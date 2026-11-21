// The tool result of creating a copy. Afterwards the agent knows what it has, what is missing and what stays real. Called by
// the build (stacks/creation.js) in the step `ready`; the result is stored in `stack_copies.result`, and
// `GET /api/projects/:pid/stack-copies[/:name]` returns it (stacks/routes.js).
//
// collectResult({ copy, project, instance, containerId, code, desired, services, data })  → Promise<result>
//   copy         the row from `stack_copies` ({ id, projectId, name, chatId, base })
//   project      the project ({ id, name, path }) — `path` is the same in the copy (clone at the original path)
//   instance     the copy's instance row (`project_instances`, `copy-<name>`: dnsName, ip, containerId)
//   containerId  the copy container (default: `instance.containerId`, otherwise its name from projectbox/run-instance.js)
//   code         what stacks/code-snapshot.js returned — the summary OR the snapshot itself. If `head` is missing per repo
//                (the summary carries only counts), collectResult reads `snapshot.json` from the copy's location (never
//                through a symlink, with a cap) — `preparation` is kept. `code.preparation` (the build passes on the result
//                of stacks/prepare.js: per repo `base` = the id the copy stands on | null | "empty", plus `applied`) says which
//                `base` APPLIED where — without it only knowsBase guesses from ref names
//   desired      the desired state from the freeze (stacks/freeze.js: `{ container, services }`, `services` = ids of the
//                native services that ran in main)
//   services     optional: the services as the start of the copy left them (stacks/start.js `services`: the inner containers
//                with `kind: "container"` and the native ones with `kind: "native"`, each { name, port?, state }). NATIVE is
//                only what carries `kind: "native"` (without `kind`: native); the containers are already there from the
//                inspect, of them only the finding “failed” counts — it goes to the entry of the same name (no second
//                entry). Without `services` the registered ones of the project with the desired state.
//                State of a native service: “running” (ran in main, no failure reported) · “off” · “failed”
//   data         optional: the data folder (default DIRS.data) — only for `snapshot.json`
// It NEVER THROWS because of a partial source: what could not be read is listed under `unknown` ({ what, reason }), and the
// field concerned is `null` — not [] (empty is not unknown: “not looked” is not “none there”).
//
// buildResult(inlet)  → result. PURE — from what collectResult read and already classified (no value in it); collectResult
//   calls it at the end, the tests call it directly too.
//
// THE SOURCES (everything in the container, never a git or a file of the project in B; B only reads its own
// `snapshot.json`)
//   copy    `docker ps -a` + `inspect` in the copy container (dockerIn): services, state, published ports, names and aliases
//           (the “local names” of the classification), `Config.Env` (the environment as the container has it)
//           `docker compose … --profile * config --format json` per compose call (groups by the labels, projectbox/
//           compose-config.js — configResolvedArgs): `build` per service (`buildsCode`), the RESOLVED `environment`, service
//           names, `container_name`, `hostname`, aliases
//           the `.env*` files of the project folder: ONE `sh -c` with `find` (the same folders and the same depth as
//           projectbox/env-key.js readEnvFiles, cap MAX_BYTES per file), content base64-framed on stdout. A `.env*` that is
//           a SYMLINK is read INSIDE the container if it points to a regular file (there is no reason not to follow it
//           there — the copy's app does too), otherwise named; every named file that was not read makes `complete` false
//   main    `docker ps` + `inspect --format` in main: `Config.Healthcheck.Retries === 1` of the running containers
//           (healthcheckRetries1 — the pause hits main: ONE healthcheck fails per pause, under autoheal a service with
//           `retries: 1` restarts once) and their published ports
//           `ss -H -ltn` in main: listening TCP ports minus registered services minus published ports — what remains ran in
//           main without an entry and does NOT start in the copy
//
// NO VALUE. The classification (projectbox/env-key.js) sees the values in memory and returns only keys and classes; here
//   only the keys with a target of class “foreign” remain (envRealTargets). The pairs from `inspect`, `compose config` and the
//   `.env*` live only in local variables of this function and are discarded after the classification. A DockerError
//   carries stdout and stderr (and its message the first stderr row) — `compose config` writes values to stdout and an
//   interpolation message to stderr: so ONLY the code of an error is passed on (reasonWithoutValue), never `message`,
//   `stdout`, `stderr`; likewise for a JSON.parse error (its message quotes the input). This file logs nothing. Guard:
//   server/backend/test/stacks-result.test.js (bait in `.env`, `environment` and `Config.Env`, in the error case too).
//
// THE FORM (RESULT_VERSION 1)
//   { version, name, instance, identifier, projectId, chatId, dnsName, ip,
//     branchSpace: "copy/<name>/",
//     code: null | { projectRepo, projectRepoCommit, repos: [{ rel, part, head: { branch, oid } | null, refs, state }], template }
//       template: the name of the copy this one was made from, otherwise null. From a template its WHOLE state came along
//              (upper layers, stacks/freeze.js): without a base `state` is then `{ kind: "open" }` with four counts null
//              (unknown — nothing was counted, never “clean”), `notBroughtAlong` does not name reflogs, index and stashes,
//              and instead of `openTrap`, `reflogs`, `index` the hints carry SET.template
//       state: { kind: "open", paths, erase, hidden, hiddenMissing } | { kind: "clean" } (also with `open` if all four
//              counts are known and 0)
//              | { kind: "base", base, applies: true | false | null }
//              hidden/hiddenMissing: counts from the snapshot, null if it does not carry them
//              applies from `code.preparation` (its `applied`; without the field: the id the repo stands on ⇒ true;
//              null/"empty" ⇒ false; the repo is missing there ⇒ null). If the preparation carries an id, `head` is detached
//              on it — also for the project repo without a match (the state before “State before copy”, `applies: false`).
//              Without a preparation it is guessed from the ref names (null: an id prefix that only git in the copy resolves)
//     notBroughtAlong: null | { stashes: [{ rel, count }], notLinked: [{ rel, reason }], alternates: [rel], partClones: [rel],
//                                lfs: [rel], unreadable: [rel], reflogs: true, index: true }
//     services: null | [{ name, kind: "compose" | "container" | "native", container, composeProject, state, health, ports,
//                        addresses: [{ port, name, fromB, fromNextTurn }], buildsCode: true | false | null }]
//     envRealTargets: null | { key: [..], notClassified: [..], where: [{ source: "env-file" | "compose" | "container", location,
//                             key, notClassified }], notRead: [{ location, reason }], complete, set }
//       key              a target of class “foreign” (FQDN, LAN, cloud — also every `*.cbase` except the name of the copy
//                        itself: from the copy `<project>.cbase` is main)
//       notClassified    looks like a target but could not be classified (`unclear`) — named instead of silently counted
//                        as local
//       complete         every source searched AND every `.env*` found was read (an entry in `notRead` makes it false)
//     healthcheckRetries1: null | [container], unregisteredListener: null | [port],
//     hints: [sentence], unknown: [{ what, reason }] }
import path from "node:path";
import fs from "node:fs";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { hostPort } from "../projectbox/address.js";
import { MAIN, copyInstance } from "../projectbox/creation.js";
import { ComposeConfigError, LABEL, composeConfig, configResolvedArgs, configKey, labelsOf } from "../projectbox/compose-config.js";
import { dockerIn, execIn } from "../projectbox/docker.js";
import { ENV_DEPTH, MAX_BYTES, SKIP_ENV_FOLDER, envKey, stageEntries } from "../projectbox/env-key.js";
import { containerOf } from "../projectbox/run-instance.js";
import { dnsNameOf } from "../projectbox/names.js";
import { missingLabelFiles } from "../projectbox/layout/label-files.js";
import { INSPECT_BUNDLE, hostPortsOf } from "../projectbox/relocation/collect.js";
import { realRoots, openFileWithoutReference } from "../runtime/real-path.js";
import { REF_SPACE } from "./names.js";
import { copyLocation } from "./location.js";

