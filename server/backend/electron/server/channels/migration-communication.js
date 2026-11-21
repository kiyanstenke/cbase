// The coding half of the migration of agent communication: what belongs to coding moves to the tool pair on EVERY start —
// idempotent, without a marker (a second run finds nothing more):
//
//   Agent definitions    the agents' tool list (workspace and projects) in place, also as mcp__cbase__<name>, by
//                        TOOL_REPLACEMENT: the five read tools ⇒ agents_list, channel_send ⇒ agent_send + agents_list,
//                        channel_create ⇒ chat_assign.
//   Stored               parked channel turns (pending_resumes, cause "channel") and interrupted ones (active_runs, kind
//   channel prompts      "chat:channel") carry the preamble's old reply path: only the sentence is replaced
//                        (channelResponseRow), the rows stay. The queue (run_inputs) is refreshed by ./delivery.js
//                        preamblesRefresh on restart.
//
// Called from server.js on start, before every run (before sweepAutoContinues and resumeInterruptedWork).

import * as store from "../store.js";
import { TOOL_REPLACEMENT, replaceOldChannelPreamble } from "./migration-communication-table.js";

const MCP_PREFIX = "mcp__cbase__";

/** A list by TOOL_REPLACEMENT, in place (an old name ⇒ its successors, duplicates drop). */
export function replaceNames(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw);
    const prefix = name.startsWith(MCP_PREFIX) ? MCP_PREFIX : "";
    const core = prefix ? name.slice(MCP_PREFIX.length) : name;
    const fresh = TOOL_REPLACEMENT[core] ? TOOL_REPLACEMENT[core].map((n) => prefix + n) : [name];
    for (const n of fresh) if (!out.includes(n)) out.push(n);
  }
  return out;
}
/** Does the list carry an old name (bare or with prefix)? */
export const hasOld = (list) => (Array.isArray(list) ? list : []).some((t) => {
  const n = String(t);
  return Boolean(TOOL_REPLACEMENT[n.startsWith(MCP_PREFIX) ? n.slice(MCP_PREFIX.length) : n]);
});

/**
 * The migration. Idempotent: what has been migrated carries no old name anymore.
 * @returns {{ definitions: number, prompts: number }}
 */
export function migrateCommunicationCoding() {
  const report = { definitions: 0, prompts: 0 };
  for (const ws of store.listWorkspaces()) {
    // Agent definitions (coding, workspace and projects): in place.
    const definitions = [...store.listWorkspaceAgents(ws.id), ...store.listProjects(ws.id).flatMap((p) => store.listProjectAgents(p.id))];
    for (const d of definitions) {
      if (!Array.isArray(d.toolList) || !hasOld(d.toolList)) continue;
      store.updateAgent(d.id, { toolList: replaceNames(d.toolList) });
      report.definitions++;
    }
  }
  // Stored channel prompts: a channel turn parked at the limit or credit gate, and one interrupted by a deploy, start with
  // their stored prompt (runs/auto-continue.js, runs/resume.js) — after the change with a tool that no longer exists. Before
  // every run, i.e. before sweepAutoContinues and resumeInterruptedWork: only the sentence.
  for (const z of store.listPendingResumes()) {
    if (z.payload?.cause !== "channel") continue;
    const fresh = replaceOldChannelPreamble(z.prompt);
    if (fresh !== z.prompt) { store.setPendingResumePrompt(z.chatId, fresh); report.prompts++; }
  }
  for (const r of store.listActiveRuns()) {
    if (r.kind !== "chat:channel") continue;
    const fresh = replaceOldChannelPreamble(r.prompt);
    if (fresh !== r.prompt) { store.setActiveRunPrompt(r.chatId, fresh); report.prompts++; }
  }
  if (report.definitions || report.prompts) {
    console.log(`[store] agent communication (coding): migrated ${report.definitions} definition(s) and ${report.prompts} stored channel prompt(s) to the tool pair`);
  }
  return report;
}
