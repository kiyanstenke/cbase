// The first turn after a compaction: what Claude Code attaches to the session after the summary (files, background work, skills;
// wordings and numbers runs/compaction-baseline.js, selection runs/compaction-attachments.js), computed here from this chat's state.
// Called by doRun in the first turn after the compaction (the same question as the other preambles from the start of the session:
// `preambleResumed` is false) — the same text for all three providers.
//
// The background work is read NOW (runs/background.js), not at the marker: between compaction and turn an agent can have finished — the
// baseline also computes its attachments from the state at the moment of compaction, which in its case lies right before the turn.
// Files and skills stand at the marker (`attachments`, runs/post-run.js compactChatContext).
import * as store from "../store.js";
import { outputLocation } from "./outputs.js";
import { backgroundWork } from "./background.js";
import { liveMonitors } from "./monitors.js";
import { readFileForRun } from "./system-prompt.js";
import { fileAttachments, backgroundTexts, skillAttachment } from "./compaction-attachments.js";
import { attachmentFence } from "./compaction-baseline.js";

/** The `attachments` of the last compaction marker — null without a compaction since the last boundary (/clear). */
export function lastCompaction(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role === "clear") return null;
    if (r.role !== "meta") continue;
    try { const m = JSON.parse(r.text); if (m?.compacted) return m; } catch { /* another meta row */ }
  }
  return null;
}

/**
 * The fenced attachment for the first turn after the compaction, "" if there is nothing to attach.
 * `withFiles`: false for Codex (it reads through the shell — no call from which a path safely emerges; see compaction-attachments.js).
 * `instance`/`location`: instance and runtime location of the turn (read path of the files, output location of the monitors).
 */
export function afterCompactionAttachment(chat, { withFiles = true, instance = null, location } = {}) {
  try {
    const rows = store.listMessages(chat.id);
    const marker = lastCompaction(rows);
    const refs = marker?.attachments || { files: [], skills: [] };
    const texts = [];
    if (withFiles) texts.push(...fileAttachments(refs.files, { read: (p, max) => readFileForRun(p, instance, max) }));
    const monitors = new Map(liveMonitors(chat.id).map((m) => [m.taskId, m]));
    const work = backgroundWork(chat.id).map((a) => (a.kind === "monitor" ? { ...a, ...(monitors.get(a.taskId) || {}), kind: "monitor" } : a));
    let outputs = "";
    try { outputs = outputLocation(chat.id, location); } catch { /* without a location no log path */ }
    texts.push(...backgroundTexts(work, { outputLocation: outputs }));
    const skills = refs.skills?.length ? skillAttachment(refs.skills, new Map(rows.map((z) => [z.id, z]))) : "";
    if (skills) texts.push(skills);
    return attachmentFence(texts);
  } catch (e) {
    console.error("[after-compaction] attachment not computed:", chat?.id, e?.message || e);
    return "";
  }
}
