# @argszero/dsh-git-hook-guard

Stops the harness's own git commands from running a repository's hooks.

`workspace-changes` takes a working-tree snapshot through `GitRunner.run()` at every
top-level turn start. That call scrubs its environment and passes no `-c` flags, so
a `.git/config` that arrived with a clone — `core.hooksPath .hooks` — decides where
hooks live, and a repository-shipped `.hooks/post-index-change` executes with the
DSH user's privileges without any tool call asking for it
([#9382](https://github.com/deepseek-ai/deepseek-harness/discussions/9382); the
`core.fsmonitor` half is
[#9217](https://github.com/deepseek-ai/deepseek-harness/discussions/9217)).

This plugin shadows `spawn` on the subprocess service and, for the git invocations
the harness itself starts, inserts the two flags the repository's own code already
uses: `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.

It is an **argument-level mitigation, not a sandbox**, and it says so on every
report it serves.

## The gap, measured

`GitRunner.run()` builds a git child with this environment and no global options:

```
GIT_CONFIG_COUNT=0  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0  LC_ALL=C
git add --all --ignore-errors
```

`GIT_CONFIG_COUNT=0` is git's own switch for "no `GIT_CONFIG_KEY_n` entries were
injected"; the scrub cancels *environment-injected* configuration, which is what
its comment claims. It does nothing about the configuration git reads from the
invocation's own working directory. Measured on git 2.50.1 (Apple Git-155), with
`core.hooksPath .hooks` in `.git/config` and an executable `.hooks/post-index-change`
in the work tree:

| invocation | hook ran? |
|------------|-----------|
| `git add --all --ignore-errors` | **yes** — deterministically, with `GIT_TRACE=1` naming it |
| `GIT_CONFIG_COUNT=0 git add …` | **yes** — the existing scrub does not help |
| `git -c core.hooksPath=/dev/null add …` | no |
| `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=… git add …` | no (that is a different, environment-injected hook) |
| `git write-tree` | **yes** |
| `snapshotTree`'s private-index shape (`GIT_INDEX_FILE` + `GIT_OBJECT_DIRECTORY`) | **yes** |
| `git rev-parse`, `git ls-files --stage`, `git check-ignore` | no |

`post-index-change` fires only once the repository has a commit, which is why the
snapshot of a fresh clone is the first command that reaches it.

## Install

**In the application (the Desktop shell, and the Web UI).** Desktop's profile is the
application's own and cannot be managed from a terminal: `dsh --profile desktop` and
`dsh plugin --profile desktop …` are both refused before they run
(`apps/cli/src/args.ts`, `rejectElectronProfile`). Install it where that profile *is*
managed: open the sidebar's **Plugins** page, choose **Add plugin**, and give the
package name.

```
@argszero/dsh-git-hook-guard
```

**In a profile the launcher manages (web, tui, any custom profile).**

```sh
dsh plugin --profile <name> add @argszero/dsh-git-hook-guard
```

That command forwards to pnpm inside the profile directory, so
`npm install @argszero/dsh-git-hook-guard` run there is equivalent — a profile is an
ordinary package with its own `package.json`. Then mount it, or apply the bundled
patch, which mounts it and changes nothing else:

```yaml
- insert:
    - id: git-hook-guard
      name: '@argszero/dsh-git-hook-guard'
      inject:
        - subprocess
```

**Mount it in `report` mode first** if you want the number that justifies the change:

```yaml
- insert:
    - id: git-hook-guard
      name: '@argszero/dsh-git-hook-guard'
      config:
        mode: report
      inject:
        - subprocess
```

## Configuration

| key | default | meaning |
|-----|---------|---------|
| `mode` | `harden` | `harden` inserts the flags · `report` counts what it *would* rewrite and writes nothing · `off` mounts nothing at all |
| `scope` | `harness` | `harness` selects a git executable whose explicit environment carries `GIT_CONFIG_COUNT=0` · `all` selects every git executable on the subprocess service |
| `hooksPath` | `/dev/null` | the value `core.hooksPath` is pinned to |
| `fsmonitor` | `true` | whether `core.fsmonitor=false` is pinned as well |
| `report` | `true` | whether the mount and disposal summaries are logged |

Every invalid value **fails the mount** rather than being silently defaulted: a guard
whose configuration was quietly replaced by a default reports success while doing
something else, and the operator who wrote the typo is the one person who cannot see
it.

### Why `harden` is the default and `harness` is the default

The gap is that the flags are missing, and a mitigation an operator has to arm twice
is a mitigation that is off in the deployments that need it. So `harden` is the
default. But the *scope* has to be narrow, because the opposite mistake is worse:

- `harness` reads the distinction off the invocation — the scrub marker — and a
  user's git command cannot carry it, because a command issued through the shell
  tool has the shell in `argv[0]`. The hooks a user installed on purpose keep
  running, and `git commit` still runs its `pre-commit` hook.
- `all` covers more and overreaches more: a `git commit` a plugin or a PTC program
  spawns directly through the subprocess seam loses its hooks. It is there for
  operators who want it, and the snapshot says which scope is in force.

## What it does

- **Shadows `spawn` on the service instance**, reached by name lookup the way the
  vendored traceable proxy exposes it (`ctx.get('subprocess')[Symbol.for('cordis.original')]`).
  A second subprocess provider cannot be supplied — the service's own documentation
  says loading one throws — so the instance is the only seam, and it is the one that
  works: every in-repo caller reads `this.subprocess.spawn(...)` or
  `ctx.subprocess.spawn(...)` **at call time**, including `GitRunner`, which captures
  the service when `workspace-changes` applies. A service captured *before* this
  plugin mounts is still hardened.
- **Inserts at index 1** — immediately after the executable and therefore before
  everything else, including any `-C <path>` the caller passed. git only accepts `-c`
  before the subcommand, and that position is what makes the rewrite uniform: it does
  not have to find the subcommand to be valid.
- **Declines when the caller already configured a guarded key.** The repository's own
  hardened call site (`packages/experimental/worktree/src/index.ts:132`) passes these
  very flags; a guard that "helpfully" re-set them would be editing a caller that did
  the work already — and could be outvoted anyway, because git resolves a repeated
  `-c` for one key in favour of the later one. Those invocations are counted as
  `callerConfigured` instead.
- **Fails open.** The only paths out of the decision that are not "return the spec
  unchanged" are the ones that return a rewritten copy, and a throw anywhere inside
  is caught, counted as `failures`, and followed by the caller's own spec. A guard
  whose own bug broke every child process the harness starts would be a worse failure
  than the missing `-c` it exists to add.
- **Counts, with a denominator.** `spawnsSeen` is the denominator for every other
  number, because "the guard is mounted" and "the guard inspected nothing" look
  identical from the outside and only one of them is protection.

## The report

`gitHookGuard` is provided on the context:

```js
ctx.gitHookGuard.snapshot()
// {
//   mode: 'harden',
//   scope: 'harness',
//   counters: { spawnsSeen, gitSpawns, harnessGitSpawns, selected,
//               wouldHarden, hardened, callerConfigured, failures },
//   coverage: {
//     patched: true,                                  // false is a failure, not a posture
//     neutralization: 'core.hooksPath=/dev/null and core.fsmonitor=false',
//     notCovered: [ … the list below … ],
//   },
//   arguments: ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'],
// }

ctx.gitHookGuard.reset()   // zero the counters; the shadow and the settings stay
```

## What it does not cover

Printed on every snapshot rather than kept in a README, because a mitigation whose
boundaries are only in the documentation is a mitigation someone will over-trust:

- A git command that does not go through the subprocess service is invisible here.
  The plugin manager probes install specs with its own `execa()` call
  (`packages/boot/plugin-manager/src/github-connection.ts` runs `git ls-remote`
  directly), and repository scripts spawn git directly.
- Only invocations that start after the mount are inspected; one already running
  keeps the argv it was started with.
- `spawnTerminal` is deliberately **not** shadowed — a persistent shell is the
  user's own, and the hooks it runs are hooks the user installed.
- This is an argument-level mitigation, not a sandbox: anything outside the harness
  (the user's shell, another tool, a scheduled job) still runs repository hooks.
- A caller that already sets `core.hooksPath` or `core.fsmonitor` is respected and
  left alone.
- Plus one line for whichever of `scope`, `mode` and `fsmonitor` is doing something:
  a silent narrowing is the failure that list exists to prevent.

## The real fix

This plugin is a mitigation, not the fix. The fix belongs where the flags are missing
— `GitRunner.run()` in `packages/deliverables/workspace-changes/src/git.ts` — and the
in-tree precedent is already there:

```ts
// packages/experimental/worktree/src/index.ts:132
[gitCommand, '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
```

Until that lands, this is the seam a plugin can reach.

## Development

```sh
npm install
npm test                  # tsc, then the suite
npm run test:inject       # defect injection: every arm must be CAUGHT
npm run test:probe-lines  # the peer range, line by line
```

The suite has three layers, and only the third is the claim:

- unit arms for the discriminator, the rewrite and the counters;
- an integration arm that builds the reproduction from #9382 — a real repository, a
  real `.git/config`, a real git — with a **positive control** that measures the
  premise (the hook *does* run without the guard) before anything is asserted about
  hardening. A suite that only asserted "no marker appeared" would pass on a host
  where the hook never runs for any reason;
- a faithful stand-in for `workspace-changes`' `GitRunner`, which takes the service at
  construction and calls `.spawn` on that captured reference at run time — the shape
  that makes an instance shadow work and a fresh-lookup-only fix insufficient.

The hook script writes to a path **baked into its own text**, never to `$MARKER`: a
hook that reads its marker from the environment looks identical to a hook that never
ran as soon as the environment is scrubbed, which is exactly the environment this
plugin's subject runs under.

## License

MIT
