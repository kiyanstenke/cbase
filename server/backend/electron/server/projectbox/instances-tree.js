// The tree of a project's instances: GET /api/projects/:pid/instances[?open=main,copy-k1]. A sub-slice of the owner
// `projectRoutes` (projects/routes.js); ctx carries `pid`, `sub`, `proj`.
//
//   → 200 `{ loaded: true, ops: true, asOf, instances: [Instance] }` — main first, then the living copies in creation order
//     (store.liveStackCopies: `requested_at`, id), including a WAITING copy that has no instance row yet.
//   Instance = { name, identifier, state, phase, error, waiting, cpu, memBytes, createdOf, base, container, repos, services, chats,
//                action, progress }
//     name        "main" | "copy-<name>"                       identifier  `<pid>/<name>`
//     state       main: the state of the instance row. A copy: as long as its row in stack_copies is not `ready`, ITS state
//                 (waiting_queue, waiting_storage, build, tear_down, error) with `phase`; afterwards the state of its instance row
//                 (ready, start, stopped, error …). `error` is the text next to it ("" without).
//     waiting     `{ reason: "queue" | "storage", since }` for a waiting copy (`since` = its last state change) AND for a start that
//                 waits for storage (row `stopped` with phase `waiting_storage`, main as well as copy), else null
//     cpu, memBytes  same source as /api/project-resources (services.js projectResources: ONE `docker stats` over the project
//                 containers, shared 4 s snapshot, NO `docker exec`) — null when not measured (cap, docker down, instance not in the
//                 measurement). Never 0 for "unknown".
//     createdOf   `{ chatId, title }` of the creating chat (copy via the tool; `title` null if the chat is gone), else null
//     base        the base instance of a copy (`baseInstance`), null in main
//     container   `{ loaded, open, error, asOf, list: [{ name, service, running, status }] }` — the inner containers (`docker ps -a`;
//                 `asOf` = when read, see "SUMMARY")
//     repos       `{ loaded, open, error, asOf, list: [{ rel, branch, detached, open, error? }] }` — per code repo the branch and the
//                 NUMBER of open files (same repo row as GET …/instances/:instance/repos — `open` is `openCount` there)
//     services    `[{ id, name, port, running, holdsStart, startable, link }]` — the project's registered services in THIS instance:
//                 `running`/`holdsStart` as in /api/project-services per instance (services.js serviceRunning/startHeld), asked only in
//                 a ready instance (else false); `startable` is false in EVERY instance without a start command, main included: the
//                 tree offers only the simple start (`mode: simple`) and the start route answers 400 without `startCommand`; the
//                 client then shows "enter start command" (in main the agent start works there too, in a copy not);
//                 `link` is the active preview link of exactly this (instance, service) `{ id, url, procedure, state }` or null
//     chats       `[{ id, title, running }]` — the project's chats with this instance (store.chatsInInstance, archived ones too),
//                 `running` = their turn runs (runs/state.js running)
//     progress    the progress of a copy that waits or is being created (projectbox/copy-progress.js `copyProgress`: step of six,
//                 stage of the start, share and remaining time estimated from the project's last finished copy), else null
//     action      the LAST human action on this instance in this process (projectbox/instance-action-status.js)
//                 `{ kind, running, since, end, ok, error, stacks }` — the running stack restart and its result, a failed branch switch;
//                 null without an action or when it began BEFORE this instance row was created (a torn-down copy created again
//                 under the same name does not inherit the state)
//
// ONE EXEC PER INSTANCE: a `docker exec` costs ≈ 53 ms wall and ≈ 85 ms CPU in B, `git status` inside 2–4 ms. A 5 s tick over all
// instances would be ≈ 35 % of a CPU permanently at 15 instances. So the tree reads containers and repos FRESH only for the instances
// named in `?open` (comma separated, unknown names drop silently); every other ready instance comes from the summary cache (see
// "SUMMARY"). Per instance ONE `docker exec`: `sh -c` with `docker ps -a --format PS_TEMPLATE` (never `{{json .}}` — it fetched the
// sizes), for main the question "does the project folder lie in a repo?" (git.js projectReposWithRoot), then REPOS_SCRIPT from
// instance-actions.js over all repos — with `GIT_OPTIONAL_LOCKS=0` so reading foreign repos takes no `index.lock`. An instance that is
// not `ready` (stopped, being built …) is never asked (no exec into a standing container): not named it carries
// `{ loaded: false, open: false }` (never an empty list), named `{ loaded: false, open: true, error }`. Two simultaneous queries of
// the same instance share the call (web and iOS).
//
// PARTIAL SOURCES: each has its own cap and its `loaded`/`error`; a failing one never tears down the tree. The exec carries
// TREE_CAP_MS (knob CBASE_INSTANCE_TREE_MS), the resource measurement RESOURCES_CAP_MS (CBASE_INSTANCE_TREE_RES_MS; afterwards null,
// the measurement keeps running and fills the shared snapshot). If the exec fails entirely (container down, cap), containers AND repos
// carry the error; if only `docker ps` fails, only containers; a copy without a readable snapshot only repos. If the store cannot be
// read the answer is 500 — then there is no tree, only an error.
//
// SHARED with the instance actions: without projectboxOps() 404 "only in server operation" before anything is read; a project not yet
// moved gets 409 NOT_CONVERTED (`{ error, code }`). Not reachable from project networks (fence row "project-instances",
// projectbox/fence-table.js): the "Instances" tab (web and iOS) reads the tree, agents have cbase_copy_stack_list.
//
// SUMMARY: the row of EVERY instance names stack x/y and branch without opening it. So containers and repos of every READY instance are
// in every tree — a named one (the tab's selected one) always read fresh, every other from the cache `read` (per identifier, at most
// SUMMARY_MS old, knob CBASE_INSTANCE_SUMMARY_MS). An entry is valid only for the same state (`marker`): the same instance row
// (`createdAt` — a copy created again under the same name inherits nothing) in the same state (`updatedAt` — every state and phase
// change stamps it) with the same last action (branch switch, discard, stack restart: `since`, `end`, `running`). `?fresh=1` reads
// every ready instance anew — the client sends it after its own action and after the events `project/instance`/`project/copy`. Every
// part read carries `asOf` (when read). Cost (one exec ≈ 85 ms CPU): 5 instances every 30 s ≈ 1.4 % of a CPU, plus the selected one in
// the 5 s tick ≈ 1.7 %. What ends by itself between two reads (a container dies) is at most SUMMARY_MS stale. `open` means "asked"
// (fresh or from the cache) — a ready instance always is; an error stays visible (state "error", never "closed").
//
// Guards: server/backend/test/instances-tree.test.js (fake docker, real server); the sub-slice in
// server/backend/test/dispatcher.test.js, the fence row in server/backend/test/fence.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, send } from "../runtime/http.js";
import { CONTAINER_PAUSED, CONTAINER_STANDS, commandRun } from "../runtime/git-run.js";
import { STATUS_OUTPUT, projectRepos, projectReposWithRoot } from "../git.js";
import { PS_TEMPLATE, containerFromPs, serviceRunning, projectResources, startHeld } from "../services.js";
import { running } from "../runs/state.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";
import { MAIN } from "./creation.js";
import { runInstance } from "./run-instance.js";
import { REPOS_SCRIPT, repoRowsFrom } from "./instance-actions.js";
import { actionStatus } from "./instance-action-status.js";
import { WAITING_STORAGE } from "./instance-stop.js";
import { progressOf } from "./copy-progress.js";

