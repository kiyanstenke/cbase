// Credit ("extra usage") and the credit gate (src/lib/credit.ts). No browser: this proves what the display must
// NOT claim: "not delivered" is not "no credit", "field missing" is not "off", and an identifier like
// "out_of_credits" is not a sentence.
//
// Counter-test: `normCredit` with `an: !!…` instead of `bool(…)` turns "a missing is_enabled stays unknown" red;
// `creditReasonSentence` with `return reason` in the default branch turns "an unknown reason shows no identifier" red.
//
// Run:  node --test web/test/credit.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-credit-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "credit.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  CREDIT_GATE_PERCENT, normCredit, creditReasonSentence, creditAmount,
  CREDIT_GATE_ROUTE, gateBody, normCreditGate, loadCreditGate, setCreditGate,
  isGateWaitRow,
} = await import(pathToFileURL(path.join(out, "credit.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const t = (k) => k; // the English text is the key, as in src/lib/i18n.ts

test("no block delivered does NOT mean \"no credit\" — the view gets null", () => {
  assert.equal(normCredit(undefined), null);
  assert.equal(normCredit(null), null);
  assert.equal(normCredit("out_of_credits"), null);
  assert.equal(normCredit([]), null);
});

test("a missing is_enabled stays unknown (null), it does not become \"off\"", () => {
  const g = normCredit({});
  assert.equal(g.existing, true);
  assert.equal(g.on, null);
  assert.equal(g.limit, null);
  assert.equal(g.used, null);
  assert.equal(g.utilization, null);
});

test("snake_case from the endpoint and camelCase from the preparation give the same result", () => {
  const a = normCredit({ is_enabled: true, monthly_limit: 50, used_credits: 1.25, utilization: 2.5, currency: "$", disabled_reason: "" });
  const b = normCredit({ isEnabled: true, monthlyLimit: 50, usedCredits: 1.25, utilization: 2.5, currency: "$", disabledReason: "" });
  assert.deepEqual(a, b);
  assert.equal(a.on, true);
  assert.equal(a.limit, 50);
  assert.equal(a.used, 1.25);
  assert.equal(a.utilization, 2.5);
});

test("numbers as strings count, nonsense becomes null instead of NaN", () => {
  assert.equal(normCredit({ utilization: "12.5" }).utilization, 12.5);
  assert.equal(normCredit({ utilization: "no idea" }).utilization, null);
  assert.equal(normCredit({ monthly_limit: Infinity }).limit, null);
});

test("an unknown reason shows a sentence, no identifier", () => {
  const s = creditReasonSentence("any_new_reason", t);
  assert.ok(!s.includes("_"), s);
  assert.ok(s.endsWith("."), s);
});

test("the known reasons tell \"used up\" from \"never switched on\"", () => {
  // `has_credits:false` means "no pot", not "empty".
  assert.notEqual(creditReasonSentence("out_of_credits", t), creditReasonSentence("not_enabled", t));
  assert.notEqual(creditReasonSentence("", t), creditReasonSentence("out_of_credits", t));
  assert.equal(creditReasonSentence("OUT_OF_CREDITS ", t), creditReasonSentence("out_of_credits", t));
});

test("the gate threshold lies ABOVE the exhausted threshold — two numbers, two meanings", () => {
  assert.equal(CREDIT_GATE_PERCENT, 99);
  assert.ok(CREDIT_GATE_PERCENT > 98, "98 means \"nothing gets through any more\", 99 means \"do not start anything new\"");
});

test("an unknown amount is a dash, not a zero", () => {
  assert.equal(creditAmount(null, "$", "de-DE"), "—");
  assert.ok(creditAmount(1.5, "$", "de-DE").startsWith("$ "));
  assert.ok(!creditAmount(1.5, "", "de-DE").includes("$"));
});

// ── The switch that switched itself off again when switched on ────────────
//
// The usage page read and wrote the credit gate as a field `creditGate` on `/api/auto-continue`. The backend has
// no such field; the route answered 200 with `{ok:true, enabled:true}`, the client read `undefined` and reset the
// switch. Because the same route reads a MISSING `enabled` as ON, every click also switched automatic continue on.
// Route and field name now live in lib/credit.ts and are checked here without a browser.
//
// Counter-test: `CREDIT_GATE_ROUTE` set to "/api/auto-continue" turns "the switch goes to ITS route" red;
// `normCreditGate` with `!!o.enabled` instead of the type check turns "an answer without `enabled` confirms
// nothing" red; `isGateWaitRow` with `w.reason === "gate"` (the old web comparison) turns the wait-row test red.

test("the gate switch goes to ITS route, with the field `enabled`", () => {
  assert.equal(CREDIT_GATE_ROUTE, "/api/credit-gate");
  assert.deepEqual(gateBody(true), { enabled: true });
  assert.deepEqual(gateBody(false), { enabled: false });
  // The key is `enabled` and nothing else: an extra field would be exactly the body that silently flips a foreign
  // setting on the neighbouring route.
  assert.deepEqual(Object.keys(gateBody(false)), ["enabled"]);
});

test("an answer without `enabled` confirms nothing — it does not mean \"off\"", () => {
  assert.equal(normCreditGate({ ok: true }), null, "exactly what came back from /api/auto-continue");
  assert.equal(normCreditGate({ creditGate: true }), null, "the invented field name does not count");
  assert.equal(normCreditGate(null), null);
  assert.equal(normCreditGate("enabled"), null);
  assert.equal(normCreditGate({ enabled: "true" }), null, "a string is not a state");
  assert.deepEqual(normCreditGate({ enabled: false }), { on: false, threshold: CREDIT_GATE_PERCENT });
});

test("the threshold comes from the server; the constant only holds while it is silent", () => {
  assert.equal(normCreditGate({ enabled: true, threshold: 95 }).threshold, 95);
  assert.equal(normCreditGate({ enabled: true }).threshold, CREDIT_GATE_PERCENT);
  // Nonsense from the wire must not set the label to "from 0 %".
  assert.equal(normCreditGate({ enabled: true, threshold: 0 }).threshold, CREDIT_GATE_PERCENT);
  assert.equal(normCreditGate({ enabled: true, threshold: 140 }).threshold, CREDIT_GATE_PERCENT);
});

test("reading and writing touch exactly one route — and write a real boolean", async () => {
  const calls = [];
  const call = async (filePath, opts) => {
    calls.push({ path: filePath, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, enabled: true, threshold: 99 };
  };
  assert.deepEqual(await loadCreditGate(call), { on: true, threshold: 99 });
  assert.deepEqual(await setCreditGate(call, false), { on: true, threshold: 99 });
  assert.deepEqual(calls, [
    { path: "/api/credit-gate", method: "GET", body: null },
    { path: "/api/credit-gate", method: "PUT", body: { enabled: false } },
  ]);
});

test("a write the answer does not confirm THROWS — it must not read \"ok\"", async () => {
  // Exactly the answer of the wrong route; it used to become a silent "off" on the switch while a different
  // setting had actually been flipped.
  const call = async () => ({ ok: true, enabled: undefined });
  await assert.rejects(() => setCreditGate(call, true));
});

test("a gate wait row is recognised by its marker, not by a string", () => {
  // This is what it really looks like (autoContinueView in runs/auto-continue.js): reason "credit" PLUS gate marker.
  assert.equal(isGateWaitRow({ reason: "credit", gate: true }), true);
  assert.equal(isGateWaitRow({ reason: "credit" }), true, "the secondary form holds on its own");
  assert.equal(isGateWaitRow({ gate: true }), true);
  // The value the web client used to compare never comes from the server — a "reset" row is a clock, not a button.
  assert.equal(isGateWaitRow({ reason: "reset", gate: false }), false);
  assert.equal(isGateWaitRow({ reason: "probe", gate: false }), false);
  assert.equal(isGateWaitRow(null), false);
  assert.equal(isGateWaitRow(undefined), false);
});

// The statement about the VIEW. A module that knows the route correctly heals nothing while the page next to it
// goes its own way. The chat is a FAMILY of files under components/chat/: the component in ChatPane.tsx, the history
// build (`buildBubbles`, the role "limit") in chatBubbles.ts, the history row (`<LimitRow`) in ChatBubbleRow.tsx, the
// stage with the strip (`<LimitStrip`, button "Start anyway") in ChatStage.tsx; the reducer listens to "limit_line"
// in chatBubbles.ts, the shell to "limit_wait" in ChatPane.tsx. The stream, slash switch, provider-switch sheet,
// history cache, model choice and background state carry no limit marker, but the negative checks (no second button,
// no dead comparison, no own threshold) must see the WHOLE family. All checks read them together.
// Counter-test: ChatPane.tsx alone turns "renders the history row from LimitStrip.tsx" red; without ChatStage.tsx
// "renders the strip from LimitStrip.tsx" goes red; without chatBubbles.ts "skips the history role "limit" on loading"
// goes red (the first check to fall).
const readChatPaneFamily = (read) =>
  read("src/components/chat/ChatPane.tsx") + read("src/components/chat/ChatStage.tsx") + read("src/components/chat/chatBubbles.ts") + read("src/components/chat/ChatBubbleRow.tsx") + read("src/components/chat/chatStream.ts")
  + read("src/components/chat/chatSlash.ts") + read("src/components/chat/ProviderSwitchModal.tsx") + read("src/components/chat/chatCache.ts")
  + read("src/components/chat/chatModelChoice.ts") + read("src/components/chat/chatBackground.ts");

test("no view invents a field name or a second route", () => {
  const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
  // Switch and wait list live on the subpage Usage → At limit (UsageLimit.tsx); UsageSettings.tsx is only the frame.
  const usage = read("src/components/settings/UsageLimit.tsx");
  const chat = readChatPaneFamily(read);
  // "Active runs" in the header is the third view that describes a wait row: the pill builds its line via
  // lib/run-description.ts (the chat list's short info says the same sentence), so the pill TOGETHER with that
  // computation is checked, and that the pill really calls it.
  const pillFile = read("src/components/pills/ActiveRunsPill.tsx");
  assert.ok(pillFile.includes("runDetails(run, t)"), "the pill builds its details via lib/run-description.ts");
  const pill = pillFile + read("src/lib/run-description.ts");

  assert.ok(usage.includes("setCreditGate") && usage.includes("loadCreditGate"),
    "the switch goes through the checked helpers");
  // `creditGate` exists nowhere in the backend as a JSON key (runs/limit-gate.js only knows the function names
  // creditGateOn/-Status/-Holds). Its presence in the client IS the bug — for reading as well as writing.
  assert.ok(!usage.includes("creditGate"), "the invented field name is back in the view");
  assert.ok(!/"\/api\/auto-continue",\s*\{\s*method:\s*"PUT",\s*body:[^}]*credit/i.test(usage),
    "the gate is hung on the neighbouring route again");

  // The second dead comparison: `reason === "gate"` is never true, so the "Start anyway" button never appeared
  // on the web.
  for (const [name, source] of [["UsageLimit", usage], ["ChatPane-Family", chat], ["ActiveRunsPill", pill]]) {
    assert.ok(!source.includes('reason === "gate"'), `${name} compares against a value the server never sends again`);
    assert.ok(source.includes("isGateWaitRow"), `${name} no longer recognises the gate wait row via the marker`);
  }
});

// ── The strip with the button exists in EVERY chat ─────────────────
//
// The gate parks every chat alike, but only ChatPane used to render wait row, button and the history role "limit".
// Both are now ONE component (LimitStrip.tsx). The check reads the source text like the one above: a second copy
// elsewhere or an own 99 in the strip is exactly the bug prevented here.
//
// Counter-test: removing the LimitStrip rendering and `limit_wait` turns "the chat renders strip and limit row" red;
// importing the gate percent constant into ChatPane turns "the 99 comes from the server" red; a union without them
// turns "the gate kinds have their own headings" red.
test("the chat renders strip and limit row from the SAME component", () => {
  const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
  const chat = readChatPaneFamily(read);
  // LimitStrip.tsx has a single caller; that no copy appears is still checked by the marker below.
  for (const [name, source] of [["ChatPane-Family", chat]]) {
    assert.ok(/<LimitStrip\b/.test(source), `${name} does not render the strip from LimitStrip.tsx`);
    assert.ok(/<LimitRow\b/.test(source), `${name} does not render the history row from LimitStrip.tsx`);
    assert.ok(source.includes('"limit_wait"'), `${name} does not listen to limit_wait`);
    assert.ok(source.includes('"limit_line"'), `${name} does not listen to limit_line`);
    assert.ok(source.includes('e.role === "limit"'), `${name} skips the history role "limit" on loading`);
    assert.ok(source.includes("/auto-continue`"), `${name} does not load the wait row on opening`);
    // The "Start anyway" button sends the release as the body — without `anyway` the server parked again at once.
    assert.ok(source.includes("JSON.stringify({ anyway })"), `${name} does not send the release as {anyway}`);
    // No second strip next to it: the button's marker lives only in the component.
    assert.ok(!source.includes("data-limit-anyway"), `${name} builds the button itself again`);
  }
});

test("the gate threshold in the strip comes from the server — no second 99 in the chat", () => {
  const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
  const chat = readChatPaneFamily(read);
  const strip = read("src/components/LimitStrip.tsx");
  assert.ok(!chat.includes("CREDIT_GATE_PERCENT"), "the ChatPane family carries its own gate threshold again");
  assert.ok(strip.includes("loadCreditGate"), "the strip does not fetch the threshold via the checked route");
  assert.ok(strip.includes("useGateThreshold"), "the threshold has no shared loading path");
  // A bare 99 in the strip would be the second source.
  assert.ok(!/\b99\b/.test(strip.replace(/\/\/.*$/gm, "")), "the strip carries its own 99 again");
});

test("the gate kinds have their own headings — and gate-off no longer exists", () => {
  const strip = fs.readFileSync(path.join(webDir, "src/components/LimitStrip.tsx"), "utf8");
  for (const kind of ['"gate"', '"gate-free"', '"gate-stale"']) assert.ok(strip.includes(kind), `kind ${kind} is missing in the union`);
  assert.ok(!strip.includes('"gate-off"'), "gate-off is back in the client — the server no longer writes it");
  for (const head of ["Credit gate — no new turn", "Started anyway", "Credit gate — reading stale, started"]) {
    assert.ok(strip.includes(`t("${head}")`), `heading "${head}" is missing`);
  }
  // The CLI reports its model switch as "model_switch" with field `model` (runs/do-run.js); the client used to compare
  // against "switch"/`model`, the branch was dead.
  assert.ok(strip.includes('"model_switch"') && !strip.includes('"switch"'), "the model-switch branch compares against a value the server never sends");
});
