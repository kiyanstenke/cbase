// Guard: every oneshot with foreign text runs sandboxed (runs/sandboxing.js: empty cwd `DIRS.empty` + `withoutTools`).
//
// THE REASON. Eight oneshots used to run as a full agent: the goal verdict (runs/post-run.js judgeGoal), compaction (claude.js
// compactConversation), the verdicts of the graph workflows (workflows/driver.js verdictOneshot) and claude.js classifyContext,
// classifyProjectDump, mergeProjectContext, routeDumpToProject, curateContext, with the CLI's tool set in the folder of the chat,
// project or workspace, `classifyContext` even WITHOUT cwd, i.e. in the server's folder (in the container `/home/agent`: DB with
// GitLab tokens, `~/.claude`). Their material is foreign text (histories with tool output, web pages, dropped documents); an
// injected instruction could make the CLI read files, and the answer lands as summary, context entry, suggestion or verdict note
// in later prompts. An unsandboxed oneshot also costs the CLI's full system prompt with catalog (a title measured 44,000 characters
// for 370).
//
// THE PROMISES, each with the way that breaks it:
//   (A1) SOURCE TEXT. Every call of `runOnce(`/`runOnceClaude(`/`runOnceCodex(` (also `x.runOnce(`) in a .js file under
//        server/backend/electron/server/ except providers/ carries as options an object with `...sandboxed()` at the top level, NO
//        spread after it, without an own `cwd`/`withoutTools` in any spelling (that would override the sandboxing) and without a
//        computed key; or a name whose `const`/`let` object in the same function looks exactly like that and is not modified there
//        (`.cwd =`, `[...] =`, `delete`, `Object.assign`, new assignment). Exempt is only what stands in EXCEPTIONS with reason and
//        count (file + enclosing function + EXACTLY that many raw calls). Red: a new unsandboxed call; an entry without an
//        unsandboxed call (the list may only shrink, also when the place has been sandboxed meanwhile); a second raw call in the
//        function of an exception; a `runOnce` under another name (`import { runOnce as ... }`, `const x = runOnce`) or as a string
//        (`m["runOnce"](...)`); a caller from KNOWN without a sandboxed call (the reader would read nothing any more, and an empty
//        findings list would be green). Comments do not count, strings only as a whole name (`views`, copy from
//        in-project-start-places.test.js; a .test.js never imports another).
//   (A2) The built-in sabotage shows every rule of (A1) red, including the five bypasses: spread after the sandboxing, modified
//        named object, `Object.assign`, access via `["runOnce"]`, a second raw call in scanServices.
//   (A3) The STATE BEFORE THE SANDBOXING (the eight callers as they stood at the old commit, reduced to their calls, inserted in
//        place of their three files) is red, with exactly the eight callers (nine calls: compaction has its retry) and nothing else.
//   (B)  BEHAVIOR with a fake CLI at the real server (agent-harness.mjs): goal verdict and compaction spawn the Claude CLI with
//        `--tools ""`, strict empty MCP configuration and cwd `DIRS.empty` (not the workspace), and their answers take effect (the
//        goal is reached and cleared, compaction reports ok).
//   (C)  The six wrappers in claude.js give `runOnce` cwd `DIRS.empty` and `withoutTools: true` (spy at the connector), the service
//        scan does NOT (it reads the project: `onlyRead`, its cwd). Without DIRS set, `sandboxed()` throws.
//   (D)  No provider fails on the options: Codex gets CODEX_WITHOUT_FILE_ACCESS and `-C DIRS.empty` (cwd likewise), the API
//        connector (only OpenRouter over openai-chat) answers and sends no `tools` field; `cwd`/`withoutTools` mean nothing there.
// The effect at the remaining callers is held by the golden runs (spawn.json: cwd and argv of the curator in `curate`,
// of the verdicts in `workflow`, of goal verdict and compaction in `targetGate`).
//
// WHAT THIS GUARD DOES NOT SEE: whether the prompt of a caller really carries everything (the eight were read during the rebuild:
// none needed a tool); oneshots outside electron/server/ (the MCP server under electron/mcp/ calls none) and processes that
// providers/ itself starts (core, engine; own guards).
//
// COUNTER-TESTS (each shown red once): workflows/driver.js verdictOneshot with `cwd: resolveCwd(chat)` again => (A1) red
// ("workflows/driver.js:184 verdictOneshot ...") and golden-runs.test.js red (the `workflow` spawn.json deviates from the fixture);
// (A3) is the counter-test of the guard itself. With one rule of the reader switched off each => (A2) red with the matching
// sabotage: the spread rule ("spread after the sandboxing" stayed green), `change` ("o.cwd = c"), only its `Object.assign` pattern
// ("Object.assign(o, { cwd })"), the string search (`m["runOnce"](...)`), the count of the exception ("second raw call in
// scanServices"). runs/post-run.js judgeGoal with `...sandboxed()` BEFORE `...agentRunFor("goal")` => (A1) red. A caller removed
// from BEFORE_SANDBOXING => (A3) red (the list of places lacks it).
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap test/oneshot-sandboxing.test.js   (from server/backend/)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import { sandboxed } from "../electron/server/runs/sandboxing.js";
import { getConnector, registerConnector, runOnce } from "../electron/server/providers/index.js";
import { CODEX_WITHOUT_FILE_ACCESS } from "../electron/server/providers/connectors/codex.js";
import { replaceOpenRouter } from "./openrouter-spy.mjs";
import {
  classifyContext, classifyProjectDump, compactConversation, curateContext, mergeProjectContext, routeDumpToProject, scanServices,
} from "../electron/server/claude.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "electron", "server");
const REPO = path.resolve(SERVER, "..", "..", "..", "..");
// The callers at the state before the sandboxing (6cf4ce37), reduced to their imports and calls (word for word) — the files of that
// state with only what the guard reads. scanServices keeps its one raw call: it is the named exception then as now.
const BEFORE_SANDBOXING = {
  "claude.js": [
    'import { runOnce } from "./providers/index.js";',
    "export { runOnce };",
    'export async function compactConversation({ cwd, transcript, model, effort = "", provider, chatId = "", overruled = false } = {}) {',
    "  let result;",
    "  try {",
    "    result = await runOnce(prompt, { cwd, timeoutMs: deadline, model, effort, provider, chatId, overruled });",
    "  } catch {",
    "    result = await runOnce(prompt, { cwd, timeoutMs: deadline, model, effort, provider, chatId, overruled });",
    "  }",
    "  return result;",
    "}",
    'export async function classifyContext(text, existingCategories = [], { model = "", effort = "" } = {}) {',
    "  const result = await runOnce(prompt, { timeoutMs: 90_000, model, effort });",
    "  return result;",
    "}",
    'export async function classifyProjectDump({ cwd, text, categories, model, effort = "" } = {}) {',
    "  const result = await runOnce(prompt, { cwd, timeoutMs: 90_000, model, effort });",
    "  return result;",
    "}",
    'export async function mergeProjectContext({ cwd, existing, incomingText, categories, model, effort = "" } = {}) {',
    "  return extractJson(await runOnce(prompt, { cwd, timeoutMs: 90_000, model, effort }));",
    "}",
    'export async function routeDumpToProject({ cwd, text, projects = [], model, effort = "" } = {}) {',
    "  return extractJson(await runOnce(prompt, { cwd, timeoutMs: 90_000, model, effort }));",
    "}",
    'export async function scanServices({ cwd, model, effort = "", instance = null, projectId = null, atDismissed = null }) {',
    "  const result = await runOnce(prompt, { cwd, timeoutMs: 300_000, model, effort, onlyRead: true, instance, projectId });",
    "  return result;",
    "}",
    'export async function curateContext({ cwd, userText, assistantText, existing, categories, model, effort = "", chatId = "", approval = false }) {',
    "  const result = await runOnce(prompt, { cwd, timeoutMs: 120_000, model, effort, chatId, approval });",
    "  return result;",
    "}",
    "",
  ].join("\n"),
  "runs/post-run.js": [
    'import { compactConversation, runOnce } from "../claude.js";',
    "async function maybeAutoTitle(chat, userText, assistantText, { approval = false } = {}) {",
    '  return await runOnce(prompt, { ...sandboxed(), timeoutMs: 30_000, ...agentRunFor("title"), chatId: chat.id, approval });',
    "}",
    "async function judgeGoal(chat, userText, assistantText, { overruled = false } = {}) {",
    '  return await runOnce(prompt, { cwd: resolveCwd(chat), timeoutMs: 30_000, ...agentRunFor("goal"), chatId: chat.id, overruled });',
    "}",
    "",
  ].join("\n"),
  "workflows/driver.js": [
    'import { runOnce } from "../claude.js";',
    'async function verdictOneshot(chat, prompt, model = "", { overruled = false } = {}) {',
    '  return await runOnce(prompt, { cwd: resolveCwd(chat), timeoutMs: 60_000, model: model || agentModelFor("workflow"), effort: agentRunFor("workflow").effort, chatId: chat.id, overruled });',
    "}",
    "",
  ].join("\n"),
};