export const RESULT_VERSION = 1;
// Caps — ESTIMATED, NOT MEASURED; the message of a cap says that it was one (reasonWithoutValue).
export const RESULT_CAP_MS = 120_000; //          CBASE_COPY_RESULT_MS, per docker call
export const ENV_FILES_CAP = 500; //              `.env*` files per copy; above that named, not classified
export const SNAPSHOT_CAP = 64 * 1024 * 1024; // bytes of snapshot.json
export const LISTENER_CAP = 2000; //                rows of `ss`
const capMs = () => { const n = Number(process.env.CBASE_COPY_RESULT_MS); return Number.isInteger(n) && n > 0 ? n : RESULT_CAP_MS; };

// The sentences of the result — ONCE, a guard holds them (copy-tools.test.js binds them to the copy paragraph of the system
// prompt in runs/system-prompt.js: change both together).
export const SET = Object.freeze({
  branchSpace: (name) => `cbase fetches the copy's commits into the main instance under ${REF_SPACE}/${name}/<branch> — never into a checked-out ` +
    "branch; merging happens with a normal git step in the main instance.",
  openTrap: "Open changes that were taken along stay open in the main instance: if the copy commits them, they must be committed " +
    "or discarded in the main instance before the merge there.",
  // In the project repo the base applies to the state before the commit “State before copy”; the detached tip is merged by
  // project-repo-copy.js.
  base: "With `base` no open changes came along anywhere; a repo that does not know the base stands cleanly on the HEAD of the " +
    "snapshot. In the project repo the state BEFORE the commit \"State before copy\" applies: the base is resolved " +
    "against it, and it stands detached on it if it does not know the base — the open changes of the project root exist " +
    "only in that commit in the main instance. What the copy changes there detached, cbase still merges into the main instance " +
    "itself when fetching.",
  reflogs: "The reflogs did not come along — the copy begins without a history of the ref movements.",
  // A copy from a copy — the state of the template including everything that does not come along from main.
  template: (name) => `The copy was made from the copy "${name}": its state came along whole — commits, open changes, reflogs, ` +
    "index state and stashes. What the template still has open is open in the copy as well; only what the copy commits or " +
    "moves anew since its freeze is fetched — the template fetches the template's work.",
  index: "The index state did not come along: staged changes are unstaged in the copy.",
  stashes: "Stashes stayed in the main instance",
  hidden: "Files with the assume-unchanged or skip-worktree bit came with their content but without the bit — in the copy " +
    "`git status` shows them as changed if they are",
  hiddenMissing: "Files that are missing in the main instance via skip-worktree (sparse checkout) are in the copy with the state of " +
    "the checkout",
  notLinked: "Submodules, linked worktrees and links as `.git` did not come via the snapshot — they exist only in the " +
    "overlay of the project folder, with the state of the main instance",
  alternates: "These repos borrow objects via `alternates` — their source did not come along",
  partClones: "Partial clones (promisor): git fetches missing objects over the network in the copy",
  lfs: "Git LFS: only the pointers came via the snapshot, LFS contents of the copy are not backed up",
  unreadable: "These repos were not readable at the snapshot and came only as files in the overlay",
  outside: "Repos outside the project's list (deeper than the search, outside the project folder) came along only as files " +
    "in the overlay — fetch and remove do not know them.",
  buildsCode: "Services with `buildsCode: true` run with the image of the main instance; a rebuild happens only with `docker compose up -d --build " +
    "<service>` in the copy.",
  realTargets: "These targets are the real ones in the copy too: whoever writes or reads there hits the same database, the same " +
    "service, the same account as the main instance.",
  notClassified: "These keys look like a target but could not be classified (e.g. a variable as host) — whether they " +
    "hit the same target as the main instance is open",
  buildOutputs: "What the repos ignore (build outputs, node_modules, .venv, .env, data folders) lies in the copy as the lower " +
    "layer from the main instance: a native service of the copy sees the build outputs of the main instance until the copy builds itself; if " +
    "the main instance changes such a file, the copy sees the change as long as it has not written the file itself.",
  translucent: "Files that the main instance creates AFTER the creation (also non-ignored ones, e.g. after a branch switch there) " +
    "shine through into the copy and appear in the clone as untracked; renaming a folder that lies only in the lower layer " +
    "can fail with EXDEV. Read `git status` before `git add -A` in the copy — otherwise files of the main instance get into its " +
    "branches.",
  healthcheck: "These containers of the main instance check their health with `retries: 1`: during the pause of the creation a " +
    "healthcheck fails, so under autoheal they restart once",
  listener: "In the main instance these ports listen without a registered service — in the copy only what is registered runs; what is " +
    "missing there, start by hand or enter as a service",
  addresses: "Addresses per service: `<copy>.<project>.cbase:<port>` from every project container, `<ip>:<port>` from cbase itself; " +
    "from the next turn on this chat works IN the copy, there it is `localhost:<port>`.",
});

