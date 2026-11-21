// The ONE mutation path of the skills. UI (workspace and project routes, `who: human`) and tool (`cbase_skill_write`,
// `who: agent`, toolchain/skill-routes.js) go through THESE functions — each writes its history entry in the same step as the
// mutation, lets open deletion requests of the skill with another version lapse (silent hint to their chat) and reports the
// event `skills`.
//
//   skillCreate         new (name unique per level; for the agent: no project skill under the name of a workspace coding skill)
//   changeSkill         name/description/guide (agent) or texts and frontmatter (UI); renaming checks references and the
//                       workspace-name rule; without effect it writes nothing (`unchanged`)
//   skillDelete         an agent definition names the skill ⇒ 409 with `references`; the resources move to the trash
//                       `<data>/skill-trash/<historyId>/`, not into nothing
//   revert              only the human (UI); exactly once; only while the skill is unchanged since; writes NO new entry,
//                       marks the old one
//   submitRequest       deleting via the tool is a request; a second one for the same skill is merged — its chat is then
//                       on the request (`additionalChats`) and learns decision and lapse like the first
//   decideRequest       approve (= skillDelete with `requestId`, the reference check applies) or decline; hint to every
//                       chat of the request
//   cleanStaleRequests  on reading: open requests whose skill is missing or carries another version lapse (paths that write
//                       past the mutation path — a migration, a rolled-back release)
//
// Errors throw `SkillError` with status and body — the routes pass both on 1:1.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as skillsLib from "../skills.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { depositHint } from "../runs/hints.js";

export class SkillError extends Error {
  constructor(status, body) {
    super(body?.error || "skill error");
    this.status = status;
    this.body = body;
  }
}

const levelOf = (s) => (s?.projectId ? "project" : "workspace");

/** The state of a skill in the history (plus frontmatter, department and creation time — undoing a deletion needs them). */
export function skillState(s) {
  if (!s) return null;
  return {
    name: s.name, description: s.description || "", body: s.body || "", version: s.version || store.skillVersion(s),
    hasResources: Boolean(s.hasResources), hiddenIn: s.projectId ? [] : store.skillHiddenIn(s.id),
    allowedTools: s.allowedTools || "", model: s.model || "", area: s.area || "coding", createdAt: s.createdAt ?? null,
  };
}
// Does the current skill match a state? Version (name, description, guide) and the frontmatter the UI changes.
const matches = (s, state) => Boolean(s && state) && s.version === state.version
  && (state.allowedTools === undefined || (s.allowedTools || "") === state.allowedTools)
  && (state.model === undefined || (s.model || "") === state.model);

/** The agent definitions whose `skills` list names the skill (under `name`) and could load it. */
export function skillReferences(skill, name = skill?.name) {
  if (!skill || !name) return [];
  const ws = store.getWorkspace(skill.workspaceId);
  const definitions = [...store.listWorkspaceAgents(skill.workspaceId), ...(ws?.projects || []).flatMap((p) => store.listProjectAgents(p.id))];
  return definitions
    .filter((d) => !skill.projectId || !d.projectId || d.projectId === skill.projectId)
    .filter((d) => String(d.skills || "").split(",").map((x) => x.trim()).includes(name))
    .map((d) => ({ id: d.id, name: d.name, level: d.projectId ? "project" : "workspace" }));
}
function referenceError(skill, references, what) {
  const names = references.map((v) => v.name).join(", ");
  return new SkillError(409, {
    error: T`The skill "${skill.name}" is listed in the skills of ${references.length === 1 ? T("the agent definition(s)##one") : T("the agent definition(s)##many")} ${names} — ${what} works only once it is removed there (otherwise the next start of that agent fails with "skill not found").`,
    references,
  });
}
const existingError = (s, text) => new SkillError(409, { error: text, existing: { id: s.id, name: s.name, level: levelOf(s) } });

