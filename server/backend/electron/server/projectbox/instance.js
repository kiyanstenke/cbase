// Creating a project container: the procedure. The pure parts (subnet, mounts, hash, arguments, check function) are in
// ./creation.js; here are the docker calls, the state and the dismantling.
//
// createInstance(projectId, opts)  → the instance row afterwards (store/project-instances.js), or a `CreationError`.
//   Callers are the recreate, the relocation, the build of a copy and the setup of a new project (setup/procedure.js,
//   option `newProject`) — no route of its own. Order:
//   1. Preconditions, WITHOUT a docker call and without touching the row:
//        ops (without it status 404 `ONLY_IN_OPS`, `code: NO_OPS`),
//        no server end (the stop chain would no longer see a container created now — `serverEnds()`),
//        the project and its workspace,
//        the marker of the network separation (only valid for the running PID 1 of B; without it NO project container),
//        the shared login (if entry.sh emptied `CLAUDE_SECURESTORAGE_CONFIG_DIR` because the login move failed, the
//        project container would point at a login directory without a login through the image ENV),
//        the runtime folder (created through runs/runtime-location.js `createLocation`) and the CLI home in it
//        (`home/.claude`, `home/.codex`, `home/.local` — if they are missing there is no creation; `home/.vscode-server`
//        is NOT required — older projects lack it, step 4 creates it),
//        the row: a creation of its own (state `create`) only without a row or out of `error` — a ready instance is
//        recreated by the recreate, a working one belongs to its procedure —, and no second creation of the same project
//        in this process. `newProject: true`: additionally a row in `create` that carries `convertedAt`, has no
//        container id and is held by no procedure — the POST of a setup writes it BEFORE the container. A row in `ready`
//        throws `OCCUPIED` as without the option.
//   2. Preconditions WITH docker, still without touching the row:
//        the image `cbase-projectbox:latest` in the user container; the container is created from its id, not from the
//        name — the deploy may move `:latest` between check and `run`, the row still names the image that runs;
//        no container `cbase-p-<id>` (the recreate removes the old one by id first).
//   3. The row in the state `create` (or the caller's: `recreate`, `relocation`, `clearAway`), every step as a phase —
//      through ./instances.js setInstanceState, never directly at the store (the transition to `ready` wakes waiters).
//   4. Mounts (creation.js mountsFor), required sources present, the sources with `condition: "create"` created as agent
//      (the caches in the home of B; `home/.vscode-server` in the CLI home — BEFORE the link check and link-safe, see
//      createSourcesOn), every source below the runtime or project folder without a link (see "MOUNT SOURCES" below), the
//      target placeholders of the single-file mounts in the CLI home created as agent (otherwise runc would create them
//      as root in the runtime folder); an EMPTY placeholder whose source no longer exists is removed (the CLI would read
//      an empty settings.json as a broken setting).
//   5. Network: the one of the row or an existing `cbase-pn-<id>` is reused (fixed address); otherwise the first free /24
//      (docker networks, routes from /proc/net/route, addresses, inner pool, block list); "Pool overlaps" ⇒ the next one.
//      `volume create cbase-p-<id>-docker` (idempotent; the volume survives every recreate).
//   6. `run` only when the check function (creation.js creationViolations) finds nothing.
//   7. Wait until `docker exec … docker info` answers and the status file of the entrypoint
//      (`/run/cbase-projectbox.status`) says `ready` or `error` — tick `CBASE_PROJECTBOX_TICK_MS` (1 s), cap
//      `CBASE_PROJECTBOX_CREATION_MS` (120 s, like the entrypoint; the error says that it is a cap). A container that
//      ends before that is an error at once.
//   8. Check: storage driver overlay2 (vfs means: no idmapped mount), `memory` in cgroup.subtree_control, status file
//      `ready` (otherwise it holds the DNAT error) — exported as `checkInside` (the start of a copy checks with it after
//      `.prepared`, stacks/start.js; ONE place for the check).
//   9. The row with container id, network, subnet, bridge, IP, gateway, hostname, image id, hash and the name
//      `<slug>.cbase` (./names.js: the stored one stays, otherwise the first free one — chosen and written in the same
//      synchronous step); `ready` (or the caller's state with the phase "created"). Then the block in /etc/hosts
//      (bringAlongNames; a failure there is a log line, not an error of the creation).
//   If a step in 1 or 2 fails: the throw, the row stays as it was. If a step from 3 on fails: dismantling by id
//   (container `rm -f`, the network created in THIS call `network rm`; the volume stays), row `error` with the reason
//   (or, with a caller's state, that state with the phase "creation-error" and the reason — the caller decides on its
//   return path), then the throw. A `run -d` that CREATES the container and fails at start (exit 125 — address taken,
//   mount denied) returns no id; the container would stay behind as `created`, and the next creation would end with
//   CONTAINER_EXISTS. After an attempted `run` without an id the dismantling therefore looks it up by name — only a container
//   with the label of THIS project (step 2 showed there was none before) — and removes it by its id.
//
// MOUNT SOURCES. dockerd (the inner one of B) resolves `--mount type=bind,src=…` in ITS namespace, that is in B, and
//   follows every link. A source below a folder that a project container mounts rw — `<runtime>/home/.local`, rw at the
//   container's home — can be replaced by the container with a link (`home → /home/agent`); the next creation (loss,
//   recreate, copy) would then mount a directory of B rw into the project container. Only the ANCHORS are trusted —
//   runtime folder and project folder, both mount points themselves that the container cannot replace
//   (runs/runtime-limit.js anchorOfTheInstance). Every source BELOW an anchor is therefore determined without a link:
//   lstat per path part from the anchor (runtime/real-path.js realRoot, `strict`), and its realpath must be exactly that
//   place, below the realpath of the anchor. Otherwise NO creation (`SOURCE_REFERENCE` — the error names the source and
//   where it points). Remaining window: between this check and the `mount` of dockerd ANOTHER running container of the
//   same runtime folder (a copy) can still swap; the own one is not running at that moment. The window is closed from
//   behind: the check runs a SECOND time right before `run` (after creating sources and placeholders), and after the
//   `run` (before `ready` or the phase "created") `mountIdentity` compares dev:ino per such source — in B determined
//   without a link, in the container through ONE `docker exec <c> stat -c %d:%i -- <targets …>` (none without such a
//   source). If one differs or cannot be checked: dismantling by id and `SOURCE_REFERENCE` — dockerd then mounted
//   something other than the check meant. NOT MEASURED on a real daemon: that st_dev is equal between B and the project
//   container (bind in the same superblock).
//   The helper containers check their bind sources more strictly (./helper.js checkBindSource: realpath === wording).
//   `<runtime>/home/.vscode-server` is a second such source — one that B CREATES when it is missing. That happens BEFORE
//   the first check (otherwise it would fail at the missing source) and through runs/runtime-write.js (createSourcesOn:
//   a link leading out ⇒ `EOUTSIDE` ⇒ `SOURCE_REFERENCE`, no creation); afterwards both checks and mountIdentity hold for
//   it as for every source below the anchor. It carries the same remaining window: mountIdentity only compares after
//   `waitForInside` (up to 120 s).
//
// desiredMounts(projectId, opts)  the mounts and their hash as a creation would set them NOW — the recreate compares the
//   label `cbase.mounts.v2` of the running container with it. `opts.instance` picks the rule table (copy:
//   mountRulesCopy); `hashV1` is the same state by the older formula (label `cbase.mounts`; the transition, recreate.js).
// setNeverMountedAddition(fn)  fn({ data }) → further entries for creation.js `neverMounted` from areas that
//   projectbox/ does not import (in server.js: stacks/location.js — `<data>/copies-backup`). Without it there is no
//   context of the creation (empty is not unknown: a list without the backups would look complete).
// creationPrecheck(projectId, opts)  step 1 and the image from step 2, WITHOUT a change — the recreate asks before
//   removing the old container.
//
// withProjectOccupancy(projectId, what, fn) / projectOccupied(projectId)  ONE procedure per project in this process that
//   creates or removes the container — a deletion in the middle of a creation (or the other way round) would otherwise
//   pull the container from under each other's feet. A second procedure throws `OCCUPIED` (409).
//   TWO LEVELS: the project occupancy (`withProjectOccupancy`: creation, deletion, relocation, build of a copy …) and
//   the instance occupancy (`withInstanceOccupancy(projectId, instance, what, fn)` / `instanceOccupied`: restore, recreate
//   …, per identifier `<pid>/<instance>`). A project occupancy excludes every instance occupancy of the same project and
//   vice versa; instance occupancies of different identifiers run side by side (otherwise only one instance would come
//   up after a deploy). `occupancyOfProject(projectId)` names the first occupancy of either level,
//   `occupancySentence(what)` its sentence.
//
// THE INSTANCE: `createInstance(pid, { instance, build, chatId, … })` — names, network (`networkFor` per instance,
//   collision across all rows except the own one), volume label, rule table (creation.js mountRulesFor) and row per
//   instance; for the main instance without `build` byte-equal (anchor
//   `server/backend/test/fixtures/projectbox/main-creation*.json`).
//
// Controls: CBASE_PROJECTBOX_CREATION_MS (cap of the waiting), CBASE_PROJECTBOX_TICK_MS (tick). Test seams as options:
// `root` (prefixes /run and /proc as in network-marker.js), `home`, `system`, `addresses`, `data`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRS, MCP_SCRIPT } from "../app-state.js";
import * as store from "../store.js";
import { createLocation, locationFor } from "../runs/runtime-location.js";
import { serverEnds } from "../runs/server-end.js";
import { removeInRuntimeFolder, createFolderInRuntimeFolder, writeInRuntimeFolder } from "../runs/runtime-write.js";
import { realRoot } from "../runtime/real-path.js";
import {
  MAIN, LABEL_CHAT_WITHOUT, LABEL_INSTANCE, LABEL_PROJECT, PROJECTBOX_IMAGE, SYSTEM_PATHS, creationArgs, creationViolations, exceptionTable, containerName,
  isCopy, mountsFor, mountsHash, mountsHashV1, networkArgs, networkFromSubnet, networkName, neverMounted, routesFrom, volumeName, selectSubnet,
} from "./creation.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";
import { DockerError, docker, dockerIn } from "./docker.js";
import { procedureAlive, setInstanceState, withProcedure } from "./instances.js";
import { dnsNameOf, bringAlongNames } from "./names.js";
import { networkSeparation } from "./network-marker.js";
import { T } from "../i18n.js";

