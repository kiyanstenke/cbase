// The data collection of the relocation plan. plan.js is PURE; everything it needs to know is fetched by THIS file: docker
// (through the seam ../docker.js), git (through the starter runtime/git-run.js), files of the project and the store. The
// shape is EXACTLY the one from the header of plan.js — a field that could not be fetched here is MISSING (unknown is not
// empty), and the plan turns that into "data-missing" or "incomplete".
//
//   collectRelocationData({ projectId, docker, git, home })  → `data` for planRelocation
//       docker     the seam (default ../docker.js `docker`; tests pass a fake) — argument arrays only
//       git        (cwd, args) → { code, stdout, stderr } (default: the starter of runtime/git-run.js WITHOUT an instance,
//                  i.e. the path in B — the project has not moved yet; this file refuses a converted project)
//       home       the user's home in B (default os.homedir())
//   planFor(projectId, opts)  → { plan, data } — collect, then planRelocation with the `exists` seam of B (without it every
//                  MCP path outside the mounts would hold, see plan.js). The ANSWER of a route is only `plan`: `data` carries
//                  raw material with values (Compose texts, MCP environment from the store) and never leaves the backend.
//   CollectError   { code, status }: NO_PROJECT (404), ALREADY_CONVERTED (409).
//
// WHAT IS FETCHED (per field; `docker` always against the daemon of B)
//   container      `ps -a -q --no-trunc`, then `inspect --type container` in bundles — ALL containers of B, stopped ones too
//   images         `images -q --no-trunc` plus the `.Image` of the containers, then `image inspect` → { Id, RepoTags,
//                  RepoDigests, Size, Labels } (only these fields; `Labels` = `Config.Labels`, `{}` without — by it the plan
//                  recognises a label INHERITED from the image, which makes no container one of cbase's)
//   volumes        `volume ls -q`, `volume inspect` → { Name, Driver, Labels, options? }, `size` from `system df -v` (human
//                  size like "1.2GB" → bytes; if `system df` fails, `size` is missing and the plan reports "size-unknown").
//                  `options` are ONLY the keys of `Options` (driver_opts: type, o, device …) — a value can be a secret
//                  (cifs `o: password=…`); the plan holds on them
//   networks       `network ls -q --no-trunc`, `network inspect` → { Id, Name, Labels }
//   diffs          `diff <id>` per container whose `working_dir` label lies under the project folder — paths only
//   composeTexts   the Compose files from the labels, read ONLY inside the project folder and without following a link
//                  (runtime/real-path.js) — whatever lies outside is missing and holds the plan
//   untrackedCompose  Compose files in the project (depth 3) that git does not track
//   worktrees      `git worktree list --porcelain` per repo (the repo of the folder, every embedded one), each entry with
//                  `prunable`/`missing` if git calls it orphaned or its folder is absent (step 13 would fail on it AFTER
//                  the standstill — the plan holds beforehand, "worktree-orphaned")
//   worktreeRoots, worktreeTarget   the root step 13 moves FROM (flat) and the one it moves INTO (the runtime folder) — a
//                  worktree that already lies there stays ("worktree-at-target")
//   nested         [{ situation, projectId, name, path, repo? }] — a project WITH an instance row lies in this project folder
//                  or the other way round, or a repo has its working tree, git directory or `commondir` in that folder
//   nativeUnclear  services.js unclearNativeRuns: services of the project in B without a process group that might be running
//   bEnvironmentNames  the names of the environment of B (never a value)
//   runtimePrefilled  [{ field, count }] — targets of step 13 where something already lies (./data.js runtimeSources); if
//                  the check fails the field is MISSING (the plan: "incomplete")
//   processes      [{ pid, start, program, terminal?, descendant? }] — the processes in B that work in the project or in a
//                  worktree step 13 moves (working directory, program, maps, open files; ./processes.js remainingProcesses),
//                  WITHOUT the process groups of the native runs that step 4 ends itself (services.js nativeRuns — confirmed
//                  by start time). `terminal` carries the tag when the process runs in the session of a terminal the lock
//                  ends (../idle.js lockTerminalSessions). If /proc cannot be read the field is MISSING (the plan:
//                  data-missing, `what: "processes"`).
//   env, tracked   ../env-key.js readEnvFiles (NEVER values) with the mounts from creation.js mountRules; the
//                  `.env.example` files git tracks
//   services, startScripts   project_services + service_start_commands; `scripts` from package.json per service folder
//   repos          the attributes a copy does not carry — ONLY truth values, never content
//   projectRepo    whether a project repo arises and the files of its first commit: `git ls-files --others
//                  --exclude-standard` against a THROWAWAY index with exactly the exclude block of projectRepo.js (the first
//                  commit takes everything) — paths and sizes, no content
//   local, localReferences   ~/.local/state|share per entry with size (capped); cli-home.js localReferences per project —
//                  NOT for a project with an instance row nor one nested with such a project (there localReferences would
//                  read files the container can write; a `pyvenv.cfg` as a FIFO blocks the event loop of B); their ids are
//                  in `localReferencesOpen` (the plan: "incomplete")
//   foreign        the other (not converted) projects of B: ports (registered + host ports of their containers), their
//                  `.env*` classification and `volumeNames` (the literal `name:` of the volumes in their Compose files,
//                  capped, read without following links; unreadable ⇒ missing)
//   texts          skills and context — only for the search for old ports; the plan emits the places found
//
// FOREIGN DATA. The project folder and the outputs of git and `docker diff` are foreign data for B: no link is followed
// (files through real-path.js, sizes through lstat), no path from an output is opened unless it lies in the project folder
// after realpath, and `.env*` values never leave env-key.js.
//
// GIT IN B. Every git call of this collection runs with the hardening of projectRepo.js (`GIT_HARDENING`:
// `core.fsmonitor=false` — `git ls-files` would execute a `core.fsmonitor` command from the repo configuration —,
// `core.hooksPath=/dev/null`, `core.untrackedCache=false`). And NO repo whose working tree, git directory or common git
// directory lies in the folder of a project with an instance row (its project container writes `.git/config` there) is
// touched in B: the collection determines git directory and `commondir` WITHOUT git; a hit — or a project folder nested
// with such a folder — ends the git collection, `nested` names it, and the plan holds ("nested-converted", BEFORE the
// standstill). `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` stay untouched: system and user configuration belong to B (among
// other things `safe.directory` lives there); only the configuration of the repo is attackable.
//
// Guards: server/backend/test/relocation-collect.test.js (data shape without "data-missing", no env value in data.env and
// in the plan — counter-check through a value in the fixture), server/backend/test/relocation-routes.test.js (the routes),
// server/backend/test/relocation-end.test.js (the real plan of this collection before the real procedure).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as store from "../../store.js";
import { findRepos } from "../../git.js";
import { traverseWithoutReferences, realPath, realRoots, entriesInArea, inArea, openFileWithoutReference, openInArea } from "../../runtime/real-path.js";
import { gitRun } from "../../runtime/git-run.js";
import { locationFor, worktreeRoot } from "../../runs/runtime-location.js";
import { mountRules } from "../creation.js";
import { SHARED_IN_SHARE, localReferences } from "../cli-home.js";
import { ComposeConfigError, LABEL, composeConfig, labelsOf } from "../compose-config.js";
import { docker as dockerSeam } from "../docker.js";
import { isOwnContainer } from "../own-labels.js";
import { readEnvFiles } from "../env-key.js";
import { creationContext } from "../instance.js";
import { GIT_HARDENING, searchProject, excludeBlock, gitEnvironment } from "../projectRepo.js";
import { nativeRuns, unclearNativeRuns } from "../../services.js";
import { lockTerminalSessions, languageServiceGroups } from "../idle.js";
import { runtimeSources } from "./data.js";
import { planRelocation, toMovingWorktrees } from "./plan.js";
import { remainingProcesses } from "./processes.js";

