// What a release knows, and the rollback lock built on it.
//
// THE PROBLEM. After the first relocation, sessions, work folders and runtime data of a converted project live under
// `data/projects/<id>/` and the runs go through the project container. A release without relocation knows nothing of that: a
// rollback to it would lose the memory of those chats ("the way back is repairing forward"). The rollback must see this
// BEFORE the swap, per B.
//
// THE TWO HALVES. (1) The release names what it knows: `backend/capabilities.json` in the release tree (source
// `server/backend/capabilities.json`, targets/server.mjs uploads it; NOT in the image — the rollback reads it over ssh like
// the Dockerfile of the target release). Content: a JSON list of words, today `["relocation", "copy", ...]`. If the file is
// MISSING the release knows NOTHING — no inference from date or name. An unreadable file knows nothing either (with a
// notice): better one lock too many than a lost memory. (2) B reports numbers: `/api/runs/active` carries `converted` (number
// of converted projects) and `relocationsOpen` (relocations in progress; the route is unauthenticated — no ids). A MISSING
// field (old backend), an unreachable backend and a stopped B (no `docker exec`) are "unknown", NEVER 0 — empty is not
// unknown.
//
// THE LOCK. If the target release knows `relocation`, nothing locks. Otherwise every B locks with `converted` > 0, every B
// with a relocation IN PROGRESS (`relocationsOpen` > 0: open journal, state `relocation`, heavy load — `converted` only
// counts from the cutover, a half relocation would stay behind under a release without relocation) and every B whose numbers
// are unknown. Two kinds (`kind`):
//   "known"    a number > 0 — NEVER overridable. The way out is named (lockSet): repair forward or go back to a release that
//              knows the relocation; a relocation in progress ends by itself (before the cutover it rolls back).
//   "unknown"  stopped, unreachable, a field missing — overridable ONLY with its own switch `--rollback-without-relocation`
//              (the operator assures that nothing is converted there and no relocation runs), with a notice per B; for the
//              number of copies `--rollback-without-copy`.
// `--force` does NOT override the lock (it already overrides the idle gate — exactly the case where a hanging relocation
// keeps `busy`). Checked BEFORE the image build, after the idle gate and per B right before its swap. No second mechanism for
// the copies: `copy` hangs on the same list and `copies` on the same answer.
//
// Pure except for nothing: every function gets text or answers and computes. The ssh part is in targets/rollback.mjs
// (rollbackLockCheck) and targets/status.mjs. Guarded by the maintainer's private suite (the computation, the source, the
// upload, the rollback as a whole over a fake ssh).
//
// COPIES. The second capability `copy` and the second answer `copies` (number of live rows in `stack_copies`, every state
// except `removed`). If the target release lacks a copy capability (`lockChecks`), the rollback asks B; every number belonging
// to a MISSING capability locks — `converted` and `relocationsOpen` for `relocation`, `copies` for `copy`. A known number
// overrides nothing, not even `--force`; an unknown one only its own switch. One capability was not enough: a release may know
// `copy` but be unable to clear a copy away and not know the move-in of a chat into a copy (it would run that chat's turns in
// the main). Hence one stage per slice: `copy-clear-away` and `copy-move-in` belong to the copy like `copy` itself
// (COPY_CAPABILITIES). If the target lacks ONE of them, every live copy (`copies` > 0) locks. A new slice with a new copy state
// or journal section appends a word here and enters it in server/backend/capabilities.json — a guard of
// the maintainer's private suite holds the states and sections from store/stack-copies.js against the list it knows.
//
// READING FROM THE VOLUME. Every rollback to a stocked release asks B — also the stopped ones (the gateway puts an idle B to
// sleep) and the silent ones. (a) Where the answer lacks the number of copies (stopped, silent, field missing), it comes from
// the DATABASE in B's home volume: a throwaway container from B's own image (`copiesReadingCommand`, no network, no
// `docker exec`, the volume READ-ONLY, `node:sqlite` with `readOnly`) counts the live rows of `stack_copies` under the SAME
// condition as `store.liveStackCopies()` (`state != 'removed'` — bound by guard (11)). A number read counts like the answer:
// > 0 "known", 0 lets pass. If the reading fails (no database, no table, a hot journal, docker) it stays unknown — with its
// reason in the sentence. For the RELOCATION nothing is read: a stopped B stays unknown. (b) Two switches instead of one:
// `--rollback-without-relocation` overrides ONLY unknown relocation numbers, `--rollback-without-copy` ONLY those of the
// copies. Every lock entry carries in `open` which number is unknown; `lockRuling` demands the matching switch for each,
// `lockSet` names exactly those needed.
//
// FURTHER AXES, each the same build (a capability word, a number from /api/runs/active, a reading from the volume where the
// answer lacks it, its own switch, never `--force`):
//   3. episodes per workspace (`episodes-per-workspace`, `episodesMultiple`, `--rollback-without-episodes`): an episode is
//      unique per (workspace, system, id); an older release builds `CREATE UNIQUE INDEX ... ON episodes(system, external_id)`
//      at start without try, fails on a duplicate id and B would not start. NOT in LOCK_CAPABILITIES: targets/rollback.mjs
//      asks both and merges the verdicts for lockRuling. Guard (15).
//   4. git-lfs in the project box (`lfs`, `--rollback-without-lfs`): a project box with git-lfs writes hooks into every repo
//      where it runs (`command -v git-lfs ... || exit 2`); without git-lfs push, checkout and `git worktree add` would break
//      there. No backend counts these repos, so the axis knows only "unknown": a target without the word locks every B, only
//      the switch overrides. Without any B nothing locks.
//   5. the layout (`layout`, `layoutsOpen`, `--rollback-without-layout`): its procedure stops containers, moves and deletes
//      folders; its journal is `project_layout`. An open rebuild would stay half done. Counted: running before and after the
//      cutover, error after the cutover, error with a failed way back; a waiting order does not lock. Guard (18). Status:
//      `layoutRow`.
//   6. stopped instances (`instance-stopped`, `projectStopped` plus `projectWork` entries in state `stop`,
//      `--rollback-without-instance-stopped`): an older release misreads `stopped` and `stop`. Guard (20).
//   8. the bridge prefix (`bridge-cbp`, `converted`, `--rollback-without-bridge-cbp`; the seventh axis left the tool):
//      in this release bridge and hostname of a project container are `cbp-<n>`, and entry.sh guards only `-i cbp-+`. An older
//      release guards the old prefix only and adopts an existing project network without looking at its bridge — every project
//      network of a converted project would stand unprotected under it. Counted: converted projects (the same number as the
//      relocation, `converted`; from the volume where the answer is silent — a stopped B is common, the gateway puts idle ones to
//      sleep). Guard (22).
import { COPY_PREFIX } from "./project-container.mjs";