// A PROJECT skill under the name of a workspace coding skill — rejected only via the tool (the UI stays as it is).
function checkE9(workspaceId, projectId, name) {
  if (!projectId) return;
  const ws = store.getSkillByName(workspaceId, null, name);
  if (ws && ws.area === "coding") {
    throw existingError(ws, T`The workspace skill "${name}" already exists — a project skill of the same name would hide it in this project. Change the existing one (cbase_skill_write change with its id) or pick another name.`);
  }
}
function checkName(name) {
  if (!skillsLib.validName(name)) throw new SkillError(400, { error: T("Skill name must be lower-kebab-case (a-z, 0-9, -, at most 64 characters)") });
}
function checkFree(workspaceId, projectId, name, exceptId = "", from = null) {
  const found = store.getSkillByName(workspaceId, projectId, name);
  if (found && found.id !== exceptId) {
    // Coding skills only: a managing skill stays invisible to an agent — only "taken", without `existing`. Its id would lead
    // into a change that ends in 404 anyway, and so would a cbase_skill on the name.
    if (from?.who === "agent" && found.area === "managing") {
      throw new SkillError(409, { error: T`The name "${name}" is already taken in this workspace — pick another one.` });
    }
    throw existingError(found, projectId
      ? T`A skill "${name}" already exists in this project.`
      : T`A skill "${name}" already exists in this workspace.`);
  }
}

// Who changes: `{ who: "human" }` or `{ who: "agent", chat }` — the title at that time (the chat may be gone later).
const ofFields = (from) => (from?.who === "agent"
  ? { who: "agent", chatId: from.chat?.id || null, chatTitle: from.chat?.title ?? null }
  : { who: "human", chatId: null, chatTitle: null });

/** The event — web and iOS reload an open skill page of the workspace and an open request card. */
export function reportSkills({ workspaceId, projectId = null, skillId = null, kind, requestId }) {
  broadcast({ type: "skills", workspaceId, projectId: projectId || null, skillId: skillId || null, kind, ...(requestId ? { requestId } : {}) });
}

// The chats of a request: the first and every merged one — each made it, each learns how it ended.
const requestChats = (a) => [a.chatId, ...(a.additionalChats || []).map((c) => c?.id)].filter((v, i, l) => v && l.indexOf(v) === i);
function hintToRequest(a, text) {
  for (const chatId of requestChats(a)) {
    try { depositHint(chatId, text, { source: "skill-request" }); }
    catch { /* a hint must never fail the mutation — the chat may be gone, the request stays on the skill page */ }
  }
}
const hintExpired = (a, why) => hintToRequest(a,
  T`Your deletion request for the skill "${a.skillName}" lapsed: ${why}. If it should still go, read it again (cbase_skill) and request it with the current version.`);
function expiredReport(list, why) {
  for (const a of list) {
    hintExpired(a, why);
    reportSkills({ workspaceId: a.workspaceId, projectId: a.projectId, skillId: a.skillId, kind: "request", requestId: a.id });
  }
}

