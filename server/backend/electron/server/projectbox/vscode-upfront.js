// FETCHING THE VS CODE SERVER UPFRONT. Next to it ./vscode-server.js (the clean-up) — its header explains the folder
// `~/.vscode-server` per project, and its care is the yardstick here.
//
// WHY. After every update of VS Code on the developer's machine ("the Mac"), Dev Containers uploads TWO things for the new
//   commit on the first attach, through the relay of the tunnel (whose exec server buffers the whole stdin):
//     1. into B, the user container, the helper `~/.vscode-remote-containers/bin/<commit>` (only `LICENSE`, `node`,
//        `node_modules/node-pty`; ≈ 121 MB, minutes);
//     2. into the project container the whole server `~/.vscode-server/bin/<commit>` (≈ 220 MB download, ≈ 640 MB
//        unpacked; around ten minutes).
//   Both can be placed beforehand: Microsoft names the newest version before the Mac pulls it. If `bin/<commit>` is
//   already there, Dev Containers uploads nothing (`test -d …/bin/<commit>`), and the first open after an update takes
//   seconds. EVERY ready, converted main instance therefore gets (1) the newest version from Microsoft and (2) the USED
//   one — the version the Mac last worked with (step 1b); a project that was never opened in VS Code is served too.
//   COST: ≈ 640 MB per project and version; the clean-up (vscode-server.js) additionally keeps the two newest others, so
//   up to four per project — enforced after every `ready` AND after every placement (step 4). In B usually two tarballs
//   (every required one stays — if asking for the newest fails, yesterday's protected one too) and the helpers (the three
//   newest and the protected ones).
//
// WHEN. Only in server operation (ops.js), and only if `CBASE_VSCODE_UPFRONT_MS` is not 0:
//   - one cycle at start (hook "restartGrace", name "vscode-upfront", registered in server.js) and then in the tick
//     UPFRONT_TICK_MS (`CBASE_VSCODE_UPFRONT_MS`; the tick hangs on the server run: server.js stops it on `close`); after
//     a TRANSIENT error (Microsoft not reached; network, HTTP or the time cap while fetching — never a content error) a
//     catch-up after CATCH_UP_MS (`CBASE_VSCODE_UPFRONT_CATCH_UP_MS`, 0 = none), at most CATCH_UP_ATTEMPTS in a row — the
//     first cycle after a deploy can fail while many project containers are being restored. A network error names its
//     cause (`cause` of undici);
//   - per project after every transition of the MAIN instance to `ready` (restore.js `atReady`, in server.js AFTER the
//     clean-up of the same restore) — so a stopped project catches up as soon as it runs again. This path downloads
//     nothing: it takes every protected version (newest and used) that the last cycle put checked into the cache; if it
//     placed something, it cleans up afterwards like the tick (step 4).
//   Without a consumer — no helper folder of Dev Containers in B and no project with a finished version — the cycle does
//   not ask Microsoft at all (a user without VS Code downloads nothing). A trace of the used version only counts together
//   with its helper in B, so it always falls under the first case.
//
// HOW.
//   1. ASK (questionNewest): `GET UPDATE_API` (`CBASE_VSCODE_UPDATE_API`) → `{ url, version (= commit), productVersion,
//      sha256hash, … }`. Checked: `version` exactly 40 hex characters, `sha256hash` exactly 64, `url` https (http only if
//      the endpoint is also http on a loopback address — the test); answer at most RESPONSE_CAP_BYTES. The commit is
//      persisted under vscode-server.js NEWEST_KEY: it is a PROTECTED version of the clean-up.
//  1b. THE USED VERSION (usedVersion): on EVERY start of a server VS Code writes, in the project,
//      `~/.vscode-server/data/Machine/.devport-<commit>` and `.connection-token-<commit>` (regular files, mtime = last
//      start). The used version is the trace with the newest mtime over ALL converted main instances (stopped ones too),
//      at most USED_DAYS old. Read in B ONLY like the look into `bin` (readTrace): through the descriptor in the runtime
//      folder, `.vscode-server`, `data` and `Machine` real folders, no link followed, only names, dirent type and lstat of
//      the matching names, at most LOOK_CAP entries per project (at the cap no trace from this project, a warning); an
//      mtime more than LANE_FUTURE_MS in the future does not count. A trace ONLY COUNTS if B also knows its version in
//      the helper folder of Dev Containers (helperKnows: `~/.vscode-remote-containers/bin/<c>` a real folder, likewise
//      `.vscode-remote-containers` and `bin`; without the helper folder none counts). Reason: the trace lies in the
//      project, where `~/.vscode-server` is mounted rw — a process in the project container can write it; the helper
//      folder in B is written only by Dev Containers through the tunnel and by this module (helperInB), never by a project
//      container (creation.js `neverMounted`). Dev Containers uploads the helper of the Mac's version into B FIRST and
//      THEN the server into the project, so a genuine trace always has its helper. Per project the newest trace whose
//      helper B knows counts (filtered BEFORE the choice — a newer foreign one does not hide an older genuine one). What
//      remains is under RESIDUAL RISK ("A foreign trace"). Persisted under vscode-server.js USED_KEY (only on a change,
//      with a log line; empty without a trace — then its protection falls). If it is not the newest and not already
//      checked in the cache, questionVersion asks Microsoft for exactly it: `GET VERSION_API`
//      (`CBASE_VSCODE_VERSION_API`, placeholder `{commit}`), checked as above plus `version` = the commit asked for.
//   2. FETCH (fetchTarball) into the cache `<data>/vscode-server-upfront/` (CACHE_FOLDER — listed in creation.js
//      `neverMounted`: no project container sees it; B unpacks code from it that B itself and every project execute). If
//      `<commit>.tar.gz` with `<commit>.json` (checksum, size, build time) is already there, there is no second download.
//      Otherwise as a STREAM to `<commit>.tar.gz.part` (O_EXCL, O_NOFOLLOW, 0600), capped at TARBALL_CAP_BYTES and
//      DOWNLOAD_CAP_MS, SHA-256 alongside; then checkTarball (below); only then `<commit>.json` and the rename. Every
//      error deletes the partial file; leftovers of an aborted run (`*.part`) fall at the start of the next fetch. EVERY
//      required version stays (the newest and the used one, `keep`), filled up to TARBALLS_KEEP with the newest others.
//      Versions are fetched one after the other (newest, then used).
//      DENIED: if a tarball fails on its CONTENT (CONTENT_ERROR: checksum, tar, layout, size), `<commit>.denied` is
//      written next to it (commit, sha256, code, reason, time, attempts, check status, cap if any). A layout, tar or cap
//      error locks at once, a wrong checksum (maybe a broken transport) after CHECKSUM_ATTEMPTS — each only as long as
//      Microsoft names THE SAME checksum (a new release of the same version is tried again), the status of the check is
//      the same (sha256 of this file — a deploy that changes check or cap takes back every denial) and, for the size cap,
//      the cap is not larger. Locked means: no download, one warning per tick instead of a full download per tick. Network
//      errors and the time cap never lock. The marker of another, not required version falls with the next fetch, the own
//      one after a successful fetch.
//      checkTarball reads the headers of the unpacked stream (without unpacking): only files and folders (no link, no hard
//      link, no device), every name under `vscode-server-linux-x64/` without `..`, `.` or empty parts, at most ENTRIES_CAP
//      entries and UNPACKED_CAP_BYTES; `LICENSE`, `node` (executable), `node_modules/node-pty/`, `bin/code-server`,
//      `package.json` and `product.json` must be present, the latter with `commit` = the commit of the answer (otherwise
//      another version's server would lie under `bin/<A>` — Dev Containers would never reload it). The mtime of the top
//      level is the BUILD TIME.
//   3. HELPER IN B (helperInB, per version): only if `~/.vscode-remote-containers/bin` already exists (Dev Containers was
//      used here before; both real folders, no link) and `<commit>` is missing: `tar --no-same-owner -xzf <tarball>
//      --strip-components 1` exactly the excerpt HELPER_PARTS to `bin/<commit>_<ms>` (the half-done pattern of Dev
//      Containers), layout checked, mtime = build time, then rename — if the target exists by now, the own leftover
//      falls. Then the CLEAN-UP there (cleanUpHelper): half-done `<40 hex>_<digits>` older than HALF_DONE_MIN fall; of the
//      finished ones the HELPER_KEEP newest (mtime) and the protected versions stay, never one from which a process of B
//      runs (`/proc/*/cmdline` or exe with `/.vscode-remote-containers/bin/<c>/`, read once); without a readable /proc
//      nothing finished falls. Only real folders with an exactly matching name; no link is followed.
//   4. PROJECTS (vscodeUpfrontForProject): EVERY MAIN instance (never a copy — it does not mount the folder) of a
//      converted project in `ready` (a running container — none is woken or started; stopped ones catch up at
//      `atReady`), not frozen, without held heavy load (heavyLoad.js: a relocation or clone occupies the disk — the next
//      tick catches up). Per project the versions one after the other (newest, then used); a result that hangs on the
//      project (no mount point, other inode, no folder, an error of the exec) aborts the remaining versions of this
//      project (ABORT — the next would bring the same). Per version FIRST the look in B without docker (projectLook, like
//      vscode-server.js causeInB through the descriptor in the runtime folder): `.vscode-server` a real folder (the source
//      of the mount, the creation makes it), `bin` a real folder or not there yet (reason "empty"), `<commit>` missing —
//      otherwise NO docker call. Then ONE `docker.js:execIn` as agent with the fixed script UPFRONT_SCRIPT and the tarball
//      as stdin (stream from the cache, cap UNPACK_CAP_MS). The script checks by itself (like the clean-up):
//      `.vscode-server` is a MOUNT POINT there (mountinfo field 5, exact, encoded) with THE SAME inode B saw; if `bin` is
//      missing it creates `bin` (`mkdir` WITHOUT -p — a link in that place stays as it is) and checks again afterwards;
//      `.vscode-server` and `bin` real folders; `bin/<commit>` missing (otherwise `already-there`, nothing read) ⇒
//      `mkdir bin/<commit>_<ms>`, `tar --no-same-owner -xzf - --strip-components 1`, layout checked, then `mv -n` without
//      overwriting — if the target exists by now (including the case that mv pushed into a folder that just arose), the
//      own leftover falls (`lost`); then the mtime = build time (`touch -h -t`, TZ UTC). An abort leaves
//      `bin/<commit>_<ms>` behind — the clean-up takes it after 60 min. Projects ONE AFTER THE OTHER, never in parallel
//      (IO): all paths (tick and `atReady`) go through ONE queue; at most one per project (`running-already`).
//      CLEAN-UP AFTER PLACING: if a project got at least one version (`ok`), vscode-server.js cleanUpVscodeServer follows
//      in the SAME queue entry (awaited) with the same home and /proc: first the look in B (no cause, no docker),
//      protected are the stored versions AND every one of this entry's list (`protectedAlongside` — the one just placed
//      never falls, even if it is the oldest by build time). So it stays at four per project at most, even when Microsoft
//      names new versions tick after tick.
//
// NEVER THE WRONG PLACE. The fake docker of the tests runs `docker exec` LOCALLY. The script only writes into a folder that
//   (a) is a mount point there and (b) has the same inode as the source B just looked at — on macOS there is no /proc,
//   under Linux a developer's `~/.vscode-server` is not a mount point with that inode. In the product it only runs in the
//   project container. B NEVER writes into the folder of a project itself (it belongs to the project: a link there would
//   redirect B; B reads in the runtime folder only through the descriptor). In B this module writes only to two places no
//   container has mounted (both in creation.js `neverMounted`): the cache under `<data>` and
//   `~/.vscode-remote-containers/bin` of B. The helper step only touches a folder that already exists (Dev Containers
//   creates it, never this module).
// NEVER FATAL. No path throws: network, 4xx/5xx, wrong checksum, cap, an unexpected layout, docker — one line
//   `[projectbox] VS Code server upfront …` in the log each; the catch-up or the next tick tries again. No LLM.
// CAPS. All ESTIMATED, not measured, each with a message: answer RESPONSE_CAP_BYTES and API_CAP_MS; tarball
//   TARBALL_CAP_BYTES and DOWNLOAD_CAP_MS; headers ENTRIES_CAP and UNPACKED_CAP_BYTES; unpacking UNPACK_CAP_MS per helper
//   or project (a killed `docker exec` does not end its `tar` — the leftover in the container is a half-done folder); the
//   look in B LOOK_CAP entries (at the cap NO cause); the output of the script OUTPUT_CAP_BYTES. The clock seam
//   advanceUpfrontCap lets every running cap of this module expire at once (the tests).
// RESIDUAL RISK (named).
//   - A Mac that uses a version and then opens no project for longer than USED_DAYS loses its protection (the next cycle
//     empties USED_KEY); if it is then THREE or more versions behind Microsoft, its version falls in the project, and it
//     uploads on the next attach as without this module.
//   - Two Macs with different versions: only the MOST RECENTLY used one is protected and placed upfront.
//   - A FOREIGN TRACE (hardened, not excluded). A PROCESS IN THE PROJECT can write a trace too and keep its mtime at "now".
//     It only counts for a version whose helper B knows (step 1b) — after every clean-up in B at most the HELPER_KEEP
//     newest, the newest, the used one and one from which a process of B is running; in between only what Dev Containers
//     itself uploads is added. No invented one, none Microsoft does not know, none that lies only in the project. What a
//     foreign trace for a known version Y still does — in ALL projects, because the used version is ONE value for all: it
//     DISPLACES the genuine version X of the Mac from USED_KEY as soon as it is newer than every trace of X. Consequences:
//     (a) X is no longer protected in the clean-up of EVERY project and falls there once two newer others lie there;
//     likewise its helper in B; (b) X is no longer placed upfront; (c) Y is protected and placed in EVERY ready main
//     instance (an OFFICIAL version, checksum from Microsoft, https only, layout checked, never foreign code). The Mac
//     then uploads by itself on the next attach to a project where X fell; afterwards its trace is the newest and the
//     next cycle takes X back — unless the foreign process keeps its mtime at "now". Cost and waiting time, no damage to
//     code or data. At most ONE used version at a time.
//   - The used version is only determined in the cycle (at start and per tick): a new trace protects from the next cycle on.
//   - If the Mac opens a project WHILE this module unpacks the same version there, Dev Containers uploads by itself;
//     whoever renames first wins. Its `mv -n` then pushes its folder into ours (`bin/<c>/<c>_<ms>`, not seen by the
//     clean-up) — the same case in the opposite direction is cleared by this script itself (`lost`).
//   - Between check and rename in B (helperInB) there is a window: an EMPTY `bin/<commit>` that arose in it is replaced by
//     `rename` (POSIX), a full one makes the own leftover fall.
//   - Until the first tick after a Microsoft update up to one tick interval passes; a faster Mac uploads by itself.
//   - Microsoft ships a version the Mac never gets (a withdrawn update): ≈ 640 MB per project until the clean-up takes it
//     (it is protected until the next new version).
//   - The same race in the helper of B: `bin/<c>/<c>_<ms>` — cleanUpHelper takes it after HALF_DONE_MIN. In the PROJECT
//     the nested leftover (above) stays until the version itself falls.
//   - x64 only (ARCH): UPDATE_API names the x64 server. On another machine this module does nothing (status
//     "other-architecture", one warning per process).
//   - The look in B reads at most LOOK_CAP entries in `bin` of a project; above that NO cause, but a warning per project
//     and tick.
//   - The mtime of the helpers in B is not uniform: this module sets the build time, a helper Dev Containers uploaded
//     itself presumably carries the time of its unpacking. "The three newest" thus mixes both; the protected one and a
//     running one always stay.
//
// Test seams as options: `api` (endpoint), `versionTemplate` (the version interface with `{commit}`), `data` (root of the
// cache), `home` (B's home for the helper and for helperKnows in usedVersion), `proc` (B's /proc for the clean-up there),
// `creationHome` or `home` per project (the home of the creation), `procContainer` or `proc` per project (the root the
// script reads instead of /proc), `maxBytes`, `capMs`, `now` (also the clock of the traces); plus `runningCycle()`,
// `runningUpfront(pid)` and `advanceUpfrontCap()`. Guard: server/backend/test/projectbox-vscode-upfront.test.js.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { DIRS } from "../app-state.js";
import { areaInRuntimeFolder } from "../runs/runtime-write.js";
import { serverEnds } from "../runs/server-end.js";
import { inFolderInArea } from "../runtime/real-path.js";
import * as store from "../store.js";
import { MAIN, containerName, isCopy } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { execIn, isFrozen } from "./docker.js";
import { creationOptionsFor } from "./recreate.js";
import { heavyLoadStatus } from "./heavyLoad.js";
import {
  USED_KEY, HALF_DONE_MIN, NEWEST_KEY, protectedVersions, cleanUpVscodeServer, protectionSet, vscodeServerLocations,
} from "./vscode-server.js";

