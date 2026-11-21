// The layout of a project as a pure computation, server version.
//
// ONE computation, three places: `web/src/lib/project-layout.ts` (web), `mobile/CbaseMobile/Code/ProjectLayout.swift` (iOS) and this
// file. Bound through ONE fixture set `server/backend/test/fixtures/layout-plan/*.json` (README there) — the server test is
// `server/backend/test/layout-plan.test.js`. If preview and server computed differently, the project tab would show one end tree, and
// the adoption would carry out another.
//
// This file is a transfer of `computePlan`, `targetOf` and their helpers from the web module, line by line, without TypeScript — the
// same names, the same order of the rules, the same sortings (`compare` by UTF-16 units, never `localeCompare`). `treeFromSelection`,
// `freeName`, `actionsFor` and `targetsFor` are the UI's business (the selection in the client does not exist on the server) and
// stand here NOT. Whoever changes something here changes it in all three places and updates the fixtures (README there).
//
//   computePlan(tree, steps, rules, mode)   steps → { finalTree, mapping, finalMapping, codeRepos, repos, error, warnings }
//   targetOf(mapping, origin)               the longest matching `from` prefix wins; null = left out, undefined = not covered
//   nameError(name, rules), repoLocationVisible(rel, rules), isBlock(kind), isRepo(k), parentOf, nameOf, under, compare
//
// The rules come from `projectbox/setup/rules.js` `rulesResponse()` (the route hands them in) — never a second version here. Steps and
// nodes: see the header of the web module; paths relative to the root, in the state AFTER the previous steps.

