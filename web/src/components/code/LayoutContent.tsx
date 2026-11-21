"use client";
// The content of the outline in ONE place: the Outline tab of the side bar AND the OUTLINE section at the bottom of the explorer show
// the SAME view: the states (no file with a language service, loading, no symbols; the texts are VS Code's) and the tree
// components/code/LayoutTree.tsx (embedded, not copied). The choice (order, follow cursor, collapse all) comes from the header
// (components/code/LayoutActions.tsx).
import type { EditorView } from "@codemirror/view";
import { lspLanguageOf } from "@/lib/api";
import { useCursorSituation } from "@/components/code/cursor-position";
import { LayoutTree } from "@/components/code/LayoutTree";
import type { LayoutChoice } from "@/components/code/LayoutActions";
import type { Layout } from "@/components/code/layout-problems";

type T = (key: string, params?: Record<string, string | number>) => string;

export function LayoutContent({ t, active, layout, view, choice, onJump }: {
  t: T;
  /** The active file (project-relative) or null. */
  active: string | null;
  layout: Layout | null;
  /** The view of the active file; its cursor is read here, not in CodePane (there everything would re-render per keystroke). */
  view: () => EditorView | null;
  choice: LayoutChoice;
  /** Jumps to the symbol name in the active file (`selectionRange.start`, 0-based, as in VS Code). */
  onJump: (from: { line: number; character: number }) => void;
}) {
  const cursor = useCursorSituation(view)?.lsp ?? null;
  // VS Code (outlinePane): without an editor or without a language service "The active editor cannot provide outline information.",
  // without symbols "No symbols found in document '{0}'".
  if (!active || !lspLanguageOf(active)) return <div className="px-3 py-2 text-[12px] text-dim" data-layout-empty>{t("The active editor cannot provide outline information.")}</div>;
  if (!layout || layout.path !== active) return <div className="px-3 py-2 text-[12px] text-dim">{t("Loading…##inline")}</div>;
  if (layout.symbols.length === 0) return <div className="px-3 py-2 text-[12px] text-dim" data-layout-empty>{t("No symbols found in document '{name}'", { name: active.slice(active.lastIndexOf("/") + 1) })}</div>;
  // The tree as in VS Code: coloured kinds, expandable, follows the cursor.
  return <LayoutTree key={active} t={t} symbols={layout.symbols} cursor={cursor} ordering={choice.ordering} followUps={choice.followUps} collapseSeq={choice.collapseSeq}
    onJump={(s) => onJump(s.selectionRange.start)} />;
}
