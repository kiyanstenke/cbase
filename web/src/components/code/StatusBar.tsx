"use client";

// The editor's status bar as in VS Code, not to be confused with the header's status bar (TopNav, web/test/statusBar.test.mjs). 22 px
// high, 12 px type, every entry in the SAME shape (`STATUS_ENTRY`: full height, 5 px at the sides, hover lightens, a pressed toggle
// stands light):
//   left   x n / warning m: the problems of the open files (a click opens "Problems"), plus debug while a run exists;
//   right  "Ln L, Col C" (with selection "(N selected)", several cursors "N selections"; a click opens "Go to Line", the palette with
//          `:`), indentation ("Spaces: 2" / "Tab Size: 4", guessed from the file; a click opens the editor settings), "UTF-8",
//          "LF"/"CRLF" (the buffer's line ending), the language mode, then the language service (LspStatusLine.tsx), Zen and terminal.
// The counters read the store lib/diagnostic-status.ts through the buffer keys of the open tabs; a file without an entry does not count
// (it is unknown, not error-free). An entry is cleared when its buffer closes and carried along when it is renamed; this file
// registers that ONCE per window.
// The calculations (column with tabs, indentation, language name, line ending) live purely in lib/editor-status.ts.
import { useMemo } from "react";
import type { EditorView } from "@codemirror/view";
import { atClose, atRename, bufferKey, renamedKey } from "@/lib/buffer";
import { coordinatesOf } from "@/lib/buffer-coordinates";
import { setDiagnostics, sumDiagnostics, relocateDiagnostics } from "@/lib/diagnostic-status";
import { selectionText, languageName, lineEndingName, type Indentation } from "@/lib/editor-status";
import { useDiagnosticTick } from "@/components/code/TabBar";
import { openPalette } from "@/components/code/CommandPalette";
import { sourceForView } from "@/components/code/palette-host";
import { useCursorSituation, useCursorValue, type CursorSituation } from "@/components/code/cursor-position";

type T = (key: string, params?: Record<string, string | number>) => string;

/** The shape of EVERY entry of the bar (the language service in LspStatusLine.tsx too). */
export const STATUS_ENTRY = "flex h-full min-w-0 max-w-[320px] shrink-0 items-center gap-1 truncate px-[5px] outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60";
/** A pressed toggle (problems, debug, zen, terminal open). */
export const STATUS_ON = "bg-hover text-fg";

// A buffer that closes takes its count with it (otherwise a closed file would keep counting); so does one that is renamed. Once per window.
let registered = false;
function registerClose() {
  if (registered || typeof window === "undefined") return;
  registered = true;
  atClose((p) => setDiagnostics(p.key, null));
  atRename((target, old, fresh, newTarget) => relocateDiagnostics((k) => renamedKey(k, target, old, fresh, newTarget)));
}

/** An entry: a button (with `onClick`) or just text. `name`: the name for screen readers where the content is only symbols and numbers. */
export function StatusEntry({ title, name, on, onClick, children, data, className = "" }: {
  title: string;
  name?: string;
  on?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  data?: Record<`data-${string}`, string>;
  className?: string;
}) {
  if (!onClick) return <span title={title} aria-label={name} className={`${STATUS_ENTRY} hover:bg-transparent ${className}`} {...data}>{children}</span>;
  return (
    <button type="button" onClick={onClick} title={title} aria-label={name} aria-pressed={on} className={`${STATUS_ENTRY} ${on ? STATUS_ON : ""} ${className}`} {...data}>
      {children}
    </button>
  );
}

/** The bar: left, gap, right. */
export function StatusBar({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  registerClose();
  return (
    <div className="flex h-[22px] shrink-0 items-stretch border-t border-edge bg-bg px-[5px] text-[12px] leading-none text-dim" data-editor-status-bar>
      {left}
      <span className="min-w-0 flex-1" />
      {right}
    </div>
  );
}

const ErrorCharacter = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><circle cx="8" cy="8" r="6" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></svg>
);
const WarnCharacter = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden><path d="M8 2.2l6.2 11H1.8z" /><path d="M8 6.5v3.2M8 11.4v.4" /></svg>
);

/** Errors and warnings of a view's open files from the store: the counters here and the badge on the PROBLEMS tab of the panel
 *  (components/code/panel/LowerPanel.tsx): ONE calculation. `known`/`files`: how many of the files have a number. */
