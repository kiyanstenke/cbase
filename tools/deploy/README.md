# `tools/deploy/` — the deploy tool

Description, targets, options and gates: **`DEPLOY.md` in the repository root.** This file only holds what hangs on a
guard or on a folder of this tool. Tests named here live next to it (`tools/deploy/*.test.mjs`) unless a path says otherwise; guards that read private data are covered by the maintainer's private suite and are not named here; the gate's libraries and the product guards that came from this folder live in `tools/check/` (same relative layout: `lib/sh.mjs` is `tools/check/lib/sh.mjs`).

The maintainer's tree carries a private remainder of this tool (the `baseline` target, the pin-sync guard, the merged gate plan, the tests that read private data, the list of what never leaves the private repository, and recorded old files for counter-tests). The public tool reaches it only through `lib/private-part.mjs`, a guarded dynamic import, so every file here loads without it. `./deploy check` runs the merged plan where the tree carries it (the public plan plus the maintainer's private suites); without the private part it runs the public plan, which has the suite Deploy tool for this folder.

## A runtime dependency lives in three places — one guard ties them together

A runtime dependency of the backend is named in:

1. `server/backend/package.json` → `dependencies`,
2. `server/backend/package-lock.json` (with all transitive packages, read for `linux`/`x64`, the image's target),
3. `server/backend/Dockerfile` → the ONE install instruction `npm ci --omit=dev` (with `COPY` of the lockfile before it).

The image installs from the lockfile, so the container runs the versions the gate checked on the developer machine. The guard is
`runtime-dependencies.test.mjs` over `lib/runtime-dependencies.mjs` (reads only manifest, lockfile and Dockerfile, never
`node_modules`, so it runs anywhere): ranges and versions manifest vs lockfile, no orphaned lockfile row, the runtime closure
complete and free of dev packages, exactly one install instruction with `COPY` of the lockfile, and the `rm -rf` after it in both
directions.

**The dead closure is deleted from the backend image.** An edge that is never loaded at runtime is listed with its reason in
`NEVER_LOADED` (today only `onnxruntime-web` under `@huggingface/transformers`) and checked in both directions: an exception
without an edge is red. `server/backend/Dockerfile` removes the dead closure in the same instruction as `npm ci` (a separate layer
would keep the bytes). The guard checks that no path hits a runtime package, every dead package lies under a path, and every path
deletes something dead. `backendImageProbe` checks two more lines in the built image: "onnxruntime-web in the backend image: no"
and a load smoke test of `@huggingface/transformers` from `/app`.

**A new dependency:** add it to `server/backend/package.json`, run `npm install` in `server/backend/` (writes the lockfile); the
Dockerfile picks it up via `npm ci`. An edge that is never loaded goes into `NEVER_LOADED` with a reason and its closure into the
`rm -rf` of the Dockerfile.

## `baseline/` — the workflow tool of the Claude CLI as a versioned state

cbase keeps a 1:1 contract with Claude Code's `Workflow` tool; a state records what the model sees at one version.

```sh
./deploy baseline [<version>]      # fetch the binary, record, print the difference to the last state, write the state
./deploy baseline <version> -n     # the same, write nothing (for a pin jump)
./deploy baseline --diff <a> <b>   # compare two checked-in states
```

- **Default version** is the pin in `server/backend/Dockerfile`.
- **The binary** comes from the npm platform package of this machine (`npm pack @anthropic-ai/claude-code-<platform>-<arch>@<v>`,
  cache `~/.cache/cbase-baseline`, sha256 in the stamp). Measurement runs against an API mock (placeholder key, empty HOME, local
  `ANTHROPIC_BASE_URL`): what the CLI sends to the model is recorded, no regex on the minified binary.
- **A state** `baseline/<version>/`: `stamp.json` (version, package, sha256 of the binary and of each file, conditions),
  `schema.json` (`input_schema` of `Workflow`), `description.md`, `guide.md` (skill `workflow-authoring`), `examples/*.js` (each
  indented example script).
- **The gate** never pulls (no CLI, no network on a Linux clone); the checked-in states are checked only through the
  pure part `lib/baseline.mjs` (covered by the maintainer's private suite). The duty at a pin jump is held by the pin-sync guard below.
- `targets/baseline.mjs` exports the way to the binary, shared with the generator of the journal fixture
  (`server/backend/test/fixtures/dynworkflows-journal/generate.mjs`).

## The pin-sync guard — the Claude pin against every artifact written against a version

The 1:1 contract follows the current CLI instead of freezing on one version; a gate without a CLI does not notice a jump, so the PIN
is the trigger.

- **`lib/cli-pins.mjs`** reads the ONE `npm install -g` line in `server/backend/Dockerfile` (Claude and Codex). A missing or
  unreadable pin is an error, never "empty = fits". `./deploy status` shows both pins and the row "reference for the Claude pin"
  (brought along or not, with findings); the version INSIDE the containers it does not show (`docker exec <c> claude --version`).
- **`pinSync.json`** is the registration: per artifact a name, path (`<pin>` = the Claude pin, `*` = a file name) and stamp kind:
  `stamp-file` (the next `stamp.json` above carries `claudeVersion` and the file's sha256), `json:<field>` (a field of the JSON
  file) or a row beginning, after at most one comment character, with `Reference-Version:` and the version (`dynworkflows/frame.js`,
  `guide.md`, ...).
- **`lib/pinSync.mjs`** checks in BOTH directions (like the guard register): a registered artifact that is missing for the pin or
  carries another stamp is red; an artifact with a stamp that is not registered is too. It never extracts, writes nothing, needs no
  CLI and no network. Covered by the maintainer's private suite.
- **`./deploy server` aborts BEFORE the image build** if the pin jumped and the reference was not brought along
  (`targets/server.mjs`); `--force` bypasses.
- **Bringing along at a pin jump:** `./deploy baseline <v>` (write the state), `./deploy baseline --diff <old> <v>` (read the
  list), write the expectations under `server/backend/test/fixtures/dynworkflows/<v>/` by hand, regenerate the journal fixture, raise
  each `Reference-Version:` row after re-measuring, then run `claude --version` in ALL user containers.
- **Limit:** wordings written against the binary that carry NO stamp (`dynworkflows/sandbox.js`, `script.js`, `budget.js`, ...) are
  not seen by the guard; they age silently.

## The deploy does not wait for dynamic workflows

- **`lib/processes.mjs`** is the ONE one-shot detection for both places (locally via the app's descendants with `ps`, in the
  container via `ps -ww`): every `claude ... stream-json` and `codex exec` process holds the idle gate, except an agent of a dynamic
  workflow. The process marker is in the COMMAND LINE: Claude `--mcp-config .../<chat>.agent-<id>.workflow.mcp.json`, Codex
  `-c mcp_servers.<server>.env.CBASE_WORKFLOW_AGENT="<id>"`. A subagent still holds (no journal).
- **`lib/gates.mjs:dynWorkflowRow`**: gate and status show the information row "Dynamic workflows" (count, name, state from
  `/api/runs/active` field `dynWorkflows`) over ALL user containers; a backend that does not answer or lacks the field is
  "unknown", never "none". `busy` does not count them; the restart resumes them.
- Guard `gates-workflows.test.mjs` (counter-test: marker never recognized, the gate waits for the workflow agent, red); that the REAL
  command lines carry the marker is held by `server/backend/test/active-runs.test.js`.
- **Starts in the project container.** A run of a converted project appears TWICE in the list: as `docker exec ... <container>
  /usr/sbin/cbase-wrapper --pgid-file <P> -- claude ...` and, after the wrapper's exec, as `claude ...` itself. `partsProcesses`
  counts it ONCE: wrapper rows with the same `--pgid-file` are one start, and every visible inner row consumes exactly one wrapper
  (multiset). The marker of a workflow agent is in both rows.
- **`lib/processes.mjs:mask`**: the gate's detail rows show a command line only after `mask`: `-e/--env NAME=value` and
  `env.NAME=value` become `***`, BEFORE truncation. This is the second line of defense for foreign rows.
- **`lib/gates.mjs:projectWorkRow`**: gate and status show the row "Project instances" (field `projectWork` of `/api/runs/active`:
  `<project>/<instance>`, state, phase, since when) over ALL user containers. Setup, start, re-creation and relocation count in
  `busy`: the gate waits for them, `--force` aborts the step midway. Unreachable or without the field means "unknown". The row also
  reads `projectError` (converted instances in `error`): "all ready" only for empty work AND 0, otherwise "N in `error`" as `warn`
  (the deploy does not turn red); `projectStopped` (instances stopped by hand) is shown as a quiet addition. Covered
  by the maintainer's private suite.
- **`lib/project-container.mjs:setupRow`**: status shows per B "setups: N open, M failed; without instance row: K" from
  `setupOpen`, `setupError`, `withoutInstanceRow` of `/api/runs/active`; `ok` only for M = K = 0. For K > 0 the names follow, read
  through `lib/remote.mjs:remoteOpsStatus` from `GET /api/projectbox/ops-status` (names, so the fence refuses the route from project
  networks), capped at 12. Unreachable, a backend without a field and a broken field are "unknown", never 0.
- **`lib/project-container.mjs:composeInBRow`**: the field `composeInB` (`[{ projectId, name, container, running }]`) lists compose
  containers IN B beside a converted project. 0 is ok; running ones are `warn` ("stop by hand"); ONLY stopped ones (relocation leaves
  one-shot containers and containers with changed labels in B on purpose) is a hint; `null` (docker in B unreadable) and a missing
  field are "unknown". A message, no abort.

## The route self-test is monolith PLUS `NEW_SINCE_SPLIT`

`routes.test.mjs` checks that the tree carries the literal GET routes of the monolith, plus exactly the named new ones
(`NEW_SINCE_SPLIT`, each with a reason). Whoever builds a new literal GET route lists it there; it is then also one that a deploy
checks after the bundle swap.

## How the gate runs its suites — phases, width, lock

**Environment first.** `targets/check.mjs:environmentVerdict` names three reasons why whole groups of red tests have nothing to do
with the code, each as its own row: a shallow clone (`lib/git.mjs:isFlat`; red, the gate ends AT ONCE, the counter-tests' `git show
<sha>` would not find their states), uid 0 (warning with `ROOT_DEPENDENT`: tests whose `chmod` does not lock root out) and a
`require('node-pty')` that does not load in server/backend/ (red, "`npm rebuild node-pty`"). Unknown is a warning, never ok. Guard
`test-output.test.mjs` (with a real `git clone --depth 1`).

- **`lib/gate-plan.mjs`**: pure computation. `runSuites` (short suites together, THEN `LONG_SUITES` = backend; the backend command in
  `targets/check.mjs` is a function so the load is measured only at its start), `backendParallelism` (`max(3, min(10, cores - 4 -
  foreign))`, base load `BASE_LOAD_PER_CORE`), `shortParallelism`, `backendParallelismText` (the log row), `suiteDeadlines` (abort of
  any suite after `SUITE_STALL_MS` = 300 s without a TAP result, emergency cap `SUITE_CAP_MS` = 1 h; enforced by `lib/sh.mjs`
  `stall`, guard `suite-stall.test.mjs`). Guard `gate-plan.test.mjs`: the formula, the phases on supplied suites whose end
  the test decides (no clock), and the binding to `check.mjs` (every suite with an explicit `--test-concurrency`, no
  `Promise.all(suites.map(...))`, load measurement before the own checks).
- **`lib/gate-lock.mjs`**: `takeLock` / `lockState`: file `/tmp/cbase.gate.lock`, created atomically WITH content (`link`), free for
  a dead holder and for a reused pid (start time), released in the `finally` of the suites and on `exit`, never a foreign one. Guard
  `gate-lock.test.mjs` against REAL second processes: free, occupied (waits, ONE message, takes after release), occupied then SIGKILL
  (takes over), dead, reused, own, not creatable. The test waits on events; the looking-again function is handed in and a second
  look is a red finding, so an error never becomes an endless loop.
- **Whoever adds a suite** gives it a width in the `suites` block (`${width(n)}`), else `gate-plan.test.mjs` is red. A second LONG
  suite belongs in `LONG_SUITES`.

## Unknown names in the backend

`unknown-names.test.mjs`: TypeScript (`checkJs`, from `web/node_modules` via `loadTs` in `lib/seams.mjs`) over all `.js` under
`server/backend/electron`; only "Cannot find name '...'" (TS2304, TS2552, ...) is counted: a used name that is neither declared nor
imported, which `node --check` does not see and which throws a ReferenceError only at runtime. The exception list in the test is
empty and may only shrink (an entry without a finding is red); a `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error` in the tree is red
too. The counter-test is built in (an in-memory copy of `projects/routes.js` without the import must report the name). Deliberately
without the DOM library, which would make `name`, `status`, `open` "known".

## Three smaller guards

- `gates-background.test.mjs`: gate and `./deploy status` carry the row "background agents": whom the idle gate waits for and that
  `--force` takes it along.
- `iphone.test.mjs` (`lib/iphone.mjs`): which iPhone an installation accepts, against a fake `xcrun` with the real `devicectl`
  answers; the case is the WIFI iPhone (`localNetwork` + `disconnected`, table "available (paired)"), which a plain text search for
  "connected" never saw.
- `sandbox-condition.test.mjs`: `--no-sandbox` for Chrome only under `inContainer()`: the binding of the condition, not the absence
  of the flag.

## The user container before the first project container

`server/backend/` is in no glob of the gate, so the guards of the container entry live here.

- **`entry-sh.test.mjs`** runs the real `server/backend/entry.sh` under `/bin/bash` (3.2 in the gate) AND `/bin/dash` with fake `id`,
  `iptables` (with state), `dockerd`, `docker`, `chgrp`, `chown`, `chmod`, `rm`, `setpriv`, `node`; the seam `CBASE_ENTRY_ROOT`
  prefixes /etc/hosts, /run, /var/run, /var/log and /proc/1/stat, HOME is a temp home. The real `rm`/`chmod` act only under the test
  root. It covers the chain `CBASE-PROJ` (conntrack to ACCEPT, tcp 7718 to ACCEPT, tcp to REJECT tcp-reset) and exactly one jump
  `-i cbp-+` BEFORE dockerd, the marker `/run/cbase/network-separation.ok` with the start time of PID 1, the background stop of the
  project containers without separation, `/etc/hosts` for agent, and the move of `.credentials.json` to `~/.claude-login/` for every
  initial state (old only, new only, both in both directions and tie, none, symlinks, hard link, second start, without DIND, without
  variable). If the separation stands but the marker fails, `entry.sh` stops the project containers as without separation.
  Counter-tests run against a fixed earlier commit, not HEAD. **Trap when measuring:** the background `dockerd` log line is written by
  the child when it gets its turn; the test checks its order at the source, not in the log.
- **`lib/network-separation.mjs`** + `network-separation.test.mjs`: the row "network separation (CBASE-PROJ)" of `./deploy status`
  per user container (`docker exec -u 0 <c>`: chain, INPUT, marker, `/proc/1/stat`). A missing chain (B older) is warn; any deviation
  is bad. The test binds the three versions of the start-time rule (entry.sh `pid1_start`, `projectbox/network-marker.js`, here).
- **`lib/login-retreat.mjs`**: `loginRetreat(env)` for `./deploy rollback server`. If the target image
  lacks `CLAUDE_SECURESTORAGE_CONFIG_DIR`, the rollback copies `~/.claude-login/.credentials.json` to `~/.claude/` (`cp -p`, tmp +
  rename) and strips the variable from the run args. The copy does NOT go through `docker exec` (a rollback is usually needed when B
  does not run) but through a throwaway container from the target image with B's home volume, in the swap script between `docker
  stop` and `rm -f`; stopped B get the same copy without swapping. Unknown environment means the safe way; not doable or failed
  means abort BEFORE `rm -f` (exit 97, B runs again), `--force` bypasses. `targets/rollback.mjs` repoints `:latest` and `current`
  only AFTER the swap. The maintainer's private suite runs the whole rollback with a fake ssh and fake docker.
- **Pin-sync artifact `login-directory`** (`baseline/<pin>/login-directory.json`, stamp `json:claudeVersion`), written by
  a measurement probe of the maintainer's tree, which also checks the probe and the artifact. `./deploy
  baseline <pin>` rewrites the directory; run the probe again afterwards, else the guard is red.

## The swap of a user container begins with `stop -t 60`

- **`deadlines.test.mjs`**: besides the literals it requires that `serverEndCapMs()` and `snapshotCapMs()` have exactly one `return`
  ending in `: <CONSTANT>;`, else a value would apply that the guard never reads.
- **`lib/swap.mjs`**: pure. `swapScript({ container, spec, image, ..., beforeRemove })` = `docker stop -t 60 <B> || true`, the
  `beforeRemove` line (the rollback's login retreat), `docker rm -f <B>`, `docker run ...` in ONE ssh call; `removeScript` for the
  "recreate" retry; `B_STOP_DEADLINE = 60`. Callers `targets/server.mjs:swapContainer` and `targets/rollback.mjs`. The maintainer's private suite
  holds, via a source table (`DOCKER_ALLOWED`), that no other line under `tools/deploy/` and `tools/check/` stops, removes or creates a user container;
  the counterpart for the gateway is in `server/gateway/containers.test.js`. A swap that began with `rm -f` of a RUNNING B would
  SIGKILL the inner dockerd, every project container and its stack. The backend runs its stop chain on TERM
  (`runs/server-end.js`, `projectbox/serverEnd.js`). The relation of the deadlines (gateway == deploy, chain < server-end cap, server
  end + closing + margin <= 60 s) is held by `deadlines.test.mjs`.
- **`lib/gateway-stand.mjs`**: row "gateway code (host)" in `./deploy status`: the same rsync dry run as `deployGateway`
  (`server/gateway/` to `<root>/gateway/`, without `data`); `gatewayDeviations` reads the itemization of GNU rsync (`<f`) and
  openrsync (`>f`). If it deviates, new gateway code takes effect only after `./deploy server --gateway` (restart, open streams
  break). Guard `gateway-stand.test.mjs`.
- **`lib/remote.mjs:containerSpecFrom`**: the pure part of `containerSpec` (no ssh, the image env as an argument): `--stop-timeout 60`
  is ALWAYS first. The limits come from `inspect`: `Memory`, `NanoCpus` and `CpuShares`, so a value set with `docker update` survives
  every swap; what is not listed (MemorySwap, CpuQuota/CpuPeriod, OomScoreAdj, PidsLimit) silently drops at the swap. `docker update
  --cpus 0` does NOT lift a hard limit (Docker 28 treats 0 as "not given"). Guard `container-spec.test.mjs`.
- **`lib/limits-swap.mjs`**: the limits from `containerSpecFrom` are only the fallback: immediately before the swap of EACH B the
  deploy (and the rollback) reads `resources-desired.json` (one ssh, `limitsCommand`) and creates B with the STORED value
  (`specWithLimits` + `argsForCreation` from `server/gateway/resources.js`); right after `docker run` it checks the new B against it
  and aligns it with `docker update` BY ID (lowering only if memory.current + 512 MiB stays below, else a warning). Without a stored
  value inspect applies as a warning, but without `--cpus` if NanoCpus >= host threads. The row "limits" follows in the swap table.
  Guard `limits.ops.test.mjs`, `container-spec.test.mjs`.

## The image `cbase-projectbox`

`server/backend/Dockerfile` has three stages: **base** (node:22-bookworm-slim, the ONE apt row, `agent` in group docker,
`CLAUDE_SECURESTORAGE_CONFIG_DIR`), **projectbox** (`lsof`, `iproute2`, compose/buildx pinned by sha256, x86_64 only;
`/usr/sbin/cbase-projectbox-entry` = `projectbox-entry.sh`, `/usr/sbin/cbase-wrapper`; ENTRYPOINT tini) and **backend** (the former
chain, LAST, so a `docker build` without `--target` builds it as before). The projectbox has no node package, no `/app`, no CLI;
`lsof` does not belong in B. **Trap:** a builder WITHOUT BuildKit builds all stages; the host has BuildKit.

- **`lib/projectbox.mjs`**: pure. `projectboxCand(release, image)` = `cbase-projectbox:cand-<release>` (there is NO host `:latest`),
  `projectboxBuildCommand` (`--target projectbox` on the backend build context), `projectboxHostProbe(cand)` (entrypoint via `image
  inspect`, then ONE `docker run --rm -i --network none --entrypoint sh` with `PROBE_INSIDE`: tools, entry, wrapper, compose/buildx
  version, no `/app`, no CLI, agent 1001 in docker, yarn, login ENV), `projectboxVerdict` (every missing row is bad), the Dockerfile
  parser (`dockerfileStages`, `stagesChain`, `stagesEnv`) and `readProjectboxExpectation` (expected values come from the Dockerfile,
  not a second list). **The SOURCE:** `projectboxSource(dockerfile, fileHash)` = sha256 over the instructions of the chain base to
  projectbox and the sha256 of every file they COPY/ADD (`projectboxSourceFiles`); `backend` does not count. The deploy computes it
  from the tree (`targets/server.mjs localProjectboxSource`), builds with `--label cbase.projectbox.source=<s>`, and
  `projectboxVerdict` requires the label. Distribution does not load if the inner :latest carries the same source as the host
  candidate (plan `source`): a cache rebuild with a new id would otherwise re-create every project container. The source is computed
  from the bytes BEFORE upload (`localProjectboxStatus()` reads once, frozen); `checkReleaseSource` then holds the release folder
  against it (`sha256sum` per file on the host) and THROWS before the build if a file changed or is missing. The host probe also
  reads the sha256 of entry and wrapper INSIDE the candidate (`PROBE_FILES`) against `projectboxFileExpectation`.
- **`targets/server.mjs`**: the build-context file list carries `PROJECTBOX_FILES`. `deployServer` computes the projectbox state,
  fills the release, checks the release folder, builds the backend and hands over WITH THE SAME release to `rollOutAfterBackendBuild`
  (the seam the distribution test drives against a fake docker): `checkBackendImage`, build the projectbox, `checkProjectbox`,
  PREPARE the projectbox in each B, `docker tag <cand> cbase-backend:latest`, `current`, `pruneCandidates`, `swapContainer({ ...,
  projectbox })`. Both checks THROW (verdict as a pure function: `backendImageVerdict` including "lsof in the backend image" must be
  absent, `projectboxVerdict`); then `cbase-backend:latest` and `current` stay.
- **Guards** (all in `latch.json`): `projectbox-dockerfile.test.mjs` (stages, apt once, ENV locations, sha on the RAW row, CLIs only
  in backend, `readCliPins` = exactly the two pins, build context, the deploy place as `deployPlace(src)`, order up to the swap,
  throw in the `if (!verdict.ok)` block, counter-tests against an earlier state and sabotages), `projectbox-entry.test.mjs` (the real
  entry under bash AND dash with fake dockerd/docker/iptables/sysctl/ip/rm/sed/xargs; times via gate file and status file, never via
  duration; a `sed` with EBUSY is retried up to five times, afterwards dockerd starts anyway and the status file stays `error`; the fake
  dockerd carries two rip cords so the harness never hangs), `wrapper.test.mjs` (group, `kill -TERM -<pgid>` hits the grandchild,
  argv[0] stays `claude`, log/exit mode, 125/126/127; sabotages without setsid). The fake docker of the backend tests
  (`server/backend/test/fake-docker.mjs`) maps `/usr/sbin/cbase-wrapper` to the repo wrapper.
- **Stage 2 prepared:** the entrypoint has the DORMANT overlay stage 3a (only with `/cbase-copy/overlays.tsv`: overlays outside before
  inside, wait for `.prepared` with `phase=prepare`, then every mount point under `/cbase-copy` and `/cbase-main` with `umount -l`;
  any error means `phase=error`, no dockerd, the script lives until TERM), stage projectbox `ENV LIBMOUNT_FORCE_MOUNT2=always`, and
  the host probe asks `mount`, `mountpoint`, `umount` and that variable. The clone program `server/backend/cbase-clone` (python3:
  `list`, `copy`, `fadvise`, `policy-protection`) is NOT in the projectbox but in the backend image under `/usr/local/bin` (mounted
  read-only into every project container and helper: a correction is a backend deploy, not a new projectbox id); `backendImageProbe`
  asks it (`clone-ok`). Guards: `projectbox-entry.test.mjs`, `clone-program.test.mjs` (fixture docker folder, fake cp via
  `CBASE_CLONE_CP`; every list goes to cp in CHUNKS of at most 1,000 paths and 64 KiB argv per call; deletion markers, char device
  0:0, do not count in the comparison via ctime), `projectbox-dockerfile.test.mjs`.
- **git-lfs and the LFS helper:** stage projectbox installs `git-lfs` and runs `git lfs install --system` WITH smudge filter, plus
  `ENV GIT_LFS_SKIP_SMUDGE=1` (a normal checkout loads no objects) and in `/etc/gitconfig` `credential.helper =
  /usr/local/bin/cbase-lfs-access` + `credential.useHttpPath = true` (the build checks all four entries). The helper
  `server/backend/cbase-lfs-access` (Node without import/export: the same text is ESM in the repo and CommonJS in the image; `node:fs`
  via `process.getBuiltinModule`) lies in the BACKEND image under `/usr/local/bin`, so it is in `build.sh` and the file list of
  `targets/server.mjs`. It answers only to `get` for `https`, only with `CBASE_LFS_URL` AND `CBASE_LFS_PASS` (set at agent starts,
  `runs/lfs-environment.js`) and **only when git-lfs asks**: helper <- `sh -c "<helper> get"` <- `git credential fill` <- exe
  `/usr/bin/git-lfs`, read via `/proc` (test seam `CBASE_LFS_PROC`); git itself, a `git credential fill` from a shell and a renamed
  program get nothing. After every jump of git or git-lfs the chain must be re-measured: a changed chain makes the helper stay
  silent, never answer more. The route behind it: `POST /api/projects/:id/lfs-access` (`projectbox/lfs-access.js`, fence row
  `lfs-access` allowed). **Rejection:** on `erase` with the chain helper <- `git credential reject` <- git-lfs the helper reports `{
  host, rejected: <sha256 of username\npassword> }` to the same route (never the value) and stays silent for git; the route then
  answers `{ access: null }` for that host until another access is stored. Cap `CBASE_LFS_CAP_MS` (default 10 s). Guards:
  `lfs-helper.test.mjs`, `projectbox-dockerfile.test.mjs` and `server/backend/test/lfs-access.test.js`.
- **`cbase-project`**: `server/backend/cbase-project` (Node, only `node:*`, ES modules without extension) lies ONLY in the backend
  image under `/usr/bin` (not `/usr/local/bin`: that is mounted into every project container), `node --check` in the build; it is NOT
  in `PROJECTBOX_FILES` but in the file list of `targets/server.mjs` and the `cp` line of `server/backend/build.sh`. Guard
  `cbase-project.test.mjs` (resolution pure, call against a fake docker and fake API without TTY: no `-t`, `-u agent`, `-w`, `-e TERM`
  without `=`, exit code; fallback without backend, place in the image; counter-test: a copy with a fixed `-t` is red). The backend is
  asked at `127.0.0.1:7718` only; `CBASE_PROJECT_API` changes that, never the user's `PORT`. The working folder is compared
  PHYSICALLY and converted to the root's store form; `--git-access` (only from the wrapper `cbase-git`) requires a folder in the
  container (else exit 128) and fetches for network commands ONLY the workspace's stored git access from the backend (`POST
  /api/workspaces/:wid/git-access` with the key from `<data>/git-access.key`); no `git credential` in B. Guards `cbase-git.test.mjs`
  and `server/backend/test/fence.test.js` against the real server.

## The projectbox in every user container

Inside each B, `cbase-projectbox:latest` points only at a candidate that passed the start probe; the backend creates every project
container from it. On the host there is no `:latest` of the projectbox, only `cbase-projectbox:cand-<release>`.

- **`lib/projectbox-distribution.mjs`**: pure. `projectboxPlan({ hostId, inner })` (per B `load` | `nothing` | `unknown`; only `null`
  means "missing", anything unreadable is "unknown"), `projectboxSituation(output)`, `cleanupPlan` (the two youngest `cand-<release>`
  stay, older by id, except :latest and used ones), `projectboxRows` (`./deploy status`: "projectbox inside == host candidate" and
  "project containers with a deviating image"), the scripts `prepareScript` (probe leftovers by id away; if the id already lies inside:
  only put the name on it, else `docker save <cand> | timeout ... docker exec -i -u agent <B> docker load` as a stream; id
  comparison; start probe, NO tag), `tagScript` (id of `<cand>` inside once more against the checked one, then `tag`), `probeScript`
  (`run -d --privileged -e CBASE_DOCKER_POOL=10.249.0.0/16 --label cbase.probe=1`, wait until `docker exec <id> docker info`
  answers, `rm -f -v <id>`), `leftoversScript` (a leftover goes only if its `cbase.probe` stands ON the container, the same rule as
  `projectbox/own-labels.js`, guard `helper-selectors.test.mjs`), `readScript`, `cleanupScript`. **Passed means `phase=ready`:** after
  the first `docker info` answer the probe reads the entrypoint's status file (`STATUS_FILE` = `/run/cbase-projectbox.status`) until
  it says `ready`; `error`/`ended` means `EXIT.STATUS` with the entrypoint's message. Every failed step takes the freshly set name
  away again and ends with a code from `EXIT`. After `ready` the probe also asks `git lfs version` and `git config --system
  --get-all credential.helper`: both (`git-lfs/...` and exactly `/usr/local/bin/cbase-lfs-access`) or NEITHER (a projectbox older than
  git-lfs) pass; only one means `EXIT.LFS`. **Every call into B has a cap:** `dx` = `timeout -k 5 60 docker exec -u agent <B> ...`
  (`EXEC_CAP_S`), the stream `timeout -k 5 1200` (`LOAD_CAP_S`); on expiry "cap: ..." is in the message and the B is "unknown" or
  failed. **The flow has two steps:** `prepareProjectbox` (per B read, load, start probe; result per B `current` | `ready` | `dry` |
  `unknown` | `failed`) and `repointProjectbox` (tags only the ready ones, cleans old candidates, NEVER throws because of one B; a B
  that runs only since the preparation is prepared and tagged here with the same host id). It throws only in the deploy
  (`candidateGetsBuilt`) when the just-built host candidate is missing or unreadable (`readImageId`: `{id}` | `{missing}` |
  `{unknown}`); in the rollback "missing" is a warning, also in a dry run. **The probe pool `10.249.0.0/16`** touches nothing in B
  (`OCCUPIED_RANGES`). `lib/gates.mjs:innerContainers` knows no probe containers (label `cbase.probe=1`); probe, helper and project
  labels count only if they stand ON the container (`innerContainers` reads the exact labels and those of its image in a third query,
  keys from `projectbox/own-labels.js`). Guard: `helper-selectors.test.mjs`.
- **Callers.** `targets/server.mjs:rollOutAfterBackendBuild` prepares BEFORE `docker tag <cand> cbase-backend:latest`; `swapContainer`
  repoints right after `remoteContainers()`, before the early return "all already run this image" and before the idle gate.
  `targets/rollback.mjs` runs `distributeProjectbox` with the TARGET release, only after the swap, health, retrieval of the inner
  containers and repointing of `:latest`/`current` of the host; inside back to the target release's candidate, without a stream if the
  id still lies inside; if its candidate was cleaned up and its Dockerfile knows the stage, `projectboxForRollback` builds it from
  `releases/<target>/backend` and checks it with the same host probe; a target release without a projectbox leaves everything inside.
  `targets/status.mjs` calls `projectboxStatus({ release, containers })`.
- **Guard `projectbox-distribution.test.mjs`**: fake ssh (bash), fake curl/pgrep/sleep/timeout and the fake docker of the project
  containers; PATH is `<bin>:/usr/bin:/bin`, no real docker or ssh is reachable. The fake `timeout` has no clock: it ends with 124 as
  soon as a call stands at the fake docker's gate. It runs the real `rollOutAfterBackendBuild`, the real `rollback` and
  `projectboxStatus`. Counter-tests against earlier states and copies: the script without probe part tags unchecked; the preparation
  behind the tag; the repointing behind the early return; a verdict that only warns; the rollback distribution before the swap or
  before the retrieval. The docker rows of the start probe are in the source table `DOCKER_ALLOWED` of the maintainer's private suite.

## The backend retrieves project containers, not the deploy

After every swap of B the BACKEND starts the project containers itself (restart hook "project-restore",
`server/backend/electron/server/projectbox/restore.js`): only after a valid network-separation marker, then the inner stack in
`depends_on` order, with a cap per stage. A `docker start` by the deploy would bypass that.

- **`lib/project-container.mjs`**: a leaf, pure (only import `node:crypto`): `projectOf(name, labels)` (label `cbase.project` first,
  else the name `cbase-p-<id>`; also `cbase-k-<id>-<name>`, the copy), `isProjectContainer`, `partsInner(list)` to `{ user, projects }`,
  `retrievalList(wanted)` (what `restoreInner` starts, never a project container), `projectContainerRow` (gate and status: own row
  "project containers ... backend retrieves", `ok`, never `warn`) and `projectRetrievalRow(runs, before)` (after the post-observation:
  `projectWork` empty means "the restoration is through", in progress is `warn`, unreachable/without field is "unknown"). "All ready"
  only for `projectWork` empty AND `projectError` 0.
- **Callers.** `lib/gates.mjs:innerFrom` carries `project` on the project container, `remoteGate` warns only about the user's;
  `lib/remote.mjs:restoreInner` restores `retrievalList` and reports the left-out ones; `targets/server.mjs` names them in the
  confirmation and, after `settleMany`, asks every B that had project containers before the swap. The deploy does NOT wait for the
  restoration: `projectWork` makes `busy` true, the next idle gate waits.
- **Guarded by the maintainer's private suite**: the pure parts, `restoreInner` against a fake ssh (only project containers means no ssh
  call), and the places in gate, status, swap and rollback; counter-tests against earlier module states.

## Relocations and the deploy

- **`restoreInner` does not restart the old containers of a relocation.** The snapshot `wanted` is from BEFORE the swap. Before
  `docker start`, `restoreInner` asks `/api/runs/active` of the B: `relocationContainer` lists the sha256 of the FULL id of every
  container an open or finished relocation journal took over; `lib/project-container.mjs:relocationDeduction` subtracts them. Silent
  means start NOTHING, the warning names the command by hand; without the field (backend before relocation) all as before. The ONE
  reading of `/api/runs/active` in B is `lib/remote.mjs:remoteRuns`. OPEN journals carry only the list of the containers the
  relocation really stopped.
- **The snapshot before the swap.** The answer `idleBeforeSwap` read right before the swap goes as `beforeSwap` to `restoreInner`. If
  the backend stays silent AFTER the swap, this snapshot applies if it had `relocationsOpen === 0` and a field `relocationContainer`;
  otherwise unknown (start nothing). Covered by the maintainer's private suite.
- **Abort in the middle of a rollback.** If the swap loop aborts AFTER a swap, the rollback retrieves health and inner containers per
  already swapped B (`retrieveAfterAbort`) and appends "inner containers retrieved: ..." / "not retrieved: ..." to the error.
  `:latest` and `current` stay as they are on purpose. This also covers the B whose login retreat failed. Another failure of the swap
  script (`rm -f`/`run` fail) stays without retrieval. Guards `projectbox-distribution.test.mjs` and the maintainer's private suite.

## The rollback lock — what a release knows

`server/backend/capabilities.json` lists what a release knows; a rollback to a release lacking a word would lose the memory of
state it cannot read. `lib/capabilities.mjs` computes the lock from the target's file and the numbers in `/api/runs/active` of each B;
the rollback checks BEFORE the image rebuild, after the idle gate and per B immediately before its swap. A missing file means the
release knows NOTHING. An answer that is missing, silent or from a stopped B is "unknown", never 0. Two kinds of lock entries:
"known" (a count > 0) is never bypassable, not even by `--force`; "unknown" is bypassable only with the axis' own switch (only for
`rollback server`, `deploy.mjs:parseArgs`); the sentence names the way out (repair forward, or a target that knows the word).
`./deploy status` shows the matching row per B. All of it is guarded by the maintainer's private suite (computation, source, upload, and the whole rollback at a
fake ssh), with counter-tests against earlier states.

| Axis | Word | Count | Switch |
|---|---|---|---|
| relocation / copy stages | `relocation`, `copy`, `copy-clear-away`, `copy-move-in` | `converted`, `relocationsOpen`, `copies` | `--rollback-without-relocation`, `--rollback-without-copy` |
| episodes per workspace | `episodes-per-workspace` | `episodesMultiple` | `--rollback-without-episodes` |
| git-lfs in the projectbox | `lfs` | none (every B "unknown") | `--rollback-without-lfs` |
| outline (layout) | `layout` | `layoutsOpen` | `--rollback-without-layout` |
| stopped instances | `instance-stopped` | `projectStopped` + `stop` in `projectWork` | `--rollback-without-instance-stopped` |
| bridge prefix `cbp-` (an older entry.sh guards only the old prefix) | `bridge-cbp` | `converted` | `--rollback-without-bridge-cbp` |

- **Copy stages.** A target lacking ONE stage (`COPY_CAPABILITIES`) locks every live copy. A new slice with a new state or journal
  section in `store/stack-copies.js` appends a word; the maintainer's private suite is red until list and file are brought along.
- **Counts of stopped and silent B.** If the answer carries no count (B stopped, backend silent, field missing), the count is read
  from the database in the home volume: a throwaway container from B's own image (`lib/capabilities.mjs` `copiesReadingCommand`:
  `--network none`, `--pull never`, volume `:ro`, `-u 0`, `node:sqlite` with `readOnly`, no `docker exec`). Counted as in the data
  layer; a read 0 does not lock, > 0 is "known", a failed read is "unknown" with its reason. Each axis has its own reader script and
  lock/sentence functions; every lock entry carries `open`, and `lockRuling` requires the switch of each unknown count.
- **Fakes that answer `/api/runs/active` carry every count with lock effect** (`episodesMultiple`, `layoutsOpen`, `projectStopped`,
  `projectWork`). A fake without the field is "unknown" for that axis, and a rollback path in a guard then runs into the lock instead
  of what it should check. A new field with lock effect needs the same row in every such fake.

## Unknown is not free — a reading that failed was read as "free", "missing" or "the newest"

Each item: place, rule, guard (each guard enters the breaking path; the counter-tests load the affected file at an earlier state
and show it red).

- **`rollback server` without `--to`.** Target is the release active BEFORE `current`: `pointCurrent` keeps the file `activations`
  (a stack, `lib/release.mjs`); a rollback takes the topmost back, a second goes further. Without a known predecessor it aborts with
  `--to`. `pruneReleases` protects `current` and the three youngest activations. Covered by
  the maintainer's private suite.
- **One-shots in the container.** `remoteProcesses` reads `ps -ww -eo pid=,args=` and selects with `lib/processes.mjs providerRows`
  (the same rule as locally); plus `open.oneshots` of the backend: > 0 is busy. A fake docker in a test must answer `ps` with at least
  one process row (PID 1): an empty or unreadable list is "unknown" and counts as busy. Guard `gates-workflows.test.mjs`.
- **Env of the spec.** `containerSpec` filters against the env of `insp.Image`, not `:latest`/the target; unreadable throws before
  any swap. `STALE_IMAGE_ENV` names are never passed on as `-e`; add only a name nothing reads or sets any more (the guard greps the
  repo). Guards `container-spec.test.mjs` and the maintainer's private suite.
- **Gateway race in the rollback.** The rollback swaps through `targets/server.mjs swapContainer` (same script, same `swapVerdict`);
  `recreate` runs with the login retreat before removal. Covered by the maintainer's private suite.
- **Error body.** `lib/remote.mjs isRunsResponse`: only an object with a boolean `busy` and no `error`; else `remoteRuns` is `null`
  (busy; `restoreInner` starts nothing). Covered by the maintainer's private suite.
- **Image id.** `swapContainer` reads `:latest` with `readImageId`; without an id it aborts before any B is touched. The rollback
  likewise for candidate and target (unreadable is not "cleaned up, rebuild"). Covered by the maintainer's private suite.
- **Quoting.** `lib/swap.mjs runCommand`/`shellWord`: every argument one shell word; the same line for script and display. Covered
  by the maintainer's private suite.
- **Post-observation in `all`.** `deploy.mjs runTargets`: the holder hangs on registration, waiting also happens after an error, its
  result stands at the error. Guard `deploy-targets.test.mjs`.
- **Failed login retreat with `--force`.** The retreat row writes `RETREAT_MARKER <B>` to stdout; the verdict carries a red row. Also
  every B for which the retreat is not doable and which `--force` rolls back without a copy. Covered by the maintainer's private suite.
- **A B does not become healthy.** Health and retrieval are collected per B, the projectbox is always distributed, thrown after.
  Test seam `CBASE_DEPLOY_HEALTHY_MS`. Covered by the maintainer's private suite.
- **The lesson of the removed local gate:** an answer that is none is "unknown", never "free".
- **Candidates of the activations.** `pruneCandidates` (`targets/server.mjs`) removes by `lib/release.mjs candidatesToRemove`: the
  candidate of the just-activated release and those of the `HISTORY_PROTECTED` youngest activations ALWAYS stay, of the rest the
  `CANDIDATES_KEEP` = 2 youngest; an unreadable history removes nothing. Covered by the maintainer's private suite.

## Stopped user containers (step 0 of `server`)

The gateway puts an idle B to sleep (`docker stop`). `remoteContainers()` sees only running ones, so a stopped B would keep the old
image through a server deploy and later be woken by the gateway with old code. `lib/stopped-b.mjs` `startStoppedB()` therefore starts
every stopped B (`exited`/`created`) in `targets/server.mjs` `rollOutAfterBackendBuild` — after the image checks, before preparing the
project box and thus before the idle gate —, after which it is swapped like every other. A B whose `docker start` fails does not stop
the deploy: it stays stopped, keeps its image and is named as a warning; a B in another state (restarting, paused, dead) is named and
not touched. `./deploy status` shows the stopped B through the same reading (`situationCommand`, `containerSituation`). Guard:
`stopped-b.test.mjs`.

## Rollout lock, first installation, guards (plan step 1)

- **Dev-tree lock.** The root script `deploy` lets `server|web|client|rollback|all|init` through only from a rollout checkout: `deploy.local.json` in the repo root AND the marker `.cbase-rollout-checkout` (gitignored, untracked) whose content is the real path of the checkout (`pwd -P > .cbase-rollout-checkout`). A stray `deploy.local.json` in the dev tree unlocks nothing; a cloned or copied folder carries no valid marker. `mobile`, `baseline` stay locked. `lib/rollout-checkout.mjs` repeats the rule in node (deploy.mjs, before any rollout work). Guard: `rollout-lock.test.mjs`.
- **Config guards.** `remote.root`, `gatewayPort`, `containerPrefix`, `image`, `projectboxImage` come from `deploy.local.json` or `CBASE_REMOTE_ROOT`, `CBASE_GATEWAY_PORT`, `CBASE_CONTAINER_PREFIX`, `CBASE_IMAGE`, `CBASE_PROJECTBOX_IMAGE`. Every rollout command awaits `assertOwnInstallation`, the hook for a maintainer who runs a second installation on the same host (its identity lives outside the public tree; without it nothing is refused). Guard: `config-guards.test.mjs`.
- **`./deploy init`** (`targets/init.mjs`, template `templates/cbase-gateway.service`): root folders + systemd user unit, not started, refuses an existing root/unit unless `--force`. Guard: `init.test.mjs`.
- **Image builds** run under `nice -n 10 ionice -c3` (`lib/build-throttle.mjs`). Guard: `build-throttle.test.mjs`.
- **Cleanup-cron guard** (`checkCronWindow` in `lib/cronWindow.mjs`, hour `remote.cleanupCronUtcHour`, none by default): no `server`/`all`/`rollback server` run across a daily docker-cleanup cron of the host (it prunes unused images and stopped containers — the candidate image and the container under swap); the duration is the named assumption `DEPLOY_DURATION_ASSUMPTION_MIN` (45 min, not measured); checked before the gate and before the rollback; override only `--cron-window-ignore` (never `--yes`/`--force`). Guard: `cronWindow.test.mjs`.
