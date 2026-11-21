// Ultracode and effort level are two independent axes.
//
// The rule lives in ONE place (`electron/server/chats/ultracode.js:ultracodeFollowUp`): it normalizes the switch to 0/1 and
// NEVER touches level, model or provider. Two halves:
//   1. The rule itself, case by case — exactly the cases that used to couple (switching on set xhigh, a new level
//      switched off, Haiku 4.5 carried no mode, a model change re-clamped). Counter-test: the old version of
//      `chats/ultracode.js` (its two imports stubbed) turns half 1 red.
//   2. The SOURCE-CODE guard: every `updateChat`/`createChat` in the server tree whose fields can carry level, model,
//      provider or mode (key, spread, a variable) passes them through `ultracodeFollowUp` — a future path that wants to
//      couple again then stands at THIS one place and turns half 1 red. The callers are COUNTED and printed on every run.
//      Only `store/` is exempt (the functions and migrations live there: `migrateUltraToMax`, `setLevelIfEmpty`).
// The behavior at the routes (PATCH, creation, fork, workflow start) is held by `effort-core.test.js` and
// `workflow-run-settings.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ultracodeFollowUp } from "../electron/server/chats/ultracode.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "electron", "server");
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-4-5-20251001";

test("the rule: level and ultracode are independent — switching on, new level, model without levels, model change", () => {
  const uc = { provider: "claude", model: OPUS, effort: "high", ultracode: true };
  const output = { ...uc, ultracode: false };
  // Switching on does not change the level — a level sent along stays as it is.
  assert.deepEqual(ultracodeFollowUp(output, { ultracode: true }), { ultracode: 1 });
  assert.deepEqual(ultracodeFollowUp(output, { ultracode: true, effort: "low" }), { ultracode: 1, effort: "low" });
  // Switching off does not change the level.
  assert.deepEqual(ultracodeFollowUp(uc, { ultracode: false }), { ultracode: 0 });
  // A new level does not switch the mode off.
  assert.deepEqual(ultracodeFollowUp(uc, { effort: "low" }), { effort: "low" });
  assert.deepEqual(ultracodeFollowUp(uc, { effort: "max" }), { effort: "max" });
  // A model without levels carries it anyway.
  assert.deepEqual(ultracodeFollowUp(uc, { model: HAIKU }), { model: HAIKU });
  assert.deepEqual(ultracodeFollowUp(null, { provider: "claude", model: HAIKU, effort: "", ultracode: true }), { provider: "claude", model: HAIKU, effort: "", ultracode: 1 });
  // A model or provider change leaves switch AND level alone.
  assert.deepEqual(ultracodeFollowUp(uc, { model: "claude-sonnet-5" }), { model: "claude-sonnet-5" });
  assert.deepEqual(ultracodeFollowUp(uc, { provider: "codex", model: "gpt-5.5" }), { provider: "codex", model: "gpt-5.5" });
  // Creation (fork, trigger, child chat): both values as passed, the switch as 0/1.
  assert.deepEqual(ultracodeFollowUp(null, { provider: "claude", model: OPUS, effort: "medium", ultracode: true }), { provider: "claude", model: OPUS, effort: "medium", ultracode: 1 });
  assert.deepEqual(ultracodeFollowUp(null, { provider: "claude", model: OPUS, effort: "medium", ultracode: false }), { provider: "claude", model: OPUS, effort: "medium", ultracode: 0 });
  // Nothing touched => the same object.
  const title = { title: "x" };
  assert.equal(ultracodeFollowUp(uc, title), title);
  // Ultracode is never a level.
  for (const f of [{ effort: "high" }, { model: HAIKU }, { ultracode: true }]) assert.notEqual(ultracodeFollowUp(uc, f).effort, "ultracode");
});

// ── Source text: no write path past the rule ──────────────────────────────────────────────────────────────────────
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...jsFiles(p)); }
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
/** The argument text from `start` (after the opening bracket) to the matching closing one, strings skipped. */
function argsValue(text, start) {
  let depth = 0, i = start, part = "", parts = [];
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const j = i; i++;
      while (i < text.length && text[i] !== c) { if (text[i] === "\\") i++; i++; }
      part += text.slice(j, i + 1); continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    if (c === "," && depth === 0) { parts.push(part.trim()); part = ""; continue; }
    part += c;
  }
  parts.push(part.trim());
  return parts;
}
/** The keys of the TOP level of an object literal — a `model:` in a nested value is no chat field. A spread counts:
 *  `...(condition ? { a: 1 } : {})` yields the keys of its literal branches; any other spread (a variable, a call) can
 *  carry anything and yields `null`. */