/** Microsoft's update interface for the Linux server (x64, stable): the newest version. */
export const UPDATE_API = "https://update.code.visualstudio.com/api/update/server-linux-x64/stable/latest";
export const updateApi = () => process.env.CBASE_VSCODE_UPDATE_API || UPDATE_API;
/** Microsoft's interface for ONE specific version (the same shape as UPDATE_API — `url`, `version` = commit,
 *  `productVersion`, `sha256hash`). `{commit}` is the placeholder; `CBASE_VSCODE_VERSION_API` the seam of the tests (an
 *  endpoint on 127.0.0.1). */
export const VERSION_API = "https://update.code.visualstudio.com/api/versions/commit:{commit}/server-linux-x64/stable";
export const versionApiTemplate = () => process.env.CBASE_VSCODE_VERSION_API || VERSION_API;
/** The address for `commit` (exactly 40 hex characters, otherwise it throws — the commit comes from a file in the project). */
export function versionApi(commit, template = versionApiTemplate()) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ""))) throw Object.assign(new Error("version interface: not a commit of 40 hex characters"), { code: "RESPONSE" });
  return String(template).replaceAll("{commit}", commit);
}
/** The USED version only counts if its trace is at most this many days old — after that its protection falls (see header,
 *  RESIDUAL RISK). */
export const USED_DAYS = 14;
/** The tick (every 6 h and at start); `CBASE_VSCODE_UPFRONT_MS`, 0 = off. */
export const UPFRONT_TICK_MS = 6 * 3_600_000;
export function upfrontTickMs() {
  const raw = process.env.CBASE_VSCODE_UPFRONT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : UPFRONT_TICK_MS;
}
/** Catch-up after a TRANSIENT error (Microsoft not reached, network while fetching): one attempt after CATCH_UP_MS, at most
 *  CATCH_UP_ATTEMPTS in a row, then the tick again (the first cycle after a deploy can fail while the project containers
 *  are being restored — the next attempt would otherwise come a whole tick later).
 *  `CBASE_VSCODE_UPFRONT_CATCH_UP_MS`, 0 = no catch-up. */
export const CATCH_UP_MS = 10 * 60_000;
export const CATCH_UP_ATTEMPTS = 3;
export function catchUpMs() {
  const raw = process.env.CBASE_VSCODE_UPFRONT_CATCH_UP_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : CATCH_UP_MS;
}
/** The cache in B: `<data>/vscode-server-upfront/` — listed in creation.js `neverMounted` (bound in the test). */
export const CACHE_FOLDER = "vscode-server-upfront";
/** The folder of Dev Containers in the home of B — listed in creation.js `neverMounted` (bound in the test). */
export const HELPER_FOLDER = ".vscode-remote-containers";
/** The top level of Microsoft's tarball; `--strip-components 1` removes it. */
export const TOPMOST = "vscode-server-linux-x64";
/** The excerpt of the helper (exactly these three). */
export const HELPER_PARTS = Object.freeze(["LICENSE", "node", "node_modules/node-pty"]);
// Caps (see header, "CAPS") — estimated, not measured.
export const RESPONSE_CAP_BYTES = 64 * 1024;
export const API_CAP_MS = 60_000;
export const TARBALL_CAP_BYTES = 400 * 1024 * 1024;
export const DOWNLOAD_CAP_MS = 30 * 60_000;
export const ENTRIES_CAP = 50_000;
export const UNPACKED_CAP_BYTES = 2 * 1024 * 1024 * 1024;
export const UNPACK_CAP_MS = 15 * 60_000;
export const LOOK_CAP = 1000;
export const OUTPUT_CAP_BYTES = 64 * 1024;
const META_CAP_BYTES = 1024 * 1024; // pax header, GNU long name, product.json
/** How many tarballs stay in the cache (the newest ones, every required one always). */
export const TARBALLS_KEEP = 2;
/** How many finished helper versions stay in B (the newest by mtime) — plus always the protected ones. */
export const HELPER_KEEP = 3;
/** The architecture for which UPDATE_API ships the server (`server-linux-x64`). On another one the module does nothing: a
 *  placed x64 server would make Dev Containers skip the upload, and `node` would not start. */
export const ARCH = "x64";
/** The architecture of this machine: `process.arch`; `CBASE_VSCODE_ARCH` is the seam of the tests (projectbox-scenario.mjs
 *  `withOps` sets "x64"). */
export const archHere = () => process.env.CBASE_VSCODE_ARCH || process.arch;
/** How often a wrong checksum for THE SAME version with THE SAME checksum of the answer is loaded before it counts as
 *  denied (an aborted transfer must not lock the next tick, a broken release must not cost a full download every tick). A
 *  denied layout (checked AFTER the checksum, so the same content) counts at once. */
export const CHECKSUM_ATTEMPTS = 3;

