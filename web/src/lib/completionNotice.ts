// The completion notice of a subagent — TWO kinds under one role.
//
// The server stores it under the role of a user message (`user`), because for the main agent that is exactly what it is:
// the input of a new turn. For the human it is a system message. Marker: the start `<task-notification>`
// (server/backend/electron/server/runs/completionNotice.js, FINISHED_MARKER); in the stream `systemNotice: true` additionally says so
// on `user_message`/`message_injected`. Every view that reads history rows (chat history and reducer,
// agent dock, queue strip) asks HERE — without the case distinction the XML would show as a user bubble in the history.
//
// A leaf with ONE relative import (the third kind, lib/agents-message.ts — itself a leaf without imports):
// reducer.test.mjs transpiles chatBubbles.ts with its relative imports, without a tsconfig.
import { messageQueue } from "./agents-message.js";

export const FINISHED_MARKER = "<task-notification>";

/** Is this text a completion notice (and not a user message)? */
export const isCompletionNotice = (text: unknown): boolean => typeof text === "string" && text.startsWith(FINISHED_MARKER);

export type FinishedStatus = "completed" | "stopped" | "failed";

const entXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The FIRST occurrence of the element, unescaped — `null` if it is missing (missing is not empty: see `<name>`).
const fieldOrNull = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([^]*?)</${name}>`).exec(text);
  return m ? entXml(m[1]) : null;
};
const field = (text: string, name: string) => fieldOrNull(text, name) ?? "";

/**
 * The name from the summary — only for old data WITHOUT `<name>`. The form is fixed per outcome
 * (runs/completionNotice.js): `Agent "<name>" completed`, `Agent "<name>" was stopped`, `Agent "<name>" failed: <error>`.
 * Completed and stopped end EXACTLY with their outcome; on failure the FIRST `" failed: ` separates — the error text
 * behind it may itself carry `"…" failed`. Without a known status the order is completed · stopped · failed.
 * THE SAME rule stands in mobile/CbaseMobile/Chat/CompletionNotice.swift, bound in
 * web/test/completion-notice-binding.test.mjs.
 */
export function nameFromSummary(summary: string, status: string): string {
  const header = 'Agent "';
  if (!summary.startsWith(header)) return "";
  const rest = summary.slice(header.length);
  const open = status === "";
  if ((open || status === "completed") && rest.endsWith('" completed')) return rest.slice(0, rest.length - '" completed'.length);
  if ((open || status === "stopped") && rest.endsWith('" was stopped')) return rest.slice(0, rest.length - '" was stopped'.length);
  if (open || status === "failed") {
    const i = rest.indexOf('" failed: ');
    if (i >= 0) return rest.slice(0, i);
  }
  return "";
}

/** What the row shows in the history: the name of the agent and its outcome. `null` if the text is none. */
export function readCompletionNotice(text: unknown): { agentId: string; name: string; status: FinishedStatus | "" } | null {
  if (!isCompletionNotice(text)) return null;
  const t = text as string;
  const raw = field(t, "status");
  const status: FinishedStatus | "" = raw === "completed" || raw === "stopped" || raw === "failed" ? raw : "";
  // The name stands in its own element; the summary is only the fallback for old data.
  const name = fieldOrNull(t, "name") ?? nameFromSummary(field(t, "summary"), status);
  return { agentId: field(t, "task-id"), name, status };
}

/**
 * The completion notice of a dynamic WORKFLOW (server/backend/electron/server/dynworkflows/run.js) — the
 * summary starts with `Workflow "`, and its task id is that of the end marker of the same run (`marker`).
 */
export function isWorkflowNotice(text: unknown): boolean {
  return isCompletionNotice(text) && field(text as string, "summary").startsWith('Workflow "');
}

/**
 * The completion notice of a graph workflow in the background (server/backend/electron/server/workflows/graph-background.js,
 * `graphCompletionNotice`): summary `Graph-Workflow "<name>" completed | was stopped | failed: …`, name in `<name>`. It counts as a
 * workflow ONLY for the wording of the row.
 * `completionNoticeDuplicate` still asks `isWorkflowNotice` alone: a graph run has no end marker in the history with which
 * its notice could coincide. Counterpart: the graph workflow check in Chat/CompletionNotice.swift.
 */
export function isGraphWorkflowNotice(text: unknown): boolean {
  return isCompletionNotice(text) && field(text as string, "summary").startsWith('Graph-Workflow "');
}

/**
 * The outcome in the wake-up call of a COPY (project container stage 2). The server writes it in the form of a
 * completion notice, but WITHOUT `<name>` and `<status>` — name and outcome stand in the summary alone, in a fixed form
 * `Copy "<name>" <outcome>` (English on the wire; stored German notes are rewritten by the migration tool, no alias here):
 *   server/backend/electron/server/stacks/inset.js `moveInWakeText`     → `ready` · `not built: <reason>`
 *   server/backend/electron/server/stacks/remove.js `copyWakeText`   → `removed` · `removed (never built)` · `not removed: <reason>`
 * Without this all five would show only "System message" — also the error cases; which copy was meant and whether it was
 * ready, failed or removed, the human would not see. A copy name never carries `"`
 * (projectbox/creation.js COPY_NAME: `[a-z0-9-]`), so the name ends at the FIRST `"` — a reason behind it may itself contain
 * `Copy "x" ready`. An unknown form is NOT a copy wake-up call (`null`): the row claims no outcome it does not know.
 * THE SAME rule stands in mobile/CbaseMobile/Chat/CompletionNotice.swift (`copy`), bound in
 * web/test/completion-notice-binding.test.mjs (also there: every form of the server arrives).
 */
export type CopyOutcome = "ready" | "not-built" | "clearedAway" | "never-built-removed" | "not-cleared-away";

