// The attachments after compaction — what Claude Code attaches to the session after a compaction (measured on the pinned binary,
// wordings and numbers in runs/compaction-baseline.js), transferred to cbase. A leaf: no DB, no process state — the caller hands
// in the history rows, the background work and the read path (runs/post-run.js at the compaction, runs/do-run.js in the first turn
// after it).
//
// In the order of the baseline:
//   1. FILES — the most recently read (the baseline: its read state, filled by Read, Edit, Write, … — and emptied after every
//      compaction and refilled with exactly the restored files). cbase: the calls of these tools in the main strand since the last
//      boundary, plus the files the previous compaction restored (at its marker) — at most FILES_MAX, newest first, without the
//      memory files (CLAUDE.md/AGENTS.md are in the system prompt), read fresh from disk, at most READ_ROWS_MAX lines each in the
//      form of Read ("<n>\t<line>"). Above FILE_TOKEN_MAX a reference instead of the content, together at most FILE_BUDGET (what no
//      longer fits drops out; a smaller one after it still fits).
//      Codex reads files through the shell — there is no call from which a path safely emerges, and the baseline does not count shell
//      commands into the read state either.
//   2. BACKGROUND WORK — one status (task_status) per running background agent and per running shell/monitor. In addition to the
//      baseline, the dynamic and graph workflows in the background (see workflowStatusText).
//   3. SKILLS — those loaded with cbase_skill (the baseline: invoked_skills), newest first, at most SKILL_TOKEN_MAX each (truncated
//      with a marker), together at most SKILL_BUDGET.
// What the baseline attaches otherwise and cbase does not: plan file and plan mode (cbase has no plan file), tool deltas, agent
// types, MCP instructions and environment (in cbase they are in every run's system prompt, a fresh session carries them anyway),
// the SessionStart hook (the CLI fires it itself in the fresh session), goal and cron carry-over (they show the model nothing —
// cbase's goal and wakeup live on in the server).
import path from "node:path";

import {
  FILES_MAX, FILE_BUDGET, FILE_TOKEN_MAX, READ_ROWS_MAX, SKILL_BUDGET, SKILL_TOKEN_MAX, CHARACTERS_PER_TOKEN,
  FILE_CALL, FILE_RESULT, FILE_TOO_LARGE, agentStatusText, truncateSkill, monitorStatusText, estimateTokens, skillsText,
  workflowStatusText,
} from "./compaction-baseline.js";