const FINISHED = /^[0-9a-f]{40}$/;
const HALF_DONE = /^[0-9a-f]{40}_[0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const O = fs.constants;

const row = (text) => console.log(`[projectbox] VS Code server upfront ${text}`);
const warning = (text) => console.warn(`[projectbox] VS Code server upfront ${text}`);
const error = (code, text) => Object.assign(new Error(text), { code });
// A network error with its cause: undici throws "fetch failed" or "terminated" and carries the reason only in `cause`
// (ENOTFOUND, ECONNRESET, UND_ERR_SOCKET, …). Own errors (with `code`) stay as they are.
function networkError(e, purpose) {
  if (e?.code) return e;
  const c = e?.cause;
  const reason = [c?.code, c?.message].filter(Boolean).join(" ");
  return error("NETWORK", `${purpose}: ${e?.message || e}${reason ? ` (${reason})` : ""}`);
}
const short = (c) => String(c).slice(0, 8);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const seconds = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

// ── caps with a clock seam (like docker.js) ───────────────────────────────────────────────────────────────────────────

const runningCaps = new Set();
/** Test seam: every running cap of this module expires AT ONCE (the same message, the same abort). → how many. */
export function advanceUpfrontCap() {
  const now = [...runningCaps];
  for (const procedure of now) procedure();
  return now.length;
}
function withCap(ms, purpose, abort) {
  let clock = null;
  const end = () => { if (clock) clearTimeout(clock); clock = null; runningCaps.delete(procedure); };
  const procedure = () => { end(); abort(error("CAP", `${purpose}: cap of ${ms} ms hit (estimated, not measured) — aborted`)); };
  clock = setTimeout(procedure, ms);
  clock.unref?.();
  runningCaps.add(procedure);
  return end;
}

// ── deleting in B: ONE place (projectbox-rm-in-b.test.js, kind b-location) ────────────────────────────────────────────

// Only two places call it: the cache `<data>/vscode-server-upfront/` and `~/.vscode-remote-containers/bin` of B — both in
// creation.js `neverMounted`; no project or copy container has them mounted.
function removeInB(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) {
    warning(`${p} not removed — ${e?.code || e?.message || e}`);
    return false;
  }
}

const realFolder = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
const realFile = (p) => { try { const st = fs.lstatSync(p); return st.isFile() ? st : null; } catch { return null; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; } };

// ── 1. ask ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** https always; http only if the endpoint is also http on a loopback address (the fake endpoint of the tests). */
export function transportAllowed(target, api) {
  let u;
  let a;
  try { u = new URL(String(target)); a = new URL(String(api)); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && a.protocol === "http:" && LOOPBACK.has(u.hostname) && LOOPBACK.has(a.hostname);
}

/** Check the answer of the update interface → `{ commit, sha256, url, product }` or throw with a reason (header, step 1). */
export function checkResponse(j, api) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw error("RESPONSE", "the answer is not an object");
  const commit = String(j.version ?? "");
  if (!FINISHED.test(commit)) throw error("RESPONSE", `"version" is not a commit of 40 hex characters: ${JSON.stringify(commit.slice(0, 60))}`);
  const sha256 = String(j.sha256hash ?? "");
  if (!SHA256.test(sha256)) throw error("RESPONSE", `"sha256hash" is not a SHA-256 of 64 hex characters: ${JSON.stringify(sha256.slice(0, 80))}`);
  const url = String(j.url ?? "");
  if (!transportAllowed(url, api)) throw error("RESPONSE", `"url" is not https: ${JSON.stringify(url.slice(0, 200))}`);
  const product = typeof j.productVersion === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(j.productVersion) ? j.productVersion : "";
  return { commit, sha256, url, product, api: String(api) };
}

async function readCapped(body, maxBytes, purpose) {
  const parts = [];
  let n = 0;
  for await (const b of Readable.fromWeb(body)) {
    n += b.length;
    if (n > maxBytes) throw error("CAP_BYTES", `${purpose}: more than ${maxBytes} bytes (cap, estimated)`);
    parts.push(b);
  }
  return Buffer.concat(parts).toString("utf8");
}

// Ask an interface of Microsoft (step 1: the newest, also one specific version) → the checked answer. Throws with a
// reason; `purpose` precedes every message.
async function questionInterface(api, purpose, capMs) {
  if (!transportAllowed(api, api)) throw error("RESPONSE", `the endpoint is not https: ${String(api).slice(0, 200)}`);
  const ac = new AbortController();
  const end = withCap(capMs, purpose, (e) => ac.abort(e));
  try {
    const res = await fetch(api, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* does not matter */ } throw error("HTTP", `${purpose}: HTTP ${res.status}`); }
    const text = await readCapped(res.body, RESPONSE_CAP_BYTES, purpose);
    let j;
    try { j = JSON.parse(text); } catch { throw error("RESPONSE", "the answer is not JSON"); }
    return checkResponse(j, api);
  } catch (e) {
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : networkError(e, purpose);
  } finally { end(); }
}

/** Step 1: the newest version at Microsoft (or `api`). Throws with a reason. */
export function questionNewest({ api = updateApi(), capMs = API_CAP_MS } = {}) {
  return questionInterface(api, "update interface", capMs);
}

/** Step 1b: ONE SPECIFIC version at Microsoft (VERSION_API or `template`) — the used one. Checked like the newest, plus:
 *  the answer names EXACTLY this commit (otherwise another version's server would lie under `bin/<A>`). Throws with a reason. */
export async function questionVersion(commit, { template = versionApiTemplate(), capMs = API_CAP_MS } = {}) {
  const info = await questionInterface(versionApi(commit, template), "version interface", capMs);
  if (info.commit !== commit) throw error("RESPONSE", `version interface: "version" is ${short(info.commit)}…, asked for ${short(commit)}…`);
  return info;
}

// ── 2. fetch and check ────────────────────────────────────────────────────────────────────────────────────────────────

export const cacheFolder = (data = DIRS?.data) => (data ? path.join(data, CACHE_FOLDER) : null);
const tarballFile = (folder, commit) => path.join(folder, `${commit}.tar.gz`);
const metaFile = (folder, commit) => path.join(folder, `${commit}.json`);
const deniedFile = (folder, commit) => path.join(folder, `${commit}.denied`);
// The errors that lie in the CONTENT (the same answer ⇒ the same result) — only these the cache remembers; network, HTTP
// and the clock ("CAP") never. CAP_BYTES is the size cap of the download, CAP_CONTENT the caps in checkTarball.
const CONTENT_ERROR = new Set(["CHECKSUM", "TAR", "BUILD", "CAP_BYTES", "CAP_CONTENT"]);
// The status of the check: sha256 of THIS file (16 characters). A marker only applies under the same status — a deploy
// that changes the check or a cap takes back every old denial without anyone having to bump a number. Unreadable ⇒
// `null`, then no marker locks (load anew).
let checkStatus;
export function checkStatusOfThisFile() {
  if (checkStatus === undefined) {
    try { checkStatus = crypto.createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).digest("hex").slice(0, 16); } catch { checkStatus = null; }
  }
  return checkStatus;
}

/** The marker "denied" for `commit` in the cache → `{ commit, sha256, reason, at, attempts, code }` or `null`. Never throws. */
export function denied(commit, { data } = {}) {
  const folder = cacheFolder(data);
  if (!folder || !FINISHED.test(String(commit || "")) || !realFolder(folder)) return null;
  const st = realFile(deniedFile(folder, commit));
  if (!st || st.size > META_CAP_BYTES) return null;
  try {
    const a = JSON.parse(fs.readFileSync(deniedFile(folder, commit), "utf8"));
    return a?.commit === commit && SHA256.test(String(a.sha256 || "")) ? a : null;
  } catch { return null; }
}

// Whether the marker applies to THIS answer: the same status of the check, the same version, the same checksum; for a
// wrong checksum the attempts used up; for the size cap only as long as the cap is not larger than the one the download
// failed at.
const locks = (a, info, maxBytes) => Boolean(a && checkStatusOfThisFile() && a.status === checkStatusOfThisFile() && a.sha256 === info.sha256
  && (a.code !== "CHECKSUM" || (a.attempts || 0) >= CHECKSUM_ATTEMPTS)
  && (a.code !== "CAP_BYTES" || (Number.isFinite(a.cap) && maxBytes <= a.cap)));

function rememberDenied(folder, info, e, maxBytes) {
  try {
    const old = denied(info.commit, { data: path.dirname(folder) });
    const equal = old && old.sha256 === info.sha256 && old.code === e.code && old.status === checkStatusOfThisFile();
    const attempts = (equal ? old.attempts || 0 : 0) + 1;
    const a = {
      commit: info.commit, sha256: info.sha256, code: e.code, reason: String(e.message || e).slice(0, 500), at: Date.now(), attempts,
      status: checkStatusOfThisFile(), ...(e.code === "CAP_BYTES" ? { cap: maxBytes } : {}),
    };
    const part = `${deniedFile(folder, info.commit)}.part`;
    removeInB(part);
    const fd = fs.openSync(part, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify(a)); } finally { fs.closeSync(fd); }
    fs.renameSync(part, deniedFile(folder, info.commit));
    return a;
  } catch (f) {
    warning(`marker "denied" for ${short(info.commit)} not written — ${f?.code || f?.message || f}`);
    return null;
  }
}

function createCache(folder) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!realFolder(folder)) throw error("CACHE", `${folder} is not a real folder`);
}

/** A checked tarball in the cache → `{ file, meta }` or `null` (missing, link, size or checksum of the meta does not match). */
export function cacheEntry(commit, { data } = {}) {
  const folder = cacheFolder(data);
  if (!folder || !FINISHED.test(String(commit || "")) || !realFolder(folder)) return null;
  const file = tarballFile(folder, commit);
  const st = realFile(file);
  const mst = realFile(metaFile(folder, commit));
  if (!st || !mst || mst.size > META_CAP_BYTES) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaFile(folder, commit), "utf8")); } catch { return null; }
  if (meta?.commit !== commit || !SHA256.test(String(meta.sha256 || "")) || meta.bytes !== st.size) return null;
  if (meta.buildTime !== null && !(Number.isInteger(meta.buildTime) && meta.buildTime > 0)) return null;
  return { file, meta };
}

async function load(info, target, { maxBytes, capMs }) {
  const ac = new AbortController();
  const end = withCap(capMs, `download ${short(info.commit)}`, (e) => ac.abort(e));
  try {
    const res = await fetch(info.url, { signal: ac.signal, redirect: "follow" });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* does not matter */ } throw error("HTTP", `download: HTTP ${res.status}`); }
    if (!transportAllowed(res.url || info.url, info.api)) {
      try { await res.body?.cancel(); } catch { /* does not matter */ }
      throw error("RESPONSE", `the download did not end on https: ${String(res.url).slice(0, 200)}`);
    }
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      try { await res.body?.cancel(); } catch { /* does not matter */ }
      throw error("CAP_BYTES", `download: ${length} bytes announced, cap ${maxBytes} (estimated)`);
    }
    const fd = fs.openSync(target, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);
    const hash = crypto.createHash("sha256");
    let n = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (n > maxBytes) return cb(error("CAP_BYTES", `download: more than ${maxBytes} bytes (cap, estimated)`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(target, { fd }), { signal: ac.signal });
    return { bytes: n, sha256: hash.digest("hex") };
  } catch (e) {
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : networkError(e, "download");
  } finally { end(); }
}

