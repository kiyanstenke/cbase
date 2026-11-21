// Create code repos. Used by the setup (step `code-repos`), later by the subsequent upload and by the layout.
//
//   createCodeRepo(inst, root, rel, { signal, home, permissionsFromIndex }) → { created: true } | { created: false, reason, notice }
//   (`permissionsFromIndex`: only creation and subsequent upload — an uploaded repo gets the x bit back from its index, see
//   permissionsFromIndex below.)
//
// In the container, with GIT_HARDENING and without a deadline:
//   1. Folder exists and is no link (access.stat), else a notice (`reason: "missing"`).
//   2. A `.git` FOLDER in it ⇒ already a repo (`reason: "repo"`) — NEVER a commit into a `.git` that cbase did not demonstrably create
//      itself (an uploaded repo without a commit used to count as "our own half init", and the commit took the user's staged index
//      under cbase's message — with the configuration from the upload, `gpg.program` ran). The proof is the marker
//      `.git/cbase-code-repo-creation` (HALF_MARKER), which step 4 lays right after `init` and removes again after the commit: marker
//      without HEAD and without index ⇒ our own half `init` (B died between init and commit) ⇒ `init` once more (harmless) and the
//      commit (repeatable); marker with HEAD ⇒ the commit ran, only the marker falls. A `.git` FILE with a relative `gitdir` to an
//      existing `.git/modules/…` or `.git/worktrees/…` ⇒ submodule or worktree of a repo of the project, no init
//      (`reason: "submodule"`); any other `.git` file never arrived — notice, no init (`reason: "git-file"`).
//   3. A repo INSIDE (projectRepo.js searchProject on the subtree) or a repo ABOVE (ancestors up to the root) ⇒ no init, "stays a
//      normal folder (repos inside)" (collection folder). An ancestor with the marker of the PROJECT repo does not count (at the
//      subsequent upload and in the layout the root carries it already).
//   4. `git init -q -b main`, the marker, then `git commit --allow-empty -q -m "Code repo created (cbase)"` (with `commit.gpgSign=false`,
//      `gc.auto=0`, `maintenance.auto=false` — like HARDENING_COMMIT: a `commit.gpgSign=true` in the `~/.gitconfig` of the project home
//      would otherwise let the commit fail at GIT or a `gpg.program` run), then the marker falls. Every git here with
//      `--git-dir=.git` (an invalid `.git` would otherwise find the root's repo through the search upwards) — the identity ONLY via
//      the environment (GIT_AUTHOR_*/GIT_COMMITTER_*; no configuration is written). B reads it WITHOUT a child process from its OWN
//      `~/.gitconfig` (section `[user]`, only `name`/`email`, without `include`); if it is missing, projectRepo.js IDENTITY. So no
//      new start site arises in B. Nothing is staged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { T } from "../../i18n.js";
import * as access from "../../runtime/fileAccess.js";
import { commandRun } from "../../runtime/git-run.js";
import { GIT_HARDENING, IDENTITY, searchProject, carriesProjectRepoMarker } from "../projectRepo.js";

export const CODE_REPO_MESSAGE = "Code repo created (cbase)";
// The message of a code repo created before the commit messages became English: such a repo is still recognized as ours
// (layout/procedure.js, the repetition of the step "code-repos") — reading old data in users' repos, not an alias.
export const CODE_REPO_MESSAGE_BEFORE = "Code-Repo angelegt (cbase)";
const IDENTITY_NAMES = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

