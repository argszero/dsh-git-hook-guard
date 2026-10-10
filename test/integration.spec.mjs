/**
 * The claim, measured against a real repository and a real git.
 *
 * This is the file the plugin is worth anything without: it builds the
 * reproduction from #9382 — a repository whose `.git/config` carries
 * `core.hooksPath .hooks` and whose work tree ships an executable
 * `.hooks/post-index-change` — and runs the harness's own snapshot command
 * through a `GitRunner`-shaped caller and the REAL local subprocess provider.
 *
 * The first arm is a **positive control**, and it is not optional: it measures
 * the premise (this git build runs that hook for that command) before anything
 * is asserted about hardening. A suite that only asserted "no marker appeared"
 * would pass on a host where the hook never runs for any reason, which is
 * exactly the false negative that cost one round of this investigation — a hook
 * that reads `$MARKER` from the environment loses its marker to the very
 * environment scrub the plugin's subject runs under. The hook here writes to a
 * path baked into its own text, so "it ran" cannot be hidden by an empty
 * environment.
 *
 * Every arm creates a fresh repository and a fresh context, so the only
 * difference between a control and its hardened twin is the mount.
 *
 * @module test/integration.spec
 */

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gitAvailable, gitRunner, scratchRepo, service, world } from './harness.mjs'

/** The harness's own snapshot command, verbatim from `git.ts`'s `snapshotTree`. */
const SNAPSHOT = ['add', '--all', '--ignore-errors']

const hasGit = gitAvailable()

/** Resolve git the way `workspace-changes` does, once, for every arm. */
async function resolveGit(ctx) {
  return ctx.subprocess.resolveExecutable('git')
}

test('the premise: without the guard, the snapshot runs the repository\'s hook', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({ plugin: false })
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    repo.touch('control')
    const result = await git.run(SNAPSHOT, { cwd: repo.repo })
    assert.equal(result.exitCode, 0, `git add must succeed, stderr: ${result.stderr}`)
    assert.equal(repo.runs(), 1, 'the reported reproduction must reproduce, or every hardened arm below proves nothing')
    await harness.dispose()
  } finally {
    repo.done()
  }
})

test('a mounted guard stops the snapshot from running it, for a caller that captured the service first', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({ plugin: false })
    // The ordering `workspace-changes` has: the service is in hand before this
    // plugin exists, and the reference is the one the git calls go through.
    const captured = harness.ctx.get('subprocess')
    const git = gitRunner(captured, await resolveGit(harness.ctx))
    await harness.mount()
    repo.touch('hardened')
    const result = await git.run(SNAPSHOT, { cwd: repo.repo })
    assert.equal(result.exitCode, 0, `git add must still succeed, stderr: ${result.stderr}`)
    assert.equal(repo.runs(), 0, 'the repository\'s post-index-change hook did not run')
    assert.ok(service(harness).snapshot().counters.hardened >= 1, 'and the guard says it rewrote something')
  } finally {
    repo.done()
  }
})

test('the same command through the property read is hardened too', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({})
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    repo.touch('property')
    assert.equal((await git.run(SNAPSHOT, { cwd: repo.repo })).exitCode, 0)
    assert.equal(repo.runs(), 0)
  } finally {
    repo.done()
  }
})

test('mode "report" measures the gap without closing it', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({ config: { mode: 'report' } })
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    repo.touch('report')
    assert.equal((await git.run(SNAPSHOT, { cwd: repo.repo })).exitCode, 0)
    assert.equal(repo.runs(), 1, 'nothing was rewritten, so the hook still ran — the measurement is of the real deployment')
    const counters = service(harness).snapshot().counters
    assert.equal(counters.wouldHarden, 1)
    assert.equal(counters.hardened, 0)
  } finally {
    repo.done()
  }
})