/** The place in the release tree (relative to `releases/<r>/`) and the source in the repo (relative to the root). */
export const CAPABILITIES_FILE = "backend/capabilities.json";
export const CAPABILITIES_SOURCE = "server/backend/capabilities.json";
/** The capability without which a release cannot run converted projects. */
export const RELOCATION = "relocation";
/**
 * The capability without which a release does not know live copies of the stacks: their rows in `stack_copies`, containers,
 * networks, volumes and layers would stay under it without a way to clear them away, a build-up half done. Same lock, same
 * kinds, same switch (header).
 */
export const COPY = "copy";
/** Clearing a copy away. */
export const COPY_CLEAR_AWAY = "copy-clear-away";
/** Moving a chat into a copy. */
export const COPY_MOVE_IN = "copy-move-in";
/** The stages of the copy — if the target release lacks one, every live copy locks. */
export const COPY_CAPABILITIES = Object.freeze([COPY, COPY_CLEAR_AWAY, COPY_MOVE_IN]);
/** The capabilities whose absence in the target release makes the lock check run — if it knows all, nobody asks B. */
export const LOCK_CAPABILITIES = Object.freeze([RELOCATION, ...COPY_CAPABILITIES]);
/** Does the target release lack a stage of the copy? Then every live copy counts. */
export const missingCopyStage = (known) => COPY_CAPABILITIES.some((f) => !known?.has(f));
/** Must the rollback to a release with these capabilities ask B? */
export const lockChecks = (known) => LOCK_CAPABILITIES.some((f) => !known?.has(f));

/**
 * The content of `backend/capabilities.json` → `{ known: Set<string>, notice }`. Empty text (file missing) ⇒ nothing known,
 * `notice` says so; broken JSON or not a list of words ⇒ likewise nothing, with a notice.
 */
export function capabilitiesFrom(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { known: new Set(), notice: `no ${CAPABILITIES_FILE} — the release knows nothing` };
  let v;
  try { v = JSON.parse(raw); } catch (e) {
    return { known: new Set(), notice: `${CAPABILITIES_FILE} is not JSON (${e.message}) — the release knows nothing` };
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && /^[a-z][a-z0-9-]*$/.test(x))) {
    return { known: new Set(), notice: `${CAPABILITIES_FILE} is not a list of words — the release knows nothing` };
  }
  return { known: new Set(v), notice: "" };
}