export const CREATION_CAP_MS = 120_000;
export const TICK_MS = 1_000;
/** The status file of the entrypoint (server/backend/projectbox-entry.sh): `phase=…` and `notice=…`. */
export const STATUS_FILE = "/run/cbase-projectbox.status";
export const CGROUP_CONTROL = "/sys/fs/cgroup/cgroup.subtree_control";
// A single docker call while waiting and checking: a hanging `exec` (jammed inner dockerd) must not defeat the cap.
// Fixed, not the rest of the creation cap — that cap is checked BETWEEN the calls (otherwise it would hit a docker child
// in the middle of writing its state); it can thus stretch by at most this time.
export const CALL_CAP_MS = 10_000; // also the tick call of the restore (./restore.js)

const countFrom = (raw, preset, min = 1) => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min ? n : preset;
};
export const creationCapMs = () => countFrom(process.env.CBASE_PROJECTBOX_CREATION_MS, CREATION_CAP_MS);
export const tickMs = () => countFrom(process.env.CBASE_PROJECTBOX_TICK_MS, TICK_MS);

export class CreationError extends Error {
  constructor(message, { code, status = 409, rootCause = null } = {}) {
    super(message);
    this.name = "CreationError";
    this.code = code;
    this.status = status;
    if (rootCause) this.cause = rootCause;
  }
}
const error = (code, set, status = 409, rootCause = null) => new CreationError(set, { code, status, rootCause });

const running = new Map(); // project id → "creation" | "erase" | …: the PROJECT occupancy in THIS process
const runningInstance = new Map(); // identifier `<pid>/<instance>` → "restore" | "recreate" | …: the INSTANCE occupancy
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The file system of B, for the pure functions ───────────────────────────────────────────────────────────────────

function kind(p) {
  try { const s = fs.statSync(p); return s.isDirectory() ? "folder" : s.isFile() ? "file" : "different"; } catch { return null; }
}
const exists = (p, desired) => kind(p) === desired;
const entries = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const content = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const inode = (p) => { try { return fs.statSync(p).ino; } catch { return null; } };