// The cap of the ONE exec per open instance. Estimated: bundled 85 ms (7 repos), single outliers up to 459 ms per git — 15 s is a
// multiple, even for a large status. Knob CBASE_INSTANCE_TREE_MS (integer > 0), read at run time.
export const TREE_CAP_MS = 15_000;
// The cap of the resources: `docker stats --no-stream` takes two samples (≈ 2 s, services.js instanceStatsAll). Knob
// CBASE_INSTANCE_TREE_RES_MS. After it cpu/memBytes are null.
export const RESOURCES_CAP_MS = 4_000;
// How old the summary of a non-selected instance may be at most (header, "SUMMARY"). Knob CBASE_INSTANCE_SUMMARY_MS.
export const SUMMARY_MS = 30_000;
const slider = (name, preset) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : preset;
};

const error = (status, code, text) => Object.assign(new Error(text), { status, code });

/** `?open=main,copy-k1` → the set of named names (empty without). Unknown names do no harm — only what is in the tree is asked. */
export function openFromQuery(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim()).filter(Boolean));
}

// ── The one exec per open instance ───────────────────────────────────────────────────────────────────────────────────────

// $1 template, $2 project folder (main only, else ""), $3 marker, then the repos. After `shift 2` REPOS_SCRIPT starts with
// `m=$1; shift` (the marker) — the same script as GET …/repos, unchanged. stderr of `docker ps` belongs to its part (the error
// text); git's stderr is dropped in REPOS_SCRIPT.
export const TREE_SCRIPT = [
  "v=$1; p=$2; m=$3; shift 2",
  "docker ps -a --format \"$v\" 2>&1; printf '\\n%s ps %s\\n' \"$m\" \"$?\"",
  "if [ -n \"$p\" ]; then (cd \"$p\" && exec git rev-parse --show-toplevel) 2>/dev/null; printf '\\n%s root %s\\n' \"$m\" \"$?\"; fi",
  REPOS_SCRIPT,
].join("\n");

