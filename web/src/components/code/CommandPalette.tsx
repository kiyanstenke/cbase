"use client";

// The command palette (editor navigation as in VS Code; Quick Input as in VS Code 1.143): ONE window. Without a prefix files (Cmd+P),
// `>` commands (Shift+Cmd+P, F1), `@` symbols of the file (Shift+Cmd+O, `@:` by category), `#` workspace symbols (Cmd+T), `:` line
// (Ctrl+G), `?` help. Typing switches mode: whoever deletes the `>` searches files again. The chat's former file finder
// (chat/FileFinder.tsx) is the "Files" mode of this window, not a second window; its measuring marks (`data-file-finder-*`) sit on
// input, list and rows here while it is in front.
//
// THE SHAPE IS VS CODE'S (lib/quick-input.ts, globals.css `.cb-quick-input`): at the top of the host's area (its root, below the title
// bar), horizontally centred, `min(window × 0.62, 600)` wide, WITHOUT a scrim: a click elsewhere or Escape closes (document `mousedown`
// and `closest`, no click catcher over the window). Rows 22 px, separator as an edge with the name on the right in the group's first
// row, key caps on the right, hits bold in the hit colour, the chosen row in `quickInputList.focusBackground`; the pointer only colours
// (`list.hoverBackground`), the choice stays. Keys: Down/Up (Ctrl+N/Ctrl+P) cycle, PageDown/Up, Ctrl+Home/End, Cmd+Down/Up to the next
// group, Enter opens, Cmd+Enter/Alt+Enter to the side, Right at the end of the input opens and leaves the palette open (with focus);
// Cmd+P (Shift+Cmd+P) inside Cmd+P moves on (back), and whoever then releases Cmd opens the chosen row (VS Code
// `quickOpenNavigateNextInFilePicker`); another palette command switches the mode and carries the filter along (`switchInput`).
// Progress appears only after 800 ms of work. Escape, a click elsewhere and every mode switch restore the editor that `:`/`@` previewed
// (VS Code `restoreViewState` on cancel); only what was really opened counts as accepted.
//
// There is ONE palette in the window: it hangs on its own React root (created at the body on first open, like the editor menu; the
// portal at the body). It is opened by the command table in the editor (components/code/palette-host.ts), by the keys of a host outside
// the editor (CodePane) and by Cmd+P of the chat (chat/ChatCodeArea.tsx). The modes: components/code/palette-modes.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useT } from "@/lib/i18n";
import { paletteCommandToKey, paletteMode, PREFIX } from "@/lib/commandPalette";
import { moveChoice, movementToKey, helpSwitch, QI_PROGRESS_MS, quickInputSituation, chunks, clipKeys, switchInput } from "@/lib/quick-input";
import type { Hits } from "@/lib/fuzzy-scorer";
import { CODICONS } from "@/lib/codicons";
import { codiconPath } from "@/lib/codicon-symbols";
import { symbolColor, symbolIcon } from "@/lib/symbol-kinds";
import { useResolvedTheme } from "@/lib/theme";
import { isMac } from "@/lib/chat-bar";
import { FileSymbol } from "@/components/code/FileSymbol";
import { rememberView, withoutPreview, reinstate, type ViewStatus } from "@/components/code/palette-preview";
import {
  helpMode, useWorkArea, useSelection, useCommands, useFiles, useSymbols, rowsMode,
  type ModeStatus, type PaletteSelection, type PaletteSource, type PaletteRow, type RowsSymbol,
} from "@/components/code/palette-modes";

type Job = { input: string; markFrom: number | null; source: PaletteSource | null; selection: PaletteSelection | null; atClose: (() => void)[]; prior: HTMLElement | null; seq: number };
let state: Job | null = null;
let seq = 0;
const subscribers = new Set<() => void>();
let root: Root | null = null;
const report = () => { for (const fn of [...subscribers]) fn(); };
const subscription = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };

/** Open the palette: `input` with a prefix (`>`, `@`, `#`, `:`, `?` or none), or a `selection` (interpreter). `markFrom`: the input marked
 *  from this position (Cmd+T with the word at the cursor, VS Code `valueSelection`). If already open it starts over (the close
 *  callbacks stay; focus finally returns to where it was before the FIRST open). */
