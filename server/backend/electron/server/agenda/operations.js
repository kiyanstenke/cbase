// The computation of an agenda change — PURE: no database, no clock (time comes in as `now`), no stream. The agenda is a TREE
// (top-level topics such as issues or features, with subcategories below). `applyOps(alt, input, now, { projects })` takes the
// current agenda and the body of PUT /api/chats/:id/agenda (tool cbase_agenda_write) and returns the new one — or throws
// `AgendaError` with one sentence for the model. All or nothing: the operations run on a copy, and only the whole goes to the
// database (store/agenda.js agendaChange, one transaction). `projects` = the workspace's projects (`[{ id, name }]` or ids) —
// the route resolves them, pure stays pure; `null`/missing means UNKNOWN (not "none"), and giving a project is then an error.
//
// The body:
//   title?        string — replaces the title ("" clears it); line breaks become spaces
//   description?  string — replaces the description ENTIRELY ("" clears it); Markdown, lines stay
//   steps?        list of operations, applied in order (the items are a flat list in PREORDER, store/agenda.js):
//                   { op: "fresh", text, note?, status?, under?, after?, project? }
//                   { op: "change", id, text?, note?, status?, project? }       at least one of the four
//                   { op: "move", id, under?, after? }                          the whole subtree moves along
//                   { op: "erase", id }                                         the whole subtree goes along
//                   { op: "arrange", under?, ids: [EVERY child of this parent] }
//                   { op: "archive", id }                                       a FINISHED subtree leaves the tree for the archive
//                   { op: "restore", id }                                       an archived subtree comes back to its old place
//   Where an item goes (fresh, move): `under` = the parent item, the top level if not given; `after` = the sibling it follows
//   (including that sibling's subtree), or "beginning", the end of the siblings if not given. With `under`, `after` must be a
//   child of `under`; WITHOUT `under`, `after` sets the level (the item goes behind `after`, on its level) — so an
//   "after: s7" keeps its meaning from when the agenda was flat, and a model that sends `under` as null moves nothing to the
//   top by accident.
// `null` on a field means "not given" (models like to send unused fields as null); if all three fields are missing, that is
// NOT a statement but an error (a missing field is no statement).
//
// The caps (AGENDA_CAP) say in the error text that they are caps and name their number — an agenda that cut silently could
// not be told from a complete one. The text cap (80) applies only to texts SENT: a longer one from the flat agenda stays until
// the model changes it.

import { AGENDA_STATUS, agendaTree, agendaPreorder } from "../store.js";
import { T } from "../i18n.js";

// `points` counts the ACTIVE tree only — the archive (store/agenda.js chat_agenda_archive) is unbounded.
export const AGENDA_CAP = Object.freeze({ title: 120, description: 8000, points: 500, text: 80, note: 2000 });
export const AGENDA_OPERATIONS = Object.freeze(["fresh", "change", "move", "erase", "arrange", "archive", "restore"]);

// `code` names the kind of error for the keeper's write path (agenda/upkeep.js turns it into a status through
// AGENDA_UPKEEP_CODES); without it, it is an error of the computation itself (400).
export class AgendaError extends Error {
  constructor(text, code = null) {
    super(text);
    this.name = "AgendaError";
    this.code = code;
  }
}

const given = (v) => v !== undefined && v !== null;
// An id given (under, after): null and "" mean "not given".
const idGiven = (v) => given(v) && v !== "";
// Line breaks of every kind — including the Unicode separators U+2028/U+2029, which would otherwise carry a title onto several
// lines of the turn block's title line.
const singleLine = (s) => s.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
// Characters as the model sees them: code points, not UTF-16 units (an emoji is ONE character, not two).
const character = (s) => [...s].length;

function string(v, where) {
  if (typeof v !== "string") throw new AgendaError(T`${where} must be a string — nothing written.`);
  return v;
}

function cap(value, field, where, word) {
  const max = AGENDA_CAP[field];
  const n = character(value);
  if (n > max) {
    throw new AgendaError(T`Cap: ${where} holds at most ${max.toLocaleString(T("en-US##locale"))} characters (sent: ${n.toLocaleString(T("en-US##locale"))}) — ${word}; nothing written.`);
  }
  return value;
}

function status(v, where) {
  if (!AGENDA_STATUS.includes(v)) throw new AgendaError(T`${where}: unknown status ${JSON.stringify(v)} — allowed are ${AGENDA_STATUS.join(", ")}; nothing written.`);
  return v;
}

const pointText = (v, where) => {
  const t = singleLine(string(v, where));
  if (!t) throw new AgendaError(T`${where} is empty — an item needs a heading; nothing written.`);
  return cap(t, "text", where, T("an item is a heading, details belong in its note"));
};
const pointNote = (v, where) => cap(string(v, where).trim(), "note", where, T("shorten the note, larger content belongs in the description or in sub-items"));

function idList(ids) {
  return ids.length ? ids.join(", ") : "(no)";
}

// The workspace's projects as `[{ id, name }]` — ids alone are allowed (then without names); `null` stays unknown.
function projectList(projects) {
  if (projects instanceof Map) return [...projects].map(([id, name]) => ({ id: String(id), name: String(name ?? "") }));
  if (!Array.isArray(projects)) return null;
  return projects.map((p) => (typeof p === "string" ? { id: p, name: "" } : { id: String(p?.id ?? ""), name: String(p?.name ?? "") })).filter((p) => p.id);
}

