// The layout of a project as a pure computation: an interactive view of how the project will be laid out afterwards, where folders can
// be moved before creation (project root + subprojects = code repos).
//
// ONE computation, three places: this module (web), `mobile/CbaseMobile/Code/ProjectLayout.swift` (iOS) and `projectbox/layout/plan.js`
// (server). Bound through ONE fixture set `server/backend/test/fixtures/layout-plan/*.json` (README there): `web/test/project-layout-plan.test.mjs`
// runs this module, `web/test/layout-ios-binding.test.mjs` the Swift model. A deviation between preview and result would silently put files
// in other places or drop them.
//
//   treeFromSelection(sources, rules, gitFiles)  creation: the selection in the client → nodes, upload list per source, hints
//   computePlan(tree, steps, rules, mode)         steps → final tree, mapping per source (creation) or final mapping
//                                                 (inventory), code-repo marks, errors (block) and warnings (do not block)
//   targetOf(mapping, origin)                     the target path of a file: the longest matching `from` prefix wins;
//                                                 `null` = left out, `undefined` = covered by no entry (caller error)
//
// The rules come from `GET /api/projectCreation/rules` (`projectbox/setup/rules.js`); never a second version here.
//
// Steps (paths relative to the root, each in the state AFTER the previous steps):
//   { kind: "move", from, to }          renaming = same parent folder; a node together with everything currently hanging below it
//   { kind: "leaveOut", path }          creation: do not upload; inventory: delete (with confirmation)
//   { kind: "code-repo", path }         mark a normal folder as a code repo
//   { kind: "code-repo-off", path }     creation only: remove the mark again
// A step that does not fit (node missing, target inside a code repo, inside itself, …) is NOT applied and appears as an error with its
// number; "Create" stays blocked until it is withdrawn. Equal paths after a step are allowed and only an error in the final tree
// (TARGET_DUPLICATE); a later step on a duplicate path hits the FIRST node in tree order.
//
// The tree is built over PARENT REFERENCES, not path prefixes: two folders of the same name from two sources would have the same
// prefixes, and moving one would take the other's children along. A node's path is its parent node's plus its name; a move sets parent
// and name. Initially the parent node is the node at the parent path (same source first); if it is missing (the inventory loads level by
// level), the parent path stays as fixed text.

export type NodeKind = "file" | "folder" | "code-repo" | "worktree" | "clone";

/** A node BEFORE all steps. `source`/`origin` only in creation (origin = path in the source). */
export interface Node {
  path: string;
  kind: NodeKind;
  source?: number;
  origin?: string;
  size?: number;
  /** The "code repo" mark on a normal folder; it becomes a repo during setup. */
  codeRepo?: boolean;
}

export type Step =
  | { kind: "move"; from: string; to: string }
  | { kind: "leaveOut"; path: string }
  | { kind: "code-repo"; path: string }
  | { kind: "code-repo-off"; path: string };

export interface Notice {
  code: string;
  path?: string;
  second?: string;
  step?: number;
}

export interface Rules {
  omit: { folder: string[]; files: string[] };
  limits: { depth: number; repos: number; skip: string[]; dependencies: string[] };
  names: { forbidden: string[]; prefix: string };
  reserveBytes?: number;
}

export interface MappingEntry { from: string; to: string | null }

export interface FinalMapping { ways: { old: string; fresh: string }[]; gone: string[]; codeRepos: string[] }

export interface Plan {
  /** Sorted by path. `kind` of a marked folder stays "folder" (with `codeRepo: true`). */
  finalTree: Node[];
  /** Creation: per source (key = number as text) the mapping origin → target, sorted by `from`. Inventory: empty. */
  mapping: Record<string, MappingEntry[]>;
  /** Inventory: only the topmost affected nodes. Creation: empty. */
  finalMapping: FinalMapping;
  /** Final paths of the MARKED folders, sorted, deduplicated; the POST carries them as `codeRepos` (real repos bring `.git` along). */
  codeRepos: string[];
  /** Final paths of all repo nodes (code repo, worktree, clone, marked), sorted, deduplicated; what the repo search finds afterwards. */
  repos: string[];
  error: Notice[];
  warnings: Notice[];
}

export type Mode = "creation" | "inventory";

