// ONE buffer per file in the whole window. Key: target (apiBase + instance) and path. The file tab in Coding → Files, the code tab in the
// chat, the editable side of the diff tab and later peek and rename are VIEWS of the same buffer: what one view types is immediately in
// all others; the “unsaved” dot comes from the buffer, not from the view. Between separate windows `basis`/409 still protects. This
// module lives per window (module singleton).
//
// THE STATE (`BufferStatus`, immutable, a new object per change): `text` (normalized to “\n”, what the views show), `saved` (the disk
// text `text` is based on), `base` (its sha256, the precondition of `PUT …/files/write`, null: none), `lineEnding`, `version` (counts
// EVERY change of `text`; the language service reconciles with it), `inquiry` (the disk carries a different text or the file is gone:
// the choice “reload / keep mine”), `storageError`. `dirty` is `text !== saved`, computed, no flag (keystrokes between ⌘S and the reply
// stay unsaved). The file-state computations (read, line ending, draft, re-read, write body, 409) live ONCE in lib/file-status.ts; here
// they are only applied.
//
// VIEWS (`connect`): a view reports what it typed (`ofView`) and receives what others typed (`apply`), never its own back. The
// CodeMirror part lives in components/code/buffer-view.ts (ONE extension for every view). `change` changes without a view (rename,
// code action): positions as offsets or as LSP areas (0-based, UTF-16).
//
// BACKGROUND TABS: if a buffer becomes unsaved through `change` (or a view without a tab, e.g. peek) while NO tab holds it, the
// triggering editor gets `openInBackground(p)`, which opens the file as an unsaved tab in the background (dot on the tab).
//
// LIFETIME: tabs (and other holders) hold a buffer (`hold`). When the last holder lets go and the buffer is clean (and no view is
// connected any more), it closes: `atClose` callbacks run (the language service then gets `close`). An UNSAVED buffer without a holder
// stays around (the chat that showed it is only detached; if it comes back it sees the same text); only `release({ dismiss: true })` of
// the last holder (the tab was really closed, the editor detached after a confirmed question) discards it. ⌥⌘S only saves what someone
// holds or what was opened as a background tab, never a buffer left lying (otherwise a discarded instance switch would write it later).
//
// A leaf module except for its computations (file-status, code-instance, diff-tab, api/core); web/test/buffer.test.mjs compiles it with
// tsc and runs it with a fake transport (two views, change without a view, 409, version), with counter-checks.
import { api } from "./api/core.js";
import { instancePath } from "./code-instance.js";
import {
  fromReading, isMissingReading, isChangedError, withDraft, afterReread, norm, writeBody, shaFromResponse, lineEndingOf,
  type Inquiry, type Reread, type Disk, type LineEnding,
} from "./file-status.js";
import { minimalChange } from "./diff-tab.js";

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Where the file lies: the route (project or workspace) and the instance (`<projectId>/<instance>`, null = the main one), as in CodePane.
 *  A file in a project's folder ALWAYS has its buffer under the project (the canonical identity), even if it is opened at workspace
 *  level; the mapping lives ONCE in lib/buffer-coordinates.ts. */
export type BufferTarget = { apiBase: string; instance: string | null };
export const sameTarget = (a: BufferTarget, b: BufferTarget): boolean => a.apiBase === b.apiBase && (a.instance ?? null) === (b.instance ?? null);
/** A change in offsets of the normalized text (UTF-16, like CodeMirror). */
export type Area = { from: number; to: number; insert: string };
/** LSP form: 0-based, `character` in UTF-16 units. */
export type LspPosition = { line: number; character: number };
export type LspChange = { range: { start: LspPosition; end: LspPosition }; newText: string };
export type Change = Area | LspChange;

export type SaveError = { kind: "first-select" } | { kind: "changed" } | { kind: "error"; text: string };
/** “nothing”: not loaded, read-only, or it is already saving. */
export type StorageResult = { kind: "saved" } | { kind: "nothing" } | SaveError;
/** A remembered draft: its own text, the base it rests on, and its checksum. `buffer`: the buffer it was written from (`Buffer.buffer`,
 *  per window); if it comes from the buffer that carries the file in the window NOW, the buffer is newer. */
export type BufferDraft = { base: string; content: string; sha?: string | null; buffer?: string | null };
export type FileMeta = { binary?: boolean; tooLarge?: boolean; image?: boolean; mime?: string; size?: number };
/** `draft`: “takenOver” = the draft is the state; “done” = it does not count (equal to the disk, its text is in the buffer, or it comes
 *  from exactly this buffer, which is newer): the holder forgets it; “deviating” = the buffer was already open in the window and carries
 *  its OWN unsaved text: nothing is replaced, the draft stays remembered (the holder does not overwrite it, `draftFremd`); “none”. */