/** `converted` from /api/runs/active: an integer ≥ 0, else `null` (missing, backend silent) — never 0 from lack. */
export function convertedCount(runs) {
  const n = runs?.converted;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `relocationsOpen` from /api/runs/active: like `converted` — if missing it is unknown, never 0. */
export function relocationsOpenCount(runs) {
  const n = runs?.relocationsOpen;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `copies` from /api/runs/active: the number of live copies — if missing (old backend) unknown, never 0. */
export function copiesCount(runs) {
  const n = runs?.copies;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `copiesWaiting`: of these waiting — like `copies`. */
export function copiesWaitingCount(runs) {
  const n = runs?.copiesWaiting;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The container of a copy is called `cbase-k-<projectId>-<name>` (COPY_PREFIX from lib/project-container.mjs). Project id and
// name cannot be told apart from the name alone (both may carry `-`) — hence the whole name, never a guessed cut.

/**
 * The "Copies" row for `./deploy status` per B: the number of live and waiting copies (from /api/runs/active — the route is
 * unauthenticated, it carries only numbers), the ids and states of the copies IN PROGRESS (from `projectWork`: instance
 * `copy-*`, build-up or clear-away, with heavy load) and the copy containers (`cbase-k-*` from `inner` = `innerContainers(…).all`
 * — helpers, probe and such a leftover without a row are already separated there). Unknown is a warning, not a zero; a live
 * copy is `warn` like a converted project — it locks the rollback to a release without `copy`.
 */
export function copiesRow(runs, inner = null) {
  const label = "Copies";
  const container = (Array.isArray(inner) ? inner : [])
    .filter((c) => String(c?.name || "").startsWith(COPY_PREFIX) && String(c.name).length > COPY_PREFIX.length)
    .map((c) => `${c.name}${/^up\b/i.test(String(c.status || "")) ? "" : " (stopped)"}`);
  const conText = container.length ? `; containers: ${container.join(", ")}` : "";
  if (!runs) return [label, `unknown (backend unreachable)${conText}`, "warn"];
  const n = copiesCount(runs);
  if (n === null) return [label, `unknown (backend without field \`copies\`)${conText}`, "warn"];
  if (!n) return container.length ? [label, `no live row, but containers without a row${conText}`, "warn"] : [label, "none", "ok"];
  const w = copiesWaitingCount(runs);
  const work = (Array.isArray(runs.projectWork) ? runs.projectWork : [])
    .filter((x) => String(x?.instance || "").startsWith("copy-"))
    .map((x) => `${x.projectId || "?"}/${x.instance} ${copyWorkWord(x.state)}${x.phase ? ` "${x.phase}"` : ""}`);
  const parts = [`${n} alive${w === null ? "" : `, ${w} waiting`}`];
  if (work.length) parts.push(`in progress: ${work.join(", ")}`);
  return [label, `${parts.join("; ")}${conText} — a rollback only to a release that knows the copy`, "warn"];
}

// ── The number of copies from the database in the home volume (without `docker exec`) ──────────────────────────────────
// The place of the database in B: headless.js takes `CBASE_DATA_ROOT` or `$HOME/cbase` (HOME=/home/agent in the image), the
// store puts `data/automater.db` below it (store/db.js initStore). Only under the home volume — otherwise the reader cannot see it.
export const COPIES_HOME = "/home/agent";
export const COPIES_DB_VAR = "CBASE_COPIES_DB";
const SAFE = /^[A-Za-z0-9._/-]+$/;
// How every reader program below opens the database. B keeps it in WAL mode (server/backend/electron/server/store/db.js): what
// was committed last can still be in `automater.db-wal`, and the home volume is mounted READ-ONLY here.
//   1. The plain read-only open. While B runs (or after it died) `-wal` and `-shm` exist; SQLite reads them without writing
//      (read-only shared memory) and gives a consistent snapshot, including the WAL.
//   2. Only if that fails AND there is no `-wal`: the database was closed cleanly (the last connection folded the WAL back and
//      removed it). SQLite still wants to create `-shm` for a WAL file and cannot on a read-only mount — so it is opened
//      `immutable=1` (no locks, no WAL). That is only sound while nobody writes: the size, the modification time and the absence
//      of `-wal` are taken before the open and compared before the answer — a B that started meanwhile creates `-wal`, a write
//      changes the file, and the answer becomes an error instead of a count from a torn file.
// Rejected: `immutable=1` always (it ignores the WAL of a running B and reads a file a checkpoint is rewriting); copying db, wal
// and shm into a temp folder (three copies are not one moment). No single quote (the program stands in '…' behind ssh).
const READER_OPEN = [
  'const{DatabaseSync}=require("node:sqlite");const fs=require("node:fs");',
  `const P=process.env.${COPIES_DB_VAR};`,
  'const stamp=()=>{try{const s=fs.statSync(P);return s.size+":"+s.mtimeMs+":"+fs.existsSync(P+"-wal");}catch(x){return "gone";}};',
  "let db=null,frozen=null;",
  'try{db=new DatabaseSync(P,{readOnly:true});db.prepare("SELECT count(*) AS n FROM sqlite_master").get();}',
  'catch(e){if(fs.existsSync(P+"-wal"))throw e;try{if(db)db.close();}catch(x){}frozen=stamp();db=new DatabaseSync("file:"+P+"?immutable=1",{readOnly:true});}',
  'const say=(line)=>{if(frozen!==null&&stamp()!==frozen)throw new Error("the database changed while it was read without locks");console.log(line);};',
].join("");

/** One reader program: `<tag>=<n>` from `countSql` (params as literals), `<tag>=no-table` without `table`, `<tag>=error …`. */
function readerScript(tag, table, countSql, params = []) {
  const args = params.map((x) => JSON.stringify(x)).join(",");
  return [
    "try{",
    READER_OPEN,
    `const t=db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table",${JSON.stringify(table)});`,
    `if(!t){say("${tag}=no-table");}`,
    `else{const n=db.prepare(${JSON.stringify(countSql)}).get(${args}).n;say("${tag}="+n);}`,
    "db.close();",
    `}catch(e){console.log("${tag}=error "+String(e&&e.message||e).replace(/\\s+/g," ").slice(0,200));}`,
  ].join("");
}
// The reader program (`node -e`, in the throwaway container): exactly one line `COPIES=<n>`, `COPIES=no-table` or
// `COPIES=error <message>`; it always ends with 0 (the verdict is in the line). Same condition as
// store/stack-copies.js liveStackCopies (`state != 'removed'`) — held by the maintainer's private suite. No single quote (the text
// stands in '…' behind ssh), opened read-only (`readOnly`), the location comes from the environment.
export const COPIES_SCRIPT = readerScript("COPIES", "stack_copies", "SELECT COUNT(*) AS n FROM stack_copies WHERE state != ?", ["removed"]);

/**
 * The reader of the number of copies for ONE user container from its `docker inspect`: `{ command }` (one line for ssh) or
 * `{ missing }` (no home volume, no image, data location outside the volume, unsafe characters). A throwaway container from B's
 * OWN image (the id — it exists as long as B exists; `--pull never`), without network, as root (reads every file of the volume),
 * the home volume READ-ONLY — it writes nothing, not even a journal next to the database, and needs neither `docker exec` nor a
 * running B. Guarded by the maintainer's private suite.
 */
export function copiesReadingCommand(insp) {
  return volumeReaderCommand(insp, COPIES_SCRIPT);
}

// The command of a reader in the throwaway container for ONE program (`script`, a `node -e`): copies and episodes per workspace
// — the same data location (`COPIES_DB_VAR` carries it for both), the same limits.
function volumeReaderCommand(insp, script) {
  const name = String(insp?.Name || "").replace(/^\//, "") || "?";
  const home = (insp?.Mounts || []).find((m) => m?.Destination === COPIES_HOME);
  const source = home?.Type === "volume" ? home.Name : home?.Type === "bind" ? home.Source : "";
  if (!source || !SAFE.test(source)) return { missing: `${name}: no home volume under ${COPIES_HOME}` };
  const image = String(insp?.Image || "");
  if (!/^[A-Za-z0-9._/:@-]+$/.test(image)) return { missing: `${name}: image unknown` };
  const env = (insp?.Config?.Env || []).find((e) => typeof e === "string" && e.startsWith("CBASE_DATA_ROOT="));
  const root = env ? env.slice("CBASE_DATA_ROOT=".length).replace(/\/+$/, "") : `${COPIES_HOME}/cbase`;
  if (!SAFE.test(root) || !root.startsWith(`${COPIES_HOME}/`) || root.split("/").includes("..")) {
    return { missing: `${name}: CBASE_DATA_ROOT=${root} is not safely under ${COPIES_HOME}` };
  }
  const parts = ["docker run --rm --network none --pull never", `-v ${source}:${COPIES_HOME}:ro`, "--entrypoint node", "-u 0",
    `-e ${COPIES_DB_VAR}=${root}/data/automater.db`, image, `-e '${script}'`];
  return { command: parts.join(" ") };
}

/** The output of the reader → `{ count, reason }`: `count` an integer ≥ 0 or null (then `reason` says why). */
export function copiesFromReading(stdout, stderr = "") {
  const z = String(stdout || "").split("\n").map((x) => x.trim()).find((x) => x.startsWith("COPIES="));
  if (!z) {
    const e = String(stderr || "").split("\n").map((x) => x.trim()).find(Boolean);
    return { count: null, reason: e ? `reader without answer (${e.slice(0, 160)})` : "reader without answer" };
  }
  const value = z.slice("COPIES=".length);
  if (/^\d+$/.test(value)) return { count: Number(value), reason: "" };
  if (value === "no-table") return { count: null, reason: "database without table `stack_copies`" };
  return { count: null, reason: value.startsWith("error ") ? `database unreadable (${value.slice("error ".length)})` : `unreadable answer (${value.slice(0, 80)})` };
}

const readingCount = (l) => (Number.isInteger(l?.count) && l.count >= 0 ? l.count : null);

// ── Episodes per workspace (header, third axis) ──────────────────────────────────────────────────────────────────────
/** The capability of a release to keep episodes per workspace — without it the release does not start at a duplicate id. */
export const EPISODES_PER_WS = "episodes-per-workspace";
/** Must the rollback to a release with these capabilities ask B for the episodes? */
export const episodesChecks = (known) => !known?.has(EPISODES_PER_WS);
/** The own switch that overrides ONLY an unknown number of episodes (deploy.mjs; never `--force`). */
export const WITHOUT_EPISODES_TOGGLE = "--rollback-without-episodes";

/** `episodesMultiple` from /api/runs/active: an integer ≥ 0, else `null` (missing — old backend —, backend silent), never 0. */
export function episodesMultipleCount(runs) {
  const n = runs?.episodesMultiple;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The reader program: exactly one line `EPISODES=<n>`, `EPISODES=no-table` or `EPISODES=error <message>`. Same condition as
// the backend's runs/episodes-count.js episodesMultiple (guard (15)). No single quote, read-only.
export const EPISODES_SCRIPT = readerScript("EPISODES", "episodes", "SELECT COUNT(*) AS n FROM (SELECT 1 FROM episodes GROUP BY system, external_id HAVING COUNT(*) > 1)");

/** The reader of the episode number for ONE user container — like copiesReadingCommand, only another program. */
export const episodesReadingCommand = (insp) => volumeReaderCommand(insp, EPISODES_SCRIPT);

/**
 * The output of the reader → `{ count, reason }`. A database WITHOUT table `episodes` has no episode and so no duplicate id —
 * that is a 0, not ignorance (unlike the copies: the target release creates the table empty, and its index finds nothing). A
 * database that cannot be opened stays unknown.
 */
export function episodesFromReading(stdout, stderr = "") {
  const z = String(stdout || "").split("\n").map((x) => x.trim()).find((x) => x.startsWith("EPISODES="));
  if (!z) {
    const e = String(stderr || "").split("\n").map((x) => x.trim()).find(Boolean);
    return { count: null, reason: e ? `reader without answer (${e.slice(0, 160)})` : "reader without answer" };
  }
  const value = z.slice("EPISODES=".length);
  if (/^\d+$/.test(value)) return { count: Number(value), reason: "" };
  if (value === "no-table") return { count: 0, reason: "" };
  return { count: null, reason: value.startsWith("error ") ? `database unreadable (${value.slice("error ".length)})` : `unreadable answer (${value.slice(0, 80)})` };
}

/**
 * The lock of the third axis. `known` as in rollbackLock; `bs` per B `{ name, runs, stopped, episodesReading }`
 * (`episodesReading` the result of episodesFromReading — it counts only where the answer carries no number). → `{ locks, rows }`
 * in the same form as rollbackLock; an unknown entry carries `open: [EPISODES_PER_WS]` (its switch in lockRuling). If the
 * target knows the capability nothing locks, and `bs` may be empty.
 */
export function episodesLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock episodes";
  if (!episodesChecks(known)) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows episodes per workspace — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    const short = `${label} (${String(b.name).slice(0, 26)}…)`;
    let n = !b.stopped && b.runs ? episodesMultipleCount(b.runs) : null;
    const read = n === null ? readingCount(b.episodesReading) : null;
    if (read !== null) n = read;
    const fromVolume = read !== null ? " (from the database in the volume)" : "";
    if (n === 0) { rows.push([short, `no source id in two workspaces${fromVolume}`, "ok"]); continue; }
    let reason;
    let kind;
    if (n > 0) {
      reason = `${n} source id(s) with episodes in more than one workspace${fromVolume}`;
      kind = "known";
    } else {
      const reading = b.episodesReading?.reason ? `; episodes unreadable from the volume: ${b.episodesReading.reason}` : "";
      reason = (b.stopped
        ? "stopped — whether it has a source id in two workspaces cannot be asked without `docker exec`"
        : !b.runs
          ? "backend unreachable — number of source ids in two workspaces unknown"
          : "backend without field `episodesMultiple` — number of source ids in two workspaces unknown") + reading;
      kind = "unknown";
    }
    locks.push({ name: b.name, reason, kind, open: kind === "unknown" ? [EPISODES_PER_WS] : [] });
    rows.push([short, reason, "bad"]);
  }
  return { locks, rows };
}

/** The sentence with which the rollback refuses at the third axis — with the named way out (like lockSet). */
export function episodesLockSentence(locks, target) {
  const wayOut = locks.some((s) => s.kind === "known")
    ? `Way out: repair forward, go back to a release that knows episodes per workspace (${CAPABILITIES_FILE} with "${EPISODES_PER_WS}"), ` +
      `or discard the duplicate episode in one of the workspaces and remove it for good; no switch overrides a known number, not even --force and ${WITHOUT_EPISODES_TOGGLE}`
    : `Way out: make B reachable and try again, or ${WITHOUT_EPISODES_TOGGLE} (you assure that ${TOGGLE[EPISODES_PER_WS].assured}) — --force does not override the lock`;
  return `Target release ${target} does not know episodes per workspace (${CAPABILITIES_FILE}), but ${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — ` +
    `its start builds the index ux_episodes_ext uniquely over (system, external_id), fails on any such id, and B would not start. ${wayOut}`;
}

// ── git-lfs in the project box (header, fourth axis) ─────────────────────────────────────────────────────────────────
/** The capability of a release whose project box carries git-lfs — without it the git-lfs hooks would break. */
export const LFS = "lfs";
/** Does the rollback to a release with these capabilities lock at the fourth axis (every B, unknown)? */
export const lfsChecks = (known) => !known?.has(LFS);
/** The own switch that overrides ONLY the fourth axis (deploy.mjs; never `--force`). */
export const WITHOUT_LFS_TOGGLE = "--rollback-without-lfs";
/** The reason per B — there is no number, only this ignorance. */
export const LFS_REASON = "whether a repo of its project containers carries git-lfs hooks is unknown (cbase does not count them)";

/**
 * The lock of the fourth axis. `known` as in rollbackLock; `bs` per B `{ name }` (nothing else is read — there is no number).
 * → `{ locks, rows }` in the same form as rollbackLock: if the target release lacks `lfs`, one "unknown" entry per B with
 * `open: [LFS]` (its switch in lockRuling). If the target knows the capability nothing locks, and `bs` may be empty.
 */
export function lfsLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock LFS";
  if (!lfsChecks(known)) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows git-lfs in the project box — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    locks.push({ name: b.name, reason: LFS_REASON, kind: "unknown", open: [LFS] });
    rows.push([`${label} (${String(b.name).slice(0, 26)}…)`, LFS_REASON, "bad"]);
  }
  return { locks, rows };
}

/** The sentence with which the rollback refuses at the fourth axis — with the named way out (like lockSet). */
export function lfsLockSentence(locks, target) {
  return `Target release ${target} does not know git-lfs in the project box (${CAPABILITIES_FILE} without "${LFS}"), but ` +
    `${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — git-lfs creates the hooks pre-push, ` +
    "post-checkout, post-commit and post-merge in every repo where it ran (`command -v git-lfs … || exit 2`); under a project box without git-lfs " +
    "push, checkout and `git worktree add` (workflows, isolated agents) would then break in these repos. Way out: repair forward, " +
    `go back to a release that knows "${LFS}", or ${WITHOUT_LFS_TOGGLE} (you assure that ${TOGGLE[LFS].assured}) — ` +
    "--force does not override the lock";
}

// ── The layout (header, fifth axis) ──────────────────────────────────────────────────────────────────────────────────
/** The capability of a release to run and continue a layout. */
export const LAYOUT = "layout";
/** Must the rollback to a release with these capabilities ask B for the layouts? */
export const layoutChecks = (known) => !known?.has(LAYOUT);
/** The own switch that overrides ONLY an unknown number of layouts (deploy.mjs; never `--force`). */
export const WITHOUT_LAYOUT_TOGGLE = "--rollback-without-layout";

/** `layoutsOpen` from /api/runs/active: an integer ≥ 0, else `null` (missing — old backend —, count failed). */
export function layoutsOpenCount(runs) {
  const n = runs?.layoutsOpen;
  return Number.isInteger(n) && n >= 0 ? n : null;
}
/** `layoutsWaiting` (only the status row) — like layoutsOpenCount. */
export function layoutsWaitingCount(runs) {
  const n = runs?.layoutsWaiting;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The reader program: exactly one line `LAYOUT=<n>`, `LAYOUT=no-table` or `LAYOUT=error <message>`.
// Same condition as store/project-layout.js layoutsOpenCount (guard (18)). No single quote (the values go as parameters),
// read-only.
export const LAYOUT_SCRIPT = readerScript("LAYOUT", "project_layout", "SELECT count(*) AS n FROM project_layout WHERE state = ? OR (state = ? AND (turned = 1 OR backward = 1))", ["running", "error"]);

/** The reader of the layout number for ONE user container — like copiesReadingCommand, only another program. */
export const layoutReadingCommand = (insp) => volumeReaderCommand(insp, LAYOUT_SCRIPT);

/**
 * The output of the reader → `{ count, reason }`. A database WITHOUT table `project_layout` never ran a layout — a 0 (like the
 * episodes). A database that cannot be opened stays unknown.
 */
export function layoutFromReading(stdout, stderr = "") {
  const z = String(stdout || "").split("\n").map((x) => x.trim()).find((x) => x.startsWith("LAYOUT="));
  if (!z) {
    const e = String(stderr || "").split("\n").map((x) => x.trim()).find(Boolean);
    return { count: null, reason: e ? `reader without answer (${e.slice(0, 160)})` : "reader without answer" };
  }
  const value = z.slice("LAYOUT=".length);
  if (/^\d+$/.test(value)) return { count: Number(value), reason: "" };
  if (value === "no-table") return { count: 0, reason: "" };
  return { count: null, reason: value.startsWith("error ") ? `database unreadable (${value.slice("error ".length)})` : `unreadable answer (${value.slice(0, 80)})` };
}

/**
 * The lock of the fifth axis — the form of episodesLock: `bs` per B `{ name, runs, stopped, layoutReading }`. An unknown entry
 * carries `open: [LAYOUT]` (its switch in lockRuling). If the target knows the capability nothing locks.
 */
export function layoutLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock layout";
  if (!layoutChecks(known)) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows the layout — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    const short = `${label} (${String(b.name).slice(0, 26)}…)`;
    let n = !b.stopped && b.runs ? layoutsOpenCount(b.runs) : null;
    const read = n === null ? readingCount(b.layoutReading) : null;
    if (read !== null) n = read;
    const fromVolume = read !== null ? " (from the database in the volume)" : "";
    if (n === 0) { rows.push([short, `no layout under rebuild${fromVolume}`, "ok"]); continue; }
    let reason;
    let kind;
    if (n > 0) {
      reason = `${n} layout(s) under rebuild${fromVolume}`;
      kind = "known";
    } else {
      const reading = b.layoutReading?.reason ? `; layouts unreadable from the volume: ${b.layoutReading.reason}` : "";
      reason = (b.stopped
        ? "stopped — whether a layout is under rebuild there cannot be asked without `docker exec`"
        : !b.runs
          ? "backend unreachable — number of layouts under rebuild unknown"
          : "backend without field `layoutsOpen` — number of layouts under rebuild unknown") + reading;
      kind = "unknown";
    }
    locks.push({ name: b.name, reason, kind, open: kind === "unknown" ? [LAYOUT] : [] });
    rows.push([short, reason, "bad"]);
  }
  return { locks, rows };
}

/** The sentence with which the rollback refuses at the fifth axis — with the named way out. */
export function layoutLockSentence(locks, target) {
  const wayOut = locks.some((s) => s.kind === "known")
    ? `Way out: let the rebuild finish (before the cutover it rolls back by itself, after an error "Retry"), go back to a release that knows the layout (${CAPABILITIES_FILE} with "${LAYOUT}"), ` +
      `or repair forward; no switch overrides a known number, not even --force and ${WITHOUT_LAYOUT_TOGGLE}`
    : `Way out: make B reachable and try again, or ${WITHOUT_LAYOUT_TOGGLE} (you assure that ${TOGGLE[LAYOUT].assured}) — --force does not override the lock`;
  return `Target release ${target} does not know the layout (${CAPABILITIES_FILE}), but ${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — ` +
    `it knows neither the journal nor the lock of the rebuild: stopped containers and services would stay off, a half-rebuilt folder half, and nobody would continue. ${wayOut}`;
}

/** The "Layouts" row for `./deploy status` per B: waiting and under rebuild (running, open after the cutover or with an open way back). */
export function layoutRow(runs) {
  const label = "Layouts";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  const n = layoutsOpenCount(runs);
  const w = layoutsWaitingCount(runs);
  if (n === null) return [label, "unknown (backend without field `layoutsOpen`)", "warn"];
  if (!n && !w) return [label, "none", "ok"];
  return [label, `${w ?? "?"} waiting, ${n} open under rebuild (running, after the cutover or with a failed way back)${n ? " — no rollback to a release without layout until the rebuild is done" : ""}`, n ? "warn" : "ok"];
}

// ── Stopped instances (header, sixth axis) ───────────────────────────────────────────────────────────────────────────
/** The capability of a release to know stopped instances, start them and continue a half stop. */
export const INSTANCE_STOPPED = "instance-stopped";
/** Must the rollback to a release with these capabilities ask B for stopped instances? */
export const instanceStoppedChecks = (known) => !known?.has(INSTANCE_STOPPED);
/** The own switch that overrides ONLY an unknown number of stopped instances (deploy.mjs; never `--force`). */
export const WITHOUT_INSTANCE_STOPPED_TOGGLE = "--rollback-without-instance-stopped";

/**
 * The number from /api/runs/active: `projectStopped` (converted rows in `stopped`) plus the entries in `projectWork` with
 * `state: "stop"`. If one of the two fields is missing (old backend) or is not a number/list, `null` — "unknown", never 0.
 */
export function instancesStoppedCount(runs) {
  const g = runs?.projectStopped;
  if (!Number.isInteger(g) || g < 0 || !Array.isArray(runs?.projectWork)) return null;
  return g + runs.projectWork.filter((x) => x?.state === "stop").length;
}

// The reader program: exactly one line `STOPPED=<n>`, `STOPPED=no-table` or `STOPPED=error <message>`. Same condition as
// the answer (runs/routes.js: `projectStopped` = stopped with `converted_at`, plus every row in `stop` from `projectWork`;
// guard (20)). No single quote (the values go as parameters), read-only.
export const INSTANCE_STOPPED_SCRIPT = readerScript("STOPPED", "project_instances", "SELECT count(*) AS n FROM project_instances WHERE (state = ? AND converted_at IS NOT NULL) OR state = ?", ["stopped", "stop"]);

/** The reader of the number of stopped instances for ONE user container — like copiesReadingCommand, only another program. */
export const instanceStoppedReadingCommand = (insp) => volumeReaderCommand(insp, INSTANCE_STOPPED_SCRIPT);

/**
 * The output of the reader → `{ count, reason }`. A database WITHOUT table `project_instances` never had an instance — a 0. A
 * database that cannot be opened stays unknown.
 */
export function instanceStoppedFromReading(stdout, stderr = "") {
  const z = String(stdout || "").split("\n").map((x) => x.trim()).find((x) => x.startsWith("STOPPED="));
  if (!z) {
    const e = String(stderr || "").split("\n").map((x) => x.trim()).find(Boolean);
    return { count: null, reason: e ? `reader without answer (${e.slice(0, 160)})` : "reader without answer" };
  }
  const value = z.slice("STOPPED=".length);
  if (/^\d+$/.test(value)) return { count: Number(value), reason: "" };
  if (value === "no-table") return { count: 0, reason: "" };
  return { count: null, reason: value.startsWith("error ") ? `database unreadable (${value.slice("error ".length)})` : `unreadable answer (${value.slice(0, 80)})` };
}

/**
 * The lock of the sixth axis — the form of layoutLock: `bs` per B `{ name, runs, stopped, instanceStoppedReading }`. An unknown
 * entry carries `open: [INSTANCE_STOPPED]` (its switch in lockRuling). If the target knows the capability nothing locks.
 */
export function instanceStoppedLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock stopped instances";
  if (!instanceStoppedChecks(known)) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows stopped instances — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    const short = `${label} (${String(b.name).slice(0, 26)}…)`;
    let n = !b.stopped && b.runs ? instancesStoppedCount(b.runs) : null;
    const read = n === null ? readingCount(b.instanceStoppedReading) : null;
    if (read !== null) n = read;
    const fromVolume = read !== null ? " (from the database in the volume)" : "";
    if (n === 0) { rows.push([short, `no instance stopped or stopping${fromVolume}`, "ok"]); continue; }
    let reason;
    let kind;
    if (n > 0) {
      reason = `${n} instance(s) stopped or stopping${fromVolume}`;
      kind = "known";
    } else {
      const reading = b.instanceStoppedReading?.reason ? `; stopped instances unreadable from the volume: ${b.instanceStoppedReading.reason}` : "";
      reason = (b.stopped
        ? "stopped — whether an instance is stopped there cannot be asked without `docker exec`"
        : !b.runs
          ? "backend unreachable — number of stopped instances unknown"
          : "backend without field `projectStopped` or `projectWork` — number of stopped instances unknown") + reading;
      kind = "unknown";
    }
    locks.push({ name: b.name, reason, kind, open: kind === "unknown" ? [INSTANCE_STOPPED] : [] });
    rows.push([short, reason, "bad"]);
  }
  return { locks, rows };
}