const pexec = promisify(execFile);

/** Cap of one git call — estimated, not measured; as in projectRepo.js and workflows/worktree.js. */
export const GIT_CAP_MS = 120_000;
/** Cap of the output of one git call (`ls-files --others` of a large project). */
export const GIT_OUTPUT = 64 * 1024 * 1024;
/** Cap of `docker system df -v` — about ten times what was measured under light load; estimated. */
export const DF_CAP_MS = 180_000;
/** How many ids one `inspect` call gets (the command line stays short). */
export const INSPECT_BUNDLE = 50;
/** Cap of the size calculation per ~/.local entry (entries); above it the size is unknown (null), not truncated. */
export const LOCAL_CAP = 200_000;
/** Cap of the walk through `.git/objects` per repo (entries); above it the attribute is unknown (null). */
export const OBJECTS_CAP = 500_000;
/** Largest file read as a Compose file, package.json or .gitattributes. */
export const TEXT_CAP = 1024 * 1024;
/** Depth of the search for Compose files in the project (like readEnvFiles and localReferences). */
export const COMPOSE_DEPTH = 3;

const COMPOSE_NAME = /^(?:docker-)?compose(?:[.-][\w.-]*)?\.ya?ml$/;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"]);

export class CollectError extends Error {
  constructor(message, { code, status = 409 } = {}) {
    super(message);
    this.name = "CollectError";
    this.code = code;
    this.status = status;
  }
}

// ── git in B (the project has not moved yet) ──────────────────────────────────────────────────────────────────────

