// Row decoration in the explorer, as in VS Code. Pure calculations, a leaf module without imports — tested in
// web/test/explorer-decoration.test.mjs (with sabotage), drawn in components/code/explorer/TreeRow.tsx.
//
// The colors are CSS variables in app/globals.css (`--git-*`, `--problem-*`, light and dark after Light/Dark Modern); this file only says
// WHICH variable a row carries. Precedence as in VS Code: problem color before git color before "ignored" (dimmed). A folder carries the
// strongest color beneath it and a dot on the right; a file carries the number of problems and the git letter ("2, M") on the right. The
// number counts errors AND warnings, the color takes the more severe kind, from ten on it reads "9+" (VS Code `MarkersFileDecorations`).
//
// Everything after VS Code: untracked has its OWN color (dark #73c991 against new #81b88b, light #007100 like renamed — `gitDecoration.*` of the git
// extension); a deleted entry does NOT color its folders (VS Code `propagate: false` for DELETED/INDEX_DELETED); a symlink carries ⤷ on the
// right (VS Code `ExplorerDecorationsProvider`).
//
//   gitCard          the git state per path (project-relative, also in nested repos) from `GET …/git`.
//   folderCard       per folder the strongest kind beneath it (conflict > modified > renamed > new > untracked; deleted colors no folder).
//   ignoredChecker  "is this path ignored by git?" from `GET …/git/ignored` (folders with a trailing "/" cover everything below;
//                     nested repos judge for themselves, their root is judged by the repo above).
//   problemCard      the diagnostics of open buffers per file (count) and per folder above (error before warning).
//   decoration        everything together for one row.

export type GitKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
const GIT_KINDS: readonly GitKind[] = ["modified", "added", "deleted", "renamed", "untracked", "conflict"];

export const GIT_COLOR: Readonly<Record<GitKind, string>> = {
  modified: "var(--git-changed)",
  added: "var(--git-new)",
  untracked: "var(--git-untracked)",
  deleted: "var(--git-deleted)",
  renamed: "var(--git-renamed)",
  conflict: "var(--git-conflict)",
};
export const GIT_LETTER: Readonly<Record<GitKind, string>> = { modified: "M", added: "A", untracked: "U", deleted: "D", renamed: "R", conflict: "!" };
/** Which kind a folder shows when several lie beneath it — the strongest. */
export const GIT_RANG: Readonly<Record<GitKind, number>> = { conflict: 6, modified: 5, deleted: 4, renamed: 3, added: 2, untracked: 1 };
export const IGNORED_COLOR = "var(--git-ignored)";
export const PROBLEM_COLOR = { error: "var(--problem-error)", warning: "var(--problem-warning)" } as const;

export type GitRepoSituation = { relPath: string; changes?: readonly { path: string; kind: string }[] | null };

export function gitCard(repos: readonly GitRepoSituation[] | null | undefined): Map<string, GitKind> {
  const m = new Map<string, GitKind>();
  for (const r of repos ?? []) {
    for (const c of r.changes ?? []) {
      if (!(GIT_KINDS as readonly string[]).includes(c.kind)) continue;
      m.set(r.relPath ? `${r.relPath}/${c.path}` : c.path, c.kind as GitKind);
    }
  }
  return m;
}

const ancestors = (p: string) => {
  const out: string[] = [];
  for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) out.push(p.slice(0, i));
  return out;
};

/** Which kinds color their folders — not deleted (VS Code: `propagate` is off for DELETED/INDEX_DELETED). */
export const GIT_COLORIZES_FOLDER: Readonly<Record<GitKind, boolean>> = { modified: true, added: true, untracked: true, deleted: false, renamed: true, conflict: true };

export function folderCard(files: ReadonlyMap<string, GitKind>): Map<string, GitKind> {
  const m = new Map<string, GitKind>();
  for (const [p, kind] of files) {
    if (!GIT_COLORIZES_FOLDER[kind]) continue;
    for (const d of ancestors(p)) {
      const soFar = m.get(d);
      if (!soFar || GIT_RANG[kind] > GIT_RANG[soFar]) m.set(d, kind);
    }
  }
  return m;
}

export type IgnoredRepo = { relPath: string; ignored: readonly string[] | null; clipped?: boolean };

