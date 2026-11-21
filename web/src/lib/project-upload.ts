// Read folders and files of a new project and upload them into the project container. A leaf without components: the UI
// (`components/projects/`) chooses, shows and asks; reading, the POST body and the upload live here.
//
//   1. read      readDirectory (showDirectoryPicker) or fromFileList (webkitdirectory, <input multiple>) → SelectedSource;
//                folders of the omit list (`GET /api/projectCreation/rules`) are not even entered, except in `.git`.
//                It also reads the content of every `.git` FILE so the layout can tell a submodule/worktree from a dead one.
//   2. create    creationBody(name, sources, selectionTree, plan) → `{ body, uploads }`: the sources in server numbering, per file
//                its target path from the mapping (`targetOf`, the longest prefix wins; the same computation as the preview).
//   3. upload    uploadSource: `begin` in batches of at most 5,000 paths (from the second on with `operation`), waiting for the ready
//                container meanwhile (409 NOT_READY), then chunks with `offset` to `POST /api/projects/:id/upload/:operation`
//                (small files collected up to 3 MB, large ones in 3 MB chunks), finally `finished`. The server writes ONLY into the
//                source's staging area; target path = path within it.
//
// Resuming: `begin` with `paths` returns the sizes of the files already STAGED. With `resume` a complete one is skipped and a started one
// continues from its size; without it every file starts at 0 (replace). A 409 OFFSET (the file has a different length on the server
// than assumed) resumes this one file from the reported size.
import { api, subscribeGlobalEvents } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { type SelectionTree, type Plan, type Rules, nameError, nameOf, normal, targetOf } from "@/lib/project-layout";
import { type ZipDirectory, fileReader, readSmallEntry, readZipDirectory, zipTargetName } from "@/lib/zip-directory";

export const CHUNK = 3 * 1024 * 1024;
export const PATHS_PER_STACK = 5000;
/** A `.git` FILE is one line `gitdir: …`; nothing more is ever read. */
const GIT_FILE_MAX = 4096;

export interface SelectedSource {
  kind: "folder" | "files" | "zip" | "clone";
  /** Folder: its name; files: empty; ZIP: the topmost folder in the project: the archive's top folder or the file name
   *  without `.zip`. */
  name: string;
  /** Paths UNDER the folder or the file names (ZIP: the archive paths under the top folder, or whole). */
  entries: { rel: string; size: number }[];
  /** rel → file (ZIP: empty; the archive goes up). */
  files: Map<string, File>;
  /** rel → content of every `.git` FILE. */
  gitContents: Record<string, string>;
  /** Folders of the omit list that were not entered at all while reading. */
  skippedFolder: number;
  /** ZIP only: the archive and what the mapping needs (`zipMapping`). */
  zip?: ZipSource;
  /** Clone only: the checked https address and the branch (empty = the remote's default branch). */
  clone?: { url: string; branch: string };
}

/** A clone source for the selection: without files (the content comes only in the container), `name` = default from the URL. */
export const cloneSource = (url: string, branch: string, name: string): SelectedSource => ({
  kind: "clone", name, entries: [], files: new Map(), gitContents: {}, skippedFolder: 0, clone: { url, branch },
});

export interface ZipSource {
  file: File;
  /** The archive's top folder, or null; then `name` is an imagined folder that does not exist in the archive. */
  parentFolder: string | null;
  /** Archive paths with a control character in a part (see `zipMapping`). */
  controlCharacters: string[];
}

export class UploadAborted extends Error {
  constructor() { super("aborted"); this.name = "UploadAborted"; }
}

export interface Abort { aborted: boolean }

type FileHandle = { kind: "file"; name: string; getFile: () => Promise<File> };
type FolderHandle = { kind: "directory"; name: string; entries: () => AsyncIterable<[string, FileHandle | FolderHandle]> };

/** Is there the folder dialog with a handle (Chromium, Electron)? Otherwise `webkitdirectory` remains. */
export const directoryChoicePossible = () =>
  typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** The folder dialog; `null` = cancelled. */
export async function selectDirectory(): Promise<FolderHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: string }) => Promise<FolderHandle> }).showDirectoryPicker;
  try { return await picker.call(window, { mode: "read" }); } catch { return null; }
}

/** The key of `files`: the same form under which the layout tracks a file (`rel` of its upload, NFC); a macOS name in NFD would
 *  otherwise never find its file. */
const key = (rel: string) => rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");

async function gitContent(f: File): Promise<string> {
  try { return await f.slice(0, GIT_FILE_MAX).text(); } catch { return ""; }
}

/** Read a chosen folder. `onCount` reports the count every 100 files (live counter while reading large trees). */
export async function readDirectory(
  folder: FolderHandle, rules: Rules, opts: { onCount?: (n: number) => void; abort?: Abort } = {},
): Promise<SelectedSource> {
  const q: SelectedSource = { kind: "folder", name: folder.name, entries: [], files: new Map(), gitContents: {}, skippedFolder: 0 };
  const omit = new Set(rules.omit.folder);
  const go = async (h: FolderHandle, prefix: string, inGit: boolean) => {
    for await (const [name, kind] of h.entries()) {
      if (opts.abort?.aborted) throw new UploadAborted();
      const rel = prefix + name;
      if (kind.kind === "directory") {
        // Nothing is omitted inside a repo's `.git`; it belongs to the repo.
        if (!inGit && omit.has(name)) { q.skippedFolder++; continue; }
        await go(kind, `${rel}/`, inGit || name === ".git");
        continue;
      }
      const f = await kind.getFile();
      q.entries.push({ rel, size: f.size });
      q.files.set(key(rel), f);
      if (name === ".git" && !inGit) q.gitContents[rel] = await gitContent(f);
      if (q.entries.length % 100 === 0) opts.onCount?.(q.entries.length);
    }
  };
  await go(folder, "", false);
  opts.onCount?.(q.entries.length);
  return q;
}

