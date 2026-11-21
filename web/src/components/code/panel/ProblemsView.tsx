"use client";
// The PROBLEMS view in the lower panel like VS Code. Computed in lib/problems-list.ts (filter, order, rows, window, empty texts), only
// drawn here:
//
//   ProblemsList   one row per file (arrow, file icon, name, folder dimmed, count as a badge), below it its problems (severity icon in
//                   the colours of Dark/Light Modern, message — multi-line like VS Code, single-line per problem via the arrow on the right —,
//                   source "ts(2304)", "[Ln L, Col C]"). A click (and Space) opens as a preview and LEAVES focus in the list (VS Code
//                   `preserveFocus` — the jump itself then does not focus), double click and ↵ open permanently and give the editor focus;
//                   a click on a file folds it open and shut. Keyboard: ↑ ↓ Home End, ← fold / to the file, → unfold / into the first
//                   problem. Only the visible window is drawn (VS Code virtualises), each row on its own (↑↓ redraws two rows, not the
//                   list); the selection follows the problem via its stable key and becomes empty if it disappears. For assistive technology
//                   a `tree` with `aria-activedescendant`. The rows carry the explorer's shape (`.cb-tree-row`) — one shape for every tree list.
//   ProblemsFilter  the filter field at the top right of the panel header ("Filter (e.g. text, **/*.ts, !**/node_modules/**)"), inside it
//                   "n of m" when something is really missing, and the funnel with errors/warnings/infos, "Show Excluded Files" and "Show
//                   Active File Only" (kit `Menu`, portal on the body).
//
// When empty the view says what VS Code says — and is focusable (VS Code `messageBoxContainer` with tabIndex 0) so that ⇧⌘M closes it again
// even when empty: without problems "No problems have been detected in the workspace.", with "Show Active File Only" and no problem in it
// "No problems have been detected in the current file.", filtered without hits "No results found with provided filter criteria." with
// "Clear Filters". If the list has not arrived, nothing is shown (empty is not unknown).
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuEntry } from "@/components/CbKit";
import { FileSymbol } from "@/components/code/FileSymbol";
import { ArrowSymbol } from "@/components/code/explorer/ExplorerHeader";
import {
  excerpt, emptyState, leftOf, sourceText, visibleRows, jumpKind, showsFilterCount, rowPositions,
  type FilterToggle, type ProblemEntry, type ProblemFilter, type ProblemList, type ProblemRow,
} from "@/lib/problems-list";

type T = (key: string, params?: Record<string, string | number>) => string;
type Jump = (p: ProblemEntry, o: { fixed: boolean; focus: boolean }) => void;

