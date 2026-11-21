"use client";

// The search across files as in VS Code (formerly `SearchPanel` in CodePane). The field carries the three toggles IN itself (Aa match
// case · ab whole word · .* regular expression), the arrow on the left opens the "Replace" row (in it AB "Preserve Case", Alt+Cmd+P;
// beside it "Replace All", Alt+Cmd+Enter), "…" the filters "files to include/exclude" (globs, comma-separated; `./folder` from the
// root; in the exclude field the toggle "Use Exclude Settings and Ignore Files", on as in VS Code). Below it the header ("1 result in
// 1 file", singular/plural as in VS Code) and "Collapse All", the hits grouped per file: ONE row per match (the same line twice, each
// with its marking; the number in the header is the number of rows), the preview as in VS Code (~26 characters before, "…"). With the
// replace row open, old struck through and new beside it. The list is a tree for the keyboard (one tab stop, up/down, right/left,
// Enter) like the outline. A click jumps to the hit and marks it.
//
// Searching happens on the server (`POST <apiBase>/files/search` via `calls`, with the instance, web/test/code-instance.test.mjs) with
// all fields; the unsaved buffers of this view go along as `open`, and for those within the scope (`openMatches`) the buffer itself
// searches (lib/file-search.ts `withBuffers`, as in VS Code). The results carry the fields they were searched with: "Replace All" works
// only while they apply (not during the search, not before the wait after an input has elapsed, not with other fields), replaces
// EXACTLY the shown hits (lib/search-replace.ts) and can be undone (Cmd+Z in the list or "Undo").
//
// `preset` opens the search with a folder ("Find in Folder…" in the tree's context menu): CodePane passes `searchInFolder(folder)` to
// the tree and masks the folder (lib/file-search.ts `globMasked`).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileSearchResponse } from "@/lib/api";
import {
  resultKey, resultCounts, substituteFor, replacedKey, questionKey, citations, sameFields, withBuffers, hitsList, previewParts,
  type FileHits, type SearchFields, type Hits,
} from "@/lib/file-search";
import { allReplace as replaceAll, undo, type ReplaceEntry } from "@/lib/search-replace";
import { allBuffers, type EditorHolder } from "@/lib/buffer";
import { inView, coordinatesOf } from "@/lib/buffer-coordinates";
import { seedForField } from "@/lib/panel-layout";
import { useConfirm } from "@/components/Prompts";
import { FileSymbol } from "@/components/code/FileSymbol";

type T = (key: string, params?: Record<string, string | number>) => string;
/** A request from outside: open the search with these fields (when `seq` grows, it applies anew). */
export type SearchDefault = { seq: number; include?: string; search?: string };
/** Where a hit jumps to: start and end (LSP positions, 0-based); the selection as in VS Code. */
export type SearchJump = { from: { line: number; character: number }; until?: { line: number; character: number } };
/** Results together with the fields they were searched with. */
type Result = { fields: SearchFields; list: FileHits[]; truncated: boolean };

const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const folder = (p: string) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; };

/** A toggle in the field as in VS Code (20 × 20, chosen: accent surface with border). */
function Toggle({ on, onClick, title, children, data }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode; data: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      aria-label={title}
      className={`grid h-5 min-w-5 shrink-0 place-items-center rounded-[3px] px-0.5 font-mono text-[11px] leading-none ${on ? "bg-accent/25 text-fg ring-1 ring-inset ring-accent" : "text-dim hover:bg-hover hover:text-fg"}`}
      data-search-toggle={data}
    >
      {children}
    </button>
  );
}

const FIELD = "flex min-w-0 items-center gap-0.5 rounded-[2px] border border-edge bg-bg py-[2px] pl-1.5 pr-[2px] focus-within:border-accent";
const INPUT = "min-w-0 flex-1 bg-transparent py-[1px] text-[13px] text-fg outline-none placeholder:text-dim";
const fileId = (path: string) => `d\u0000${path}`;
const hitsId = (path: string, j: number) => `t\u0000${path}\u0000${j}`;