/** A file list from the browser: `webkitdirectory` (folder, first path part = folder name) or `<input multiple>` (files). */
export async function fromFileList(list: FileList | File[], kind: "folder" | "files"): Promise<SelectedSource | null> {
  const all = Array.from(list) as (File & { webkitRelativePath?: string })[];
  if (!all.length) return null;
  const q: SelectedSource = { kind, name: "", entries: [], files: new Map(), gitContents: {}, skippedFolder: 0 };
  for (const f of all) {
    let rel = f.name;
    if (kind === "folder") {
      const parts = (f.webkitRelativePath || f.name).split("/");
      if (!q.name) q.name = parts[0] || f.name;
      rel = parts.slice(1).join("/") || f.name;
    }
    if (q.files.has(key(rel))) continue;
    q.entries.push({ rel, size: f.size });
    q.files.set(key(rel), f);
    const t = rel.split("/");
    if (t[t.length - 1] === ".git" && !t.slice(0, -1).includes(".git")) q.gitContents[rel] = await gitContent(f);
  }
  return q;
}

/** The error of a ZIP that the provisioner would certainly reject (pre-check); the source does not even enter the list. */
export class ZipDenied extends Error {
  reason: NonNullable<ZipDirectory["denied"]>["reason"];
  names: string[];
  constructor(a: NonNullable<ZipDirectory["denied"]>) { super(a.reason); this.name = "ZipDenied"; this.reason = a.reason; this.names = a.names; }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A ZIP as a source: the central directory, without unpacking (`lib/zip-directory.ts`). For the layout a ZIP is a FOLDER named `name`:
 * the same computation, the same default (code repo unless it contains repos); only `zipMapping` translates the origin into archive
 * paths. `__MACOSX/` does not come along; an entry outside the top folder does not exist then (otherwise it would not be one).
 * Throws `ZipError` (no/broken archive) or `ZipDenied`.
 */
export async function readZip(file: File): Promise<SelectedSource> {
  const read = fileReader(file);
  const v = await readZipDirectory(file.size, read);
  if (v.denied) throw new ZipDenied(v.denied);
  const name = v.parentFolder ?? zipTargetName(file.name);
  const q: SelectedSource = {
    kind: "zip", name, entries: [], files: new Map(), gitContents: {}, skippedFolder: 0,
    zip: { file, parentFolder: v.parentFolder, controlCharacters: [] },
  };
  for (const e of v.entries) {
    const parts = e.name.split("/");
    if (parts[0] === "__MACOSX") continue;
    if (parts.some((t) => CONTROL.test(t))) q.zip!.controlCharacters.push(e.name);
    if (e.folder) continue;
    // Beside the top folder lies only what the server omits anyway (`.DS_Store`, otherwise there would be no top folder).
    if (v.parentFolder && !e.name.startsWith(`${v.parentFolder}/`)) continue;
    const rel = v.parentFolder ? e.name.slice(v.parentFolder.length + 1) : e.name;
    if (!rel) continue;
    q.entries.push({ rel, size: e.size });
    const t = rel.split("/");
    if (t[t.length - 1] === ".git" && !t.slice(0, -1).includes(".git")) q.gitContents[rel] = (await readSmallEntry(e, read)) ?? "";
  }
  return q;
}

/**
 * PURE: the mapping of a ZIP for the POST, from the plan's mapping (origin = `name/…`, as with a folder) into archive paths
 * (per ZIP the mapping `[{ from: <archive path prefix>, to }]`):
 * - with a top folder the origin already is the archive path;
 * - without one, `name` is imagined: its prefix drops, and its own entry becomes `from: ""`, the archive root, allowed exactly once for
 *   the server (a flat archive with more than 50,000 files used to blow the mapping cap with one entry per first path part); the longest
 *   prefix wins, so explicit entries below it come first;
 * - every file the layout leaves out with NAME_OMITTED (`withoutName`: control characters inside a code repo; the server does not accept
 *   the name, and it is no node one could leave out) gets `to: null`, as with a folder that does not upload it at all. Only paths of this
 *   archive; a second source of the same name carries the same origin.
 */
export function zipMapping(
  q: SelectedSource, mapping: { from: string; to: string | null }[], withoutName: string[],
): { from: string; to: string | null }[] {
  const z = q.zip!;
  const n = q.name.normalize("NFC");
  const archivePath = (h: string): string | null => (z.parentFolder ? h : h === n ? "" : h.startsWith(`${n}/`) ? h.slice(n.length + 1) : null);
  const out: { from: string; to: string | null }[] = [];
  for (const e of mapping) {
    const a = archivePath(e.from);
    if (a !== null) out.push({ from: a, to: e.to });
  }
  const uploaded = new Set(out.map((e) => e.from));
  const inArchive = new Set(z.controlCharacters);
  for (const h of withoutName) {
    const a = archivePath(h);
    if (a && inArchive.has(a) && !uploaded.has(a)) { uploaded.add(a); out.push({ from: a, to: null }); }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

// ── The POST body and the upload list per source ────────────────────────────────────────────────────────────────

export interface UploadFile { target: string; file: Blob; size: number }
/** `seq` = number at the server; `source` = number of the selection (key of the mapping in the plan). */
/** `archive`: ZIP only; the archive goes up, `files` is empty and `bytes` its size. */
/** `fresh`: ZIP only; upload the archive from the start at the server (it is cut to 0) instead of resuming from its size. */
export interface SourceUpload { seq: number; source: number; kind: "folder" | "files" | "zip"; target: string; files: UploadFile[]; bytes: number; archive?: File; fresh?: boolean }
export interface CreationBody {
  name: string;
  sources: (
    | { kind: "folder" | "files" | "zip"; target: string; name?: string; bytes: number; mapping?: { from: string; to: string | null }[] }
    | { kind: "clone"; target: string; name: string; clone: { url: string; branch?: string } }
  )[];
  codeRepos: string[];
}

/**
 * PURE except for the file objects: from selection, tree and plan the body of `POST /api/workspaces/:id/projects` and per source the files
 * with their target path. `sources[i].seq` is the number of the selection (`treeFromSelection`); the server renumbers the sent sources from
 * 1, and `uploads[].seq` is already the server's. A source without a single file that goes up drops out of the body.
 * A folder source whose top folder is in the final tree goes as `folder` with its final path; otherwise (it was left out, only parts
 * remain) as `files` into the root; each file's target comes from the mapping anyway.
 */
export function creationBody(
  name: string,
  sources: { seq: number; q: SelectedSource }[],
  tree: SelectionTree,
  plan: Plan,
): { body: CreationBody; uploads: SourceUpload[] } {
  const body: CreationBody = { name: name.trim(), sources: [], codeRepos: [...plan.codeRepos] };
  const uploads: SourceUpload[] = [];
  for (const { seq, q } of sources) {
    const mapping = plan.mapping[String(seq)] ?? [];
    if (q.clone) {
      // A clone is ONE node: its final path is `<place>/<name>`; if left out it drops out of the body. Nothing is uploaded, the server
      // clones in the container once it is ready. It is looked up under the SAME origin as the node (`normal`, project-layout.ts
      // treeFromSelection); if that is missing, the computation is wrong, not a leave-out (otherwise the clone would silently drop out of
      // the body).
      const top = mapping.find((e) => e.from === normal(q.name));
      if (!top) throw new Error(tr("Outline: no target for the repository “{name}” (source {seq})", { name: q.name, seq }));
      if (!top.to) continue;
      body.sources.push({ kind: "clone", target: top.to, name: nameOf(top.to), clone: q.clone.branch ? { url: q.clone.url, branch: q.clone.branch } : { url: q.clone.url } });
      continue;
    }
    if (q.zip) {
      // A ZIP goes up as a whole; the server unpacks it by the mapping. If no file remains, it drops out.
      const stays = (tree.upload[String(seq)] ?? []).some((d) => {
        const target = targetOf(mapping, d.origin);
        if (target === undefined) throw new Error(tr("Outline: no target for “{origin}” (source {seq})", { origin: d.origin, seq }));
        return target !== null;
      });
      if (!stays) continue;
      const top = mapping.find((e) => e.from === q.name.normalize("NFC"));
      const target = top && top.to ? top.to : "";
      const withoutName = tree.hints.filter((h) => h.code === "NAME_OMITTED" && h.path).map((h) => h.path as string);
      const source = { kind: "zip" as const, target, name: q.zip.file.name, bytes: q.zip.file.size, mapping: zipMapping(q, mapping, withoutName) };
      body.sources.push(source);
      uploads.push({ seq: body.sources.length, source: seq, kind: "zip", target, files: [], bytes: source.bytes, archive: q.zip.file });
      continue;
    }
    const files: UploadFile[] = [];
    for (const d of tree.upload[String(seq)] ?? []) {
      const target = targetOf(mapping, d.origin);
      if (target === null) continue;
      if (target === undefined) throw new Error(tr("Outline: no target for “{origin}” (source {seq})", { origin: d.origin, seq }));
      const file = q.files.get(d.rel);
      if (!file) throw new Error(tr("Selection: file “{rel}” is missing (source {seq})", { rel: d.rel, seq }));
      files.push({ target, file, size: file.size });
    }
    if (!files.length) continue;
    const bytes = files.reduce((s, d) => s + d.size, 0);
    // The top node of a folder source: its entry in the mapping, the only one without "/" (every origin of the source begins with the
    // folder name, and creation carries an entry for every top node).
    const top = q.kind === "folder" ? mapping.find((e) => !e.from.includes("/")) : undefined;
    const source = top && top.to
      ? { kind: "folder" as const, target: top.to, name: nameOf(top.to), bytes }
      : { kind: "files" as const, target: "", bytes };
    body.sources.push(source);
    uploads.push({ seq: body.sources.length, source: seq, kind: source.kind, target: source.target, files, bytes });
  }
  return { body, uploads };
}

// ── The upload of a source ──────────────────────────────────────────────────────────────────────────────────────────

export interface Progress { files: number; filesTotal: number; bytes: number; bytesTotal: number }

type UploadError = Error & { code?: string; size?: number; free?: number; needed?: number };

/** Waits for an event of this project (`project/setup`, `project/instance`) or at most `ms`. */
function waitForProject(projectId: string, ms: number): Promise<void> {
  return new Promise((finished) => {
    let at: () => void = () => {};
    const time = setTimeout(() => { at(); finished(); }, ms);
    at = subscribeGlobalEvents((evt) => {
      if ((evt.type === "project/setup" || evt.type === "project/instance") && String(evt.projectId ?? "") === projectId) {
        clearTimeout(time);
        at();
        finished();
      }
    });
  });
}

interface ProjectStatus { id: string; setup?: { state: string; code?: string; error?: string } }

/** `begin`, until the container is ready. Throws if the setup meanwhile ends in `error` (or the project is gone). */
async function begin(
  projectId: string, seq: number, body: Record<string, unknown>, abort?: Abort,
): Promise<{ operation: string; existing: { path: string; size: number }[] }> {
  for (;;) {
    if (abort?.aborted) throw new UploadAborted();
    try {
      return await api(`/api/projects/${projectId}/setup/sources/${seq}/begin`, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      // RUNNING: a setup step is working right now (container being created); wait as for the ready container.
      if ((e as UploadError).code !== "NOT_READY" && (e as UploadError).code !== "RUNNING") throw e;
    }
    const all = await api<ProjectStatus[]>("/api/projects").catch(() => null);
    if (all) {
      const p = all.find((x) => x.id === projectId);
      if (!p) throw Object.assign(new Error(tr("Project gone")), { code: "PROJECT_GONE" });
      if (!p.setup) throw Object.assign(new Error(tr("Setup already finished")), { code: "NO_SETUP" });
      if (p.setup.state === "error") {
        // In `error` the server carries only the reason; the display adds the prefix (`SETUP_ERROR`).
        throw Object.assign(new Error(p.setup.error || p.setup.code || tr("Setup failed")), { code: "SETUP_ERROR", reason: p.setup.error || p.setup.code || "" });
      }
    }
    await waitForProject(projectId, 5000);
  }
}

function bufferToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The chunks of ONE operation into its staging area (creation and later). `already` = the sizes of the files already STAGED (from
 * `begin`): with `resume` a complete one is skipped and a started one continues from its size; without it every file starts at 0
 * (replace). Small files starting at 0 go collected up to 3 MB, everything else singly with offset; a 409 OFFSET resumes this one file
 * from the reported size.
 */
async function chunksUp(o: {
  projectId: string; operation: string; files: UploadFile[]; already: Map<string, number>; resume: boolean;
  state: Progress; report: () => void; hold: () => void;
}): Promise<void> {
  const { projectId, operation, files: fileList, already: existing, state, report, hold } = o;
  // The operation is in the ADDRESS: the server stamps the request at its start, before the body ("busy"). In the body it would be
  // "unsettled" until reading ends and would hold every other source of the project with 409 UPLOAD_RUNNING for that long.
  const post = (files: { path: string; dataB64: string; offset: number }[]) =>
    api(`/api/projects/${projectId}/upload?operation=${encodeURIComponent(operation)}`, { method: "POST", body: JSON.stringify({ files }) });

  let batch: { path: string; dataB64: string; offset: number }[] = [];
  let batchBytes = 0;
  let collectedFiles = 0;
  const empty = async () => {
    if (!batch.length) return;
    const usable = batch; const b = batchBytes; const n = collectedFiles;
    batch = []; batchBytes = 0; collectedFiles = 0;
    await post(usable);
    state.bytes += b; state.files += n; report();
  };

  for (const d of fileList) {
    hold();
    const uploaded = existing.get(d.target);
    if (o.resume && uploaded === d.size) { state.files += 1; state.bytes += d.size; report(); continue; }
    let at = o.resume && uploaded !== undefined && uploaded < d.size ? uploaded : 0;
    if (at === 0 && d.size <= CHUNK) {
      if (batchBytes + d.size > CHUNK) await empty();
      batch.push({ path: d.target, dataB64: bufferToB64(await d.file.arrayBuffer()), offset: 0 });
      batchBytes += d.size;
      collectedFiles += 1;
      if (batchBytes >= CHUNK) await empty();
      continue;
    }
    await empty();
    state.bytes += at;
    let attempts = 0;
    while (at < d.size) {
      hold();
      const part = await d.file.slice(at, at + CHUNK).arrayBuffer();
      try {
        await post([{ path: d.target, dataB64: bufferToB64(part), offset: at }]);
      } catch (e) {
        const f = e as UploadError;
        if (f.code !== "OFFSET" || typeof f.size !== "number" || f.size > d.size || ++attempts > 3) throw e;
        state.bytes += f.size - at;
        at = f.size;
        report();
        continue;
      }
      at += part.byteLength;
      state.bytes += part.byteLength;
      report();
    }
    state.files += 1;
    report();
  }
  await empty();
}

/**
 * Uploads the files of ONE source into its staging area and reports it `finished`. Throws `UploadAborted` on `abort` (the source stays in
 * `wait-upload` and is resumable), otherwise the server's error (with `code`).
 */
export async function uploadSource(o: {
  projectId: string;
  seq: number;
  files: UploadFile[];
  resume?: boolean;
  onProgress?: (f: Progress) => void;
  abort?: Abort;
}): Promise<void> {
  const { projectId, seq, files, abort } = o;
  const bytesTotal = files.reduce((s, d) => s + d.size, 0);
  const state: Progress = { files: 0, filesTotal: files.length, bytes: 0, bytesTotal };
  const report = () => o.onProgress?.({ ...state });
  const hold = () => { if (abort?.aborted) throw new UploadAborted(); };

  // 1. begin, in batches, from the second on with the operation of the first.
  let operation = "";
  const existing = new Map<string, number>();
  for (let i = 0; i === 0 || i < files.length; i += PATHS_PER_STACK) {
    const paths = files.slice(i, i + PATHS_PER_STACK).map((d) => ({ path: d.target, size: d.size }));
    const r = await begin(projectId, seq, { bytes: bytesTotal, paths, ...(operation ? { operation } : {}) }, abort);
    operation = r.operation;
    for (const v of r.existing ?? []) existing.set(v.path, v.size);
  }
  report();

  // 2. chunks.
  await chunksUp({ projectId, operation, files, already: existing, resume: Boolean(o.resume), state, report, hold });

  // 3. finished: the source is staged, the setup continues.
  hold();
  await api(`/api/projects/${projectId}/setup/sources/${seq}/finished`, { method: "POST" });
}

/** The chunks of an archive from `at` to `POST …/archive` (creation and later). A 409 OFFSET resumes from the reported size (at most
 *  three times). `state.bytes` is the archive's size afterwards. */
async function archiveChunksUp(o: {
  projectId: string; archiveId: string; archive: Blob; at: number; state: Progress; report: () => void; hold: () => void;
}): Promise<void> {
  const { projectId, archiveId, archive, state, report, hold } = o;
  const total = archive.size;
  // The id is also in the ADDRESS: the server stamps the request before the body (like `?operation=` for a folder).
  const post = (offset: number, dataB64: string) =>
    api(`/api/projects/${projectId}/archive?archiveId=${encodeURIComponent(archiveId)}`, { method: "POST", body: JSON.stringify({ archiveId, offset, dataB64 }) });
  let at = o.at;
  let attempts = 0;
  state.bytes = at;
  while (at < total) { // a ZIP has at least 22 bytes (`readZipDirectory`); the first chunk at 0 always replaces
    hold();
    const part = await archive.slice(at, at + CHUNK).arrayBuffer();
    try {
      await post(at, bufferToB64(part));
    } catch (e) {
      const f = e as UploadError;
      if (f.code !== "OFFSET" || typeof f.size !== "number" || f.size > total || ++attempts > 3) throw e;
      at = f.size;
      state.bytes = at;
      report();
      continue;
    }
    at += part.byteLength;
    state.bytes = at;
    report();
  }
}

/**
 * Uploads the archive of ONE ZIP source and reports it `finished`; unpacking happens on the server. `begin` assigns the `archiveId` once per
 * source and names the size already there: it resumes from it, otherwise the first chunk starts at 0 (replace). A 409 OFFSET resumes from
 * the reported size. Throws `UploadAborted` or the server's error.
 */
export async function uploadArchive(o: {
  projectId: string;
  seq: number;
  archive: Blob;
  resume?: boolean;
  /** From the start: the server cuts the archive to 0 (`begin` with `fresh: true`); a different archive than the started one. */
  fresh?: boolean;
  onProgress?: (f: Progress) => void;
  abort?: Abort;
}): Promise<void> {
  const { projectId, seq, archive, abort } = o;
  const total = archive.size;
  const state: Progress = { files: 0, filesTotal: 1, bytes: 0, bytesTotal: total };
  const report = () => o.onProgress?.({ ...state });
  const hold = () => { if (abort?.aborted) throw new UploadAborted(); };

  // A different archive (different size) is rejected by the server without `fresh` with 409 ARCHIVE_DIFFERENT; it would hang onto the old start.
  // With `fresh` the file name goes along: the view shows it afterwards, and the next resume compares against it.
  const name = archive instanceof File ? archive.name : "";
  const r = await begin(projectId, seq, { bytes: total, ...(o.fresh ? { fresh: true, ...(name ? { name } : {}) } : {}) }, abort) as unknown as { archiveId: string; size?: number };
  const archiveId = String(r.archiveId || "");
  if (!archiveId) throw Object.assign(new Error(tr("The server did not assign an archive id")), { code: "ARCHIVE_FOREIGN" });
  const uploaded = Math.max(0, Math.floor(Number(r.size) || 0));
  let at = o.resume && !o.fresh && uploaded <= total ? uploaded : 0;
  state.bytes = at;
  report();
  let attempts = 0;
  for (;;) {
    await archiveChunksUp({ projectId, archiveId, archive, at, state, report, hold });
    hold();
    try {
      await api(`/api/projects/${projectId}/setup/sources/${seq}/finished`, { method: "POST", body: JSON.stringify({ archiveId, size: total }) });
      break;
    } catch (e) {
      // The server counts at the descriptor: if less lies there (a resume from a remembered state that no longer holds), it continues from
      // there; more than the archive would be a different archive, and no further chunk heals that.
      const f = e as UploadError;
      if (f.code !== "ARCHIVE_INCOMPLETE" || typeof f.size !== "number" || f.size >= total || ++attempts > 3) throw e;
      at = f.size;
      state.bytes = at;
      report();
    }
  }
  state.files = 1;
  report();
}

// ── "Resume upload" ─────────────────────────────────────────────────────────────────────────────────────
// After an aborted upload (tab closed, deploy, "Cancel") the person chooses the folder again. Where do the target paths come from? The
// creation mapping is remembered per project and server source in the browser; it carries every move of the preview. If it is missing
// (another device, deleted site data), the creation default applies: folder → `<target>/<path>`, files → root. What the mapping does
// not cover (another folder chosen) does not go up and is counted.

const rememberKey = (projectId: string, seq: number) => `cbase-creation-mapping:${projectId}:${seq}`;

// `kind` and `name` are those of the SELECTION (folder or files chosen), not of the server source: a folder whose top node was left out
// goes to the server as `files`, but its mapping begins with the folder name; it is resumed only with the folder dialog.

export function rememberMapping(projectId: string, seq: number, value: {
  kind: "folder" | "files" | "zip"; name: string; mapping: { from: string; to: string | null }[];
  /** ZIP only: size and modification time of the archive; together with the name the identity when resuming. */
  size?: number; changed?: number;
}) {
  try { localStorage.setItem(rememberKey(projectId, seq), JSON.stringify(value)); } catch { /* convenience only */ }
}

export function forgetMapping(projectId: string, seq: number) {
  try { localStorage.removeItem(rememberKey(projectId, seq)); } catch { /* */ }
}

/** Which dialog for "Resume upload": the remembered choice; older entries without a reliable `kind` are recognized by a
 *  "/" in the origin (only a folder selection carries the folder name in front). `null` = nothing remembered. */
export function rememberedChoice(projectId: string, seq: number): "folder" | "files" | "zip" | null {
  const g = rememberedMapping(projectId, seq);
  if (!g) return null;
  if (g.kind === "zip") return "zip";
  return g.kind === "folder" || g.mapping.some((e) => e.from.includes("/")) ? "folder" : "files";
}

/** Name, size and modification time of a ZIP source's remembered archive (whatever of it is remembered), or null. */
export function rememberedArchive(projectId: string, seq: number): { name: string; size?: number; changed?: number } | null {
  const g = rememberedMapping(projectId, seq);
  if (!g || g.kind !== "zip") return null;
  return {
    name: g.name,
    ...(typeof g.size === "number" ? { size: g.size } : {}),
    ...(typeof g.changed === "number" ? { changed: g.changed } : {}),
  };
}

/**
 * PURE: is the chosen archive demonstrably the one whose beginning already lies on the server? What is known is compared: name and size
 * from the server's view (`name`/`bytes` of a ZIP source; valid on every device), plus this browser's remembered state (name, size,
 * modification time). Without any information it is not demonstrable ⇒ false. Appending a different archive from `size` would mix two
 * archives; the caller then asks and uploads from the start (`fresh`).
 */
export function sameArchive(
  file: { name: string; size: number; lastModified?: number },
  server: { name?: string; bytes?: number },
  remembered: { name: string; size?: number; changed?: number } | null,
): boolean {
  const check: boolean[] = [];
  if (server.name) check.push(server.name === file.name);
  if (typeof server.bytes === "number") check.push(server.bytes === file.size);
  if (remembered) {
    check.push(remembered.name === file.name);
    if (typeof remembered.size === "number") check.push(remembered.size === file.size);
    if (typeof remembered.changed === "number" && typeof file.lastModified === "number") check.push(remembered.changed === file.lastModified);
  }
  return check.length > 0 && check.every(Boolean);
}

function rememberedMapping(projectId: string, seq: number): {
  kind: string; name: string; mapping: { from: string; to: string | null }[]; size?: number; changed?: number;
} | null {
  try {
    const w = JSON.parse(localStorage.getItem(rememberKey(projectId, seq)) || "null");
    return w && Array.isArray(w.mapping) ? w : null;
  } catch { return null; }
}

/**
 * The files of a newly chosen selection for a waiting source: origin as in creation (folder name + path, omit list; the same
 * computation via the caller's `treeFromSelection`: `upload` of a single source), target from the remembered mapping or the default.
 * → `{ files, notCaptured }`.
 */
export function resumptionFiles(
  projectId: string,
  source: { seq: number; kind: string; target: string },
  selected: SelectedSource,
  upload: { origin: string; rel: string }[],
): { files: UploadFile[]; notCaptured: number } {
  const remembered = rememberedMapping(projectId, source.seq);
  const preset = (origin: string) => {
    if (source.kind !== "folder") return origin;
    const i = origin.indexOf("/");
    return i < 0 ? source.target : `${source.target}/${origin.slice(i + 1)}`;
  };
  const files: UploadFile[] = [];
  let notCaptured = 0;
  for (const d of upload) {
    const target = remembered ? targetOf(remembered.mapping, d.origin) : preset(d.origin);
    if (target === null) continue;
    const file = selected.files.get(d.rel);
    if (target === undefined || !file) { notCaptured++; continue; }
    files.push({ target, file, size: file.size });
  }
  return { files, notCaptured };
}

// ── Uploading later ───────────────────────────────────────────────────────────────────
// Into an EXISTING project (setup finished, instance `ready`): every upload is an operation with its own staging area at the server
// (`POST /api/projects/:id/upload/begin`). The target is the root: files into the root, a folder to `<folder name>/`, a ZIP to
// `<top folder>/` or `<zip name>/`; no layout preview. If target files exist already, ONE question comes (`question`); "abort" discards
// the operation. Then `finished` or `archive/unpack`: the server places it in the container. `question` may end with `UploadAborted`
// instead of an answer (the row was aborted, the sheet closed): then the operation stays at the server and is resumable; halted, not
// discarded.

export type ConflictResponse = "overwrite" | "skip" | "abort";
/** The question: how many target files exist already, and up to five of them. */
export interface ConflictQuestion { existing: number; examples: string[] }
export type Result = "placed" | "dismissed";

/** PURE: the target paths of a selection for the later upload: the origin as the layout computes it (`treeFromSelection` of a single
 *  source: folder name + path, omit list, dead `.git` files and inside-invalid names gone). */
export function retroactiveFiles(q: SelectedSource, upload: { origin: string; rel: string }[]): UploadFile[] {
  const out: UploadFile[] = [];
  for (const d of upload) {
    const file = q.files.get(d.rel);
    if (file) out.push({ target: d.origin, file, size: file.size });
  }
  return out;
}

/**
 * PURE: why the server would not accept the target path `rel`, or null. The same rule as `rules.js` `uploadPath`: every part per
 * `nameError`; inside (from the second part on) `.git` and names with the cbase prefix are allowed. A single invalid path makes
 * `begin` reject the whole batch with 400 ("Icon\r" of a macOS folder with its own icon).
 */
export function targetError(rel: string, rules: Rules): string | null {
  if (!rel || rel.startsWith("/")) return "empty";
  const parts = rel.split("/");
  for (const [i, t] of parts.entries()) {
    const insideAllowed = i > 0 && (t === ".git" || t.toLowerCase().startsWith(rules.names.prefix));
    const f = nameError(insideAllowed ? `x${t}` : t, rules);
    if (f) return f;
  }
  return null;
}

/** PURE: the files whose target the server accepts, and the targets of the rest (they stay out; the caller tells the person). */
export function separateInvalid(files: UploadFile[], rules: Rules): { files: UploadFile[]; invalid: string[] } {
  const good: UploadFile[] = [];
  const invalid: string[] = [];
  for (const d of files) {
    if (targetError(d.target, rules)) invalid.push(d.target);
    else good.push(d);
  }
  return { files: good, invalid };
}

const dismiss = (projectId: string, operation: string) =>
  api(`/api/projects/${projectId}/upload/${operation}`, { method: "DELETE" }).catch(() => {});

/**
 * Upload files or a folder later. `operation` resumes an interrupted one: what is already staged does not go up again. `onOperation`
 * reports the id as soon as it exists (resuming after a closed tab). Throws `UploadAborted` (the operation stays and is resumable) or
 * the server's error.
 */
export async function uploadRetroactive(o: {
  projectId: string;
  files: UploadFile[];
  operation?: string;
  question: (f: ConflictQuestion) => Promise<ConflictResponse>;
  onOperation?: (operation: string) => void;
  onProgress?: (f: Progress) => void;
  abort?: Abort;
}): Promise<Result> {
  const { projectId, abort } = o;
  const hold = () => { if (abort?.aborted) throw new UploadAborted(); };

  // 1. begin, in batches, from the second on (and when resuming) with the operation.
  let operation = o.operation ?? "";
  let existing = 0;
  const examples: string[] = [];
  const existingPaths = new Set<string>();
  const already = new Map<string, number>();
  for (let i = 0; i === 0 || i < o.files.length; i += PATHS_PER_STACK) {
    hold();
    const paths = o.files.slice(i, i + PATHS_PER_STACK).map((d) => ({ path: d.target, size: d.size }));
    const r = await api<{ operation: string; existing: number; examples?: string[]; existingPaths?: string[]; staged?: { path: string; size: number }[] }>(
      `/api/projects/${projectId}/upload/begin`, { method: "POST", body: JSON.stringify({ paths, ...(operation ? { operation } : {}) }) });
    if (!operation) o.onOperation?.(r.operation);
    operation = r.operation;
    existing += Number(r.existing) || 0;
    for (const b of r.examples ?? []) if (examples.length < 5) examples.push(b);
    for (const p of r.existingPaths ?? []) existingPaths.add(p);
    for (const b of r.staged ?? []) already.set(b.path, b.size);
  }

  // 2. The question, once; "skip" does not upload the existing ones at all.
  let conflict: "overwrite" | "skip" | undefined;
  if (existing > 0) {
    const a = await o.question({ existing, examples });
    if (a === "abort") { await dismiss(projectId, operation); return "dismissed"; }
    conflict = a;
  }
  const files = conflict === "skip" ? o.files.filter((d) => !existingPaths.has(d.target)) : o.files;

  // 3. chunks, always with resume: in a new operation nothing is staged.
  const state: Progress = { files: 0, filesTotal: files.length, bytes: 0, bytesTotal: files.reduce((s, d) => s + d.size, 0) };
  const report = () => o.onProgress?.({ ...state });
  report();
  await chunksUp({ projectId, operation, files, already, resume: true, state, report, hold });

  // 4. finished: the server counts the conflicts against the root as of NOW; if one arose since `begin`, it asks (409 CONFLICT).
  hold();
  return finishedWithQuestion(projectId, operation, conflict, o.question, hold);
}

/**
 * `POST …/upload/:operation/finished`, on 409 CONFLICT with the question (once). Also "resume" of a placing. `hold` after the answer:
 * an abort while the question was open places nothing any more.
 */
export async function finishedWithQuestion(
  projectId: string, operation: string, conflict: "overwrite" | "skip" | undefined,
  question: (f: ConflictQuestion) => Promise<ConflictResponse>, hold: () => void = () => {},
): Promise<Result> {
  const finished = (k?: string) =>
    api(`/api/projects/${projectId}/upload/${operation}/finished`, { method: "POST", body: JSON.stringify(k ? { conflict: k } : {}) });
  try {
    await finished(conflict);
    return "placed";
  } catch (e) {
    const f = e as UploadError & { existing?: number; examples?: string[] };
    if (f.code !== "CONFLICT" || conflict) throw e;
    const a = await question({ existing: Number(f.existing) || 0, examples: Array.isArray(f.examples) ? f.examples.slice(0, 5) : [] });
    if (a === "abort") { await dismiss(projectId, operation); return "dismissed"; }
    hold();
    await finished(a);
    return "placed";
  }
}

/** What `POST …/archive/check` says about an archive. */
export interface ArchiveCheck {
  operation: string; target: string; parentFolder: boolean; files: number; folder: number; references: number;
  sizeDeclared: number; omitted: number; existing: number; examples: string[]; throughReference: number; hints: unknown[];
}

/**
 * Upload a ZIP later: `begin` with `archive` → chunks to `…/archive` → `archive/check` → question → `archive/unpack`. `operation`
 * resumes: the server names the size already there (it does not reject a different archive of the same size; the caller checks that it is
 * the same). Without a conflict it unpacks WITHOUT mode (the server takes "keep"): what only arises at the target during unpacking stays
 * staged and arrives as the question at the row; never silently discarded.
 */
export async function uploadRetroactiveArchive(o: {
  projectId: string;
  archive: File;
  operation?: string;
  question: (f: ConflictQuestion) => Promise<ConflictResponse>;
  onOperation?: (operation: string) => void;
  onProgress?: (f: Progress) => void;
  abort?: Abort;
}): Promise<Result> {
  const { projectId, archive, abort } = o;
  const hold = () => { if (abort?.aborted) throw new UploadAborted(); };
  const total = archive.size;
  const state: Progress = { files: 0, filesTotal: 1, bytes: 0, bytesTotal: total };
  const report = () => o.onProgress?.({ ...state });

  const r = await api<{ operation: string; archiveId: string; size?: number }>(`/api/projects/${projectId}/upload/begin`, {
    method: "POST", body: JSON.stringify({ archive: { bytes: total, name: archive.name }, ...(o.operation ? { operation: o.operation } : {}) }),
  });
  if (!o.operation) o.onOperation?.(r.operation);
  const operation = r.operation;
  const archiveId = String(r.archiveId || "");
  if (!archiveId) throw Object.assign(new Error(tr("The server did not assign an archive id")), { code: "ARCHIVE_FOREIGN" });
  let at = Math.min(total, Math.max(0, Math.floor(Number(r.size) || 0)));
  report();

  let check: ArchiveCheck | null = null;
  let attempts = 0;
  while (!check) {
    await archiveChunksUp({ projectId, archiveId, archive, at, state, report, hold });
    hold();
    try {
      check = await api<ArchiveCheck>(`/api/projects/${projectId}/archive/check`, { method: "POST", body: JSON.stringify({ operation }) });
    } catch (e) {
      const f = e as UploadError;
      if (f.code !== "ARCHIVE_INCOMPLETE" || typeof f.size !== "number" || f.size >= total || ++attempts > 3) throw e;
      at = f.size;
    }
  }
  hold(); // an abort during the check unpacks nothing any more
  state.files = 1;
  report();
  return unpackWithQuestion(projectId, check, o.question, hold);
}

/**
 * Question after the check, then `archive/unpack`. Also "resume" of a completely uploaded archive. `mode` goes along only if a person
 * answered; without it the server places "keep".
 */
export async function unpackWithQuestion(
  projectId: string, p: ArchiveCheck, question: (f: ConflictQuestion) => Promise<ConflictResponse>, hold: () => void = () => {},
): Promise<Result> {
  let mode: "overwrite" | "skip" | undefined;
  if (p.existing > 0) {
    const a = await question({ existing: p.existing, examples: (p.examples ?? []).slice(0, 5) });
    if (a === "abort") { await dismiss(projectId, p.operation); return "dismissed"; }
    mode = a;
  }
  hold();
  await api(`/api/projects/${projectId}/archive/unpack`, { method: "POST", body: JSON.stringify({ operation: p.operation, ...(mode ? { mode } : {}) }) });
  return "placed";
}

/** Resuming an archive in `upload` without a new choice: if it is already complete, the server checks it; `null` means "bytes are missing". */
export async function checkArchiveIfComplete(projectId: string, operation: string): Promise<ArchiveCheck | null> {
  try {
    return await api<ArchiveCheck>(`/api/projects/${projectId}/archive/check`, { method: "POST", body: JSON.stringify({ operation }) });
  } catch (e) {
    if ((e as UploadError).code === "ARCHIVE_INCOMPLETE") return null;
    throw e;
  }
}

// What a later operation was, remembered per operation in the browser so that "resume" opens the right dialog and a different archive or
// folder is noticed. If it is missing (another device), the server's view decides (`kind`, `newFolders`).
const operationKey = (projectId: string, operation: string) => `cbase-retroactive:${projectId}:${operation}`;
/** `deposit`: drag & drop of several entries (folders and files mixed); resuming goes through a new drop on the row, no file dialog
 *  carries these targets. */
export interface RememberedOperation { choice: "folder" | "files" | "zip" | "deposit"; name: string; size?: number; changed?: number }

export function rememberOperation(projectId: string, operation: string, w: RememberedOperation) {
  try { localStorage.setItem(operationKey(projectId, operation), JSON.stringify(w)); } catch { /* convenience only */ }
}
export function forgetOperation(projectId: string, operation: string) {
  try { localStorage.removeItem(operationKey(projectId, operation)); } catch { /* */ }
}
export function rememberedOperation(projectId: string, operation: string): RememberedOperation | null {
  try {
    const w = JSON.parse(localStorage.getItem(operationKey(projectId, operation)) || "null");
    return w && (w.choice === "folder" || w.choice === "files" || w.choice === "zip" || w.choice === "deposit") && typeof w.name === "string" ? w : null;
  } catch { return null; }
}

// ── Drag & drop (web) ────────────────────────────────────────────────────────────────────────────────────────────────

/** The entries of a drop; to be fetched SYNCHRONOUSLY in the `drop` event (the items are empty afterwards). */
export function depositEntries(dt: DataTransfer): FileSystemEntry[] {
  const out: FileSystemEntry[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const e = it.webkitGetAsEntry?.();
    if (e) out.push(e);
  }
  return out;
}

const readFolderEntries = (d: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => new Promise((ok, no) => {
  const reader = d.createReader();
  const all: FileSystemEntry[] = [];
  const further = () => reader.readEntries((part) => { if (!part.length) ok(all); else { all.push(...part); further(); } }, no);
  further();
});
/** The file of a dropped entry. */
export const fileOf = (f: FileSystemFileEntry): Promise<File> => new Promise((ok, no) => f.file(ok, no));

/**
 * Read a drop (folders and files mixed): ONE selection of kind `files` whose `rel` carries the folder name, so a dropped folder becomes
 * `<folder name>/…` and a file goes to the root, as with the "⋯" menu. Folders of the omit list are not entered (except in `.git`).
 * `files` is keyed by `key` (NFC), `entries[].rel` as the browser delivers the name.
 */
export async function readDeposit(entries: FileSystemEntry[], rules: Rules | null, opts: { onCount?: (n: number) => void; abort?: Abort } = {}): Promise<SelectedSource> {
  const q: SelectedSource = { kind: "files", name: "", entries: [], files: new Map(), gitContents: {}, skippedFolder: 0 };
  // `rules: null` (Code tab): no filter; what was dropped comes through.
  const omit = new Set(rules?.omit.folder ?? []);
  const go = async (e: FileSystemEntry, prefix: string, inGit: boolean) => {
    if (opts.abort?.aborted) throw new UploadAborted();
    const rel = prefix + e.name;
    if (e.isDirectory) {
      if (!inGit && omit.has(e.name)) { q.skippedFolder++; return; }
      for (const k of await readFolderEntries(e as FileSystemDirectoryEntry)) await go(k, `${rel}/`, inGit || e.name === ".git");
      return;
    }
    if (!e.isFile) return;
    const f = await fileOf(e as FileSystemFileEntry);
    if (q.files.has(key(rel))) return;
    q.entries.push({ rel, size: f.size });
    q.files.set(key(rel), f);
    if (e.name === ".git" && !inGit) q.gitContents[rel] = await gitContent(f);
    if (q.entries.length % 100 === 0) opts.onCount?.(q.entries.length);
  };
  for (const e of entries) await go(e, "", false);
  opts.onCount?.(q.entries.length);
  return q;
}

/** Code tab: a drop as `{ rel, file }` without filter; the file tree chooses target and way (`CodePane` uploadFiles). */
export async function depositFiles(entries: FileSystemEntry[]): Promise<{ rel: string; file: File }[]> {
  const q = await readDeposit(entries, null);
  const out: { rel: string; file: File }[] = [];
  for (const d of q.entries) {
    const file = q.files.get(key(d.rel));
    if (file) out.push({ rel: d.rel, file });
  }
  return out;
}