export type LoadResult =
  | { kind: "text"; buffer: Buffer; draft: "none" | "takenOver" | "done" | "deviating" }
  | ({ kind: "file" } & FileMeta)
  | { kind: "error"; error: unknown };

export type BufferStatus = Readonly<{
  /** “empty”: not read yet (or no text file); “loading”; “da” (there). */
  state: "empty" | "loading" | "loaded";
  text: string;
  saved: string;
  base: string | null;
  lineEnding: LineEnding;
  version: number;
  inquiry: Inquiry | null;
  /** “keep mine” for a deleted file: as long as it stays gone, that is no new question. */
  wayAccepted: boolean;
  storageError: SaveError | null;
}>;

/** An editor that can open background tabs (CodePane, later the peek holder). */
export interface EditorHolder { openInBackground(p: Buffer): void }
/** A view of the buffer: receives foreign changes (in offsets of the text BEFORE the change, sorted, without overlap). */
export interface View {
  apply(changes: readonly Area[]): void;
  /** The editor the view stands in, for the background tab if no tab holds the buffer (peek). */
  readonly editor?: EditorHolder | null;
  /** Take a change as its OWN step (into the history, ⌘Z undoes it; rename in an already open file) and report it to the buffer as
   *  typed. false: not possible (currently shows a different text). Only the buffer's own history can do this
   *  (lib/buffer-history.ts: undo belongs to the buffer, as in VS Code to the model). */
  own?(changes: readonly Area[]): boolean;
  /** When the view last had focus (`newFocus()`, larger = later; missing = never); `change(…, { history })` takes the youngest. */
  readonly focus?: number;
}
export type Transport = <T = unknown>(url: string, opts?: RequestInit) => Promise<T>;
type NewReadKind = Reread["kind"];

// ── Computations ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Inserted text in the buffer's form (only “\n”): a formatter with CRLF (Prettier `endOfLine: crlf`, ruff `cr-lf`) would otherwise send
 *  “\r\n” into the buffer while CodeMirror normalizes its view; buffer and view would drift apart and ⌘S would write corrupted text. The
 *  disk's line ending is only restored by writing (lib/file-status.ts `withLineEnding`). */
const insert = (t: unknown): string => norm(String(t ?? ""));
export const bufferKey = (target: BufferTarget, path: string): string => JSON.stringify([target.apiBase, target.instance ?? "", path]);
const isLsp = (a: Change): a is LspChange => typeof (a as LspChange).range === "object" && (a as LspChange).range !== null;

/** LSP position → offset (a line or a character beyond the end clamps to the end, as LSP requires). */
export function offsetOf(rowsStarts: readonly number[], length: number, p: LspPosition): number {
  if (!Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) throw new RangeError("Invalid position");
  if (p.line >= rowsStarts.length) return length;
  const start = rowsStarts[p.line];
  const end = p.line + 1 < rowsStarts.length ? rowsStarts[p.line + 1] - 1 : length;
  return Math.min(start + p.character, end);
}
function rowsStartsOf(text: string): number[] {
  const s = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) s.push(i + 1);
  return s;
}
/** Arbitrary changes → areas in offsets, sorted (same place: insert before replace, otherwise input order), validated. */
export function asAreas(text: string, changes: readonly Change[]): Area[] {
  let starts: number[] | null = null;
  const raw = changes.map((a, i) => {
    if (!isLsp(a)) return { b: { from: a.from, to: a.to, insert: insert(a.insert) }, i };
    starts ??= rowsStartsOf(text);
    return { b: { from: offsetOf(starts, text.length, a.range.start), to: offsetOf(starts, text.length, a.range.end), insert: insert(a.newText) }, i };
  });
  raw.sort((x, y) => x.b.from - y.b.from || x.b.to - y.b.to || x.i - y.i);
  let end = 0;
  const out: Area[] = [];
  for (const { b } of raw) {
    if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from < 0 || b.to < b.from || b.to > text.length) throw new RangeError("Change outside the text");
    if (b.from < end) throw new RangeError("Changes overlap");
    end = b.to;
    if (b.from !== b.to || b.insert) out.push(b);
  }
  return out;
}
/** Apply sorted areas (from `asAreas`) to a text. */
export function applyToText(text: string, areas: readonly Area[]): string {
  let out = "", pos = 0;
  for (const b of areas) { out += text.slice(pos, b.from) + b.insert; pos = b.to; }
  return out + text.slice(pos);
}
const randomId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

