// The clone of a source: submodules and LFS files come along, so the project works as in the main container.
//
//   checkCloneDetail({ url, branch }) → { ok: true, url, branch, host, hostWithPort, name } | { ok: false, code, error }
//                                       PURE, in the route BEFORE any creation (./sources.js → 400 with `code`). `url` normalized
//                                       (`URL.href`: host lower case, default port gone), `host` = `URL.hostname` (lower case, no
//                                       port — the key of the stored access), `hostWithPort` = `URL.host` (the key of the helper,
//                                       git compares the port), `name` = last path part without `.git` (default of the target) or null.
//   clones(inst, source, { root, accessesFor, further, signal })
//                                       the steps `clone` → `submodule` → `lfs` from the state of the source, in the project
//                                       container. After EACH step `further(next, flags)` — the caller (./procedure.js cloneSource)
//                                       sets state and flag CONDITIONALLY in one move (the flags AFTER the effect); `false` ⇒ the source
//                                       no longer stood like that (cancelled, left out): end without an error. Throws CloneError.
//   setCloneLogs(list)                  TEST SEAM: further schemes (`["file"]`) for the check AND the clone of the MAIN repo
//                                       (`-c protocol.<p>.allow=always`) — a local bare repo in the test. It applies ONLY to the
//                                       `git clone` of the main repo: submodules and LFS run with the full hardening (https only)
//                                       in the test too — a `.gitmodules` with `file://`, `ext::` or `-…` is blocked there as well
//                                       (guard in project-clone.test.js).
//   setSubmoduleCap({ depth, count })   TEST SEAM: smaller caps for the submodules (null takes them back; SUBMODULE_DEPTH and
//                                       SUBMODULE_CAP apply). server.js never calls either.
//   readRemoteHints(inst, root)         after the setup (./procedure.js): per code repo the remotes whose address carries an access
//                                       → `[{ repo, remote }]` — NAMES only, never the address or its value. cbase rewrites nothing.
//
// THE CHECK (one rule with web and iOS — bound through the fixture set server/backend/test/fixtures/clone-check/cases.json,
// expectation `server`, guard server/backend/test/clone-check.test.js). The address ITSELF is read, not via `new URL` (WHATWG turns
// `0x7f.1` into `127.0.0.1`, resolves dot segments, drops an empty `user@`). The order of the reasons is part of the rule:
//   empty ⇒ ONLY_HTTPS · SSH form (`git@host:path`, `ssh://`) ⇒ ONLY_HTTPS with the sentence "cbase does not know SSH addresses" ·
//   a character outside RFC 3986 or a `%` without two hex digits ⇒ CHARACTER · not the form `<scheme>://<authority><path>` ⇒
//   ONLY_HTTPS · a scheme other than https ⇒ ONLY_HTTPS · `@` in the authority (also empty) ⇒ WITH_USER · `?` ⇒ WITH_QUERY · `#` ⇒
//   WITH_FRAGMENT · the host (no `%`, `hostname[:port]` lower case from letters, digits, "." and "-", port 0–65535 and not empty, a
//   number as last member only as IPv4 in dotted form) ⇒ HOST_UNCLEAR · the branch against `^[A-Za-z0-9._/-]{1,200}$`, not starting
//   with `-` ⇒ BRANCH · the name (last path part after resolving "."/".." — also as `%2e` —, without `.git`, decoded, NFC; empty, ".",
//   ".." or containing "/" or "\") ⇒ HOST_UNCLEAR with the sentence "names no repository" (an own code would be in no list of
//   the spec; the clients say INVALID there, the server never answers with a code outside CLONE_CODES).
// ONLY THEN `new URL` as the last check (throws ⇒ ONLY_HTTPS) — for the normalized address (`URL.href`: host lower case, default
// port gone), and `parseRemote(URL.href)` (git.js — the reading of the git view and the access search) must read the same host as
// `URL.hostname`, `URL.host` must satisfy HOST_WITH_PORT (otherwise it would get no helper) ⇒ else HOST_UNCLEAR. With the test seam
// (`setCloneLogs`) the host checks apply only to https (a `file://` has no host).
//
// THE STEPS (all in the container through gitRun, with GIT_HARDENING, `-c protocol.https.allow=always` — the hardening forbids every
// protocol, also for submodules —, `-c pack.threads=1` (memory), `withoutDeadline` and `signal`; no value in argv):
//   1. `clone`: target present (provisioner `clone` with `onlyCheck`, without following a link) ⇒ TARGET_OCCUPIED, nothing deleted.
//      A leftover of the staging (`clone_fetched = 0`: a cancelled or dead run) goes INSIDE the container (file access erase), never
//      by fs in B; `checkSlot(0)` (at least the reserve free). Then `git clone [--branch b] -- <url> <staging>` with
//      `GIT_LFS_SKIP_SMUDGE=1` (always passed — B does not carry it) and the access of the host in list form (accessAsEnvironment:
//      helper for `host[:port]`, access searched under the host name). Errors: an auth error (git.js isGitAuthError) without an
//      access ⇒ NO_ACCESS + `host`; with an access ⇒ ACCESS_REJECTED, likewise "Repository not found" with an access (GitHub answers
//      so to a token without rights, GitLab with "could not be found or you don't have permission"); "No space left on device" ⇒
//      SLOT; otherwise CLONE with the last stderr row, shortened.
//   2. `submodule`, level by level from the clone: the paths from `.gitmodules`; `git submodule init` (resolves relative addresses
//      against the https remote and writes `submodule.<n>.url` into the LOCAL configuration); every SSH address there
//      (`git@host:path`, `ssh://…@host[:port]/path`) is rewritten by `git config --local submodule.<n>.url https://<host>/<path>`
//      — `.gitmodules` stays as it is (later updates in the Code tab then work without `insteadOf`; a manual `git submodule sync`
//      would write the SSH address back); the accesses of ALL hosts that occur; per submodule `git submodule update -- <path>`
//      (without `--recursive`, with `GIT_LFS_SKIP_SMUDGE=1`), then down. An auth error ⇒ SUBMODULE_ACCESS with the host (host name,
//      as the access is created); `error` is then EXACTLY "Submodule “<name>”" (the clients put it into their sentence "{source}: no
//      access for a submodule on {host}", the host is in `host`); "No space left on device" ⇒ SLOT; otherwise SUBMODULE.
//      Caps with a message: depth SUBMODULE_DEPTH, count SUBMODULE_CAP (estimates, not measured — a cap against a cycle, no rule of
//      the content).
//   3. `lfs`: the clone and every submodule (`git submodule --quiet foreach --recursive`, NUL-separated), per repo the hosts of its
//      remotes (runtime/git-run.js networkHosts) → accesses → lfsFetch (`git lfs ls-files` first: a repo without an LFS file is done
//      at once). "No space left on device" ⇒ SLOT; otherwise LFS.
// Moving to `<location>/<name>` is part of placing (./procedure.js stepPlace: provisioner `clone`, ONE rename).
// A cancel comes as `aborted` from gitRun and throws CloneError ABORTED; the staging stays (files stay) — "Retry" resumes at the step
// the flags name (./procedure.js).
import path from "node:path";
import { T } from "../../i18n.js";
import { isGitAuthError, parseRemote } from "../../git.js";
import * as access from "../../runtime/fileAccess.js";
import { HOST_WITH_PORT, gitRun, hostFromAddress, lfsFetch, networkHosts, accessAsEnvironment } from "../../runtime/git-run.js";
import { GIT_HARDENING, searchProject } from "../projectRepo.js";
import { placeClone } from "./provisioner.js";
import { SlotError, checkSlot } from "./slot.js";
import { nameError } from "./rules.js";
import { stagingAbs } from "./operation.js";