// ── (A) The tables ────────────────────────────────────────────────────────────────────────────────────────────────────────
// A oneshot that does NOT run sandboxed: file relative to electron/server, the enclosing function, the COUNT of unsandboxed
// calls in it (exactly that many, not "up to": the exception applies to the place, not the whole function; a second raw call
// next to it, e.g. in an arrow without a block, which is no function of its own, would otherwise be covered too) and the reason.
export const EXCEPTIONS = [
  { file: "claude.js", fn: "scanServices", count: 1,
    reason: "service detection READS the project with Read/Glob/Grep, that is its job. Hardened instead of sandboxed: " +
      "`onlyRead` (only these three tools, DETECTION_ENVIRONMENT, empty strict MCP configuration), in operation in the project " +
      "container (inProject, in-project-start-places.test.js), and every field of the response that looks like a credential is " +
      "dismissed (claude.js looksLikeSecret)" },
];
// Callers that MUST run sandboxed (file -> enclosing function). Not complete (a new sandboxed place needs no row), but every
// one here must be found: otherwise the reader would read nothing any more, and (A1) would be green over nothing.
export const KNOWN = [
  ["runs/post-run.js", "maybeAutoTitle"], ["runs/post-run.js", "judgeGoal"],
  ["workflows/driver.js", "verdictOneshot"],
  ["claude.js", "compactConversation"], ["claude.js", "classifyContext"], ["claude.js", "classifyProjectDump"],
  ["claude.js", "mergeProjectContext"], ["claude.js", "routeDumpToProject"], ["claude.js", "curateContext"],
  ["settings/routes.js", "adjustRoutes"], ["communication/retrieval.js", "summaryOnDemand"],
];

