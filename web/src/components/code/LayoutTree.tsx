"use client";

// The outline as a tree as in VS Code: the symbols of the active file (from the language service,
// components/code/layout-problems.ts) with the codicon per kind in VS Code's colour (classes orange, methods purple, variables/fields
// blue, the rest in the text colour; lib/symbol-kinds.ts, paths lib/codicon-symbols.ts), expandable, ordered by the choice "Sort by:
// Position · Name · Category", and the tree FOLLOWS THE CURSOR (VS Code `outline.followCursor`, can be switched off): the symbols
// around the cursor are expanded, the innermost marked and scrolled into view (components/code/cursor-position.ts). "Collapse All",
// "Follow Cursor" and the order sit in the header of the section or tab (components/code/LayoutActions.tsx; the choice comes from
// there). A click jumps to the symbol name. Rows are 22 px like VS Code's trees; keyboard like a tree (up/down move, right expands,
// left collapses, Enter jumps).
import { useEffect, useMemo, useRef, useState } from "react";
import { allWithChildren, treeRows, chainsIds, sortSymbols, symbolColor, symbolIcon, type TreeSymbol, type SymbolOrdering } from "@/lib/symbol-kinds";
import { codiconPath } from "@/lib/codicon-symbols";
import { useResolvedTheme } from "@/lib/theme";

type T = (key: string, params?: Record<string, string | number>) => string;

export function LayoutTree({ t, symbols, cursor, ordering, followUps, collapseSeq, onJump }: {
  t: T;
  symbols: readonly TreeSymbol[];
  cursor: { line: number; character: number } | null;
  ordering: SymbolOrdering;
  /** Follow the cursor (VS Code `outline.followCursor`). */
  followUps: boolean;
  /** "Collapse All": when the number changes, the tree collapses every depth. */
  collapseSeq: number;
  onJump: (s: TreeSymbol) => void;
}) {
  const dark = useResolvedTheme() === "dark";
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  // Another order gives the ids (a path of indices) other symbols, so the collapsed state no longer applies.
  const orderingPrior = useRef(ordering);
  useEffect(() => {
    if (orderingPrior.current === ordering) return;
    orderingPrior.current = ordering;
    setClosed(new Set()); setFocus(null);
  }, [ordering]);
  const sorted = useMemo(() => sortSymbols(symbols, ordering), [symbols, ordering]);
  // "Collapse All" (not on mount: a new file starts open).
  const collapsePrior = useRef(collapseSeq);
  useEffect(() => {
    if (collapsePrior.current === collapseSeq) return;
    collapsePrior.current = collapseSeq;
    setClosed(new Set(allWithChildren(sorted)));
  }, [collapseSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const chain = useMemo(() => (followUps && cursor ? chainsIds(sorted, cursor) : []), [sorted, cursor, followUps]);
  const marked = chain.length ? chain[chain.length - 1] : null;
  // Follow the cursor: what encloses it is expanded (only if it was closed, otherwise the state would stay the same).
  const chainKey = chain.join(" ");
  useEffect(() => {
    if (!chain.length) return;
    setClosed((old) => (chain.slice(0, -1).some((id) => old.has(id)) ? new Set([...old].filter((id) => !chain.slice(0, -1).includes(id))) : old));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey]);
  const rows = useMemo(() => treeRows(sorted, closed), [sorted, closed]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!marked) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-layout-id="${marked}"]`);
    const l = list.current;
    if (!el || !l) return;
    const e = el.getBoundingClientRect(), r = l.getBoundingClientRect();
    if (e.top < r.top) l.scrollTop -= r.top - e.top;
    else if (e.bottom > r.bottom) l.scrollTop += e.bottom - r.bottom;
  }, [marked, rows.length]);
  const toggle = (id: string, open: boolean) => setClosed((old) => { const n = new Set(old); if (open) n.delete(id); else n.add(id); return n; });
  const carrier = focus !== null && rows.some((z) => z.id === focus) ? focus : marked ?? rows[0]?.id ?? null;
  const key = (e: React.KeyboardEvent, i: number) => {
    const z = rows[i];
    const go = (j: number) => { const target = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (target) { setFocus(target.id); list.current?.querySelector<HTMLElement>(`[data-layout-id="${target.id}"]`)?.focus(); } };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight" && z.hasChildren && !z.open) toggle(z.id, true);
    else if (e.key === "ArrowLeft" && z.open) toggle(z.id, false);
    else if (e.key === "ArrowLeft" && z.depth > 0) go(rows.findIndex((x) => x.id === z.id.slice(0, z.id.lastIndexOf("."))));
    else if (e.key === "Enter" || e.key === " ") onJump(z.symbol);
    else return;
    e.preventDefault();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-layout-tree>
      <div ref={list} role="tree" aria-label={t("Outline")} className="cb-scroll min-h-0 flex-1 overflow-auto pb-2 text-[13px]">
        {rows.map((z, i) => {
          const color = symbolColor(z.symbol.kind, dark);
          const isMarked = z.id === marked;
          return (
            <div
              key={z.id}
              role="treeitem"
              aria-level={z.depth + 1}
              aria-expanded={z.hasChildren ? z.open : undefined}
              aria-selected={isMarked}
              tabIndex={carrier === z.id ? 0 : -1}
              onFocus={() => setFocus(z.id)}
              onKeyDown={(e) => key(e, i)}
              onClick={() => onJump(z.symbol)}
              title={z.symbol.detail ? `${z.symbol.name} — ${z.symbol.detail}` : z.symbol.name}
              style={{ paddingLeft: 4 + z.depth * 8 }}
              className={`flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                isMarked ? "bg-hover text-fg" : "text-fg/90 hover:bg-hover"
              }`}
              data-layout-id={z.id}
              data-layout-marked={isMarked ? "" : undefined}
            >
              <span
                className="grid h-4 w-4 shrink-0 place-items-center text-dim"
                onClick={(e) => { if (z.hasChildren) { e.stopPropagation(); toggle(z.id, !z.open); } }}
                aria-hidden
              >
                {z.hasChildren && (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={`transition-transform ${z.open ? "rotate-90" : ""}`}><path d="M6 3l5 5-5 5" /></svg>
                )}
              </span>
              <svg
                width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="shrink-0"
                style={color ? { color: color } : undefined}
                data-symbol-kind={String(z.symbol.kind)}
                data-codicon={symbolIcon(z.symbol.kind)}
                aria-hidden
              >
                <path d={codiconPath(symbolIcon(z.symbol.kind)) ?? ""} />
              </svg>
              <span className="min-w-0 truncate">{z.symbol.name}</span>
              {z.symbol.detail && <span className="min-w-0 shrink truncate text-[12px] text-dim">{z.symbol.detail}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