test('disposing the plugin restores the deployment it found', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({})
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    repo.touch('before')
    await git.run(SNAPSHOT, { cwd: repo.repo })
    assert.equal(repo.runs(), 0, 'hardened while mounted')
    await harness.dispose()
    repo.touch('after')
    await git.run(SNAPSHOT, { cwd: repo.repo })
    assert.equal(repo.runs(), 1, 'and unhardened again once the plugin is gone')
  } finally {
    repo.done()
  }
})

test('the private-index snapshot shape is hardened as well', { skip: !hasGit && 'no git on this host' }, async () => {
  // `snapshotTree` writes into a scratch index with a private object store, so
  // the invocation that fires the hook is not the plain one.
  const repo = scratchRepo()
  try {
    const scratch = mkdtempSync(join(repo.dir, 'index-'))
    try {
      copyFileSync(join(repo.repo, '.git', 'index'), join(scratch, 'index'))
      const env = {
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo.repo, '.git', 'objects'),
      }
      mkdirSync(env.GIT_OBJECT_DIRECTORY, { recursive: true })

      const control = await world({ plugin: false })
      const controlGit = gitRunner(control.ctx.subprocess, await resolveGit(control.ctx))
      repo.touch('private-control')
      assert.equal((await controlGit.run(SNAPSHOT, { cwd: repo.repo, env })).exitCode, 0)
      assert.equal(repo.runs(), 1, 'the private-index shape fires the hook too')
      await control.dispose()

      repo.clear()
      const guarded = await world({})
      const guardedGit = gitRunner(guarded.ctx.subprocess, await resolveGit(guarded.ctx))
      repo.touch('private-guarded')
      assert.equal((await guardedGit.run(SNAPSHOT, { cwd: repo.repo, env })).exitCode, 0)
      assert.equal(repo.runs(), 0, 'and the guard covers that shape as well')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } finally {
    repo.done()
  }
})

test('the guarded snapshot still answers the questions it is asked', { skip: !hasGit && 'no git on this host' }, async () => {
  // Hardening that broke the snapshot would be a worse defect than the hook.
  const repo = scratchRepo()
  try {
    const harness = await world({})
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    const root = await git.run(['rev-parse', '--show-toplevel'], { cwd: repo.repo })
    assert.equal(root.exitCode, 0)
    assert.equal(root.stdout.trim(), realpathSync(repo.repo))
    repo.touch('tree')
    assert.equal((await git.run(SNAPSHOT, { cwd: repo.repo })).exitCode, 0)
    const tree = await git.run(['write-tree'], { cwd: repo.repo })
    assert.match(tree.stdout.trim(), /^[0-9a-f]{40}$/, 'write-tree still produces a tree id')
    const files = await git.run(['ls-files', '-z', '--stage'], { cwd: repo.repo })
    assert.equal(files.exitCode, 0)
    assert.ok(files.stdout.includes('README.md'), 'ls-files still lists the work tree')
    assert.equal(repo.runs(), 0, 'and none of it ran the hook')
  } finally {
    repo.done()
  }
})

test('a caller that sets its own git config is not overridden in the real path either', { skip: !hasGit && 'no git on this host' }, async () => {
  const repo = scratchRepo()
  try {
    const harness = await world({})
    const git = gitRunner(harness.ctx.subprocess, await resolveGit(harness.ctx))
    // A real working-tree change, not just a command: git writes the index only
    // when it changes, and `post-index-change` only fires on a written index. A
    // clean tree here made this arm depend on git deciding to refresh the index
    // stat cache anyway, which is a race — the probe caught it failing about once
    // in eight runs on one line and never on the other.
    repo.touch('caller-config')
    const result = await git.run(
      ['-c', `core.hooksPath=${repo.repo}/.hooks`, ...SNAPSHOT],
      { cwd: repo.repo },
    )
    assert.equal(result.exitCode, 0, `git add must succeed, stderr: ${result.stderr}`)
    assert.equal(repo.runs(), 1, 'the caller asked for that hooks path, and gets it')
    assert.equal(service(harness).snapshot().counters.callerConfigured, 1)
  } finally {
    repo.done()
  }
})