// ── The window: registry, transport, callbacks ───────────────────────────────────────────────────────────────────────────────────
const REGISTER = new Map<string, Buffer>();
const CLOSE = new Set<(p: Buffer) => void>();
const RENAME = new Set<(target: BufferTarget, old: string, fresh: string, newTarget: BufferTarget) => void>();
const SAVED = new Set<(p: Buffer) => void>();
let transport: Transport = api;
/** For tests only: replace the way to the server (null = `api` again). */
export function setTransport(t: Transport | null): void { transport = t ?? api; }
/** For tests only: forget all buffers (without callbacks). */
export function forgetAllBuffers(): void { REGISTER.clear(); }
/** Runs when a buffer closes for good (the language service gets `close`). */
export function atClose(fn: (p: Buffer) => void): () => void { CLOSE.add(fn); return () => { CLOSE.delete(fn); }; }
/** Runs on every `renameBuffer` (file or folder; `newTarget` ≠ `target`: the file changed project); an editor's history moves along with
 *  it (components/code/navigation-connection.tsx). */
export function atRename(fn: (target: BufferTarget, old: string, fresh: string, newTarget: BufferTarget) => void): () => void { RENAME.add(fn); return () => { RENAME.delete(fn); }; }
/** Runs after every successful save of a buffer, whichever part of the window it came from (Coding → Files, a chat, ⌥⌘S, the right side
 *  of a diff): a comparison whose LEFT side is this file re-reads it (components/code/compare-connection.ts `useLeftSaved`). */
export function atSave(fn: (p: Buffer) => void): () => void { SAVED.add(fn); return () => { SAVED.delete(fn); }; }
let focusCounter = 0;
/** The next focus stamp of a view (`View.focus`): a number that only grows. */
export const newFocus = (): number => ++focusCounter;

const EMPTY: BufferStatus = { state: "empty", text: "", saved: "", base: null, lineEnding: "\n", version: 0, inquiry: null, wayAccepted: false, storageError: null };

export class Buffer {
  /** This buffer's identifier in this window: random, new per buffer. */
  readonly buffer: string = randomId();
  /** Read-only (external targets): no view types, `change` and saving do nothing. */
  readonly readonly: boolean;
  private targetValue: BufferTarget;
  private pathValue: string;
  private statusValue: BufferStatus = EMPTY;
  private readonly views = new Set<View>();
  private readonly subscribers = new Set<() => void>();
  private holderTab = 0;
  private holderOther = 0;
  private closed = false;
  private savesCurrently = false;
  /** Counts every save; a re-read that began BEFORE a save would be stale. */
  private writeSeq = 0;
  private loadRunning: Promise<LoadResult> | null = null;
  private loadingCurrently = false;
  private checkBackChain: Promise<unknown> = Promise.resolve();
  /** Opened as a background tab (`openInBackground`), since held by no tab; ⌥⌘S takes it along. */
  private inBackground = false;
  /** This buffer merges into another of the same file (`supersede`). */
  private supersededThrough: Buffer | null = null;

  constructor(target: BufferTarget, path: string, o: { readonly?: boolean } = {}) {
    this.targetValue = { apiBase: target.apiBase, instance: target.instance ?? null };
    this.pathValue = path;
    this.readonly = Boolean(o.readonly);
  }

  get target(): BufferTarget { return this.targetValue; }
  get path(): string { return this.pathValue; }
  get key(): string { return bufferKey(this.targetValue, this.pathValue); }
  get status(): BufferStatus { return this.statusValue; }
  get text(): string { return this.statusValue.text; }
  get version(): number { return this.statusValue.version; }
  get dirty(): boolean { return this.statusValue.state === "loaded" && this.statusValue.text !== this.statusValue.saved; }
  /** How many holders (tabs and others) hold it. */
  get holders(): number { return this.holderTab + this.holderOther; }
  get open(): boolean { return !this.closed; }
  /** Does ⌥⌘S take it along? Unsaved, writable, and someone holds it, or it was opened as a background tab. A superseded one whose text
   *  already stands in the new buffer does not (the new one writes it). */
  get saveForAll(): boolean { return this.dirty && !this.readonly && (this.holders > 0 || this.inBackground) && !this.standsIn(this.supersededThrough); }
  /** The buffer this one merges into (`supersede`); null: none. */
  get superseded(): Buffer | null { return this.supersededThrough; }
  /** The mark of a read: whoever reads the disk itself (diff tab) takes it BEFORE reading and passes it to `takeDisk`; a read that began
   *  before a save then does not count (as in `checkBack`). */
  readMarker(): number { return this.writeSeq; }