/** The IPv4 networks of this machine's interfaces (eth0 of B, …) as CIDR. */
function ownAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && a.cidr) out.push(a.cidr);
  }
  return out;
}

// The further entries of "never mounted" from other areas (header, setNeverMountedAddition).
let neverAddition = null;
export function setNeverMountedAddition(fn) { neverAddition = typeof fn === "function" ? fn : null; }

// The context of the pure functions for a project: paths, rules, check helpers. `instance` picks the rule table (copy:
// mountRulesCopy).
function context(projectId, { home = os.homedir(), system = null, data = null, instance = MAIN } = {}) {
  const proj = store.getProject(projectId);
  if (!proj) throw error("NO_PROJECT", `project ${projectId} does not exist`, 404);
  const ws = proj.workspaceId ? store.getWorkspace(proj.workspaceId) : null;
  if (!ws?.path) throw error("NO_PROJECT", `project ${projectId} has no workspace with a path`, 404);
  if (!proj.path) throw error("NO_PROJECT", `project ${projectId} has no path`, 404);
  const location = locationFor({ projectId, converted: true });
  const dataFolder = data || DIRS?.data;
  if (!dataFolder) throw error("NO_OPS", "no data folder (server not started)", 500);
  const sys = system || { ...SYSTEM_PATHS, mcp: path.dirname(MCP_SCRIPT) };
  if (!neverAddition) throw error("NEVER_MOUNTED", "without the entries of the copies (setNeverMountedAddition, server.js) no complete \"never mounted\" list — no creation", 500);
  // The roots no source may reach across: every OTHER project and EVERY workspace (the own one too — whoever mounts it
  // mounts the neighbouring projects along).
  const foreignRoots = [
    ...store.listAllProjects().filter((p) => p.id !== proj.id && p.path).map((p) => p.path),
    ...store.listWorkspaces().filter((w) => w.path).map((w) => w.path),
  ];
  return {
    proj, ws, location,
    ctx: {
      projectId: proj.id, instance: instance || MAIN, home, wsPath: ws.path, projectPath: proj.path, runtime: location.root, cliHome: location.home,
      data: dataFolder, system: sys, entries, isFile: (p) => kind(p) === "file",
      foreignRoots, neverMounted: neverMounted({ home, data: dataFolder, flat: locationFor({}), addition: neverAddition({ data: dataFolder }) }),
    },
  };
}

/** The context of the pure creation functions (paths, workspace, runtime folder, system paths) — for the relocation plan
 *  (relocation/collect.js: the mount rules of the FUTURE project container). Throws like the creation. */
export const creationContext = (projectId, opts = {}) => context(projectId, opts);

/** The mounts and their hash as a creation would set them NOW (the recreate compares the label `cbase.mounts.v2` with
 *  it); `hashV1` the same state by the older formula (header). `opts.instance` picks the rule table. */
export function desiredMounts(projectId, opts = {}) {
  const { ctx } = context(projectId, opts);
  const mounts = mountsFor({ ...ctx, exists });
  return { mounts, hash: mountsHash(mounts, { inode }), hashV1: mountsHashV1(mounts, { content, inode }), ctx };
}

// ── docker ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isMissing = (e) => e instanceof DockerError && /No such (object|container|image|network)|not found/i.test(`${e.stderr}\n${e.message}`);

async function imageId() {
  try {
    const id = (await docker(["image", "inspect", "--format", "{{.Id}}", PROJECTBOX_IMAGE])).stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw error("IMAGE", `${PROJECTBOX_IMAGE}: unexpected id "${id}"`);
    return id;
  } catch (e) {
    if (e instanceof CreationError) throw e;
    if (isMissing(e)) throw error("IMAGE", `${PROJECTBOX_IMAGE} is missing in the user container — it comes with the next deploy`, 409, e);
    throw error("IMAGE", `${PROJECTBOX_IMAGE} not readable: ${e.message}`, 500, e);
  }
}