const ROW = 22;
const sym = (children: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden>{children}</svg>
);
// The codicons error, warning, info in their colours (`problemsErrorIcon.foreground` …, variables in globals.css).
export const SEVERITY_SYMBOL: Record<string, () => React.ReactNode> = {
  error: () => <span className="cb-problem-symbol" data-severity="error">{sym(<><circle cx="8" cy="8" r="5.6" /><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" /></>)}</span>,
  warning: () => <span className="cb-problem-symbol" data-severity="warning">{sym(<><path d="M8 2.4l5.9 10.6H2.1z" strokeLinejoin="round" /><path d="M8 6.4v3.3M8 11.2v.5" /></>)}</span>,
  info: () => <span className="cb-problem-symbol" data-severity="info">{sym(<><circle cx="8" cy="8" r="5.6" /><path d="M8 7.2v4M8 4.8v.6" /></>)}</span>,
};
const symbolOf = (s: string) => (SEVERITY_SYMBOL[s] ?? SEVERITY_SYMBOL.info)();
// chevron-up / chevron-down — the toggle of a multi-line message (VS Code `problems.action.toggleMultiline`).
const OnSymbol = () => sym(<path d="M4 10l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />);
const ToSymbol = () => sym(<path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />);

/** The count as a badge (VS Code `badge.*`) — on a file in the list and on the panel's tab. */
export function Badge({ text, data }: { text: string; data?: Record<`data-${string}`, string> }) {
  if (!text) return null;
  return <span className="cb-badge" {...data}>{text}</span>;
}

// One row — drawn only when ITS data change (memo).
const Row = memo(function Row({ t, z, id, top, selected, focus, onSelect, onToggle, onJump, onSingleLine }: {
  t: T; z: ProblemRow; id: string; top: number; selected: boolean; focus: boolean;
  onSelect: (key: string) => void; onToggle: (file: string) => void; onJump: Jump; onSingleLine: (key: string) => void;
}) {
  const mark = { "data-selected": selected ? "" : undefined, "data-focus": selected && focus ? "" : undefined, "data-problem-row": z.key };
  const situation = { position: "absolute" as const, top: top, left: 0, right: 0 };
  if (z.kind === "file") {
    return (
      <div id={id} role="treeitem" aria-level={1} aria-expanded={z.open} aria-selected={selected} {...mark} data-problem-file={z.group.file}
        className="cb-tree-row" style={situation} title={z.group.file}
        onClick={() => { onSelect(z.key); onToggle(z.group.file); }}>
        <span className="grid w-4 shrink-0 place-items-center text-fg"><ArrowSymbol open={z.open} /></span>
        <FileSymbol path={z.group.file} className="ml-0.5 mr-1.5" />
        <span className="shrink-0 truncate text-fg">{z.group.name}</span>
        {z.group.folder && <span className="ml-[0.5em] min-w-0 truncate text-[0.9em] text-dim">{z.group.folder}</span>}
        <span className="ml-2.5 shrink-0"><Badge text={String(z.group.entries.length)} data={{ "data-problem-count": String(z.group.entries.length) }} /></span>
      </div>
    );
  }
  const p = z.entry;
  const source = sourceText(p.source, p.code);
  const details = (
    <>
      {source && <span className="ml-1.5 shrink-0 text-dim" data-problem-source>{source}</span>}
      <span className="ml-1.5 shrink-0 text-dim" data-problem-place>{t("[Ln {z}, Col {s}]", { z: p.line, s: p.column ?? 1 })}</span>
    </>
  );
  const open = z.rows.length > 1;
  return (
    <div id={id} role="treeitem" aria-level={2} aria-selected={selected} {...mark} data-problem-severity={p.severity}
      className="cb-tree-row flex-col !items-stretch" style={{ ...situation, paddingLeft: 24 }} title={p.message}
      onClick={() => { onSelect(z.key); onJump(p, jumpKind("click")); }}
      onDoubleClick={() => onJump(p, jumpKind("double-click"))}>
      {z.rows.map((text, i) => (
        <div key={i} className="flex min-w-0 items-center" style={{ height: ROW }} data-problem-notice-row={i}>
          {i === 0 ? <span className="mr-1.5 grid w-4 shrink-0 place-items-center">{symbolOf(p.severity)}</span> : <span className="mr-1.5 w-4 shrink-0" />}
          <span className="min-w-0 shrink truncate text-fg">{text}</span>
          {i === z.rows.length - 1 && details}
          <span className="flex-1" />
          {i === 0 && z.multiline && (
            <button type="button" tabIndex={-1} aria-expanded={open}
              title={open ? t("Show message in single line") : t("Show message in multiple lines")}
              aria-label={open ? t("Show message in single line") : t("Show message in multiple lines")}
              onClick={(e) => { e.stopPropagation(); onSingleLine(z.key); }}
              className="mr-1 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[3px] text-fg hover:bg-hover"
              data-problem-multiline={open ? "open" : "closed"}>{open ? <OnSymbol /> : <ToSymbol />}</button>
          )}
        </div>
      ))}
    </div>
  );
});

export function ProblemsList({ t, list, filter, onFilterClear, closed: collapsed, setClosed, singleLine, setSingleLine, onJump }: {
  t: T;
  list: ProblemList;
  filter: ProblemFilter;
  onFilterClear: () => void;
  closed: ReadonlySet<string>;
  setClosed: (closed: ReadonlySet<string>) => void;
  /** The problems whose message is single-line (key) — none by default (VS Code: multi-line). */
  singleLine: ReadonlySet<string>;
  setSingleLine: (s: ReadonlySet<string>) => void;
  /** Open a problem: `fixed` (double click, ↵) with focus in the editor, otherwise as a preview, focus stays here (lib/problems-list.ts `jumpKind`). */
  onJump: Jump;
}) {
  const rows = useMemo(() => visibleRows(list.groups, collapsed, singleLine), [list, collapsed, singleLine]);
  const positions = useMemo(() => rowPositions(rows, ROW), [rows]);
  const [active, setActive] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const base = useId();
  // The selection follows the problem (stable key); if it is gone there is none (-1) — never silently the first row.
  const index = rows.findIndex((z) => z.key === active);
  useEffect(() => { if (active && index < 0) setActive(null); }, [active, index]);
  // The visible window (scrolled, list height).
  const [view, setView] = useState({ roles: 0, height: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView((s) => (s.roles === el.scrollTop && s.height === el.clientHeight ? s : { roles: el.scrollTop, height: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [rows.length > 0]);
  const { from, until } = excerpt(positions, view.roles, view.height);
  // Keep the chosen row in view (keyboard) — computed, since it may not be drawn at all.
  useEffect(() => {
    const el = box.current;
    if (!el || index < 0) return;
    const top = positions.top[index], bottom = top + rows[index].height * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const collapsedRef = useRef(collapsed), oneRef = useRef(singleLine);
  collapsedRef.current = collapsed;
  oneRef.current = singleLine;
  const toggle = useMemo(() => (file: string) => { const n = new Set(collapsedRef.current); if (n.has(file)) n.delete(file); else n.add(file); setClosed(n); }, [setClosed]);
  const singleLineToggle = useMemo(() => (k: string) => { const n = new Set(oneRef.current); if (n.has(k)) n.delete(k); else n.add(k); setSingleLine(n); }, [setSingleLine]);
  const keys = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const z = index >= 0 ? rows[index] : null;
    const go = (i: number) => { e.preventDefault(); setActive(rows[Math.max(0, Math.min(rows.length - 1, i))].key); };
    if (e.key === "ArrowDown") go(index < 0 ? 0 : index + 1);
    else if (e.key === "ArrowUp") go(index < 0 ? 0 : index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowLeft" && index >= 0) {
      const l = leftOf(rows, index);
      e.preventDefault();
      if (l.collapse) toggle(l.collapse); else setActive(rows[l.index].key);
    } else if (e.key === "ArrowRight" && z?.kind === "file") {
      e.preventDefault();
      if (!z.open) toggle(z.group.file); else if (rows[index + 1]?.kind === "problem") setActive(rows[index + 1].key);
    } else if ((e.key === "Enter" || e.key === " ") && z) {
      e.preventDefault();
      if (z.kind === "file") toggle(z.group.file);
      else onJump(z.entry, jumpKind(e.key === "Enter" ? "enter" : "spacebar"));
    }
  };

  const empty = emptyState(list, filter);
  if (empty === "loading") return null;
  if (empty) {
    // Focusable like VS Code (`messageBoxContainer` tabIndex 0): ⇧⌘M focuses it, and a second ⇧⌘M closes.
    return (
      <div tabIndex={0} className="h-full px-5 text-[13px] leading-[22px] text-fg outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent" data-panel-focus data-problems-empty={empty}>
        {empty === "no" ? t("No problems have been detected in the workspace.")
          : empty === "activeFile" ? t("No problems have been detected in the current file.")
            : <>
              {t("No results found with provided filter criteria.")}{" "}
              <button type="button" onClick={onFilterClear} className="text-accent hover:underline" data-problems-filter-clear>{t("Clear Filters")}</button>
            </>}
      </div>
    );
  }
  const idOf = (i: number) => `${base}-${i}`;
  return (
    <div
      ref={box}
      role="tree"
      aria-label={t("Problems")}
      aria-activedescendant={index >= 0 && index >= from && index < until ? idOf(index) : undefined}
      tabIndex={0}
      className="cb-tree cb-scroll relative h-full overflow-auto outline-none"
      data-tree-focus={focused ? "" : undefined}
      data-panel-focus
      data-problems-list
      onScroll={(e) => { const el = e.currentTarget; setView((s) => (s.roles === el.scrollTop ? s : { ...s, roles: el.scrollTop })); }}
      onFocus={() => { setFocused(true); if (index < 0 && rows[0]) setActive(rows[0].key); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={keys}
    >
      <div style={{ height: positions.total, position: "relative" }}>
        {rows.slice(from, until).map((z, k) => {
          const i = from + k;
          return (
            <Row key={z.key} t={t} z={z} id={idOf(i)} top={positions.top[i]} selected={i === index} focus={focused}
              onSelect={setActive} onToggle={toggle} onJump={onJump} onSingleLine={singleLineToggle} />
          );
        })}
      </div>
    </div>
  );
}

const FunnelSymbol = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden><path d="M2.5 3h11L9.2 8.2V13l-2.4-1.2V8.2z" /></svg>
);

/** The filter field in the panel header (only while PROBLEMS is in front). */
export function ProblemsFilter({ t, text, setText, toggle, setToggle, list, set }: {
  t: T;
  text: string;
  setText: (s: string) => void;
  toggle: Required<FilterToggle>;
  setToggle: (s: Required<FilterToggle>) => void;
  list: ProblemList;
  set: boolean;
}) {
  const converted = !toggle.error || !toggle.warnings || !toggle.infos || toggle.onlyActiveFile || !toggle.excludedShow;
  return (
    <div className="flex h-[24px] min-w-[120px] max-w-[500px] flex-1 items-center gap-0.5 rounded-[2px] border border-edge bg-bg pl-1.5 pr-[2px] focus-within:border-accent" data-problems-filter data-problems-filter-set={set ? "" : undefined}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); } }}
        placeholder={t("Filter (e.g. text, **/*.ts, !**/node_modules/**)")}
        aria-label={t("Filter (e.g. text, **/*.ts, !**/node_modules/**)")}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-dim"
        data-problems-filter-field
      />
      {showsFilterCount(list) && <span className="shrink-0 rounded-[2px] px-1 text-[11px] text-dim" data-problems-shown={`${list.shown}/${list.total}`}>{t("Showing {n} of {m}", { n: list.shown, m: list.total })}</span>}
      <Menu label={t("More Filters...")} width={260} button={{
        content: <FunnelSymbol />,
        className: `grid h-5 w-5 shrink-0 place-items-center rounded-[3px] ${converted ? "bg-accent/25 text-fg ring-1 ring-inset ring-accent" : "text-dim hover:bg-hover hover:text-fg"}`,
        data: { "data-problems-funnel": converted ? "on" : "off" },
      }}>
        <MenuEntry label={t("Show Errors")} selected={toggle.error} onClick={() => setToggle({ ...toggle, error: !toggle.error })} />
        <MenuEntry label={t("Show Warnings")} selected={toggle.warnings} onClick={() => setToggle({ ...toggle, warnings: !toggle.warnings })} />
        <MenuEntry label={t("Show Infos")} selected={toggle.infos} onClick={() => setToggle({ ...toggle, infos: !toggle.infos })} />
        <MenuEntry label={t("Show Excluded Files")} selected={toggle.excludedShow} onClick={() => setToggle({ ...toggle, excludedShow: !toggle.excludedShow })} />
        <MenuEntry label={t("Show Active File Only")} selected={toggle.onlyActiveFile} onClick={() => setToggle({ ...toggle, onlyActiveFile: !toggle.onlyActiveFile })} />
      </Menu>
    </div>
  );
}
