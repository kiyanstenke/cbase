// The terminals of the bottom panel as in VS Code: lib/terminal-list.ts, EXECUTED. "Open in integrated terminal" creates a NEW
// terminal in the folder and brings it to the front (the running one stays), showing the tab creates at most one, ending one
// brings the one at the same position (else the last) to the front, and the title is the start folder (the root: the project name).
// Every sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/terminal-list.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "terminal-list.ts"), "utf8");

const SABOTAGES = {
  "new one stays at the back": { old: "active: seq, next: seq + 1 };", fresh: "active: s.active ?? seq, next: seq + 1 };", catches: "fresh" },
  "new one replaces the running one": { old: "list: [...s.list, { seq, cwd: terminalFolderNorm(a.cwd) }]", fresh: "list: [{ seq, cwd: terminalFolderNorm(a.cwd) }]", catches: "fresh" },
  "number twice": { old: "next: seq + 1 };", fresh: "next: seq };", catches: "fresh" },
  "folder not normalized": { old: "cwd: terminalFolderNorm(a.cwd) }", fresh: "cwd: String(a.cwd ?? \"\") }", catches: "fresh" },
  "safe always creates": { old: "return s.list.length ? s : terminalStep(s, { kind: \"fresh\" });", fresh: "return terminalStep(s, { kind: \"fresh\" });", catches: "safe" },
  "ending: always the first to the front": { old: "const front = list[Math.min(i, list.length - 1)];", fresh: "const front = list[0];", catches: "end" },
  "ending another one switches": { old: "if (s.active !== seq) return { ...s, list };", fresh: "", catches: "end" },
  "ending: unknown number": { old: "if (i < 0) return s;", fresh: "", catches: "end" },
  "selecting an unknown number": { old: "s.list.some((x) => x.seq === a.seq) && ", fresh: "", catches: "select" },
  "title is the whole path": { old: "return n ? n.slice(n.lastIndexOf(\"/\") + 1) : rootName;", fresh: "return n || rootName;", catches: "title" },
  "title without shell": { old: "if (shell) return shell;", fresh: "", catches: "title" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-terminal-list-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "terminal-list.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `terminal-list-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const CHECKS = {
  fresh: (m) => {
    let s = m.terminalStep(m.TERMINAL_EMPTY, { kind: "fresh" });
    assert.deepEqual(s, { list: [{ seq: 1, cwd: "" }], active: 1, next: 2 });
    s = m.terminalStep(s, { kind: "fresh", cwd: "/src/lib/" });
    assert.deepEqual(s.list, [{ seq: 1, cwd: "" }, { seq: 2, cwd: "src/lib" }], "the running one stays, the folder without edge slashes");
    assert.equal(s.active, 2, "the new one is at the front");
    s = m.terminalStep(m.terminalStep(s, { kind: "end", seq: 2 }), { kind: "fresh", cwd: "a" });
    assert.equal(s.list[s.list.length - 1].seq, 3, "a number never occurs twice");
  },
  safe: (m) => {
    const one = m.terminalStep(m.TERMINAL_EMPTY, { kind: "safe" });
    assert.deepEqual(one.list, [{ seq: 1, cwd: "" }], "showing the tab creates one in the root");
    assert.equal(m.terminalStep(one, { kind: "safe" }), one, "... and only if none is running");
  },
  end: (m) => {
    let s = m.TERMINAL_EMPTY;
    for (const cwd of ["", "a", "b"]) s = m.terminalStep(s, { kind: "fresh", cwd });
    s = m.terminalStep(s, { kind: "select", seq: 2 });
    const middle = m.terminalStep(s, { kind: "end" });
    assert.deepEqual(middle.list.map((x) => x.seq), [1, 3]);
    assert.equal(middle.active, 3, "the next one takes the same position afterwards (VS Code setActiveInstanceByIndex)");
    const last = m.terminalStep(middle, { kind: "end" });
    assert.equal(last.active, 1, "at the end: the last of the list");
    const other = m.terminalStep(s, { kind: "end", seq: 1 });
    assert.equal(other.active, 2, "ending another one does not change the front one");
    assert.deepEqual(other.list.map((x) => x.seq), [2, 3]);
    assert.equal(m.terminalStep(s, { kind: "end", seq: 99 }), s, "an unknown number changes nothing");
    const rear = m.terminalStep(m.terminalStep(s, { kind: "select", seq: 3 }), { kind: "end", seq: 1 });
    assert.equal(rear.active, 3, "ending another one (at the front of the list) leaves the front one in front");
    const empty = m.terminalStep(m.terminalStep(m.TERMINAL_EMPTY, { kind: "fresh" }), { kind: "end" });
    assert.deepEqual([empty.list, empty.active], [[], null], "the last one falls: none in front any more");
  },
  select: (m) => {
    const s = m.terminalStep(m.terminalStep(m.TERMINAL_EMPTY, { kind: "fresh" }), { kind: "fresh", cwd: "x" });
    assert.equal(m.terminalStep(s, { kind: "select", seq: 1 }).active, 1);
    assert.equal(m.terminalStep(s, { kind: "select", seq: 7 }), s, "an unknown number does not come to the front");
  },
  title: (m) => {
    assert.equal(m.terminalTitle("", "cbase"), "cbase", "the root is named like the project");
    assert.equal(m.terminalTitle("src/lib", "cbase"), "lib", "the name of the start folder");
    assert.equal(m.terminalTitle("/web/", "cbase"), "web");
    // As VS Code `${process}`: the shell name once the server reports it; until then (and from an old server) the folder.
    assert.equal(m.terminalTitle("src/lib", "cbase", "zsh"), "zsh", "the name of the shell");
    assert.equal(m.terminalTitle("src/lib", "cbase", ""), "lib", "without a name: the folder");
    assert.equal(m.terminalTitle("", "cbase", null), "cbase");
  },
};

test("Panel terminals: new in folder, safe, end, select, title", async () => {
  const m = await load("terminal-list.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("Panel terminals: every sabotage fails at its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