  /** Every change of the state (every keystroke too). */
  subscribe(fn: () => void): () => void { this.subscribers.add(fn); return () => { this.subscribers.delete(fn); }; }

  // ── Holders ──
  /** A tab (or another holder, e.g. peek) holds the buffer. `release({ dismiss: true })` = the tab was really closed. */
  hold(kind: "tab" | "other" = "tab"): (o?: { dismiss?: boolean }) => void {
    this.againOpen();
    if (kind === "tab") { this.holderTab += 1; this.inBackground = false; } else this.holderOther += 1;
    let released = false;
    return (o = {}) => {
      if (released) return;
      released = true;
      if (kind === "tab") this.holderTab -= 1; else this.holderOther -= 1;
      if (o.dismiss && this.holders === 0 && this.dirty) this.dismiss();
      this.checkClose();
    };
  }

  // ── Views ──
  connect(a: View): () => void {
    this.views.add(a);
    return () => { if (this.views.delete(a)) this.checkClose(); };
  }
  /** A view typed: in offsets of its text BEFORE the change (the buffer's text). */
  ofView(a: View, changes: readonly Area[]): void {
    if (this.statusValue.state !== "loaded") return;
    this.applyAreas(asAreas(this.statusValue.text, changes), a, a.editor ?? null);
  }
  /** Change without a view (rename, code action, peek without a tab). `editor` opens the file as a background tab if no tab holds it.
   *  Throws for areas outside the text or overlap (then nothing is changed). false: not loaded/read-only.
   *  Whoever loads a file first for this holds it meanwhile (`const release = p.hold("other"); await p.load(); p.change(…); release();`):
   *  a buffer without a holder closes after loading; if a closed one becomes unsaved it registers again, but `atClose` already ran.
   *  `history`: via the most recently focused view that can (`View.own`): one step in ITS history, ⌘Z there undoes it; without such a
   *  view via the buffer. */
  change(changes: readonly Change[], o: { editor?: EditorHolder | null; history?: boolean } = {}): boolean {
    if (this.statusValue.state !== "loaded" || this.readonly) return false;
    const b = asAreas(this.statusValue.text, changes);
    if (o.history && b.length) {
      const a = [...this.views].filter((x) => x.own).sort((x, y) => (y.focus ?? 0) - (x.focus ?? 0))[0];
      if (a?.own?.(b)) return true;
    }
    this.applyAreas(b, null, o.editor ?? null);
    return true;
  }
  /** Replace the whole text (formatting) as the smallest change, so cursors and scroll state of the views stay. */
  replaceText(fresh: string, o: { editor?: EditorHolder | null } = {}): boolean {
    const c = minimalChange(this.statusValue.text, norm(fresh));
    return c ? this.change([c], o) : false;
  }

  // ── Loading, re-reading, choice ──
  /** First load (via lib/file-status.ts). If the buffer already exists in the window, the draft does not count (“done”), and a passed
   *  disk is only checked. `disk`: the caller already read the file (diff tab); then no request of its own. */
  load(o: { draft?: BufferDraft | null; disk?: { disk: Disk; lineEnding?: LineEnding; marker?: number }; onError?: (e: unknown) => void } = {}): Promise<LoadResult> {
    if (this.statusValue.state === "loaded") {
      if (o.disk) this.takeDisk(o.disk.disk, o.disk.lineEnding, o.disk.marker);
      return Promise.resolve({ kind: "text", buffer: this, draft: o.draft ? this.takeDraft(o.draft) : "none" });
    }
    if (this.loadRunning) return this.loadRunning;
    this.loadingCurrently = true; // before any report: a buffer that is loading does not close
    this.set({ state: "loading" });
    this.loadRunning = this.loadNow(o).finally(() => { this.loadingCurrently = false; this.loadRunning = null; this.checkClose(); });
    return this.loadRunning;
  }
  private async loadNow(o: { draft?: BufferDraft | null; disk?: { disk: Disk; lineEnding?: LineEnding }; onError?: (e: unknown) => void }): Promise<LoadResult> {
    const e = o.draft ?? null;
    let disk: Disk;
    let ze: LineEnding;
    if (o.disk) {
      disk = o.disk.disk;
      ze = o.disk.lineEnding ?? lineEndingOf(e?.base ?? "");
    } else {
      try {
        const r = await this.calls<{ content?: unknown; sha?: unknown } & FileMeta>(`/files/read?path=${encodeURIComponent(this.pathValue)}`);
        if (r.binary || r.tooLarge || r.image) {
          this.set({ state: "empty" });
          return { kind: "file", binary: r.binary, tooLarge: r.tooLarge, image: r.image, mime: r.mime, size: r.size };
        }
        const l = fromReading(r); // normalized, with line ending and checksum
        disk = { text: l?.text ?? "", sha: l?.sha ?? null };
        ze = l?.lineEnding ?? "\n";
      } catch (err) {
        o.onError?.(err);
        // The file is gone but a draft exists: it stays, with the hint “deleted”. Any other error is none.
        if (!(e && isMissingReading(err))) { this.set({ state: "empty" }); return { kind: "error", error: err }; }
        disk = null;
        ze = lineEndingOf(e.base);
      }
    }
    // With a draft (lib/file-status.ts `withDraft`): if the draft still rests on the disk it is simply unsaved; otherwise its base counts as saved
    // (with its checksum), and the choice stands.
    const m = withDraft(disk, e);
    if (m && e) {
      this.setText(m.editor, { state: "loaded", saved: m.saved, base: m.inquiry ? e.sha ?? null : disk?.sha ?? null, lineEnding: ze, inquiry: m.inquiry, wayAccepted: false, storageError: null });
      return { kind: "text", buffer: this, draft: "takenOver" };
    }
    const text = disk?.text ?? "";
    this.setText(text, { state: "loaded", saved: text, base: disk?.sha ?? null, lineEnding: ze, inquiry: null, wayAccepted: false, storageError: null });
    return { kind: "text", buffer: this, draft: e ? "done" : "none" };
  }