/** The sentence with which the rollback refuses at the sixth axis — with the named way out. */
export function instanceStoppedLockSentence(locks, target) {
  const wayOut = locks.some((s) => s.kind === "known")
    ? `Way out: start the stopped instances first (tab "Instances" → Start; a stop in progress ends by itself), go back to a release that knows them (${CAPABILITIES_FILE} with "${INSTANCE_STOPPED}"), ` +
      `or repair forward; no switch overrides a known number, not even --force and ${WITHOUT_INSTANCE_STOPPED_TOGGLE}`
    : `Way out: make B reachable and try again, or ${WITHOUT_INSTANCE_STOPPED_TOGGLE} (you assure that ${TOGGLE[INSTANCE_STOPPED].assured}) — --force does not override the lock`;
  return `Target release ${target} does not know stopped instances (${CAPABILITIES_FILE}), but ${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — ` +
    `it misreads \`stopped\` and \`stop\`: every turn there would run against a standing container, a half stop would stay forever, and there is no way to start there. ${wayOut}`;
}

// ── The bridge prefix (header, eighth axis) ──────────────────────────────────────────────────────────────────────────
/** The capability of a release whose project networks carry the bridge `cbp-<n>` and whose entry.sh guards `-i cbp-+`. */
export const BRIDGE_CBP = "bridge-cbp";
/** Must the rollback to a release with these capabilities ask B for converted projects at the eighth axis? */
export const bridgeChecks = (known) => !known?.has(BRIDGE_CBP);
/** The own switch that overrides ONLY an unknown number at the eighth axis (deploy.mjs; never `--force`). */
export const WITHOUT_BRIDGE_TOGGLE = "--rollback-without-bridge-cbp";