// ── Errors without a value (header, “NO VALUE”) ────────────────────────────────────────────────────────────────────────

class ResultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ResultError";
    this.code = code;
  }
}

/** The reason of an error WITHOUT a value: only a code or a fixed text — never `message`, `stdout`, `stderr` (header). */
export function reasonWithoutValue(e) {
  if (e instanceof ResultError) return e.message; // fixed texts of this file
  if (e instanceof ComposeConfigError) return `compose labels: ${e.code}`;
  if (e instanceof SyntaxError) return "output is not JSON";
  const c = e?.code;
  if (c === "CAP") return `cap of ${capMs()} ms reached (estimated, not measured)`;
  if (c === "PAUSE_CAP") return "cap of the pause barrier reached";
  if (Number.isInteger(c)) return `Exit ${c}`;
  if (typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c)) return c;
  return "Error";
}

// If `compose config` fails because a file from the labels is missing (a deleted override file — in main too), the reason
// names it instead of “Exit 1”. Checked INSIDE the copy container (the copy's state lies there at the original path); only
// the indices of the missing ones come back, the names come from the own list — paths, no values. Without a finding the
// original error stays. The check lives in projectbox/layout/label-files.js (projectbox/ must not import stacks/, the
// other way round is fine).

async function read(what, unknown, fn) {
  try {
    return await fn();
  } catch (e) {
    unknown.push({ what, reason: reasonWithoutValue(e) });
    return null;
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ID = /^[0-9a-f]{12,64}$/;
const HEX = /^[0-9a-f]{4,64}$/i;
const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const unique = (xs) => sorted(new Set(xs));
const short = (oid) => (typeof oid === "string" && /^[0-9a-f]{7,64}$/.test(oid) ? oid.slice(0, 12) : null);
const bundle = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const nameWithoutStrich = (n) => String(n || "").replace(/^\//, "");
const small = (n) => String(n || "").trim().toLowerCase();

// `environment` of a compose service (object or list “K=V”) or `Config.Env` as pairs — only for the classification.
function pairsFrom(env) {
  if (Array.isArray(env)) {
    return env.map((z) => { const s = String(z); const k = s.indexOf("="); return k < 0 ? [s, ""] : [s.slice(0, k), s.slice(k + 1)]; });
  }
  if (env && typeof env === "object") return Object.entries(env).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]);
  return [];
}

// Keys with a target of class “foreign” and keys that look like a target but could not be classified (`unclear`) — the only
// ways back out of the classification.
const isReal = (e) => (e.targets || []).some((z) => z.host === "foreign");
const realKey = (entries) => unique((entries || []).filter(isReal).map((e) => e.key));
const openKey = (entries) => unique((entries || []).filter((e) => e.unclear === true && !isReal(e)).map((e) => e.key));

// ── The `.env*` in the copy container ──────────────────────────────────────────────────────────────────────────────────

const FOLDER_SAFE = /^[A-Za-z0-9._-]+$/;
// $1 project folder, $2 depth (find counts from the folder: depth of the folders + 1 like readEnvFiles), $3 MAX_BYTES. Per
// file “./rel\0” and then “>” (too large), “!” (not readable), “~” (a symlink that points to no regular file) or
// “=<base64>”, each with “\0”; last “cbase-end\0<exit of find>\0”. A symlink (`-type l`, find does not follow it) is checked
// INSIDE the container with `[ -f ]` and measured with `head -c MAX_BYTES+1` — never a FIFO, never a device. stderr of find
// goes to /dev/null (names of locked folders); an exit ≠ 0 means “not complete”.
export function envScript() {
  const prune = SKIP_ENV_FOLDER.map((n) => {
    if (!FOLDER_SAFE.test(n)) throw new TypeError(`envScript: folder name “${n}” unsuitable`);
    return `-name '${n}'`;
  }).join(" -o ");
  const read = `if b=$(base64 < "$f"); then printf "%s\\0=" "$f"; printf "%s" "$b" | tr -d "\\n"; printf "\\0"; else printf "%s\\0!\\0" "$f"; fi`;
  return [
    'cd -- "$1" || exit 31',
    `find . -mindepth 1 -maxdepth "$2" \\( -type d \\( ${prune} \\) -prune \\) -o \\( -type f \\( -name .env -o -name '.env.*' \\) ` +
      `\\( -size +"$3"c -exec sh -c 'for f; do printf "%s\\0>\\0" "$f"; done' sh {} + ` +
      `-o -exec sh -c 'for f; do ${read}; done' sh {} + \\) \\) ` +
      `-o \\( -type l \\( -name .env -o -name '.env.*' \\) -exec sh -c 'm=$0; for f; do if [ ! -f "$f" ]; then printf "%s\\0~\\0" "$f"; ` +
      `else n=$(head -c $((m + 1)) < "$f" | wc -c); if [ $((n)) -gt "$m" ]; then printf "%s\\0>\\0" "$f"; else ${read}; fi; fi; done' "$3" {} + \\) ` +
      "2>/dev/null",
    "e=$?",
    "printf 'cbase-end\\0%s\\0' \"$e\"",
  ].join("\n");
}

/** The framed output of the env script → { files: [{ rel, content } | { rel, reason }], complete }. Throws with a fixed text. */
export function envOutput(text) {
  const t = String(text ?? "").split("\0");
  const files = [];
  let end = null;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const a = t[i];
    const b = t[i + 1];
    if (a === "cbase-end") { end = /^\d+$/.test(b) ? Number(b) : -1; break; }
    if (!a.startsWith("./")) throw new ResultError("output of the `.env*` search cannot be read", "ENV_UNREADABLE");
    const rel = a.slice(2);
    if (b === ">") files.push({ rel, reason: `larger than ${MAX_BYTES} bytes — not read (cap)` });
    else if (b === "!") files.push({ rel, reason: "not readable" });
    else if (b === "~") files.push({ rel, reason: "symlink to no regular file — not read" });
    else if (b.startsWith("=") && /^[A-Za-z0-9+/=]*$/.test(b.slice(1))) files.push({ rel, content: Buffer.from(b.slice(1), "base64").toString("utf8") });
    else throw new ResultError("output of the `.env*` search cannot be read", "ENV_UNREADABLE");
  }
  if (end === null) throw new ResultError("output of the `.env*` search has no end marker — incomplete", "ENV_INCOMPLETE");
  return { files: files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0)), complete: end === 0 };
}

