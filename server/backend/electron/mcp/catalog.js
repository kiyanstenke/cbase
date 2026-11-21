// The tool catalog of the cbase MCP server: the groups under tools/ by spread, in THIS order. The order is `tools/list` and
// therefore the prompt prefix of every run (guard: server/backend/test/mcp-catalog.test.js). The server reads the NAMES too
// (runs/agent-set.js: an agent's toolset in catalog order, and the full set of a coding chat as an explicit list for a
// grandchild). Without an environment, the entry point decides what is visible.

import { agentTools } from "./tools/agents.js";
import { agendaTools } from "./tools/agenda.js";
import { appTools } from "./tools/app.js";
import { artifactTools } from "./tools/artifacts.js";
import { captureTools } from "./tools/captures.js";
import { dynWorkflowTools } from "./tools/dynworkflows.js";
import { graphWorkflowTools } from "./tools/graphworkflows.js";
import { outerLoopTools } from "./tools/outerloop.js";
import { projectTools } from "./tools/projects.js";
import { serviceTools } from "./tools/services.js";
import { skillTools } from "./tools/skills.js";
import { stackTools } from "./tools/stacks.js";
import { timelineTools } from "./tools/timeline.js";
import { workspaceTools } from "./tools/workspace.js";

export const TOOLS = [
  ...projectTools,
  // Artifacts and folder context.
  ...artifactTools,
  ...serviceTools,
  ...agentTools,
  ...workspaceTools,
  ...captureTools,
  ...appTools,
  // The library of dynamic workflows: appended last so the prefix before it stays the same.
  ...dynWorkflowTools,
  // Start, observe and stop graph workflows: last again, for the same reason. The messenger StructuredOutput is therefore no
  // longer at the end of the catalog, but last in its group; whoever sees it (a workflow agent with a schema) never sees this
  // group (visibility.js, WORKFLOW_AGENT_FAMILIES).
  ...graphWorkflowTools,
  // Create, list, fetch and remove the copy of a project: last again (the prefix before it stays the same). Offered only to a
  // run in a relocated project (visibility.js lockedForInstance); a coding chat without an instance sees none of these tools.
  ...stackTools,
  // The analysis tool of the outer loop: last again. Offered only to an outer-loop run (visibility.js ONLY_OUTER_LOOP); without
  // its marker the group drops out of every tools/list.
  ...outerLoopTools,
  // The agenda per coding chat: read (every run with the full catalog) and write (only the main agent of a coding chat,
  // visibility.js): last again, so the prefix before it stays the same for every run.
  ...agendaTools,
  // Writing skills: only the main run of a coding chat with the marker CBASE_SKILL_WRITE (offering.js); last again, for the same
  // reason.
  ...skillTools,
  // The timeline per project: read and write, ONLY the timeline agent in its outer-loop run (visibility.js ONLY_TIMELINE_AGENT);
  // last again, for the same reason, and without the marker the group drops out of every tools/list.
  ...timelineTools,
];

export const CATALOG_NAMES = Object.freeze(TOOLS.map((t) => t.name));