// The reader program: exactly one line `CONVERTED=<n>`, `CONVERTED=no-table` or `CONVERTED=error <message>`. Same condition as
// the answer (runs/routes.js `converted`: distinct projects with an instance row carrying `converted_at`; guard (22)). No single
// quote, read-only.
export const BRIDGE_SCRIPT = readerScript("CONVERTED", "project_instances", "SELECT count(DISTINCT project_id) AS n FROM project_instances WHERE converted_at IS NOT NULL");

/** The reader of the number of converted projects for ONE user container — like copiesReadingCommand, only another program. */
export const bridgeReadingCommand = (insp) => volumeReaderCommand(insp, BRIDGE_SCRIPT);

/** The output of the reader → `{ count, reason }`. Without table `project_instances` nothing was ever converted — a 0. */
export function bridgeFromReading(stdout, stderr = "") {
  const z = String(stdout || "").split("\n").map((x) => x.trim()).find((x) => x.startsWith("CONVERTED="));
  if (!z) {
    const e = String(stderr || "").split("\n").map((x) => x.trim()).find(Boolean);
    return { count: null, reason: e ? `reader without answer (${e.slice(0, 160)})` : "reader without answer" };
  }
  const value = z.slice("CONVERTED=".length);
  if (/^\d+$/.test(value)) return { count: Number(value), reason: "" };
  if (value === "no-table") return { count: 0, reason: "" };
  return { count: null, reason: value.startsWith("error ") ? `database unreadable (${value.slice("error ".length)})` : `unreadable answer (${value.slice(0, 80)})` };
}