export const CLONE_CODES = Object.freeze(["ONLY_HTTPS", "WITH_USER", "WITH_QUERY", "WITH_FRAGMENT", "CHARACTER", "BRANCH", "HOST_UNCLEAR"]);
// The codes a clone source fails with; anything else (a docker error, an error of the program) is CLONE.
export const CLONE_ERROR_CODES = Object.freeze(["NO_ACCESS", "ACCESS_REJECTED", "SUBMODULE_ACCESS", "CLONE", "SUBMODULE", "LFS", "TARGET_OCCUPIED", "SLOT", "INTERRUPTED", "ABORTED"]);
export const SUBMODULE_DEPTH = 16;
export const SUBMODULE_CAP = 500;

export class CloneError extends Error {
  constructor(code, message, fields = {}) { super(message); this.name = "CloneError"; this.code = code; Object.assign(this, fields); }
}

// ── The seam ───────────────────────────────────────────────────────────────────────────────────────────────────────

let additionalLogs = [];
/** TEST SEAM (header): further schemes, lower case, letters only — `[]` takes them back. Applies only to the clone of the main repo. */
export function setCloneLogs(list) {
  additionalLogs = (Array.isArray(list) ? list : []).map((p) => String(p).toLowerCase()).filter((p) => /^[a-z]+$/.test(p) && p !== "https");
}
let cap = { depth: SUBMODULE_DEPTH, count: SUBMODULE_CAP };
/** TEST SEAM (header): smaller caps for the submodules — `null` takes them back. */
export function setSubmoduleCap(d) {
  const count = (x, preset) => (Number.isInteger(x) && x >= 0 ? x : preset);
  cap = d ? { depth: count(d.depth, SUBMODULE_DEPTH), count: count(d.count, SUBMODULE_CAP) } : { depth: SUBMODULE_DEPTH, count: SUBMODULE_CAP };
}
// The hardening of every step; `frontMain` only for the `git clone` of the main repo (there and only there the test seam, see header).
const front = () => [...GIT_HARDENING, "-c", "protocol.https.allow=always", "-c", "pack.threads=1"];
const frontMain = () => [...GIT_HARDENING, "-c", "protocol.https.allow=always", ...additionalLogs.flatMap((p) => ["-c", `protocol.${p}.allow=always`]), "-c", "pack.threads=1"];

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────