/** The tools that fill the read state, and their path field. */
export const READ_TOOLS = Object.freeze({ Read: "file_path", Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" });
/** The memory files — they are in the system prompt (runs/system-prompt.js MEMORY_FILE_NAMES) and are not restored. */
const MEMORY = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
const SKILL_TOOL = /(^|__)cbase_skill$/;

const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const time = (r) => Number(r?.ts) || 0;

/**
 * What the compaction records at its marker (`attachments`): the files and skills of the section, merged with those of the
 * previous marker. Pure.
 * @param {Array<Object>} rows  the history rows since the boundary (store.listMessages)
 * @param {{ files?: Array, skills?: Array }} [previous]  `attachments` of the previous marker
 * @returns {{ files: Array<{path:string, at:number}>, skills: Array<{name:string, row:number, at:number}> }}
 */
export function attachmentRefs(rows, previous = null) {
  const files = new Map();
  const skills = new Map();
  for (const d of Array.isArray(previous?.files) ? previous.files : []) if (d?.path) files.set(String(d.path), Number(d.at) || 0);
  for (const s of Array.isArray(previous?.skills) ? previous.skills : []) if (s?.name && s.row) skills.set(String(s.name), { row: Number(s.row), at: Number(s.at) || 0 });
  const openSkills = new Map(); // call id → { name, at }
  for (const r of rows || []) {
    if (r.role === "tool") {
      const b = json(r.text);
      if (!b || b.parent || !b.name) continue; // subagents have their own read state
      const field = READ_TOOLS[b.name];
      const p = field ? b.input?.[field] : null;
      if (typeof p === "string" && path.isAbsolute(p)) { files.delete(p); files.set(p, time(r)); }
      if (SKILL_TOOL.test(b.name) && b.id && typeof b.input?.name === "string") openSkills.set(b.id, { name: b.input.name, at: time(r) });
    } else if (r.role === "tool_result") {
      const b = json(r.text);
      const s = b?.id ? openSkills.get(b.id) : null;
      if (s && !b.isError) { skills.delete(s.name); skills.set(s.name, { row: r.id, at: s.at }); }
    }
  }
  return {
    // Only those the next compaction can restore (the baseline empties its read state and refills it with exactly these):
    // the newest FILES_MAX without the memory files.
    files: [...files].map(([filePath, at]) => ({ path: filePath, at }))
      .filter((d) => !MEMORY.has(path.basename(d.path)))
      .sort((a, b) => b.at - a.at).slice(0, FILES_MAX),
    skills: [...skills].map(([name, v]) => ({ name, row: v.row, at: v.at })),
  };
}

/** Read form: "<n>\t<line>" from 1, at most READ_ROWS_MAX lines. */
export function withLineNumbers(text) {
  const rows = String(text).split("\n").slice(0, READ_ROWS_MAX);
  return rows.map((z, i) => `${i + 1}\t${z.endsWith("\r") ? z.slice(0, -1) : z}`).join("\n");
}

/**
 * The file attachments. `read(path, maxBytes)` → `{ text, truncated }` | null — the run's read path (runs/system-prompt.js:
 * without instance directly, in the main instance of a converted project through the descriptor, in a copy never).
 * @returns {string[]}  one text per file (call + result or reference); plus `.paths` (not enumerable): the paths that are in it
 */
export function fileAttachments(refs, { read: read2, tool = "Read" } = {}) {
  const candidates = [...(refs || [])]
    .filter((d) => d?.path && !MEMORY.has(path.basename(d.path)))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, FILES_MAX);
  const read = [];
  for (const d of candidates) {
    let r = null;
    // A byte cap far above FILE_TOKEN_MAX: whatever breaks it is too large for the content anyway.
    try { r = typeof read2 === "function" ? read2(d.path, FILE_TOKEN_MAX * CHARACTERS_PER_TOKEN * 4) : null; } catch { r = null; }
    if (!r || typeof r.text !== "string" || r.text.includes("\u0000")) continue; // missing, unreadable or binary — like a failed Read
    const content = withLineNumbers(r.text);
    const text = r.truncated || estimateTokens(content) > FILE_TOKEN_MAX
      ? FILE_TOO_LARGE(d.path, tool)
      : `${FILE_CALL(tool, { file_path: d.path })}\n\n${FILE_RESULT(tool, content)}`;
    read.push({ path: d.path, text });
  }
  let sum = 0;
  const inside = read.filter((g) => {
    const t = estimateTokens(g.text);
    if (sum + t > FILE_BUDGET) return false;
    sum += t;
    return true;
  });
  return Object.defineProperty(inside.map((g) => g.text), "paths", { value: inside.map((g) => g.path), enumerable: false });
}

/**
 * The skills from the result rows of cbase_skill (the content as it was loaded — `body` of the response, else the text).
 * @param {Array<{name, row, at}>} refs
 * @param {Map<number, Object>} rowsAfterId  the history rows by id
 */
export function skillAttachment(refs, rowsAfterId) {
  const sorted = [...(refs || [])].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  let sum = 0;
  const skills = [];
  for (const s of sorted) {
    const row = rowsAfterId?.get(Number(s.row));
    const b = row ? json(row.text) : null;
    const raw = typeof b?.result === "string" ? b.result : "";
    const response = json(raw);
    const content = typeof response?.body === "string" ? response.body : raw;
    if (!content.trim()) continue;
    const truncated = truncateSkill(content, SKILL_TOKEN_MAX);
    const t = estimateTokens(truncated);
    if (sum + t > SKILL_BUDGET) continue;
    sum += t;
    skills.push({ name: s.name, content: truncated });
  }
  return skillsText(skills);
}

/**
 * Agents, monitors and workflows: one status per running piece of background work (runs/background.js backgroundWork).
 * `outputLocation`: the chat's output location (a monitor's log lies below it).
 */
export function backgroundTexts(work, { outputLocation = "" } = {}) {
  const rows = Array.isArray(work) ? work : [];
  const out = [];
  for (const a of rows) if (a.kind === "agent") out.push(agentStatusText({ id: a.agentId, description: a.description || a.name || "" }));
  for (const m of rows) {
    if (m.kind !== "monitor") continue;
    const output = m.logPath && outputLocation ? path.join(outputLocation, m.logPath) : "";
    out.push(monitorStatusText({ id: m.taskId, description: m.description || m.name || "", command: m.command || "", output }));
  }
  for (const w of rows) {
    if (w.kind === "dynworkflow") out.push(workflowStatusText({ id: w.taskId || w.runId, name: w.name || "" }));
    else if (w.kind === "graphWorkflow") out.push(workflowStatusText({ id: w.startId || w.runId, name: w.name || "" }));
  }
  return out;
}