// Resources into the trash and back. `rename` within the same data folder; across file system boundaries copy and remove.
function move(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (e) {
    if (e?.code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

// ── Create ────────────────────────────────────────────────────────────────────────────────────────────────────
export function skillCreate({ workspaceId, projectId = null, name, description = "", body = "", allowedTools = "", model = "", area = "coding" }, from) {
  checkName(name);
  checkFree(workspaceId, projectId, name, "", from);
  if (from?.who === "agent") checkE9(workspaceId, projectId, name);
  const now = Date.now();
  const id = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  const { skill, entry } = store.skillTransaction(() => {
    const sk = store.createSkill({ id, workspaceId, projectId, name, description, body, allowedTools, model, area, createdAt: now, updatedAt: now });
    const e = store.createSkillHistory({ id: historyId, skillId: id, workspaceId, projectId, kind: "create", ...ofFields(from), prior: null, after: skillState(sk), at: now });
    return { skill: sk, entry: e };
  });
  reportSkills({ workspaceId, projectId, skillId: id, kind: "create" });
  return { skill, entry };
}

// ── Change ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * `fields`: name?, description?, body?, allowedTools?, model? (strings only). `version` (optional): the one read — if it
 * differs, 409 with `conflict`. Returns `{ skill, entry, unchanged }`.
 */
export function changeSkill(id, fields, from, { version } = {}) {
  const old = store.getSkill(id);
  if (!old) throw new SkillError(404, { error: "skill not found" });
  if (version !== undefined && version !== old.version) {
    throw new SkillError(409, { error: T`The skill "${old.name}" has changed in the meantime — read it again (cbase_skill) and change the current state.`, conflict: true, current: { version: old.version } });
  }
  const fresh = {};
  for (const k of ["name", "description", "body", "allowedTools", "model"]) {
    if (typeof fields?.[k] === "string" && fields[k] !== (old[k] ?? "")) fresh[k] = fields[k];
  }
  if (!Object.keys(fresh).length) return { skill: old, entry: null, unchanged: true };
  if (fresh.name !== undefined) {
    checkName(fresh.name);
    checkFree(old.workspaceId, old.projectId, fresh.name, old.id, from);
    if (from?.who === "agent") checkE9(old.workspaceId, old.projectId, fresh.name);
    const references = skillReferences(old);
    if (references.length) throw referenceError(old, references, T("this##rename"));
  }
  const now = Date.now();
  const historyId = crypto.randomUUID();
  const prior = skillState(old);
  const { skill, entry, expired } = store.skillTransaction(() => {
    const { name: newName, ...texts } = fresh;
    if (Object.keys(texts).length) store.updateSkill(id, { ...texts, updatedAt: now });
    if (newName !== undefined) store.setSkillName(id, newName, now);
    const sk = store.getSkill(id);
    const e = store.createSkillHistory({ id: historyId, skillId: id, workspaceId: old.workspaceId, projectId: old.projectId, kind: "change", ...ofFields(from), prior, after: skillState(sk), at: now });
    return { skill: sk, entry: e, expired: store.expireSkillRequests(id, { version: sk.version, at: now }) };
  });
  expiredReport(expired, T("the skill was changed before the decision"));
  reportSkills({ workspaceId: old.workspaceId, projectId: old.projectId, skillId: id, kind: "change" });
  return { skill, entry, unchanged: false };
}

// ── Delete ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Deletes at once (UI, approved request). References ⇒ 409 `references`. Returns `{ entry }`. */
export function skillDelete(id, from, { requestId = null } = {}) {
  const old = store.getSkill(id);
  if (!old) throw new SkillError(404, { error: "skill not found" });
  const references = skillReferences(old);
  if (references.length) throw referenceError(old, references, T("deleting"));
  const now = Date.now();
  const historyId = crypto.randomUUID();
  const prior = skillState(old);
  const bin = store.skillTrashDir(historyId);
  const inBin = move(store.skillResourceDir(id), bin);
  let result;
  try {
    result = store.skillTransaction(() => {
      store.deleteSkill(id);
      const e = store.createSkillHistory({ id: historyId, skillId: id, workspaceId: old.workspaceId, projectId: old.projectId, kind: "erase", ...ofFields(from), prior, after: null, trash: inBin, requestId, at: now });
      return { entry: e, expired: store.expireSkillRequests(id, { version: null, except: requestId || "", at: now }) };
    });
  } catch (e) {
    if (inBin) { try { move(bin, store.skillResourceDir(id)); } catch { /* stays in the trash */ } }
    throw e;
  }
  expiredReport(result.expired, T("the skill was deleted before the decision"));
  reportSkills({ workspaceId: old.workspaceId, projectId: old.projectId, skillId: id, kind: "erase" });
  return { entry: result.entry };
}

// ── Undo (only the human) ───────────────────────────────────────────────────────────────────────────
const alreadyError = () => new SkillError(409, { error: T("This entry has already been undone."), reverted: true });
function conflictError(e, current) {
  return new SkillError(409, {
    error: T("The skill has changed since this entry — undoing it would skip a later change. Undo the newer one first."),
    conflict: true, current: skillState(current), expected: e.after,
  });
}

/**
 * Is the entry revertible now (`revertible`)? The same conditions as `revert` below — otherwise the UI shows a button that only
 * leads to a 409: a deletion only with a free name and an existing project, a creation only without a reference, a rename
 * back only onto a free name and without a reference.
 */
export function revertible(e) {
  if (!e || e.revertedAt) return false;
  const s = store.getSkill(e.skillId);
  if (e.kind === "erase") {
    return !s && Boolean(e.prior?.name) && !store.getSkillByName(e.workspaceId, e.projectId, e.prior.name)
      && (!e.projectId || Boolean(store.getProject(e.projectId)));
  }
  if (!matches(s, e.after)) return false;
  if (e.kind === "create") return !skillReferences(s).length;
  const oldName = e.prior?.name;
  if (oldName && oldName !== s.name) {
    const found = store.getSkillByName(s.workspaceId, s.projectId, oldName);
    if ((found && found.id !== s.id) || skillReferences(s).length) return false;
  }
  return true;
}

export function revert(entryId) {
  const e = store.skillHistoryEntry(entryId);
  if (!e) throw new SkillError(404, { error: T("History entry not found") });
  if (e.revertedAt) throw alreadyError();
  const now = Date.now();
  const s = store.getSkill(e.skillId);
  if (e.kind === "erase") {
    if (s) throw conflictError(e, s);
    const v = e.prior || {};
    const found = store.getSkillByName(e.workspaceId, e.projectId, v.name);
    if (found) throw existingError(found, T`A skill "${v.name}" exists on this level again — rename or delete it first, then restore.`);
    if (e.projectId && !store.getProject(e.projectId)) throw new SkillError(409, { error: T("This skill's project no longer exists.") });
    const projects = new Set((store.getWorkspace(e.workspaceId)?.projects || []).map((p) => p.id));
    const sk = store.skillTransaction(() => {
      if (!store.revertSkillHistory(e.id, now)) throw alreadyError();
      const fresh = store.createSkill({ id: e.skillId, workspaceId: e.workspaceId, projectId: e.projectId, name: v.name, description: v.description || "", body: v.body || "",
        hasResources: Boolean(v.hasResources) && e.trash, allowedTools: v.allowedTools || "", model: v.model || "", area: v.area === "managing" ? "managing" : "coding",
        createdAt: v.createdAt ?? now, updatedAt: now });
      for (const pid of v.hiddenIn || []) if (projects.has(pid)) store.setSkillExcluded(pid, e.skillId, true);
      return fresh;
    });
    if (e.trash) {
      try { move(store.skillTrashDir(e.id), store.skillResourceDir(e.skillId)); }
      catch (err) { console.error("[skills] resources not restored from the trash:", err?.message || err); }
    }
    reportSkills({ workspaceId: e.workspaceId, projectId: e.projectId, skillId: e.skillId, kind: "back" });
    return { skill: store.getSkill(sk.id) };
  }
  if (!s || !matches(s, e.after)) throw conflictError(e, s);
  if (e.kind === "create") {
    const references = skillReferences(s);
    if (references.length) throw referenceError(s, references, T("this##undo"));
    const bin = store.skillTrashDir(e.id);
    const inBin = move(store.skillResourceDir(s.id), bin);
    let expired;
    try {
      expired = store.skillTransaction(() => {
        if (!store.revertSkillHistory(e.id, now)) throw alreadyError();
        store.deleteSkill(s.id);
        if (inBin) store.skillHistoryTrash(e.id, true);
        return store.expireSkillRequests(s.id, { version: null, at: now });
      });
    } catch (err) {
      if (inBin) { try { move(bin, store.skillResourceDir(s.id)); } catch { /* stays in the trash */ } }
      throw err;
    }
    expiredReport(expired, T("creating the skill was undone"));
    reportSkills({ workspaceId: e.workspaceId, projectId: e.projectId, skillId: s.id, kind: "back" });
    return { skill: null };
  }
  // change: write back the prior state (name including reference check and uniqueness, texts, frontmatter).
  const v = e.prior || {};
  if (v.name && v.name !== s.name) {
    checkFree(s.workspaceId, s.projectId, v.name, s.id);
    const references = skillReferences(s);
    if (references.length) throw referenceError(s, references, T("this##undo"));
  }
  const { sk, expired } = store.skillTransaction(() => {
    if (!store.revertSkillHistory(e.id, now)) throw alreadyError();
    const texts = { description: v.description ?? s.description, body: v.body ?? s.body, updatedAt: now };
    if (v.allowedTools !== undefined) texts.allowedTools = v.allowedTools;
    if (v.model !== undefined) texts.model = v.model;
    store.updateSkill(s.id, texts);
    if (v.name && v.name !== s.name) store.setSkillName(s.id, v.name, now);
    const fresh = store.getSkill(s.id);
    return { sk: fresh, expired: store.expireSkillRequests(s.id, { version: fresh.version, at: now }) };
  });
  expiredReport(expired, T("the change to the skill was undone"));
  reportSkills({ workspaceId: e.workspaceId, projectId: e.projectId, skillId: s.id, kind: "back" });
  return { skill: sk };
}

// ── Deletion requests ──────────────────────────────────────────────────────────────────────────────────────────
/** A request of the main agent (`from.chat`) for `skill` in `version`. Returns `{ request, merged }`. */
export function submitRequest(skill, from, { version, reason = "" } = {}) {
  if (version !== skill.version) {
    throw new SkillError(409, { error: T`The skill "${skill.name}" has changed in the meantime — read it again (cbase_skill) before requesting deletion.`, conflict: true, current: { version: skill.version } });
  }
  const references = skillReferences(skill);
  if (references.length) throw referenceError(skill, references, T("deleting"));
  // An open request on an older version can no longer be decided — it lapses instead of swallowing this one.
  expiredReport(store.expireSkillRequests(skill.id, { version: skill.version }), T("the skill had changed before the decision"));
  const open = store.openSkillRequest(skill.id);
  if (open) {
    const a = from?.chat?.id ? store.skillRequestChatAdd(open.id, from.chat.id, from.chat.title ?? null) : open;
    return { request: a || open, merged: true };
  }
  const a = store.createSkillRequest({ id: crypto.randomUUID(), skillId: skill.id, workspaceId: skill.workspaceId, projectId: skill.projectId, version: skill.version,
    skillName: skill.name, chatId: from.chat.id, chatTitle: from.chat.title ?? null, reason: String(reason || "").trim() || null });
  reportSkills({ workspaceId: skill.workspaceId, projectId: skill.projectId, skillId: skill.id, kind: "request", requestId: a.id });
  return { request: a, merged: false };
}

/** Is the request still at the skill's state (`current`)? */
export function requestCurrent(a) {
  const s = a && store.getSkill(a.skillId);
  return Boolean(s && s.version === a.version);
}

/** The human decides. `approve` true ⇒ delete (the reference check applies), false ⇒ decline. Returns `{ request }`. */
export function decideRequest(id, approve) {
  const a = store.skillRequest(id);
  if (!a) throw new SkillError(404, { error: T("Request not found") });
  if (a.status !== "open") {
    throw new SkillError(409, { error: a.status === "expired"
      ? T("The request has lapsed — the skill changed before the decision.")
      : T("This request has already been decided."), request: requestView(a) });
  }
  const now = Date.now();
  if (!requestCurrent(a)) {
    const expired = store.expireSkillRequests(a.skillId, { version: store.getSkill(a.skillId)?.version ?? null, at: now });
    expiredReport(expired, T("the skill had changed before the decision"));
    throw new SkillError(409, { error: T("The request has lapsed — the skill changed before the decision."), request: requestView(store.skillRequest(id)) });
  }
  if (approve) {
    // Delete first (the reference check can still throw 409 here — the request then stays open), then mark it approved.
    const chat = store.getChat(a.chatId);
    skillDelete(a.skillId, { who: "agent", chat: chat || { id: a.chatId, title: a.chatTitle } }, { requestId: a.id });
    store.decideSkillRequest(a.id, "approved", now);
  } else if (!store.decideSkillRequest(a.id, "rejected", now)) {
    throw new SkillError(409, { error: T("This request has already been decided."), request: requestView(store.skillRequest(id)) });
  }
  hintToRequest(a, approve
    ? T`Your deletion request for the skill "${a.skillName}" was approved by the human — the skill is deleted.`
    : T`Your deletion request for the skill "${a.skillName}" was declined by the human — the skill stays.`);
  reportSkills({ workspaceId: a.workspaceId, projectId: a.projectId, skillId: a.skillId, kind: "decided", requestId: a.id });
  return { request: requestView(store.skillRequest(id)) };
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────
const projectNameOf = (projectId) => (projectId ? store.getProject(projectId)?.name || "" : "");

export function entryView(e) {
  if (!e) return null;
  const pn = projectNameOf(e.projectId);
  return {
    id: e.id, skillId: e.skillId, workspaceId: e.workspaceId, projectId: e.projectId, ...(pn ? { projectName: pn } : {}),
    kind: e.kind, who: e.who, ...(e.chatId ? { chatId: e.chatId, chatTitle: e.chatTitle } : {}),
    prior: e.prior, after: e.after, trash: e.trash, ...(e.requestId ? { requestId: e.requestId } : {}),
    at: e.at, ...(e.revertedAt ? { revertedAt: e.revertedAt } : {}), revertible: revertible(e),
  };
}
export function requestView(a) {
  if (!a) return null;
  return {
    id: a.id, skillId: a.skillId, skillName: a.skillName, workspaceId: a.workspaceId, projectId: a.projectId, version: a.version,
    chatId: a.chatId, chatTitle: a.chatTitle, ...(a.additionalChats?.length ? { additionalChats: a.additionalChats } : {}), reason: a.reason, status: a.status, at: a.at,
    ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}), current: requestCurrent(a),
  };
}

/**
 * Open requests that can no longer be decided lapse on READING — their skill is missing or carries another version. The
 * mutation path already lets them lapse in the same step; what remains are the paths past it (a migration, a rolled-back
 * release that does not know the table). Without this such a request would stay open on the skill page forever, and
 * "Approve" would only lead to a 409. Called by the lists (withChanges) and the read paths of the requests.
 */
export function cleanStaleRequests(workspaceId) {
  const seen = new Set();
  for (const a of store.skillRequestsList(workspaceId, "open")) {
    if (seen.has(a.skillId)) continue;
    seen.add(a.skillId);
    const s = store.getSkill(a.skillId);
    if (s && s.version === a.version) continue;
    expiredReport(store.expireSkillRequests(a.skillId, { version: s ? s.version : null }), s
      ? T("the skill had changed before the decision")
      : T("the skill no longer exists"));
  }
}

/** The fields on every row of a skill list: `version`, `lastChange`, `openRequest`. */
export function withChanges(workspaceId, list) {
  cleanStaleRequests(workspaceId);
  const last = store.lastSkillChanges(workspaceId);
  const open = store.openSkillRequests(workspaceId);
  return list.map((s) => {
    const e = last.get(s.id);
    const a = open.get(s.id);
    return {
      ...s, version: s.version ?? store.getSkill(s.id)?.version ?? null,
      lastChange: e ? { who: e.who, ...(e.chatId ? { chatId: e.chatId, chatTitle: e.chatTitle } : {}), at: e.at } : null,
      openRequest: a ? { id: a.id, chatTitle: a.chatTitle, at: a.at } : null,
    };
  });
}

export { levelOf as skillLevel };