const RFC3986 = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
const PERCENT_BROKEN = /%(?![0-9A-Fa-f]{2})/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// The same patterns as web/src/lib (project clone check; see header "THE CHECK").
const SCP_FORM = /^[^/@\s]+@[^/:\s]+:/;
const SSH_SCHEMA = /^(?:ssh|git\+ssh|ssh\+git):\/\//i;
const FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/;
const SCHEMA_WITHOUT_STRICHE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
// A host whose last member is a number is an IPv4 address for WHATWG — valid only in dotted form of four numbers.
function ipv4Qualifies(host) {
  const segments = host.split(".");
  if (!/^(?:[0-9]+|0x[0-9a-f]*)$/.test(segments[segments.length - 1])) return true; // not an IPv4 case
  return segments.length === 4 && segments.every((x) => /^(?:0|[1-9][0-9]{0,2})$/.test(x) && Number(x) <= 255);
}
// The parts of a path after RFC 3986 "remove_dot_segments" ("."/"..", also as `%2e`).
function pathParts(filePath) {
  const out = [];
  for (const t of String(filePath).split("/")) {
    const k = t.toLowerCase();
    if (k === "" || k === "." || k === "%2e") continue;
    if (k === ".." || k === ".%2e" || k === "%2e." || k === "%2e%2e") { out.pop(); continue; }
    out.push(t);
  }
  return out;
}
// The last path part without `.git`, decoded, NFC — "" without a path or with a broken encoding.
function defaultName(filePath) {
  const parts = pathParts(filePath);
  let n = parts.length ? parts[parts.length - 1] : "";
  if (n.toLowerCase().endsWith(".git")) n = n.slice(0, -4);
  try { n = decodeURIComponent(n); } catch { return ""; }
  return n.normalize("NFC");
}
const no = (code, text) => ({ ok: false, code, error: text });
const sshSet = () => T("cbase does not know SSH addresses — please use the https address.");
const short = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function checkCloneDetail({ url, branch } = {}) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return no("ONLY_HTTPS", T("The address is missing — please enter the https address of the repository."));
  // `git@host:path` and `ssh://` — the most common mix-up, hence before the character check (like the clients).
  if (SCP_FORM.test(raw) || SSH_SCHEMA.test(raw)) return no("ONLY_HTTPS", sshSet());
  if (!RFC3986.test(raw) || PERCENT_BROKEN.test(raw)) {
    return no("CHARACTER", T("The address contains characters that are not allowed in a URL (RFC 3986)."));
  }
  const form = FORM.exec(raw);
  if (!form) {
    const front2 = (raw.match(SCHEMA_WITHOUT_STRICHE) || [""])[0].replace(/:$/, "").toLowerCase();
    if (front2 && front2 !== "https") return no("ONLY_HTTPS", T`Only https addresses can be cloned (not “${short(front2, 40)}:”).`);
    return no("ONLY_HTTPS", T("This is not a valid address — please enter the https address of the repository (https://host/path)."));
  }
  const [, schemaRaw, authority, rest] = form;
  const schema = schemaRaw.toLowerCase();
  if (schema !== "https" && !additionalLogs.includes(schema)) {
    return no("ONLY_HTTPS", T`Only https addresses can be cloned (not “${short(schema, 40)}:”).`);
  }
  if (authority.includes("@")) {
    return no("WITH_USER", T("The address carries user information — enter it without user and token; cbase keeps the access per host."));
  }
  if (raw.includes("?")) return no("WITH_QUERY", T("The address carries a query (“?…”) — please leave it out."));
  if (raw.includes("#")) return no("WITH_FRAGMENT", T("The address carries a fragment (“#…”) — please leave it out."));
  const hostUnclear = (h) => no("HOST_UNCLEAR", T`The host “${short(h, 120)}” cannot key an access (only letters, digits, “.”, “-” and a port 0–65535; a number at the end only as dotted IPv4).`);
  if (schema === "https") {
    const hp = /^([^:]*)(?::([0-9]*))?$/.exec(authority);
    if (authority.includes("%") || !hp) return hostUnclear(authority);
    const h = hp[1].toLowerCase();
    const port = hp[2];
    if (!HOSTNAME.test(h) || !ipv4Qualifies(h)) return hostUnclear(authority);
    if (port !== undefined && (port === "" || port.length > 5 || Number(port) > 65535)) return hostUnclear(authority);
  }
  let branchValue = null;
  if (branch !== undefined && branch !== null && branch !== "") {
    if (typeof branch !== "string" || !BRANCH_RE.test(branch) || branch.startsWith("-")) {
      return no("BRANCH", T("The branch may only contain letters, digits, “.”, “_”, “/” and “-” (at most 200, not starting with “-”)."));
    }
    branchValue = branch;
  }
  const name = defaultName(rest);
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    return no("HOST_UNCLEAR", T("The address names no repository (the path after the host is missing or ends in no name)."));
  }
  // Only now URL (see header): the normalized address, and parseRemote must read it like URL.
  let u;
  try { u = new URL(raw); } catch {
    return no("ONLY_HTTPS", T("This is not a valid address — please enter the https address of the repository."));
  }
  if (schema === "https") {
    const pr = parseRemote(u.href);
    if (!pr?.host || u.hostname !== pr.host) {
      return no("HOST_UNCLEAR", T`The host of the address is ambiguous (“${short(u.hostname, 120)}” vs “${short(pr?.host || "—", 120)}”) — please check the address.`);
    }
    if (!HOST_WITH_PORT.test(u.host)) return hostUnclear(u.host);
  }
  return { ok: true, url: u.href, branch: branchValue, host: u.hostname, hostWithPort: u.host, name: !nameError(name) ? name : null };
}

