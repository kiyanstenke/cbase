// The helper container: a short-lived container from `cbase-projectbox` in the daemon of the USER CONTAINER that moves data with
// root rights between volumes and folders the backend (agent) may not read or write itself: the relocation copies named volumes
// (`cp -a /src/. /dst/…`), the copy clones the main's Docker volume (`clone`), builds back (`returnPath`) and clears away
// (`clearAway`). ONE way for all kinds — no special way per procedure.
//
// THE LABELS. A helper carries `cbase.helper=<kind>`, `cbase.helper.project=<projectId>`, `cbase.helper.instance=<instance>` and
// `cbase.helper.run=<server run>` — NEVER `cbase.project` or `cbase.instance`, and its name starts with `cbase-helper-`, never with
// `cbase-p-`. Every search for project containers goes through these labels or this name prefix: the stop without network
// separation (server/backend/entry.sh), the stop before `rm -f` in the gateway (server/gateway/containers.js), the server end
// (serverEnd.js), the delete paths (erase.js), the distribution of the image (the deploy tool's projectbox-distribution.mjs), the
// deploy classes (the deploy tool's project-container.mjs) and the fallback without backend of `cbase-project`
// (server/backend/cbase-project, which would otherwise drop into a helper with the project folder rw). Docker filters `label=<key>`
// by the WHOLE key — `cbase.helper.project` does not match `label=cbase.project`. Guard: tools/check/helper-selectors.test.mjs
// (each of these searches against the fake docker, with a real helper and a helper of the wrong form as built-in counter-proof).
// Further labels (`cbase.relocation=<id>`) may be added as long as they carry none of these keys.
//
// THE FORM (`helperArgs`, checked by `helperViolations` before every start — a violation starts nothing):
//   `run -d --name cbase-helper-<kind>-<seq> --network none --restart no --label … [--mount …] --entrypoint /usr/bin/tini
//   cbase-projectbox:latest -- sleep infinity`. Never `--privileged` (it needs no dockerd), no network, no ports, no `-v` (creates
//   missing sources silently as a root folder), `--restart no` (a restart of B does not bring it back). The image's entrypoint
//   (dockerd) does not run: tini holds `sleep`, the work goes through `executeHelper` (docker exec, as root — the helper IS the
//   boundary: a symlink in the copied content points only into its own file system).
//   Without `--cap-add`: no CAP_SYS_ADMIN, so the helper (`cp -a`, cbase-manifest) sees no `trusted.*` xattrs. That loses nothing: in
//   Sysbox's user namespace NO process can set them, not even root (EPERM), and the inner dockerds run with `userxattr` — their
//   overlay marks are `user.overlay.*`, which `cp -a` carries and the manifest measures. `--cap-add` would not help there anyway
//   (trusted.* checks CAP_SYS_ADMIN in the init user namespace) — more rights without gain.
//   Bind sources must exist and have no symlink step (a symlink a project container created would let B's dockerd resolve it and
//   mount a foreign path of B into the root helper). The check is before the start — a window remains between it and the `run`
//   (residual risk, named): bind sources only from places B alone writes.
//
//   startHelper({ kind, projectId, instance, mounts, labels, capMs }) → { id, name, kind, projectId, instance }
//       mounts: [{ type: "volume" | "bind", source, target, onlyRead }]
//   executeHelper(helper, command, { capMs, stdin, env, stdoutFile, maxBytes })  docker exec as root; environment only as `-e NAME`;
//       `stdoutFile` writes stdout as a stream into a file instead of memory (docker.js); `maxBytes` is the output cap of the seam for
//       a call with its OWN, larger technical cap — otherwise the seam's default (64 MiB) would lie below it and that cap would be dead
//   emptyHelper(helper, { capMs })  `stop -t 0` + `start`: no process stays that B did not start
//   removeHelper(id)  by id: first checks by `inspect` that it is a helper (else it throws `NoHelper` — never a project container),
//       then `rm -f -v`. An object already gone is no error (`false`). A helper means: `cbase.helper` set ON the container
//       (own-labels.js) — a container that inherited it only from its image is none (`docker ps --filter label=cbase.helper` hits it
//       too, and the restart grace would have removed a user container with its anonymous volumes). The image is read for that; if it
//       cannot be read, the label alone counts.
//   withHelper(opts, fn)  start, `fn(helper)`, remove in `finally`
//   helperRestartGrace()  the restart-grace hook "project-helper" (registered in server.js): removes every ORPHAN — a helper with a
//       server run other than this one (label `cbase.helper.run`; two queries, the own ones after all, hence no race with a helper that
//       is just starting). A hit that is no helper (`NoHelper`, e.g. the label only from the image) stays, with a log line, and is no
//       error. Without the ops marker no docker call. `helperCleanedUp()` is the promise of that clean-up: the relocation's decider
//       awaits it before touching a half relocation (an old helper could otherwise still write into a volume the return path removes).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECTBOX_IMAGE } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { docker } from "./docker.js";
import { ownKey } from "./own-labels.js";

