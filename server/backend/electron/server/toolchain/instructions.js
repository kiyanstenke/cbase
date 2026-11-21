// The instructions of an agent: which sections it carries and how they appear in the system prompt. ONE computation for the
// main run (runs/system-prompt.js buildSystemPrompt, `role: "main"`) and for every subagent and workflow agent of every
// provider (runs/agents.js agentSpecFactory, `role: "sub"`). Pure: reads the store.
//
//   sectionsFor({ workspaceId, projectId, role }) → [{ title, text, origin }]
//       only enabled ones; scope `all` plus that of the role (`main` or `sub`); first the workspace (without those deselected
//       in the project), then the project — each in the order of its level. An empty text drops (a title alone says nothing).
//   instructionsBlock(list) → "" or the block "# User instructions" with one subheading per section.
//   instructionsFor(o) → instructionsBlock(sectionsFor(o))
//
// The text is what the USER specified (maintained in the UI) — not foreign text, so no fence. It is placed in the system prompt
// anew every turn: after compacting it is back, a change applies from the next turn.
import * as store from "../store.js";

const ROLES = Object.freeze(["main", "sub"]);

export function sectionsFor({ workspaceId, projectId = null, role } = {}) {
  if (!workspaceId || !ROLES.includes(role)) return [];
  const matches = (a) => a.enabled && (a.scope === "all" || a.scope === role) && String(a.text || "").trim();
  const out = projectId ? store.agentSectionsOffInProject(projectId) : new Set();
  const ws = store.agentSectionsOfTheLevel(workspaceId, null).filter((a) => matches(a) && !out.has(a.id));
  const pr = projectId ? store.agentSectionsOfTheLevel(workspaceId, projectId).filter(matches) : [];
  return [
    ...ws.map((a) => ({ title: a.title, text: a.text, origin: "workspace" })),
    ...pr.map((a) => ({ title: a.title, text: a.text, origin: "project" })),
  ];
}

export function instructionsBlock(list = []) {
  if (!list.length) return "";
  return [
    "# User instructions",
    "The user has stored these sections for this workspace or this project. They apply to all of your work.",
    ...list.flatMap((a) => ["", `## ${String(a.title).trim() || "Instruction"}`, String(a.text).trim()]),
  ].join("\n");
}

export const instructionsFor = (o) => instructionsBlock(sectionsFor(o));
