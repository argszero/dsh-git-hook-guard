/**
 * The integration harness: a REAL cordis context, the REAL
 * `LocalSubprocessRuntime` from `@deepseek-ai/dsh-subprocess-local`, and a REAL
 * git repository whose `.git/config` carries the reporter's own `core.hooksPath
 * .hooks` with an executable `.hooks/post-index-change` in the work tree.
 *
 * Nothing about the seam is simulated. The plugin's whole claim is that a shadow
 * on the live subprocess instance is seen by the caller that captured the service
 * earlier — so the harness builds the caller the way `workspace-changes` builds
 * it: a `GitRunner`-shaped object that takes `ctx.subprocess` when it is
 * constructed and calls `.spawn` on it later. A test that stored the service
 * after mounting would prove only that a fresh lookup works, which was never in
 * doubt.
 *
 * Two pieces are fabricated on purpose:
 *
 * - the **stub provider**, used only where a test needs to read the argv that
 *   reached the service rather than its effect on a repository;
 * - the **hook script's marker path**, which is baked into the script text rather
 *   than read from the environment. A hook that reads `$MARKER` looks identical
 *   to a hook that never ran as soon as the child's environment is scrubbed —
 *   which is exactly the environment this plugin's whole subject runs under, and
 *   a false negative measured that way cost one round of this investigation.
 *
 * @module test/harness
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../lib/index.js'

/** The environment `GitRunner.run()` builds, verbatim in the parts that matter. */
export const GITRUNNER_ENV = {
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
}

/** Whether this host has a usable git at all; a test that needs one skips without it. */
export function gitAvailable() {
  try {
    const output = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return /^git version \d/.test(output)
  } catch {
    return false
  }
}

/** Run git directly, for setting a fixture up (never for the behaviour under test). */
function gitAt(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * A scratch repository that reproduces #9382 exactly as reported.
 *
 * `core.hooksPath .hooks` is the reporter's **relative** form, kept deliberately:
 * a repository that ships its hooks in a tracked directory is what a copied or
 * extracted project looks like, and a relative path is what such a project's own
 * installer writes. The hook is executable and its marker path is absolute and
 * baked in, so "the hook ran" is observable without trusting any environment.
 *
 * The hook fires on `post-index-change`, which git runs after the index is
 * written — `git add` and `git write-tree` reach it, `git rev-parse` and
 * `git ls-files` do not.
 * @param spec - `hook` names the hook to install; `hooksPath` overrides the config value.
 * @returns the repository, its marker, and a disposer.
 */
export function scratchRepo(spec = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'git-hook-guard-'))
  const repo = join(dir, 'repo')
  const marker = join(dir, 'marker.txt')
  gitAt(['init', '-q', repo], dir)
  gitAt(['config', 'user.email', 'guard@example.invalid'], repo)
  gitAt(['config', 'user.name', 'guard'], repo)
  mkdirSync(join(repo, '.hooks'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# scratch\n')
  const hookName = spec.hook ?? 'post-index-change'
  const hook = join(repo, '.hooks', hookName)
  writeFileSync(hook, `#!/bin/sh\necho "${hookName}" >> "${marker}"\n`)
  chmodSync(hook, 0o755)
  gitAt(['add', '--all'], repo)
  gitAt(['commit', '-qm', 'init'], repo)
  // Set AFTER the fixture's own commit, so the fixture never trips its own hook.
  gitAt(['config', '--local', 'core.hooksPath', spec.hooksPath ?? '.hooks'], repo)
  rmSync(marker, { force: true })
  return {
    dir,
    repo,
    marker,
    hook,
    /** How many times the hook ran since the last `clear()`. */
    runs: () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(line => line.length > 0).length : 0),
    /** Forget what ran so far. */
    clear: () => rmSync(marker, { force: true }),
    /** Make a real working-tree change, so the next index write actually fires the hook. */
    touch: (text = 'change') => appendFileSync(join(repo, 'README.md'), `${text} ${Math.random().toString(36).slice(2)}\n`),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * A stand-in for `workspace-changes`' `GitRunner`, down to the spec it builds.
 *
 * It takes the service at construction, exactly as `GitRunner`'s constructor
 * does, and calls `.spawn` on that captured reference at run time — the shape
 * that makes an instance shadow work and a fresh-lookup-only fix insufficient.
 * @param subprocess - the service, captured now.
 * @param executable - the resolved git path.
 * @returns an object with `run(args, options)`.
 */
export function gitRunner(subprocess, executable) {
  return {
    async run(args, options = {}) {
      const signal = options.signal ?? AbortSignal.timeout(30_000)
      const extra = options.env ?? {}
      const handle = subprocess.spawn({
        argv: [executable, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? 8 * 1024 * 1024 },
          stderr: { maxBytes: 16 * 1024 },
        },
        graceMs: 2_000,
        signal,
        // Verbatim from git.ts:59 — this environment is the guard's default fingerprint.
        env: { ...GITRUNNER_ENV, ...extra },
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0)?.text ?? '',
        stderr: handle.collected.stderr?.readFrom(0)?.text ?? '',
      }
    },
  }
}

/** The exit facts a stub handle reports; nothing in this plugin reads more. */
function fakeHandle(spec) {
  return {
    pid: 4242,
    argv: spec.argv,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
  }
}

/**
 * A provider that records every spec it is handed.
 *
 * Used where a test asserts the *argv* rather than the effect: a rewritten
 * invocation and an untouched one are indistinguishable from git's exit code,
 * and `harden` versus `report` differ by nothing else.
 */
export class RecordingSubprocess extends SubprocessRuntime {
  constructor(ctx) {
    super(ctx)
    /** Every spec handed to `spawn`, in order. */
    this.specs = []
  }

  async resolveExecutable(command) {
    return command
  }

  async terminalEnvironment() {
    return { platform: process.platform, shell: '/bin/sh' }
  }

  spawn(spec) {
    this.specs.push(spec)
    return fakeHandle(spec)
  }

  async spawnTerminal(spec) {
    this.specs.push(spec)
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: () => {},
      resize: () => {},
      terminate: async () => {},
      collected: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    }
  }
}

/**
 * Mount a real context with a real subprocess provider.
 *
 * `plugin: false` defers the guard's mount to the caller, which is how a test
 * captures the service *before* the shadow exists — the `GitRunner` ordering.
 * `plugin: 'default'` mounts the object a loader entry reaches rather than this
 * module's namespace; the two differ by the `Config` key (see
 * `test/mount.spec.mjs`).
 * @param spec - `provider` (`'local'` or `'stub'`), `plugin`, and `config`.
 * @returns the context, the captured log, the mount/dispose pair, and accessors.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  const Provider = spec.provider === 'stub' ? RecordingSubprocess : LocalSubprocessRuntime
  await ctx.plugin(Provider)
  const harness = {
    ctx,
    logged,
    /** The mounted fork, once `mount()` has run. */
    fork: undefined,
    /** The provider instance, for the recording stub. */
    provider: ctx.get('subprocess')[Symbol.for('cordis.original')] ?? ctx.get('subprocess'),
    mount: async () => {
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      return harness
    },
    dispose: async () => {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }
  if (spec.plugin !== false) await harness.mount()
  return harness
}

/** The service this plugin provides, or `undefined` when it did not mount one. */
export function service(harness) {
  return harness.ctx.get('gitHookGuard')
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}

/** Whether the plugin's shadow is currently installed on the provider instance. */
export function shadowInstalled(harness) {
  return Object.hasOwn(harness.provider, 'spawn')
}
