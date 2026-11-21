// The instance of a run. A leaf (only import: i18n.js, itself without imports): `runs/` must not import the domain
// `projectbox` (server/backend/test/import-direction.test.js), so the source comes via a setter from server.js — the
// same pattern as setRunState/setBackgroundSource.
//
// THE INSTANCE AS IT TRAVELS: the mapped row from `store.projectInstance(projectId, "main")`
// (store/project-instances.js) — `{ projectId, instance, identifier, containerId, … }` — but ONLY if the operations
// marker is set and the project is converted. Otherwise `null`, and every start stays `spawn`. The source
// (projectbox/run-instance.js `runInstance`) decides that; here it is only asked.
//
// IT IS FIXED ONCE: at the start of the turn from the turn's runtime location AND the chat
// (`instanceOfChat(chat, runLocation)` — it can be a copy of the chat, see "THE INTERFACE" below; location and
// instance name the same project), then it travels along: run spec, engine tool context, monitor, subagent core. A
// subagent carries its IDENTIFIER in its image (store/subagents.js) — resume and the orphan report hit the same
// instance with it; `instanceFromIdentifier` gets it back. A project switch in the middle of a subagent's life does
// not change its instance.
//
// UNSET the answer is `null`: unit tests without a server and the local server without operations start as before.
// It is set in EVERY server (server.js:startServer).

import { T } from "../i18n.js";

let source = null;

/** Sets the source `(projectId, instance = "main") => instance | null` (server.js). `null` takes it back. */
export function setInstanceSource(fn) {
  source = typeof fn === "function" ? fn : null;
}

/** The instance of a project (id or null) for a start NOW — `null` without project, without source, without relocation. */
export function instanceForProject(projectId, instance = "main") {
  if (!projectId || !source) return null;
  return source(String(projectId), String(instance || "main")) || null;
}

/** The identifier "<projectId>/<instance>" a subagent carries in its image — `null` without an instance. */
export const instanceIdentifierOf = (inst) => (inst ? inst.identifier || `${inst.projectId}/${inst.instance || "main"}` : null);

/** Is this the instance of a COPY (`copy-<name>`)? `false` for the main and without an instance. Whoever reads or
 *  writes files of an instance asks this: only the copy sees its overlay (runtime/fileAccess.js), the main lives in
 *  the backend's container. */
export const instanceIsCopy = (inst) => Boolean(inst) && String(inst.instance || "main") !== "main";

/** The instance's name in an identifier "<projectId>/<instance>" — "main" without identifier or without a slash. */
export function instanceNameFromIdentifier(identifier) {
  if (typeof identifier !== "string") return "main";
  const i = identifier.lastIndexOf("/");
  return i > 0 && i < identifier.length - 1 ? identifier.slice(i + 1) : "main";
}

/** The project of an identifier "<projectId>/<instance>" — `null` without identifier. Pure (no source needed): the
 *  core and the lock per project ask for it even if the instance no longer exists. */
export function projectFromIdentifier(identifier) {
  if (typeof identifier !== "string" || !identifier) return null;
  const i = identifier.lastIndexOf("/");
  return i > 0 ? identifier.slice(0, i) : null;
}

/** The instance for an identifier from an image — `null` if it (or operations) no longer exists. */
export function instanceFromIdentifier(identifier) {
  if (typeof identifier !== "string" || !identifier) return null;
  const i = identifier.lastIndexOf("/");
  if (i <= 0) return null;
  return instanceForProject(identifier.slice(0, i), identifier.slice(i + 1));
}

// ── The running turn, pinned ───────────────────────────────────────────────────────────────────────────────────────
// A project switch in the middle of a turn is ALLOWED ("the running turn stays in the old one"). So that the old
// side knows, every running turn is listed here with the project it runs in (that of its chat row at the start —
// the location is computed from it), and from the start of the turn with the identifier of its instance — like a
// subagent core (runs/agents.js). Three readers: a project's idle check counts the turn there even if its chat is
// elsewhere by now (projectbox/idle.js, `turnsInProject`); the fence admits the calls from this instance to its
// chat's routes (projectbox/fence.js, `turnIdentifier`); and if the project switched WHILE the turn ran
// (`turnProjectSwitched`, chats/routes.js PATCH), the next turn learns of it as a silent hint (runs/agents.js,
// `switchAfterTurn`). In memory: a turn does not survive the process.
// Registered in doRun right after `running.add` (the project is known there, the instance only after the gate),
// removed on gate abort and in the finally — on a resume retry the recursive call registers again and keeps the
// switch mark (the same turn). Without an instance row `identifier` is null: the fence then knows no token, and the
// hint only falls if the identifier changes.
const turns = new Map(); // chatId → { projectId, identifier, switched, chatProject? }   switched: false | "project" | "copy"
//   chatProject: the project the chat is in NOW after it switched DURING the turn (PATCH) — null without a project;
//   if the field is missing, the chat is still in the turn's project.
const afterSwitch = new Map(); // chatId → { identifier, reason } of the previous turn whose chat switched project or instance WHILE it ran

