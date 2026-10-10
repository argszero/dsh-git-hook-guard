/**
 * The harness's own git commands stop running a repository's hooks.
 *
 * ## The gap
 *
 * `workspace-changes` takes a working-tree snapshot at every top-level turn
 * start, through `GitRunner.run()` (`packages/deliverables/workspace-changes/src/git.ts`):
 *
 * ```
 * turn/start                     workspace-changes/src/index.ts:146
 *   TurnRecorder.start           recorder.ts → snapshotTree (git.ts)
 *     git add --all --ignore-errors    ← runs the repository's post-index-change hook
 *     git write-tree
 * ```
 *
 * That call scrubs its environment — `GIT_CONFIG_COUNT=0 GIT_TERMINAL_PROMPT=0
 * GIT_OPTIONAL_LOCKS=0 LC_ALL=C` — and passes no `-c` flags. The scrub cancels
 * *environment-injected* git configuration, which is what its comment claims;
 * it does nothing about the configuration git reads from the invocation's own
 * working directory. A `.git/config` that arrived with a clone or an extracted
 * archive therefore still decides where hooks live:
 *
 * ```
 * .git/config          core.hooksPath = .hooks        ← arrives with the project
 * .hooks/post-index-change                            ← executes with the DSH user's privileges
 * ```
 *
 * Measured on git 2.50.1: with that configuration in place and a work tree
 * holding an executable `.hooks/post-index-change`, `git add --all
 * --ignore-errors` runs it — deterministically, with `GIT_TRACE=1` naming it
 * (`run-command.c:673 run_command: .hooks/post-index-change 0 0`). The
 * private-index shape `snapshotTree` uses (`GIT_INDEX_FILE` plus
 * `GIT_OBJECT_DIRECTORY`) runs it too, and so does `git write-tree`. `rev-parse`,
 * `ls-files --stage` and `check-ignore` do not. Reported as **#9382**; the
 * `core.fsmonitor` half of the same boundary is **#9217**, where the same absence
 * of flags lets a repository-configured monitor run twice per index command.
 *
 * ## The fix, and why it is not a rewrite
 *
 * This repository already carries the answer for its own git calls:
 *
 * ```
 * packages/experimental/worktree/src/index.ts:132
 *   [gitCommand, '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
 * ```
 *
 * The product path is the one place those flags are missing. The plugin adds
 * exactly them, to exactly the invocations that need them, and changes nothing
 * else: no git behaviour is re-implemented, no repository is inspected, no file
 * is written, and git's own configuration precedence does the work.
 *
 * ## Where it attaches
 *
 * The subprocess capability is a cordis service, one implementation per context
 * — its own documentation says a second one throws, so a plugin cannot supply a
 * hardened provider. What it *can* do is shadow a method on the live instance,
 * reached by name lookup the way the vendored traceable proxy exposes it
 * (`ctx.get('subprocess')[Symbol.for('cordis.original')]`). Every in-repo caller
 * reads `this.subprocess.spawn(...)` or `ctx.subprocess.spawn(...)` at call time,
 * so a shadow on the instance is seen by all of them — including `GitRunner`,
 * which captures the service when `workspace-changes` applies.
 *
 * The shadow is installed on the **instance**, never on the prototype: a
 * prototype belongs to whichever copy of the package happened to be imported,
 * and patching the wrong copy is a failure this repository has already shipped
 * more than once.
 *
 * ## What it deliberately does not touch
 *
 * The default scope is the harness's own bookkeeping calls: a git executable
 * whose explicit environment carries the `GIT_CONFIG_COUNT=0` credential-scrub
 * marker. A git command the user asks for goes through the shell tool, whose
 * `argv[0]` is the shell — it fails the executable test long before the
 * environment is consulted, and the hooks the user installed on purpose keep
 * running. A caller that sets `core.hooksPath` or `core.fsmonitor` itself is
 * respected rather than overridden. `scope: 'all'` widens the selection for
 * operators who want it, and the snapshot says which scope is in force.
 *
 * `spawnTerminal` is not shadowed at all: a persistent shell is the user's own.
 *
 * @module @argszero/dsh-git-hook-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { normalizeConfig } from './config.ts'
import type { Config } from './config.ts'
import { GitHookGuard } from './guard.ts'
import type { GuardSnapshot } from './guard.ts'

export type { Config, GuardMode, GuardScope, Settings } from './config.ts'
export { MODES, SCOPES, defaults, hardeningArguments, normalizeConfig } from './config.ts'
export type { GuardCounters, GuardCoverage, GuardSnapshot } from './guard.ts'
export { GitHookGuard } from './guard.ts'
export type { Hardened } from './harden.ts'
export { callerConfiguredKeys, explicitSettings, harden, subcommandOf } from './harden.ts'
export { carriesScrubMarker, executableName, isGitExecutable, selected } from './detect.ts'

/** Stable Loader identity. */
export const name = 'git-hook-guard'

