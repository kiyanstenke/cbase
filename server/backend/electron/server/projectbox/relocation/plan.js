// The relocation plan. PURE: no docker, no store access, no writing. Everything it needs to know is gathered beforehand by
// the collection (./collect.js: inspect and list JSON, git, files) and handed in as `data`; the only thing this file reads
// is `realpath`, and that through a seam. The start order comes from ../restore.js startStages (pure).
//
//   planRelocation(data, { under, realPath, exists }) → plan (shape below)
//   ENTRIES   the table entry → stage ("hold" | "hint") with its sentence — the ONE place that decides what stops a
//             relocation. A hold reason stops `POST …/relocation` until it is resolved; a hint only shows in plan and report.
//   RATES     the assumptions of the downtime estimate.
//
// WHO MOVES ALONG. A container moves along when its label `com.docker.compose.project.working_dir`, after realpath, lies
// UNDER the project folder — WITH the separator: `/ws/orbit-2` is not under `/ws/orbit` (the same rule as services.js
// matchContainers, via runtime/real-path.js inArea). A container without that label never moves; the plan names it when it
// seems to belong to the project (a registered service names it, or one of its binds lies in the project). Containers of
// cbase itself (project container, helper, probe) are never part of a plan — recognised by EXACTLY the keys from
// ../own-labels.js, set ON the container (one inherited from the image does not count; `data.images[].Labels`). A container
// left out that way which mounts a volume of the plan, or whose `working_dir` lies under the project folder, holds
// (`container-excluded`) — left out never means silently.
//
// ONE-OFF CONTAINERS (`compose run`, label `oneoff=True`). `up` does not create them, the procedure does not replicate them
// and never removes them: they STAY in B, the user container — with image, write layer, anonymous volumes and networks. So
// they count for nothing that moves (no group, no start order, no service in `compose`, no image, no volume), and the plan
// names each as a hint. Two cases hold, each with a way out: a one-off container that is RUNNING (step 4 would stop it and
// it would stay behind stopped), and one that uses a volume that moves (afterwards it would hang on the old copy in B — a
// silent duplicate).
//
// `data` (whatever is missing is unknown — never "empty"; what safety depends on becomes a hold reason when missing):
//   project        { id, name, path }                                the project folder in B
//   mounts         [{ target, kind }]                                creation.js mountRules of the future project container
//   home           the user's home in B
//   projectNetwork the /24 of the project container, if already known
//   container      [docker inspect]                                  ALL containers of B (stopped ones too)
//   images         [docker image inspect]                            { Id, RepoTags, RepoDigests, Size, Labels? } (Labels =
//                                                                    `Config.Labels`, `{}` without; without the field only a
//                                                                    cbase key on the container itself counts)
//   volumes        [docker volume inspect]                           { Name, Driver, Labels, options?, size? } (size in bytes;
//                                                                    `options` the KEYS of `Options`, never a value)
//   networks       [docker network inspect]                          { Name, Labels }
//   diffs          { <containerId>: ["C /x", …] | [{ Kind, Path }] } `docker diff` per container that moves
//   composeTexts   { <absolute path>: text }                         the Compose files from the labels
//   untrackedCompose [relative path]                                 Compose files in the project that git does not track
//   worktrees      [{ repo, path, missing?, prunable? }]             `git worktree list` per repo
//   worktreeRoots  [path]                                            worktree roots of cbase (step 13 moves them);
//                                                                    worktreeTarget: the root in the runtime folder
//   mcpServer      [{ name, transport, command, args, env, url }]    the MCP servers of the project
//   env            readEnvFiles(project.path, { mounts, home, localNames }) (../env-key.js)
//   tracked        [relative path]                                   `git ls-files` of the `.env.example` files (missing ⇒
//                                                                    data-missing, likewise `untrackedCompose`)
//   services       [{ id, name, port, dir, startCommand, savedCommand, container }]   project_services + service_start_commands
//   startScripts   { <absolute folder>: { <name>: command } }        package.json `scripts` per service folder
//   repos          [{ path, alternates, flat, partialClone, submodule, embedded, beyondLimit, objectsReferences, filter,
//                     detached, stashes }]                           what a copy does not carry — only named
//   projectRepo    { arises, reason, files: [{ path, bytes }] }      reason "repo" = the folder is itself a repo
//   local          [{ rel, bytes }]                                  entries of ~/.local under state/ and share/
//   localReferences { <projectId>: [rel] }                           cli-home.js localReferences per project of B
//   foreign        [{ projectId, name, ports, env, volumeNames? }]   other projects/repos of B; `volumeNames` the literal
//                                                                    `name:` of their Compose volumes
//   texts          [{ kind, id, title, text }]                       skills, context, facts of the project
//   bEnvironmentNames [name]                                         the names in the environment of B (missing ⇒ no entry)
//   runtimePrefilled [{ field, count }]                              prefilled targets of step 13 (missing ⇒ incomplete)
//   processes      [{ pid, start, program, terminal?, descendant? }] processes in B working in the project or in a worktree
//                                                                    step 13 moves, without the groups of the native runs
//                                                                    (./processes.js) — without the field the plan holds
//   nested, nativeUnclear, localReferencesOpen                       optional findings of the collection; absent means none
//
// The plan: { projectId, projectPath, canRelocate, holdReasons, hints, container, compose, startFollowUp, stopFollowUp,
//   images, volumes, networks, withoutLabel, worktrees, dismantling: { env, services, overrides }, local, projectRepo, slot,
//   downtime, mentions, hits }. It holds no env value and no file content (env-key.js hands out none).
// Guard: server/backend/test/relocation-plan.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inArea } from "../../runtime/real-path.js";
import { LEVEL2_AREA, INNER_POOL, BLOCK_LIST, cidrRange, volumeName } from "../creation.js";
import { SHARED_IN_SHARE, referencesIn } from "../cli-home.js";
import { ComposeConfigError, LABEL, composeConfig, configKey, labelsOf } from "../compose-config.js";
import { ownKey } from "../own-labels.js";
import { stageEntries, stagePath, stageValue } from "../env-key.js";
import { dependsOnFrom, startStages } from "../restore.js";
import { overriddenPorts } from "./port-command.js";

