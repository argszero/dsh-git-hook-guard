/**
 * The plugin in a real context: the shadow, the seam, and the restore.
 *
 * The seam assertion is the one this plugin stands or falls on, and it is made
 * against the shape `workspace-changes` actually uses — a service reference
 * captured **before** the plugin mounts and called later. A plugin that only
 * worked for lookups made after it mounted would pass a test written the obvious
 * way and fail in the deployment it was built for.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { gitRunner, logText, service, shadowInstalled, world } from './harness.mjs'

const RUNNER = { cwd: '/repo' }

/** One git invocation of the harness's bookkeeping shape, through a captured service. */
function snapshotCall(subprocess) {
  return gitRunner(subprocess, '/usr/bin/git').run(['add', '--all', '--ignore-errors'], RUNNER)
}

test('a service captured before the mount sees the shadow', async () => {
  const harness = await world({ provider: 'stub', plugin: false })
  const captured = harness.ctx.get('subprocess')
  await harness.mount()
  // Read the *guard* service only now: it is provided by the fork the mount
  // creates, so a read taken before the mount is `undefined` by construction and
  // would assert nothing.
  const afterMount = service(harness)
  assert.equal(afterMount.snapshot().coverage.patched, true, 'the service reports the shadow as installed')

  await snapshotCall(captured)
  const provider = harness.ctx.get('subprocess')[Symbol.for('cordis.original')]
  const [spec] = provider.specs
  assert.deepEqual(spec.argv, [
    '/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'add', '--all', '--ignore-errors',
  ], 'the invocation the caller built before the mount is the one that was rewritten')
  assert.equal(afterMount.snapshot().counters.hardened, 1)
})

test('a property read of the service sees the same shadow', async () => {
  const harness = await world({ provider: 'stub' })
  await gitRunner(harness.ctx.subprocess, '/usr/bin/git').run(['write-tree'], RUNNER)
  assert.equal(service(harness).snapshot().counters.hardened, 1)
})

test('a non-git spawn and a shell-mediated git command are left alone', async () => {
  const harness = await world({ provider: 'stub' })
  const provider = harness.ctx.get('subprocess')[Symbol.for('cordis.original')]
  await harness.ctx.subprocess.spawn({
    argv: ['/bin/bash', '-lc', 'git add -A'],
    cwd: '/repo',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 1_000,
    env: { GIT_CONFIG_COUNT: '0' },
  })
  const counters = service(harness).snapshot().counters
  assert.equal(counters.spawnsSeen, 1)
  assert.equal(counters.gitSpawns, 0, 'the user\'s git command arrives as the shell, and is never selected')
  assert.deepEqual(provider.specs[0].argv, ['/bin/bash', '-lc', 'git add -A'])
})

test('mode "report" installs the shadow and rewrites nothing', async () => {
  const harness = await world({ provider: 'stub', config: { mode: 'report' } })
  const provider = harness.ctx.get('subprocess')[Symbol.for('cordis.original')]
  await snapshotCall(harness.ctx.subprocess)
  assert.deepEqual(provider.specs[0].argv, ['/usr/bin/git', 'add', '--all', '--ignore-errors'], 'nothing was added')
  const counters = service(harness).snapshot().counters
  assert.equal(counters.wouldHarden, 1)
  assert.equal(counters.hardened, 0)
})

test('mode "off" installs nothing at all', async () => {
  const harness = await world({ provider: 'stub', plugin: false })
  const fork = await harness.ctx.plugin((await import('../lib/index.js')).default, { mode: 'off' })
  assert.equal(service(harness), undefined, 'no service is provided in the off posture')
  assert.equal(shadowInstalled(harness), false, 'and no shadow is installed')
  const provider = harness.ctx.get('subprocess')[Symbol.for('cordis.original')]
  await snapshotCall(harness.ctx.subprocess)
  assert.deepEqual(provider.specs[0].argv, ['/usr/bin/git', 'add', '--all', '--ignore-errors'])
  await fork.dispose()
})

test('disposal removes the shadow and leaves the provider in its original shape', async () => {
  const harness = await world({ provider: 'stub' })
  assert.equal(shadowInstalled(harness), true)
  await harness.dispose()
  assert.equal(shadowInstalled(harness), false, 'the own property is deleted, not left behind')
  assert.equal(service(harness), undefined, 'and the service goes with the fork')
  const provider = harness.ctx.get('subprocess')[Symbol.for('cordis.original')]
  provider.specs.length = 0
  await snapshotCall(harness.ctx.subprocess)
  assert.deepEqual(provider.specs[0].argv, ['/usr/bin/git', 'add', '--all', '--ignore-errors'], 'unmounted means uninspected')
})

test('the shadow is per instance: another context is untouched', async () => {
  const guarded = await world({ provider: 'stub' })
  // The second context has a provider of its own and mounts *nothing* — the
  // point of the assertion is that a shadow on one instance does not appear on
  // another, so mounting the guard here would test the opposite of the claim.
  const other = await world({ provider: 'stub', plugin: false })
  const provider = other.ctx.get('subprocess')[Symbol.for('cordis.original')]
  await snapshotCall(other.ctx.subprocess)
  assert.deepEqual(provider.specs[0].argv, ['/usr/bin/git', 'add', '--all', '--ignore-errors'],
    'a second context\'s provider is not patched by the first context\'s plugin')
  assert.equal(service(other), undefined)
  assert.equal(service(guarded).snapshot().counters.spawnsSeen, 0)
})

test('the mount is reported once, with the posture it mounted in', async () => {
  const harness = await world({ provider: 'stub', config: { scope: 'all' } })
  const text = logText(harness.logged)
  assert.match(text, /git-hook-guard: mounted in harden mode, scope "all"/)
  assert.match(text, /core\.hooksPath=\/dev\/null and core\.fsmonitor=false/)
})

test('an invalid configuration fails the mount instead of being silently defaulted', async () => {
  const harness = await world({ provider: 'stub', plugin: false })
  const index = await import('../lib/index.js')
  // Whether cordis surfaces the refusal as a rejection or as a failed fork is
  // cordis' business; what this plugin promises is observable either way — no
  // service, no shadow, and therefore no protection reported for a typo. The
  // mount is awaited inside a try because `ctx.plugin` hands back a thenable
  // (a cordis `Fiber`) and not a full promise: it has `then` but no `catch`.
  for (const config of [{ mode: 'sure' }, { scope: 'everything' }, { hooksPath: '' }, { fsmonitor: 'yes' }]) {
    try {
      await harness.ctx.plugin(index.default, config)
    } catch { /* the refusal this test is about */ }
    assert.equal(service(harness), undefined, `${JSON.stringify(config)} must not mount a guard`)
  }
  assert.equal(shadowInstalled(harness), false)
})