/**
 * A project by id or name (case-insensitive) — `{ project: { id, name } }` or `{ error: "…" }`. The same resolution for
 * writing (`project` on fresh/change) and for the read filter (`?project=`, agenda/routes.js). A name that occurs twice is an
 * error, not a choice.
 */
export function findProject(value, projects) {
  const list = projectList(projects);
  if (!list) return { error: T("the projects of this workspace are not known") };
  const v = String(value ?? "").trim();
  const perId = list.find((p) => p.id === v);
  if (perId) return { project: perId };
  const small = v.toLowerCase();
  const perName = list.filter((p) => p.name && p.name.toLowerCase() === small);
  if (perName.length === 1) return { project: perName[0] };
  const existing = list.length ? list.map((p) => (p.name ? `${p.name} (${p.id})` : p.id)).join(", ") : "(no)";
  if (perName.length > 1) return { error: T`the project name “${v}” is ambiguous — give the id; existing: ${existing}` };
  return { error: T`unknown project “${v}” — existing: ${existing}` };
}

// The projects as a map id → name (for the response); unknown ⇒ empty (then no item carries a project label).
function projectNames(projects) {
  return new Map((projectList(projects) || []).map((p) => [p.id, p.name]));
}

/**
 * The new agenda according to `input` — `{ title, description, steps, nextSeq, deleted, archive, restore, archived, restored }`
 * (`deleted` = the ids of all items an `erase` took along; `archive` = the entries for the archive table, `restore` = the ids of
 * the archive entries that came back — both written by store.agendaChange in the same transaction; `archived`/`restored` = the
 * root ids, for the response). Throws `AgendaError`; `alt` stays untouched.
 * `archiveEntryOf(id)` = the archive entry holding point `id` (store.agendaArchiveEntryOf) — the computation stays pure, the
 * caller reads; without it `restore` is an error. `by` = who archives ("main", or "auto" for the sweep).
 */
