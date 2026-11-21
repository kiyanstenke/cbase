// Name and workspace of an agent browser from its profile folder — the `describeProfile` of the scanner in browsers.js
// (startAgentScan, registered in server.js). The scanner only knows the folder; who owns it is in the database:
//   • "chat-<chatId>"                  → the chat's main agent: chat title, the chat's workspace
//   • "chat-<chatId>-agent-<agentId>"  → a subagent (its description, else its name) or an agent of a dynamic workflow
//                                        (its `label` in the tree, else "<workflow> #n"); the chat's workspace
//   • otherwise                        → a workspace pool: its name, the workspace itself
// Without the second form a subagent's browser would show under its raw folder name and WITHOUT a workspace, and be
// missing from every list filtered by workspace. The chat view computes its own short name
// (web/src/lib/browser-choice.ts); this one is for lists ACROSS chats.
import * as store from "../store.js";
import { profileParts } from "../browser-profiles.js";
import { dynTrees } from "../dynworkflows/run.js";
import { T } from "../i18n.js";

/** The name of a subagent or workflow agent — "" when none is known. */
export function agentName(chatId, agentId) {
  const sub = store.readSubagent(chatId, agentId);
  const description = String(sub?.description || sub?.name || "").trim();
  if (description) return description;
  for (const run of dynTrees(chatId).runs) {
    const a = run.agents.find((x) => x.agentId === agentId);
    if (a) return a.label || `${run.name || T("Workflow")} #${a.n}`;
  }
  return "";
}

/** `describeProfile` for startAgentScan: `{ label, workspaceId }` or `null` (unknown chat). */
export function describeProfile(dirName) {
  const { chatId, agentId } = profileParts(dirName);
  if (chatId) {
    const chat = store.getChat(chatId);
    if (!chat) return null;
    const label = agentId ? agentName(chatId, agentId) || T("Subagent") : chat.title || T("Chat");
    return { label, workspaceId: chat.workspaceId };
  }
  return { label: store.getWorkspace(dirName)?.name || dirName, workspaceId: dirName };
}