// The headers of a tar (ustar, GNU, pax) — only read, never unpacked.
const BLOCK = 512;
const blocks = (n) => Math.ceil(n / BLOCK) * BLOCK;
const cstr = (h, a, n) => { const s = h.subarray(a, a + n); const i = s.indexOf(0); return (i < 0 ? s : s.subarray(0, i)).toString("utf8"); };
function octal(h, a, n, purpose) {
  if (h[a] & 0x80) throw error("TAR", `${purpose} in base-256 format — above every cap`);
  const s = cstr(h, a, n).replace(/\s+$/, "").replace(/^\s+/, "");
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw error("TAR", `${purpose} is not an octal number: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}
function paxRead(text) {
  const out = {};
  let rest = text;
  while (rest.length) {
    const m = /^(\d+) /.exec(rest);
    if (!m) throw error("TAR", "pax header unreadable");
    const length = Number(m[1]);
    const set = Buffer.from(rest, "utf8").subarray(0, length).toString("utf8");
    if (length <= m[0].length || !set.endsWith("\n")) throw error("TAR", "pax record unreadable");
    const kv = set.slice(m[0].length, -1);
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    rest = Buffer.from(rest, "utf8").subarray(length).toString("utf8");
  }
  return out;
}
function nameRel(name, type) {
  if (!name || name.includes("\0") || name.startsWith("/")) throw error("TAR", `entry with an inadmissible name: ${JSON.stringify(name.slice(0, 200))}`);
  const parts = name.replace(/\/$/, "").split("/");
  if (parts[0] !== TOPMOST) throw error("TAR", `entry outside ${TOPMOST}/: ${JSON.stringify(name.slice(0, 200))}`);
  if (parts.some((t) => t === "" || t === "." || t === "..")) throw error("TAR", `entry with an empty, "." or ".." part: ${JSON.stringify(name.slice(0, 200))}`);
  if (parts.length === 1 && type !== "5") throw error("TAR", `${TOPMOST} is not a folder`);
  return parts.slice(1).join("/");
}

/**
 * Check the headers of the tarball (header, step 2) → `{ entries, buildTime (s since 1970 | null), product }`. Throws with
 * a reason. `commit`: the commit of the answer — `product.json` must carry it.
 */
export async function checkTarball(file, { commit, maxEntries = ENTRIES_CAP, maxUnpacked = UNPACKED_CAP_BYTES } = {}) {
  const source = fs.createReadStream(file);
  const gz = zlib.createGunzip();
  source.on("error", (e) => gz.destroy(e));
  source.pipe(gz);
  let header = Buffer.alloc(0);
  let skip = 0;
  let collect = null; // { kind, parts, open }
  let pax = null;
  let longName = null;
  let end = false;
  let entries = 0;
  let sum = 0;
  const g = { buildTime: null, license: false, node: false, nodePty: false, codeServer: false, packageJson: false, productCommit: null, product: "" };

  const collected = () => {
    const data = Buffer.concat(collect.parts);
    const kind = collect.kind;
    collect = null;
    if (kind === "x") pax = paxRead(data.toString("utf8"));
    else if (kind === "L") { const i = data.indexOf(0); longName = (i < 0 ? data : data.subarray(0, i)).toString("utf8"); }
    else if (kind === "product") {
      let p;
      try { p = JSON.parse(data.toString("utf8")); } catch { throw error("BUILD", "product.json is not JSON"); }
      g.productCommit = typeof p?.commit === "string" ? p.commit : null;
      g.product = typeof p?.version === "string" ? p.version.slice(0, 40) : "";
    }
  };
  const startCollect = (kind, size) => {
    if (size > META_CAP_BYTES) throw error("CAP_CONTENT", `${kind === "product" ? "product.json" : "metadata header"}: ${size} bytes above the cap ${META_CAP_BYTES}`);
    collect = { kind, parts: [], open: size };
    if (size === 0) collected();
  };
  const process = (h) => {
    if (h.every((b) => b === 0)) { end = true; return; }
    let s = 0;
    for (let i = 0; i < BLOCK; i += 1) s += i >= 148 && i < 156 ? 32 : h[i];
    if (s !== octal(h, 148, 8, "checksum")) throw error("TAR", "checksum of a header does not match");
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const size = octal(h, 124, 12, "size");
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      skip = blocks(size);
      if (type === "x" || type === "L") startCollect(type, size);
      else if (size > META_CAP_BYTES) throw error("CAP_CONTENT", `metadata header: ${size} bytes above the cap`);
      return;
    }
    let name = cstr(h, 0, 100);
    if (h.toString("latin1", 257, 263) === "ustar\0") { const pre = cstr(h, 345, 155); if (pre) name = `${pre}/${name}`; }
    if (longName !== null) { name = longName; longName = null; }
    let realSize = size;
    if (pax) {
      if (pax.path !== undefined) name = pax.path;
      if (pax.size !== undefined) {
        if (!/^\d+$/.test(pax.size)) throw error("TAR", "pax size unreadable");
        realSize = Number(pax.size);
      }
      pax = null;
    }
    entries += 1;
    if (entries > maxEntries) throw error("CAP_CONTENT", `more than ${maxEntries} entries (cap, estimated)`);
    if (type !== "0" && type !== "5") throw error("TAR", `entry of type "${type}" (${JSON.stringify(name.slice(0, 200))}) — only files and folders are allowed`);
    const rel = nameRel(name, type);
    if (type === "0") {
      sum += realSize;
      if (sum > maxUnpacked) throw error("CAP_CONTENT", `unpacks to more than ${maxUnpacked} bytes (cap, estimated)`);
      skip = blocks(realSize);
      const mode = octal(h, 100, 8, "mode");
      if (rel === "LICENSE") g.license = true;
      else if (rel === "node") g.node = (mode & 0o111) !== 0;
      else if (rel === "bin/code-server") g.codeServer = true;
      else if (rel === "package.json") g.packageJson = true;
      else if (rel === "product.json") startCollect("product", realSize);
      if (rel.startsWith("node_modules/node-pty/")) g.nodePty = true;
    } else {
      skip = 0;
      if (rel === "") g.buildTime = octal(h, 136, 12, "time");
      if (rel === "node_modules/node-pty") g.nodePty = true;
    }
  };

  try {
    for await (const chunk of gz) {
      let o = 0;
      while (o < chunk.length && !end) {
        if (skip > 0) {
          const n = Math.min(skip, chunk.length - o);
          if (collect && collect.open > 0) {
            const m = Math.min(collect.open, n);
            collect.parts.push(Buffer.from(chunk.subarray(o, o + m)));
            collect.open -= m;
            if (collect.open === 0) collected();
          }
          skip -= n;
          o += n;
          continue;
        }
        const n = Math.min(BLOCK - header.length, chunk.length - o);
        header = Buffer.concat([header, chunk.subarray(o, o + n)]);
        o += n;
        if (header.length < BLOCK) continue;
        const h = header;
        header = Buffer.alloc(0);
        process(h);
      }
      if (end) break;
    }
  } finally { source.destroy(); gz.destroy(); }
  if (!end) throw error("TAR", "no end of the archive (truncated)");
  const missing = [];
  if (!g.license) missing.push("LICENSE");
  if (!g.node) missing.push("node (executable)");
  if (!g.nodePty) missing.push("node_modules/node-pty");
  if (!g.codeServer) missing.push("bin/code-server");
  if (!g.packageJson) missing.push("package.json");
  if (g.productCommit === null) missing.push("product.json with \"commit\"");
  if (missing.length) throw error("BUILD", `unexpected layout — missing: ${missing.join(", ")}`);
  if (commit && g.productCommit !== commit) throw error("BUILD", `product.json carries the commit ${short(g.productCommit)}…, the answer named ${short(commit)}…`);
  return { entries, buildTime: g.buildTime || null, product: g.product };
}

function writeMeta(folder, meta) {
  const target = metaFile(folder, meta.commit);
  const part = `${target}.part`;
  const fd = fs.openSync(part, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(meta)}\n`); } finally { fs.closeSync(fd); }
  fs.renameSync(part, target);
}

// Every REQUIRED version stays (the one just fetched, the newest AND the used one — `required`, a set), filled up to
// TARBALLS_KEEP with the newest others (mtime = time of fetching); a required one never falls. Plus meta files without a tarball.
function cleanCacheOn(folder, required) {
  const removed = [];
  const tarballs = [];
  for (const n of fs.readdirSync(folder)) {
    const m = /^([0-9a-f]{40})\.tar\.gz$/.exec(n);
    const st = m ? realFile(path.join(folder, n)) : null;
    if (st) tarballs.push({ commit: m[1], mtime: st.mtimeMs });
  }
  tarballs.sort((a, b) => b.mtime - a.mtime);
  const stay = new Set(required);
  for (const t of tarballs) if (stay.size < TARBALLS_KEEP) stay.add(t.commit);
  for (const t of tarballs) {
    if (stay.has(t.commit)) continue;
    if (removeInB(tarballFile(folder, t.commit))) removed.push(t.commit);
  }
  for (const n of fs.readdirSync(folder)) {
    const m = /^([0-9a-f]{40})\.json$/.exec(n);
    if (m && !stay.has(m[1]) && !realFile(tarballFile(folder, m[1]))) removeInB(path.join(folder, n));
  }
  if (removed.length) row(`cache: ${removed.length} old tarball(s) removed (${removed.map(short).join(", ")})`);
  return removed;
}

/**
 * Step 2 (header): the checked tarball for `info` in the cache → `{ file, meta, fresh }`. Throws with a reason (the partial
 * file is gone then). If it already lies there checked: no download. `keep`: the other versions this cycle needs — their
 * tarballs and their "denied" markers never fall in the clean-up (otherwise fetching the newest would delete the used one,
 * and the marker of one would fall while fetching the other — the denied tarball would then be loaded anew every tick).
 */
