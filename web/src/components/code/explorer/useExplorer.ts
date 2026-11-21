"use client";
// The explorer's state as in VS Code. CodePane holds only what concerns the TABS and is told about renaming/deleting via
// `onRenamed`/`onDeleted` (its tabs and buffers follow).
//
// The computations live in lib/explorer-tree.ts (rows, keys, chain), lib/explorer-names.ts (copy names, check, drop) and
// lib/explorer-decoration.ts (git, ignored, problems) — here we only ask, remember and write.
//
// Every address goes through `calls` (which carries the chosen copy's `instance=` — web/test/code-instance.test.mjs (f) guards that for
// CodePane, web/test/explorer-sources.test.mjs for this folder). Writing goes through the routes of devtools/code-route.js: `/files/create`,
// `/files/rename` (rename AND move), `/files/copy` (copy — never overwrite), `DELETE /files`, `/upload`; reading `/files/tree` per folder
// (lazy) and `/git/ignored` (when it becomes visible, after every own change and when the set of git changes changes — no own poll).
//
// - Every answer carries a run number; a list replaces only an OLDER one (also "ignored") — a late answer never overwrites a newer one.
// - If the git state (`gitKey`) changes, the open, loaded folders re-read: what an agent or the terminal creates appears (there is no
//   "turn ended" event in the web; the git state asks every 8 s and on window focus).
// - "ignored" is debounced: a write action and the git state after it ask ONCE.
// - A list with chains (`chain`) states the contents of the chain's folders at once (lib/explorer-tree.ts `chainsSeed`).
// - A path's kind is three-valued (`kindOf`: folder, file, unknown); deleted paths drop out of `children` and `open`.
// - Dragging asks before moving (VS Code `explorer.confirmDragAndDrop`, "Do not ask again" per device); an occupied name asks "Replace?";
//   pasting like VS Code `pasteFileHandler`; skipped and capped entries say so.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DirListing, type FileEntry, type GitIgnored, type GitIgnoredRepo, type Workspace } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { missingOpen, chainsSeed, openSegments, visibleRows, toggle as toggleIn, ancestors, showExcluded, type TreeRow, type EntryRow } from "@/lib/explorer-tree";
import { depositPlan, importPlan, checkName, topmost, targetPath, type Deposit, type Import, type NameError } from "@/lib/explorer-names";
import { insertTargets, deleteWarning, select as selectIn, targetFolder as targetFolderOf } from "@/lib/explorer-actions";

export type Editing = { kind: "rename"; path: string } | { kind: "fresh"; type: "file" | "dir"; parent: string };
export type EditingError = { code: NameError } | { server: string };
export type Clipboard = { kind: "copy" | "cut"; paths: string[] };

const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** `p` lies in/under `old`: rewrite to `fresh` (renaming/moving a folder takes everything below it along). */
const relocate = (p: string, old: string, fresh: string) => (p === old ? fresh : p.startsWith(`${old}/`) ? fresh + p.slice(old.length) : p);

