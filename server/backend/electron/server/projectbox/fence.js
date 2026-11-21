// The API fence. It stands in the dispatcher BEFORE everything else (server.js, also before the static files and /api/health)
// and in both upgrade paths that bypass the dispatcher (tunnel.js, browsers.js attachBrowserDevtools). It acts ONLY with the
// ops marker (server.js asks `projectboxOps()` synchronously before calling it: without the marker there is no extra await).
//
// THE VERDICT (`fenceVerdict`, pure)
//   - valid token ⇒ scope of its instance, whatever the source; BUT from a project network (`10.230.0.0/16`) only the token of
//     the instance of the source /24 counts; a token of another instance from this network ⇒ 401 (the token complements the
//     source, it does not replace it);
//   - source in `10.230.0.0/16` without a valid token ⇒ 401;
//   - otherwise "as today" (the gateway, the UI, every run in B, /api/runs/active from outside).
//   "Valid" means: the token belongs to an identifier (projectbox/token.js, in memory of this backend start only), and there is
//   an instance for that identifier NOW, the same one runs/instance.js `instanceFromIdentifier` knows (ops marker AND converted
//   project). If the instance row goes, its token no longer counts.
//   Within the scope the fence table (fence-table.js) decides: first matching row; none ⇒ 403; "rejected" ⇒ 403 with a reason.
//
// THE CHECK IN THE SCOPE (`checkScope`, pure over a `view` — the read paths of the data layer)
//   PARAMETER  per name of a path parameter (and per query parameter of the row) a check against project P and workspace W
//              of the instance. Unknown chats, services, channels … are 403, not 404: the fence does not reveal what exists.
//   BODY       per name a check of the request body; the fence reads it BEFORE the route and passes it on unchanged (a
//              substitute `req` in ctx.req, `substituteRequest`).
//   enforce    sets the query parameters of the row to the value of the instance; a different value ⇒ 403.
//   ONLY FROM MAIN: a row with `onlyFromMain` (the request of a copy) is 409 with the token of a COPY; `checkScope` then
//              returns `{ ok: false, status: 409, reason }` (otherwise without `status`, the fence sends 403).
//   INSTANCE:  from a project network the token decides the instance, never a given chat. `chatInstance` (PARAMETER) also asks
//              whether a chat lies in THE instance of the token; `ctx.fence` carries identifier and instance to the routes that
//              write into or read from an instance (devtools/routes.js, channels/routes.js): they take them instead of the chat.
//              `:chat` IS this check: every row with `:chat` (turn, subagent, monitor, wakeup, workflow, capture, question,
//              approval …) demands a chat of the project AND of the instance of the token. A project-only check let a copy token
//              start a monitor in the main container via the main's chat (and vice versa). At the project level only pure read
//              rows with a reason remain (`:chatInProject`, `readInProject` of the row).
//
// THE FILTER (`FILTER`, pure): "filtered" means the route answers as today and the 2xx response goes through the filter of the
//   row — the same SHAPE (an array stays an array, `mcp/lib.js` expects it), plus the header `x-cbase-fenced: 1` (`mcp/lib.js`
//   api notes it per tool call, `mcp/cbase-mcp.js` then appends the second text block). A 2xx response that cannot be filtered
//   does NOT go out (403): unfiltered it would be a leak.
//
// THE SOURCE is `req.socket.remoteAddress` (without `::ffff:`). It is reliably the IP of the project container, also for its
// inner containers and after the OUTPUT DNAT. `setFenceSource(fn)` is the test seam (the test server listens only on
// 127.0.0.1); server.js never sets it.
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import * as store from "../store.js";
import { getBrowser } from "../browsers.js";
import { instanceFromIdentifier, instanceForChat, instanceIdentifierOf, instanceNameFromIdentifier, turnIdentifier } from "../runs/instance.js";
import { chatAliveInInstance } from "../runs/agents.js";
import { running } from "../runs/state.js";
import { send } from "../runtime/http.js";
import { LEVEL2_AREA, cidrRange } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { identifierForToken } from "./token.js";
import { FREE_PARAMETER, FENCE_TABLE, parameterOf, rowFor } from "./fence-table.js";
import { readAddress } from "../communication/address.js";

export const TOKEN_HEADER = "x-cbase-token";
export const FENCED_HEADER = "x-cbase-fenced";
const BODY_MAX = 5_000_000; // wie runtime/http.js BODY_MAX

