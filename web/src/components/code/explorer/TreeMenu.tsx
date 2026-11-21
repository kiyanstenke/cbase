"use client";
// The explorer's context menu as in VS Code: groups separated by dividers, shortcuts RIGHT-ALIGNED in the row. Which items an entry gets
// is computed by ExplorerTree.tsx (`menuItems`); only the form lives here.
//
// Form rules (components/README.md, the form system of the interface): sheet `cb-pop` (via `popClass`) by portal on the body with `cb-kit` on the node,
// rows in the kit row (`menuRow`/`menuRowDanger`, web/test/menu-row.test.mjs), ↑ ↓ Home End via `menuKeys`. NO click catcher as
// `fixed inset-0`: a document `mousedown` outside `[data-tree-menu]` closes, as do Esc, a right click elsewhere, scrolling and a window
// resize.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuSeparator, menuKeys, menuRow, menuRowDanger, popClass } from "@/components/CbKit";

export type MenuItem = { label: string; shortcut?: string; danger?: boolean; inactive?: boolean; data?: string; run: () => void };
export type MenuEntryKind = MenuItem | "separator";

export function TreeMenu({ x, y, entries, onClose }: { x: number; y: number; entries: readonly MenuEntryKind[]; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;
  // Keep inside the window: past the right/bottom edge ⇒ to the other side of the pointer (like a native context menu).
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 4 ? Math.max(4, x - r.width) : x;
    const top = y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y;
    setSituation({ left, top });
    el.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onOutside = (e: Event) => { if (!(e.target instanceof Element) || !e.target.closest("[data-tree-menu]")) close.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close.current(); } };
    const dismiss = () => close.current();
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("contextmenu", onOutside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("contextmenu", onOutside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="cb-kit" data-tree-menu>
      <div ref={sheet} role="menu" onKeyDown={menuKeys} onContextMenu={(e) => e.preventDefault()} className={`${popClass} fixed z-50 min-w-[240px]`} style={situation}>
        {entries.map((p, i) => (p === "separator"
          ? <MenuSeparator key={`t${i}`} />
          : <Point key={p.label} point={p} close={onClose} />))}
      </div>
    </div>,
    document.body,
  );
}

function Point({ point, close }: { point: MenuItem; close: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={point.inactive}
      {...(point.danger ? { "data-danger": "" } : {})}
      {...(point.data ? { "data-tree-action": point.data } : {})}
      onClick={() => { close(); point.run(); }}
      className={point.danger ? menuRowDanger : menuRow}
    >
      <span className="flex w-full items-center gap-6">
        <span className="min-w-0 flex-1 truncate">{point.label}</span>
        {point.shortcut && <span className="shrink-0 text-[11.5px] tracking-wide text-dim" data-tree-shortcut>{point.shortcut}</span>}
      </span>
    </button>
  );
}
