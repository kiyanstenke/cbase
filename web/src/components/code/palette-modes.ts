// The command palette's modes (quick input like VS Code) — per mode a hook that computes the rows from input and host; the window
// (components/code/CommandPalette.tsx) shows them, chooses with quick input's keys and runs with Enter. The pure computations (prefix, keys,
// scoring, separators, `:12:4`, symbol rows) live in lib/commandPalette.ts, lib/quick-input.ts and lib/fuzzy-scorer.ts.
//
//   Files (no prefix, ⌘P)       without input the history ("recently opened", components/code/palette-history.ts — plus open tabs it does
//                               not know yet); with input the matching history entries and below them "file results" from
//                               `POST …/files/find` (the server searches the search's scope and sorts like Quick Open). Hits count only for
//                               the input they were fetched for (lib/chat-tabs.ts `finderSituation`), Enter during a search WAITS for
//                               them. `file:12:4` opens at the position (`file:` at line 1), `file@symbol` shows the symbols of the
//                               chosen file, a pasted link (`https://…`) opens it (VS Code `_getLinkPick`).
//   Commands (`>`, ⇧⌘P, F1)     the command table (lib/editor-commands.ts — everything from the menu, only what applies here) plus the
//                               host's toggles; "recently used" first, then "other commands", the key caps on the right.
//   Symbols (`@`, ⇧⌘O)          `outline` of the file (until the answer that of the view, lsp-layout.ts), "symbols (n)" or `@:` by
//                               category; the chosen row shows the symbol in the editor (palette-preview.ts), Escape restores.
//   Workspace (`#`, ⌘T)         `workspace_symbols` of the running language servers in the host's target, "container • path" dimmed.
//   Line (`:`, ⌃G)              VS Code's computation (lib/quick-input.ts `rowsTarget`), with preview.
//   Help (`?`)                  the prefixes; a typed prefix switches there.
//   Choice                      a list a command brings along (interpreter), with free text ("Enter path …").
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import { api, isNotSupported, lspAreaOf, lspOffsetOf, lspCalls, type FileFindResponse, type LspLocation, type LspRange, type LspSymbol, type LspTarget } from "@/lib/api";
import { instancePath } from "@/lib/code-instance";
import { baseName, finderSituation } from "@/lib/chat-tabs";
import { subscribeCommands, allCommands, commandVisible, type EditorCommand } from "@/lib/editor-commands";
import { PALETTE_COMMANDS } from "@/lib/commandPalette";
import { wordFilter, type Hits } from "@/lib/fuzzy-scorer";
import {
  workRows, commandRows, fileInput, fileRows, flatSymbols, helpRows, linkTarget, symbolAtLocation, symbolRequest, symbolRows, rowsTarget,
  type FlatSymbol, type Notice,
} from "@/lib/quick-input";
import { tr } from "@/lib/i18n";
import { questions, situationOf, lspFileOf, type EditorContext } from "@/components/code/lsp-core";
import { locationOf } from "@/components/code/lsp-nav-core";
import { carryOutCommand } from "@/components/code/lsp-commands";
import { layoutOf, jumpTo } from "@/components/code/lsp-layout";
import { withoutPreview, showPreview } from "@/components/code/palette-preview";
import { subscribeHistory, commandHistory, fileHistory, rememberCommand, forgetFile, historyStatus } from "@/components/code/palette-history";