// ── Addresses ──────────────────────────────────────────────────────────────────────────────────────────────────────

const bare = (ip) => String(ip || "").replace(/^::ffff:/i, "");
function ipCount(ip) {
  const m = bare(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
}
/** Is `ip` in `cidr`? IPv6 (except `::ffff:` IPv4) and anything unreadable: no. */
export function inNetwork(ip, cidr) {
  const n = ipCount(ip);
  const b = cidr ? cidrRange(cidr) : null;
  return n !== null && b !== null && n >= b.start && n <= b.end;
}

// ── The verdict ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The verdict on a request. `instances` are the instances that count NOW (the glue passes the one that belongs to the token —
 * runs/instance.js); `identifierOfToken` is the token table (projectbox/token.js).
 * → `{ verdict: "as-today" }` · `{ verdict: "401", reason }` · `{ verdict: "403", reason, instance, row? }` ·
 *   `{ verdict: "scope", instance, row, params }`
 */
export function fenceVerdict({ source, token, method, path: filePath, instances = [], table = FENCE_TABLE, identifierOfToken = identifierForToken, area = LEVEL2_AREA }) {
  const fromProjectNetwork = inNetwork(source, area);
  const identifier = token ? identifierOfToken(String(token)) : null;
  const instance = identifier ? (instances || []).find((i) => i && (i.identifier || `${i.projectId}/${i.instance || "main"}`) === identifier) || null : null;
  if (!instance) {
    if (!fromProjectNetwork) return { verdict: "as-today" };
    return { verdict: "401", reason: token ? "Fence: the token is not valid (unknown, from an earlier backend start, or the instance no longer exists)" : "Fence: from a project network only with the instance's token (x-cbase-token)" };
  }
  if (fromProjectNetwork && !inNetwork(source, instance.subnet)) {
    return { verdict: "401", reason: `Fence: the token belongs to instance ${instance.identifier || instance.projectId}, the request comes from another project network` };
  }
  const hits = rowFor(method, filePath, table);
  if (!hits) return { verdict: "403", instance, reason: `Fence: ${String(method).toUpperCase()} ${String(filePath).split("?")[0]} is not released from a project container (no row in the fence table)` };
  if (hits.row.rule === "rejected") return { verdict: "403", instance, row: hits.row, reason: `Fence (${hits.row.family}): ${hits.row.reason}` };
  return { verdict: "scope", instance, row: hits.row, params: hits.params };
}

// ── The checks in the scope ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is chat `id` one of the project — itself or as the child chat of a graph workflow of a chat of the project?
 * PLUS: a chat from which a LIVE run is pinned in THIS instance — the running turn (runs/instance.js `turnIdentifier`), a live
 * subagent carrying the identifier of this instance in its picture, or the open core of a dynamic workflow on it (runs/agents.js
 * `chatAliveInInstance`). The chat may switch project in the middle of this work; the work keeps running here until its end and
 * must reach its own chat (history, question, completion notice, agent tools), or after the switch it would face a 403. Only
 * THIS chat and only from this instance (`s.K`): no foreign chat, no foreign project. When the work ends, only the project of
 * the chat counts again. A view without `runInInstance` (the test view of the pure checks) does not know the exception.
 */
function chatInScope(s, id) {
  const c = id ? s.chat(String(id)) : null;
  if (!c) return false;
  if (c.projectId && c.projectId === s.P) return true;
  if (s.K && typeof s.runInInstance === "function" && s.runInInstance(c.id, s.K)) return true;
  const start = s.graphStartOfChild(c.id);
  const parent = start?.chatId ? s.chat(start.chatId) : null;
  return Boolean(parent && parent.projectId === s.P);
}

