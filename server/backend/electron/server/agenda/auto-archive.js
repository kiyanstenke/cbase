// The agenda's sweep: a top-level point that has been finished for AGENDA_ARCHIVE_AFTER_MS goes to the archive by itself
// (operation `archive`, by "auto") — the main agent archives deeper subtrees or sooner with the same operation. It runs on the
// SERVER RUN (server.js: once shortly after the start, then hourly), through the ONE write path (change.js changeAgenda,
// originator "server"): same transaction, same event, the rail follows.
//
// When a point counts as finished since: the latest `doneAt` of its leaves; a leaf without one (older rows) counts from its
// `changedAt` — a legacy agenda gets cleaned up on the first sweep instead of waiting another week. A subtree that came back from
// the archive (`restoredAt` on any of its points) stays for AGENDA_ARCHIVE_AFTER_MS from then on. An archived chat, a chat that
// keeps no agenda: the store refuses, the sweep skips it.

import process from "node:process";
import * as store from "../store.js";
import { changeAgenda } from "./change.js";

export const AGENDA_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const agendaSweepTickMs = () => Number(process.env.CBASE_AGENDA_SWEEP_MS) || 60 * 60 * 1000;
export const agendaSweepFirstMs = () => Number(process.env.CBASE_AGENDA_SWEEP_FIRST_MS) || 60 * 1000;

/** The top-level points of an agenda the sweep archives now — their ids, in order. Pure, exported for tests. */
export function dueForArchive(agenda, now, after = AGENDA_ARCHIVE_AFTER_MS) {
  const points = agenda?.steps || [];
  const tree = store.agendaTree(points);
  const due = [];
  for (let i = 0; i < points.length; i++) {
    if (tree[i].depth !== 0 || tree[i].status !== "done") continue;
    let j = i + 1;
    while (j < points.length && tree[j].depth > 0) j += 1;
    const block = points.slice(i, j);
    const kids = new Set(block.map((p) => p.parent).filter(Boolean));
    const since = Math.max(0, ...block.filter((p) => !kids.has(p.id)).map((p) => Number(p.doneAt) || Number(p.changedAt) || 0));
    const restored = Math.max(0, ...block.map((p) => Number(p.restoredAt) || 0));
    if (since && now - since >= after && now - restored >= after) due.push(points[i].id);
  }
  return due;
}

/** One pass over every agenda — → the number of archived subtrees. Never throws (a broken chat must not stop the others). */
export function sweepAgendaArchive({ now = Date.now() } = {}) {
  let n = 0;
  for (const chatId of store.agendaChatIds()) {
    try {
      const ids = dueForArchive(store.readAgenda(chatId), now);
      if (!ids.length) continue;
      const chat = store.getChat(chatId);
      if (!chat || !store.chatKeepsAgenda(chat) || chat.archivedAt) continue;
      const r = changeAgenda(chatId, chat.workspaceId, { steps: ids.map((id) => ({ op: "archive", id })) }, { now, originator: "server", by: "auto" });
      n += r.archived.length;
    } catch (e) {
      console.error(`[agenda] sweep ${chatId}:`, e?.message || e);
    }
  }
  return n;
}