export async function fetchTarball(info, { data = DIRS?.data, maxBytes = TARBALL_CAP_BYTES, capMs = DOWNLOAD_CAP_MS, keep = [] } = {}) {
  const folder = cacheFolder(data);
  if (!folder) throw error("CACHE", "no data folder");
  createCache(folder);
  const existing = cacheEntry(info.commit, { data });
  if (existing) return { ...existing, fresh: false };
  const required = new Set([info.commit, ...keep]);
  // Leftovers of an aborted run — there is at most one cycle at a time (vscodeUpfrontCycle) — and "denied" markers of
  // other, not required versions (they only apply as long as Microsoft names exactly that version).
  for (const n of fs.readdirSync(folder)) {
    if (n.endsWith(".part")) removeInB(path.join(folder, n));
    else if (n.endsWith(".denied") && !required.has(n.slice(0, -".denied".length))) removeInB(path.join(folder, n));
  }
  // Denied once: the same version with the same checksum is not loaded again — otherwise a release that does not pass the
  // check would cost a full download on every tick and every restart. A new checksum (or a new version) counts as a new
  // answer.
  const marker = denied(info.commit, { data });
  if (locks(marker, info, maxBytes)) {
    throw error("DENIED", `denied on ${new Date(marker.at).toISOString()} (${marker.reason}) — not loaded again as long as Microsoft names the same version with the same checksum`);
  }
  const part = `${tarballFile(folder, info.commit)}.part`;
  const t0 = Date.now();
  try {
    const { bytes, sha256 } = await load(info, part, { maxBytes, capMs });
    if (sha256 !== info.sha256) throw error("CHECKSUM", `SHA-256 ${short(sha256)}… instead of ${short(info.sha256)}… — discarded`);
    const p = await checkTarball(part, { commit: info.commit });
    const meta = { commit: info.commit, sha256, bytes, buildTime: p.buildTime, product: info.product || p.product, entries: p.entries, fetchedAt: Date.now() };
    writeMeta(folder, meta);
    fs.renameSync(part, tarballFile(folder, info.commit));
    if (exists(deniedFile(folder, info.commit))) removeInB(deniedFile(folder, info.commit)); // an earlier failed attempt is settled
    row(`${meta.product || "?"} (${short(info.commit)}): ${mb(bytes)} fetched in ${seconds(t0)} — SHA-256 and layout checked (${p.entries} entries) → ${tarballFile(folder, info.commit)}`);
    cleanCacheOn(folder, required);
    return { file: tarballFile(folder, info.commit), meta, fresh: true };
  } catch (e) {
    removeInB(part);
    if (CONTENT_ERROR.has(e?.code)) {
      const a = rememberDenied(folder, info, e, maxBytes);
      if (a && locks(a, info, maxBytes)) e.message = `${e.message} — remembered as denied, no further download of this version`;
      else if (a) e.message = `${e.message} — attempt ${a.attempts} of ${CHECKSUM_ATTEMPTS}`;
    }
    throw e;
  }
}

// ── 3. the helper in B ────────────────────────────────────────────────────────────────────────────────────────────────

export const helperBin = (home = os.homedir()) => path.join(home, HELPER_FOLDER, "bin");
const helperExists = (home) => realFolder(path.join(home, HELPER_FOLDER)) && realFolder(helperBin(home));

// A child in B with a cap that hits the PROCESS GROUP (tar starts gzip) and resolves by itself. → { code } or throw.
function performAction(program, args, { capMs, purpose }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const err = [];
    let errN = 0;
    const subprocess = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    const end2 = (fn) => { if (finished) return; finished = true; end(); fn(); };
    const end = withCap(capMs, purpose, (e) => end2(() => {
      try { process.kill(-subprocess.pid, "SIGKILL"); } catch { try { subprocess.kill("SIGKILL"); } catch { /* gone */ } }
      reject(e);
    }));
    subprocess.stderr.on("data", (b) => { if (errN < 8192) { err.push(b); errN += b.length; } });
    subprocess.on("error", (e) => end2(() => reject(error("SPAWN", `${purpose}: could not be started (${e.code || e.message})`))));
    subprocess.on("close", (code, signal) => end2(() => {
      if (code === 0) return resolve({ code });
      const first = Buffer.concat(err).toString("utf8").split("\n").map((z) => z.trim()).find(Boolean) || (signal ? `ended by ${signal}` : `exit ${code}`);
      reject(error("KIND", `${purpose}: ${first}`));
    }));
  });
}

// The excerpt must be exactly HELPER_PARTS — otherwise it falls.
function checkHelperBuild(tmp) {
  const top = fs.readdirSync(tmp).sort();
  if (JSON.stringify(top) !== JSON.stringify(["LICENSE", "node", "node_modules"])) throw error("BUILD", `helper: top level ${JSON.stringify(top)}`);
  const nm = fs.readdirSync(path.join(tmp, "node_modules")).sort();
  if (JSON.stringify(nm) !== JSON.stringify(["node-pty"])) throw error("BUILD", `helper: node_modules ${JSON.stringify(nm)}`);
  const node = fs.lstatSync(path.join(tmp, "node"));
  if (!node.isFile() || !(node.mode & 0o111)) throw error("BUILD", "helper: node is not an executable file");
  if (!fs.lstatSync(path.join(tmp, "LICENSE")).isFile()) throw error("BUILD", "helper: LICENSE is not a file");
  if (!realFolder(path.join(tmp, "node_modules", "node-pty"))) throw error("BUILD", "helper: node_modules/node-pty is not a folder");
}

/** Step 3 (header): place the helper `~/.vscode-remote-containers/bin/<commit>` in B. Throws with a reason; the own leftover falls. */
export async function helperInB(commit, entry, { home = os.homedir(), now = Date.now(), capMs = UNPACK_CAP_MS } = {}) {
  if (!FINISHED.test(String(commit || ""))) throw error("RESPONSE", "not a commit");
  if (!helperExists(home)) return { status: "no-dev-containers" };
  const bin = helperBin(home);
  const target = path.join(bin, commit);
  if (exists(target)) return { status: "already-there" };
  const tmp = path.join(bin, `${commit}_${now}`);
  fs.mkdirSync(tmp, { mode: 0o755 }); // not recursive: an existing name throws (EEXIST)
  const t0 = Date.now();
  try {
    await performAction("tar", ["--no-same-owner", "-xzf", entry.file, "--strip-components", "1", "-C", tmp, ...HELPER_PARTS.map((t) => `${TOPMOST}/${t}`)],
      { capMs, purpose: `tar (helper ${short(commit)})` });
    checkHelperBuild(tmp);
    if (entry.meta?.buildTime) fs.utimesSync(tmp, entry.meta.buildTime, entry.meta.buildTime);
    if (exists(target)) { removeInB(tmp); return { status: "already-there" }; }
    try { fs.renameSync(tmp, target); } catch (e) {
      if (e?.code === "ENOTEMPTY" || e?.code === "EEXIST") { removeInB(tmp); return { status: "already-there" }; }
      throw e;
    }
  } catch (e) {
    removeInB(tmp);
    throw e;
  }
  row(`${entry.meta?.product || "?"} (${short(commit)}): helper placed in B in ${seconds(t0)} → ${target}`);
  return { status: "ok", target };
}

// The processes of B, read ONCE (command lines and exe) — `null` without a readable /proc (then nothing finished falls).
function processesRead(proc) {
  let names;
  try { names = fs.readdirSync(proc); } catch { return null; }
  if (!names.includes("self") && !names.some((n) => /^\d+$/.test(n))) return null;
  const out = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try { out.push(fs.readFileSync(path.join(proc, n, "cmdline")).toString("utf8").replace(/\0/g, " ")); } catch { /* gone */ }
    try { out.push(fs.readlinkSync(path.join(proc, n, "exe"))); } catch { /* gone */ }
  }
  return out.join("\n");
}

// The names `<c>_<digits>` in `bin/<c>` (real folders, older than HALF_DONE_MIN) — at most LOOK_CAP entries read.
function nestedLeftovers(folder, c, now) {
  const leftovers = [];
  let dir;
  try { dir = fs.opendirSync(folder); } catch { return leftovers; }
  try {
    let seen = 0;
    for (let d = dir.readSync(); d && ++seen <= LOOK_CAP; d = dir.readSync()) {
      if (!d.isDirectory() || !HALF_DONE.test(d.name) || !d.name.startsWith(`${c}_`)) continue;
      let st;
      try { st = fs.lstatSync(path.join(folder, d.name)); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > HALF_DONE_MIN * 60_000) leftovers.push(d.name);
    }
  } finally { dir.closeSync(); }
  return leftovers;
}

/**
 * Step 3, clean-up in `~/.vscode-remote-containers/bin` of B (header). `shielded`: the LIST of the protected versions
 * (default protectedVersions(); a single value throws — protectionSet — and nothing falls). Never throws.
 * → `{ status, removed, running }`.
 */