// ── The observer at the turn ───────────────────────────────────────────────────────────────────────────────────────
// Recreation (projectbox/) checks at the start of a turn of a chat of a converted project whether image and mounts
// of the project container still match the target state, and tries a pending recreation as soon as a turn ends (the
// project's idle state could be reached). A setter instead of an import, set in server.js:
// `setTurnObserver({ beginning, end })`.
//   beginning({ chatId, projectId, identifier })  ONLY if the turn has an instance (pinTurn with `instance`);
//                                           without an instance nobody asks. If it returns a promise (the check,
//                                           docker calls), it BELONGS to the turn: doRun waits for it before
//                                           removing the chat from `running` (`turnCheckOpen`) — otherwise it would
//                                           run uncounted past the end of the turn (quiet, cleanup in tests).
//   end({ chatId, projectId, ran })         at every end of a pinned turn with a project (also on gate abort).
// Both called synchronously, a throw is only logged (a rejection of the promise likewise).
let turnObserver = null;
const turnChecks = new Map(); // chatId → the promise of the check at the start of the turn
export function setTurnObserver(b) {
  turnObserver = b && typeof b === "object" ? b : null;
}
function observerReport(what, arg) {
  const fn = turnObserver?.[what];
  if (typeof fn !== "function") return undefined;
  try { return fn(arg); } catch (e) { console.error(`[project] turn observer (${what}, ${arg?.chatId}):`, e?.message || e); return undefined; }
}
/** The still running check at the start of this chat's turn — a promise that never rejects — or null. */
export const turnCheckOpen = (chatId) => turnChecks.get(String(chatId ?? "")) || null;

/** Pin a chat's running turn (or add the instance to it). The switch mark stays. */
export function pinTurn(chatId, { projectId = null, instance = null } = {}) {
  const id = String(chatId);
  const old = turns.get(id);
  turns.set(id, { projectId: projectId ? String(projectId) : null, identifier: instanceIdentifierOf(instance), switched: old?.switched || false,
    ...(old && "chatProject" in old ? { chatProject: old.chatProject } : {}) });
  if (instance) { // the check at the start of the turn (see "The observer at the turn")
    const r = observerReport("beginning", { chatId: id, projectId: projectId ? String(projectId) : null, identifier: instanceIdentifierOf(instance) });
    if (r && typeof r.then === "function") {
      const p = r.then(() => undefined, (e) => { console.error(`[project] turn observer (beginning, ${id}):`, e?.message || e); });
      turnChecks.set(id, p);
      p.then(() => { if (turnChecks.get(id) === p) turnChecks.delete(id); });
    }
  }
}

/** The turn is over (`ran: false` = it did not get past the gate). If its chat switched project midway, the process
 *  remembers the identifier it ran in — for the hint in the next turn. */
export function releaseTurn(chatId, { ran = true } = {}) {
  const id = String(chatId);
  const t = turns.get(id);
  turns.delete(id);
  if (ran && t?.switched) afterSwitch.set(id, { identifier: t.identifier, reason: t.switched });
  if (t?.projectId) observerReport("end", { chatId: id, projectId: t.projectId, ran });
}

/** The chat switched its project (PATCH) — if a turn is running, it stays where it is and carries the mark.
 *  `toProject`: the project the chat is in now (null without) — turnInstanceDifferent compares with it; without it
 *  the mark applies. */
export function turnProjectSwitched(chatId, { toProject } = {}) {
  const t = turns.get(String(chatId));
  if (!t) return;
  t.switched = "project";
  if (toProject !== undefined) t.chatProject = toProject ? String(toProject) : null;
}

/** The chat's copy became ready (move-in) or was cleared away (move-out) while a turn ran — it stays where it is,
 *  and the next turn learns of it as a silent hint. Also every switch of the chat's instance
 *  (runs/instance-switch.js chatInstanceSet: PATCH, move-in, move-out). A project switch in the same turn keeps its
 *  mark. */
export function turnInstanceSwitched(chatId) {
  const t = turns.get(String(chatId));
  if (t && !t.switched) t.switched = "copy";
}

/** Does the chat's turn run in ANOTHER instance than the chat carries now (move into the copy, move out or project
 *  switch in the middle of the turn)? Then a queued input does not go into its open process (runs/queue.js
 *  injectNextRunInput), and the process begins no new turn (runs/do-run.js): the input becomes the next turn, in
 *  the instance of NOW. First the PROJECT: if the chat is in another project (or none) after a PATCH, it is another
 *  instance — `instanceNameForChat` alone would only ask within the old project and never see the switch; a switch
 *  without a stated destination counts as a switch. Then main and copy of the same project.
 *  Without an instance on the turn or without a turn: no. Unreadable ⇒ yes (closed: rather a new turn than an input
 *  in the wrong instance). */