export function readCopyNotice(text: unknown): { name: string; outcome: CopyOutcome } | null {
  if (!isCompletionNotice(text)) return null;
  const summary = field(text as string, "summary");
  const header = 'Copy "';
  if (!summary.startsWith(header)) return null;
  const rest = summary.slice(header.length);
  const i = rest.indexOf('"');
  if (i <= 0) return null;
  const name = rest.slice(0, i);
  const after = rest.slice(i + 1);
  const outcome: CopyOutcome | null = after === " ready" ? "ready"
    : after.startsWith(" not built: ") ? "not-built"
      : after === " removed" ? "clearedAway"
        : after === " removed (never built)" ? "never-built-removed"
          : after.startsWith(" not removed: ") ? "not-cleared-away"
            : null;
  return outcome ? { name, outcome } : null;
}

// The keys of the copy row (English is the key; German in i18n-de.ts).
const COPY_LABEL: Record<CopyOutcome, string> = {
  "ready": "Copy “{name}” ready",
  "not-built": "Copy “{name}” not built",
  "clearedAway": "Copy “{name}” removed",
  "never-built-removed": "Copy “{name}” removed (never built)",
  "not-cleared-away": "Copy “{name}” not removed",
};

/**
 * The notice of a MONITOR (server/backend/electron/server/runs/monitor-notice.js): summary `Monitor "<name>" event` (one event,
 * `status` running) or `Monitor "<name>" ended — <end>`, name in `<name>`. Otherwise the row would read "Subagent “<name>” finished".
 * Counterpart: the monitor check in mobile/CbaseMobile/Chat/CompletionNotice.swift.
 */
export function isMonitorNotice(text: unknown): boolean {
  return isCompletionNotice(text) && field(text as string, "summary").startsWith('Monitor "');
}

/** The wording of the monitor row per `<status>` — English is the key (i18n-de.ts). Unknown = "ended". */
export function monitorLabel(status: string): string {
  return status === "running" ? "Monitor “{name}” reports"
    : status === "failed" ? "Monitor “{name}” failed"
      : status === "timed_out" ? "Monitor “{name}” timed out"
        : status === "flooded" ? "Monitor “{name}” throttled"
          : status === "stopped" ? "Monitor “{name}” stopped"
            : "Monitor “{name}” ended";
}

/** The system row in the history: a separator with a translatable key and its parameters (the name stays data). */
export function finishedRow(text: unknown): { label: string; labelParams?: Record<string, string> } {
  // The wake-up call of a copy FIRST: it is recognized by the summary, not by the name — if it ever carried
  // `<name>`, it would otherwise read "Subagent “<name>” finished".
  const copy = readCopyNotice(text);
  if (copy) return { label: COPY_LABEL[copy.outcome], labelParams: { name: copy.name } };
  // A monitor before the completion notice: its `<status>` knows more than completed/stopped/failed.
  if (isMonitorNotice(text)) {
    const name = fieldOrNull(text as string, "name") ?? "";
    return name ? { label: monitorLabel(field(text as string, "status")), labelParams: { name } } : { label: "System message" };
  }
  const f = readCompletionNotice(text);
  if (!f || !f.name) return { label: "System message" };
  // A workflow is called a workflow: not "Subagent" under every completion notice. The same keys as the end marker
  // (lib/workflow-marker.ts); the graph workflow too.
  const workflow = isWorkflowNotice(text) || isGraphWorkflowNotice(text);
  const label = f.status === "stopped" ? (workflow ? "Workflow “{name}” stopped" : "Subagent \"{name}\" stopped")
    : f.status === "failed" ? (workflow ? "Workflow “{name}” failed" : "Subagent \"{name}\" failed")
      : (workflow ? "Workflow “{name}” finished" : "Subagent \"{name}\" finished");
  return { label, labelParams: { name: f.name } };
}

/**
 * Does the completion notice say nothing the preceding row does not already say? That is the one of a workflow DIRECTLY behind the
 * end marker of the same run (same task id): the marker carries name and outcome, a second row "… finished" below it
 * would be a duplicate. Then it drops out of the history. If something came between marker and notice (the main agent was still
 * working, the notice waited in the queue), it stays — there it shows where it got the result. `previous` is the last row of the history
 * (a separator of the marker carries `kind` and `marker`, see markerSeparator). Counterpart: the duplicate check in
 * mobile/CbaseMobile/Chat/CompletionNotice.swift.
 */
export function completionNoticeDuplicate(prior: { kind?: string; marker?: { taskId: string } } | undefined, text: unknown): boolean {
  if (!prior || prior.kind !== "workflow-end" || !isWorkflowNotice(text)) return false;
  const id = field(text as string, "task-id");
  return id !== "" && prior.marker?.taskId === id;
}

/**
 * An entry of the queue: a queued completion notice is a SYSTEM MESSAGE — the strip shows
 * name and state instead of the XML, and it carries no trash can (the server rejects a discard with 409). Marker:
 * the field `systemNotice` of the server (runs/queue.js publicPendingInputs) OR the marker on the text (an older server).
 * Also the message of an agent (lib/agents-message.ts) — it comes first.
 * Counterpart: the queue entry in mobile/CbaseMobile/Chat/CompletionNotice.swift.
 */
export function queueEntry(q: { text: string; systemNotice?: boolean }):
  { systemNotice: true; label: string; labelParams?: Record<string, string> } | { systemNotice: false } {
  // The third kind first: the message of an agent is likewise a system row without a trash can —
  // "Message from <from>" instead of the XML, whether or not the server marks it.
  const message = messageQueue(q.text);
  if (message) return { systemNotice: true, ...message };
  if (q.systemNotice !== true && !isCompletionNotice(q.text)) return { systemNotice: false };
  return { systemNotice: true, ...finishedRow(q.text) };
}