/**
 * The lock of the eighth axis — the form of instanceStoppedLock: `bs` per B `{ name, runs, stopped, bridgeReading }`. `converted`
 * of the answer, else the reading from the volume. An unknown entry carries `open: [BRIDGE_CBP]` (its switch in lockRuling). If the
 * target knows the capability nothing locks.
 */
export function bridgeLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock bridge prefix";
  if (!bridgeChecks(known)) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows the bridge prefix cbp- — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    const short = `${label} (${String(b.name).slice(0, 26)}…)`;
    let n = !b.stopped && b.runs ? convertedCount(b.runs) : null;
    const read = n === null ? readingCount(b.bridgeReading) : null;
    if (read !== null) n = read;
    const fromVolume = read !== null ? " (from the database in the volume)" : "";
    if (n === 0) { rows.push([short, `no converted project${fromVolume}`, "ok"]); continue; }
    let reason;
    let kind;
    if (n > 0) {
      reason = `${n} converted project(s)${fromVolume}`;
      kind = "known";
    } else {
      const reading = b.bridgeReading?.reason ? `; converted projects unreadable from the volume: ${b.bridgeReading.reason}` : "";
      reason = (b.stopped
        ? "stopped — whether a project is converted there cannot be asked without `docker exec`"
        : !b.runs
          ? "backend unreachable — number of converted projects unknown"
          : "backend without field `converted` — number of converted projects unknown") + reading;
      kind = "unknown";
    }
    locks.push({ name: b.name, reason, kind, open: kind === "unknown" ? [BRIDGE_CBP] : [] });
    rows.push([short, reason, "bad"]);
  }
  return { locks, rows };
}

