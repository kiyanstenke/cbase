// Clearing away without loss. The ONE clear-away path of a copy: afterwards every commit and every open, non-ignored change
// is in main under `refs/heads/copy/<name>/…`, every new repo is a bundle in the copy's backup folder, and nothing of the
// copy is left. The triggers (DELETE, deleting a project, restart, wake-up) belong to stacks/remove.js — here only the
// procedure.
//
// clearAwayCopy(copyId, { reason, retrieve = [], automatic = false, home, system, data, root, addresses })
//   → Promise<{ state: "removed" | "earmarked" | "error", report }>. NEVER THROWS: a failure is recorded as `error` with its
//   reason in the row and in the report. `home`/`system`/`data` are test seams (default: home of B, SYSTEM_PATHS, DIRS.data),
//   `root`/`addresses` those of the creation when the copy's container is missing (projectbox/instance.js; empty in the product).
//   By the state of the row:
//     waiting_*                straight to `removed` (no build, nothing to fetch) — report `{ discarded: true }`.
//     build                    nothing changed, `earmarked` waiting for the build — only a ready copy is cleared away (the
//                              trigger calls again after `ready`).
//     ready, clearAway/earmarked   step 0, then 1–5.
//     clearAway/<phase>        continue (after a restart): from the step the journal names as next.
//     error                    If the copy was never `ready` (no user worked in it): dismantling by id
//                              (stacks/dismantling.js), then `removed`. If it was ready: the same lossless path as above —
//                              from the journal's step; if all backups are written, only step 5 is left (the copy is no
//                              longer needed), otherwise the running copy is needed — if it is missing, `error` “Backup
//                              pending” stays. Simply removing what is there would be exactly the loss this path forbids.
//                              If the dismantling of a NEVER built copy fails, it stays never built — no clear-away section
//                              in the journal, the sentence “… — never built …” instead of “Backup pending” (otherwise
//                              its chat would be bound to it forever, stacks/inset.js wasReady). And if a copy ran again
//                              after step 4 had backed it up (`wasAliveAgain`), the clear-away does not continue at step 5
//                              but fetches and backs up once more from step 0.
//     removed                  nothing, `removed` with the report of the row (idempotent).
//   Occupancy: the instance occupancy “copy-clear-away” (projectbox/instance.js — a fetch, a re-creation or a second
//   clear-away of the same copy never runs alongside) and `withProcedure` (the restart recognises a clear-away without a
//   running procedure). Occupied ⇒ `earmarked` (a ready row goes to `clearAway/earmarked` for it).
//
// The steps (each a phase of `clearAway`, STACK_COPY_PHASES; each a journal step `clear-<phase>`, idempotent — a second call
// after an abort continues at the next step not done and reaches the same result):
//   0. ONE synchronous step (lock first, then idle): phase `fetch` — the instance row goes `ready` → `clearAway` (from here
//      every new turn waits at the lock) —, then `instanceIdle`; not empty ⇒ the instance row back to its state, the copy
//      `clearAway/earmarked` (if it came from `error`: back to `error` with its reason, see stepNull), returning `earmarked`
//      with `open`. Empty ⇒ the terminals and debuggers of the copy itself end with a message, as do the terminals of the
//      chat bar of the chats of this copy. From here the copy is CLOSED for write paths as long as its instance row is not
//      `ready` (devtools/routes.js writeLockCopy): every file and git route except the reading ones answers 409
//      COPY_NOT_READY, a new terminal or debugger 409. `earmarked` does NOT lock (the instance row stays `ready`).
//   Before steps 1–4 the copy runs (copyRunning): if the stop chain of an orderly server end stopped its container, the
//      clear-away starts it itself (by id, only its own) and waits for the ready phase — the instance row stays `clearAway`
//      (never `ready`, no turn slips in); the report says so (`copyStarted`). If its container is MISSING (an inner dockerd
//      that no longer sees its containers after a recreate of B, a manual `docker rm`), the clear-away creates it anew — the
//      same way as re-creating a copy (its layer, its volume, its network), but in `clearAway` under its own occupancy,
//      without restore and without the stack (`copyCreated`).
//   Right after that, before step 1, the clear-away stops the WRITERS of the copy (holdWriterOn): its native services and
//      every running container of its inner dockerd (the stack) — `docker stop -t 30` by id INSIDE the copy. Step 5 ends
//      them anyway; this way what they still write while stopping lands in the first backup, and a stack that writes into a
//      versioned path no longer makes the post-check fail on every call. The report lists it (services, containers, and
//      what kept running or could not be read).
//   1. fetch (stacks/fetch.js): new repos (WIP + bundle — also every one into whose `.git` the copy wrote; one numbered
//      earlier that disappeared, as `gone`), the branches of every code repo including stash, tags, notes and detached
//      worktree heads (`stashes` in the report), LFS. Afterwards every repo the journal knows has its bundle or the reason
//      why it needs none — otherwise the step stays open.
//   2. save: per code repo the backup `refs/cbase/wip/clone` (only the upper layer) → `copy/<name>/wip`, per worktree of
//      the copy `wt-<id>` (everything untracked — it does not lie in the overlay) → `copy/<name>/wip-<id>`; both `onlyNew`
//      (a backup never pushes a branch forward — occupied ⇒ fallback ref); then LFS once more.
//   3. projectRepo (stacks/project-repo-copy.js, with hook); the LFS objects that only this commit creates are fetched by
//      fetch.js fetchProjectRepo before the merge.
//   A ref not fetched in 1–3 (object missing, fsck) is an error: “Backup pending”. Likewise a worktree of the copy
//   whose path is not UTF-8 or carries a line break (state `findings`): its open work would bypass the backup — 1, 2 and 4
//   stop before it (withoutWorktreeFinding). And a search for repos in a dependency folder that stopped at the cap (record
//   `x` of the list): 1 and 4 stop (searchesComplete, COPY_CAP).
//   4. layer: first the safety net — every folder into whose `.git` the copy wrote is a part of the snapshot or backed up,
//      otherwise “Backup pending”. Then the upper layer (returnPath.js layerList) — versioned is what 1–3 fetched;
//      what remains is what is ignored there (`check-ignore` INSIDE the copy, per repo — the DEEPEST one, also a backed-up
//      repo inside a new one) or lies in no repo, plus the dependencies, whiteouts (deleted in the copy, not executed in
//      main), opaque folders and special files — all in the report (per list at most REPORT_CAP paths, with count and the
//      marker `truncated`). Retrieved is ONLY what `retrieve` names (in form, in this list or a backed-up repo, onto a FREE
//      path, without symlinks, without `user.overlay.*`; returnPath.js copyBack or fetch.js retrieveRepos); nothing is ever
//      deleted in main. If retrieving a path fails at reading or writing (copyBack `error` — unreadable, full, terminated),
//      that is “Backup pending: Retrieving …” (COPY_RETRIEVE): the layer stays, the next call tries again; what is
//      denied (foreign, occupied, symlink) stays an entry in the report. `check-ignore` gets the names as BYTES (nulBytes)
//      and answers with their NUMBER (a name that is not UTF-8 would never come back as text). `automatic`: the ignored
//      files without the dependencies as ONE tar (cap IGNORED_CAP, knob CBASE_COPY_IGNORED_CAP; above it: “Backup
//      pending”) — never played back into main; `missing` in the report at most returnPath.js MISSING_CAP names, with
//      `missingCount` and `truncated`.
//      Last, in the same journal step, the POST-CHECK (header there): what runs again since the stopping before step 1
//      (native services, stack containers) ends once more, then it recomputes in the copy what 1–3 would back up (refs, WIP
//      per code repo and worktree, new repos, project repo) against what they did back up (`backedUp` in the journal). If
//      it differs, 1–4 run ONCE more; if it still differs: `error` “Backup pending: post-check …”
//      (COPY_POST_CHECK), nothing removed — the sentence names what the clear-away could not stop. The report lists both.
//   5. remove: only when every bundle of new repos is written (otherwise “Backup pending” with the path); end the
//      native services of the copy (per running one through the hook setServicesStopper — server.js: services.js
//      stopService; stacks/ does not import services.js; without the hook only `docker stop` ends them, the report says
//      so), `docker stop -t 30` by id (only an own container, projectbox/erase.js onlyOwn), then stacks/dismantling.js
//      dismantleCopy: container, network, volume by id, the location including the layer through the root helper of kind
//      `clearAway`, last the instance row; forget the token, update the names. Then `removed` with the report and
//      `wakeProject` (after `removed` — the waiting turns of the chat run in main). The report names the backup folder ONLY
//      if it still exists afterwards (bundles of new repos, the tar of the ignored files) — cleanUpBackup deletes an empty one.
//   If 0–4 fail (the copy is stopped, a cap, a ref is missing, the post-check): `error` “Backup pending: …”, the
//   layer stays, the report names the copy's location. If 5 fails: `error` “Clear-away incomplete: …” (everything is backed
//   up then).
//   SERVER END (runs/server-end.js serverEnds): no `error` — the row stays in `clearAway`, the restart continues
//   (stacks/remove.js copiesRemoveRestartGrace) and brings up the stopped copy container itself.
//
// Journal (the clear-away section): time, reason, automatic, retrieve, report, backedUp — `time` is the fixed date of the
// WIP commits (a second run produces the same ids); `backedUp` is the state that 1–3 backed up, for the post-check (an
// older journal lacks it: the check then differs once, 1–4 run once more).
// Guards: server/backend/test/stacks-clear-away.test.js (also the lock in the phases, the post-check, the backup folder);
// the losslessness gaps: stacks-lossless.test.js; the retrieving program itself: stacks-return-path-program.test.js; the
// lock of the routes: files-in-copy.test.js, project-terminal-copy.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { T } from "../i18n.js";
import { LABEL_INSTANCE, LABEL_PROJECT, copyInstance } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { nativeServicesStatus } from "../projectbox/services.js";
import { DockerError, docker, dockerIn } from "../projectbox/docker.js";
import { CALL_CAP_MS, createInstance, withInstanceOccupancy, waitForInside } from "../projectbox/instance.js";
import { setInstanceState, withProcedure } from "../projectbox/instances.js";
import { nextStep } from "../projectbox/journal.js";
import { endInstanceSessions, instanceIdle, wakeProject } from "../projectbox/idle.js";
import { onlyOwn } from "../projectbox/erase.js";
import { REVIVED } from "../projectbox/restore.js";
import { locationFor, worktreeRoot } from "../runs/runtime-location.js";
import { serverEnds } from "../runs/server-end.js";
import {
  jobsFor, backedUpRepos, fetchCodeRepos, fetchLfs, fetchProjectRepo, fetchRepo, copyContext, copyTarget, newRepos,
  topUnder, upperLists, pathError, relTo, retrieveRepos, saveNewRepos, statusOfTheCopy, statusesOfTheCopy, under, wip,
  wipMessageNew,
} from "./fetch.js";
import { neverBuilt } from "./inset.js";
import { removeCopyWorktrees, createBackup, cleanUpBackup, dismissBackupFile } from "./objects.js";
import { copyLocation } from "./location.js";
import { dismantleCopy } from "./dismantling.js";
import { depSearchCap, copyBack, withReturnPathHelper, nulBytes, tarOfTheLayers } from "./returnPath.js";
import { PERL_HELPERS } from "./prepare.js";
import { CopyError, copyJournal, setCopyState } from "./state.js";

