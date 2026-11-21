// Guards for the upfront fetch of the VS Code server (projectbox/vscode-upfront.js). Cleaning up with the protected version is held
// by projectbox-vscode-server.test.js.
//
// No network, no clock: Microsoft is an HTTP endpoint on 127.0.0.1 in this process, the tarball is built in the test from a temp
// folder (layout like the real one: top level `vscode-server-linux-x64/`, GNU headers including the `L` long name, mtime of the
// top level = the measured build time 2026-10-06 08:40:24 UTC), caps run through the clock seams (advanceUpfrontCap, docker.js
// advanceCap). The fake docker runs `docker exec` LOCALLY — so the script must protect itself (mount point and inode), and
// that is exactly what (R) checks.
//
// Held:
//   (T) checkTarball: the good tarball -> entries, build time, product; RED (throw, nothing unpacked): a link, a hard link, `..`, a
//       name outside the top level, `node` without the x bit, `bin/code-server` missing, `product.json` with another commit, a
//       falsified header checksum, a truncated archive, the cap on entries.
//   (F) questionNewest/checkResponse: commit 40 base-16 characters, SHA-256 64, url https (http only on loopback, when the endpoint
//       is); HTTP error, no JSON, answer over the cap — each a throw with a reason.
//   (H) fetchTarball: fetched, checked, meta beside it; a second time NO download; wrong checksum => nothing in the cache, no
//       partial file; size cap (announced and streamed) => the same; wrong layout => the same; the time cap (clock seam) => the
//       same; the two newest stay in the cache; a leftover `*.part` falls at the next fetch. REJECTED: a wrong checksum blocks after
//       three attempts, size cap and layout at once — no fourth download; a new checksum, another state of the check and a larger
//       cap load again; the time cap remembers nothing; the marker of another version falls on fetching, its own after a success.
//   (B) helperInB: without `~/.vscode-remote-containers/bin` (or as a link) NOTHING; otherwise EXACTLY LICENSE, node,
//       node_modules/node-pty (list against the source), mtime = build time, no leftover; present => `already-there`.
//       cleanUpHelper: half-finished ones after 60 min, the three newest finished ones and the protected one stay, never a running
//       one, never a link/a file/a foreign name; without a readable /proc nothing finished (built-in counter-test: a /proc without
//       the process deletes the running one); a nested leftover `bin/<c>/<c>_<ms>` falls after 60 min, also in the protected version.
//   (S) UPFRONT_SCRIPT with a real `sh` and the tarball as stdin: layout = `--strip-components 1` (list against the source), mtime =
//       build time, no leftover; `already-there`; `no-mount`; `other-folder`; `bin` or `.vscode-server` as a link => nothing (not at
//       the link's target either); a race BEFORE renaming and a `mv -n` INTO a just-created folder => `lost`, the own leftover is
//       gone; broken tar and wrong layout => exit 1 without leftover; invalid arguments => exit 2.
//   (A) vscodeUpfrontForProject through the fake docker: without `bin/`, without a finished version, with the version already there,
//       with `bin` as a link — NO docker call; otherwise exactly `docker exec -i -u agent cbase-p-<id> sh -c <script> …` and the
//       layout in the project = `--strip-components 1`; copy, no operation, off (0), not converted, not ready, without a protected
//       version, without a tarball, not x64: nothing; `no-mount` as a warning; `running-already` and the cap of the exec as a
//       warning, never a throw; the cap of the look in B is a warning with the project id.
//   (D) vscodeUpfrontCycle: without need NO request to Microsoft; with need ask, fetch, helper, clean up, projects — the protected
//       version is in app_settings afterwards; a second pass does NOT load again and calls no docker; HTTP 500 => `error` (step
//       ask); without operation or off => nothing; not x64 => nothing, no request, one warning per process; a project at the cap of
//       the look does not count toward the need, with a warning.
//   (N) Catching up (after "fetch failed" on the first start): after a temporary error one attempt after CATCH_UP_MS, at most three
//       in a row, then a warning and the tick; a success resets; a content error, the switch 0 and `close` do not catch up. A network
//       error names its cause ((F), ECONNREFUSED).
//   (R) server.js: the restart hook "vscode-upfront" stands before "project-resumption", without operation no tick; with operation a
//       tick that `close` ends; the consumer at atReady fetches upfront after cleaning up — and without test seams (real /proc) the
//       script writes NOTHING in the test (no mount point). The names CACHE_FOLDER and HELPER_FOLDER stand in creation.js
//       `neverMounted`.
//   All projects + the Mac's version:
//   (F) questionVersion: exactly the asked commit (another `version` throws), checked like the newest; versionApi inserts only 40
//       base-16 characters; the default is the measured address.
//   (H) fetchTarball with `keep`: tarball and "rejected" marker of a needed version stay (built-in counter-test without).
//   (B) cleanUpHelper with two protected — both stay; a single value instead of the list => `error` with a warning, nothing falls.
//   (S) if `bin` is missing the script creates it (a real folder, then put in place) — not without a mount point, not through a
//       dangling link (`no-folder`, nothing at the target); a failed mkdir => exit 1 without leftover; mkdir losing a race for `bin`
//       => still `finished`.
//   (A) without `bin` a cause (line "bin created"); two protected => each that is missing, in ONE exec per version, status `mixed`; a
//       result that hangs on the project (no-mount) leaves the second untried (one exec, not two).
//   (D) every ready main is a target — also at the cap of the look (the look with a commit does not read `bin`).
//   (V) usedVersion: the newest trace over all converted mains (stopped ones too), at most 14 days, saved only on change; links (file,
//       `data`, `Machine`), folders, foreign names, the future, copies, unconverted ones and the cap do not count. The pass with a used
//       version: both into EVERY ready main (also one without `bin`), the used one from the cache without a request, a version with
//       two roles, an error of the used one does not stop the newest.
//   Cleanup after placing and trace check:
//   (D) after placing, the project cleans up (upfrontProject -> vscode-server.js cleanUpVscodeServer): a project with four remaining
//       and the used one falls to the limit (two protected + two newest remaining); the just-placed newest (older by build time than
//       the rest) and the used one (the oldest) stay; the script gets "newest,used". Without placing no cleanup and no docker;
//       without a cause "nothing" without docker ((A), (D), (V) pass). THE QUEUE: the cleanup runs in the same entry — if its exec
//       hangs at the gate the entry is not over (`runningUpfront`), and a project queued meanwhile comes only after (order of the
//       exec calls). A just-placed, NOT saved version (the path with a list) is protected on top (`protectedAlongside`), also as oldest.
//   (V) a trace counts only if B knows its version in the Dev Containers helper folder: without a helper folder none (a saved value
//       falls, the line names the reason); no helper, a helper as a link, as a file, only half-finished, `bin` or
//       `.vscode-remote-containers` as a link — none; counter-test built in (the real helper). A newer foreign trace in the same
//       project does not hide the older real one. The named residual risk is recorded as a test: a foreign trace on a KNOWN
//       version (the newest) displaces the real one. In the pass: a trace without a helper => no need, no request, nothing saved
//       ((V) pass); (N) puts the Mac version's helper in front of the trace.
//   (N) a temporary error of ONLY the used one catches up; a stopped main supplies the trace but is no target.
//   (R) the consumer at atReady reports per version.
//
// COUNTER-TESTS: see the map at the end.
//
// Run (only with the gate deadlines):
//   CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//   CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/projectbox-vscode-upfront.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { DIRS } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { VSCODE_SERVER, containerName, neverMounted } from "../electron/server/projectbox/creation.js";
import { advanceCap } from "../electron/server/projectbox/docker.js";
import { createInstance } from "../electron/server/projectbox/instance.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { CLEAN_UP_SCRIPT, USED_KEY, NEWEST_KEY, protectedVersions, runningCleanUp } from "../electron/server/projectbox/vscode-server.js";
import {
  ARCH, USED_DAYS, CACHE_FOLDER, HELPER_FOLDER, HELPER_PARTS, TOPMOST, VERSION_API, UPFRONT_SCRIPT, denied, checkResponse, usedVersion as usedVersionRaw, cacheEntry,
  questionNewest, questionVersion, helperInB, fetchTarball, projectLook, readTrace, versionApi, versionApiTemplate,
  CATCH_UP_ATTEMPTS, runningCycle, runningUpfront, checkStatusOfThisFile, checkTarball, cleanUpHelper, touchStamp, readUpfrontOutput, advanceUpfrontCap,
  upfrontTickRunning, upfrontTickMs, setUpfrontTickObserver, upfrontCatchUp, vscodeUpfrontCycle, vscodeUpfrontForProject, vscodeUpfrontRestartGrace, stopVscodeUpfront,
} from "../electron/server/projectbox/vscode-upfront.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { restoreInstance } from "../electron/server/projectbox/restore.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

const HEX = (z, n = 40) => z.repeat(n);
const C = "2a59476c9bfcb90b3ddc372c36762471b7dfad1c"; // the measured commit (1.141.0) — here just a name
const C2 = HEX("b");
const C3 = HEX("c");
const BUILD_TIME = 1791276024; // 2026-10-06 08:40:24 UTC: the mtime of the top level of the real tarball (octal 15261131770)
const HOUR = 3600;
const ON = { CBASE_VSCODE_UPFRONT_MS: "21600000" }; // withOps otherwise switches the upfront fetch off (projectbox-scenario.mjs)

// ── The tarball ───────────────────────────────────────────────────────────────────────────────────────────────────────

// A folder like the content of `vscode-server-linux-x64/` (shrunk): helper parts, a foreign module, bin/, out/ with a path over 100
// characters (GNU long name), package.json, product.json with `commit`.
const LANG = "out/vs/workbench/contrib/terminal/node/one-very-long-folder-name-that-goes-beyond-one-hundred-characters/and-continue";
function sourceFolder(root, { commit = C, without = [], mode = {} } = {}) {
  const q = path.join(root, `source-${crypto.randomBytes(3).toString("hex")}`);
  const files = {
    LICENSE: ["MIT\n", 0o644], node: ["#!/bin/sh\necho node\n", 0o755],
    "node_modules/node-pty/package.json": ['{"name":"node-pty"}\n', 0o644],
    "node_modules/node-pty/lib/index.js": ["module.exports = 1;\n", 0o644],
    "node_modules/node-pty/build/Release/pty.node": ["binary\n", 0o755],
    "node_modules/other/index.js": ["foreign\n", 0o644],
    "bin/code-server": ["#!/bin/sh\n", 0o755], "bin/helpers/check-requirements.sh": ["#!/bin/sh\nexit 0\n", 0o755],
    "out/server-main.js": ["// server\n", 0o644], [`${LANG}/x.js`]: ["// lang\n", 0o644],
    "package.json": ['{"name":"code-server"}\n', 0o644],
    "product.json": [`${JSON.stringify({ commit, version: "1.141.0", quality: "stable" })}\n`, 0o644],
  };
  for (const [rel, [content, m]] of Object.entries(files)) {
    if (without.includes(rel)) continue;
    const p = path.join(q, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    fs.chmodSync(p, mode[rel] ?? m);
  }
  const folder = (d) => { fs.chmodSync(d, 0o755); for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.lstatSync(p).isDirectory()) folder(p); } };
  folder(q);
  return q;
}

