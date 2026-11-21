// Visible outputs: the pure computations of the web client: the tree of the "Outputs" folder under Artifacts and the recognition of paths
// into the output location in chat text. A leaf without imports (web/test/outputs.test.mjs compiles it on its own); the list comes from
// the server (`GET /api/chats/:id/outputs`, lib/api/outputs.ts).
//
// TREE: subfolders stay; the internal folders (`internal` on the entry; the server knows `agents/` and `workflows/`) sit under ONE node
// "Internal", at the very bottom. Newest first: a file by its mtime, a folder by its newest file.
//
// PATHS: only what starts with one of the roots the SERVER names becomes clickable (the current output location, behind it an old one
// after a project change); the client never guesses a location. A relative path (`screens/qa31-*`) only if the same message names a
// root AND its first part is a top-level folder of the output location. `*`/`?` turn a path into a folder with a filter.

export type OutputEntry = { path: string; size: number; changed: number; internal: boolean };
export type OutputsList = { roots: string[]; entries: OutputEntry[]; total: number; clipped: boolean; max: number };

// The type by extension: the same table as the server (runs/outputs-view.js outputType, without charset). It decides the view in the window
// (ArtifactModal: image, PDF, markdown/plain text read, other text as source, otherwise download). HTML and SVG are NEVER executed: HTML
// is text (source), SVG goes into an <img>.
const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", log: "text/plain", output: "text/plain",
  json: "application/json", csv: "text/csv", yaml: "application/yaml", yml: "application/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", ts: "text/typescript",
  zip: "application/zip", mp4: "video/mp4", webm: "video/webm",
};
export function outputMime(name: string): string {
  const i = name.lastIndexOf(".");
  return (i > name.lastIndexOf("/") && MIME[name.slice(i + 1).toLowerCase()]) || "application/octet-stream";
}

/** The key of the "Internal" node (not a real path in the folder tree: real folders carry `<path>/`). */
export const INTERNAL_KEY = "internal:";

export type OutputsNode =
  | { kind: "folder"; key: string; name: string; children: OutputsNode[]; files: number; newest: number; internal?: boolean }
  | { kind: "file"; key: string; name: string; entry: OutputEntry };

/** A pattern with `*`/`?` (per path part, `*` without `/`) → RegExp over the path below the folder. */
export function patternRegex(pattern: string): RegExp {
  const source = pattern.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}(?:/.*)?$`);
}

/** The entries under `folder` (relative, no trailing `/`; "" = all), filtered by `pattern` (relative to `folder`). */
export function filterOutputs(entries: OutputEntry[], folder: string, pattern: string | null): OutputEntry[] {
  const front = folder ? `${folder}/` : "";
  const re = pattern ? patternRegex(pattern) : null;
  return entries.filter((e) => e.path.startsWith(front) && (!re || re.test(e.path.slice(front.length))));
}

function build(items: { e: OutputEntry; rest: string }[], front: string): OutputsNode[] {
  const folder = new Map<string, { e: OutputEntry; rest: string }[]>();
  const node: OutputsNode[] = [];
  for (const it of items) {
    const i = it.rest.indexOf("/");
    if (i < 0) { node.push({ kind: "file", key: it.e.path, name: it.rest, entry: it.e }); continue; }
    const header = it.rest.slice(0, i);
    const list = folder.get(header) ?? [];
    list.push({ e: it.e, rest: it.rest.slice(i + 1) });
    folder.set(header, list);
  }
  for (const [name, content] of folder) {
    const key = `${front}${name}/`;
    node.push({
      kind: "folder", key, name, children: build(content, key), files: content.length,
      newest: Math.max(...content.map((x) => x.e.changed)),
    });
  }
  const stamp = (k: OutputsNode) => (k.kind === "file" ? k.entry.changed : k.newest);
  return node.sort((a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name));
}

/** The tree of the "Outputs" folder: newest first, the internal entries under ONE "Internal" node at the bottom. */
export function outputsTree(entries: OutputEntry[], internalName = "Internal"): OutputsNode[] {
  const visible = entries.filter((e) => !e.internal);
  const internalEntries = entries.filter((e) => e.internal);
  const top = build(visible.map((e) => ({ e, rest: e.path })), "");
  if (!internalEntries.length) return top;
  return [...top, {
    kind: "folder", key: INTERNAL_KEY, name: internalName, internal: true, files: internalEntries.length,
    children: build(internalEntries.map((e) => ({ e, rest: e.path })), ""), newest: Math.max(...internalEntries.map((e) => e.changed)),
  }];
}

/** The folder keys on the way to a path (for expanding), with "Internal" first if it is internal. */
export function outputsWay(path: string, internal: boolean): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = internal ? [INTERNAL_KEY] : [];
  for (let i = 1; i < parts.length; i++) out.push(`${parts.slice(0, i).join("/")}/`);
  return out;
}

// ── Paths in chat text ──────────────────────────────────────────────────────────────────────────────────────────

export type OutputTarget = { kind: "file"; path: string } | { kind: "folder"; path: string; pattern: string | null };
export type PathPart = { text: string; target?: OutputTarget };
export type PathContext = {
  roots: string[];
  /** The paths of the list (to tell file from folder); a missing path counts as a file; the server decides on opening. */
  files: Set<string>;
  /** The top-level folders of the output location (`screens`, `playwright` …); only they make a relative path clickable. */
  upperFolder: Set<string>;
  /** Does the message name a root? Only then do relative paths count. */
  relative: boolean;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What belongs to a path: everything up to whitespace, quote, bracket, backtick.
const PATH_CHARACTER = "[^\\s`'\"<>()\\[\\]{}]";
const END_PUNCTUATION = /[.,;:!?]+$/;