// The phases from the data layer (ONE list, store/stack-copies.js) — not as literals here.
const [EARMARKED, FETCH, SAVE, PROJECT_REPO, LAYER, REMOVE] = store.STACK_COPY_PHASES.clearAway;
const STEP = (phase) => `clear-${phase}`;
export const CLEAR_AWAY_STEPS = Object.freeze([FETCH, SAVE, PROJECT_REPO, LAYER, REMOVE].map(STEP));
export const IGNORED_CAP = 2 * 1024 ** 3;
export const REPORT_CAP = 200;
const count = (raw, preset) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : preset; };
const ignoredCap = () => count(process.env.CBASE_COPY_IGNORED_CAP, IGNORED_CAP);
const text = (e) => String(e?.message || e || "unknown").split("\n").slice(0, 3).join(" ").slice(0, 800);
const codeOf = (e) => (typeof e?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : null);
const isMissing = (e) => e instanceof DockerError && /No such (object|container)|not found/i.test(`${e.stderr}\n${e.message}`);
const list = (xs) => ({ count: xs.length, paths: xs.slice(0, REPORT_CAP), ...(xs.length > REPORT_CAP ? { truncated: true } : {}) });

// Hook (server.js): fn({ projectId, serviceId, port, projectPath, instance }) ends a native service of the copy —
// services.js stopService (stacks/ does not import services.js; same pattern as setNativeServicesStatus in stacks/freeze.js).
let servicesStopper = null;
export function setServicesStopper(fn) { servicesStopper = typeof fn === "function" ? fn : null; }

// Test seam: fn({ copyId, step, repeated }) is awaited before each of the steps 1–4, after its phase is set — the guard
// writes into the copy “in the phase” there, without a clock. null removes it.
let observerForTest = null;
export function setClearAwayObserverForTest(fn) { observerForTest = typeof fn === "function" ? fn : null; }

const folderStands = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

// `check-ignore` INSIDE the copy — cwd a repo; stdin (NUL) paths relative to it, as BYTES (returnPath.js nulBytes); output
// per ignored path its NUMBER in the input (one line per number) — never the path itself: a name that is not UTF-8 would
// come back as text with U+FFFD and match none of the asked ones. Exit 22: git failed (exit > 1 — 1 only means “none
// ignored”); exit 23: git named a path that was not asked.
export const IGNORED_SCRIPT = `${PERL_HELPERS}
my $text = input();
my @paths = split /\\0/, $text, -1; pop @paths if @paths && $paths[-1] eq "";
my %seq; $seq{$paths[$_]} = $_ for 0 .. $#paths;
my ($fh, $tmp) = tempfile(UNLINK => 1); binmode $fh; print $fh $text; close($fh) or die "tmp: $!\\n";
open(STDIN, "<", $tmp) or die "$tmp: $!\\n";
open(my $p, "-|", "git", "-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin") or die "check-ignore: $!\\n";
binmode $p; my $o = do { local $/; <$p> }; close $p;
exit 22 if ($? >> 8) > 1;
for my $x (grep { length } split /\\0/, (defined $o ? $o : "")) { exit 23 unless exists $seq{$x}; print "$seq{$x}\\n"; }
`;

// ── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────────

const pending = (msg, code = "COPY_BACKUP") => new CopyError(msg, { code, status: 500 });

function checkFetched(what, entries) {
  // The FIRST line: the program puts the error lines first (returnPath.js `fetch`) — the last one was git's hint about
  // `git remote prune`, not the blocking ref.
  const f = entries.flatMap((r) => (r?.error || []).map((x) => `${r.rel}: ${x.source} — ${String(x.notice).split("\n")[0]}`));
  if (f.length) throw pending(T`${what}: ${f.length} ref(s) not fetched (${f.slice(0, 3).join("; ")})`, "COPY_FETCH");
}

// A worktree whose path is not UTF-8 or carries a line break is in the state only as a FINDING (fetch.js stateFromOutput — not in
// the list of worktrees). stepSave does not back up its open work (WIP only per worktree of that list), and step 5 would
// take it along. Until it is backed up as bytes, every step that reads the state stops here: “Backup pending”, the
// copy stays.
function withoutWorktreeFinding(statuses, step) {
  const b = [...statuses.values()].flatMap((st) => st.findings || []);
  if (!b.length) return;
  const names = b.slice(0, 3).map((x) => JSON.stringify(String(x.worktree))).join(", ");
  throw pending(T`${step}: ${b.length} worktree(s) of the copy with a path that is not UTF-8 or carries a line break (${names}${b.length > 3 ? ` (+${b.length - 3})` : ""}) — their open work cannot be backed up; rename the worktree in the copy (worktree move) or remove it`);
}

