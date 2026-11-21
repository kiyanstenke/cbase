// No fixed prompt text names what fell with Managing. The rule behind it: the execution side and the description side give the
// same answer — the frame of every workflow agent (dynworkflows/frame.js) and the AGENDA_SET of every coding main run
// (runs/system-prompt.js) must not explain the cbase to-do list and cbase_todo_list, which no run has any more.
//
//   (1) No runtime code under electron/server and electron/mcp names one of the 33 dropped tool names (DROPPED_TOOLS below) or
//       "cbase-ToDo" outside a comment. Only the places that hold the names as DATA are exempt, each with a reason (EXCEPTIONS).
//   (2) The rendered prompt texts — system prompt with and without agenda, frame of the workflow agents, channel-retrieval prompt,
//       tool primer and catalog texts of the coding groups (toolchain/tool-catalog.js) — name neither the tool names nor
//       "cbase-ToDo" nor a manager, an inbox, items or suggestions (the paths that fell with the Managing teardown).
//   (3) The base block names Coding → Scheduled for fixed times, not a workflow with a time trigger.
//
// COUNTER-TESTS: frame.js / runs/system-prompt.js back at the pre-teardown state => (1) red with both findings, (2) red for the
// system prompt with agenda and the frame; tool-catalog.js back at the old state => (2) red (primer names "Inbox");
// runs/system-prompt.js back at the old time-trigger sentence => (3) red.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/prompt-dropped-tools.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt } from "../electron/server/runs/system-prompt.js";
import { WORKFLOW_AGENT_FRAME } from "../electron/server/dynworkflows/frame.js";
import { channelStatusPrompt } from "../electron/server/communication/retrieval.js";
import { CODING_GROUPS, CODING_LORE, CODING_TOOLS, TOOL_AREAS, toolPrimer } from "../electron/server/toolchain/tool-catalog.js";

const ELECTRON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron");

// Places that hold the dropped names as DATA (relative to electron/), each with a reason.
const EXCEPTIONS = new Map([
  ["server/channels/migration-communication-table.js", "rename table for the tool list of stored agents (old name → new)"],
]);

// The tool names that fell with Managing — a frozen copy (the runtime no longer knows them; it was the list of the removed
// schedule migration, store/scheduled-migration.js).
const DROPPED_TOOLS = Object.freeze([
  "cbase_fact_search", "cbase_fact_get", "cbase_fact_create", "cbase_fact_update",
  "cbase_pfact_search", "cbase_pfact_get", "cbase_pfact_create", "cbase_pfact_update",
  "cbase_doc_list", "cbase_doc_read", "cbase_doc_write", "cbase_doc_import", "cbase_doc_move", "cbase_doc_delete",
  "cbase_memory_read", "cbase_memory_update",
  "cbase_proposal_list", "cbase_proposal_submit", "cbase_proposal_withdraw",
  "cbase_schedule_list", "cbase_schedule_create", "cbase_schedule_update", "cbase_schedule_delete", "cbase_schedule_run",
  "cbase_todo_list", "cbase_todo_create", "cbase_todo_update", "cbase_todo_delete", "cbase_todo_link_context",
  "cbase_chat_assign", "cbase_hook_install", "cbase_hook_remove", "cbase_workflow_list",
]);
const names = DROPPED_TOOLS;
const PATTERN = new RegExp(`\\b(?:${names.join("|")})\\b|cbase-ToDo`);

/** A file's code without comments — line and block comments; a `//` after whitespace counts as a line comment. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((z) => (/^\s*\/\//.test(z) ? "" : z.replace(/\s\/\/\s.*$/, "")))
    .join("\n");
}

function jsFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...jsFiles(path.join(dir, e.name), r)); }
    else if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(r);
  }
  return out;
}

test("(1) no runtime code names a dropped tool name or \"cbase-ToDo\" (except the named data places)", (t) => {
  t.diagnostic(`${names.length} dropped names`);
  const files = [...jsFiles(path.join(ELECTRON, "server"), "server"), ...jsFiles(path.join(ELECTRON, "mcp"), "mcp")];
  assert.ok(files.length > 100, `too few files read (${files.length}) — wrong location?`);
  for (const a of EXCEPTIONS.keys()) assert.ok(files.includes(a), `exception without file: ${a} — remove it`);
  const findings = [];
  for (const rel of files) {
    if (EXCEPTIONS.has(rel)) continue;
    const rows = withoutComments(fs.readFileSync(path.join(ELECTRON, rel), "utf8")).split("\n");
    rows.forEach((z, i) => { const m = z.match(PATTERN); if (m) findings.push(`${rel}:${i + 1} "${m[0]}"`); });
  }
  assert.deepEqual(findings, [], `dropped names in runtime code:\n${findings.join("\n")}`);
});

test("(2) the rendered prompt texts name neither dropped tools nor the to-do list, manager, inbox, items or suggestions", () => {
  const dropped = new RegExp(`${PATTERN.source}|\\bManager|\\bInbox\\b|\\bItem\\b|\\bsuggestions\\b`);
  const texts = {
    "system prompt with agenda": buildSystemPrompt("", { full: true, agenda: true }),
    "system prompt without agenda": buildSystemPrompt("", { full: true, agenda: false }),
    "frame of the workflow agents": WORKFLOW_AGENT_FRAME,
    "channel retrieval": channelStatusPrompt({ chat: { title: "X" }, rows: [{ at: "", role: "user", text: "hallo" }] }),
    // The tool primer and the catalog texts of the coding groups (the outer-loop agents' editor shows them).
    "tool primer (full)": toolPrimer(CODING_TOOLS),
    "tool primer (read-only)": toolPrimer(["cbase_agents_list"]),
    ...Object.fromEntries(CODING_GROUPS.map((g) => [`group ${g.key}`, g.description])),
    ...Object.fromEntries(TOOL_AREAS.map((b) => [`area ${b.key}`, b.description])),
    ...Object.fromEntries(CODING_LORE.flatMap((k, i) => [[`lore ${i} row`, k.row], [`lore ${i} readRow`, k.readRow || ""]])),
  };
  for (const [where, text] of Object.entries(texts)) {
    assert.ok(typeof text === "string", `${where}: not a text`);
    const m = text.match(dropped);
    assert.equal(m, null, `${where} names "${m?.[0]}": …${m ? text.slice(Math.max(0, m.index - 80), m.index + 80) : ""}…`);
  }
  assert.match(texts["system prompt with agenda"], /AGENDA \(cbase_agenda/, "the agenda is in the prompt — otherwise (2) checks the wrong thing");
});

// (3) The schedule sentence in the base block once sent the user to a "workflow with a time trigger" — there is no time trigger
// (workflows/triggers.js knows only GitLab), so it names Coding → Scheduled.
test("(3) the base block names Coding → Scheduled for fixed times, no workflow with a time trigger", () => {
  for (const agenda of [true, false]) {
    const text = buildSystemPrompt("", { full: true, agenda });
    assert.doesNotMatch(text, /time trigger/i, "there is no time trigger");
    assert.match(text, /under Coding → Scheduled, not as a cron in the chat/, "the user creates jobs at fixed times under Scheduled");
  }
});