/** A command the host brings along (not an editor command of the table). */
export type PaletteCommand = { id: string; title: string; shortcut?: string; execute: () => void };
/** Where the palette works: the target of files and workspace symbols, the view for commands, `@` and `:`, opening a file. */
export type PaletteSource = {
  target: LspTarget | null;
  targetName: string;
  open: readonly string[];
  view: EditorView | null;
  /** `focus: false` (VS Code `preserveFocus`, → at the end of the input): open and jump, focus stays in the palette. */
  openFile: ((path: string, row?: number, column?: number, o?: { focus?: boolean }) => void) | null;
  /** Open to the side (⌘↵, the row's button) — into the group on the right (lib/editor-groups.ts); if missing, ⌘↵ opens like Enter. */
  openFileBeside?: ((path: string, row?: number, column?: number) => void) | null;
  /** The area the window stands over (top, horizontally centred) — the host's root. */
  anchor?: HTMLElement | null;
  commands?: readonly PaletteCommand[];
};
/** A character on the left of the row. */
export type RowsSymbol = { kind: "file"; path: string } | { kind: "symbol"; symbolKind: number | string };
export type RowsButton = { icon: "page" | "remove"; title: string; action: () => void };
export type PaletteRow = {
  key: string;
  label: string;
  labelHits?: Hits[];
  /** The description behind the name (dimmed, VS Code `description`). */
  detail?: string;
  detailHits?: Hits[];
  /** The shortcut as key caps on the right. */
  shortcut?: string;
  /** The separator above this row (VS Code `separator`): edge on top, name on the right in the row. */
  group?: string;
  symbol?: RowsSymbol;
  /** An entry of a choice: the chosen one carries the tick. */
  selected?: boolean;
  data?: Record<string, string>;
  /** "close" (default): the palette closes, then the action runs. "wait": it stays open until the action succeeded — an
   *  error stays in it. "inside": the action stays in the palette (free text, help). "text": a row that only says something (VS Code
   *  `noResultsPick` and the message of ⌃G) — Enter does nothing. */
  kind?: "close" | "wait" | "inside" | "text";
  execute: () => unknown;
  /** ⌘↵/⌥↵ and the "Open to the Side" button. */
  beside?: () => unknown;
  /** → at the end of the input (VS Code `acceptInBackground`): open, the palette stays open. */
  inBackground?: () => unknown;
  buttons?: RowsButton[];
  /** The preview in the editor while the row is chosen. */
  preview?: () => void;
};
export type ModeStatus = {
  rows: PaletteRow[];
  error?: string;
  /** The rows belong to an older input — dimmed, not selectable. */
  stale?: boolean;
  /** Searching (the progress under the input, VS Code `busy`). */
  loading?: boolean;
  /** The cap says that it is one (the last row of the list). */
  footnote?: string;
  /** The row chosen on opening (VS Code `activeItems`). */
  start?: number;
  /** Enter, if the mode decides itself (files: wait for the fresh answer). */
  enter?: () => void;
};
/** A list a command brings along (interpreter): loading, rows, a free text. */
export type PaletteSelection = {
  title: string;
  load: () => Promise<PaletteRow[]>;
  freeText?: { label: string; placeholder: string; take: (text: string) => Promise<unknown> };
};

const EMPTY: ModeStatus = { rows: [] };
const notice = (e: unknown) => String((e as Error)?.message ?? e);
const folderOf = (p: string) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; };
const text = (m: Notice) => tr(m.text, m.values);
/** A row that only says something (VS Code `noResultsPick`). */
export const textRow = (label: string, data?: Record<string, string>): PaletteRow => ({ key: `text:${label}`, label, kind: "text", execute: () => {}, ...(data ? { data } : {}) });
/** A tick that counts on with every change of the history (the rows recompute). */
const useHistoryTick = (): number => useSyncExternalStore(subscribeHistory, historyStatus, () => 0);

// ── Symbols of a file (for `@` and `file@symbol`) ──────────────────────────────────────────────────────────────────────────────────
/** The symbol rows: character by kind, container dimmed, separator "symbols (n)" or per category. `jump(s)` opens/jumps,
 *  `preview(s)` shows it in the editor. */
