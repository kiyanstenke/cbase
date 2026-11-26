// Files from a drop or a picker, ready for upload — one place for every upload target that accepts a drop (chat attachments,
// chat artifacts, folder context, project upload, the Code tab's explorer).
//
// Why this exists: `DataTransfer.files` of a dropped FOLDER holds one pseudo-file for the folder itself (no type, a few hundred
// bytes, unreadable). Handing that to `fetch` as a body makes the browser fail while reading it, and the only thing the user sees is
// "Failed to fetch" — the request never leaves the machine. A drop must therefore be walked through its entries
// (`webkitGetAsEntry`), which turns a folder into its files with paths relative to the drop.
//
// The second trap is a file the browser lists but cannot read (a cloud-only placeholder of a sync client, a file removed after the
// drop, a folder in the fallback without entries). `readableFile` reads one byte first, so the user gets the file's name and a hint
// instead of the same opaque fetch error.
//
// Pure DOM APIs, no imports: `web/test/drop-files.test.mjs` compiles this file alone and runs it against fake entries.

/** A file with its path relative to the drop or the picked folder ("Folder/sub/name.pdf"; a loose file is just its name). */
export type DroppedFile = { rel: string; file: File };

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

/** All children of a folder entry (`readEntries` delivers them in batches until an empty one). */
export const readFolderEntries = (d: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => new Promise((ok, no) => {
  const reader = d.createReader();
  const all: FileSystemEntry[] = [];
  const further = () => reader.readEntries((part) => { if (!part.length) ok(all); else { all.push(...part); further(); } }, no);
  further();
});

/** The file of a dropped entry. */
export const fileOf = (f: FileSystemFileEntry): Promise<File> => new Promise((ok, no) => f.file(ok, no));

/** Walk entries (folders and files mixed) into files with relative paths; a folder becomes `<folder>/…`. */
export async function filesOfEntries(entries: FileSystemEntry[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const go = async (e: FileSystemEntry, prefix: string) => {
    const rel = prefix + e.name;
    if (e.isDirectory) {
      for (const k of await readFolderEntries(e as FileSystemDirectoryEntry)) await go(k, `${rel}/`);
      return;
    }
    if (e.isFile) out.push({ rel, file: await fileOf(e as FileSystemFileEntry) });
  };
  for (const e of entries) await go(e, "");
  return out;
}

/** A picked list as relative files: a folder picker sets `webkitRelativePath`, otherwise the name. */
export function filesOfList(list: FileList | File[]): DroppedFile[] {
  return Array.from(list).map((file) => ({ rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
}

/**
 * The files of a drop, folders walked. Call it directly in the `drop` handler: the entries are taken synchronously before the
 * first await (an async function runs up to its first await in the caller's turn). Without the entries API the plain file list is
 * the fallback — a folder in it is caught by `readableFile`.
 */
export async function droppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries = depositEntries(dt);
  if (!entries.length) return filesOfList(dt.files);
  return filesOfEntries(entries);
}

/** Anything an upload target accepts: a drop (`DataTransfer`, folders walked) or a picked list. Synchronous up to the entries. */
export type UploadSource = FileList | File[] | DataTransfer;

/**
 * The files of an upload source. Call it BEFORE the first await of the upload function, so a drop's entries are still there.
 * A `DataTransfer` is recognised by `getData` (a `FileList` and an array have none).
 */
export function filesOf(source: UploadSource): Promise<DroppedFile[]> {
  if (typeof (source as DataTransfer).getData === "function") return droppedFiles(source as DataTransfer);
  return Promise.resolve(filesOfList(source as FileList | File[]));
}

/** Raised by `readableFile`; the message names the file and says what to do. */
export class UnreadableFile extends Error {
  rel: string;
  constructor(rel: string, message: string) { super(message); this.name = "UnreadableFile"; this.rel = rel; }
}

/**
 * Read the first byte before the upload. A file the browser cannot read (cloud-only placeholder, removed, a folder) throws
 * `UnreadableFile` with `describe(rel)` as its message instead of letting `fetch` fail without a reason. An empty file passes.
 */
export async function readableFile(d: DroppedFile, describe: (rel: string) => string): Promise<File> {
  try {
    await d.file.slice(0, 1).arrayBuffer();
  } catch {
    throw new UnreadableFile(d.rel, describe(d.rel));
  }
  return d.file;
}
