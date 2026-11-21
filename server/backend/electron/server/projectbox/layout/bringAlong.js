// The paths in database and data folder after a layout. Pure except for the writers at the end of each function; each is REPEATABLE — a
// value that already carries the new path stays (targetOf does not map it again, because the final mapping maps old paths to new ones
// and a new path never lies under an old one that no longer exists — except in a swap: there the procedure writes the result ONCE to the
// journal and replays it on the second run instead of computing anew).
//
//   projections(plan, root, rootReal)   → { rel(r) → r' | null | r, abs(a) → a' | null | a, abb }   null = left out
//   normDir(dir)                         the form of `project_services.dir`: relative, without `./`, without a trailing slash — or null
//                                        (absolute, `..`), then the row stays as it is
//   servicesPlan(pid, ab)                [{ id, name, old, fresh }] — `fresh` null: the service falls (it lay under a left-out path);
//                                        the start commands and all other texts stay
//   knowledgePlan(pid, ab)               [{ id, codePaths, lastVerified }] — prefix in `code_paths`, key in `last_verified.commits`; a path
//                                        under a left-out one drops out of the list
//   graphPlan(pid, ab)                   [{ id, path, info, links? }] — `graph_starts.worktree_info` (repos[].root/relPath/name,
//                                        own[].source, skipped[]). A left-out repo drops out of `repos` together with the `own` under its
//                                        `target` (its worktree falls in step 11) — path and info empty only if NO repo remains (before,
//                                        one repo emptied the whole row, and the running graph workflow kept working in the main working
//                                        tree; deliberate deviation from "left-out repos: clear worktree_path", which applied to the run
//                                        with ONE repo). `links`: the linked dependencies (`kind: "link"`) whose `source` changed — the
//                                        procedure sets them again in the project container (rebuild-program.js `links`)
//   subagentsPlan(pid, ab)               [{ chatId, agentId, fields }] — `cwd`, `worktree.repo`, `worktreeRepo`
//   bringAlongPostWork(pid, ab)          `<data>/git-post-work/<pid>.jsonl`: `repo` per worktree (the file belongs to B — never mounted, see
//                                        runs/git-post-work.js)
// The writers: writeServices, writeKnowledge, writeGraph, writeSubagents.
import fs from "node:fs";
import path from "node:path";
import * as store from "../../store.js";
import { postWorkFile } from "../../runs/git-post-work.js";
import { mappingFromEnd, targetOf } from "./plan.js";

// By whole path parts: "..old" lies under the root.
const underAbs = (p, b) => { const r = path.relative(b, p); return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };

/** The two projections of the plan: relative to the root and absolute (both versions of the root, git writes realpath). */
export function projections(plan, root, rootReal = root) {
  const abb = mappingFromEnd(plan?.finalMapping || { ways: [], gone: [] });
  const rel = (r) => {
    const z = targetOf(abb, String(r ?? ""));
    return z === undefined ? String(r ?? "") : z;
  };
  const abs = (a) => {
    if (typeof a !== "string" || !path.isAbsolute(a)) return a;
    for (const w of [...new Set([path.resolve(root), path.resolve(rootReal || root)])]) {
      if (!underAbs(a, w)) continue;
      const r = path.relative(w, path.resolve(a));
      if (r === "") return a;
      const n = rel(r.split(path.sep).join("/"));
      return n === null ? null : path.join(w, n);
    }
    return a;
  };
  return { rel, abs, abb };
}

/** The form of the column `dir` (see header). */
export function normDir(dir) {
  let d = String(dir ?? "").trim().replace(/\\/g, "/");
  if (path.posix.isAbsolute(d)) return null;
  while (d.startsWith("./")) d = d.slice(2);
  d = d.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (d === ".") d = "";
  if (d.split("/").some((t) => t === "..")) return null;
  return d;
}

export function servicesPlan(pid, proj) {
  const out = [];
  for (const s of store.listProjectServices(pid)) {
    const d = normDir(s.dir);
    if (d === null || d === "") continue;
    const n = proj.rel(d);
    if (n === d) continue;
    out.push({ id: s.id, name: s.name, old: s.dir, fresh: n });
  }
  return out;
}

