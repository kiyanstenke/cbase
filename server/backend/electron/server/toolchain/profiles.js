// Agent hooks: HOOK_EVENTS/loadAgentHooks; PERMISSION_MODES comes from workflows.js and is only re-exported here (importers
// depend on this path).

import * as store from "../store.js";
// workflows.js is a leaf (zero imports), so the direction goes there and cannot close a cycle.
import { PERMISSION_MODES } from "../workflows.js";


// ── Agent hooks (Claude Code style, loop engine; "SubagentStop" for every subagent) ──
// Configured as app_settings `agent_hooks` = JSON array [{event, matcher, command}].
// event: one of HOOK_EVENTS. matcher: tool-name RegExp or "*" (for SubagentStop the agent type).
// Executed via providers/hook-run.js: all kinds in the loop engine (engine.js), "SubagentStop" in the subagent core at the
// end of EVERY subagent of every provider (runs/agents.js).
// Every kind here needs something that fires it — guard server/backend/test/system-prompt-proofread.test.js.
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "SessionEnd", "PreCompact", "SubagentStop", "Stop", "Notification"];
function loadAgentHooks() {
  try {
    const arr = JSON.parse(store.getSetting("agent_hooks", "[]"));
    if (!Array.isArray(arr)) return [];
    return arr.filter((h) => h && HOOK_EVENTS.includes(h.event) && typeof h.command === "string" && h.command.trim())
      .map((h) => ({ event: h.event, matcher: typeof h.matcher === "string" ? h.matcher : "*", command: String(h.command) }));
  } catch { return []; }
}

export { HOOK_EVENTS, PERMISSION_MODES, loadAgentHooks };