const H = "hold";
const I = "hint";
/** Entry → stage and sentence (see header). Every kind the plan reports is listed here; the guard checks that. */
export const ENTRIES = Object.freeze({
  "data-missing": { stage: H, text: "A piece of information the plan cannot judge without is missing — unknown is not “nothing”." },
  "compose-labels": { stage: H, text: "The Compose labels of a container cannot be replicated." },
  "compose-project-shared": { stage: H, text: "A Compose project name has containers inside AND outside the project folder." },
  "compose-file-outside": { stage: H, text: "A Compose file lies outside the mounts of the project container." },
  "compose-several-calls": { stage: I, text: "A Compose project was created with different file sets; each set is replicated separately." },
  "worktree-outside": { stage: H, text: "A worktree lies outside the project folder (and is not one of cbase's)." },
  // The data for the next four comes from collect.js; without it (older callers) none of them applies.
  "worktree-orphaned": { stage: H, text: "A worktree is missing or orphaned (`prunable`) — step 13 could not move it. Way out: `git worktree prune` in the repo (or bring the folder back), then plan again." },
  "worktree-at-target": { stage: I, text: "A worktree already lies in the worktree root of the runtime folder (left over from an earlier relocation); it stays where it is." },
  "nested-converted": { stage: H, text: "A project with a project container lies inside this project folder or the other way round, or a repo has its git directory in that folder — B does not touch these repos. Way out: untangle the folders (move one project), then plan again." },
  "native-service-unclear": { stage: H, text: "A service of the project may be running in B without a process group that cbase can end safely (started by the agent) — way out: stop the service, then plan again." },
  // A process in B that works in the project and that step 4 does not end would keep running in B after the relocation — on
  // the old port, in the folder the project container then owns. "Works" means: working directory, program (`exe`), `maps`
  // or an open file in the project folder or in a worktree step 13 moves (data from ./processes.js). One inside a terminal
  // the lock ends is only a hint; if it survives, step 4 holds.
  "process-in-project": { stage: H, text: "A process in B works in the project folder or in a worktree the relocation moves (its working directory, program or an open file lies in there) and belongs to no service the relocation ends — after the relocation it would keep running in B, on the old port and in the folder the project container then owns. Way out: end it or run it as a service in cbase (started through cbase, the relocation ends it and restarts it in the project container); close an open terminal in the project (workspace terminal, VS Code) or change out of the project folder; then plan again." },
  // A descendant (ppid chain) of a process from a group the relocation itself ends, in a group of its OWN — only named in
  // the plan; after ending the groups step 4 looks again strictly (the second look exempts nobody).
  "process-descendant": { stage: I, text: "A process in B works in the project folder in a process group of its own but descends from a native service the relocation ends — if it does not end with that service, step 4 holds after ending the services (return path)." },
  "process-in-terminal": { stage: I, text: "A process in B works in the project folder in a terminal of the project or of one of its chats — the lock ends that terminal with a message, and the process ends with it. If it survives (nohup, disown), step 4 holds before anything is stopped." },
  "path-outside-mcp": { stage: H, text: "An MCP server of the project names a path outside the mounts." },
  "path-outside-env": { stage: H, text: "A `.env*` key names a path outside the mounts that exists in B." },
  "path-unknown-env": { stage: I, text: "A `.env*` key names a path outside the mounts that does not exist in B (presumably inside the stack container)." },
  "env-unreadable": { stage: I, text: "A `.env*` file was not read." },
  "bind-outside": { stage: H, text: "A bind of a stack container has a source outside the mounts — the inner dockerd would create it empty." },
  "docker-sock": { stage: I, text: "A stack container binds the Docker socket — in the project container that is the project daemon." },
  "writeLayer": { stage: H, text: "The write layer of a container carries data (`docker diff` outside /tmp, /run, the mount points and what a runtime creates by itself on every start) — it does not move along: inside, the container is created anew from its image. Way out: bring what lies there and is needed into the image or into a volume and recreate the service; or, if it may be discarded (a tool or package cache, development tools installed by hand afterwards — `folder` counts EVERY path by folder), start the relocation with a receipt (`acknowledged: [{ kind: \"writeLayer\", container, count, checksum }]` — exactly as in the plan); the whole discarded list is in the relocation location afterwards." },
  "image-without-tag": { stage: H, text: "A container does not run on the image of its tag — inside it would come up with a different one." },
  "image-digest": { stage: H, text: "A container names its image by digest (`…@sha256:…`) — `docker load` brings no digests along, so inside `up --pull never` would not find it. Way out: name a tag in the Compose file and recreate the service." },
  "volume-driver": { stage: H, text: "A volume does not have the driver `local` — the helper only copies `volumes/<name>/_data`." },
  "volume-options": { stage: H, text: "A volume has driver options (`driver_opts`: bind/device, nfs, tmpfs …) — inside, an ordinary volume holding a COPY would arise, and the device or share would stay behind as a stale state. Way out: run the volume without `driver_opts` (a bind as a bind mount, tmpfs as `tmpfs:` on the service) and recreate the service; stage 1 does not carry a network share." },
  "once-container-running": { stage: H, text: "A one-off container (`compose run`) is running — step 4 would stop it, and it would stay behind stopped in B. Way out: let it finish or end it, then plan again." },
  "once-container-volume": { stage: H, text: "A one-off container (`compose run`) uses a volume (named or anonymous) that moves — it would stay in B on the old copy. Way out: remove the container (`docker rm`, a leftover of `compose run` without `--rm`), then plan again." },
  // An ANONYMOUS volume of a plan container can also be mounted by a container that does not move along (`--volumes-from`,
  // `docker run -v <hash>:…`) — afterwards it would hang on the old copy in B.
  "volume-shared": { stage: H, text: "A volume (named or anonymous) is also used by a container that does not move along." },
  // `network_mode: service:…`/`container:…`, `ipc:`/`pid: container:…` and `volumes_from` show on the container as
  // `container:<id in B>` or `VolumesFrom` — a coupling to container ids that do not exist inside.
  "service-reference": { stage: H, text: "A container shares the network, IPC or PID namespace of another container (`container:…`, from `network_mode: service:…`) or takes over its volumes (`volumes_from`) — the coupling hangs on container ids of B, and the relocation does not replicate it. Way out: dissolve the coupling in the Compose file (shared network, named volumes), recreate the service, then plan again." },
  // The volume of the project container (`cbase-p-<id>-docker`) already exists — left over from an earlier instance. The new
  // project container would mount it, and the return path of a failed relocation would delete it with its content.
  "project-volume-existing": { stage: H, text: "The volume of the project container already lies in B (left over from an earlier instance) — the new project container would mount it, and the return path would delete it. Way out: check what is in it, back it up or remove it by hand (`docker volume rm`), then plan again." },
  // A container of cbase (own label ON the container, ../own-labels.js) never moves along — if it mounts a volume of this
  // relocation or its Compose `working_dir` lies in the project folder, it would silently stay behind in B.
  "container-excluded": { stage: H, text: "A container the relocation leaves out as a container of cbase (it carries a cbase label on the container — project container, helper, probe) mounts a volume of this relocation or has its Compose `working_dir` in the project folder; it would stay in B, on the old copy. Way out: a leftover helper disappears with the next start of B (the restart-grace pass clears orphans), a probe with the next deploy; if a container of your own carries a cbase label (Compose `labels:` or `docker run --label`), remove the label and recreate the container; then plan again." },
  // A volume without the Compose label of this relocation may be run as `external` by another project — even one whose
  // containers are currently missing (`compose down`); `volume-shared` only sees existing containers. In practice hardly any
  // volume carries a Compose label (created by hand or copied in; Compose keeps using an existing unlabelled volume with a
  // warning and never sets one). So a volume WITHOUT any Compose label that only containers of ONE Compose project of this
  // relocation mount moves along (hint `volume-without-label`); whether it really is that project's volume is decided by
  // the dry run against Compose's own model (procedure.js).
  "volume-extern": { stage: H, text: "A named volume carries the Compose label of a project that does not move along, or, without any Compose label, containers of several Compose projects mount it — another project may own it, even if its containers are currently missing; after the relocation there would be two states. Way out: make the volume a volume of this Compose project (in the Compose file without `external`, copy the content over, recreate the service), then plan again." },
  // A project that is not converted names the volume in its Compose file (`name:`) — even without containers.
  "volume-without-label-foreign": { stage: I, text: "A volume without a Compose label that moves along is named by another (not converted) project in its Compose file as `name:` — that project may use it, even if its containers are currently missing; after the relocation there would be two states. `notCheckable`: a `name:` there carries a variable." },
  "volume-without-label": { stage: I, text: "A named volume carries no Compose label (created by hand or copied in); only containers of one Compose project of this relocation mount it. It moves along provided Compose's model of that project names it as its own volume (not `external`) — otherwise the dry run holds before anything is stopped." },
  "network-owner-stays": { stage: H, text: "A network belongs to a Compose project that does not move along — inside nobody would create it." },
  "network-coupling-ends": { stage: I, text: "A network without labels connects to containers that do not move along; the connection ends." },
  "fixed-subnet-collision": { stage: H, text: "A fixed subnet intersects level 2, the inner pool, the block list or the project network." },
  "fixed-subnet": { stage: I, text: "A fixed subnet (`subnet:`) moves along 1:1 and bypasses the pool." },
  "stack-port-7718": { stage: H, text: "A service of the project occupies 7718 — in the project container that port belongs to the OUTPUT DNAT." },
  "profile-services": { stage: I, text: "A Compose file uses profiles; `config --hash` runs with `--profile *`, `up --no-start` names the services explicitly." },
  "variable-without-label": { stage: I, text: "A Compose file uses variables that no `.env` in the project folder sets — the hash comparison holds if they are missing." },
  // Such a variable exists in the environment of B (PORT=7718 of the backend) — a `compose up` from B (terminal, agent)
  // resolved it with B's value, inside it is missing. Names only, never the value.
  "variable-from-b": { stage: I, text: "A Compose file uses variables that no `.env` in the project folder sets but that exist in the environment of B — a `compose up` from B took their value, inside they are missing (the hash comparison then holds). Way out: set the variable in the project's `.env`." },
  "without-label": { stage: I, text: "A container without a Compose label seems to belong to the project; it stays in B." },
  "once-container": { stage: I, text: "A one-off container (`compose run`) does not move along — `up` does not create it. It stays in B, together with its image, write layer and anonymous volumes; remove it by hand when it is no longer needed." },
  "override-untracked": { stage: I, text: "A Compose file in the project is not tracked by git (override)." },
  "mcp-relative": { stage: I, text: "An MCP server names a relative command or path; from now on it resolves against the project folder." },
  "env-without-example": { stage: I, text: "A port key has no recognisable repo default — no tracked `.env.example` and no registered service of this folder with this port and a default in the code (start script, framework); it stays unchanged." },
  "service-port-unknown": { stage: I, text: "The repo-default port of a service with a port override cannot be determined; start command and field stay (the old port is free in its own namespace)." },
  // After the dismantling two services of the project would sit on the SAME port (two folders with `next dev -p 3001` and
  // `-p 3002` ⇒ both 3000) — in the project container they share one network namespace, the second start fails with
  // EADDRINUSE. Likewise a service the dismantling puts on the published port of a container that moves along (field
  // `container`). Only what the dismantling CREATES: a duplicate that already exists in B is no entry.
  "service-port-collision": { stage: H, text: "After the port dismantling a service of the project would sit on a port already occupied by another service of the project or by a container that moves along (published port, field `container`) — in the project container they share one network namespace, and the second would not start. Services that already carry the same port in B do not make the plan hold. Way out: give the rebuilt service a repo default of its own (tracked `.env.example` or a port in the start script), change the published port of the container or remove one of the services, then plan again." },
  "old-ports-mention": { stage: I, text: "A text mentions a port that the dismantling changes." },
  "random-hits": { stage: I, text: "Another project currently hits a port of this project only by chance; after the relocation it no longer does." },
  "hits-fremdes": { stage: I, text: "This project currently hits a port of another project; in the project container it no longer does." },
  // The runtime folder of the project already holds chat or project files (left over from an earlier relocation whose return
  // path left it standing) — step 13 puts them aside. Field and count only.
  "runtime-prefilled": { stage: I, text: "The runtime folder of the project already holds a version of chat or project files (left over from an earlier relocation) — step 13 puts it aside into the relocation location (`prefilled/`) instead of overwriting it; it stays there." },
  "local-without-assignment": { stage: I, text: "An entry under ~/.local belongs to no project; it is not copied." },
  "size-unknown": { stage: I, text: "The size of an image or volume is unknown; space and downtime are too low." },
  "start-follow-up": { stage: I, text: "The `depends_on` order cannot be resolved completely (cycle, unknown service); the rest starts last." },
  "incomplete": { stage: I, text: "A piece of information for a hint is missing; the hint may be absent." },
  "copy-alternates": { stage: I, text: "A repo has `objects/info/alternates` — a copy does not carry that." },
  "copy-flat": { stage: I, text: "A repo is a shallow clone." },
  "copy-partial-clone": { stage: I, text: "A repo is a partial clone (filter)." },
  "copy-submodule": { stage: I, text: "A repo has submodules." },
  "copy-embedded": { stage: I, text: "A repo lies inside another repo." },
  "copy-beyond-limit": { stage: I, text: "A repo lies beyond the bounds of `findRepos`." },
  "copy-objects-reference": { stage: I, text: "There are symlinks under `.git/objects`." },
  "copy-filter": { stage: I, text: "`.gitattributes` sets `filter=`." },
  "copy-detached": { stage: I, text: "A repo is on a detached HEAD." },
  "copy-stash": { stage: I, text: "A repo has stashes." },
  "copy-code-repo": { stage: I, text: "The project folder is itself a code repo — no project repo is created." },
});
const COPY_FLAGS = Object.freeze({ alternates: "copy-alternates", flat: "copy-flat", partialClone: "copy-partial-clone", submodule: "copy-submodule", embedded: "copy-embedded", beyondLimit: "copy-beyond-limit", objectsReferences: "copy-objects-reference", filter: "copy-filter", detached: "copy-detached", stashes: "copy-stash" });

