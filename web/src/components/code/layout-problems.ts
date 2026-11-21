// The two lists CodePane's sidebar/panel shows from the language service: the "Outline" mode (`outline` of the active file, flat with depth)
// and the "Problems" panel (`diagnostics` of all open tabs with a language service).
//
// Debounced: after a change the question is asked only after a pause (outline LAYOUT_PAUSE_MS like breadcrumbs/sticky scroll, problems
// PROBLEMS_PAUSE_MS), on open and on file switch immediately; only the answer of the latest run counts (run number), so a late answer
// never overwrites a newer one.
import { useCallback, useEffect, useRef, useState } from "react";
import { flatLayout, isNotSupported, lspLanguageOf, severityOf, type LspSymbol, type LspTarget } from "@/lib/api";
import { subscribeDiagnosticRefresh } from "@/lib/lsp-status";
import { setDiagnostics, countSeverity } from "@/lib/diagnostic-status";
import type { Buffer } from "@/lib/buffer";
import { questionBuffer } from "@/components/code/lsp-core";
import type { BufferChange } from "@/components/code/BufferEditor";
import { LAYOUT_PAUSE_MS } from "@/components/code/lsp-layout";

/** How long after the last change the open Problems panel asks again. */
export const PROBLEMS_PAUSE_MS = 500;
export type OutlineItem = { name: string; kind: string; line: number; level: number };
/** The outline as a tree (the server's symbols as they come) — `items` stays the flat list for the other readers. */
export type Layout = { path: string; items: OutlineItem[]; symbols: LspSymbol[] };
/** Plus column (1-based), source ("ts") and code (2304) — the Problems view shows them like VS Code. */
export type Problem = { file: string; line: number; message: string; severity: string; column?: number; source?: string; code?: string | number };
type Tab = { path: string; loaded: boolean; binary?: boolean; tooLarge?: boolean };

export function useLayoutAndProblems(o: {
  outlineOn: boolean; activePath: string | null; pa: Buffer | null;
  problemsOn: boolean; tabs: readonly Tab[]; bufferOf: (path: string) => Buffer | null; bufferTick: number; change: BufferChange;
}): { outline: Layout | null; problems: Problem[] | null; loadProblems: () => Promise<void> } {
  const { outlineOn, activePath, pa, problemsOn, tabs, bufferOf, bufferTick, change } = o;
  const [outline, setOutline] = useState<Layout | null>(null);
  // null: never loaded — "no problems" would be an unchecked claim (empty is not unknown; the view shows nothing then).
  const [problems, setProblems] = useState<Problem[] | null>(null);

  // Outline of the active file (`outline`, hierarchical, flat with depth here).
  // The buffer reports every change itself (`subscribe`) — CodePane does not render per keystroke; each change pushes the question back by the pause.
  const layoutFor = useRef<string | null>(null);
  const state = pa?.status.state;
  useEffect(() => {
    if (!outlineOn || !activePath || !lspLanguageOf(activePath)) { if (outlineOn) setOutline(null); layoutFor.current = null; return; }
    if (!pa || pa.status.state !== "loaded") return;
    let alive = true;
    let h: ReturnType<typeof setTimeout> | null = null;
    let version = pa.version;
    const question = (ms: number) => {
      if (h) clearTimeout(h);
      h = setTimeout(() => {
        h = null;
        questionBuffer(pa, "outline")
          .then((r) => { if (alive) setOutline({ path: activePath, items: isNotSupported(r) ? [] : flatLayout(r.symbols), symbols: isNotSupported(r) ? [] : r.symbols ?? [] }); })
          .catch(() => { if (alive) setOutline({ path: activePath, items: [], symbols: [] }); });
      }, ms);
    };
    const immediately = layoutFor.current !== activePath; // other tab or just opened: do not wait
    layoutFor.current = activePath;
    question(immediately ? 0 : LAYOUT_PAUSE_MS);
    const off = pa.subscribe(() => { if (pa.version !== version && pa.status.state === "loaded") { version = pa.version; question(LAYOUT_PAUSE_MS); } });
    return () => { alive = false; off(); if (h) clearTimeout(h); };
  }, [outlineOn, activePath, pa, state]);

  // Problems (diagnostics) of open tabs with a language service. Only the answer of the latest run counts.
  const run = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const loadProblems = useCallback(async () => {
    const seq = ++run.current;
    const all: Problem[] = [];
    const counts: [string, ReturnType<typeof countSeverity>][] = []; // into the store only if this run is the latest
    await Promise.all(tabsRef.current.filter((t) => t.loaded && !t.binary && !t.tooLarge && lspLanguageOf(t.path)).map(async (t) => {
      const p = bufferOf(t.path);
      if (p?.status.state !== "loaded") return;
      try {
        const r = await questionBuffer(p, "diagnostics");
        if (!isNotSupported(r)) {
          for (const d of r.diagnostics ?? []) all.push({ file: t.path, line: d.range.start.line + 1, message: d.message, severity: severityOf(d.severity), column: d.range.start.character + 1, source: d.source, code: d.code });
          counts.push([p.key, countSeverity(r.diagnostics ?? [])]); // tab colour and status bar counter
        }
      } catch { /* ignore */ }
    }));
    if (seq !== run.current) return;
    for (const [k, z] of counts) setDiagnostics(k, z);
    setProblems(all);
  }, [bufferOf]);
  const problemsOpen = useRef(false);
  const tabsKey = tabs.map((t) => `${t.path}:${t.loaded ? 1 : 0}`).join("\n");
  useEffect(() => {
    if (!problemsOn) { problemsOpen.current = false; return; }
    const immediately = !problemsOpen.current; // just opened: do not wait
    problemsOpen.current = true;
    let h = setTimeout(() => { void loadProblems(); }, immediately ? 0 : PROBLEMS_PAUSE_MS);
    // Every change of a held buffer (every keystroke too) pushes the question back — without CodePane rendering.
    const off = change.subscribe(() => { clearTimeout(h); h = setTimeout(() => { void loadProblems(); }, PROBLEMS_PAUSE_MS); });
    // When B asks for new diagnostics (restart after a language switch), the open list asks again at once — per target of the open tabs.
    const targets = new Map<string, LspTarget>();
    for (const t of tabsRef.current) { const p = bufferOf(t.path); if (p) targets.set(JSON.stringify([p.target.apiBase, p.target.instance ?? ""]), p.target); }
    const bitten = [...targets.values()].map((z) => subscribeDiagnosticRefresh(z, null, () => { clearTimeout(h); h = setTimeout(() => { void loadProblems(); }, 0); }));
    return () => { off(); for (const b of bitten) b(); clearTimeout(h); };
  }, [problemsOn, loadProblems, bufferTick, tabsKey, change, bufferOf]);

  return { outline, problems, loadProblems };
}