// Large files go out in ~3 MB pieces (the same size as in the mobile app): a 500 MB video as one base64 request would blow up renderer
// and server.
const UPLOAD_CHUNK = 3 * 1024 * 1024;
const toBase64 = (bytes: Uint8Array) => {
  // btoa needs a string; in small chunks, because String.fromCharCode(...) would otherwise blow the stack.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** How long "ignored" rests after the last trigger before it asks (a write action and the git state after it are ONE trigger). */
const IGNORED_QUIET_MS = 600;
/** VS Code `explorer.confirmDragAndDrop` — "Do not ask again" holds per device (browser storage; without it it always asks). */
const DRAG_QUESTIONS_KEY = "cbase-explorer-drag-questions";
const dragQuestions = () => { try { return localStorage.getItem(DRAG_QUESTIONS_KEY) !== "0"; } catch { return true; } };
const dragNotMoreQuestions = () => { try { localStorage.setItem(DRAG_QUESTIONS_KEY, "0"); } catch { /* without storage: keep asking */ } };

export type ExplorerOptions = {
  apiBase: string;
  instance: string | null;
  calls: <T = unknown>(rest: string, opts?: RequestInit) => Promise<T>;
  active: boolean;
  /** Changes when the set of git changes changes (a new `.gitignore` line is one) — the ignored paths re-read. */
  gitKey: string;
  onOpen: (path: string, fixed: boolean) => void;
  /** "Open to the Side" (VS Code `explorer.openToSide`: ⌃↵, ⌥-click, context menu) — without: does not exist (the chat has no groups). */
  onOpenBeside?: (path: string) => void;
  onRenamed: (old: string, fresh: string) => void;
  onDeleted: (path: string) => void;
  /** Something was written — the git state re-reads. */
  onChanged: () => void;
  /** The paths (in this view) with unsaved changes — deleting then warns like VS Code (lib/explorer-actions.ts `deleteWarning`). */
  unsaved?: () => readonly string[];
};

export function useExplorer(o: ExplorerOptions) {
  const t = useT();
  const question = useConfirm();
  const { calls, active } = o;
  const oRef = useRef(o);
  oRef.current = o;

  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [openSet, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editingError, setEditingError] = useState<EditingError | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [error, setError] = useState("");
  const [ignored, setIgnored] = useState<GitIgnoredRepo[] | null>(null);
  /** A notice under the header (skipped entries of a copy, an unknown location) — until the next action. */
  const [hint, setHint] = useState("");
  /** Grows when focus should return to the tree (after ↵/Esc in the field, after a menu action, after deleting and pasting). */
  const [treeFocus, setTreeFocus] = useState(0);
  const toTree = useCallback(() => setTreeFocus((n) => n + 1), []);
  /** Is an upload running? {done,total} counts PIECES, not files (large files go out in parts). */
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  /** "Reveal Active File": the path the drawing scrolls into view as soon as its row exists; `seq` grows per request. */
  const [showRequest, setShow] = useState<{ path: string; seq: number } | null>(null);

  // ── Reading ──
  // Every request gets a number; `versions` remembers per folder the number of the list currently valid. An answer replaces only an OLDER one
  // — otherwise a late answer (asked before a change) would overwrite the newer one.
  const runSeq = useRef(0);
  const versions = useRef(new Map<string, number>());
  const loadingCurrently = useRef(new Set<string>());
  const load = useCallback(async (dir: string): Promise<FileEntry[] | null> => {
    const seq = ++runSeq.current;
    loadingCurrently.current.add(dir);
    try {
      const r = await calls<DirListing>(`/files/tree?path=${encodeURIComponent(dir)}`);
      const fresh: [string, FileEntry[]][] = [];
      for (const [d, list] of [[dir, r.entries] as [string, FileEntry[]], ...(chainsSeed(r.entries) as [string, FileEntry[]][])]) {
        if ((versions.current.get(d) ?? 0) > seq) continue;
        versions.current.set(d, seq);
        fresh.push([d, list]);
      }
      if (fresh.length) setChildren((prev) => ({ ...prev, ...Object.fromEntries(fresh) }));
      if ((versions.current.get(dir) ?? 0) <= seq) setError("");
      return r.entries;
    } catch (e) {
      if ((versions.current.get(dir) ?? 0) <= seq) setError(String((e as Error).message));
      return null;
    } finally {
      loadingCurrently.current.delete(dir);
    }
  }, [calls]);
  /** Forget folders (deleted, moved, re-read): even a still-running answer about them no longer counts. */
  const forget = useCallback((drop: (d: string) => boolean) => {
    const seq = ++runSeq.current;
    setChildren((prev) => {
      const n: Record<string, FileEntry[]> = {};
      for (const [k, v] of Object.entries(prev)) { if (drop(k)) versions.current.set(k, seq); else n[k] = v; }
      return n;
    });
  }, []);

  // "ignored": ONE request per quiet period, and only the answer of the last one counts.
  const ignoreSeq = useRef(0);
  const ignClock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadIgnoredNow = useCallback(async () => {
    if (ignClock.current) { clearTimeout(ignClock.current); ignClock.current = null; }
    const seq = ++ignoreSeq.current;
    try {
      const r = await calls<GitIgnored>(`/git/ignored`);
      if (seq === ignoreSeq.current) setIgnored(r.repos ?? []);
    } catch {
      if (seq === ignoreSeq.current) setIgnored(null); // no git — nothing dimmed
    }
  }, [calls]);
  const loadIgnored = useCallback(() => {
    if (ignClock.current) clearTimeout(ignClock.current);
    ignClock.current = setTimeout(() => { ignClock.current = null; void loadIgnoredNow(); }, IGNORED_QUIET_MS);
  }, [loadIgnoredNow]);
  useEffect(() => () => { if (ignClock.current) clearTimeout(ignClock.current); }, []);

  // The root on becoming visible: a tab mounted hidden loads nothing, and whoever comes back sees it fresh.
  useEffect(() => { if (active) { void load(""); void loadIgnoredNow(); } }, [load, loadIgnoredNow, active]);
  // A new git state re-reads the open, loaded folders (files from outside appear) and "ignored" (debounced).
  const openRef = useRef(openSet);
  openRef.current = openSet;
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const lastKey = useRef(o.gitKey);
  useEffect(() => {
    if (!active || lastKey.current === o.gitKey) return;
    lastKey.current = o.gitKey;
    for (const d of ["", ...[...openRef.current].filter((x) => childrenRef.current[x] !== undefined)]) void load(d);
    loadIgnored();
  }, [loadIgnored, load, active, o.gitKey]);

  // Editing: the field stands in the target folder (it is the last segment of its row); a renamed entry stands alone.
  const breakPaths = useMemo(() => (editing?.kind === "rename" ? [editing.path, parentOf(editing.path)] : []), [editing]);
  const rows = useMemo<TreeRow[]>(() => visibleRows(children, openSet, {
    compact: true,
    fresh: editing?.kind === "fresh" ? { parent: editing.parent, type: editing.type } : null,
    abort: breakPaths,
  }), [children, openSet, editing, breakPaths]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Open folders without loaded contents fetch them (also the growing chain of a compact row).
  useEffect(() => {
    if (!active) return;
    for (const d of missingOpen(children, rows)) if (!loadingCurrently.current.has(d)) void load(d);
  }, [rows, children, active, load]);
  // A chain drawn open puts ALL segments in `open` — if it breaks later (a file is added), every one stays open.
  useEffect(() => {
    const n = openSegments(rows, openSet);
    if (n !== openSet) setOpen(n);
  }, [rows, openSet]);

  const typeOf = useMemo(() => {
    const m = new Map<string, "dir" | "file">();
    for (const list of Object.values(children)) for (const e of list) m.set(e.path, e.type);
    return m;
  }, [children]);
  /** A path's kind — null: unknown (never silently counted as a file). A folder with loaded contents is a folder. */
  const kindOf = useCallback((p: string): "dir" | "file" | null => (p === "" ? "dir" : typeOf.get(p) ?? (children[p] !== undefined ? "dir" : null)), [typeOf, children]);
  const isFolder = useCallback((p: string) => kindOf(p) === "dir", [kindOf]);

  /** Re-read: the root and every open, already loaded folder; everything else is forgotten (loads when it opens). */
  const loadAgain = useCallback(() => {
    const dirs = ["", ...[...openSet].filter((d) => children[d] !== undefined)];
    forget((k) => !dirs.includes(k));
    for (const d of dirs) void load(d);
    void loadIgnoredNow();
  }, [openSet, children, load, loadIgnoredNow, forget]);

  // ── Selection and collapsing ──
  // The computation is in lib/explorer-actions.ts `select` (click, ⌘-click, ⇧-click, ⌘⇧-click); here only the state.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const select = useCallback((path: string, mod: { meta?: boolean; shift?: boolean } = {}) => {
    const n = selectIn({ selection: selectionRef.current, focus: focusRef.current, anchor: anchor.current }, rowsRef.current, path, mod);
    selectionRef.current = n.selection;
    focusRef.current = n.focus;
    anchor.current = n.anchor;
    setSelection(n.selection);
    setFocus(n.focus);
  }, []);
  /** Set only the focus, the selection stays (the tree search jumps to the first hit while typing, VS Code `focusNext`). */
  const focusOn = useCallback((path: string) => { focusRef.current = path; setFocus(path); }, []);
  const toggle = useCallback((row: Pick<EntryRow, "chain" | "open">, on?: boolean) => setOpen((prev) => toggleIn(prev, row, on)), []);
  const collapseAll = useCallback(() => setOpen(new Set()), []);
  /** Open the folders above `path` (`withSelf`: it too), select it and scroll it into view ("Reveal Active File", also "Open in Code
   *  Tab"). Without `force` VS Code `explorer.autoRevealExclude` applies: under `node_modules`/`bower_components` the tree shows nothing —
   *  "Reveal in Explorer View" forces (VS Code `select(…, "force")`). */
  const reveal = useCallback((path: string, withSelf = false, force = false) => {
    if (!force && showExcluded(path)) return;
    setOpen((prev) => {
      const missing = [...ancestors(path), ...(withSelf && path ? [path] : [])].filter((d) => !prev.has(d));
      if (!missing.length) return prev;
      const n = new Set(prev);
      for (const d of missing) n.add(d);
      return n;
    });
    setSelection((prev) => (prev.size === 1 && prev.has(path) ? prev : new Set([path])));
    setFocus(path);
    anchor.current = path;
    setShow((z) => ({ path, seq: (z?.seq ?? 0) + 1 }));
  }, []);
  /** Only scroll into view (keys, type-ahead) — the selection stays as it is. */
  const scrollTo = useCallback((path: string) => setShow((z) => ({ path, seq: (z?.seq ?? 0) + 1 })), []);
  /** ⌘A: all visible entries. */
  const selectAll = useCallback(() => setSelection(new Set(rowsRef.current.filter((z) => z.kind === "entry").map((z) => z.path))), []);
  /** Open a file — as a preview (click, Space) or pinned (double click, ⌘↓); CodePane decides what that means. */
  const openPath = useCallback((path: string, fixed: boolean) => oRef.current.onOpen(path, fixed), []);
  const canBeside = Boolean(o.onOpenBeside);
  const openBeside = useMemo(() => (canBeside ? (path: string) => oRef.current.onOpenBeside?.(path) : null), [canBeside]);
  /** An adopted layout: selection and expanded folders move to the new paths, the contents re-read. */
  const rehome = useCallback((form: (p: string) => string | null) => {
    setOpen((prev) => { const n = new Set<string>(); for (const d of prev) { const z = form(d); if (z !== null) n.add(z); } return n; });
    setSelection((prev) => { const n = new Set<string>(); for (const d of prev) { const z = form(d); if (z !== null) n.add(z); } return n; });
    setFocus((f) => (f === null ? f : form(f)));
    forget(() => true);
    void load("");
  }, [load, forget]);

  /** Where "New File" and "Upload" without an explicit folder aim: a chosen folder itself, otherwise the selection's folder — null if the
   *  focus's kind is unknown (lib/explorer-actions.ts `targetFolder`). */
  const targetFolder = useCallback((path: string | null = focus) => targetFolderOf(path, path === null ? null : kindOf(path)), [focus, kindOf]);
  const unknownLocation = useCallback(() => setHint(t("The type of the selected item is unknown — refresh the Explorer.")), [t]);

  // ── Writing ──
  const report = useCallback((e: unknown) => alert(t("Error: {msg}", { msg: (e as Error).message })), [t]);
  const afterWrite = useCallback((dirs: string[]) => {
    for (const d of new Set(dirs)) void load(d);
    void loadIgnored();
    oRef.current.onChanged();
  }, [load, loadIgnored]);

  /** A path just written: open the folders above, select and reveal it (also across a new intermediate level "a/b.ts"). */
  const showAfter = useCallback((path: string) => {
    setOpen((prev) => { const missing = ancestors(path).filter((d) => !prev.has(d)); return missing.length ? new Set([...prev, ...missing]) : prev; });
    select(path);
    setShow((z) => ({ path, seq: (z?.seq ?? 0) + 1 }));
  }, [select]);

  /** Rename or move via `/files/rename`; open tabs and buffers follow in CodePane (`onRenamed`). */
  const nameText = useCallback(async (from: string, to: string) => {
    await calls(`/files/rename`, { method: "POST", body: JSON.stringify({ from, to }) });
    oRef.current.onRenamed(from, to);
    setOpen((prev) => new Set([...prev].map((p) => relocate(p, from, to))));
    setSelection((prev) => new Set([...prev].map((p) => relocate(p, from, to))));
    setFocus((f) => (f === null ? f : relocate(f, from, to)));
    forget((k) => k === from || k.startsWith(`${from}/`));
  }, [calls, forget]);

  const restart = useCallback((type: "file" | "dir", parent?: string) => {
    const dir = parent ?? targetFolder();
    if (dir === null) { unknownLocation(); return; }
    setHint("");
    setOpen((prev) => { const n = new Set(prev); for (const d of [...ancestors(dir), ...(dir ? [dir] : [])]) n.add(d); return n; });
    if (children[dir] === undefined) void load(dir);
    setEditingError(null);
    setEditing({ kind: "fresh", type, parent: dir });
  }, [targetFolder, children, load, unknownLocation]);
  const startRename = useCallback((path: string) => {
    setEditingError(null);
    setEditing({ kind: "rename", path });
    select(path);
  }, [select]);
  const abort = useCallback(() => { setEditing(null); setEditingError(null); }, []);
  /** The check while typing (the message under the field). */
  const check = useCallback((name: string) => {
    const b = editing;
    if (!b) return checkName(name, []);
    const dir = b.kind === "fresh" ? b.parent : parentOf(b.path);
    return checkName(name, (children[dir] ?? []).map((e) => e.name), b.kind === "rename" ? nameOf(b.path) : null);
  }, [editing, children]);
  /** ↵ in the field: true = done (the field closes), false = an error stands under the field, it stays open. */
  const confirm = useCallback(async (name: string): Promise<boolean> => {
    const b = editing;
    if (!b) return true;
    if (b.kind === "rename" && name === nameOf(b.path)) { abort(); return true; }
    const p = check(name);
    if (p.error) { setEditingError({ code: p.error }); return false; }
    // VS Code `validateFileName`: "a/b.ts" creates `a` too, "sub/x.ts" on renaming moves — the server creates missing folders.
    try {
      if (b.kind === "rename") {
        const to = targetPath(parentOf(b.path), name);
        await nameText(b.path, to);
        afterWrite([parentOf(b.path), parentOf(to)]);
        showAfter(to);
      } else {
        const target = targetPath(b.parent, name);
        await calls(`/files/create`, { method: "POST", body: JSON.stringify({ path: target, type: b.type }) });
        afterWrite([b.parent, parentOf(target)]);
        showAfter(target);
        if (b.type === "file") oRef.current.onOpen(target, true);
      }
      abort();
      return true;
    } catch (e) {
      setEditingError({ server: String((e as Error).message) });
      return false;
    }
  }, [editing, abort, check, nameText, afterWrite, showAfter, calls]);

  /** Delete (⌘⌫, menu) — all selected, with confirmation. */
  const erase = useCallback(async (paths?: readonly string[]) => {
    const list = topmost(paths ?? [...selection]).filter((p) => p !== "");
    if (!list.length) return;
    // If unsaved changes lie below, ONE confirmation asks about them (VS Code `deleteFiles`, `skipConfirm`) — the changes are lost.
    const w = deleteWarning(list, oRef.current.unsaved?.() ?? []);
    const lost = t("Your changes will be lost if you don't save them.");
    const text = w?.kind === "files" ? `${t("You are deleting files with unsaved changes. Do you want to continue?")} ${lost}`
      : w?.kind === "file" ? `${t("You are deleting {name} with unsaved changes. Do you want to continue?", { name: w.name })} ${lost}`
      : w?.kind === "folder" ? `${w.count === 1
        ? t("You are deleting a folder {name} with unsaved changes in 1 file. Do you want to continue?", { name: w.name })
        : t("You are deleting a folder {name} with unsaved changes in {n} files. Do you want to continue?", { name: w.name, n: w.count })} ${lost}`
      : list.length === 1
        ? t("Delete \"{name}\"? This cannot be undone.", { name: nameOf(list[0]) })
        : t("Delete {n} items? This cannot be undone.", { n: list.length });
    if (!(await question(text, { ok: t("Delete"), danger: true }))) { toTree(); return; }
    const dirs: string[] = [];
    const gone: string[] = [];
    try {
      for (const p of list) {
        await calls(`/files?path=${encodeURIComponent(p)}`, { method: "DELETE" });
        oRef.current.onDeleted(p);
        dirs.push(parentOf(p));
        gone.push(p);
      }
    } catch (e) { report(e); }
    // Deleted paths drop out of `children` (also from their folder's list — its kind is unknown afterwards, not "file") and `open`.
    const below = (p: string) => gone.some((l) => p === l || p.startsWith(`${l}/`));
    forget(below);
    setChildren((prev) => {
      let n: Record<string, FileEntry[]> | null = null;
      for (const [k, v] of Object.entries(prev)) { if (v.some((e) => below(e.path))) (n ??= { ...prev })[k] = v.filter((e) => !below(e.path)); }
      return n ?? prev;
    });
    setOpen((prev) => ([...prev].some(below) ? new Set([...prev].filter((p) => !below(p))) : prev));
    setSelection((prev) => new Set([...prev].filter((p) => !below(p))));
    setFocus((f) => (f !== null && below(f) ? (parentOf(f) || null) : f));
    afterWrite(dirs);
    toTree();
  }, [selection, question, t, calls, report, afterWrite, forget, toTree]);

  /**
   * Move or copy `sources` into the folder `target` (dragging, pasting) — one request per topmost path. `like.questions`: when dragging,
   * moving asks first like VS Code `explorer.confirmDragAndDrop` (`targetName` stands in the question). An occupied name asks "Replace?" when moving
   * (replace = delete the old one, then move). → the written drops.
   */
  const deposit = useCallback(async (sources: readonly string[], target: string, kind: "move" | "copy", like: { questions?: { targetName: string } } = {}): Promise<Deposit[]> => {
    setHint("");
    const names = (children[target] ?? (await load(target)) ?? []).map((e) => e.name);
    const plan = depositPlan(sources, target, kind, names, kindOf);
    const occupied = plan.omitted.filter((a) => a.reason === "occupied");
    if (kind === "move" && like.questions && (plan.ops.length || occupied.length) && dragQuestions()) {
      const all = [...plan.ops.map((x) => x.from), ...occupied.map((x) => x.from)];
      const text = all.length === 1
        ? t("Are you sure you want to move “{name}” into “{target}”?", { name: nameOf(all[0]), target: like.questions.targetName })
        : t("Are you sure you want to move {n} files into “{target}”?", { n: all.length, target: like.questions.targetName });
      const yes = await question(text, { ok: t("Move"), checkMark: { text: t("Do not ask me again"), onConfirm: (enabled) => { if (enabled) dragNotMoreQuestions(); } } });
      if (!yes) return [];
    }
    const ops: Deposit[] = [...plan.ops];
    const replace = new Set<string>();
    for (const b of occupied) {
      if (kind !== "move" || !b.to) continue;
      const yes = await question(t("A file or folder with the name “{name}” already exists in the destination folder. Do you want to replace it? This action is irreversible.", { name: nameOf(b.from) }), { ok: t("Replace"), danger: true });
      if (yes) { ops.push({ from: b.from, to: b.to }); replace.add(b.to); }
    }
    const dirs = [target];
    const finished: Deposit[] = [];
    let omitted = 0;
    try {
      for (const { from, to } of ops) {
        if (kind === "copy") {
          const r = await calls<{ omitted?: number }>(`/files/copy`, { method: "POST", body: JSON.stringify({ from, to }) });
          omitted += typeof r?.omitted === "number" ? r.omitted : 0;
        } else {
          if (replace.has(to)) { await calls(`/files?path=${encodeURIComponent(to)}`, { method: "DELETE" }); oRef.current.onDeleted(to); }
          await nameText(from, to);
          dirs.push(parentOf(from));
        }
        finished.push({ from, to });
      }
    } catch (e) { report(e); }
    // What did not work says so — "the cap says that it is one".
    const parts: string[] = [];
    if (omitted) parts.push(t("{n} items were not copied (links or special files).", { n: omitted }));
    if (kind === "copy" && occupied.length) parts.push(t("“{name}”: no free name for the copy.", { name: nameOf(occupied[0].from) }));
    const unknown = plan.omitted.filter((a) => a.reason === "unknown");
    if (unknown.length) parts.push(t("“{name}”: unknown type — not copied (refresh the Explorer).", { name: nameOf(unknown[0].from) }));
    if (parts.length) setHint(parts.join(" "));
    if (finished.length) {
      afterWrite(dirs);
      if (target) setOpen((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
      const fresh = new Set(finished.map((x) => x.to));
      selectionRef.current = fresh;
      setSelection(fresh);
      setFocus(finished[finished.length - 1].to);
      anchor.current = finished[finished.length - 1].to;
    }
    return finished;
  }, [children, load, kindOf, calls, nameText, report, t, afterWrite, question]);

  /**
   * A drop from the explorer of ANOTHER window at the same location like VS Code `ExternalFileImport.import` (lib/explorer-names.ts
   * `importPlan`): existence and kind of each source and the names in the target are read fresh; a folder onto the root asks first; for each
   * occupied name "Replace?" (No skips only that one); missing sources are reported; then copy one after the other (replace = delete the old
   * one, then copy; onto itself nothing — VS Code `doMoveCopy`), the first error stops. A single file opens pinned
   * (`explorer.autoOpenDroppedFile`). → the written drops.
   */
  const importing = useCallback(async (sources: readonly string[], target: string): Promise<Deposit[]> => {
    setHint("");
    const listen = new Map<string, Promise<FileEntry[] | null>>();
    const list = (d: string) => { let l = listen.get(d); if (!l) listen.set(d, (l = load(d))); return l; };
    const kinds = new Map<string, "dir" | "file">();
    for (const q of topmost(sources)) { const e = (await list(parentOf(q)))?.find((x) => x.name === nameOf(q)); if (e) kinds.set(q, e.type); }
    const plan = importPlan(sources, target, ((await list(target)) ?? []).map((e) => e.name), (p) => kinds.get(p) ?? null);
    if (plan.folderAtRoot) {
      const folder = plan.ops.filter((o) => o.kind === "dir");
      const text = folder.length > 1 ? t("Are you sure to want to copy folders?") : t("Are you sure to want to copy “{name}”?", { name: nameOf(folder[0].from) });
      if (!(await question(text, { ok: t("Copy Folder") }))) return [];
    }
    const ops: Import[] = [];
    for (const o of plan.ops) {
      if (o.replace && !(await question(t("A file or folder with the name “{name}” already exists in the destination folder. Do you want to replace it? This action is irreversible.", { name: nameOf(o.from) }), { ok: t("Replace"), danger: true }))) continue;
      ops.push(o);
    }
    if (plan.missing.length) alert(plan.missing.length > 1 ? t("Some or all of the dropped files could not be accessed for import.") : t("The dropped file could not be accessed for import."));
    const finished: Deposit[] = [];
    let omitted = 0;
    try {
      for (const o of ops) {
        if (o.error === "itself") throw new Error(t("Unable to move/copy when source “{source}” is parent of target “{target}”.", { source: o.from, target: o.to }));
        if (o.error === "contained") throw new Error(t("Unable to move/copy “{source}” into “{target}” since a file would replace the folder it is contained in.", { source: o.from, target: o.to }));
        if (o.to !== o.from) {
          if (o.replace) { await calls(`/files?path=${encodeURIComponent(o.to)}`, { method: "DELETE" }); oRef.current.onDeleted(o.to); }
          const r = await calls<{ omitted?: number }>("/files/copy", { method: "POST", body: JSON.stringify({ from: o.from, to: o.to }) });
          if (typeof r?.omitted === "number") omitted += r.omitted;
        }
        finished.push({ from: o.from, to: o.to });
      }
    } catch (e) { report(e); }
    if (omitted) setHint(t("{n} items were not copied (links or special files).", { n: omitted }));
    if (finished.length) {
      afterWrite([target]);
      if (target) setOpen((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
      const fresh = new Set(finished.map((x) => x.to));
      selectionRef.current = fresh;
      setSelection(fresh);
      setFocus(finished[finished.length - 1].to);
      anchor.current = finished[finished.length - 1].to;
    }
    if (ops.length === 1 && finished.length === 1 && ops[0].kind === "file") oRef.current.onOpen(finished[0].to, true);
    return finished;
  }, [load, question, t, calls, report, afterWrite]);

  const copy = useCallback(() => { if (selection.size) setClipboard({ kind: "copy", paths: topmost([...selection]) }); }, [selection]);
  const cut = useCallback(() => { if (selection.size) setClipboard({ kind: "cut", paths: topmost([...selection]) }); }, [selection]);
  /**
   * Paste like VS Code `pasteFileHandler` (lib/explorer-actions.ts `insertTargets`): `element` is the menu's element (without it: the
   * focus, otherwise the root). Onto the copied source itself ⇒ into its folder ("src copy"); into an own subfolder ⇒ error. A single
   * pasted FILE opens pinned, focus stays in the tree.
   */
  const insert = useCallback(async (element?: string) => {
    const z = clipboard;
    if (!z) return;
    const el = element ?? focus ?? "";
    const plan = insertTargets(el, kindOf(el), z.paths);
    if ("error" in plan) {
      if (plan.error === "ancestor") alert(t("File to paste is an ancestor of the destination folder."));
      else unknownLocation();
      toTree();
      return;
    }
    const kind = z.kind === "cut" ? "move" : "copy";
    const finished: Deposit[] = [];
    for (const g of plan.groups) finished.push(...(await deposit(g.sources, g.target, kind)));
    if (z.kind === "cut") setClipboard(null);
    if (finished.length === 1 && kindOf(finished[0].from) === "file") oRef.current.onOpen(finished[0].to, true);
    toTree();
  }, [clipboard, focus, kindOf, deposit, t, unknownLocation, toTree]);

  /** ⌥⌘C / ⌥⇧⌘C: the path (the paths, one per line) to the clipboard — absolute only where the location is known (the main). */
  const copyPath = useCallback(async (paths: readonly string[], relative: boolean) => {
    let root: string | null = null;
    if (!relative) root = await rootPath(oRef.current.apiBase, oRef.current.instance);
    const text = paths.map((p) => (root ? (p ? `${root.replace(/\/+$/, "")}/${p}` : root) : p)).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* without clipboard access: nothing */ }
  }, []);

  // ── Upload ──
  // `rel` is the path under `dir`: for folder selection `webkitRelativePath`, for drag & drop the path in the drop — so the structure is
  // kept. No confirmation, no filter, no provisioning.
  const performUpload = useCallback(async (dir: string | null, files: { rel: string; file: File }[]) => {
    if (dir === null) { unknownLocation(); return; }
    if (!files.length) return;
    const total = files.reduce((n, f) => n + Math.max(1, Math.ceil(f.file.size / UPLOAD_CHUNK)), 0);
    let done = 0;
    setUpload({ done, total });
    try {
      for (const { rel: raw, file } of files) {
        const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
        const parts = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
        for (let i = 0; i < parts; i++) {
          const slice = file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
          const bytes = new Uint8Array(await slice.arrayBuffer());
          await calls(`/upload`, { method: "POST", body: JSON.stringify({ dir, files: [{ path: rel, dataB64: toBase64(bytes), append: i > 0 }] }) });
          setUpload({ done: ++done, total });
        }
      }
      if (dir) setOpen((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      afterWrite([dir]);
    } catch (e) {
      alert(t("Upload failed: {msg}", { msg: (e as Error).message }));
    } finally {
      setUpload(null);
    }
  }, [calls, afterWrite, t, unknownLocation]);

  // The "ignored" list is capped (the server's cap): not everything ignored is dimmed — the tree says so.
  const ignoredClipped = Boolean(ignored?.some((r) => r.clipped));

  return {
    rows, children, open: openSet, selection, focus, editing, editingError, clipboard, error, ignored, ignoredClipped, upload, show: showRequest,
    hint, closeHint: () => setHint(""), unknownLocation, treeFocus, toTree,
    load, loadAgain, select, focusOn, selectAll, toggle, collapseAll, reveal, scrollTo, openPath, openBeside, rehome, targetFolder, isFolder, kindOf,
    restart, startRename, abort, check, confirm, erase, deposit, importing, copy, cut, insert,
    emptyClipboard: () => setClipboard(null), copyPath, uploadIn: performUpload,
  };
}
export type Explorer = ReturnType<typeof useExplorer>;

/** The absolute location of the root (project or workspace) — null in a copy (it lies elsewhere than the main) or when it is missing. */
async function rootPath(apiBase: string, instance: string | null): Promise<string | null> {
  if (instance) return null;
  const pid = /^\/api\/projects\/([^/]+)$/.exec(apiBase)?.[1] ?? null;
  const wid = /^\/api\/workspaces\/([^/]+)$/.exec(apiBase)?.[1] ?? null;
  try {
    const list = await api<Workspace[]>("/api/workspaces");
    if (wid) return list.find((w) => w.id === wid)?.path ?? null;
    for (const w of list) { const p = w.projects.find((x) => x.id === pid); if (p) return p.path; }
  } catch { /* unknown */ }
  return null;
}
