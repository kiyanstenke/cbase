// The agenda in the run: who keeps it, and the fenced block that brings it into a turn without a resumed session. A leaf that reads
// only the data layer (store/agenda.js through the facade) — `runs/` stays domain-free.
//
// Two paths, one reason (prompt cache):
//   · The system prompt gets only a FIXED sentence (runs/system-prompt.js buildSystemPrompt, option `agenda`) — never the content:
//     every change to the system prompt costs the cache of the whole history, and the agenda changes in almost every turn.
//   · The CONTENT comes once as a fenced block before the input of the first turn WITHOUT a resumed session — new session, after
//     compaction, after session loss or provider change, in the resume retry. With a resumed session it is already in the
//     history, or the model reads the agenda through the tool (cbase_agenda). An empty agenda yields no block (the golden runs stay
//     byte-equal).
// Both only for the MAIN RUN of a Coding chat with the full toolset — only it has cbase_agenda_write (mcp/visibility.js), and
// sentence and block name the tool: the description follows the execution.
//
// The content is the model's own text — still fenced: a marker inside the content is defused (like runs/hints.js), the fence cannot
// be closed from within the content.
//
// The agenda is a tree: the points stand indented (two spaces per level) as `- s3 [in_work 2/5] text {Project: X}` — at a point with
// subpoints the COMPUTED status and done/all leaves (store/agenda.js agendaTree, the same computation as route and bar), the project
// only at top-level points and only while the project still exists.

import { agendaTree, agendaIsEmpty, readAgenda, chatKeepsAgenda, getWorkspace } from "../store.js";

const MARKER = "cbase-agenda";
const disarm = (s) => String(s ?? "").replace(/<(\s*\/?\s*cbase-agenda)/gi, "‹$1");

/** Does the run of this chat with this toolset ("" = the full one) keep the agenda — does it have the write tool? */
export function runWritesAgenda(chat, toolset = "") {
  return chatKeepsAgenda(chat) && !toolset;
}

/** The fenced block of an agenda; empty ⇒ "". `projects` = Map id → name (the labels of the top-level points). Pure, exported for tests. */
export function agendaFence(agenda, projects = new Map()) {
  if (agendaIsEmpty(agenda)) return "";
  const state = agenda.changedAt ? new Date(agenda.changedAt).toISOString() : "";
  const rows = [];
  if (String(agenda.title || "").trim()) rows.push(`Title: ${disarm(agenda.title)}`);
  if (String(agenda.description || "").trim()) rows.push("Description:", disarm(agenda.description));
  const points = agenda.steps || [];
  if (points.length) {
    rows.push("Points (in their order, indented = subpoint; at points with subpoints the computed status and done/total):");
    const tree = agendaTree(points);
    points.forEach((s, i) => {
      const b = tree[i];
      const inset = "  ".repeat(b.depth);
      const count = b.subitems ? ` ${b.done}/${b.total}` : "";
      const name = b.depth === 0 && s.projectId ? projects.get(s.projectId) : undefined;
      rows.push(`${inset}- ${s.id} [${b.status}${count}] ${disarm(s.text)}${name ? ` {Project: ${disarm(name)}}` : ""}`);
      // Notes only on open points — on finished ones they are history, and the block should stay short.
      if (s.note && b.status !== "done") rows.push(`${inset}  Note: ${disarm(s.note).replace(/\n/g, `\n${inset}  `)}`);
    });
  }
  return [
    // No claim "you wrote it yourself": the agenda keeper (outer loop) writes too (cbase_agenda_maintain) — such a sentence would
    // assert an authorship the block does not know.
    "[cbase — the agenda of this chat. It is your plan across sessions and compactions "
      + "and stands here once because this turn begins without a continued session. Continue it with cbase_agenda_write "
      + "(check off leaves, create new points); you can read it any time with cbase_agenda. It is not a message from the "
      + "human — his message (or the cause of this turn) follows after the separator.]",
    `<${MARKER}${state ? ` updated="${state}"` : ""}>`,
    ...rows,
    `</${MARKER}>`,
  ].join("\n");
}

/** The preamble for a turn's input: the block if the run keeps the agenda, the session is NOT resumed and the agenda is not
 *  empty — otherwise "". A read error (the table is missing only before initStore) must never disturb the run. */
export function agendaPreamble(chat, { toolset = "", resumed = false } = {}) {
  if (resumed || !runWritesAgenda(chat, toolset)) return "";
  try {
    const projects = new Map((getWorkspace(chat.workspaceId)?.projects || []).map((p) => [p.id, p.name]));
    return agendaFence(readAgenda(chat.id), projects);
  } catch { return ""; }
}

/** The input with preamble — separated by the same separator as the silent hints (runs/hints.js withHints). */
export const withAgenda = (preamble, input) => (preamble ? `${preamble}\n\n---\n\n${input}` : input);