// ── The code (from the snapshot) ───────────────────────────────────────────────────────────────────────────────────────

// Does the repo know the base? true: a ref of this name (short, heads, tags, remotes, full) or a ref whose id starts with the
// prefix; null: an id prefix without a ref — only git in the copy knows; false otherwise. Without a ref list: null.
function knowsBase(refs, base) {
  if (!Array.isArray(refs)) return null;
  const b = String(base);
  const names = new Set([b, `refs/heads/${b}`, `refs/tags/${b}`, `refs/remotes/${b}`]);
  if (refs.some((r) => names.has(r?.name))) return true;
  if (HEX.test(b)) return refs.some((r) => typeof r?.oid === "string" && r.oid.startsWith(b.toLowerCase())) ? true : null;
  return false;
}

// The preparation per repo (stacks/prepare.js → `code.preparation`): `base` = the full id the repo stands detached on, null
// (HEAD of the snapshot), "empty" (unborn HEAD); `applied` = the base applied there. With a base the project repo stands
// detached even WITHOUT a match (on the state before “State before copy”) — then `applied: false`. A preparation without `applied`
// (an older one) did not know that: there a full id meant “applied”. Without a preparation: null (knowsBase guesses).
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function preparationPerRepo(code) {
  const repos = code?.preparation?.repos;
  return Array.isArray(repos) ? new Map(repos.map((v) => [String(v?.rel ?? ""), v])) : null;
}

function statusOf(r, base, preparation, template = false) {
  if (base === null || base === undefined) {
    // From a template its whole state came along, nothing was counted — unknown, never “clean” (empty is not unknown).
    if (template) return { kind: "open", paths: null, erase: null, hidden: null, hiddenMissing: null };
    if (!r.open) return { kind: "clean" };
    const n = (x) => (Array.isArray(x) ? x.length : Number.isInteger(x) ? x : null);
    // What git status does not check (assume-unchanged/skip-worktree) comes in from the snapshot as counts of its own.
    const s = {
      kind: "open", paths: n(r.open.paths), erase: n(r.open.erase),
      hidden: n(r.open.hidden), hiddenMissing: Number.isInteger(r.open.hiddenMissing) ? r.open.hiddenMissing : null,
    };
    // Without a `base` EVERY repo carries an `open` (also one whose status only names an embedded repo). If all four counts
    // are known and 0, it is clean; a missing one (null, older snapshot) is unknown — then it stays “open”.
    return s.paths === 0 && s.erase === 0 && s.hidden === 0 && s.hiddenMissing === 0 ? { kind: "clean" } : s;
  }
  const b = typeof base === "object" ? (Object.prototype.hasOwnProperty.call(base, r.rel) ? String(base[r.rel]) : null) : String(base);
  // What applied is known to the preparation — it asked `rev-parse --verify <b>^{commit}` INSIDE the copy.
  if (preparation) {
    const v = preparation.get(String(r.rel ?? ""));
    return { kind: "base", base: b, applies: v ? (typeof v.applied === "boolean" ? v.applied : typeof v.base === "string" && FULL_ID.test(v.base)) : null };
  }
  if (typeof base === "object") return { kind: "base", base: b, applies: b !== null };
  return { kind: "base", base: b, applies: knowsBase(r.refs, base) };
}