// If the search for repos in a dependency folder stopped at the cap (returnPath.js DEP_SEARCH_CAP, record `x`), a repo of
// the copy may lie in it that gets no bundle — step 5 would take it along. The fetch goes through in that case, the
// clear-away stops here (steps 1 and 4, each by the list of the upper layer).
function searchesComplete(listen, step) {
  const open = (listen.depIncomplete || []).map((x) => x.rel);
  if (!open.length) return;
  throw pending(T`${step}: the search for repos in ${open.slice(0, 5).join(", ")}${open.length > 5 ? ` (+${open.length - 5})` : ""} stopped (more than ${depSearchCap()} entries — cap, estimated, not measured; knob CBASE_COPY_DEP_SEARCH_CAP); a repo in there would have no bundle`, "COPY_CAP");
}

const shortRepos = (repos) => repos.map((r) => ({ part: r.part, rel: r.rel, fetched: r.fetched.map((g) => ({ source: g.source, target: g.target, fallback: g.fallback })), error: r.error }));

// ── The backed-up state (header “POST-CHECK”) ───────────────────────────────────────────────────────────────────────────
// What steps 1–3 actually backed up, in the journal (`backedUp`, survives a restart): per code repo the fetched refs
// `{ source: oid }` (step 1) and the result of every WIP computation `{ target: oid | "empty" | "without:<reason>" }` (step 2,
// target “clone” or the worktree's path), per new repo a fingerprint of state and WIP, read BEFORE its bundle (step 1), and
// the fetched refs of the project repo (step 3). The post-check recomputes the same in the copy and compares.
const codeRepos = (k) => k.snapshot.repos.filter((r) => !r.projectRepo);
const fetchedAs = (entries) => Object.fromEntries(entries.map((g) => [g.source, g.oid]));
const wipValue = (w) => (w.oid ? w.oid : w.empty ? "empty" : `without:${w.without || "?"}`);
const sorted = (m) => [...m].map(([n, o]) => `${n} ${o}`).sort();
/** The fingerprint of a state (COPY_STATUS, fetch.js stateFromOutput) — everything a backup fetches or names, in a fixed order. */
function statusFingerprint(st) {
  const form = {
    refs: sorted(st.refs), tags: sorted(st.tags), notes: sorted(st.notes), stash: st.stash, reflog: st.reflog,
    symref: st.symref, head: st.head, worktrees: [...st.worktrees].sort(),
    headers: st.wtHeads.map((w) => `${w.detached ? 1 : 0} ${w.head || "-"} ${w.id} ${w.path || ""}`).sort(),
    embedded: [...st.embedded].sort(), gitfile: [...st.gitfile].sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(form)).digest("hex");
}
// The WIP computation of a code repo: the clone (only the upper layer), then per worktree of the copy everything untracked
// — ONE function for step 2 and the post-check (the same messages, the same date ⇒ the same state yields the same id).
// The messages are commit messages in the user's repo and keep their wording.
async function wipOfTheRepos(k, repo, state, listen, time) {
  const out = [{ target: "clone", w: await wip(k, { cwd: k.pathOf(repo.rel), kind: "clone", mode: "top", top: topUnder(listen, repo.rel), time, message: `cbase: open work of copy ${k.name}` }) }];
  for (const wt of state?.worktrees || []) {
    out.push({ target: wt, w: await wip(k, { cwd: wt, kind: "wt", mode: "all", time, message: `cbase: open work of copy ${k.name} (worktree)` }) });
  }
  return out;
}
// The fingerprint of a new repo (state + WIP with the message of fetch.js wipMessageNew — the same id, no back and forth of the ref).
async function newFingerprint(k, rel, listen, time) {
  const st = await statusOfTheCopy(k, { rel, part: rel });
  const w = await wip(k, { cwd: k.pathOf(rel), kind: "clone", mode: "top", top: topUnder(listen, rel), time, message: wipMessageNew(k, rel) });
  return `${statusFingerprint(st)} ${wipValue(w)}`;
}

async function stepFetch(k, { helper, helperInst, time, backedUp }) {
  const statuses = await statusesOfTheCopy(k);
  withoutWorktreeFinding(statuses, "fetch");
  const listen = await upperLists(k, helper);
  searchesComplete(listen, "fetch");
  const { fresh, gitfile } = await newRepos(k, { statuses, listen });
  // The fingerprint of every new repo BEFORE its bundle — what happens in it afterwards is seen by the post-check.
  const newFingerprints = {};
  for (const rel of fresh) newFingerprints[rel] = await newFingerprint(k, rel, listen, time);
  const newR = await saveNewRepos(k, { listen, fresh, time });
  // Every repo the journal knows has its bundle here or the reason why it needs none — otherwise the step stays open (the
  // next attempt repeats it) instead of step 5 repeating “bundle missing” forever.
  const missing = backedUpRepos(k).filter((g) => !g.present && !g.without);
  if (missing.length) throw pending(T`fetch: bundle missing for ${missing.map((g) => g.rel).join(", ")}`);
  const repos = await fetchCodeRepos(k, { helperInst, statuses });
  checkFetched("fetch", repos);
  backedUp.refs = Object.fromEntries(repos.map((r) => [r.part, fetchedAs(r.fetched)]));
  backedUp.fresh = newFingerprints;
  const lfs = await fetchLfs(k, { helperInst });
  return {
    repos: shortRepos(repos), newRepos: newR.map((n) => (n.bundle ? { rel: n.rel, bundle: n.bundle, size: n.size } : n)),
    // The number of fetched stash entries (`copy/<name>/stash-<n>`), named separately — a stash is open work.
    stashes: repos.reduce((n, r) => n + r.fetched.filter((g) => g.source.startsWith("refs/cbase/stash-")).length, 0),
    gitfile, lfs, trap: repos.flatMap((r) => r.trap),
  };
}

async function stepSave(k, { helper, helperInst, time, backedUp }) {
  const statuses = await statusesOfTheCopy(k);
  withoutWorktreeFinding(statuses, "save");
  const listen = await upperLists(k, helper);
  const out = [];
  const wips = {};
  for (const repo of codeRepos(k)) {
    const ws = await wipOfTheRepos(k, repo, statuses.get(repo.part), listen, time);
    // The clone to `copy/<name>/wip`, a worktree `wt-<id>` to `copy/<name>/wip-<id>` — both `onlyNew`.
    const jobs = ws.filter(({ w }) => w.oid).map(({ target, w }) => ({
      source: `refs/cbase/wip/${w.id}`, target: copyTarget(k.name, target === "clone" ? "wip" : `wip-${w.id.slice(3)}`), oid: w.oid, onlyNew: true,
    }));
    const r = await fetchRepo(k, { helperInst, repo, jobs });
    checkFetched("save", [{ rel: repo.rel, error: r.error }]);
    wips[repo.part] = Object.fromEntries(ws.map(({ target, w }) => [target, wipValue(w)]));
    out.push({ part: repo.part, rel: repo.rel, wip: r.fetched.map((g) => ({ source: g.source, target: g.target, fallback: g.fallback })) });
  }
  backedUp.wip = wips;
  return { repos: out, lfs: await fetchLfs(k, { helperInst }) };
}

async function stepProjectRepo(k, { helper, helperInst, backedUp }) {
  const listen = await upperLists(k, helper);
  const pr = await fetchProjectRepo(k, { helperInst, listen });
  if (pr) checkFetched("projectRepo", [pr]);
  backedUp.projectRepo = pr ? fetchedAs(pr.fetched) : null;
  return pr ? { ...pr, fetched: pr.fetched.map((g) => ({ source: g.source, target: g.target, fallback: g.fallback })) } : null;
}