/** Downtime = images / imagesMBs + volumes / volumesMBs + stopS + 2 × volumes / manifestMBs. */
export const RATES = Object.freeze({
  // Measured on a real relocation (9.0 GB in 697 s ≈ 12.9 MB/s, B at its 8 GiB memory cap); `docker load` alone reaches 17–26 MB/s.
  imagesMBs: 13,
  volumesMBs: 40, // the server's SSD: 40–45 MB/s
  manifestMBs: 35, // measured 78 MB in 2.2 s, per side (source after stopping, target before the start)
  stopS: 30, // `docker stop -t 30` (a PID 1 that ignores SIGTERM takes the full 30 s)
});
const MB = 1e6;
/** How many paths of the first project-repo commit the plan names literally (the rest shows as a count). */
export const PATHS_CAP = 200;
/** From here on a file is "large" (the plan names it individually). */
export const LARGE_BYTES = 10 * 1024 * 1024;
/** Runtime places whose content does not make a write layer "carry data" (/tmp; /run is runtime-only per FHS). */
export const DIFF_TRANSIENT = Object.freeze(["/tmp", "/run", "/var/run"]);
/** What a runtime recreates in the write layer by itself, so it cannot go missing. Python's bytecode cache: the official
 *  Python image deletes it at build time and the interpreter rewrites it on the first start of every container
 *  (`…/encodings/__pycache__/*.pyc`) — otherwise every Python container would hold. MinIO creates the empty folders
 *  `$HOME/.minio/certs/CAs` on every start; a certificate INSIDE is a leaf below and still holds. Inside the project
 *  container the same start writes both again. */
export const DIFF_GENERATED = Object.freeze([/(?:^|\/)__pycache__(?:\/[^/]+\.pyc)?$/, /(?:^|\/)\.minio\/certs(?:\/CAs)?$/]);
/** States of a one-off container that step 4 would stop (the running states of procedure.js plus paused). */
export const ONCE_RUNNING = Object.freeze(["running", "restarting", "paused"]);
/** Framework defaults for the port when neither `.env.example` nor the start script names it ("default in the code"). */
export const FRAMEWORK_PORTS = Object.freeze([
  [/\bnext\s+(?:dev|start)\b/, "next", 3000], [/\bnuxt\b|\bnuxi\s+dev\b/, "nuxt", 3000], [/\bvite\b/, "vite", 5173],
  [/\bastro\s+dev\b/, "astro", 4321], [/\breact-scripts\s+start\b/, "react-scripts", 3000], [/\buvicorn\b/, "uvicorn", 8000],
  [/\bflask\s+run\b/, "flask", 5000], [/\bmanage\.py\s+runserver\b/, "django", 8000], [/\brails\s+s(?:erver)?\b/, "rails", 3000],
]);

const realDefault = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const nameOf = (c) => String(c?.Name || c?.name || "").replace(/^\//, "");
const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const ANONYM = /^[0-9a-f]{64}$/;
const DEFAULT_NETWORKS = new Set(["bridge", "host", "none", "default"]);
const EXAMPLE = /\.(?:example|sample|template|dist)$/;

function hostPorts(c) {
  const out = new Set();
  for (const source of [c?.HostConfig?.PortBindings, c?.NetworkSettings?.Ports]) {
    for (const bindings of Object.values(source || {})) {
      for (const b of bindings || []) { const n = Number(b?.HostPort); if (Number.isInteger(n) && n > 0) out.add(n); }
    }
  }
  return out;
}

function size(v) {
  const g = v?.size ?? v?.UsageData?.Size;
  return Number.isFinite(g) && g >= 0 ? g : null;
}

const refNorm = (r) => {
  let s = String(r || "").replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "");
  if (!s.includes("@") && !/:[^/]+$/.test(s)) s += ":latest";
  return s;
};