export function openPalette(a: { input?: string; markFrom?: number; source?: PaletteSource | null; selection?: PaletteSelection | null; atClose?: () => void }): void {
  if (typeof document === "undefined") return;
  if (!root) {
    const host = document.createElement("div");
    host.setAttribute("data-command-palette-root", "");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<PaletteWrapper />);
  }
  const old = state;
  state = {
    input: a.input ?? "",
    markFrom: typeof a.markFrom === "number" ? a.markFrom : null,
    source: a.source !== undefined ? a.source : old?.source ?? null,
    selection: a.selection ?? null,
    atClose: [...(old?.atClose ?? []), ...(a.atClose ? [a.atClose] : [])],
    prior: old?.prior ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null),
    seq: ++seq,
  };
  report();
}
/** Close: focus returns to where it was before opening (a command that sets focus itself does so afterwards). */
export function closePalette(): void {
  const a = state;
  if (!a) return;
  state = null;
  report();
  for (const fn of a.atClose) { try { fn(); } catch { /* the next callback runs anyway */ } }
  if (a.prior?.isConnected) a.prior.focus({ preventScroll: true });
}
export const paletteOpen = (): boolean => state !== null;

function PaletteWrapper() {
  const a = useSyncExternalStore(subscription, () => state, () => null);
  return a ? <PaletteWindow key={a.seq} job={a} /> : null;
}

/** The area the window stands over: the host's root, otherwise that of the last focused element, otherwise below the header. */
function anchorOf(a: Job): { top: number; left: number; width: number } | null {
  const el = (a.source?.anchor?.isConnected ? a.source.anchor : null) ?? a.prior?.closest<HTMLElement>("[data-quick-input-anchor]") ?? null;
  if (el) { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width }; }
  const header = document.querySelector("header.cb-frame");
  return header ? { top: header.getBoundingClientRect().bottom, left: 0, width: window.innerWidth } : null;
}

function Highlighted({ text, hits }: { text: string; hits?: Hits[] }) {
  if (!hits?.length) return <>{text}</>;
  return <>{chunks(text, hits).map((s, i) => (s.on ? <span key={i} className="cb-qi-hits">{s.text}</span> : <span key={i}>{s.text}</span>))}</>;
}

function Character({ symbol, dark }: { symbol: RowsSymbol; dark: boolean }) {
  if (symbol.kind === "file") return <span className="cb-qi-symbol" aria-hidden><FileSymbol path={symbol.path} /></span>;
  const name = symbolIcon(symbol.symbolKind), color = symbolColor(symbol.symbolKind, dark);
  return (
    <span className="cb-qi-symbol" data-codicon={name} style={color ? { color: color } : undefined} aria-hidden>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d={codiconPath(name) ?? ""} /></svg>
    </span>
  );
}

function Clip({ shortcut }: { shortcut: string }) {
  return (
    <span className="cb-qi-keys" aria-hidden data-qi-keys={shortcut}>
      {clipKeys(shortcut).map((chord, i) => (
        <span key={i} className="cb-qi-chord">{chord.map((k, j) => <kbd key={j} className="cb-qi-key">{k}</kbd>)}</span>
      ))}
    </span>
  );
}

const CLOSE = CODICONS.close;
function ButtonCharacter({ icon }: { icon: "page" | "remove" }) {
  if (icon === "page") {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 2.5v11" /></svg>;
  }
  return <svg width="16" height="16" viewBox={CLOSE.box} fill="currentColor" aria-hidden>{CLOSE.paths.map((p, i) => <path key={i} d={p.d} />)}</svg>;
}

