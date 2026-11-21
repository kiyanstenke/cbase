// What the "Instances" tab shows. The ONE calculation over the response of `GET /api/projects/:pid/instances[?open=…]`
// (server/backend/electron/server/projectbox/instances-tree.js) and over the field `instance` from `/api/projects`
// (projectbox/names.js projectInstanceField) — web; iOS twin mobile/CbaseMobile/Code/InstancesTree.swift, bound in
// web/test/instances-tree-binding.test.mjs.
//
//   readTree(raw)             the response as an allowlist (empty is not unknown: a part without `loaded` is NEVER an empty list);
//                             `null` if it is not a tree — the page then shows "not loaded", never "no instances".
//   openParam(open, tree)     the value for `?open=` — only names the tree knows (unknown ones silently drop), sorted; `null` without
//                             (no parameter). Before the first tree the remembered names go out unchanged.
//   situationOf(i)            the state of an instance in ONE UI word (see `Situation`).
//   partSituation(t)          a part (container, repos): closed · loading · error · empty · list.
//   actionsOf(i)              per action { an, reason } — `reason` is a key, not a text (the UI translates).
//   serviceAction(d, i)       what the service row offers: stop · start · startCommand · no. The server calculates `startable` for EVERY
//                             instance from the start command (in main it used to be always true, and the plain start ended in a 400
//                             "no start command stored").
//   linkStopped(i)            a preview link of this instance reaches nothing — it is stopped, stopping or starting (visitors see 502
//                             "instance stopped"); the link row shows it, the dot is neutral.
//   workingChats(i)           the chats with a running turn — for the confirmation before stop, branch and delete (the lock itself is held
//                             by the server: 409 INSTANCE_WORKING also names agents and workflows that the tree does not know).
//   baseOptions(tree)         the instances a copy can be created from: every `ready` one, main first.
//   chatInstanceOptions(field) the instance choice of a chat: main + every copy that runs/instance-switch.js instanceChoice accepts —
//                             copy row `ready` (`copyState`) AND instance row alive (ready, start, stopped — LIVE_INSTANCE). A copy
//                             being cleared away keeps its instance row `ready` and used to be offered, the switch ended in a 409;
//                             without `copyState` (older server) the copy is unknown, never ready. Empty if the project is not converted
//                             or the field carries no `state` text (that is also how the app's decoder `ProjectInstanceShort` reads it).
//                             In EVERY converted project at least `[main]`: without a ready copy the choice stands with main (chosen) and
//                             below it "Create copy …" — so the button is always visible and creating a first copy does not require
//                             knowing the "Instances" tab.
//   progress                  per instance: the progress of a copy that waits or is arising (`copyProgressFrom`, type and allowlist in the
//                             leaf lib/api/copy-progress.ts — the same type the "Active runs" pill reads); null on main, on a ready copy
//                             and where the server does not deliver it (validly). `progressDetail` turns it into what row and detail show.
//   chatInstanceName(value)   the value of `chats.instance` as an instance name (NULL/""/"main" ⇒ "main").
//   instanceSwitchFromEvent(evt)  the stream event `harness`/`chat_settings` of an instance switch (runs/instance-switch.js
//                             chatInstanceSet) → `{ instance }` (null = main); `null` if the event says nothing about the instance (the
//                             workflow driver sends `chat_settings` with other fields — a MISSING field is no statement, nor is a value
//                             that is neither text nor null).
//   copyName(name)            "copy-k1" ⇒ "k1"; main ⇒ null.
//   rowOf(i)                  the summary of the instance row: `stack` running/total and the names of the non-running containers (null =
//                             not read — never 0/0 for unknown), `branch` of the project folder (`rel` "", otherwise the first repo) with
//                             `changed` (open files) and `additional` (number of the other repos; null = not read or no repo), `links` per
//                             service with an active preview link (`stopped` like `linkStopped`). Containers and repos of every READY
//                             instance are delivered by the server in every tree (cache ≤ 30 s, the chosen one fresh —
//                             projectbox/instances-tree.js summary); `asOf` per part = when read.
//   actionFrom(raw)           the human's last action on an instance (tree field `action` and the same field in the event
//                             `project/instance`) — `{ kind, running, since, end, ok, error, stacks }`, `null` without; `stacks` only for
//                             the stack restart (`null` means "no list", never "no stack").
//
// A leaf that imports only the leaf lib/api/copy-progress.ts (itself without imports): the test transpiles it with tsc (the file comes
// along) and runs it under Node.
import { copyProgressFrom, type CopyProgress } from "./api/copy-progress.js";
export { progressDetail, copyProgressFrom, type ProgressDetail, type CopyProgress } from "./api/copy-progress.js";