function keyOf(literal) {
  const out = [];
  for (const t of argsValue(literal, 1)) {
    if (!t) continue;
    if (t.startsWith("...")) {
      // Only `...(condition ? {…} : condition ? {…} : {…})`: the literal branches become "§", every section between two
      // `:` must then be "§" or "<condition> ? §" — a value without brackets (variable, call) yields `null`.
      const body = t.slice(3).trim();
      if (!(body.startsWith("(") && body.endsWith(")"))) return null;
      const inside = body.slice(1, -1);
      const question = inside.indexOf("?");
      if (question < 0) return null;
      let rest = "", depth = 0, start = 0;
      const branches = [];
      for (let i = question + 1; i < inside.length; i++) {
        const c = inside[i];
        if (c === "{") { if (depth === 0) start = i; depth++; continue; }
        if (c === "}") { depth--; if (depth === 0) { branches.push(inside.slice(start, i + 1)); rest += "§"; } continue; }
        if (depth === 0) rest += c;
      }
      if (!rest.split(":").every((section) => /^(?:[^:]*\?\s*)?§$/.test(section.trim()))) return null;
      for (const branch of branches) {
        const k = keyOf(branch);
        if (k === null) return null;
        out.push(...k);
      }
      continue;
    }
    const k = t.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1];
    if (k) out.push(k);
  }
  return out;
}
/** Verdict on the field argument: "" = harmless, otherwise the reason. */
function verdict(fn, arg) {
  if (!arg.startsWith("{")) return `no object literal (${arg.slice(0, 40)})`;
  const key = fn === "createChat" ? ["ultracode"] : ["effort", "model", "provider", "ultracode"];
  const top = keyOf(arg);
  if (top === null) return "spread in the literal";
  const hits = top.filter((k) => key.includes(k));
  return hits.length ? `field ${hits.join(", ")}` : "";
}

function writePaths(root = SERVER) {
  const findings = [], throughRule = [];
  for (const file of jsFiles(root)) {
    const rel = path.relative(root, file);
    if (rel.startsWith(`store${path.sep}`) || rel === "store.js" || rel === path.join("chats", "ultracode.js")) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(updateChat|createChat)\(/g)) {
      const before = text.slice(Math.max(0, m.index - 10), m.index);
      if (/function\s+$/.test(before)) continue;
      const args = argsValue(text, m.index + m[0].length);
      const arg = m[1] === "updateChat" ? args[1] || "" : args[0] || "";
      const row = text.slice(0, m.index).split("\n").length;
      const location = `${rel}:${row} ${m[1]}`;
      // Through the rule: the call itself, or a variable that arises from it in THIS file.
      const variable = /^[A-Za-z_$][\w$]*$/.test(arg) && new RegExp(`\\bconst ${arg} = ultracodeFollowUp\\(`).test(text);
      if (/^ultracodeFollowUp\(/.test(arg) || variable) { throughRule.push(location); continue; }
      const reason = verdict(m[1], arg);
      if (reason) findings.push(`${location} — ${reason}`);
    }
  }
  return { findings, throughRule };
}

test("source: every chat write path with level, model, provider or mode goes through ultracodeFollowUp", () => {
  const { findings, throughRule } = writePaths();
  console.log(`# ultracode rule: ${throughRule.length} write paths through ultracodeFollowUp — ${throughRule.join(" · ")}`);
  assert.deepEqual(findings, [], "past the ONE ultracode rule (chats/ultracode.js):\n" + findings.join("\n"));
  // The known paths: creation, PATCH, workflow start, child chat of a graph workflow, trigger.
  assert.ok(throughRule.length >= 5, `only ${throughRule.length} paths through the rule — was a caller bypassed?`);
});

test("source guard, counter-test: a path past the rule turns red", () => {
  const tmp = fs.mkdtempSync(path.join(path.dirname(here), ".ultracode-rule-"));
  try {
    fs.mkdirSync(path.join(tmp, "x"));
    fs.writeFileSync(path.join(tmp, "x", "a.js"), [
      'store.updateChat(chat.id, { effort: "low" });',
      "store.updateChat(chat.id, fields);",
      "store.updateChat(chat.id, { ...runFields });",
      'store.createChat({ id, ultracode: true });',
      'store.updateChat(chat.id, { title: "t", notify: JSON.stringify({ model: 1 }) });',
      'store.createChat({ id, model: "m", effort: "low" });',
      "store.updateChat(chat.id, ultracodeFollowUp(chat, fields));",
    ].join("\n"));
    const { findings, throughRule } = writePaths(tmp);
    assert.equal(findings.length, 4, findings.join("\n"));
    assert.deepEqual(findings.map((b) => b.split(" — ")[1]), ["field effort", "no object literal (fields)", "spread in the literal", "field ultracode"]);
    assert.equal(throughRule.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
