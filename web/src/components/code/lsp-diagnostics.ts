// Diagnostics of the language service as a linter (what the server reports is shown — "Import could not be resolved" as an error): after
// every change (debounced) `diagnostics` — the first call starts the server. F8/⇧F8 jump via the command table (components/code/lsp-commands.ts)
// with `nextDiagnostic`/`previousDiagnostic`. Shown as a squiggle and in the hover — NO gutter dot per error line: VS Code has none
// (components/code/gutters.ts, guard web/test/editor-look.test.mjs).
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { isNotSupported, lspAreaOf, severityOf } from "@/lib/api";
import { questions, lspFileOf } from "@/components/code/lsp-core";
import { setDiagnostics, countSeverity } from "@/lib/diagnostic-status";
import { subscribeDiagnosticRefresh } from "@/lib/lsp-status";

// B asks for new diagnostics (lsp/diagnostic_refresh — the server restarted after the UI language changed, or sent
// `workspace/diagnostic/refresh`): the view asks again AT ONCE — without click or key (the linter otherwise asks only after a change).
// Like VS Code, whose diagnostics speak the new language after a language switch. Follows the target and language of the file (a tab switches).
// `forceLinting` alone does NOTHING while nothing changed since the last run (@codemirror/lint: `force` only on `set`) — only the effect
// `newQuestionsEffect` marks the linter via `needsRefresh`, then it runs at once instead of after the pause.
const newQuestionsEffect = StateEffect.define<null>();
const newQuestionsNeeded = (u: ViewUpdate) => u.transactions.some((tr) => tr.effects.some((e) => e.is(newQuestionsEffect)));
const askNew = (view: EditorView) => { view.dispatch({ effects: newQuestionsEffect.of(null) }); forceLinting(view); };
const newQuestions = ViewPlugin.fromClass(class {
  off: () => void = () => {};
  key = "";
  constructor(readonly view: EditorView) { this.followUp(); }
  followUp() {
    const d = lspFileOf(this.view.state);
    const k = d ? d.buffer.key : "";
    if (k === this.key) return;
    this.off();
    this.key = k;
    this.off = d ? subscribeDiagnosticRefresh(d.buffer.target, d.language, () => askNew(this.view)) : () => {};
  }
  update() { this.followUp(); }
  destroy() { this.off(); }
});

export const lspDiagnostics: Extension = [
  linter(async (view) => {
    const d = lspFileOf(view.state);
    if (!d) return [];
    const doc = view.state.doc;
    let r;
    try { r = await questions(d, "diagnostics"); } catch { return []; }
    if (isNotSupported(r)) return [];
    setDiagnostics(d.buffer.key, countSeverity(r.diagnostics ?? [])); // tab colour and status bar counter (lib/diagnostic-status.ts)
    return (r.diagnostics ?? []).map((x): Diagnostic => {
      const b = lspAreaOf(doc, x.range);
      // A zero-width point is underlined as one character (otherwise it would be invisible).
      const to = b.to > b.from ? b.to : Math.min(doc.length, b.from + 1);
      return { from: b.from, to, severity: severityOf(x.severity), message: x.message, source: x.source || undefined };
    });
  }, { delay: 500, needsRefresh: newQuestionsNeeded }),
  newQuestions,
];