function codePart(code, base) {
  if (!code || !Array.isArray(code.repos)) return { code: null, notBroughtAlong: null };
  const preparation = base === null || base === undefined ? null : preparationPerRepo(code);
  const template = typeof code.template?.name === "string" ? code.template.name : null;
  const repos = code.repos.map((r) => {
    const state = statusOf(r, base, preparation, template !== null);
    // If the base applied, the repo stands detached on it (`checkout -f --detach`) — not on the HEAD of the snapshot.
    // Likewise the project repo without a match, detached on the state before “State before copy” — the preparation's id decides.
    const vb = preparation ? preparation.get(String(r.rel ?? ""))?.base : null;
    const on = typeof vb === "string" && FULL_ID.test(vb) ? vb : null;
    return {
      rel: String(r.rel ?? ""), part: String(r.part ?? ""),
      head: on ? { branch: null, oid: short(on) }
        : r.head && typeof r.head === "object"
          ? { branch: typeof r.head.symref === "string" && r.head.symref.startsWith("refs/heads/") ? r.head.symref.slice(11) : null, oid: short(r.head.oid) }
          : null,
      refs: Array.isArray(r.refs) ? r.refs.length : Number.isInteger(r.refs) ? r.refs : null,
      state,
    };
  });
  const list = (f) => unique(code.repos.filter(f).map((r) => String(r.rel ?? "")));
  return {
    code: { projectRepo: typeof code.projectRepo === "boolean" ? code.projectRepo : null, projectRepoCommit: short(code.commit), repos, template },
    notBroughtAlong: {
      stashes: template !== null ? [] : code.repos.filter((r) => Number(r.stash) > 0).map((r) => ({ rel: String(r.rel ?? ""), count: Number(r.stash) })),
      notLinked: (Array.isArray(code.notLinked) ? code.notLinked : []).map((x) => ({ rel: String(x?.rel ?? ""), reason: String(x?.reason ?? "") })),
      alternates: list((r) => Boolean(r.objects?.alternates)),
      partClones: list((r) => Boolean(r.objects?.promisor)),
      lfs: list((r) => Boolean(r.lfs)),
      unreadable: Array.isArray(code.unreadable) ? unique(code.unreadable.map((x) => String(x?.rel ?? x))) : [],
      reflogs: template === null,
      index: template === null,
    },
  };
}

// ── buildResult (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The result from what was read (header, “THE FORM”). `inlet`: { copy: { name, projectId, chatId, base }, instance:
 * { instance, dnsName, ip }, code, container: [{ name, service, composeProject, state, health, ports }] | null,
 * build: { groups: Set<project>, services: Set<"project\0service"> } | null, native: [{ name, ports, state }] | null,
 * env: { where, notRead, complete } | null, healthcheckRetries1, listener, unknown }. No field may carry a value — the
 * classification happened before.
 */
