// What the usage pages say when no number is there.
//
// "Empty is not unknown": Settings → Usage used to show "No measurement saved yet." on a 500 from /api/usage/claude-limits and
// "Not connected." on a timeout of /api/usage/codex — UsageSubscription swallowed the errors (`.catch(() => {})`) and said the same
// while loading. And the overview always justified an incomplete equivalent value with "not every model has a price", although
// `equivalentComplete` is per usage-contract.js also false for unsplit cache (a wrong reason, while the detail page showed every
// model with a price).
//
// Bound:
//   (a) EXECUTED, the sheet `web/src/lib/usage-status.ts` (compiled with tsc): loading ⇒ "Loading…", error ⇒ "Unavailable", only an
//       answer says "no measurement"/"not connected"/"logged in, no snapshot"; the reason of an incomplete equivalent value comes
//       from the answer (`models[].priceKnown`, `sums.cacheUnsplit`), otherwise only "incomplete" is shown; every sentence is in
//       i18n-de.ts.
//   (b) as TEXT: UsageOverview and UsageSubscription take the sentences from the sheet, UsageSubscription keeps limits and Codex
//       three-valued and no longer swallows their errors, and neither writes the old fixed reason itself.
//
// Counter-tests:
//   finding 6 — delete the line `if (s === "error") return "Unavailable";` in `claudeEmptySentence` ⇒ (a) red ("error ⇒ unavailable"
//               — a 500 would again read "No measurement saved yet.").
//   finding 7 — in `incompleteSet` replace `const unsplit = (s.cacheUnsplit ?? 0) > 0;` by `const unsplit = false;` ⇒ (a) red
//               ("unsplit cache is the reason" — the overview would guess a reason again).
//
// Run:  node --test --test-reporter=tap web/test/usage-status.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let sheet = null;
async function loadSheet() {
  if (sheet) return sheet;
  assert.ok(fs.existsSync(tsc), "web/node_modules is missing (tsc) — the sheet cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-usage-status-"));
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "lib", "usage-status.ts"), "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  sheet = await import(pathToFileURL(path.join(tmp, "usage-status.js")).href);
  return sheet;
}

test("(a) empty is not unknown: loading, unavailable and \"no measurement\"/\"not connected\" are three statements", async () => {
  const m = await loadSheet();
  assert.equal(m.claudeEmptySentence(null), "Loading…", "loading ⇒ loading");
  assert.equal(m.claudeEmptySentence("error"), "Unavailable", "error ⇒ unavailable");
  assert.equal(m.claudeEmptySentence({ window: [] }), "No measurement saved yet.", "only an answer says \"no measurement\"");
  assert.equal(m.codexEmptySentence(null), "Loading…");
  assert.equal(m.codexEmptySentence("error"), "Unavailable", "a timeout does not mean \"not connected\"");
  assert.equal(m.codexEmptySentence({ connected: false }), "Not connected.");
  assert.equal(m.codexEmptySentence({ connected: true }), "Logged in — no usage snapshot yet.");
  assert.equal(m.statusValue(null), null);
  assert.equal(m.statusValue("error"), null);
  const value = { connected: true };
  assert.equal(m.statusValue(value), value);
});

test("(a) the reason of an incomplete equivalent value comes from the answer, never guessed", async () => {
  const m = await loadSheet();
  const sums = (complete, cacheUnsplit = 0) => ({ equivalentComplete: complete, cacheUnsplit });
  assert.equal(m.incompleteSet({ sums: sums(true), models: [{ priceKnown: true }] }), null, "complete ⇒ no note");
  assert.equal(m.incompleteSet(null), null, "no note without an answer (the number then says \"—\" or \"Loading…\")");
  assert.equal(m.incompleteSet({ sums: sums(false), models: [{ priceKnown: true }, { priceKnown: false }] }), "incomplete — not every model has a price", "a model without a price is the reason");
  assert.equal(m.incompleteSet({ sums: sums(false, 1200), models: [{ priceKnown: true }] }), "incomplete — cache from older runs is not split into reads and writes", "unsplit cache is the reason");
  assert.equal(m.incompleteSet({ sums: sums(false, 5), models: [{ priceKnown: false }] }), "incomplete — not every model has a price, and cache from older runs is not split", "both reasons");
  assert.equal(m.incompleteSet({ sums: sums(false), models: [{ priceKnown: true }] }), "incomplete", "a reason the answer does not name (a part without its own price) is not invented");
  // Every sentence of the sheet is in i18n-de.ts.
  const en = read("src/lib/i18n-de.ts");
  const sets = [
    m.claudeEmptySentence(null), m.claudeEmptySentence("error"), m.claudeEmptySentence({}), m.codexEmptySentence({ connected: false }), m.codexEmptySentence({ connected: true }),
    ...[[false, 0, false], [false, 0, true], [false, 9, false], [false, 9, true]].map(([v, c, p]) => m.incompleteSet({ sums: sums(v, c), models: [{ priceKnown: !p }] })),
  ];
  for (const s of sets) assert.ok(en.includes(`  ${JSON.stringify(s)}: `), `missing in i18n-de.ts: ${s}`);
});

test("(b) the pages take the sentences from the sheet; UsageSubscription keeps limits and Codex three-valued and swallows no error", () => {
  const overview = read("src/components/settings/UsageOverview.tsx");
  const subscription = read("src/components/settings/UsageSubscription.tsx");
  for (const [name, text] of [["UsageOverview", overview], ["UsageSubscription", subscription]]) {
    assert.match(text, /from "@\/lib\/usage-status"/, `${name} imports lib/usage-status.ts`);
    assert.ok(!text.includes('t("No measurement saved yet.")') && !text.includes('t("Not connected.")'), `${name} does not write "no measurement"/"not connected" itself`);
    assert.ok(!text.includes('t("incomplete — not every model has a price")'), `${name} does not guess the reason itself`);
    assert.ok(!/type State<T> =/.test(text), `${name} has no state type of its own`);
  }
  assert.match(overview, /empty=\{t\(claudeEmptySentence\(limits\)\)\}/);
  assert.match(overview, /empty=\{t\(codexEmptySentence\(codex\)\)\}/);
  assert.match(overview, /const set = incompleteSet\(statusValue\(consumption\[a\] \?\? null\)\);/);
  assert.match(subscription, /useState<State<ClaudeLimits>>\(null\)/);
  assert.match(subscription, /useState<State<CodexState>>\(null\)/);
  assert.match(subscription, /loadClaudeLimits\(\)\.then\(\(l\) => \{ if \(!cancelled\) setLimits\(l\); \}\)\.catch\(\(\) => \{ if \(!cancelled\) setLimits\("error"\); \}\);/, "an error of the limits is \"unavailable\"");
  assert.match(subscription, /api<CodexState>\("\/api\/usage\/codex"\)\.then\(\(c\) => \{ if \(!cancelled\) setCodex\(c\); \}\)\.catch\(\(\) => \{ if \(!cancelled\) setCodex\("error"\); \}\);/, "an error of the Codex state is \"unavailable\"");
  assert.match(subscription, /\{t\(provider === "claude" \? claudeEmptySentence\(limits\) : codexEmptySentence\(codex\)\)\}/);
});