async function containerExists(name) {
  try {
    return JSON.parse((await docker(["inspect", "--type", "container", name])).stdout || "[]")[0] || null;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

async function networkExists(name) {
  try {
    return JSON.parse((await docker(["network", "inspect", name])).stdout || "[]")[0] || null;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** The IPv4 subnets of all docker networks of the user container. */
async function dockerNetworkSubnets() {
  const ids = (await docker(["network", "ls", "-q", "--no-trunc"])).stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const networks = JSON.parse((await docker(["network", "inspect", ...ids])).stdout || "[]");
  return networks.flatMap((n) => (n?.IPAM?.Config || []).map((c) => c?.Subnet).filter((s) => s && !String(s).includes(":")));
}

function routesOf(root) {
  const file = path.join(root || "/", "proc/net/route");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    // Empty is not unknown: without routes the choice would not know whether a /24 is free.
    throw error("NETWORK", `routes not readable (${file}: ${e.code || e.message}) — without them no project network is chosen`, 500, e);
  }
  return routesFrom(text);
}

/**
 * Network of the instance: existing (reused — or recreated on its subnet when its bridge is not the derived one, see THE BRIDGE
 * below) or new. Returns `{ network, networkId, fresh }`. Per instance — name
 * `networkName(pid, instance)`, an existing network of a copy must carry the label of THIS instance, and the collision
 * runs across the rows of ALL instances except the own one (excluding the whole own project would hand a copy the /24
 * of its main instance as soon as that network happens to be gone).
 */
async function networkFor(projectId, { row, root, addresses, instance = MAIN, chatId }) {
  const pid = String(projectId);
  const name = networkName(projectId, instance);
  const existing = await networkExists(name);
  if (existing) {
    if (existing.Labels?.[LABEL_PROJECT] !== pid) {
      throw error("NETWORK", `network ${name} does not belong to this project (label ${LABEL_PROJECT}=${existing.Labels?.[LABEL_PROJECT] ?? "—"})`);
    }
    if (isCopy(instance) && existing.Labels?.[LABEL_INSTANCE] !== instance) {
      throw error("NETWORK", `network ${name} does not belong to the instance ${instance} (label ${LABEL_INSTANCE}=${existing.Labels?.[LABEL_INSTANCE] ?? "—"})`);
    }
    const subnet = (existing.IPAM?.Config || []).map((c) => c.Subnet).find(Boolean);
    const network = networkFromSubnet(subnet);
    if (row?.subnet && row.subnet !== network.subnet) {
      throw error("NETWORK", `network ${name} has ${network.subnet}, the instance row ${row.subnet} — address not fixed`);
    }
    // THE BRIDGE (hard cut, creation.js BRIDGE_PREFIX). entry.sh guards only the bridges `cbp-+`; a network created by
    // an older release carries the old bridge name and would stand unprotected (every port of the project container open to B and
    // its neighbours). Adopting it is no option: the bridge name is fixed at `network create`. So: remove it and create it again on
    // THE SAME subnet (same `--ip`, same gateway, same hostname). Only without an attached container — this runs in the creation, after
    // the container of the instance is gone (creation refuses an existing one); an endpoint left here is foreign or a race, and
    // removing the network under it would cut it off: refuse visibly instead. A missing option (docker then names the bridge `br-<id>`,
    // which entry.sh does not guard either) counts as a deviation — empty is not unknown.
    const bridge = existing.Options?.["com.docker.network.bridge.name"] ?? "";
    if (bridge !== network.bridge) {
      const attached = Object.keys(existing.Containers || {});
      if (attached.length) {
        throw error("NETWORK", `network ${name} carries the bridge “${bridge || "—"}” instead of ${network.bridge}, but ${attached.length} container(s) are still attached — not recreated`);
      }
      await docker(["network", "rm", existing.Id]);
      const networkId = (await docker(networkArgs({ projectId, network, instance, chatId }))).stdout.trim();
      console.log(`[projectbox] network ${name}: bridge “${bridge || "—"}” → ${network.bridge}, recreated on ${network.subnet}`);
      return { network, networkId, fresh: true };
    }
    return { network, networkId: existing.Id, fresh: false };
  }
  const args = (network) => networkArgs({ projectId, network, instance, chatId });
  // A row with a subnet (recreate): the same address, no evading.
  if (row?.subnet) {
    const network = networkFromSubnet(row.subnet);
    const networkId = (await docker(args(network))).stdout.trim();
    return { network, networkId, fresh: true };
  }
  const occupied = {
    dockerNetworks: [
      ...(await dockerNetworkSubnets()),
      ...store.projectInstances().filter((z) => !(z.projectId === pid && (z.instance || MAIN) === instance) && z.subnet).map((z) => z.subnet),
    ],
    routes: routesOf(root),
    addresses: addresses ?? ownAddresses(),
  };
  const denied = [];
  for (let attempt = 0; attempt < 256; attempt++) {
    const network = selectSubnet({ ...occupied, dockerNetworks: [...occupied.dockerNetworks, ...denied] });
    try {
      const networkId = (await docker(args(network))).stdout.trim();
      return { network, networkId, fresh: true };
    } catch (e) {
      // A network that docker knows but that list and routes did not show (race, foreign pool): the next one.
      if (e instanceof DockerError && /Pool overlaps/i.test(`${e.stderr}\n${e.message}`)) { denied.push(network.subnet); continue; }
      throw error("NETWORK", `network create ${network.subnet}: ${e.message}`, 500, e);
    }
  }
  throw error("NETWORK", "no project network could be created — 256 attempts failed at \"Pool overlaps\"", 500);
}

const statusFrom = (text) => {
  const s = { phase: "", notice: "" };
  for (const z of String(text || "").split("\n")) {
    const k = z.indexOf("=");
    if (k > 0 && (z.slice(0, k) === "phase" || z.slice(0, k) === "notice")) s[z.slice(0, k)] = z.slice(k + 1).trim();
  }
  return s;
};
const cat = (id, file, capMs) => docker(["exec", "-u", "agent", id, "cat", file], { capMs });

// The phases of the status file at which the waiting ends — per target (`until`). `prepare`: the entrypoint of a copy
// waits there for `.prepared`, its dockerd only starts afterwards — `docker info` would never answer.
const FINAL_PHASES = { ready: ["ready", "error", "ended"], prepare: ["prepare", "ready", "error", "ended"] };

/**
 * Until `docker info` answers inside AND the status file says `ready`/`error`/`ended` — with a cap. Also the way of the
 * restore after `docker start` (./restore.js): the same cap (120 s, like the entrypoint), the same reading of the status
 * file — ONE place that reads it. `{ until: "prepare" }` reads ONLY the status file (no `docker info`, `driver` stays
 * null) and already ends at `prepare`.
 */
export async function waitForInside(id, { until = "ready" } = {}) {
  const finalPhases = FINAL_PHASES[until];
  if (!finalPhases) throw new TypeError(`waitForInside: unknown target "${until}" (${Object.keys(FINAL_PHASES).join(", ")})`);
  const withInfo = until === "ready";
  const cap = creationCapMs();
  const tick = tickMs();
  const start = Date.now();
  let driver = null;
  let last = "no answer yet";
  for (let attempt = 0; ; attempt++) {
    const rest = cap - (Date.now() - start);
    if (rest <= 0) {
      throw error("START", `the project container does not answer after ${attempt} attempt(s) — cap of ${cap} ms hit (${last})`, 500);
    }
    const d = CALL_CAP_MS;
    try {
      if (withInfo && !driver) driver = (await dockerIn(id, ["info", "--format", "{{.Driver}}"], { capMs: d })).stdout.trim();
      const status = statusFrom((await cat(id, STATUS_FILE, d)).stdout);
      if (finalPhases.includes(status.phase)) return { driver, status, attempts: attempt + 1 };
      last = `status file phase=${status.phase || "—"}`;
    } catch (e) {
      last = e.message;
      // A container that already ended again never answers — report at once, with its log.
      const c = await containerExists(id).catch(() => null);
      if (c && c.State?.Status && c.State.Status !== "running") {
        const log = await docker(["logs", "--tail", "20", id]).then((r) => `${r.stdout}${r.stderr}`.trim(), () => "");
        throw error("START", `the project container ended at once (${c.State.Status}, exit ${c.State.ExitCode})${log ? `: ${log.split("\n").slice(-3).join(" | ")}` : ""}`, 500, e);
      }
    }
    await pause(tick);
  }
}

/**
 * Step 8 (header): storage driver overlay2, status file `ready`, `memory` in cgroup.subtree_control — after waitForInside
 * (`{ driver, status }` from there). Throws `CreationError` CHECK (500). ONE place for the creation of the main instance
 * and the start of a copy (its creation only waits until `prepare`, the check comes after `.prepared`).
 */
export async function checkInside(containerId, { driver, status }) {
  if (driver !== "overlay2") throw error("CHECK", `storage driver "${driver}" instead of overlay2 (vfs means: the container sees no idmapped mounts)`, 500);
  if (status.phase !== "ready") throw error("CHECK", `the entrypoint reports phase=${status.phase}: ${status.notice || "—"}`, 500);
  const control = (await cat(containerId, CGROUP_CONTROL, CALL_CAP_MS)).stdout;
  if (!control.split(/\s+/).includes("memory")) throw error("CHECK", `cgroup.subtree_control without memory ("${control.trim()}") — the inner dockerd could not limit memory`, 500);
}

// ── The creation ───────────────────────────────────────────────────────────────────────────────────────────────────

function preconditions(projectId, opts) {
  if (!projectboxOps()) throw error("NO_OPS", ONLY_IN_OPS, 404);
  if (serverEnds()) throw error("SERVER_ENDS", "the server is ending — no new project container, the stop chain would no longer see it", 503);
  const k = context(projectId, opts);
  const marker = networkSeparation({ root: opts.root || "" });
  if (!marker.valid) throw error("NETWORK_SEPARATION", `network separation is missing (marker ${marker.reason}) — without it no project container is created`);
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === "") {
    throw error("LOGIN", "the login move of this user container is incomplete (CLAUDE_SECURESTORAGE_CONFIG_DIR empty) — the project container would find no login");
  }
  createLocation(k.location);
  const missing = [".claude", ".codex", ".local"].map((n) => path.join(k.location.home, n)).filter((p) => !exists(p, "folder"));
  if (missing.length) throw error("CLI_HOME", `CLI home of the project is missing (${missing.join(", ")}) — it is created before every creation`);
  return k;
}

// The states the row may carry DURING a creation: the own one (`create`) and those of the callers. `clearAway`: only the
// removal of a copy whose container is missing (stacks/clearAway.js) — under its instance occupancy "copy-clear-away",
// the row is and stays `clearAway` (never `ready`, no restore).
const CREATION_STATES = ["create", "recreate", "relocation", "clearAway"];

/**
 * Creates the project container of a project (header of this file). `opts.state`: the state the row carries during the
 * creation — `create` (default; then `ready`), otherwise the caller's (`recreate`, `relocation`; it stays, the phase
 * says "created" or "creation-error").
 *
 * `opts.instance` (default MAIN) picks names, network, volume label, rule table and row. A copy (`copy-<name>`) is only
 * created by its build: `build: true` — only with `occupancyHeld` under the project occupancy "copy" — takes the row the
 * build holds in `create`, only waits until `phase=prepare` (no `docker info`, no overlay2 and cgroup checks — they run
 * in the start) and leaves the row in `create` with the phase "created" or "creation-error"; `ready` is set by the
 * build. The recreate of a copy (`state: "recreate"`) holds the instance occupancy, as does the removal of a copy whose
 * container is missing (`state: "clearAway"` — occupancy "copy-clear-away", the row stays `clearAway`). `opts.chatId`
 * (otherwise the one of the row): the label `cbase.chat` of the copy — a trace, never the truth.
 */
export async function createInstance(projectId, opts = {}) {
  const pid = String(projectId);
  const state = opts.state || "create";
  if (!CREATION_STATES.includes(state)) throw new TypeError(`createInstance: state "${state}" is not one of the creation (${CREATION_STATES.join(", ")})`);
  const instance = opts.instance || MAIN;
  const copy = isCopy(instance); // throws for an invalid instance
  const build = opts.build === true;
  if (build && !copy) throw new TypeError("createInstance: `build` only exists for a copy");
  if (copy && !opts.occupancyHeld) throw new TypeError(`createInstance: a copy (${instance}) is only created by a procedure that holds the occupancy (build, recreate)`);
  if (copy && state === "create" && !build) throw new TypeError(`createInstance: in "create" a copy (${instance}) is only created by its build (build: true)`);
  if (copy && state === "relocation") throw new TypeError("createInstance: a relocation only creates the main instance");
  if (build && running.get(pid) !== "copy") throw new TypeError(`createInstance: build without the project occupancy "copy" (project ${pid}: ${running.get(pid) ?? "free"})`);
  // In `clearAway` only the removal of a copy creates its missing container (CREATION_STATES).
  if (state === "clearAway" && (!copy || build || instanceOccupied(pid, instance) !== "copy-clear-away")) {
    throw new TypeError(`createInstance: in "clearAway" only the removal of a copy (instance occupancy "copy-clear-away") creates — ${instance}: ${instanceOccupied(pid, instance) ?? "free"}`);
  }
  const own = state === "create" && !build;
  const k = preconditions(pid, { ...opts, instance });
  const prior = store.projectInstance(pid, instance);
  // The row the POST of a setup wrote in `create` — stamped, without a container, without a procedure.
  const newRow = opts.newProject === true && own && !copy && prior?.state === "create" && Boolean(prior.convertedAt)
    && !prior.containerId && !procedureAlive(pid, instance);
  if (own && prior && prior.state !== "error" && !newRow) {
    throw error("OCCUPIED", prior.state === "ready"
      ? `the instance ${prior.identifier} is ready — recreating is a path of its own`
      : `the instance ${prior.identifier} is in "${prior.state}" — no second creation next to it`);
  }
  if (build && prior?.state !== "create") {
    throw error("OCCUPIED", `the instance ${store.instanceIdentifier(pid, instance)} ${prior ? `is in "${prior.state}"` : "does not exist"} — the build holds it in "create"`);
  }
  if (state === "clearAway" && prior?.state !== "clearAway") {
    throw error("OCCUPIED", `the instance ${store.instanceIdentifier(pid, instance)} ${prior ? `is in "${prior.state}"` : "does not exist"} — the removal only recreates a row in "clearAway"`);
  }
  const chatId = copy ? String(opts.chatId || prior?.chatId || LABEL_CHAT_WITHOUT) : undefined; // a copy without a chat carries LABEL_CHAT_WITHOUT
  const run = () => withProcedure(pid, instance, () => creation(pid, k, { ...opts, state, own, prior, instance, build, chatId }));
  // The recreate (./recreate.js) holds the occupancy over the WHOLE procedure (stop, rm, creation, restore) — otherwise
  // there would be a window for a deletion between removal and creation. It says so with `occupancyHeld: true`; without
  // a held occupancy that is a caller's error. Held is the project occupancy (relocation, build of a copy) or the
  // instance occupancy of THIS identifier (recreate).
  if (opts.occupancyHeld) {
    if (!running.get(pid) && !instanceOccupied(pid, instance)) throw new TypeError(`createInstance: occupancyHeld, but project ${pid} is not occupied`);
    return run();
  }
  return withProjectOccupancy(pid, "creation", run);
}

// ── The preconditions of a creation, without changing anything ─────────────────────────────────────────────────────
// The recreate asks them BEFORE removing the old container: ops, no server end, project, marker of the network
// separation, login, runtime folder and CLI home (preconditions) and the image — if the creation only failed at that
// afterwards, the project would be left without a container. Throws the `CreationError` of the creation; returns
// `{ image }` (the id a creation would use NOW). Creates at most the runtime folder (idempotent, like the creation).
export async function creationPrecheck(projectId, opts = {}) {
  preconditions(String(projectId), opts);
  return { image: await imageId() };
}

// The ONE place of the occupancy sentences — the deletion lock (./erase.js) names the occupancy through it too. The sentences are
// noun phrases that other files build into texts (T); the function form keeps every key literal for the translation guard.
const OCCUPANCY_SET = {
  creation: () => T("a creation"), erase: () => T("a deletion"), restore: () => T("a restoration"), recreate: () => T("a re-creation"),
  relocation: () => T("a relocation"), copy: () => T("the build of a copy"), "copy-dismantling": () => T("the dismantling of a copy"),
  "copy-fetch": () => T("fetching a copy"), "copy-clear-away": () => T("clearing away a copy"), setup: () => T("a setup"),
  place: () => T("placing uploaded files"), layout: () => T("a layout"), superseded: () => T("removing old containers"), stop: () => T("a stop"),
  branch: () => T("a branch switch"), dismiss: () => T("discarding files"), "stack-restart": () => T("a restart of the stack"),
};
/** The sentence of an occupancy; unknown: the word itself. */
export const occupancySentence = (what) => (Object.hasOwn(OCCUPANCY_SET, what) ? OCCUPANCY_SET[what]() : String(what));
/** Which procedure is working on the project as a WHOLE right now (project occupancy, header), otherwise null. */
export const projectOccupied = (projectId) => running.get(String(projectId)) ?? null;
/** Which procedure is working on the instance right now (instance occupancy), otherwise null — without the project occupancy. */
export const instanceOccupied = (projectId, instance = MAIN) => runningInstance.get(store.instanceIdentifier(String(projectId), instance || MAIN)) ?? null;
/**
 * The occupancy at the project, of either level: `{ what, instance }` — `instance` null for the project occupancy,
 * otherwise the instance of the first instance occupancy —, or null. For locks that take the WHOLE project.
 */
export function occupancyOfProject(projectId) {
  const pid = String(projectId);
  const p = running.get(pid);
  if (p) return { what: p, instance: null };
  for (const [identifier, what] of runningInstance) {
    if (identifier.startsWith(`${pid}/`)) return { what, instance: identifier.slice(pid.length + 1) };
  }
  return null;
}
const occupiedSet = (pid, b) => (b.instance ? T`for project ${pid} (instance ${b.instance}) ${occupancySentence(b.what)} is already running` : T`for project ${pid} ${occupancySentence(b.what)} is already running`);

/**
 * `fn` as the ONLY procedure that creates or removes the container of this project (header) — the project occupancy.
 * It excludes every instance occupancy of the same project (and vice versa).
 */
export async function withProjectOccupancy(projectId, what, fn) {
  const pid = String(projectId);
  const occupied = occupancyOfProject(pid);
  if (occupied) throw error("OCCUPIED", occupiedSet(pid, occupied));
  running.set(pid, what);
  try {
    return await fn();
  } finally {
    running.delete(pid);
    reportOccupancyEnd(pid, null, what);
  }
}

// The END of an occupancy (project or instance) — fn(projectId, instance | null, what), set in server.js to ./idle.js
// afterOccupancy: a start of a stopped instance that an occupancy denied (the turn waits at the lock) is then caught up
// instead of waiting for the check-back. A setter instead of an import: idle.js imports this file. Called after the
// release (the occupancy is already gone) and never throws.
let occupancyEnd = null;
export function setOccupancyEnd(fn) { occupancyEnd = typeof fn === "function" ? fn : null; }
function reportOccupancyEnd(pid, instance, what) {
  if (!occupancyEnd) return;
  try { occupancyEnd(pid, instance, what); }
  catch (e) { console.error(`[projectbox] end of the occupancy ${pid}${instance ? `/${instance}` : ""} (${what}):`, e?.message || e); }
}

/**
 * `fn` as the ONLY procedure of this instance: restore, recreate …. Next to a project occupancy of the same project and
 * next to an instance occupancy of the SAME identifier `OCCUPIED`; instances of different identifiers run side by side.
 * Occupies synchronously — there is no await between call and occupancy.
 */
export async function withInstanceOccupancy(projectId, instance, what, fn) {
  const pid = String(projectId);
  const inst = instance || MAIN;
  isCopy(inst); // throws for an invalid instance
  const identifier = store.instanceIdentifier(pid, inst);
  const p = running.get(pid);
  if (p) throw error("OCCUPIED", occupiedSet(pid, { what: p, instance: null }));
  const i = runningInstance.get(identifier);
  if (i) throw error("OCCUPIED", occupiedSet(pid, { what: i, instance: inst }));
  runningInstance.set(identifier, what);
  try {
    return await fn();
  } finally {
    runningInstance.delete(identifier);
    reportOccupancyEnd(pid, inst, what);
  }
}

async function creation(pid, { ctx }, { state, own, prior, instance = MAIN, build = false, chatId, root = "", addresses = null }) {
  const copy = isCopy(instance);
  const name = containerName(pid, instance);
  const identifier = store.instanceIdentifier(pid, instance);
  // Step 2 — with docker, the row still stays as it is.
  const image = await imageId();
  const old = await containerExists(name);
  if (old) throw error("CONTAINER_EXISTS", `${name} already exists (id ${String(old.Id).slice(0, 12)}, ${old.State?.Status}) — remove it by id first`);

  const phase = (p) => setInstanceState(pid, instance, state, { phase: p });
  let containerId = "";
  let runAttempted = false;
  let network = null;
  try {
    phase("mounts");
    const mounts = mountsFor({ ...ctx, exists });
    const missing = mounts.filter((m) => m.condition === "required" && !exists(m.source, m.kind)).map((m) => m.source);
    if (missing.length) throw error("SOURCE_MISSING", `required source is missing: ${missing.join(", ")}`);
    createSourcesOn(mounts); // BEFORE the first link check — `cli-vscode-server` is missing in every older project
    const references = mountSourcesWithReference(mounts, ctx);
    if (references.length) throw error("SOURCE_REFERENCE", `mount source leads through a link or out of its anchor: ${references.join("; ")} — no creation (the container would have mounted a directory of B)`);
    placeholder(mounts, ctx);
    const hash = mountsHash(mounts, { inode });
    // The older formula stays in the label `cbase.mounts` — a release before the v2 label reads only that.
    const hashV1 = mountsHashV1(mounts, { content, inode });

    phase("network");
    network = await networkFor(pid, { row: prior, root, addresses, instance, chatId });
    phase("volume");
    await docker(["volume", "create", "--label", `${LABEL_PROJECT}=${pid}`, "--label", `${LABEL_INSTANCE}=${instance}`, volumeName(pid, instance)]);

    const args = creationArgs({ projectId: pid, network: network.network, image, mounts, hash, hashV1, cliHome: ctx.cliHome, instance, chatId });
    const violations = creationViolations(args, { ...ctx, image, chatId });
    if (violations.length) throw error("VIOLATION", `the creation violates the contract: ${violations.join("; ")}`, 500);
    // A second look at the server end: the preparation may have taken a while.
    if (serverEnds()) throw error("SERVER_ENDS", "the server is ending — no new project container", 503);
    // The link check once more right before `run` — sources and placeholders have been created meanwhile.
    const referencesBeforeRun = mountSourcesWithReference(mounts, ctx);
    if (referencesBeforeRun.length) throw error("SOURCE_REFERENCE", `mount source leads through a link or out of its anchor: ${referencesBeforeRun.join("; ")} — no creation (the container would have mounted a directory of B)`);

    phase("container");
    runAttempted = true;
    containerId = (await docker(args)).stdout.trim().split("\n").pop();
    phase("wait");
    // The build of a copy only waits until `phase=prepare` — its dockerd only starts after `.prepared`, `docker info`
    // would never answer; overlay2 and cgroup `memory` are checked by the start.
    const { driver, status } = build ? await waitForInside(containerId, { until: "prepare" }) : await waitForInside(containerId);

    phase("check");
    if (build) {
      if (status.phase !== "prepare") throw error("CHECK", `the entrypoint reports phase=${status.phase}: ${status.notice || "—"}`, 500);
    } else await checkInside(containerId, { driver, status });
    // What dockerd mounted at `run` is the place the check meant (dev:ino, see header "MOUNT SOURCES").
    const deviating = await mountIdentity(containerId, mounts, ctx);
    if (deviating.length) throw error("SOURCE_REFERENCE", `mount source in the container is not the checked one: ${deviating.join("; ")} — container removed (dockerd followed a link to B at run)`);

    // The name: chosen and written in ONE synchronous step — no second creation draws the same one in between. A copy:
    // `<copy>.<label of the main name>.cbase` (names.js dnsNameOf) — none yet without a name of the main instance
    // (bringAlongNames assigns it as soon as the main instance carries one).
    const dnsName = dnsNameOf(pid, instance);
    const fields = {
      containerId, network: networkName(pid, instance), subnet: network.network.subnet, bridge: network.network.bridge, ip: network.network.ip,
      gateway: network.network.gateway, hostname: network.network.hostname, ...(dnsName ? { dnsName } : {}), imageId: image, mountsHash: hash,
    };
    const row = setInstanceState(pid, instance, own ? "ready" : state, { phase: own ? "" : "created", ...fields });
    // The block in /etc/hosts: a failure there never takes the finished creation back (bringAlongNames reports instead of throwing).
    try { bringAlongNames(); } catch (x) { console.warn(`[projectbox] creation ${copy ? identifier : pid}: names not brought along: ${x?.message || x}`); }
    return row;
  } catch (e) {
    const reason = e instanceof CreationError ? e.message : `creation: ${e?.message || e}`;
    const dismantling = [];
    if (containerId) await docker(["rm", "-f", containerId]).catch((x) => dismantling.push(`rm ${containerId.slice(0, 12)}: ${x.message}`));
    else if (runAttempted) {
      // `run` failed after it may have created the container — look it up, only with the own label (for a copy also that
      // of its instance), by id.
      const rest = await containerExists(name).catch((x) => { dismantling.push(`inspect ${name}: ${x.message}`); return null; });
      const labels = rest?.Config?.Labels || {};
      if (rest?.Id && labels[LABEL_PROJECT] === pid && (!copy || labels[LABEL_INSTANCE] === instance)) {
        await docker(["rm", "-f", rest.Id]).catch((x) => dismantling.push(`rm ${String(rest.Id).slice(0, 12)}: ${x.message}`));
      } else if (rest) dismantling.push(`${name} does not carry the label of this project — not removed`);
    }
    if (network?.fresh && network.networkId) await docker(["network", "rm", network.networkId]).catch((x) => dismantling.push(`network rm: ${x.message}`));
    const set = dismantling.length ? `${reason} (dismantling incomplete: ${dismantling.join("; ")})` : reason;
    const who = copy ? identifier : pid;
    try {
      setInstanceState(pid, instance, own ? "error" : state, { phase: own ? "" : "creation-error", error: set, containerId: "" });
    } catch (x) { console.error(`[projectbox] creation ${who}: state not set: ${x?.message || x}`); }
    console.error(`[projectbox] creation ${who} failed: ${set}`);
    if (e instanceof CreationError) { e.message = set; throw e; }
    throw error("CREATION", set, 500, e);
  }
}

// Step 4, the sources with `condition: "create"` (creation.js mountRules) — BEFORE the first link check. The package
// caches are in the home of B, in no runtime folder: `createFolderInRuntimeFolder` says `false`, plain mkdir.
// `cli-vscode-server` is in the CLI home of the project, BELOW the runtime folder that every container of the project
// mounts rw — created link-safe there (runs/runtime-write.js: existing parts by their real place in the runtime folder,
// new ones O_NOFOLLOW). If the way leads out (`home` or `home/.vscode-server` is a link to a folder of B), creating
// throws `EOUTSIDE` — here `SOURCE_REFERENCE`, no creation, and nothing is created in B; a link that stays inside the
// runtime folder is caught afterwards by mountSourcesWithReference (strict: no link from the anchor on). The pure
// desired calculation (desiredMounts) creates nothing — the row is in it anyway, the hash is the same before and after.
function createSourcesOn(mounts) {
  for (const m of mounts) {
    if (m.condition !== "create") continue;
    try {
      if (!createFolderInRuntimeFolder(m.source)) fs.mkdirSync(m.source, { recursive: true });
    } catch (e) {
      if (e?.code !== "EOUTSIDE") throw e;
      throw error("SOURCE_REFERENCE", `mount source leads through a link out of its runtime folder: ${m.source} (${e.message}) — no creation (the container would have mounted a directory of B)`, 409, e);
    }
  }
}

// The mount sources below a trusted anchor (see header, "MOUNT SOURCES") that lead through a link or whose real place is
// not below the real place of their anchor — each as "<source> → <real place>". Anchors: runtime folder, project folder,
// the root of a copy (`copy-root`, itself a source). A source that is an anchor itself or below none is not checked here.
const underFolder = (p, r) => p !== r && p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
// Per mount source BELOW a trusted anchor: `{ m, q, a }` (the deepest anchor). Shared by the link check and mountIdentity.
function sourcesUnderAnchor(mounts, ctx) {
  const anchor = [ctx.runtime, ctx.projectPath, mounts.find((m) => m.rule === "copy-root")?.source].filter(Boolean).map((a) => path.resolve(a));
  const out = [];
  for (const m of mounts) {
    const q = path.resolve(String(m.source));
    const a = anchor.filter((x) => underFolder(q, x)).sort((x, y) => y.length - x.length)[0];
    if (a) out.push({ m, q, a });
  }
  return out;
}
function mountSourcesWithReference(mounts, ctx) {
  const out = [];
  for (const { m, q, a } of sourcesUnderAnchor(mounts, ctx)) {
    let real = null;
    let aReal = null;
    try { real = fs.realpathSync.native(q); aReal = fs.realpathSync.native(a); } catch { /* missing — below */ }
    const without = realRoot(q, [a], { strict: true });
    if (!real || !aReal || !without || real !== without || !underFolder(real, aReal)) out.push(`${m.source} → ${real || "not resolvable"}`);
  }
  return out;
}

// Per source below an anchor dev:ino in B — determined without a link (lstat at the place the strict lstat walk of
// `realRoot` yields; if the way leads through a link there is none) — against dev:ino of its target IN the container
// (`stat -c %d:%i`, ONE docker call). Returns one sentence per deviation; a pair that cannot be checked is a deviation
// (unknown is not equal). Without such a source no docker call.
async function mountIdentity(containerId, mounts, ctx) {
  const pairs = sourcesUnderAnchor(mounts, ctx);
  if (!pairs.length) return [];
  const inB = pairs.map(({ q, a }) => {
    const without = realRoot(q, [a], { strict: true });
    if (!without) return null;
    try { const st = fs.lstatSync(without, { bigint: true }); return `${st.dev}:${st.ino}`; } catch { return null; }
  });
  let rows;
  try {
    const r = await docker(["exec", "-u", "agent", containerId, "stat", "-c", "%d:%i", "--", ...pairs.map(({ m }) => m.target)]);
    rows = r.stdout.trim().split("\n").map((z) => z.trim());
  } catch (e) {
    return [`stat in the container could not be checked (${e?.message || e})`];
  }
  const out = [];
  pairs.forEach(({ m }, i) => {
    const inside = rows[i] || "";
    if (!inB[i] || !/^\d+:\d+$/.test(inside) || inside !== inB[i]) out.push(`${m.source} → in the container ${m.target} is ${inside || "unknown"}, in B ${inB[i] || "not determinable without a link"}`);
  });
  return out;
}

// The target placeholders of the single-file mounts in the CLI home of the project: created as agent BEFORE the `run`
// (the server runs as agent) — otherwise runc creates the mount point in the mounted runtime folder as root. An EMPTY
// placeholder of a row that is missing this time (source gone) is removed: the CLI would read an empty
// settings.json/config.toml as a broken setting.
// The CLI home is in the runtime folder (`<runtime>/home`), which every container of the project mounts rw — a creation
// after a loss of the container, a recreate or a copy hits a folder in which a process of the user already ran.
// Therefore through the descriptor there (runs/runtime-write.js): a link `home/.claude → ~/.claude` would otherwise
// create the placeholder in B and delete an empty file of B. If the way leads out, creating throws (`EOUTSIDE`, the
// creation fails), deleting leaves it.
function placeholder(mounts, ctx) {
  const under = (p) => p.startsWith(ctx.cliHome + path.sep);
  const set = new Set(mounts.map((m) => m.target));
  for (const m of mounts) {
    if (m.source === m.target || !under(m.target) || exists(m.target, m.kind)) continue;
    const folder = m.kind === "folder" ? m.target : path.dirname(m.target);
    if (!createFolderInRuntimeFolder(folder)) fs.mkdirSync(folder, { recursive: true });
    if (m.kind === "file") { if (!writeInRuntimeFolder(m.target, "", { mode: 0o600 })) fs.writeFileSync(m.target, "", { flag: "a", mode: 0o600 }); }
  }
  for (const a of exceptionTable({ home: ctx.home, cliHome: ctx.cliHome })) {
    if (a.kind !== "file" || set.has(a.target) || !under(a.target)) continue;
    try { if (fs.statSync(a.target).size === 0) { if (!removeInRuntimeFolder(a.target)) fs.rmSync(a.target, { force: true }); } } catch { /* it does not exist */ }
  }
}
// Only for the runtime-write test: the placeholders without a whole creation (docker). No caller in the product.
export const _placeholder = placeholder;