// ── The post-check ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Steps 1–3 each back up a snapshot; the copy can still be written to afterwards — by processes INSIDE it (an attached
// editor window, a background process, a write already under way), past the lock of the routes (devtools/routes.js
// writeLockCopy). What came after the backup of its repo, step 5 would silently take along with the container. Hence, at
// the end of step 4, in the same journal step (it only counts as done afterwards — an abort or failure resumes there, never
// at step 5): what runs again since the stopping before step 1 ends once more (holdWriterOn: native services and stack
// containers — otherwise a dev server or a stack container would keep writing and the check would trip on every call), then
// it recomputes in the copy what steps 1–3 would back up and compares it with `backedUp`:
//   - per code repo the fetch jobs from the state of NOW (fetch.js jobsFor) — each must be fetched with the same id;
//   - per code repo the WIP computation (wipOfTheRepos — the same messages, the same date, so the same id for the same state);
//   - the new repos (fetch.js newRepos): the same as in step 1, each with the same fingerprint;
//   - the project repo: its fetch jobs from the state of now are fetched, and its WIP computation is empty (the commit of
//     step 3 took everything that is not ignored).
// Ignored files do not count (they are only named; a cache that keeps running would otherwise stop every clear-away).
// If something differs: steps 1–4 run ONCE more (through the journal: idempotent, the same date; a new backup lands on a
// fallback ref because of `onlyNew`, the old one stays), then the check again. If it still differs, something keeps writing
// in the copy: `error` “Backup pending” (COPY_POST_CHECK) — the copy stays, nothing is removed. Rather `error` than
// silent. No new git start place: everything runs through k.run (runtime/git-run.js commandRun) like steps 1–3.
class StillOnce extends Error {}
const POST_CHECK_TEXT_MAX = 20;

async function postCheck(k, { helper, time, backedUp }) {
  const deviation = [];
  const statuses = await statusesOfTheCopy(k);
  withoutWorktreeFinding(statuses, T("post-check"));
  const listen = await upperLists(k, helper);
  searchesComplete(listen, T("post-check"));
  for (const repo of codeRepos(k)) {
    const st = statuses.get(repo.part);
    const refs = backedUp.refs?.[repo.part];
    const wips = backedUp.wip?.[repo.part];
    if (!refs || !wips) { deviation.push(T`${repo.rel}: no backed-up state in the journal`); continue; }
    const open = jobsFor(k, repo, st).filter((a) => refs[a.source] !== a.oid);
    if (open.length) deviation.push(T`${repo.rel}: ${open.length} ref(s) new or moved (${open.slice(0, 3).map((a) => a.source).join(", ")})`);
    for (const { target, w } of await wipOfTheRepos(k, repo, st, listen, time)) {
      if (wips[target] !== wipValue(w)) deviation.push(target === "clone" ? T`${repo.rel}: open work changed` : T`${repo.rel}: open work in the worktree ${target} changed`);
    }
  }
  const { fresh } = await newRepos(k, { statuses, listen });
  const newPrior = backedUp.fresh || null;
  if (!newPrior) deviation.push(T("new repos: no backed-up state in the journal"));
  else {
    for (const rel of fresh) {
      if (!(rel in newPrior)) deviation.push(T`new repo ${rel}: created after the fetch`);
      else if (newPrior[rel] !== await newFingerprint(k, rel, listen, time)) deviation.push(T`new repo ${rel}: changed after its bundle`);
    }
  }
  const pr = k.snapshot.repos.find((r) => r.projectRepo);
  if (pr) {
    const refs = backedUp.projectRepo;
    if (!refs) deviation.push(T("Project repo: no backed-up state in the journal"));
    else {
      const open = jobsFor(k, pr, await statusOfTheCopy(k, pr)).filter((a) => refs[a.source] !== a.oid);
      if (open.length) deviation.push(T`Project repo: ${open.length} ref(s) new or moved`);
      const w = await wip(k, { cwd: k.pathOf(pr.rel), kind: "clone", mode: "top", top: topUnder(listen, pr.rel), time, message: `cbase: post-check of the copy ${k.name}` });
      if (!w.empty) deviation.push(T("Project repo: open work after the commit"));
    }
  }
  return deviation;
}

// The owners of the files of the upper layer (header, step 4): per path the deepest repo it lies in — repos of the
// snapshot, backed-up new repos, worktrees of the copy below the project folder —, or “without” (no repo: everything counts).
function ownerValue(k, { statuses, gitfile }) {
  const out = new Map();
  for (const r of k.snapshot.repos) out.set(r.rel, "repo");
  // “gone”: no repo lies there any more — what still lies below counts as without a repo (report, with `automatic` the tar).
  for (const g of backedUpRepos(k)) out.set(g.rel, g.without === "gitfile" || g.without === "gone" ? "without" : "repo");
  for (const st of statuses.values()) {
    for (const wt of st.worktrees) {
      const rel = relTo(wt, k.projectPath);
      if (wt.startsWith(`${k.projectPath}/`) && pathError(rel) === null) out.set(rel, "repo");
    }
  }
  for (const rel of gitfile) out.set(rel, "without");
  for (const n of k.snapshot.notLinked || []) if (n.reason !== "embedded" && !out.has(n.rel)) out.set(n.rel, "without");
  const sorted = [...out.entries()].sort((a, b) => b[0].length - a[0].length);
  return (rel) => {
    for (const [o, kind] of sorted) if (o === "." || under(rel, o)) return { rel: o, kind };
    return { rel: null, kind: "without" };
  };
}

async function ignoredOf(k, owner, paths) {
  if (!paths.length) return [];
  const r = await k.run(k.pathOf(owner), "perl", ["-e", IGNORED_SCRIPT], { stdin: nulBytes(paths), what: "check-ignore" });
  if (r.code === 23) throw pending(T`${owner}: check-ignore named a path that was not asked`);
  if (r.code !== 0) throw pending(T`${owner}: check-ignore in the copy failed (exit ${r.code ?? r.signal}): ${String(r.stderr || "").trim().split("\n").pop()}`);
  const out = [];
  for (const z of String(r.stdout || "").split("\n").filter(Boolean)) {
    const i = Number(z);
    if (!/^\d+$/.test(z) || i >= paths.length) throw pending(T`${owner}: check-ignore returned ${JSON.stringify(z.slice(0, 40))} instead of a number of the input`);
    out.push(paths[i]);
  }
  return out;
}

