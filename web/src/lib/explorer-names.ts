// Port of: microsoft/vscode src/vs/workbench/contrib/files/browser/fileActions.ts (MIT)
// Port of: microsoft/vscode src/vs/workbench/contrib/files/browser/fileImportExport.ts (MIT)
// Names in the explorer as in VS Code. Pure calculations, a leaf module without imports — tested in
// web/test/explorer-names.test.mjs (with sabotage), drawn in components/code/explorer/.
//
//   copyName        the next name of a copy like VS Code `incrementFileName` (explorer.incrementalNaming "simple"):
//                    "a.ts" → "a copy.ts" → "a copy 2.ts" → "a copy 3.ts"; a folder has no extension; ".env" → ".env copy".
//   freeCopyName  keep counting until the name is free in the target folder (paste into the same folder, duplicate, ⌥-drag).
//   wellFormed      the name as VS Code `getWellFormedFileName` takes it: tabs at the edge and trailing slashes drop.
//   checkName      the check of the field when renaming and creating, like VS Code `validateFileName`: errors (empty, a LEADING "/" or "\",
//                    already existing, a part that is "."/".."/empty) keep the field open, whitespace at the edge of a part is only a warning.
//                    A "/" INSIDE the name is allowed: "a/b.ts" creates the folders, "sub/x.ts" when renaming moves (`targetPath`).
//                    The text lives in the drawing code (via `t()`), only the code is here.
//   targetPath         the path an entered name means in the folder `parent` ("\" separates like "/").
//   nameSelection    what is preselected when renaming: the name without the last extension (folders and ".env": all of it).
//   depositPlan       what dragging, pasting and duplicating do: one request per topmost path, never into itself, an occupied name is
//                    "name copy.ext" when copying and "occupied" with its target when moving (the "Replace?" question is asked by
//                    useExplorer). An entry of unknown kind gets no copy name ("empty is not unknown": it would be counted as a file:
//                    "a.b" → "a copy.b" for a folder).

/** The last extension like node `path.extname`: from the last dot, but never a leading dot alone (".env" has none). */
export function suffixOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i);
}

const COPY = /^(.+ copy)( \d+)?$/;

/** The next copy name after VS Code ("simple"). */
export function copyName(name: string, isFolder: boolean): string {
  const suffix = isFolder ? "" : suffixOf(name);
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  const m = COPY.exec(stem);
  if (m) {
    const n = m[2] ? parseInt(m[2], 10) : 1;
    return `${m[1]} ${n + 1}${suffix}`;
  }
  return `${stem} copy${suffix}`;
}

/** A copy name that is free in the target folder; `existing` are the names there. Gives up after 10,000 tries (null). */
export function freeCopyName(name: string, isFolder: boolean, existing: ReadonlySet<string> | readonly string[]): string | null {
  const occupied = existing instanceof Set ? existing : new Set(existing as readonly string[]);
  let n = copyName(name, isFolder);
  for (let i = 0; i < 10_000; i++) {
    if (!occupied.has(n)) return n;
    n = copyName(n, isFolder);
  }
  return null;
}

export type NameError = "empty" | "slash" | "invalid" | "existing";
export type NameCheck = { error: NameError | null; warning: "margin" | null };

/** VS Code `getWellFormedFileName`: tabs at the edge and trailing slashes drop (nothing else — edge whitespace stays, it warns). */
export function wellFormed(name: string): string {
  return name.replace(/^\t+|\t+$/g, "").replace(/\/+$/, "").replace(/\\+$/, "");
}

/** A part of a name like VS Code `isValidBasename` (POSIX): not empty, not only whitespace, not "."/"..", at most 255 characters. */
const validPart = (t: string) => t.length > 0 && t.length <= 255 && !/^\s+$/.test(t) && t !== "." && t !== ".." && !t.includes("\u0000");

/**
 * The check of an entered name like VS Code `validateFileName`. `existing` are the names in the target folder; `old` is the previous
 * name when renaming (it does not count as "already existing"). The well-formed name is checked — edge whitespace is not silently
 * trimmed, it warns.
 */
export function checkName(raw: string, existing: readonly string[], old: string | null = null): NameCheck {
  const name = wellFormed(raw);
  if (!name || /^\s+$/.test(name)) return { error: "empty", warning: null };
  if (name[0] === "/" || name[0] === "\\") return { error: "slash", warning: null };
  if (name !== old && existing.includes(name)) return { error: "existing", warning: null };
  const parts = name.split(/[\\/]/);
  if (parts.some((t) => !validPart(t))) return { error: "invalid", warning: null };
  if (parts.some((t) => /^\s|\s$/.test(t))) return { error: null, warning: "margin" };
  return { error: null, warning: null };
}

/** The path an entered name means in the folder `parent`: well-formed, "\" like "/" ("a/b.ts" creates `a` too). */
export function targetPath(parent: string, raw: string): string {
  const name = wellFormed(raw).split(/[\\/]/).join("/");
  return parent ? `${parent}/${name}` : name;
}