export function SearchView({ t, calls, target, preset, editor, onOpen, afterReplace, seed, onSeedConsumed }: {
  t: T;
  calls: <R>(rest: string, opts?: RequestInit) => Promise<R>;
  /** The view's target: for the buffers of "Replace All" and the search in unsaved buffers (canonical). */
  target: { apiBase: string; instance: string | null };
  preset?: SearchDefault | null;
  /** Opens a file as a tab in the background (a file whose replacement could not be saved). */
  editor: EditorHolder;
  onOpen: (path: string, jump: SearchJump) => void;
  afterReplace?: () => void;
  /** Shift+Cmd+F (VS Code "Search: Find in Files"): the editor's single-line selection as the search term (when `seq` grows, it applies anew). */
  seed?: { seq: number; text: string } | null;
  /** The seed is in the field: the host forgets it, otherwise it would reappear after the search is next shown (remounted). */
  onSeedConsumed?: () => void;
}) {
  const question = useConfirm();
  const [query, setQuery] = useState(preset?.search ?? "");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [preserved, setPreserved] = useState(false);
  const [details, setDetails] = useState(Boolean(preset?.include));
  const [include, setInclude] = useState(preset?.include ?? "");
  const [exclude, setExclude] = useState("");
  const [exclusions, setExclusions] = useState(true);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacedCurrently, setReplacedCurrently] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [entry, setEntry] = useState<ReplaceEntry | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runItem = useRef(0);
  const fields: SearchFields = useMemo(() => ({ query, regex, caseSensitive, wholeWord, include, exclude, exclusions }), [query, regex, caseSensitive, wholeWord, include, exclude, exclusions]);

  // A request from outside ("Find in Folder…"): filters open, the folder in, the field focused.
  const defaultSeq = preset?.seq ?? 0;
  useEffect(() => {
    if (!preset || !defaultSeq) return;
    if (preset.include !== undefined) { setInclude(preset.include); setDetails(true); }
    if (preset.search !== undefined) setQuery(preset.search);
    requestAnimationFrame(() => field.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSeq]);
  const seedSeq = seed?.seq ?? 0;
  useEffect(() => {
    if (!seed || !seedSeq) return;
    setQuery(seedForField(seed.text, regex)); // escaped in regex mode as in VS Code
    onSeedConsumed?.();
    requestAnimationFrame(() => { field.current?.focus(); field.current?.select(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSeq]);

  // The unsaved buffers of THIS view (path in the view → text); they are searched themselves.
  const unsaved = useCallback((): Map<string, string> => {
    const k = coordinatesOf(target);
    const m = new Map<string, string>();
    for (const p of allBuffers()) {
      if (!p.dirty) continue;
      const path = inView(k, p.target, p.path);
      if (path && !path.startsWith("/")) m.set(path, p.text);
    }
    return m;
  }, [target]);

  const run = useCallback(async () => {
    const seq = ++runItem.current;
    const f = fields;
    if (!f.query) { setRes(null); setError(""); setBusy(false); return; }
    setBusy(true); setError("");
    try {
      const open = unsaved();
      const r = await calls<FileSearchResponse>("/files/search", {
        method: "POST", body: JSON.stringify({ ...f, open: [...open.keys()] }),
      });
      if (seq === runItem.current) setRes({ fields: f, list: hitsList(withBuffers(r.results, open, r.openMatches, f), f), truncated: r.truncated });
    } catch (e) { if (seq === runItem.current) { setError(String((e as Error).message)); setRes(null); } }
    finally { if (seq === runItem.current) setBusy(false); }
  }, [calls, fields, unsaved]);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void run(); }, 300);
    return () => clearTimeout(timer.current);
  }, [run]);
  // A message ("… replaced") holds until the search changes.
  useEffect(() => { setNotice(""); }, [fields]);

  const counts = res ? resultCounts(res.list) : null;
  // "Replace All" only over results that match the fields: not during the search or before it.
  const applies = Boolean(res && sameFields(res.fields, fields));
  const ready = applies && !busy && !replacedCurrently && Boolean(counts?.hits);
  const allTo = Boolean(res?.list.length) && res!.list.every((d) => closed.has(d.path));

  // "Replace All" over the buffers (see header, lib/search-replace.ts).
  const allReplace = async () => {
    if (!ready || !res || !counts) return;
    const r0 = res;
    const fresh = replacement;
    const ok = await question(
      t(questionKey(counts.hits, counts.files), { n: counts.hits, m: counts.files, fresh })
        + (r0.truncated ? ` ${t("The search was truncated — only the occurrences shown will be replaced.")}` : ""),
      { ok: t("Replace") },
    );
    if (!ok || !sameFields(r0.fields, fields)) return;
    setReplacedCurrently(true);
    try {
      const coord = coordinatesOf(target);
      const e = await replaceAll({ list: r0.list, fields: r0.fields, replacement: fresh, preserved, toCanon: (p) => coord.toCanon(p), editor });
      setEntry(e.entry);
      let text = t(replacedKey(e.replaced, e.files), { n: e.replaced, m: e.files, fresh });
      if (e.stale) text += ` ${t("{n} changed occurrences skipped.", { n: e.stale })}`;
      if (e.notSaved.length) text += ` ${t("Not saved: {list}", { list: e.notSaved.map(base).join(", ") })}`;
      setNotice(text);
      afterReplace?.();
      void run();
    } finally { setReplacedCurrently(false); }
  };
  // Undo: the earlier text comes back where the buffer still carries the later text.
  const back = async () => {
    const e = entry;
    if (!e || replacedCurrently) return;
    setReplacedCurrently(true);
    try {
      const r = await undo(e, editor);
      setEntry(null);
      let text = t("Undid Replace All in {n} files.", { n: r.back });
      if (r.changed.length) text += ` ${t("Changed since, not undone: {list}", { list: r.changed.map(base).join(", ") })}`;
      if (r.notSaved.length) text += ` ${t("Not saved: {list}", { list: r.notSaved.map(base).join(", ") })}`;
      setNotice(text);
      afterReplace?.();
      void run();
    } finally { setReplacedCurrently(false); }
  };

  // The visible rows of the tree in order (keyboard).
  const visible = useMemo(() => {
    const out: { id: string; path: string; j: number | null }[] = [];
    for (const d of res?.list ?? []) {
      out.push({ id: fileId(d.path), path: d.path, j: null });
      if (!closed.has(d.path)) d.hits.forEach((_x, j) => out.push({ id: hitsId(d.path, j), path: d.path, j }));
    }
    return out;
  }, [res, closed]);
  const carrier = focus !== null && visible.some((x) => x.id === focus) ? focus : visible[0]?.id ?? null;
  const toggle = (path: string, open: boolean) => setClosed((old) => { const n = new Set(old); if (open) n.delete(path); else n.add(path); return n; });
  const jump = (path: string, x: Hits) => onOpen(path, { from: { line: x.row - 1, character: x.from }, until: { line: x.row - 1, character: x.until } });
  const key = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") { if (entry) { e.preventDefault(); void back(); } return; }
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-search-id]")?.dataset.searchId;
    const i = visible.findIndex((x) => x.id === id);
    if (i < 0) return;
    const z = visible[i];
    const go = (j: number) => {
      const target2 = visible[Math.max(0, Math.min(visible.length - 1, j))];
      if (!target2) return;
      setFocus(target2.id);
      tree.current?.querySelector<HTMLElement>(`[data-search-id="${CSS.escape(target2.id)}"]`)?.focus();
    };
    const open = !closed.has(z.path);
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(visible.length - 1);
    else if (e.key === "ArrowRight" && z.j === null && !open) toggle(z.path, true);
    else if (e.key === "ArrowRight" && z.j === null) go(i + 1);
    else if (e.key === "ArrowLeft" && z.j === null && open) toggle(z.path, false);
    else if (e.key === "ArrowLeft" && z.j !== null) go(visible.findIndex((x) => x.id === fileId(z.path)));
    else if ((e.key === "Enter" || e.key === " ") && z.j === null) toggle(z.path, !open);
    else if (e.key === "Enter" || e.key === " ") { const d = res?.list.find((x) => x.path === z.path); if (d && z.j !== null) jump(z.path, d.hits[z.j]); }
    else return;
    e.preventDefault();
  };

  // The preview of ONE hit as in VS Code (lib/file-search.ts `previewParts`); with the replace row open, old struck through, new beside it.
  const preview = (x: Hits, f: SearchFields) => {
    const v = previewParts(x.text, x.from, x.until);
    let middle: React.ReactNode = <mark className="rounded-[2px] bg-[rgba(234,92,0,0.33)] text-fg">{v.hits}</mark>;
    if (replaceOpen && f.query && v.hits) {
      const groups = f.regex ? citations(x.text, f).find((y) => y.start === x.from)?.groups : undefined;
      const fresh = substituteFor(replacement, x.text.slice(x.from, x.until), groups, f.regex, preserved);
      middle = (
        <>
          <del className="bg-[rgba(255,0,0,0.2)] text-fg">{v.hits}</del>
          {fresh && <ins className="bg-[rgba(156,204,44,0.25)] text-fg no-underline">{fresh}</ins>}
        </>
      );
    }
    return <>{v.before}{middle}{v.after}</>;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-search-view>
      <div className="flex gap-0.5 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={() => setReplaceOpen((v) => !v)}
          aria-expanded={replaceOpen}
          title={t("Toggle Replace")}
          aria-label={t("Toggle Replace")}
          className="grid w-4 shrink-0 place-items-center self-stretch rounded-[3px] text-dim hover:bg-hover hover:text-fg"
          data-search-replace-toggle
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={replaceOpen ? "rotate-90" : ""} aria-hidden><path d="M6 3l5 5-5 5" /></svg>
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={FIELD}>
            <input
              ref={field}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }}
              placeholder={t("Search")}
              aria-label={t("Search")}
              autoFocus
              className={INPUT}
              data-search-field
            />
            <Toggle on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title={t("Match Case")} data="aa">Aa</Toggle>
            <Toggle on={wholeWord} onClick={() => setWholeWord((v) => !v)} title={t("Match Whole Word")} data="ab"><span className="underline decoration-1 underline-offset-2">start</span></Toggle>
            <Toggle on={regex} onClick={() => setRegex((v) => !v)} title={t("Use Regular Expression")} data="regex">.*</Toggle>
          </div>
          {replaceOpen && (
            <div className="flex items-center gap-1">
              <div className={`${FIELD} flex-1`}>
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.altKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void allReplace(); }
                    else if (e.code === "KeyP" && e.altKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setPreserved((v) => !v); } // Alt+Cmd+P as in VS Code
                  }}
                  placeholder={t("Replace")}
                  aria-label={t("Replace")}
                  className={INPUT}
                  data-search-replacement
                />
                <Toggle on={preserved} onClick={() => setPreserved((v) => !v)} title={t("Preserve Case (⌥⌘P)")} data="preserved">AB</Toggle>
              </div>
              <button
                type="button"
                onClick={() => void allReplace()}
                disabled={!ready}
                title={t("Replace All (⌥⌘Enter)")}
                aria-label={t("Replace All")}
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[3px] text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
                data-search-all-replace
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M3 3h4v4H3zM9 9h4v4H9z" /><path d="M9 4.5h2.5a1 1 0 0 1 1 1V7M7 11.5H4.5a1 1 0 0 1-1-1V9" /></svg>
              </button>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setDetails((v) => !v)}
              aria-expanded={details}
              title={t("Toggle Search Details")}
              aria-label={t("Toggle Search Details")}
              className="rounded-[3px] px-1 text-[13px] leading-none text-dim hover:bg-hover hover:text-fg"
              data-search-details
            >
              …
            </button>
          </div>
          {details && (
            <>
              <label className="flex flex-col gap-0.5 text-[11px] text-dim">
                {t("files to include")}
                <div className={FIELD}><input value={include} onChange={(e) => setInclude(e.target.value)} placeholder={t("e.g. *.ts, src/**/include")} className={INPUT} data-search-include /></div>
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-dim">
                {t("files to exclude")}
                <div className={FIELD}>
                  <input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={t("e.g. *.ts, src/**/exclude")} className={INPUT} data-search-exclude />
                  <Toggle on={exclusions} onClick={() => setExclusions((v) => !v)} title={t("Use Exclude Settings and Ignore Files")} data="exclusions">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M3 2.5h7l3 3v8H3z" /><path d="M10 2.5v3h3" /><path d="M5.5 9.5l5 0" /></svg>
                  </Toggle>
                </div>
              </label>
            </>
          )}
        </div>
      </div>
      <div className="flex min-h-[22px] items-center gap-1 px-3 text-[12px] text-dim" data-search-header>
        <span className="min-w-0 flex-1 truncate" title={notice || undefined}>
          {busy ? t("Searching…##inline") : error ? <span className="text-danger">{error}</span> : notice ? (
            <>
              {notice}
              {entry && (
                <button type="button" onClick={() => void back()} className="ml-1 text-accent hover:underline" data-search-undo>{t("Undo")}</button>
              )}
            </>
          ) : counts ? (
            counts.hits === 0 ? t("No results") : (
              <>
                {t(resultKey(counts.hits, counts.files), { n: counts.hits, m: counts.files })}
                {res?.truncated ? ` ${t("(truncated)")}` : ""}
              </>
            )
          ) : ""}
        </span>
        {Boolean(res?.list.length) && (
          <button
            type="button"
            onClick={() => setClosed(allTo ? new Set() : new Set(res!.list.map((d) => d.path)))}
            title={allTo ? t("Expand All") : t("Collapse All")}
            aria-label={allTo ? t("Expand All") : t("Collapse All")}
            className="grid h-5 w-5 place-items-center rounded-[3px] hover:bg-hover hover:text-fg"
            data-search-all-closed
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><rect x="2.5" y="2.5" width="11" height="11" rx="1" />{allTo ? <path d="M5.5 8h5M8 5.5v5" /> : <path d="M5.5 8h5" />}</svg>
          </button>
        )}
      </div>
      <div ref={tree} role="tree" aria-label={t("Search results")} onKeyDown={key} className="cb-scroll min-h-0 flex-1 overflow-auto pb-2 text-[13px]">
        {res?.list.map((d) => {
          const open = !closed.has(d.path);
          const did = fileId(d.path);
          return (
            <div
              key={d.path}
              role="treeitem"
              aria-expanded={open}
              aria-level={1}
              aria-selected={carrier === did}
              tabIndex={carrier === did ? 0 : -1}
              onFocus={(e) => { if (e.target === e.currentTarget) setFocus(did); }}
              className="outline-none [&:focus-visible>div:first-child]:ring-1 [&:focus-visible>div:first-child]:ring-inset [&:focus-visible>div:first-child]:ring-accent/60"
              data-search-id={did}
              data-search-file={d.path}
            >
              <div
                onClick={() => { setFocus(did); toggle(d.path, !open); }}
                title={d.path}
                className={`flex h-[22px] cursor-pointer select-none items-center gap-1 pl-1 pr-2 ${carrier === did ? "bg-hover" : "hover:bg-hover"}`}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={`mx-[3px] shrink-0 text-dim ${open ? "rotate-90" : ""}`} aria-hidden><path d="M6 3l5 5-5 5" /></svg>
                <FileSymbol path={d.path} />
                <span className="shrink-0 truncate">{base(d.path)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{folder(d.path)}</span>
                <span className="shrink-0 rounded-full bg-hover px-1.5 text-[11px] leading-[16px] text-fg/80">{d.hits.length}</span>
              </div>
              {open && (
                <div role="group">
                  {d.hits.map((x, j) => {
                    const tid = hitsId(d.path, j);
                    return (
                      <div
                        key={j}
                        role="treeitem"
                        aria-level={2}
                        aria-selected={carrier === tid}
                        tabIndex={carrier === tid ? 0 : -1}
                        onFocus={() => setFocus(tid)}
                        onClick={() => { setFocus(tid); jump(d.path, x); }}
                        title={t("Line {line}", { line: x.row })}
                        className={`flex h-[22px] cursor-pointer items-center whitespace-pre pl-[38px] pr-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${carrier === tid ? "bg-hover" : "hover:bg-hover"}`}
                        data-search-id={tid}
                        data-search-hits={x.row}
                      >
                        <span className="min-w-0 flex-1 truncate">{preview(x, res.fields)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