export function useProblemCount(target: { apiBase: string; instance: string | null }, paths: readonly string[]) {
  const tick = useDiagnosticTick();
  return useMemo(() => {
    const k = coordinatesOf(target);
    const key: string[] = [];
    for (const p of paths) { const o = k.toCanon(p); if (o) key.push(bufferKey(o.target, o.path)); }
    return sumDiagnostics(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, paths.join("\n"), tick]);
}

/** x n / warning m over a view's open files; a click toggles "Problems". If no file has a known number, "–" stands instead of 0
 *  (unknown is not "no problems"); the numbers are in the name for screen readers too. */
export function ProblemCounter({ t, target, paths, on, onClick }: {
  t: T;
  target: { apiBase: string; instance: string | null };
  paths: readonly string[];
  on: boolean;
  onClick: () => void;
}) {
  const z = useProblemCount(target, paths);
  const known = z.known > 0;
  const name = !known ? t("Problems not known yet")
    : z.error || z.warnings ? t("{f} errors, {w} warnings", { f: z.error, w: z.warnings })
    : z.known === z.files ? t("No problems") : t("No known problems");
  const title = t("{what} — show Problems", { what: name });
  return (
    <StatusEntry title={title} name={name} on={on} onClick={onClick} data={{ "data-status-problems": known ? `${z.error}/${z.warnings}` : "?" }} className="gap-[3px]">
      <ErrorCharacter /><span className="tabular-nums">{known ? z.error : "–"}</span>
      <span className="w-1" />
      <WarnCharacter /><span className="tabular-nums">{known ? z.warnings : "–"}</span>
    </StatusEntry>
  );
}

/** "Ln L, Col C" or "N selections (M characters selected)" as in VS Code (lib/editor-status.ts `selectionText`); a click opens
 *  "Go to Line" (the palette with `:`). */
export function CursorEntry({ t, view }: { t: T; view: () => EditorView | null }) {
  // The entry reads the position itself (components/code/cursor-position.ts), so per keystroke only it renders, not CodePane.
  const situation = useCursorSituation(view);
  if (!situation) return null;
  const a = selectionText(situation);
  const text = t(a.key, a.values);
  const toRow = () => {
    const v = view();
    openPalette({ input: ":", source: v ? sourceForView(v) : null });
  };
  return <StatusEntry title={t("Go to Line/Column (⌃G)")} onClick={toRow} data={{ "data-status-cursor": `${situation.row}:${situation.column}` }}>{text}</StatusEntry>;
}

/** Indentation, encoding, line ending and language mode of the active file. The indentation is the one the editor RUNS (guessed on open
 *  and set as facets, components/code/indentation.ts); without a view it is not shown. */
const indentationOf = (l: CursorSituation | null): string => (l ? `${l.indentation.kind}:${l.indentation.width}` : "");
export function FileDetails({ t, path, view, lineEnding, onIndentation }: {
  t: T;
  path: string;
  /** The view whose indentation applies (read here as a base value; renders only when it changes). */
  view: () => EditorView | null;
  lineEnding: string;
  onIndentation: () => void;
}) {
  const one = useCursorValue(view, indentationOf);
  const e: Indentation | null = one ? { kind: one.slice(0, one.indexOf(":")) as Indentation["kind"], width: Number(one.slice(one.indexOf(":") + 1)) } : null;
  const indentation = !e ? null : e.kind === "tab" ? t("Tab Size: {n}", { n: e.width }) : t("Spaces: {n}", { n: e.width });
  return (<>
    {e && indentation && <StatusEntry title={t("Indentation (editor settings)")} onClick={onIndentation} data={{ "data-status-indentation": `${e.kind}:${e.width}` }}>{indentation}</StatusEntry>}
    <StatusEntry title={t("Encoding")} data={{ "data-status-encoding": "" }}>UTF-8</StatusEntry>
    <StatusEntry title={t("End of Line Sequence")} data={{ "data-status-line-ending": lineEndingName(lineEnding) }}>{lineEndingName(lineEnding)}</StatusEntry>
    <StatusEntry title={t("Language Mode")} data={{ "data-status-language": "" }}>{languageName(path)}</StatusEntry>
  </>);
}