export type Waiting = { reason: "queue" | "storage"; since: number | null };
export type Part<T> = { loaded: boolean; open: boolean; error: string; list: T[]; asOf: number | null };
export type TreeContainer = { name: string; service: string; running: boolean; status: string };
export type TreeRepo = { rel: string; branch: string; detached: boolean; open: number; error: string };
export type TreeLink = { id: string; url: string; procedure: number | null; state: string };
export type TreeService = { id: string; name: string; port: number | null; running: boolean; holdsStart: boolean; startable: boolean; link: TreeLink | null };
export type TreeChat = { id: string; title: string; running: boolean };
export type TreeStack = { project: string; ok: boolean; error: string };
export type TreeAction = { kind: string; running: boolean; since: number | null; end: number | null; ok: boolean; error: string; stacks: TreeStack[] | null };
export type TreeInstance = {
  name: string; identifier: string; state: string; phase: string; error: string; waiting: Waiting | null;
  cpu: number | null; memBytes: number | null; createdOf: { chatId: string; title: string | null } | null; base: string | null;
  container: Part<TreeContainer>; repos: Part<TreeRepo>; services: TreeService[]; chats: TreeChat[]; action: TreeAction | null;
  progress: CopyProgress | null;
};
export type Tree = { ops: boolean; asOf: number; instances: TreeInstance[] };

/** The situation of an instance in the UI. `waiting` carries the reason in `i.waiting`. */
export type Situation = "ready" | "starts" | "stops" | "stopped" | "waiting" | "build" | "clearAway" | "error" | "unknown";
export type PartSituation = "closed" | "loading" | "error" | "empty" | "list";
export type Reason =
  | "not-ready" | "not-stopped" | "start-waiting" | "no-waiting-start" | "main" | "gets-cleared-away" | "no-repos" | "repos-closed";
export type Available = { on: boolean; reason: Reason | null };
export type Actions = {
  stop: Available; start: Available; abortStart: Available; erase: Available; branch: Available;
  chat: Available; code: Available; terminal: Available; asBase: Available;
};
export type ServiceAction = "stop" | "start" | "startCommand" | "no";
export type InstanceOption = { name: string; identifier: string; state: string };
export type RowsStack = { run: number; total: number; down: string[] };
export type RowsBranch = { name: string; detached: boolean; changed: boolean; additional: number };
export type RowsLink = { service: string; port: number | null; stopped: boolean };
export type Row = { stack: RowsStack | null; branch: RowsBranch | null; links: RowsLink[] };

export const MAIN = "main";
const COPY = "copy-";
/** The living states of an instance row a chat may switch into (runs/instance-switch.js LIVE_INSTANCE). */
export const LIVE_INSTANCE: readonly string[] = ["ready", "start", "stopped"];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): string => (typeof x === "string" ? x : "");
const countOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const truthy = (x: unknown): boolean => x === true;
const idText = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");

export function copyName(name: string): string | null {
  return name.startsWith(COPY) && name.length > COPY.length ? name.slice(COPY.length) : null;
}

export function chatInstanceName(value: string | null | undefined): string {
  const w = typeof value === "string" ? value.trim() : "";
  return w === "" ? MAIN : w;
}

export function instanceSwitchFromEvent(evt: unknown): { instance: string | null } | null {
  if (!isObj(evt) || evt.type !== "harness" || evt.subtype !== "chat_settings") return null;
  const w = evt.instance;
  if (w === null) return { instance: null }; // explicitly main
  if (typeof w !== "string") return null; // missing (workflow driver) or not text — no statement
  const name = chatInstanceName(w);
  return { instance: name === MAIN ? null : name };
}

function partFrom<T>(raw: unknown, row: (x: unknown) => T | null): Part<T> {
  if (!isObj(raw)) return { loaded: false, open: false, error: "", list: [], asOf: null };
  const loaded = truthy(raw.loaded);
  const list = loaded && Array.isArray(raw.list) ? raw.list.map(row).filter((x): x is T => x !== null) : [];
  return { loaded, open: loaded || truthy(raw.open), error: text(raw.error), list, asOf: countOrNull(raw.asOf) };
}

function waitingFrom(raw: unknown): Waiting | null {
  if (!isObj(raw) || (raw.reason !== "queue" && raw.reason !== "storage")) return null;
  return { reason: raw.reason, since: countOrNull(raw.since) };
}