export const LABEL_HELPER = "cbase.helper";
export const LABEL_HELPER_PROJECT = "cbase.helper.project";
export const LABEL_HELPER_INSTANCE = "cbase.helper.instance";
export const LABEL_HELPER_RUN = "cbase.helper.run";
export const HELPER_KINDS = Object.freeze(["relocation", "clone", "returnPath", "clearAway"]);
export const HELPER_PREFIX = "cbase-helper-";
export const HELPER_ENTRYPOINT = "/usr/bin/tini";
export const HELPER_COMMAND = Object.freeze(["--", "sleep", "infinity"]);
// The keys a helper NEVER carries: the searches for project containers and for probe containers go through them.
export const FOREIGN_LABELS = Object.freeze(["cbase.project", "cbase.instance", "cbase.mounts", "cbase.mounts.v2", "cbase.probe"]);

const RUN = crypto.randomUUID(); // this server run — a helper with another one is an orphan
export const helperRun = () => RUN;

const ID = /^[0-9a-f]{64}$/;
// A label value without whitespace, comma and quote: the CLI's `{{.Labels}}` is `k=v,k=v` — a comma in the value would smuggle a
// member of its own (`cbase.relocation=1,cbase.project=p`) into every reading that splits on it (the deploy tool's gates.mjs).
const VALUE_OK = (s) => typeof s === "string" && s.length > 0 && !/[\s,"'\\\x00-\x1f]/.test(s);
// A path in the `--mount` text (CSV): spaces are fine, comma and quote are not (they would open a mount field of their own).
const PATH_OK = (s) => typeof s === "string" && s.length > 0 && !/[,"\x00-\x1f]/.test(s);
const LABEL_KEY = /^[a-z0-9][a-z0-9.-]*$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function mountText({ type, source, target, onlyRead }) {
  return `type=${type},src=${source},dst=${target}${onlyRead ? ",readonly" : ""}`;
}

/** The `run` arguments of a helper. Pure; checked in `helperViolations`. */
export function helperArgs({ kind, projectId, instance = "main", mounts = [], labels = {}, image = PROJECTBOX_IMAGE, run = RUN, seq = crypto.randomBytes(4).toString("hex") }) {
  return [
    "run", "-d", "--name", `${HELPER_PREFIX}${kind}-${seq}`, "--network", "none", "--restart", "no",
    "--label", `${LABEL_HELPER}=${kind}`, "--label", `${LABEL_HELPER_PROJECT}=${projectId}`,
    "--label", `${LABEL_HELPER_INSTANCE}=${instance}`, "--label", `${LABEL_HELPER_RUN}=${run}`,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    ...mounts.flatMap((m) => ["--mount", mountText(m)]),
    "--entrypoint", HELPER_ENTRYPOINT,
    image, ...HELPER_COMMAND,
  ];
}

const WITH_VALUE = new Set(["--name", "--network", "--restart", "--label", "--mount", "--entrypoint"]);
const WITHOUT_VALUE = new Set(["-d"]);

// The fields of a `--mount` text; `duplicate` names every field that comes twice — the sign of a comma in a path
// (`src=/a,readonly=false,src=/` would otherwise mount `/`).
function mountFields(text) {
  const f = {};
  const duplicate = [];
  for (const part of String(text).split(",")) {
    const k = part.indexOf("=");
    const [key, value] = k < 0 ? [part, true] : [part.slice(0, k), part.slice(k + 1)];
    if (key in f) duplicate.push(key);
    f[key] = value;
  }
  return { f, duplicate };
}

/**
 * Violations of a `run` argument against the helper's form — `[]` means: may be started so.
 * @param {string[]} args
 * @param {{ image?: string }} ctx
 */
export function helperViolations(args, { image = PROJECTBOX_IMAGE } = {}) {
  const v = [];
  if (!Array.isArray(args) || args[0] !== "run") return ["no `run`"];
  const values = new Map();
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!String(a).startsWith("-")) break;
    if (WITHOUT_VALUE.has(a)) { values.set(a, [...(values.get(a) || []), true]); continue; }
    if (WITH_VALUE.has(a)) {
      if (i + 1 >= args.length) { v.push(`${a} without value`); break; }
      values.set(a, [...(values.get(a) || []), args[++i]]);
      continue;
    }
    v.push(`forbidden: ${a}${a === "--privileged" ? " (a helper needs no dockerd)" : ""}`);
  }
  const one = (k) => values.get(k) || [];
  const [img, ...command] = args.slice(i);
  if (img !== image) v.push(`image ${img} instead of ${image}`);
  if (JSON.stringify(command) !== JSON.stringify(HELPER_COMMAND)) v.push(`command ${command.join(" ")} instead of ${HELPER_COMMAND.join(" ")}`);
  if (!values.has("-d")) v.push("without -d");
  if (JSON.stringify(one("--network")) !== JSON.stringify(["none"])) v.push("not exactly --network none");
  if (JSON.stringify(one("--restart")) !== JSON.stringify(["no"])) v.push("not exactly --restart no");
  if (JSON.stringify(one("--entrypoint")) !== JSON.stringify([HELPER_ENTRYPOINT])) v.push(`not exactly --entrypoint ${HELPER_ENTRYPOINT}`);
  const names = one("--name");
  if (names.length !== 1 || !String(names[0]).startsWith(HELPER_PREFIX) || !/^[A-Za-z0-9-]+$/.test(names[0])) v.push(`name not exactly once ${HELPER_PREFIX}…`);

  const labels = new Map();
  for (const l of one("--label")) {
    const k = String(l).indexOf("=");
    const key = k < 0 ? String(l) : String(l).slice(0, k);
    const value = k < 0 ? "" : String(l).slice(k + 1);
    if (!LABEL_KEY.test(key)) { v.push(`label key “${key}”`); continue; }
    if (FOREIGN_LABELS.includes(key)) v.push(`label ${key} — a helper never carries the labels of the project containers`);
    if (labels.has(key)) v.push(`label ${key} twice`);
    if (!VALUE_OK(value)) v.push(`label ${key} without a valid value`);
    labels.set(key, value);
  }
  if (!HELPER_KINDS.includes(labels.get(LABEL_HELPER))) v.push(`${LABEL_HELPER} is not a known kind (${HELPER_KINDS.join(", ")})`);
  for (const k of [LABEL_HELPER_PROJECT, LABEL_HELPER_INSTANCE, LABEL_HELPER_RUN]) if (!labels.get(k)) v.push(`without label ${k}`);
  for (const k of labels.keys()) {
    if (k.startsWith(`${LABEL_HELPER}.`) && ![LABEL_HELPER_PROJECT, LABEL_HELPER_INSTANCE, LABEL_HELPER_RUN].includes(k)) v.push(`label ${k} is reserved for the helper`);
  }

  for (const m of one("--mount")) {
    const { f, duplicate } = mountFields(m);
    const known = new Set(["type", "src", "dst", "readonly"]);
    for (const k of Object.keys(f)) if (!known.has(k)) v.push(`mount field ${k} in ${m}`);
    for (const k of duplicate) v.push(`mount field ${k} twice in ${m}`);
    if ("readonly" in f && f.readonly !== true) v.push(`mount field readonly with a value in ${m}`);
    if (f.type !== "volume" && f.type !== "bind") v.push(`mount type ${f.type} in ${m}`);
    if (!PATH_OK(f.src)) v.push(`mount source in ${m}`);
    if (!PATH_OK(f.dst) || !path.posix.isAbsolute(f.dst) || f.dst.split("/").includes("..")) v.push(`mount target in ${m}`);
    if (f.type === "volume" && !VOLUME_NAME.test(String(f.src))) v.push(`volume name in ${m}`);
    if (f.type === "bind" && (!path.isAbsolute(String(f.src)) || String(f.src).split("/").includes(".."))) v.push(`bind source not absolute in ${m}`);
  }
  return v;
}