// ── (A) The reader (copy from in-project-start-places.test.js: views, matching, parts) ─────────────────────────────────────
// Two views of equal length (offsets match): `code` without comments, `mask` additionally without the content of strings,
// template text and regex literals (expressions in `${...}` stay code). Only the mask counts brackets.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
function views(src) {
  const n = src.length;
  const code = src.split("");
  const mask = src.split("");
  const empty = (arr, a, b) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let last = "", word = "", gap = false;
  const stringEnd = (i, q) => {
    for (let j = i + 1; j < n; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === q) return j + 1;
      if (src[j] === "\n") return j;
    }
    return n;
  };
  const regexEnd = (i) => {
    let kind = false;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "\n") return j;
      if (c === "[") kind = true;
      else if (c === "]") kind = false;
      else if (c === "/" && !kind) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
    }
    return n;
  };
  const template = (i) => {
    let beginning = i + 1;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "`") { empty(mask, beginning, j); return j + 1; }
      if (c === "$" && src[j + 1] === "{") { empty(mask, beginning, j); j = read2(j + 2, true); beginning = j + 1; }
    }
    empty(mask, beginning, n);
    return n;
  };
  function read2(i, untilBracket) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { let e = src.indexOf("\n", i); if (e < 0) e = n; empty(code, i, e); empty(mask, i, e); i = e; continue; }
      if (c === "/" && d === "*") { let e = src.indexOf("*/", i + 2); e = e < 0 ? n : e + 2; empty(code, i, e); empty(mask, i, e); i = e; continue; }
      const fresh = () => { last = "a"; word = ""; gap = false; };
      if (c === '"' || c === "'") { const e = stringEnd(i, c); empty(mask, i + 1, e - 1); i = e; fresh(); continue; }
      if (c === "`") { i = template(i); fresh(); continue; }
      if (c === "/" && (REGEX_AFTER.has(last) || REGEX_WORDS.has(word))) { const e = regexEnd(i); empty(mask, i + 1, e - 1); i = e; fresh(); continue; }
      if (/\s/.test(c)) { gap = true; i++; continue; }
      if (untilBracket) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) return i; depth--; }
      }
      word = /[\w$]/.test(c) ? (!gap && /[\w$]/.test(last) ? word + c : c) : "";
      last = c; gap = false; i++;
    }
    return n;
  }
  read2(0, false);
  return { code: code.join(""), mask: mask.join("") };
}
function matching(mask, i) {
  let depth = 0;
  for (let j = i; j < mask.length; j++) {
    const c = mask[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return j; }
  }
  return -1;
}
function parts(mask, a, b) {
  const out = [];
  let depth = 0, beginning = a;
  for (let j = a; j < b; j++) {
    const c = mask[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push([beginning, j]); beginning = j + 1; }
  }
  out.push([beginning, b]);
  return out;
}
const rowOf = (text, i) => text.slice(0, i).split("\n").length;

