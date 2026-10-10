#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins **the whole line**,
 * installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the `@deepseek-ai/dsh-subprocess` range is one line, and its
 * **newest** published build is the representative: the earliest build of a line is
 * an alpha nobody is left on, and probing it says less than probing the build the
 * line converged to.
 *
 * This plugin reads the subprocess service across those lines, so the probe is not
 * a formality: `spawn`'s spec shape, the provider class the suite mounts and the
 * `Symbol.for('cordis.original')` accessor are all read from the line's own build.
 * Four rules, because violating any of them measures the probe rather than the line:
 *
 * 1. **The whole line is pinned, not the packages this plugin happens to import.**
 *    The closure is walked from the two packages the suite reaches
 *    (`@deepseek-ai/dsh-subprocess` and `@deepseek-ai/dsh-subprocess-local`) through
 *    each line's own `dependencies` and `peerDependencies`, so a package a line adds
 *    between builds is picked up rather than missing. Pinning a subset leaves npm
 *    free to resolve the rest from another line, and the resulting tree is not the
 *    line.
 * 2. **`--legacy-peer-deps`.** Without it npm derives peers transitively and can
 *    install a second line's copy of a package to satisfy them — again a tree that
 *    is not the line. The installation is `npm ci`-free on purpose: there is no
 *    lockfile to honour, the pins *are* the specification.
 * 3. **Every pinned package's version is read back after install.** A pin that
 *    silently did not apply is the failure mode this whole script exists to prevent,
 *    so it is asserted rather than assumed, and the assertion runs before the suite
 *    so a mixed tree can never be reported as a passing line.
 * 4. **`@deepseek-ai/cordis` does not follow the line numbering.** Its constraint is
 *    read from the line's own manifest (`~4.0.4` on both lines today) and resolved
 *    from the published versions; a line whose constraint matches nothing is
 *    reported as unpinned rather than left for npm to choose.
 *
 * ```sh
 * node scripts/probe-lines.mjs                  # every line the range admits
 * node scripts/probe-lines.mjs -- 0.2.0-rc.2    # one line
 * node scripts/probe-lines.mjs --keep           # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED_LINES` note in the suite) rather than left claimed. This script is
 * development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The peer whose `||` segments define the lines this package claims to support. */
const SUBJECT = '@deepseek-ai/dsh-subprocess'

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/** The two packages whose dependency closure is walked to find the line's whole set. */
const ROOTS = [SUBJECT, '@deepseek-ai/dsh-subprocess-local']

/**
 * The newest published build of each `||` segment of a range.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

/** Read one field of a published manifest, or `undefined` when it is unreachable. */
function view(specifier, field) {
  try {
    const raw = execFileSync(
      'npm', ['view', specifier, field, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return JSON.parse(raw || 'null')
  } catch {
    return undefined
  }
}

/** Whether one package has a build at exactly this line. */
function publishedAt(name, line) {
  return view(`${name}@${line}`, 'version') !== undefined
}

/**
 * Every `@deepseek-ai/dsh-*` package the line carries, by walking outwards from the
 * two packages the suite reaches.
 *
 * Read from each line's own manifests rather than written down here: the set grows
 * between lines, and a list kept in this file would silently stop covering the line
 * it claims to check.
 * @param line - the line to read.
 * @returns the package names, in the order they were discovered.
 */
function linePackages(line) {
  const found = new Set()
  const queue = [...ROOTS]
  while (queue.length > 0) {
    const name = queue.shift()
    const declared = {
      ...(view(`${name}@${line}`, 'dependencies') ?? {}),
      ...(view(`${name}@${line}`, 'peerDependencies') ?? {}),
    }
    for (const dependency of Object.keys(declared)) {
      if (!dependency.startsWith('@deepseek-ai/dsh-') || found.has(dependency)) continue
      found.add(dependency)
      queue.push(dependency)
    }
  }
  return [...found]
}

/** Install the pinned tree, then assert that the pins are what was installed. */
function install(dir, log, pins) {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  const resolved = []
  for (const [name, wanted] of Object.entries(pins)) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
    resolved.push(`${name.replace('@deepseek-ai/', '')}@${installed}`)
    if (installed !== wanted) {
      throw new Error(`the pin did not apply: ${name} resolved to ${installed}, not ${wanted}`)
    }
  }
  log(`    pinned ${resolved.length} packages exactly: ${resolved.join(' ')}`)
}

/** Install one probe and run the suite in it. */
function probe(line) {
  const dir = mkdtempSync(join(tmpdir(), `git-hook-guard-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)

  const declared = [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.devDependencies), ...linePackages(line)]
  // Only the harness packages are counted as "declared": `semver` and `typescript`
  // are not candidates for a line pin, and counting them would report a hole that
  // does not exist.
  const dshDeclared = [...new Set(declared)].filter(name => name.startsWith('@deepseek-ai/dsh-'))
  const names = dshDeclared
    // A package the line never shipped cannot be pinned to it. Dropped rather than
    // silently resolved from another line: the count is printed, because a dropped
    // name is one hole in "the whole line" that the reader should see.
    .filter(name => publishedAt(name, line))
  const pins = Object.fromEntries(names.map(name => [name, line]))

  // Rule 4: cordis is line-independent, so its constraint is read from the line's
  // own manifest and resolved from the published versions.
  const cordisConstraint = (view(`${SUBJECT}@${line}`, 'peerDependencies') ?? {})['@deepseek-ai/cordis']
  const cordis = cordisConstraint === undefined
    ? undefined
    : semver.maxSatisfying(view('@deepseek-ai/cordis', 'versions') ?? [], cordisConstraint)
  if (typeof cordis === 'string') pins['@deepseek-ai/cordis'] = cordis

  log(`    pinning ${names.length} harness packages${dshDeclared.length - names.length > 0 ? ` (${dshDeclared.length - names.length} not published at this line, left unpinned)` : ''}`)
  log(`    line states cordis ${String(cordisConstraint)}${typeof cordis === 'string' ? `; pinned ${cordis}` : ' — UNMATCHED, left to npm'}`)

  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The pins live in `devDependencies` so the tree is exactly the line: the peers
    // are then satisfied by it, and nothing else is installed for them.
    devDependencies: { ...manifest.devDependencies, ...pins },
    // No `probe-lines` script here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)

  try {
    install(dir, log, pins)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies[SUBJECT]
const published = view(SUBJECT, 'versions') ?? []
const lines = requested.length > 0 ? requested : representativesOf(range, published)

const failed = lines.filter(line => !probe(line))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range and the README\n`)
  process.exitCode = 1
}