export function buildResult(inlet = {}) {
  const { copy = {}, instance = {}, container = null, build = null, native = null, env = null } = inlet;
  const name = String(copy.name ?? "");
  const unknown = [...(inlet.unknown || [])].map((u) => ({ what: String(u.what), reason: String(u.reason) }));
  const dnsName = instance.dnsName || null;
  const ip = instance.ip || null;
  const address = (port) => ({
    port,
    name: dnsName ? hostPort(dnsName, port) : null,
    fromB: ip ? hostPort(ip, port) : null,
    fromNextTurn: hostPort("localhost", port),
  });
  const { code, notBroughtAlong } = codePart(inlet.code, copy.base ?? null);

  let services = null;
  if (container !== null || native !== null) {
    services = [];
    for (const c of container || []) {
      const ports = unique((c.ports || []).filter((p) => Number.isInteger(p)));
      const groupKnown = Boolean(c.service && c.composeProject && build?.groups?.has(c.composeProject));
      services.push({
        name: c.service || c.name, kind: c.service ? "compose" : "container", container: c.name, composeProject: c.composeProject || null,
        state: c.state || null, health: c.health || null, ports, addresses: ports.map(address),
        buildsCode: groupKnown ? build.services.has(`${c.composeProject}\0${c.service}`) : null,
      });
    }
    for (const n of native || []) {
      const ports = unique((n.ports || []).filter((p) => Number.isInteger(p)));
      services.push({ name: n.name, kind: "native", container: null, composeProject: null, state: n.state || null, health: null, ports, addresses: ports.map(address), buildsCode: null });
    }
    services.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  let envRealTargets = null;
  if (env) {
    const where = env.where.map((w) => ({ source: w.source, location: w.location, key: unique(w.key), notClassified: unique(w.notClassified || []) }))
      .filter((w) => w.key.length || w.notClassified.length)
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
    const notRead = [...(env.notRead || [])].map((x) => ({ location: x.location, reason: x.reason }));
    envRealTargets = {
      key: unique(where.flatMap((w) => w.key)), notClassified: unique(where.flatMap((w) => w.notClassified)), where,
      notRead, complete: Boolean(env.complete) && notRead.length === 0, set: SET.realTargets,
    };
  }

  const hints = [SET.branchSpace(name)];
  if (code?.template) hints.push(SET.template(code.template));
  else if (code?.repos.some((r) => r.state.kind === "open")) hints.push(SET.openTrap);
  const perRepo = (field) => (code?.repos || []).filter((r) => r.state[field] > 0).map((r) => `${r.rel} (${r.state[field]})`);
  if (perRepo("hidden").length) hints.push(`${SET.hidden}: ${perRepo("hidden").join(", ")}.`);
  if (perRepo("hiddenMissing").length) hints.push(`${SET.hiddenMissing}: ${perRepo("hiddenMissing").join(", ")}.`);
  if (copy.base !== null && copy.base !== undefined) hints.push(SET.base);
  if (!code?.template) hints.push(SET.reflogs, SET.index);
  if (notBroughtAlong) {
    const nm = notBroughtAlong;
    if (nm.stashes.length) hints.push(`${SET.stashes}: ${nm.stashes.map((s) => `${s.rel} (${s.count})`).join(", ")}.`);
    if (nm.notLinked.length) hints.push(`${SET.notLinked}: ${nm.notLinked.map((x) => `${x.rel} (${x.reason})`).join(", ")}.`);
    if (nm.alternates.length) hints.push(`${SET.alternates}: ${nm.alternates.join(", ")}.`);
    if (nm.partClones.length) hints.push(`${SET.partClones}: ${nm.partClones.join(", ")}.`);
    if (nm.lfs.length) hints.push(`${SET.lfs}: ${nm.lfs.join(", ")}.`);
    if (nm.unreadable.length) hints.push(`${SET.unreadable}: ${nm.unreadable.join(", ")}.`);
  }
  hints.push(SET.outside);
  if (services?.some((d) => d.buildsCode === true)) hints.push(SET.buildsCode);
  if (envRealTargets?.key.length) hints.push(SET.realTargets);
  if (envRealTargets?.notClassified.length) hints.push(`${SET.notClassified}: ${envRealTargets.notClassified.join(", ")}.`);
  hints.push(SET.buildOutputs, SET.translucent);
  const hc = Array.isArray(inlet.healthcheckRetries1) ? unique(inlet.healthcheckRetries1) : null;
  if (hc?.length) hints.push(`${SET.healthcheck}: ${hc.join(", ")}.`);
  const listener = Array.isArray(inlet.listener) ? unique(inlet.listener.filter((p) => Number.isInteger(p))) : null;
  if (listener?.length) hints.push(`${SET.listener}: ${listener.join(", ")}.`);
  hints.push(SET.addresses);

  return {
    version: RESULT_VERSION,
    name, instance: name ? copyInstance(name) : null, identifier: copy.projectId && name ? `${copy.projectId}/${copyInstance(name)}` : null,
    projectId: copy.projectId ?? null, chatId: copy.chatId ?? null, dnsName, ip,
    branchSpace: `${REF_SPACE}/${name}/`,
    code, notBroughtAlong, services, envRealTargets,
    healthcheckRetries1: hc, unregisteredListener: listener,
    hints, unknown,
  };
}

// ── collectResult ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The containers of a daemon: `ps -a -q --no-trunc`, then `inspect` in bundles. Throws (read catches).
async function inspectAll(container, { all = true, format = null } = {}) {
  const opts = { capMs: capMs() };
  const ps = await dockerIn(container, ["ps", ...(all ? ["-a"] : []), "-q", "--no-trunc"], opts);
  const ids = ps.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.some((i) => !ID.test(i))) throw new ResultError("`docker ps` returned no container ids", "PS_UNREADABLE");
  const out = [];
  for (const b of bundle(ids, INSPECT_BUNDLE)) {
    const r = await dockerIn(container, ["inspect", ...(format ? ["--format", format] : []), ...b], opts);
    if (format) out.push(...r.stdout.split("\n").filter((z) => z.trim()).map((z) => JSON.parse(z)));
    else out.push(...JSON.parse(r.stdout));
  }
  return out;
}

// The names of an inspected container under which the stack reaches it (classification “stack”).
function namesOf(c) {
  const n = [nameWithoutStrich(c?.Name), c?.Config?.Hostname, labelsOf(c)[LABEL.service]];
  for (const network of Object.values(c?.NetworkSettings?.Networks || {})) n.push(...(Array.isArray(network?.Aliases) ? network.Aliases : []));
  return n.map(small).filter(Boolean);
}

// The pairs of a source live only here (header, “NO VALUE”): classification happens at the end, when all local names are known.
// `ownCbase`: the name of the copy — only it is local from inside; every other `*.cbase` is a real target.
function newSources() {
  const list = [];
  return {
    pairs: (source, location, pairs) => list.push({ source, location, pairs, text: null }),
    text: (source, location, text) => list.push({ source, location, pairs: null, text }),
    classify(localNames, ownCbase) {
      const ctx = { localNames, ownCbase };
      const where = list.map((q) => {
        const entries = q.text !== null ? envKey(q.text, ctx).entries : stageEntries(q.pairs, ctx);
        return { source: q.source, location: q.location, key: realKey(entries), notClassified: openKey(entries) };
      });
      for (const q of list) { q.pairs = null; q.text = null; }
      list.length = 0;
      return where;
    },
  };
}

