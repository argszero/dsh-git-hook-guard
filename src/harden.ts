/**
 * The rewrite itself: where the flags go, and when the guard declines to add
 * them.
 *
 * Insertion is at index 1 — immediately after the executable and therefore
 * before everything else, including any `-C <path>` the caller passed — because
 * git only accepts `-c` before the subcommand. That position is also what makes
 * the rewrite uniform: it does not have to find the subcommand to be valid.
 *
 * Declining is the interesting half. A caller that already sets `core.hooksPath`
 * or `core.fsmonitor` has made a decision about git configuration, and the guard
 * does not overrule it — the repository's own hardened call sites
 * (`packages/experimental/worktree/src/index.ts`) are exactly this case, and a
 * guard that "helpfully" re-set the keys would be editing a caller that did the
 * work already. Worse: git resolves a repeated `-c` for one key in favour of the
 * later one, so an inserted copy could be silently outvoted anyway. The guard
 * therefore reads the invocation and counts it as `callerConfigured` instead.
 *
 * @module @argszero/dsh-git-hook-guard/harden
 */

import { GUARDED_KEYS, hardeningArguments } from './config.ts'
import type { Settings } from './config.ts'

/** A rewrite that was applied: the new argv, and the arguments it gained. */
export interface Hardened {
  /** The argument vector to hand the subprocess service. */
  readonly argv: readonly string[]
  /** The slice inserted at index 1, so a report can quote it. */
  readonly added: readonly string[]
}

/**
 * The git global options that consume the token after them.
 *
 * Only used to keep the walk below from mistaking an option's *value* for the
 * subcommand. Being incomplete is safe and deliberate: stopping the walk early
 * can only make the guard miss a caller-set key, and a missed key means the
 * guard inserts its own flags in front of a caller's — git resolves the later
 * `-c` first, so the caller's decision still wins and no hook is re-enabled.
 */
const VALUE_TAKING: readonly string[] = ['-c', '--config', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']

/**
 * The `-c`/`--config` settings an invocation carries, walked over the global
 * option region only.
 *
 * Both spellings git accepts are read: `-c name=value` / `--config name=value`
 * as two tokens, and `-cname=value` / `--config=name=value` as one. The walk
 * stops at the first token that is not an option, which is the subcommand — the
 * point past which git itself stops reading global options.
 * @param argv - the full argument vector, `argv[0]` being the executable.
 * @returns the settings, keyed by lowercased name.
 */
export function explicitSettings(argv: readonly string[]): Map<string, string> {
  const settings = new Map<string, string>()
  let index = 1
  while (index < argv.length) {
    const token = argv[index] as string
    if (token === '--') break
    if (!token.startsWith('-')) break
    const record = (name: string, value: string): void => {
      const separator = name.indexOf('=')
      const key = (separator === -1 ? name : name.slice(0, separator)).trim().toLowerCase()
      settings.set(key, separator === -1 ? value : name.slice(separator + 1))
    }
    if (token === '-c' || token === '--config') {
      const value = argv[index + 1]
      if (value === undefined) break
      record(value, '')
      index += 2
      continue
    }
    if (token.startsWith('-c') && token.length > 2) {
      record(token.slice(2), '')
      index += 1
      continue
    }
    if (token.startsWith('--config=')) {
      record(token.slice('--config='.length), '')
      index += 1
      continue
    }
    index += VALUE_TAKING.includes(token) ? 2 : 1
  }
  return settings
}

/**
 * The guarded keys an invocation already sets, if any.
 * @param argv - the full argument vector.
 * @returns the names of the guarded keys the caller configured, lowercased.
 */
export function callerConfiguredKeys(argv: readonly string[]): string[] {
  const settings = explicitSettings(argv)
  return GUARDED_KEYS.filter(key => settings.has(key))
}

/**
 * The subcommand an invocation runs, for a report line.
 *
 * Best-effort and only ever used for text: the first token after the executable
 * that is not an option, with the option region walked the same way
 * {@link explicitSettings} walks it.
 * @param argv - the full argument vector.
 * @returns the subcommand, or `(none)` when the invocation has none.
 */
export function subcommandOf(argv: readonly string[]): string {
  let index = 1
  while (index < argv.length) {
    const token = argv[index] as string
    if (token === '--' || !token.startsWith('-')) return token
    index += VALUE_TAKING.includes(token) ? 2 : 1
  }
  return '(none)'
}

/**
 * Rewrite one selected invocation, or explain why the guard declined.
 *
 * @param argv - the invocation's argument vector.
 * @param settings - the resolved configuration.
 * @returns the hardened argv, or `undefined` when the caller configured a guarded key itself.
 */
export function harden(argv: readonly string[], settings: Settings): Hardened | undefined {
  if (callerConfiguredKeys(argv).length > 0) return undefined
  const added = hardeningArguments(settings)
  return { argv: [argv[0] as string, ...added, ...argv.slice(1)], added }
}

/**
 * The neutralisation a rewrite applies, as a sentence for the report.
 * @param settings - the resolved configuration.
 * @returns the description.
 */
export function describeNeutralization(settings: Settings): string {
  const parts = [`core.hooksPath=${settings.hooksPath}`]
  if (settings.fsmonitor) parts.push('core.fsmonitor=false')
  return parts.join(' and ')
}
