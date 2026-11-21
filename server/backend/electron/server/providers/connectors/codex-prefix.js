// The prefix of a Codex run: cbase's defaults (the system prompt that Claude gets via --append-system-prompt — Codex
// has no counterpart for it) and the NAMES of the MCP tools of this run, put in front of the input — but only if the
// thread does not carry them yet.
//
// WHY THE NAME LIST. Since Codex 0.15x the model sees NO MCP tool up front: they are deferred sub-tools of code mode
// (`exec`), visible only at runtime via `ALL_TOOLS` (no switch brings them back — `--disable code_mode_host`/
// `code_mode` measured without effect). Without the list Codex only finds tools the system prompt happens to mention,
// or through broad `ALL_TOOLS` searches (~10k tokens per search, capped). The list is therefore the set the run REALLY
// has: computed from the `env` of its cbase server entry with the same function the MCP server uses for `tools/list`
// (mcp/offering.js), cut by `enabledTools` (the `-c mcp_servers.<name>.enabled_tools` of pushMcpConfig).
// Call and lookup pattern measured (0.151.0, 0.153.1 and 0.162.1): `ALL_TOOLS` carries `{ name, description }`, `name`
// is `mcp__cbase__<tool>`, `description` ends with the exec declaration including parameters ("exec tool declaration:
// declare const tools: { mcp__cbase__…(args: {…}) … }"), and `await tools.mcp__cbase__<tool>({…})` reaches the server.
// Measured against the pinned Codex CLI (on every CLI jump; the measurement also covers the shape of the
// user message in the rollout, the appending on resume and the naming rule for foreign servers). MEASURED_ON_CODEX
// below is bound to the pin in server/backend/Dockerfile (guard in server/backend/test/codex-prefix.test.js): a Codex
// jump is red until re-measured. Result at 0.162.1: (a) ALL_TOOLS `{ name, description }` including the declaration,
// the call reaches the server; (b) the input stands VERBATIM as `response_item` message role user (plus `event_msg`
// item_completed UserMessage — `user_message` is no longer written since 0.153.1); (c) resume writes into the same
// rollout; (d) foreign names: server `mein-srv` + tool `werk-zeug.x` ⇒ `mcp__mein_srv__werk_zeug_x` (see
// codexExecName). 0.162.1 brings `codex migrate-rollouts` and the feature `background_paginated_rollout_migration`
// (off by default): a migration of the rollouts to another place or format would make the proof below come up empty —
// then the block is sent (nothing goes wrong, it only gets more expensive); re-measure before switching it on.
// NOT as `-c developer_instructions`: measured, a changed value is IGNORED on `resume` — after an instance switch the
// old list would stand there.
//
// WHY NOT EVERY TURN. With Codex the system prompt stands in the history and stays (Claude gets it anew per turn as
// the system prompt, with `--system-prompt-snapshot off`, and there it REPLACES the old one) — sent with every run,
// the copies (13–18k characters each) would pile up in the same thread. Measured: between two turns of the same
// thread the prefix is almost always identical — what can change (project focus, copy, goal, folder context,
// CLAUDE.md/AGENTS.md, skills, agent types, toolset) changes on an event, not per turn.
// Hence ONE block with ONE revision (hash), sent if
//   - the thread is new (no resume: first turn, after compaction, provider switch, failed resume; fork) or
//   - the resumed thread does not PROVABLY carry this revision as its MOST RECENT block.
// The proof is the thread itself: its rollout file (which Codex loads on resume), and only in the home of THIS run
// (Codex only reads its own on resume — codex.js rolloutOfTheThread). The search runs from the end for the most recent
// line that decides something:
//   - a compaction by Codex (`"type":"compacted"`) ⇒ no — the replacement history keeps user messages only up to a
//     budget and truncates them in the middle;
//   - a user message (`response_item`, the lines Codex replays on resume — not `event_msg`) whose text BEGINS with the
//     header `[SYSTEM-DEFAULTS` (any revision, also the old form without one): yes only if it begins verbatim with
//     THIS block; any other revision ⇒ no. Only the most recent block counts ("a newer revision replaces this one
//     entirely"): after A, B, A is due again (project there and back, copy → main, goal set → cleared, skill on → off
//     …). A QUOTE of the marker (completion notice, channel, pasted text) does not begin with the header and does not
//     count; a forged header with the right revision but a different body is not a block of this revision (verbatim,
//     not just the marker).
// No storage in the database: a server restart loses nothing (the rollout lies where it lay), and where the proof is
// missing — rollout not found or not readable, format unknown, cap reached, thread from before the revision —, the
// block is sent. In the process the module only remembers up to which line boundary a rollout has been checked and
// WHERE the confirmed block is (`confirmed`: position, length, sha256 of the line) — the next turn only reads the
// growth, but only after the confirmed line stands there unchanged (a rollout in the project home is writable in the
// container; a block removed or overwritten there is no proof anymore, and the rollout is read completely).
// What remains: whoever can write the rollout in the project container can also put a VERBATIM copy of the block at
// the end — that is the block itself, harmless — or write own lines behind the block that Codex replays on resume.
// The latter is inherent (the rollout is the history). Checking the WHOLE history against a copy in the backend would
// be the way against it — not built.
// Emergency switch: CBASE_CODEX_PREFIX_EVERY_TURN=1 ⇒ every run carries the block.