// Each check → `null` (fine) or a reason. `writes` is the method ≠ GET/HEAD.
export const PARAMETER = Object.freeze({
  project: (s, v) => (v === s.P ? null : "a different project than this container's"),
  // The identifier "<projectId>/<instance>" of THIS instance (namespace of the port list, only as query/enforce).
  instance: (s, v) => (v === s.K ? null : "a different instance than this one"),
  workspace: (s, v) => (v === s.W ? null : "a different workspace than the project's"),
  // `:chat` is the check `chatInstance`: project AND instance of the token. Checking only the project let a copy token start a
  // command in the main container via /api/chats/<main chat>/monitor (the monitor runs in the instance of the TURN), a subagent
  // in the main's core via /agent, a prompt in its turn via /wakeup — and the main token the same in the copy.
  chat: (s, v) => PARAMETER.chatInstance(s, v),
  // Only the PROJECT: for pure read rows with a named reason (`readInProject` of the row; the list is held by
  // server/backend/test/fence-instance.test.js (5)) — data of B that the filtered chat list shows anyway, no file, no code, no
  // git of an instance. A method that WRITES checks the instance here too: a wrongly entered row falls to the safe side.
  chatInProject: (s, v, { writes } = {}) => (writes ? PARAMETER.chatInstance(s, v) : chatInScope(s, v) ? null : "not a chat of this project"),
  // The chat lies in the project AND in the instance of this token: the binding of the chat (runs/instance.js instanceForChat:
  // copy, child pin, main) is the identifier of the token, or a LIVE run of the chat sits in it (the pinned turn or a subagent in
  // the main whose chat has since moved). Not determinable (no view for it, source throws, copy locked) is NO — never a
  // fallback to the main instance. The `?chat` of the instance-routed routes (fenceContext chatReason), the channel sender, the
  // agent browser and the copy creation ask it too.
  chatInstance: (s, v) => {
    if (!chatInScope(s, v)) return "not a chat of this project";
    const c = s.chat(String(v));
    if (s.K && typeof s.runInInstance === "function" && s.runInInstance(c.id, s.K)) return null;
    if (typeof s.instanceForChat !== "function") return "the chat's instance cannot be determined";
    let r;
    try { r = s.instanceForChat(c, { projectId: s.P }); } catch { return "the chat's instance cannot be read"; }
    return r && !r.locked && r.identifier && r.identifier === s.K ? null : "a chat of an instance other than this token's";
  },
  service: (s, v) => (s.service(String(v))?.projectId === s.P ? null : "not a service of this project"),
  channel: (s, v) => ((s.channelParticipants(String(v)) || []).some((t) => chatInScope(s, t.chatId)) ? null : "not a channel of a chat of this project"),
  // The browser of THIS instance: the project browser of the main instance is `proj:<id>`, that of a copy `proj:<id>@copy-<name>`
  // (devtools/routes.js /browser/ensure); an agent browser belongs to the chat that lies in this instance (`chatInstance`). And
  // it runs in ITS container: its debug host is the IP of the instance (`s.IP`). A session in B (`proj:<id>` from before the
  // relocation, 127.0.0.1) is never the browser of an instance: through it a project container would read the browser of B
  // with its logins. An instance without an IP has none (empty is not unknown).
  browser: (s, v) => {
    const b = s.browser(String(v));
    if (!b) return "not a browser of this project";
    if (!s.IP || b.debugHost !== s.IP) return "not a browser of this instance (it does not run in its container)";
    const name = instanceNameFromIdentifier(s.K);
    if (b.scopeKey === (name === "main" ? `proj:${s.P}` : `proj:${s.P}@${name}`)) return null;
    return b.kind === "agent" && b.chatId && PARAMETER.chatInstance(s, b.chatId) === null ? null : "not a browser of this instance";
  },
});