// ── Common to the steps ───────────────────────────────────────────────────────────────────────────────────────

const lastRow = (stderr) => {
  const rows = String(stderr || "").split("\n").map((z) => z.trim()).filter(Boolean);
  return short(rows[rows.length - 1] || "", 200);
};
const NOT_FOUND = /repository not found|repository '[^']*' not found|could not be found or you don't have permission/i;
const NO_SLOT = /no space left on device/i;
const withoutPort = (h) => String(h || "").replace(/:\d+$/, "");
const aborted = () => new CloneError("ABORTED", T("Cancelled."));
// "No space left on device" in a step — the same sentence in all three.
const noSlot = (what) => new CloneError("SLOT", T`No space left on the server's disk — ${what} is incomplete. Free some space and try again.`);

// A git in the container with the hardening — throws on cancel. `main`: the hardening of the main clone (frontMain, see header).
async function g(inst, cwd, args, { env, signal, envAlways, main = false } = {}) {
  const r = await gitRun(inst, cwd, [...(main ? frontMain() : front()), ...args], { withoutDeadline: true, ...(signal ? { signal } : {}), ...(env ? { env } : {}), ...(envAlways ? { envAlways } : {}) });
  if (r.aborted) throw aborted();
  return r;
}

// `git config -z …` → [[key, value]]; exit 1 = no key or no file (the normal case without submodules).
async function config(inst, cwd, args, { signal, code = "SUBMODULE", what = "" } = {}) {
  const r = await g(inst, cwd, ["config", "-z", ...args], { signal });
  if (r.code === 1) return [];
  if (r.code !== 0) throw new CloneError(code, T`${what}git config: ${lastRow(r.stderr)}`);
  return String(r.stdout || "").split("\0").filter(Boolean).map((e) => {
    const i = e.indexOf("\n");
    return i < 0 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)];
  });
}

