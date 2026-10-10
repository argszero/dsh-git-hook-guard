/**
 * The discriminator, which is the whole security argument of this plugin.
 *
 * Everything else is argv plumbing; this file is where "the harness's own git
 * call" and "the user's git command" are separated, and where a mistake is not a
 * missed hardening but a broken `git commit` for somebody. So the arms are
 * written as the two deployment shapes that must stay apart — a bookkeeping call
 * with the credential-scrub marker, and a shell-mediated command that has no
 * marker because its `argv[0]` is the shell.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { carriesScrubMarker, executableName, isGitExecutable, selected } from '../lib/detect.js'

test('executableName takes the last segment for either separator, quoted or not', () => {
  assert.equal(executableName('git'), 'git')
  assert.equal(executableName('/usr/bin/git'), 'git')
  assert.equal(executableName('C:\\Program Files\\Git\\cmd\\git.exe'), 'git.exe')
  assert.equal(executableName('/opt/git/bin/git.exe'), 'git.exe')
  assert.equal(executableName('"C:\\Program Files\\Git\\cmd\\git.exe"'), 'git.exe')
  // A trailing separator is not a name; it must not swallow the path.
  assert.equal(executableName('/usr/bin/'), '')
  assert.equal(executableName(''), '')
})

test('isGitExecutable answers for the shapes a deployment produces', () => {
  for (const argv of [['git', 'add'], ['/usr/bin/git'], ['C:\\Git\\cmd\\git.exe', 'status'], ['GIT.EXE'], ['git']]) {
    assert.equal(isGitExecutable(argv), true, `${JSON.stringify(argv)} runs git`)
  }
  for (const argv of [
    ['bash', '-c', 'git add'],
    ['git-lfs', 'pull'],
    ['gitk'],
    ['/usr/bin/git-shell'],
    ['/usr/bin/'],
    [],
    ['', 'add'],
  ]) {
    assert.equal(isGitExecutable(argv), false, `${JSON.stringify(argv)} does not run the git binary itself`)
  }
})

test('a non-string argv[0] is not git, whatever it is', () => {
  assert.equal(isGitExecutable([undefined]), false)
  assert.equal(isGitExecutable([42]), false)
  assert.equal(isGitExecutable([{ toString: () => 'git' }]), false)
})

test('carriesScrubMarker reads the one marker GitRunner writes, exactly', () => {
  assert.equal(carriesScrubMarker({ GIT_CONFIG_COUNT: '0' }), true)
  assert.equal(carriesScrubMarker({ GIT_CONFIG_COUNT: '0', LC_ALL: 'C' }), true)
  // The marker is git's switch for "no environment-injected config". A different
  // value means the caller *is* injecting config, which is not the harness's
  // bookkeeping shape.
  assert.equal(carriesScrubMarker({ GIT_CONFIG_COUNT: '1' }), false)
  assert.equal(carriesScrubMarker({ GIT_CONFIG_COUNT: '00' }), false)
  assert.equal(carriesScrubMarker({ git_config_count: '0' }), false)
  assert.equal(carriesScrubMarker({ GIT_CONFIG_KEY_0: 'core.hooksPath' }), false)
  assert.equal(carriesScrubMarker({}), false)
  assert.equal(carriesScrubMarker(undefined), false)
})

test('the default scope keeps the two deployment shapes apart', () => {
  const bookkeeping = ['/usr/bin/git', 'add', '--all', '--ignore-errors']
  const userCommand = ['/bin/bash', '-lc', 'git commit -m "x"']
  assert.equal(selected('harness', bookkeeping, { GIT_CONFIG_COUNT: '0' }), true, 'the harness snapshot is selected')
  assert.equal(selected('harness', bookkeeping, {}), false, 'a git call without the scrub marker is not the harness\'s')
  assert.equal(selected('harness', userCommand, { GIT_CONFIG_COUNT: '0' }), false,
    'a shell-mediated command is the user\'s, marker or no marker')
  // `all` drops the environment test and keeps only the executable test.
  assert.equal(selected('all', bookkeeping, {}), true)
  assert.equal(selected('all', userCommand, { GIT_CONFIG_COUNT: '0' }), false,
    'even the widest scope does not reach a command whose argv[0] is a shell')
})
