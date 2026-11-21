// The approval card of a dynamic workflow — ONE switch for the loader (`buildBubbles`) and the coding chat's reducer
// (components/chat/chatBubbles.ts).
//
// The server (server/backend/electron/server/dynworkflows/approval.js) writes the card under its OWN role `workflow_approval`
// (`{ requestId, name, description, phases: [{ title, detail? }], at }`) and the ruling under `workflow_approval_ruling`
// (`{ requestId, decision: "accepted"|"rejected", runId?, taskId?, at }`); live the same payloads as harness events
// `workflow_approval` (under `card`) and `workflow_approval_decided` (under `ruling`). A card is open as long as no ruling stands for
// its requestId — a later message does NOT close it (unlike the question). Counterpart: mobile/CbaseMobile/Chat/WorkflowApproval.swift.
//
// A leaf module without imports (reducer.test.mjs compiles chatBubbles.ts with its relative imports without tsconfig).

export const APPROVAL_ROLE = "workflow_approval";
export const RULING_ROLE = "workflow_approval_ruling";

export type WorkflowDecision = "accepted" | "rejected";
export type WorkflowApproval = {
  requestId: string;
  name: string;
  description: string;
  phases: { title: string; detail?: string }[];
  decision: WorkflowDecision | null; // null = open
};

const asObject = (raw: unknown): Record<string, unknown> | null => {
  let o: unknown = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { return null; } }
  return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
};

/** The card from a history row (JSON text) or an event (`evt.card`). `null` if it is none. */
export function readWorkflowApproval(raw: unknown): WorkflowApproval | null {
  const k = asObject(raw);
  const requestId = typeof k?.requestId === "string" ? k.requestId : "";
  if (!k || !requestId) return null;
  const phases = (Array.isArray(k.phases) ? k.phases : [])
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object" && typeof (p as Record<string, unknown>).title === "string")
    .map((p) => ({ title: String(p.title), ...(typeof p.detail === "string" && p.detail ? { detail: p.detail } : {}) }));
  return { requestId, name: String(k.name ?? ""), description: String(k.description ?? ""), phases, decision: null };
}

/** The ruling from a history row or an event (`evt.ruling`). `null` if it is none. */
export function readWorkflowRuling(raw: unknown): { requestId: string; decision: WorkflowDecision } | null {
  const e = asObject(raw);
  const requestId = typeof e?.requestId === "string" ? e.requestId : "";
  if (!e || !requestId || (e.decision !== "accepted" && e.decision !== "rejected")) return null;
  return { requestId, decision: e.decision };
}
