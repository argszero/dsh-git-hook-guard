/**
 * The guard object: what it counts, what it returns, and what it admits it
 * cannot see.
 *
 * Two properties carry the design and are why this file exists apart from the
 * plugin spec:
 *
 * - **The ordinary path allocates nothing.** A spawn that is not a selected git
 *   invocation gets its own spec object back, identity intact — the guard is in
 *   the hot path of every child process the harness starts, and "returns an equal
 *   object" is not the same promise as "returns your object".
 * - **Fail-open.** A guard whose own bug broke every spawn would be worse than
 *   the missing `-c` it exists to add, so a throw inside the decision is caught,
 *   counted, and followed by the caller's untouched spec. The failure is counted
 *   rather than swallowed, because `failures > 0` is the difference between a
 *   quiet deployment and a broken guard.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHookGuard } from '../lib/guard.js'
import { normalizeConfig, defaults } from '../lib/config.js'

const spec = overrides => ({ argv: ['git', 'add'], cwd: '/repo', env: { GIT_CONFIG_COUNT: '0' }, ...overrides })
const guardFor = (config = {}) => new GitHookGuard(normalizeConfig(config))

test('the ordinary path returns the caller\'s own object', () => {
  const guard = guardFor()
  const other = spec({ argv: ['/bin/bash', '-lc', 'ls'] })
  assert.equal(guard.apply(other), other, 'a non-git spawn is passed through, not copied')
  assert.equal(guard.counters.spawnsSeen, 1)
  assert.equal(guard.counters.gitSpawns, 0, 'a shell spawn is not counted as a git spawn')
})

test('the counters keep their denominators', () => {
  const guard = guardFor()
  guard.apply(spec())                                              // git + marker → selected, hardened
  guard.apply(spec({ env: {} }))                                   // git, no marker → out of the default scope
  guard.apply(spec({ argv: ['bash', '-c', 'git add'] }))            // not git at all
  assert.deepEqual(guard.counters, {
    spawnsSeen: 3,
    gitSpawns: 2,
    harnessGitSpawns: 1,
    selected: 1,
    wouldHarden: 0,
    hardened: 1,
    callerConfigured: 0,
    failures: 0,
  })
})

test('a hardened spawn is a copy, and the caller\'s spec is not edited', () => {
  const guard = guardFor()
  const original = spec()
  const result = guard.apply(original)
  assert.notEqual(result, original)
  assert.deepEqual(original.argv, ['git', 'add'], 'the input argv is untouched')
  assert.deepEqual(result.argv, ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'add'])
  assert.equal(result.cwd, '/repo', 'every other field is carried over')
  assert.equal(result.env, original.env)
})

test('a caller that configured a guarded key is counted, not overridden', () => {
  const guard = guardFor()
  const worktree = spec({ argv: ['git', '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status'] })
  assert.equal(guard.apply(worktree), worktree)
  assert.equal(guard.counters.selected, 1, 'it was selected — the scope matched')
  assert.equal(guard.counters.hardened, 0)
  assert.equal(guard.counters.callerConfigured, 1)
})

test('scope "all" widens selection to every git executable on the service', () => {
  const guard = guardFor({ scope: 'all' })
  guard.apply(spec({ env: {} }))
  assert.equal(guard.counters.harnessGitSpawns, 0, 'no marker was present')
  assert.equal(guard.counters.selected, 1, 'and it was selected anyway')
  assert.equal(guard.counters.hardened, 1)
})

test('mode "report" runs the same decision and stops one line short of the write', () => {
  // The posture an operator mounts first. It has to produce the number that
  // justifies the change — and it has to write nothing while doing so, or the
  // measurement is taken on an already-changed deployment.
  const report = guardFor({ mode: 'report' })
  const argv = ['git', 'add', '--all']
  const original = spec({ argv })
  assert.equal(report.apply(original), original, 'report hands the caller its own spec back')
  assert.deepEqual(report.counters, {
    spawnsSeen: 1, gitSpawns: 1, harnessGitSpawns: 1, selected: 1, wouldHarden: 1, hardened: 0, callerConfigured: 0, failures: 0,
  })
  const hardened = guardFor()
  hardened.apply(spec({ argv }))
  assert.equal(hardened.counters.hardened, 1)
  assert.equal(hardened.counters.wouldHarden, 0, 'the two postures never report each other\'s number')
})

test('a failure inside the decision is counted and the spawn proceeds untouched', () => {
  const guard = guardFor()
  const hostile = {
    get argv() { throw new Error('argv exploded') },
    cwd: '/repo',
    env: { GIT_CONFIG_COUNT: '0' },
  }
  const result = guard.apply(hostile)
  assert.equal(result, hostile, 'fail-open: the caller\'s spec is handed on')
  assert.equal(guard.counters.failures, 1, 'and the failure is visible in the report')
  assert.equal(guard.counters.spawnsSeen, 1)
})

test('an empty or malformed argv is not a git invocation', () => {
  const guard = guardFor()
  for (const argv of [[], 'git add', null]) {
    const malformed = { argv, cwd: '/repo' }
    assert.equal(guard.apply(malformed), malformed)
  }
  assert.equal(guard.counters.gitSpawns, 0)
})

test('reset zeroes the counters and leaves the settings alone', () => {
  const guard = guardFor({ mode: 'report', scope: 'all' })
  guard.apply(spec({ env: {} }))
  assert.equal(guard.counters.wouldHarden, 1)
  guard.reset()
  assert.equal(guard.counters.wouldHarden, 0)
  assert.equal(guard.counters.spawnsSeen, 0)
  assert.equal(guard.snapshot().scope, 'all')
})

test('the snapshot states the boundaries, and narrows them as settings change', () => {
  const defaultLines = guardFor().blindSpots()
  assert.ok(defaultLines.some(line => line.includes('spawnTerminal')), 'the PTY path is named')
  assert.ok(defaultLines.some(line => line.includes('execa')), 'the plugin manager\'s own git call is named')
  assert.ok(defaultLines.some(line => line.includes('not a sandbox')), 'the mitigation is not oversold')
  assert.ok(defaultLines.some(line => line.includes('GIT_CONFIG_COUNT=0')), 'the default scope says what it does not select')
  assert.ok(!defaultLines.some(line => line.includes('every git executable')), 'the narrow default does not claim the wide scope')

  const wide = guardFor({ scope: 'all' }).blindSpots()
  assert.ok(wide.some(line => line.includes('every git executable')), 'scope "all" names its overreach')
  assert.ok(!wide.some(line => line.includes('does not carry GIT_CONFIG_COUNT=0')), 'and drops the narrow scope\'s caveat')

  const reporting = guardFor({ mode: 'report' }).blindSpots()
  assert.ok(reporting.some(line => line.includes('nothing is rewritten')), 'the measurement posture says it protects nothing yet')

  const noMonitor = guardFor({ fsmonitor: false }).blindSpots()
  // The predicate is the sentence the disabled half is named by, not the word
  // `core.fsmonitor` — that word also appears in the caller-configured line, so
  // a substring test on it stays green with the disabled-half line removed. The
  // mutation harness found exactly that; the assertion is spelled to the claim.
  assert.ok(noMonitor.some(line => line.includes('fsmonitor is false')), 'a disabled half is named')
})

test('the snapshot reports the arguments and the patch state', () => {
  const guard = guardFor()
  assert.deepEqual(guard.snapshot().arguments, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
  assert.deepEqual(guardFor({ fsmonitor: false }).snapshot().arguments, ['-c', 'core.hooksPath=/dev/null'])
  assert.equal(guard.snapshot().coverage.patched, false, 'nothing is patched until the plugin installs the shadow')
  guard.patched = true
  assert.equal(guard.snapshot().coverage.patched, true)
  assert.equal(guard.snapshot().mode, defaults.mode)
  assert.equal(guard.snapshot().coverage.neutralization, 'core.hooksPath=/dev/null and core.fsmonitor=false')
})

test('the snapshot copies its counters', () => {
  const guard = guardFor()
  const snapshot = guard.snapshot()
  snapshot.counters.hardened = 99
  assert.equal(guard.counters.hardened, 0, 'a reader cannot mutate the live state through a snapshot')
})