const okt = (n, l) => `${n.toString(8).padStart(l - 1, "0")}\0`;
function header({ name, type, size = 0, mode = 0o644, mtime = BUILD_TIME, target = "" }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(okt(mode, 8), 100, "latin1");
  h.write(okt(1000, 8), 108, "latin1");
  h.write(okt(1000, 8), 116, "latin1");
  h.write(okt(size, 12), 124, "latin1");
  h.write(okt(mtime, 12), 136, "latin1");
  h.fill(0x20, 148, 156);
  h.write(type, 156, "latin1");
  h.write(target, 157, 100, "utf8");
  h.write("ustar  \0", 257, "latin1"); // GNU like the real one
  h.write("agent", 265, "latin1");
  h.write("agent", 297, "latin1");
  let s = 0;
  for (const b of h) s += b;
  h.write(`${s.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}
const padding = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tarBytes(entries) {
  const parts = [];
  for (const e of entries) {
    const content = e.content ?? Buffer.alloc(0);
    let name = e.name;
    if (Buffer.byteLength(name) > 100) {
      const lang = Buffer.from(`${name}\0`);
      parts.push(header({ name: "././@LongLink", type: "L", size: lang.length, mtime: 0 }), padding(lang));
      name = name.slice(0, 100);
    }
    parts.push(header({ ...e, name, size: e.type === "0" ? content.length : 0 }));
    if (e.type === "0") parts.push(padding(content));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
// The entries of a folder under TOPMOST/ (folder first, then its content, sorted); the top level carries the build time.
function entriesFrom(q, { top = TOPMOST } = {}) {
  const output = [{ name: `${top}/`, type: "5", mode: 0o755, mtime: BUILD_TIME }];
  const go = (rel) => {
    for (const n of fs.readdirSync(rel ? path.join(q, rel) : q).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(path.join(q, r));
      if (st.isDirectory()) { output.push({ name: `${top}/${r}/`, type: "5", mode: st.mode & 0o7777, mtime: BUILD_TIME - 60 }); go(r); }
      else output.push({ name: `${top}/${r}`, type: "0", mode: st.mode & 0o7777, content: fs.readFileSync(path.join(q, r)), mtime: BUILD_TIME - 60 });
    }
  };
  go("");
  return output;
}
const tgz = (entries) => zlib.gzipSync(tarBytes(entries));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// The list of a folder like `find -printf '%y %m %s %p'` (folder sizes do not count — file system).
function list(root) {
  const output = {};
  const go = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    const st = fs.lstatSync(abs);
    const type = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "?";
    if (rel) output[rel] = `${type} ${(st.mode & 0o7777).toString(8)}${type === "f" ? ` ${st.size}` : ""}`;
    if (type === "d") for (const n of fs.readdirSync(abs).sort()) go(rel ? `${rel}/${n}` : n);
  };
  go("");
  return output;
}
// The helper's excerpt of the source list: the three parts with their content and their parent folders.
function helperList(q) {
  const all = list(q);
  const parent = new Set(HELPER_PARTS.flatMap((t) => t.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  return Object.fromEntries(Object.entries(all).filter(([rel]) => parent.has(rel) || HELPER_PARTS.some((t) => rel === t || rel.startsWith(`${t}/`))));
}
const mtimeS = (p) => Math.round(fs.lstatSync(p).mtimeMs / 1000);

function withTemp(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-upfront-")));
  const finished = () => fs.rmSync(root, { recursive: true, force: true });
  let r;
  try { r = fn(root); } catch (e) { finished(); throw e; }
  if (r && typeof r.then === "function") return r.finally(finished);
  finished();
  return r;
}

// ── Microsoft in the test ─────────────────────────────────────────────────────────────────────────────────────────────────

// An endpoint on 127.0.0.1: `/api` answers `z.response` (or the next status from `z.apiFollowUp`, otherwise `z.apiStatus`), `/t/<name>`
// delivers `z.files[name]`; `/v/<commit>` (the version interface) answers `z.versions[commit]` (the next status from
// `z.versionFollowUp` first; unknown => 404); `z.hang` sends the head and a piece, then nothing more (z.hangs then resolves).
// `z.requests` counts per path.
async function endpoint() {
  const z = { response: null, apiStatus: 0, apiFollowUp: [], versions: {}, versionFollowUp: [], files: {}, hang: false, requests: [], longResponse: false };
  let hangsR;
  z.hangs = new Promise((r) => { hangsR = r; });
  const server = http.createServer((req, res) => {
    z.requests.push(req.url);
    const v = /^\/v\/(.+)$/.exec(req.url || "");
    if (v) {
      const status = z.versionFollowUp.length ? z.versionFollowUp.shift() : 0;
      if (status) { res.writeHead(status); res.end("broken"); return; }
      const a = z.versions[v[1]];
      if (!a) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(a));
      return;
    }
    if (req.url === "/api") {
      const status = z.apiFollowUp.length ? z.apiFollowUp.shift() : z.apiStatus;
      if (status) { res.writeHead(status); res.end("broken"); return; }
      const text = z.longResponse ? `{"x":"${"a".repeat(70 * 1024)}"}` : typeof z.response === "string" ? z.response : JSON.stringify(z.response);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
      return;
    }
    const m = /^\/t\/(.+)$/.exec(req.url || "");
    const b = m ? z.files[m[1]] : null;
    if (!b) { res.writeHead(404); res.end(); return; }
    if (z.hang) { res.writeHead(200, { "content-length": String(b.length) }); res.write(b.subarray(0, 100)); hangsR(); return; }
    if (z.withoutLength) { res.writeHead(200); res.end(b); return; }
    res.writeHead(200, { "content-length": String(b.length) });
    res.end(b);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  z.api = `${base}/api`;
  // An answer like Microsoft's for the tarball `b` under the name `name`.
  z.offer = (name, b, { commit = C, sha256 = sha(b) } = {}) => {
    z.files[name] = b;
    z.response = { url: `${base}/t/${name}`, name: "1.141.0", version: commit, productVersion: "1.141.0", sha256hash: sha256, hash: "x" };
    return { commit, sha256, url: z.response.url, product: "1.141.0", api: z.api };
  };
  // A SPECIFIC version under `/v/<commit>` (the answer names `version`, default the same commit).
  z.template = `${base}/v/{commit}`;
  z.offerVersion = (name, b, { commit, version = commit, sha256 = sha(b) } = {}) => {
    z.files[name] = b;
    z.versions[commit] = { url: `${base}/t/${name}`, name: "1.141.0", version, productVersion: "1.141.0", sha256hash: sha256, hash: "x" };
    return { commit, sha256, url: z.versions[commit].url, product: "1.141.0", api: z.template.replace("{commit}", commit) };
  };
  z.count = (filePath) => z.requests.filter((a) => a === filePath).length;
  z.close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return z;
}
async function withEndpoint(fn) {
  const z = await endpoint();
  try { return await fn(z); } finally { await z.close(); }
}

// Captures console.warn and console.log for the duration of `fn`.
async function withLog(fn) {
  const old = { warn: console.warn, log: console.log };
  const warnings = [];
  const rows = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
  console.log = (...a) => { rows.push(a.map(String).join(" ")); };
  try { return await fn(warnings, rows); } finally { console.warn = old.warn; console.log = old.log; }
}

const encoded = (p) => p.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
// A /proc to read: per process `cmdline`; `self/mountinfo` with the mount points `mounts` (field 5, encoded).
function proc(root, list2 = [], { mounts = [] } = {}) {
  fs.mkdirSync(path.join(root, "self"), { recursive: true });
  for (const p of list2) {
    const d = path.join(root, String(p.pid));
    fs.mkdirSync(d);
    if (p.cmdline) fs.writeFileSync(path.join(d, "cmdline"), p.cmdline.map((a) => `${a}\0`).join(""));
    if (p.exe) fs.symlinkSync(p.exe, path.join(d, "exe"));
  }
  const rows = ["22 1 0:21 / / rw,relatime master:1 - overlay overlay rw",
    ...mounts.map((m, i) => `${100 + i} 22 8:1 /var/lib/source-${i} ${encoded(m)} rw,relatime - ext4 /dev/sda1 rw`)];
  fs.writeFileSync(path.join(root, "self", "mountinfo"), `${rows.join("\n")}\n`);
  return root;
}
const inoOf = (p) => { try { return String(fs.lstatSync(p, { bigint: true }).ino); } catch { return "0"; } };
function version(p, ageS) {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "node"), `${path.basename(p)}\n`);
  const t = Date.now() / 1000 - ageS;
  fs.utimesSync(p, t, t);
  return p;
}
const content = (d) => fs.readdirSync(d).sort();

// ── (T) checkTarball ────────────────────────────────────────────────────────────────────────────────────────────────

test("(T) checkTarball: the good tarball — entries, build time, product; every inadmissible layout throws with a reason", async () => {
  await withTemp(async (root) => {
    const q = sourceFolder(root);
    const gut = entriesFrom(q);
    const file = (name, b) => { const f = path.join(root, name); fs.writeFileSync(f, b); return f; };
    const r = await checkTarball(file("good.tgz", tgz(gut)), { commit: C });
    assert.deepEqual(r, { entries: gut.length, buildTime: BUILD_TIME, product: "1.141.0" });
    assert.ok(tarBytes(gut).includes(Buffer.from("././@LongLink")), "the tarball carries no GNU long name");

    const raises = async (name, entries, pattern, opts = {}) => {
      await assert.rejects(checkTarball(file(`${name}.tgz`, Buffer.isBuffer(entries) ? entries : tgz(entries)), { commit: C, ...opts }), pattern, name);
    };
    await raises("reference", [...gut, { name: `${TOPMOST}/bin/link`, type: "2", target: "/etc/passwd" }], /type "2"/);
    await raises("hardlink", [...gut, { name: `${TOPMOST}/bin/hart`, type: "1", target: `${TOPMOST}/node` }], /type "1"/);
    await raises("dotdot", [...gut, { name: `${TOPMOST}/../out`, type: "0", content: Buffer.from("x") }], /"\.\." part/);
    await raises("outside", [...gut, { name: "elsewhere/x", type: "0", content: Buffer.from("x") }], /outside vscode-server-linux-x64/);
    await raises("absolute", [...gut, { name: "/etc/x", type: "0", content: Buffer.from("x") }], /inadmissible name/);
    await raises("without-x", entriesFrom(sourceFolder(root, { mode: { node: 0o644 } })), /node \(executable\)/);
    await raises("without-code-server", entriesFrom(sourceFolder(root, { without: ["bin/code-server"] })), /bin\/code-server/);
    await raises("other-commit", entriesFrom(sourceFolder(root, { commit: C2 })), /product\.json carries the commit bbbbbbbb…, the answer named 2a59476c…/);
    const raw = tarBytes(gut);
    const falsified = Buffer.from(raw);
    falsified[600] ^= 0x01; // in the second header (name), the checksum stays
    await raises("checksum", zlib.gzipSync(falsified), /checksum of a header/);
    await raises("cutOff", zlib.gzipSync(raw.subarray(0, raw.length - 2048)), /truncated/);
    await raises("cap", gut, /more than 5 entries/, { maxEntries: 5 });
  });
});

// ── (F) Asking ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("(F) questionNewest/checkResponse: commit, SHA-256 and https checked; HTTP error, no JSON and an answer that is too large throw", async () => {
  const api = "https://update.example/api";
  const gut = { url: "https://dl.example/x.tgz", version: C, sha256hash: HEX("a", 64), productVersion: "1.141.0" };
  assert.deepEqual(checkResponse(gut, api), { commit: C, sha256: HEX("a", 64), url: gut.url, product: "1.141.0", api });
  for (const [field, value, pattern] of [
    ["version", HEX("a", 39), /"version" is not a commit/], ["version", HEX("A"), /"version" is not a commit/],
    ["sha256hash", HEX("a", 63), /"sha256hash" is not/], ["url", "http://dl.example/x.tgz", /"url" is not https/],
    ["url", "http://127.0.0.1/x.tgz", /"url" is not https/], // loopback http only if the endpoint is http on loopback too
    ["url", "file:///etc/passwd", /"url" is not https/],
  ]) assert.throws(() => checkResponse({ ...gut, [field]: value }, api), pattern, `${field}=${value}`);
  assert.throws(() => checkResponse([], api), /not an object/);
  await withEndpoint(async (z) => {
    z.offer("a.tgz", Buffer.from("x"));
    const info = await questionNewest({ api: z.api });
    assert.equal(info.commit, C);
    assert.equal(info.url, z.response.url);
    z.apiStatus = 500;
    await assert.rejects(questionNewest({ api: z.api }), /HTTP 500/);
    z.apiStatus = 0;
    z.response = "no json";
    await assert.rejects(questionNewest({ api: z.api }), /not JSON/);
    z.longResponse = true;
    await assert.rejects(questionNewest({ api: z.api }), /more than 65536 bytes/);
  });
  await assert.rejects(questionNewest({ api: "http://update.example/api" }), /not https/);
  // A network error names its cause (undici carries it only in `cause`) — otherwise the log would say only "fetch failed".
  const to = http.createServer();
  await new Promise((r) => to.listen(0, "127.0.0.1", r));
  const port = to.address().port;
  await new Promise((r) => to.close(r));
  await assert.rejects(questionNewest({ api: `http://127.0.0.1:${port}/api` }), (e) => e.code === "NETWORK" && /^update interface: fetch failed \(ECONNREFUSED/.test(e.message));
});

test("(F) questionVersion: exactly the asked commit (another `version` throws), checked like the newest; versionApi inserts only 40 base-16 characters; the default is the measured address", async () => {
  assert.equal(VERSION_API, "https://update.code.visualstudio.com/api/versions/commit:{commit}/server-linux-x64/stable");
  assert.equal(versionApi(C, VERSION_API), `https://update.code.visualstudio.com/api/versions/commit:${C}/server-linux-x64/stable`);
  for (const wrong of ["", HEX("a", 39), HEX("A"), `${HEX("a")}/../x`, "../../api/update"]) {
    assert.throws(() => versionApi(wrong, VERSION_API), (e) => e.code === "RESPONSE" && /not a commit/.test(e.message), JSON.stringify(wrong));
  }
  await withEndpoint(async (z) => {
    z.offerVersion("v.tgz", Buffer.from("x"), { commit: C2 });
    const info = await questionVersion(C2, { template: z.template });
    assert.deepEqual([info.commit, info.url, info.api], [C2, z.versions[C2].url, `${z.template.replace("{commit}", C2)}`]);
    assert.equal(z.count(`/v/${C2}`), 1);
    // Microsoft names a DIFFERENT version than the asked one: throw (otherwise another server would lie under bin/<C2>).
    z.offerVersion("w.tgz", Buffer.from("x"), { commit: C3, version: C });
    await assert.rejects(questionVersion(C3, { template: z.template }), (e) => e.code === "RESPONSE" && /"version" is 2a59476c…, asked for cccccccc…/.test(e.message));
    // Unknown (404), network: throw with reason and code.
    await assert.rejects(questionVersion(HEX("d"), { template: z.template }), (e) => e.code === "HTTP" && /^version interface: HTTP 404/.test(e.message));
    z.versionFollowUp = [500];
    await assert.rejects(questionVersion(C2, { template: z.template }), (e) => e.code === "HTTP" && /HTTP 500/.test(e.message));
    // The same check of the answer as for the newest: http is allowed only on loopback if the endpoint is too.
    z.versions[C2] = { ...z.versions[C2], url: "http://dl.example/x.tgz" };
    await assert.rejects(questionVersion(C2, { template: z.template }), /"url" is not https/);
  });
  await assert.rejects(questionVersion(C, { template: "http://update.example/v/{commit}" }), /not https/);
});

