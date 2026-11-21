"use client";
// Problems in the tree: the diagnostics of the OPEN buffers — per file errors/warnings, computed in lib/explorer-decoration.ts
// `problemCard`, drawn in TreeRow.tsx (red/yellow with a count, folder above with a dot).
//
// ONE source with the tab colour and the status bar's counters: it is read from lib/diagnostic-status.ts (keyed like the buffer — the same
// file in Coding → Files and in the chat has ONE count). The editor's linter (components/code/lsp-diagnostics.ts, the visible file after
// every change) and the "Problems" panel (components/code/layout-problems.ts) write there. After every pause the tree asks the language
// service for ALL open tabs (asking only for the unknown left a background tab red after the error was long fixed — its linter runs only
// while it is visible) and writes the answer into the same stock — never a second count beside it; the stock reports only a real change.
// The same rule as the panel: asking only while the tree is visible (`on`), only after the pause (`PROBLEMS_PAUSE_MS` — never per key),
// and only the answer of the last run counts (run number). A buffer whose file is not loaded or has no language service asks nothing.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isNotSupported, lspLanguageOf } from "@/lib/api";
import type { Buffer } from "@/lib/buffer";
import { questionBuffer } from "@/components/code/lsp-core";
import type { BufferChange } from "@/components/code/BufferEditor";
import { PROBLEMS_PAUSE_MS } from "@/components/code/layout-problems";
import { subscribeDiagnostics, diagnosticVersion, diagnosticsOf, setDiagnostics, countSeverity, type DiagnosticCount } from "@/lib/diagnostic-status";
import type { ProblemSituation } from "@/lib/explorer-decoration";

type Tab = { path: string; loaded: boolean; binary?: boolean; tooLarge?: boolean };

/** Equal if both carry the same entries in the same order. */
export const sameSituation = (a: readonly ProblemSituation[], b: readonly ProblemSituation[]) => a.length === b.length && a.every((x, i) => x.file === b[i].file && x.severity === b[i].severity);

const withService = (x: Tab) => x.loaded && !x.binary && !x.tooLarge && Boolean(lspLanguageOf(x.path));

export function useTreeProblems(o: { on: boolean; tabs: readonly Tab[]; bufferOf: (path: string) => Buffer | null; bufferTick: number; change: BufferChange }): ProblemSituation[] {
  const { on, tabs, bufferOf, bufferTick, change } = o;
  const diagTick = useSyncExternalStore(subscribeDiagnostics, diagnosticVersion, () => 0);
  const run = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tabsKey = tabs.map((x) => `${x.path}:${x.loaded ? 1 : 0}`).join("\n");
  useEffect(() => {
    if (!on) return;
    const question = () => setTimeout(() => {
      const seq = ++run.current;
      const responses: [string, DiagnosticCount][] = [];
      void Promise.all(tabsRef.current.filter(withService).map(async (x) => {
        const p = bufferOf(x.path);
        if (p?.status.state !== "loaded") return;
        try {
          const r = await questionBuffer(p, "diagnostics");
          if (!isNotSupported(r)) responses.push([p.key, countSeverity(r.diagnostics ?? [])]);
        } catch { /* no answer, no colour */ }
      })).then(() => { if (seq === run.current) for (const [k, z] of responses) setDiagnostics(k, z); });
    }, PROBLEMS_PAUSE_MS);
    let h = question();
    // Every change of a held buffer (every key too) postpones the question — CodePane no longer renders for it (`bufferTick` grows only
    // with the shape, lib/buffer-shape.ts).
    const off = change.subscribe(() => { clearTimeout(h); h = question(); });
    return () => { off(); clearTimeout(h); };
  }, [on, tabsKey, bufferTick, bufferOf, change]);
  // The position per file in the paths of THIS view, from the shared stock (`problemCard` adds them up again). The SAME list as long as its
  // content does not change — `bufferTick` grows with every key, and a new list would recompute the tree's cards (git, ignored, problems)
  // and each row's decoration.
  const last = useRef<ProblemSituation[]>([]);
  return useMemo(() => {
    const out: ProblemSituation[] = [];
    for (const x of tabsRef.current) {
      if (!withService(x)) continue;
      const p = bufferOf(x.path);
      const z = p ? diagnosticsOf(p.key) : null;
      if (!z) continue;
      for (let i = 0; i < z.error; i++) out.push({ file: x.path, severity: "error" });
      for (let i = 0; i < z.warnings; i++) out.push({ file: x.path, severity: "warning" });
    }
    if (sameSituation(out, last.current)) return last.current;
    last.current = out;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabsKey/diagTick/bufferTick are the triggers
  }, [tabsKey, diagTick, bufferTick, bufferOf]);
}