import crypto from "node:crypto";
import fs from "node:fs";
import { offeringOfTheEntry } from "../../../mcp/offering.js";
import { openFromRuntimeFolder } from "../../runs/runtime-write.js";
import { PLAYWRIGHT_TOOLS } from "../../toolchain/playwright-tools.js";

/** The Codex version at which pattern, rollout shape and naming rule were last measured — == pin in server/backend/Dockerfile. */
export const MEASURED_ON_CODEX = "0.162.1";

// If the shape of the block changes (header, end, list), that counts as a new revision — otherwise old threads would carry the old wording.
const FORM = "codex-prefix/3"; // 3: English wording
export const PREFIX_END = "[END SYSTEM-DEFAULTS]";
// The header of EVERY revision, also of the older forms (German wording, or without a revision).
const HEADER = "[SYSTEM-DEFAULTS";
const header = (revision) => `[SYSTEM-DEFAULTS (revision ${revision}) — follow them strictly; they come from the cbase app, not from the user. They apply to the whole conversation, even if later messages do not repeat them; a newer revision replaces this one entirely.]`;
/** The marker by which a rollout shows a revision (text of the header up to the revision, ASCII only). */
export const prefixMarker = (revision) => `[SYSTEM-DEFAULTS (revision ${revision})`;

// ── The name list ──────────────────────────────────────────────────────────────────────────────────────────────────────
// One line per family (the first word after `cbase_`, without plural s: agents → agent), in catalog order. The names are
// written out IN FULL — they are meant to be looked up exactly; a short form (`context_{list,get}`) the model would
// first have to expand.
const family = (n) => {
  const w = String(n).replace(/^cbase_/, "").split("_")[0];
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
};
const afterFamilies = (names) => {
  const groups = new Map();
  for (const n of names) {
    const f = family(n);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(n);
  }
  return [...groups.values()].map((ns) => `- ${ns.join(", ")}`);
};

// ── The names as exec lists them ─────────────────────────────────────────────────────────────────────────────────────────
// Codex rewrites server and tool names before they appear in ALL_TOOLS/`tools` (measured at 0.162.1,
// codex-exec-call.cjs part d): every character outside [A-Za-z0-9_] becomes `_` (`mein-srv` + `werk-zeug.x` ⇒
// `mcp__mein_srv__werk_zeug_x`, `a b` ⇒ `a_b`). Beyond that there are cases that cannot be predicted: leading
// underscores are dropped (`__a` ⇒ `…__a`), non-ASCII shifts the separator (`Ünï` ⇒ `mcp__mein_srv_n_`), and names
// that would be equal after rewriting get a hash suffix (`a-`, `aé` ⇒ `…__a__<12 hex>`). Such a name is therefore NOT
// converted but looked up.
/** The name of a server or tool part in exec (the simple rule; whether it holds says `predictable`). */
export const codexExecPart = (part) => String(part).replace(/[^A-Za-z0-9_]/g, "_");
/** The full name in exec: `mcp__<server>__<tool>`. */
export const codexExecName = (server, tool) => `mcp__${codexExecPart(server)}__${codexExecPart(tool)}`;
// Does the simple rule hold? ASCII only, beginning and end a letter or digit (exactly these cases are measured) — and
// no other known name of the same server yields the same name (otherwise Codex appends a hash).
const NAME_SIMPLE = /^[A-Za-z0-9](?:[\x20-\x7e]*[A-Za-z0-9])?$/;
function predictable(tools) {
  const count = new Map();
  for (const w of tools) count.set(codexExecPart(w), (count.get(codexExecPart(w)) || 0) + 1);
  return (w) => NAME_SIMPLE.test(String(w)) && count.get(codexExecPart(w)) === 1;
}