export function writeServices(pid, plan, { instance = "main", deleteLog = null } = {}) {
  const dropped = [];
  for (const d of plan) {
    const now = store.getProjectService(d.id);
    if (!now) continue;
    if (d.fresh === null) {
      store.serviceFallsWithLayout(d.id);
      dropped.push({ id: d.id, name: d.name });
      // desired.services: a service that no longer exists triggers no restore.
      const inst = store.projectInstance(pid, instance);
      const ids = (Array.isArray(inst?.desired?.services) ? inst.desired.services : []).map(Number);
      if (ids.includes(Number(d.id))) store.changeProjectInstance(pid, instance, { desired: { ...inst.desired, services: ids.filter((x) => x !== Number(d.id)) } });
      if (typeof deleteLog === "function") deleteLog(d.id);
      continue;
    }
    if (normDir(now.dir) === d.fresh) continue;
    store.updateProjectService(d.id, { dir: d.fresh });
  }
  return dropped;
}

export function knowledgePlan(pid, proj) {
  let list;
  try { list = store.listProjectContext(pid, { withBody: false }); } catch { return []; }
  const out = [];
  for (const c of list) {
    const cp = Array.isArray(c.codePaths) ? c.codePaths : [];
    const newCp = [];
    let different = false;
    for (const p of cp) {
      const d = normDir(p);
      if (d === null || d === "") { newCp.push(p); continue; }
      const n = proj.rel(d);
      if (n === d) { newCp.push(p); continue; }
      different = true;
      if (n !== null) newCp.push(n);
    }
    let lv = c.lastVerified && typeof c.lastVerified === "object" ? c.lastVerified : null;
    if (lv?.commits && typeof lv.commits === "object") {
      const commits = {};
      for (const [k, v] of Object.entries(lv.commits)) {
        const d = normDir(k);
        const n = d === null || d === "" ? k : proj.rel(d);
        if (n !== k) different = true;
        if (n !== null) commits[n] = v;
      }
      lv = { ...lv, commits };
    }
    if (different) out.push({ id: c.id, codePaths: newCp, lastVerified: lv });
  }
  return out;
}

export function writeKnowledge(pid, plan) {
  for (const w of plan) store.updateProjectContext(pid, w.id, { codePaths: w.codePaths, lastVerified: w.lastVerified });
  return plan.length;
}

/** `graph_starts` of the runs of THIS project (`info.projectId`) whose repo was moved or left out (see header). */
export function graphPlan(pid, proj) {
  const out = [];
  const newRepo = (r, root) => {
    const rel = typeof r.relPath === "string" && r.relPath ? proj.rel(normDir(r.relPath) ?? r.relPath) : r.relPath;
    return { ...r, root, relPath: rel ?? r.relPath, name: path.basename(root) };
  };
  for (const z of store.graphWorktreeRows()) {
    let info = null;
    try { info = z.info ? JSON.parse(z.info) : null; } catch { info = null; }
    if (!info || String(info.projectId || "") !== String(pid) || !Array.isArray(info.repos)) continue;
    let different = false;
    const gone = []; // the `target`s of the left-out repos
    const repos = [];
    for (const r of info.repos) {
      if (!r || typeof r !== "object") { repos.push(r); continue; }
      const root = proj.abs(r.root);
      if (root === null) { different = true; if (typeof r.target === "string") gone.push(r.target); continue; }
      if (root === r.root) { repos.push(r); continue; }
      different = true;
      repos.push(newRepo(r, root));
    }
    if (!repos.some((r) => r && typeof r === "object")) { if (different) out.push({ id: z.id, path: "", info: "", gone: true }); continue; }
    const links = [];
    const own = Array.isArray(info.own) ? info.own.flatMap((e) => {
      if (!e || typeof e !== "object") return [e];
      if (typeof e.path === "string" && gone.some((f) => underAbs(e.path, f))) { different = true; return []; }
      if (typeof e.source !== "string") return [e];
      const q = proj.abs(e.source);
      if (q === e.source || q === null) return [e];
      different = true;
      if (e.kind === "link" && typeof e.path === "string") links.push({ path: e.path, source: q });
      return [{ ...e, source: q }];
    }) : info.own;
    // The repos without a checked-in file (workflows/worktree.js `skipped`, the prompt names their place in the main folder).
    let skipped = info.skipped;
    if (Array.isArray(skipped)) {
      skipped = skipped.flatMap((u) => {
        if (!u || typeof u !== "object" || typeof u.root !== "string") return [u];
        const root = proj.abs(u.root);
        if (root === u.root) return [u];
        different = true;
        return root === null ? [] : [newRepo(u, root)];
      });
    }
    if (different) {
      const newInfo = { ...info, repos, own, ...(Array.isArray(skipped) ? { skipped } : {}) };
      out.push({ id: z.id, path: z.path, info: JSON.stringify(newInfo), ...(links.length ? { links } : {}) });
    }
  }
  return out;
}

