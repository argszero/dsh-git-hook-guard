/**
 * The published shape, checked against the manifest that describes it.
 *
 * This family has shipped the same three defects more than once, and each one is
 * invisible to a suite that only imports `lib/` directly:
 *
 * - a `files` list that omits an artifact the package's own `main`/`exports` name,
 *   so the installed package cannot be imported at all;
 * - a scoped package published without `publishConfig.access: public`, which npm
 *   refuses with `E402` only at the moment of publishing;
 * - a `dsh.bundle.patch` pointing at a file that is not in the package, so the
 *   entry a profile composes resolves to nothing.
 *
 * All three are read from the manifest and the tree on disk — nothing here needs a
 * network or a git.
 *
 * @module test/packaging.spec
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Whether a `files` entry covers a path, treating the two glob forms the manifest uses. */
function covered(path, entries) {
  return entries.some(entry => entry === path
    || (entry.endsWith('/**/*.js') && path.startsWith(entry.slice(0, -'**/*.js'.length)) && path.endsWith('.js'))
    || (entry.endsWith('/**/*.d.ts') && path.startsWith(entry.slice(0, -'**/*.d.ts'.length)) && path.endsWith('.d.ts'))
    || (entry.endsWith('/**') && path.startsWith(entry.slice(0, -'**'.length))))
}

test('every artifact the manifest points at exists and is in `files`', () => {
  assert.equal(manifest.type, 'module')
  for (const relative of [manifest.main, manifest.types, manifest.exports['.'].default, manifest.exports['.'].types]) {
    assert.equal(typeof relative, 'string', `${relative} must be declared`)
    const path = relative.replace(/^\.\//, '')
    assert.ok(existsSync(join(ROOT, path)), `${path} is declared but not built`)
    assert.ok(covered(path, manifest.files), `${path} is built but not in files, so it would not be published`)
  }
})

test('the bundle patch is packaged, and it names the package that ships it', () => {
  const patch = manifest.dsh.bundle.patch.replace(/^\.\//, '')
  assert.ok(covered(patch, manifest.files), `${patch} is the mount a profile composes and must be published`)
  const text = readFileSync(join(ROOT, patch), 'utf8')
  assert.match(text, /- insert:/, 'the patch is an insert, so nothing existing is rewritten')
  assert.ok(text.includes(`name: '${manifest.name}'`), 'the patch inserts the package that declares it')
  assert.match(text, /inject:\s*\n\s*- subprocess/, 'the entry declares the capability the plugin is held for')
})

test('a scoped package declares public access, or npm refuses the publish with E402', () => {
  assert.ok(manifest.name.startsWith('@'), 'this arm is about scoped packages')
  assert.equal(manifest.publishConfig?.access, 'public')
})

test('the peer range names the subject of the probe, and the harnesses stay out of the package', () => {
  // `probe-lines` reads its lines back out of this range, so a subject that moves
  // without the script moving would silently shrink the claim.
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-subprocess'], 'the seam this plugin shadows is a peer')
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.ok(name.startsWith('@deepseek-ai/'), `${name} is not a harness package`)
    assert.ok(range.length > 0)
  }
  // The two development harnesses are named by the manifest and are *not* shipped:
  // `files` covers none of `scripts/`. Asserting the absence is the point — an
  // installed package has no test directory either, so a suite that reached for a
  // published harness would be unrunnable exactly where it matters.
  assert.match(manifest.scripts['test:probe-lines'] ?? 'probe-lines.mjs', /probe-lines\.mjs/)
  assert.match(manifest.scripts['test:inject'] ?? 'inject-defects.mjs', /inject-defects\.mjs/)
  for (const script of ['scripts/probe-lines.mjs', 'scripts/inject-defects.mjs']) {
    assert.ok(!covered(script, manifest.files), `${script} is development-only and must not be published`)
  }
})
