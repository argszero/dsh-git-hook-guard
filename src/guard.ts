/**
 * The guard as an object: what it counted, what it changed, and — the part a
 * security claim is worth nothing without — what it structurally cannot see.
 *
 * The counting is not decoration. "The guard is mounted" and "the guard
 * inspected nothing" look identical from the outside, and only one of them is
 * protection; so `spawnsSeen` is a denominator for every other number, and the
 * blindness list is emitted on every snapshot rather than kept in a README a
 * reader has to find.
 *
 * @module @argszero/dsh-git-hook-guard/guard
 */

import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { carriesScrubMarker, isGitExecutable, selected } from './detect.ts'
import { describeNeutralization, harden, subcommandOf } from './harden.ts'
import type { GuardMode, GuardScope, Settings } from './config.ts'

/** Every number the guard keeps, each with its denominator beside it. */
export interface GuardCounters {
  /** Spawn calls that reached the shadow; the denominator for everything below. */
  spawnsSeen: number
  /** Of those, the ones whose `argv[0]` names git. */
  gitSpawns: number
  /** Of those, the ones carrying the `GIT_CONFIG_COUNT=0` credential-scrub marker. */
  harnessGitSpawns: number
  /** Invocations the configured scope selected. */
  selected: number
  /** Selected invocations the guard's decision was to harden but `mode: 'report'` left alone. */
  wouldHarden: number
  /** Selected invocations whose argv was rewritten. */
  hardened: number
  /** Selected invocations the guard declined: the caller set `core.hooksPath`/`core.fsmonitor` itself. */
  callerConfigured: number
  /** Selections that raised while being rewritten; the spawn proceeded untouched. */
  failures: number
}

/** What the guard is protecting, and what it is not. */
export interface GuardCoverage {
  /** Whether the shadow was installed at all. False is a failure, not a posture. */
  readonly patched: boolean
  /** The neutralisation a rewrite applies. */
  readonly neutralization: string
  /** Things this plugin structurally cannot see, stated on every report. */
  readonly notCovered: readonly string[]
}

/** The read-only view the `gitHookGuard` service serves. */
export interface GuardSnapshot {
  readonly mode: GuardMode
  readonly scope: GuardScope
  readonly counters: GuardCounters
  readonly coverage: GuardCoverage
  /** The arguments one hardened invocation gains. */
  readonly arguments: readonly string[]
}

/** A fresh counter set. */
function zeroCounters(): GuardCounters {
  return {
    spawnsSeen: 0,
    gitSpawns: 0,
    harnessGitSpawns: 0,
    selected: 0,
    wouldHarden: 0,
    hardened: 0,
    callerConfigured: 0,
    failures: 0,
  }
}

/**
 * The decision the shadow makes for one spawn.
 *
 * Fail-open by construction: the only paths out of {@link GitHookGuard.apply}
 * that are not "return the spec unchanged" are the ones that return a rewritten
 * copy, and a throw anywhere inside is caught, counted, and followed by the
 * original spec. A guard whose own bug broke every subprocess spawn would be a
 * worse failure than the missing `-c` it exists to add.
 */
export class GitHookGuard {
  /** The counters, mutated in place so a report always reads the live values. */
  readonly counters: GuardCounters = zeroCounters()

  /** Whether the first hardening has been logged; the log line is evidence, and one is enough. */
  private announced = false

  /** Set by the plugin once it has installed the shadow, so a report can say whether it did. */
  patched = false

