// The state of a file in the editor — ONE calculation for the file tab (components/CodePane.tsx: driven in the chat AND on Coding → Files)
// and the editable right side of the diff tab (components/code/DiffTab.tsx):
//
// - LINE ENDINGS: CodeMirror internally holds only "\n" — a file with CRLF used to appear unsaved right after loading (editor "\n", saved
//   "\r\n"), and saving wrote every line back with "\n". Now: when reading, REMEMBER the line ending (`lineEndingOf`, the majority), keep
//   the text normalized (`norm`) and restore it when writing (`withLineEnding`). Only the normalized text is compared.
// - PRECONDITION: `GET …/files/read` names `sha` (sha256 of the delivered content, server files.js `contentSha`), `PUT …/files/write` takes
//   it as `base` — if the file has changed in the meantime (an agent wrote), the server answers 409 `CHANGED` instead of silently
//   overwriting (`isChangedError`). "Keep mine" is a deliberate overwrite: afterwards WITHOUT a precondition.
// - DRAFT on first load (`withDraft`): the remembered draft carries its base. If it is still the disk, it is simply unsaved; if the disk
//   has changed since, the BASE counts as saved and the notice "reload / keep mine" stands (nothing silently overwritten or discarded); if
//   the file is gone, the draft stays with the notice "deleted".
// - RE-READ (`afterReread`): an editor whose text differs from the saved one is NEVER replaced — not even if the file has been deleted in
//   the meantime; then the notice stands. Unsaved is what the editor shows NOW, not a flag.
// - AFTER SAVING (`afterSave`): clean only if the editor still shows exactly what was saved — keystrokes between ⌘S and the answer stay
//   unsaved.
// A LEAF module without imports; web/test/file-status.test.mjs transpiles and runs it.

export type LineEnding = "\n" | "\r\n";

/** The line ending of a file — the majority (on a tie CRLF: a file carrying CRLF is usually meant so). */
export function lineEndingOf(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf ? "\r\n" : "\n";
}
/** The text as CodeMirror holds it: only "\n" (even a lone "\r" is a line ending for CodeMirror). */
export const norm = (text: string): string => text.replace(/\r\n?/g, "\n");
/** The normalized text with the file's line ending — this is how it goes to disk. */
export const withLineEnding = (text: string, ze: LineEnding): string => (ze === "\n" ? text : norm(text).replace(/\n/g, "\r\n"));

const SHA = /^[0-9a-f]{64}$/;
/** A response of `GET …/files/read` as a state: normalized text, line ending, checksum (null: a server without `sha`). Null without text. */
export function fromReading(r: { content?: unknown; sha?: unknown } | null | undefined): { text: string; lineEnding: LineEnding; sha: string | null } | null {
  if (!r || typeof r.content !== "string") return null;
  return { text: norm(r.content), lineEnding: lineEndingOf(r.content), sha: typeof r.sha === "string" && SHA.test(r.sha) ? r.sha : null };
}
/** The body of `PUT …/files/write`: the text with the file's line ending, `base` only if one is known (otherwise without precondition). */
export function writeBody(path: string, text: string, ze: LineEnding, base: string | null): { path: string; content: string; base?: string } {
  return { path: path, content: withLineEnding(text, ze), ...(base && SHA.test(base) ? { base } : {}) };
}
/** The checksum from the response of `PUT …/files/write` (null: a server without `sha`). */
export function shaFromResponse(r: unknown): string | null {
  const s = (r as { sha?: unknown } | null)?.sha;
  return typeof s === "string" && SHA.test(s) ? s : null;
}
/** A 409 `CHANGED` from `PUT …/files/write` (the precondition `base` did not hold) — otherwise null. */
export function isChangedError(e: unknown): { current: string | null; missing: boolean } | null {
  const o = e as { httpStatus?: unknown; code?: unknown; current?: unknown; missing?: unknown } | null;
  if (!o || o.httpStatus !== 409 || o.code !== "CHANGED") return null;
  return { current: typeof o.current === "string" && SHA.test(o.current) ? o.current : null, missing: o.missing === true };
}

/** `GET …/files/read` of a file that does not (any longer) exist: the server answers 400 with the text of `stat` (ENOENT). Any other
 *  error is NOT a deletion — the editor stays as it is. */
export function isMissingReading(e: unknown): boolean {
  const o = e as { httpStatus?: unknown; message?: unknown } | null;
  return !!o && o.httpStatus === 400 && typeof o.message === "string" && /\bENOENT\b/.test(o.message);
}

/** What waits for the human's choice after reading: the disk has another text, or the file is gone. */
export type Inquiry = { kind: "changed"; text: string; sha: string | null } | { kind: "deleted" };
/** The disk: the normalized text with checksum, or null = the file does not (any longer) exist. */
export type Disk = { text: string; sha: string | null } | null;

/** First load WITH a remembered draft. Null: the draft does not count (none, or it equals the disk). */
export function withDraft(disk: Disk, e: { base: string; content: string } | null | undefined): { editor: string; saved: string; inquiry: Inquiry | null } | null {
  if (!e) return null;
  const content = norm(e.content), base = norm(e.base);
  if (disk === null) return { editor: content, saved: base, inquiry: { kind: "deleted" } };
  if (content === disk.text) return null;
  if (base === disk.text) return { editor: content, saved: disk.text, inquiry: null };
  return { editor: content, saved: base, inquiry: { kind: "changed", text: disk.text, sha: disk.sha } };
}

/**
 * Read again (following live, after a block, after saving) — what happens to the editor:
 *   "takeOver"   the editor is clean: it shows the disk (also a deleted file — that is then no question);
 *   "unchanged"  the disk is still the saved one: nothing to do;
 *   "clean"      the editor carries its own text, but the disk shows EXACTLY it (an agent wrote the same): saved := disk;
 *   "inquiries"  own text AND another disk (or none any more): the editor stays, the notice stands.
 * `editor` null = the editor is not (yet) there — like clean. `wayAccepted`: the human said "keep mine" to a deleted file — as long as it
 * stays gone, that is no new question (otherwise the notice would reappear after every check); if it comes back, it is compared against
 * its text as usual.
 */
export type Reread = { kind: "takeOver" } | { kind: "unchanged" } | { kind: "clean" } | { kind: "inquiries"; inquiry: Inquiry };
export function afterReread(saved: string, editor: string | null, disk: Disk, wayAccepted = false): Reread {
  const dirty = editor !== null && editor !== saved;
  if (!dirty) return disk !== null && disk.text === saved ? { kind: "unchanged" } : { kind: "takeOver" };
  if (disk === null) return wayAccepted ? { kind: "unchanged" } : { kind: "inquiries", inquiry: { kind: "deleted" } };
  if (disk.text === editor) return { kind: "clean" };
  if (disk.text === saved) return { kind: "unchanged" };
  return { kind: "inquiries", inquiry: { kind: "changed", text: disk.text, sha: disk.sha } };
}

/** After saving: clean only if the editor NOW still shows what was sent. */
export function afterSave(sent: string, editorNow: string | null): "clean" | "unsaved" {
  return editorNow === null || norm(editorNow) === norm(sent) ? "clean" : "unsaved";
}