// The starter in B, as the fallback of gitRun without an instance: never throws, exit ≠ 0 is in `code`.
async function gitInB(cwd, args) {
  try {
    const { stdout, stderr } = await pexec("git", [...GIT_HARDENING, ...args], { cwd, timeout: GIT_CAP_MS, maxBuffer: GIT_OUTPUT, windowsHide: true, env: gitEnvironment(), encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const cap = e?.killed ? `\ngit ${args[0]}: cap of ${GIT_CAP_MS / 1000} s hit — estimated, not measured (projectbox/relocation/collect.js)` : "";
    return { code: typeof e?.code === "number" ? e.code : null, stdout: String(e?.stdout || ""), stderr: `${String(e?.stderr || e?.message || "")}${cap}` };
  }
}
/** The git starter of the collection: runtime/git-run.js without an instance, i.e. exactly the fallback. */
export const gitStandard = (cwd, args) => gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args) });

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const rows = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const unique = (xs) => [...new Set(xs)];
const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const under = (p, root) => inArea(p, [root]);

/** The host ports of a `docker inspect` (PortBindings and NetworkSettings.Ports). */
export function hostPortsOf(c) {
  const out = new Set();
  for (const source of [c?.HostConfig?.PortBindings, c?.NetworkSettings?.Ports]) {
    for (const bindings of Object.values(source || {})) {
      for (const b of bindings || []) { const n = Number(b?.HostPort); if (Number.isInteger(n) && n > 0) out.add(n); }
    }
  }
  return out;
}

/** "1.2GB", "512kB", "0B", "3.4 MiB" → bytes (docker: units.HumanSize, base 1000; binary units to be safe); otherwise null. */
export function sizeFromText(s) {
  if (Number.isFinite(s)) return s >= 0 ? s : null;
  const m = String(s ?? "").trim().match(/^([\d.]+)\s*([kKMGTP]?)(i?)B$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const base = m[3] ? 1024 : 1000;
  const exp = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2]];
  return Math.round(n * base ** exp);
}

// A docker call whose result is JSON. `inspect` of several ids fails on ONE vanished id (exit 1) but prints the rest — we
// take those, and the vanished one is missing (a container that disappeared between `ps` and `inspect` no longer exists).
async function inspectBundle(docker, front, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += INSPECT_BUNDLE) {
    const part = ids.slice(i, i + INSPECT_BUNDLE);
    let text;
    try { text = (await docker([...front, ...part])).stdout; } catch (e) {
      if (!/No such/i.test(String(e?.stderr || e?.message || "")) || !String(e?.stdout || "").trim()) throw e;
      text = e.stdout;
    }
    const list = JSON.parse(text || "[]");
    if (!Array.isArray(list)) throw new Error(`docker ${front.join(" ")}: not a list`);
    out.push(...list);
  }
  return out;
}

// Size of a tree through lstat (no link is followed); above `cap` entries null (unknown, not truncated).
function treeSize(root, cap = LOCAL_CAP) {
  const st = lstat(root);
  if (!st) return null;
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++count > cap) return null;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const s = lstat(p);
      if (s) sum += s.size;
    }
  }
  return sum;
}

// ── docker ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function collectDocker(docker) {
  const ids = rows((await docker(["ps", "-a", "-q", "--no-trunc"])).stdout);
  const container = ids.length ? await inspectBundle(docker, ["inspect", "--type", "container"], unique(ids)) : [];

  const imageIds = unique([...rows((await docker(["images", "-q", "--no-trunc"])).stdout), ...container.map((c) => c?.Image).filter(Boolean)]);
  const images = (imageIds.length ? await inspectBundle(docker, ["image", "inspect"], imageIds) : []).map((i) => ({
    Id: i?.Id, RepoTags: Array.isArray(i?.RepoTags) ? i.RepoTags : [], RepoDigests: Array.isArray(i?.RepoDigests) ? i.RepoDigests : [],
    ...(Number.isFinite(i?.Size) ? { Size: i.Size } : {}),
    // Without `Config` in the inspect the label of the image is unknown — the field is then missing (never "no labels").
    ...(i?.Config && typeof i.Config === "object" ? { Labels: i.Config.Labels && typeof i.Config.Labels === "object" ? i.Config.Labels : {} } : {}),
  }));

  const volNames = rows((await docker(["volume", "ls", "-q"])).stdout);
  const volRaw = volNames.length ? await inspectBundle(docker, ["volume", "inspect"], unique(volNames)) : [];
  let sizes = null;
  try {
    const df = JSON.parse((await docker(["system", "df", "-v", "--format", "{{json .}}"], { capMs: DF_CAP_MS })).stdout || "{}");
    sizes = new Map((Array.isArray(df?.Volumes) ? df.Volumes : []).map((v) => [v?.Name, sizeFromText(v?.Size)]));
  } catch (e) {
    console.error(`[relocation] plan: docker system df not readable — volume sizes unknown: ${e?.message || e}`);
  }
  const volumes = volRaw.map((v) => {
    const g = sizes?.get(v?.Name);
    const options = v?.Options && typeof v.Options === "object" ? Object.keys(v.Options).sort() : [];
    return { Name: v?.Name, ...(v?.Driver ? { Driver: v.Driver } : {}), Labels: v?.Labels || {}, ...(options.length ? { options } : {}), ...(Number.isFinite(g) ? { size: g } : {}) };
  });

  const networkIds = rows((await docker(["network", "ls", "-q", "--no-trunc"])).stdout);
  const networks = (networkIds.length ? await inspectBundle(docker, ["network", "inspect"], unique(networkIds)) : [])
    .map((n) => ({ Id: n?.Id, Name: n?.Name, Labels: n?.Labels || {} }));
  return { container, images, volumes, networks };
}