  /** A draft for a buffer already open in the window. “done” only if its text is in the buffer: it comes from THIS buffer (`buffer`; the
   *  buffer is newer, even if saved or typed on since) or carries the same text. A clean buffer takes it like the first load
   *  (lib/file-status.ts `withDraft` against the disk the buffer knows; if it rests on it, it is simply unsaved, otherwise the choice
   *  stands). If the buffer itself carries unsaved text (or a choice), nothing is replaced: “deviating”, the draft stays remembered.
   *  Otherwise every draft would count as “done” and the holder would delete text that stood in no buffer (a second buffer of the same
   *  file after a relocation, a draft from an earlier session). */
  private takeDraft(e: BufferDraft): "done" | "takenOver" | "deviating" {
    const s = this.statusValue;
    if ((e.buffer && e.buffer === this.buffer) || norm(e.content) === s.text) return "done";
    if (this.dirty || s.inquiry || s.wayAccepted || this.readonly) return "deviating";
    const m = withDraft({ text: s.saved, sha: s.base }, e);
    if (!m) return "done";
    this.setText(m.editor, { saved: m.saved, base: m.inquiry ? e.sha ?? null : s.base, inquiry: m.inquiry, storageError: null });
    return "takenOver";
  }

  /** Re-read the disk (follow live, after a 409) and apply it (`takeDisk`). Runs queue up; a read that began before a save does not
   *  count. `ifText`: if the buffer still shows exactly this text, the disk wins (the server wrote it itself). */
  checkBack(o: { onError?: (e: unknown) => void; ifText?: string } = {}): Promise<NewReadKind | null> {
    const run = this.checkBackChain.then(() => this.lookAfter(o), () => this.lookAfter(o));
    this.checkBackChain = run.catch(() => null);
    return run;
  }
  private async lookAfter(o: { onError?: (e: unknown) => void; ifText?: string }): Promise<NewReadKind | null> {
    if (this.statusValue.state !== "loaded") return null;
    const seq = this.writeSeq;
    let disk: Disk = null;
    let ze: LineEnding | undefined;
    try {
      const r = await this.calls<{ content?: unknown; sha?: unknown } & FileMeta>(`/files/read?path=${encodeURIComponent(this.pathValue)}`);
      const l = r.binary || r.tooLarge ? null : fromReading(r);
      if (!l) return null;
      disk = { text: l.text, sha: l.sha };
      ze = l.lineEnding;
    } catch (err) {
      o.onError?.(err);
      if (!isMissingReading(err)) return null; // any other read error leaves everything as it is
    }
    if (seq !== this.writeSeq || this.savesCurrently) return null;
    if (o.ifText !== undefined && disk && this.statusValue.text === o.ifText) {
      this.setText(disk.text, { saved: disk.text, base: disk.sha, lineEnding: ze ?? this.statusValue.lineEnding, inquiry: null, wayAccepted: false });
      return "takeOver";
    }
    return this.takeDisk(disk, ze);
  }