async function stepLayer(k, { helper, helperInst, retrieve, automatic }) {
  const statuses = await statusesOfTheCopy(k);
  withoutWorktreeFinding(statuses, T("upper layer"));
  const listen = await upperLists(k, helper);
  searchesComplete(listen, T("upper layer"));
  // The safety net: every folder into whose `.git` the copy wrote is a part of the snapshot or backed up (a bundle or the
  // reason why none) — otherwise its history would lie only in the layer, and step 5 would take it along.
  const known = new Set(k.snapshot.repos.map((r) => r.rel));
  const backedUpAll = new Set(backedUpRepos(k).map((g) => g.rel));
  const notBackedUp = [...listen.gitInside].filter((rel) => rel !== "." && !known.has(rel) && !backedUpAll.has(rel)).sort();
  if (notBackedUp.length) throw pending(T`layer: the copy wrote into the .git of ${notBackedUp.slice(0, 5).join(", ")}${notBackedUp.length > 5 ? ` (+${notBackedUp.length - 5})` : ""}, without a bundle`);
  const gitfile = (await newRepos(k, { statuses, listen })).gitfile;
  const wem = ownerValue(k, { statuses, gitfile });
  // The unversioned files: ignored (per repo) or without a repo.
  const perOwner = new Map();
  const withoutRepo = [];
  for (const d of listen.files) {
    const o = wem(d.rel);
    if (o.kind === "without") { withoutRepo.push(d); continue; }
    if (!perOwner.has(o.rel)) perOwner.set(o.rel, []);
    perOwner.get(o.rel).push(d);
  }
  const ignored = [...withoutRepo];
  for (const [owner, ds] of perOwner) {
    const ign = new Set(await ignoredOf(k, owner, ds.map((d) => relTo(d.rel, owner))));
    for (const d of ds) if (ign.has(relTo(d.rel, owner))) ignored.push(d);
  }
  ignored.sort((a, b) => a.rel.localeCompare(b.rel));
  const partPath = new Map(listen.parts.map((t) => [t.part, t]));

  // Retrieving: backed-up repos through their bundle, otherwise named files/folders of this list.
  const backedUp = new Set(backedUpRepos(k).map((g) => g.rel));
  const back = [];
  const denied = [];
  const repos = [];
  const perPart = new Map();
  const take = (e) => { if (!perPart.has(e.part)) perPart.set(e.part, new Set()); perPart.get(e.part).add(e.inPart); };
  for (const rel of retrieve) {
    const f = pathError(rel);
    if (f) { denied.push({ rel: String(rel), reason: f }); continue; }
    if (backedUp.has(rel)) { repos.push(rel); continue; }
    const dep = listen.dependent.find((a) => a.rel === rel);
    const hits = dep ? [dep] : ignored.filter((d) => d.rel === rel || under(d.rel, rel));
    if (!hits.length) { denied.push({ rel, reason: T("not in the list of the ignored or unversioned files of the copy") }); continue; }
    for (const t of hits) take(t);
  }
  const r = await retrieveRepos(k, { helperInst, rels: repos });
  back.push(...r.retrieved);
  denied.push(...r.denied);
  const broken = [];
  for (const [part, rels] of perPart) {
    const t = partPath.get(part);
    const z = await copyBack({ helperInst, source: t.path, target: k.pathOf(t.rel), rels: [...rels].sort() });
    const full = (x) => (t.rel === "." ? x : `${t.rel}/${x}`);
    back.push(...z.back.map((x) => ({ rel: full(x), kind: "file" })));
    denied.push(...z.denied.map((x) => ({ rel: full(x.rel), reason: x.reason })));
    broken.push(...z.error.map((x) => `${full(x.rel)}: ${x.reason}`));
  }
  // A read or write error while retrieving is not “denied” — the human asked for the path, and the layer is its only
  // complete version. Step 4 then does not count as done, step 5 does not run; a new attempt retrieves what is still
  // missing (what already came back this time is then listed as occupied in the report).
  if (broken.length) throw pending(T`Retrieving: ${broken.length} path(s) not retrieved (${broken.slice(0, 3).join("; ")})`, "COPY_RETRIEVE");

  // automatic ⇒ the ignored files (without dependencies) as ONE tar, never played back.
  let tar = null;
  if (automatic && ignored.length) {
    createBackup(k.location);
    const file = k.location.ignoredTar;
    const cap = ignoredCap();
    try {
      const t = await tarOfTheLayers({ helper, entries: ignored.map((d) => [partPath.get(d.part).path, d.inPart, d.rel]), file, cap });
      tar = { file, size: t.size, count: ignored.length - t.missingCount, missing: t.missing, ...(t.missingCount > t.missing.length ? { missingCount: t.missingCount, truncated: true } : {}) };
    } catch (e) {
      try { dismissBackupFile(k.location, file); } catch { /* the error above counts */ }
      throw e;
    }
  }
  const names = (xs) => xs.map((x) => x.rel);
  return {
    ignored: list(names(ignored)), dependent: list(names(listen.dependent)), deleted: list(names(listen.deleted)),
    opaque: list(names(listen.opaque)), special: list(names(listen.special)), unreadable: list(names(listen.unreadable)),
    back, denied, tar,
  };
}

// End the native services of the copy — per running one through the hook setServicesStopper. → the rows for the report
// (id, or id with reason). Step 5 and holdWriterOn (before step 1 and before the post-check) — the second time none runs
// any more, the list stays empty.
async function endNativeServices(pid, instance) {
  const out = [];
  try {
    for (const d of (await nativeServicesStatus(pid, { instance })).filter((x) => x.running)) {
      if (!servicesStopper) { out.push(T`${d.id}: without the hook — ends with the container`); continue; }
      try { await servicesStopper({ projectId: pid, serviceId: d.id, port: d.port, projectPath: store.getProject(pid)?.path || "", instance }); out.push(d.id); }
      catch (e) { out.push(`${d.id}: ${text(e)}`); }
    }
  } catch (e) { out.push(T`Services not read: ${text(e)}`); }
  return out;
}

// ── Stopping the writers of the copy ────────────────────────────────────────────────────────────────────────────────────
// If only the NATIVE services ended before the post-check (nativeServicesStatus skips a service whose container runs), the
// containers of the stack in the copy's inner dockerd would run until the `docker stop` of step 5. If one of them wrote
// into a versioned path (a bind in the project folder: logs, uploads, SQLite — the project repo versions everything next
// to the code repos except dependencies and unreadable things), the check would differ even after the repetition: `error`
// COPY_POST_CHECK on EVERY call as long as the stack runs, and the client has no stop for a copy outside `ready`. So the
// clear-away itself stops all writers that step 5 ends anyway: right after step 0 (and after copyRunning — a restart of the
// copy brings `always`/`unless-stopped` up again), before step 1, and once more at the start of the post-check (second net:
// a process in the copy that starts a container again). The order: first the native services (they still write into the
// stack's database), then every RUNNING container of the inner dockerd — `docker ps -q` INSIDE the copy, `docker stop -t
// 30` by id. Only own ones: the inner dockerd is the copy's (its own docker volume), cbase creates nothing of its own in
// it, and step 5 stops it with everything in it. What the stack still writes while stopping (flush) lies before step 1 and
// so in the first backup. No function is lost: the copy's stack ends in step 5 anyway, and an `earmarked` (step 0 not
// quiet) stops nothing.
// → `{ services, container, open }`: the ended services (format of endNativeServices), the shortened ids of the stopped
// containers and, per writer that keeps running or could not be read, a sentence (for the report and the error text of the
// post-check). Never throws — the post-check stays the net behind it.
const STACK_STOP_DEADLINE_S = 30;
const STACK_STOP_CAP_MS = 90_000; // like `docker stop` in step 5: the deadline (30 s, the daemon stops in parallel) plus a buffer — estimated
const idsFrom = (s) => String(s || "").split(/\s+/).filter(Boolean);

async function holdWriterOn(pid, instance, containerId) {
  const services = await endNativeServices(pid, instance);
  const open = services.filter((d) => typeof d === "string");
  const container = [];
  if (!containerId) return { services, container, open: [...open, T("Stack: no copy container")] };
  const running = async () => idsFrom((await dockerIn(containerId, ["ps", "-q", "--no-trunc"], { capMs: CALL_CAP_MS })).stdout);
  try {
    const ids = await running();
    if (ids.length) {
      let failure = null;
      try { await dockerIn(containerId, ["stop", "-t", String(STACK_STOP_DEADLINE_S), ...ids], { capMs: STACK_STOP_CAP_MS }); }
      catch (e) { failure = text(e); }
      // A failure can hit single ones (one ended between `ps` and `stop`): whoever still runs afterwards is open.
      const stillRunning = failure ? new Set(await running()) : new Set();
      for (const id of ids) {
        if (stillRunning.has(id)) open.push(`Container ${id.slice(0, 12)}: ${failure}`);
        else container.push(id.slice(0, 12));
      }
    }
  } catch (e) { open.push(T`Stack not read: ${text(e)}`); }
  if (container.length) console.log(`[stacks] copy ${pid}/${instance}: ${container.length} container(s) of the stack stopped (clear-away)`);
  return { services, container, open };
}

// Merge the results of holdWriterOn into one field of the report (a second call after an abort appends).
function withHalted(old, fresh) {
  const plus = (a, b) => [...new Set([...(a || []), ...b])];
  const out = { ...(old || {}) };
  for (const f of ["services", "container", "open"]) if (fresh[f].length) out[f] = plus(out[f], fresh[f]);
  return out;
}
const hasHalted = (fresh) => Boolean(fresh.services.length || fresh.container.length || fresh.open.length);

// Step 5 (header). No longer needs the copy — only its location and its instance.
async function removeStep({ copy, pid, instance, location, data, journal }) {
  const missing = backedUpRepos({ copy, location }).filter((g) => !g.present && !g.without);
  if (missing.length) throw pending(`Bundle missing: ${missing.map((g) => `${g.rel} (${g.bundle})`).join(", ")} — nothing removed`);
  const report = { services: [], stopped: null };
  const inst = store.projectInstance(pid, instance);
  if (inst) {
    report.services = await endNativeServices(pid, instance);
    if (inst.containerId) {
      const { own } = await onlyOwn([String(inst.containerId)]);
      for (const id of own) {
        try { await docker(["stop", "-t", "30", id], { capMs: 90_000 }); report.stopped = id.slice(0, 12); }
        catch (e) { if (!isMissing(e)) throw e; }
      }
    }
  }
  // The worktrees of the copy in the runtime folder (step 2 backed up their open work) — before the dismantling, which
  // deletes the instance row last: if removing fails, the row stays and the clear-away is `error`. Deleted in the main
  // container or by the root helper, never in B (the running main mounts the folder rw).
  const runLocation = locationFor({ projectId: pid, converted: true });
  report.worktrees = (await removeCopyWorktrees({ runLocation, root: worktreeRoot(runLocation, instance), projectId: pid, instance })).removed;
  const r = await dismantleCopy({ copy: store.stackCopy(copy.id) || copy, instance, journal, reason: "clearAway" }, { data });
  cleanUpBackup(location);
  return { ...report, removed: r.removed, stayed: r.stayed };
}