// ── (H) Fetching ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(H) fetchTarball: fetched and checked, no second download; wrong checksum, size and time cap, wrong layout => nothing in the cache and no partial file; two stay", async () => {
  await withTemp(async (root) => {
    const data = path.join(root, "data");
    const cache = path.join(data, CACHE_FOLDER);
    const b = tgz(entriesFrom(sourceFolder(root)));
    await withEndpoint(async (z) => {
      const info = z.offer("good.tgz", b);
      const r = await withLog(() => fetchTarball(info, { data }));
      assert.equal(r.fresh, true);
      assert.equal(r.file, path.join(cache, `${C}.tar.gz`));
      assert.deepEqual(fs.readFileSync(r.file), b);
      assert.deepEqual({ ...r.meta, fetchedAt: 0, entries: 0 }, { commit: C, sha256: sha(b), bytes: b.length, buildTime: BUILD_TIME, product: "1.141.0", entries: 0, fetchedAt: 0 });
      assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
      assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
      assert.equal(z.count("/t/good.tgz"), 1);
      const second = await fetchTarball(info, { data });
      assert.equal(second.fresh, false);
      assert.equal(z.count("/t/good.tgz"), 1, "a checked tarball was loaded a second time");
      assert.ok(cacheEntry(C, { data }));

      // After every content error exactly ONE marker `<commit>.denied` stands beside the good tarball (those of other versions fall).
      const onlyThe = (marker) => assert.deepEqual(content(cache), [`${C}.json`, `${C}.tar.gz`, ...(marker ? [`${marker}.denied`] : [])].sort());
      // Wrong checksum (the answer names another): discarded, no partial file — three attempts, then blocked as long as Microsoft
      // names the same checksum.
      const wrong = z.offer("wrong.tgz", b, { commit: C2, sha256: HEX("0", 64) });
      await assert.rejects(fetchTarball(wrong, { data }), (e) => e.code === "CHECKSUM" && /attempt 1 of 3/.test(e.message));
      onlyThe(C2);
      await assert.rejects(fetchTarball(wrong, { data }), (e) => e.code === "CHECKSUM" && /attempt 2 of 3/.test(e.message));
      await assert.rejects(fetchTarball(wrong, { data }), (e) => e.code === "CHECKSUM" && /remembered as denied/.test(e.message));
      assert.equal(z.count("/t/wrong.tgz"), 3);
      await assert.rejects(fetchTarball(wrong, { data }), (e) => e.code === "DENIED" && /SHA-256/.test(e.message));
      assert.equal(z.count("/t/wrong.tgz"), 3, "a rejected version was loaded again");
      assert.deepEqual([denied(C2, { data }).code, denied(C2, { data }).attempts], ["CHECKSUM", 3]);
      onlyThe(C2);
      // A NEW checksum of the same version is a new answer: loaded, counting restarts.
      const wrong2 = z.offer("wrong.tgz", b, { commit: C2, sha256: HEX("1", 64) });
      await assert.rejects(fetchTarball(wrong2, { data }), (e) => e.code === "CHECKSUM" && /attempt 1 of 3/.test(e.message));
      assert.equal(z.count("/t/wrong.tgz"), 4);
      // A marker under ANOTHER state of the check (a deploy in between) does not block.
      const markerFile = path.join(cache, `${C2}.denied`);
      const real = fs.readFileSync(markerFile, "utf8");
      fs.writeFileSync(markerFile, JSON.stringify({ ...JSON.parse(real), attempts: 9, status: "0000000000000000" }));
      await assert.rejects(fetchTarball(wrong2, { data }), (e) => e.code === "CHECKSUM" && /attempt 1 of 3/.test(e.message));
      assert.equal(z.count("/t/wrong.tgz"), 5, "a marker of another state blocked");
      assert.equal(JSON.parse(fs.readFileSync(markerFile, "utf8")).status, checkStatusOfThisFile());
      assert.match(checkStatusOfThisFile(), /^[0-9a-f]{16}$/);
      // Size cap: announced (content-length) — blocks at once, but only for a cap that is not larger.
      const large = z.offer("large.tgz", b, { commit: C2 });
      await assert.rejects(fetchTarball(large, { data, maxBytes: b.length - 1 }), (e) => /announced/.test(e.message) && /remembered as denied/.test(e.message));
      onlyThe(C2);
      await assert.rejects(fetchTarball(large, { data, maxBytes: b.length - 2 }), (e) => e.code === "DENIED");
      assert.equal(z.count("/t/large.tgz"), 1);
      // Streamed (without length), another version — the marker of C2 falls in the process.
      z.withoutLength = true;
      const large3 = z.offer("large.tgz", b, { commit: C3 });
      await assert.rejects(fetchTarball(large3, { data, maxBytes: b.length - 1 }), /more than \d+ bytes/);
      z.withoutLength = false;
      onlyThe(C3);
      // A LARGER cap loads again (here the layout then fails: product.json carries C) — and that blocks at once.
      await assert.rejects(fetchTarball(large3, { data }), (e) => e.code === "BUILD" && /remembered as denied/.test(e.message));
      assert.equal(z.count("/t/large.tgz"), 3);
      await assert.rejects(fetchTarball(large3, { data }), (e) => e.code === "DENIED" && /product\.json/.test(e.message));
      assert.equal(z.count("/t/large.tgz"), 3, "a wrong layout was loaded again");
      onlyThe(C3);
      // Wrong layout (product.json with another commit) with a matching checksum.
      const different = z.offer("different.tgz", tgz(entriesFrom(sourceFolder(root, { commit: C3 }))), { commit: C2 });
      await assert.rejects(fetchTarball(different, { data }), (e) => e.code === "BUILD");
      onlyThe(C2);
      // The time cap through the clock seam: the download hangs after the first piece — it remembers NOTHING (the clock is no content).
      z.hang = true;
      const hangsInfo = z.offer("hangs.tgz", b, { commit: C3 });
      const hangs = fetchTarball(hangsInfo, { data, capMs: 3_600_000 });
      await z.hangs;
      assert.ok(advanceUpfrontCap() >= 1, "no cap ran");
      await assert.rejects(hangs, (e) => e.code === "CAP" && /cap of 3600000 ms/.test(e.message));
      z.hang = false;
      onlyThe();
      assert.equal(denied(C3, { data }), null);
      // A leftover `*.part` of an aborted run falls at the next fetch; the two newest stay in the cache.
      fs.writeFileSync(path.join(cache, `${C3}.tar.gz.part`), "leftover");
      const t = Date.now() / 1000;
      fs.utimesSync(path.join(cache, `${C}.tar.gz`), t - 200, t - 200);
      const b2 = tgz(entriesFrom(sourceFolder(root, { commit: C2 })));
      // A marker of the same version (another checksum) falls with the successful fetch.
      fs.writeFileSync(path.join(cache, `${C2}.denied`), real);
      await withLog(() => fetchTarball(z.offer("b2.tgz", b2, { commit: C2 }), { data }));
      assert.equal(denied(C2, { data }), null, "the marker stayed after a successful fetch");
      fs.utimesSync(path.join(cache, `${C2}.tar.gz`), t - 100, t - 100);
      assert.deepEqual(content(cache), [`${C2}.json`, `${C2}.tar.gz`, `${C}.json`, `${C}.tar.gz`].sort());
      const b3 = tgz(entriesFrom(sourceFolder(root, { commit: C3 })));
      await withLog(async (_w, rows) => {
        await fetchTarball(z.offer("b3.tgz", b3, { commit: C3 }), { data });
        assert.ok(rows.some((x) => x.includes("cache: 1 old tarball(s) removed (2a59476c)")), JSON.stringify(rows));
      });
      assert.deepEqual(content(cache), [`${C2}.json`, `${C2}.tar.gz`, `${C3}.json`, `${C3}.tar.gz`].sort());
      // A meta that does not match the tarball is no entry (then it is fetched anew).
      fs.appendFileSync(path.join(cache, `${C3}.tar.gz`), "x");
      assert.equal(cacheEntry(C3, { data }), null);
    });
  });
});

test("(H) fetchTarball with `keep`: tarball and \"rejected\" marker of a needed version stay — without `keep` both fall (counter-test built in)", async () => {
  await withTemp(async (root) => {
    const tb = (commit) => tgz(entriesFrom(sourceFolder(root, { commit })));
    const BAD = HEX("e"); // a needed version whose tarball is rejected (marker without a tarball)
    await withEndpoint(async (z) => {
      // The cache: C (the used one, the OLDEST), C2 (newer), the marker of BAD; then the pass fetches the newest, C3.
      const run = async (name, keep) => {
        const data = path.join(root, name);
        const cache = path.join(data, CACHE_FOLDER);
        await withLog(() => fetchTarball(z.offer(`${name}-c.tgz`, tb(C)), { data }));
        await withLog(() => fetchTarball(z.offer(`${name}-c2.tgz`, tb(C2), { commit: C2 }), { data }));
        const t = Date.now() / 1000;
        fs.utimesSync(path.join(cache, `${C}.tar.gz`), t - 200, t - 200);
        fs.utimesSync(path.join(cache, `${C2}.tar.gz`), t - 100, t - 100);
        fs.writeFileSync(path.join(cache, `${BAD}.denied`), JSON.stringify({ commit: BAD, sha256: HEX("0", 64), code: "BUILD", reason: "x", at: 1, attempts: 1, status: checkStatusOfThisFile() }));
        await withLog(() => fetchTarball(z.offer(`${name}-c3.tgz`, tb(C3), { commit: C3 }), { data, ...(keep ? { keep } : {}) }));
        return content(cache);
      };
      assert.deepEqual(await run("including", [C, BAD]), [`${C3}.json`, `${C3}.tar.gz`, `${BAD}.denied`, `${C}.json`, `${C}.tar.gz`].sort(),
        "the used (oldest) one fell, or the marker of a needed version");
      // Counter-test (without `keep`): the two newest — C2 stays, the used C falls, and so does the marker of BAD.
      assert.deepEqual(await run("without", null), [`${C2}.json`, `${C2}.tar.gz`, `${C3}.json`, `${C3}.tar.gz`].sort());
    });
  });
});

// ── (B) The helper in B ──────────────────────────────────────────────────────────────────────────────────────────────

test("(B) helperInB: only with an existing bin/ of Dev Containers, exactly LICENSE/node/node_modules/node-pty, mtime = build time; cleanUpHelper: three newest + protected, never a running one", async () => {
  await withTemp(async (root) => {
    const q = sourceFolder(root);
    const file = path.join(root, "a.tgz");
    fs.writeFileSync(file, tgz(entriesFrom(q)));
    const entry = { file, meta: { buildTime: BUILD_TIME, product: "1.141.0" } };
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    // Without the Dev Containers folder: nothing — no folder created either.
    assert.deepEqual(await helperInB(C, entry, { home }), { status: "no-dev-containers" });
    fs.mkdirSync(path.join(home, HELPER_FOLDER));
    assert.deepEqual(await helperInB(C, entry, { home }), { status: "no-dev-containers" });
    assert.deepEqual(content(path.join(home, HELPER_FOLDER)), []);
    // `bin` as a link (target outside): nothing, not at the target either.
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, HELPER_FOLDER, "bin"));
    assert.deepEqual(await helperInB(C, entry, { home }), { status: "no-dev-containers" });
    assert.deepEqual(content(outside), []);
    fs.unlinkSync(path.join(home, HELPER_FOLDER, "bin"));
    // `.vscode-remote-containers` as a link to a folder with bin/: nothing.
    const home2 = path.join(root, "home2");
    fs.mkdirSync(path.join(outside, "bin"), { recursive: true });
    fs.mkdirSync(home2);
    fs.symlinkSync(outside, path.join(home2, HELPER_FOLDER));
    assert.deepEqual(await helperInB(C, entry, { home: home2 }), { status: "no-dev-containers" });
    assert.deepEqual(content(path.join(outside, "bin")), []);

    const bin = path.join(home, HELPER_FOLDER, "bin");
    fs.mkdirSync(bin);
    const r = await withLog(() => helperInB(C, entry, { home, now: 1700000000123 }));
    assert.deepEqual(r, { status: "ok", target: path.join(bin, C) });
    assert.deepEqual(content(bin), [C], "a leftover of unpacking stayed");
    assert.deepEqual(list(path.join(bin, C)), helperList(q));
    assert.ok(Object.keys(list(path.join(bin, C))).includes("node_modules/node-pty/build/Release/pty.node"));
    assert.ok(!fs.existsSync(path.join(bin, C, "node_modules", "other")), "a foreign module got into the helper");
    assert.equal(mtimeS(path.join(bin, C)), BUILD_TIME);
    assert.deepEqual(await helperInB(C, entry, { home }), { status: "already-there" });
    // A layout that is not the helper (without node): throw, no leftover.
    const withoutNode = path.join(root, "without-node.tgz");
    fs.writeFileSync(withoutNode, tgz(entriesFrom(sourceFolder(root, { without: ["node"] }))));
    await assert.rejects(helperInB(C2, { file: withoutNode, meta: {} }, { home }), /tar \(helper bbbbbbbb\)/);
    assert.deepEqual(content(bin), [C]);

    // Cleanup: finished ones with mtime order ≠ name order, the protected one as the oldest, half-finished old/fresh, a running one,
    // plus link, file and foreign names shaped like versions.
    const v = { recent: HEX("9"), second: HEX("5"), third: HEX("1"), fourth: HEX("7"), fifth: HEX("3"), protection: HEX("8"), running: HEX("2") };
    const ages = { recent: 10, second: HOUR, third: 2 * HOUR, fourth: 3 * HOUR, fifth: 4 * HOUR, protection: 9 * HOUR, running: 8 * HOUR };
    for (const [k, n] of Object.entries(v)) version(path.join(bin, n), ages[k]);
    fs.utimesSync(path.join(bin, C), Date.now() / 1000 - 6 * HOUR, Date.now() / 1000 - 6 * HOUR);
    version(path.join(bin, `${HEX("4")}_1700000000000`), 2 * HOUR);
    version(path.join(bin, `${HEX("6")}_1700000000001`), 10 * 60);
    fs.symlinkSync(outside, path.join(bin, HEX("d")));
    fs.writeFileSync(path.join(bin, HEX("e")), "file\n");
    for (const n of ["foreign", HEX("A"), HEX("f", 41), `${HEX("d")}_x`]) version(path.join(bin, n), 10 * HOUR);
    const withProcess = proc(path.join(root, "procB"), [{ pid: 7, cmdline: [`/home/agent/${HELPER_FOLDER}/bin/${v.running}/node`, "x"] }]);
    // Without a readable /proc: nothing finished (and no half-finished one — the step is dropped entirely).
    assert.deepEqual(cleanUpHelper({ home, proc: path.join(root, "exists-not"), shielded: [v.protection] }), { status: "without-proc", removed: [], running: [] });
    const prior = content(bin);
    // A single value instead of the list is an error with a warning — NOTHING falls (silently without protection the cleanup
    // would delete more).
    await withLog(async (warnings) => {
      assert.equal(cleanUpHelper({ home, proc: withProcess, shielded: v.protection }).status, "error");
      assert.ok(warnings.some((w) => w.includes("helper: clean-up failed") && w.includes("not a list")), JSON.stringify(warnings));
    });
    assert.deepEqual(content(bin), prior);
    const a = await withLog(() => cleanUpHelper({ home, proc: withProcess, shielded: [v.protection] }));
    assert.equal(a.status, "ok");
    assert.deepEqual(a.removed.sort(), [v.fourth, v.fifth, C, `${HEX("4")}_1700000000000`].sort());
    assert.deepEqual(a.running, [v.running]);
    assert.deepEqual(content(bin), prior.filter((n) => !a.removed.includes(n)));
    assert.ok(content(bin).includes(v.protection) && content(bin).includes(v.recent) && content(bin).includes(v.second) && content(bin).includes(v.third));
    assert.deepEqual(content(outside), ["bin"], "something at the target of a link was deleted");
    // Built-in counter-test: a /proc without the process — the running one goes.
    const withoutProcess = proc(path.join(root, "procB2"), [{ pid: 8, cmdline: ["sleep", "1"] }]);
    const g = await withLog(() => cleanUpHelper({ home, proc: withoutProcess, shielded: [v.protection] }));
    assert.deepEqual(g.removed, [v.running]);
    // TWO protected (newest and used) — both stay, neither counts among the three newest; built-in counter-test: with only the
    // newest the used one falls in the next run.
    const used = HEX("b");
    version(path.join(bin, used), 7 * HOUR);
    version(path.join(bin, HEX("c")), 7.5 * HOUR);
    const two = await withLog(() => cleanUpHelper({ home, proc: withoutProcess, shielded: [v.protection, used] }));
    assert.deepEqual(two.removed, [HEX("c")]);
    assert.ok(content(bin).includes(used) && content(bin).includes(v.protection));
    const one = await withLog(() => cleanUpHelper({ home, proc: withoutProcess, shielded: [v.protection] }));
    assert.deepEqual(one.removed, [used], "counter-test: without protection the used one stayed anyway");

    // A nested leftover from a race with Dev Containers (`bin/<c>/<c>_<ms>`): falls after HALF_DONE_MIN — also in the protected
    // version —; a fresh one, one with a foreign commit in the name and the versions themselves stay. Built-in counter-test: without
    // the step it would stay forever — the second run without a leftover shows that.
    const rest = (c, n, ageS) => version(path.join(bin, c, n), ageS);
    rest(v.recent, `${v.recent}_1700000000002`, 2 * HOUR);
    rest(v.protection, `${v.protection}_1700000000003`, 2 * HOUR);
    rest(v.second, `${v.second}_1700000000004`, 10 * 60);
    rest(v.third, `${HEX("4")}_1700000000005`, 2 * HOUR);
    const procEmpty = proc(path.join(root, "procB3"), []);
    const nest = await withLog(async (_w, rows) => {
      const x = cleanUpHelper({ home, proc: procEmpty, shielded: [v.protection] });
      assert.ok(rows.some((y) => y.includes("helper: 2 old version(s)")), JSON.stringify(rows));
      return x;
    });
    assert.deepEqual(nest.removed.sort(), [`${v.recent}/${v.recent}_1700000000002`, `${v.protection}/${v.protection}_1700000000003`].sort());
    assert.ok(fs.existsSync(path.join(bin, v.second, `${v.second}_1700000000004`)), "a fresh leftover fell");
    assert.ok(fs.existsSync(path.join(bin, v.third, `${HEX("4")}_1700000000005`)), "a foreign name fell");
    for (const c of [v.recent, v.protection, v.second, v.third]) assert.ok(fs.existsSync(path.join(bin, c, "node")), `version ${c} touched`);
    assert.deepEqual(cleanUpHelper({ home, proc: procEmpty, shielded: [v.protection] }).removed ?? [], []);
  });
});