// The containers whose `working_dir` lies under the project folder (the same rule as plan.js, without the containers of
// cbase — ../own-labels.js; a label inherited from the image does not count).
function relocationSet(container, images, root) {
  const image = new Map((images || []).map((i) => [i.Id, i.Labels && typeof i.Labels === "object" ? i.Labels : null]));
  return container.filter((c) => {
    const l = labelsOf(c);
    if (isOwnContainer(l, image.get(c?.Image) ?? null)) return false;
    const wd = l[LABEL.folder];
    return Boolean(wd) && under(realPath(wd), root);
  });
}

async function collectDiffs(docker, set) {
  const diffs = {};
  for (const c of set) {
    try {
      diffs[c.Id] = rows((await docker(["diff", c.Id])).stdout);
    } catch (e) {
      console.error(`[relocation] plan: docker diff ${String(c?.Name || c?.Id).replace(/^\//, "")} not readable: ${e?.message || e}`); // missing ⇒ hold reason
    }
  }
  return diffs;
}

// ── files of the project ─────────────────────────────────────────────────────────────────────────────────────────

// A text file whose OPENED object lies in `realW` after realpath (a link leading out is not read), at most TEXT_CAP bytes;
// otherwise null (missing).
function readText(file, realW) {
  let fd = null;
  try {
    fd = openInArea(file, realW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > TEXT_CAP) return null;
    return fs.readFileSync(fd, "utf8");
  } catch { return null; } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function composeTexts(set, realW) {
  const out = {};
  for (const c of set) {
    let k;
    try { k = composeConfig(c); } catch (e) { if (e instanceof ComposeConfigError) continue; throw e; }
    for (const file of k.files) {
      if (Object.hasOwn(out, file)) continue;
      if (!under(realPath(file), realW[0])) continue; // outside the project: missing ⇒ hold reason in the plan
      const text = readText(file, realW);
      if (typeof text === "string") out[file] = text;
    }
  }
  return out;
}

// The Compose files in the project (absolute), without following a link.
function composeFiles(root, realW) {
  const out = [];
  traverseWithoutReferences(root, realW, (full, e) => {
    const t = path.relative(root, full).split(path.sep).length;
    if (e.isDirectory()) return !SKIP.has(e.name) && t <= COMPOSE_DEPTH;
    if (e.isFile() && COMPOSE_NAME.test(e.name)) out.push(full);
    return false;
  });
  return sorted(out);
}

function startScripts(projectPath, services, realW) {
  const out = {};
  for (const d of services) {
    const folder = d.dir ? path.resolve(projectPath, d.dir) : projectPath;
    if (Object.hasOwn(out, folder)) continue;
    const text = readText(path.join(folder, "package.json"), realW);
    if (typeof text !== "string") continue;
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    const scripts = pkg && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
    out[folder] = Object.fromEntries(Object.entries(scripts).filter(([, v]) => typeof v === "string"));
  }
  return out;
}

// ── git: repos, worktrees, tracking, attributes ─────────────────────────────────────────────────────────────────

// Which of the files (absolute) does git track? Per file the nearest repo above it (embedded, the folder itself or the repo
// the folder lies in); without a repo it is untracked. → set of the tracked absolute paths.
async function trackedFiles(git, files, repoRoots) {
  const byRepo = new Map();
  for (const d of files) {
    const repo = repoRoots.filter((r) => under(d, r)).sort((a, b) => b.length - a.length)[0];
    if (!repo) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(d);
  }
  const tracked = new Set();
  for (const [repo, list] of byRepo) {
    const rel = list.map((d) => path.relative(repo, d));
    const r = await git(repo, ["ls-files", "-z", "--full-name", "--", ...rel.map((x) => `:(literal)${x}`)]);
    if (r.code !== 0) return null; // cannot be answered ⇒ unknown
    const top = await git(repo, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 ? top.stdout.trim() : repo;
    for (const x of String(r.stdout).split("\0").filter(Boolean)) tracked.add(realPath(path.join(root, x)));
  }
  return tracked;
}

// One entry per block of `--porcelain`; `prunable` (git calls it orphaned) and `missing` (its folder is absent — also a
// `locked` worktree on an absent disk, which git never calls `prunable`) are only present when they apply.
async function worktreesOf(git, repos) {
  const out = [];
  for (const repo of repos) {
    const r = await git(repo, ["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return null;
    let w = null;
    for (const z of String(r.stdout).split("\n")) {
      if (z.startsWith("worktree ")) {
        w = { repo, path: z.slice("worktree ".length) };
        if (!lstat(w.path)) w.missing = true;
        out.push(w);
      } else if (w && (z === "prunable" || z.startsWith("prunable "))) w.prunable = true;
      else if (!z.trim()) w = null;
    }
  }
  return out;
}

// The attributes of a repo — truth values only. The common git directory is only entered if it lies in the project folder
// after realpath (a gitfile can point anywhere); otherwise the file attributes are unknown (null).
async function repoAttributes(git, repo, { root, embedded, beyondLimit }) {
  const m = { path: repo, embedded, beyondLimit, alternates: null, flat: null, partialClone: null, submodule: null, objectsReferences: null, filter: null, detached: null, stashes: null };
  const rp = await git(repo, ["rev-parse", "--git-common-dir", "--is-shallow-repository"]);
  let common = null;
  if (rp.code === 0) {
    const [c, flat] = rows(rp.stdout);
    common = c ? realPath(path.resolve(repo, c)) : null;
    m.flat = flat === "true";
  }
  const tristate = (code) => (code === 0 ? true : code === 1 ? false : null); // exit 1 = "no", everything else unknown
  const sr = await git(repo, ["symbolic-ref", "-q", "HEAD"]);
  m.detached = sr.code === 0 ? false : sr.code === 1 ? true : null;
  m.stashes = tristate((await git(repo, ["rev-parse", "-q", "--verify", "refs/stash"])).code);
  const tk = await git(repo, ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"]);
  m.partialClone = tk.code === 0 ? rows(tk.stdout).length > 0 : tk.code === 1 ? false : null;
  const gm = lstat(path.join(repo, ".gitmodules"));
  m.submodule = Boolean(gm && gm.isFile());
  const realW = [root];
  const attr = [readText(path.join(repo, ".gitattributes"), realW)];
  if (common && under(common, root)) {
    m.alternates = Boolean(lstat(path.join(common, "objects", "info", "alternates")));
    attr.push(readText(path.join(common, "info", "attributes"), realW));
    let count = 0;
    let reference = false;
    const objects = path.join(common, "objects");
    if (lstat(objects)?.isDirectory()) {
      traverseWithoutReferences(objects, realRoots([objects], [objects]), (full, e) => {
        if (++count > OBJECTS_CAP) { reference = null; return "hold"; }
        if (e.isSymbolicLink()) { reference = true; return "hold"; }
        return e.isDirectory();
      });
      m.objectsReferences = reference;
    } else m.objectsReferences = false;
  }
  m.filter = attr.some((t) => typeof t === "string" && /(^|\s)filter=/m.test(t));
  return m;
}

// The project repo: does it arise, and which files would its first commit take? Computed with a throwaway index and
// EXACTLY the exclude block of projectRepo.js — no rebuild of the exclusions. Never throws; unanswerable ⇒ undefined.
// A folder WITHOUT A SINGLE entry gets none (`reason: "empty"`): a new project there is often a target for
// `git clone <url> <path>`, and a `.git` with a first commit would make the clone fail (or let the cbase commit wander into
// a foreign remote). A folder that only carries code repos or dependencies is NOT empty — there the empty first commit stays.
async function projectRepoData(git, projectPath, { repos, unreadable }, realW) {
  if (lstat(path.join(projectPath, ".git"))) return { arises: false, reason: "repo", files: [] };
  const top = await git(projectPath, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.stdout.trim()) return { arises: false, reason: "in-repo", files: [] };
  try {
    if (!entriesInArea(projectPath, realW).length) return { arises: false, reason: "empty", files: [] };
  } catch (e) {
    console.error(`[relocation] plan: project folder cannot be read: ${e?.message || e}`);
    return undefined;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-plan-"));
  try {
    if ((await git(tmp, ["init", "-q", "."])).code !== 0) return undefined;
    fs.writeFileSync(path.join(tmp, ".git", "info", "exclude"), `${excludeBlock(repos, unreadable)}\n`);
    const r = await git(projectPath, ["--git-dir", path.join(tmp, ".git"), "--work-tree", projectPath, "ls-files", "-z", "--others", "--exclude-standard"]);
    if (r.code !== 0) return undefined;
    const files = String(r.stdout).split("\0").filter(Boolean).map((rel) => {
      const st = lstat(path.join(projectPath, rel));
      return { path: rel, bytes: st ? st.size : null };
    });
    return { arises: true, reason: null, files };
  } catch (e) {
    console.error(`[relocation] plan: project repo cannot be computed: ${e?.message || e}`);
    return undefined;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── nested with a project container (see header "GIT IN B") ────────────────────────────────────────────────────────

// The folders of the OTHER projects with an instance row (converted or mid-relocation): their project container mounts them rw.
function containerFolder(projectId) {
  const out = [];
  const seen = new Set([String(projectId)]);
  for (const z of store.projectInstances()) {
    const pid = String(z.projectId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = store.getProject(pid);
    if (p?.path) out.push({ projectId: pid, name: p.name || "", path: realPath(p.path) });
  }
  return out;
}

// Where git reads for `repo` — determined WITHOUT git (git would already read the configuration): the git directory (`.git`
// as a folder or link, as a file "gitdir: …") and its `commondir`. If the git directory already lies in a container folder,
// nothing more is read in it. → [real paths] · [] (no `.git`) · null (cannot be determined).
function gitLocations(repo, inContainer) {
  const point = path.join(repo, ".git");
  const st = lstat(point);
  if (!st) return [];
  let gitdir = point;
  if (st.isFile()) {
    const m = String(readText(point, [realPath(repo)]) ?? "").match(/^gitdir:[ \t]*(.+?)[ \t]*$/m);
    if (!m) return null;
    gitdir = path.resolve(repo, m[1]);
  }
  const locations = [realPath(gitdir)];
  if (inContainer(locations[0])) return locations;
  const cd = readText(path.join(gitdir, "commondir"), [locations[0]]);
  if (typeof cd === "string" && cd.trim()) locations.push(realPath(path.resolve(gitdir, cd.trim())));
  return locations;
}

// → an entry for `nested` if git must not run for `repo` in B; otherwise null.
function nestedRepo(repo, cFolder) {
  const inContainer = (p) => cFolder.find((c) => under(p, c.path)) || null;
  const name = (situation, c) => ({ situation, projectId: c?.projectId ?? null, name: c?.name ?? "", path: c?.path ?? null, repo });
  const c = inContainer(realPath(repo));
  if (c) return name("repo-in-project-container", c);
  const locations = gitLocations(repo, inContainer);
  // Without a project with a project container, a git directory whose place is unknown (`.git` as a file without
  // `gitdir:`) can lie in none — no hold reason; git then stumbles over the broken `.git` itself.
  if (locations === null) return cFolder.length ? name("git-directory-unknown", null) : null;
  for (const o of locations) { const c2 = inContainer(o); if (c2) return name("git-directory-in-project-container", c2); }
  return null;
}

async function collectGit(git, projectPath, root, { env, cFolder = [] }) {
  const out = {};
  const nested = [];
  const may = (repo) => { const v = nestedRepo(repo, cFolder); if (v) nested.push(v); return !v; };
  const hold = () => { out.nested = nested; return out; }; // no more git — the fields are missing, the plan holds
  let search = null;
  try { search = await searchProject(projectPath); } catch (e) {
    console.error(`[relocation] plan: search for repos under ${projectPath} aborted: ${e?.message || e}`);
  }
  const own = Boolean(lstat(path.join(projectPath, ".git")));
  if (own && !may(projectPath)) return hold();
  const top = await git(projectPath, ["rev-parse", "--show-toplevel"]);
  const upper = !own && top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
  if (upper && !may(upper)) return hold();
  if (!search) return out; // without a complete search worktrees/repos/tracked are missing — the plan holds
  for (const r of search.repos) may(path.join(projectPath, r));
  if (nested.length) return hold();
  const embedded = search.repos.map((r) => path.join(projectPath, r));
  const allRepos = [...(own ? [projectPath] : []), ...embedded];
  const limit = new Set(findRepos(projectPath).map((r) => path.resolve(r)));
  out.repos = [];
  for (const repo of allRepos) {
    const isRoot = repo === projectPath;
    const inRepo = own && !isRoot;
    out.repos.push(await repoAttributes(git, repo, { root, embedded: inRepo, beyondLimit: !isRoot && !inRepo && !limit.has(path.resolve(repo)) }));
  }
  const wt = await worktreesOf(git, allRepos);
  if (wt) out.worktrees = wt;
  const repoRoots = [...allRepos, ...(upper ? [upper] : [])].map((r) => realPath(r));
  const examples = (env || []).filter((f) => path.basename(f.rel || f.file) === ".env.example").map((f) => f.file);
  const compose = composeFiles(projectPath, [root]);
  const tracked = await trackedFiles(git, [...examples, ...compose].map((d) => realPath(d)), repoRoots);
  if (tracked) {
    out.tracked = examples.filter((d) => tracked.has(realPath(d))).map((d) => path.relative(projectPath, d));
    out.untrackedCompose = compose.filter((d) => !tracked.has(realPath(d))).map((d) => path.relative(projectPath, d));
  }
  const pr = await projectRepoData(git, projectPath, search, [root]);
  if (pr) out.projectRepo = pr;
  return out;
}

// ── store ────────────────────────────────────────────────────────────────────────────────────────────────────────

function textsPath(project, ws) {
  const texts = [];
  for (const s of store.listProjectSkills(project.id)) texts.push({ kind: "skill", id: s.id, title: s.name, text: `${s.description || ""}\n${s.body || ""}` });
  for (const k of store.listProjectContext(project.id, { status: "all" })) texts.push({ kind: "context", id: k.id, title: k.title, text: `${k.summary || ""}\n${k.body || ""}` });
  return texts;
}

// The literal `name:` of the volumes of a Compose file (top-level block `volumes:`, also in flow form `d: { name: x }`) —
// names only; a name with `$` stays as written (the plan calls it "notCheckable").
export function volumeNamesFrom(text) {
  const out = new Set();
  let inside = false;
  for (const z of String(text || "").split(/\r?\n/)) {
    if (/^\S/.test(z) && !z.startsWith("#")) inside = /^volumes\s*:/.test(z);
    if (!inside) continue;
    const withoutComment = z.replace(/\s#.*$/, "");
    // Block form `    name: x` takes the whole value (also `${VAR}`); the flow form `{ name: x }` ends at `,` or `}`.
    const block = withoutComment.match(/^\s+name\s*:\s*["']?([^"'\s]+?)["']?\s*$/);
    if (block) { out.add(block[1]); continue; }
    for (const m of withoutComment.matchAll(/[{,]\s*name\s*:\s*["']?([^"'\s,}]+)/g)) out.add(m[1]);
  }
  return [...out].sort();
}

// The volume names from the Compose files of another project (capped, without following a link); unreadable ⇒ the field
// is missing (unknown, the plan then reports nothing).
function foreignVolumeNames(filePath) {
  try {
    const w = realPath(filePath);
    const names = new Set();
    for (const file of composeFiles(filePath, [w])) {
      let fd = null;
      try {
        fd = openFileWithoutReference(file, [w]);
        if (fs.fstatSync(fd).size > TEXT_CAP) continue;
        for (const n of volumeNamesFrom(fs.readFileSync(fd, "utf8"))) names.add(n);
      } catch { /* unreadable: skipped */ } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
    }
    return [...names].sort();
  } catch { return undefined; }
}

function foreignProjects(project, container, home) {
  const out = [];
  for (const p of store.listAllProjects()) {
    if (p.id === project.id || !p.path || store.converted(p.id)) continue;
    const w = realPath(p.path);
    const ports = new Set(store.listProjectServices(p.id).map((s) => Number(s.port)).filter((n) => Number.isInteger(n) && n > 0));
    for (const c of container) {
      const wd = labelsOf(c)[LABEL.folder];
      if (wd && under(realPath(wd), w)) for (const n of hostPortsOf(c)) ports.add(n);
    }
    let env = [];
    try { env = readEnvFiles(p.path, { home }); } catch { env = []; }
    const volumeNames = foreignVolumeNames(p.path);
    out.push({ projectId: p.id, name: p.name, ports: sorted([...ports]), env, ...(volumeNames ? { volumeNames } : {}) });
  }
  return out;
}

function localData(home) {
  const source = path.join(home, ".local");
  const out = [];
  for (const kind of ["state", "share"]) {
    let names = [];
    try { names = fs.readdirSync(path.join(source, kind)).sort(); } catch { continue; }
    for (const name of names) {
      if (kind === "share" && SHARED_IN_SHARE.has(name)) continue;
      out.push({ rel: `${kind}/${name}`, bytes: treeSize(path.join(source, kind, name)) });
    }
  }
  return out;
}

// ── the collection ───────────────────────────────────────────────────────────────────────────────────────────────

/** The `data` for planRelocation (shape: header of plan.js). */
export async function collectRelocationData({ projectId, docker = dockerSeam, git = gitStandard, home = os.homedir() } = {}) {
  const project = store.getProject(projectId);
  if (!project) throw new CollectError(`project ${projectId} does not exist`, { code: "NO_PROJECT", status: 404 });
  if (!project.path) throw new CollectError(`project ${projectId} has no path`, { code: "NO_PROJECT", status: 404 });
  if (store.converted(project.id)) throw new CollectError(`project ${projectId} has already been relocated — its containers run in the project container`, { code: "ALREADY_CONVERTED" });
  const ws = store.getWorkspace(project.workspaceId);
  if (!ws) throw new CollectError(`project ${projectId} has no workspace`, { code: "NO_PROJECT", status: 404 });
  const root = realPath(project.path);
  const realW = [root];

  const data = { project: { id: project.id, name: project.name, path: project.path }, home };
  try {
    const { ctx } = creationContext(project.id, { home });
    data.mounts = mountRules(ctx);
  } catch (e) {
    console.error(`[relocation] plan: mounts cannot be computed: ${e?.message || e}`); // missing ⇒ hold reason
  }
  data.projectNetwork = store.projectInstance(project.id, "main")?.subnet || null;

  const d = await collectDocker(docker);
  Object.assign(data, d);
  const set = relocationSet(d.container, d.images, root);
  data.diffs = await collectDiffs(docker, set);
  data.composeTexts = composeTexts(set, realW);

  // The names under which the own stack reaches itself (env-key.js: host class "stack").
  const localNames = new Set();
  for (const c of set) {
    const l = labelsOf(c);
    if (l[LABEL.service]) localNames.add(String(l[LABEL.service]).toLowerCase());
    const name = String(c?.Name || "").replace(/^\//, "");
    if (name) localNames.add(name.toLowerCase());
    for (const n of Object.values(c?.NetworkSettings?.Networks || {})) for (const a of n?.Aliases || []) localNames.add(String(a).toLowerCase());
  }
  if (Array.isArray(data.mounts)) {
    try { data.env = readEnvFiles(project.path, { mounts: data.mounts, home, localNames }); } catch (e) {
      console.error(`[relocation] plan: .env* not readable: ${e?.message || e}`); // missing ⇒ hold reason
    }
  }

  // If the project folder is nested with the folder of a project with an instance row, no git runs in it in B.
  const cFolder = containerFolder(project.id);
  const nest = cFolder.filter((c) => under(root, c.path) || under(c.path, root))
    .map((c) => ({ situation: under(root, c.path) ? "in-project-container" : "project-container-darin", projectId: c.projectId, name: c.name, path: c.path }));
  if (nest.length) data.nested = nest;
  else Object.assign(data, await collectGit(git, project.path, root, { env: data.env, cFolder }));
  // Step 13 moves FROM the flat root INTO the one of the runtime folder — only the first is a source.
  data.worktreeRoots = [worktreeRoot(locationFor({}))];
  data.worktreeTarget = worktreeRoot(locationFor({ projectId: project.id, converted: true }));

  // The NAMES of the environment of B (never a value) — the plan names a Compose variable that only B sets (PORT=7718).
  data.bEnvironmentNames = Object.keys(process.env).sort();
  data.mcpServer = store.effectiveMcpServers(ws.id, project.id).map((s) => ({ name: s.name, transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url }));
  data.services = store.listProjectServices(project.id).map((s) => ({
    id: s.id, name: s.name, port: s.port ?? null, dir: s.dir || "", startCommand: s.startCommand || "",
    savedCommand: store.savedStartCommand(project.id, s.name), container: s.container || "",
  }));
  data.startScripts = startScripts(project.path, data.services, realW);
  data.local = localData(home);
  data.localReferences = {};
  // Never in a folder a project container writes to (see header) — those projects are listed in localReferencesOpen.
  const withContainer = new Set(store.projectInstances().map((z) => String(z.projectId)));
  const open = [];
  for (const p of store.listAllProjects()) {
    if (!p.path) continue;
    const w = realPath(p.path);
    if (withContainer.has(String(p.id)) || cFolder.some((c) => under(w, c.path) || under(c.path, w))) { open.push(p.id); continue; }
    data.localReferences[p.id] = localReferences(p.path, { home });
  }
  if (open.length) data.localReferencesOpen = open;
  data.foreign = foreignProjects(project, d.container, home);
  data.texts = textsPath(project, ws);
  data.nativeUnclear = await unclearNativeRuns(project.id);
  // Who works in B in the project folder without step 4 ending them? Exempt are only the groups of the recorded native
  // runs — the relocation ends those itself — and those of the language servers of the project in B: the lock ends them
  // (../idle.js) before step 4 searches. Also whoever works in a worktree step 13 moves (the same list as the plan); a
  // descendant of an exempt group carries `descendant` (the plan only names it).
  const additional = toMovingWorktrees(data, root).map((w) => w.path);
  const processes = await remainingProcesses({ projectPath: project.path, additional, exempt: [...nativeRuns(project.id).map((l) => l.pid), ...languageServiceGroups(project.id)] });
  if (processes === null) console.error("[relocation] plan: the processes of B are not readable (/proc) — unknown, the plan holds");
  else {
    const terminals = lockTerminalSessions(project.id);
    data.processes = processes.map((p) => ({ pid: p.pid, start: p.start, program: p.program, ...(terminals.has(p.sid) ? { terminal: terminals.get(p.sid) } : {}), ...(p.descendant ? { descendant: true } : {}) }));
  }
  // Do versions of the files step 13 copies already lie in the runtime folder (leftover of an earlier relocation)? The
  // same list as step 13 (./data.js runtimeSources); only field and count.
  try {
    const q = runtimeSources(project.id);
    const byKey = new Map();
    for (const x of [...q.chat, ...q.project]) if (lstat(x.to)) byKey.set(x.field, (byKey.get(x.field) || 0) + 1);
    data.runtimePrefilled = [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([field, count]) => ({ field, count }));
  } catch (e) {
    console.error(`[relocation] plan: prefilled targets in the runtime folder cannot be checked: ${e?.message || e}`); // missing ⇒ incomplete
  }
  return data;
}

/** Collect and plan. `exists` is the seam of B for MCP paths (see plan.js). → { plan, data } */
export async function planFor(projectId, opts = {}) {
  const data = await collectRelocationData({ projectId, ...opts });
  const exists = opts.exists || ((p) => { try { fs.lstatSync(p); return true; } catch (e) { return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : null; } });
  return { plan: planRelocation(data, { exists }), data };
}