  /**
   * @param settings - the resolved configuration.
   * @param note - where one informational line goes; a no-op by default so a
   *   unit test can construct a guard without a context.
   * @param warn - where a failure line goes.
   */
  constructor(
    private readonly settings: Settings,
    private readonly note: (message: string) => void = () => {},
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /**
   * Inspect one spawn and return the spec to hand on.
   *
   * Returns the caller's own object when nothing changes, so the ordinary path
   * allocates nothing and the identity a caller might compare is preserved.
   * @param spec - the spawn request.
   * @returns the spec to pass to the service — the same one, or a rewritten copy.
   */
  apply(spec: SubprocessSpawnSpec): SubprocessSpawnSpec {
    this.counters.spawnsSeen += 1
    try {
      const argv = spec.argv
      if (!Array.isArray(argv) || argv.length === 0) return spec
      if (!isGitExecutable(argv)) return spec
      this.counters.gitSpawns += 1
      if (carriesScrubMarker(spec.env)) this.counters.harnessGitSpawns += 1
      if (!selected(this.settings.scope, argv, spec.env)) return spec
      this.counters.selected += 1
      const rewritten = harden(argv, this.settings)
      if (rewritten === undefined) {
        this.counters.callerConfigured += 1
        return spec
      }
      if (this.settings.mode === 'report') {
        // The posture exists so an operator can measure their own deployment
        // before trusting a rewrite with it, so it runs the same decision and
        // stops one line short of the write.
        this.counters.wouldHarden += 1
        return spec
      }
      this.counters.hardened += 1
      if (!this.announced && this.settings.report) {
        this.announced = true
        this.note(
          `hardened the first selected invocation (git ${subcommandOf(argv)}) with ${rewritten.added.join(' ')};`
          + ' every later one is counted the same way',
        )
      }
      return { ...spec, argv: rewritten.argv }
    } catch (error: unknown) {
      // The guard's own failure must not become the caller's. Counted, so a
      // report that shows `failures > 0` cannot be mistaken for a quiet success.
      this.counters.failures += 1
      this.warn(`could not inspect a spawn, passing it through unchanged: ${String(error)}`)
      return spec
    }
  }

  /** Zero every counter, leaving the shadow and the settings in place. */
  reset(): void {
    Object.assign(this.counters, zeroCounters())
    this.announced = false
  }

  /**
   * The boundaries of this mitigation, as lines a report can print.
   *
   * Written as a function of the settings rather than a constant, so a scope,
   * a mode or a disabled fsmonitor is named when it is doing something —
   * a silent narrowing is the failure this list exists to prevent.
   * @returns the lines, each one a thing the plugin does not cover.
   */
  blindSpots(): string[] {
    const lines = [
      'A git command that does not go through the subprocess service is invisible here: the plugin manager probes install specs with its own execa() call, and repository scripts spawn git directly.',
      'Only invocations that start after the mount are inspected; one already running keeps the argv it was started with.',
      'spawnTerminal is deliberately not shadowed — a persistent shell is the user\'s own, and the hooks it runs are hooks the user installed.',
      'This is an argument-level mitigation, not a sandbox: anything outside the harness (the user\'s shell, another tool, a scheduled job) still runs repository hooks.',
      'A caller that already sets core.hooksPath or core.fsmonitor is respected and left alone, so the guard never overrides a call site that made its own decision.',
    ]
    if (this.settings.scope === 'harness') {
      lines.push('scope is "harness": a git invocation whose environment does not carry GIT_CONFIG_COUNT=0 is not selected, so a harness git call that does not follow the credential-scrub contract is unprotected.')
    } else {
      lines.push('scope is "all": every git executable on the subprocess service is hardened, including one a plugin or a PTC program spawns directly, so a git command a program issued with hooks intended loses them.')
    }
    if (this.settings.mode === 'report') {
      lines.push('mode is "report": nothing is rewritten, so wouldHarden counts what a hardened deployment would change and no invocation is protected.')
    }
    if (!this.settings.fsmonitor) {
      lines.push('fsmonitor is false: only core.hooksPath is neutralised, so a repository that configures core.fsmonitor still runs it.')
    }
    return lines
  }

  /** The current reading, with the counters copied so a caller cannot mutate the live state. */
  snapshot(): GuardSnapshot {
    return {
      mode: this.settings.mode,
      scope: this.settings.scope,
      counters: { ...this.counters },
      coverage: {
        patched: this.patched,
        neutralization: describeNeutralization(this.settings),
        notCovered: this.blindSpots(),
      },
      arguments: this.settings.fsmonitor
        ? ['-c', `core.hooksPath=${this.settings.hooksPath}`, '-c', 'core.fsmonitor=false']
        : ['-c', `core.hooksPath=${this.settings.hooksPath}`],
    }
  }
}
