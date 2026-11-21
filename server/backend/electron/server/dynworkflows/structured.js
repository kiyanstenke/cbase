// StructuredOutput of a dynamic workflow: `agent(prompt, {schema})` yields a CHECKED object, the same on every provider.
//
// The path of a schema:
//   1. Before the start `checkSchema` checks it (root `object` with `properties`, `required` ⊆ `properties`, ajv
//      compiles it) — an unsatisfiable one throws, and no agent process is created.
//   2. `openOutput` creates a reference (random identifier → chat, checker, attempts). Schema and reference go through
//      the ENVIRONMENT to the agent's cbase MCP server (CBASE_SCHEMA, CBASE_SCHEMA_REFERENCE — like the skill catalog),
//      and only then does it show the tool `StructuredOutput`, whose input schema IS the schema.
//   3. The tool is only a messenger: it sends the object to POST /api/chats/:id/dyn-workflows/structured-output, and
//      `takeOutput` validates HERE, with ajv. An invalid one is an error tool result with the ajv wording — the model
//      corrects itself in the same turn.
//   4. If a turn ends without a valid call, the run follows up ONCE (run.js, FOLLOW_UP). After FAILED_ATTEMPTS_MAX
//      invalid calls — or when the follow-up brought nothing either — `agent()` yields `null`, and `log()` names the
//      agent (`withoutResultText`).
// The CLIs' native schema flags (`--json-schema`, `--output-schema`) are not used: Claude, Codex and the loop engine
// take the same path through the MCP server. For the engine the follow-up is the normal case — it cannot force a tool
// call.
//
// Wordings of the throws and of the cap follow the binary of the pinned Claude version ("agent({schema}) received an
// invalid JSON Schema: …", "Failed to provide valid structured output after N attempts — last StructuredOutput error:
// …").
//
// A leaf except for ajv and the name leaf of the MCP tree.

import crypto from "node:crypto";
import AjvModule from "ajv";
import { STRUCTURE_TOOL } from "../../mcp/visibility.js";

const Ajv = AjvModule.default || AjvModule;

export const TOOL = STRUCTURE_TOOL;
export const FAILED_ATTEMPTS_MAX = 5;

/** The addition to the system prompt of an agent with a schema (behind its frame). */
export const STRUCTURE_FRAME = [
  "",
  "",
  "# Your result is an object",
  `This call requires a structured result: deliver it through the tool ${TOOL} (on the cbase MCP server,`,
  `e.g. mcp__cbase__${TOOL}). Call it EXACTLY ONCE with the complete object, as your last action — the`,
  "object is your return value, not your last text. If it is invalid, you get the reason as a tool error:",
  "correct the object and call the tool again.",
].join("\n");

/** The message the run follows up with once when a turn ended without a valid call. */
export const FOLLOW_UP = `You ended your turn without delivering a valid result through ${TOOL}. Call ${TOOL} now with`
  + " the complete object.";

