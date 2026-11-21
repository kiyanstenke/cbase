// One event of the terminal stream into xterm (src/lib/terminal-stream.ts).
//
// The incident: an IDLE terminal showed hundreds of prompts in a row. The stream had no heartbeat, Cloudflare cut the silent
// connection, the EventSource reconnected by itself, and every component wrote the whole buffer that the server sent to each new
// subscription into the SAME xterm. The server now resumes at `Last-Event-ID` and marks EVERY full fetch with `replaced`
// (server/backend/test/terminal-stream.test.js); this file is the client half: `replaced` => RIS (`ESC c`) before the text, in
// ONE write (in the order of the write stream, not as a `reset()` past it); an empty `d` (the line that only sets the position)
// => nothing; unreadable => nothing.
//
// Plus by path: (1) all three components with a terminal (TerminalsPane, TerminalPanel, AuthLoginConsole) import the helper and
// write from `onmessage` ONLY through it: a fourth version of the old `term.write(d)` would append again without knowing
// `replaced`, and no type error would see it; (2) the installed xterm really turns `ESC c` into the full reset (InputHandler
// `fullReset` -> `onRequestReset` -> `Terminal.reset`, which keeps size and key handler): an xterm bump that changes this turns
// red here instead of silently doubling in the browser.
//
// Counter-test: dropping `TERMINAL_RESET +` in the helper AND putting the old body back into TerminalPanel
// (`const { d } = JSON.parse(e.data); if (d && term) term.write(d);`) turns "replaced: RIS before the text",
// "replaced with empty buffer" and the TerminalPanel binding red.
//
// Run:  node --test web/test/terminal-stream.test.mjs
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
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

// The source is compiled to JS with the local tsc and imported: the real module text is tested (model:
// browser-stream.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-terminal-stream-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "terminal-stream.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { terminalChunk, writeTerminalChunk, TERMINAL_RESET } = await import(pathToFileURL(path.join(out, "terminal-stream.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const RIS = String.fromCharCode(0x1b) + "c";

/** A terminal that only records what it received. */
const log = () => {
  const steps = [];
  return { steps, write: (d) => steps.push(d) };
};
const write = (term, obj) => writeTerminalChunk(term, typeof obj === "string" ? obj : JSON.stringify(obj));

test("RIS is ESC c", () => {
  assert.equal(TERMINAL_RESET, RIS);
});

test("An ordinary chunk is only written, no reset", () => {
  const t = log();
  write(t, { d: "$ ls\r\n", until: 6 });
  assert.deepEqual(t.steps, ["$ ls\r\n"]);
});

test("replaced: RIS before the text, in ONE write, else the history would stand twice", () => {
  const t = log();
  write(t, { d: "everything", until: 900, replaced: true });
  assert.deepEqual(t.steps, [RIS + "everything"]);
});

test("An empty d without replaced only sets the position and writes nothing (also with an old server without until)", () => {
  const t = log();
  write(t, { d: "", until: 42 });
  write(t, { d: "" });
  assert.deepEqual(t.steps, []);
});

test("replaced with an empty buffer (the first fetch of a fresh terminal) writes only RIS, which is harmless for a fresh xterm", () => {
  const t = log();
  write(t, { d: "", until: 0, replaced: true });
  assert.deepEqual(t.steps, [RIS]);
});

test("Unreadable input is skipped; without a terminal nothing happens", () => {
  const t = log();
  for (const raw of ["not json", "null", "42", "\"text\"", JSON.stringify({ d: 5 }), JSON.stringify({ until: 3 }), JSON.stringify({ d: "x", replaced: "yes" })]) {
    write(t, raw);
  }
  assert.deepEqual(t.steps, ["x"], "only the chunk with a text d; a \"yes\" is not replaced");
  assert.doesNotThrow(() => write(null, { d: "x", replaced: true }));
  assert.doesNotThrow(() => write(undefined, { d: "x" }));
});

test("terminalChunk reads d, until and replaced: a missing until gives null, replaced only for true", () => {
  assert.deepEqual(terminalChunk(JSON.stringify({ d: "a", until: 7 })), { d: "a", until: 7, replaced: false });
  assert.deepEqual(terminalChunk(JSON.stringify({ d: "a" })), { d: "a", until: null, replaced: false });
  assert.deepEqual(terminalChunk(JSON.stringify({ d: "a", until: "7", replaced: true })), { d: "a", until: null, replaced: true });
  assert.equal(terminalChunk("{"), null);
});

test("The installed xterm fully resets on ESC c and keeps size and key handler", () => {
  const xterm = path.join(webDir, "node_modules", "@xterm", "xterm", "src");
  const input = fs.readFileSync(path.join(xterm, "common", "InputHandler.ts"), "utf8");
  assert.match(input, /registerEscHandler\(\{ final: 'c' \}, \(\) => this\.fullReset\(\)\)/, "ESC c is no longer fullReset");
  assert.match(input, /public fullReset\(\): boolean \{[^}]*this\._onRequestReset\.fire\(\);/, "fullReset no longer fires onRequestReset");
  const term = fs.readFileSync(path.join(xterm, "browser", "CoreBrowserTerminal.ts"), "utf8");
  assert.match(term, /onRequestReset\(\(\) => this\.reset\(\)\)/, "the terminal no longer attaches reset() to onRequestReset");
  const reset = term.slice(term.indexOf("public reset(): void {"), term.indexOf("public clearTextureAtlas"));
  assert.match(reset, /this\.options\.rows = this\.rows;/, "reset no longer keeps the row count");
  assert.match(reset, /this\.options\.cols = this\.cols;/, "reset no longer keeps the column count");
  assert.match(reset, /this\._customKeyEventHandler = customKeyEventHandler;/, "reset no longer keeps the key handler");
});

for (const file of ["src/components/TerminalsPane.tsx", "src/components/TerminalPanel.tsx", "src/components/AuthLoginConsole.tsx"]) {
  test(`${file} writes the stream only through writeTerminalChunk`, () => {
    const q = read(file);
    assert.match(q, /import \{ writeTerminalChunk \} from "@\/lib\/terminal-stream";/, "writeTerminalChunk does not come from @/lib/terminal-stream");
    assert.match(q, /es\.onmessage = \(e\) => writeTerminalChunk\(term, e\.data\);/, "onmessage does not call writeTerminalChunk(term, e.data)");
    const handler = q.split("\n").filter((z) => /onmessage/.test(z));
    assert.equal(handler.length, 1, `exactly one onmessage handler expected, found: ${handler.length}`);
    for (const z of handler) assert.doesNotMatch(z, /term\.write/, `onmessage writes into xterm itself: ${z.trim()}`);
    assert.doesNotMatch(q, /JSON\.parse\(e\.data\)/, "the component still reads the stream data itself");
  });
}