// The leaves of a `docker diff` (a "C" on a folder is only a parent marker), without the transient places. `targets` are
// the mount targets of the container: when a target is missing in the image, dockerd creates the mount point in the write
// layer (`A /data`) — that is not data, the content lies in the mount, and inside `create` makes the same point again.
export function diffData(diff, targets = []) {
  const paths = (diff || []).map((d) => (typeof d === "string" ? d.replace(/^[ACD]\s+/, "") : String(d?.Path || ""))).filter(Boolean);
  const parent = new Set();
  for (const p of paths) for (let d = path.posix.dirname(p); d !== "/" && d !== "."; d = path.posix.dirname(d)) parent.add(d);
  return sorted([...new Set(paths)].filter((p) => !parent.has(p) && !DIFF_TRANSIENT.some((f) => inArea(p, [f])) && !inArea(p, targets) && !DIFF_GENERATED.some((r) => r.test(p))));
}

// The write layer is sorted by path, and `.venv`/`.cache` sort before every letter — five examples can hide a real file
// behind them (`/app/instance/app.db`). So the hold reason carries the count per folder (the first three levels, all
// folders, largest first) and a checksum over the WHOLE sorted list; a receipt names that checksum (`applyReceipts`) —
// what is acknowledged is exactly the list the plan saw.
export function writeLayerFolder(paths) {
  const n = new Map();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    const k = `/${parts.slice(0, Math.min(3, Math.max(1, parts.length - 1))).join("/")}`;
    n.set(k, (n.get(k) || 0) + 1);
  }
  return [...n].map(([filePath, count]) => ({ path: filePath, count })).sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}
export const writeLayerChecksum = (paths) => crypto.createHash("sha256").update(paths.join("\n")).digest("hex").slice(0, 16);

// Port overrides in a start command: `-p 3100`, `--port 3100`, `--port=3100`, `PORT=3100`, `X_PORT=3100` — the ONE rule from
// ./port-command.js (inside quotes too; a docker `-p 3100:3000` is none), ascending.
export const portsInCommand = overriddenPorts;

/** Hold reasons the caller of the relocation may acknowledge explicitly (the caller reads the plan and decides): only the
 *  write layer (development tools installed by hand, with their package cache). */
export const ACKNOWLEDGEABLE = Object.freeze(["writeLayer"]);

/** The receipts `acknowledged` ([{ kind, container, count, checksum }]) against the hold reasons of a plan: a receipt lifts
 *  EXACTLY the hold reason of the same kind, container, count and checksum (count and checksum over the whole list prove
 *  that the plan that was read is the one acknowledged — if the write layer changes in between, it no longer fits).
 *  → { open, dismissed, mismatched }: `open` the remaining hold reasons, `dismissed` the lifted ones (with examples, for
 *  the report), `mismatched` every receipt without a matching hold reason (including a kind that cannot be acknowledged) —
 *  the caller rejects those. */
export function applyReceipts(holdReasons = [], acknowledged = []) {
  const open = [];
  const dismissed = [];
  const used = new Set();
  const list = Array.isArray(acknowledged) ? acknowledged : [];
  for (const h of holdReasons || []) {
    const i = ACKNOWLEDGEABLE.includes(h.kind)
      ? list.findIndex((q, j) => !used.has(j) && q && q.kind === h.kind && q.container === h.container && q.count === h.count && typeof q.checksum === "string" && q.checksum === h.checksum)
      : -1;
    if (i < 0) { open.push(h); continue; }
    used.add(i);
    dismissed.push({ kind: h.kind, container: h.container, count: h.count, checksum: h.checksum, folder: h.folder || [], examples: h.examples || [] });
  }
  const mismatched = list.filter((_, j) => !used.has(j)).map((q) => ({ kind: String(q?.kind ?? ""), container: String(q?.container ?? ""), count: q?.count ?? null, checksum: q?.checksum ?? null }));
  return { open, dismissed, mismatched };
}

/** The partition of the worktrees (one computation for plan, collection and procedure): `root` is the real project folder.
 *  → { move: [{ repo, path }], stay: [{ repo, path, atTarget? }], notices: [[kind, fields]] }. */
export function worktreePartitioning(data = {}, root, { under = (p, w) => inArea(p, [w]), realPath = realDefault } = {}) {
  const move = [];
  const stay = [];
  const notices = [];
  for (const w of data.worktrees || []) {
    const p = realPath(w.path);
    if (w.repo && p === realPath(w.repo)) continue;
    if (under(p, root)) stay.push({ repo: w.repo, path: w.path });
    else if (w.missing || w.prunable) notices.push(["worktree-orphaned", { repo: w.repo, path: w.path }]);
    else if (data.worktreeTarget && under(p, realPath(data.worktreeTarget))) {
      stay.push({ repo: w.repo, path: w.path, atTarget: true });
      notices.push(["worktree-at-target", { repo: w.repo, path: w.path }]);
    } else if ((data.worktreeRoots || []).some((r) => under(p, realPath(r)))) move.push({ repo: w.repo, path: w.path });
    else notices.push(["worktree-outside", { repo: w.repo, path: w.path }]);
  }
  return { move, stay, notices };
}

/** The worktrees step 13 moves — ONE list for plan, collection (processes inside them) and procedure. */
export const toMovingWorktrees = (data, root, opts) => worktreePartitioning(data, root, opts).move;