/**
 * The tool names of this run per MCP server, from the server map that pushMcpConfig also translates into `-c`.
 * → [{ server, names }] — `names` null: the server only names them at runtime (a foreign server without an allowlist);
 * RAW names. cbase: the offering of its `env` (mcp/offering.js), cut by `enabledTools`. Playwright: the fixed set of
 * the pinned version (toolchain/playwright-tools.js, bound to the real MCP), cut by `enabledTools` — the name
 * `playwright` is reserved (toolchain/mcp-config.js RESERVED_MCP_NAMES), under it always stands cbase's own entry. A
 * foreign server: `enabledTools`, otherwise unknown. A server with `enabledTools: []` is blocked (Codex: "[] blocks the
 * server", f21-codex-enabled-tools.cjs) and is missing.
 */
export function codexToolNames(mcpServers) {
  const out = [];
  for (const [server, s] of Object.entries(mcpServers || {})) {
    if (!s) continue;
    const only = Array.isArray(s.enabledTools) ? new Set(s.enabledTools.map(String)) : null;
    if (server === "cbase") {
      out.push({ server, names: offeringOfTheEntry(s) });
      continue;
    }
    if (server === "playwright") {
      const names = PLAYWRIGHT_TOOLS.filter((n) => !only || only.has(n));
      if (names.length) out.push({ server, names });
      continue;
    }
    if (only) { if (only.size) out.push({ server, names: [...only] }); continue; }
    out.push({ server, names: null });
  }
  return out;
}

// A foreign server as a line: the predictable names in full (the way exec lists them), the rest via the lookup. The
// lookup filter ends on ONE underscore — that way it also finds the shifted names (`mcp__mein_srv_n_`).
function foreignRow(server, names) {
  const s = codexExecPart(server);
  const search = `\`ALL_TOOLS.filter((x) => x.name.startsWith("mcp__${s}_")).map((x) => x.name)\``;
  if (!names) return `- ${server}: names via ${search}`;
  const matches = predictable(names);
  // Many names, all predictable (Playwright: 57): the pattern once, then the names — the way the system prompt names
  // them (browser_tabs …), instead of `mcp__playwright__` in front 57 times.
  if (names.length > SHORT_FORM_FROM && names.every(matches)) {
    return `- ${server} (in exec \`${codexExecName(server, "")}<name>\`): ${names.map(codexExecPart).join(", ")}`;
  }
  const full = names.filter(matches).map((w) => codexExecName(server, w));
  const rest = names.length - full.length;
  if (!full.length) return `- ${server}: ${rest} tool${rest === 1 ? "" : "s"} with special characters in the name — names via ${search}`;
  return `- ${server}: ${full.join(", ")}${rest ? ` — plus ${rest} with special characters in the name, via ${search}` : ""}`;
}
const SHORT_FORM_FROM = 8;

// Images in tool results (caps.vision): an MCP result with an image block reaches Codex ONLY if the exec code passes
// the block to `image(…)`; returned, it stays an object in the script and the model sees nothing (measured at 0.162.1,
// on the wire: returned ⇒ no image, `image(r)` ⇒ error, `image(<image block>)` ⇒
// `input_image`; likewise `image(await tools.view_image({ path }))`). The line only appears if a tool of the run
// delivers images.
const IMAGE_TOOLS = Object.freeze({ cbase: ["cbase_screenshot", "cbase_recording_stop"], playwright: ["browser_take_screenshot"] });
function imageRow(server) {
  const hits = server.flatMap(({ server: s, names }) => (names || []).filter((n) => (IMAGE_TOOLS[s] || []).includes(n)).map((n) => codexExecName(s, n)));
  if (!hits.length) return "";
  return `Images in a tool result (${hits.join(", ")}) are only visible to you if you pass the image block to \`image(…)\` in exec: `
    + `\`const r = await tools.${hits[0]}({ … }); image(r.content.find((x) => x.type === "image"));\` — an image file on disk with `
    + "`image(await tools.view_image({ path }))`.";
}