/** The sentence with which the rollback refuses at the eighth axis — with the named way out. */
export function bridgeLockSentence(locks, target) {
  const wayOut = locks.some((s) => s.kind === "known")
    ? `Way out: repair forward, or go back to a release that knows it (${CAPABILITIES_FILE} with "${BRIDGE_CBP}"); no switch overrides a known number, ` +
      `not even --force and ${WITHOUT_BRIDGE_TOGGLE}`
    : `Way out: make B reachable and try again, or ${WITHOUT_BRIDGE_TOGGLE} (you assure that ${TOGGLE[BRIDGE_CBP].assured}) — --force does not override the lock`;
  return `Target release ${target} does not know the bridge prefix cbp- (${CAPABILITIES_FILE} without "${BRIDGE_CBP}"), but ${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — ` +
    `its entry.sh guards only the old bridges, and it adopts the project networks \`cbp-<n>\` without looking at their bridge: every project container would stand open to B and its neighbours. ${wayOut}`;
}

// What an instance row of a copy in `projectWork` means: `create` is the whole build-up, `clearAway` the clearing away,
// `heavyLoad` the volume clone. The status row "Project instances" in gates.mjs shows the words too.
export const copyWorkWord = (state) => ({ create: "build-up", clearAway: "clearing away", heavyLoad: "heavy load" })[state] || String(state || "?");

/** The "Relocations in progress" row for `./deploy status` per B. */
export function relocationsOpenRow(runs) {
  const label = "Relocations in progress";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  const n = relocationsOpenCount(runs);
  if (n === null) return [label, "unknown (backend without field `relocationsOpen`)", "warn"];
  return [label, n ? `${n} — no rollback to a release without relocation until it is done` : "none", n ? "warn" : "ok"];
}

/** The "Converted projects" row for `./deploy status` per B. Unknown is a warning, not a zero. */
export function convertedRow(runs) {
  const label = "Converted projects";
  if (!runs) return [label, "unknown (backend unreachable)", "warn"];
  const n = convertedCount(runs);
  if (n === null) return [label, "unknown (backend without field `converted`)", "warn"];
  return [label, n ? `${n} — a rollback only to a release that knows the relocation` : "none", n ? "warn" : "ok"];
}

/**
 * The lock. `known` from the capabilities of the TARGET release; `bs` per B `{ name, runs, stopped, copiesReading }` (`runs` the
 * answer of /api/runs/active or null; a stopped B is not asked — an old answer does not count; `copiesReading` the result of
 * copiesFromReading: the number of copies from the database in the volume, it counts only where the answer carries none).
 * → `{ locks: [{ name, reason, kind, open }], rows }` (rows in the format of log.table; `kind` "known" | "unknown", see header;
 * `open` the unknown numbers as capability — `relocation` and/or `copy` — by which lockRuling picks the switch). Only the numbers
 * of a MISSING capability are checked (`converted`/`relocationsOpen` for `relocation`, `copies` for every stage of the copy);
 * if the target knows all, nothing locks, and `bs` may be empty (nobody has to ask).
 */
export function rollbackLock({ known, bs = [], target = "" }) {
  const label = "Rollback lock";
  const relocation = !known?.has(RELOCATION);
  const copy = missingCopyStage(known); // every stage of the copy, not just the word `copy`
  if (!relocation && !copy) return { locks: [], rows: [[label, `Target${target ? ` ${target}` : ""} knows the relocation and the copy — no lock`, "ok"]] };
  const locks = [];
  const rows = [];
  for (const b of bs) {
    const short = `${label} (${String(b.name).slice(0, 26)}…)`;
    const ask = !b.stopped && Boolean(b.runs);
    const n = relocation && ask ? convertedCount(b.runs) : null;
    const u = relocation && ask ? relocationsOpenCount(b.runs) : null;
    let k = copy && ask ? copiesCount(b.runs) : null;
    // If the answer carries no number of copies (stopped, silent, field missing), the one from the database in the volume counts.
    const read = copy && k === null ? readingCount(b.copiesReading) : null;
    if (read !== null) k = read;
    const fromVolume = read !== null ? " (from the database in the volume)" : "";
    const readingReason = copy && k === null && b.copiesReading?.reason ? `; copies unreadable from the volume: ${b.copiesReading.reason}` : "";
    const reasons = [];
    const open = [];
    let kind = "";
    // Known first: a real number > 0 locks even if another field is missing (then the reason names both).
    if (n > 0) reasons.push(`${n} converted project(s)`);
    if (u > 0) reasons.push(`${u} relocation(s) in progress`);
    if (k > 0) reasons.push(`${k} live copy/copies${fromVolume}`);
    if (reasons.length) kind = "known";
    if (b.stopped || !b.runs) {
      if (relocation) open.push(RELOCATION);
      if (copy && k === null) open.push(COPY);
      const wasQuestions = [relocation && "converted projects or a relocation", copy && k === null && "live copies"].filter(Boolean).join(" or ");
      const whichCounts = relocation && copy && k === null ? "converted projects, relocations and copies" : relocation ? "converted projects and relocations" : "copies";
      if (open.length) {
        reasons.push(b.stopped
          ? `stopped — whether it has ${wasQuestions} cannot be asked without \`docker exec\`${readingReason}`
          : `backend unreachable — number of ${whichCounts} unknown${readingReason}`);
      }
    } else {
      if (relocation && n === null) reasons.push("backend without field `converted` — number unknown");
      if (relocation && u === null) reasons.push("backend without field `relocationsOpen` — number of relocations unknown");
      if (relocation && (n === null || u === null)) open.push(RELOCATION);
      if (copy && k === null) { reasons.push(`backend without field \`copies\` — number of copies unknown${readingReason}`); open.push(COPY); }
    }
    if (reasons.length && !kind) kind = "unknown";
    if (reasons.length) {
      const reason = reasons.join("; ");
      locks.push({ name: b.name, reason, kind, open });
      rows.push([short, reason, "bad"]);
    } else rows.push([short, [relocation && "no converted projects, no relocation in progress", copy && `no copy${fromVolume}`].filter(Boolean).join(", "), "ok"]);
  }
  return { locks, rows };
}