export function actionFrom(raw: unknown): TreeAction | null {
  if (!isObj(raw) || !text(raw.kind)) return null;
  const stacks = Array.isArray(raw.stacks)
    ? raw.stacks.map((s) => (isObj(s) && text(s.project) ? { project: text(s.project), ok: truthy(s.ok), error: text(s.error) } : null)).filter((x): x is TreeStack => x !== null)
    : null;
  return { kind: text(raw.kind), running: truthy(raw.running), since: countOrNull(raw.since), end: countOrNull(raw.end), ok: truthy(raw.ok), error: text(raw.error), stacks };
}

function instanceFrom(raw: unknown): TreeInstance | null {
  if (!isObj(raw)) return null;
  const name = text(raw.name);
  if (!name || (name !== MAIN && !copyName(name))) return null;
  const from = isObj(raw.createdOf) && text(raw.createdOf.chatId) ? { chatId: text(raw.createdOf.chatId), title: typeof raw.createdOf.title === "string" ? raw.createdOf.title : null } : null;
  return {
    name, identifier: text(raw.identifier), state: text(raw.state), phase: text(raw.phase), error: text(raw.error), waiting: waitingFrom(raw.waiting),
    cpu: countOrNull(raw.cpu), memBytes: countOrNull(raw.memBytes), createdOf: from, base: text(raw.base) || null,
    container: partFrom(raw.container, (c) => (isObj(c) && text(c.name) ? { name: text(c.name), service: text(c.service), running: truthy(c.running), status: text(c.status) } : null)),
    repos: partFrom(raw.repos, (r) => (isObj(r) && typeof r.rel === "string" ? { rel: r.rel, branch: text(r.branch), detached: truthy(r.detached), open: countOrNull(r.open) ?? 0, error: text(r.error) } : null)),
    services: Array.isArray(raw.services) ? raw.services.map((d) => {
      if (!isObj(d) || !idText(d.id)) return null;
      const l = isObj(d.link) && idText(d.link.id) ? { id: idText(d.link.id), url: text(d.link.url), procedure: countOrNull(d.link.procedure), state: text(d.link.state) } : null;
      return { id: idText(d.id), name: text(d.name), port: countOrNull(d.port), running: truthy(d.running), holdsStart: truthy(d.holdsStart), startable: truthy(d.startable), link: l };
    }).filter((x): x is TreeService => x !== null) : [],
    chats: Array.isArray(raw.chats) ? raw.chats.map((c) => (isObj(c) && text(c.id) ? { id: text(c.id), title: text(c.title), running: truthy(c.running) } : null)).filter((x): x is TreeChat => x !== null) : [],
    action: actionFrom(raw.action),
    // Only on a copy (main does not arise — a progress there would be a server error, not a state).
    progress: name === MAIN ? null : copyProgressFrom(raw.progress),
  };
}

export function readTree(raw: unknown): Tree | null {
  if (!isObj(raw) || raw.loaded !== true || !Array.isArray(raw.instances)) return null;
  const instances = raw.instances.map(instanceFrom).filter((x): x is TreeInstance => x !== null);
  // main first, otherwise the server's order (creation order); a duplicate row counts once.
  const seen = new Set<string>();
  const unique = instances.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true)));
  unique.sort((a, b) => (a.name === MAIN ? -1 : b.name === MAIN ? 1 : 0));
  return { ops: raw.ops !== false, asOf: countOrNull(raw.asOf) ?? 0, instances: unique };
}

export function openParam(open: Iterable<string>, tree: Tree | null): string | null {
  const known = tree ? new Set(tree.instances.map((i) => i.name)) : null;
  const names = [...new Set(open)].filter((n) => n && (!known || known.has(n))).sort();
  return names.length ? names.join(",") : null;
}

export function situationOf(i: TreeInstance): Situation {
  if (i.waiting) return "waiting";
  switch (i.state) {
    case "ready": return "ready";
    case "start": case "recreate": case "relocation": return "starts";
    case "stop": return "stops";
    case "stopped": return "stopped";
    case "waiting_queue": case "waiting_storage": return "waiting";
    case "create": case "build": return "build";
    case "clearAway": return "clearAway";
    case "error": return "error";
    default: return "unknown";
  }
}

export function partSituation<T>(t: Part<T>): PartSituation {
  if (!t.loaded) return !t.open ? "closed" : t.error ? "error" : "loading";
  if (!t.list.length) return t.error ? "error" : "empty";
  return "list";
}

const on = (): Available => ({ on: true, reason: null });
const off = (reason: Reason): Available => ({ on: false, reason });