// ── (S) The script in the container ──────────────────────────────────────────────────────────────────────────────────────

const REAL = Object.fromEntries(["tar", "mv", "mkdir"].map((p) => [p, spawnSync("sh", ["-c", `command -v ${p}`], { encoding: "utf8" }).stdout.trim()]));
// The script as in the container: `sh -c <script> <$0> <vs> <commit> <proc> <ino> <stamp> <ms>`, the tarball as stdin.
function script(vs, procW, b, { commit = C, ino = inoOf(vs), stamp = touchStamp(BUILD_TIME), ms = "1700000000123", env = {} } = {}) {
  const r = spawnSync("sh", ["-c", UPFRONT_SCRIPT, "cbase-vscode-upfront", vs, commit, procW, ino, stamp, ms], { input: b, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, ...readUpfrontOutput(r.stdout) };
}

test("(S) script: layout = --strip-components 1, mtime = build time; already-there, no-mount, other-folder, links, races (lost), broken tar and wrong layout without a leftover", () => {
  withTemp((root) => {
    const q = sourceFolder(root);
    const b = tgz(entriesFrom(q));
    const vs = path.join(root, "home", VSCODE_SERVER);
    const bin = path.join(vs, "bin");
    version(path.join(bin, C2), HOUR);
    const including = proc(path.join(root, "proc"), [], { mounts: [vs] });
    assert.equal(touchStamp(BUILD_TIME), "202610060840.24");
    assert.equal(touchStamp(null), "");

    // Without a mount point, with a foreign inode: nothing.
    const without = proc(path.join(root, "proc-without"), [], { mounts: [`${vs}-neighbour`] });
    assert.equal(script(vs, without, b).status, "no-mount");
    assert.equal(script(vs, including, b, { ino: "1" }).status, "other-folder");
    assert.deepEqual(content(bin), [C2]);

    const r = script(vs, including, b);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([r.status, r.commit, r.timeOpen], ["finished", C, false], r.out);
    assert.deepEqual(content(bin), [C2, C].sort(), "a leftover of unpacking stayed");
    assert.deepEqual(list(path.join(bin, C)), list(q), "the layout is not that of --strip-components 1");
    assert.equal(mtimeS(path.join(bin, C)), BUILD_TIME);
    assert.equal(script(vs, including, b).status, "already-there");

    // `bin` and `.vscode-server` as a link: nothing, not at the target either.
    const target = path.join(root, "target-outside");
    fs.mkdirSync(path.join(target, "bin"), { recursive: true });
    const vs2 = path.join(root, "home2", VSCODE_SERVER);
    fs.mkdirSync(vs2, { recursive: true });
    fs.symlinkSync(path.join(target, "bin"), path.join(vs2, "bin"));
    assert.equal(script(vs2, proc(path.join(root, "proc2"), [], { mounts: [vs2] }), b, { commit: C3 }).status, "no-folder");
    const vs3 = path.join(root, "home3", VSCODE_SERVER);
    fs.mkdirSync(path.dirname(vs3), { recursive: true });
    fs.symlinkSync(target, vs3);
    assert.equal(script(vs3, proc(path.join(root, "proc3"), [], { mounts: [vs3] }), b, { commit: C3, ino: inoOf(target) }).status, "no-folder");
    assert.deepEqual(content(path.join(target, "bin")), []);

    // Race BEFORE renaming (a tar that lets the target arise): lost, the own leftover is gone.
    const pathFront = (name, body) => {
      const d = path.join(root, `bin-${name}`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(d, name), 0o755);
      return { PATH: `${d}:${process.env.PATH}` };
    };
    const runner = path.join(bin, C3);
    const v1 = script(vs, including, b, { commit: C3, env: { ...pathFront("tar", `mkdir -p '${runner}'\nexec '${REAL.tar}' "$@"`) } });
    assert.deepEqual([v1.code, v1.status, v1.commit], [0, "lost", C3], v1.err);
    assert.deepEqual(content(bin), [C2, C3, C].sort());
    assert.deepEqual(content(runner), [], "something was written into the other's folder");
    fs.rmdirSync(runner);
    // Race BETWEEN the check and `mv -n` (an mv that creates the target first): mv pushes in, the script takes it out.
    const v2 = script(vs, including, b, { commit: C3, env: pathFront("mv", `mkdir -p '${runner}'\nexec '${REAL.mv}' "$@"`) });
    assert.deepEqual([v2.code, v2.status], [0, "lost"], v2.err);
    assert.deepEqual(content(runner), [], "the own leftover stayed in the other's folder");
    assert.deepEqual(content(bin), [C2, C3, C].sort());
    fs.rmdirSync(runner);

    // `bin` is missing (VS Code was never in this project) — the script creates it, a real folder, and places the version. Without
    // a mount point it creates NOTHING.
    const vs5 = path.join(root, "home5", VSCODE_SERVER);
    fs.mkdirSync(vs5, { recursive: true });
    assert.equal(script(vs5, proc(path.join(root, "proc5a"), [], { mounts: [`${vs5}-nachbar`] }), b).status, "no-mount");
    assert.deepEqual(content(vs5), [], "bin was created without a mount point");
    const emptyR = script(vs5, proc(path.join(root, "proc5"), [], { mounts: [vs5] }), b);
    assert.deepEqual([emptyR.code, emptyR.status, emptyR.commit], [0, "finished", C], emptyR.err);
    const binSt = fs.lstatSync(path.join(vs5, "bin"));
    assert.ok(binSt.isDirectory() && !binSt.isSymbolicLink(), "bin is not a real folder");
    assert.deepEqual(content(path.join(vs5, "bin")), [C]);
    assert.deepEqual(list(path.join(vs5, "bin", C)), list(q));
    // A DANGLING link in the place of `bin`: mkdir without -p does not follow it — it stays, `no-folder`, nothing at the target.
    const vs6 = path.join(root, "home6", VSCODE_SERVER);
    fs.mkdirSync(vs6, { recursive: true });
    const hanging = path.join(root, "target-exists-not");
    fs.symlinkSync(hanging, path.join(vs6, "bin"));
    assert.equal(script(vs6, proc(path.join(root, "proc6"), [], { mounts: [vs6] }), b).status, "no-folder");
    assert.ok(fs.lstatSync(path.join(vs6, "bin")).isSymbolicLink());
    assert.equal(fs.existsSync(hanging), false, "something was created at the target of the dangling link");
    // mkdir fails and there is no folder afterwards (permissions — here a fake mkdir in front of the PATH, root-independent): exit 1
    // with a reason, no leftover. Built-in counter-test: a mkdir that fails BECAUSE another process has created `bin` meanwhile is no error.
    const vs7 = path.join(root, "home7", VSCODE_SERVER);
    fs.mkdirSync(vs7, { recursive: true });
    const p7 = proc(path.join(root, "proc7"), [], { mounts: [vs7] });
    const mkdirFront = (folder, body) => {
      const d = path.join(root, folder);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "mkdir"), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(d, "mkdir"), 0o755);
      return { PATH: `${d}:${process.env.PATH}` };
    };
    const m = script(vs7, p7, b, { env: mkdirFront("mkdir-fails", `case "$*" in */bin) exit 1;; esac\nexec '${REAL.mkdir}' "$@"`) });
    assert.equal(m.code, 1, m.out);
    assert.match(m.err, /mkdir bin failed/);
    assert.deepEqual(content(vs7), []);
    const w = script(vs7, p7, b, { env: mkdirFront("mkdir-race", `case "$*" in */bin) '${REAL.mkdir}' "$2"; exit 1;; esac\nexec '${REAL.mkdir}' "$@"`) });
    assert.deepEqual([w.code, w.status], [0, "finished"], w.err);
    assert.deepEqual(content(path.join(vs7, "bin")), [C]);

    // Broken tar and wrong layout: exit 1, no leftover.
    const k = script(vs, including, Buffer.from("not gzip"), { commit: C3 });
    assert.equal(k.code, 1);
    assert.match(k.err, /tar failed/);
    const f = script(vs, including, tgz(entriesFrom(sourceFolder(root, { without: ["bin/code-server"] }))), { commit: C3 });
    assert.equal(f.code, 1);
    assert.match(f.err, /unexpected layout/);
    assert.deepEqual(content(bin), [C2, C].sort());
    // Invalid arguments: exit 2, nothing.
    assert.equal(script(vs, including, b, { commit: "x" }).code, 2);
    assert.equal(script(vs, including, b, { commit: C3, ms: "1a" }).code, 2);
    assert.equal(script(vs, including, b, { commit: C3, stamp: "2026-10-06" }).code, 2);
    assert.deepEqual(content(bin), [C2, C].sort());
  });
});

// ── (A) A project through the fake docker ─────────────────────────────────────────────────────────────────────────

const execCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args).filter((a) => a[0] === "exec" && a.includes(UPFRONT_SCRIPT));
// The calls of the cleanup (vscode-server.js) after placing.
const cleanupCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args).filter((a) => a[0] === "exec" && a.includes(CLEAN_UP_SCRIPT));
const workEnd = () => { for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" }); };

// A ready, converted main with its cache (fetched through the endpoint) and a protected version.
async function readyProject(ctx, fd, z, root) {
  const s = scenario(ctx);
  const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
  assert.equal(row.state, "ready", row.error);
  setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() }); // only the relocation converts it
  const q = sourceFolder(root);
  const info = z.offer("p.tgz", tgz(entriesFrom(q)));
  const entry = await withLog(() => fetchTarball(info));
  store.setSetting(NEWEST_KEY, C);
  const source = path.join(s.location.home, VSCODE_SERVER);
  return { s, q, entry, source, bin: path.join(source, "bin") };
}