function underProject(s, file) {
  const project = s.project(s.P);
  if (!project?.path || !file) return false;
  // In a COPY B reads and writes nothing (the language service is off there): what counts is the wording of the path under the
  // project folder; a realpath in B would see the main instance, and a file only the copy has does not exist there.
  if (instanceNameFromIdentifier(s.K) !== "main") {
    const rel = path.relative(path.resolve(project.path), path.resolve(String(file)));
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  }
  let root, real;
  try { root = fs.realpathSync(project.path); real = fs.realpathSync(path.resolve(String(file))); } catch { return false; }
  const rel = path.relative(root, real);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const HUMAN_NEVER = "from: \"human\" never comes from a project network — a human never passes the fence";

export const BODY = Object.freeze({
  // From a project network the assignment of a chat cannot be changed — whether another project, empty or null
  // (`cbase_chat_set_project` sends `projectId: null` for an empty argument). The same question as the route: `"projectId" in b`.
  withoutProjectSwitch: (s, b) => (b && typeof b === "object" && "projectId" in b ? "only the human changes a chat's project assignment from a project container" : null),
  serviceOfTheProject: (s, b) => (b?.projectId === s.P ? null : "a service is created only in the project of this container"),
  // The drop into the workspace context: explicitly onto the workspace level or into the own project — the automatic
  // assignment would choose among ALL projects of the workspace.
  dropInWithoutForeignProject: (s, b) => (b?.route === "workspace" || (b?.projectId && b.projectId === s.P) ? null : "a drop-in from a project container goes to the workspace level (route: \"workspace\") or into the own project"),
  senderOfTheProject: (s, b, { params }) => {
    if (!chatInScope(s, b?.chatId)) return "the sender is not a chat of this project";
    // And one of THIS instance: a copy token does not speak as a chat of the main instance (the files of the message are resolved
    // by channels/messages.js from the identifier of the token, not from the sender).
    if (PARAMETER.chatInstance(s, b.chatId)) return "the sender is a chat of an instance other than this token's";
    return (s.channelParticipants(String(params.channel)) || []).some((t) => t.chatId === String(b.chatId)) ? null : "the sender is not a participant of this channel";
  },
  // cbase_agent_send: the sender is the chat in the path (already `:chat`, this instance). A `channel:<id>` like "channel-send"
  // (senderOfTheProject): the sender is a participant. A `chat:<id>` is ANY chat across project and instance borders — the route
  // checks workspace and readability (communication/target-chat.js), the fence nothing. An own subagent (no prefix) is checked
  // by the route (communication/target-subagent.js); wf:/graph: likewise. `from: "human"` (the "Message" button) never comes from
  // a project network — a human never comes through the fence. A `wf:<runId>:<n>` is a workflow of the chat in the path (already
  // `:chat`, this instance): the route resolves only its runs.
  agentSendInScope: (s, b, { params }) => {
    if (b?.from === "human") return HUMAN_NEVER;
    const a = readAddress(b?.to || b?.agentId || b?.name);
    if (a.kind === "channel") {
      return (s.channelParticipants(String(a.channelId)) || []).some((t) => t.chatId === String(params.chat)) ? null : "the sender is not a participant of this channel";
    }
    return null;
  },
  // The stop of a subagent: cbase_agent_stop sends `from: "agent"`; `from: "human"` is the UI button and never comes from a project
  // network. ("Stop all" — /agents/stop — has no row at all: 403 from every project network.)
  stopNotFromHuman: (s, b) => (b?.from === "human" ? HUMAN_NEVER : null),
  // The copy is created for a chat of THIS instance — never for a chat of another project or another instance (`chatInstance`:
  // project AND instance of the token). Whether it is a coding chat, whether it already has a copy, whether the project has been
  // relocated is then up to the route (stacks/request.js); the fence holds only the scope.
  copyForChat: (s, b) => {
    // Without a chat only a human creates (UI, B): from a project container it is always the tool of a chat, which then moves
    // in (`inset`).
    if (typeof b?.chatId !== "string" || !b.chatId) return "`chatId` is missing — from a project container only a chat's tool creates (with move-in)";
    const reason = PARAMETER.chatInstance(s, b.chatId);
    return reason ? `the copy is created for a chat of this instance: ${reason}` : null;
  },
  // The agents' language service reads in B and writes files on rename (lsp/boundary.js): `file` only under the project folder,
  // checked after realpath (a symlink out of the project is outside). The FINDINGS of a rename and everything the service reads
  // are limited by the route itself via `ctx.fence`.
  fileInProject: (s, b) => (underProject(s, b?.file) ? null : "only files under the project folder (after realpath)"),
});

/**
 * Checks path parameters, query parameters, enforcements and body of a row. `query` is the URLSearchParams (it is CHANGED for
 * `enforce`). → `{ ok: true }` or `{ ok: false, reason }`.
 */
export function checkScope({ instance, row, params = {}, method = "GET", query = new URLSearchParams(), body = undefined }, view) {
  const P = instance.projectId;
  const project = view.project(P);
  if (!project) return { ok: false, reason: "Fence: the project of this instance no longer exists" };
  const s = { ...view, P, W: project.workspaceId, K: instanceIdentifierOf(instance), IP: instance.ip || null };
  const writes = !["GET", "HEAD"].includes(String(method).toUpperCase());
  const no = (reason) => ({ ok: false, reason: `Fence (${row.family}): ${reason}` });
  for (const [name, value] of Object.entries(params)) {
    if (FREE_PARAMETER.includes(name)) continue;
    const check = PARAMETER[name];
    if (!check) return no(`parameter :${name} without a check`);
    const reason = check(s, value, { writes });
    if (reason) return no(reason);
  }
  // A row for the main instance only: with the token of a copy it is 409 ("does not exist"), not 403 ("not allowed").
  if (row.onlyFromMain && instanceNameFromIdentifier(s.K) !== "main") return { ok: false, status: 409, reason: `Fence (${row.family}): ${row.onlyFromMain}` };
  for (const [name, kind] of Object.entries(row.query || {})) {
    if (!query.has(name)) continue;
    const reason = PARAMETER[kind](s, query.get(name), { writes });
    if (reason) return no(`?${name}: ${reason}`);
  }
  for (const [name, kind] of Object.entries(row.enforce || {})) {
    const desired = kind === "project" ? P : kind === "workspace" ? s.W : kind === "instance" ? s.K : null;
    if (desired === null) return no(`enforced ?${name} has no value`);
    if (query.has(name) && query.get(name) !== desired) return no(`?${name}: only the value of this project`);
    query.set(name, desired);
  }
  if (row.body) {
    const check = BODY[row.body];
    if (!check) return no(`body check ${row.body} is missing`);
    const reason = check(s, body, { params, writes });
    if (reason) return no(reason);
  }
  return { ok: true };
}

// ── The filters ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The counters of /api/active-runs, the same rule as runs/routes.js (disjoint; `kind: "limit"` first). Bound in the test. */
export function countActiveRuns(items) {
  const counts = { total: items.length, running: 0, waiting: 0, ask: 0, limit: 0 };
  for (const it of items) {
    if (it.kind === "limit") { counts.limit++; continue; }
    if (it.phase === "ask") counts.ask++;
    else if (it.phase === "waiting") counts.waiting++;
    else counts.running++;
  }
  return counts;
}

const list = (x) => {
  if (!Array.isArray(x)) throw new Error("not a list");
  return x;
};
const cwdIn = (cwd, root) => {
  if (!cwd || !root) return false;
  const rel = path.relative(String(root), String(cwd));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

// The counters of /api/runs/active that a project container sees (matched with runs/routes.js activeRunsGateRoute).
export const RUNS_COUNTER = Object.freeze(["busy", "runs", "verdicts", "quiet", "open"]);

// Per filter `(body, s) → body` in the SAME shape. `s` is the view with P and W.
export const FILTER = Object.freeze({
  projects: (r, s) => list(r).filter((x) => x?.id === s.P),
  workspaces: (r, s) => list(r).filter((w) => w?.id === s.W).map((w) => (Array.isArray(w.projects) ? { ...w, projects: w.projects.filter((x) => x?.id === s.P) } : w)),
  services: (r, s) => list(r).filter((d) => d?.projectId === s.P),
  ports: (r, s) => list(r).filter((d) => d?.projectId === s.P),
  portsRunning: (r, s) => {
    if (!r || typeof r !== "object" || !Array.isArray(r.open)) throw new Error("no port list");
    const projectPath = s.project(s.P)?.path || "";
    const own = (e) => (e.registered ? e.registered.projectId === s.P : cwdIn(e.process?.cwd, projectPath));
    const open = r.open.filter(own).map((e) => (e.mismatch ? { ...e, ...("process" in e ? { process: null } : {}) } : e));
    const ownServices = new Set(open.filter((e) => e.registered).map((e) => e.port));
    const findings = (r.findings || []).flatMap((b) => {
      if (b.kind === "unregistered") return b.projectId === s.P ? [b] : [];
      if (b.kind === "occupiedByOther") return ownServices.has(b.port) ? [{ ...b, process: "", cwd: "" }] : [];
      if (b.kind === "conflict") {
        const services = (b.services || []).filter((d) => s.service(String(d.id))?.projectId === s.P);
        return services.length ? [{ ...b, services }] : [];
      }
      return [];
    });
    return { ...r, open, reserved: (r.reserved || []).filter((x) => x?.projectId === s.P), findings };
  },
  portsFree: (r, s) => {
    if (!r || typeof r !== "object" || !Array.isArray(r.skipped)) throw new Error("no port choice");
    const skipped = r.skipped.filter((u) => s.service(String(u.id))?.projectId === s.P);
    return { ...r, skipped, skippedTotal: skipped.length };
  },
  chats: (r, s) => list(r).filter((c) => chatInScope(s, c?.id)),
  activeRuns: (r, s) => {
    if (!r || typeof r !== "object" || !Array.isArray(r.items)) throw new Error("no run list");
    const items = r.items.filter((it) => it?.chatId && chatInScope(s, it.chatId));
    return { ...r, items, counts: countActiveRuns(items) };
  },
  // /api/runs/active: the counters (busy, runs, verdicts, quiet, open — including the queue) are no data and stay; the gateway
  // and the deploy read them. The lists only with chats of this project or the own project. An ALLOWLIST: a `...r` would let out
  // every field the route adds for the deploy — `relocationContainer` (fingerprints of the containers of OTHER projects), copies,
  // waiting copies, open relocations, converted, project errors. A new field of the route reaches a project container only once
  // it is listed here.
  runsCounter: (r, s) => {
    if (!r || typeof r !== "object" || typeof r.busy !== "boolean") throw new Error("no busy status");
    const inScope = (x) => chatInScope(s, x?.chatId);
    const counter = Object.fromEntries(RUNS_COUNTER.filter((k) => k in r).map((k) => [k, r[k]]));
    return {
      ...counter,
      approvals: (r.approvals || []).filter(inScope),
      agents: (r.agents || []).filter(inScope),
      dynWorkflows: (r.dynWorkflows || []).filter(inScope),
      // The running outer-loop runs by their (observed) chat — like `agents`.
      outerLoop: (r.outerLoop || []).filter(inScope),
      projectWork: (r.projectWork || []).filter((x) => x?.projectId === s.P),
    };
  },
});

// ── The production view (read paths of the data layer) ─────────────────────────────────────────────────────────────

export const productionView = () => ({
  project: (id) => store.getProject(id),
  chat: (id) => store.getChat(id),
  graphStartOfChild: (id) => store.graphStartOfChild(id),
  service: (id) => store.getProjectService(id),
  channelParticipants: (id) => store.listChannelParticipants(id),
  browser: (id) => getBrowser(id),
  instanceForChat: (chat, location) => instanceForChat(chat, location), // chatInstance
  // Does a run of the chat live in the instance `identifier` (chatInScope)? The turn only while it runs.
  runInInstance: (chatId, identifier) => (running.has(String(chatId)) && turnIdentifier(chatId) === identifier) || chatAliveInInstance(chatId, identifier),
});

// ── The glue (server.js, tunnel.js, browsers.js) ───────────────────────────────────────────────────────────────────

let sourceOf = null;
/** Test seam: `(req) => ip` instead of `req.socket.remoteAddress`. `null` takes it back. server.js never sets it. */
export function setFenceSource(fn) {
  sourceOf = typeof fn === "function" ? fn : null;
}
/** The source of a request as the fence sees it (with the same test seam) — also for the route of the git access
 *  (projectbox/git-assignment.js gitAccessResponse: loopback only). */
export const requestSource = (req) => (sourceOf ? sourceOf(req) : req?.socket?.remoteAddress);

function verdictFor(req, method, filePath) {
  const header = req.headers?.[TOKEN_HEADER];
  const token = typeof header === "string" ? header : "";
  const identifier = token ? identifierForToken(token) : null;
  const instance = identifier ? instanceFromIdentifier(identifier) : null;
  return fenceVerdict({
    source: requestSource(req), token, method, path: filePath,
    instances: instance ? [instance] : [], identifierOfToken: () => identifier,
  });
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let length = 0;
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      length += c.length;
      if (length > BODY_MAX) { tooBig = true; parts.length = 0; req.resume(); reject(Object.assign(new Error("body too large"), { status: 413 })); return; }
      parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on("error", reject);
    req.on("end", () => { if (!tooBig) resolve(Buffer.concat(parts)); });
  });
}