// ── The running copy for steps 1–4 ──────────────────────────────────────────────────────────────────────────────────────
// After an orderly server end (--force, host restart, container swap) the stop chain (projectbox/serverEnd.js) has stopped
// the copy container too; `unless-stopped` does not bring it back, and no restart path touches an instance row in
// `clearAway`. Continuing would run against the stopped container into COPY_STANDS and end in `error`. So the clear-away
// brings it up itself — under its occupancy and its procedure, with the instance row in `clearAway`: it never becomes
// `ready` on the way, every turn of the chat waits at its lock, none slips into the copy. `docker start` by id, only the
// own container (labels LABEL_PROJECT AND LABEL_INSTANCE), a paused one is not touched (its pause belongs to another
// procedure); then waitForInside until the ready phase (the entrypoint has mounted the overlays again — a git before that
// would see the project folder without them). Steps 1–4 do not need the copy's stack — what the inner dockerd brings up
// again by itself at the start (`always`, `unless-stopped`) is stopped by holdWriterOn right after.
// Returns `{ id, started, created }` — the full id of the running copy container (for holdWriterOn, without a second read
// of the row) and the shortened id if the clear-away started or re-created it (otherwise null each). If it fails:
// COPY_STANDS (“Backup pending”, the layer stays).
// If the container is MISSING (the row names none, or `inspect` says “No such container”), copyNewCreate creates it instead
// of reporting COPY_STANDS. Only the re-creation (projectbox/recreate.js) would otherwise create it — and that locks a copy
// in clear-away (projectbox/restore.js): every clear-away would end COPY_STANDS, the chat would stay at the lock, deletion
// 409, with the database as the only way out.
// `creation` (test seams of the creation, otherwise those of the product): `{ home, system, data, root, addresses }`.
async function copyRunning(pid, instance, creation = {}) {
  const stands = (msg) => pending(T`Copy ${pid}/${instance}: ${msg}`, "COPY_STANDS");
  const inst = store.projectInstance(pid, instance);
  if (!inst) throw stands(T("no instance row"));
  let c = null;
  if (inst.containerId) {
    try { c = JSON.parse((await docker(["inspect", "--type", "container", String(inst.containerId)], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
    catch (e) { if (!isMissing(e)) throw stands(`inspect: ${text(e)}`); c = null; }
  }
  if (!c) return copyNewCreate(pid, instance, inst, creation, stands);
  const l = c.Config?.Labels || {};
  if (l[LABEL_PROJECT] !== pid || l[LABEL_INSTANCE] !== instance) throw stands(T`${String(c.Id).slice(0, 12)} does not carry the labels of this copy — not started`);
  if (c.State?.Paused) throw stands(T("the container is paused — not touched"));
  if (c.State?.Running) return { id: String(c.Id), started: null, created: null };
  const id = String(c.Id);
  try { await docker(["start", id], { capMs: CALL_CAP_MS }); } catch (e) { throw stands(`docker start ${id.slice(0, 12)}: ${text(e)}`); }
  let status;
  try { ({ status } = await waitForInside(id)); } catch (e) { throw stands(T`after the start: ${text(e)}`); }
  if (status?.phase !== "ready") throw stands(T`the entrypoint reports phase=${status?.phase || "—"}: ${status?.notice || "—"}`);
  console.log(`[stacks] copy ${pid}/${instance}: started again for the clear-away (${id.slice(0, 12)})`);
  return { id, started: id.slice(0, 12), created: null };
}

// Create the copy's missing container anew WITHOUT reviving the copy. The same way as re-creating a copy
// (projectbox/instance.js createInstance: its rule table, its layer in the copy's location — the creation does not touch
// it —, its volume, the network of the row), but in `clearAway` under the occupancy the clear-away already holds: the
// instance row never leaves `clearAway` (no `ready`, no turn slips in), there is no restore (no stack, no native services —
// steps 1–4 do not need them; what the inner dockerd brings up itself is stopped by holdWriterOn right after). The creation
// waits for the ready phase and checks overlay2 and cgroup like any other; afterwards the row gets its phase back (the
// creation sets its own). If it fails (the row is then `clearAway` with a creation error and no container, the creation's
// dismantling ran): COPY_STANDS — the catch of clearAwayCopy sets `error`, the next call tries again. A container under
// the copy's name that the row does not name stays untouched (the creation refuses ⇒ COPY_STANDS).
async function copyNewCreate(pid, instance, inst, creation, stands) {
  const phasePrior = inst.phase || FETCH;
  let row;
  try {
    row = await createInstance(pid, {
      instance, state: "clearAway", occupancyHeld: true,
      home: creation.home, system: creation.system || null, data: creation.data || null, root: creation.root || "", addresses: creation.addresses ?? null,
    });
  } catch (e) { throw stands(T`the container is missing, and creating it anew failed: ${text(e)}`); }
  const id = String(row?.containerId || "");
  if (!id) throw stands(T("the container is missing, and the creation named no new one"));
  setInstanceState(pid, instance, "clearAway", { phase: phasePrior });
  console.log(`[stacks] copy ${pid}/${instance}: the container was missing — created anew for the clear-away (${id.slice(0, 12)})`);
  return { id, started: null, created: id.slice(0, 12) };
}

// ── The procedure ───────────────────────────────────────────────────────────────────────────────────────────────────

// Step 0 (header): synchronous — lock first, then idle. Returns null (quiet) or `{ open }` (reset).
// Not quiet ⇒ BOTH rows back to where they stood before step 0: the instance row to its state, the copy to
// `clearAway/earmarked` — if it came from `error`, back to `error` with its reason. Otherwise it too would stand `earmarked`
// with an instance row in `error`: the restore exempts `earmarked` (there the instance row stays `ready`), so the lock of
// its chat would trigger the new attempt from `error` after the deadline and the copy would run `ready` again — a revival;
// what came into being after that would only be saved by wasAliveAgain. `earmarked` means exactly “came from ready”.
function stepNull(copy, pid, instance) {
  const inst = store.projectInstance(pid, instance);
  if (!inst) throw pending(T`the instance row ${pid}/${instance} is missing — without it the copy cannot be fetched`, "COPY_STANDS");
  const prior = { state: inst.state, phase: inst.phase || "", error: inst.error || "" };
  const copyPrior = { state: copy.state, error: copy.error || "" };
  setCopyState(copy.id, "clearAway", { phase: FETCH });
  let empty;
  try { empty = instanceIdle(store.instanceIdentifier(pid, instance)); }
  catch (e) { empty = { quiet: false, open: [{ chatId: "", reason: "unreadable", text: text(e) }] }; }
  if (empty.quiet) {
    // Terminals and debuggers of the copy itself (code tab, `proj:<id>@copy-<name>`) do not count toward idleness; they end
    // here with a message — as under the lock of the re-creation. Otherwise they would run into the fetching and backing up
    // and only die with the container, without a word. Likewise the terminals of the chat bar (`chat:<id>`) of the chats of
    // this copy. A NEW terminal no longer opens from here on: the instance row is `clearAway`, and no file or git route of
    // the copy accepts anything any more.
    try {
      const n = endInstanceSessions(pid, instance, T`[cbase] The copy "${copy.name}" is being removed — this terminal was closed.`, { chats: true });
      if (n) console.log(`[stacks] copy ${pid}/${instance}: ${n} terminal(s)/debugger(s) ended (clear-away)`);
    } catch (e) { console.error(`[stacks] copy ${pid}/${instance}: terminals not ended:`, text(e)); }
    return null;
  }
  if (copyPrior.state === "error") {
    // First the instance row back (out of `clearAway` — afterwards the copy's setter no longer couples it), then the copy to
    // `error` with its old reason. The job stays; the wake-up (stacks/remove.js) tries again.
    setInstanceState(pid, instance, prior.state, { phase: prior.phase, ...(prior.state === "error" ? { error: prior.error } : {}), ifState: "clearAway" });
    setCopyState(copy.id, "error", { error: copyPrior.error || T("Clear-away pending: something is still running in the copy") });
    return { open: empty.open };
  }
  setCopyState(copy.id, "clearAway", { phase: EARMARKED });
  setInstanceState(pid, instance, prior.state, { phase: prior.phase, ...(prior.state === "error" ? { error: prior.error } : {}), ifState: "clearAway" });
  return { open: empty.open };
}

// ── Did the copy run again after the backup? ────────────────────────────────────────────────────────────────────────────
// A clear-away that continues at step 5 (step 4 including the post-check done, then step 5 failed or the server ended)
// skips steps 0–4 — correct as long as nothing ran in the copy since the post-check. This net catches a copy that was
// revived in between (by an older release or a path nobody thought of): turns worked in it, and step 5 would take their
// work along unfetched. It ran again if (in this order, without docker first):
//   - its instance row carries the marker REVIVED (the start of B set a revived row to `error` this way), or
//   - it stands neither `error` nor `clearAway` (ready, start, recreate … — revived now), or
//   - its container was started AFTER step 4 was done (journal step of the layer done; `State.StartedAt` — even if it fell
//     back to `error` afterwards). A restart that brings the container up by itself is a harmless false alarm.
// Then the clear-away begins at step 0 again (lock and idle — a turn can run in a revived copy) and fetches, backs up and
// checks once more — idempotent through the same date; changed open work lands on a fallback ref (`onlyNew`). If its
// container cannot be read (unlike “missing”): “Backup pending” (COPY_STANDS) — nothing removed.
// Returns the reason (text for report and log) or null.
async function wasAliveAgain(copy, pid, instance) {
  const inst = store.projectInstance(pid, instance);
  if (!inst) return null; // the dismantling ran to the end (the instance row goes last) — nothing runs in it any more
  if (inst.phase === REVIVED) return T`instance row with the marker ${REVIVED}`;
  if (!["error", "clearAway"].includes(inst.state)) return T`instance row “${inst.state}”`;
  const backedUpAt = (copy.journal?.log || []).filter((p) => p.step === STEP(LAYER) && p.what === "done").map((p) => Number(p.at)).filter(Number.isFinite).pop();
  if (!backedUpAt || !inst.containerId) return null;
  let c;
  try { c = JSON.parse((await docker(["inspect", "--type", "container", String(inst.containerId)], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) {
    if (isMissing(e)) return null;
    throw pending(T`Copy ${pid}/${instance}: whether it ran again after the backup cannot be read (inspect: ${text(e)}) — step 5 waits`, "COPY_STANDS");
  }
  const start = Date.parse(String(c?.State?.StartedAt || ""));
  return Number.isFinite(start) && start > backedUpAt ? T`container ${String(c.Id).slice(0, 12)} started after the backup` : null;
}

// Set the phase if the row can carry it: in `clearAway` always, from `error` only with an instance row (otherwise `error`
// stays until `removed`).
function phase(copyId, p) {
  const k = store.stackCopy(copyId);
  if (k.state === "clearAway" && k.phase === p) return;
  if (k.state === "clearAway" || store.projectInstance(k.projectId, copyInstance(k.name))) setCopyState(copyId, "clearAway", { phase: p });
}

async function run(copy, opts) {
  const pid = String(copy.projectId);
  const instance = copyInstance(copy.name);
  const data = opts.data || DIRS.data;
  const location = copyLocation({ data, projectId: pid, name: copy.name });
  const journal = copyJournal(copy.id);
  const old = copy.journal?.data?.clearAway || null;
  const run2 = {
    time: old?.time || Math.floor(Date.now() / 1000), reason: opts.reason || old?.reason || "", automatic: Boolean(opts.automatic || old?.automatic),
    retrieve: [...new Set([...(old?.retrieve || []), ...opts.retrieve])], report: old?.report || {},
    // What steps 1–3 backed up (header “The backed-up state”) — never in the report, only for the post-check.
    backedUp: old?.backedUp && typeof old.backedUp === "object" ? old.backedUp : {},
  };
  const remember = () => journal.note({ clearAway: run2 });
  const state = journal.snapshot();
  let from = CLEAR_AWAY_STEPS.includes(state?.step) ? nextStep(CLEAR_AWAY_STEPS, state) : CLEAR_AWAY_STEPS[0];
  if (from === null) from = STEP(REMOVE); // everything done but not `removed` (an abort in between): step 5 is idempotent
  if (from === STEP(REMOVE)) {
    // If the copy ran again after the backup (wasAliveAgain): fetch and back up first, then remove.
    const why = await wasAliveAgain(copy, pid, instance);
    if (why) {
      console.warn(`[stacks] copy ${pid}/${instance}: ran again after the backup (${why}) — steps 0–4 run once more before step 5`);
      run2.report.revived = why;
      from = CLEAR_AWAY_STEPS[0];
    }
  }

  const openPrior = CLEAR_AWAY_STEPS.indexOf(from) < CLEAR_AWAY_STEPS.indexOf(STEP(REMOVE));
  if (openPrior) {
    // Step 0 — only from `ready`, `earmarked` and `error` (a running phase already holds the lock).
    const now = store.stackCopy(copy.id);
    if (now.state !== "clearAway" || now.phase === EARMARKED) {
      const n = stepNull(now, pid, instance);
      if (n) return { state: "earmarked", report: { open: n.open } };
    }
    await remember();
    // Steps 1–4 need the running copy; if its container is missing, copyRunning creates it anew (header there).
    const running = await copyRunning(pid, instance, { home: opts.home, system: opts.system, data: opts.data, root: opts.root, addresses: opts.addresses });
    if (running.started) { run2.report.copyStarted = running.started; await remember(); }
    if (running.created) { run2.report.copyCreated = running.created; await remember(); }
    // Before step 1 stop the writers of the copy — native services AND the containers of its stack (header of
    // holdWriterOn). What they still write on the way is already taken along by the first backup.
    const openNow = [];
    const initial = await holdWriterOn(pid, instance, running.id);
    openNow.push(...initial.open);
    if (hasHalted(initial)) { run2.report.halted = withHalted(run2.report.halted, initial); await remember(); }
    const k = copyContext(store.stackCopy(copy.id), { data });
    await withReturnPathHelper({ copy, location, projectPath: k.projectPath, snapshot: k.snapshot, home: opts.home, system: opts.system }, async ({ helper, helperInst }) => {
      const g = run2.backedUp;
      // Step 4 ends with the post-check (header there) — only afterwards does the layer step count as done.
      let repeated = false;
      const control = async () => {
        // Second net: what runs again since the stopping before step 1 ends here — usually nothing.
        const again = await holdWriterOn(pid, instance, running.id);
        openNow.push(...again.open);
        if (hasHalted(again)) run2.report.postCheck = withHalted(run2.report.postCheck, again);
        const deviation = await postCheck(k, { helper, time: run2.time, backedUp: g });
        if (!deviation.length) return;
        const set = `${deviation.slice(0, POST_CHECK_TEXT_MAX).join("; ")}${deviation.length > POST_CHECK_TEXT_MAX ? ` (+${deviation.length - POST_CHECK_TEXT_MAX})` : ""}`;
        if (repeated) {
          // Services and stack containers are stopped by the clear-away itself (holdWriterOn); the sentence only names what
          // it could NOT stop, and what it never stops — for that the client has no way except the one named there.
          const notOn = [...new Set(openNow)].map((x) => String(x).slice(0, 240));
          const not = notOn.length ? T` Not stopped: ${notOn.slice(0, 5).join("; ")}${notOn.length > 5 ? ` (+${notOn.length - 5})` : ""}.` : "";
          throw pending(T`Post-check: the copy is still being written to after the backup (${set}) — nothing removed. Services and stack containers of the copy are stopped by the clear-away itself.${not} End whatever else writes there (a VS Code window, cbase-project) and call the clear-away again`, "COPY_POST_CHECK");
        }
        repeated = true;
        console.log(`[stacks] copy ${pid}/${instance}: post-check — written after the backup (${set}); steps 1–4 run once more`);
        // The backups of the first round stay in main; the second puts changed open work on a fallback ref (`wip-1`)
        // because of `onlyNew` — the report names both.
        run2.report.postCheck = { ...(run2.report.postCheck || {}), repeated: deviation.slice(0, POST_CHECK_TEXT_MAX), firstBackup: run2.report.save?.repos || [] };
        await remember();
        throw new StillOnce();
      };
      const effect = {
        [STEP(FETCH)]: async () => { run2.report.fetch = await stepFetch(k, { helper, helperInst, time: run2.time, backedUp: g }); },
        [STEP(SAVE)]: async () => { run2.report.save = await stepSave(k, { helper, helperInst, time: run2.time, backedUp: g }); },
        [STEP(PROJECT_REPO)]: async () => { run2.report.projectRepo = await stepProjectRepo(k, { helper, helperInst, backedUp: g }); },
        [STEP(LAYER)]: async () => {
          const prior = repeated ? run2.report.layer : null;
          const s = await stepLayer(k, { helper, helperInst, retrieve: run2.retrieve, automatic: run2.automatic });
          // Second round: what the first already retrieved is now listed as occupied — the report names it as retrieved.
          const already = new Set((prior?.back || []).map((z) => z.rel));
          run2.report.layer = prior
            ? { ...s, back: [...prior.back, ...s.back], denied: s.denied.filter((a) => !already.has(a.rel)) }
            : s;
          await control();
        },
      };
      let i = CLEAR_AWAY_STEPS.indexOf(from);
      while (i < CLEAR_AWAY_STEPS.length - 1) {
        const s = CLEAR_AWAY_STEPS[i];
        phase(copy.id, [FETCH, SAVE, PROJECT_REPO, LAYER][i]);
        if (observerForTest) await observerForTest({ copyId: copy.id, step: s, repeated });
        try {
          await journal.step(s, async () => { await effect[s](); await remember(); });
        } catch (e) {
          // The post-check differed: the layer step stays announced, not done — from the start (the fetch step), once.
          if (!(e instanceof StillOnce)) throw e;
          i = 0;
          continue;
        }
        i += 1;
      }
    });
  }
  // Step 5.
  phase(copy.id, REMOVE);
  await journal.step(STEP(REMOVE), async () => {
    run2.report.remove = await removeStep({ copy, pid, instance, location, data, journal });
    await remember();
  });
  // The backup folder only if it still exists after step 5 (bundles of new repos, the tar of the ignored files) —
  // cleanUpBackup deletes an empty one.
  const report = { reason: run2.reason, automatic: run2.automatic, ...run2.report, ...(folderStands(location.backup) ? { backup: location.backup } : {}) };
  setCopyState(copy.id, "removed", { result: report });
  wakeProject(pid);
  return { state: "removed", report };
}

async function clearAway(copyId, opts) {
  const copy = store.stackCopy(copyId);
  if (!copy) return { state: "error", report: { error: T`no copy ${copyId}` } };
  if (copy.state === "removed") return { state: "removed", report: copy.result };
  if (store.STACK_COPY_WAITING.includes(copy.state)) {
    const report = { reason: opts.reason, automatic: opts.automatic, dismissed: true };
    setCopyState(copy.id, "removed", { result: report });
    return { state: "removed", report };
  }
  if (copy.state === "build") return { state: "earmarked", report: { waiting: "build" } };
  if (!projectboxOps()) throw new CopyError(T`copies exist only in server mode`, { code: "NO_OPS", status: 404 });
  const pid = String(copy.projectId);
  const instance = copyInstance(copy.name);
  if (neverBuilt(copy)) {
    // Never ready: nobody worked in it — dismantling by id, then `removed`. The same condition (stacks/inset.js neverBuilt)
    // chooses the message (stacks/remove.js) and the hint of the tool cbase_copy_stack_remove (mcp/tools/stacks.js).
    const r = await dismantleCopy({ copy, instance, journal: copyJournal(copy.id), reason: "clearAway" }, { data: opts.data });
    const report = { reason: opts.reason, automatic: opts.automatic, dismantling: r.removed, stayed: r.stayed };
    setCopyState(copy.id, "removed", { result: report });
    wakeProject(pid);
    return { state: "removed", report };
  }
  try {
    return await withProcedure(pid, instance, () => withInstanceOccupancy(pid, instance, "copy-clear-away", () => run(copy, opts)));
  } catch (e) {
    if (e?.code !== "OCCUPIED") throw e;
    const now = store.stackCopy(copy.id);
    if (now?.state === "ready") setCopyState(copy.id, "clearAway", { phase: EARMARKED });
    return { state: "earmarked", report: { occupied: text(e) } };
  }
}

export async function clearAwayCopy(copyId, { reason = "", retrieve = [], automatic = false, home = os.homedir(), system = null, data = null, root = "", addresses = null } = {}) {
  const opts = { reason: String(reason || ""), retrieve: Array.isArray(retrieve) ? retrieve : [], automatic: automatic === true, home, system, data, root, addresses };
  try {
    return await clearAway(copyId, opts);
  } catch (e) {
    const now = store.stackCopy(copyId);
    const code = codeOf(e);
    if (serverEnds()) return { state: "earmarked", report: { serverEnd: true, phase: now?.phase || "", error: text(e) } };
    // The path “never built” (stacks/inset.js neverBuilt: the row is still `error`, never `ready`) writes NO clear-away
    // section into the journal and names no layer. Otherwise wasReady would read “work was done here” from it, and ONE
    // failed dismantling (a hiccup of the daemon) would bind the chat forever to a copy without an instance row: every
    // further clear-away would take the path with fetching and end COPY_STANDS, a new attempt 409, deleting project and
    // workspace 409. The reason is in the row (the dismantling section is written by dismantling.js); the next call
    // dismantles further.
    const never = Boolean(now && neverBuilt(now));
    // COPY_STANDS never comes from step 5 itself, only from what a new attempt does before step 1 (wasAliveAgain, step 0,
    // copyRunning) — then the journal is still on the remove step, but not everything is backed up. “Bundle missing” is the
    // wording of removeStep and is recognised here, so both must carry the same text.
    const inRemove = now?.journal?.step === STEP(REMOVE) && !String(e?.message || "").startsWith("Bundle missing") && code !== "COPY_STANDS";
    const location = now && !never ? copyLocation({ data: data || DIRS.data, projectId: now.projectId, name: now.name }) : null;
    const set = never
      ? T`${text(e)}${code ? ` (${code})` : ""} — never built, there is nothing in it to back up; a new call (cbase_copy_stack_remove) dismantles the rest`
      : inRemove
        ? T`Clear-away incomplete: ${text(e)}${code ? ` (${code})` : ""}`
        : T`Backup pending: ${text(e)}${code ? ` (${code})` : ""} — the layer stays: ${location?.root.base || "?"}`;
    // The backup folder only if it exists (as in the success case).
    const report = never
      ? { reason: String(reason || ""), automatic: automatic === true, neverBuilt: true, error: set }
      : { ...(now?.journal?.data?.clearAway?.report || {}), error: set, ...(location ? { layer: location.root.base, ...(folderStands(location.backup) ? { backup: location.backup } : {}) } : {}) };
    try {
      if (now && now.state !== "removed") {
        if (!never) { try { await copyJournal(copyId).note({ clearAway: { ...(now.journal?.data?.clearAway || {}), error: set } }); } catch { /* the reason is in the row */ } }
        setCopyState(copyId, "error", { error: set.slice(0, 1600) });
      }
    } catch (x) { report.error = T`${set} — and the row was not set: ${text(x)}`; }
    return { state: "error", report };
  }
}