/** PURE: `[user] name/email` from the text of a `.gitconfig` — `{ name?, email? }` (values without quotation marks). */
export function identityFromText(text) {
  const out = {};
  let inUser = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const z = raw.replace(/^\s+|\s+$/g, "");
    if (!z || z.startsWith("#") || z.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(z);
    if (header) { inUser = header[1].toLowerCase() === "user" && !/"/.test(z); continue; }
    if (!inUser) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(z);
    if (!m) continue;
    let value = m[2].replace(/\s+[#;].*$/, "");
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    const k = m[1].toLowerCase();
    if ((k === "name" || k === "email") && value && !/[\r\n\0]/.test(value)) out[k] = value;
  }
  return out;
}

/** The identity of a code-repo commit: from `<home>/.gitconfig` of B (without a child process), else cbase. */
export function codeRepoIdentity(home = os.homedir()) {
  let text = "";
  try {
    const file = path.join(home, ".gitconfig");
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size <= 64 * 1024) text = fs.readFileSync(file, "utf8");
  } catch { text = ""; }
  const i = identityFromText(text);
  const name = i.name || IDENTITY.name;
  const email = i.email || IDENTITY.email;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

const git = (inst, cwd, args, { env = {}, signal } = {}) => commandRun(inst, cwd, "git", [...GIT_HARDENING, ...args], {
  withoutDeadline: true, ...(signal ? { signal } : {}), env: { GIT_TERMINAL_PROMPT: "0", ...env }, envAlways: ["GIT_TERMINAL_PROMPT", ...Object.keys(env)],
});
// The commit of a code repo (header, step 4): GIT_HARDENING (hooks off) plus what HARDENING_COMMIT adds — no signing — and no
// maintenance afterwards (`git commit` would otherwise start `maintenance run --auto` with the repo's configuration).
export const CODE_REPO_COMMIT = Object.freeze(["-c", "commit.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "--git-dir=.git"]);
// The marker of our own half `init` (header, steps 2/4) — an empty file IN `.git`.
export const HALF_MARKER = "cbase-code-repo-creation";

export class CodeRepoError extends Error {
  constructor(code, message) { super(message); this.name = "CodeRepoError"; this.code = code; }
}
const check = (r, what) => {
  if (r.aborted) throw new CodeRepoError("ABORTED", `${what}: aborted`);
  if (r.code !== 0) throw new CodeRepoError("GIT", `${what}: Exit ${r.code ?? r.signal}${r.cap ? `, cap ${r.cap}` : ""} ${String(r.stderr || "").trim().split("\n").pop()?.slice(0, 200) || ""}`.trim());
  return r;
};

// A `.git` FILE applies if its gitdir is relative and points to an existing `.git/modules/…` or `.git/worktrees/…` UNDER the root
// (the same rule as in the SETUP helper).
async function gitFileApplies(inst, root, folderAbs, { signal } = {}) {
  let r;
  try { r = await access.read(inst, path.join(folderAbs, ".git"), { maxBytes: 4096, withoutDeadline: true, signal }); } catch { return false; }
  const text = r?.data ? r.data.toString("utf8") : "";
  const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
  if (!m || path.isAbsolute(m[1])) return false;
  const target = path.resolve(folderAbs, m[1]);
  const w = path.resolve(root);
  if (!target.startsWith(`${w}/`)) return false;
  const parts = path.relative(w, target).split("/");
  if (!parts.some((t, i) => t === ".git" && ["modules", "worktrees"].includes(parts[i + 1]))) return false;
  const st = await access.stat(inst, target, { withoutDeadline: true, signal });
  return st?.kind === "folder";
}

const headExists = async (inst, abs, opts) => (await git(inst, abs, ["--git-dir=.git", "rev-parse", "--verify", "--quiet", "HEAD"], opts)).code === 0;
const commitCodeRepo = async (inst, abs, r, env, signal) => {
  check(await git(inst, abs, [...CODE_REPO_COMMIT, "commit", "--allow-empty", "-q", "-m", CODE_REPO_MESSAGE], { env, signal }), `Code repo ${r}: commit`);
};
const markerGone = async (inst, abs, signal) => {
  try { await access.erase(inst, path.join(abs, ".git", HALF_MARKER), { withoutDeadline: true, signal }); } catch (e) { if (e?.code !== "ENOENT") throw e; }
};

// An uploaded repo arrives without file permissions: the browser transfers none, every file lands with 0644 (a ZIP carries its
// permissions, the SETUP helper sets them). Where the index lists a file as executable (100755) and the tree carries it without the x
// bit (git: "mode change 100755 => 100644"), it gets it back — otherwise every script would show as a change, and a commit would take
// its permission away in the repo. Only on request (`permissionsFromIndex`: creation and subsequent upload), never in the layout —
// there a missing x bit is a decision in the repo, no loss at upload. `core.fileMode=false` in the repo reports no permissions: then
// everything stays as it is. chmod as agent in the container: a link that stepped into the place between reading and chmod would give
// the x bit only to files that agent may change anyway. → number of files.
async function permissionsFromIndex(inst, abs, r, signal) {
  const d = check(await git(inst, abs, ["--git-dir=.git", "diff", "--raw", "-z", "--no-renames", "--diff-filter=M"], { signal }), `Code repo ${r}: read permissions`);
  const parts = d.stdout.split("\0");
  const paths = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [old, fresh] = parts[i].replace(/^:/, "").split(" ");
    if (old === "100755" && fresh === "100644" && parts[i + 1]) paths.push(parts[i + 1]);
  }
  for (let i = 0; i < paths.length; i += 200) {
    check(await commandRun(inst, abs, "chmod", ["+x", "--", ...paths.slice(i, i + 200)], { withoutDeadline: true, ...(signal ? { signal } : {}) }), `Code repo ${r}: set permissions`);
  }
  return paths.length;
}

// Best effort: a repo whose permissions cannot be read or set does not stop the creation — the notice says so.
async function permissionsNotice(inst, abs, r, signal) {
  try {
    const n = await permissionsFromIndex(inst, abs, r, signal);
    return n ? T` — ${n} file(s) executable again as in the index` : "";
  } catch (e) {
    if (e?.code === "ABORTED") throw e;
    return T` — file permissions not set from the index (${String(e?.message || e).slice(0, 120)})`;
  }
}

export async function createCodeRepo(inst, root, rel, { signal = null, home, permissionsFromIndex: permissions = false } = {}) {
  if (!inst) throw new TypeError("createCodeRepo: only with an instance (in the project container)");
  const w = path.resolve(String(root || ""));
  const r = String(rel || "").replace(/^\/+|\/+$/g, "");
  if (!r || r.split("/").some((t) => !t || t === "." || t === "..")) throw new TypeError(`createCodeRepo: no place under the root (“${rel}”)`);
  const abs = path.join(w, r);
  const opts = { signal };
  // 1. Folder there, no link.
  const st = await access.stat(inst, abs, { withoutDeadline: true, signal });
  if (!st || st.kind !== "folder") return { created: false, reason: "missing", notice: st ? T`${r} is not a folder` : T`${r} is missing` };
  // 2. `.git` in it.
  const g = await access.stat(inst, path.join(abs, ".git"), { withoutDeadline: true, signal });
  const env = codeRepoIdentity(home || os.homedir());
  if (g?.kind === "folder") {
    const marker = (await access.stat(inst, path.join(abs, ".git", HALF_MARKER), { withoutDeadline: true, signal }))?.kind === "file";
    const head = await headExists(inst, abs, opts);
    if (!marker) {
      if (!head) return { created: false, reason: "repo", notice: T`${r} brings a .git without a commit — it is not cbase's, no commit` };
      return { created: false, reason: "repo", notice: T`${r} is already a repo${permissions === true ? await permissionsNotice(inst, abs, r, signal) : ""}` };
    }
    if (head) { await markerGone(inst, abs, signal); return { created: true }; }
    // Our own half `init`: never staged — an index means someone has worked in it since.
    if (await access.stat(inst, path.join(abs, ".git", "index"), { withoutDeadline: true, signal })) {
      return { created: false, reason: "repo", notice: T`${r}: something was staged in the half-created repo — no commit` };
    }
    check(await git(inst, abs, ["init", "-q", "-b", "main"], opts), `Code repo ${r}: init`);
    await commitCodeRepo(inst, abs, r, env, signal);
    await markerGone(inst, abs, signal);
    return { created: true };
  }
  if (g) {
    if (g.kind === "file" && await gitFileApplies(inst, w, abs, opts)) return { created: false, reason: "submodule", notice: T`${r} is a submodule or worktree of a repo of the project` };
    return { created: false, reason: "git-file", notice: T`${r} carries a .git without a valid target — no code repo created` };
  }
  // 3. Repos inside or above (the project repo of the root does not count).
  const { repos } = await searchProject(abs, { instance: inst, withoutDeadline: true });
  if (repos.length) return { created: false, reason: "collection-folder", notice: T`${r} stays a normal folder (repos inside)` };
  const parts = r.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const ancestor = path.join(w, ...parts.slice(0, i));
    const v = await access.stat(inst, path.join(ancestor, ".git"), { withoutDeadline: true, signal });
    if (!v) continue;
    if (i === 0 && carriesProjectRepoMarker(w)) continue;
    return { created: false, reason: "in-repo", notice: T`${r} lies in a repo (${path.relative(w, ancestor) || T("root")}) — no code repo created` };
  }
  // 4. init, marker, empty commit, marker gone. If B dies between init and marker, a repo without a commit stays that cbase no
  //    longer touches (reason "repo") — better a repo without a first commit than a commit into a foreign one.
  check(await git(inst, abs, ["init", "-q", "-b", "main"], opts), `Code repo ${r}: init`);
  try { await access.create(inst, path.join(abs, ".git", HALF_MARKER), "file", { withoutDeadline: true, signal }); } catch (e) { if (e?.code !== "EEXIST") throw e; }
  await commitCodeRepo(inst, abs, r, env, signal);
  await markerGone(inst, abs, signal);
  return { created: true };
}

export { IDENTITY_NAMES };
