// The request for a copy via REST. The EXECUTION SIDE of creating: what the description side (visibility of the tools)
// promises is enforced by this file. Called by stacks/routes.js (`POST /api/projects/:pid/stack-copies`); the tools take
// the same path.
//
// submitCopyRequest({ projectId, chatId?, name, base, baseInstance?, data }) → Promise<row>
//   `chatId` is OPTIONAL. Without a chat a human creates the copy — the checks of the chat are skipped, the row carries
//   no `chat_id` and no `inset`: nobody moves in, no wake call. With a chat (the tool cbase_copy_stack through the
//   fence) the row carries `inset` — the chat moves in at `ready`. A chat creates any number; only a name can be
//   occupied.
//   Checks, in this order — the first that does not hold is the answer (`CopyError` with `status` and `code`):
//     project missing                              404 NO_PROJECT
//     with chat: chat missing                      404 NO_CHAT
//     with chat: chat belongs to another project   400 FOREIGN_CHAT
//     with chat: not a coding chat (kind ≠ normal, special role) 403 NO_CODING_CHAT
//     with chat: chat archived                     409 ARCHIVED
//     project not converted                        409 NOT_CONVERTED
//     project with an open setup                   409 NO_COPY_DURING_SETUP (in EVERY step, also waiting for an upload
//                                                  and failed — the copy would capture a half state;
//                                                  projectbox/setup/status.js)
//     `baseInstance` ≠ "main" (a copy from a copy — the TEMPLATE; REST and the tool cbase_copy_stack):
//       not an instance (`copy-<name>`)            400 BASE_INSTANCE_INVALID
//       no live copy of this name                  409 TEMPLATE_UNKNOWN
//       copy or instance row not `ready`           409 TEMPLATE_NOT_READY (the sentence names both states; if the
//                                                  template is STOPPED, also the way out)
//       its snapshot not readable                  409 TEMPLATE_UNREADABLE (without it no repo list is safe)
//       The template is checked TWICE like project and chat (before and after the awaits): a clearing away that begins
//       in between lets no request arise for a dying template. Afterwards the template may go (the queue then sets the
//       waiting copy to `error`, stacks/queue.js projectReason); once the new copy is built, it no longer depends on it.
//     `base` does not have the form                400 BASE_INVALID   (a string or { relPath: ref }; plus what never
//                                                                      exists in the copy: reflog selectors like
//                                                                      `main@{1}`/`@{-1}` — not `@{u}`/`@{upstream}`/
//                                                                      `@{push}` —, stash, pseudo refs)
//     `name` does not have the form                400 NAME_INVALID   (stacks/names.js nameError)
//     main stopped or stopping                     409 MAIN_STOPPED   (BEFORE reading the refs — a copy from a template
//                                                                      needs the main instance's refs too (nameFree),
//                                                                      and in a stopped container they are not
//                                                                      readable. The sentence names the way out)
//     refs of the main instance not readable       409 REFS_UNREADABLE ("did not look" is not "none there")
//     `base` unknown in the main instance          409 COPY_BASE      (see "THE PRE-CHECK OF THE BASE"; a `rev-parse`
//                                                                      that does not end with 0/1: REFS_UNREADABLE)
//     name taken (live, backup, ref)               409 NAME_TAKEN     (nameFree with `backups`; if a LIVE copy carries
//                                                                      it, the sentence names its state and what is up
//                                                                      with it — stacks/state.js occupiedWhatToDo)
//     space `copy` blocked (a ref `copy`)          409 SPACE_BLOCKED  (automaticName; branch, tag or note)
//   The checks of project and chat (up to the setup) hold TWICE: before and after the awaits — reading the refs and the
//   pre-check of the base (a chat deleted or archived in this window would otherwise get a copy with `inset` for a chat
//   that no longer exists; `projectAndChat`).
//   Then `copyRequests` (stacks/state.js, `waiting_queue`) and `wakeQueue()` (stacks/queue.js) — the procedure is
//   started by the queue, never by this file. An automatic name that someone else took between choice and creation
//   (unique index) is chosen anew up to three times.
//
// The naming rule requires the backup folders (`backups` is mandatory in stacks/names.js). They come from
//   `<data>/copies-backup/<pid>/` (stacks/location.js projectCopiesLocation) — a name with a backup folder is taken
//   (the bundles of a cleared-away copy are kept there per NAME; a second one of the same name would write into the
//   same folder). If the folder is missing, there are none; if it is not readable, it throws (never "none").
// THE REFS come from EVERY repo of the main instance — the project folder if it has a `.git`, and the repos from
//   searchProject — via `git for-each-ref refs/heads/copy refs/tags/copy refs/notes/copy` IN the main instance (gitRun
//   with the main instance: no git in the user container). Each pattern matches the ref `copy` itself and everything
//   below — all three spaces the fetch writes to (stacks/names.js REF_CLEAN).
// THE PRE-CHECK OF THE BASE: without it the request would only check the FORM, and whether a repo knows the ref only the
//   preparation in the copy (stacks/prepare.js) — after volume clone, pause of the main instance and creation: a typo
//   would cost a clone, a pause and a dismantling and come as a wake call instead of an answer. So the request asks per
//   repo IN the main instance (gitRun) `rev-parse --verify --quiet --end-of-options <ref>^{commit}` — exit 0 knows it,
//   a silent 1 does not, everything else (128, a 1 with an error text, signal, cap, a throw) is "did not look" (409 REFS_UNREADABLE, never "unknown") —
//   except for a relative ref on which git dies with 128 because its name part is already cleanly unknown (`@{u}~1`
//   without upstream, knowsCommit); an exit 0 only counts with an id on stdout, as in the late check (`^main`). Asked
//   are the repos the copy carries (like stacks/code-snapshot.js: `.git` as a folder — the project folder and the repos
//   from searchProject). A string: if none knows it ⇒ 409 COPY_BASE in the wording of the late check. An object: a
//   `rel` that is no such repo, or a ref its repo does not know ⇒ 409 COPY_BASE.
//   The pre-check is NECESSARY, NOT SUFFICIENT: the state only counts at the freeze (refs change while waiting) — the
//   late check in stacks/prepare.js stays. And it never says "unknown" where the copy COULD still know the ref: the
//   project repo gets a commit before the copy (the commit "State before copy" with marker — a relative ref like `HEAD~1`
//   then points one commit further back), and a project folder without `.git` only gets a new project repo before the
//   copy — it knows `HEAD`, `@` and `main` with `~`/`^`. There the late check decides. The commit only shifts the
//   position, it brings no new name: with the marker the reservation therefore only holds for a relative ref whose
//   NAME PART (before the first `~`/`^`) the project repo knows as a commit today — `typo~1` is 409 COPY_BASE.
//   What resolves in the main instance but never or differently in the copy (a fresh `git init`: not the main
//   instance's reflogs, no `refs/stash`, no pseudo refs) is already rejected by baseError — not `@{u}`, `@{upstream}`
//   and `@{push}`: the copy carries `branch.*`/`remote.*` and `refs/remotes/*`.
//   FROM A TEMPLATE baseInTheTemplate asks the same question IN the template (gitRun with its instance row), over the
//   repos of its snapshot — exactly the parts the new copy carries. Without reservation: there is neither "Stand vor
//   Kopie" nor a new project repo there; what the template knows, the copy knows. baseError applies unchanged although
//   reflogs and stash come along from a template — relaxing it would be a decision of its own.
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { MAIN, copyNameOf } from "../projectbox/creation.js";
import { setupOpen } from "../projectbox/setup/status.js";
import { T } from "../i18n.js";
import { runInstance } from "../projectbox/run-instance.js";
import { BRANCH, searchProject, carriesProjectRepoMarker } from "../projectbox/projectRepo.js";
import { gitRun } from "../runtime/git-run.js";
import { readSnapshot } from "./code-snapshot.js";
import { REF_CLEAN, REF_SPACE, automaticName, nameError, nameFree, spaceError } from "./names.js";
import { copyLocation, projectCopiesLocation } from "./location.js";
import { wakeQueue } from "./queue.js";
import { CopyError, occupiedWhatToDo, copyRequests } from "./state.js";

