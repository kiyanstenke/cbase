// `/name <rest>` of a saved dynamic workflow at the message route: a REFUSAL, not a start.
//
// The composer only offers `/workflow:<short name>` for graph workflows (workflows/slash-workflow.js). Dynamic workflows
// start from the library or from the model (`cbase_dynamic_workflow`).
//
// Why a refusal instead of "carry on like any message": the CLI reads a leading `/name` as a command — an unknown one
// swallows the WHOLE message (`Unknown command`, `num_turns: 0`). Whoever types the name of a saved workflow out of
// habit therefore gets a visible message at the composer, and nothing is sent.
//
// Two rules:
//   · the TEXT is read, not the display (`display`);
//   · only in a coding chat (no run kind, runs/hooks.js runKindFor): the special runs (context, ingest) know no dynamic
//     workflows — there the line carries on as before.
// The body field `dynWorkflow` is no longer read: the client does not offer the group any more. A workflow deleted in
// the meantime is therefore just any `/word`.

import { T } from "../i18n.js";
import { runKindFor } from "../runs/hooks.js";
import { savedWorkflow } from "./run.js";

// Same form as a saved name (names.js FORM), followed by whitespace or the end — "/goal-x" is the name "goal-x", not
// `/goal` with "-x".
const SLASH_CALL = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\s+([\s\S]*))?$/;

/** `{ name, rest }` of a line that starts with `/name` — otherwise `null`. */
export function slashCall(text) {
  const m = SLASH_CALL.exec(String(text ?? "").trim());
  return m ? { name: m[1], rest: (m[2] || "").trim() } : null;
}

/**
 * If `text` hits the name of a saved dynamic workflow in the chat's effective view: the refusal 404 `dyn_slash`.
 * Otherwise `null` — the route carries on (skill resolution, else unchanged to the model).
 * @param {Object} chat
 * @param {string} text
 * @returns {null | { status: number, body: { error: string, reason: string } }}
 */
export function dynSlashRefusal(chat, text) {
  const call = slashCall(text);
  if (!call || runKindFor(chat)) return null;
  const { entry } = savedWorkflow(chat, call.name);
  if (!entry) return null;
  return {
    status: 404,
    body: {
      reason: "dyn_slash",
      error: T`"/${call.name}" is not a command — saved dynamic workflows start from the library or through the model (cbase_dynamic_workflow). Nothing was sent.`,
    },
  };
}