// A bind source: present, and no step a symlink (see header).
function checkBindSource(source) {
  let real;
  try { real = fs.realpathSync(source); } catch (e) { throw new Error(`helper: bind source ${source} missing (${e.code || e.message})`); }
  if (real !== path.resolve(source)) throw new Error(`helper: bind source ${source} leads through a symlink (to ${real}) — not mounted`);
}

export async function startHelper({ kind, projectId, instance = "main", mounts = [], labels = {}, capMs } = {}) {
  for (const m of mounts) {
    if (!PATH_OK(m?.source) || !PATH_OK(m?.target)) throw new Error(`helper refused: mount path with comma, quote or control character (${JSON.stringify(m)})`);
  }
  const args = helperArgs({ kind, projectId, instance, mounts, labels });
  const v = helperViolations(args);
  if (v.length) throw new Error(`helper refused: ${v.join("; ")}`);
  for (const m of mounts) if (m.type === "bind") checkBindSource(m.source);
  const name = args[args.indexOf("--name") + 1];
  let r;
  try {
    r = await docker(args, capMs === undefined ? {} : { capMs });
  } catch (e) {
    // A `run` that created but did not start leaves the container behind — remove it by id, the id found through the name.
    await removeAfterName(name).catch(() => {});
    throw e;
  }
  const id = String(r.stdout || "").trim();
  if (!ID.test(id)) {
    await removeAfterName(name).catch(() => {});
    throw new Error(`helper: docker run returned no id ("${id.slice(0, 80)}")`);
  }
  return { id, name, kind, projectId, instance };
}