export const REFS_CAP_MS = 60_000; // per repo — ESTIMATED, not measured
export const NAME_ATTEMPTS = 3;

const error = (message, code, status) => new CopyError(message, { code, status });

/** A coding chat: `kind = 'normal'` without a special role (chats/genus.js computes the same genus for archive and fork). */
export const isCodingChat = (chat) => Boolean(chat) && chat.kind === "normal" && !chat.specialRole;

// The form of a `base`: a string (branch, tag, commit) or `{ relPath: ref }`. No control character, no leading "-" (an
// argument, not a switch), no `..` in the path. Whether a repo KNOWS the ref is asked by the pre-check in the main
// instance (head, baseInMain) and last by the preparation in the copy.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const refForm = (r) => typeof r === "string" && r.length > 0 && r.length <= 256 && !CONTROL.test(r) && !r.startsWith("-") && r.trim() === r;
const relForm = (p) => typeof p === "string" && p.length > 0 && p.length <= 1024 && !CONTROL.test(p) && !path.isAbsolute(p) && p !== ".." &&
  !p.split("/").includes("..") && !p.startsWith("-");

// What resolves in the main instance but never, or to another commit, in the copy: the copy is a fresh `git init` with
// the refs of the snapshot (stacks/prepare.js) — without the main instance's reflogs (`main@{1}`, `@{-1}`,
// `main@{yesterday}`), without `refs/stash` and without the pseudo refs of a git command in the main instance. A
// branch with such a name stays reachable via `heads/<name>`.
// `@{u}`, `@{upstream}` and `@{push}` (any case, `main@{u}`, `HEAD@{PUSH}`) are NOT reflog selectors and are allowed:
// git resolves them from `branch.*`/`remote.*` and `refs/remotes/*`, and the copy carries both — the same commit, also
// with `~`/`^` after it. Every other `@{…}` stays rejected, also `@{0}`: in the main instance it reads the reflog, in
// the copy the freshly written one — the same answer only as long as the main instance's reflog matches the ref, and
// nobody gains anything over the ref itself. A date (`main@{yesterday}`) gave ANOTHER commit in the copy than in the
// main instance, `main@{1}` and `@{-1}` none at all.
const PSEUDO_REFS = Object.freeze(["ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_HEAD", "AUTO_MERGE"]);
const REFLOG = /@\{(?!(?:u|upstream|push)\})/i;
function onlyInMain(r) {
  if (REFLOG.test(r)) {
    return T("reflog selectors like `main@{1}`, `@{-1}` or `main@{yesterday}` (also `@{0}`) do not work: the main instance's reflogs do not exist in the ") +
      T("copy (a fresh repo with its refs), there they would lead nowhere or to another commit (`@{u}`, `@{upstream}` and ") +
      T("`@{push}` work)");
  }
  const header = r.split(/[~^:]/)[0];
  if (header === "stash" || header === "refs/stash") return T("the stash does not exist in the copy (it does not come along)");
  if (PSEUDO_REFS.includes(header)) return T`pseudo refs like ${header} do not exist in the copy (a fresh repo with the main instance's refs)`;
  return null;
}
const NAME = () => T("name a branch, tag or commit");