// An SSH address as https at the SAME host (`https://<host>/<path>`; an ssh port is no https port) — or null.
export function sshToHttps(url) {
  const s = String(url ?? "").trim();
  let host = null;
  let filePath = null;
  let m;
  if ((m = s.match(/^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?([^/:@[\]]+)(?::\d+)?\/(.+)$/i))) { host = m[1]; filePath = m[2]; }
  else if ((m = s.match(/^[^@/:]+@([^/:@[\]]+):(?!\/)(.+)$/))) { host = m[1]; filePath = m[2]; }
  else if ((m = s.match(/^([^/:@[\]]+\.[^/:@[\]]+):(?!\/)(.+)$/))) { host = m[1]; filePath = m[2]; } // `host:path` without a user (scp-like)
  if (!host || !filePath) return null;
  const h = host.toLowerCase();
  if (!HOST_WITH_PORT.test(h)) return null;
  return `https://${h}/${filePath.replace(/^\/+/, "")}`;
}

// A submodule path from `.gitmodules` that qualifies as a location: relative, without an empty, ".", ".." or `.git` part (git checks it
// itself; here because it becomes a cwd).
const pathQualifies = (p) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.includes("\0")
  && p.split("/").every((t) => t !== "" && t !== "." && t !== ".." && t.toLowerCase() !== ".git");

// ── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────

async function stepClone(inst, root, source, { accessesFor, signal }) {
  const staging = stagingAbs(root, source.seq);
  const upfront = await placeClone(inst, root, staging, source.target, { onlyCheck: true, signal });
  if (upfront.occupied) {
    throw new CloneError("TARGET_OCCUPIED", T`Something already exists at the target “${short(source.target, 160)}” — nothing was cloned or deleted.`);
  }
  // The leftover of a run that did not reach `clone_fetched` — inside the container.
  try { await access.erase(inst, staging, { withoutDeadline: true, ...(signal ? { signal } : {}) }); }
  catch (x) { if (x?.code !== "ENOENT") throw x; }
  if (signal?.aborted) throw aborted();
  try { await checkSlot(inst, root, 0); }
  catch (x) { if (x instanceof SlotError) throw new CloneError("SLOT", x.message); throw x; }
  const hostWithPort = hostFromAddress(source.cloneUrl);
  const accesses = hostWithPort ? accessesFor([hostWithPort]) : [];
  const env = { GIT_LFS_SKIP_SMUDGE: "1", ...accessAsEnvironment(accesses) };
  const r = await g(inst, root, ["clone", ...(source.cloneBranch ? ["--branch", source.cloneBranch] : []), "--", source.cloneUrl, staging],
    { env, envAlways: ["GIT_LFS_SKIP_SMUDGE"], signal, main: true });
  if (r.code === 0) return;
  const text = String(r.stderr || "");
  const host = withoutPort(hostWithPort) || source.host || "";
  if (isGitAuthError(text) || (accesses.length && NOT_FOUND.test(text))) {
    if (accesses.length) {
      throw new CloneError("ACCESS_REJECTED", T`${host} rejected the stored access (or it has no right to this repository) — check the access, then “Try again”.`, { host });
    }
    throw new CloneError("NO_ACCESS", T`No Git access is stored for ${host} — add one, then “Try again”.`, { host });
  }
  if (NO_SLOT.test(text)) throw noSlot(T("the clone"));
  // Only the reason (the last stderr row): the clients put it into their sentence "{source}: cloning failed: {reason}".
  throw new CloneError("CLONE", lastRow(text) || T`exit ${r.code ?? r.signal}`);
}