  /** Apply a read disk (lib/file-status.ts `afterReread`): a buffer with its own text is NEVER replaced; a different disk or a deleted
   *  file waits as an inquiry. `disk` null = the file does not exist (any more). `marker` (`readMarker()` before reading): if it was
   *  saved since or is saving now, the disk is stale and nothing happens (null). */
  takeDisk(disk: Disk, lineEnding?: LineEnding, marker?: number): NewReadKind | null {
    const s = this.statusValue;
    if (s.state !== "loaded") return null;
    if (marker !== undefined && (marker !== this.writeSeq || this.savesCurrently)) return null;
    const ze = lineEnding ?? s.lineEnding;
    const n = afterReread(s.saved, s.text, disk, s.wayAccepted);
    if (n.kind === "inquiries") {
      const f = n.inquiry, old = s.inquiry;
      const equal = old?.kind === f.kind && (f.kind === "deleted" || (old?.kind === "changed" && old.text === f.text && old.sha === f.sha));
      if (!equal) this.set({ inquiry: f });
      return n.kind;
    }
    if (disk === null) return n.kind; // gone: a clean buffer stays put, an adopted one too
    if (n.kind === "takeOver") this.setText(disk.text, { saved: disk.text, base: disk.sha, lineEnding: ze, inquiry: null, wayAccepted: false });
    else if (n.kind === "clean") this.set({ saved: disk.text, base: disk.sha, lineEnding: ze, inquiry: null, wayAccepted: false });
    // unchanged: the disk is still the saved one, so an open question resolves itself and checksum and line ending follow the disk (an
    // agent that only switches the line endings would otherwise make every save fail on a stale checksum).
    else if (s.inquiry || s.wayAccepted || s.base !== disk.sha || s.lineEnding !== ze) this.set({ inquiry: null, wayAccepted: false, base: disk.sha, lineEnding: ze });
    return n.kind;
  }

  /** “Reload”: the disk wins. For a deleted file: the text goes (the holder closes the tab or re-reads). */
  loadAgain(): void {
    const n = this.statusValue.inquiry;
    if (!n) return;
    const text = n.kind === "changed" ? n.text : "";
    this.setText(text, { saved: text, base: n.kind === "changed" ? n.sha : null, inquiry: null, wayAccepted: false, storageError: null });
  }
  /** “Keep mine”: overwrite on purpose; compared against the disk, saved WITHOUT a precondition. For a deleted file: saving recreates it. */
  keep(): void {
    const n = this.statusValue.inquiry;
    if (!n) return;
    this.set({ saved: n.kind === "changed" ? n.text : "", base: null, inquiry: null, wayAccepted: n.kind === "deleted", storageError: null });
  }
  /** Discard the unsaved text: the text becomes the saved one again. */
  dismiss(): void {
    if (this.statusValue.state !== "loaded") return;
    this.inBackground = false;
    this.setText(this.statusValue.saved, { inquiry: null, storageError: null });
  }
  forgetStorageError(): void { if (this.statusValue.storageError) this.set({ storageError: null }); }

  // ── Two buffers of the same file ──
  /** The list of projects changed and this buffer's new target already had a buffer (a chat opened the file before the list was read;
   *  lib/buffer-coordinates.ts `relocate`). This one merges into `through` WITHOUT losing text:
   *   “equal”       it carries nothing of its own (clean, or the same text as `through`): it gives way once nobody holds it;
   *   “takenOver”   `through` is clean and rests on the same disk: its text becomes this one's (unsaved), this one gives way;
   *   “separated”   both carry their own (or `through` is not loaded, or a choice stands): this one stays where it is, visible to ⌥⌘S
   *                 like a background tab, and whoever holds it keeps it; saving checks `basis`, the second gets 409 and the choice.
   *  If `through` is still loading, it is decided again after loading. Whoever holds it asks `superseded` (lib/buffer-coordinates.ts
   *  `tabBufferFor`) and switches as soon as nothing is lost; when the last one lets go, it only gives way if its text is in `through`. */
  supersede(through: Buffer): "equal" | "takenOver" | "separated" {
    if (through === this) return "equal";
    this.supersededThrough = through;
    const s = this.statusValue, d = through.statusValue;
    let kind: "equal" | "takenOver" | "separated";
    if (!this.dirty || this.standsIn(through)) kind = "equal";
    else if (d.state === "loaded" && !through.dirty && !through.readonly && !d.inquiry && !s.inquiry && d.saved === s.saved && through.replaceText(s.text)) kind = "takenOver";
    else {
      kind = "separated"; // without holder and view `checkClose` makes it a background tab (⌥⌘S)
      if (d.state === "loading") void through.load().then(() => { if (this.supersededThrough === through && !this.closed) this.supersede(through); }, () => {});
    }
    this.report(); // whoever holds it checks again
    this.checkClose(); // without holder and view: give way now (or stay, visible to ⌥⌘S)
    return kind;
  }
  /** Does this buffer's text already stand in `p` (loaded, the same text)? */
  private standsIn(p: Buffer | null): boolean { return Boolean(p && p !== this && p.statusValue.state === "loaded" && p.statusValue.text === this.statusValue.text); }

