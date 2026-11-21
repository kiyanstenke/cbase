// Taken from: microsoft/vscode extensions/theme-seti/icons/vs-seti-icon-theme.json (MIT)
// The file icon by name and extension as in the default icon theme of VS Code (Seti) — ONE table for explorer, tabs, search, breadcrumbs and
// file search (drawn by components/code/FileSymbol.tsx). As in Seti, folders have NO icon, only the arrow. The colors are Seti's; in the
// light theme the component draws them unchanged (Seti does the same).
//
// Search order: whole name (lower case), then the longest matching extension (".d.ts" before ".ts", ".test.ts" before ".ts"), then a
// name beginning (`.env.local` ⇒ `.env`), otherwise the default icon.

export type SymbolForm =
  | "text" // a short abbreviation (TS, JS, py …)
  | "react" | "image" | "gear" | "padlock" | "git" | "info" | "docker" | "npm" | "license" | "markdown" | "brackets" | "angle" | "shell"
  | "database" | "table" | "pdf" | "archive" | "file";

export type FileSymbolKind = { form: SymbolForm; color: string; text?: string };

export const SETI = Object.freeze({
  blue: "#519aba", gray: "#4d5a5e", green: "#8dc149", orange: "#e37933", pink: "#f55385", purple: "#a074c4", red: "#cc3e44",
  white: "#d4d7d6", yellow: "#cbcb41", ignored: "#41535b", standard: "#6d8086",
});

const s = (form: SymbolForm, color: string, text?: string): FileSymbolKind => (text ? { form, color, text } : { form, color });

/** Whole names (lower case). */
const NAMES: Record<string, FileSymbolKind> = {
  "package.json": s("npm", SETI.red),
  "package-lock.json": s("npm", SETI.gray),
  "yarn.lock": s("padlock", SETI.blue),
  "pnpm-lock.yaml": s("padlock", SETI.yellow),
  "bun.lockb": s("padlock", SETI.white),
  "tsconfig.json": s("text", SETI.blue, "TS"),
  "jsconfig.json": s("text", SETI.yellow, "JS"),
  "dockerfile": s("docker", SETI.blue),
  "docker-compose.yml": s("docker", SETI.pink),
  "docker-compose.yaml": s("docker", SETI.pink),
  "compose.yml": s("docker", SETI.pink),
  "compose.yaml": s("docker", SETI.pink),
  ".dockerignore": s("docker", SETI.gray),
  ".gitignore": s("git", SETI.ignored),
  ".gitattributes": s("git", SETI.ignored),
  ".gitmodules": s("git", SETI.ignored),
  ".gitkeep": s("git", SETI.ignored),
  "license": s("license", SETI.yellow),
  "license.md": s("license", SETI.yellow),
  "license.txt": s("license", SETI.yellow),
  "readme.md": s("info", SETI.blue),
  "readme": s("info", SETI.blue),
  "makefile": s("gear", SETI.orange),
  ".editorconfig": s("gear", SETI.white),
  ".prettierrc": s("gear", SETI.yellow),
  ".eslintrc": s("gear", SETI.purple),
  ".npmrc": s("npm", SETI.red),
  ".nvmrc": s("gear", SETI.green),
};