export function baseError(base) {
  if (base === undefined || base === null) return null;
  if (typeof base === "string") {
    if (!refForm(base)) return T("`base`: a ref (branch, tag, commit) — without control characters, without a leading \"-\"");
    const only = onlyInMain(base);
    return only ? T`\`base\`: "${base.slice(0, 80)}" — ${only} — ${NAME()}` : null;
  }
  if (typeof base !== "object" || Array.isArray(base)) return T("`base`: a string or an object { relPath: ref }");
  const e = Object.entries(base);
  if (!e.length) return T("`base`: an empty object means nothing — omit it or give one ref per repo");
  for (const [p, r] of e) {
    if (!relForm(p)) return T`\`base\`: "${String(p).slice(0, 80)}" is not a relative path of a repo (${"."} for the project folder)`;
    if (!refForm(r)) return T`\`base\`: the ref for "${p}" is not one`;
    const only = onlyInMain(r);
    if (only) return T`\`base\`: the ref for "${p}" (${r.slice(0, 80)}) — ${only} — ${NAME()}`;
  }
  return null;
}

// The names below copies-backup/<pid>/. If the folder is missing: none. Every other error throws.
export function backupNames({ data, projectId }) {
  const location = projectCopiesLocation({ data, projectId });
  try {
    return fs.readdirSync(location.backup, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw error(T`Backups of the copies not readable (${e?.code || "Error"}) — without them no name is safely free`, "BACKUP_UNREADABLE", 409);
  }
}

// The refs `refs/heads/copy…` of all repos of the main instance (head), IN the main instance → `{ refs, repos }`;
// `repos` are the repos from searchProject as `{ rel, location }` (the pre-check of the base asks the same ones,
// without a second search).
export async function copyRefsOfTheMain(project, inst) {
  const root = path.resolve(String(project.path));
  const unreadable = (where, e) => error(T`Refs of the main instance ${where} not readable (${e?.code || e?.message || e}) — without them no name is safely free`, "REFS_UNREADABLE", 409);
  const locations = [];
  let gitExists = false;
  // Like stacks/code-snapshot.js gitKind: an lstat in the user container, no opening, no following.
  try { fs.lstatSync(path.join(root, ".git")); gitExists = true; } catch (e) { if (e?.code !== "ENOENT") throw unreadable(T("in the project folder"), e); }
  if (gitExists) locations.push(root);
  let repos;
  try { ({ repos } = await searchProject(root, { instance: inst })); } catch (e) { throw unreadable(T("(search of the repos)"), e); }
  const codeRepos = [];
  for (const rel of repos || []) {
    locations.push(path.join(root, rel));
    codeRepos.push({ rel, location: path.join(root, rel) });
  }
  const refs = [];
  for (const location of locations) {
    let r;
    try {
      r = await gitRun(inst, location, ["for-each-ref", "--format=%(refname)", ...REF_CLEAN.map(([front]) => `${front}${REF_SPACE}`)], { timeout: REFS_CAP_MS });
    } catch (e) { throw unreadable(`in ${path.relative(root, location) || "."}`, e); }
    if (r.code !== 0) {
      throw error(T`Refs of the main instance in ${path.relative(root, location) || "."} not readable (exit ${r.code ?? r.signal}${r.cap ? T`, cap ${r.cap}` : ""}) — ` +
        T("without them no name is safely free"), "REFS_UNREADABLE", 409);
    }
    refs.push(...r.stdout.split("\n").map((z) => z.trim()).filter(Boolean));
  }
  return { refs, repos: codeRepos };
}

// ── The pre-check of the base (head) ───────────────────────────────────────────────────────────────────────────────────

// The kind of a `.git` — like stacks/code-snapshot.js gitKind (an lstat in the user container, no opening, no
// following): "folder" (a repo of its own, the copy carries it), "reference", "gitfile" (worktree, submodule), null
// (none). Not readable ⇒ throws (never "none").
function gitKind(dir) {
  let st;
  try { st = fs.lstatSync(path.join(dir, ".git")); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; }
  return st.isDirectory() ? "folder" : st.isSymbolicLink() ? "reference" : "gitfile";
}

// The name part of a relative ref: everything before the first `~` or `^` that does not begin a `^{…}` (`HEAD~1` →
// `HEAD`, `main^2` → `main`, `v1^{}~1` → `v1^{}`, `@{u}~1` → `@{u}`); without such a character null.
const RELATIVE = /[~^](?!\{)/;
function namePart(ref) {
  const m = RELATIVE.exec(ref);
  return m ? ref.slice(0, m.index) : null;
}
// Like CHECKOUT commit_of in stacks/prepare.js (the late check): an answer with exit 0 is only a commit if it is an id
// (`^main` — a negation, not a revision — ends with 0 and prints `^<id>`; the copy says "unknown" there).
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// Does the repo at the location know the ref as a commit? IN the main instance. `{ known }` or `{ error }` — only exit
// 0 and a silent exit 1 are an answer (head). One exception: on a relative ref git DIES with 128 if its name part already does not
// resolve (`@{u}~1` and `@{push}^` without upstream) — without `~`/`^` the same name answers with 1. If the name part
// alone cleanly answers with 1, the repo does not know the whole ref either; every other answer stays "did not look"
// (a broken object behind `broken~1` dies at the name part too).
async function knowsCommit(inst, location, ref) {
  let r;
  try {
    r = await gitRun(inst, location, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { timeout: REFS_CAP_MS });
  } catch (e) { return { error: String(e?.code || e?.message || e) }; }
  if (!r.cap && r.code === 0) return { known: OID.test(String(r.stdout ?? "").trim()) };
  // Exit 1 is "unknown" only when git said nothing: `--quiet` keeps a cleanly unknown ref silent, but git 2.54 also ends a
  // lookup that hit a broken object (`broken~1` on a destroyed commit) with 1 — and prints the read error. Older git (2.39 in
  // the image, 2.50) dies with 128 there. Both are "did not look", never "unknown".
  if (!r.cap && r.code === 1 && !String(r.stderr ?? "").trim()) return { known: false };
  const header = !r.cap && r.code === 128 ? namePart(ref) : null;
  if (header && (await knowsCommit(inst, location, header)).known === false) return { known: false };
  return { error: `Exit ${r.code ?? r.signal}${r.cap ? T`, cap ${r.cap}` : ""}` };
}

// What the copy's project repo COULD know without the main instance knowing it today (head): `HEAD`/`@`/BRANCH with
// `~`/`^` if it is only created before the copy; a relative ref if it gets a commit before the copy — but only if the
// project repo knows its NAME PART as a commit today: the commit "State before copy" appends a commit and thereby only
// shifts the position, no new name arises (`typo~1` would otherwise pass and cost clone, pause and dismantling).
// `HEAD~1`, `main~1`, `@^` stay allowed; whether the position then holds (`HEAD~5` in a short history) is decided by
// the late check — the pre-check is necessary, not sufficient.
const NEW_PROJECT_REPO = new RegExp(`^(?:HEAD|@|(?:(?:refs/)?heads/)?${BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?:[~^]|$)`);

/**
 * The pre-check (head): throws `CopyError` 409 COPY_BASE (nobody knows it) or 409 REFS_UNREADABLE (did not look) —
 * otherwise nothing. `repos` from copyRefsOfTheMain (the repos from searchProject); the project folder is added here.
 */
export async function baseInMain(base, { project, inst, repos = [] }) {
  if (base === undefined || base === null) return;
  const root = path.resolve(String(project.path));
  const kindOf = (dir, rel) => {
    try { return gitKind(dir); } catch (e) {
      throw error(T`base: the .git of ${rel} is not readable (${e?.code || e?.message || e}) — did not look is not unknown`, "REFS_UNREADABLE", 409);
    }
  };
  const kind = new Map([[".", kindOf(root, ".")]]);
  const parts = kind.get(".") === "folder" ? [{ rel: ".", location: root }] : [];
  for (const r of repos) {
    if (kind.has(r.rel)) continue;
    kind.set(r.rel, kindOf(r.location, r.rel));
    if (kind.get(r.rel) === "folder") parts.push(r);
  }
  const marker = kind.get(".") === "folder" && carriesProjectRepoMarker(root);
  const could = async (ref) => {
    if (kind.get(".") === null) return NEW_PROJECT_REPO.test(ref);
    const header = marker ? namePart(ref) : null;
    if (!header) return false;
    const k = await knowsCommit(inst, root, header);
    if (k.error) {
      throw error(T`base "${ref}": could not look up the name part "${header}" in the project folder (${k.error}) — "did not look" is not "unknown"`, "REFS_UNREADABLE", 409);
    }
    return k.known;
  };
  const list = parts.map((t) => t.rel).join(", ") || T("no repos");

  if (typeof base === "string") {
    const not = [];
    for (const t of parts) {
      const k = await knowsCommit(inst, t.location, base);
      if (k.known) return;
      if (k.error) not.push(`${t.rel} (${k.error})`);
    }
    if (not.length) {
      throw error(T`base "${base}": could not look in ${not.join(", ")} — no other repo of the main instance knows this commit, and "did not look" is not "unknown"`, "REFS_UNREADABLE", 409);
    }
    if (await could(base)) return; // the late check decides (head)
    throw error(T`base "${base}": no repo of the copy knows this commit (${list}; looked up in the main instance) — nothing is guessed`, "COPY_BASE", 409);
  }
  for (const [rel, ref] of Object.entries(base)) {
    if (!kind.has(rel)) throw error(T`base names the repo "${rel}" — the main instance has none under this path (${list})`, "COPY_BASE", 409);
    const a = kind.get(rel);
    if (rel === "." && a === null) continue; // the project repo is only created before the copy — the late check decides
    if (a !== "folder") {
      throw error(T`base names "${rel}" — there is ${a === null ? T("no repo anymore") : T("a worktree, submodule or symlink without its own .git")}, the copy does not carry it as a repo of its own (${list})`, "COPY_BASE", 409);
    }
    const k = await knowsCommit(inst, parts.find((t) => t.rel === rel).location, ref);
    if (k.error) throw error(T`base: could not look in the repo "${rel}" (${k.error}) — "did not look" is not "unknown"`, "REFS_UNREADABLE", 409);
    if (!k.known && !(rel === "." && (await could(ref)))) {
      throw error(T`base: the repo "${rel}" does not know "${ref}" as a commit (looked up in the main instance) — nothing is guessed`, "COPY_BASE", 409);
    }
  }
}

/**
 * The pre-check of the base IN the template (head, "FROM A TEMPLATE") — throws `CopyError` 409 COPY_BASE or
 * REFS_UNREADABLE like baseInMain. `repos`: the parts of its snapshot (`{ rel }`, `.` = the project folder).
 */
export async function baseInTheTemplate(base, { project, inst, repos = [] }) {
  if (base === undefined || base === null) return;
  const root = path.resolve(String(project.path));
  const locationOf = (rel) => (rel === "." ? root : path.join(root, rel));
  const list = repos.map((r) => r.rel).join(", ") || T("no repos");
  if (typeof base === "string") {
    const not = [];
    for (const r of repos) {
      const k = await knowsCommit(inst, locationOf(r.rel), base);
      if (k.known) return;
      if (k.error) not.push(`${r.rel} (${k.error})`);
    }
    if (not.length) {
      throw error(T`base "${base}": could not look in ${not.join(", ")} of the template — no other repo knows this commit, and "did not look" is not "unknown"`, "REFS_UNREADABLE", 409);
    }
    throw error(T`base "${base}": no repo of the template knows this commit (${list}; looked up in the template) — nothing is guessed`, "COPY_BASE", 409);
  }
  for (const [rel, ref] of Object.entries(base)) {
    if (!repos.some((r) => r.rel === rel)) throw error(T`base names the repo "${rel}" — the template carries none under this path (${list})`, "COPY_BASE", 409);
    const k = await knowsCommit(inst, locationOf(rel), ref);
    if (k.error) throw error(T`base: could not look in the repo "${rel}" of the template (${k.error}) — "did not look" is not "unknown"`, "REFS_UNREADABLE", 409);
    if (!k.known) throw error(T`base: the repo "${rel}" of the template does not know "${ref}" as a commit (looked up in the template) — nothing is guessed`, "COPY_BASE", 409);
  }
}

// The template (head) — fresh from the store, called TWICE like projectAndChat. → { name, instance, inst } or throws.
function templateOf(pid, baseInstance) {
  let name;
  try { name = copyNameOf(baseInstance); } catch {
    throw error(T`\`baseInstance\`: "${String(baseInstance).slice(0, 80)}" is not an instance — "main" or "copy-<name>"`, "BASE_INSTANCE_INVALID", 400);
  }
  const k = store.liveStackCopy(pid, name);
  if (!k) {
    throw error(T`The template "${name}" does not exist in project ${pid} (no live copy of that name) — a copy is made from main or from a ready copy of the same project.`, "TEMPLATE_UNKNOWN", 409);
  }
  const inst = store.projectInstance(pid, baseInstance);
  if (k.state !== "ready" || inst?.state !== "ready") {
    const like = T`copy ${k.state}, instance ${inst?.state ?? T("no row")}`;
    // A stopped template does not become ready by itself — the sentence names the way out.
    if (inst?.state === "stopped" || inst?.state === "stop") {
      throw error(T`The template "${name}" is stopped (${like}) and does not start by itself — start it in the "Instances" tab first (or a turn of a chat working in ${baseInstance} starts it), then create the copy from it.`, "TEMPLATE_NOT_READY", 409);
    }
    throw error(T`The template "${name}" is not ready (${like}) — a copy from it can only be made once it is ready.`, "TEMPLATE_NOT_READY", 409);
  }
  return { name, instance: baseInstance, inst };
}

// The checks of project and chat (head) — fresh from the store. Called TWICE: before and AFTER the awaits
// (copyRefsOfTheMain and baseInMain — each up to REFS_CAP_MS per repo). Deleting and archiving a chat are synchronous;
// without the second check a chat that left in this window would get a copy with `inset` whose wake call would lead
// nowhere or pull it out of the archive. After the second check everything up to copyRequests is synchronous: no
// window anymore. Without `chatId` (a human creates the copy) only the project.
function projectAndChat(pid, chatId) {
  const project = store.getProject(pid);
  if (!project) throw error(T`Project ${pid} does not exist`, "NO_PROJECT", 404);
  let chat = null;
  if (chatId !== null && chatId !== undefined) {
    chat = store.getChat(String(chatId));
    if (!chat) throw error(T`Chat ${chatId} does not exist`, "NO_CHAT", 404);
    if (chat.projectId !== pid) {
      throw error(T`Chat ${chat.id} belongs ${chat.projectId ? T`to project ${chat.projectId}` : T("to no project")}, not to ${pid} — a copy the chat moves into belongs to the project of its chat`, "FOREIGN_CHAT", 400);
    }
    if (!isCodingChat(chat)) throw error(T`Chat ${chat.id} is not a coding chat — only coding chats create copies`, "NO_CODING_CHAT", 403);
    if (chat.archivedAt) throw error(T`Chat ${chat.id} is archived — restore it first`, "ARCHIVED", 409);
  }
  if (!store.converted(pid)) throw error(T`Project ${pid} is not relocated — copies exist only of projects in the project container`, "NOT_CONVERTED", 409);
  if (setupOpen(pid)) {
    throw error(T`Project ${pid} is still being set up — a copy is only possible afterwards (it would capture a half-finished state).`, "NO_COPY_DURING_SETUP", 409);
  }
  return { project, chat };
}

export async function submitCopyRequest({ projectId, chatId = null, name, base = null, baseInstance = "main", data = null } = {}) {
  const pid = String(projectId || "");
  const { project } = projectAndChat(pid, chatId);
  // A copy from a copy — the template must be alive and ready (head).
  const fromTemplate = baseInstance !== MAIN;
  const template = fromTemplate ? templateOf(pid, baseInstance) : null;
  const bf = baseError(base);
  if (bf) throw error(bf, "BASE_INVALID", 400);
  const desired = name === undefined || name === null || name === "" ? null : name;
  if (desired !== null) {
    const nf = nameError(desired);
    if (nf) throw error(nf, "NAME_INVALID", 400);
  }
  const inst = runInstance(pid, MAIN);
  if (!inst) throw error(T`Project ${pid}: no main instance — without it the refs are not readable`, "REFS_UNREADABLE", 409);
  // A STOPPED main instance: reading the refs in the stopped container would end with 409 REFS_UNREADABLE without a way
  // out. A copy from a template needs the refs too (nameFree: the commits of a copy land under copy/<name>/ in the main
  // instance), so this holds for every request. No start from here: a wish for a copy is not a turn in main.
  if (inst.state === "stopped" || inst.state === "stop") {
    throw error(T`Instance main of project ${pid} is stopped — without it the refs cannot be read. Start it in the "Instances" tab first (or a turn of a chat working in main starts it), then create the copy.`, "MAIN_STOPPED", 409);
  }
  const { refs, repos } = await copyRefsOfTheMain(project, inst);
  const d = data || DIRS.data;
  if (template) {
    // The base against the repos of the TEMPLATE, asked in it.
    let parts;
    try { parts = readSnapshot(copyLocation({ data: d, projectId: pid, name: template.name })).repos.map((r) => ({ rel: String(r.rel) })); } catch (e) {
      throw error(T`Snapshot of the template "${template.name}" not readable (${e?.code || e?.message || e}) — without it no repo list is safe`, "TEMPLATE_UNREADABLE", 409);
    }
    await baseInTheTemplate(base, { project, inst: template.inst, repos: parts });
  } else await baseInMain(base, { project, inst, repos }); // a ref no repo knows: at once instead of after clone and pause
  const { chat } = projectAndChat(pid, chatId); // once more after the awaits — the chat can be gone meanwhile
  if (fromTemplate) templateOf(pid, baseInstance); // likewise the template (a clearing away can have begun meanwhile)

  for (let attempt = 1; ; attempt++) {
    const backups = backupNames({ data: d, projectId: pid });
    const live = store.liveStackCopies(pid).map((k) => k.name);
    let choice = desired;
    if (choice !== null) {
      if (!nameFree(choice, { live, refs, backups })) {
        const carrier = live.includes(choice) ? store.liveStackCopy(pid, choice) : null;
        const why = carrier ? T`the live copy "${choice}" (${carrier.state}) carries it. ${occupiedWhatToDo(carrier)}`
          : live.includes(choice) ? T("a live copy carries it")
          : backups.includes(choice) ? T`under copies-backup/${pid}/${choice} there are backups of an earlier copy`
            : spaceError(refs) || T`the main instance already has branches under ${REF_SPACE}/${choice}/`;
        throw error(T`Name "${choice}" is taken: ${why}`, "NAME_TAKEN", 409);
      }
    } else {
      const space = spaceError(refs);
      if (space) throw error(space, "SPACE_BLOCKED", 409);
      try { choice = automaticName({ live, refs, backups }); } catch (e) { throw error(e.message, "NO_NAME", 409); }
    }
    try {
      // A chat with a scheduled job does NOT move in — only the human changes its instance, and every later occurrence
      // would otherwise run in the copy. The copy is created anyway (created by this chat), without inset and wake call;
      // the binding is refused by runs/instance-switch.js anyway (the second safeguard).
      const k = copyRequests({ projectId: pid, name: choice, chatId: chat ? chat.id : null, inset: Boolean(chat) && !chat.jobId, baseInstance, base });
      wakeQueue();
      return k;
    } catch (e) {
      // Only an automatic name that someone else took meanwhile is chosen anew (the name is the only index).
      if (!(e instanceof CopyError) || e.code !== "COPY_OCCUPIED" || desired !== null || attempt >= NAME_ATTEMPTS) {
        if (e instanceof CopyError) throw e;
        throw error(String(e?.message || e), "REQUEST", 500);
      }
    }
  }
}