  // ── Saving ──
  /** Save with `basis`: 409 `CHANGED` ⇒ nothing written, re-read, the choice stands. An open choice blocks ⌘S.
   *  `prior` (format on save): its text only counts if the buffer still shows what was formatted. */
  async save(o: { prior?: (text: string) => Promise<string | null | undefined>; onError?: (e: unknown) => void } = {}): Promise<StorageResult> {
    const s0 = this.statusValue;
    if (s0.state !== "loaded" || this.readonly || this.savesCurrently) return { kind: "nothing" };
    if (s0.inquiry) { this.set({ storageError: { kind: "first-select" } }); return { kind: "first-select" }; }
    this.savesCurrently = true;
    try {
      if (o.prior) {
        const prior = this.statusValue.text;
        try {
          const f = await o.prior(prior);
          if (typeof f === "string" && this.statusValue.text === prior) this.replaceText(f);
        } catch { /* formatting failed: save anyway */ }
      }
      const s = this.statusValue;
      const text = s.text;
      try {
        const response = await this.calls(`/files/write`, { method: "PUT", body: JSON.stringify(writeBody(this.pathValue, text, s.lineEnding, s.base)) });
        this.writeSeq += 1;
        // `saved` is what was sent: if someone typed on meanwhile, the buffer stays unsaved.
        this.set({ saved: text, base: shaFromResponse(response), inquiry: null, wayAccepted: false, storageError: null });
        for (const fn of [...SAVED]) { try { fn(this); } catch { /* a callback does not stop saving */ } }
        return { kind: "saved" };
      } catch (e) {
        o.onError?.(e);
        if (isChangedError(e)) {
          // The file changed meanwhile (or was deleted): nothing was written; re-reading sets the choice.
          this.set({ storageError: { kind: "changed" } });
          this.savesCurrently = false;
          await this.checkBack({ onError: o.onError });
          return { kind: "changed" };
        }
        const f: SaveError = { kind: "error", text: String((e as Error)?.message ?? e) };
        this.set({ storageError: f });
        return f;
      }
    } finally {
      this.savesCurrently = false;
      this.checkClose();
    }
  }

  // ── Internal ──
  private calls<T = unknown>(rest: string, opts?: RequestInit): Promise<T> {
    return transport<T>(instancePath(`${this.targetValue.apiBase}${rest}`, this.targetValue.instance), opts);
  }
  private report(): void { for (const fn of [...this.subscribers]) fn(); }
  private set(part: Partial<BufferStatus>): void {
    this.statusValue = { ...this.statusValue, ...part };
    this.report();
    this.checkClose();
  }
  /** Bring the text to `fresh` (as the smallest change to all views) and set the rest of the state: ONE report. */
  private setText(fresh: string, part: Partial<BufferStatus>): void {
    const c = minimalChange(this.statusValue.text, fresh);
    if (c) this.applyAreas([c], null, null, part);
    else this.set(part);
  }
  private applyAreas(areas: readonly Area[], source: View | null, editor: EditorHolder | null, part: Partial<BufferStatus> = {}): void {
    if (!areas.length) { if (Object.keys(part).length) this.set(part); return; }
    const s = this.statusValue;
    this.statusValue = { ...s, ...part, text: applyToText(s.text, areas), version: s.version + 1 };
    if (this.dirty) this.againOpen(); // a closed buffer that receives unsaved text belongs in the window again
    for (const a of [...this.views]) if (a !== source) a.apply(areas);
    // Unsaved but no tab holds it: the triggering editor opens it as a background tab.
    if (editor && this.dirty && this.holderTab === 0) { this.inBackground = true; editor.openInBackground(this); }
    this.report();
    this.checkClose();
  }
  private againOpen(): void {
    if (!this.closed || REGISTER.has(this.key)) return;
    this.closed = false;
    REGISTER.set(this.key, this);
  }
  private checkClose(): void {
    if (this.closed || this.holders > 0 || this.views.size > 0 || this.savesCurrently || this.loadingCurrently) return;
    // Superseded: if its text is in the new buffer, it gives way; otherwise it stays visible to ⌥⌘S (never silently discarded).
    if (this.dirty && this.supersededThrough) { if (this.standsIn(this.supersededThrough)) { this.dismiss(); return; } this.inBackground = true; }
    if (this.dirty) return; // unsaved without a holder: left lying (the chat is only detached; ⌥⌘S saves it)
    this.closed = true;
    if (REGISTER.get(this.key) === this) REGISTER.delete(this.key);
    for (const fn of [...CLOSE]) { try { fn(this); } catch { /* a callback does not stop closing */ } }
  }
  /** Only for `renameBuffer` (`target`: the file changed project, lib/buffer-coordinates.ts). */
  move(fresh: string, target: BufferTarget = this.targetValue): void { this.targetValue = { apiBase: target.apiBase, instance: target.instance ?? null }; this.pathValue = fresh; this.report(); }
}