/** An unsatisfiable or invalid schema — agent() throws it before anything starts. */
export class SchemaError extends Error {
  constructor(message) { super(message); this.name = "SchemaError"; }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UNSATISFIABLE = "agent({schema}): unsatisfiable JSON Schema — ";

/**
 * Check the schema of an agent() call before the start: root `type: "object"` with `properties`, `required` ⊆
 * `properties`, and ajv must compile it. Throws `SchemaError`.
 * @returns {(value: unknown) => boolean} the compiled checker (ajv, `errors` on the checker)
 */
export function checkSchema(schema) {
  if (!isObject(schema) || schema.type !== "object") {
    throw new SchemaError(`${UNSATISFIABLE}the root schema must declare type: 'object' (the API rejects any other root type for a tool input schema); wrap arrays or primitives in an object property`);
  }
  if (!isObject(schema.properties)) {
    throw new SchemaError(`${UNSATISFIABLE}the root schema must declare properties: {...} — an object-rooted schema without properties gives the agent nothing to fill in`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new SchemaError(`${UNSATISFIABLE}required must be an array of property names`);
    const missing = schema.required.filter((k) => typeof k !== "string" || !Object.hasOwn(schema.properties, k));
    if (missing.length) {
      throw new SchemaError(`${UNSATISFIABLE}required ${missing.map((k) => JSON.stringify(k)).join(", ")} not in properties — no output can satisfy this schema, so ${TOOL} validation would fail on every attempt`);
    }
  }
  try {
    return new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch (e) {
    throw new SchemaError(`agent({schema}) received an invalid JSON Schema: ${e?.message || e}`);
  }
}

/** The ajv wording of a failure — path (or "(root)") and message per error. */
export const ajvWording = (error) => (error || []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");

// The open references: identifier → { chatId, check, attempts, failedAttempts, lastError, accepted, object, replaceable }.
// `replaceable`: once a message reached the agent, the NEWEST valid object counts — an invalid one replaces nothing.
// The marker hangs on the EVENT "a message arrived", not on the state at sending, and stays set: normally the message
// arrives BEFORE acceptance (Codex: during turn 1, read only in the continuation; Claude: in stdin while the model
// calls StructuredOutput) — a marker that only reopened an already accepted object and fell at acceptance would give
// the script the object from BEFORE the message.
const open = new Map();

/**
 * Create a reference for ONE agent() call. `check` is the checker from `checkSchema` (thrown there before anything is
 * created here).
 * @returns {{ reference: string, stand: () => Object, message: () => void, close: () => void }}
 */
export function openOutput({ chatId, check }) {
  const reference = `so_${crypto.randomUUID()}`;
  const entry = { chatId: String(chatId), check, attempts: 0, failedAttempts: 0, lastError: "", accepted: false, object: null, replaceable: false };
  open.set(reference, entry);
  return {
    reference,
    snapshot: () => ({ accepted: entry.accepted, object: entry.object, attempts: entry.attempts, failedAttempts: entry.failedAttempts, lastError: entry.lastError }),
    // A message to the agent has arrived (dynworkflows/message.js): from now on every later valid object replaces the
    // accepted one — before or after acceptance.
    message: () => { entry.replaceable = true; },
    close: () => { open.delete(reference); },
  };
}

const response = (valid, text, e) => ({ status: 200, body: { valid, text, attempts: e.attempts, failedAttempts: e.failedAttempts } });

/**
 * A call of the messenger: check the object against the reference's schema. Both fields are required — a missing field
 * is not a statement (400). An unknown reference or one of another chat is 404.
 * @returns {{ status: number, body: Object }}
 */
export function takeOutput({ chatId, body }) {
  const b = isObject(body) ? body : {};
  if (typeof b.reference !== "string" || !b.reference.trim()) {
    return { status: 400, body: { error: "Field “reference” is missing: the agent's schema reference (CBASE_SCHEMA_REFERENCE)." } };
  }
  if (!Object.hasOwn(b, "object")) return { status: 400, body: { error: "Field “object” is missing: the result that is checked against the schema." } };
  const e = open.get(b.reference);
  if (!e || e.chatId !== String(chatId)) return { status: 404, body: { error: "This schema reference is not open (any more) — the agent() call has ended." } };
  if (e.accepted && !e.replaceable) return response(false, `The result has already been accepted. End your turn now.`, e);
  if (e.failedAttempts >= FAILED_ATTEMPTS_MAX) return response(false, `Cap reached: ${FAILED_ATTEMPTS_MAX} invalid calls. End your turn.`, e);
  e.attempts++;
  if (e.check(b.object)) {
    e.accepted = true;
    e.object = b.object;
    if (e.replaceable) {
      return response(true, "Accepted. Your result has been delivered; because a message was sent to you, a later valid"
        + ` object through ${TOOL} replaces this one — otherwise end your turn now without further text.`, e);
    }
    return response(true, "Accepted. Your result has been delivered — end your turn now without further text.", e);
  }
  e.failedAttempts++;
  e.lastError = ajvWording(e.check.errors);
  const rest = FAILED_ATTEMPTS_MAX - e.failedAttempts;
  return response(false, `Invalid against the schema: ${e.lastError}. `
    + (rest > 0 ? `Correct the object and call ${TOOL} again (${rest} attempt${rest === 1 ? "" : "s"} left).` : `That was invalid call number ${FAILED_ATTEMPTS_MAX} — end your turn.`), e);
}

/** The log() line when agent() with a schema yields `null` — it names the agent. */
export function withoutResultText({ label, n, agentId, snapshot, followedUp }) {
  const who = `agent ${label ? `“${label}”` : `#${n}`}${agentId ? ` (${agentId})` : ""}`;
  if (snapshot.failedAttempts >= FAILED_ATTEMPTS_MAX) {
    return `agent({schema}): ${who} returned null — Failed to provide valid structured output after ${snapshot.failedAttempts} attempts — last ${TOOL} error: ${snapshot.lastError}`;
  }
  return `agent({schema}): ${who} returned null — subagent completed without calling ${TOOL}${followedUp ? " (after in-conversation nudge)" : ""}`
    + (snapshot.lastError ? `; last ${TOOL} error: ${snapshot.lastError}` : "");
}

/** Open references (for tests). */
export const openReferences = () => open.size;