const MEMORY = ["CLAUDE.md", "AGENTS.md"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
export const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Is `a` under `b` (or equal)? `b` empty = the root. */
export const under = (a: string, b: string) => b === "" || a === b || a.startsWith(`${b}/`);
const connect = (a: string, b: string) => (a ? (b ? `${a}/${b}` : a) : b);
/** Comparison by UTF-16 units (never `localeCompare`): Swift compares `Array(s.utf16)` the same way. */
export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** PURE: why `name` does not work as ONE path part, or null (the same reasons as `rules.js` `nameError`). */
export function nameError(name: string, rules: Rules): string | null {
  if (typeof name !== "string" || !name) return "empty";
  if (rules.names.forbidden.includes(name)) return "forbidden";
  if (name.includes("/") || name.includes("\\")) return "slash";
  if (CONTROL_CHARACTERS.test(name)) return "controlCharacters";
  if (name.toLowerCase().startsWith(rules.names.prefix)) return "prefix";
  if (/[\ud800-\udfff]/.test(name.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) return "utf8";
  return null;
}

/** PURE: does the repo search (`findRepos`) see a repo at this place? Like `git.js` `repoLocationVisible`. */
export function repoLocationVisible(rel: string, rules: Rules): boolean {
  if (!rel) return true;
  const parts = rel.split("/");
  if (parts.length > rules.limits.depth) return false;
  return parts.every((t) => Boolean(t) && !t.startsWith(".") && !rules.limits.skip.includes(t));
}

/** A block: the layout does not show its inside, and nothing is moved into it. */
export const isBlock = (kind: NodeKind) => kind === "code-repo" || kind === "worktree" || kind === "clone";
/** A repo after setup: every block and every marked folder. */
export const isRepo = (k: { kind: NodeKind; codeRepo?: boolean }) => isBlock(k.kind) || (k.kind === "folder" && Boolean(k.codeRepo));

interface Live {
  k: Node;
  start: string;
  name: string;
  parent: Live | null;
  /** Parent path as fixed text while `parent` is null (root = ""). */
  base: string;
  startParent: Live | null;
  gone: boolean;
  /** Mark set by a step (inventory: `codeRepos` of the final mapping). */
  newlyMarked: boolean;
  /** Was a repo before the steps (inventory: warning "one code repo becomes two"). */
  wasRepo: boolean;
}

const byPath = (a: Node, b: Node) =>
  compare(a.path, b.path) || (a.source ?? 0) - (b.source ?? 0) || compare(a.origin ?? "", b.origin ?? "");

/** PURE: steps → plan. */
export function computePlan(tree: Node[], steps: Step[], rules: Rules, mode: Mode): Plan {
  const node: Live[] = tree.map((k) => {
    const n: Node = { path: k.path, kind: k.kind };
    if (k.source !== undefined) n.source = k.source;
    if (k.origin !== undefined) n.origin = k.origin;
    if (k.size !== undefined) n.size = k.size;
    if (k.kind === "folder" && k.codeRepo) n.codeRepo = true;
    return { k: n, start: k.path, name: nameOf(k.path), parent: null, base: parentOf(k.path), startParent: null, gone: false, newlyMarked: false, wasRepo: isRepo(n) };
  });
  // Initial parents: the node at the parent path, same source first, otherwise the first in tree order. Via one table per start path
  // (in tree order); a `filter` per node was quadratic (40,000 files took about 20 s).
  const byStart = new Map<string, Live[]>();
  for (const y of node) { const l = byStart.get(y.start); if (l) l.push(y); else byStart.set(y.start, [y]); }
  for (const x of node) {
    if (!x.base) continue;
    const candidates = (byStart.get(x.base) ?? []).filter((y) => y !== x);
    const e = candidates.find((y) => y.k.source === x.k.source) ?? candidates[0] ?? null;
    if (e) { x.parent = e; x.startParent = e; x.base = ""; }
  }
  const pathOf = (x: Live): string => {
    const parts: string[] = [];
    let y: Live | null = x;
    let base = "";
    const seen = new Set<Live>();
    while (y && !seen.has(y)) { seen.add(y); parts.unshift(y.name); base = y.base; y = y.parent; }
    return connect(base, parts.join("/"));
  };
  const refresh = () => { for (const x of node) x.k.path = pathOf(x); };
  const below = (x: Live, y: Live) => { for (let e = y.parent; e; e = e.parent) if (e === x) return true; return false; };
  const error: Notice[] = [];
  const warnings: Notice[] = [];
  const find = (p: string) => (p ? node.find((x) => !x.gone && x.k.path === p) : undefined);
  const no = (code: string, step: number, path: string) => { error.push({ code, step, path }); };

  steps.forEach((s, i) => {
    if (s.kind === "move") {
      const from = String(s.from ?? ""), to = String(s.to ?? "");
      const x = find(from);
      if (!x) return no("STEP_UNKNOWN", i, from);
      if (!to || to === from || under(to, from)) return no("STEP_INVALID", i, to);
      const ep = parentOf(to);
      let e: Live | null = null;
      if (ep) {
        const f = find(ep);
        if (!f) return no("STEP_INVALID", i, to);
        if (isBlock(f.k.kind)) return no("IN_CODE_REPO", i, to);
        if (f.k.kind !== "folder" || f === x || below(x, f)) return no("STEP_INVALID", i, to);
        e = f;
      }
      x.parent = e;
      x.base = "";
      x.name = nameOf(to);
      refresh();
      return;
    }
    if (s.kind === "leaveOut") {
      const p = String(s.path ?? "");
      const x = find(p);
      if (!x) return no("STEP_UNKNOWN", i, p);
      for (const y of node) if (y === x || below(x, y)) y.gone = true;
      return;
    }
    if (s.kind === "code-repo" || s.kind === "code-repo-off") {
      const p = String(s.path ?? "");
      const x = find(p);
      if (!x) return no("STEP_UNKNOWN", i, p);
      if (s.kind === "code-repo") {
        if (x.k.kind !== "folder" || x.k.codeRepo) return no("STEP_INVALID", i, p);
        x.k.codeRepo = true;
        x.newlyMarked = true;
      } else {
        // The inventory has no "remove mark" (that would mean deleting `.git`).
        if (mode !== "creation" || x.k.kind !== "folder" || !x.k.codeRepo) return no("STEP_INVALID", i, p);
        delete x.k.codeRepo;
        x.newlyMarked = false;
      }
      return;
    }
    no("STEP_UNKNOWN", i, "");
  });

  // ── The final tree and its rules ─────────────────────────────────────────────────────────────────────────────────────
  const end = node.filter((x) => !x.gone).map((x) => x.k).sort(byPath);
  for (const k of end) if (k.path.split("/").some((t) => nameError(t, rules))) error.push({ code: "NAME_INVALID", path: k.path });
  for (let i = 1; i < end.length; i++) {
    if (end[i].path === end[i - 1].path && (i < 2 || end[i - 2].path !== end[i].path)) error.push({ code: "TARGET_DUPLICATE", path: end[i].path });
  }
  // Creation: a folder under which no file and no block lies any more (everything pulled out or left out) never comes into being, because
  // the upload brings only files. It does not become a code repo and appears as warning FOLDER_EMPTY (otherwise the preview would show
  // "code repo" and the `code-repos` step would silently note `missing`).
  const empty = new Set<string>();
  if (mode === "creation") {
    const content = new Set<string>();
    for (const k of end) {
      if (k.kind !== "file" && !isBlock(k.kind)) continue;
      const t = k.path.split("/");
      for (let i = 1, p = t[0]; i < t.length; p = `${p}/${t[i]}`, i++) content.add(p);
    }
    for (const k of end) if (k.kind === "folder" && !content.has(k.path)) empty.add(k.path);
  }
  const repos: string[] = [];
  for (const k of end) if (isRepo(k) && !(k.kind === "folder" && empty.has(k.path)) && repos[repos.length - 1] !== k.path) repos.push(k.path);
  for (const r of repos) if (!repoLocationVisible(r, rules)) error.push({ code: "CODE_REPO_LOCATION", path: r });
  if (repos.length > rules.limits.repos) error.push({ code: "TOO_MANY_REPOS" });
  for (const a of repos) for (const b of repos) {
    if (a !== b && a.startsWith(`${b}/`)) error.push({ code: "REPO_IN_REPO", path: a, second: b });
  }
  // A block contains nothing in the tree (its inside is no node). If another node lies below it, it has landed in a block: a repo there
  // is already REPO_IN_REPO, everything else IN_CODE_REPO.
  // Via the set of block paths and the ancestors per node, from the shortest: the same block as "the first in path order" (a shorter
  // prefix sorts before the longer); a `find` per node was quadratic.
  const blockPaths = new Set(end.filter((b) => isBlock(b.kind)).map((b) => b.path));
  if (blockPaths.size) for (const k of end) {
    if (isRepo(k)) continue;
    const t = k.path.split("/");
    for (let i = 1, p = t[0]; i < t.length; p = `${p}/${t[i]}`, i++) {
      if (blockPaths.has(p)) { error.push({ code: "IN_CODE_REPO", path: k.path, second: p }); break; }
    }
  }

  const startOf = new Map(node.map((x) => [x.k, x.start]));
  for (const k of end) {
    if (k.kind === "folder" && !k.codeRepo && rules.limits.dependencies.includes(nameOf(k.path))) {
      warnings.push({ code: "DEPENDENCY", path: k.path });
    }
    const start = startOf.get(k) ?? k.path;
    if (k.kind === "file" && MEMORY.includes(nameOf(start)) && !start.includes("/") && k.path.includes("/")) {
      warnings.push({ code: "MEMORY", path: k.path });
    }
  }
  if (mode === "inventory" && node.filter((x) => x.wasRepo).length === 1 && repos.length >= 2) warnings.push({ code: "REPO_SHARED" });
  for (const k of end) if (k.kind === "folder" && empty.has(k.path)) warnings.push({ code: "FOLDER_EMPTY", path: k.path });

  // ── Mapping (creation) or final mapping (inventory) ───────────────────────────────────────────────────────────────────
  // One entry per node that lies differently from where its INITIAL parent node would take it, and per topmost left-out node.
  const mapping: Record<string, MappingEntry[]> = {};
  const finalMapping: FinalMapping = { ways: [], gone: [], codeRepos: [] };
  for (const x of node) {
    const e = x.startParent;
    const ofStart = x.k.origin ?? x.start;
    const carriedOver = e ? connect(e.k.path, nameOf(x.start)) : x.start;
    let entry: MappingEntry | null = null;
    if (x.gone) { if (!e || !e.gone) entry = { from: ofStart, to: null }; }
    else if (!e || e.gone || x.k.path !== carriedOver) entry = { from: ofStart, to: x.k.path };
    if (mode === "creation") {
      if (x.k.source === undefined || x.k.origin === undefined) continue;
      // A topmost node of a source ALWAYS gets an entry (otherwise `targetOf` would not find its files).
      if (!entry && !e) entry = { from: ofStart, to: x.k.path };
      if (entry) (mapping[String(x.k.source)] ??= []).push(entry);
    } else {
      if (entry && entry.to === null) finalMapping.gone.push(x.start);
      else if (entry && (e || entry.to !== x.start)) finalMapping.ways.push({ old: x.start, fresh: entry.to as string });
      if (!x.gone && x.newlyMarked) finalMapping.codeRepos.push(x.k.path);
    }
  }
  for (const list of Object.values(mapping)) list.sort((a, b) => compare(a.from, b.from));
  finalMapping.ways.sort((a, b) => compare(a.old, b.old));
  finalMapping.gone.sort(compare);
  finalMapping.codeRepos.sort(compare);

  const codeRepos: string[] = [];
  for (const k of end) if (k.kind === "folder" && k.codeRepo && !empty.has(k.path) && codeRepos[codeRepos.length - 1] !== k.path) codeRepos.push(k.path);
  return { finalTree: end, mapping, finalMapping, codeRepos, repos, error, warnings };
}

/**
 * PURE: the target path of a file with origin `origin` (path in its source); the longest matching `from` prefix wins.
 * `null` = left out; `undefined` = no entry covers it (the caller has an error, never "leave out").
 */
export function targetOf(mapping: MappingEntry[], origin: string): string | null | undefined {
  let best: MappingEntry | null = null;
  for (const e of mapping) {
    if (e.from && under(origin, e.from) && (!best || e.from.length > best.from.length)) best = e;
  }
  if (!best) return undefined;
  return best.to === null ? null : best.to + origin.slice(best.from.length);
}

// ── The tree from the selection in the client (creation) ─────────────────────────────────────────────────────────────────────────

export interface SelectionFile { rel: string; size: number }
export interface Selection {
  seq: number;
  kind: "folder" | "files" | "clone";
  /** Folder: its name (topmost node, default target `<name>/…`). Files: empty. Clone: the default name from the URL. */
  name: string;
  /** Folder: paths UNDER the folder; files: the file names. Clone: empty (the content is unknown before cloning). */
  files: SelectionFile[];
}

export interface UploadFile { origin: string; rel: string; size: number }

export interface SelectionTree {
  node: Node[];
  /** Per source (key = number as text) the files that are uploaded, including the repos' `.git` content. */
  upload: Record<string, UploadFile[]>;
  /** GIT_FILE_TOT (a `.git` file without a valid target, left out), NAME_OMITTED (a name inside a block that the server does not
   *  accept), SOURCE_EMPTY (nothing to upload), NAME_SUPPLEMENTED. */
  hints: Notice[];
  /** Files that do not come along per `rules.omit`, as a dead `.git` file or with NAME_OMITTED. */
  omitted: number;
}

/** A path of the selection as nodes and mapping carry it (`\` → `/`, no outer `/`, NFC). */
export const normal = (p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");

/** PURE: `folder` + relative `target` resolved without leaving the root, or null. */
function resolve(folder: string, target: string): string | null {
  const stack: string[] = [];
  for (const t of connect(folder, target).split("/")) {
    if (t === "" || t === ".") continue;
    if (t === "..") { if (!stack.length) return null; stack.pop(); continue; }
    stack.push(t);
  }
  return stack.join("/");
}

/** PURE: `name`, or with a suffix `-2`, `-3`, … (for a file before the last extension), until it is not in `occupied`. */
export function freeName(name: string, occupied: Set<string>, isFolder: boolean): string {
  if (!occupied.has(name)) return name;
  const point = isFolder ? -1 : name.lastIndexOf(".");
  const stem = point > 0 ? name.slice(0, point) : name;
  const suffix = point > 0 ? name.slice(point) : "";
  for (let i = 2; ; i++) {
    const n = `${stem}-${i}${suffix}`;
    if (!occupied.has(n)) return n;
  }
}

/** The number of `.git` path parts (exactly one means: the inside of a repo, not a repo inside a repo). */
const gitParts = (p: string) => p.split("/").filter((t) => t === ".git").length;

/**
 * PURE: the selection → nodes.
 * - A folder with `.git/HEAD` IS a code repo (block, inside hidden).
 * - A `.git` FILE: `gitFiles` carries its content (key `<seq>:<origin>`), which the caller read beforehand.
 *   If its `gitdir` points, relative and within the same source, to an existing `.git/modules/…` or `.git/worktrees/…` of a brought-along
 *   repo, it comes along (submodule or worktree; if it lies outside every repo, the folder is a worktree block). Any other is dead: it
 *   is dropped (hint GIT_FILE_TOT), the folder is a normal folder.
 * - Default: the topmost folder of a folder source carries the code-repo mark, unless it contains repos.
 * - Omission follows `rules.omit`, never anything INSIDE a `.git` folder (that belongs to the repo).
 * - A source without a single file yields no node (hint SOURCE_EMPTY); the POST leaves it out.
 * - Equal top-level names across several sources (two folders "src", two "README.md") get a suffix from the second on (`src-2`,
 *   `README-2.md`, hint NAME_SUPPLEMENTED): a step addresses a node by its path, and of two equal paths it would always hit the first,
 *   so the second could be neither renamed nor left out.
 */
export function treeFromSelection(sources: Selection[], rules: Rules, gitFiles: Record<string, string> = {}): SelectionTree {
  const node: Node[] = [];
  const upload: Record<string, UploadFile[]> = {};
  const hints: Notice[] = [];
  let omitted = 0;
  const occupied = new Set<string>();

  for (const q of sources) {
    if (q.kind === "clone") {
      // A clone is ONE block with unknown content: name and place are changeable, the content is not. It does not come from the browser,
      // nothing is uploaded.
      const n = normal(q.name);
      const free = freeName(n, occupied, true);
      if (free !== n) hints.push({ code: "NAME_SUPPLEMENTED", path: free, second: n });
      occupied.add(free);
      upload[String(q.seq)] = [];
      node.push({ path: free, kind: "clone", source: q.seq, origin: n });
      continue;
    }
    const prefix = q.kind === "folder" ? normal(q.name) : "";
    const files: UploadFile[] = [];
    for (const d of q.files) {
      const rel = normal(d.rel);
      if (!rel) continue;
      const origin = connect(prefix, rel);
      const parts = origin.split("/");
      const g = parts.indexOf(".git");
      const folderParts = g >= 0 ? parts.slice(0, g) : parts.slice(0, -1);
      if (folderParts.some((t) => rules.omit.folder.includes(t)) || (g < 0 && rules.omit.files.includes(parts[parts.length - 1]))) {
        omitted++;
        continue;
      }
      files.push({ origin, rel, size: Math.max(0, Math.floor(Number(d.size) || 0)) });
    }

    const repoFolder = new Set<string>();
    for (const d of files) {
      if (d.origin.endsWith("/.git/HEAD") && gitParts(d.origin) === 1) repoFolder.add(d.origin.slice(0, -"/.git/HEAD".length));
    }
    const hasUnder = (p: string) => files.some((d) => d.origin.startsWith(`${p}/`));
    const liveGitFile = new Set<string>(); // folders with a valid `.git` file
    const totGit = new Set<string>();
    for (const d of files) {
      if (nameOf(d.origin) !== ".git" || gitParts(d.origin) !== 1) continue;
      const folder = parentOf(d.origin);
      const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(gitFiles[`${q.seq}:${d.origin}`] ?? "");
      const target = m ? m[1] : "";
      const resolved = target && !target.startsWith("/") && !/^[A-Za-z]:/.test(target) ? resolve(folder, target) : null;
      const parts = resolved ? resolved.split("/") : [];
      const gi = parts.indexOf(".git");
      const alive = resolved !== null && gi >= 0 && (parts[gi + 1] === "modules" || parts[gi + 1] === "worktrees")
        && parts.length > gi + 2 && hasUnder(resolved) && repoFolder.has(parts.slice(0, gi).join("/"));
      if (alive) liveGitFile.add(folder);
      else { totGit.add(d.origin); hints.push({ code: "GIT_FILE_TOT", path: d.origin }); }
    }
    // Blocks: repo folders and folders with a valid `.git` file; the outermost wins (a submodule in a repo is its content).
    const candidates: [string, NodeKind][] = [
      ...[...repoFolder].map((o): [string, NodeKind] => [o, "code-repo"]),
      ...[...liveGitFile].filter((o) => !repoFolder.has(o)).map((o): [string, NodeKind] => [o, "worktree"]),
    ].filter(([o]) => o !== "");
    const blocks = candidates.filter(([o]) => !candidates.some(([b]) => b !== o && o.startsWith(`${b}/`)));
    const inBlock = (p: string) => blocks.some(([b]) => under(p, b));
    // A file that becomes NO node (the inside of a block, the content of a `.git` folder) is checked against no name rule of the layout.
    // The server does check (`rules.js` `uploadPath`: inside, control characters and broken UTF-16), for the whole batch and only AFTER
    // creation. Such files stay out with hint NAME_OMITTED (a macOS "Icon\r" in a repo made the whole source fail). A node carries its
    // rule itself (NAME_INVALID).
    const insideInvalid = (d: UploadFile) => {
      const t = d.origin.split("/");
      if (!t.includes(".git") && !inBlock(d.origin)) return false;
      return t.some((x) => CONTROL_CHARACTERS.test(x) || /[\ud800-\udfff]/.test(x.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")));
    };
    const keep: UploadFile[] = [];
    for (const d of files) {
      if (totGit.has(d.origin)) continue;
      if (insideInvalid(d)) { hints.push({ code: "NAME_OMITTED", path: d.origin }); continue; }
      keep.push(d);
    }
    omitted += files.length - keep.length;
    if (!keep.length) {
      hints.push({ code: "SOURCE_EMPTY", ...(prefix ? { path: prefix } : {}) });
      upload[String(q.seq)] = [];
      continue;
    }
    upload[String(q.seq)] = keep;

    // Topmost names of this source against those of the previous ones: from the second on with a suffix. `target(origin)` is the start path.
    const top = new Map<string, string>();
    for (const d of keep) {
      const first = d.origin.split("/")[0];
      if (top.has(first)) continue;
      const isFolder = d.origin.includes("/");
      const free = freeName(first, occupied, isFolder);
      if (free !== first) hints.push({ code: "NAME_SUPPLEMENTED", path: free, second: first });
      top.set(first, free);
    }
    for (const free of top.values()) occupied.add(free);
    const target = (h: string) => { const i = h.indexOf("/"); const e = i < 0 ? h : h.slice(0, i); return (top.get(e) ?? e) + (i < 0 ? "" : h.slice(i)); };

    // The size per folder in ONE pass over each file's ancestors (a `reduce` per folder was quadratic).
    const sizeByPath = new Map<string, number>();
    for (const d of keep) {
      const t = d.origin.split("/");
      for (let i = 1, p = t[0]; i < t.length; p = `${p}/${t[i]}`, i++) sizeByPath.set(p, (sizeByPath.get(p) ?? 0) + d.size);
    }
    const sizeUnder = (p: string) => sizeByPath.get(p) ?? 0;

    const folderPaths = new Set<string>();
    const rememberParent = (p: string) => { const t = p.split("/"); for (let i = 1; i < t.length; i++) folderPaths.add(t.slice(0, i).join("/")); };
    for (const [b, kind] of blocks) {
      rememberParent(b);
      node.push({ path: target(b), kind, source: q.seq, origin: b, size: sizeUnder(b) });
    }
    for (const d of keep) {
      if (inBlock(d.origin) || d.origin.split("/").includes(".git")) continue;
      rememberParent(d.origin);
      node.push({ path: target(d.origin), kind: "file", source: q.seq, origin: d.origin, size: d.size });
    }
    for (const o of folderPaths) {
      if (inBlock(o) || o.split("/").includes(".git")) continue;
      const marker = q.kind === "folder" && o === prefix && !blocks.some(([b]) => b.startsWith(`${o}/`));
      node.push({ path: target(o), kind: "folder", source: q.seq, origin: o, size: sizeUnder(o), ...(marker ? { codeRepo: true } : {}) });
    }
  }
  node.sort((a, b) => (a.source ?? 0) - (b.source ?? 0) || compare(a.path, b.path));
  return { node, upload, hints, omitted };
}

// ── What the UI offers per node (actions) ──────────────────────────────────────────────────────────────

export interface Actions { move: boolean; rename: boolean; leaveOut: boolean; mark: boolean; unmark: boolean }

/** PURE: the actions of a node in the final tree. `onlyView` (an open setup/copy, relocation) switches everything off. */
export function actionsFor(k: Node, finalTree: Node[], mode: Mode, onlyView = false): Actions {
  if (onlyView) return { move: false, rename: false, leaveOut: false, mark: false, unmark: false };
  const folder = k.kind === "folder";
  const repoInside = finalTree.some((x) => x !== k && isRepo(x) && x.path.startsWith(`${k.path}/`));
  const repoAbove = finalTree.some((x) => x !== k && isRepo(x) && k.path.startsWith(`${x.path}/`));
  return {
    move: true,
    rename: true,
    // A clone is left out through its source (removal), not through the layout.
    leaveOut: k.kind !== "clone",
    mark: folder && !k.codeRepo && !repoInside && !repoAbove,
    unmark: mode === "creation" && folder && Boolean(k.codeRepo),
  };
}

/** PURE: the folders `k` may be moved into: the root ("") and every normal folder except `k`, its inside and its current parent folder. */
export function targetsFor(k: Node, finalTree: Node[]): string[] {
  const now = parentOf(k.path);
  const targets: string[] = now === "" ? [] : [""];
  for (const x of finalTree) {
    if (x.kind !== "folder" || under(x.path, k.path) || x.path === now) continue;
    if (finalTree.some((b) => isBlock(b.kind) && x.path.startsWith(`${b.path}/`))) continue;
    if (!targets.includes(x.path)) targets.push(x.path);
  }
  return targets;
}