// ── The registry ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The buffer of a file, created if the window does not have it yet (not loaded yet: `load`). */
export function buffer(target: BufferTarget, path: string, o: { readonly?: boolean } = {}): Buffer {
  const k = bufferKey(target, path);
  let p = REGISTER.get(k);
  if (!p) { p = new Buffer(target, path, o); REGISTER.set(k, p); }
  return p;
}
export const findBuffer = (target: BufferTarget, path: string): Buffer | null => REGISTER.get(bufferKey(target, path)) ?? null;
export const allBuffers = (): Buffer[] => [...REGISTER.values()];
/** A remembered draft that does NOT come from this buffer and carries a different text (`load` said “deviating”): the holder does not
 *  overwrite it with the buffer's text, otherwise it would be lost. */
export const draftForeign = (e: BufferDraft | null | undefined, p: Buffer): boolean => Boolean(e && e.buffer !== p.buffer && norm(e.content) !== p.text);
/** Fetch and load in one; see `Buffer.load`. */
export const loadBuffer = (target: BufferTarget, path: string, o?: Parameters<Buffer["load"]>[0]): Promise<LoadResult> => buffer(target, path).load(o);
/** Change without a view; see `Buffer.change`. */
export const change = (p: Buffer, changes: readonly Change[], o?: { editor?: EditorHolder | null; history?: boolean }): boolean => p.change(changes, o);

/** ⌥⌘S: save every unsaved buffer of the window that someone holds or that was opened as a background tab (`saveAll`; never one left
 *  lying, e.g. after a confirmed discard of a detached editor), per file with `basis`; a 409 only leaves that file unsaved (its
 *  `storageError` says so, the choice stands). */
export async function saveAll(o: { onError?: (e: unknown) => void } = {}): Promise<{ buffer: Buffer; result: StorageResult }[]> {
  const open = allBuffers().filter((p) => p.saveForAll);
  return Promise.all(open.map(async (p) => ({ buffer: p, result: await p.save({ onError: o.onError }) })));
}

/** The path of a file after `renameBuffer(…, old, fresh, …)` (old empty: the whole target moves under `fresh`); null: the rename does not touch it. */
export function renamedPath(path: string, old: string, fresh: string): string | null {
  if (old && path !== old && !path.startsWith(`${old}/`)) return null;
  return old ? fresh + path.slice(old.length) : fresh ? `${fresh}/${path}` : path;
}
/** The key after `renameBuffer(target, old, fresh, newTarget)` for a stock keyed like the buffer (the problem count, the git base); null:
 *  the rename does not touch it. The SAME computation as the relocation of the buffers themselves. */
export function renamedKey(key: string, target: BufferTarget, old: string, fresh: string, newTarget: BufferTarget = target): string | null {
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== target.apiBase || parts[1] !== (target.instance ?? "") || typeof parts[2] !== "string") return null;
  const path2 = renamedPath(parts[2], old, fresh);
  return path2 === null ? null : bufferKey(newTarget, path2);
}

/** A file or folder was renamed: the buffers below it move along (a target that already has a buffer stays untouched). `newTarget`: the
 *  file lies in a different project afterwards (or in none): the buffer relocates there with its text; `old` empty then means “the whole
 *  target” (a project folder was renamed). Which target applies is computed in lib/buffer-coordinates.ts. */
export function renameBuffer(target: BufferTarget, old: string, fresh: string, newTarget: BufferTarget = target): void {
  const z2 = { apiBase: newTarget.apiBase, instance: newTarget.instance ?? null };
  if (sameTarget(target, z2) && (!old || old === fresh)) return;
  for (const fn of [...RENAME]) { try { fn(target, old, fresh, z2); } catch { /* a listener does not stop the rename */ } }
  for (const p of allBuffers()) {
    if (!sameTarget(p.target, target)) continue;
    const target2 = renamedPath(p.path, old, fresh);
    if (target2 === null) continue;
    const k = bufferKey(z2, target2);
    if (REGISTER.has(k)) continue;
    REGISTER.delete(p.key);
    p.move(target2, z2);
    REGISTER.set(k, p);
  }
}