test("(A) vscodeUpfrontForProject through the fake docker: without a cause no docker; otherwise `exec -i -u agent` and the layout of --strip-components 1 — also without `bin` (creates it); copy, operation, off, state, version, tarball, no-mount, running-already, cap", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs, execGate: "upfront" });
    try {
      fd.openGate("upfront");
      const { s, q, source, bin } = await readyProject(ctx, fd, z, root);
      assert.deepEqual(protectedVersions(), [C]);
      // The seam `home`: the target is then the source itself (the fake docker runs locally); the seam's /proc names it as a
      // mount point — as in the container.
      const opts = { home: s.location.home, proc: proc(path.join(s.root, "upfront-proc"), [], { mounts: [source] }) };
      const run = (o = opts, values = ON) => withOps(fd, () => vscodeUpfrontForProject(s.projectId, o), values);
      const only = (status, extra = {}) => ({ status, versions: { [C]: { status, ...extra } } }); // ONE version (the protected C)
      // The cleanup after placing — here without a cause (at most two remaining), so "nothing" without docker.
      const nothingCleanUp = (finished) => ({ status: "nothing", cause: false, finished, halfDoneOld: 0, ino: inoOf(source) });

      // The cases without any look: copy, no operation, off, not x64, not ready, not converted, without a version — no docker.
      const prior = fd.calls().length;
      assert.ok(fs.lstatSync(source).isDirectory(), "the creation did not create `.vscode-server`");
      assert.equal(fs.existsSync(bin), false, "the scenario should start without `bin` (VS Code was never there)");
      assert.deepEqual(await run({ ...opts, instance: "copy-k1" }), { status: "copy" });
      assert.deepEqual(await vscodeUpfrontForProject(s.projectId, opts), { status: "no-ops" });
      assert.deepEqual(await run(opts, { CBASE_VSCODE_UPFRONT_MS: "0" }), { status: "off" });
      assert.equal(ARCH, "x64");
      assert.deepEqual(await run({ ...opts, arch: "arm64" }), { status: "other-architecture", arch: "arm64" });
      setInstanceState(s.projectId, "main", "stopped");
      assert.deepEqual(await run(), { status: "not-ready", reason: "stopped" });
      setInstanceState(s.projectId, "main", "ready", { convertedAt: null });
      assert.deepEqual(await run(), { status: "not-converted" });
      setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() });
      store.setSetting(NEWEST_KEY, "");
      assert.deepEqual(await run(), { status: "no-version" });
      store.setSetting(NEWEST_KEY, C);
      // A version without a tarball in the cache: per version "no-tarball" — this path never loads by itself.
      assert.deepEqual(await run({ ...opts, commit: C3 }), { status: "no-tarball", versions: { [C3]: { status: "no-tarball" } } });
      assert.equal(fd.calls().length, prior, "a case without a cause called docker");

      // Without a mount point in the container: nothing (no `bin` either), a warning.
      await withLog(async (warnings) => {
        assert.deepEqual(await run({ ...opts, proc: proc(path.join(s.root, "upfront-proc-without"), []) }), only("no-mount"));
        assert.ok(warnings.some((w) => w.includes(`project ${s.projectId} — ${source} is not a mount point in the project container`)), JSON.stringify(warnings));
      });
      assert.equal(fs.existsSync(bin), false, "`bin` was created without a mount point");

      // WITHOUT `bin` (the project was never open in VS Code) — exactly one exec with -i; the script creates `bin`, the layout in the
      // project is that of --strip-components 1, mtime = build time.
      const ok = await withLog(async (_w, rows) => {
        const r = await run();
        assert.ok(rows.some((x) => x.includes(`VS Code server upfront 1.141.0 (2a59476c): placed in project ${s.projectId}`) && x.includes("(bin created — VS Code was never here)")), JSON.stringify(rows));
        return r;
      });
      assert.deepEqual(ok, { ...only("ok"), cleanUp: nothingCleanUp(1) });
      const calls = execCalls(fd);
      assert.equal(calls.length, 2); // no-mount and this one
      assert.equal(cleanupCalls(fd).length, 0, "the cleanup after placing called docker without a cause");
      const a = calls.at(-1);
      assert.deepEqual(a.slice(0, 13), ["exec", "-i", "-u", "agent", containerName(s.projectId), "sh", "-c", UPFRONT_SCRIPT, "cbase-vscode-upfront", source, C, opts.proc, inoOf(source)]);
      assert.equal(a[13], "202610060840.24");
      assert.match(a[14], /^\d+$/);
      assert.ok(fs.lstatSync(bin).isDirectory() && !fs.lstatSync(bin).isSymbolicLink());
      assert.deepEqual(content(bin), [C]);
      assert.deepEqual(list(path.join(bin, C)), list(q));
      assert.equal(mtimeS(path.join(bin, C)), BUILD_TIME);
      // Already there: the look in B sees it — no docker.
      const n = fd.calls().length;
      assert.deepEqual(await run(), only("already-there", { reason: "already there" }));
      assert.equal(fd.calls().length, n);
      // `bin` as a link (target a folder WITHOUT the version): no docker, nothing at the target.
      const target = path.join(root, "target-bin");
      version(path.join(target, C2), 10);
      fs.renameSync(bin, path.join(root, "bin-gone"));
      fs.symlinkSync(target, bin);
      const v = await run();
      assert.equal(v.versions[C].status, "nothing");
      assert.match(v.versions[C].reason, /^link: /);
      assert.equal(fd.calls().length, n);
      assert.deepEqual(content(target), [C2]);
      fs.unlinkSync(bin);
      // `.vscode-server` as a link (also with `bin` at the target): no docker.
      fs.renameSync(source, path.join(root, "vs-gone"));
      fs.symlinkSync(path.join(root, "vs-gone"), source);
      const vv = await run();
      assert.deepEqual([vv.status, vv.versions[C].reason], ["nothing", `link: ${source}`]);
      assert.equal(fd.calls().length, n);
      fs.unlinkSync(source);
      fs.renameSync(path.join(root, "vs-gone"), source);
      fs.renameSync(path.join(root, "bin-gone"), bin);

      // TWO protected versions (newest C, used C2 — its tarball is in the cache): atReady places EACH that is missing — C is already
      // there, C2 is added; ONE exec.
      const q2 = sourceFolder(root, { commit: C2 });
      await withLog(() => fetchTarball(z.offer("p2.tgz", tgz(entriesFrom(q2)), { commit: C2 }), { keep: [C] }));
      store.setSetting(USED_KEY, C2);
      assert.deepEqual(protectedVersions(), [C, C2]);
      const two = await withLog(() => run());
      assert.deepEqual(two, { status: "mixed", versions: { [C]: { status: "already-there", reason: "already there" }, [C2]: { status: "ok" } }, cleanUp: nothingCleanUp(2) });
      assert.equal(execCalls(fd).length, 3);
      assert.deepEqual(content(bin), [C2, C].sort());
      assert.deepEqual(list(path.join(bin, C2)), list(q2));
      // ABORT: a result that hangs on the project (here no mount point) leaves the second version UNTRIED — ONE exec, not two.
      fs.rmSync(path.join(bin, C), { recursive: true });
      fs.rmSync(path.join(bin, C2), { recursive: true });
      const beforeAbort = execCalls(fd).length;
      const abort = await withLog(() => run({ ...opts, proc: proc(path.join(s.root, "upfront-proc-without-2"), []) }));
      assert.deepEqual(abort, { status: "no-mount", versions: { [C]: { status: "no-mount" }, [C2]: { status: "no-mount", reason: "not attempted — like 2a59476c" } } });
      assert.equal(execCalls(fd).length, beforeAbort + 1, "after no-mount the second version was tried anyway");
      store.setSetting(USED_KEY, "");

      // A hanging `docker exec` (the gate): a second call gets `running-already`; the cap turns it into a warning.
      fs.rmSync(path.join(fd.dir, "gates", "upfront.waiting"), { force: true });
      fd.closeGate("upfront");
      await withLog(async (warnings) => {
        const hangs = run({ ...opts, capMs: 3_600_000 });
        assert.ok(runningUpfront(s.projectId), "no running upfront fetch visible");
        await fd.gateReached("upfront");
        assert.deepEqual(await run(), { status: "running-already" });
        assert.ok(advanceCap() >= 1, "no cap ran");
        const r = await hangs;
        assert.equal(r.status, "error");
        assert.match(r.versions[C].reason, /cap of 3600000 ms/);
        assert.ok(warnings.some((w) => w.includes(`VS Code server upfront project ${s.projectId}: failed (1.141.0 (2a59476c))`) && w.includes("(cap 3600000 ms, estimated)")), JSON.stringify(warnings));
      });
      assert.equal(runningUpfront(s.projectId), null, "the upfront fetch stayed marked as running");
      fd.openGate("upfront");
      assert.deepEqual(await withLog(() => run()), { ...only("ok"), cleanUp: nothingCleanUp(1) }, "not runnable again after the cap");
    } finally {
      fd.openGate("upfront");
      workEnd();
      fd.cleanUp();
    }
  })));
});

// ── (D) The pass ────────────────────────────────────────────────────────────────────────────────────────────────

test("(D) vscodeUpfrontCycle: without need no request; with need ask, fetch, helper, project — the protected version is fixed afterwards; no second download; HTTP 500, no operation, off", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs });
    try {
      const s = scenario(ctx);
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() });
      const q = sourceFolder(root);
      z.offer("d.tgz", tgz(entriesFrom(q)));
      const source = path.join(s.location.home, VSCODE_SERVER);
      const bin = path.join(source, "bin");
      const home = path.join(root, "home-b");
      fs.mkdirSync(home);
      const procB = proc(path.join(root, "procB"), [{ pid: 9, cmdline: ["sleep", "1"] }]);
      const seams = { api: z.api, versionTemplate: z.template, home, proc: procB, creationHome: s.location.home, procContainer: proc(path.join(root, "procP"), [], { mounts: [source] }) };
      const cycle = (values = ON, n = seams) => withOps(fd, () => vscodeUpfrontCycle(n), values);

      // No need: no helper folder in B, no project with a finished version, no trace — Microsoft is not asked.
      fs.mkdirSync(bin);
      assert.deepEqual(await cycle(), { status: "no-need" });
      assert.equal(z.requests.length, 0, "a request without need");
      assert.deepEqual(protectedVersions(), []);
      // No operation, off: nothing.
      version(path.join(bin, C2), HOUR);
      assert.deepEqual(await vscodeUpfrontCycle(seams), { status: "no-ops" });
      assert.deepEqual(await cycle({ CBASE_VSCODE_UPFRONT_MS: "0" }), { status: "off" });
      assert.equal(z.requests.length, 0);
      // HTTP 500: error in the step ask, a warning, nothing written.
      z.apiStatus = 500;
      await withLog(async (warnings) => {
        const r = await cycle();
        assert.deepEqual([r.status, r.step, r.code], ["error", "questions", "HTTP"]);
        assert.deepEqual(r.versions, {});
        assert.ok(warnings.some((w) => w.includes("VS Code server upfront Microsoft not reached") && w.includes("HTTP 500")), JSON.stringify(warnings));
      });
      z.apiStatus = 0;
      assert.deepEqual(protectedVersions(), []);

      // With need (the project has a finished version, B the Dev Containers folder).
      fs.mkdirSync(path.join(home, HELPER_FOLDER, "bin"), { recursive: true });
      const r = await withLog(async (_w, rows) => {
        const x = await cycle();
        assert.ok(rows.some((y) => y.includes(`Microsoft names 1.141.0 (${C}) as the newest version`)), JSON.stringify(rows));
        return x;
      });
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.deepEqual([r.newest, r.used], [C, null]);
      assert.deepEqual(r.versions, { [C]: {
        roles: ["newest"], fetch: { status: "fresh" }, helper: { status: "ok", target: path.join(home, HELPER_FOLDER, "bin", C) },
        projects: { [s.projectId]: { status: "ok" } },
      } });
      assert.deepEqual(r.cleanUp, { status: "nothing", removed: [], running: [] });
      // After placing, the project's cleanup: two finished, one protected — no cause, no docker.
      assert.deepEqual(r.projects, { [s.projectId]: { status: "ok", versions: { [C]: { status: "ok" } }, cleanUp: { status: "nothing", cause: false, finished: 2, halfDoneOld: 0, ino: inoOf(source) } } });
      assert.equal(cleanupCalls(fd).length, 0, "the cleanup after placing called docker without a cause");
      assert.deepEqual(protectedVersions(), [C]);
      assert.equal(store.getSetting(NEWEST_KEY, ""), C);
      assert.deepEqual(list(path.join(home, HELPER_FOLDER, "bin", C)), helperList(q));
      assert.deepEqual(list(path.join(bin, C)), list(q));
      assert.equal(z.count("/t/d.tgz"), 1);
      // A second pass: Microsoft is asked, but nothing is loaded and no docker is called.
      const n = fd.calls().length;
      const r2 = await withLog(() => cycle());
      assert.equal(r2.status, "ok");
      assert.deepEqual(r2.versions[C], {
        roles: ["newest"], fetch: { status: "cache" }, helper: { status: "already-there" }, projects: { [s.projectId]: { status: "already-there", reason: "already there" } },
      });
      assert.equal(z.count("/api"), 3);
      assert.equal(z.count("/t/d.tgz"), 1, "a checked tarball was loaded a second time");
      assert.equal(fd.calls().length, n, "the second pass called docker");
      // At most one at a time.
      const a = cycle();
      assert.ok(runningCycle());
      assert.deepEqual(await withOps(fd, () => vscodeUpfrontCycle(seams), ON), { status: "running-already" });
      await withLog(() => a);
      assert.equal(runningCycle(), null);
      // A machine that is not x64: nothing, no request, the warning ONCE per process.
      const beforeRequests = z.requests.length;
      await withLog(async (warnings) => {
        assert.deepEqual(await cycle(ON, { ...seams, arch: "arm64" }), { status: "other-architecture", arch: "arm64" });
        assert.deepEqual(await cycle(ON, { ...seams, arch: "arm64" }), { status: "other-architecture", arch: "arm64" });
        assert.equal(warnings.filter((w) => w.includes("this machine is arm64")).length, 1, JSON.stringify(warnings));
      });
      assert.equal(z.requests.length, beforeRequests, "Microsoft was asked on another machine");
      // The cap of the look in B in the pass: the project does not count toward the NEED (a warning with its id) — a TARGET it stays
      // (every ready main): the look with a commit does not read `bin`, it asks only for `bin/<commit>`.
      fs.renameSync(bin, `${bin}-away`);
      fs.mkdirSync(bin);
      for (let i = 0; i <= 1000; i++) fs.writeFileSync(path.join(bin, `x${i}`), "");
      await withLog(async (warnings) => {
        const d = await cycle();
        assert.equal(d.status, "ok", JSON.stringify(d));
        // The cleanup after: at the cap of the look in B "cause" holds, the script decides — the one finished version is protected, nothing falls.
        assert.deepEqual(d.projects, { [s.projectId]: { status: "ok", versions: { [C]: { status: "ok" } }, cleanUp: { status: "ok", removed: [], running: [] } } });
        assert.ok(warnings.some((w) => w.includes(`VS Code server upfront project ${s.projectId}: cap of 1000 entries`)), JSON.stringify(warnings));
      });
      fs.rmSync(bin, { recursive: true });
      fs.renameSync(`${bin}-away`, bin);
    } finally {
      workEnd();
      fd.cleanUp();
    }
  })));
});

// ── (D) Cleanup after placing ─────────────────────────────────────────────────────────

// The kind and container of the calls of both scripts (upfront fetch, cleanup) in their order — from the call `ab` on.
const scriptFollowUp = (fd, mark = 0) => fd.calls({ daemon: "host" }).map((a) => a.args).filter((a) => a[0] === "exec")
  .map((a) => (a.includes(UPFRONT_SCRIPT) ? `upfront ${a[4]}` : a.includes(CLEAN_UP_SCRIPT) ? `cleanup ${a[3]}` : null)).filter(Boolean).slice(mark);

