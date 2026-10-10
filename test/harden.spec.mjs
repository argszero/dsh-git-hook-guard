/**
 * The rewrite: where the flags land, and the rule that decides not to add them.
 *
 * The insertion position is not a style choice — git only accepts `-c` before the
 * subcommand, so an argv that gains them anywhere else is an argv git refuses,
 * and the failure would surface as a broken snapshot rather than as a missing
 * mitigation. The declining rule is the other half: the repository's own hardened
 * call site passes these very flags, and a guard that re-set them would be
 * editing a caller that already did the work — and could be outvoted anyway,
 * because git resolves a repeated `-c` for one key in favour of the later one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { callerConfiguredKeys, describeNeutralization, explicitSettings, harden, subcommandOf } from '../lib/harden.js'
import { defaults, normalizeConfig } from '../lib/config.js'

const settings = defaults

test('explicitSettings reads both spellings git accepts', () => {
  assert.deepEqual([...explicitSettings(['git', '-c', 'core.hooksPath=/dev/null', 'add'])], [['core.hookspath', '/dev/null']])
  assert.deepEqual([...explicitSettings(['git', '-ccore.hooksPath=.hooks', 'add'])], [['core.hookspath', '.hooks']])
  assert.deepEqual([...explicitSettings(['git', '--config', 'core.fsmonitor=false', 'status'])], [['core.fsmonitor', 'false']])
  assert.deepEqual([...explicitSettings(['git', '--config=core.fsmonitor=false', 'status'])], [['core.fsmonitor', 'false']])
  // Keys are case-insensitive in git config, and a mixed-case spelling in argv is real.
  assert.deepEqual([...explicitSettings(['git', '-c', 'Core.HooksPath=.hooks', 'add'])], [['core.hookspath', '.hooks']])
})

test('explicitSettings stops where git stops reading global options', () => {
  // Past the subcommand, `-c` belongs to the subcommand, not to git.
  assert.deepEqual([...explicitSettings(['git', 'add', '-c', 'core.hooksPath=.hooks'])], [])
  assert.deepEqual([...explicitSettings(['git', 'add', '--', '-c', 'core.hooksPath=.hooks'])], [])
  // A value-taking option does not hide the next option.
  assert.deepEqual([...explicitSettings(['git', '-C', '/repo', '-c', 'core.hooksPath=.hooks', 'add'])], [['core.hookspath', '.hooks']])
})

test('callerConfiguredKeys names the guarded keys a caller set itself', () => {
  // The repository's own hardened call site, verbatim
  // (`packages/experimental/worktree/src/index.ts:132`).
  const worktree = ['git', '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status']
  assert.deepEqual(callerConfiguredKeys(worktree), ['core.hookspath', 'core.fsmonitor'])
  assert.deepEqual(callerConfiguredKeys(['git', '-c', 'core.hooksPath=.hooks', 'add']), ['core.hookspath'])
  assert.deepEqual(callerConfiguredKeys(['git', '-c', 'core.pager=cat', 'add']), [], 'an unrelated key is not a decision about hooks')
})

test('harden puts the flags immediately after the executable, before everything else', () => {
  const rewritten = harden(['/usr/bin/git', 'add', '--all', '--ignore-errors'], settings)
  assert.ok(rewritten !== undefined)
  assert.deepEqual(rewritten.argv, [
    '/usr/bin/git',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    'add', '--all', '--ignore-errors',
  ])
  assert.deepEqual(rewritten.added, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
  // A caller's own global options are still global options in the result.
  assert.deepEqual(harden(['git', '-C', '/repo', 'status'], settings).argv,
    ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/repo', 'status'])
  // An invocation with no subcommand at all is still valid git.
  assert.deepEqual(harden(['git'], settings).argv,
    ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
})

test('harden leaves the input array untouched', () => {
  const argv = ['git', 'add']
  const frozen = Object.freeze([...argv])
  harden(frozen, settings)
  assert.deepEqual([...frozen], argv, 'the rewrite copies; the caller\'s argv is not edited in place')
})

test('harden declines when the caller configured a guarded key itself', () => {
  assert.equal(harden(['git', '-c', 'core.hooksPath=.hooks', 'add'], settings), undefined)
  assert.equal(harden(['git', '--config', 'core.fsmonitor=false', 'status'], settings), undefined)
  // Whatever they chose, including a value the guard would not pick.
  assert.equal(harden(['git', '-c', 'core.hooksPath=.hooks', 'add'], settings), undefined)
})

test('the configured hooksPath and fsmonitor decide what is added', () => {
  const both = harden(['git', 'add'], settings)
  assert.deepEqual(both.added, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
  const hooksOnly = harden(['git', 'add'], normalizeConfig({ fsmonitor: false }))
  assert.deepEqual(hooksOnly.added, ['-c', 'core.hooksPath=/dev/null'])
  const custom = harden(['git', 'add'], normalizeConfig({ hooksPath: '/nonexistent/hooks' }))
  assert.deepEqual(custom.added, ['-c', 'core.hooksPath=/nonexistent/hooks', '-c', 'core.fsmonitor=false'])
  // An empty hooksPath cannot be inserted and is refused before a mount, where
  // the operator can still see the mistake.
  assert.throws(() => normalizeConfig({ hooksPath: '' }), /hooksPath must be a non-empty string/)
})

test('subcommandOf names the command for a report line', () => {
  assert.equal(subcommandOf(['git', 'add', '--all']), 'add')
  assert.equal(subcommandOf(['git', '-C', '/repo', 'status']), 'status')
  assert.equal(subcommandOf(['git', '-c', 'core.pager=cat', 'diff-tree']), 'diff-tree')
  assert.equal(subcommandOf(['git']), '(none)')
  assert.equal(subcommandOf(['git', '--version']), '(none)')
})

test('describeNeutralization quotes the settings it is describing', () => {
  assert.equal(describeNeutralization(settings), 'core.hooksPath=/dev/null and core.fsmonitor=false')
  assert.equal(describeNeutralization(normalizeConfig({ fsmonitor: false })), 'core.hooksPath=/dev/null')
})

test('every hardened argv keeps the original arguments as a suffix', () => {
  // The invariant behind the whole module, checked over the shapes the tests and
  // the harnesses in this family actually build.
  for (const argv of [
    ['git', 'add', '--all', '--ignore-errors'],
    ['/usr/bin/git', 'rev-parse', '--show-toplevel'],
    ['git', 'check-ignore', '-z', '--stdin'],
    ['git', '-C', '/repo', 'ls-files', '-z', '--stage'],
  ]) {
    const rewritten = harden(argv, settings)
    assert.deepEqual(rewritten.argv.slice(rewritten.added.length + 1), argv.slice(1))
    assert.equal(rewritten.argv[0], argv[0])
  }
})
