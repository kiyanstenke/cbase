"use client";
// The actions of the outline as in VS Code (Outline view: "Collapse All" and "…" with "Follow Cursor" and "Sort by: Position · Name ·
// Category"), placed in the HEADER of the OUTLINE section in the explorer (ExplorerSections.tsx, visible on hover like VS Code) or next to
// the title of the Outline tab (CodePane). The choice applies to BOTH places (one hook in CodePane) and is remembered across files and
// sessions (like VS Code `outline/state`; without storage the default: position, follow cursor). The tree itself is LayoutTree.tsx.
// (The "Layout*" file names mean this outline.)
import { useCallback, useState } from "react";
import { asOrdering, type SymbolOrdering } from "@/lib/symbol-kinds";
import { DotsIcon, Menu, MenuEntry, MenuSeparator } from "@/components/CbKit";

type T = (key: string, params?: Record<string, string | number>) => string;

const ORDERING_KEY = "cbase-layout-ordering";
const FOLLOW_UPS_KEY = "cbase-layout-consequences";
const readOrdering = (): SymbolOrdering => { try { return asOrdering(window.localStorage.getItem(ORDERING_KEY)); } catch { return "position"; } };
const readFollowUps = (): boolean => { try { return window.localStorage.getItem(FOLLOW_UPS_KEY) !== "0"; } catch { return true; } };

export type LayoutChoice = {
  ordering: SymbolOrdering;
  setOrdering: (o: SymbolOrdering) => void;
  /** VS Code `outline.followCursor`: expand the symbols around the cursor, mark the innermost and scroll it into view. */
  followUps: boolean;
  setFollowUps: (f: boolean) => void;
  /** "Collapse All": grows with every press (the tree then collapses every depth). */
  collapseSeq: number;
  collapse: () => void;
};

export function useLayoutChoice(): LayoutChoice {
  const [ordering, setOrderingRaw] = useState<SymbolOrdering>(readOrdering);
  const [followUps, setFollowUpsRaw] = useState<boolean>(readFollowUps);
  const [collapseSeq, setCollapseSeq] = useState(0);
  const setOrdering = useCallback((o: SymbolOrdering) => {
    setOrderingRaw(o);
    try { window.localStorage.setItem(ORDERING_KEY, o); } catch { /* without storage the choice holds until closing */ }
  }, []);
  const setFollowUps = useCallback((f: boolean) => {
    setFollowUpsRaw(f);
    try { window.localStorage.setItem(FOLLOW_UPS_KEY, f ? "1" : "0"); } catch { /* without storage the choice holds until closing */ }
  }, []);
  const collapse = useCallback(() => setCollapseSeq((n) => n + 1), []);
  return { ordering, setOrdering, followUps, setFollowUps, collapseSeq, collapse };
}

const BUTTON = "grid h-[22px] w-[22px] place-items-center rounded-[5px] text-dim transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg";

/** "Collapse All" (codicon collapse-all) and "…" (VS Code: Follow Cursor · Sort by). */
export function LayoutActions({ t, choice }: { t: T; choice: LayoutChoice }) {
  return (<>
    <button type="button" onClick={choice.collapse} title={t("Collapse All")} aria-label={t("Collapse All")} className={BUTTON} data-layout-collapse>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M5.5 8h5" /></svg>
    </button>
    <Menu label={t("More Actions…")} width={230} button={{ content: <DotsIcon />, className: BUTTON, data: { "data-layout-menu": "" } }}>
      <MenuEntry label={t("Follow Cursor")} selected={choice.followUps} onClick={() => choice.setFollowUps(!choice.followUps)} data={{ "data-layout-follow-ups": choice.followUps ? "1" : "0" }} />
      <MenuSeparator />
      {([["position", t("Sort By: Position")], ["name", t("Sort By: Name")], ["kind", t("Sort By: Category")]] as const).map(([o, text]) => (
        <MenuEntry key={o} label={text} selected={choice.ordering === o} onClick={() => choice.setOrdering(o)} data={{ "data-layout-ordering": o }} />
      ))}
    </Menu>
  </>);
}