test("(D) after placing the project cleans up — a project with many versions falls to the limit, the just-placed and the used one stay; without placing no cleanup; in the same queue entry (one after the other), the just-placed one protected even if it is not saved", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs, execGate: "upfront" });
    try {
      fd.openGate("upfront");
      const ready = async ({ converted = true } = {}) => {
        const s = scenario(ctx);
        const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
        assert.equal(row.state, "ready", row.error);
        if (converted) setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() });
        const source = path.join(s.location.home, VSCODE_SERVER);
        return { s, source, bin: path.join(source, "bin") };
      };
      const p = await ready();
      // Q is converted only AFTER the pass (the "queue" part below) — the pass knows only P.
      const q = await ready({ converted: false });
      setCreationOptions((pid) => (pid === p.s.projectId ? { home: p.s.location.home } : pid === q.s.projectId ? { home: q.s.location.home } : {}));
      const procP = proc(path.join(root, "procP"), [], { mounts: [p.source, q.source] });
      // B knows the helper of the Mac version C2 (Dev Containers placed it into B first when attaching), P carries its trace.
      const home = helperHome(path.join(root, "home-b"), [C2]);
      lane(p.source, C2, 60_000);
      // P, full: C2 (the Mac's, the OLDEST — 20 days) and four remaining (5…2 h). The newest C arrives with the build time (≈ a week
      // old) — older by mtime than the four: without protection it would immediately fall victim to its own cleanup.
      version(path.join(p.bin, C2), 20 * 86_400);
      for (const [x, h] of [["5", 5], ["6", 4], ["7", 3], ["8", 2]]) version(path.join(p.bin, HEX(x)), h * HOUR);
      z.offer("new.tgz", tgz(entriesFrom(sourceFolder(root))));
      z.offerVersion("mac.tgz", tgz(entriesFrom(sourceFolder(root, { commit: C2 }))), { commit: C2 });
      const seams = { api: z.api, versionTemplate: z.template, home, proc: proc(path.join(root, "procB"), []), procContainer: procP };

      const r = await withLog(() => withOps(fd, () => vscodeUpfrontCycle(seams), ON));
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.deepEqual([r.newest, r.used], [C, C2]);
      assert.deepEqual(r.projects[p.s.projectId], {
        status: "mixed", versions: { [C]: { status: "ok" }, [C2]: { status: "already-there", reason: "already there" } },
        cleanUp: { status: "ok", removed: [HEX("6"), HEX("5")], running: [] },
      });
      // At the limit: two protected (the just-placed newest C and the used C2) and the two newest remaining.
      assert.deepEqual(content(p.bin), [C, C2, HEX("7"), HEX("8")].sort());
      assert.deepEqual(scriptFollowUp(fd), [`upfront ${containerName(p.s.projectId)}`, `cleanup ${containerName(p.s.projectId)}`]);
      assert.equal(cleanupCalls(fd).at(-1).at(-1), `${C},${C2}`, "the cleanup did not get the protected versions");
      // A second pass places nothing — no cleanup, no docker.
      const n = fd.calls().length;
      const r2 = await withLog(() => withOps(fd, () => vscodeUpfrontCycle(seams), ON));
      assert.equal(r2.status, "ok", JSON.stringify(r2));
      assert.equal(r2.projects[p.s.projectId].cleanUp, undefined, "a cleanup without placing");
      assert.equal(fd.calls().length, n);

      // THE QUEUE and the protection of the just-placed one: P gets C3 — a version that is NOT saved (the path with a list, as the pass
      // drives it) and would be the oldest of the remaining by mtime; plus two fresh remaining ones so that there is a cause.
      await withLog(() => fetchTarball(z.offerVersion("c3.tgz", tgz(entriesFrom(sourceFolder(root, { commit: C3 }))), { commit: C3 }), { keep: [C, C2] }));
      for (const [x, h] of [["3", 1], ["4", 0.5]]) version(path.join(p.bin, HEX(x)), h * HOUR);
      setInstanceState(q.s.projectId, "main", "ready", { convertedAt: Date.now() });
      const mark = scriptFollowUp(fd).length;
      // The gate closes EXACTLY when P's version is placed (the line "placed" comes after the exec of the upfront fetch and before the
      // cleanup): the cleanup's exec then waits at the gate. The fake writes the marker `.waiting` at EVERY exec, also at an open
      // gate — so it is removed at the same moment. The wait is for the event, no clock.
      const marker = path.join(fd.dir, "gates", "upfront.waiting");
      let placedR;
      const placed = new Promise((r) => { placedR = r; });
      const orig = console.log;
      console.log = (...a) => {
        if (a.map(String).join(" ").includes(`placed in project ${p.s.projectId}`)) { fd.closeGate("upfront"); fs.rmSync(marker, { force: true }); placedR(); }
      };
      let rp;
      let rq;
      try {
        await withOps(fd, async () => {
          const lp = vscodeUpfrontForProject(p.s.projectId, { versions: [{ commit: C3 }], proc: procP });
          await placed; // only after: every marker comes from the cleanup's exec
          await fd.gateReached("upfront");
          assert.deepEqual(scriptFollowUp(fd, mark), [`upfront ${containerName(p.s.projectId)}`, `cleanup ${containerName(p.s.projectId)}`]);
          assert.ok(runningCleanUp(p.s.projectId), "the cleanup is not running");
          // The queue entry is NOT over while its cleanup runs — the next one waits.
          assert.equal(runningUpfront(p.s.projectId), lp, "the queue entry ended before its cleanup");
          const lq = vscodeUpfrontForProject(q.s.projectId, { commit: C, proc: procP });
          assert.ok(runningUpfront(q.s.projectId));
          fd.openGate("upfront");
          [rp, rq] = await Promise.all([lp, lq]);
        }, ON);
      } finally { console.log = orig; fd.openGate("upfront"); }
      assert.deepEqual(rp, { status: "ok", versions: { [C3]: { status: "ok" } }, cleanUp: { status: "ok", removed: [HEX("8"), HEX("7")], running: [] } });
      assert.deepEqual(content(p.bin), [C, C2, C3, HEX("3"), HEX("4")].sort(), "the just-placed (unsaved) version fell");
      assert.equal(cleanupCalls(fd).at(-1).at(-1), `${C},${C2},${C3}`);
      // Q came up only AFTER P's cleanup; Q got C in an empty `bin` — no cause, no docker for the cleanup.
      assert.deepEqual(scriptFollowUp(fd, mark), [`upfront ${containerName(p.s.projectId)}`, `cleanup ${containerName(p.s.projectId)}`, `upfront ${containerName(q.s.projectId)}`]);
      assert.deepEqual([rq.status, rq.cleanUp?.status], ["ok", "nothing"]);
    } finally {
      fd.openGate("upfront");
      setCreationOptions(null);
      workEnd();
      fd.cleanUp();
    }
  })));
});

// ── (V) The used version ────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
// The traces of a project: `<source>/data/Machine/.devport-<c>` and `.connection-token-<c>`, mtime `ageMs` back (as VS Code writes
// them at every start).
function lane(source, c, ageMs, { now = Date.now(), only } = {}) {
  const m = path.join(source, "data", "Machine");
  fs.mkdirSync(m, { recursive: true });
  for (const kind of only ? [only] : ["devport", "connection-token"]) {
    const f = path.join(m, `.${kind}-${c}`);
    fs.writeFileSync(f, kind === "devport" ? "41234" : "secret");
    const t = (now - ageMs) / 1000;
    fs.utimesSync(f, t, t);
  }
  return m;
}
// A home of B with the Dev Containers helper folder and one finished helper `bin/<c>` each (a trace counts only if B knows its
// version there) — as Dev Containers places it when attaching through the tunnel.
function helperHome(home, commits) {
  const hb = path.join(home, HELPER_FOLDER, "bin");
  fs.mkdirSync(hb, { recursive: true });
  for (const c of commits) version(path.join(hb, c), 10);
  return home;
}
// A converted main ONLY as a row (no container — the trace is read in B, also for stopped ones).
function mainRow(ctx, { state = "stopped", instance = "main", converted = true } = {}) {
  const s = scenario(ctx);
  store.createProjectInstance({ projectId: s.projectId, instance, state, ...(converted ? { convertedAt: Date.now() } : {}) });
  return { s, source: path.join(locationFor({ projectId: s.projectId, converted: true }).home, VSCODE_SERVER) };
}

test("(V) usedVersion: the newest trace over all converted mains (stopped ones too), at most 14 days; saved only on change; links, folders, foreign names, the future, copies and the cap do not count", async () => {
  await withAgentsServer(async (ctx) => {
    const now = Date.now();
    assert.equal(USED_DAYS, 14);
    // B knows the helper of EVERY version of this test (without it no trace would count): so each that does not count here falls for
    // ITS reason. The rule itself is held by the "(V) a trace counts only with the helper" test below.
    const bHome = helperHome(path.join(ctx.root, "home-b-v"), [C2, C3, ...["a", "7", "d", "e", "f", "1", "2", "9", "8"].map((x) => HEX(x))]);
    const usedVersion = (o) => usedVersionRaw({ home: bHome, ...o });
    // Without a main and without a trace: null, nothing saved, no line.
    await withLog(async (_w, rows) => {
      assert.equal(usedVersion({ now }), null);
      assert.equal(rows.length, 0, JSON.stringify(rows));
    });
    assert.equal(store.getSetting(USED_KEY, "no entry"), "no entry");
    const p1 = mainRow(ctx);
    const p2 = mainRow(ctx, { state: "ready" });
    fs.mkdirSync(p1.source, { recursive: true });
    fs.mkdirSync(p2.source, { recursive: true });
    assert.equal(usedVersion({ now }), null, "a trace without data/Machine");
    // P1: C2 two days ago; P2: C3 one day ago (only `.devport-`) — the newest is C3, saved with one line.
    lane(p1.source, C2, 2 * DAY, { now });
    lane(p2.source, C3, 1 * DAY, { now, only: "devport" });
    const b = await withLog(async (_w, rows) => {
      const x = usedVersion({ now });
      assert.ok(rows.some((y) => y.includes(`the Mac last worked with ${C3} (trace in project ${p2.s.projectId}`)), JSON.stringify(rows));
      return x;
    });
    assert.deepEqual([b.commit, b.projectId, Math.round(b.mtimeMs / 1000)], [C3, p2.s.projectId, Math.round((now - DAY) / 1000)]);
    assert.equal(store.getSetting(USED_KEY, ""), C3);
    // The same once more: no line (only on change).
    await withLog(async (_w, rows) => {
      assert.equal(usedVersion({ now }).commit, C3);
      assert.equal(rows.length, 0, JSON.stringify(rows));
    });
    // What does NOT count, all newer than C3: a link with trace names (target fresh), a folder with trace names, foreign names (capitals,
    // 39 characters, another prefix, a suffix), a trace from the FUTURE; a copy and an unconverted main with a fresh trace; a project
    // whose `data` or `Machine` is a link to a folder with a fresh trace.
    const m1 = path.join(p1.source, "data", "Machine");
    const outside = path.join(ctx.root, "outside-lane");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "file"), "x");
    fs.symlinkSync(path.join(outside, "file"), path.join(m1, `.devport-${HEX("a")}`));
    fs.mkdirSync(path.join(m1, `.devport-${HEX("7")}`)); // not HEX("b") — that is C2, whose real trace is here
    // Capitals with a letter no other name here carries: APFS does not distinguish case — `.devport-AAA…` would be the same entry as
    // the link `.devport-aaa…` above (and would write through it).
    for (const n of [`.devport-${HEX("F")}`, `.devport-${HEX("c", 39)}`, `.devports-${HEX("d")}`, `.devport-${HEX("d")}.alt`, `devport-${HEX("d")}`]) {
      fs.writeFileSync(path.join(m1, n), "x");
    }
    lane(p1.source, HEX("e"), -2 * DAY, { now }); // two days in the future
    const copy = mainRow(ctx, { instance: "copy-k1" });
    lane(copy.source, HEX("f"), 60_000, { now });
    const old = mainRow(ctx, { converted: false });
    lane(old.source, HEX("1"), 60_000, { now });
    const p3 = mainRow(ctx);
    fs.mkdirSync(p3.source, { recursive: true });
    const foreign = lane(path.join(ctx.root, "foreign-vs"), HEX("2"), 60_000, { now });
    fs.symlinkSync(path.dirname(foreign), path.join(p3.source, "data"));
    const p4 = mainRow(ctx);
    fs.mkdirSync(path.join(p4.source, "data"), { recursive: true });
    fs.symlinkSync(foreign, path.join(p4.source, "data", "Machine"));
    assert.equal(usedVersion({ now }).commit, C3, "something that must not count became the used version");
    assert.deepEqual([readTrace(p3.source, { now }).reason, readTrace(p4.source, { now }).reason], [`link: ${path.join(p3.source, "data")}`, `link: ${path.join(p4.source, "data", "Machine")}`]);
    assert.equal(readTrace(p1.source, { now: now + 3 * DAY }).lane.commit, HEX("e"), "counter-test: the same trace, no longer in the future, counts");
    for (const n of fs.readdirSync(m1)) if (n.endsWith(HEX("e"))) fs.rmSync(path.join(m1, n));
    // Built-in counter-test: the same trace REAL in P1 (a regular file, newer) — it wins.
    lane(p1.source, HEX("9"), 60_000, { now, only: "connection-token" });
    assert.equal(usedVersion({ now }).commit, HEX("9"));
    // The cap: a project with more entries in data/Machine — no trace from it (not the newest either), a warning with id.
    // P1 carries 10 entries (under the cap of 15), P5 22.
    assert.equal(fs.readdirSync(m1).length, 10);
    const p5 = mainRow(ctx);
    const m5 = lane(p5.source, HEX("8"), 1000, { now });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(m5, `noise-${i}`), "");
    await withLog(async (warnings) => {
      assert.equal(usedVersion({ now, cap: 15 }).commit, HEX("9"), "a trace beyond the cap counted");
      assert.ok(warnings.some((w) => w.includes(`VS Code server upfront project ${p5.s.projectId}: cap of 15 entries`)), JSON.stringify(warnings));
    });
    assert.equal(usedVersion({ now, cap: 25 }).commit, HEX("8"), "counter-test: under the cap the trace is there");
    // 14 days: 15 days later EVERY trace is too old — null, saved empty, a line that the protection falls.
    await withLog(async (_w, rows) => {
      assert.equal(usedVersion({ now: now + 15 * DAY }), null);
      assert.ok(rows.some((y) => y.includes(`no trace of a used version in the last 14 days — the protection of ${HEX("8")} falls`)), JSON.stringify(rows));
    });
    assert.equal(store.getSetting(USED_KEY, "x"), "");
    // Just inside the 14 days (one minute before the limit) the newest still counts.
    assert.equal(usedVersion({ now: now + 14 * DAY - 60_000 }).commit, HEX("8"));
  });
});