function PaletteWindow({ job }: { job: Job }) {
  const t = useT();
  const dark = useResolvedTheme() === "dark";
  const [inputText, setInput] = useState(job.input);
  const [choice, setChoice] = useState(0);
  const [freeText, setFreeText] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [progress, setProgress] = useState(false);
  // Position right on first paint (the own root lives only in the browser); otherwise no input would exist yet at the focus effect.
  const [situation, setSituation] = useState(() => quickInputSituation({ width: window.innerWidth, height: window.innerHeight }, anchorOf(job)));
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const accepted = useRef(false);
  const fast = useRef(false); // Cmd+P inside Cmd+P: whoever releases Cmd opens (VS Code `quickNavigate`)
  const startUsed = useRef(false);
  const { source, selection } = job;
  const { mode, rest } = selection ? { mode: "selection" as const, rest: inputText } : paletteMode(inputText);
  const afterResponse = useCallback(() => setChoice((w) => w), []);
  const toFreeText = useCallback(() => { setFreeText(true); setInput(""); setChoice(0); }, []);
  const changeOver = useCallback((prefix: string) => { setInput(prefix); setChoice(0); inputRef.current?.focus(); }, []);
  const files = useFiles(mode === "files", rest, choice, source, closeAccepted, afterResponse);
  const commands = useCommands(mode === "commands", rest, source);
  const symbols = useSymbols(mode === "symbols", rest, source);
  const work = useWorkArea(mode === "workArea", rest, source);
  const selected = useSelection(selection, rest, freeText, toFreeText);
  const s: ModeStatus = mode === "files" ? files.state : mode === "commands" ? commands : mode === "symbols" ? symbols
    : mode === "workArea" ? work : mode === "row" ? rowsMode(true, rest, source) : mode === "help" ? helpMode(true, changeOver) : selected;
  const n = s.rows.length;
  const w = Math.min(choice, Math.max(0, n - 1));
  const active = s.rows[w];
  const groups = s.rows.flatMap((z, i) => (z.group && i > 0 ? [i] : i === 0 ? [0] : []));

  // The editor's state before the preview: Escape restores it, an acceptance leaves the jump standing.
  const viewStatus = useRef<ViewStatus | null>(null);
  if (viewStatus.current === null) viewStatus.current = rememberView(source?.view ?? null);
  useEffect(() => () => {
    if (accepted.current) withoutPreview(viewStatus.current?.view);
    else reinstate(viewStatus.current);
  }, []);
  // A mode switch cancels the old one (VS Code: a new picker, the old provider restores the editor), BEFORE the new mode's preview
  // (the effects run in this order).
  const previousMode = useRef(mode);
  useEffect(() => {
    const before = previousMode.current;
    previousMode.current = mode;
    if (before !== mode && (before === "row" || before === "symbols")) reinstate(viewStatus.current);
  }, [mode]);
  // The preview follows the chosen row (and its content: with Ctrl+G the input changes the target, not the row).
  useEffect(() => {
    if (active?.preview && !s.stale) active.preview();
    else withoutPreview(source?.view);
  }, [active?.key, active?.label, mode, s.stale]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setChoice(0); setRunError(""); startUsed.current = false; }, [inputText]);
  // `?` + a known prefix switches there (VS Code `HelpQuickAccessProvider`: the input becomes the prefix).
  useEffect(() => {
    if (selection || mode !== "help") return;
    const h = helpSwitch(rest);
    if (h !== null) setInput(h);
  }, [inputText]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s.start !== undefined && !startUsed.current) { startUsed.current = true; setChoice(s.start); } }, [s.start]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [w, mode]);

  // Position: at the top of the area, centred; recomputed on every window resize.
  useLayoutEffect(() => {
    const compute = () => setSituation(quickInputSituation({ width: window.innerWidth, height: window.innerHeight }, anchorOf(job)));
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [job]);
  // The marking after a switch by key (the filter behind the new prefix).
  const mark = useRef<number | null>(null);
  useLayoutEffect(() => {
    const start = mark.current, el = inputRef.current;
    mark.current = null;
    if (start !== null && el) el.setSelectionRange(Math.min(start, el.value.length), el.value.length);
  }, [inputText]);
  // Progress only after 800 ms of work (VS Code `busyDelay`); when the work ends it vanishes at once.
  const busy = Boolean(s.loading || s.stale || running);
  useEffect(() => {
    if (!busy) { setProgress(false); return; }
    const h = setTimeout(() => setProgress(true), QI_PROGRESS_MS);
    return () => clearTimeout(h);
  }, [busy]);
  // The marking of the input on open (Cmd+T: the word at the cursor).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (job.markFrom !== null) el.setSelectionRange(Math.min(job.markFrom, el.value.length), el.value.length);
  }, [job]);
  // A click elsewhere closes (VS Code: the window loses focus); document `mousedown`, no click catcher.
  useEffect(() => {
    const onOutside = (e: MouseEvent) => { if (!(e.target instanceof Node) || !windowRef.current?.contains(e.target)) closePalette(); };
    document.addEventListener("mousedown", onOutside, true);
    return () => document.removeEventListener("mousedown", onOutside, true);
  }, []);
  // Cmd released after Cmd+P inside Cmd+P: open the chosen row.
  const acceptRef = useRef<() => void>(() => {});
  useEffect(() => {
    const release = (e: KeyboardEvent) => { if (fast.current && (e.key === "Meta" || (!isMac() && e.key === "Control"))) { fast.current = false; acceptRef.current(); } };
    document.addEventListener("keyup", release, true);
    return () => document.removeEventListener("keyup", release, true);
  }, []);

  function closeAccepted() { accepted.current = true; closePalette(); }
  const run = async (z: PaletteRow | undefined, like: "normal" | "beside" | "background" = "normal") => {
    if (!z || running || s.stale || z.kind === "text") return;
    if (z.kind === "inside") { z.execute(); return; }
    if (like === "background") {
      // VS Code `acceptInBackground`: the file opens (`preserveFocus`), the palette stays open and keeps focus.
      if (z.inBackground) z.inBackground();
      return;
    }
    if (z.kind === "wait") {
      setRunning(true); setRunError("");
      try { await z.execute(); closeAccepted(); } catch (e) { setRunError(String((e as Error)?.message ?? e)); setRunning(false); }
      return;
    }
    const action = like === "beside" && z.beside ? z.beside : z.execute;
    closeAccepted();
    try { await action(); } catch (e) { console.warn("[palette]", e); }
  };
  // Accepted is only what was opened (`closeAccepted`); an Enter still waiting for the answer is not yet.
  const enter = () => { if (s.enter) s.enter(); else if (!s.stale) void run(active); };
  acceptRef.current = enter;

  const page = () => Math.max(1, Math.floor((listRef.current?.clientHeight || (situation?.listMax ?? 440)) / 22) - 1);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mac = isMac();
    const b = movementToKey(e, mac);
    if (b) { e.preventDefault(); setChoice(moveChoice(w, n, b, page(), groups)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if ((e.metaKey || e.altKey || e.ctrlKey) && active?.beside) void run(active, "beside");
      else enter();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (e.key === "ArrowRight" && !e.shiftKey && active?.inBackground) {
      const el = e.currentTarget;
      if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) { e.preventDefault(); void run(active, "background"); return; }
    }
    if (e.key === "Backspace" && freeText && !inputText) { e.preventDefault(); setFreeText(false); return; }
    const pb = paletteCommandToKey(e, mac);
    if (!pb) return;
    e.preventDefault();
    e.stopPropagation();
    // Inside Cmd+P, Cmd+P and Shift+Cmd+P move through the list (VS Code `quickOpenNavigateNext/PreviousInFilePicker`); every other palette command switches the mode.
    if (mode === "files" && !selection && e.key !== "F1" && (pb.id === "workbench.action.quickOpen" || pb.id === "workbench.action.showCommands")) {
      setChoice(moveChoice(w, n, pb.id === "workbench.action.quickOpen" ? "next" : "previous", 1));
      fast.current = true;
      return;
    }
    files.forgetEnter();
    // A selection (interpreter) is not a palette provider: the command opens it anew (VS Code: Quick Access replaces the picker).
    if (selection) { openPalette({ input: pb.prefix, source: job.source }); return; }
    // Another provider carries the filter along, the same one keeps the input; the filter is marked (VS Code `doShowOrPick`).
    const fresh = switchInput(inputText, PREFIX[paletteMode(inputText).mode], pb.prefix);
    mark.current = fresh.markFrom;
    if (fresh.input === inputText) inputRef.current?.setSelectionRange(fresh.markFrom, inputText.length);
    else setInput(fresh.input);
  };

  const fileMode = mode === "files";
  const placeholder = selection ? (freeText && selection.freeText ? selection.freeText.placeholder : selection.title)
    : t("Search files by name (append : to go to line or @ to go to symbol), or paste a link");
  const error = runError || s.error;
  const title = selection ? selection.title : t("Command Palette");
  return (
    <div
      ref={windowRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="cb-quick-input"
      style={{ top: situation.top, left: situation.left, width: situation.width }}
      data-command-palette={mode}
      {...(fileMode ? { "data-file-finder": "" } : {})}
    >
      <div className="cb-qi-header">
        <input
          ref={inputRef}
          value={inputText}
          onChange={(e) => { files.forgetEnter(); setInput(e.target.value); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={title}
          aria-busy={running || undefined}
          role="combobox"
          aria-expanded="true"
          aria-controls="cb-qi-list"
          aria-activedescendant={active ? `cb-qi-row-${w}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="cb-qi-input"
          data-command-palette-input
          {...(fileMode ? { "data-file-finder-input": "" } : {})}
        />
      </div>
      <div className="cb-qi-progress" {...(progress ? { "data-running": "" } : {})} aria-hidden />
      {(n > 0 || error || s.footnote) && (
        <div
          ref={listRef}
          id="cb-qi-list"
          role="listbox"
          aria-busy={s.stale || running}
          className="cb-qi-list cb-scroll"
          style={{ maxHeight: situation.listMax }}
          data-command-palette-list
          {...(fileMode ? { "data-file-finder-list": "", ...(s.stale ? { "data-file-finder-stale": "1" } : {}) } : {})}
        >
          {s.rows.map((z, i) => (
            <div
              key={z.key}
              id={`cb-qi-row-${i}`}
              role="option"
              aria-selected={i === w}
              aria-disabled={s.stale || z.kind === "text" || undefined}
              title={z.detail ? `${z.label} ${z.detail}` : z.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { setChoice(i); void run(z, e.metaKey || e.altKey || e.ctrlKey ? "beside" : "normal"); }}
              // VS Code's row (quickInputList): 22 px, separator as an edge above; the list's first row carries none.
              className="cb-qi-row"
              style={s.stale ? { opacity: 0.6 } : undefined}
              {...(z.group && i > 0 ? { "data-group-edge": "" } : {})}
              {...(z.data ?? {})}
            >
              {z.symbol && <Character symbol={z.symbol} dark={dark} />}
              <span className="cb-qi-name"><Highlighted text={z.label} hits={z.labelHits} /></span>
              {z.detail && <span className="cb-qi-description"><Highlighted text={z.detail} hits={z.detailHits} /></span>}
              <span className="cb-qi-right">
                {z.shortcut && <Clip shortcut={z.shortcut} />}
                {z.group && <span className="cb-qi-group" data-qi-group={z.group}>{z.group}</span>}
                {z.buttons && z.buttons.length > 0 && (
                  <span className="cb-qi-buttons">
                    {z.buttons.map((k) => (
                      <button
                        key={k.icon}
                        type="button"
                        tabIndex={-1}
                        className="cb-qi-button"
                        title={k.title}
                        aria-label={k.title}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); if (k.icon === "page") accepted.current = true; k.action(); }}
                        data-qi-button={k.icon}
                      >
                        <ButtonCharacter icon={k.icon} />
                      </button>
                    ))}
                  </span>
                )}
                {z.selected !== undefined && (
                  <span aria-hidden data-palette-check-mark={z.selected ? "1" : "0"} className={`ml-1 grid h-3.5 w-3.5 place-items-center ${z.selected ? "" : "invisible"}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                )}
              </span>
            </div>
          ))}
          {/* The cap says that it is one (cbase rule; VS Code does not name it): the last, unselectable row. */}
          {s.footnote && <div className="cb-qi-row cb-qi-description" style={{ cursor: "default", marginLeft: 0 }} aria-hidden {...(fileMode ? { "data-file-finder-truncated": "" } : {})}>{s.footnote}</div>}
          {error && <div className="cb-qi-error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