export function cleanUpHelper({ home = os.homedir(), proc = "/proc", shielded = protectedVersions(), now = Date.now(), cap = LOOK_CAP } = {}) {
  try {
    const protection = protectionSet(shielded);
    if (!helperExists(home)) return { status: "no-dev-containers" };
    const bin = helperBin(home);
    const candidates = [];
    const finished = [];
    const names = fs.readdirSync(bin);
    if (names.length > cap) {
      warning(`helper: ${names.length} entries in ${bin} — above the cap ${cap}, not cleaned up`);
      return { status: "cap", removed: [], running: [] };
    }
    for (const n of names) {
      const isFinished = FINISHED.test(n);
      if (!isFinished && !HALF_DONE.test(n)) continue;
      let st;
      try { st = fs.lstatSync(path.join(bin, n)); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (!isFinished) { if (now - st.mtimeMs > HALF_DONE_MIN * 60_000) candidates.push(n); continue; }
      // A nested leftover: if this module placed `bin/<c>` while Dev Containers uploaded the same helper, its `mv -n`
      // pushed its folder INTO it — `bin/<c>/<c>_<digits>`. It falls like a half-done one after HALF_DONE_MIN, also in
      // the protected version; no process ever runs from it (Dev Containers uses `bin/<c>/node`).
      for (const r of nestedLeftovers(path.join(bin, n), n, now)) candidates.push(`${n}/${r}`);
      if (!protection.has(n)) finished.push({ n, mtime: st.mtimeMs });
    }
    finished.sort((a, b) => b.mtime - a.mtime);
    candidates.push(...finished.slice(HELPER_KEEP).map((f) => f.n));
    if (!candidates.length) return { status: "nothing", removed: [], running: [] };
    const processes = processesRead(proc);
    if (processes === null) return { status: "without-proc", removed: [], running: [] };
    const removed = [];
    const running = [];
    for (const n of candidates) {
      if (!n.includes("/") && processes.includes(`/${HELPER_FOLDER}/bin/${n}/`)) { running.push(n); continue; }
      if (removeInB(path.join(bin, n))) removed.push(n);
    }
    if (removed.length) row(`helper: ${removed.length} old version(s) in ${bin} removed (${removed.map(short).join(", ")})${running.length ? `; ${running.length} stay(s) because a process runs from it` : ""}`);
    return { status: "ok", removed, running };
  } catch (e) {
    warning(`helper: clean-up failed — ${e?.code || e?.message || e}`);
    return { status: "error", removed: [], running: [], reason: e?.message || String(e) };
  }
}

// ── 1b. the used version ──────────────────────────────────────────────────────────────────────────────────────────────

/** A trace of the last use: on EVERY start of a server VS Code writes `~/.vscode-server/data/Machine/.devport-<commit>`
 *  and `.connection-token-<commit>` — regular files, mtime = last start. */
const LANE = /^\.(devport|connection-token)-([0-9a-f]{40})$/;
/** How far a trace may lie in the future (clock, write delay) — beyond that it does not count: an mtime in the year 2100
 *  (touch from inside the project) would otherwise hold the protection forever. */
const LANE_FUTURE_MS = 60_000;

/**
 * The newest trace in `<source>/data/Machine` of ONE project (header, step 1b) — like projectLook through the descriptor
 * in the runtime folder, without following a link: `.vscode-server`, `data` and `Machine` each a real folder (lstat
 * through the pinned parent folder), only names and dirent type are read, lstat only for matching names (a regular file,
 * no link), at most `cap` entries — at the cap NO trace from this project (`cap: true`, the caller warns). B opens no
 * file, it only reads names and mtime. `counts(commit)` (usedVersion passes helperKnows): only traces whose version it
 * affirms count — filtered BEFORE choosing the newest, so a newer foreign trace does not hide an older genuine one in the
 * same project. → `{ lane: { commit, mtimeMs } | null, cap?, reason? }`. Never throws.
 */
export function readTrace(source, { cap = LOOK_CAP, now = Date.now(), counts = () => true } = {}) {
  const data = path.join(source, "data");
  const machine = path.join(data, "Machine");
  const area = areaInRuntimeFolder(machine);
  if (!area) return { lane: null, reason: "no runtime folder" };
  try {
    for (const [folder, name] of [[path.dirname(source), path.basename(source)], [source, "data"], [data, "Machine"]]) {
      let st;
      try { st = inFolderInArea(folder, area, ({ at }) => fs.lstatSync(at(name))); } catch (e) {
        if (e?.code === "ENOENT") return { lane: null, reason: `missing: ${path.join(folder, name)}` };
        throw e;
      }
      if (st.isSymbolicLink()) return { lane: null, reason: `link: ${path.join(folder, name)}` };
      if (!st.isDirectory()) return { lane: null, reason: `not a folder: ${path.join(folder, name)}` };
    }
    return inFolderInArea(machine, area, ({ at }) => {
      const dir = fs.opendirSync(at(""));
      try {
        let seen = 0;
        let lane = null;
        for (let d = dir.readSync(); d; d = dir.readSync()) {
          if (++seen > cap) return { lane: null, cap: true, reason: `cap of ${cap} entries in ${machine} hit (estimated) — B reads no further, no trace from this project` };
          if (d.isSymbolicLink() || d.isDirectory()) continue; // never follow a link
          const m = LANE.exec(d.name);
          if (!m || !counts(m[2])) continue;
          let st;
          try { st = fs.lstatSync(at(d.name)); } catch { continue; }
          if (!st.isFile() || st.mtimeMs > now + LANE_FUTURE_MS) continue;
          // The newest; with an equal mtime the larger name (fixed, not the order of the folder).
          if (!lane || st.mtimeMs > lane.mtimeMs || (st.mtimeMs === lane.mtimeMs && m[2] > lane.commit)) lane = { commit: m[2], mtimeMs: st.mtimeMs };
        }
        return { lane };
      } finally { dir.closeSync(); }
    });
  } catch (e) {
    return { lane: null, reason: e?.code || e?.message || String(e) };
  }
}

/**
 * Which versions B KNOWS in the helper folder of Dev Containers — `~/.vscode-remote-containers/bin/<c>` a real folder (no
 * link; likewise `.vscode-remote-containers` and `bin`), exactly the name `<40 hex>` (a half-done `<c>_<ms>` does not
 * count). Only Dev Containers through the tunnel and this module (helperInB) write the folder, never a project container
 * (creation.js `neverMounted`). → a check `(commit) => boolean` (ONE lstat per commit, remembered) or `null` without the
 * helper folder (then no trace counts). Never throws.
 */
export function helperKnows(home = os.homedir()) {
  if (!helperExists(home)) return null;
  const bin = helperBin(home);
  const remembered = new Map();
  return (commit) => {
    const c = String(commit || "");
    if (!FINISHED.test(c)) return false;
    if (!remembered.has(c)) remembered.set(c, realFolder(path.join(bin, c)));
    return remembered.get(c);
  };
}

/**
 * The USED version (header, step 1b): the newest trace over ALL converted main instances (`heads`, default
 * store.projectInstances() — stopped ones too: reading only happens in B), at most USED_DAYS old, and only one whose
 * version B knows in the helper folder of Dev Containers (helperKnows with `home` = B's home — without the helper folder
 * none counts, and the projects are not read at all). Persisted under vscode-server.js USED_KEY — only on a change, with
 * a log line; EMPTY without a trace (the protection falls). If the list cannot be read, the stored value stays (warning)
 * and the result is `null`.
 * → `{ commit, mtimeMs, projectId } | null`. Never throws.
 */
export function usedVersion({ now = Date.now(), cap = LOOK_CAP, heads, home = os.homedir() } = {}) {
  let best = null;
  let knows = null;
  try {
    knows = helperKnows(home);
    const list = knows ? heads ?? store.projectInstances().filter((z) => z.instance === MAIN && z.convertedAt) : [];
    const limit = now - USED_DAYS * 86_400_000;
    for (const z of list) {
      const r = readTrace(vscodeServerLocations(z.projectId).source, { cap, now, counts: knows });
      if (r.cap) warning(`project ${z.projectId}: ${r.reason}`);
      const s = r.lane;
      if (!s || s.mtimeMs < limit) continue;
      if (!best || s.mtimeMs > best.mtimeMs || (s.mtimeMs === best.mtimeMs && s.commit > best.commit)) best = { ...s, projectId: z.projectId };
    }
  } catch (e) {
    warning(`used version not determined — ${e?.message || e}; the stored value stays`);
    return null;
  }
  try {
    const old = String(store.getSetting(USED_KEY, "") || "");
    const fresh = best?.commit ?? "";
    if (old !== fresh) {
      store.setSetting(USED_KEY, fresh);
      if (best) row(`the Mac last worked with ${best.commit} (trace in project ${best.projectId}, ${new Date(best.mtimeMs).toISOString()}, helper known in B) — from now on protected in the clean-up and placed upfront in every project`);
      else row(`no trace of a used version in the last ${USED_DAYS} days — the protection of ${old} falls${knows ? "" : ` (no helper folder of Dev Containers in ${helperBin(home)} — without it no trace counts)`}`);
    }
  } catch (e) {
    warning(`used version not stored — ${e?.message || e}`);
  }
  return best;
}

// ── 4. projects ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The look in B (header, step 4) at `<source>/bin` through the descriptor in the runtime folder, without following a link.
 * `.vscode-server` must be a real folder (the source of the mount — the creation makes it). With `commit`: cause if
 * `bin/<commit>` is missing — also if `bin` itself is missing (reason "empty": VS Code was never here, the script creates
 * `bin`); `bin` as a link or non-folder is no cause. `commit` null (the need): cause only with at least one finished
 * version (at most `cap` entries read — at the cap no cause, `cap: true`).
 * → `{ cause, ino?, alreadyThere?, cap?, reason? }`. Never throws.
 */
export function projectLook(source, commit, { cap = LOOK_CAP } = {}) {
  const empty = { cause: false };
  const bin = path.join(source, "bin");
  const area = areaInRuntimeFolder(bin);
  if (!area) return { ...empty, reason: "no runtime folder" };
  try {
    // `.vscode-server` through the pinned parent folder: a real folder, no link; the script checks its inode.
    const vs = inFolderInArea(path.dirname(source), area, ({ at }) => fs.lstatSync(at(path.basename(source)), { bigint: true }));
    if (vs.isSymbolicLink()) return { ...empty, reason: `link: ${source}` };
    if (!vs.isDirectory()) return { ...empty, reason: `not a folder: ${source}` };
    const ino = String(vs.ino); // exact (BigInt), as text — that is how it goes to the script
    let st;
    try { st = inFolderInArea(source, area, ({ at }) => fs.lstatSync(at("bin"))); } catch (e) {
      if (e?.code !== "ENOENT") throw e;
      return commit ? { cause: true, ino, reason: "empty" } : { ...empty, ino, reason: "empty (never open in VS Code)" };
    }
    if (st.isSymbolicLink()) return { ...empty, reason: `link: ${bin}` };
    if (!st.isDirectory()) return { ...empty, reason: `not a folder: ${bin}` };
    return inFolderInArea(bin, area, ({ at }) => {
      if (commit) {
        try { fs.lstatSync(at(commit)); return { ...empty, ino, alreadyThere: true, reason: "already there" }; } catch (e) { if (e?.code !== "ENOENT") throw e; }
        return { cause: true, ino };
      }
      const dir = fs.opendirSync(at(""));
      try {
        let seen = 0;
        for (let d = dir.readSync(); d; d = dir.readSync()) {
          if (++seen > cap) return { ...empty, ino, cap: true, reason: `cap of ${cap} entries in ${bin} hit (estimated) — B reads no further, nothing upfront` };
          if (d.isSymbolicLink() || !FINISHED.test(d.name)) continue;
          let s;
          try { s = fs.lstatSync(at(d.name)); } catch { continue; }
          if (s.isDirectory()) return { cause: true, ino };
        }
        return { ...empty, ino, reason: "no finished version (never open in VS Code)" };
      } finally { dir.closeSync(); }
    });
  } catch (e) {
    return { ...empty, reason: e?.code || e?.message || String(e) };
  }
}

/**
 * The script in the project container (header, step 4). Arguments: $1 `<home>/.vscode-server` (absolute), $2 the commit
 * (40 hex), $3 the root of /proc (only `self/mountinfo`), $4 the inode B saw at the source, $5 the build time as
 * `CCYYMMDDhhmm.SS` (UTC) or empty, $6 digits for the name of the half-done folder. stdin: the tarball (gz). No values in
 * the text. Output ONE line: `no-mount`, `other-folder`, `no-folder`, `already-there` (then nothing was read), `lost <c>`
 * (someone else was faster, the own leftover is gone) or `finished <c>`; plus possibly `time-open <c>`. Errors on stderr,
 * exit 1 (the own leftover is gone). POSIX sh with cut, grep, sed, ls, mkdir, tar (gzip), mv, rm, touch — all in the base
 * stage of the images.
 */
export const UPFRONT_SCRIPT = [
  "set -u",
  "LC_ALL=C; export LC_ALL",
  "vs=$1; c=$2; proc=$3; ino=$4; stamp=$5; ms=$6",
  "hex40() { case $1 in ''|*[!0-9a-f]*) return 1;; esac; [ \"${#1}\" -eq 40 ]; }",
  "hex40 \"$c\" || { echo \"invalid commit\" >&2; exit 2; }",
  "case $ms in ''|*[!0-9]*) echo \"invalid timestamp\" >&2; exit 2;; esac",
  "case $stamp in ''|[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9][0-9]) ;; *) echo \"invalid build time\" >&2; exit 2;; esac",
  // Only into a MOUNT POINT (like the clean-up, vscode-server.js) with the same inode B saw.
  "nl='",
  "'",
  "case $vs in *\"$nl\"*) echo no-mount; exit 0;; esac",
  "encoded=$(printf '%s\\n' \"$vs\" | sed -e 's/\\\\/\\\\134/g' -e 's/ /\\\\040/g' -e 's/\t/\\\\011/g')",
  "cut -d ' ' -f 5 \"$proc/self/mountinfo\" 2>/dev/null | grep -qxF -- \"$encoded\" || { echo no-mount; exit 0; }",
  "[ -d \"$vs\" ] && [ ! -L \"$vs\" ] || { echo no-folder; exit 0; }",
  "set -- $(ls -di -- \"$vs\" 2>/dev/null)",
  "[ \"${1:-}\" = \"$ino\" ] || { echo other-folder; exit 0; }",
  "b=$vs/bin",
  // If `bin` is missing (VS Code was never in this project) the script creates it — WITHOUT -p: an existing name (also a
  // link, also a dangling one) stays as it is. If mkdir fails and there is no folder afterwards, that is an error
  // (permissions); afterwards it is checked again in any case: a real folder, no link.
  "if [ ! -e \"$b\" ] && [ ! -L \"$b\" ]; then",
  "  if ! mkdir -- \"$b\" 2>/dev/null && [ ! -e \"$b\" ] && [ ! -L \"$b\" ]; then echo \"mkdir bin failed\" >&2; exit 1; fi",
  "fi",
  "[ -d \"$b\" ] && [ ! -L \"$b\" ] || { echo no-folder; exit 0; }",
  "target=$b/$c",
  "if [ -e \"$target\" ] || [ -L \"$target\" ]; then echo already-there; exit 0; fi",
  "t=$b/${c}_$ms",
  "mkdir -- \"$t\" || { echo \"mkdir failed\" >&2; exit 1; }",
  "if ! tar --no-same-owner -xzf - --strip-components 1 -C \"$t\"; then rm -rf -- \"$t\"; echo \"tar failed\" >&2; exit 1; fi",
  "if [ ! -f \"$t/node\" ] || [ ! -x \"$t/node\" ] || [ ! -f \"$t/bin/code-server\" ] || [ ! -f \"$t/package.json\" ] || [ ! -d \"$t/node_modules/node-pty\" ]; then",
  "  rm -rf -- \"$t\"; echo \"unexpected layout\" >&2; exit 1",
  "fi",
  // Without overwriting: if the target exists by now, the own leftover falls; if mv pushed INTO a folder that just arose,
  // the leftover there falls. The first line is only a shortcut (it saves the detour through pushing in) — the two lines
  // after the mv catch the same case on their own.
  "if [ -e \"$target\" ] || [ -L \"$target\" ]; then rm -rf -- \"$t\"; echo \"lost $c\"; exit 0; fi",
  "mv -n -- \"$t\" \"$target\"",
  "if [ -d \"$t\" ]; then rm -rf -- \"$t\"; echo \"lost $c\"; exit 0; fi",
  "if [ -d \"$target/${c}_$ms\" ] && [ ! -L \"$target/${c}_$ms\" ]; then rm -rf -- \"$target/${c}_$ms\"; echo \"lost $c\"; exit 0; fi",
  "if [ -n \"$stamp\" ]; then TZ=UTC0 touch -h -t \"$stamp\" -- \"$target\" 2>/dev/null || echo \"time-open $c\"; fi",
  "echo \"finished $c\"",
].join("\n");

/** The output of the script → `{ status, commit? }` (status: one of the lines, otherwise `unknown`), `timeOpen`. */
export function readUpfrontOutput(text) {
  let status = "unknown";
  let commit = null;
  let timeOpen = false;
  for (const z of String(text || "").split("\n")) {
    const t = z.trim();
    if (["no-mount", "other-folder", "no-folder", "already-there"].includes(t)) { status = t; continue; }
    const m = /^(finished|lost|time-open) ([0-9a-f]{40})$/.exec(t);
    if (!m) continue;
    if (m[1] === "time-open") timeOpen = true;
    else { status = m[1]; commit = m[2]; }
  }
  return { status, commit, timeOpen };
}

/** Build time (s since 1970, UTC) → `CCYYMMDDhhmm.SS` for `touch -t` under TZ=UTC0; empty without a build time. */
export function touchStamp(buildTime) {
  if (!Number.isInteger(buildTime) || buildTime <= 0) return "";
  const d = new Date(buildTime * 1000);
  const z = (n, l = 2) => String(n).padStart(l, "0");
  return `${z(d.getUTCFullYear(), 4)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}.${z(d.getUTCSeconds())}`;
}

// The ONE queue of all projects (tick and atReady, see header: one after the other) and at most one per project.
const runningProject = new Map();
let queue = Promise.resolve();
/** Test seam: the running or enqueued upfront fetch of a project (promise of the result) or `null`. */
export const runningUpfront = (projectId) => runningProject.get(String(projectId)) ?? null;

/**
 * Step 4 for ONE project (header) — the consumer at `atReady` (server.js, after the clean-up) and the cycle. Never throws.
 * The versions: `versions` (`[{ commit, entry }]`, the cycle), otherwise `commit`/`entry` as one, otherwise EVERY protected
 * version (vscode-server.js protectedVersions) with its tarball from the cache — this path never downloads itself. `after`:
 * a promise whose end it waits for BEFORE enqueuing (server.js: the clean-up of the same `ready`) — the project is
 * registered at once (`runningUpfront`), so a test sees the consumer without a clock.
 * @returns {Promise<{ status: string, reason?: string, versions?: Record<string, { status: string, reason?: string }>, cleanUp? }>} —
 *   `status` is a hold BEFORE the versions (copy, no-ops, off, other-architecture, serverEnd, no-version, not-converted,
 *   not-ready, frozen, heavyLoad, error) or, with `versions`, their common status ("mixed" if they ended differently).
 *   `cleanUp`: the result of vscode-server.js cleanUpVscodeServer — only if at least one version was placed (`ok`).
 */
export function vscodeUpfrontForProject(projectId, { after, ...opts } = {}) {
  const pid = String(projectId);
  if (runningProject.has(pid)) return Promise.resolve({ status: "running-already" });
  const enqueue = () => {
    const r = queue.then(() => upfrontProject(pid, opts));
    queue = r.then(() => {}, () => {});
    return r;
  };
  const run = (after ? Promise.resolve(after).then(() => {}, () => {}).then(enqueue) : enqueue()).finally(() => runningProject.delete(pid));
  runningProject.set(pid, run);
  return run;
}

// The results of a version after which the remaining ones of this project are not tried any more: they hang on the project
// or the container, not on the version — mount, inode, folder, an error of the exec (missing container, cap: a second one
// would cost UNPACK_CAP_MS once more) —, the next would bring the same. The next tick tries again.
const ABORT = new Set(["no-mount", "other-folder", "no-folder", "error", "serverEnd"]);
const common = (list) => (list.every((r) => r.status === list[0].status) ? list[0].status : "mixed");

async function upfrontProject(pid, { instance = MAIN, home, proc = "/proc", capMs = UNPACK_CAP_MS, versions, commit, entry, data, arch = archHere() } = {}) {
  try {
    if (isCopy(instance)) return { status: "copy" };
    if (!projectboxOps()) return { status: "no-ops" };
    if (upfrontTickMs() === 0) return { status: "off" };
    if (arch !== ARCH) return { status: "other-architecture", arch };
    if (serverEnds()) return { status: "serverEnd" };
    const list = versions ?? (commit ? [{ commit, entry }] : protectedVersions().map((c) => ({ commit: c })));
    if (!list.length) return { status: "no-version" };
    const z = store.projectInstance(pid, MAIN);
    if (!z?.convertedAt) return { status: "not-converted" };
    if (z.state !== "ready") return { status: "not-ready", reason: z.state };
    const name = containerName(pid, MAIN);
    if (isFrozen(name)) return { status: "frozen" };
    if (heavyLoadStatus()) return { status: "heavyLoad" };
    const creationHome = home ?? creationOptionsFor(pid).home ?? os.homedir();
    const locations = vscodeServerLocations(pid, { home: creationHome });
    // The versions ONE AFTER THE OTHER, in the order of the list (the cycle: newest, then used).
    const results = {};
    let abort = null;
    for (const v of list) {
      if (abort) { results[v.commit] = { status: abort.status, reason: `not attempted — like ${short(abort.commit)}` }; continue; }
      const r = serverEnds() ? { status: "serverEnd" } : await upfrontVersion(pid, name, locations, v, { proc, capMs, data });
      results[v.commit] = r;
      if (ABORT.has(r.status)) abort = { status: r.status, commit: v.commit };
    }
    const out = { status: common(Object.values(results)), versions: results };
    // If something was PLACED here (`ok`), the project cleans up afterwards (vscode-server.js) — in THIS queue entry
    // (awaited: the next entry only begins afterwards), with the same home of the creation and the same root of /proc.
    // Without a cause no docker (the clean-up checks by itself). Protected: the stored versions AND every one of this
    // list (`protectedAlongside`) — the one just placed never falls victim to the own clean-up, even if it is the oldest
    // by build time or storing it failed. Otherwise only `atReady` would hold the four per project, and the tick would
    // add one per new version from Microsoft.
    if (Object.values(results).some((r) => r.status === "ok")) {
      out.cleanUp = await cleanUpVscodeServer(pid, { home: creationHome, proc, protectedAlongside: list.map((v) => v.commit) });
    }
    return out;
  } catch (e) {
    const reason = e?.message || String(e);
    warning(`project ${pid}: failed — ${reason}`);
    return { status: "error", reason };
  }
}

// ONE version into ONE project (header, step 4): the look in B, then at most ONE exec. Never throws.
async function upfrontVersion(pid, name, { source, target }, { commit: c, entry }, { proc, capMs, data }) {
  let v = `? (${short(c)})`;
  try {
    const e = entry ?? cacheEntry(c, { data });
    if (!e) return { status: "no-tarball" };
    v = `${e.meta?.product || "?"} (${short(c)})`;
    const look = projectLook(source, c);
    if (!look.cause) return { status: look.alreadyThere ? "already-there" : "nothing", reason: look.reason };
    const t0 = Date.now();
    const command = ["sh", "-c", UPFRONT_SCRIPT, "cbase-vscode-upfront", target, c, proc, look.ino, touchStamp(e.meta?.buildTime), String(Date.now())];
    const stream = fs.createReadStream(e.file);
    let r;
    try { r = await execIn(name, command, { stdin: stream, capMs, maxBytes: OUTPUT_CAP_BYTES }); } finally { stream.destroy(); }
    const a = readUpfrontOutput(r.stdout);
    if (a.status === "finished") {
      row(`${v}: placed in project ${pid} in ${seconds(t0)} → ${target}/bin/${c}${look.reason === "empty" ? " (bin created — VS Code was never here)" : ""}${a.timeOpen ? " (build time not set)" : ""}`);
      return { status: "ok" };
    }
    if (a.status === "no-mount") {
      warning(`${v}: project ${pid} — ${target} is not a mount point in the project container (created before the mount existed, recreation pending); nothing placed`);
      return { status: "no-mount" };
    }
    if (a.status === "other-folder") {
      warning(`${v}: project ${pid} — ${target} is a different folder in the project container than ${source} in B (inode); nothing placed`);
      return { status: "other-folder" };
    }
    if (a.status === "lost") row(`${v}: project ${pid} — VS Code was faster, the own leftover is removed`);
    return { status: a.status };
  } catch (e) {
    const reason = e?.message || String(e);
    warning(`project ${pid}: failed (${v}) — ${reason}${e?.code === "CAP" ? ` (cap ${capMs} ms, estimated)` : ""}`);
    return { status: "error", reason };
  }
}

// ── the cycle and the tick ────────────────────────────────────────────────────────────────────────────────────────────

let cycleRunning = null;
let archReported = false; // the line "other architecture" once per process
/** Test seam: the running cycle (promise of the result) or `null`. */
export const runningCycle = () => cycleRunning;

/**
 * One cycle (header, steps 1–4). Never throws; at most one at a time (`running-already`).
 * @returns {Promise<{ status: string, newest?, used?, versions?, cleanUp?, projects?, step?, code?, reason?, failures? }>}
 *   `versions[<commit>]` names per version what happened: `roles` (newest, used), `fetch` (fresh, cache or error with
 *   step), `helper` (helperInB) and `projects[<id>]` (the result of this version in the project). `projects[<id>]` is the
 *   result of vscodeUpfrontForProject. An error while asking or fetching any version makes `status` "error" (`step`,
 *   `code`, `reason` of the first, all in `failures`) — the other versions run anyway.
 */
export function vscodeUpfrontCycle(opts = {}) {
  if (cycleRunning) return Promise.resolve({ status: "running-already" });
  const p = cycle(opts).finally(() => { cycleRunning = null; });
  cycleRunning = p;
  return p;
}

async function cycle({ api = updateApi(), versionTemplate = versionApiTemplate(), data, home = os.homedir(), proc = "/proc", creationHome, procContainer = "/proc", maxBytes, capMs, arch = archHere(), now } = {}) {
  try {
    if (!projectboxOps()) return { status: "no-ops" };
    if (upfrontTickMs() === 0) return { status: "off" };
    if (arch !== ARCH) {
      if (!archReported) warning(`off: this machine is ${arch}, Microsoft's server here is ${ARCH} (UPDATE_API) — nothing upfront, Dev Containers uploads by itself`);
      archReported = true;
      return { status: "other-architecture", arch };
    }
    if (serverEnds()) return { status: "serverEnd" };
    // The need, before Microsoft is asked (header, "WHEN"): the helper folder in B or a main instance with a finished
    // version. The used version (step 1b) is determined and stored BEFOREHAND — also without need, so that an old value
    // falls; it only counts with its helper in B, so it never lies outside the first case.
    const helper = helperExists(home);
    const heads = store.projectInstances().filter((z) => z.instance === MAIN && z.convertedAt);
    const used = usedVersion({ heads, home, ...(now === undefined ? {} : { now }) });
    const withVersion = heads.filter((z) => {
      const look = projectLook(vscodeServerLocations(z.projectId).source, null);
      if (look.cap) warning(`project ${z.projectId}: ${look.reason}`);
      return look.cause;
    });
    if (!helper && !withVersion.length) return { status: "no-need" };
    const result = { status: "ok", newest: null, used: used?.commit ?? null, versions: {}, cleanUp: null, projects: {} };
    const failures = [];
    const fails = (ev, step, e) => {
      const f = { step, code: e?.code ?? null, reason: e?.message || String(e) };
      failures.push(f);
      if (ev) ev.fetch = { status: "error", ...f };
    };

    // 1. The newest (Microsoft); its commit is the protected newest version of the clean-up.
    const list = [];
    let info = null;
    try { info = await questionNewest({ api }); } catch (e) {
      warning(`Microsoft not reached — ${e?.message || e}`);
      fails(null, "questions", e);
    }
    if (info) {
      result.newest = info.commit;
      if (String(store.getSetting(NEWEST_KEY, "") || "") !== info.commit) {
        store.setSetting(NEWEST_KEY, info.commit);
        row(`Microsoft names ${info.product || "?"} (${info.commit}) as the newest version — from now on it is protected in the clean-up`);
      }
      list.push({ commit: info.commit, info, roles: ["newest"] });
    }
    // 1b. The used one: if it is the newest, ONE version with two roles.
    if (used) {
      const equal = list.find((v) => v.commit === used.commit);
      if (equal) equal.roles.push("used");
      else list.push({ commit: used.commit, info: null, roles: ["used"] });
    }
    // 2. Fetch, version by version. What the cache keeps: each of these versions and every protected one (if the newest
    //    could not be asked for this time, yesterday's stays).
    const keep = [...new Set([...list.map((v) => v.commit), ...protectedVersions()])];
    for (const v of list) {
      const ev = { roles: v.roles, fetch: null, helper: null, projects: {} };
      result.versions[v.commit] = ev;
      if (!v.info) {
        // The used one: if it lies checked in the cache, B does not ask Microsoft (no download, no request per tick).
        const existing = cacheEntry(v.commit, { data });
        if (existing) { v.entry = existing; ev.fetch = { status: "cache" }; continue; }
        try { v.info = await questionVersion(v.commit, { template: versionTemplate }); } catch (e) {
          warning(`used version ${short(v.commit)}: not obtained from Microsoft — ${e?.message || e}`);
          fails(ev, "questions", e);
          continue;
        }
      }
      try {
        const h = await fetchTarball(v.info, { data, keep, ...(maxBytes ? { maxBytes } : {}), ...(capMs ? { capMs } : {}) });
        v.entry = h;
        ev.fetch = { status: h.fresh ? "fresh" : "cache" };
      } catch (e) {
        warning(`${v.info.product || "?"} (${short(v.commit)}): not fetched — ${e?.message || e}`);
        fails(ev, "fetch", e);
      }
    }
    const withTarball = list.filter((v) => v.entry);
    // 3. The helper in B, per version; then the clean-up there (protected: every version of this cycle and every protected one).
    if (helper) {
      for (const v of withTarball) {
        try { result.versions[v.commit].helper = await helperInB(v.commit, v.entry, { home, ...(capMs ? { capMs } : {}) }); } catch (e) {
          warning(`${v.entry.meta?.product || "?"} (${short(v.commit)}): helper not placed in B — ${e?.message || e}`);
          result.versions[v.commit].helper = { status: "error", reason: e?.message || String(e) };
        }
      }
      result.cleanUp = cleanUpHelper({ home, proc, shielded: keep });
    }
    // 4. EVERY converted main instance (not only those with a version) — vscodeUpfrontForProject itself refuses stopped
    //    and frozen ones and those under heavy load (stopped ones catch up at atReady). One after the other, through the
    //    ONE queue; a project that got something here cleans up in the same entry (`projects[<id>].cleanUp`).
    if (withTarball.length) {
      const versions = withTarball.map((v) => ({ commit: v.commit, entry: v.entry }));
      for (const z of heads) {
        if (serverEnds()) break;
        const r = await vscodeUpfrontForProject(z.projectId, {
          versions, proc: procContainer, ...(creationHome ? { home: creationHome } : {}), ...(capMs ? { capMs } : {}),
        });
        result.projects[z.projectId] = r;
        for (const v of withTarball) {
          result.versions[v.commit].projects[z.projectId] = r.versions?.[v.commit] ?? { status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
        }
      }
    }
    if (failures.length) {
      const [first] = failures;
      Object.assign(result, { status: "error", step: first.step, code: first.code, reason: first.reason, failures });
    }
    return result;
  } catch (e) {
    warning(`cycle failed — ${e?.message || e}`);
    return { status: "error", reason: e?.message || String(e) };
  }
}

let tick = null;
let catchUp = null;
let catchUpAttempts = 0;
// Transient (see CATCH_UP_MS): Microsoft not reached, or a network, HTTP or time error while fetching — never an error in
// the CONTENT (CONTENT_ERROR, DENIED: the same answer would bring the same) or in the cache.
const TRANSIENT_FETCH = new Set(["NETWORK", "HTTP", "CAP"]);
// Any failure of the cycle (`failures` — the newest OR the used version) is enough; an error with the used one counts
// like one with the newest.
const transient = (r) => r?.status === "error"
  && (r.failures ?? [r]).some((f) => f.step === "questions" || (f.step === "fetch" && TRANSIENT_FETCH.has(f.code)));

let tickObserver = null;
/** Test seam: `fn({ result, scheduled, attempts })` after every decision of the tick (null = none) — so a test waits for
 *  the event instead of the clock, and a missing catch-up is red instead of a hang. */
export function setUpfrontTickObserver(fn) { tickObserver = fn; }

// After a cycle of the tick: catch up or not (see CATCH_UP_MS).
function decide(r) {
  if (r?.status === "running-already") return;
  if (!transient(r)) { catchUpAttempts = 0; return; }
  const ms = catchUpMs();
  if (!tick || catchUp || ms === 0) return;
  if (catchUpAttempts >= CATCH_UP_ATTEMPTS) {
    warning(`${CATCH_UP_ATTEMPTS} catch-up attempts failed — next attempt in the tick (${Math.round(upfrontTickMs() / 60_000)} min)`);
    catchUpAttempts = 0;
    return;
  }
  catchUpAttempts += 1;
  row(`failed transiently — next attempt in ${Math.max(1, Math.round(ms / 60_000))} min (${catchUpAttempts} of ${CATCH_UP_ATTEMPTS})`);
  catchUp = setTimeout(() => { catchUp = null; tickCycle(); }, ms);
  catchUp.unref?.();
}

// One cycle of the tick (restart grace, interval, catch-up). Never throws.
function tickCycle() {
  return vscodeUpfrontCycle().then((r) => {
    try { decide(r); } catch (e) { warning(`catch-up not scheduled — ${e?.message || e}`); }
    try { tickObserver?.({ result: r, ...upfrontCatchUp() }); } catch { /* test seam */ }
    return r;
  }, () => null);
}

/** Hook "restartGrace" (server.js, name "vscode-upfront"): the tick on the server run and one cycle at once — in the
 *  background, returns nothing (holds neither start nor quiet). Nothing without the ops marker. After a transient error it
 *  catches up (CATCH_UP_MS, at most CATCH_UP_ATTEMPTS in a row). */
export function vscodeUpfrontRestartGrace() {
  if (!projectboxOps()) return;
  const ms = upfrontTickMs();
  if (ms === 0) { row("off (CBASE_VSCODE_UPFRONT_MS=0)"); return; }
  if (!tick) {
    tick = setInterval(() => { tickCycle(); }, ms);
    tick.unref?.();
  }
  tickCycle();
}
/** The tick ends with the server run (server.js, `close`) — together with a scheduled catch-up. */
export function stopVscodeUpfront() {
  if (tick) clearInterval(tick);
  tick = null;
  if (catchUp) clearTimeout(catchUp);
  catchUp = null;
  catchUpAttempts = 0;
}
/** Test seam: whether a catch-up is scheduled, and which attempt it is. */
export const upfrontCatchUp = () => ({ scheduled: catchUp !== null, attempts: catchUpAttempts });
/** Test seam: whether the tick is running. */
export const upfrontTickRunning = () => tick !== null;