export function applyOps(old, input, now, { projects = null, archiveEntryOf = null, by = "main" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgendaError(T("The body must be an object — nothing written."));
  if (!given(input.title) && !given(input.description) && !given(input.steps)) {
    throw new AgendaError(T("Nothing to change: give title, description or steps — nothing written."));
  }
  let title = old.title || "";
  let description = old.description || "";
  let nextSeq = Math.max(1, Number(old.nextSeq) || 1);
  // Copies — the operations change item by item, and an error halfway must not have touched `alt`.
  let points = (old.steps || []).map((s) => ({ ...s, parent: s.parent ?? null, projectId: s.projectId ?? null }));
  const deleted = [];
  const archive = [];
  const restore = [];
  const archived = [];
  const restored = [];
  // Does this project still exist in the workspace? Unknown projects (`projects` missing) count as alive — no silent assumption.
  const known = projectList(projects);
  const projectAlive = (id) => !known || known.some((p) => p.id === id);

  if (given(input.title)) title = cap(singleLine(string(input.title, "title")), "title", T("the title"), T("shorten it"));
  if (given(input.description)) {
    description = cap(string(input.description, "description").trim(), "description", T("the description"), T("make it more concise (goal, plan, context), details belong in the items' notes or in artifacts"));
  }

  // The subtree from index k: [k, end) — in preorder the contiguous run behind k whose parents lie in the subtree.
  const subtreeEnd = (k) => {
    const ids = new Set([points[k].id]);
    let j = k + 1;
    while (j < points.length && ids.has(points[j].parent)) { ids.add(points[j].id); j += 1; }
    return j;
  };
  const children = (parent) => points.filter((p) => p.parent === parent).map((p) => p.id);
  const level = (parent) => (parent === null ? T("of the top level") : T`of “${parent}”`);

  if (given(input.steps)) {
    if (!Array.isArray(input.steps)) throw new AgendaError(T("steps must be a list of operations — nothing written."));
    input.steps.forEach((op, i) => {
      const where = T`steps[${i}]`;
      if (!op || typeof op !== "object" || Array.isArray(op)) throw new AgendaError(T`${where} must be an object with op — nothing written.`);
      const kind = op.op;
      const error = (text) => new AgendaError(T`${where} (${kind}): ${text}; nothing written.`);
      const find = (id, field = "id") => {
        if (typeof id !== "string" || !id) throw new AgendaError(T`${where} (${kind}): ${field} is missing — nothing written.`);
        const k = points.findIndex((s) => s.id === id);
        if (k < 0) throw new AgendaError(T`${where} (${kind}): unknown id “${id}” — existing: ${idList(points.map((s) => s.id))}; nothing written.`);
        return k;
      };
      const projectOf = (value) => {
        const r = findProject(string(value, T`${where} (${kind}): project`), projects);
        if (r.error) throw error(r.error);
        return r.project.id;
      };
      // Where to (fresh, move): the parent item and the sibling before — `except` = the subtree being moved.
      const target = (except = new Set()) => {
        let parent = null;
        if (idGiven(op.under)) {
          find(op.under, "under");
          if (except.has(op.under)) throw error(T`“${op.id}” cannot go under “${op.under}” — that lies in its own subtree`);
          parent = op.under;
        }
        const following = idGiven(op.after) ? op.after : null;
        if (following !== null && following !== "beginning") {
          const k = find(following, "after");
          if (except.has(following)) throw error(T`after “${following}” lies in the subtree being moved`);
          const afterParent = points[k].parent;
          if (idGiven(op.under) && afterParent !== parent) {
            throw error(T`after “${following}” is not a child of “${parent}” — there are: ${idList(children(parent))}`);
          }
          parent = afterParent;
        }
        return { parent, following };
      };
      // The insertion point in the list (already shortened by the subtree being moved).
      const place = ({ parent, following }) => {
        if (following === "beginning") return parent === null ? 0 : points.findIndex((p) => p.id === parent) + 1;
        if (following !== null) return subtreeEnd(points.findIndex((p) => p.id === following));
        return parent === null ? points.length : subtreeEnd(points.findIndex((p) => p.id === parent));
      };

      if (kind === "fresh") {
        const st = given(op.status) ? status(op.status, `${where} (fresh)`) : "open";
        const whereTo = target();
        let projectId = null;
        if (given(op.project) && op.project !== "") {
          if (whereTo.parent !== null) throw error(T`project only on top-level items — this item would go under “${whereTo.parent}”`);
          projectId = projectOf(op.project);
        }
        const s = {
          id: `s${nextSeq}`,
          parent: whereTo.parent,
          text: pointText(op.text ?? "", `${where} (fresh): text`),
          note: given(op.note) ? pointNote(op.note, T`${where} (fresh): the note`) : "",
          status: st,
          projectId,
          createdAt: now,
          changedAt: now,
          doneAt: st === "done" ? now : null,
        };
        nextSeq += 1;
        points.splice(place(whereTo), 0, s);
      } else if (kind === "change") {
        const k = find(op.id);
        if (!given(op.text) && !given(op.note) && !given(op.status) && !given(op.project)) {
          throw new AgendaError(T`${where} (change): nothing to change — give text, note, status or project; nothing written.`);
        }
        const s = points[k];
        const n = { ...s };
        if (given(op.text)) n.text = pointText(op.text, `${where} (change): text`);
        if (given(op.note)) n.note = pointNote(op.note, T`${where} (change): the note`);
        if (given(op.status)) {
          status(op.status, `${where} (change)`);
          const under = children(s.id);
          if (under.length) throw error(T`“${s.id}” has sub-items — its status is computed from the sub-items; check those off (${idList(under)})`);
          n.status = op.status;
        }
        if (given(op.project)) {
          if (op.project === "") n.projectId = null;
          else if (s.parent !== null) throw error(T`project only on top-level items — “${s.id}” sits under “${s.parent}”`);
          else n.projectId = projectOf(op.project);
        }
        if (n.text !== s.text || n.note !== s.note || n.status !== s.status || n.projectId !== s.projectId) n.changedAt = now;
        if (n.status === "done") n.doneAt = s.status === "done" ? (s.doneAt || now) : now;
        else n.doneAt = null;
        points[k] = n;
      } else if (kind === "move") {
        const k = find(op.id);
        const end = subtreeEnd(k);
        const migrates = new Set(points.slice(k, end).map((p) => p.id));
        const whereTo = target(migrates);
        const pid = points[k].projectId;
        // Only a project that still exists in the workspace keeps the item on top: the response does not show a deleted (or
        // foreign) one (agendaResponse ⇒ null), and a refusal "carries a project" would contradict what the model sees — it
        // drops on the move.
        if (whereTo.parent !== null && pid && projectAlive(pid)) {
          throw error(T`“${op.id}” carries a project and must not go under another item — remove it first (change with project: "")`);
        }
        const block = points.splice(k, end - k);
        block[0] = { ...block[0], parent: whereTo.parent, projectId: whereTo.parent === null ? pid : null };
        points.splice(place(whereTo), 0, ...block);
      } else if (kind === "erase") {
        const k = find(op.id);
        deleted.push(...points.splice(k, subtreeEnd(k) - k).map((p) => p.id));
      } else if (kind === "arrange") {
        if (!Array.isArray(op.ids) || op.ids.some((x) => typeof x !== "string")) throw new AgendaError(T`${where} (arrange): ids must be a list of ids — nothing written.`);
        let parent = null;
        if (idGiven(op.under)) { find(op.under, "under"); parent = op.under; }
        const found = children(parent);
        const duplicate = op.ids.filter((x, j) => op.ids.indexOf(x) !== j);
        const unknown = op.ids.filter((x) => !found.includes(x));
        const missing = found.filter((x) => !op.ids.includes(x));
        if (duplicate.length || unknown.length || missing.length) {
          const parts = [
            ...(duplicate.length ? [T`duplicate: ${idList([...new Set(duplicate)])}`] : []),
            ...(unknown.length ? [T`not a child: ${idList(unknown)}`] : []),
            ...(missing.length ? [T`missing: ${idList(missing)}`] : []),
          ];
          throw new AgendaError(T`${where} (arrange): ids must name EVERY child ${level(parent)} exactly once (${parts.join("; ")}) — there are: ${idList(found)}; nothing written.`);
        }
        // The children with their subtrees as blocks, in the new order in place of the old range.
        const beginning = parent === null ? 0 : points.findIndex((p) => p.id === parent) + 1;
        const areaEnd = parent === null ? points.length : subtreeEnd(beginning - 1);
        const blocks = new Map();
        for (let j = beginning; j < areaEnd;) {
          const e = subtreeEnd(j);
          blocks.set(points[j].id, points.slice(j, e));
          j = e;
        }
        points.splice(beginning, areaEnd - beginning, ...op.ids.flatMap((x) => blocks.get(x)));
      } else if (kind === "archive") {
        const k = find(op.id);
        const tree = agendaTree(points);
        if (tree[k].status !== "done") {
          throw error(T`“${op.id}” is not finished (${tree[k].status}) — only a subtree whose items are all done goes to the archive`);
        }
        const parent = points[k].parent ?? null;
        const siblings = children(parent);
        const before = siblings[siblings.indexOf(op.id) - 1] ?? null;
        const block = points.splice(k, subtreeEnd(k) - k);
        const withKids = new Set(block.map((p) => p.parent).filter(Boolean));
        const leaves = block.filter((p) => !withKids.has(p.id));
        const doneAt = Math.max(0, ...leaves.map((p) => Number(p.doneAt) || Number(p.changedAt) || 0)) || null;
        // A parent left without children holds its STORED status again (store/agenda.js) — all its children were done, so it is.
        if (parent !== null && !points.some((p) => p.parent === parent)) {
          const e = points.findIndex((p) => p.id === parent);
          if (points[e].status !== "done") points[e] = { ...points[e], status: "done", doneAt: doneAt || now };
        }
        archive.push({ rootId: op.id, parentId: parent, afterId: before, text: block[0].text, points: block, leaves: leaves.length, doneAt, by });
        archived.push(op.id);
      } else if (kind === "restore") {
        if (typeof op.id !== "string" || !op.id) throw new AgendaError(T`${where} (restore): id is missing — nothing written.`);
        const entry = typeof archiveEntryOf === "function" ? archiveEntryOf(op.id) : null;
        if (!entry || restore.includes(entry.id)) {
          throw error(T`“${op.id}” is not in the archive — read it with cbase_agenda (archive: true or search)`);
        }
        const clash = entry.points.filter((p) => points.some((q) => q.id === p.id)).map((p) => p.id);
        if (clash.length) throw error(T`the ids ${idList(clash)} already stand in the agenda`);
        // Its old place: under the old parent if it still stands, behind the old sibling if that still stands there — otherwise
        // at the end of that level (or the top level).
        const parent = entry.parentId && points.some((p) => p.id === entry.parentId) ? entry.parentId : null;
        const after = entry.afterId && points.some((p) => p.id === entry.afterId && (p.parent ?? null) === parent) ? entry.afterId : null;
        const following = after ?? (entry.afterId === null && parent === entry.parentId ? "beginning" : null);
        const block = entry.points.map((p) => ({ ...p }));
        block[0] = { ...block[0], parent, projectId: parent === null ? (block[0].projectId ?? null) : null, restoredAt: now };
        points.splice(place({ parent, following }), 0, ...block);
        restore.push(entry.id);
        restored.push(entry.rootId);
      } else {
        throw new AgendaError(T`${where}: unknown op ${JSON.stringify(kind)} — allowed are ${AGENDA_OPERATIONS.join(", ")}; nothing written.`);
      }
      // The invariant after EVERY operation (store/agenda.js agendaPreorder — the same rule the reader repairs by): a
      // computation that would break it writes nothing.
      const { defects } = agendaPreorder(points);
      if (defects.length) throw error(T`the tree's order would be violated (${defects.join("; ")})`);
    });
  }

  if (points.length > AGENDA_CAP.points) {
    throw new AgendaError(T`Cap: an agenda holds at most ${AGENDA_CAP.points} items (it would be ${points.length}) — archive finished subtrees (op archive) or merge items; nothing written.`);
  }
  return { title, description, steps: points, nextSeq, deleted, archive, restore, archived, restored };
}

// ── The agenda keeper ────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Three writers go through the same transaction (agenda/change.js): the main agent (`main`, full set), the server as driver
// (`server`, the review gate) and the keeper (`keeper`, a built-in outer-loop agent). The keeper may ONLY bring the agenda up
// to date: create items, set a leaf's status forward, set title and description while they are empty. All checks run INSIDE
// the transaction against `alt` — a decision on an old state is caught by `base` (STALE), never by a clock. The mark STAYS
// when another writer touches the item afterwards (the ring stays); what happened afterwards is told by its explanation from
// the log (upkeepAfterwards). Only a later change by the keeper itself replaces it. The main agent closes the item's open log
// rows (confirmed/corrected), locks a reverted stage against the keeper (`upkeepLock`, no ping-pong) and turns a row whose
// stage it reaches itself into ITS OWN decision (outdated — it never locks again).
//
// Pure like the rest: the standing log rows come in as an argument (`rows`), writing happens in change.js. The outcome is
// computed per ROW, never per item (two runs on the same item — "open → in_work", then "in_work → done" — would otherwise
// both count as corrected when the main agent took back only the second stage), and it is measured against the stage of the
// KEEPER's row, never against the state in `alt` (the server, which closes no row, may have set that in between).

/** The keeper's codes and their HTTP status. `INVALID` = an error of the computation itself (unknown id, cap …). */
export const AGENDA_UPKEEP_CODES = Object.freeze({
  STALE: 409, REVERTED: 409, NOT_ALLOWED: 400, BACKWARD: 400, NO_SHEET: 400, NOT_EMPTY: 400, INVALID: 400,
});
/** The keeper's operations (tool cbase_agenda_maintain) — `status` is mapped to `change { id, status }`. */
export const AGENDA_UPKEEP_OPERATIONS = Object.freeze(["fresh", "status"]);
const UPKEEP_FIELDS = Object.freeze({ fresh: ["op", "text", "note", "status", "under", "after", "project"], status: ["op", "id", "status"] });
const stage = (st) => AGENDA_STATUS.indexOf(st);

/**
 * The keeper's input, checked against `alt` and mapped to the operations of `applyOps` — or an `AgendaError` with a code
 * (then nothing is written). `base` = the version the keeper read.
 */
export function upkeepInput(old, input, { base } = {}) {
  const no = (code, text) => new AgendaError(T`${text} — nothing written.`, code);
  if (!Number.isInteger(base) || base < 0) throw no("INVALID", T("base must be the version you read (integer ≥ 0)"));
  // The text does NOT name the current number: a model that took it from the refusal would write against a state it never
  // read — and `base` would no longer catch a decision on an old state. Only cbase_agenda delivers the number
  // (mcp/tools/agenda.js, `agenda.version`).
  if (base !== (Number(old.version) || 0)) {
    throw new AgendaError(T("The agenda has changed since you read it — read it again with cbase_agenda; nothing written."), "STALE");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw no("INVALID", T("The body must be an object"));
  const out = {};
  for (const [field, word] of [["title", T("the title##object")], ["description", T("the description")]]) {
    if (!given(input[field])) continue;
    if (String(old[field] || "").trim()) throw no("NOT_EMPTY", T`${field} is already set — the keeper sets ${word} only while the field is empty`);
    out[field] = input[field];
  }
  if (!given(input.steps)) return out;
  if (!Array.isArray(input.steps)) throw no("INVALID", T("steps must be a list of operations"));
  const points = old.steps || [];
  const byId = new Map(points.map((p) => [p.id, p]));
  const withChildren = new Set(points.map((p) => p.parent).filter(Boolean));
  const state = new Map(points.map((p) => [p.id, p.status]));
  out.steps = input.steps.map((op, i) => {
    const where = T`steps[${i}]`;
    if (!op || typeof op !== "object" || Array.isArray(op)) throw no("INVALID", T`${where} must be an object with op`);
    const kind = op.op;
    if (!AGENDA_UPKEEP_OPERATIONS.includes(kind)) {
      throw no("NOT_ALLOWED", T`${where}: op ${JSON.stringify(kind ?? null)} is not allowed for the keeper — it only brings the agenda up to date (fresh, status); deleting, moving, arranging and changing text or note of existing items stay with the main agent`);
    }
    const unknown = Object.keys(op).filter((k) => !UPKEEP_FIELDS[kind].includes(k) && given(op[k]));
    if (unknown.length) throw no("NOT_ALLOWED", T`${where} (${kind}): fields not allowed: ${unknown.join(", ")} — allowed are ${UPKEEP_FIELDS[kind].join(", ")}`);
    if (kind === "fresh") {
      // `under` on an item that was a LEAF when read would make it a parent — from then on its status would be computed from
      // the new child without any of the `status` checks applying (backward as well as past a lock). An item this call creates
      // itself may become a parent (it is not in `alt`).
      if (idGiven(op.under) && byId.has(op.under) && !withChildren.has(op.under)) {
        throw no("NO_SHEET", T`${where} (fresh): “${op.under}” has no sub-items — a new item below it would make it a parent whose status would then be computed from the new item; the keeper creates new items only under an item that already has sub-items, or on the top level`);
      }
      return Object.fromEntries(UPKEEP_FIELDS.fresh.filter((k) => given(op[k])).map((k) => [k, op[k]]));
    }
    // status: only on a leaf that already existed when read, only forward, never again to a stage that was taken back.
    const id = op.id;
    if (typeof id !== "string" || !byId.has(id)) {
      throw no("INVALID", T`${where} (status): unknown id ${JSON.stringify(id ?? null)} — you set status only on items that already existed when you read (a new item you create with its status right away); existing: ${idList(points.map((p) => p.id))}`);
    }
    if (!AGENDA_STATUS.includes(op.status)) throw no("INVALID", T`${where} (status): unknown status ${JSON.stringify(op.status ?? null)} — allowed are ${AGENDA_STATUS.join(", ")}`);
    if (withChildren.has(id)) throw no("NO_SHEET", T`${where} (status): “${id}” has sub-items — its status is computed from them`);
    if (stage(op.status) < stage(state.get(id))) {
      throw no("BACKWARD", T`${where} (status): “${id}” is at ${state.get(id)} — the keeper only sets forward (open → in_work → done), setting back stays with the main agent`);
    }
    const lock = byId.get(id).upkeepLock;
    if (lock && stage(op.status) >= stage(lock)) {
      throw no("REVERTED", T`${where} (status): the main agent took “${id}” back from ${lock} — do not set it to ${op.status} again`);
    }
    state.set(id, op.status);
    return { op: "change", id, status: op.status };
  });
  return out;
}

/**
 * The recheck AFTER `applyOps` for the keeper — the same computation as every response (store.agendaTree, the COMPUTED
 * status): the checks in `upkeepInput` see only the operation, not its effect on the tree. A new sub-item changes the computed
 * status of its ancestors — an open child under a fully done top-level item reopens it, the last done child sets a parent to
 * done. For EVERY item that was in `alt`:
 *   - its computed status does not go backward (400 BACKWARD — the keeper reopens nothing that is done);
 *   - it does not reach the stage of its `upkeepLock` if it only rises through this call (409 REVERTED). An item that was
 *     already at or above it in `alt` (a leftover lock — the main agent has since finished the item through sub-items) does
 *     not keep the keeper from every other change.
 * Throws `AgendaError` with a code (then nothing is written), otherwise nothing.
 */
export function recheckUpkeep(old, computation) {
  const prior = old.steps || [];
  const treePrior = agendaTree(prior);
  const state = new Map(prior.map((s, i) => [s.id, { status: treePrior[i].status, lock: s.upkeepLock || null }]));
  const after = computation.steps || [];
  const treeAfter = agendaTree(after);
  after.forEach((s, i) => {
    const a = state.get(s.id);
    if (!a) return;
    const n = treeAfter[i].status;
    if (stage(n) < stage(a.status)) {
      throw new AgendaError(T`“${s.id}” would then be at ${n} instead of ${a.status} — the keeper reopens nothing that is done and sets no item back, not even through a new sub-item; that stays with the main agent — nothing written.`, "BACKWARD");
    }
    if (a.lock && stage(n) > stage(a.status) && stage(n) >= stage(a.lock)) {
      throw new AgendaError(T`the main agent took “${s.id}” back from ${a.lock} — it would then be at ${n} again; the keeper does not put it back there through its sub-items either — nothing written.`, "REVERTED");
    }
  });
}

/**
 * After `applyOps` for the keeper: what changed (`changed` = `[{ pointId, kind, prior, after, stage }]` — for `fresh`, after is
 * the text, for `status` the stages, for title/description the values with pointId ""; `stage` = the stage at which the
 * keeper left the item: for `status` after, for `fresh` the new item's status, otherwise null — the main agent is measured
 * against it) and, if `mark`, the mark on every changed item. → `{ steps, changed }`.
 */
export function bringAlongUpkeep(old, computation, { agentId, runId, mark = true, now } = {}) {
  const oldById = new Map((old.steps || []).map((s) => [s.id, s]));
  const changed = [];
  for (const field of ["title", "description"]) {
    const prior = String(old[field] ?? "");
    const after = String(computation[field] ?? "");
    if (after !== prior) changed.push({ pointId: "", kind: field, prior, after, stage: null });
  }
  const steps = (computation.steps || []).map((s) => {
    const a = oldById.get(s.id);
    let g = null;
    if (!a) g = { pointId: s.id, kind: "fresh", prior: null, after: s.text, stage: s.status };
    else if (a.status !== s.status) g = { pointId: s.id, kind: "status", prior: a.status, after: s.status, stage: s.status };
    if (!g) return s;
    changed.push(g);
    if (!mark) return s;
    return { ...s, upkeep: { agentId: String(agentId), runId: String(runId), at: now, kind: g.kind, prior: g.kind === "status" ? g.prior : null } };
  });
  return { steps, changed };
}

/**
 * After `applyOps` for the main agent (`main`) and the server (`server`): the keeper's mark stays on every item (the ring
 * stays; its explanation reads the outcome from the log, upkeepAfterwards). Only for the main agent, computed from the chat's
 * STANDING log rows (`rows` = `[{ id, pointId, kind, after, stage, outcome, outdated }]`, outcome open or confirmed —
 * store.agendaUpkeepStanding):
 *   - the outcome PER OPEN ROW of a touched item — `status`: `corrected` if the computed status afterwards lies below its
 *     stage, otherwise `confirmed` (also on erase: that takes back no stage); `fresh`: `corrected` only if the item (alone or
 *     with a subtree) is erased, otherwise `confirmed`; title/description: `corrected` if the main agent changes the field,
 *     otherwise the row stays open. The FIRST outcome counts — a closed row stays as it is;
 *   - `upkeepLock` if it SETS an item's status and thereby falls below the stage of a standing row that is not outdated
 *     (open OR confirmed, `status` or `fresh` with a status): the LOWEST stage it fell below — that locks the most
 *     (open → in_work → done set twice and taken back to open: neither in_work nor done comes back). A standing lock stays
 *     until it sets that stage or a later one itself; a new one below replaces it;
 *   - `outdated`: if it SETS an item's status to the stage of such a row or further, that stage is its own decision from now
 *     on — the row never locks again, not even on a later reopening (keeper open → in_work, main agent done, later open ⇒
 *     otherwise a lock on in_work, and bringing the agenda up to date after a reopening would be lost). Its outcome stays as
 *     it is; a confirmation through text or note makes nothing outdated.
 *   It is measured against the stage of the keeper's row, never against the state in `alt`: the server (review gate) closes
 *   no row and may have set the status in between.
 * → `{ steps, touched, outdated }` (`touched` = `[{ id, outcome }]`, `outdated` = row ids — both for store.agendaUpkeepOutcome).
 */
export function bringAlongWriter(old, computation, input, { originator = "main", rows = [] } = {}) {
  const ops = Array.isArray(input?.steps) ? input.steps.filter((op) => op && typeof op === "object") : [];
  const touched = new Set([
    ...ops.filter((op) => ["change", "move", "erase"].includes(op.op) && typeof op.id === "string").map((op) => op.id),
    ...(computation.deleted || []),
    // An archived point is touched too (its log rows get an outcome) — and it still exists, only elsewhere.
    ...(computation.archive || []).flatMap((e) => (e.points || []).map((p) => p.id)),
  ]);
  const inArchive = new Set((computation.archive || []).flatMap((e) => (e.points || []).map((p) => p.id)));
  const main = originator === "main";
  const statusSet = new Set(ops.filter((op) => op.op === "change" && typeof op.id === "string" && given(op.status)).map((op) => op.id));
  const points = computation.steps || [];
  const tree = agendaTree(points);
  const computed = new Map(points.map((s, i) => [s.id, tree[i].status]));
  // The rows whose stage the keeper set per item and that still count for a lock (a corrected row does not lock anew, an
  // outdated one never again).
  const rowsPerPoint = new Map();
  for (const z of rows) {
    if (z.outdated || !z.pointId || !AGENDA_STATUS.includes(z.stage)) continue;
    if (!rowsPerPoint.has(z.pointId)) rowsPerPoint.set(z.pointId, []);
    rowsPerPoint.get(z.pointId).push(z);
  }
  const outdated = [];
  const steps = points.map((s) => {
    // The mark `upkeep` goes along unchanged (the ring stays) — only the lock is decided here, and only where the main agent
    // sets the status.
    if (!main || !statusSet.has(s.id)) return s;
    const now = stage(computed.get(s.id));
    let lock = s.upkeepLock && now < stage(s.upkeepLock) ? s.upkeepLock : null;
    for (const z of rowsPerPoint.get(s.id) || []) {
      if (stage(z.stage) <= now) outdated.push(z.id);
      else if (!lock || stage(z.stage) < stage(lock)) lock = z.stage;
    }
    const { upkeepLock: _so_far, ...without } = s;
    return lock ? { ...without, upkeepLock: lock } : without;
  });
  const touched2 = [];
  if (main) {
    const stays = new Set(points.map((s) => s.id));
    for (const z of rows) {
      if (z.outcome !== "open") continue;
      if (!z.pointId) {
        if ((z.kind === "title" || z.kind === "description") && String(computation[z.kind] ?? "") !== String(old[z.kind] ?? "")) {
          touched2.push({ id: z.id, outcome: "corrected" });
        }
        continue;
      }
      if (!touched.has(z.pointId)) continue;
      const found = stays.has(z.pointId) || inArchive.has(z.pointId);
      const corrected = z.kind === "fresh" ? !found : found && stage(computed.get(z.pointId)) < stage(z.stage);
      touched2.push({ id: z.id, outcome: corrected ? "corrected" : "confirmed" });
    }
  }
  return { steps, touched: touched2, outdated };
}

// An agenda's leaves (items without sub-items) — only they carry a status of their own.
function sheets(agenda) {
  const points = agenda?.steps || [];
  const withChildren = new Set(points.map((s) => s.parent).filter(Boolean));
  return points.filter((s) => !withChildren.has(s.id));
}

/** How many LEAVES per status — `{ open, in_work, done }` (a parent item does not count, its status is computed). */
export function agendaCounter(agenda) {
  const z = { open: 0, in_work: 0, done: 0 };
  for (const s of sheets(agenda)) if (Object.hasOwn(z, s.status)) z[s.status] += 1;
  return z;
}

/** What is up next: the first leaf in work, otherwise the first open one — or null. */
export function nextStep(agenda) {
  const b = sheets(agenda);
  const s = b.find((x) => x.status === "in_work") || b.find((x) => x.status === "open");
  return s ? { id: s.id, text: s.text, status: s.status } : null;
}

/** Only the subtrees whose top-level item carries this project (the read filter `project`) — the agenda otherwise unchanged. */
export function onlyProject(agenda, projectId) {
  const out = [];
  let inside = false;
  for (const s of agenda?.steps || []) {
    if ((s.parent ?? null) === null) inside = s.projectId === projectId;
    if (inside) out.push(s);
  }
  return { ...agenda, steps: out };
}

/** What happened after an item was marked: `open` (nobody has touched it since, or only the server), `confirmed` (the main
 *  agent worked on it), `corrected` (it took the stage back), `outdated` (it set the stage itself afterwards — takes
 *  precedence over the outcome, it describes the more recent state). */
export const AGENDA_UPKEEP_AFTERWARDS = Object.freeze(["open", "confirmed", "corrected", "outdated"]);

/**
 * The outcome of the log row that belongs to the mark `marker` on item `pointId` — the same change: run, item, kind and time
 * (mark and row arise in the same transaction with the same `now`, agenda/change.js). `rows` = store.agendaUpkeepHistory.
 * Without a matching row `null` — UNKNOWN (say: the agent deleted along with its log), not "nothing happened".
 */
export function upkeepAfterwards(marker, pointId, rows) {
  if (!marker || !Array.isArray(rows)) return null;
  // Run, item, kind and time determine EXACTLY one row (one call writes at most one change per item).
  const z = rows.find((r) => r.pointId === pointId && r.runId === marker.runId && r.kind === marker.kind && Number(r.at) === Number(marker.at));
  if (!z) return null;
  if (z.outdated) return "outdated";
  return AGENDA_UPKEEP_AFTERWARDS.includes(z.outcome) ? z.outcome : null;
}

/**
 * The agenda as it goes out (route, stream, tool — the contract for web and iOS): without the internal id counter, with the
 * counters per status (leaves only) and per item in preorder `{ id, parent, depth, text, note, status, subitems, done, total,
 * project, createdAt, changedAt, doneAt, upkeep }` — `status` on an item with sub-items is computed (store/agenda.js
 * agendaTree), `project` resolved at read time from `projects` (a deleted project ⇒ null), `upkeep.afterwards` from
 * `upkeepRows` (store.agendaUpkeepHistory; without them `null` = unknown — read through agenda/change.js agendaView); `archived` = the
 * number of archive entries.
 */
export function agendaResponse(a, projects = null, { upkeepRows = null, archived = 0 } = {}) {
  const points = a.steps || [];
  const tree = agendaTree(points);
  const names = projectNames(projects);
  return {
    chatId: a.chatId,
    title: a.title,
    description: a.description,
    steps: points.map((s, i) => {
      const b = tree[i];
      const parent = s.parent ?? null;
      const project = parent === null && s.projectId && names.has(s.projectId) ? { id: s.projectId, name: names.get(s.projectId) } : null;
      return {
        id: s.id, parent, depth: b.depth, text: s.text, note: s.note, status: b.status,
        subitems: b.subitems, done: b.done, total: b.total, project,
        createdAt: s.createdAt, changedAt: s.changedAt, doneAt: b.doneAt,
        // The agenda keeper's mark (display only) with `afterwards` — `upkeepLock` does NOT go out, it is internal to the
        // server.
        upkeep: s.upkeep ? { ...s.upkeep, afterwards: upkeepAfterwards(s.upkeep, s.id, upkeepRows) } : null,
      };
    }),
    version: a.version,
    changedAt: a.changedAt,
    counter: agendaCounter(a),
    // How many finished subtrees lie in the archive (store.agendaArchiveCount) — the clients show "Archive (n)".
    archived: Number(archived) || 0,
  };
}

// ── Reading views ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The agenda as the AGENT reads it by default (cbase_agenda, the turn block, other chats): only what is not finished. A point
// stays if its COMPUTED status is not done — a parent with one open leaf stays (with its done/total), its done children fall.
// Preorder holds: an unfinished point's parent is unfinished too. The clients get the full tree and hide on their own (the
// toggle "n done"). `hidden.done` = finished LEAVES left out.

/** Only the unfinished points of an agenda IN ITS RESPONSE SHAPE (agendaResponse: `status` computed, `subitems` per point) —
 *  `{ agenda, hidden: { done } }`. Filtering the response keeps a parent's done/total those of its whole subtree. */
export function openOnly(view) {
  const points = view?.steps || [];
  const keep = points.filter((s) => s.status !== "done");
  const done = points.filter((s) => s.status === "done" && !s.subitems).length;
  return { agenda: { ...view, steps: keep }, hidden: { done } };
}

/** The subtree of point `id` (preorder, the root first) — or null if the point is not in `points`. */
export function subtreeOf(points, id) {
  const list = points || [];
  const k = list.findIndex((p) => p.id === id);
  if (k < 0) return null;
  const ids = new Set([id]);
  let j = k + 1;
  while (j < list.length && ids.has(list[j].parent)) { ids.add(list[j].id); j += 1; }
  return list.slice(k, j);
}

/** The cap of search hits — and the answer says when it cut (`more`). */
export const AGENDA_SEARCH_CAP = 50;

/**
 * Search the active points and the archive for `query` (case-insensitive, in text and note) — `{ hits, more }`, `cap` per source
 * (active, archive), hits in the
 * order active tree first, then the archive newest first: `{ id, text, status, path: [texts of the ancestors], archived, entryId, rootId }`.
 * `entries` = store.agendaArchive (each `{ id, points }`).
 */
export function searchAgenda(points, entries, query, { cap = AGENDA_SEARCH_CAP } = {}) {
  const q = String(query ?? "").trim().toLocaleLowerCase();
  if (!q) return { hits: [], more: false };
  // Each source has its own cap — a common word with many active hits must not crowd out the archive (the clients take the
  // archived hits from here and search the active tree themselves).
  const hits = [];
  let more = false;
  let taken = 0;
  const active = new Map((points || []).map((p) => [p.id, p]));
  const ancestors = (byId, id) => {
    const path = [];
    for (let e = byId.get(id); e; e = byId.get(e.parent)) path.unshift(e.text);
    return path;
  };
  const scan = (list, entryId, base = [], rootId = null) => {
    const tree = agendaTree(list);
    const byId = new Map(list.map((p) => [p.id, p]));
    list.forEach((p, i) => {
      if (!`${p.text}\n${p.note || ""}`.toLocaleLowerCase().includes(q)) return;
      if (taken >= cap) { more = true; return; }
      taken += 1;
      // An archived subtree's path begins where it hung in the active tree, as far as that still stands.
      const path = [...base, ...ancestors(byId, p.parent)];
      hits.push({ id: p.id, text: p.text, status: tree[i].status, path, archived: entryId !== null, ...(entryId !== null ? { entryId, rootId } : {}) });
    });
  };
  scan(points || [], null);
  taken = 0;
  for (const e of entries || []) scan(e.points || [], e.id, e.parentId ? ancestors(active, e.parentId) : [], e.rootId ?? e.points?.[0]?.id ?? null);
  return { hits, more };
}
