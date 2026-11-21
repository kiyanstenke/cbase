// "Replace All" of the search across files, and its undo, styled like VS Code, over the BUFFER of each file (lib/buffer.ts), executed in
// web/test/file-search.test.mjs against a fake server.
//
//   - Exactly the SHOWN hits (`list`) are replaced, each only if at its place, with the SAME fields the search used (`fields`), exactly this
//     finding still stands (lib/file-search.ts `replacePlan`); otherwise it counts as `stale` and stays. So a list of "foo" with the fields
//     of "f" replaces nothing instead of every f, and the number in the question is the number that gets replaced.
//   - Per file: hold, load, change (`history`: into the history of the open view, where Cmd+Z takes it back), and save a file without
//     changes of its own at once, against its loaded base: if it has changed meanwhile (409), nothing is overwritten, it joins as a tab
//     and its question ("reload / keep mine") stands there. A file that already carried unsaved changes stays unsaved (as in VS Code) and
//     joins as a tab.
//   - Undo (like Cmd+Z after "Replace All" in VS Code): the entry remembers per file the text before and after; only a file whose buffer
//     still carries exactly the text after goes back (otherwise "changed"), and what was saved is saved again.
import { replacePlan, type FileHits, type SearchOptions } from "./file-search.js";
import { buffer, type EditorHolder, type BufferTarget } from "./buffer.js";

export type ReplaceFile = { target: BufferTarget; path: string; display: string; prior: string; after: string; saved: boolean };
export type ReplaceEntry = { files: ReplaceFile[] };
export type ReplaceResult = {
  replaced: number;
  files: number;
  /** Hits at whose place something else stood by now; not replaced. */
  stale: number;
  /** Files (view path) that could not be saved (409, not loadable, read-only). */
  notSaved: string[];
  entry: ReplaceEntry | null;
};

export async function allReplace(o: {
  list: readonly FileHits[];
  fields: SearchOptions;
  replacement: string;
  preserved: boolean;
  /** View path → canonical place of the buffer (lib/buffer-coordinates.ts `toCanon`). */
  toCanon: (path: string) => { target: BufferTarget; path: string } | null;
  editor: EditorHolder;
}): Promise<ReplaceResult> {
  let replaced = 0, files = 0, stale = 0;
  const notSaved: string[] = [];
  const entry: ReplaceFile[] = [];
  for (const d of o.list) {
    const k = o.toCanon(d.path);
    if (!k) { notSaved.push(d.path); continue; }
    const p = buffer(k.target, k.path);
    const release = p.hold("other");
    try {
      await p.load();
      if (p.status.state !== "loaded" || p.readonly) { notSaved.push(d.path); continue; }
      const wasUnsaved = p.dirty;
      const prior = p.text;
      const plan = replacePlan(prior, d.hits, o.fields, o.replacement, o.preserved);
      stale += plan.stale;
      if (!plan.areas.length || !p.change(plan.areas, { history: true })) continue;
      replaced += plan.areas.length; files++;
      const after = p.text;
      if (wasUnsaved) { o.editor.openInBackground(p); entry.push({ target: k.target, path: k.path, display: d.path, prior, after, saved: false }); continue; }
      const s = await p.save();
      if (s.kind !== "saved" && s.kind !== "nothing") { notSaved.push(d.path); o.editor.openInBackground(p); } // 409: the question stands in the tab
      entry.push({ target: k.target, path: k.path, display: d.path, prior, after, saved: s.kind === "saved" });
    } finally { release(); }
  }
  return { replaced, files, stale, notSaved, entry: entry.length ? { files: entry } : null };
}

/** Undo "Replace All" (see header). `back`: files that carry their text from before again; `changed`: changed since, they stay. */
export async function undo(e: ReplaceEntry, ed: EditorHolder): Promise<{ back: number; changed: string[]; notSaved: string[] }> {
  let back = 0;
  const changed: string[] = [], notSaved: string[] = [];
  for (const d of e.files) {
    const p = buffer(d.target, d.path);
    const release = p.hold("other");
    try {
      await p.load();
      if (p.status.state !== "loaded" || p.text !== d.after) { changed.push(d.display); continue; }
      if (!p.replaceText(d.prior)) { changed.push(d.display); continue; }
      back++;
      if (!d.saved) { ed.openInBackground(p); continue; }
      const s = await p.save();
      if (s.kind !== "saved" && s.kind !== "nothing") { notSaved.push(d.display); ed.openInBackground(p); }
    } finally { release(); }
  }
  return { back, changed, notSaved };
}