/** A substitute for `req` that delivers the same body once more (the route reads it with readBody as always). */
export function substituteRequest(req, raw) {
  const r = new PassThrough();
  for (const k of ["headers", "rawHeaders", "method", "url", "httpVersion", "httpVersionMajor", "httpVersionMinor", "socket", "connection"]) {
    try { r[k] = req[k]; } catch { /* getter without a value */ }
  }
  r.end(raw);
  return r;
}

/**
 * The body as the route meant it: `send` compresses JSON from 16 KB on according to `Accept-Encoding` (runtime/http.js) —
 * the filter collects those bytes. Parsed raw, every filtered response over 16 KB to a caller with `Accept-Encoding` (the
 * cbase MCP in the project container) was 403 "… is not valid JSON" — services, ports and service log failed.
 * `content-encoding` is a list, decoded backwards; an unknown encoding throws (the response then does not go out).
 */
export function decodedBody(raw, encoding) {
  let b = raw;
  const list = String(encoding || "").toLowerCase().split(",").map((x) => x.trim()).filter((x) => x && x !== "identity");
  for (const k of list.reverse()) {
    if (k === "gzip" || k === "x-gzip") b = zlib.gunzipSync(b);
    else if (k === "br") b = zlib.brotliDecompressSync(b);
    else if (k === "deflate") b = zlib.inflateSync(b);
    else throw new Error(`unknown encoding "${k}"`);
  }
  return b;
}
const headerValue = (header, name) => {
  for (const [k, v] of Object.entries(header || {})) if (k.toLowerCase() === name) return v;
  return undefined;
};
/** What no longer holds after the filter: length and encoding belong to the unfiltered body. */
const GONE_AFTER_FILTER = new Set(["content-length", "content-encoding", "vary"]);