function symbolPaletteRows(flat: readonly FlatSymbol[], rest: string, h: { jump: (s: FlatSymbol) => void; beside?: (s: FlatSymbol) => void; preview?: (s: FlatSymbol) => void }) {
  const rows = symbolRows(flat, rest, text);
  return rows.map((z): PaletteRow => ({
    key: `${z.s.index}:${z.s.name}`, label: z.s.name, labelHits: z.hits, detail: z.s.container || undefined, detailHits: z.containerHits,
    symbol: { kind: "symbol", symbolKind: z.s.kind }, ...(z.group ? { group: text(z.group) } : {}), data: { "data-palette-symbol": z.s.name },
    execute: () => h.jump(z.s), ...(h.beside ? { beside: () => h.beside?.(z.s) } : {}),
    ...(h.preview ? { preview: () => h.preview?.(z.s) } : {}),
  }));
}
const NO_SYMBOLS = "No editor symbols";
const NO_MATCHING_SYMBOLS = "No matching editor symbols";

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function useFiles(active: boolean, input: string, choice: number, source: PaletteSource | null, close: () => void, afterResponse: () => void) {
  const tick = useHistoryTick();
  // `file@symbol` (VS Code `getEditorSymbolPicks`): the file is the one chosen BEFORE the input came (`lastGlobalPicks.active`) —
  // remembered as long as the input does not mean symbols (below).
  const lastFile = useRef<string | null>(null);
  const e = fileInput(active ? input : "", lastFile.current);
  // A pasted link goes before everything (VS Code `_getPicks`: `_getLinkPick` before `extractRangeFromFilter`).
  const link = active ? linkTarget(input.trim()) : null;
  const query = link ? "" : e.filter;
  const [response, setResponse] = useState<{ q: string; r: FileFindResponse } | null>(null);
  const [error, setError] = useState("");
  const enterWaiting = useRef<string | null>(null); // Enter came before the answer for THIS input arrived
  const target = source?.target ?? null;
  const symbolFile = !link && e.symbol !== null ? lastFile.current : null;
  const open = (p: string, z = e.row, s = e.column) => { close(); source?.openFile?.(p, z ?? undefined, s ?? undefined); };
  const later = useRef({ open, afterResponse, history: [] as string[] });
  const history = useMemo(() => {
    const v = fileHistory(target);
    return [...v, ...(source?.open ?? []).filter((p) => !v.includes(p) && !p.startsWith("/"))];
  }, [target?.apiBase, target?.instance, source?.open, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  later.current = { open, afterResponse, history };
  useEffect(() => {
    const q = active && symbolFile === null ? query.trim() : "";
    if (!q || !target) { setResponse(null); setError(""); return; }
    let alive = true;
    const h = setTimeout(() => {
      api<FileFindResponse>(instancePath(`${target.apiBase}/files/find`, target.instance), { method: "POST", body: JSON.stringify({ query: q }) })
        .then((r) => {
          if (!alive) return;
          setResponse({ q, r }); setError(""); later.current.afterResponse();
          if (enterWaiting.current === q) { enterWaiting.current = null; const first = fileRows(q, later.current.history, r.results)[0]; if (first) later.current.open(first.path); }
        })
        .catch((x) => { if (alive) setError(notice(x)); });
    }, 120);
    return () => { alive = false; clearTimeout(h); };
  }, [active, query, symbolFile, target?.apiBase, target?.instance]); // eslint-disable-line react-hooks/exhaustive-deps
  const symbols = useFileSymbols(active && symbolFile !== null, target, symbolFile);
  const openHere = active ? history : [];
  const queue = useMemo(() => fileRows(response?.q ?? "", history, response?.r.results ?? null), [response, history]);
  const emptyQueue = useMemo(() => fileRows("", openHere, null), [openHere]);
  const situation = finderSituation(query, response ? { q: response.q, results: queue.map((z) => z.path) } : null, openHere, choice);
  const q = query.trim();
  const rowsData = q ? queue : emptyQueue;
  const rows = situation.rows.map((p, i): PaletteRow => {
    const z = rowsData[i]?.path === p ? rowsData[i] : { path: p, history: false, hits: {} };
    const beside = source?.openFileBeside ? () => { close(); source.openFileBeside?.(p, e.row ?? undefined, e.column ?? undefined); } : undefined;
    return {
      key: p, label: baseName(p), labelHits: z.hits.label, detail: folderOf(p) || undefined, detailHits: z.hits.description,
      symbol: { kind: "file", path: p }, ...(z.group ? { group: tr(z.group) } : {}), data: { "data-file-finder-row": p },
      execute: () => source?.openFile?.(p, e.row ?? undefined, e.column ?? undefined),
      ...(beside ? { beside } : {}),
      // VS Code `acceptInBackground` (`preserveFocus: true`): open and jump, the palette stays open AND keeps focus.
      inBackground: () => source?.openFile?.(p, e.row ?? undefined, e.column ?? undefined, { focus: false }),
      buttons: [
        ...(beside ? [{ icon: "page" as const, title: tr("Open to the Side"), action: beside }] : []),
        ...(z.history && fileHistory(target).includes(p) ? [{ icon: "remove" as const, title: tr("Remove from Recently Opened"), action: () => forgetFile(target, p) }] : []),
      ],
    };
  });
  // The file for `file@symbol`: the chosen row while the input does not mean symbols — without hits and with an `@` in the filter
  // the old one stays (VS Code: `NO_RESULTS_PICK` with "@" does not replace `lastGlobalPicks`).
  if (active && !link && e.symbol === null) {
    const selected = situation.rows[Math.min(choice, situation.rows.length - 1)] ?? null;
    if (selected !== null || !e.filter.includes("@")) lastFile.current = selected;
  }
  const status: ModeStatus = !active ? EMPTY : !target || !source?.openFile ? { rows: [textRow(tr("There are no files to search here."))] }
    : link ? { rows: [linkRow(link)] }
    : symbolFile !== null ? symbols.status(e.symbol ?? "", (s) => open(symbolFile, s.selection.start.line + 1, s.selection.start.character + 1),
      source.openFileBeside ? (s) => { close(); source.openFileBeside?.(symbolFile, s.selection.start.line + 1, s.selection.start.character + 1); } : undefined) : {
      rows: q && response?.q === q && rows.length === 0 ? [textRow(tr("No matching results"), { "data-command-palette-hint": "" })] : rows,
      error: error || undefined,
      stale: situation.stale,
      loading: Boolean(q) && response?.q !== q && !error,
      // The cap says that it is one — a list that silently truncates would look complete. Two caps, two sentences (files.js
      // `quickOpenFiles`): the walk stopped at its safety cap, or there were more hits than the list shows.
      footnote: !q || response?.q !== q ? undefined
        : response.r.aborted ? tr("The search stopped after {n} files — exclude large folders via .gitignore or .ignore.", { n: (response.r.searched ?? 0).toLocaleString() })
          : response.r.truncated && response.r.results.length ? tr("The first {n} matches — search more precisely to see more.", { n: response.r.results.length }) : undefined,
      enter: () => {
        if (situation.enter?.kind === "open") open(situation.enter.path);
        else if (situation.enter?.kind === "wait") enterWaiting.current = query.trim();
      },
    };
  return { state: status, forgetEnter: () => { enterWaiting.current = null; } };
}

/** The row of a pasted link (VS Code `_getLinkPick`): "Open Link" with the address, Enter opens it in a new browser tab;
 *  an invalid link says so. (Open to the side does not exist for a link in cbase — no browser as an editor.) */
function linkRow(link: NonNullable<ReturnType<typeof linkTarget>>): PaletteRow {
  if (!link.valid) return { ...textRow(tr("Invalid Link"), { "data-palette-link": "" }), detail: tr("Enter a valid link to open it from Quick Open.") };
  return {
    key: `link:${link.url}`, label: tr("Open Link"), detail: link.url, kind: "wait", data: { "data-palette-link": link.url },
    execute: () => {
      const w = window.open(link.url, "_blank");
      if (!w) throw new Error(tr("The link could not be opened. It may be unsupported or opening it was canceled."));
      w.opener = null;
    },
  };
}

/** The outline of a file that need NOT be open in the editor (`file@symbol`): `outline` without a buffer reads the disk (lsp/actions.js). */
function useFileSymbols(active: boolean, target: LspTarget | null, file: string | null) {
  const [status, setStatus] = useState<{ file: string; symbols?: LspSymbol[]; not?: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (!active || !target || !file) return;
    let alive = true;
    setStatus(null);
    lspCalls(target, "outline", { file: file })
      .then((r) => { if (alive) setStatus(isNotSupported(r) ? { file, not: true } : { file, symbols: Array.isArray(r.symbols) ? r.symbols : [] }); })
      .catch((x) => { if (alive) setStatus({ file, error: notice(x) }); });
    return () => { alive = false; };
  }, [active, target?.apiBase, target?.instance, file]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    status: (rest: string, jump: (s: FlatSymbol) => void, beside?: (s: FlatSymbol) => void): ModeStatus => {
      if (!status || status.file !== file) return { rows: [], loading: true };
      if (status.error) return { rows: [], error: status.error };
      if (status.not) return { rows: [textRow(tr(NO_SYMBOLS))] };
      const flat = flatSymbols(status.symbols);
      const rows = symbolPaletteRows(flat, rest, { jump, beside });
      return { rows: rows.length ? rows : [textRow(tr(flat.length ? NO_MATCHING_SYMBOLS : NO_SYMBOLS))] };
    },
  };
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type CommandRaw = { id: string; label: string; shortcut?: string; execute: () => void };
export function useCommands(active: boolean, rest: string, source: PaletteSource | null): ModeStatus {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeCommands(() => setTick((x) => x + 1)), []);
  const vt = useHistoryTick();
  return useMemo(() => {
    if (!active) return EMPTY;
    const view = source?.view ?? null;
    const list: CommandRaw[] = [];
    if (view) {
      const situation = situationOf(view), k: EditorContext = { view: view, file: lspFileOf(view.state) };
      for (const b of allCommands() as EditorCommand<EditorContext>[]) {
        if (b.submenu || !b.execute || !commandVisible(b, situation, k)) continue;
        list.push({ id: b.id, label: tr(b.title), shortcut: b.shortcut, execute: () => { view.focus(); carryOutCommand(view, b.id); } });
      }
    }
    for (const b of source?.commands ?? []) list.push({ id: b.id, label: tr(b.title), shortcut: b.shortcut, execute: b.execute });
    const history = commandHistory();
    const rows = commandRows(list, rest, history).map((z): PaletteRow => ({
      key: z.e.id, label: z.e.label, labelHits: z.hits, shortcut: z.e.shortcut, ...(z.duplicate ? { detail: z.e.id } : {}),
      ...(z.group ? { group: tr(z.group) } : {}), data: { "data-palette-command": z.e.id },
      execute: () => { rememberCommand(z.e.id); z.e.execute(); },
    }));
    return { rows: rows.length ? rows : [textRow(tr("No matching commands"), { "data-command-palette-hint": "" })] };
  }, [active, rest, source, tick, vt]);
}

// ── Symbols of the file ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const posOf = (v: EditorView) => { const k = v.state.selection.main.head, l = v.state.doc.lineAt(k); return { line: l.number - 1, character: k - l.from }; };
const previewArea = (v: EditorView, r: LspRange, sel: LspRange) => {
  const b = lspAreaOf(v.state.doc, r);
  showPreview(v, b.from, b.to, lspOffsetOf(v.state.doc, sel.start));
};
export function useSymbols(active: boolean, rest: string, source: PaletteSource | null): ModeStatus {
  const view = source?.view ?? null;
  const file = view ? lspFileOf(view.state) : null;
  const [status, setStatus] = useState<{ symbols?: LspSymbol[]; not?: boolean; error?: string; fresh?: boolean } | null>(null);
  useEffect(() => {
    if (!active || !view || !file) return;
    const prior = layoutOf(view.state);
    setStatus(prior ? { symbols: prior } : null);
    let alive = true;
    questions(file, "outline")
      .then((r) => { if (alive) setStatus(isNotSupported(r) ? { not: true } : { symbols: Array.isArray(r.symbols) ? r.symbols : [], fresh: true }); })
      .catch((e) => { if (alive) setStatus((s) => (s?.symbols ? { ...s, fresh: true } : { error: notice(e) })); });
    return () => { alive = false; };
  }, [active, view, file?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps
  // The choice on opening: the innermost symbol at the cursor (VS Code: only without a filter, only on first fill).
  const cursor = useMemo(() => (active && view ? posOf(view) : null), [active, view]);
  return useMemo(() => {
    if (!active) return EMPTY;
    if (!view) return { rows: [textRow(tr("To go to a symbol, first open a text editor with symbol information."))] };
    if (!file || status?.not) return { rows: [textRow(tr("The active text editor does not provide symbol information."))] };
    if (!status) return { rows: [], loading: true };
    if (status.error) return { rows: [], error: status.error };
    const flat = flatSymbols(status.symbols);
    // Open to the side speaks the host's coordinates: the buffer is canonical (project, project-relative), the workspace-level editor has its
    // own — the path comes from the view's connection (`locationOf`), an external target does not open beside.
    const here = locationOf(view);
    const pathHere = here && !here.extern ? here.path : null;
    const rows = symbolPaletteRows(flat, rest, {
      jump: (s) => { withoutPreview(view); jumpTo(view, s.selection); },
      ...(source?.openFileBeside && pathHere ? { beside: (s: FlatSymbol) => { withoutPreview(view); source.openFileBeside?.(pathHere, s.selection.start.line + 1, s.selection.start.character + 1); } } : {}),
      preview: (s) => previewArea(view, s.range, s.selection),
    });
    if (!rows.length) return { rows: [textRow(tr(flat.length ? NO_MATCHING_SYMBOLS : NO_SYMBOLS))], loading: !status.fresh };
    const empty = !rest.trim() || rest.trim() === ":";
    const start = empty && cursor ? symbolAtLocation(symbolRows(flat, rest, text), cursor) : -1;
    return { rows, loading: !status.fresh, ...(start >= 0 ? { start } : {}) };
  }, [active, view, file, status, rest, cursor, source]);
}

// ── Symbols in the workspace ───────────────────────────────────────────────────────────────────────────────────────────────────────
type WsSymbol = { name: string; kind: number | string; container?: string; location: LspLocation };
export function useWorkArea(active: boolean, rest: string, source: PaletteSource | null): ModeStatus {
  const view = source?.view ?? null;
  // With a file in the view its BUFFER asks — canonical (lib/buffer-coordinates.ts): a file of a project thus asks the project level, and
  // the hits open the file itself (`open`, converted into the editor's coordinates). At workspace level a request without a file belongs to no
  // project (lsp/actions.js: empty) — there the file goes along (devtools/code-route.js `lspTargetFor`); at project level the contract stays
  // (without `file`).
  const lspFile = view ? lspFileOf(view.state) : null;
  const target = lspFile?.buffer.target ?? source?.target ?? null;
  const file = lspFile && target?.apiBase.startsWith("/api/workspaces/") ? lspFile.buffer.path : null;
  const [response, setResponse] = useState<{ q: string; full: string; symbols: WsSymbol[]; clipped: boolean } | null>(null);
  const [error, setError] = useState("");
  const full = active ? rest.trim() : "";
  // The language server gets only the FIRST word (VS Code `getWorkspaceSymbols(symbolQuery.original)`), the others filter here.
  const q = symbolRequest(full);
  const fullRef = useRef(full);
  fullRef.current = full;
  useEffect(() => {
    if (!active || !target) { setResponse(null); setError(""); return; }
    let alive = true;
    // VS Code: the request goes out after 200 ms of quiet (`SymbolsQuickAccessProvider` TYPING_SEARCH_DELAY) — also without input.
    const h = setTimeout(() => {
      lspCalls(target, "workspace_symbols", { query: q, ...(file ? { file: file } : {}) })
        .then((r) => {
          if (!alive) return;
          setError("");
          setResponse({ q, full: fullRef.current, symbols: isNotSupported(r) ? [] : Array.isArray(r.symbols) ? r.symbols : [], clipped: !isNotSupported(r) && Boolean((r as { truncated?: boolean }).truncated) });
        })
        .catch((e) => { if (alive) setError(notice(e)); });
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [active, q, target?.apiBase, target?.instance, file]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!active) return EMPTY;
    if (!target) return { rows: [textRow(tr("There are no files to search here."))] };
    const openLocation = (location: LspLocation, beside = false) => {
      if (lspFile && !beside) { lspFile.open?.(location); return; } // also a target outside the instance; relative to the buffer that asked
      if (location.external) { lspFile?.open?.(location); return; }
      const f = beside && source?.openFileBeside ? source.openFileBeside : source?.openFile;
      f?.(location.file, location.range.start.line + 1, location.range.start.character + 1);
    };
    const fresh = response?.q === q;
    const raw = (response?.symbols ?? []).map((s) => ({ ...s, file: s.location.external ? baseName(s.location.file) : s.location.file }));
    const rows = workRows(raw, fresh ? full : response?.full ?? "").map((z, i): PaletteRow => ({
      key: `${i}:${z.s.location.file}:${z.s.location.range.start.line}:${z.s.name}`, label: z.s.name, labelHits: z.hits,
      detail: z.description, detailHits: z.descriptionHits, symbol: { kind: "symbol", symbolKind: z.s.kind }, data: { "data-palette-ws-symbol": z.s.name },
      execute: () => openLocation(z.s.location),
      ...(source?.openFileBeside && !z.s.location.external ? { beside: () => openLocation(z.s.location, true), buttons: [{ icon: "page" as const, title: tr("Open to the Side"), action: () => openLocation(z.s.location, true) }] } : {}),
    }));
    return {
      rows: fresh && !rows.length ? [textRow(tr("No matching workspace symbols"), { "data-command-palette-hint": "" })] : rows,
      stale: Boolean(response) && !fresh, loading: !fresh && !error, error: error || undefined,
      footnote: fresh && response?.clipped ? tr("The first {n} matches — search more precisely to see more.", { n: rows.length }) : undefined,
    };
  }, [active, q, full, target, response, error, source, lspFile]);
}

// ── Line ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function rowsMode(active: boolean, rest: string, source: PaletteSource | null): ModeStatus {
  if (!active) return EMPTY;
  const v = source?.view ?? null;
  const doc = v?.state.doc ?? null;
  const z = rowsTarget(doc && { rows: doc.lines, row: (n) => doc.line(n).text, length: doc.length, locationOf: (o) => { const l = doc.lineAt(o); return { row: l.number, column: o - l.from + 1 }; } }, rest, v?.state.tabSize ?? 4);
  const label = text(z.notice);
  if (!v || !doc || z.row === undefined) return { rows: [textRow(label, { "data-palette-row": "" })] };
  const l = doc.line(z.row), off = Math.min(l.from + (z.column ?? 1) - 1, l.to);
  return {
    rows: [{
      key: "row", label, data: { "data-palette-row": `${z.row}` },
      execute: () => { withoutPreview(v); jumpTo(v, off); },
      preview: () => showPreview(v, l.from, l.from, off),
    }],
  };
}

// ── Help (`?`) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function helpMode(active: boolean, changeOver: (prefix: string) => void): ModeStatus {
  if (!active) return EMPTY;
  return {
    rows: helpRows().map((h): PaletteRow => ({
      key: `help:${h.prefix}`, label: h.label, detail: tr(h.text), kind: "inside", data: { "data-palette-help": h.prefix },
      shortcut: PALETTE_COMMANDS.find((b) => b.id === h.command)?.shortcut, execute: () => changeOver(h.prefix),
    })),
  };
}

// ── Choice (interpreter) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function useSelection(selection: PaletteSelection | null, rest: string, freeText: boolean, toFreeText: () => void): ModeStatus {
  const [status, setStatus] = useState<{ rows?: PaletteRow[]; error?: string } | null>(null);
  useEffect(() => {
    if (!selection) return;
    let alive = true;
    setStatus(null);
    selection.load().then((rows) => { if (alive) setStatus({ rows }); }).catch((e) => { if (alive) setStatus({ error: notice(e) }); });
    return () => { alive = false; };
  }, [selection]);
  return useMemo(() => {
    if (!selection) return EMPTY;
    const ft = selection.freeText;
    if (freeText && ft) {
      const t = rest.trim();
      return t
        ? { rows: [{ key: "free", label: tr("Use this path: {p}", { p: t }), kind: "wait", data: { "data-palette-free-text": "" }, execute: () => ft.take(t) }] }
        : { rows: [textRow(ft.placeholder)] };
    }
    if (!status) return { rows: [], loading: true };
    // VS Code `QuickPick`: name and description, the hits highlighted (here with the command palette's word filter).
    const f = rest.trim();
    const rows: PaletteRow[] = [];
    for (const z of status.rows ?? []) {
      if (!f) { rows.push(z); continue; }
      const lt = wordFilter(f, z.label), dt = z.detail ? wordFilter(f, z.detail) : null;
      if (lt || dt) rows.push({ ...z, ...(lt ? { labelHits: lt } : {}), ...(dt ? { detailHits: dt } : {}) });
    }
    if (ft && status.rows) rows.push({ key: "freeText", label: ft.label, kind: "inside", data: { "data-palette-free-text-open": "" }, execute: toFreeText });
    return { rows, error: status.error };
  }, [selection, status, rest, freeText, toFreeText]);
}