/** The plan (see header). `opts.under(path, root)` is the test seam of the rule "under the project folder". */
export function planRelocation(data = {}, { under = (p, w) => inArea(p, [w]), realPath = realDefault, exists = null } = {}) {
  const holdReasons = [];
  const hints = [];
  const report = (kind, fields = {}) => {
    const e = ENTRIES[kind];
    if (!e) throw new Error(`planRelocation: unknown kind ${kind}`);
    (e.stage === H ? holdReasons : hints).push({ kind, text: e.text, ...fields });
  };
  const project = data.project || {};
  if (!project.path) throw new Error("planRelocation: no project folder");
  const root = realPath(project.path);
  const rel = (p) => { const r = path.relative(root, realPath(p)); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p; };
  const mounts = data.mounts;
  if (!Array.isArray(mounts)) report("data-missing", { what: "mounts" });
  const pathCtx = { mounts: mounts || [], home: data.home || "", exists };

  // ── Who moves along ──────────────────────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(data.container)) report("data-missing", { what: "container" });
  // Containers of cbase (header): only its OWN keys on the container count, not one inherited from the image.
  const imageLabels = (c) => {
    const i = Array.isArray(data.images) ? data.images.find((x) => x.Id === c.Image) : null;
    return i && i.Labels && typeof i.Labels === "object" ? i.Labels : null;
  };
  const own = [];
  const all = [];
  for (const c of data.container || []) {
    const k = ownKey(labelsOf(c), imageLabels(c));
    if (k.length) own.push({ c, key: k }); else all.push(c);
  }
  const relocation = [];
  const outside = [];
  const withoutLabelRaw = [];
  for (const c of all) {
    const wd = labelsOf(c)[LABEL.folder];
    if (!wd) withoutLabelRaw.push(c);
    else if (under(realPath(wd), root)) relocation.push(c);
    else outside.push(c);
  }
  const relocationIds = new Set(relocation.map((c) => c.Id));
  const notWith = all.filter((c) => !relocationIds.has(c.Id));
  // One-off containers stay in B (header); only `replica` is created inside.
  const isOnce = (c) => String(labelsOf(c)[LABEL.oneoff] || "").toLowerCase() === "true";
  const replica = relocation.filter((c) => !isOnce(c));

  // ── Compose groups ───────────────────────────────────────────────────────────────────────────────────────────
  const groups = new Map();
  for (const c of replica) {
    let k;
    try { k = composeConfig(c); } catch (e) {
      if (!(e instanceof ComposeConfigError)) throw e;
      report("compose-labels", { container: nameOf(c), reason: e.message });
      continue;
    }
    const s = configKey(k);
    if (!groups.has(s)) groups.set(s, { ...k, container: [] });
    groups.get(s).container.push(c);
  }
  const projects = new Map();
  for (const g of groups.values()) projects.set(g.project, (projects.get(g.project) || 0) + 1);
  for (const [p, n] of projects) if (n > 1) report("compose-several-calls", { project: p, sets: n });
  for (const p of projects.keys()) {
    const other = outside.filter((c) => labelsOf(c)[LABEL.project] === p).map(nameOf);
    if (other.length) report("compose-project-shared", { project: p, outside: sorted(other) });
  }

  // ── Containers, images, mounts, ports, write layer ───────────────────────────────────────────────────────────
  if (!Array.isArray(data.images)) report("data-missing", { what: "images" });
  const images = data.images || [];
  const imageOfRef = (ref) => {
    const n = refNorm(ref);
    return images.find((i) => (i.RepoTags || []).map(refNorm).includes(n) || (i.RepoDigests || []).includes(ref)) || null;
  };
  const container = [];
  const imagesWith = new Map();
  const ownPorts = new Set();
  const volumesWith = new Map();
  const anonym = [];
  const onceVolumes = new Map(); // named volume → the one-off containers using it
  const anonymousOnce = new Map(); // anonymous volume → the one-off containers using it
  // Driver and options per volume that moves — ONCE per volume (options carry bind/device, nfs, tmpfs).
  const volumeChecked = new Set();
  const checkVolume = (name, mountDriver) => {
    if (volumeChecked.has(name)) return;
    volumeChecked.add(name);
    const vol = (data.volumes || []).find((v) => v.Name === name);
    if ((mountDriver || vol?.Driver || "local") !== "local") report("volume-driver", { volume: name, driver: mountDriver || vol?.Driver });
    if (Array.isArray(vol?.options) && vol.options.length) report("volume-options", { volume: name, options: sorted(vol.options) });
  };
  for (const c of relocation) {
    const l = labelsOf(c);
    const name = nameOf(c);
    const once = isOnce(c);
    const ref = c?.Config?.Image || "";
    const ports = hostPorts(c);
    if (!once) {
      if (ref.includes("@")) report("image-digest", { container: name, image: ref });
      else {
        const tagImage = /^(?:sha256:)?[0-9a-f]{12,64}$/.test(ref) ? null : imageOfRef(ref);
        if (!tagImage || tagImage.Id !== c.Image) report("image-without-tag", { container: name, tag: ref || null, tagShowsOn: tagImage?.Id || null });
      }
      const img = images.find((i) => i.Id === c.Image);
      imagesWith.set(c.Image, { id: c.Image, tags: img?.RepoTags || [], bytes: Number.isFinite(img?.Size) ? img.Size : null });
      for (const p of ports) ownPorts.add(p);
      if (ports.has(7718)) report("stack-port-7718", { container: name });
      // A coupling to container ids of B — only name and kind, never the value.
      const hc = c?.HostConfig || {};
      const references = ["NetworkMode", "IpcMode", "PidMode"].filter((k) => typeof hc[k] === "string" && hc[k].startsWith("container:"));
      if (Array.isArray(hc.VolumesFrom) && hc.VolumesFrom.length) references.push("VolumesFrom");
      if (references.length) report("service-reference", { container: name, references });
    }
    const ms = [];
    const onceAnonym = [];
    for (const m of c.Mounts || []) {
      if (m.Type === "volume") {
        const vol = (data.volumes || []).find((v) => v.Name === m.Name);
        const isAnonym = ANONYM.test(m.Name || "") || Object.hasOwn(vol?.Labels || {}, "com.docker.volume.anonymous");
        ms.push({ type: "volume", name: m.Name, target: m.Destination, anonym: isAnonym });
        if (once) {
          if (isAnonym) onceAnonym.push(m.Name);
          else { if (!onceVolumes.has(m.Name)) onceVolumes.set(m.Name, new Set()); onceVolumes.get(m.Name).add(name); }
          // Also the one-off containers per anonymous volume (checked below against the anonymous volumes that move).
          if (isAnonym) { if (!anonymousOnce.has(m.Name)) anonymousOnce.set(m.Name, new Set()); anonymousOnce.get(m.Name).add(name); }
          continue;
        }
        checkVolume(m.Name, m.Driver);
        if (isAnonym) anonym.push({ name: m.Name, container: name, target: m.Destination, bytes: size(vol) });
        else { if (!volumesWith.has(m.Name)) volumesWith.set(m.Name, new Set()); volumesWith.get(m.Name).add(name); }
      } else if (m.Type === "bind") {
        ms.push({ type: "bind", source: m.Source, target: m.Destination });
        if (once) continue;
        if (m.Source === "/var/run/docker.sock" || m.Source === "/run/docker.sock") report("docker-sock", { container: name });
        else if (stagePath(m.Source, pathCtx).path === "outside") report("bind-outside", { container: name, source: m.Source, target: m.Destination });
      } else ms.push({ type: m.Type || "?", target: m.Destination });
    }
    if (once) {
      // Stays in B (header): write layer and volumes stay with it; only a running one holds.
      const state = c?.State?.Status || "";
      if (ONCE_RUNNING.includes(state)) report("once-container-running", { container: name, state });
      report("once-container", { container: name, state, anonym: sorted(onceAnonym) });
    } else {
      const diff = data.diffs?.[c.Id];
      if (!Array.isArray(diff)) report("data-missing", { what: "diffs", container: name });
      else {
        const d = diffData(diff, (c.Mounts || []).map((m) => m?.Destination).filter((z) => typeof z === "string" && z.startsWith("/")));
        if (d.length) report("writeLayer", { container: name, count: d.length, checksum: writeLayerChecksum(d), folder: writeLayerFolder(d), examples: d.slice(0, 5) });
      }
    }
    container.push({
      id: c.Id, name, service: l[LABEL.service] || "", composeProject: l[LABEL.project] || "",
      state: c?.State?.Status || "", exitCode: c?.State?.ExitCode ?? null, restart: c?.HostConfig?.RestartPolicy?.Name || "",
      image: c.Image, imageRef: ref, composeImage: l[LABEL.image] || null, configHash: l[LABEL.hash] || null,
      oneoff: once, dependsOn: dependsOnFrom(l[LABEL.dependsOn]).deps.map((x) => x.service),
      mounts: ms, networks: sorted(Object.keys(c?.NetworkSettings?.Networks || {})), ports: sorted([...ports]),
    });
  }
  if (!Array.isArray(data.volumes)) report("data-missing", { what: "volumes" });
  // The Compose project of the users of a volume, when it is exactly one and it moves along (otherwise null).
  const oneProjectOf = (user) => {
    const ps = new Set([...user].map((n) => container.find((x) => x.name === n)?.composeProject || ""));
    const [p] = ps;
    return ps.size === 1 && p && projects.has(p) ? p : null;
  };
  const named = [];
  for (const [name, user] of volumesWith) {
    const vol = (data.volumes || []).find((v) => v.Name === name);
    const other = notWith.filter((c) => (c.Mounts || []).some((m) => m.Type === "volume" && m.Name === name)).map(nameOf);
    if (other.length) report("volume-shared", { volume: name, outside: sorted(other) });
    // Only a volume with the Compose label of a project of THIS relocation provably belongs to it (without the row in
    // `data.volumes` the label is unknown — that holds too).
    const owner = vol ? vol.Labels?.[LABEL.project] || null : undefined;
    // Without ANY Compose label and mounted only by containers of ONE Compose project of this relocation ⇒ moves along;
    // whether it is that project's volume, the dry run checks against Compose's model (procedure.js).
    const withoutLabel = vol && !Object.keys(vol.Labels || {}).some((k) => k.startsWith("com.docker.compose.")) ? oneProjectOf(user) : null;
    if (withoutLabel) report("volume-without-label", { volume: name, project: withoutLabel });
    else if (!owner || !projects.has(owner)) report("volume-extern", { volume: name, project: owner === undefined ? "unknown" : owner });
    named.push({ name, labels: vol?.Labels || {}, bytes: size(vol), container: sorted(user), withoutContainer: false, ...(withoutLabel ? { withoutLabel } : {}) });
  }
  for (const v of data.volumes || []) {
    const p = v?.Labels?.[LABEL.project];
    if (!p || !projects.has(p) || volumesWith.has(v.Name) || ANONYM.test(v.Name || "")) continue;
    if (notWith.some((c) => (c.Mounts || []).some((m) => m.Name === v.Name))) continue;
    checkVolume(v.Name, null);
    named.push({ name: v.Name, labels: v.Labels || {}, bytes: size(v), container: [], withoutContainer: true });
  }
  named.sort((a, b) => (a.name < b.name ? -1 : 1));
  // A named volume that moves, on a one-off container that stays: hold (header, "ONE-OFF CONTAINERS").
  for (const v of named) if (onceVolumes.has(v.name)) report("once-container-volume", { volume: v.name, container: sorted(onceVolumes.get(v.name)) });
  // The same two questions for the ANONYMOUS volumes that move — a container that does not move along, or a one-off
  // container that stays, would afterwards hang on the old copy in B.
  for (const a of sorted(new Set(anonym.map((x) => x.name)))) {
    const other = notWith.filter((c) => (c.Mounts || []).some((m) => m.Type === "volume" && m.Name === a)).map(nameOf);
    if (other.length) report("volume-shared", { volume: a, outside: sorted(other) });
    if (anonymousOnce.has(a)) report("once-container-volume", { volume: a, container: sorted(anonymousOnce.get(a)) });
  }
  // The volume of the project container already lies in B (left over from an earlier instance).
  if (Array.isArray(data.volumes) && project.id != null) {
    const pv = volumeName(String(project.id));
    if (data.volumes.some((v) => v?.Name === pv)) report("project-volume-existing", { volume: pv });
  }
  // A volume without a Compose label that moves along, and another project that names it in its Compose file.
  for (const v of named.filter((x) => x.withoutLabel)) {
    for (const f of data.foreign || []) {
      if (!Array.isArray(f?.volumeNames)) continue;
      if (f.volumeNames.includes(v.name)) report("volume-without-label-foreign", { volume: v.name, projectId: f.projectId ?? null, name: f.name || "" });
      else if (f.volumeNames.some((n) => String(n).includes("$"))) report("volume-without-label-foreign", { volume: v.name, projectId: f.projectId ?? null, name: f.name || "", notCheckable: true });
    }
  }
  // Defence in depth: a container left out as a cbase container that sits on a volume of this relocation or has its
  // `working_dir` in the project folder holds, with name and reason (header, ENTRIES).
  const planVolumes = new Set([...named.map((v) => v.name), ...anonym.map((v) => v.name)]);
  for (const { c, key } of own) {
    const vols = sorted([...new Set((c.Mounts || []).filter((m) => m?.Type === "volume" && planVolumes.has(m.Name)).map((m) => m.Name))]);
    const wd = labelsOf(c)[LABEL.folder];
    const inProject = Boolean(wd) && under(realPath(wd), root);
    if (vols.length || inProject) report("container-excluded", { container: nameOf(c), labels: key, volumes: vols, workingDirInProject: inProject });
  }

  // ── Networks and the order of the groups (owner before user) ────────────────────────────────────────────────
  if (!Array.isArray(data.networks)) report("data-missing", { what: "networks" });
  const networkSelf = new Set();
  const networkOwner = new Map();
  const groupsList = [...groups.values()];
  const to = new Map(groupsList.map((g) => [g, new Set()]));
  for (const g of groupsList) {
    for (const c of g.container) {
      for (const n of Object.keys(c?.NetworkSettings?.Networks || {})) {
        if (DEFAULT_NETWORKS.has(n) || n.startsWith("container:")) continue;
        const network = (data.networks || []).find((x) => x.Name === n);
        if (!network) { if (Array.isArray(data.networks)) report("data-missing", { what: "network", network: n }); continue; }
        const owner = network.Labels?.[LABEL.project];
        if (owner) {
          networkOwner.set(n, owner);
          if (!projects.has(owner)) report("network-owner-stays", { network: n, owner });
          else if (owner !== g.project) for (const h of groupsList) if (h.project === owner) to.get(g).add(h);
        } else {
          networkSelf.add(n);
          const extra = notWith.filter((c) => Object.keys(c?.NetworkSettings?.Networks || {}).includes(n)).map(nameOf);
          if (extra.length) report("network-coupling-ends", { network: n, outside: sorted(extra) });
        }
      }
    }
  }
  const groupsFollowUp = [];
  const open = new Set(groupsList);
  while (open.size) {
    const free = [...open].filter((g) => [...to.get(g)].every((h) => !open.has(h)));
    const next = (free.length ? free : [...open]).sort((a, b) => (configKey(a) < configKey(b) ? -1 : 1));
    if (!free.length) { groupsFollowUp.push(...next); break; }
    for (const g of next) { groupsFollowUp.push(g); open.delete(g); }
  }

  // ── Compose files: outside, subnets, profiles, variables ────────────────────────────────────────────────────
  const envAfterFile = new Map((data.env || []).map((f) => [realPath(f.file), f]));
  const occupied = [LEVEL2_AREA, INNER_POOL, ...BLOCK_LIST, ...(data.projectNetwork ? [data.projectNetwork] : [])].map(cidrRange).filter(Boolean);
  // The start order is computed by THE SAME function as the restore (../restore.js startStages).
  const stages = startStages([...replica].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1)).map((c) => {
    const l = labelsOf(c);
    return { id: c.Id, name: nameOf(c), service: l[LABEL.service] || "", project: l[LABEL.project] || "", dependsOn: l[LABEL.dependsOn] || "" };
  }));
  if (stages.notices.length) report("start-follow-up", { notices: stages.notices });
  const startFollowUp = stages.stages.flat().map((c) => c.name);
  const compose = [];
  const bEnvironment = Array.isArray(data.bEnvironmentNames) ? new Set(data.bEnvironmentNames.map(String)) : null;
  for (const g of groupsFollowUp) {
    const inSet = new Set(g.container.map(nameOf));
    const followUp = [...new Set(startFollowUp.filter((n) => inSet.has(n)).map((n) => labelsOf(g.container.find((c) => nameOf(c) === n))[LABEL.service] || n))];
    const defined = new Set();
    for (const f of [path.join(g.folder, ".env"), ...g.envFiles]) for (const e of envAfterFile.get(realPath(f))?.entries || []) defined.add(e.key);
    for (const file of g.files) {
      if (stagePath(file, pathCtx).path !== "inside") report("compose-file-outside", { project: g.project, file });
      const text = data.composeTexts?.[file];
      if (typeof text !== "string") { report("data-missing", { what: "composeTexts", file }); continue; }
      for (const m of text.matchAll(/^\s*-?\s*subnet\s*:\s*["']?([0-9.]+\/\d{1,2})/gm)) {
        const b = cidrRange(m[1]);
        const cut = b && occupied.some((x) => x.start <= b.end && b.start <= x.end);
        report(cut || !b ? "fixed-subnet-collision" : "fixed-subnet", { file: rel(file), subnet: m[1] });
      }
      if (/^\s*profiles\s*:/m.test(text)) report("profile-services", { file: rel(file), services: followUp });
      const names = new Set();
      for (const m of text.replace(/\$\$/g, "").matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) names.add(m[1] || m[2]);
      const openVar = sorted([...names].filter((n) => !defined.has(n)));
      if (openVar.length) report("variable-without-label", { file: rel(file), names: openVar });
      // The same names that exist in the environment of B (without the field there is no entry) — names only.
      const fromB = bEnvironment ? openVar.filter((n) => bEnvironment.has(n)) : [];
      if (fromB.length) report("variable-from-b", { file: rel(file), names: fromB });
    }
    compose.push({ project: g.project, folder: g.folder, files: g.files, envFiles: g.envFiles, args: g.args, services: followUp, container: g.container.map(nameOf).sort() });
  }

  // ── Containers without a label that seem to belong to the project ───────────────────────────────────────────
  const services = data.services || [];
  const withoutLabel = [];
  for (const c of withoutLabelRaw) {
    const name = nameOf(c);
    const reason = services.some((d) => d.container && d.container === name) ? "registered service"
      : (c.Mounts || []).some((m) => m.Type === "bind" && m.Source && under(realPath(m.Source), root)) ? "bind in the project folder" : null;
    if (!reason) continue;
    withoutLabel.push({ name, id: c.Id, reason });
    report("without-label", { container: name, reason });
  }

  // ── Worktrees ────────────────────────────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(data.worktrees)) report("data-missing", { what: "worktrees" });
  const { notices: wtNotices, ...worktrees } = worktreePartitioning(data, root, { under, realPath });
  for (const [kind, fields] of wtNotices) report(kind, fields);
  // Fields from collect.js (without them nothing): nested with a project container, services in B without a safe process
  // group, ~/.local references that were not read.
  for (const v of data.nested || []) report("nested-converted", { situation: v.situation, projectId: v.projectId ?? null, name: v.name || "", path: v.path ?? null, ...(v.repo ? { repo: v.repo } : {}) });
  for (const u of data.nativeUnclear || []) report("native-service-unclear", { service: u.serviceId, port: u.port ?? null, reason: u.reason });
  // The processes in B in the project folder (collect.js). Unlike the fields above, a MISSING field here is unknown, not
  // "none" — without this look a relocation would pass by a running process.
  if (!Array.isArray(data.processes)) report("data-missing", { what: "processes" });
  for (const p of data.processes || []) {
    const kind = p.terminal ? "process-in-terminal" : p.descendant ? "process-descendant" : "process-in-project";
    report(kind, { pid: p.pid, program: p.program || "", start: p.start || null, ...(p.terminal ? { terminal: p.terminal } : {}) });
  }
  // Prefilled targets in the runtime folder (collect.js) — field and count only. A missing field (the check failed) is
  // unknown, not "nothing prefilled" — only a hint: step 13 puts prefilled content aside anyway instead of overwriting it.
  if (!Array.isArray(data.runtimePrefilled)) report("incomplete", { what: "runtimePrefilled" });
  for (const v of data.runtimePrefilled || []) report("runtime-prefilled", { field: String(v.field || ""), count: Number(v.count) || 0 });
  for (const pid of data.localReferencesOpen || []) report("incomplete", { what: "localReferences", projectId: pid });

  // ── MCP servers of the project ───────────────────────────────────────────────────────────────────────────────
  const mcpLocal = new Set();
  const mcpTargets = [];
  for (const s of data.mcpServer || []) {
    for (const v of referencesIn(JSON.stringify([s.command, s.args, s.env]), data.home || "/")) mcpLocal.add(v);
    if (s.url) for (const z of stageValue("URL", s.url).targets) mcpTargets.push({ server: s.name, field: "url", ...z });
    // An argument `--flag=<value>` counts with its value; relative paths resolve against the project folder from now on.
    const check = (raw, field) => {
      const t = String(raw ?? "");
      const part = /^--?[A-Za-z0-9_.-]+=/.test(t) ? t.slice(t.indexOf("=") + 1) : t;
      const r = stageValue("", part, { ...pathCtx, base: project.path });
      if (/^\.\.?\//.test(part) || (field === "command" && r.path === null && part.includes("/"))) report("mcp-relative", { server: s.name, field });
      if (r.path === "outside" && r.inB !== false) report("path-outside-mcp", { server: s.name, field });
      for (const z of r.targets) mcpTargets.push({ server: s.name, field, ...z });
    };
    if (s.command) check(s.command, "command");
    (Array.isArray(s.args) ? s.args : []).forEach((a, i) => check(a, `args[${i}]`));
    for (const e of stageEntries(Object.entries(s.env || {}), pathCtx)) {
      if (e.path === "outside" && e.inB !== false) report("path-outside-mcp", { server: s.name, field: `env.${e.key}` });
      for (const z of e.targets) mcpTargets.push({ server: s.name, field: `env.${e.key}`, ...z });
    }
  }

  // ── `.env*`: paths, port dismantling ─────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(data.env)) report("data-missing", { what: "env" });
  // Without `git ls-files` (collect.js hands in null) it is unknown which `.env.example` is the repo default and which
  // Compose file is untracked — not "none".
  if (!Array.isArray(data.tracked)) report("data-missing", { what: "tracked" });
  if (!Array.isArray(data.untrackedCompose)) report("data-missing", { what: "untrackedCompose" });
  const tracked = new Set((data.tracked || []).map((r) => path.normalize(r)));
  const portOf = (e) => e?.port ?? e?.targets?.find((z) => z.host === "local" && z.port)?.port ?? null;
  const folderOf = (d) => (d.dir ? path.resolve(project.path, d.dir) : project.path);
  const folderRelOf = (d) => path.normalize(path.relative(project.path, folderOf(d)) || ".");
  // The default of a service "in the code" (without a tracked `.env.example`): a port in the start script (package.json),
  // otherwise the framework default derived from the command. Pure, one computation for .env and service.
  const standardInCode = (d) => {
    const scripts = Object.values(data.startScripts?.[folderOf(d)] || {});
    const inScripts = [...new Set(scripts.flatMap(portsInCommand))];
    if (inScripts.length === 1) return { standard: inScripts[0], source: "package.json" };
    if (!inScripts.length) {
      const command = `${d.startCommand || ""} ${d.savedCommand || ""} ${scripts.join(" ")}`;
      const fw = FRAMEWORK_PORTS.find(([re]) => re.test(command));
      if (fw) return { standard: fw[2], source: `framework:${fw[1]}` };
    }
    return { standard: null, source: null };
  };
  const dismantlingEnv = [];
  const envOwn = [];
  for (const f of data.env || []) {
    const r = f.rel || rel(f.file);
    if (!f.entries) { report("env-unreadable", { file: r, reason: f.reason || null }); continue; }
    const name = path.basename(r);
    if (EXAMPLE.test(name)) continue;
    envOwn.push({ ...f, rel: r });
    for (const e of f.entries) {
      if (e.path !== "outside") continue;
      report(e.inB === false ? "path-unknown-env" : "path-outside-env", { file: r, key: e.key });
    }
    const exampleRel = path.normalize(path.join(path.dirname(r), ".env.example"));
    const example = tracked.has(exampleRel) ? (data.env || []).find((x) => path.normalize(x.rel || rel(x.file)) === exampleRel) : null;
    for (const e of f.entries) {
      const port = portOf(e);
      if (port === null) continue;
      const std = example ? portOf((example.entries || []).find((x) => x.key === e.key)) : null;
      if (std === null) {
        // Without a repo default the default in the code applies — recognisable only for the port of a registered service of
        // THIS folder: its default from start script or framework. Every other port stays, and the plan names it.
        const d = services.find((x) => Number(x.port) === port && folderRelOf(x) === path.normalize(path.dirname(r)));
        const code = d ? standardInCode(d) : { standard: null };
        if (code.standard === null) report("env-without-example", { file: r, key: e.key });
        else if (code.standard !== port) dismantlingEnv.push({ file: r, key: e.key, port, standard: code.standard, source: code.source });
        continue;
      }
      if (std !== port) dismantlingEnv.push({ file: r, key: e.key, port, standard: std });
    }
  }

  // ── Services: the repo-default port (step 9) ─────────────────────────────────────────────────────────────────
  const dismantlingServices = [];
  for (const d of services) {
    if (Number(d.port) === 7718) report("stack-port-7718", { service: d.name });
    if (Number.isInteger(Number(d.port)) && d.port) ownPorts.add(Number(d.port));
    // Only the override of the REGISTERED port — an `ssh -p 2222` of a tunnel to 5432 is none.
    const inCommand = [...new Set([...portsInCommand(d.startCommand), ...portsInCommand(d.savedCommand)])].filter((p) => p === Number(d.port));
    const folderRel = folderRelOf(d);
    const fromEnv = dismantlingEnv.find((x) => path.normalize(path.dirname(x.file)) === folderRel && x.port === Number(d.port));
    if (!inCommand.length && !fromEnv) continue;
    let standard = fromEnv ? fromEnv.standard : null;
    let source = fromEnv ? fromEnv.source || ".env.example" : null;
    if (standard === null) ({ standard, source } = standardInCode(d));
    if (standard === null) report("service-port-unknown", { service: d.name, portOld: d.port ?? null });
    dismantlingServices.push({ id: d.id, name: d.name, portOld: d.port ?? null, portStandard: standard, source, command: inCommand.length > 0, env: Boolean(fromEnv) });
  }
  // The target ports after the dismantling (rebuilt ⇒ the default, otherwise today's port) and the published ports of the
  // containers that move along (without one-off containers; the port of a container that a registered service carries as
  // `container` is already there with the service) — in the project container native services and docker-proxy share ONE
  // network namespace (`next dev -p 3100` → 3000 next to a Compose container on 3000 ⇒ EADDRINUSE only after the
  // turnaround). Hold only where the dismantling CREATES the duplicate, i.e. at least one participant changes its port:
  // what already sits side by side in B (two services on 3000 that run alternately) could never run at the same time there
  // either and stays as it is — like the conflict rule of B (store/projects.js), which only counts what MORE THAN ONE
  // project claims.
  const targetPorts = new Map();
  const proofs = (port, entry) => { if (!targetPorts.has(port)) targetPorts.set(port, []); targetPorts.get(port).push(entry); };
  for (const d of services) {
    const r = dismantlingServices.find((x) => x.id === d.id);
    const old = Number(d.port);
    const target = r && r.portStandard !== null ? Number(r.portStandard) : old;
    if (!Number.isInteger(target) || target <= 0 || d.port === null || d.port === undefined || d.port === "") continue;
    proofs(target, { service: String(d.name ?? d.id), switches: target !== old });
  }
  for (const c of container) {
    if (c.oneoff) continue;
    const asService = new Set(services.filter((d) => d.container && d.container === c.name).map((d) => Number(d.port)));
    for (const p of c.ports) if (!asService.has(p)) proofs(p, { container: c.name, switches: false });
  }
  for (const [port, xs] of [...targetPorts].sort((a, b) => a[0] - b[0])) {
    if (xs.length < 2 || !xs.some((x) => x.switches)) continue;
    const ctrs = sorted(xs.filter((x) => x.container).map((x) => x.container));
    report("service-port-collision", { port, services: sorted(xs.filter((x) => x.service).map((x) => x.service)), ...(ctrs.length ? { container: ctrs } : {}) });
  }
  const overrides = [];
  for (const r of data.untrackedCompose || []) {
    report("override-untracked", { file: r });
    const abs = path.resolve(project.path, r);
    if (compose.some((g) => g.files.some((x) => realPath(x) === realPath(abs)))) overrides.push({ file: r, ofCbase: /cbase/i.test(path.basename(r)) });
  }

  // ── ~/.local ─────────────────────────────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(data.local)) report("incomplete", { what: "local" });
  const assignment = {};
  const assign = (r, pid) => { (assignment[r] ||= new Set()).add(String(pid)); };
  for (const [pid, rels] of Object.entries(data.localReferences || {})) for (const r of rels || []) assign(r, pid);
  for (const r of mcpLocal) assign(r, project.id);
  const localEntries = [];
  for (const e of data.local || []) {
    const [kind, name] = String(e.rel || "").split("/");
    if (!(kind === "state" || kind === "share") || !name || (kind === "share" && SHARED_IN_SHARE.has(name))) continue;
    const pids = sorted(assignment[e.rel] || []);
    if (!pids.length) report("local-without-assignment", { rel: e.rel });
    localEntries.push({ rel: e.rel, bytes: Number.isFinite(e.bytes) ? e.bytes : null, projects: pids, current: pids.includes(String(project.id)) });
  }
  const assignmentFrom = Object.fromEntries(Object.entries(assignment).map(([k, v]) => [k, sorted(v)]));

  // ── Project repo, and what a copy does not carry ─────────────────────────────────────────────────────────────
  let projectRepo = null;
  if (!data.projectRepo) report("incomplete", { what: "projectRepo" });
  else {
    const files = data.projectRepo.files || [];
    const bytes = files.reduce((s, x) => s + (Number.isFinite(x.bytes) ? x.bytes : 0), 0);
    projectRepo = {
      arises: Boolean(data.projectRepo.arises), reason: data.projectRepo.reason || null, count: files.length, bytes,
      env: sorted(files.filter((x) => /(?:^|\/)\.env/.test(x.path)).map((x) => x.path)),
      large: files.filter((x) => x.bytes >= LARGE_BYTES).map((x) => ({ path: x.path, bytes: x.bytes })),
      paths: sorted(files.map((x) => x.path)).slice(0, PATHS_CAP), clipped: Math.max(0, files.length - PATHS_CAP),
    };
    if (!projectRepo.arises && projectRepo.reason === "repo") report("copy-code-repo", {});
  }
  for (const r of data.repos || []) for (const [flag, kind] of Object.entries(COPY_FLAGS)) if (r[flag]) report(kind, { repo: r.path });

  // ── Space and downtime (only named) ──────────────────────────────────────────────────────────────────────────
  const imageList = [...imagesWith.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sum = (xs) => xs.reduce((s, x) => s + (x.bytes ?? 0), 0);
  const unknown = [...imageList.filter((x) => x.bytes === null).map((x) => x.id), ...[...named, ...anonym].filter((x) => x.bytes === null).map((x) => x.name)];
  if (unknown.length) report("size-unknown", { names: unknown });
  const imagesBytes = sum(imageList);
  const volumesBytes = sum(named) + sum(anonym);
  const parts = {
    images: imagesBytes / MB / RATES.imagesMBs,
    volumes: volumesBytes / MB / RATES.volumesMBs,
    stop: relocation.length ? RATES.stopS : 0,
    manifests: (2 * volumesBytes) / MB / RATES.manifestMBs,
  };
  const downtime = { seconds: Math.ceil(Object.values(parts).reduce((s, x) => s + x, 0)), parts, incomplete: unknown.length > 0, guess: RATES };

  // ── Mentions of old ports; chance hits ───────────────────────────────────────────────────────────────────────
  const oldPorts = new Set([...dismantlingEnv.map((x) => x.port), ...dismantlingServices.filter((x) => x.portStandard !== null && x.portStandard !== x.portOld).map((x) => x.portOld)]);
  const mentions = [];
  if (!Array.isArray(data.texts)) report("incomplete", { what: "texts" });
  for (const t of data.texts || []) {
    String(t.text || "").split("\n").forEach((row, i) => {
      for (const p of oldPorts) {
        const re = new RegExp(`(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)?:${p}\\b|\\b[Pp]ort\\s*[:=]?\\s*${p}\\b|-p\\s+${p}\\b|PORT=${p}\\b`);
        if (re.test(row)) mentions.push({ source: t.kind, id: t.id, title: t.title || null, port: p, row: i + 1 });
      }
    });
  }
  for (const n of mentions) report("old-ports-mention", n);
  const hitOf = [];
  const hits = [];
  if (!Array.isArray(data.foreign)) report("incomplete", { what: "foreign" });
  const foreignPorts = new Map();
  for (const f of data.foreign || []) {
    for (const p of f.ports || []) if (!ownPorts.has(p)) foreignPorts.set(p, f);
    for (const file of f.env || []) {
      for (const e of file.entries || []) {
        for (const z of e.targets || []) {
          if (z.host === "local" && z.port && ownPorts.has(z.port)) hitOf.push({ projectId: f.projectId ?? null, name: f.name, file: file.rel || null, key: e.key, port: z.port });
        }
      }
    }
  }
  const ownTargets = [...envOwn.flatMap((f) => (f.entries || []).flatMap((e) => (e.targets || []).map((z) => ({ source: f.rel, key: e.key, ...z })))), ...mcpTargets.map((z) => ({ source: `mcp:${z.server}`, key: z.field, host: z.host, port: z.port }))];
  for (const z of ownTargets) {
    const f = z.host === "local" && z.port ? foreignPorts.get(z.port) : null;
    if (f) hits.push({ projectId: f.projectId ?? null, name: f.name, source: z.source, key: z.key, port: z.port });
  }
  for (const t of hitOf) report("random-hits", t);
  for (const t of hits) report("hits-fremdes", t);

  return {
    projectId: project.id ?? null,
    projectPath: project.path,
    canRelocate: holdReasons.length === 0,
    holdReasons,
    hints,
    container: container.sort((a, b) => (a.name < b.name ? -1 : 1)),
    compose,
    startFollowUp,
    stopFollowUp: [...startFollowUp].reverse(),
    images: imageList,
    volumes: { named, anonym: anonym.sort((a, b) => (a.container + a.target < b.container + b.target ? -1 : 1)) },
    networks: { itself: sorted(networkSelf), owner: sorted(networkOwner.keys()).map((n) => ({ network: n, project: networkOwner.get(n) })) },
    withoutLabel,
    worktrees,
    dismantling: { env: dismantlingEnv, services: dismantlingServices, overrides },
    local: { entries: localEntries, assignment: assignmentFrom },
    projectRepo,
    slot: { bytes: imagesBytes + volumesBytes, images: imagesBytes, volumes: volumesBytes, unknown },
    downtime,
    mentions,
    hits: { hitOf, hits },
  };
}
