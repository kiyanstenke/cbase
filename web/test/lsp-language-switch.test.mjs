// After a UI language change, the diagnostics of open files speak the new language IMMEDIATELY. The backend restarts the servers and
// reports `lsp/diagnostic_refresh` (server-side guard: server/backend/test/lsp-vx.test.js); this is the window side, read from the sources:
//   (1) lib/lsp-status.ts `subscribeDiagnosticRefresh` listens to exactly this event, for this target and (with language) only this language
//   (2) components/code/lsp-diagnostics.ts: each view re-asks IMMEDIATELY on the event (effect + `needsRefresh`, then `forceLinting` — the linter
//       otherwise only asks after a change), follows the view's buffer and unsubscribes at the end; the part sits in the extension
//   (3) components/code/layout-problems.ts: the open problems list re-asks at once, per tab target, with unsubscription
// Every claim has a counter-test (one sabotage per line, B_SABOTAGES).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const Q = {
  status: read("src", "lib", "lsp-status.ts"),
  api: read("src", "lib", "api", "lsp.ts"),
  diag: read("src", "components", "code", "lsp-diagnostics.ts"),
  problems: read("src", "components", "code", "layout-problems.ts"),
};
const has = (text, chunk, what) => assert.ok(text.includes(chunk), `${what} — missing: ${chunk}`);

const CHECK = {
  listen(q) {
    has(q.api, 'export const LSP_DIAGNOSTIC_EVENT = "lsp/diagnostic_refresh";', "the event name (contract: lsp/contract.js DIAGNOSTIC_EVENT)");
    has(q.status, "if ((language === null || evt?.language === language) && lspEventAffects(evt, target, LSP_DIAGNOSTIC_EVENT)) fn();", "only this event, this target, this language");
  },
  view(q) {
    has(q.diag, "this.off = d ? subscribeDiagnosticRefresh(d.buffer.target, d.language, () => askNew(this.view)) : () => {};", "the view re-asks immediately");
    has(q.diag, "const askNew = (view: EditorView) => { view.dispatch({ effects: newQuestionsEffect.of(null) }); forceLinting(view); };", "effect first, then immediately (forceLinting alone does nothing without a change)");
    has(q.diag, "const newQuestionsNeeded = (u: ViewUpdate) => u.transactions.some((tr) => tr.effects.some((e) => e.is(newQuestionsEffect)));", "the effect marks the linter");
    has(q.diag, "if (k === this.key) return;\n    this.off();", "another buffer unsubscribes the old subscription");
    has(q.diag, "update() { this.followUp(); }", "follows the view's buffer");
    has(q.diag, "destroy() { this.off(); }", "unsubscribes at the end");
    has(q.diag, "  }, { delay: 500, needsRefresh: newQuestionsNeeded }),\n  newQuestions,\n];", "sits in the extension, the linter with needsRefresh");
  },
  problems(q) {
    has(q.problems, "subscribeDiagnosticRefresh(z, null, () => { clearTimeout(h); h = setTimeout(() => { void loadProblems(); }, 0); })", "the list re-asks immediately");
    has(q.problems, "return () => { off(); for (const b of bitten) b(); clearTimeout(h); };", "and unsubscribes");
  },
};
const B_SABOTAGES = [
  { name: "wrong event", file: "status", old: "lspEventAffects(evt, target, LSP_DIAGNOSTIC_EVENT)", fresh: "lspEventAffects(evt, target, LSP_SEMANTICS_EVENT)", catches: "listen" },
  { name: "any language", file: "status", old: "(language === null || evt?.language === language) && ", fresh: "", catches: "listen" },
  { name: "name differs", file: "api", old: '"lsp/diagnostic_refresh"', fresh: '"lsp/diagnostics_refresh"', catches: "listen" },
  { name: "view does not ask", file: "diag", old: "() => askNew(this.view)", fresh: "() => {}", catches: "view" },
  { name: "forceLinting only (ineffective without a change)", file: "diag", old: "view.dispatch({ effects: newQuestionsEffect.of(null) }); ", fresh: "", catches: "view" },
  { name: "linter without needsRefresh", file: "diag", old: "{ delay: 500, needsRefresh: newQuestionsNeeded }", fresh: "{ delay: 500 }", catches: "view" },
  { name: "old subscription stays", file: "diag", old: "if (k === this.key) return;\n    this.off();", fresh: "if (k === this.key) return;", catches: "view" },
  { name: "no unsubscription", file: "diag", old: "destroy() { this.off(); }", fresh: "destroy() {}", catches: "view" },
  { name: "not built in", file: "diag", old: "  newQuestions,\n];", fresh: "];", catches: "view" },
  { name: "list does not ask", file: "problems", old: "void loadProblems(); }, 0); })", fresh: "}, 0); })", catches: "problems" },
  { name: "list without unsubscription", file: "problems", old: "for (const b of bitten) b(); ", fresh: "", catches: "problems" },
];

test("language change: windows re-ask diagnostics without a click (with counter-tests)", () => {
  for (const f of Object.values(CHECK)) f(Q);
  for (const s of B_SABOTAGES) {
    assert.equal(Q[s.file].split(s.old).length, 2, `sabotage "${s.name}": anchor not exactly once (stale)`);
    const q = { ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) };
    assert.throws(() => CHECK[s.catches](q), `sabotage "${s.name}" was not caught`);
  }
});