const MEMORY = ["CLAUDE.md", "AGENTS.md"];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export const parentOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
export const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
/** Does `a` lie under `b` (or is it)? `b` empty = the root. */
export const under = (a, b) => b === "" || a === b || a.startsWith(`${b}/`);
const connect = (a, b) => (a ? (b ? `${a}/${b}` : a) : b);
/** Comparison by UTF-16 units (never `localeCompare`): Swift compares `Array(s.utf16)` the same way. */
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** PURE: why `name` does not do as ONE path part — or null (the same reasons as `rules.js` `nameError`). */
export function nameError(name, rules) {
  if (typeof name !== "string" || !name) return "empty";
  if (rules.names.forbidden.includes(name)) return "forbidden";
  if (name.includes("/") || name.includes("\\")) return "slash";
  if (CONTROL_CHARACTERS.test(name)) return "controlCharacters";
  if (name.toLowerCase().startsWith(rules.names.prefix)) return "prefix";
  if (/[\ud800-\udfff]/.test(name.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) return "utf8";
  return null;
}

/** PURE: does the repo search (`findRepos`) see a repo at this place? Like `git.js` `repoLocationVisible`. */
export function repoLocationVisible(rel, rules) {
  if (!rel) return true;
  const parts = rel.split("/");
  if (parts.length > rules.limits.depth) return false;
  return parts.every((t) => Boolean(t) && !t.startsWith(".") && !rules.limits.skip.includes(t));
}

/** A block: the layout does not show its inside, and nothing is moved into it. */
export const isBlock = (kind) => kind === "code-repo" || kind === "worktree" || kind === "clone";
/** A repo after setup: every block and every marked folder. */
export const isRepo = (k) => isBlock(k.kind) || (k.kind === "folder" && Boolean(k.codeRepo));

const byPath = (a, b) =>
  compare(a.path, b.path) || (a.source ?? 0) - (b.source ?? 0) || compare(a.origin ?? "", b.origin ?? "");

/** PURE: steps → plan. `mode` "creation" | "inventory". */
export function computePlan(tree, steps, rules, mode) {
  const node = tree.map((k) => {
    const n = { path: k.path, kind: k.kind };
    if (k.source !== undefined) n.source = k.source;
    if (k.origin !== undefined) n.origin = k.origin;
    if (k.size !== undefined) n.size = k.size;
    if (k.kind === "folder" && k.codeRepo) n.codeRepo = true;
    return { k: n, start: k.path, name: nameOf(k.path), parent: null, base: parentOf(k.path), startParent: null, gone: false, newlyMarked: false, wasRepo: isRepo(n) };
  });
  // Initial parents: the node at the parent path, same source first, otherwise the first in tree order (table per start path).
  const perStart = new Map();
  for (const y of node) { const l = perStart.get(y.start); if (l) l.push(y); else perStart.set(y.start, [y]); }
  for (const x of node) {
    if (!x.base) continue;
    const candidates = (perStart.get(x.base) ?? []).filter((y) => y !== x);
    const e = candidates.find((y) => y.k.source === x.k.source) ?? candidates[0] ?? null;
    if (e) { x.parent = e; x.startParent = e; x.base = ""; }
  }
  const pathOf = (x) => {
    const parts = [];
    let y = x;
    let base = "";
    const seen = new Set();
    while (y && !seen.has(y)) { seen.add(y); parts.unshift(y.name); base = y.base; y = y.parent; }
    return connect(base, parts.join("/"));
  };
  const refresh = () => { for (const x of node) x.k.path = pathOf(x); };
  const below = (x, y) => { for (let e = y.parent; e; e = e.parent) if (e === x) return true; return false; };
  const error = [];
  const warnings = [];
  const find = (p) => (p ? node.find((x) => !x.gone && x.k.path === p) : undefined);
  const no = (code, step, path) => { error.push({ code, step, path }); };

  steps.forEach((s, i) => {
    if (s.kind === "move") {
      const from = String(s.from ?? ""), to = String(s.to ?? "");
      const x = find(from);
      if (!x) return no("STEP_UNKNOWN", i, from);
      if (!to || to === from || under(to, from)) return no("STEP_INVALID", i, to);
      const ep = parentOf(to);
      let e = null;
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
        // In the inventory there is no "remove the mark" (that would mean deleting `.git` — not supported).
        if (mode !== "creation" || x.k.kind !== "folder" || !x.k.codeRepo) return no("STEP_INVALID", i, p);
        delete x.k.codeRepo;
        x.newlyMarked = false;
      }
      return;
    }
    no("STEP_UNKNOWN", i, "");
  });

  // ── The end tree and its rules ──────────────────────────────────────────────────────────────────────────────────────
  const end = node.filter((x) => !x.gone).map((x) => x.k).sort(byPath);
  for (const k of end) if (k.path.split("/").some((t) => nameError(t, rules))) error.push({ code: "NAME_INVALID", path: k.path });
  for (let i = 1; i < end.length; i++) {
    if (end[i].path === end[i - 1].path && (i < 2 || end[i - 2].path !== end[i].path)) error.push({ code: "TARGET_DUPLICATE", path: end[i].path });
  }
  // Creation: a folder without a file and without a block below it never arises — no code repo, warning FOLDER_EMPTY.
  const empty = new Set();
  if (mode === "creation") {
    const content = new Set();
    for (const k of end) {
      if (k.kind !== "file" && !isBlock(k.kind)) continue;
      const t = k.path.split("/");
      for (let i = 1, p = t[0]; i < t.length; p = `${p}/${t[i]}`, i++) content.add(p);
    }
    for (const k of end) if (k.kind === "folder" && !content.has(k.path)) empty.add(k.path);
  }
  const repos = [];
  for (const k of end) if (isRepo(k) && !(k.kind === "folder" && empty.has(k.path)) && repos[repos.length - 1] !== k.path) repos.push(k.path);
  for (const r of repos) if (!repoLocationVisible(r, rules)) error.push({ code: "CODE_REPO_LOCATION", path: r });
  if (repos.length > rules.limits.repos) error.push({ code: "TOO_MANY_REPOS" });
  for (const a of repos) for (const b of repos) {
    if (a !== b && a.startsWith(`${b}/`)) error.push({ code: "REPO_IN_REPO", path: a, second: b });
  }
  // A block contains nothing in the tree; if another node lies below it, it has ended up in a block (IN_CODE_REPO).
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

  // ── Mapping (creation) or final mapping (inventory) ─────────────────────────────────────────────────────────────────
  // One entry per node that lies differently from where its INITIAL parent node would carry it, and per topmost left-out one.
  const mapping = {};
  const finalMapping = { ways: [], gone: [], codeRepos: [] };
  for (const x of node) {
    const e = x.startParent;
    const ofStart = x.k.origin ?? x.start;
    const carriedOver = e ? connect(e.k.path, nameOf(x.start)) : x.start;
    let entry = null;
    if (x.gone) { if (!e || !e.gone) entry = { from: ofStart, to: null }; }
    else if (!e || e.gone || x.k.path !== carriedOver) entry = { from: ofStart, to: x.k.path };
    if (mode === "creation") {
      if (x.k.source === undefined || x.k.origin === undefined) continue;
      // A topmost node of a source ALWAYS stands there (otherwise `targetOf` would not find its files).
      if (!entry && !e) entry = { from: ofStart, to: x.k.path };
      if (entry) (mapping[String(x.k.source)] ??= []).push(entry);
    } else {
      if (entry && entry.to === null) finalMapping.gone.push(x.start);
      else if (entry && (e || entry.to !== x.start)) finalMapping.ways.push({ old: x.start, fresh: entry.to });
      if (!x.gone && x.newlyMarked) finalMapping.codeRepos.push(x.k.path);
    }
  }
  for (const list of Object.values(mapping)) list.sort((a, b) => compare(a.from, b.from));
  finalMapping.ways.sort((a, b) => compare(a.old, b.old));
  finalMapping.gone.sort(compare);
  finalMapping.codeRepos.sort(compare);

  const codeRepos = [];
  for (const k of end) if (k.kind === "folder" && k.codeRepo && !empty.has(k.path) && codeRepos[codeRepos.length - 1] !== k.path) codeRepos.push(k.path);
  return { finalTree: end, mapping, finalMapping, codeRepos, repos, error, warnings };
}

/**
 * PURE: the target path of `origin` — the longest matching `from` prefix wins. `null` = left out; `undefined` = no entry covers it (in
 * the inventory: the path stays where it is; in creation a caller error).
 */
export function targetOf(mapping, origin) {
  let best = null;
  for (const e of mapping) {
    if (e.from && under(origin, e.from) && (!best || e.from.length > best.from.length)) best = e;
  }
  if (!best) return undefined;
  return best.to === null ? null : best.to + origin.slice(best.from.length);
}

/** Inventory: the final mapping as a mapping for `targetOf` (old → new, left out → null). */
export const mappingFromEnd = (end) => [
  ...end.ways.map((w) => ({ from: w.old, to: w.fresh })),
  ...end.gone.map((a) => ({ from: a, to: null })),
];