/** The block with the names (empty if the run has no MCP server). */
export function codexToolList(mcpServers) {
  const server = codexToolNames(mcpServers);
  if (!server.length) return "";
  const hex = server.find((x) => x.server === "cbase");
  const foreign = server.filter((x) => x.server !== "cbase");
  // The sentence about ALL_TOOLS: the CLI's exec description says "To find one, filter `ALL_TOOLS` by `name` and
  // `description`" (bv1-codex-mcp-image.cjs) — the wording here must not contradict it: the names are already there,
  // filtering is just not needed.
  const rows = ["# MCP tools of this run",
    "You have them even if your tool list does not show them: they are sub-tools of `exec`. Call in exec: `await tools.mcp__cbase__<name>({ … })`. "
      + "Parameters of a tool: `text(ALL_TOOLS.find((x) => x.name === \"mcp__cbase__<name>\").description)` — the names are listed here in full, you do not have to filter ALL_TOOLS by name and description first to find one."];
  if (hex) rows.push(...(hex.names.length ? afterFamilies(hex.names) : ["This run has no cbase tools."]));
  if (foreign.length) {
    rows.push("Other servers — here with the FULL name in exec (call `await tools.<full name>({ … })`, parameters via `ALL_TOOLS.find((x) => x.name === \"<full name>\")`):");
    for (const { server: s, names } of foreign) rows.push(foreignRow(s, names));
  }
  const image = imageRow(server);
  if (image) rows.push(image);
  return rows.join("\n");
}

/** The whole block including the revision — `null` if there is nothing to prepend. */
export function codexPrefix(systemPrompt, toolList = "") {
  const body = [String(systemPrompt || "").trim(), String(toolList || "").trim()].filter(Boolean).join("\n\n");
  if (!body) return null;
  const revision = crypto.createHash("sha256").update(`${FORM}\n${body}`).digest("hex").slice(0, 12);
  return { revision, text: `${header(revision)}\n${body}\n${PREFIX_END}` };
}

// ── The proof in the rollout ─────────────────────────────────────────────────────────────────────────────────────────
// Read from the end, block by block, at most PREFIX_SCAN_MAX bytes — for the backend's homes as for the project homes;
// a file from a project home via the descriptor path (O_NOFOLLOW|O_NONBLOCK, regular files only, no mtime in the
// future). The cap is larger than the 1 MiB of the token readers in codex.js because the block can lie far back (a
// turn with a lot of tool output; rollouts up to 90 MB measured) — if it lies beyond, the block is sent, and the next
// turn finds it at the end. The cost is linear: a line across several blocks is collected as a list of pieces and
// joined ONCE (40 MiB without a line break: the cap applies after 32 blocks).
export const PREFIX_SCAN_MAX = 32 * 1024 * 1024;
const BLOCK = 1024 * 1024;
const FUTURE_SLACK_MS = 5000;
// threadId → { p, ino, size, revision, row: { pos, length, sha } }: up to `size` (a line boundary) the rollout is
// checked, and `row` is the confirmed block — the growth is only read if it stands there unchanged.
const confirmed = new Map();
export function forgetPrefixConfirmation() { confirmed.clear(); }

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// The text of a user message as Codex replays it on resume (`response_item` message role user) — the first text part
// that begins with the header, otherwise null.
function blockTheRow(j) {
  if (j?.type !== "response_item") return null;
  const p = j.payload || {};
  if (p.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return null;
  const t = p.content.find((c) => c && c.type === "input_text" && typeof c.text === "string" && c.text.startsWith(HEADER));
  return t ? t.text : null;
}
// A line → "yes" (the most recent block is THIS one, verbatim), "no" (compaction or another block), null (says nothing).
function verdictTheRow(row, prefix) {
  if (row.includes('"type":"compacted"') || row.includes('"type":"context_compacted"')) {
    let j = null;
    try { j = JSON.parse(row); } catch { return "no"; } // cut off: when in doubt a compaction
    if (j?.type === "compacted" || j?.payload?.type === "context_compacted") return "no";
  }
  if (!row.includes(HEADER)) return null;
  let j = null;
  try { j = JSON.parse(row); } catch { return null; }
  const block = blockTheRow(j);
  if (block === null) return null; // a quote, a response, an event_msg
  return block === prefix.text || block.startsWith(`${prefix.text}\n`) ? "yes" : "no";
}

// The lines of an area from the end: the first hit decides. → { verdict, pos, length, sha } | null
function verdictInArea(area, areaBeginning, prefix) {
  let end = area.length;
  for (;;) {
    const nl = end > 0 ? area.lastIndexOf(0x0a, end - 1) : -1;
    const beginning = nl + 1;
    if (end > beginning) {
      const u = verdictTheRow(area.toString("utf8", beginning, end), prefix);
      if (u) return { verdict: u, pos: areaBeginning + beginning, length: end - beginning, sha: u === "yes" ? sha256(area.subarray(beginning, end)) : null };
    }
    if (nl < 0) return null;
    end = nl;
  }
}

function readExactly(fd, pos, length) {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const r = fs.readSync(fd, buf, n, length - n, pos + n);
    if (!r) break;
    n += r;
  }
  return n === length ? buf : null;
}