function readSnapshot({ data, projectId, name }) {
  const location = copyLocation({ data, projectId, name });
  const fd = openFileWithoutReference(location.root.snapshot, realRoots([location.root.base], [location.root.base]));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > SNAPSHOT_CAP) throw new ResultError(`snapshot.json: not a file or larger than ${SNAPSHOT_CAP} bytes (cap)`, "SNAPSHOT");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// `ss -H -ltn` → the listening ports (local address, field 4).
export function listeningPorts(text) {
  const rows = String(text ?? "").split("\n").filter((z) => z.trim());
  if (rows.length > LISTENER_CAP) throw new ResultError(`\`ss\`: more than ${LISTENER_CAP} lines (cap)`, "LISTENER_CAP");
  const ports = new Set();
  for (const z of rows) {
    const f = z.trim().split(/\s+/);
    const local = f[3] || "";
    const m = local.match(/:(\d{1,5})$/);
    if (!m) throw new ResultError("`ss`: line without a local address", "LISTENER_UNREADABLE");
    if (/^127\.0\.0\.11:/.test(local)) continue; // the embedded DNS of a docker network
    ports.add(Number(m[1]));
  }
  return ports;
}

export async function collectResult({ copy, project, instance = null, containerId = null, code = null, desired = null, services = null, data = null } = {}) {
  const unknown = [];
  const name = String(copy?.name ?? "");
  const projectId = String(copy?.projectId ?? project?.id ?? "");
  let kInstance = null;
  try { kInstance = copyInstance(name); } catch { unknown.push({ what: "name of the copy", reason: "not a valid copy" }); }
  const inst = { instance: kInstance, dnsName: instance?.dnsName || null, ip: instance?.ip || null };
  if (!inst.dnsName && kInstance) { try { inst.dnsName = dnsNameOf(projectId, kInstance); } catch { /* stays null */ } }
  let kc = containerId || instance?.containerId || null;
  if (!kc && kInstance) { try { kc = containerOf({ projectId, instance: kInstance }); } catch { kc = null; } }
  let main = null;
  try { main = containerOf({ projectId, instance: MAIN }); } catch { main = null; }
  const sources = newSources();
  const localNames = new Set();

  // Code: the summary carries no refs — then snapshot.json (header).
  let codeSource = code;
  if (code && Array.isArray(code.repos) && code.repos.some((r) => !r?.head || !Array.isArray(r?.refs)) && kInstance) {
    const s = await read("code snapshot", unknown, () => readSnapshot({ data: data || DIRS.data, projectId, name }));
    // The preparation stays: only it knows which base applied where.
    if (s && Array.isArray(s.repos)) codeSource = { ...s, preparation: code.preparation ?? null };
  }
  if (!code) unknown.push({ what: "Code", reason: "no snapshot passed" });

  // Copy: the inner containers (names, ports, state, Config.Env).
  let container = null;
  const groups = new Map();
  if (kc) {
    const all = await read("containers of the copy (inspect)", unknown, () => inspectAll(kc));
    if (all) {
      container = [];
      for (const c of all) {
        const l = labelsOf(c);
        const cname = nameWithoutStrich(c?.Name);
        for (const n of namesOf(c)) localNames.add(n);
        sources.pairs("container", cname, pairsFrom(c?.Config?.Env));
        container.push({
          name: cname, service: l[LABEL.service] || null, composeProject: l[LABEL.project] || null,
          state: c?.State?.Status || null, health: c?.State?.Health?.Status || null, ports: [...hostPortsOf(c)],
        });
        if (!l[LABEL.project]) continue;
        try {
          const k = composeConfig(c);
          groups.set(configKey(k), k);
        } catch (e) {
          unknown.push({ what: `compose call of ${cname}`, reason: reasonWithoutValue(e) });
        }
      }
    }
  } else unknown.push({ what: "copy container", reason: "no container known" });

  // The finding of the start (stacks/start.js `services`, `kind: "container"`): a container that did not come up carries
  // “failed” on ITS entry from the inspect — no second entry. A failed one the inspect no longer knows stays as an entry of
  // its own: the finding is never lost silently.
  const startList = Array.isArray(services) ? services : null;
  if (container !== null && startList) {
    const failed = new Set(startList.filter((d) => d?.kind === "container" && d?.state === "failed").map((d) => String(d.name ?? "")));
    for (const c of container) if (failed.delete(c.name)) c.state = "failed";
    for (const n of sorted(failed)) container.push({ name: n, service: null, composeProject: null, state: "failed", health: null, ports: [] });
  }

  // Compose: `build`, resolved `environment`, names and aliases — per call group.
  let build = null;
  if (container !== null) {
    build = { groups: new Set(), services: new Set() };
    for (const k of [...groups.values()].sort((a, b) => (a.project < b.project ? -1 : 1))) {
      const model = await read(`compose config (${k.project})`, unknown, async () => {
        let r;
        try { r = await dockerIn(kc, configResolvedArgs(k), { capMs: capMs() }); } catch (e) {
          const missing = await missingLabelFiles(kc, k, { capMs: capMs() });
          if (missing.length) throw new ResultError(`file from the label is missing: ${missing.join(", ")}`, "LABEL_FILE_MISSING");
          throw e;
        }
        const d = JSON.parse(r.stdout);
        if (!d || typeof d !== "object" || !d.services || typeof d.services !== "object") throw new ResultError("`compose config`: no object `services`", "MODEL_UNREADABLE");
        return d;
      });
      if (!model) continue;
      build.groups.add(k.project);
      for (const [service, s] of Object.entries(model.services)) {
        if (s && typeof s === "object" && s.build !== undefined && s.build !== null && s.build !== false) build.services.add(`${k.project}\0${service}`);
        localNames.add(small(service));
        for (const n of [s?.container_name, s?.hostname]) if (n) localNames.add(small(n));
        for (const network of Object.values(s?.networks || {})) for (const a of Array.isArray(network?.aliases) ? network.aliases : []) localNames.add(small(a));
        sources.pairs("compose", `${k.project}/${service}`, pairsFrom(s?.environment));
      }
    }
  }

  // The `.env*` of the project folder, INSIDE the copy container.
  const notRead = [];
  let envComplete = false;
  let envRead = false;
  if (kc && project?.path) {
    const out = await read("`.env*` files of the copy", unknown, async () => {
      const r = await execIn(kc, ["sh", "-c", envScript(), "sh", String(project.path), String(ENV_DEPTH + 1), String(MAX_BYTES)], { capMs: capMs() });
      return envOutput(r.stdout);
    });
    if (out) {
      envRead = true;
      envComplete = out.complete;
      if (!out.complete) unknown.push({ what: "`.env*` files of the copy", reason: "the search did not reach every folder (find ended with an error)" });
      out.files.forEach((d, i) => {
        if (i >= ENV_FILES_CAP) { if (i === ENV_FILES_CAP) notRead.push({ location: `(from ${d.rel} on)`, reason: `more than ${ENV_FILES_CAP} files (cap)` }); envComplete = false; return; }
        if (d.reason) { notRead.push({ location: d.rel, reason: d.reason }); envComplete = false; return; }
        sources.text("env-file", d.rel, d.content);
        d.content = null;
      });
    }
  } else if (!project?.path) unknown.push({ what: "`.env*` files of the copy", reason: "no project folder known" });

  const where = sources.classify(localNames, new Set(inst.dnsName ? [small(inst.dnsName)] : []));
  const env = container === null && !envRead ? null
    : { where, notRead, complete: envRead && envComplete && container !== null && unknown.every((u) => !u.what.startsWith("compose config")) };

  // Main: healthchecks with retries 1 and published ports of the running containers.
  let healthcheckRetries1 = null;
  const published = new Set();
  if (main) {
    const rows = await read("healthchecks of main", unknown, () => inspectAll(main, { all: false, format: "[{{json .Name}},{{json .Config.Healthcheck}},{{json .NetworkSettings.Ports}}]" }));
    if (rows) {
      healthcheckRetries1 = [];
      for (const z of rows) {
        const [n, hc, ports] = Array.isArray(z) ? z : [];
        if (hc && typeof hc === "object" && Number(hc.Retries) === 1) healthcheckRetries1.push(nameWithoutStrich(n));
        for (const p of hostPortsOf({ NetworkSettings: { Ports: ports } })) published.add(p);
      }
    }
  }

  // Native services: as the start left them (only `kind: "native"`), otherwise the registered ones with the desired state,
  // in the same words as the start (“running” · “off”).
  let registered = null;
  try { registered = store.listProjectServices(projectId); } catch { registered = null; }
  let native = null;
  if (startList) {
    native = startList.filter((d) => d && (d.kind === "native" || d.kind === undefined))
      .map((d) => ({ name: String(d?.name ?? d?.id ?? "?"), ports: Number.isInteger(Number(d?.port)) && Number(d?.port) > 0 ? [Number(d.port)] : [], state: d?.state ? String(d.state) : null }));
  } else if (registered) {
    // Native is what is registered without a container AND what the desired state names as started natively — also with a
    // registered container (projectbox/services.js nativeServicesStatus: “native” is decided by the run, e.g. `npm run dev`
    // next to a compose entry).
    const enabled = new Set((Array.isArray(desired?.services) ? desired.services : []).map((x) => String(x?.id ?? x)));
    native = registered.filter((s) => !s.container || enabled.has(String(s.id))).map((s) => ({ name: s.name, ports: Number.isInteger(s.port) && s.port > 0 ? [s.port] : [], state: enabled.has(String(s.id)) ? "running" : "off" }));
  } else unknown.push({ what: "native services", reason: "list of services not readable" });

  // Listening ports in main without an entry.
  let listener = null;
  if (main && registered && healthcheckRetries1 !== null) {
    const ports = await read("listening ports of main (ss)", unknown, async () => listeningPorts((await execIn(main, ["ss", "-H", "-ltn"], { capMs: capMs() })).stdout));
    if (ports) {
      const known = new Set([...registered.map((s) => s.port).filter((p) => Number.isInteger(p)), ...published]);
      listener = [...ports].filter((p) => !known.has(p));
    }
  } else if (main) unknown.push({ what: "listening ports of main (ss)", reason: "cannot be compared without the services and containers of main" });

  return buildResult({
    copy: { name, projectId, chatId: copy?.chatId ?? null, base: copy?.base ?? null },
    instance: inst, code: codeSource, container, build, native, env, healthcheckRetries1, listener, unknown,
  });
}
