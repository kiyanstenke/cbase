// iPhone: the left drawer opens in every chat by swipe, no drawer flag is set inside a transaction, and the chat header
// carries only ‹ back on the left — bindings by PATH, no simulator.
//
// Reads the Swift sources under `mobile/CbaseMobile/` (read only, so it also runs on Linux — NOT under `onlyMacOS`).
// Comments are stripped before every check: the sources MENTION the forbidden thing in order to justify it.
//
// Counter-tests: each check was shown red once (sabotaged, seen red, reverted) — the sabotage sits above its test.
//
// Run:  node --test web/test/ios-drawer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const IOS = "mobile/CbaseMobile";
const raw = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// ── Reading Swift ──────────────────────────────────────────────────────────────────────────────────
// Comments become spaces (line breaks stay), strings stay. A small reader instead of a regex: a `//` inside a
// string (`"https://…"`) is not a comment, and block comments nest in Swift. Interpolations with inner strings
// (`"\(L("x"))"`) work because the quotes cancel pairwise.
function withoutComments(t) {
  let out = "";
  let i = 0;
  const empty = (s) => s.replace(/[^\n]/g, " ");
  while (i < t.length) {
    if (t.startsWith('"""', i)) {
      const end = t.indexOf('"""', i + 3);
      const until = end < 0 ? t.length : end + 3;
      out += t.slice(i, until);
      i = until;
    } else if (t[i] === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"' && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j + 1;
    } else if (t.startsWith("//", i)) {
      const end = t.indexOf("\n", i);
      const until = end < 0 ? t.length : end;
      out += empty(t.slice(i, until));
      i = until;
    } else if (t.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < t.length && depth > 0) {
        if (t.startsWith("/*", j)) { depth++; j += 2; } else if (t.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
      out += empty(t.slice(i, j));
      i = j;
    } else {
      out += t[i];
      i++;
    }
  }
  return out;
}
const swift = (rel) => withoutComments(raw(`${IOS}/${rel}`));

// All Swift sources of the app (without the dictionaries — they only carry keys).
function allSwift(dir = path.join(repo, IOS)) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...allSwift(p));
    else if (n.name.endsWith(".swift") && !n.name.startsWith("LocDE")) out.push(p);
  }
  return out;
}
const relIOS = (p) => path.relative(path.join(repo, IOS), p).split(path.sep).join("/");

// The block `{ … }` from the first `{` after `ab` — braces in strings do not count
// (`L("Chat with {name}")`). Returns the content WITHOUT the outer braces.
function block(t, startAt, location) {
  const start = t.indexOf("{", startAt);
  assert.ok(startAt >= 0 && start >= 0, `${location}: no block found`);
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      if (t.startsWith('"""', i)) { i = t.indexOf('"""', i + 3) + 2; continue; }
      let j = i + 1;
      while (j < t.length && t[j] !== '"' && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start + 1, i);
  }
  assert.fail(`${location}: block does not close`);
}
// Body of a declaration (`func load(`, `struct ManagerBody`) — exactly ONE occurrence.
function body(t, header, location) {
  const idx = t.indexOf(header);
  assert.ok(idx >= 0, `${location}: \`${header}\` missing`);
  assert.equal(t.indexOf(header, idx + 1), -1, `${location}: \`${header}\` occurs more than once — the guard cannot tell which is meant`);
  return block(t, idx, `${location} ${header}`);
}
const count = (t, s) => t.split(s).length - 1;

// ── (a) Lock and edge swipe are gone ─────────────────────────────────────────────────────────
// Counter-test: `var lockLeft = false` back in `HorizontalPanReader`.
test("(a) no lockLeft, leftDrawerLocked, BackwardSwipe in the app code", () => {
  const findings = [];
  for (const p of allSwift()) {
    const t = withoutComments(fs.readFileSync(p, "utf8"));
    for (const name of ["lockLeft", "leftDrawerLocked", "BackwardSwipe"]) {
      const n = count(t, name);
      if (n) findings.push(`${relIOS(p)}: ${name} ×${n}`);
    }
  }
  assert.deepEqual(findings, [],
    "the left drawer lock or the custom edge swipe is back in the code — in a conversation the swipe did not open the chat list");
});

// ── (d) Nobody sets the drawers inside a transaction ────────────────────────────────────────
// The rule holds for EVERY setter (the ✕ of both drawers, `closeDrawersAfterChoice`, …): the shell drives the drawer
// with its own spring (`settleDrawer`); a transaction around the flag would lay a second one on top and cost a long frame.
// Counter-test: `withAnimation { state.rightOpen = false }` in the ✕ of the right drawer (AppShell.swift).
const SETS_DRAWER = /\b(leftOpen|rightOpen)\s*=(?!=)/;
test("(d) leftOpen/rightOpen become nowhere in one Transaction set", () => {
  const findings = [];
  let setter = 0;
  for (const p of allSwift()) {
    const t = withoutComments(fs.readFileSync(p, "utf8"));
    setter += (t.match(new RegExp(SETS_DRAWER.source, "g")) ?? []).length;
    for (const m of t.matchAll(/\bwith(Animation|Transaction)\b/g)) {
      const content = block(t, m.index, `${relIOS(p)} ${m[0]}`);
      if (SETS_DRAWER.test(content)) findings.push(`${relIOS(p)}: ${m[0]}`);
    }
  }
  assert.ok(setter > 0, "no setter of leftOpen/rightOpen found — the guard reads nothing");
  assert.deepEqual(findings, [],
    "a drawer flag is set inside a transaction — the shell drives the drawer with its own spring, a transaction would lay a second one on top");
});

// ── (e) On the left of the chat header only the way back ────────────────────────────────────────────────────
// A single back button is enough at the top left of the chat UI: the ☰ button `ChatListButton` (identifier
// `chat-sidebar-button`) is gone, the swipe to the right opens the chat list. This check keeps it from silently coming
// back and also checks that ‹ is there.
// Counter-test: `HeaderButton(systemImage: "line.3.horizontal", …, identifier: "chat-sidebar-button")` in `chatHeader`.
test("(e) chat header: no ☰ button, only ‹ back", () => {
  const findings = [];
  for (const p of allSwift()) {
    const t = withoutComments(fs.readFileSync(p, "utf8"));
    for (const name of ["ChatListButton", '"chat-sidebar-button"']) {
      const n = count(t, name);
      if (n) findings.push(`${relIOS(p)}: ${name} ×${n}`);
    }
  }
  assert.deepEqual(findings, [], "the ☰ button is back in the chat header");
  const header = body(swift("Chat/ChatView.swift"), "private var chatHeader", "ChatView.swift");
  assert.ok(header.includes('identifier: "chat-back"'), "‹ back is missing from the chat header");
  assert.ok(!header.includes("line.3.horizontal"), "a ☰ symbol is back in the chat header");
});
