/**
 * Which invocations the guard is talking about.
 *
 * Two questions, kept apart on purpose because they have different answers when
 * a deployment disagrees with the defaults:
 *
 * 1. *Is this a git executable?* — answered from `argv[0]` alone, and it has to
 *    survive the shapes a real deployment produces: `git`, an absolute
 *    `/usr/bin/git`, a Windows `C:\Program Files\Git\cmd\git.exe`, and a quoted
 *    path with spaces.
 * 2. *Is this the harness's own call?* — answered from the environment, and the
 *    marker is `GIT_CONFIG_COUNT=0`: the credential-scrub contract
 *    `GitRunner.run()` writes into every git child it starts, and the reason the
 *    existing scrub does not already solve this (it cancels *environment-injected*
 *    git config, while `.git/config` is read either way).
 *
 * @module @argszero/dsh-git-hook-guard/detect
 */

import type { GuardScope } from './config.ts'

/** Executable names that are the git binary, on the platforms the harness targets. */
const GIT_EXECUTABLES: readonly string[] = ['git', 'git.exe']

/**
 * The last path segment of an executable, for either separator.
 *
 * Both separators are handled on every platform rather than by `path.basename`:
 * a Windows path reaching a POSIX host still has to answer correctly, and the
 * harness runs its Windows provider on Windows while this plugin's tests run
 * wherever the operator runs them.
 * @param executable - the path or bare name in `argv[0]`.
 * @returns the final segment, with a surrounding pair of quotes removed.
 */
export function executableName(executable: string): string {
  let name = executable
  // A quoted argv[0] arrives with its quotes on Windows when the path has spaces.
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return cut === -1 ? name : name.slice(cut + 1)
}

/**
 * Whether an invocation runs the git binary.
 *
 * Case-insensitive because Windows executable names are, and `git.EXE` is a
 * spelling a Windows deployment reaches.
 * @param argv - the full argument vector, `argv[0]` being the executable.
 * @returns whether `argv[0]` names git.
 */
export function isGitExecutable(argv: readonly string[]): boolean {
  const first = argv[0]
  if (typeof first !== 'string' || first.length === 0) return false
  const name = executableName(first).toLowerCase()
  return GIT_EXECUTABLES.includes(name)
}

/**
 * Whether an environment carries the harness's credential-scrub marker for git.
 *
 * `GIT_CONFIG_COUNT=0` is git's own switch for "no `GIT_CONFIG_KEY_n` entries
 * were injected"; a caller that sets it is asserting that the child's git
 * configuration is the deployment's, not the environment's. `GitRunner.run()`
 * sets it on every call it makes, which is what makes it usable as the
 * harness-bookkeeping fingerprint — and it is read from the explicit spec
 * environment, not from `process.env`, because the service merges the spec over a
 * scrub that already removed the ambient ones.
 * @param env - the invocation's explicit environment, if it has one.
 * @returns whether the marker is present.
 */
export function carriesScrubMarker(env: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return env !== undefined && env.GIT_CONFIG_COUNT === '0'
}

/**
 * Whether the guard selects an invocation.
 *
 * `harness` requires both facts — a git executable *and* the scrub marker — and
 * that conjunction is what keeps a user's own git out of it: a command issued
 * through the shell tool has the shell in `argv[0]`, so it fails the first test
 * long before the environment is consulted. `all` drops the environment test.
 * @param scope - the configured scope.
 * @param argv - the invocation's argument vector.
 * @param env - the invocation's explicit environment.
 * @returns whether this invocation is in scope.
 */
export function selected(
  scope: GuardScope,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (!isGitExecutable(argv)) return false
  return scope === 'all' || carriesScrubMarker(env)
}