export function writeGraph(plan) {
  for (const g of plan) store.changeGraphStart(g.id, { worktreePath: g.path, worktreeInfo: g.info });
  return plan.length;
}

/** Subagents: `cwd` under a moved path, `worktree.repo` and `worktreeRepo` (a fresh worktree arises from them on a resume). A
 *  left-out repo: `worktree`/`worktreeRepo` fall (an `undefined` removes the key, store/subagents.js). */
export function subagentsPlan(pid, proj, chatIds) {
  const chats = new Set(chatIds.map(String));
  const out = [];
  for (const s of store.subagentsLocations()) {
    if (!chats.has(String(s.chatId))) continue;
    const old = store.readSubagentLocation(s.chatId, s.agentId);
    if (!old) continue;
    const fields = {};
    if (old.hasCwd && typeof old.cwd === "string") {
      const c = proj.abs(old.cwd);
      if (c !== old.cwd) fields.cwd = c === null ? undefined : c;
    }
    if (old.hasWorktree && old.worktree && typeof old.worktree === "object" && typeof old.worktree.repo === "string") {
      const r = proj.abs(old.worktree.repo);
      if (r === null) fields.worktree = undefined;
      else if (r !== old.worktree.repo) fields.worktree = { ...old.worktree, repo: r };
    }
    if (old.hasWorktreeRepo && typeof old.worktreeRepo === "string") {
      const r = proj.abs(old.worktreeRepo);
      if (r !== old.worktreeRepo) fields.worktreeRepo = r === null ? undefined : r;
    }
    if (Object.keys(fields).length) out.push({ chatId: s.chatId, agentId: s.agentId, fields });
  }
  return out;
}

export function writeSubagents(plan) {
  for (const s of plan) store.setSubagentFields(s.chatId, s.agentId, s.fields);
  return plan.length;
}

/** The post-work file: `repo` per worktree to the new place; a worktree of a left-out repo drops out of the row, an empty row entirely.
 *  → number of changed rows. */
export function bringAlongPostWork(pid, proj) {
  let file;
  try { file = postWorkFile(pid); } catch { return 0; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return 0; throw e; }
  let n = 0;
  const rows = [];
  for (const z of text.split("\n")) {
    if (!z.trim()) continue;
    let a;
    try { a = JSON.parse(z); } catch { rows.push(z); continue; }
    if (!a || !Array.isArray(a.worktrees)) { rows.push(z); continue; }
    let different = false;
    const wt = [];
    for (const w of a.worktrees) {
      const r = typeof w?.repo === "string" ? proj.abs(w.repo) : w?.repo;
      if (r === null) { different = true; continue; }
      if (r !== w.repo) different = true;
      wt.push({ ...w, repo: r });
    }
    if (!different) { rows.push(z); continue; }
    n++;
    if (wt.length) rows.push(JSON.stringify({ ...a, worktrees: wt }));
  }
  if (!n) return 0;
  const tmp = `${file}.layout-${process.pid}`;
  fs.writeFileSync(tmp, rows.length ? `${rows.join("\n")}\n` : "", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return n;
}
