/**
 * What a plugin can be asked to do, and what it refuses to guess.
 *
 * Every field is optional and every default lives in {@link normalizeConfig}.
 * The defaults are deliberately the *quiet* posture — `mode: 'harden'` is the
 * point of the plugin, but it is reached by writing nothing rather than by
 * exporting a `Config` object, because a `Config` on the default export has to
 * be a schema cordis can call `['~standard'].validate` on (`#9308`/`#9368`), and
 * a plain defaults object makes every mount of the installed package throw
 * before `apply` runs.
 *
 * @module @argszero/dsh-git-hook-guard/config
 */

/** What the plugin does to an invocation it selected. */
export type GuardMode =
  /**
   * Insert the neutralising `-c` flags. The default: the gap is that the flags
   * are missing, and a mitigation an operator has to arm twice is a mitigation
   * that is off in the deployments that need it.
   */
  | 'harden'
  /**
   * Write nothing and count what *would* be rewritten. The posture to mount
   * first: it answers "how many of this deployment's git calls carry no flags"
   * with the deployment's own numbers instead of the reporter's.
   */
  | 'report'
  /** Mount nothing at all. No shadow, no service, no listener. */
  | 'off'

/**
 * Which git invocations the guard selects.
 *
 * The distinction is not cosmetic. A git command the *user* asked for must keep
 * the hooks they installed on purpose — that is the whole reason `git commit`
 * runs a pre-commit hook — so the guard has to be able to tell the harness's own
 * bookkeeping calls from a git command issued on the user's behalf.
 *
 * `harness` reads that off the invocation itself: the environment carries
 * `GIT_CONFIG_COUNT=0`, which is the credential-scrub marker every
 * harness-initiated git call is supposed to set (`GitRunner.run()`), and which no
 * shell-mediated command carries because a shell-mediated command's `argv[0]` is
 * the shell, not git.
 *
 * `all` widens the selection to every git executable on the subprocess service,
 * including one a plugin or a PTC program spawns directly. It covers more and
 * overreaches more: under `all`, a `git commit` a program issues straight through
 * the subprocess seam loses its hooks. Both are defensible; the narrow one is the
 * default because its failure mode is an unprotected call, and the wide one's is
 * an altered user command.
 */
export type GuardScope = 'harness' | 'all'

/** The configuration a loader entry may pass. Every field is optional. */
export interface Config {
  /** What to do with a selected invocation; see {@link GuardMode}. */
  mode?: GuardMode
  /** Which invocations are selected; see {@link GuardScope}. */
  scope?: GuardScope
  /**
   * The value the guard pins `core.hooksPath` to.
   *
   * `/dev/null` by default, which is the form this repository already uses for
   * its own git calls (`packages/experimental/worktree/src/index.ts:132`,
   * `scripts/change-scope.ts` for the fsmonitor half). A directory that cannot
   * contain a hook is the requirement; `/dev/null` satisfies it on every platform
   * the shipped code targets, and an operator who prefers an empty value or a
   * dedicated scratch directory can say so here.
   */
  hooksPath?: string
  /** Whether to pin `core.fsmonitor=false` as well. Default true — the #9217 half of the same boundary. */
  fsmonitor?: boolean
  /** Whether the mount and disposal summaries are logged. Default true. */
  report?: boolean
}

/** The validated configuration, with every default resolved. */
export interface Settings {
  readonly mode: GuardMode
  readonly scope: GuardScope
  readonly hooksPath: string
  readonly fsmonitor: boolean
  readonly report: boolean
}

/** The modes, as a runtime list so validation and documentation cannot drift. */
export const MODES: readonly GuardMode[] = ['harden', 'report', 'off']

/** The scopes, as a runtime list so validation and documentation cannot drift. */
export const SCOPES: readonly GuardScope[] = ['harness', 'all']

/** The configuration the plugin runs with when a loader entry passes nothing. */
export const defaults: Settings = {
  mode: 'harden',
  scope: 'harness',
  hooksPath: '/dev/null',
  fsmonitor: true,
  report: true,
}

/**
 * Turn a loader entry's configuration into validated settings.
 *
 * Invalid values throw, which fails the mount: a guard whose configuration was
 * silently replaced by a default is a guard that reports success while doing
 * something else, and the operator who wrote the typo is the one person who
 * cannot see it.
 * @param config - whatever the loader entry passed, or `undefined` for nothing.
 * @returns the settings, with defaults resolved.
 */
export function normalizeConfig(config: Config = {}): Settings {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('git-hook-guard: config must be an object')
  }
  const mode = config.mode ?? defaults.mode
  if (!MODES.includes(mode)) {
    throw new RangeError(`git-hook-guard: mode must be one of ${MODES.join(', ')}, got ${String(mode)}`)
  }
  const scope = config.scope ?? defaults.scope
  if (!SCOPES.includes(scope)) {
    throw new RangeError(`git-hook-guard: scope must be one of ${SCOPES.join(', ')}, got ${String(scope)}`)
  }
  const hooksPath = config.hooksPath ?? defaults.hooksPath
  if (typeof hooksPath !== 'string' || hooksPath.length === 0) {
    throw new TypeError(`git-hook-guard: hooksPath must be a non-empty string, got ${String(hooksPath)}`)
  }
  const fsmonitor = config.fsmonitor ?? defaults.fsmonitor
  if (typeof fsmonitor !== 'boolean') {
    throw new TypeError(`git-hook-guard: fsmonitor must be a boolean, got ${String(fsmonitor)}`)
  }
  const report = config.report ?? defaults.report
  if (typeof report !== 'boolean') {
    throw new TypeError(`git-hook-guard: report must be a boolean, got ${String(report)}`)
  }
  return { mode, scope, hooksPath, fsmonitor, report }
}

/**
 * The `-c` arguments one hardened invocation gains, in the order they are
 * inserted.
 *
 * Exported because the tests and the README both quote it: a mitigation whose
 * exact argv is not written down anywhere is a mitigation nobody can check.
 * @param settings - the resolved configuration.
 * @returns the argv slice inserted after the executable.
 */
export function hardeningArguments(settings: Settings): string[] {
  const arguments_: string[] = ['-c', `core.hooksPath=${settings.hooksPath}`]
  if (settings.fsmonitor) arguments_.push('-c', 'core.fsmonitor=false')
  return arguments_
}

/** The keys the guard knows how to neutralise, as git spells them. */
export const GUARDED_KEYS: readonly string[] = ['core.hookspath', 'core.fsmonitor']
