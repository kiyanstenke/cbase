// The tool choice of a coding MCP server on the web: web/src/lib/mcp-tools.ts — label, rows, counter, the next choice after a click, the
// cache status. Pure, no DOM. The meaning comes from the server (toolchain/mcp-tools.js): `choice = null` means all, `[]` none; the
// marker acts only on the chosen tool; a name in the choice that is no longer in the cache stays on toggling (if the tool comes back
// the old decision applies — the server accepts it as long as it is already in the choice).
//
// Counter-probes (each in a copy):
//   toggleChoice: from `null` becomes `[name]` instead of "all without name"  => (3) red (the first click deselected everything else)
//   toggleChoice: base only from the cache                                    => (3) red (a vanished name would fall out of the choice)
//   counter: cards also on deselected tools                                   => (2) red
//
// Run:  node --test web/test/mcp-tools.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "mcp-tools.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
async function load() {
  tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-tools-"));
  execFileSync(process.execPath, [tsc, SOURCE, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(tmp, "mcp-tools.js")).href);
}

const W = [
  { name: "read", description: "reads", writing: false },
  { name: "send", description: "sends", writing: true },
  { name: "third", writing: null, fresh: true },
];

test("(1) label and rows: reads · writes · unresolved, cache order, `null` = all chosen", async () => {
  const m = await load();
  assert.deepEqual([true, false, null, undefined].map(m.labelOf), ["writes", "reads", "unresolved", "unresolved"]);
  assert.deepEqual(m.toolRows(W, null, ["send"]), [
    { name: "read", description: "reads", label: "reads", selected: true, card: false, fresh: false },
    { name: "send", description: "sends", label: "writes", selected: true, card: true, fresh: false },
    { name: "third", description: "", label: "unresolved", selected: true, card: false, fresh: true },
  ]);
  assert.deepEqual(m.toolRows(W, [], []).map((z) => z.selected), [false, false, false], "[] = none");
});

test("(2) counter: chosen (free or with card), of those with card — a marker on a deselected tool does not count", async () => {
  const m = await load();
  assert.deepEqual(m.counter(W, null, []), { free: 3, card: 0, total: 3 });
  assert.deepEqual(m.counter(W, ["read", "send"], ["send"]), { free: 2, card: 1, total: 3 });
  assert.deepEqual(m.counter(W, ["read"], ["send"]), { free: 1, card: 0, total: 3 });
  assert.deepEqual(m.counter([], null, []), { free: 0, card: 0, total: 0 });
});

test("(3) click on the tick: \"all\" becomes \"all without this one\", a list toggles, a vanished name stays", async () => {
  const m = await load();
  assert.deepEqual(m.toggleChoice(W, null, "send"), ["read", "third"]);
  assert.deepEqual(m.toggleChoice(W, ["read"], "send"), ["read", "send"]);
  assert.deepEqual(m.toggleChoice(W, ["read", "send"], "read"), ["send"]);
  assert.deepEqual(m.toggleChoice(W, ["gone", "read"], "third"), ["gone", "read", "third"], "\"gone\" is no longer in the cache and stays");
  assert.deepEqual(m.toggleMarker(["send"], "send"), []);
  assert.deepEqual(m.toggleMarker(["gone"], "read"), ["gone", "read"]);
});

test("(4) status: never loaded, loaded N minutes ago, error (the cache stays)", async () => {
  const m = await load();
  const now = 1_792_000_000_000;
  assert.deepEqual(m.statusOf(0, "", now), { kind: "never", minutes: 0 });
  assert.deepEqual(m.statusOf(now - 3 * 60_000 - 5, "", now), { kind: "loaded", minutes: 3 });
  assert.deepEqual(m.statusOf(now - 30_000, "", now), { kind: "loaded", minutes: 0 });
  assert.deepEqual(m.statusOf(now - 120_000, "timeout", now), { kind: "error", minutes: 2 });
  assert.deepEqual(m.statusOf(0, "ECONNREFUSED", now), { kind: "error", minutes: 0 });
});
