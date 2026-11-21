// The ONE rule for watching. It stands verbatim in the system prompt (server/runs/system-prompt.js, "Waiting for something") and
// in the description of cbase_monitor (mcp/tools/services.js) — execution and description side say the same because it is ONE
// sentence. Guard: server/backend/test/monitor-over-the-turn.test.js.
//
// A leaf without imports: the MCP server (own process) and the server both read it. The whole rule against detaching
// (detection, refusal) lives in mcp/detach-rule.js — the sentence here only refers to it.
// Without the prohibition of detaching: it would otherwise stand twice in the system prompt (here and in DETACH_RULE), each
// statement has ONE place. Only a main run has the monitor, and it carries the base block with DETACH_RULE.
export const MONITOR_RULE = "Should every matching output line wake you, use report: \"rows\"; if only the result counts (build, test suite, deploy), use report: \"end\" — then it reports exactly once, with the exit code and the last lines. A command whose end you wait for you start as the command of the monitor: that way the human sees it, can stop it, and its end reaches you.";

/** The promise about the lifetime — likewise in prompt and description. The restart half is held by
 *  server/backend/test/monitor-persistent.test.js (runs/monitors.js monitorsRestartGrace). */
export const MONITOR_LIFETIME = "The monitor belongs to the chat: it survives the end of your answer and messages from the human, until its command ends, cbase_monitor_stop, its time limit, the human stops it under Background Tasks, or the chat is deleted; while it runs, the chat cannot be archived. A server restart ends a monitor with a time limit (the chat gets a note); a persistent one (e.g. a WebSocket watch) starts again by itself, same id and log — output during the restart is not seen. Every report arrives as <task-notification> and names the log file with the whole output (output location, monitors/<id>.log).";