export function turnInstanceDifferent(chatId) {
  const t = turns.get(String(chatId ?? ""));
  if (!t?.identifier || !t.projectId) return false;
  if ("chatProject" in t ? t.chatProject !== t.projectId : t.switched === "project") return true;
  try { return `${t.projectId}/${instanceNameForChat(chatId, t.projectId)}` !== t.identifier; }
  catch { return true; }
}

/** The identifier of the instance the chat's running turn works in — null without a turn or without an instance. */
export const turnIdentifier = (chatId) => turns.get(String(chatId ?? ""))?.identifier || null;

/** The project the chat's running turn is pinned to — `{ projectId }` (null without a project) or `null` without a
 *  turn. Also without an instance (a turn in the backend's container): channels/messages.js asks for it when
 *  `turnIdentifier` is empty. */
export const turnProject = (chatId) => {
  const t = turns.get(String(chatId ?? ""));
  return t ? { projectId: t.projectId } : null;
};

/** The chats whose running turn is pinned to the project `projectId`. */
export function turnsInProject(projectId) {
  const pid = String(projectId ?? "");
  return pid ? [...turns].filter(([, t]) => t.projectId === pid).map(([chatId]) => chatId) : [];
}

/** Takes the mark "the project (or the copy) switched during the previous turn" — `{ identifier, reason }` (the
 *  instance of that turn, null = the backend's container; `reason` "project" | "copy") or null. Once: after that it
 *  is gone. */
export function switchAfterTurn(chatId) {
  const id = String(chatId);
  if (!afterSwitch.has(id)) return null;
  const { identifier, reason } = afterSwitch.get(id);
  afterSwitch.delete(id);
  return { identifier, reason };
}

// ── The instance of a CHAT ─────────────────────────────────────────────────────────────────────────────────────────
// A copy belongs to NO chat: every chat carries its instance in its own column (NULL = main), chosen at creation,
// switched by PATCH (runs/instance-switch.js), set when moving into a copy and reset when moving out and on a
// project switch (in the same UPDATE — store/chats.js updateChat; a switch back does NOT bind the copy again). The
// project comparison lives HERE: the binding only holds in the chat's project, a turn in another project (pinned
// after a switch) runs in the main there.
//
// THE INTERFACE:
//   setCopySource(source, { atSwitch, kind })  server.js (setter: runs/ never imports stacks/).
//       source(chatId)  → null (the chat works in main) | `{ projectId, instance }` from the chat's column:
//                         `projectId` is the chat's project; if the copy carries work or carried it (error after
//                         ready: the lock of the instance row in the error state holds with a notice), that is all;
//                         if there is NO such live copy for the chat's instance, `tot: true` is added — the binding
//                         is then locked (never a silent main; only in races — moving out resets the column, the
//                         restart grace repairs what a crash left in between). If the source throws (database
//                         unreadable), every question throws on: unreadable is not "no copy".
//       kind(chatId)    → null (not the child chat of a graph run) | `{ identifier }` — the instance identifier
//                         `<projectId>/copy-<name>` pinned at the start, or "" (started in the main)
//                         (store.graphStartOfChild). A child never switches in the middle of a run.
//       atSwitch({ chatId, ofProject, toProject, ofInstance, toInstance })  the silent hint on a project switch:
//                         `ofInstance` is the chat's instance BEFORE the switch (the switch reset it), `toInstance`
//                         the instance the same PATCH chooses in the new project.
//       Unset (tests without a server, the local server without operations): every chat in the main, no hint.
//   instanceForChat(chat, location) → { instance, identifier, name, projectId, kind, locked, notice }
//       `chat`: the chat object (`{ id, projectId }`) or its id. `location`: the turn's runtime location
//       (runs/runtime-location.js — only a project location has an instance); without it (`undefined`) the chat
//       row's project counts. The answer:
//         instance    the instance row as from `instanceForProject` or null (no relocation, no operations, no
//                     project) — also null if `locked`
//         identifier  `<projectId>/<instance>` of this row; if `locked` that of the missing copy; otherwise null
//         name        "main" | "copy-<name>" — the chat's binding (also without a row)
//         projectId   the project that was asked in (null without project/location)
//         kind        "main" | "copy" | "kind" (the child chat of a graph run, pinned)
//         locked      true: the binding names a copy that cannot be resolved (any more) (no instance row, or no live
//                     copy row, `tot`) — NO fallback to the main. `notice` tells the user/agent. A caller that
//                     cannot report itself takes `instanceOfChat`.
//       Throws if source or instance source throw (unreadable ≠ empty).
//   instanceOfChat(chat, location) → instance row | null, THROWS `CopyLocked` (code "COPY_LOCKED", status 409) if
//       `locked`: the way for every place that binds a start, a read or a write to an instance (do-run, agents,
//       file, git and tool paths): if the copy is missing, the call ends visibly instead of silently running in the
//       main.
//   instanceNameForChat(chatId, projectId) → "main" | "copy-<name>"  only the binding, without the instance row —
//       for the questions that need the NAME (lock and idle per identifier in projectbox/idle.js, the browser
//       network) and go across all chats of a project. The project comparison is in it.
//   How a caller asks for a chat's identifier: `instanceForChat(chat, location).identifier` (with a row) or, without
//       a row, `${projectId}/${instanceNameForChat(chat.id, projectId)}`; "in a copy chat?" is `.name !== "main"`.
//   copyProjectSwitched(chatId, { ofProject, toProject, ofInstance, toInstance })  chats/routes.js PATCH, after the
//       write — passes on to `atSwitch`; a throw is only logged (the switch itself has happened).
//   turnInstanceSwitched(chatId)  (above) — on move-in and move-out, for the running turn.
let copySource = null;
let copySwitch = null;
let kindSource = null;