const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Only the topmost paths: a path below another in the list goes with it (and duplicates drop). */
export function topmost(paths: readonly string[]): string[] {
  const set = [...new Set(paths)];
  return set.filter((p) => !set.some((q) => q !== p && p.startsWith(`${q}/`)));
}

export type Deposit = { from: string; to: string };
export type Omitted = { from: string; reason: "itself" | "same-folder" | "occupied" | "unknown"; to?: string };

/**
 * What a drag, a paste after cut/copy or a duplicate into the folder `target` does — per topmost path ONE request `{from, to}` to
 * `/files/rename` (move) or `/files/copy` (copy). `existing` are the names in the target folder.
 *   move: never into itself or an own subfolder ("itself"); into the own folder there is nothing to do ("same-folder"); an occupied
 *         name is not overwritten ("occupied" — the server would refuse it anyway).
 *   copy: never into itself; an occupied name (also in the own folder) gets the next free copy name like VS Code.
 */
export function depositPlan(sources: readonly string[], target: string, kind: "move" | "copy", existing: readonly string[],
  kindOf: (path: string) => "dir" | "file" | null): { ops: Deposit[]; omitted: Omitted[] } {
  const occupied = new Set(existing);
  const ops: Deposit[] = [];
  const omitted: Omitted[] = [];
  for (const from of topmost(sources)) {
    if (target === from || target.startsWith(`${from}/`)) { omitted.push({ from, reason: "itself" }); continue; }
    let name = nameOf(from);
    if (kind === "move") {
      if (parentOf(from) === target) { omitted.push({ from, reason: "same-folder" }); continue; }
      // Replacing would mean deleting the target — if the source lies inside it ("a/a" into the root next to "a"), it would go too: never.
      if (occupied.has(name) && from.startsWith(`${target ? `${target}/` : ""}${name}/`)) { omitted.push({ from, reason: "itself" }); continue; }
      if (occupied.has(name)) { omitted.push({ from, reason: "occupied", to: target ? `${target}/${name}` : name }); continue; }
    } else if (occupied.has(name)) {
      const type = kindOf(from);
      if (type === null) { omitted.push({ from, reason: "unknown" }); continue; }
      const free = freeCopyName(name, type === "dir", occupied);
      if (free === null) { omitted.push({ from, reason: "occupied" }); continue; }
      name = free;
    }
    occupied.add(name);
    ops.push({ from, to: target ? `${target}/${name}` : name });
  }
  return { ops, omitted };
}

/** One entry of an import: source, target, kind; `replace` = the name is occupied in the target folder (the "Replace?" question); `error` =
 *  it could never work (VS Code `IFileService` `unableToMoveCopyError2`/`4`): "itself" — the target lies inside the source; "contained" —
 *  replacing would delete the folder the source lies in. */
export type Import = { from: string; to: string; kind: "dir" | "file"; replace: boolean; error: "itself" | "contained" | null };

/**
 * A drop from the explorer of ANOTHER window at the same location, like VS Code `ExternalFileImport` (fileImportExport.ts): a drag from
 * another window is there `NativeDragAndDropData` (the list's drag state only holds within its own window), so not a move but
 * `importResources` — EVERY source is COPIED into `target` under ITS name (`ResourceFileEdit(…, { overwrite: true, copy: true })`), ⌥
 * changes nothing. Unlike copying within the explorer there is no copy name: an occupied name asks "Replace?" (`replace`), an unknown
 * entry is missing (`missing`: VS Code `fileService.exists`). `folderAtRoot`: a folder dropped on the root first asks "Do you want to
 * copy …?" (`doImport`, `target.isRoot`). `kindOf` knows existence and kind per source (freshly read); `existing` are the names in the
 * target folder.
 */
export function importPlan(sources: readonly string[], target: string, existing: readonly string[], kindOf: (path: string) => "dir" | "file" | null):
  { ops: Import[]; missing: string[]; folderAtRoot: boolean } {
  const occupied = new Set(existing);
  const ops: Import[] = [];
  const missing: string[] = [];
  for (const from of topmost(sources)) {
    const kind = kindOf(from);
    if (kind === null) { missing.push(from); continue; }
    const name = nameOf(from);
    const to = target ? `${target}/${name}` : name;
    const replace = occupied.has(name);
    const error = target === from || target.startsWith(`${from}/`) ? "itself" : replace && from.startsWith(`${to}/`) ? "contained" : null;
    ops.push({ from, to, kind, replace, error });
  }
  return { ops, missing, folderAtRoot: target === "" && ops.some((o) => o.kind === "dir") };
}

/** The preselection when renaming as [start, end]: files without their last extension, folders and names without extension entirely. */
export function nameSelection(name: string, isFolder: boolean): [number, number] {
  if (isFolder) return [0, name.length];
  const suffix = suffixOf(name);
  return [0, name.length - suffix.length];
}