/** The capability whose `spawn` this plugin shadows. */
export const inject = ['subprocess']

/**
 * The key the vendored traceable proxy stores its target under
 * (`vendor/cordis/src/utils.ts`: `original: Symbol.for('cordis.original')`).
 *
 * Read through `Reflect` rather than declared as an interface member: the value
 * is a foreign object's private protocol, and a `[key: symbol]` index signature
 * would claim a type for something this plugin cannot verify.
 */
const ORIGINAL = Symbol.for('cordis.original')

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitHookGuard: GitHookGuardService
  }
}

/** The service this plugin provides: the counts, and the boundaries beside them. */
export interface GitHookGuardService {
  /** Counters, coverage and the arguments a rewrite adds, as of now. */
  snapshot(): GuardSnapshot
  /** Zero the counters. The shadow and the settings stay as they are. */
  reset(): void
}

/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the defaults live in `apply(ctx, config = {})` and not in an
 * exported `Config`: Cordis calls `Config['~standard'].validate` on a plugin's
 * `Config`, and a plain defaults object has no such property, so naming one there
 * makes every mount of the installed package throw before this function runs.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  const guard = new GitHookGuard(
    settings,
    message => { ctx.logger.info(`git-hook-guard: ${message}`) },
    message => { ctx.logger.warn(`git-hook-guard: ${message}`) },
  )
  ctx.effect(() => {
    const view = ctx.get('subprocess') as SubprocessRuntime | undefined
    if (view === undefined) {
      // `inject` should have held the plugin until the service exists; reaching
      // here means it does not, and a guard that cannot be installed must say so
      // rather than report a protection it never put in place.
      guard.patched = false
      ctx.logger.warn('git-hook-guard: the subprocess service is not available; nothing was hardened')
      return () => {}
    }
    // The traceable view forwards reads to the instance behind it, and the
    // instance is where a write has to land for every other reader to see it.
    const underlying = (Reflect.get(view as object, ORIGINAL) as SubprocessRuntime | undefined) ?? view
    const original = underlying.spawn
    const ownSpawn = Object.hasOwn(underlying, 'spawn')
    let installed = false
    try {
      Reflect.set(underlying, 'spawn', function (this: SubprocessRuntime, spec: SubprocessSpawnSpec): SubprocessHandle {
        return original.call(this, guard.apply(spec))
      })
      installed = true
      guard.patched = true
    } catch (error: unknown) {
      // A frozen or sealed provider. Reported, and reported as *not patched*:
      // the service's `patched` flag is the difference between "nothing needed
      // hardening" and "nothing could be hardened".
      guard.patched = false
      ctx.logger.warn(`git-hook-guard: could not shadow spawn on the subprocess service: ${String(error)}`)
    }
    if (installed && settings.report) {
      ctx.logger.info(
        `git-hook-guard: mounted in ${settings.mode} mode, scope "${settings.scope}",`
        + ` neutralising ${guard.snapshot().coverage.neutralization}`,
      )
    }
    return () => {
      if (!installed) return
      try {
        if (ownSpawn) Reflect.set(underlying, 'spawn', original)
        else Reflect.deleteProperty(underlying, 'spawn')
      } catch (error: unknown) {
        ctx.logger.warn(`git-hook-guard: could not restore the subprocess service: ${String(error)}`)
      }
      guard.patched = false
    }
  }, 'git-hook-guard: neutralise hooks on the harness\'s own git invocations')
  ctx.provide('gitHookGuard', {
    snapshot: () => guard.snapshot(),
    reset: () => { guard.reset() },
  } satisfies GitHookGuardService)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it carries a `Config`. This one
 * carries none — the defaults reach a mount through `apply(ctx, config = {})` —
 * because a `Config` here would have to be a real schema, and a plain defaults
 * object is the defect this family has shipped eleven times.
 */
export default { name, inject, apply }