/** Extensions without a dot, the longest searched first (`d.ts` before `ts`). */
const SUFFIXES: Record<string, FileSymbolKind> = {
  "d.ts": s("text", SETI.blue, "TS"),
  "test.ts": s("text", SETI.orange, "TS"), "spec.ts": s("text", SETI.orange, "TS"),
  "test.tsx": s("react", SETI.orange), "spec.tsx": s("react", SETI.orange),
  "test.js": s("text", SETI.orange, "JS"), "spec.js": s("text", SETI.orange, "JS"),
  "test.mjs": s("text", SETI.orange, "JS"), "test.cjs": s("text", SETI.orange, "JS"),
  ts: s("text", SETI.blue, "TS"), mts: s("text", SETI.blue, "TS"), cts: s("text", SETI.blue, "TS"),
  tsx: s("react", SETI.blue), jsx: s("react", SETI.blue),
  js: s("text", SETI.yellow, "JS"), mjs: s("text", SETI.yellow, "JS"), cjs: s("text", SETI.yellow, "JS"),
  json: s("brackets", SETI.yellow), jsonc: s("brackets", SETI.yellow), json5: s("brackets", SETI.yellow),
  md: s("markdown", SETI.blue), mdx: s("markdown", SETI.yellow),
  css: s("text", SETI.blue, "#"), scss: s("text", SETI.pink, "#"), sass: s("text", SETI.pink, "#"), less: s("text", SETI.blue, "#"),
  html: s("angle", SETI.orange), htm: s("angle", SETI.orange), xml: s("angle", SETI.orange), vue: s("angle", SETI.green),
  svelte: s("angle", SETI.red),
  py: s("text", SETI.blue, "py"), pyi: s("text", SETI.blue, "py"), ipynb: s("text", SETI.orange, "nb"),
  yml: s("text", SETI.purple, "!"), yaml: s("text", SETI.purple, "!"), toml: s("gear", SETI.gray),
  ini: s("gear", SETI.gray), cfg: s("gear", SETI.gray), conf: s("gear", SETI.gray), properties: s("gear", SETI.gray),
  env: s("gear", SETI.gray),
  sh: s("shell", SETI.green), bash: s("shell", SETI.green), zsh: s("shell", SETI.green), fish: s("shell", SETI.green),
  ps1: s("shell", SETI.blue), bat: s("shell", SETI.yellow), cmd: s("shell", SETI.yellow),
  png: s("image", SETI.purple), jpg: s("image", SETI.purple), jpeg: s("image", SETI.purple), gif: s("image", SETI.purple), webp: s("image", SETI.purple),
  ico: s("image", SETI.yellow), bmp: s("image", SETI.purple), avif: s("image", SETI.purple), svg: s("image", SETI.purple),
  sql: s("database", SETI.pink), db: s("database", SETI.pink), sqlite: s("database", SETI.pink), sqlite3: s("database", SETI.pink),
  csv: s("table", SETI.green), tsv: s("table", SETI.green), xlsx: s("table", SETI.green), xls: s("table", SETI.green),
  pdf: s("pdf", SETI.red),
  zip: s("archive", SETI.gray), gz: s("archive", SETI.gray), tgz: s("archive", SETI.gray), tar: s("archive", SETI.gray), "7z": s("archive", SETI.gray),
  lock: s("padlock", SETI.gray),
  go: s("text", SETI.blue, "go"), rs: s("text", SETI.gray, "rs"), java: s("text", SETI.red, "J"), kt: s("text", SETI.orange, "K"),
  swift: s("text", SETI.orange, "sw"), rb: s("text", SETI.red, "rb"), php: s("text", SETI.purple, "php"),
  c: s("text", SETI.blue, "C"), h: s("text", SETI.purple, "h"), cpp: s("text", SETI.blue, "C+"), hpp: s("text", SETI.purple, "h"),
  cs: s("text", SETI.blue, "C#"), lua: s("text", SETI.blue, "lua"), r: s("text", SETI.blue, "R"), dart: s("text", SETI.blue, "dt"),
  graphql: s("text", SETI.pink, "GQ"), gql: s("text", SETI.pink, "GQ"), prisma: s("text", SETI.white, "◭"),
  txt: s("file", SETI.white), log: s("file", SETI.gray),
};
const SUFFIX_LIST = Object.keys(SUFFIXES).sort((a, b) => b.length - a.length);

/** Name beginnings (`.env.local`, `.env.production`, `Dockerfile.dev`). */
const BEGINNINGS: [string, FileSymbolKind][] = [
  [".env", s("gear", SETI.gray)],
  ["dockerfile", s("docker", SETI.blue)],
  ["readme", s("info", SETI.blue)],
  ["license", s("license", SETI.yellow)],
  [".eslintrc", s("gear", SETI.purple)],
  [".prettierrc", s("gear", SETI.yellow)],
  ["tsconfig.", s("text", SETI.blue, "TS")],
];

export const STANDARD_SYMBOL: FileSymbolKind = Object.freeze(s("file", SETI.standard));

/** The icon of a file by its name (the last path part counts). */
export function fileSymbolKind(pathOrName: string): FileSymbolKind {
  const name = String(pathOrName ?? "").split("/").pop() ?? "";
  const small = name.toLowerCase();
  if (NAMES[small]) return NAMES[small];
  for (const e of SUFFIX_LIST) if (small.endsWith("." + e) && small.length > e.length + 1) return SUFFIXES[e];
  for (const [a, kind] of BEGINNINGS) if (small.startsWith(a)) return kind;
  return STANDARD_SYMBOL;
}
