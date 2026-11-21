// Start and end marker of a dynamic workflow in the history — ONE switch for all history views: the coding chat (loader
// `buildBubbles` and reducer in components/chat/chatBubbles.ts).
//
// The server (server/backend/electron/server/dynworkflows/run.js, `marker`) writes EXACTLY two rows per run under its OWN role
// `workflow_marker` — not under `meta`, which already holds metrics and compaction (one role for two kinds is a bug) — and sends the
// same payload live as harness event `workflow_marker` (nested under `marker`). Text/payload:
// `{ phase: "start"|"end", runId, taskId, name, status?, at }`; the end marker's `status` is the outcome: finished · stopped · failed
// (as the completion notice) · interrupted (server end). Counterpart: mobile/CbaseMobile/Chat/WorkflowMarker.swift.
//
// The marker hangs on NO parent block (it is no row of an agent) and never ends up in `underParent`.
// A leaf module without imports (reducer.test.mjs compiles chatBubbles.ts with its relative imports without tsconfig).

export const MARKER_ROLE = "workflow_marker";

export type WorkflowMarker = { phase: "start" | "end"; runId: string; taskId: string; name: string; status: string };

/** The marker from a history row (JSON text) or an event (`evt.marker`). `null` if it is none. */
export function readWorkflowMarker(raw: unknown): WorkflowMarker | null {
  let o: unknown = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const m = o as Record<string, unknown>;
  if (m.phase !== "start" && m.phase !== "end") return null;
  return {
    phase: m.phase, runId: String(m.runId ?? ""), taskId: String(m.taskId ?? ""), name: String(m.name ?? ""),
    status: m.phase === "end" ? String(m.status ?? "") : "",
  };
}

const END_LABEL: Record<string, string> = {
  finished: "Workflow “{name}” finished",
  stopped: "Workflow “{name}” stopped",
  failed: "Workflow “{name}” failed",
  interrupted: "Workflow “{name}” interrupted",
};

/** The marker's divider row: a translatable key, the name stays data (parameter). `null` = no marker. */
export function markerSeparator(raw: unknown): {
  role: "divider"; blocks: []; kind: "workflow-start" | "workflow-end"; label: string; labelParams: Record<string, string>; marker: WorkflowMarker;
} | null {
  const m = readWorkflowMarker(raw);
  if (!m) return null;
  const label = m.phase === "start" ? "Workflow “{name}” started" : (END_LABEL[m.status] ?? "Workflow “{name}” ended");
  return { role: "divider", blocks: [], kind: m.phase === "start" ? "workflow-start" : "workflow-end", label, labelParams: { name: m.name || "workflow" }, marker: m };
}