export function actionsOf(i: TreeInstance): Actions {
  const situation = situationOf(i);
  const ready = situation === "ready";
  const main = i.name === MAIN;
  const waitingStart = i.state === "stopped" && i.waiting?.reason === "storage";
  const notReady = off(situation === "clearAway" ? "gets-cleared-away" : "not-ready");
  const reposPart = partSituation(i.repos);
  return {
    stop: ready ? on() : notReady,
    start: i.state === "stopped" && !waitingStart ? on() : off(waitingStart ? "start-waiting" : situation === "clearAway" ? "gets-cleared-away" : "not-stopped"),
    abortStart: waitingStart ? on() : off("no-waiting-start"),
    // Only a copy can be deleted; in every situation except being cleared away itself — also a waiting or failed one (the server aborts).
    erase: main ? off("main") : situation === "clearAway" ? off("gets-cleared-away") : on(),
    branch: !ready ? notReady : reposPart === "list" ? on() : off(reposPart === "empty" ? "no-repos" : "repos-closed"),
    // A chat may go into a stopped instance: its turn starts it.
    chat: ready || i.state === "stopped" ? on() : notReady,
    code: ready ? on() : notReady,
    terminal: ready ? on() : notReady,
    asBase: ready ? on() : notReady,
  };
}

export function serviceAction(d: TreeService, i: TreeInstance): ServiceAction {
  if (d.running || d.holdsStart) return "stop";
  if (situationOf(i) !== "ready") return "no";
  return d.startable ? "start" : "startCommand";
}

/** The instance does not run (stopped, stopping, starting — also a waiting start), its link reaches nothing. By the STATE, not the
 *  situation: a waiting start is "waiting" and yet stands still. */
export function linkStopped(i: TreeInstance): boolean {
  return i.state === "stopped" || i.state === "stop" || i.state === "start";
}

export function rowOf(i: TreeInstance): Row {
  const c = i.container;
  const stack = c.loaded
    ? { run: c.list.filter((x) => x.running).length, total: c.list.length, down: c.list.filter((x) => !x.running).map((x) => x.service || x.name) }
    : null;
  const r = i.repos;
  const first = r.loaded ? (r.list.find((x) => x.rel === "") ?? r.list[0] ?? null) : null;
  const branch = first ? { name: first.branch, detached: first.detached, changed: first.open > 0, additional: r.list.length - 1 } : null;
  const stopped = linkStopped(i);
  const links = i.services.filter((d) => d.link !== null).map((d) => ({ service: d.name || d.id, port: d.port, stopped }));
  return { stack, branch, links };
}

export function workingChats(i: TreeInstance): TreeChat[] {
  return i.chats.filter((c) => c.running);
}

export function baseOptions(tree: Tree | null): InstanceOption[] {
  if (!tree) return [];
  return tree.instances.filter((i) => actionsOf(i).asBase.on).map((i) => ({ name: i.name, identifier: i.identifier, state: i.state }));
}

/** The field `instance` from /api/projects (projectbox/names.js projectInstanceField): `copies[].identifier` = `<pid>/copy-<name>`, `state` of the
 *  instance row, `copyState` that of the copy row in stack_copies ("" without a living row). */
export type ProjectInstanceField = {
  identifier?: string; state?: string; converted?: boolean;
  copies?: Array<{ identifier?: string; state?: string; copyState?: string }> | null;
} | null | undefined;

/** The state of a copy row in which a chat may switch into the copy (runs/instance-switch.js instanceChoice). */
export const COPY_READY = "ready";

export function chatInstanceOptions(field: ProjectInstanceField): InstanceOption[] {
  if (!field || field.converted !== true || typeof field.identifier !== "string" || typeof field.state !== "string") return [];
  const cut = field.identifier.lastIndexOf("/");
  if (cut <= 0 || field.identifier.slice(cut + 1) !== MAIN) return [];
  const pid = field.identifier.slice(0, cut);
  const copies = (Array.isArray(field.copies) ? field.copies : []).flatMap((k) => {
    const identifier = typeof k?.identifier === "string" ? k.identifier : "";
    const name = identifier.startsWith(`${pid}/`) ? identifier.slice(pid.length + 1) : "";
    const state = typeof k?.state === "string" ? k.state : "";
    return copyName(name) && k?.copyState === COPY_READY && LIVE_INSTANCE.includes(state) ? [{ name, identifier, state }] : [];
  });
  // Also without a ready copy — main alone is then the choice, "Create copy …" stands below it (ChatInstanceChoice).
  return [{ name: MAIN, identifier: field.identifier, state: field.state }, ...copies];
}
