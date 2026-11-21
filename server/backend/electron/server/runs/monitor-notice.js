// A monitor's notification to its chat — in the form of a completion notice (runs/completionNotice.js: `<task-notification>` with
// task-id, name, status, summary, output-file, result), so that it goes through the same wake path and Web and iOS show it as a
// system line instead of a user bubble. The summary always begins with `Monitor "` — by that the clients recognise the kind
// (web/src/lib/completionNotice.ts isMonitorNotice, iOS Chat/CompletionNotice.swift). `status`: "running" for an event (report: lines),
// otherwise the outcome (completed, failed, timed_out, flooded).
//
// A leaf without imports except i18n: called by runs/monitors.js.
import { T } from "../i18n.js";

/** The subfolder of the output location for the monitors' log files (runs/outputs-view.js OUTPUTS_INTERNAL). */
export const MONITOR_FOLDER = "monitors";
export const MONITOR_RESULT_MAX = 8_000;

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kappe = (s) => {
  const t = String(s ?? "");
  return t.length > MONITOR_RESULT_MAX ? `… [${t.length - MONITOR_RESULT_MAX} characters truncated before]\n${t.slice(-MONITOR_RESULT_MAX)}` : t;
};
const duration = (ms) => (ms >= 3_600_000 ? `${Math.round(ms / 360_000) / 10} h` : ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} min` : `${Math.round(ms / 100) / 10} s`);

/** How the monitor ended, as one sentence — for the notice and the log. Pure. */
export function monitorEndText({ task, status, info = {}, detail = "" }) {
  if (status === "stopped") {
    const who = info.through === "human" ? T("by the human") : info.through === "chat" ? T("with the chat") : T("by the agent");
    return T`End: stopped ${who}.`;
  }
  if (info.reason === "resume") return T`End: could not be started again after the server restart — ${detail}.`;
  if (status === "timed_out") return T`End: time limit of ${duration(task.timeoutMs || 0)} reached — the command was terminated.`;
  if (status === "flooded") return T("End: terminated by the flood brake (too many events).");
  if (Number.isInteger(info.wsCode)) {
    return T`End: WebSocket closed (code ${info.wsCode}${detail ? `: ${detail}` : ""}).`;
  }
  if (info.signal) return T`End: killed by signal ${info.signal}.`;
  if (Number.isInteger(info.exitCode)) return T`End: exit code ${info.exitCode}.`;
  if (info.reason === "error") return T`End: failed to start — ${detail}`;
  return T`End: ${status}.`;
}

/**
 * The notice as text for the wake path. `event`: { status, output, end? }. `end`: true for the end notice (then `output` carries
 * the last lines).
 */
export function monitorNotice({ task, event, logFile, end = false, clipped = false }) {
  const status = String(event?.status || "running");
  const name = task.description || task.taskId;
  const summary = end || status !== "running"
    ? `Monitor "${name}" ended — ${event?.end || status}`
    : `Monitor "${name}" event`;
  const hint = end
    ? T`The monitor has ended (report: ${task.report}). Below are the last lines; the full output is in ${logFile}${clipped ? " (capped)" : ""}. React to the result — this is not a message from the human.`
    : T`An event of the running monitor (report: rows); it keeps running. Full output: ${logFile}. React to it — this is not a message from the human.`;
  return [
    "<task-notification>",
    `<task-id>${xml(task.taskId)}</task-id>`,
    `<name>${xml(name)}</name>`,
    `<status>${xml(status)}</status>`,
    `<summary>${xml(summary)}</summary>`,
    `<output-file>${xml(logFile)}</output-file>`,
    `<note>${xml(hint)}</note>`,
    `<result>${xml(kappe(String(event?.output || "").trim() || T("(no output)")))}</result>`,
    "</task-notification>",
  ].join("\n");
}
