"use client";

// The code editor's menu in one place: the context menu (right click, Shift+F10, context-menu key) and the lists of code actions
// (Refactor …, Source Action …, Quick Fix, light bulb), identical in the browser and the desktop client, instead of the browser's
// menu. Kit shape: `popClass` (flat, `cb-pop`), rows `MenuEntry` (the ONE menu row, web/test/menu-row.test.mjs), shortcuts on the right
// as Mac symbols, groups by `MenuSeparator`; an entry with children opens its submenu to the side (VS Code "Peek >").
//
// There is ONE such menu in the window: it hangs on its own React root at the body (a node with `cb-kit`, because the cool colour
// roles apply only beneath it), created on first open. So CodePane and the diff tab need not mount anything: the editor extension
// (components/code/lsp-commands.ts) calls `openEditorMenu`. It closes on Escape (focus returns to the editor), a pointer press
// elsewhere (document `mousedown` + `closest`, no `fixed inset-0` catcher), scrolling outside the sheet, window size and choice.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MenuEntry, MenuSeparator, menuKeys, popClass, useFlat } from "@/components/CbKit";

export type MenuItem = {
  id: string;
  label: string;
  /** The shortcut on the right (Mac symbols). */
  right?: string;
  disabled?: boolean;
  /** A sentence under the entry (e.g. why a code action is unavailable). */
  hint?: string;
  /** The submenu (groups). */
  children?: MenuItem[][];
  /** A toggle (VS Code: a check mark before the entry, e.g. "Enable Preview Editors"); set means it has a state. */
  on?: boolean;
  execute?: () => void;
};
export type MenuJob = {
  /** Window coordinates of the top-left corner (the sheet stays inside the window). */
  x: number;
  y: number;
  groups: MenuItem[][];
  /** Opened by keyboard: focus is on the first entry (otherwise on the sheet). */
  perKey?: boolean;
  /** Where focus returns after Escape (the editor). */
  back?: () => void;
  /** A heading above the entries (code actions). */
  title?: string;
};

let state: (MenuJob & { seq: number }) | null = null;
let seq = 0;
const subscribers = new Set<() => void>();
let root: Root | null = null;
const report = () => { for (const fn of [...subscribers]) fn(); };

export function openEditorMenu(a: MenuJob): void {
  if (typeof document === "undefined" || !a.groups.some((g) => g.length)) return;
  if (!root) {
    const host = document.createElement("div");
    host.className = "cb-kit";
    host.setAttribute("data-editor-menu-root", "");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<EditorMenuWrapper />);
  }
  state = { ...a, seq: ++seq };
  report();
}
export function closeEditorMenu(o: { back?: boolean } = {}): void {
  const a = state;
  if (!a) return;
  state = null;
  report();
  if (o.back) a.back?.();
}
export const editorMenuOpen = (): boolean => state !== null;

function EditorMenuWrapper() {
  const a = useSyncExternalStore((fn) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; }, () => state, () => null);
  return a ? <Sheet key={a.seq} a={a} /> : null;
}

const MARGIN = 8;
function Sheet({ a, level = 0, anchorRight, dismiss: close }: { a: MenuJob; level?: number; anchorRight?: DOMRect; dismiss?: () => void }) {
  const flat = useFlat();
  const sheet = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState<React.CSSProperties | null>(null);
  const [kind, setKind] = useState<{ id: string; rect: DOMRect; perKey: boolean } | null>(null);

  useEffect(() => {
    if (level) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeEditorMenu({ back: true }); } };
    const beside = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest?.("[data-editor-menu]")) closeEditorMenu(); };
    const scrolled = (e: Event) => { if (!(e.target instanceof Element && e.target.closest("[data-editor-menu]"))) closeEditorMenu(); };
    const onClose = () => closeEditorMenu();
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", beside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", beside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [level]);

  // Position before the first paint: at the spot (or right of the submenu's row), kept inside the window.
  useLayoutEffect(() => {
    const b = sheet.current?.getBoundingClientRect();
    if (!b) return;
    let left = anchorRight ? anchorRight.right + 2 : a.x;
    let top = anchorRight ? anchorRight.top - 6 : a.y;
    if (left + b.width > window.innerWidth - MARGIN) left = anchorRight ? anchorRight.left - b.width - 2 : window.innerWidth - b.width - MARGIN;
    if (top + b.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, (anchorRight ? anchorRight.bottom + 6 : a.y) - b.height);
    setSituation({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
  }, [a, anchorRight]);

  useEffect(() => {
    if (!situation) return;
    const b = sheet.current;
    if (a.perKey) b?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    else b?.focus({ preventScroll: true });
  }, [situation, a.perKey]);

  const select = (p: MenuItem) => {
    if (p.children) return;
    closeEditorMenu({ back: true });
    p.execute?.();
  };
  const kindOn = (p: MenuItem, el: HTMLElement | null, perKey: boolean) => {
    if (!p.children || !el) { setKind(null); return; }
    setKind({ id: p.id, rect: el.getBoundingClientRect(), perKey });
  };
  const kindPoint = kind ? a.groups.flat().find((p) => p.id === kind.id) : null;

  return (
    <>
      <div
        ref={sheet}
        role="menu"
        tabIndex={-1}
        data-editor-menu=""
        style={{ minWidth: 240, maxWidth: 420, ...(situation ?? { top: 0, left: 0, visibility: "hidden" }) }}
        className={`${popClass} cb-kit fixed z-[60] origin-top-left${flat}`}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" && close) { e.preventDefault(); e.stopPropagation(); close(); return; }
          menuKeys(e);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {a.title && <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-dim">{a.title}</div>}
        {a.groups.filter((g) => g.length).map((g, gi) => (
          <div key={gi} role="group">
            {gi > 0 && <MenuSeparator />}
            {g.map((p) => (
              <div
                key={p.id}
                data-editor-menu-point={p.id}
                onMouseEnter={(e) => kindOn(p, e.currentTarget, false)}
                onKeyDown={(e) => { if (e.key === "ArrowRight" && p.children) { e.preventDefault(); e.stopPropagation(); kindOn(p, e.currentTarget, true); } }}
              >
                <MenuEntry
                  label={p.label}
                  hint={p.hint}
                  disabled={p.disabled}
                  selected={p.on}
                  onClick={() => (p.children ? kindOn(p, sheet.current?.querySelector<HTMLElement>(`[data-editor-menu-point="${CSS.escape(p.id)}"]`) ?? null, false) : select(p))}
                  right={p.children ? <span aria-hidden className="text-dim">›</span> : p.right ? <span className="shrink-0 text-[11px] tabular-nums text-dim">{p.right}</span> : undefined}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      {kindPoint?.children && kind && (
        <Sheet
          key={kind.id} a={{ x: 0, y: 0, groups: kindPoint.children, perKey: kind.perKey, back: a.back }} level={level + 1} anchorRight={kind.rect}
          dismiss={() => { const id = kind.id; setKind(null); sheet.current?.querySelector<HTMLElement>(`[data-editor-menu-point="${CSS.escape(id)}"] [role="menuitem"]`)?.focus(); }}
        />
      )}
    </>
  );
}