// The functions of a file with their body [on, zu]: `function name(`, `name = (...) =>`/`name = async x =>` with a block.
function functions(code, mask) {
  const out = [];
  const pattern = [
    /\bfunction\s*\*?\s*([\w$]+)\s*\(/g,
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/g,
  ];
  for (const re of pattern) {
    for (const m of mask.matchAll(re)) {
      const on = mask.indexOf("{", re === pattern[0] ? matching(mask, m.index + m[0].length - 1) : m.index + m[0].length - 1);
      const closeAt = on >= 0 ? matching(mask, on) : -1;
      if (on >= 0 && closeAt > on) out.push({ name: m[1], on, closeAt });
    }
  }
  return out;
}
const innermost = (fns, i) => fns.filter((f) => f.on < i && i < f.closeAt).sort((a, b) => (a.closeAt - a.on) - (b.closeAt - b.on))[0] || null;

// The options object [on, zu] of a call: a literal in second place, or a name whose last `const`/`let` assignment BEFORE the
// call in the same function is a literal. null = not readable.
function optionsObject(code, mask, part, callAt, fn) {
  const raw = code.slice(part[0], part[1]);
  const lead = raw.length - raw.trimStart().length;
  if (raw.trim().startsWith("{")) { const on = part[0] + lead; return { on, closeAt: matching(mask, on) }; }
  const name = raw.trim();
  if (!/^[\w$]+$/.test(name) || !fn) return null;
  const area = mask.slice(fn.on, callAt);
  let hits = null;
  for (const m of area.matchAll(new RegExp(`\\b(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*\\{`, "g"))) hits = m;
  if (!hits) return null;
  const on = fn.on + hits.index + hits[0].length - 1;
  return { on, closeAt: matching(mask, on), name };
}

// Verdict on an options object: `...sandboxed()` at the top level, NO spread after it (`{ ...sandboxed(), ...x }`: if x carries
// a cwd, it wins; a spread BEFORE is harmless, the sandboxing overrides it), no own key `cwd`/`withoutTools` in any spelling
// (`cwd: c`, `"cwd": c`, `cwd() {}`) and no computed key (`[k]: c`: not readable, so not promised).
const SANDBOXING = /^\.\.\.\s*sandboxed\s*\(\s*\)$/;
const OWN_KEY = /^(?:(?:get|set|async)\s+)?(["'`]?)(cwd|withoutTools)\1\s*(?::|\(|$)/;
function verdictObject(code, mask, obj) {
  if (!obj || obj.closeAt < 0) return { ok: false, why: "options not readable (no object literal and no name with a literal in the same function)" };
  const partsObj = parts(mask, obj.on + 1, obj.closeAt).map(([a, b]) => code.slice(a, b).trim()).filter(Boolean);
  const place = partsObj.findIndex((t) => SANDBOXING.test(t));
  if (place < 0) return { ok: false, why: "without `...sandboxed()`" };
  const later = partsObj.slice(place + 1).find((t) => t.startsWith("..."));
  if (later) return { ok: false, why: `spread \`${later}\` after \`...sandboxed()\` can override the sandboxing` };
  const own = partsObj.map((t) => t.match(OWN_KEY)).find(Boolean);
  if (own) return { ok: false, why: `\`${own[2]}\` overrides the sandboxing` };
  const computed = partsObj.find((t) => t.startsWith("["));
  if (computed) return { ok: false, why: `computed key \`${computed.split(":")[0].trim()}\`: not readable` };
  return { ok: true };
}

// A NAMED options object (`const o = { ...sandboxed() }; runOnce(p, o)`) must not be modified in its function where it can hit
// the sandboxing: assignment to `.cwd`/`.withoutTools` (also `?.`, `||=`, `??=` ...), every computed assignment `o[...] =` (in the
// mask `o["cwd"]` cannot be told from `o[k]`), `delete o....`, an `Object.assign`/`defineProperty`/`Reflect.set` ... on `o` and a
// new assignment `o = ...` (with `let`). The whole function is checked, not only the lines before the call: an assignment in a loop
// above hits the next iteration. Not seen: `o` passed to another function that modifies it (the guard reads no data flows).
function change(mask, fn, name) {
  if (!fn) return null;
  const body = mask.slice(fn.on, fn.closeAt);
  const n = name.replace(/\$/g, "\\$");
  const zuw = String.raw`(?:=(?![=>])|\|\|=|&&=|\?\?=)`;
  const pattern = [
    [String.raw`(?<![\w$.])${n}\s*(?:\?\.|\.)\s*(?:cwd|withoutTools)\b\s*${zuw}`, `\`${name}.cwd/withoutTools =\``],
    [String.raw`(?<![\w$.])${n}\s*(?:\?\.)?\s*\[[^\]]*\]\s*${zuw}`, `\`${name}[…] =\``],
    [String.raw`\bdelete\s+${n}\s*(?:\?\.|\.|\[)`, `\`delete ${name}…\``],
    [String.raw`\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty|setPrototypeOf))\s*\(\s*${n}\b`, `\`Object.assign(${name}, …)\` or similar`],
    [String.raw`(?<!\b(?:const|let|var)\s+)(?<![\w$.])${n}\s*${zuw}`, `new assignment \`${name} = …\``],
  ];
  for (const [re, what] of pattern) if (new RegExp(re).test(body)) return what;
  return null;
}

const NAMES = /\b(runOnce(?:Claude|Codex)?)\b/g;
// Reads ONE file: every call with function, row and verdict; also every mention of the name that is neither a call nor a plain
// import/re-export (an alias or an assignment). Remembered per path and content: the sabotage reads the tree twelve times, and
// `views` over 300 files costs a good half second per run.
const read = new Map();
function readFile(rel, src) {
  const key = `${rel}\u0000${src}`;
  if (!read.has(key)) read.set(key, readFileFresh(rel, src));
  return read.get(key);
}
function readFileFresh(rel, src) {
  const { code, mask } = views(src);
  const fns = functions(code, mask);
  const calls = [], foreign = [];
  for (const m of mask.matchAll(NAMES)) {
    const at = m.index;
    const after = mask.slice(at + m[0].length);
    const open = after.match(/^\s*\(/);
    if (open) {
      if (/\bfunction\s*\*?\s*$/.test(mask.slice(Math.max(0, at - 40), at))) continue; // the definition itself
      const bracket = at + m[0].length + open[0].length - 1;
      const closed = matching(mask, bracket);
      if (/^\s*\{/.test(mask.slice(closed + 1))) continue; // method definition `runOnce(...) {`
      const fn = innermost(fns, at);
      const args = parts(mask, bracket + 1, closed);
      const obj = args.length < 2 ? null : optionsObject(code, mask, args[1], at, fn);
      let u = args.length < 2 ? { ok: false, why: "without options" } : verdictObject(code, mask, obj);
      const changed = u.ok && obj?.name ? change(mask, fn, obj.name) : null;
      if (changed) u = { ok: false, why: `options \`${obj.name}\` are changed after creation (${changed})` };
      calls.push({ file: rel, fn: fn?.name || "(module level)", row: rowOf(src, at), name: m[0], ...u });
      continue;
    }
    // Not a call: only `import { ... runOnce ... } from ...` or `export { ... runOnce ... }` without `as` is allowed.
    const beginning = Math.max(mask.lastIndexOf(";", at), mask.lastIndexOf("\n\n", at), 0);
    const end = mask.indexOf(";", at);
    const set = code.slice(beginning, end < 0 ? undefined : end).replace(/^[;\s]+/, "");
    const plain = /^(import|export)\s*\{[^}]*\}/.test(set) && !new RegExp(`\\b${m[0]}\\s+as\\b`).test(set);
    if (!plain) foreign.push({ file: rel, row: rowOf(src, at), text: src.split("\n")[rowOf(src, at) - 1].trim(), kind: "under another name or as a value" });
  }
  // The name as a STRING: `m["runOnce"](p, { cwd })` or `const k = "runOnce"; m[k](...)` calls past the reader: the mask empties
  // strings, NAMES see nothing there. Red is every literal that is EXACTLY one of the three names (in the mask only the two quotes
  // with whitespace between them remain; a word in a longer text is none).
  for (const m of code.matchAll(/(["'`])(runOnce(?:Claude|Codex)?)\1/g)) {
    const wrapper = m[1] + " ".repeat(m[2].length) + m[1];
    if (mask.slice(m.index, m.index + m[0].length) !== wrapper) continue;
    const row = rowOf(src, m.index);
    foreign.push({ file: rel, row, text: src.split("\n")[row - 1].trim(), kind: "as a string (access via [\"...\"] past the reader)" });
  }
  return { calls, foreign };
}

function jsFiles(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules" && r !== "providers") out.push(...jsFiles(root, r)); }
    else if (e.name.endsWith(".js")) out.push(r);
  }
  return out;
}
// The tree as { rel -> source text }; `fallback` inserts single files (sabotage, old state).
function tree(fallback = {}) {
  const out = {};
  for (const rel of jsFiles(SERVER)) out[rel] = fs.readFileSync(path.join(SERVER, rel), "utf8");
  return { ...out, ...fallback };
}

// The check (A1) over a tree: a list of findings; empty = green.
function check(files, { exceptions = EXCEPTIONS, known = KNOWN } = {}) {
  const findings = [];
  const all = [], foreign = [];
  for (const [rel, src] of Object.entries(files)) {
    if (rel === "providers" || rel.startsWith("providers/")) continue;
    const r = readFile(rel, src);
    all.push(...r.calls);
    foreign.push(...r.foreign);
  }
  const isException = (a) => exceptions.some((x) => x.file === a.file && x.fn === a.fn);
  for (const a of all) {
    if (!a.ok && !isException(a)) findings.push(`${a.file}:${a.row} ${a.fn}: ${a.name}(…) ${a.why}`);
  }
  for (const x of exceptions) {
    if (!String(x.reason || "").trim()) findings.push(`exception ${x.file} ${x.fn}: without a reason`);
    if (!Number.isInteger(x.count) || x.count < 1) findings.push(`exception ${x.file} ${x.fn}: without \`count\` (the number of unsandboxed calls)`);
    const raw = all.filter((a) => !a.ok && a.file === x.file && a.fn === x.fn);
    if (!raw.length) findings.push(`exception ${x.file} ${x.fn}: no unsandboxed call (any more); remove the entry`);
    else if (Number.isInteger(x.count) && raw.length !== x.count) {
      findings.push(`exception ${x.file} ${x.fn}: ${x.count} unsandboxed call(s) named, ${raw.length} found (rows ${raw.map((a) => a.row).join(", ")}); the exception applies to the place, not the function`);
    }
  }
  for (const [file, fn] of known) {
    if (!all.some((a) => a.ok && a.file === file && a.fn === fn)) findings.push(`known ${file} ${fn}: no sandboxed call found`);
  }
  for (const f of foreign) findings.push(`${f.file}:${f.row}: runOnce ${f.kind} — ${f.text}`);
  return { findings, calls: all };
}

// (A1) Counter-test: in runs/post-run.js judgeGoal replace `...sandboxed()` by `cwd: resolveCwd(chat)` again => red
// ("runs/post-run.js:150 judgeGoal: runOnce(...) without `...sandboxed()`" and "known ... judgeGoal: no sandboxed call found");
// rename the entry `scanServices` in EXCEPTIONS => red ("claude.js:332 scanServices: runOnce(...) without ..." and
// "exception ... no unsandboxed call (any more)").
test("(A1) every runOnce under electron/server/ (without providers/) carries ...sandboxed(), except the named exception", () => {
  const { findings, calls } = check(tree());
  const from = calls.filter((a) => a.ok), raw = calls.filter((a) => !a.ok);
  console.log(`  [sandboxing] ${calls.length} calls in ${new Set(calls.map((a) => a.file)).size} files: ${from.length} sandboxed, ${raw.length} named exception(s): ${raw.map((a) => `${a.file}:${a.row} ${a.fn}`).join(", ")}`);
  assert.deepEqual(findings, []);
});

// (A2) The built-in sabotage: every rule red, without touching the tree.
test("(A2) built-in sabotage: new caller, overriding, spread after, modified object, alias, string, exception too wide; each red", () => {
  const real = tree();
  const red = (fallback, what, opts = {}, pattern = null) => {
    const { findings } = check({ ...real, ...fallback }, opts);
    assert.ok(findings.length > 0, `sabotage "${what}" stayed green`);
    if (pattern) assert.ok(findings.some((b) => pattern.test(b)), `sabotage "${what}": expected finding missing: ${findings.join(" | ")}`);
  };
  // "Green" here means: NO more findings than in the real tree, so (A2) shows only what the sabotage itself triggers, even if the
  // real tree is red right now ((A1) reports that).
  const without = check(real).findings;
  const green = (fallback, what) => assert.deepEqual(check({ ...real, ...fallback }).findings, without, `"${what}" should be green`);
  red({ "fresh.js": 'import { runOnce } from "./claude.js";\nexport async function fresh(chat) { return runOnce("p", { cwd: chat.cwd, timeoutMs: 1 }); }\n' },
    "new caller with cwd", {}, /^fresh\.js:2 fresh: runOnce\(…\) without `\.\.\.sandboxed\(\)`/);
  red({ "fresh.js": 'export async function fresh(p) { return runOnce(p); }\n' }, "call without options", {}, /without options/);
  red({ "fresh.js": 'export async function fresh(p, c) { return x.runOnce(p, { ...sandboxed(), cwd: c }); }\n' },
    "sandboxing overridden (cwd)", {}, /`cwd` overrides/);
  red({ "fresh.js": 'export async function fresh(p) { return runOnceClaude(p, { withoutTools: false, ...sandboxed() }); }\n' },
    "sandboxing overridden (withoutTools)", {}, /`withoutTools` overrides/);
  red({ "fresh.js": 'export async function fresh(p) { const o = { timeoutMs: 1 }; return runOnce(p, o); }\n' }, "named options without sandboxing", {}, /fresh: runOnce/);
  green({ "fresh.js": 'export async function fresh(p) { const o = { timeoutMs: 1, ...sandboxed() }; return runOnce(p, o); }\n' }, "named options with sandboxing");
  green({ "fresh.js": '// runOnce(p, { cwd })\nconst s = "runOnce(p, { cwd })";\nexport const t = `runOnce(${s})`;\n' }, "comment and strings");
  red({ "fresh.js": 'import { runOnce as r } from "./claude.js";\nexport const fresh = (p) => r(p, {});\n' }, "alias in the import", {}, /under another name/);
  red({ "fresh.js": 'import { runOnce } from "./claude.js";\nconst r = runOnce;\nexport const fresh = (p) => r(p, {});\n' }, "alias as a value", {}, /under another name/);
  red({}, "exception without a caller", { exceptions: [...EXCEPTIONS, { file: "claude.js", fn: "existsNot", reason: "x" }] }, /existsNot: no unsandboxed call/);
  red({}, "exception without a reason", { exceptions: EXCEPTIONS.map((x) => ({ ...x, reason: "" })) }, /without a reason/);
  const scanSandboxed = real["claude.js"].replace("runOnce(prompt, { cwd, timeoutMs: 300_000,", "runOnce(prompt, { ...sandboxed(), timeoutMs: 300_000,");
  assert.notEqual(scanSandboxed, real["claude.js"], "the line of the service scan has changed; update the sabotage");
  red({ "claude.js": scanSandboxed }, "exception sandboxed meanwhile", {}, /scanServices: no unsandboxed call/);
  red({}, "KNOWN without a match", { known: [...KNOWN, ["claude.js", "existsNot"]] }, /known claude\.js existsNot/);
  // The reader itself: without `views` (comments count) it would find the line in runs/limit-gate.js, where it appears only in a
  // comment. Here the other way round: the same line as code is red.
  red({ "fresh.js": "export function fresh(p) { return runOnce(p, { freigabe: true }); }\n" }, "comment line as code", {}, /fresh\.js:1/);

  // The bypasses: each red, and a harmless neighboring form green.
  // 1. Spread AFTER the sandboxing (x carries cwd); before it it is harmless.
  red({ "fresh.js": 'export async function fresh(p, x) { return runOnce(p, { ...sandboxed(), ...x }); }\n' },
    "spread after the sandboxing", {}, /spread `\.\.\.x` after `\.\.\.sandboxed\(\)`/);
  green({ "fresh.js": 'export async function fresh(p, x) { return runOnce(p, { timeoutMs: 1, ...x, ...sandboxed(), chatId: "c" }); }\n' }, "spread before the sandboxing");
  // 2. Named object modified afterwards: assignment, computed assignment, Object.assign, delete, new assignment.
  const named = (row) => ({ "fresh.js": `export async function fresh(p, c) { let o = { ...sandboxed() }; ${row} return runOnce(p, o); }\n` });
  red(named("o.cwd = c;"), "o.cwd = c", {}, /`o` are changed after creation \(`o\.cwd\/withoutTools =`\)/);
  red(named("o.withoutTools ??= false;"), "o.withoutTools ??= …", {}, /`o\.cwd\/withoutTools =`/);
  red(named('o["cwd"] = c;'), 'o["cwd"] = c', {}, /`o\[…\] =`/);
  red(named("Object.assign(o, { cwd: c });"), "Object.assign(o, { cwd })", {}, /Object\.assign\(o, …\)/);
  red(named("delete o.cwd;"), "delete o.cwd", {}, /`delete o…`/);
  red(named("o = { cwd: c };"), "o = { cwd }", {}, /new assignment `o = …`/);
  green(named("o.timeoutMs = 5; if (o.cwd === c) {}"), "o.timeoutMs = 5 and a comparison");
  // 3. Own key in another spelling and computed key.
  red({ "fresh.js": 'export async function fresh(p, c) { return runOnce(p, { ...sandboxed(), "cwd": c }); }\n' }, '"cwd": c', {}, /`cwd` overrides/);
  red({ "fresh.js": 'export async function fresh(p, c, k) { return runOnce(p, { ...sandboxed(), [k]: c }); }\n' }, "[k]: c", {}, /computed key/);
  // 4. Access via a string.
  red({ "fresh.js": 'export async function fresh(m, p, c) { return m["runOnce"](p, { cwd: c }); }\n' }, 'm["runOnce"](…)', {}, /runOnce as a string/);
  red({ "fresh.js": "const k = 'runOnceClaude';\nexport async function fresh(m, p, c) { return m[k](p, { cwd: c }); }\n" }, "const k = 'runOnceClaude'", {}, /fresh\.js:1: runOnce as a string/);
  // 5. A SECOND raw call in scanServices, as an arrow without a block (no function of its own for the reader).
  const scanTwice = real["claude.js"].replace("runOnce(prompt, { cwd, timeoutMs: 300_000,", "[prompt].map((q) => runOnce(q, { cwd })) && runOnce(prompt, { cwd, timeoutMs: 300_000,");
  assert.notEqual(scanTwice, real["claude.js"], "the line of the service scan has changed; update the sabotage");
  red({ "claude.js": scanTwice }, "second raw call in scanServices", {}, /scanServices: 1 unsandboxed call\(s\) named, 2 found/);
  red({}, "exception without count", { exceptions: EXCEPTIONS.map(({ count, ...x }) => x) }, /without `count`/);
});

// (A3) Against the old state: the eight callers as they stood at the old commit inserted => exactly these nine calls red,
// and since the spread rule became stricter (a spread after the sandboxing is red) the title as the tenth: it was already
// sandboxed there, but as `{ ...sandboxed(), timeoutMs, ...agentRunFor("title"), ... }`. Harmless in substance (`agentRunFor`
// only returns model and level), but the guard cannot look at a spread, so the sandboxing has stood AFTER it since
// (runs/post-run.js). The old state is BEFORE_SANDBOXING above: the three files of that state reduced to their calls — not a
// frozen copy of the production files (about 107 KB), which every text search over the tree would also find.
test("(A3) the state before the sandboxing is red, with exactly the eight callers and the title spread, nothing else", () => {
  const { findings } = check({ ...tree(), ...BEFORE_SANDBOXING }, { known: [] });
  const places = findings.map((b) => b.replace(/:\d+ /, " ").replace(/: runOnce\(…\).*$/, ""));
  assert.deepEqual(places.sort(), [
    "claude.js classifyContext", "claude.js classifyProjectDump", "claude.js compactConversation", "claude.js compactConversation",
    "claude.js curateContext", "claude.js mergeProjectContext", "claude.js routeDumpToProject",
    "runs/post-run.js judgeGoal", "runs/post-run.js maybeAutoTitle", "workflows/driver.js verdictOneshot",
  ], findings.join("\n"));
  assert.ok(findings.some((b) => /^runs\/post-run\.js:\d+ maybeAutoTitle: .*spread `\.\.\.agentRunFor\("title"\)` after/.test(b)), "the title is red BECAUSE of the spread");
});

// ── (B) Behavior at the real server ──────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: in runs/post-run.js judgeGoal `cwd: resolveCwd(chat)` again instead of `...sandboxed()` (with the import) => red
// ("Goal verdict: cwd is the empty folder, not .../workspace"); in claude.js compactConversation `...sandboxed(), ` removed from
// both calls => red ("Compaction: cwd is the empty folder, not .../backend": without cwd the CLI inherits the server's folder,
// exactly the old situation of classifyContext).
test("(B) goal verdict and compaction spawn the CLI sandboxed: --tools \"\", empty strict MCP configuration, cwd DIRS.empty", async () => {
  const oneshot = [
    'fs.appendFileSync(path.join(LOCATION, "oneshots.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), prompt }) + "\\n");',
    'if (prompt.includes("overarching target of a chat")) respond(JSON.stringify({ achieved: true, note: "done" }));',
    'else if (prompt.includes("You are compacting the chat history")) respond("- Goal: rebuild checkout\\n- Status: done");',
    'else respond("Title");',
  ].join("\n");
  await withAgentsServer(async ({ base, ws, chat, root, waitForTruthy, waitForQuiet }) => {
    const log = path.join(root, "oneshots.jsonl");
    const check = (o, what) => {
      assert.equal(fs.realpathSync(o.cwd), fs.realpathSync(DIRS.empty), `${what}: cwd is the empty folder, not ${o.cwd}`);
      assert.notEqual(fs.realpathSync(o.cwd), fs.realpathSync(ws.path), `${what}: not the workspace`);
      const i = o.argv.indexOf("--tools");
      assert.ok(i >= 0 && o.argv[i + 1] === "", `${what}: --tools "" missing: ${o.argv.join(" ")}`);
      assert.ok(o.argv.includes("--strict-mcp-config"), `${what}: strict MCP configuration`);
      assert.equal(o.argv[o.argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}', `${what}: empty MCP configuration`);
    };
    // Goal verdict: a chat with a goal, one message; after the turn the judge says "achieved", the goal is cleared.
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Rebuild the checkout" }) });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please rebuild the checkout." }) });
    const judge = await waitForTruthy(() => readJsonl(log).find((o) => o.prompt.includes("overarching target of a chat")), "goal verdict started");
    check(judge, "Goal verdict");
    assert.match(judge.prompt, /Rebuild the checkout/, "the goal is in the prompt");
    await waitForTruthy(async () => (await json(`${base}/api/chats/${chat.id}`)).goal === "", "the verdict \"achieved\" clears the goal");
    await waitForQuiet();
    // Compaction: by hand (like /compact); the route answers only after the summary.
    const v = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(v.ok, true, `compaction: ${JSON.stringify(v)}`);
    const compaction = readJsonl(log).filter((o) => o.prompt.includes("You are compacting the chat history"));
    assert.equal(compaction.length, 1, "exactly one compaction oneshot");
    check(compaction[0], "Compaction");
    assert.match(compaction[0].prompt, /Please rebuild the checkout\./, "the history is in the prompt");
  }, { claude: fakeClaude({ oneshot }) });
});

// ── (C) The wrappers in claude.js ────────────────────────────────────────────────────────────────────────────────────────────
// A spy in place of `runOnce` of the two native connectors (like oneshot-level.test.js); the dispatch stays real.
async function withSpy(fn) {
  const real = { claude: getConnector("claude"), codex: getConnector("codex") };
  const calls = [];
  try {
    for (const id of ["claude", "codex"]) registerConnector({ ...real[id], runOnce: async (prompt, opts) => { calls.push({ id, prompt, ...opts }); return "{}"; } });
    await fn(calls);
  } finally {
    registerConnector(real.claude);
    registerConnector(real.codex);
  }
}
// DIRS set with an empty folder of its own for a test without a server; afterwards the previous state (also null).
async function withEmpty(fn) {
  const prior = DIRS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-sandboxing-"));
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  try {
    setDirs({ ...(prior || {}), empty });
    await fn({ root, empty });
  } finally {
    setDirs(prior);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Counter-test: in claude.js classifyContext `...sandboxed(), ` removed => red ("classifyContext: cwd").
test("(C) the six wrappers give runOnce cwd DIRS.empty and withoutTools, the service scan does not; without DIRS sandboxed() throws", async () => {
  await withEmpty(async ({ root, empty }) => {
    await withSpy(async (calls) => {
      const run = { model: "claude::claude-sonnet-5", effort: "low" };
      const cases = {
        compactConversation: () => compactConversation({ transcript: "User: a\nAssistant: b", ...run }),
        classifyContext: () => classifyContext("A snippet", ["notes"], run),
        classifyProjectDump: () => classifyProjectDump({ text: "Dump", categories: [{ slug: "a", label: "A" }], ...run }),
        mergeProjectContext: () => mergeProjectContext({ existing: { title: "T", body: "B" }, incomingText: "fresh", categories: [{ slug: "a", label: "A" }], ...run }),
        routeDumpToProject: () => routeDumpToProject({ text: "Dump", projects: [{ id: "p1", name: "P1" }], ...run }),
        curateContext: () => curateContext({ userText: "u", assistantText: "a", existing: [], categories: [{ slug: "a", label: "A" }], ...run }),
      };
      for (const [name, calls2] of Object.entries(cases)) {
        calls.length = 0;
        await calls2().catch(() => {});
        assert.ok(calls.length >= 1, `${name}: no call of runOnce`);
        for (const a of calls) {
          assert.equal(a.cwd, empty, `${name}: cwd is DIRS.empty`);
          assert.equal(a.withoutTools, true, `${name}: withoutTools`);
          assert.equal(a.onlyRead, undefined, `${name}: no onlyRead`);
        }
      }
      calls.length = 0;
      await scanServices({ cwd: root, ...run }).catch(() => {});
      assert.equal(calls.length, 1, "scanServices: one call");
      assert.equal(calls[0].cwd, root, "the service scan reads in the project folder");
      assert.equal(calls[0].onlyRead, true, "... hardened through onlyRead");
      assert.equal(calls[0].withoutTools, undefined, "... and NOT sandboxed (named exception)");
    });
  });
  const prior = DIRS;
  try {
    setDirs(null);
    assert.throws(() => sandboxed(), /DIRS\.empty is not set/, "without DIRS no fallback to the server's cwd");
  } finally { setDirs(prior); }
});

// ── (D) The providers ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: in connectors/codex.js buildCodexOnceArgs remove the line `if (withoutTools) ...` => red (Codex).
test("(D) no provider fails on the options: Codex sandboxed on the wire, the API connector without tools", async () => {
  await withEmpty(async ({ root, empty }) => {
    const log = path.join(root, "argv.jsonl");
    const codex = path.join(root, "codex-fake");
    fs.writeFileSync(codex, `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cwd: process.cwd() }) + "\\n");
const i = a.indexOf("-o"); if (i >= 0) require("fs").writeFileSync(a[i + 1], "- Summary");
`, { mode: 0o755 });
    const prior = process.env.CODEX_BIN;
    try {
      process.env.CODEX_BIN = codex;
      assert.equal((await compactConversation({ transcript: "User: a\nAssistant: b", provider: "codex", model: "gpt-5.6-sol" })).text, "- Summary");
    } finally { if (prior === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prior; }
    const [z] = readJsonl(log);
    assert.equal(fs.realpathSync(z.cwd), fs.realpathSync(empty), "Codex: cwd is DIRS.empty");
    assert.equal(z.argv[z.argv.indexOf("-C") + 1], empty, "Codex: -C DIRS.empty");
    const followUp = (list, f) => list.some((_, i) => f.every((x, j) => list[i + j] === x));
    assert.ok(followUp(z.argv, CODEX_WITHOUT_FILE_ACCESS), `Codex: CODEX_WITHOUT_FILE_ACCESS — ${z.argv.join(" ")}`);

    // The API connector (OpenRouter, the spy replaces the built-in one): the same options, an answer, no tool field.
    const orig = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const back = replaceOpenRouter({ baseUrl: "https://example.test/v1", models: [{ id: "gpt-oss", label: "gpt-oss" }] });
    try {
      assert.equal(await runOnce("p", { ...sandboxed(), provider: "openrouter", model: "gpt-oss" }), "ok", "openrouter: answers");
      assert.equal(bodies.length, 1);
      for (const r of bodies) assert.equal(r.tools, undefined, `no tools field: ${JSON.stringify(r).slice(0, 200)}`);
    } finally {
      globalThis.fetch = orig;
      back();
    }
  });
});