/** The roots (and their top-level folders) as a context for ONE message. */
export function pathContext(list: OutputsList | null, message: string): PathContext | null {
  if (!list || !list.roots.length) return null;
  const files = new Set(list.entries.map((e) => e.path));
  const upperFolder = new Set(list.entries.filter((e) => e.path.includes("/")).map((e) => e.path.split("/")[0]));
  return { roots: list.roots, files, upperFolder, relative: list.roots.some((w) => message.includes(w)) };
}

/** A relative path under the root → its target (file, folder, folder with pattern). "" = the root itself. */
export function targetOf(rel: string, files: Set<string>): OutputTarget {
  const parts = rel.split("/").filter(Boolean);
  const glob = parts.findIndex((t) => /[*?]/.test(t));
  if (glob >= 0) return { kind: "folder", path: parts.slice(0, glob).join("/"), pattern: parts.slice(glob).join("/") };
  const path = parts.join("/");
  if (!path || rel.endsWith("/")) return { kind: "folder", path, pattern: null };
  if (!files.has(path) && [...files].some((d) => d.startsWith(`${path}/`))) return { kind: "folder", path, pattern: null };
  return { kind: "file", path };
}

/**
 * Split free text (or the content of an inline code) into parts: text and paths into the output location (with target). `null` if
 * nothing in it is clickable; the text then stays as it was.
 */
export function outputPathParts(text: string, k: PathContext | null): PathPart[] | null {
  if (!k || !text) return null;
  const roots = [...k.roots].sort((a, b) => b.length - a.length).map(esc);
  // Behind the root comes `/`, punctuation or the end: `…/outputs/<id>x` is a DIFFERENT name, not a root.
  const branches = [`(${roots.join("|")})(?![^\\s/\`'"<>()\\[\\]{}.,;:!?])((?:/${PATH_CHARACTER}*)?)`];
  const top = [...k.upperFolder].map(esc);
  if (k.relative && top.length) branches.push(`(?<![\\w/.~-])((?:${top.join("|")})/${PATH_CHARACTER}*)`);
  const re = new RegExp(branches.join("|"), "g");
  const parts: PathPart[] = [];
  let until = 0;
  let hits = false;
  for (const m of text.matchAll(re)) {
    let raw = m[0];
    const set = raw.match(END_PUNCTUATION)?.[0] ?? "";
    // A pattern often ends in `*`, which is not punctuation; a "." after the path is.
    if (set) raw = raw.slice(0, -set.length);
    const rel = m[1] !== undefined ? raw.slice(m[1].length).replace(/^\//, "") : raw;
    const start = m.index ?? 0;
    if (start > until) parts.push({ text: text.slice(until, start) });
    parts.push({ text: raw, target: targetOf(rel, k.files) });
    until = start + raw.length;
    hits = true;
  }
  if (!hits) return null;
  if (until < text.length) parts.push({ text: text.slice(until) });
  return parts;
}