const isJson = (header) => {
  for (const [k, v] of Object.entries(header || {})) if (k.toLowerCase() === "content-type") return String(v).includes("json");
  return false;
};

/** Attaches the filter to the response: the 2xx response is collected, filtered, sent with the marker. */
export function filterResponse(res, filter, s) {
  const { writeHead, write, end } = res;
  let status = null;
  let header = {};
  const parts = [];
  res.writeHead = function (code, a, b) {
    status = code;
    const h = typeof a === "object" && a ? a : typeof b === "object" && b ? b : {};
    header = { ...header, ...h };
    return res;
  };
  res.write = function (chunk, enc, cb) {
    if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === "string" ? enc : undefined));
    if (typeof enc === "function") enc(); else if (typeof cb === "function") cb();
    return true;
  };
  res.end = function (chunk, enc, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; }
    if (typeof enc === "function") { cb = enc; enc = undefined; }
    if (chunk) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === "string" ? enc : undefined));
    res.writeHead = writeHead; res.write = write; res.end = end;
    const code = status ?? res.statusCode ?? 200;
    const withoutLength = Object.fromEntries(Object.entries(header).filter(([k]) => k.toLowerCase() !== "content-length"));
    if (code < 200 || code >= 300) {
      res.writeHead(code, withoutLength);
      return res.end(Buffer.concat(parts), cb);
    }
    const filteredHeader = Object.fromEntries(Object.entries(header).filter(([k]) => !GONE_AFTER_FILTER.has(k.toLowerCase())));
    const preset = Object.fromEntries(Object.entries(res.getHeaders?.() || {}));
    for (const k of GONE_AFTER_FILTER) res.removeHeader?.(k);
    let body;
    try {
      if (!isJson(header) && !isJson(preset)) throw new Error("not a JSON response");
      const raw = decodedBody(Buffer.concat(parts), headerValue(header, "content-encoding") ?? headerValue(preset, "content-encoding"));
      body = Buffer.from(JSON.stringify(filter(JSON.parse(raw.toString("utf8")), s)));
    } catch (e) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: `Fence: the response could not be filtered (${e?.message || e}) — it does not go out` }), cb);
    }
    res.writeHead(code, { ...filteredHeader, [FENCED_HEADER]: "1" });
    return res.end(body, cb);
  };
}

