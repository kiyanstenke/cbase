// Chats in the rail of the collapsed chat list. web/src/lib/chat-shortcut.ts is compiled with tsc and EXECUTED; the rail
// (components/chat/ChatRail.tsx) and its mounting (ChatListPane.tsx) are read at the source.
//
// The promises, each with the way that breaks it (counter-tests below, executed):
//   (a) the shortcut: initials of the first two words, upper case; one word -> two characters; no word -> "·"; umlauts stay whole.
//   (b) hovering shows the SAME short info as a row: the button carries `data-tooltip-row` and the handles of the list's single
//       store (`short.handles`); click opens, right click opens the row's menu.
//   (c) the same chats in the same order as the list (from `sections`), tab stop only while the list is collapsed.
//
// Run:  node --test web/test/chat-rail.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const ts = (await import(pathToFileURL(path.join(webDir, "node_modules", "typescript", "lib", "typescript.js")).href)).default;
const read = (...parts) => fs.readFileSync(path.join(webDir, "src", ...parts), "utf8");

const tmps = [];
after(() => { for (const t of tmps) try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* ignore */ } });
async function loadFrom(sourceCode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-rail-"));
  tmps.push(tmp);
  // Transpile only (no type check): a sabotage counts as caught only if the CHECK catches it, never the compiler.
  const js = ts.transpileModule(sourceCode, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const q = path.join(tmp, "chat-shortcut.mjs");
  fs.writeFileSync(q, js);
  return import(pathToFileURL(q).href);
}
const SHORTCUT = read("lib", "chat-shortcut.ts");

function shortcutCheck({ chatShortcut }) {
  assert.equal(chatShortcut("Main ORBIT"), "MO");
  assert.equal(chatShortcut("deploy"), "DE", "one word: two characters");
  assert.equal(chatShortcut("Fix: ⌘-Hover kommt spät"), "FH", "punctuation separates");
  assert.equal(chatShortcut("über alles"), "ÜA", "umlauts upper case and whole");
  assert.equal(chatShortcut("  — "), "·", "no word gives a dot");
  assert.equal(chatShortcut("x"), "X");
}

test("(a) the shortcut of a chat", async () => {
  shortcutCheck(await loadFrom(SHORTCUT));
});

function installCheck(rail, pane) {
  assert.match(rail, /data-tooltip-row=\{c\.id\}/, "the card finds the button like a row");
  assert.match(rail, /onPointerEnter=\{g\.onPointerEnter\}\n\s+onPointerLeave=\{g\.onPointerLeave\}\n\s+onMouseDown=\{g\.onMouseDown\}/);
  assert.match(rail, /onContextMenu=\{\(e\) => \{ e\.preventDefault\(\); g\.onContextMenu\(\); onMenu\(c, e\.clientX, e\.clientY\); \}\}/);
  assert.match(rail, /onClick=\{\(\) => onOpen\(c\.id\)\}/);
  assert.match(rail, /tabIndex=\{visible \? 0 : -1\}/);
  assert.match(pane, /const railChats = useMemo\(\(\) => sections\.flatMap\(\(sec\) => sec\.chats\), \[sections\]\);/, "order of the list");
  assert.match(pane, /<RailChats\n\s+chats=\{railChats\}[\s\S]{0,400}handles=\{short\.handles\}[\s\S]{0,200}onMenu=\{openMenu\}\n\s+visible=\{listCollapsed\}/, "same handles, same menu");
}
const RAIL = read("components", "chat", "ChatRail.tsx");
const PANE = read("components", "chat", "ChatListPane.tsx");

test("(b)(c) rail: short info, open, menu and order like the list", () => {
  installCheck(RAIL, PANE);
});

const SABOTAGES = [
  { name: "only one letter", q: "k", old: "const k = b ? a[0] + b[0] : a.slice(0, 2).join(\"\");", fresh: "const k = a[0];" },
  { name: "lower case", q: "k", old: "return k.toLocaleUpperCase();", fresh: "return k;" },
  { name: "empty breaks", q: "k", old: "if (!a) return \"·\";", fresh: "" },
  { name: "umlaut split", q: "k", old: "[\\p{L}\\p{N}]+/gu", fresh: "[A-Za-z0-9]+/g" },
  { name: "no short-info marker", q: "s", old: "data-tooltip-row={c.id}", fresh: "" },
  { name: "no handles", q: "s", old: "onPointerEnter={g.onPointerEnter}", fresh: "" },
  { name: "no menu", q: "s", old: "onMenu(c, e.clientX, e.clientY);", fresh: "" },
  { name: "always tab stop", q: "s", old: "tabIndex={visible ? 0 : -1}", fresh: "tabIndex={0}" },
  { name: "other order", q: "p", old: "sections.flatMap((sec) => sec.chats)", fresh: "[...scopedChats]" },
  { name: "not mounted", q: "p", old: "handles={short.handles}", fresh: "handles={() => ({} as never)}" },
];

test("counter-tests: every sabotage appears exactly once and is caught", async () => {
  const source = { k: SHORTCUT, s: RAIL, p: PANE };
  for (const s of SABOTAGES) {
    assert.equal(source[s.q].split(s.old).length - 1, 1, `${s.name}: spot not exactly once`);
    const fresh = source[s.q].replace(s.old, s.fresh);
    let caught = false;
    try {
      if (s.q === "k") shortcutCheck(await loadFrom(fresh));
      else installCheck(s.q === "s" ? fresh : RAIL, s.q === "p" ? fresh : PANE);
    } catch { caught = true; }
    assert.ok(caught, `sabotage "${s.name}" not caught`);
  }
});