test("(V) a trace counts only with the helper of its version in B — without a helper folder none; a missing, linked, file or half-finished helper not; a newer foreign one does not hide an older real one; a foreign one on a KNOWN version still displaces (residual risk, named)", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => {
    const now = Date.now();
    // P1: the REAL trace of the Mac (C2, an hour ago); P2: a FOREIGN, newer one (a process in the project container: `touch
    // ~/.vscode-server/data/Machine/.devport-<Y>` — the folder is mounted rw there), on a version B does not know.
    const p1 = mainRow(ctx);
    const p2 = mainRow(ctx, { state: "ready" });
    lane(p1.source, C2, 3_600_000, { now });
    const FOREIGN = HEX("a");
    lane(p2.source, FOREIGN, 60_000, { now, only: "devport" });
    const home = path.join(root, "home-b");
    fs.mkdirSync(home);
    const vrc = path.join(home, HELPER_FOLDER);
    const hb = path.join(vrc, "bin");
    const bv = () => usedVersionRaw({ now, home });

    // Without a helper folder in B NO trace counts, not the real one either — null; a saved value falls, the line names the reason.
    store.setSetting(USED_KEY, C2);
    await withLog(async (_w, rows) => {
      assert.equal(bv(), null, "a trace counted without a helper folder in B");
      assert.ok(rows.some((x) => x.includes(`the protection of ${C2} falls (no helper folder of Dev Containers in ${hb}`)), JSON.stringify(rows));
    });
    assert.equal(store.getSetting(USED_KEY, "x"), "");
    // The helper folder without the helper of C2: none.
    fs.mkdirSync(hb, { recursive: true });
    assert.equal(bv(), null, "a trace without its helper counted");
    // A helper that is none: a link to a real folder, a file, only half-finished (`<c>_<ms>`) — none.
    const outside = version(path.join(root, "outside", C2), 10);
    fs.symlinkSync(outside, path.join(hb, C2));
    assert.equal(bv(), null, "a helper as a link counted");
    fs.unlinkSync(path.join(hb, C2));
    fs.writeFileSync(path.join(hb, C2), "");
    assert.equal(bv(), null, "a helper as a file counted");
    fs.unlinkSync(path.join(hb, C2));
    version(path.join(hb, `${C2}_1700000000123`), 10);
    assert.equal(bv(), null, "a half-finished helper counted");
    // `bin` or `.vscode-remote-containers` as a link to a folder WITH the helper: none.
    const foreignBin = path.join(root, "foreign-vrc", "bin");
    version(path.join(foreignBin, C2), 10);
    fs.renameSync(hb, `${hb}-away`);
    fs.symlinkSync(foreignBin, hb);
    assert.equal(bv(), null, "`bin` as a link counted");
    fs.unlinkSync(hb);
    fs.renameSync(`${hb}-away`, hb);
    fs.renameSync(vrc, `${vrc}-away`);
    fs.symlinkSync(path.dirname(foreignBin), vrc);
    assert.equal(bv(), null, "`.vscode-remote-containers` as a link counted");
    fs.unlinkSync(vrc);
    fs.renameSync(`${vrc}-away`, vrc);

    // Counter-test: the real helper of C2 (a folder) — the real trace counts although the foreign one in P2 is NEWER (without a helper).
    version(path.join(hb, C2), 10);
    const b = await withLog(async (_w, rows) => {
      const x = bv();
      assert.ok(rows.some((y) => y.includes(`the Mac last worked with ${C2} (trace in project ${p1.s.projectId}`) && y.includes("helper known in B")), JSON.stringify(rows));
      return x;
    });
    assert.deepEqual([b.commit, b.projectId], [C2, p1.s.projectId]);
    assert.equal(readTrace(p2.source, { now }).lane.commit, FOREIGN, "the foreign trace is there (without the check the newest)");
    // In the SAME project: a newer foreign trace does not hide the older real one (checked BEFORE choosing the newest) — without the
    // check the foreign one would be the newest there (built-in counter-test through readTrace without `counts`).
    lane(p1.source, HEX("6"), 30_000, { now });
    assert.equal(readTrace(p1.source, { now }).lane.commit, HEX("6"));
    assert.deepEqual([bv().commit, bv().projectId], [C2, p1.s.projectId], "a newer foreign trace in the same project hid the real one");

    // RESIDUAL RISK (named in the head of vscode-upfront.js): a foreign trace on a version B KNOWS — here the newest C, whose helper
    // the upfront fetch itself placed in B — still displaces the real one (for all projects: ONE value).
    version(path.join(hb, C), 10);
    lane(p2.source, C, 1000, { now, only: "devport" });
    assert.equal(bv().commit, C, "the named residual risk did not occur — head and test no longer agree");
    assert.equal(store.getSetting(USED_KEY, ""), C);
  }));
});

test("(V) pass with a used version: newest AND used into EVERY ready main (also one without `bin`); the trace counts only with the helper in B; the used one from the cache without a request; an error with the used one does not stop the newest", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs });
    try {
      // ORBIT-2: the trace of C2 (the Mac's version), but no `bin`; ORBIT: never open in VS Code (no `bin`, no trace).
      const ready = async () => {
        const s = scenario(ctx);
        const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
        assert.equal(row.state, "ready", row.error);
        setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() });
        const source = path.join(s.location.home, VSCODE_SERVER);
        return { s, source, bin: path.join(source, "bin") };
      };
      const orbit2 = await ready();
      const orbit = await ready();
      const qNew = sourceFolder(root);
      const qMac = sourceFolder(root, { commit: C2 });
      z.offer("new.tgz", tgz(entriesFrom(qNew)));
      z.offerVersion("mac.tgz", tgz(entriesFrom(qMac)), { commit: C2 });
      // B's home: first WITHOUT the Dev Containers helper folder.
      const home = path.join(root, "home-v");
      fs.mkdirSync(home);
      const hb = path.join(home, HELPER_FOLDER, "bin");
      // The target in the container is here the source itself (the fake docker runs locally) — a different one per project; the
      // pass's `creationHome` seam applies to all, so the creation's home per project goes through setCreationOptions.
      setCreationOptions((pid) => (pid === orbit2.s.projectId ? { home: orbit2.s.location.home } : pid === orbit.s.projectId ? { home: orbit.s.location.home } : {}));
      const seams = {
        api: z.api, versionTemplate: z.template, home, proc: proc(path.join(root, "procB"), []),
        procContainer: proc(path.join(root, "procP"), [], { mounts: [orbit2.source, orbit.source] }),
      };
      const cycle = () => withOps(fd, () => vscodeUpfrontCycle(seams), ON);

      // No trace yet, no version, no helper folder: no need, no request.
      assert.deepEqual(await cycle(), { status: "no-need" });
      assert.equal(z.requests.length, 0);
      // The trace in ORBIT-2 (VS Code ran there with C2, `bin` is not here — as after a re-creation), but B does not know its helper (no
      // helper folder): it does NOT count — no need, no request, nothing saved.
      lane(orbit2.source, C2, 60_000);
      assert.deepEqual(await withLog(() => cycle()), { status: "no-need" });
      assert.equal(z.requests.length, 0, "a trace without a helper in B triggered a request");
      assert.equal(store.getSetting(USED_KEY, "no entry"), "no entry", "a trace without a helper in B became the used version");
      // Dev Containers attached ORBIT-2 with C2: FIRST the helper in B, then the server into the project (here only the trace). Now it
      // counts; no project has a finished version, the need comes from the helper folder. The helper of C2 is the oldest in B (for
      // the cleanup there below).
      version(path.join(hb, C2), 20 * 86_400);
      const r = await withLog(async (_w, rows) => {
        const x = await cycle();
        assert.ok(rows.some((y) => y.includes(`the Mac last worked with ${C2}`)), JSON.stringify(rows));
        return x;
      });
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.deepEqual([r.newest, r.used], [C, C2]);
      assert.deepEqual(r.versions[C], { roles: ["newest"], fetch: { status: "fresh" }, helper: { status: "ok", target: path.join(hb, C) }, projects: { [orbit2.s.projectId]: { status: "ok" }, [orbit.s.projectId]: { status: "ok" } } });
      assert.deepEqual(r.versions[C2], {
        roles: ["used"], fetch: { status: "fresh" }, helper: { status: "already-there" },
        projects: { [orbit2.s.projectId]: { status: "ok" }, [orbit.s.projectId]: { status: "ok" } },
      });
      assert.deepEqual(r.cleanUp, { status: "nothing", removed: [], running: [] });
      const { cleanUp: cleanUpOrbit, ...orbitWithout } = r.projects[orbit.s.projectId];
      assert.deepEqual(orbitWithout, { status: "ok", versions: { [C]: { status: "ok" }, [C2]: { status: "ok" } } });
      assert.equal(cleanUpOrbit?.status, "nothing", "after placing no cleanup (or one with docker without a cause)");
      // ORBIT: `bin` created, BOTH versions with the layout of --strip-components 1.
      assert.deepEqual(content(orbit.bin), [C2, C].sort());
      assert.deepEqual(list(path.join(orbit.bin, C)), list(qNew));
      assert.deepEqual(list(path.join(orbit.bin, C2)), list(qMac));
      assert.deepEqual(content(orbit2.bin), [C2, C].sort());
      assert.deepEqual(protectedVersions(), [C, C2]);
      assert.deepEqual([z.count("/api"), z.count(`/v/${C2}`), z.count("/t/new.tgz"), z.count("/t/mac.tgz")], [1, 1, 1, 1]);
      assert.deepEqual(content(path.join(DIRS.data, CACHE_FOLDER)), [`${C2}.json`, `${C2}.tar.gz`, `${C}.json`, `${C}.tar.gz`].sort());

      // A second pass: the used one lies checked in the cache — Microsoft is NOT asked for it; no docker.
      const n = fd.calls().length;
      const r2 = await withLog(() => cycle());
      assert.equal(r2.status, "ok", JSON.stringify(r2));
      assert.deepEqual([r2.versions[C].fetch, r2.versions[C2].fetch], [{ status: "cache" }, { status: "cache" }]);
      assert.deepEqual([z.count("/api"), z.count(`/v/${C2}`)], [2, 1], "the used one was asked for despite the cache");
      assert.equal(fd.calls().length, n);

      // The cleanup in B protects both (the pass's list): three newer finished ones beside — the used one (the oldest helper) stays
      // anyway. The helper folder stays (without it no trace would count any more).
      for (const x of ["5", "6", "7"]) version(path.join(hb, HEX(x)), 10);
      const rh = await withLog(() => cycle());
      assert.deepEqual([rh.versions[C].helper?.status, rh.versions[C2].helper?.status], ["already-there", "already-there"], JSON.stringify(rh));
      assert.deepEqual(rh.cleanUp, { status: "nothing", removed: [], running: [] }, "the cleanup in B took a protected one");
      assert.deepEqual(content(hb), [C2, HEX("5"), HEX("6"), HEX("7"), C].sort());

      // The Mac uses the NEWEST (the upfront fetch placed its helper in B): one version with two roles, no request for another.
      lane(orbit2.source, C, 1000);
      const r3 = await withLog(() => cycle());
      assert.deepEqual([r3.used, Object.keys(r3.versions), r3.versions[C].roles], [C, [C], ["newest", "used"]]);
      assert.deepEqual(protectedVersions(), [C]);

      // An ERROR with the used one (Microsoft does not know it, 404): status error in the step ask — the newest runs anyway.
      const C4 = HEX("4");
      version(path.join(hb, C4), 10); // Dev Containers placed the Mac version's helper into B first
      lane(orbit2.source, C4, 10);
      fs.rmSync(path.join(orbit.bin, C), { recursive: true });
      const r4 = await withLog(async (warnings) => {
        const x = await cycle();
        assert.ok(warnings.some((w) => w.includes(`used version ${C4.slice(0, 8)}: not obtained from Microsoft`) && w.includes("HTTP 404")), JSON.stringify(warnings));
        return x;
      });
      assert.deepEqual([r4.status, r4.step, r4.code], ["error", "questions", "HTTP"]);
      assert.equal(r4.versions[C4].fetch.status, "error");
      assert.deepEqual(r4.versions[C4].projects, {});
      assert.deepEqual(r4.versions[C].projects[orbit.s.projectId], { status: "ok" }, "the newest was stopped by the error of the used one");
      assert.deepEqual(protectedVersions(), [C, C4]);
    } finally {
      setCreationOptions(null);
      workEnd();
      fd.cleanUp();
    }
  })));
});

// ── (N) Catching up ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(N) catching up: after a temporary error one attempt after CATCH_UP_MS, at most three in a row, then the tick; a success resets; a content error, 0 and close do not catch up", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs });
    const s0 = { home: process.env.HOME, api: process.env.CBASE_VSCODE_UPDATE_API };
    try {
      // Need through the helper folder in B (a temp home, never the real one); Microsoft is the test's endpoint.
      process.env.HOME = path.join(root, "home-n");
      const helperBin = path.join(process.env.HOME, HELPER_FOLDER, "bin");
      fs.mkdirSync(helperBin, { recursive: true });
      process.env.CBASE_VSCODE_UPDATE_API = z.api;
      const FAST = { ...ON, CBASE_VSCODE_UPFRONT_CATCH_UP_MS: "1" };
      // The tick's decisions in order (test seam, no timer): if a catch-up fails to happen, the decision is red — no waiting for a
      // request that never comes.
      const decisions = [];
      let wake = null;
      let read = 0;
      setUpfrontTickObserver((e) => { decisions.push(e); wake?.(); });
      const next = async () => {
        while (decisions.length <= read) await new Promise((r) => { wake = r; });
        return decisions[read++];
      };

      // (1) HTTP 500 four times: the start and three catch-up attempts — then nothing more planned, a warning, counting restarts.
      z.apiFollowUp = [500, 500, 500, 500];
      await withLog((warnings, rows) => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        for (let i = 1; i <= CATCH_UP_ATTEMPTS; i++) {
          const e = await next();
          assert.deepEqual([e.result.status, e.result.step, e.result.code, e.scheduled, e.attempts], ["error", "questions", "HTTP", true, i], `attempt ${i}`);
          assert.ok(rows.some((x) => x.includes(`next attempt in 1 min (${i} of 3)`)), JSON.stringify(rows));
        }
        const e = await next();
        assert.deepEqual([e.result.status, e.scheduled, e.attempts], ["error", false, 0]);
        assert.ok(warnings.some((w) => w.includes("3 catch-up attempts failed — next attempt in the tick (360 min)")), JSON.stringify(warnings));
      }, FAST));
      assert.equal(z.count("/api"), 4);
      stopVscodeUpfront();

      // (2) An error, then success: fetched, helper placed, the count back.
      z.offer("n.tgz", tgz(entriesFrom(sourceFolder(root))));
      z.apiFollowUp = [500];
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        assert.deepEqual([(await next()).scheduled, upfrontCatchUp().attempts], [true, 1]);
        const e = await next();
        assert.equal(e.result.status, "ok", JSON.stringify(e.result));
        assert.deepEqual(e.result.versions[C].helper, { status: "ok", target: path.join(helperBin, C) });
        assert.deepEqual([e.scheduled, e.attempts], [false, 0]);
      }, FAST));
      stopVscodeUpfront();

      // (3) An error in the CONTENT (wrong checksum) does not catch up.
      z.offer("x.tgz", Buffer.from("x"), { commit: C2, sha256: HEX("0", 64) });
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        const e = await next();
        assert.deepEqual([e.result.status, e.result.step, e.result.code, e.scheduled], ["error", "fetch", "CHECKSUM", false]);
      }, FAST));
      stopVscodeUpfront();

      // (4) CBASE_VSCODE_UPFRONT_CATCH_UP_MS=0: none. (5) Planned, then close (stopVscodeUpfront): gone.
      z.apiFollowUp = [500, 500];
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        const e = await next();
        assert.deepEqual([e.result.step, e.scheduled], ["questions", false]);
      }, { ...ON, CBASE_VSCODE_UPFRONT_CATCH_UP_MS: "0" }));
      stopVscodeUpfront();
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        assert.deepEqual([(await next()).scheduled, upfrontCatchUp()], [true, { scheduled: true, attempts: 1 }]);
        stopVscodeUpfront();
        assert.deepEqual(upfrontCatchUp(), { scheduled: false, attempts: 0 });
      }, { ...ON, CBASE_VSCODE_UPFRONT_CATCH_UP_MS: "3600000" }));
      assert.equal(z.count("/api"), 9);
      assert.equal(decisions.length, 9);

      // (6) A temporary error ONLY with the used version (HTTP 500 of the version interface; the newest comes from the cache) catches
      // up like one with the newest — the second attempt fetches it. The trace lies in a STOPPED main (read in B, no target — no
      // docker); Dev Containers placed its helper into B first.
      z.offer("n.tgz", tgz(entriesFrom(sourceFolder(root))));
      const { source: laneLocation } = mainRow(ctx);
      version(path.join(helperBin, C3), 60);
      lane(laneLocation, C3, 60_000);
      z.offerVersion("c3.tgz", tgz(entriesFrom(sourceFolder(root, { commit: C3 }))), { commit: C3 });
      z.versionFollowUp = [500];
      const beforeDocker = fd.calls().length;
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        const e1 = await next();
        assert.deepEqual([e1.result.status, e1.result.step, e1.result.code, e1.result.used, e1.scheduled, e1.attempts], ["error", "questions", "HTTP", C3, true, 1], JSON.stringify(e1.result));
        assert.deepEqual(e1.result.versions[C].fetch, { status: "cache" }, "the newest was stopped by the error of the used one");
        const e2 = await next();
        assert.equal(e2.result.status, "ok", JSON.stringify(e2.result));
        assert.deepEqual([e2.result.versions[C3].fetch, e2.result.versions[C3].helper], [{ status: "fresh" }, { status: "already-there" }]);
        assert.deepEqual([e2.scheduled, e2.attempts], [false, 0]);
      }, { ...FAST, CBASE_VSCODE_VERSION_API: z.template }));
      stopVscodeUpfront();
      assert.deepEqual([z.count("/api"), z.count(`/v/${C3}`), decisions.length], [11, 2, 11]);
      assert.equal(fd.calls().length, beforeDocker, "a stopped main became a target");
      assert.deepEqual(protectedVersions(), [C, C3]);

      // (7) The FIRST failure is a content error of the newest (wrong checksum — does not catch up alone), the second a temporary one
      // of the used one — that suffices (counted over ALL failures, not over the first). In the second attempt only the content
      // error remains: no further one.
      const C4 = HEX("4");
      z.offer("x2.tgz", Buffer.from("y"), { commit: C2, sha256: HEX("1", 64) });
      version(path.join(helperBin, C4), 30);
      lane(laneLocation, C4, 30_000);
      z.offerVersion("c4.tgz", tgz(entriesFrom(sourceFolder(root, { commit: C4 }))), { commit: C4 });
      z.versionFollowUp = [500];
      await withLog(() => withOps(fd, async () => {
        vscodeUpfrontRestartGrace();
        const e1 = await next();
        assert.deepEqual([e1.result.status, e1.result.step, e1.result.code, e1.result.used], ["error", "fetch", "CHECKSUM", C4], JSON.stringify(e1.result));
        assert.deepEqual(e1.result.failures.map((f) => [f.step, f.code]), [["fetch", "CHECKSUM"], ["questions", "HTTP"]]);
        assert.deepEqual([e1.scheduled, e1.attempts], [true, 1], "a temporary error of the used one behind a content error did not catch up");
        const e2 = await next();
        assert.deepEqual([e2.result.status, e2.result.code, e2.result.versions[C4].fetch, e2.scheduled, e2.attempts], ["error", "CHECKSUM", { status: "fresh" }, false, 0], JSON.stringify(e2.result));
      }, { ...FAST, CBASE_VSCODE_VERSION_API: z.template }));
      // The "rejected" marker of the newest survives fetching the used one in the same pass (`keep`) — otherwise the count of attempts
      // would restart at every tick, and a tarball with a wrong checksum would be loaded anew forever.
      assert.equal(denied(C2)?.attempts, 2, "the newest's marker fell when the used one was fetched");
      stopVscodeUpfront();
      assert.deepEqual([z.count("/api"), z.count(`/v/${C4}`), decisions.length], [13, 2, 13]);
    } finally {
      setUpfrontTickObserver(null);
      stopVscodeUpfront();
      if (s0.home === undefined) delete process.env.HOME; else process.env.HOME = s0.home;
      if (s0.api === undefined) delete process.env.CBASE_VSCODE_UPDATE_API; else process.env.CBASE_VSCODE_UPDATE_API = s0.api;
      fd.cleanUp();
    }
  })));
});