/**
 * The fence in the dispatcher. `true` = go on (as today, or checked in the scope — then possibly with a replaced `ctx.req`, an
 * enforced query, the filter on `ctx.res` and `ctx.fence = fenceContext(…)` = `{ projectId, projectPath, identifier, instance,
 * chatReason }` for routes that need the scope themselves); `false` = answered (401/403/413/400).
 */
export async function fenceRequest(ctx) {
  const { req, res, url, p, m } = ctx;
  const u = verdictFor(req, m, p);
  if (u.verdict === "as-today") return true;
  if (u.verdict === "401") { send(res, 401, { error: u.reason }); return false; }
  if (u.verdict === "403") { send(res, 403, { error: u.reason }); return false; }
  let body;
  if (u.row.body) {
    let raw;
    try { raw = await rawBody(req); } catch (e) { send(res, Number(e?.status) || 400, { error: `Fence: ${e?.message || e}` }); return false; }
    try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { send(res, 400, { error: "Fence: the body is not JSON" }); return false; }
    ctx.req = substituteRequest(req, raw);
  }
  const view = productionView();
  const check = checkScope({ instance: u.instance, row: u.row, params: u.params, method: m, query: url.searchParams, body }, view);
  if (!check.ok) { send(res, check.status || 403, { error: check.reason }); return false; }
  // For the route that must know it answers within the scope of an instance: the language service limits root, reading and
  // writing to the project folder (devtools/routes.js /api/lsp, lsp/boundary.js; the BODY check fileInProject covered only
  // `file`, not the findings of a rename).
  ctx.fence = fenceContext(u.instance, view);
  if (u.row.rule === "filtered") {
    const project = view.project(u.instance.projectId);
    filterResponse(res, FILTER[u.row.filter], { ...view, P: u.instance.projectId, W: project.workspaceId, K: instanceIdentifierOf(u.instance) });
  }
  return true;
}

