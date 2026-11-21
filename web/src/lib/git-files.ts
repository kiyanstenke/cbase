// The file rows of the git bar (components/GitSidebar.tsx "Changes" and the files of an expanded commit in the graph,
// components/git-bar/GitGraph.tsx): ONE place for color and letter of a change, the translation of the letters of `git diff-tree` to the
// same kinds, the icon by file type and the split into name and folder.
//
// A LEAF module without imports: web/test/git-graph.test.mjs transpiles the file alone with tsc and runs the calculations.
//
// `KIND_COLOR`/`KIND_LETTER` live here (not in GitSidebar.tsx) so that the graph takes the same colors instead of a copy.
// `COMMIT_STATUS_KIND` is the same mapping as `classify` in the server (electron/server/git.js — there for `git status`, here for
// `diff-tree --name-status`): C counts like R, T like M, U is a conflict. Bound in web/test/git-graph.test.mjs (the `case` lines of
// classify against this table).

/** The kind of a change (lib/api/git.ts GitChange.kind). */
export type GitKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
export const KIND_COLOR: Record<string, string> = {
  modified: "text-warn", added: "text-ok", deleted: "text-danger",
  renamed: "text-accent", untracked: "text-ok", conflict: "text-danger",
};
export const KIND_LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };

/** A letter of `diff-tree --name-status` → kind and label (the translation key). */
export const COMMIT_STATUS_KIND: Readonly<Record<string, { kind: GitKind; label: string }>> = {
  M: { kind: "modified", label: "modified" },
  A: { kind: "added", label: "added" },
  D: { kind: "deleted", label: "deleted" },
  R: { kind: "renamed", label: "renamed" },
  C: { kind: "renamed", label: "copied" },
  T: { kind: "modified", label: "type changed" },
  U: { kind: "conflict", label: "conflict" },
};
/** Color (Tailwind class) and letter of a file of a commit — the same as under "Changes". Unknown: muted, the letter itself. */
export function commitStatusDisplay(status: string): { color: string; letter: string; label: string; deleted: boolean } {
  const a = COMMIT_STATUS_KIND[status];
  if (!a) return { color: "text-dim", letter: status || "?", label: "modified", deleted: false };
  return { color: KIND_COLOR[a.kind] ?? "text-dim", letter: KIND_LETTER[a.kind] ?? status, label: a.label, deleted: a.kind === "deleted" };
}

/** `src/lib/a.ts` → `{ name: "a.ts", folder: "src/lib" }` (the folder relative to the repo, empty at the root). */
export function partsPath(path: string): { name: string; folder: string } {
  const p = String(path || "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? { name: p.slice(i + 1) || p, folder: p.slice(0, i) } : { name: p, folder: "" };
}
/** The path as `POST …/git/show` takes it with `file`: a file starting with "-" as `./-name` (the server rejects "-…" —
 *  git would read it as an option, server git.js commitPath). */
export function diffPath(path: string): string {
  return path.startsWith("-") ? `./${path}` : path;
}

// ── The icon by file type (in the style of VS Code, without its images) ────────────────────────────────────────────────────────────
// Code files carry a short abbreviation in the color of their language (like the Seti icons of VS Code: TS blue, JS yellow, `{}` for
// JSON, `<>` for markup, `#` for styles), images, configuration, lock files and text a line icon; everything else the neutral sheet.
// The tones are color roles `--file-<tone>` in app/globals.css (light and dark), "gray" is `--color-dim`.
export type FileTone = "blue" | "yellow" | "orange" | "purple" | "green" | "red" | "gray";
export type FileKind =
  | { kind: "shortcut"; shortcut: string; tone: FileTone }
  | { kind: "image" | "config" | "lock" | "text" | "file"; tone: FileTone };

const SHORTCUT: Record<string, [string, FileTone]> = {
  ts: ["TS", "blue"], tsx: ["TS", "blue"], mts: ["TS", "blue"], cts: ["TS", "blue"],
  js: ["JS", "yellow"], jsx: ["JS", "yellow"], mjs: ["JS", "yellow"], cjs: ["JS", "yellow"],
  json: ["{}", "yellow"], jsonc: ["{}", "yellow"], json5: ["{}", "yellow"],
  md: ["M", "blue"], mdx: ["M", "blue"], markdown: ["M", "blue"],
  css: ["#", "purple"], scss: ["#", "purple"], sass: ["#", "purple"], less: ["#", "purple"],
  html: ["<>", "orange"], htm: ["<>", "orange"], xml: ["<>", "orange"], vue: ["<>", "green"], svelte: ["<>", "orange"],
  py: ["PY", "blue"], go: ["GO", "blue"], rs: ["RS", "orange"], swift: ["SW", "orange"], java: ["JV", "red"], kt: ["KT", "purple"],
  rb: ["RB", "red"], php: ["P", "purple"], c: ["C", "blue"], h: ["H", "purple"], cc: ["C+", "blue"], cpp: ["C+", "blue"], hpp: ["H+", "purple"],
  cs: ["C#", "purple"], sql: ["SQ", "orange"], sh: [">_", "green"], bash: [">_", "green"], zsh: [">_", "green"], fish: [">_", "green"],
  pl: ["PL", "blue"], lua: ["LU", "blue"],
};
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "icns", "avif", "bmp", "tif", "tiff", "heic"]);
const CONFIG_SUFFIX = new Set(["yml", "yaml", "toml", "ini", "conf", "cfg", "env", "properties", "plist", "entitlements", "xcconfig"]);
const CONFIG_NAME = new Set(["dockerfile", "makefile", "procfile", ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".dockerignore", ".prettierrc", ".eslintrc"]);
const LOCK_NAME = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "gemfile.lock", "poetry.lock", "composer.lock", "podfile.lock", "bun.lockb", "go.sum"]);
const TEXT = new Set(["txt", "log", "csv", "tsv", "rst", "adoc"]);

/** The icon of a file from its path (only the name counts, case-insensitive). */
export function fileKind(path: string): FileKind {
  const name = partsPath(path).name.toLowerCase();
  if (LOCK_NAME.has(name) || name.endsWith(".lock")) return { kind: "lock", tone: "gray" };
  if (CONFIG_NAME.has(name) || name.startsWith(".env") || name.startsWith("dockerfile.")) return { kind: "config", tone: "gray" };
  const point = name.lastIndexOf(".");
  const suffix = point > 0 ? name.slice(point + 1) : "";
  if (!suffix) return { kind: "file", tone: "gray" };
  const k = SHORTCUT[suffix];
  if (k) return { kind: "shortcut", shortcut: k[0], tone: k[1] };
  if (IMAGE.has(suffix)) return { kind: "image", tone: "purple" };
  if (CONFIG_SUFFIX.has(suffix)) return { kind: "config", tone: "gray" };
  if (TEXT.has(suffix)) return { kind: "text", tone: "gray" };
  return { kind: "file", tone: "gray" };
}