// ── (R) server.js and creation.js ──────────────────────────────────────────────────────────────────────────────────────

test("(R) neverMounted carries the cache and the helper folder (below); withOps (projectbox-scenario.mjs) switches the upfront fetch off, `values` back on", async () => {
  // Every other test in operation would otherwise ask Microsoft at the restart and place the helper in the REAL home (see projectbox-scenario.mjs).
  assert.equal(await withOps({ bin: "/not/da" }, () => upfrontTickMs()), 0);
  assert.equal(await withOps({ bin: "/not/da" }, () => upfrontTickMs(), ON), 21_600_000);
  assert.equal(await withOps({ bin: "/not/da" }, () => upfrontTickMs(), { CBASE_VSCODE_UPFRONT_MS: undefined }), 6 * 3_600_000);
  // The version interface points, in the test's operation, to a port without a listener, never to Microsoft; `values` sets it (the
  // switch stands in TUNABLES — otherwise withOps would silently not set it).
  assert.match(await withOps({ bin: "/not/da" }, () => versionApiTemplate()), /^http:\/\/127\.0\.0\.1:9\//, "withOps leaves the version interface at Microsoft");
  assert.equal(await withOps({ bin: "/not/da" }, () => versionApiTemplate(), { CBASE_VSCODE_VERSION_API: "http://127.0.0.1:1/v/{commit}" }), "http://127.0.0.1:1/v/{commit}");
  const flat = { scratch: "/f/s", attachments: "/f/a", outputs: "/f/o", playwrightConfigs: "/f/pc", playwrightProfiles: "/f/pp", browserProfiles: "/f/b", serviceLogs: "/f/l" };
  const never = neverMounted({ home: "/h", data: "/d", flat });
  assert.ok(never.some((n) => n.path === path.join("/d", CACHE_FOLDER) && n.below), "the cache is missing in \"never mounted\"");
  assert.ok(never.some((n) => n.path === path.join("/h", HELPER_FOLDER) && n.below), "the helper folder is missing in \"never mounted\"");
});

test("(R) server.js: the restart hook \"vscode-upfront\" before \"project-resumption\"; without operation no tick, with operation a tick that close ends; the consumer at atReady fetches upfront after cleaning up — without test seams it writes nothing", async () => {
  await withAgentsServer(async (ctx) => withTemp(async (root) => withEndpoint(async (z) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: scenario(ctx).programs });
    const s0 = { home: process.env.HOME, api: process.env.CBASE_VSCODE_UPDATE_API };
    try {
      // The order of the chain (without the operation marker nobody does anything).
      const names = [];
      observeHooks((info) => { if (info.kind === "restartGrace" && info.phase === "start") names.push(info.name); });
      try { await fireHooks("restartGrace", {}); } finally { observeHooks(null); }
      assert.ok(names.includes("vscode-upfront"), `order ${names.join(", ")}`);
      assert.ok(names.indexOf("vscode-upfront") < names.indexOf("project-resumption"), `order ${names.join(", ")}`);
      assert.equal(names.at(-1), "project-resumption");
      assert.equal(upfrontTickRunning(), false, "a tick without the operation marker");
      // With the operation marker, off: no tick. On: a tick and a pass — the test's home and endpoint (never the real home, never
      // Microsoft); without need it does not ask.
      await withLog((_w, rows) => withOps(fd, () => {
        assert.equal(vscodeUpfrontRestartGrace(), undefined);
        assert.ok(rows.some((x) => x.includes("VS Code server upfront off (CBASE_VSCODE_UPFRONT_MS=0)")), JSON.stringify(rows));
      }));
      assert.equal(upfrontTickRunning(), false);
      process.env.HOME = path.join(root, "home-empty");
      fs.mkdirSync(process.env.HOME);
      process.env.CBASE_VSCODE_UPDATE_API = z.api;
      await withOps(fd, async () => {
        assert.equal(vscodeUpfrontRestartGrace(), undefined);
        assert.equal(upfrontTickRunning(), true);
        assert.deepEqual(await runningCycle(), { status: "no-need" });
      }, ON);
      assert.equal(z.requests.length, 0);
      assert.equal(upfrontTickRunning(), true, "the tick ended before the server"); // `close` ends it (checked below)
      process.env.HOME = s0.home;

      // The consumer at atReady: after the main is restored the upfront fetch (after cleaning up), with the creation's home — and
      // without the seam the script reads the real /proc: no mount point, nothing written.
      const { s, source, bin } = await readyProject(ctx, fd, z, root);
      setCreationOptions((pid) => (pid === s.projectId ? s.opts : {}));
      fs.mkdirSync(bin);
      version(path.join(bin, C2), HOUR);
      await withOps(fd, async () => {
        await withLog(async (warnings) => {
          const w = await restoreInstance(s.projectId, "main", { root: s.root });
          assert.equal(w.state, "ready", w.error);
          await new Promise((r) => setImmediate(r)); // the tick in which atReady calls its consumers
          const run = runningUpfront(s.projectId);
          assert.ok(run, "the consumer at atReady did not start");
          assert.deepEqual(await run, { status: "no-mount", versions: { [C]: { status: "no-mount" } } });
          assert.ok(warnings.some((x) => x.includes("not a mount point")), JSON.stringify(warnings));
        });
      }, ON);
      assert.deepEqual(content(bin), [C2], "placed without a mount point");
      const [call, ...more] = execCalls(fd);
      assert.equal(more.length, 0);
      assert.equal(call[4], containerName(s.projectId));
      assert.equal(call[9], path.join(s.home, VSCODE_SERVER), "the target does not come from the creation's home (creationOptionsFor)");
      assert.deepEqual(call.slice(10, 13), [C, "/proc", inoOf(source)]);
      assert.ok(DIRS.data && fs.existsSync(path.join(DIRS.data, CACHE_FOLDER, `${C}.tar.gz`)));
    } finally {
      if (s0.home === undefined) delete process.env.HOME; else process.env.HOME = s0.home;
      if (s0.api === undefined) delete process.env.CBASE_VSCODE_UPDATE_API; else process.env.CBASE_VSCODE_UPDATE_API = s0.api;
      setCreationOptions(null);
      workEnd();
      fd.cleanUp();
    }
  })));
  const ran = upfrontTickRunning();
  stopVscodeUpfront();
  assert.equal(ran, false, "the tick kept running after the server ended (server.js `close`)");
});

// COUNTER-TESTS (each shown red, then reverted; one script replaced exactly one place per sabotage):
//   checkTarball: link/hard link not rejected                                     => (T) red
//   fetchTarball: checksum not compared                                           => (H) red
//   load: without the size cap (announced and streamed)                           => (H) red
//   checkTarball: commit in product.json not compared                             => (T), (H) red
//   fetchTarball: partial file not removed on failure                             => (H) red
//   fetchTarball: cache not reused                                                => (H), (D) red ("loaded a second time")
//   the helper-exists check through existsSync (follows links)                    => (B) red (written at the link's target)
//   helperInB: the whole tarball instead of the excerpt                           => (B), (D) red
//   cleanUpHelper: running ones not spared / protected ones not spared            => (B) red
//   script: without the mount-point check                                         => (S), (A), (R) server.js red — (R) would have written
//       LOCALLY into the scenario's folder through the fake docker
//   script: without the inode check (`other-folder` missing)                      => (S) red
//   script: without `--strip-components 1`                                        => (S), (A), (D) red (layout)
//   script: `bin` as a link not rejected                                          => (S) red
//   script: without the check AFTER `mv -n` (pushed in)                           => (S) red (leftover in the other's folder)
//   script: without `touch` (build time)                                          => (S), (A) red
//   upfrontProject: without the look in B always docker                           => (A), (D) red ("a docker call without a cause")
//   upfrontProject: copy not rejected                                             => (A) red
//   pass: without the need check                                                  => (D), (R) server.js red (request without need)
//   server.js: atReady without the upfront fetch / restart hook not registered / `close` does not stop the tick => (R) server.js red
//   creation.js: cache or helper folder not in neverMounted                       => (R) neverMounted red
//   projectbox-scenario.mjs: withOps without "upfront off"                        => (R) neverMounted and (R) server.js red
//   docker.js: execIn with stdin without `-i`                                     => (A), (D), (R) server.js red (tar read nothing)
//   a second delete place in B without an entry                                   => projectbox-rm-in-b.test.js red
//   fetchTarball: the "rejected" marker never blocks                              => (H) red (fourth download)
//   blocking without the cap condition (a larger cap stays blocked)               => (H) red
//   blocking without the state of the check (an old marker blocks)                => (H) red
//   cleanUpHelper: nested leftovers not searched                                  => (B) red
//   upfrontProject / pass: the look's cap without a warning                       => (A) / (D) red
//   pass / upfrontProject: architecture not checked                               => (D) / (A) red
//   vscode-server.js protectedVersions: protects also when switched off           => projectbox-vscode-server.test.js red
//   tick: never catch up                                                          => (N) red
//   networkError: cause not appended                                              => (F) red
//   a content error on fetching counts as temporary                               => (N) red
//   stopVscodeUpfront leaves a planned catch-up standing                          => (N) red
//   protectedVersions without the used one                                        => (A), (V) pass, (N) red
//   protectedVersions with a duplicate                                            => (V) pass red (one version, two roles)
//   protection set takes a single value                                           => (B) red
//   projectLook: if `bin` is missing, no cause                                   => (A), (V) pass red
//   script does not create a missing `bin` / a lost race for `bin` counts as an error => (S), (A), (V) pass / (S) red
//   cache cleanup: the needed ones do not count (only the two newest)             => (H) keep red
//   fetchTarball: "rejected" markers of needed versions fall / pass without `keep` => (H) keep, (N) red
//   pass: targets only mains with a version                                       => (D), (V) pass red
//   pass: the used one asked for at Microsoft despite the cache                   => (V) pass red
//   pass: an error of the used one does not count as a failure                    => (V) pass, (N) red
//   pass: the cleanup in B protects only the newest                               => (V) pass red (the used one fell in the helper)
//   catching up: only the first failure counts                                    => (N) red (case 7)
//   readTrace follows links / counts a future trace / without a cap               => (V) usedVersion red
//   readTrace: `data`/`Machine` as a link followed                                => (V) usedVersion red
//   usedVersion: without the 14-day limit / copies count / saved and reported without a change => (V) usedVersion red
//   questionVersion: `version` not checked against the commit / versionApi: commit not checked as 40 base-16 characters => (F) red
//   upfrontProject: only the newest protected / ABORT without effect             => (A) red
//   upfrontProject: no cleanup after placing / cleanup not awaited / without `protectedAlongside` => (A), (D) red
//   usedVersion without the helper check / helper check follows links / helper check after choosing the newest trace
//       / helper check without the exists check                                   => (V) helper-check test (and pass) red
//   NOT counter-tested: `mkdir` WITHOUT `-p` against a dangling link at the place of `bin` (also `mkdir -p` does not create the
//   target of a dangling link, the check after it catches it anyway); GNU tar (the Mac has bsdtar); the real /proc (process list
//   and mountinfo run through seams); the check before `mv -n` alone is a shortcut — the two checks after the mv catch the same race.