/**
 * What a route learns from the fence (`ctx.fence`): the project, its folder and the INSTANCE of the token. From a project
 * network the token decides, never the chat: the target instance of every instance-routed route (file, code, git, LSP,
 * browser, channel files) is `identifier`/`instance`; a `?chat` must additionally lie in it (`chatReason` — `null` or the
 * reason for the rejection, the same check `chatInstance` as at the fence rows). The routes do not import the fence
 * (direction of the domains): they get it here as a value.
 */
export function fenceContext(instance, view) {
  const project = view.project(instance.projectId);
  const s = { ...view, P: instance.projectId, W: project?.workspaceId ?? null, K: instanceIdentifierOf(instance) };
  return Object.freeze({
    projectId: instance.projectId, projectPath: project?.path || null, identifier: s.K, instance,
    chatReason: (chatId) => PARAMETER.chatInstance(s, chatId),
    // (The project-level chat check that bounded the lists of cbase_agents_list is gone: a project network reads chats across
    // project and instance borders.)
  });
}

/**
 * The fence at an upgrade (synchronous). → `{ ok: true }` or `{ ok: false, status, reason }`. Without the ops marker: ok. An error
 * in the verdict (data layer) rejects instead of throwing: the caller is an `upgrade` listener, and a throw there would take
 * the whole server down (in the dispatcher its try catches it). Within the scope additionally: the raw path must be the
 * normalized one (400), and only rows with rule "allowed" go through (403).
 */
export function fenceUpgrade(req) {
  if (!projectboxOps()) return { ok: true };
  try { return upgradeVerdict(req); } catch (e) { return { ok: false, status: 403, reason: `Fence: verdict failed (${e?.message || e})` }; }
}
function upgradeVerdict(req) {
  let filePath = "/";
  try { filePath = new URL(req.url || "/", "http://x").pathname; } catch { return { ok: false, status: 400, reason: "Fence: path unreadable" }; }
  const u = verdictFor(req, req.method || "GET", filePath);
  if (u.verdict === "as-today") return { ok: true };
  if (u.verdict === "401") return { ok: false, status: 401, reason: u.reason };
  // The upgrade paths read their target from the RAW req.url (browsers.js attachBrowserDevtools: the browser id by regex), the
  // fence judges the normalized pathname. With `..` or `%2e%2e` (both resolved by `new URL`) it would judge a different browser
  // than the proxy connected — or a row without any browser. Within the scope therefore only a path that is the SAME raw and
  // normalized; `%2f` too, because an encoded slash cuts the segments differently from how the receiver reads them. Outside
  // the scope (as today) unchanged.
  const raw = String(req.url || "/").split("?")[0];
  if (raw !== filePath || /%2e|%2f/i.test(raw)) return { ok: false, status: 400, reason: "Fence: the path of an upgrade must be normalized (no “..”, “%2e”, “%2f”)" };
  if (u.verdict === "403") return { ok: false, status: 403, reason: u.reason };
  // An upgrade is a stream without a response body — a "filtered" row cannot be filtered there (filterResponse exists only in
  // the dispatcher). Only a row with rule "allowed" goes through.
  if (u.row.rule !== "allowed") return { ok: false, status: 403, reason: `Fence (${u.row.family}): on an upgrade only a row with the rule “allowed” applies — “${u.row.rule}” cannot be filtered on a stream` };
  const check = checkScope({ instance: u.instance, row: u.row, params: u.params, method: req.method || "GET" }, productionView());
  return check.ok ? { ok: true } : { ok: false, status: 403, reason: check.reason };
}

/** For the guard: every parameter name of the table is checked or free. */
export const uncheckedParameter = (table = FENCE_TABLE) =>
  [...new Set(table.flatMap((z) => [...parameterOf(z.pattern), ...Object.values(z.query || {}), ...Object.values(z.enforce || {})]))]
    .filter((n) => !FREE_PARAMETER.includes(n) && !PARAMETER[n]);