export function ignoredChecker(repos: readonly IgnoredRepo[] | null | undefined): (path: string) => boolean {
  const list = (repos ?? []).map((r) => {
    const files = new Set<string>(), folder = new Set<string>();
    for (const raw of r.ignored ?? []) {
      const full = r.relPath ? `${r.relPath}/${raw}` : raw;
      if (full.endsWith("/")) folder.add(full.slice(0, -1)); else files.add(full);
    }
    return { rel: r.relPath, read: Array.isArray(r.ignored), files, folder };
  }).sort((a, b) => b.rel.length - a.rel.length); // innermost repo first
  if (!list.length) return () => false;
  return (path: string) => {
    // The innermost repo that REALLY contains the path — the root of a nested repo is judged by the repo above.
    const r = list.find((x) => (x.rel === "" ? path !== "" : path.startsWith(`${x.rel}/`)));
    if (!r || !r.read) return false;
    if (r.files.has(path) || r.folder.has(path)) return true;
    for (const a of ancestors(path)) if (a.length > r.rel.length && r.folder.has(a)) return true;
    return false;
  };
}

export type ProblemSituation = { file: string; severity: string };
export type ProblemCount = { error: number; warnings: number };

export function problemCard(problems: readonly ProblemSituation[]): { files: Map<string, ProblemCount>; folder: Map<string, "error" | "warning"> } {
  const files = new Map<string, ProblemCount>();
  for (const p of problems) {
    if (p.severity !== "error" && p.severity !== "warning") continue;
    const z = files.get(p.file) ?? { error: 0, warnings: 0 };
    if (p.severity === "error") z.error++; else z.warnings++;
    files.set(p.file, z);
  }
  const folder = new Map<string, "error" | "warning">();
  for (const [f, z] of files) {
    const kind = z.error ? "error" : "warning";
    for (const d of ancestors(f)) if (folder.get(d) !== "error") folder.set(d, kind);
  }
  return { files, folder };
}

export type Cards = {
  git: ReadonlyMap<string, GitKind>;
  gitFolder: ReadonlyMap<string, GitKind>;
  ignored: (path: string) => boolean;
  problems: { files: ReadonlyMap<string, ProblemCount>; folder: ReadonlyMap<string, "error" | "warning"> };
};
export type Decoration = {
  /** The color of the name (a CSS variable) — null: the base color. */
  color: string | null;
  /** On the right: "2, M" (file), "⤷" (symlink) — null: nothing. */
  character: string | null;
  /** On the right a dot ● (folder with changes or problems beneath). */
  point: boolean;
  dimmed: boolean;
  /** Deleted: struck through. */
  through: boolean;
};

/** The symlink character (VS Code `ExplorerDecorationsProvider`: "Symbolic Link", U+2937). */
export const REFERENCE_CHARACTER = "\u2937";

export function decoration(path: string, type: "dir" | "file", k: Cards, o: { symlink?: boolean } = {}): Decoration {
  const dimmed = k.ignored(path);
  const reference = o.symlink ? REFERENCE_CHARACTER : null;
  if (type === "dir") {
    const prob = k.problems.folder.get(path) ?? null;
    const git = k.gitFolder.get(path) ?? null;
    const color = prob ? PROBLEM_COLOR[prob] : git ? GIT_COLOR[git] : dimmed ? IGNORED_COLOR : null;
    return { color, character: reference, point: !reference && Boolean(prob || git), dimmed, through: false };
  }
  const z = k.problems.files.get(path) ?? null;
  const git = k.git.get(path) ?? null;
  const count = z ? z.error + z.warnings : 0;
  const probColor = z ? (z.error ? PROBLEM_COLOR.error : PROBLEM_COLOR.warning) : null;
  const color = probColor ?? (git ? GIT_COLOR[git] : dimmed ? IGNORED_COLOR : null);
  const parts = [count ? (count < 10 ? String(count) : "9+") : "", git ? GIT_LETTER[git] : "", reference ?? ""].filter(Boolean);
  return { color, character: parts.length ? parts.join(", ") : null, point: false, dimmed, through: git === "deleted" };
}

/** The cards from the raw data — computed ONCE per state (drawing calls `decoration` per row). */
export function cards(repos: readonly GitRepoSituation[] | null | undefined, ignored: readonly IgnoredRepo[] | null | undefined,
  problems: readonly ProblemSituation[]): Cards {
  const git = gitCard(repos);
  return { git, gitFolder: folderCard(git), ignored: ignoredChecker(ignored), problems: problemCard(problems) };
}