// From `end` backward to `ab` → { verdict: "yes"|"no"|null, complete, lineEnd, hits }: `complete` = read down to `ab`
// without the cap; `lineEnd` = the position behind the last line break in the area (null: none) — a cut-off last line
// does not count as checked; `hits` = the deciding line (position, length, sha256).
function readBackward(fd, from, end, prefix) {
  let chunks = []; // a line that spans block boundaries: its pieces, the LAST one first
  let read = 0;
  let lineEnd = null;
  while (end > from) {
    const length = Math.min(BLOCK, end - from, PREFIX_SCAN_MAX - read);
    if (length <= 0) return { verdict: null, complete: false, lineEnd };
    const start = end - length;
    const buf = readExactly(fd, start, length);
    if (!buf) return { verdict: null, complete: false, lineEnd }; // the file shrank while reading
    read += length;
    if (lineEnd === null) { const i = buf.lastIndexOf(0x0a); if (i >= 0) lineEnd = start + i + 1; }
    const atStart = start === from;
    const first = buf.indexOf(0x0a);
    if (!atStart && first < 0) { chunks.push(buf); end = start; continue; } // a line longer than the block
    const front = atStart ? buf : buf.subarray(first + 1);
    const area = chunks.length ? Buffer.concat([front, ...chunks.reverse()]) : front;
    const t = verdictInArea(area, atStart ? start : start + first + 1, prefix);
    if (t) return { verdict: t.verdict, complete: true, lineEnd, hits: t };
    chunks = atStart ? [] : [buf.subarray(0, first)];
    end = start;
  }
  return { verdict: null, complete: true, lineEnd };
}

// Does the confirmed line still stand there unchanged?
function rowUnchanged(fd, z) {
  if (!z) return false;
  const buf = readExactly(fd, z.pos, z.length);
  return Boolean(buf) && sha256(buf) === z.sha;
}

/**
 * Does the thread (`file` = its rollout `{ p, project }`, see codex.js rolloutOfTheThread) carry this block (`prefix` =
 * `{ revision, text }` from codexPrefix) as its MOST RECENT one, verbatim and without a compaction after it? When in
 * doubt `false`.
 */
export function prefixInThread(threadId, file, prefix) {
  if (!threadId || !file?.p || !prefix?.revision || !prefix?.text) return false;
  let fd = null;
  try {
    fd = file.project ? openFromRuntimeFolder(file.p) : null;
    if (fd === null) fd = fs.openSync(file.p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (file.project && st.mtimeMs > Date.now() + FUTURE_SLACK_MS)) { confirmed.delete(threadId); return false; }
    const c = confirmed.get(threadId);
    const from = c && c.p === file.p && c.ino === st.ino && c.revision === prefix.revision && st.size >= c.size && rowUnchanged(fd, c.row) ? c.size : 0;
    const { verdict, complete, lineEnd, hits } = readBackward(fd, from, st.size, prefix);
    const alive = verdict === "yes" || (verdict === null && from > 0 && complete);
    if (alive) {
      const row = hits ? { pos: hits.pos, length: hits.length, sha: hits.sha } : c.row;
      confirmed.set(threadId, { p: file.p, ino: st.ino, size: lineEnd ?? from, revision: prefix.revision, row });
    } else confirmed.delete(threadId);
    return alive;
  } catch {
    confirmed.delete(threadId);
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * The input of the first process of a Codex run: the block in front if the thread is new or does not provably carry
 * it — otherwise the input alone. `threadId`: the resumed thread (null for a new thread and a fork), `rollout`:
 * threadId → `{ p, project }` | null (in the home of THIS run). Returns `{ text, prefix, sent }`.
 */
export function codexInput(spec, input, { threadId = null, rollout = () => null } = {}) {
  const prefix = codexPrefix(spec?.systemPrompt, codexToolList(spec?.mcpServers));
  if (!prefix) return { text: input, prefix: null, sent: false };
  const everyTurn = process.env.CBASE_CODEX_PREFIX_EVERY_TURN === "1";
  if (!everyTurn && threadId && prefixInThread(threadId, rollout(threadId), prefix)) return { text: input, prefix, sent: false };
  return { text: `${prefix.text}\n\n${input}`, prefix, sent: true };
}
