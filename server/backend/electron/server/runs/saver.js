// "CPU saver": the switch and the ONE question whether a start carries it. How saving works (nice, waiting, marker) is in the leaf
// mcp/cpu-saver.js; here only WHO.
//
// The switch: `cpu_saver` in app_settings ("1" on, anything else off — off by default). Read at EVERY spec build (per turn of an agent,
// per node turn of a child chat) and at every monitor start — no restart.
// Who saves when it is on (the spec then sets `saver: true`, otherwise the field is absent altogether — off is byte-equal to before):
//   - every agent from providers/agent-runtime.js: subagent, agent of a dynamic workflow, outer-loop agent
//     (runs/agents.js agentSpecFactory);
//   - a node turn in the child chat of a background graph workflow (runs/do-run.js, `saverForChat`);
//   - every monitor command (runs/monitors.js).
// Never: a chat's main agent (also a graph workflow in the chat's own chat — the human watches), the backend, the browser stream,
// app agents, oneshots. Built only from the data layer (through the facade store.js — the "store facade" guard demands it).
import * as store from "../store.js";

export const SAVER_SETTING = "cpu_saver";

/** Is the switch on? */
export const saverOn = () => store.getSetting(SAVER_SETTING, "") === "1";

/** Set: `{ enabled }` or `{ error: "missing" | "type" }` — a missing field is no statement, "yes"/1 is no boolean. */
export function setSaver(enabled) {
  if (enabled === undefined || enabled === null) return { error: "missing" };
  if (typeof enabled !== "boolean") return { error: "type" };
  store.setSetting(SAVER_SETTING, enabled ? "1" : "0");
  return { enabled };
}

/** Does this chat's turn save? Only the child chat of a background graph workflow, and only with the switch on. */
export function saverForChat(chat) {
  if (!chat?.id || !saverOn()) return false;
  try { return Boolean(store.graphStartOfChild(chat.id)); } catch { return false; }
}

/** The field for a spec: `{ saver: true }` or `{}` — without the switch it is absent, the spec stays as before. */
export const saverField = (enabled) => (enabled ? { saver: true } : {});