/** The own switch that overrides ONLY unknown numbers of the RELOCATION (deploy.mjs; never `--force`). */
export const WITHOUT_RELOCATION_TOGGLE = "--rollback-without-relocation";
/** The switch that overrides ONLY an unknown number of COPIES (deploy.mjs; never `--force`). */
export const WITHOUT_COPY_TOGGLE = "--rollback-without-copy";
// What each switch assures — the sentence names exactly those the unknown numbers need.
const TOGGLE = Object.freeze({
  [RELOCATION]: { toggle: WITHOUT_RELOCATION_TOGGLE, assured: "no project is converted and no relocation runs" },
  [COPY]: { toggle: WITHOUT_COPY_TOGGLE, assured: "no copy lives" },
  // The third axis (episodesLock) — only its switch overrides an unknown number of episodes.
  [EPISODES_PER_WS]: { toggle: WITHOUT_EPISODES_TOGGLE, assured: "no source id lies in two workspaces" },
  // The fourth axis (lfsLock) — only its switch overrides it; there is no number there.
  [LFS]: {
    toggle: WITHOUT_LFS_TOGGLE,
    assured: "no repo of a project container carries git-lfs hooks or the target release already has git-lfs in the project box",
  },
  // The fifth axis (layoutLock) — only its switch overrides an unknown number of layouts.
  [LAYOUT]: { toggle: WITHOUT_LAYOUT_TOGGLE, assured: "no layout is under rebuild" },
  // The sixth axis (instanceStoppedLock) — only its switch overrides an unknown number.
  [INSTANCE_STOPPED]: { toggle: WITHOUT_INSTANCE_STOPPED_TOGGLE, assured: "no instance is stopped and none is being stopped right now" },
  // The eighth axis (bridgeLock) — only its switch overrides an unknown number.
  [BRIDGE_CBP]: { toggle: WITHOUT_BRIDGE_TOGGLE, assured: "no project is converted there" },
});
// The unknown numbers of all entries (`open`); an entry without `open` (built by hand) counts by the missing capabilities of
// the target.
function openCounts(locks, missingRelocation, missingCopy) {
  const o = new Set();
  for (const s of locks) {
    if (Array.isArray(s.open) && s.open.length) for (const f of s.open) o.add(f);
    else { if (missingRelocation) o.add(RELOCATION); if (missingCopy) o.add(COPY); }
  }
  return [RELOCATION, COPY].filter((f) => o.has(f));
}

/**
 * The sentence with which the rollback refuses (or warns under the switch) — with the named way out. `known` (the capabilities
 * of the target release) picks the words; without it both are missing (a release before the relocation).
 */
export function lockSet(locks, target, known = null) {
  const missing = LOCK_CAPABILITIES.filter((f) => !known?.has(f));
  const missingRelocation = missing.includes(RELOCATION);
  const missingCopy = COPY_CAPABILITIES.some((f) => missing.includes(f));
  const countKnown = locks.some((s) => s.kind === "known");
  // If the target knows the copy but not a later stage, the sentence names exactly that.
  const copyWord = missing.includes(COPY)
    ? "the copy"
    : [missing.includes(COPY_CLEAR_AWAY) && "the clearing away of the copy", missing.includes(COPY_MOVE_IN) && "the move-in to the copy"].filter(Boolean).join(" and ");
  const knows = [missingRelocation && "the relocation", missingCopy && copyWord].filter(Boolean).join(" and ");
  const words = missing.map((f) => `"${f}"`);
  const including = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words.join("");
  // One switch per unknown number — `--rollback-without-relocation` assures nothing about copies and vice versa.
  const needed = openCounts(locks, missingRelocation, missingCopy).map((f) => `${TOGGLE[f].toggle} (you assure that ${TOGGLE[f].assured})`);
  const wayOut = countKnown
    ? `Way out: repair forward or go back to a release that knows ${knows} (${CAPABILITIES_FILE} with ${including}); ` +
      (missingRelocation ? "a relocation in progress ends by itself (before the cutover it rolls back, afterwards the project counts as converted); " : "") +
      (missingCopy ? "clear a copy away first (until `removed`); " : "") +
      `no switch overrides a known number, not even --force, ${WITHOUT_RELOCATION_TOGGLE} and ${WITHOUT_COPY_TOGGLE}`
    : `Way out: make B reachable and try again, or ${needed.join(" and ")} — --force does not override the lock`;
  const followUps = [
    missingRelocation && "would lose sessions and runtime folders of the converted projects and leave a half relocation standing",
    missingCopy && "would leave live copies (row, container, network, volume, layer) without a way to clear them away and a build-up half standing",
    missing.includes(COPY_MOVE_IN) && "would run the turns of a chat moved into a copy in the main",
  ].filter(Boolean).join(", ");
  return `Target release ${target} does not know ${missingRelocation ? "the relocation" : copyWord} (${CAPABILITIES_FILE}), but ` +
    `${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")} — a rollback there ${followUps}. ${wayOut}`;
}

/**
 * What the rollback does with the verdict: `{ further, warning }`. Locked without a switch ⇒ `further` false; further ONLY if
 * every reason is "unknown" AND for every unknown number (`open`) its switch is set — `withoutRelocation` for `relocation`,
 * `withoutCopy` for `copy`, `withoutEpisodes` for `episodes-per-workspace`, `withoutLfs` for `lfs`, `withoutLayout` for `layout`,
 * `withoutInstanceStopped` for `instance-stopped`, `withoutBridge` for `bridge-cbp` —, then with a warning. An entry without `open` (built by hand) demands the
 * relocation switch. `--force` does not occur here.
 */
export function lockRuling(verdict, { withoutRelocation = false, withoutCopy = false, withoutEpisodes = false, withoutLfs = false, withoutLayout = false, withoutInstanceStopped = false, withoutBridge = false } = {}) {
  const locks = verdict?.locks || [];
  if (!locks.length) return { further: true, warning: "" };
  const set = { [RELOCATION]: withoutRelocation, [COPY]: withoutCopy, [EPISODES_PER_WS]: withoutEpisodes, [LFS]: withoutLfs, [LAYOUT]: withoutLayout, [INSTANCE_STOPPED]: withoutInstanceStopped, [BRIDGE_CBP]: withoutBridge };
  const needs = (s) => (Array.isArray(s.open) && s.open.length ? s.open : [RELOCATION]);
  if (locks.every((s) => s.kind === "unknown" && needs(s).every((f) => set[f]))) {
    const used = [RELOCATION, COPY, EPISODES_PER_WS, LFS, LAYOUT, INSTANCE_STOPPED, BRIDGE_CBP].filter((f) => locks.some((s) => needs(s).includes(f))).map((f) => TOGGLE[f].toggle);
    const word = locks.every((s) => s.kind === "unknown") ? "unknown numbers overridden" : "lock overridden";
    return { further: true, warning: `${used.join(" and ")}: ${word} — ${locks.map((s) => `${s.name}: ${s.reason}`).join("; ")}` };
  }
  return { further: false, warning: "" };
}