// One level of the submodules under `repo` (absolute) and below. `state.count` counts all submodules (cap).
async function submoduleLevel(inst, repo, depth, state, { accessesFor, signal }) {
  const paths = new Map(); // name → path (from .gitmodules)
  for (const [k, v] of await config(inst, repo, ["--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { signal })) {
    paths.set(k.slice("submodule.".length, -".path".length), v);
  }
  if (!paths.size) return;
  if (depth > cap.depth) {
    throw new CloneError("SUBMODULE", T`Submodules nested deeper than ${cap.depth} levels — cap reached, not fetched further.`);
  }
  const init = await g(inst, repo, ["submodule", "init"], { signal });
  if (init.code !== 0) throw new CloneError("SUBMODULE", T`git submodule init: ${lastRow(init.stderr)}`);
  // The addresses as init wrote them into the local configuration (absolute) — rewrite SSH to https (header, step 2).
  const addresses = new Map();
  for (const [k, v] of await config(inst, repo, ["--local", "--get-regexp", "^submodule\\..*\\.url$"], { signal })) {
    const name = k.slice("submodule.".length, -".url".length);
    const https = sshToHttps(v);
    if (https) {
      const r = await g(inst, repo, ["config", "--local", `submodule.${name}.url`, https], { signal });
      if (r.code !== 0) throw new CloneError("SUBMODULE", T`Submodule “${short(name, 120)}”: address not rewritten: ${lastRow(r.stderr)}`);
      addresses.set(name, https);
    } else addresses.set(name, v);
  }
  const hosts = [...new Set([...addresses.values()].map(hostFromAddress).filter(Boolean))];
  const accesses = accessesFor(hosts);
  const env = { GIT_LFS_SKIP_SMUDGE: "1", ...accessAsEnvironment(accesses) };
  const fetched = [];
  for (const [name, address] of addresses) {
    const filePath = paths.get(name);
    if (!pathQualifies(filePath)) {
      throw new CloneError("SUBMODULE", T`Submodule “${short(name, 120)}”: the path “${short(filePath, 120)}” is not a valid location.`);
    }
    state.count += 1;
    if (state.count > cap.count) {
      throw new CloneError("SUBMODULE", T`More than ${cap.count} submodules — cap reached, not fetched further.`);
    }
    const r = await g(inst, repo, ["submodule", "update", "--", filePath], { env, envAlways: ["GIT_LFS_SKIP_SMUDGE"], signal });
    if (r.code !== 0) {
      const text = String(r.stderr || "");
      const hostWithPort = hostFromAddress(address);
      const host = withoutPort(hostWithPort);
      const withAccess = Boolean(hostWithPort) && accesses.some((z) => z.host === hostWithPort);
      if (isGitAuthError(text) || (withAccess && NOT_FOUND.test(text))) {
        // Only the name: the clients build the sentence including the host from `code` and `host` (header, step 2).
        throw new CloneError("SUBMODULE_ACCESS", T`Submodule “${short(name, 120)}”`, { host, submodule: name });
      }
      if (NO_SLOT.test(text)) throw noSlot(T`the submodule “${short(name, 120)}”`);
      throw new CloneError("SUBMODULE", T`Submodule “${short(name, 120)}”: ${lastRow(text) || T`exit ${r.code ?? r.signal}`}`, { submodule: name });
    }
    fetched.push(filePath);
  }
  for (const filePath of fetched) await submoduleLevel(inst, path.join(repo, filePath), depth + 1, state, { accessesFor, signal });
}

async function stepLfs(inst, root, source, { accessesFor, signal }) {
  const clone = stagingAbs(root, source.seq);
  const list = await g(inst, clone, ["submodule", "--quiet", "foreach", "--recursive", "printf '%s\\0' \"$displaypath\""], { signal });
  if (list.code !== 0) throw new CloneError("LFS", T`Submodules not listed: ${lastRow(list.stderr)}`);
  const repos = ["", ...String(list.stdout || "").split("\0").filter(pathQualifies)];
  for (const rel of repos) {
    const dir = rel ? path.join(clone, rel) : clone;
    const hosts = await networkHosts(inst, dir, { front: front(), signal, lfs: true });
    if (signal?.aborted) throw aborted();
    const r = await lfsFetch(inst, dir, { env: accessAsEnvironment(accessesFor(hosts)), front: front(), signal });
    if (r.aborted) throw aborted();
    if (!r.ok) {
      if (NO_SLOT.test(String(r.stderr || ""))) throw noSlot(rel ? T`the submodule “${short(rel, 120)}”` : T("the clone"));
      // Only the reason (with the submodule): the clients put it into "{source}: LFS files failed: {reason}".
      const reason = r.withoutLfs ? T("git-lfs is missing in the project container") : lastRow(r.stderr) || `Exit ${r.code}`;
      throw new CloneError("LFS", rel ? T`Submodule “${short(rel, 120)}”: ${reason}` : reason);
    }
  }
}

/**
 * The steps from the state of the source (header). `source`: the row (store sourceOf) — `seq`, `state`, `target`, `cloneUrl`,
 * `cloneBranch`, `host`, the flags. `accessesFor(hosts)` → list form (store gitAccessesFor of the workspace); `further(next, flags)`
 * → true | false (see header). → true (up to `staged`) | false (the source no longer stood like that).
 */
export async function clones(inst, source, { root, accessesFor, further, signal = null }) {
  if (!inst) throw new TypeError("clones: without an instance there is no project container");
  const including = { accessesFor: typeof accessesFor === "function" ? accessesFor : () => [], signal };
  let state = source.state;
  if (state === "clone") {
    // A clone that is already fetched is never fetched again (the staging would go) — only the state catches up.
    if (!source.cloneFetched) await stepClone(inst, root, source, including);
    if (!(await further("submodule", { cloneFetched: true }))) return false;
    state = "submodule";
  }
  if (state === "submodule") {
    if (!source.submoduleFetched) await submoduleLevel(inst, stagingAbs(root, source.seq), 1, { count: 0 }, including);
    if (!(await further("lfs", { submoduleFetched: true }))) return false;
    state = "lfs";
  }
  if (state === "lfs") {
    if (!source.lfsFetched) await stepLfs(inst, root, source, including);
    if (!(await further("staged", { lfsFetched: true }))) return false;
  }
  return true;
}

// ── Remote hint ───────────────────────────────────────────────────────────────────────────────────────────

// Does the address of a remote carry an access? http(s): any user part (`https://oauth2:<token>@…`, also a token alone as the user);
// ssh: only a user WITH a password (`git@` is no access); scp-like never.
export function carriesAccess(url) {
  const m = String(url ?? "").match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
  if (!m) return false;
  const at = m[2].lastIndexOf("@");
  if (at < 0) return false;
  const info = m[2].slice(0, at);
  if (/^https?$/i.test(m[1])) return info.length > 0;
  return info.includes(":");
}

/** The remotes of the code repos under `root` whose address carries an access (header) → `[{ repo, remote }]`. Does not throw. */
export async function readRemoteHints(inst, root, { signal = null } = {}) {
  const out = [];
  let repos = [];
  try { repos = (await searchProject(root, { instance: inst, withoutDeadline: true })).repos || []; }
  catch (x) { console.warn(`[setup] remote hint: search for the code repos failed: ${short(x?.message || x, 300)}`); return out; }
  for (const rel of repos) {
    let pairs = [];
    try { pairs = await config(inst, path.join(root, rel), ["--local", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], { signal, code: "CLONE" }); }
    catch (x) { console.warn(`[setup] remote hint: ${short(rel, 120)}: ${short(x?.message || x, 200)}`); continue; }
    for (const [k, v] of pairs) {
      if (!carriesAccess(v)) continue;
      const remote = k.replace(/^remote\./, "").replace(/\.(url|pushurl)$/, "");
      if (!out.some((h) => h.repo === rel && h.remote === remote)) out.push({ repo: rel, remote });
    }
  }
  return out;
}