async function removeAfterName(name) {
  const ids = String((await docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${LABEL_HELPER_RUN}=${RUN}`, "--filter", `name=${name}`])).stdout).split(/\s+/).filter(Boolean);
  for (const id of ids) await removeHelper(id);
}

export async function executeHelper(helper, command, { capMs, stdin, env, stdoutFile, maxBytes } = {}) {
  if (!helper || !ID.test(String(helper.id))) throw new TypeError("executeHelper: not a helper");
  if (!Array.isArray(command) || !command.length || command.some((b) => typeof b !== "string")) throw new TypeError("executeHelper: command as an array of strings");
  const names = Object.keys(env || {});
  for (const n of names) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new TypeError(`executeHelper: environment name “${n}”`);
  const args = ["exec", ...(stdin === undefined ? [] : ["-i"]), "-u", "0", ...names.flatMap((n) => ["-e", n]), helper.id, ...command];
  const opts = {};
  if (capMs !== undefined) opts.capMs = capMs;
  if (stdin !== undefined) opts.stdin = stdin;
  if (names.length) opts.env = env;
  if (stdoutFile !== undefined) opts.stdoutFile = stdoutFile;
  if (maxBytes !== undefined) opts.maxBytes = maxBytes;
  return docker(args, opts);
}

/** The helper without a process that B did not start. `stop -t 0` ends EVERYTHING in the container — with its PID 1 the whole PID
 *  namespace ends, also what a hook, fsmonitor or filter of the main let loose via `setsid` —, `start` brings tini and `sleep`
 *  back; id, mounts and labels stay. Called after the code snapshot (where code of the main ran as agent in the helper) and BEFORE
 *  phase 2 and the check of the tars. Only for a helper from startHelper. */
export async function emptyHelper(helper, { capMs } = {}) {
  if (!helper || !ID.test(String(helper.id))) throw new TypeError("emptyHelper: not a helper");
  const opts = capMs === undefined ? {} : { capMs };
  await docker(["stop", "-t", "0", helper.id], opts);
  await docker(["start", helper.id], opts);
}

/** The container is no helper — `removeHelper` removed nothing. */
export class NoHelper extends Error {
  constructor(message) { super(message); this.name = "NoHelper"; }
}

// The `Config.Labels` of an image — null if it cannot be read (unknown, never "no labels").
async function imageLabels(image) {
  if (!image) return null;
  try {
    const r = await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", String(image)]);
    const l = JSON.parse(String(r.stdout).trim() || "null");
    return l && typeof l === "object" ? l : {};
  } catch (e) {
    if (/No such (object|image)/i.test(String(e?.stderr || e?.message))) return null;
    throw e;
  }
}

/** Remove by id — a helper only. Returns true (removed) or false (was already gone). */
export async function removeHelper(id) {
  if (!ID.test(String(id))) throw new TypeError(`removeHelper: not a full id “${id}”`);
  let labels;
  let image;
  try {
    const r = await docker(["inspect", "--type", "container", "--format", "{{json .Config.Labels}}\t{{.Image}}", id]);
    const [l, i] = String(r.stdout).trim().split("\t");
    labels = JSON.parse(l || "null") || {};
    image = String(i || "").trim();
  } catch (e) {
    if (/No such (object|container)/i.test(String(e?.stderr || e?.message))) return false;
    throw e;
  }
  if (!labels[LABEL_HELPER]) throw new NoHelper(`removeHelper: ${id.slice(0, 12)} is not a helper (without ${LABEL_HELPER}) — not removed`);
  // The label must be ON the container, not only in the image (own-labels.js).
  if (!ownKey(labels, await imageLabels(image)).includes(LABEL_HELPER)) {
    throw new NoHelper(`removeHelper: ${id.slice(0, 12)} is not a helper (${LABEL_HELPER} inherited only from the image) — not removed`);
  }
  await docker(["rm", "-f", "-v", id]);
  return true;
}

export async function withHelper(opts, fn) {
  const h = await startHelper(opts);
  try {
    return await fn(h);
  } finally {
    await removeHelper(h.id).catch((e) => console.error(`[projectbox] helper ${h.name} not removed (the restart grace clears it):`, e?.message || e));
  }
}

const idsFrom = (text) => String(text || "").split(/\s+/).filter(Boolean);

/** Remove the orphans: helpers of another server run. Returns `{ removed, error }` (ids). */
export async function cleanUpHelperOrphans() {
  if (!projectboxOps()) return { removed: [], error: [] };
  const all = idsFrom((await docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${LABEL_HELPER}`])).stdout);
  if (!all.length) return { removed: [], error: [] };
  // AFTER the list of all: a helper that starts in between is here and not there.
  const own = new Set(idsFrom((await docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${LABEL_HELPER_RUN}=${RUN}`])).stdout));
  const removed = [];
  const error = [];
  for (const id of all.filter((x) => !own.has(x))) {
    try { if (await removeHelper(id)) removed.push(id); }
    catch (e) {
      // No helper (the label inherited only from the image): stays — a user container, no orphan.
      if (e instanceof NoHelper) { console.log(`[projectbox] restart grace: ${id.slice(0, 12)} carries ${LABEL_HELPER} but is no helper — stays (${e.message})`); continue; }
      error.push(id); console.error(`[projectbox] orphaned helper ${id.slice(0, 12)} not removed:`, e?.message || e);
    }
  }
  if (removed.length) console.log(`[projectbox] restart grace: ${removed.length} orphaned helper(s) removed`);
  return { removed, error };
}

let cleanUp = Promise.resolve({ removed: [], error: [] });
export const helperCleanedUp = () => cleanUp;

export function helperRestartGrace() {
  if (!projectboxOps()) return cleanUp;
  cleanUp = cleanUpHelperOrphans().catch((e) => {
    console.error("[projectbox] restart grace: orphaned helpers not read:", e?.message || e);
    return { removed: [], error: ["?"] };
  });
  return cleanUp;
}
