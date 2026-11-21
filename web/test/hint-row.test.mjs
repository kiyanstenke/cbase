// The hint row (message role `hint`) in EVERY history view of the web: every view that builds history rows must handle the
// role, and the divider row itself is drawn in one place.
//
// Two halves:
//   1. the pure switch `hintSeparator` (web/src/lib/hint.ts, leaf module) — compiled and REALLY called;
//   2. the source-text contract: EVERY file under web/src that builds history rows (recognised by `e.role === "assistant"`)
//      asks `hintSeparator`, and EVERY one that draws `role === "divider"` draws it via `<SeparatorRow` — a new history
//      view without the switch is red, not silent.
//
// Counter-test: the branch `e.role === "hint"` in chatBubbles.ts removed => test 2 red ("chatBubbles.ts builds history rows
// but does not ask hintSeparator").
//
// Run:  node --test web/test/hint-row.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let out = null;
after(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

test("hintSeparator: text => divider of the kind “hint”, empty => no row", async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-hint-"));
  execFileSync(process.execPath, [tsc, path.join(src, "lib", "hint.ts"), "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
  const { hintSeparator } = await import(pathToFileURL(path.join(out, "hint.js")).href);
  assert.deepEqual(hintSeparator("Effort now medium (was: none)"), { role: "divider", blocks: [], kind: "hint", label: "Effort now medium (was: none)" });
  assert.equal(hintSeparator(""), null);
});

function sources(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

test("every history view asks hintSeparator, every divider row is the SeparatorRow building block", () => {
  const all = sources(src).map((p) => ({ rel: path.relative(src, p), q: fs.readFileSync(p, "utf8") }));
  const builder = all.filter((f) => /e\.role === "assistant"/.test(f.q));
  const painter = all.filter((f) => /role === "divider"/.test(f.q));
  // The current views must be among them — otherwise the guard measures against the wrong marker.
  for (const rel of [path.join("components", "chat", "chatBubbles.ts")]) {
    assert.ok(builder.some((f) => f.rel === rel), `${rel} is missing among the history builders`);
  }
  for (const rel of [path.join("components", "chat", "ChatBubbleRow.tsx")]) {
    assert.ok(painter.some((f) => f.rel === rel), `${rel} is missing among the divider painters`);
  }
  for (const f of builder) {
    assert.match(f.q, /e\.role === "hint"\) \{[^}]*hintSeparator\(e\.text\)/, `${f.rel} builds history rows but does not ask hintSeparator`);
  }
  for (const f of painter) {
    assert.match(f.q, /role === "divider" \? \(\s*(\/\/[^\n]*\n\s*)?<SeparatorRow /, `${f.rel} does not draw the divider via <SeparatorRow>`);
  }
  // The row exists exactly once: no reimplementation with its own data-completion-notice marker next to the building block.
  const reimplementation = all.filter((f) => /data-completion-notice=/.test(f.q)).map((f) => f.rel);
  assert.deepEqual(reimplementation, [path.join("components", "chat", "SeparatorRow.tsx")]);
  // The hint carries no compaction icon: the icon only without `kind`.
  assert.match(all.find((f) => f.rel.endsWith("SeparatorRow.tsx")).q, /\{!b\.kind && icon\}/);
});