const short = (s) => { const t = String(s || "").trim(); return t.length > 2000 ? `…${t.slice(-2000)}` : t; };
const unloaded = (open, text) => ({ loaded: false, open, error: text });

// `docker ps` → the container rows (containerFromPs reads name, service, running; the status text is only in the raw line).
function containerRows(text) {
  const status = new Map();
  for (const row of String(text || "").split("\n")) {
    let z;
    try { z = JSON.parse(row); } catch { continue; }
    const name = String(z?.Names || "").split(",")[0].trim();
    if (name) status.set(name, String(z.Status || ""));
  }
  return containerFromPs(text).map((c) => ({ name: c.name, service: c.service || "", running: c.running, status: status.get(c.name) || c.state || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The tree's repo row from the one of instance-actions.js (there `openCount` is the number of open files).
const repoInTree = (z) => ({ rel: z.rel, branch: z.branch, detached: z.detached, open: z.openCount, ...(z.error ? { error: z.error } : {}) });

// The repo candidates BEFORE the exec: a copy from its snapshot (without git), main the search under the folder
// (projectReposWithRoot without root — the script asks the root question). → `{ upfront, rootQuestion, error }`
async function repoCandidates(proj, inst) {
  if (!proj.path || !fs.existsSync(proj.path)) return { upfront: [], rootQuestion: false, error: "" };
  if ((inst.instance || MAIN) !== MAIN) {
    try { return { upfront: await projectRepos(proj.path, { instance: inst }), rootQuestion: false, error: "" }; }
    catch (e) { return { upfront: [], rootQuestion: false, error: String(e?.message || e) }; }
  }
  try { return { upfront: projectReposWithRoot(proj.path, null, { instance: inst }), rootQuestion: true, error: "" }; }
  catch (e) { return { upfront: [], rootQuestion: false, error: String(e?.message || e) }; }
}

async function details(proj, inst) {
  const k = await repoCandidates(proj, inst);
  // With the root question the project folder itself is the first candidate: if it lies in a code repo (not the project repo),
  // that one is the result (projectRepos), and its row comes from the folder.
  const candidates = k.rootQuestion ? [{ name: "", relPath: "", root: proj.path }, ...k.upfront] : k.upfront;
  const marker = `cbase-${crypto.randomBytes(8).toString("hex")}`;
  const r = await commandRun(inst, "/", "sh", ["-c", TREE_SCRIPT, "sh", PS_TEMPLATE, k.rootQuestion ? proj.path : "", marker, ...candidates.map((x) => x.root)], {
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    envAlways: ["GIT_OPTIONAL_LOCKS"], // even if B carries it itself (in-project.js: else it would not go along)
    timeout: slider("CBASE_INSTANCE_TREE_MS", TREE_CAP_MS),
    // As GET …/repos: one MiB per repo, ONCE the room for a large status; plus 2 MiB for `docker ps`.
    maxBuffer: STATUS_OUTPUT + 1024 * 1024 * (candidates.length + 2),
  });
  const out = String(r.stdout || "");
  const psMarker = new RegExp(`\\n${marker} ps (\\d+)\\n`).exec(out);
  if (!psMarker) {
    // The call itself failed (container down, exec broken, cap before the first part): both sources carry the reason.
    const text = short(r.stderr) || T`Reading in the project container: exit ${r.code ?? "?"}`;
    const set = CONTAINER_STANDS.test(text) || CONTAINER_PAUSED.test(text) ? T`The project container is not running: ${text}` : text;
    return { container: unloaded(true, set), repos: unloaded(true, set) };
  }
  const psText = out.slice(0, psMarker.index);
  const container = Number(psMarker[1]) === 0
    ? { loaded: true, open: true, error: "", list: containerRows(psText) }
    : unloaded(true, short(psText) || T`docker ps in the instance: exit ${psMarker[1]}`);
  let rest = out.slice(psMarker.index + psMarker[0].length);
  let root = null;
  if (k.rootQuestion) {
    const w = new RegExp(`\\n${marker} root (\\d+)\\n`).exec(rest);
    if (w) {
      if (Number(w[1]) === 0) root = rest.slice(0, w.index).trim() || null;
      rest = rest.slice(w.index + w[0].length);
    }
  }
  // Repos: only a complete run counts (cap or abort in the middle of the loop ⇒ not loaded, never a half list).
  if (r.code !== 0) return { container, repos: unloaded(true, short(r.stderr) || T`Reading the repositories: exit ${r.code ?? "?"}`) };
  if (k.error) return { container, repos: unloaded(true, k.error) };
  const rows = repoRowsFrom(rest, marker, candidates);
  let list;
  if (k.rootQuestion) {
    const permanently = projectReposWithRoot(proj.path, root, { instance: inst });
    const perRoot = new Map(k.upfront.map((x, i) => [x.root, rows[i + 1]]));
    list = permanently.map((x) => {
      const z = perRoot.get(x.root) || (x.root === root ? rows[0] : null);
      return z ? repoInTree({ ...z, rel: x.relPath || "" }) : { rel: x.relPath || "", branch: "", detached: false, open: null, error: T("not read") };
    });
  } else list = rows.map(repoInTree);
  return { container, repos: { loaded: true, open: true, error: "", list } };
}

// Two simultaneous queries of the same instance share the exec (identifier → promise, only while it runs).
const inFlight = new Map();
function detailsShared(proj, inst) {
  const k = String(inst.identifier || `${inst.projectId}/${inst.instance}`);
  const existing = inFlight.get(k);
  if (existing) return existing;
  const z = details(proj, inst).catch((e) => {
    const text = String(e?.message || e);
    return { container: unloaded(true, text), repos: unloaded(true, text) };
  }).finally(() => { if (inFlight.get(k) === z) inFlight.delete(k); });
  inFlight.set(k, z);
  return z;
}

// The summary cache (header, "SUMMARY"): identifier → { time, marker, parts }.
const read = new Map();

// The state a cached entry is valid for — the same instance row in the same state with the same last action.
function marker(pid, name) {
  const z = store.projectInstance(pid, name);
  const a = actionStatus(pid, name);
  return [z?.createdAt ?? "", z?.updatedAt ?? "", a?.since ?? "", a?.end ?? "", a?.running ? 1 : 0].join(":");
}

async function readOrNew(proj, inst, name, fresh) {
  const k = `${proj.id}/${name}`;
  const m = marker(String(proj.id), name);
  const old = read.get(k);
  if (!fresh && old && old.marker === m && Date.now() - old.time < slider("CBASE_INSTANCE_SUMMARY_MS", SUMMARY_MS)) return old.parts;
  const time = Date.now();
  const t = await detailsShared(proj, inst);
  const parts = { container: { ...t.container, asOf: time }, repos: { ...t.repos, asOf: time } };
  read.set(k, { time, marker: m, parts });
  return parts;
}

// ── The other partial sources ────────────────────────────────────────────────────────────────────────────────────────────

// cpu/memBytes per identifier from projectResources (header) — a Map, empty on cap or error.
async function resources(proj) {
  const measurement = projectResources([{ id: proj.id, name: proj.name, path: proj.path, services: [] }], { includeDisk: false })
    .then((out) => {
      const z = Array.isArray(out) ? out[0] : null;
      const m = new Map();
      if (!z) return m;
      const count = (x) => (x?.dockerUp ? { cpu: Number(x.cpu) || 0, memBytes: Number(x.memBytes) || 0 } : null);
      if (Array.isArray(z.instances)) for (const i of z.instances) m.set(String(i.identifier), count(i));
      else m.set(`${proj.id}/${MAIN}`, count(z));
      return m;
    }, () => new Map());
  let tick = null;
  const cap = new Promise((resolve) => { tick = setTimeout(() => resolve(new Map()), slider("CBASE_INSTANCE_TREE_RES_MS", RESOURCES_CAP_MS)); tick.unref?.(); });
  try { return await Promise.race([measurement, cap]); } finally { clearTimeout(tick); }
}

const question = (fn) => Promise.resolve().then(fn).then(Boolean, () => false);

async function servicesThe(pid, name, ready, services, links) {
  return Promise.all(services.map(async (s) => {
    const opts = name === MAIN ? {} : { instance: name };
    const isRunning = ready ? await question(() => serviceRunning(pid, s, opts)) : false;
    const holdsStart = ready && !isRunning ? await question(() => startHeld(pid, s, opts)) : false;
    const l = links.find((x) => x.instance === name && Number(x.serviceId) === Number(s.id)) || null;
    return {
      id: s.id, name: s.name, port: s.port ?? null, running: isRunning, holdsStart,
      // Main too only WITH a start command: otherwise the tree's "Start" button (simple start) would end in the start route's 400
      // "no start command stored" (projects/routes.js).
      startable: Boolean(String(s.startCommand || "").trim()),
      link: l ? { id: l.id, url: l.url || "", procedure: l.runningSinceAt ?? null, state: l.state } : null,
    };
  }));
}

function chatsOf(pid, name) {
  return store.chatsInInstance(pid, name).map((id) => {
    let title = "";
    try { title = String(store.getChat(id)?.title || ""); } catch { title = ""; }
    return { id, title, running: running.has(id) };
  });
}

// A start that waits for storage: the row stays `stopped` with phase `waiting_storage` — the tree shows it like the wait of a copy
// being created, `since` = the request (`updatedAt` of the row; the phase stamps only it).
const startWaiting = (z) => (z?.state === "stopped" && z.phase === WAITING_STORAGE ? { reason: "storage", since: z.updatedAt ?? null } : null);

// The tree's rows without partial sources: main, then the living copies (header "state").
function instanceRows(pid) {
  const main = store.projectInstance(pid, MAIN);
  const rows = [{
    name: MAIN, state: main?.state || "", phase: main?.phase || "", error: main?.error || "", waiting: startWaiting(main),
    createdOf: null, base: null, progress: null,
  }];
  for (const k of store.liveStackCopies(pid)) {
    const name = `copy-${k.name}`;
    const z = store.projectInstance(pid, name);
    const fromRow = k.state === "ready" && z;
    const chat = k.chatId ? store.getChat(k.chatId) : null;
    rows.push({
      name,
      state: fromRow ? z.state : k.state,
      phase: (fromRow ? z.phase : k.phase) || "",
      error: k.error || (z?.error ?? "") || "",
      waiting: k.state === "waiting_queue" ? { reason: "queue", since: k.updatedAt }
        : k.state === "waiting_storage" ? { reason: "storage", since: k.updatedAt } : (fromRow ? startWaiting(z) : null),
      createdOf: k.chatId ? { chatId: k.chatId, title: chat ? chat.title : null } : null,
      base: k.baseInstance || MAIN,
      progress: fromRow ? null : progressOf(k),
    });
  }
  return rows;
}

// The last action of this instance (header, `action`): only if it began after the instance row was created (without a row — a
// waiting copy — there is no action).
function actionThe(pid, name) {
  const a = actionStatus(pid, name);
  if (!a) return null;
  const z = store.projectInstance(pid, name);
  return z && Number.isFinite(z.createdAt) && a.since >= z.createdAt ? a : null;
}

/** The tree (header). `open` = the instances to read fresh, `fresh` = all ready ones fresh (header, "SUMMARY"). Throws
 *  409 NOT_CONVERTED; a read error of the store goes out as 500. */
export async function instancesTree(proj, { open = new Set(), fresh = false } = {}) {
  const pid = String(proj.id);
  if (!store.converted(pid)) {
    throw error(409, "NOT_CONVERTED", T`Project ${pid} has not been moved — it has no instances.`);
  }
  const rows = instanceRows(pid);
  const services = store.listProjectServices(pid);
  const links = store.previewLinksActive().filter((l) => String(l.projectId) === pid);
  const res = resources(proj);
  const instances = await Promise.all(rows.map(async (z) => {
    const ready = z.state === "ready";
    const opened = open.has(z.name);
    let parts;
    // A non-ready instance is never asked (no exec into a standing container); when named it carries the reason.
    if (!ready && !opened) parts = { container: { loaded: false, open: false }, repos: { loaded: false, open: false } };
    else if (!ready) {
      const set = T`Instance ${z.name} is not ready (${z.state || T("no state")}) — nothing queried.`;
      parts = { container: unloaded(true, set), repos: unloaded(true, set) };
    } else {
      const inst = runInstance(pid, z.name);
      parts = inst ? await readOrNew(proj, inst, z.name, fresh || opened) : (() => {
        const set = T`No instance row for ${z.name}.`;
        return { container: unloaded(true, set), repos: unloaded(true, set) };
      })();
    }
    const [servicesList, counts] = await Promise.all([servicesThe(pid, z.name, ready, services, links), res]);
    const count = counts.get(`${pid}/${z.name}`) || null;
    return {
      name: z.name, identifier: `${pid}/${z.name}`, state: z.state, phase: z.phase, error: z.error, waiting: z.waiting,
      cpu: count ? count.cpu : null, memBytes: count ? count.memBytes : null, createdOf: z.createdOf, base: z.base,
      container: parts.container, repos: parts.repos, services: servicesList, chats: chatsOf(pid, z.name),
      action: actionThe(pid, z.name), progress: z.progress,
    };
  }));
  // Entries of torn-down copies drop (the cache grows only with the living instances).
  const names = new Set(rows.map((z) => z.name));
  for (const k of read.keys()) if (k.startsWith(`${pid}/`) && !names.has(k.slice(pid.length + 1))) read.delete(k);
  return { loaded: true, ops: true, asOf: Date.now(), instances };
}

// ── The sub-slice ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function instancesTreeProjectRoutes(ctx) {
  const { res, url, m, sub, proj } = ctx;
  if (sub === "/instances" && m === "GET") {
    if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
    try {
      return send(res, 200, await instancesTree(proj, {
        open: openFromQuery(url?.searchParams?.get("open")),
        fresh: url?.searchParams?.get("fresh") === "1",
      }));
    } catch (e) {
      const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status === 500) console.error(`[instances] tree ${proj?.id}:`, e?.message || e);
      const text = String(e?.message || e);
      return send(res, status, { error: text, ...(e?.code ? { code: String(e.code) } : {}) });
    }
  }
  return NEXT;
}
