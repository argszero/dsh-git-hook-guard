/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT
 * — it proves nothing about the suite, and it is reported as a failure of the
 * harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm is a defect this plugin could plausibly have shipped: one distinction
 * it exists to make, removed one line at a time. The distinctions were chosen
 * from the plugin's own promises — the discriminator that keeps a user's `git
 * commit` out of the guard, the insertion position git actually accepts, the
 * declining rule, the four configuration knobs, the counters a security claim is
 * worth nothing without, and the instance shadow itself — so a SILENT arm is a
 * claim the package makes to its users that nothing checks.
 *
 * Two arms are written as a never-true predicate rather than `if (false)`: a
 * literal `false` can make a branch unreachable and TypeScript then narrows the
 * code after it into a compile error, which would report TYPEFAIL instead of
 * testing the behaviour.
 *
 * ```sh
 * node scripts/inject-defects.mjs                    # every arm
 * node scripts/inject-defects.mjs --filter=detect    # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  // ---------------------------------------------------------------- detect ---
  {
    // Windows executable names are case-insensitive, and `GIT.EXE` is a spelling
    // a real deployment reaches. Without this the guard silently protects
    // nothing on such a host.
    name: 'detect: the executable test becomes case-sensitive',
    file: 'src/detect.ts',
    edits: [['  const name = executableName(first).toLowerCase()', '  const name = executableName(first)']],
  },
  {
    name: 'detect: a Windows git.exe is no longer the git binary',
    file: 'src/detect.ts',
    edits: [["const GIT_EXECUTABLES: readonly string[] = ['git', 'git.exe']", "const GIT_EXECUTABLES: readonly string[] = ['git']"]],
  },
  {
    // A quoted argv[0] arrives with its quotes when the path has spaces.
    name: 'detect: a quoted argv[0] is not unwrapped',
    file: 'src/detect.ts',
    edits: [['  if (name.length >= 2 && name.startsWith(\'"\') && name.endsWith(\'"\')) name = name.slice(1, -1)', "  if (name.startsWith('\\u0000')) name = name.slice(1, -1)"]],
  },
  {
    name: 'detect: a backslash path is not split by its last separator',
    file: 'src/detect.ts',
    edits: [["  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\\\'))", "  const cut = name.lastIndexOf('/')"]],
  },
  {
    // The marker is git's own switch for "no environment-injected config". A
    // different value means the caller *is* injecting config, so accepting any
    // value would select invocations that are not the harness's bookkeeping.
    name: 'detect: the scrub marker is read loosely instead of exactly',
    file: 'src/detect.ts',
    edits: [["  return env !== undefined && env.GIT_CONFIG_COUNT === '0'", '  return env !== undefined && env.GIT_CONFIG_COUNT !== undefined']],
  },
  {
    // The conjunction is the whole security argument: dropping the environment
    // test is what turns `harness` into `all` without saying so.
    name: 'detect: the default scope stops consulting the environment',
    file: 'src/detect.ts',
    edits: [["  return scope === 'all' || carriesScrubMarker(env)", "  return scope === 'all' || scope === 'harness'"]],
  },

  // ---------------------------------------------------------------- harden ---
  {
    // The repository's own hardened call site passes these very flags; a guard
    // that re-set them edits a caller that did the work and can be outvoted
    // anyway, because git resolves a repeated `-c` in favour of the later one.
    name: 'harden: a caller that configured a guarded key is overridden anyway',
    file: 'src/harden.ts',
    edits: [['  if (callerConfiguredKeys(argv).length > 0) return undefined', '  if (callerConfiguredKeys(argv).length < 0) return undefined']],
  },
  {
    // git only accepts `-c` before the subcommand; an argv that gains them
    // anywhere else is an argv git refuses.
    name: 'harden: the flags are appended instead of inserted after the executable',
    file: 'src/harden.ts',
    edits: [['  return { argv: [argv[0] as string, ...added, ...argv.slice(1)], added }', '  return { argv: [...argv, ...added], added }']],
  },
  {
    name: 'harden: the two-token -c form is not read',
    file: 'src/harden.ts',
    edits: [["    if (token === '-c' || token === '--config') {", "    if (token === '--config') {"]],
  },
  {
    name: 'harden: the single-token -cname=value form is not read',
    file: 'src/harden.ts',
    edits: [["    if (token.startsWith('-c') && token.length > 2) {", "    if (token.startsWith('-Zc') && token.length > 2) {"]],
  },
  {
    name: 'harden: the --config=name=value form is not read',
    file: 'src/harden.ts',
    edits: [["    if (token.startsWith('--config=')) {", "    if (token.startsWith('--Zconfig=')) {"]],
  },
  {
    // Keys are case-insensitive in git config, and a mixed-case spelling in argv
    // is real — `Core.HooksPath` is the same decision as `core.hooksPath`.
    name: 'harden: a config key read from argv keeps its case',
    file: 'src/harden.ts',
    edits: [['      const key = (separator === -1 ? name : name.slice(0, separator)).trim().toLowerCase()', '      const key = (separator === -1 ? name : name.slice(0, separator)).trim()']],
  },
  {
    // A value-taking option does not hide the next option; without the skip the
    // walk reads the option's *value* as if it were a key.
    name: 'harden: the walk does not step over a value-taking option',
    file: 'src/harden.ts',
    edits: [['    index += VALUE_TAKING.includes(token) ? 2 : 1\n  }\n  return settings', '    index += 1\n  }\n  return settings']],
  },
  {
    name: 'harden: subcommandOf names a subcommand where there is none',
    file: 'src/harden.ts',
    edits: [["  return '(none)'", "  return ''"]],
  },

  // ---------------------------------------------------------------- config ---
  {
    // A guard whose configuration was silently replaced by a default reports
    // success while doing something else, and the operator who wrote the typo is
    // the one person who cannot see it.
    name: 'config: an unknown mode is accepted instead of refused',
    file: 'src/config.ts',
    // Inverted rather than `if (false)`: a literal `false` makes the branch
    // unreachable and TypeScript then narrows the code after it into a compile
    // error, which would report TYPEFAIL instead of testing the behaviour.
    edits: [['  if (!MODES.includes(mode)) {', '  if (MODES.includes(mode)) {']],
  },
  {
    name: 'config: an unknown scope is accepted instead of refused',
    file: 'src/config.ts',
    edits: [['  if (!SCOPES.includes(scope)) {', '  if (SCOPES.includes(scope)) {']],
  },
  {
    // An empty hooksPath cannot be inserted: it would produce
    // `core.hooksPath=` in the invocation.
    name: 'config: an empty hooksPath is accepted',
    file: 'src/config.ts',
    edits: [["  if (typeof hooksPath !== 'string' || hooksPath.length === 0) {", "  if (typeof hooksPath !== 'string') {"]],
  },
  {
    name: 'config: a non-boolean fsmonitor is accepted',
    file: 'src/config.ts',
    edits: [["  if (typeof fsmonitor !== 'boolean') {", '  if (fsmonitor === undefined) {']],
  },
  {
    name: 'config: the default mode stops hardening',
    file: 'src/config.ts',
    edits: [["  mode: 'harden',", "  mode: 'report',"]],
  },
  {
    // The narrow default is what keeps a user's own `git commit` out of the
    // guard; widening it silently changes whose hooks run.
    name: 'config: the default scope widens to every git invocation',
    file: 'src/config.ts',
    edits: [["  scope: 'harness',", "  scope: 'all',"]],
  },
  {
    name: 'config: the default hooks path is emptied',
    file: 'src/config.ts',
    edits: [["  hooksPath: '/dev/null',", "  hooksPath: '',"]],
  },
  {
    name: 'config: fsmonitor is off by default',
    file: 'src/config.ts',
    edits: [['  fsmonitor: true,', '  fsmonitor: false,']],
  },
  {
    name: 'config: the fsmonitor flag is added even when it is turned off',
    file: 'src/config.ts',
    edits: [["  if (settings.fsmonitor) arguments_.push('-c', 'core.fsmonitor=false')", "  if (settings.hooksPath !== undefined) arguments_.push('-c', 'core.fsmonitor=false')"]],
  },
  {
    name: 'config: a guarded key is dropped from the list the guard declines on',
    file: 'src/config.ts',
    edits: [["export const GUARDED_KEYS: readonly string[] = ['core.hookspath', 'core.fsmonitor']", "export const GUARDED_KEYS: readonly string[] = ['core.fsmonitor']"]],
  },

  // ----------------------------------------------------------------- guard ---
  {
    name: 'guard: a git spawn is not counted',
    file: 'src/guard.ts',
    edits: [['      this.counters.gitSpawns += 1\n', '']],
  },
  {
    name: 'guard: a selected invocation is not counted',
    file: 'src/guard.ts',
    edits: [['      this.counters.selected += 1\n', '']],
  },
  {
    // `report` exists so an operator can measure a deployment before trusting a
    // rewrite with it; a report posture that rewrites takes the measurement on
    // an already-changed deployment.
    name: 'guard: mode "report" rewrites after all',
    file: 'src/guard.ts',
    edits: [["      if (this.settings.mode === 'report') {", "      if (this.settings.mode === 'harden') {"]],
  },
  {
    name: 'guard: a caller that configured a key is not counted',
    file: 'src/guard.ts',
    edits: [['        this.counters.callerConfigured += 1\n', '']],
  },
  {
    // The guard's own failure must not become the caller's.
    name: 'guard: a failure inside the decision reaches the caller',
    file: 'src/guard.ts',
    edits: [["      this.warn(`could not inspect a spawn, passing it through unchanged: ${String(error)}`)\n      return spec", '      this.warn(`could not inspect a spawn, passing it through unchanged: ${String(error)}`)\n      throw error']],
  },
  {
    name: 'guard: a failure inside the decision is not counted',
    file: 'src/guard.ts',
    edits: [['      this.counters.failures += 1\n', '']],
  },
  {
    name: 'guard: reset does not zero the counters',
    file: 'src/guard.ts',
    edits: [['    Object.assign(this.counters, zeroCounters())', '    void this.counters']],
  },
  {
    name: 'guard: the snapshot hands out the live counters',
    file: 'src/guard.ts',
    edits: [['      counters: { ...this.counters },', '      counters: this.counters,']],
  },
  {
    // A silent narrowing is the failure the blindness list exists to prevent.
    name: 'guard: the narrow scope does not state what it does not select',
    file: 'src/guard.ts',
    edits: [["    if (this.settings.scope === 'harness') {", "    if (this.settings.scope === 'all') {"]],
  },
  {
    name: 'guard: the wide scope does not name its overreach',
    file: 'src/guard.ts',
    edits: [[
      "      lines.push('scope is \"all\": every git executable on the subprocess service is hardened, including one a plugin or a PTC program spawns directly, so a git command a program issued with hooks intended loses them.')",
      "      lines.push('')",
    ]],
  },
  {
    name: 'guard: the report posture does not say it protects nothing',
    file: 'src/guard.ts',
    edits: [["    if (this.settings.mode === 'report') {", "    if (this.settings.mode === 'harden') {"]],
  },
  {
    name: 'guard: a disabled fsmonitor half is not named',
    file: 'src/guard.ts',
    edits: [['    if (!this.settings.fsmonitor) {', '    if (this.settings.fsmonitor) {']],
  },
  {
    // The blindness list is emitted on every snapshot rather than kept in a
    // README a reader has to find.
    name: 'guard: the execa blind spot is dropped from the list',
    file: 'src/guard.ts',
    edits: [[
      "'A git command that does not go through the subprocess service is invisible here: the plugin manager probes install specs with its own execa() call, and repository scripts spawn git directly.',",
      "'A git command that does not go through the subprocess service is invisible here.',",
    ]],
  },
  {
    name: 'guard: the snapshot claims the shadow is installed when it is not',
    file: 'src/guard.ts',
    edits: [['        patched: this.patched,', '        patched: true,']],
  },

  // ----------------------------------------------------------------- index ---
  {
    // EQUIVALENT, and measured rather than assumed. A cordis `get` hands back a
    // fresh view on every read, so the expectation was that a shadow written to
    // the view is seen by nobody. It is not so: the traceable proxy's `set` trap
    // ends in `Reflect.set(target, prop, value, shadow)`
    // (`vendor/cordis/src/utils.ts:210-211`), and for this service the receiver is
    // the instance, so the write lands on the instance either way — `Object.hasOwn
    // (instance, 'spawn')` is true after a write to *any* view. The suite is
    // therefore right to stay green, and the explicit `underlying` resolution is
    // kept because a read hands back a *wrapper* rather than the stored function
    // (`v1.spawn !== marker` while `instance.spawn === marker`), so the forwarding
    // is a property of this cordis version and not of the plugin's own protocol.
    name: 'index: the shadow is written to the view instead of the instance',
    equivalent: 'the traceable proxy set trap forwards to the instance (measured)',
    file: 'src/index.ts',
    edits: [[
      "      Reflect.set(underlying, 'spawn', function (this: SubprocessRuntime, spec: SubprocessSpawnSpec): SubprocessHandle {",
      "      Reflect.set(view as object, 'spawn', function (this: SubprocessRuntime, spec: SubprocessSpawnSpec): SubprocessHandle {",
    ]],
  },
  {
    name: 'index: mode "off" installs the shadow anyway',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') return", "  if (settings.mode === 'harden') return"]],
  },
  {
    name: 'index: the shadow never calls the guard',
    file: 'src/index.ts',
    edits: [['        return original.call(this, guard.apply(spec))', '        return original.call(this, spec)']],
  },
  {
    // "nothing needed hardening" and "nothing could be hardened" are different
    // answers, and only one of them is protection.
    name: 'index: the service reports itself unpatched while patched',
    file: 'src/index.ts',
    edits: [['      guard.patched = true', '      guard.patched = false']],
  },
  {
    name: 'index: the mount is not reported',
    file: 'src/index.ts',
    edits: [['    if (installed && settings.report) {', '    if (installed && !settings.report) {']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a wait can leave the suite
 * polling until its own deadline, and a mutant that never terminates is a mutant
 * the suite cannot report on. It is killed here and counted as caught, which is
 * what it is — the suite never reaches its assertions because the code under test
 * never returns.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns whether it succeeded, and the text it produced.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
