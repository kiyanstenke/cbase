// The tone of an event row that used to be a divider line. Completion notices (subagent, workflow, monitor, copy) and the marks of a
// dynamic workflow are EVENTS, not boundaries: they appear as a status row with a symbol, like their counterpart ("Monitor started",
// "Workflow finished"). Only real boundaries keep a line: compaction, clearing, notice.
// The tone is read from the translatable key (lib/completionNotice.ts finishedRow, lib/workflow-marker.ts markerSeparator); English is the
// key, so the language of the UI does not matter. Pure, without imports (guard web/test/separator-tone.test.mjs).
export type SeparatorTone = "start" | "ok" | "error" | "notice";

const ERROR = ["failed", "stopped", "timed out", "throttled", "interrupted", "not built", "not removed"];

/** `null` = the row stays a divider line (compaction, clearing, notice). */
export function separatorTone(kind: string | undefined, label: string | undefined): SeparatorTone | null {
  if (kind === "workflow-start") return "start";
  if (kind !== "completionNotice" && kind !== "workflow-end") return null;
  const l = String(label ?? "");
  if (l.endsWith(" reports")) return "notice";
  if (ERROR.some((w) => l.includes(w))) return "error";
  return "ok";
}