export function setCopySource(source, { atSwitch = null, kind = null } = {}) {
  copySource = typeof source === "function" ? source : null;
  copySwitch = typeof atSwitch === "function" ? atSwitch : null;
  kindSource = typeof kind === "function" ? kind : null;
}

/** The copy is the chat's binding but its instance cannot be resolved: the lock the caller reports. */
export class CopyLocked extends Error {
  constructor(message, { identifier = null } = {}) {
    super(message);
    this.name = "CopyLocked";
    this.code = "COPY_LOCKED";
    this.status = 409;
    this.identifier = identifier;
  }
}

// A chat's binding in a project — `{ name, kind }`; without a copy the main. The project comparison applies to both
// ways: a copy (or a child pin) of another project is dormant for this chat.
function binding(chatId, projectId) {
  const main = (kind) => ({ name: "main", kind });
  if (!chatId || !projectId) return main("main");
  const id = String(chatId);
  const pid = String(projectId);
  const k = kindSource ? kindSource(id) : null;
  if (k) { // a child chat runs in the instance in which its run began
    const identifier = typeof k.identifier === "string" ? k.identifier : "";
    if (identifier && projectFromIdentifier(identifier) === pid) return { name: identifier.slice(identifier.lastIndexOf("/") + 1), kind: "kind" };
    return main("kind");
  }
  if (!copySource) return main("main");
  const q = copySource(id);
  if (!q || !q.instance) return main("main");
  if (String(q.projectId) !== pid) return main("main"); // the binding only holds in the chat's project
  return { name: String(q.instance), kind: "copy", ...(q.tot ? { tot: true } : {}) };
}

export function instanceNameForChat(chatId, projectId) {
  return binding(chatId, projectId).name;
}

export function instanceForChat(chat, location) {
  const chatId = typeof chat === "string" ? chat : chat?.id;
  const projectId = location !== undefined ? (location?.projectId || null) : (chat && typeof chat === "object" && chat.projectId) || null;
  if (!projectId) return { instance: null, identifier: null, name: "main", projectId: null, kind: "main", locked: false, notice: null };
  const pid = String(projectId);
  const b = binding(chatId, pid);
  // A binding to a copy without a live row (`tot`) never resolves — even if an instance row of that name still existed.
  const instance = b.name === "main" ? instanceForProject(pid) : b.tot ? null : instanceForProject(pid, b.name);
  if (instance || b.name === "main") {
    return { instance, identifier: instanceIdentifierOf(instance), name: b.name, projectId: pid, kind: b.kind, locked: false, notice: null };
  }
  const identifier = `${pid}/${b.name}`;
  return {
    instance: null, identifier, name: b.name, projectId: pid, kind: b.kind, locked: true,
    notice: T`This chat's copy "${b.name}" (${identifier}) cannot be resolved — nothing started, read or written, not in the main instance either.`,
  };
}

export function instanceOfChat(chat, location) {
  const r = instanceForChat(chat, location);
  if (r.locked) throw new CopyLocked(r.notice, { identifier: r.identifier });
  return r.instance;
}

export function copyProjectSwitched(chatId, { ofProject = null, toProject = null, ofInstance = null, toInstance = null } = {}) {
  if (!copySwitch || !chatId) return;
  try { copySwitch({ chatId: String(chatId), ofProject: ofProject ? String(ofProject) : null, toProject: toProject ? String(toProject) : null, ofInstance: ofInstance ? String(ofInstance) : null, toInstance: toInstance ? String(toInstance) : null }); }
  catch (e) { console.error(`[stacks] project switch ${chatId}: hint about the copy not deposited:`, e?.message || e); }
}
