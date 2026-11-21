// The time axis of a file: `POST …/git/log` with `timeAxis: true` (electron/server/git.js gitTimeAxis), measured against a REAL repo in a
// temp folder — git itself is the oracle.
//
// What it proves:
//   (a) Only the commits that changed THIS file, newest first, across a rename (`--follow`); per commit the path THERE (`file`), at the
//       rename commit also the old one (`old`); subject (special characters too), author, e-mail, committer time.
//   (b) The cap says it is one: `clipped` exactly when older commits exist; never more than TIME_AXIS_CAP.
//   (c) A file without history (untracked) => empty, no error; without a file => 400.
//   (d) The route passes `timeAxis` through; without the field the response stays `{ commits }`; the path is reading (COPY_READING).
//   (e) Paths as git means them: a rename "Über.md" -> "Ärger.md" arrives UNQUOTED (not `"\303\204rger.md"`); "app/[id]/page.tsx" and
//       "a?.md" are literal paths, not patterns (they must not pull in the commits of "app/d/page.tsx" or "abc.md").
//   (f) "Load more": the cursor `after` (hash of the last entry, plus its path THERE) pages — the pages together are exactly the whole
//       time axis, across the rename too (a `--skip` lost it), `clipped` only up to the second-to-last page.
//
// Counter-tests (test "counter-tests"): the same checks over deliberately wrong versions of argv and reading — without `--follow`,
// without the one extra entry at `-n`, without the rename in the reading, without the status line, the old version without `-z` (quoted
// paths), without `--literal-pathspecs`, `--skip` instead of a cursor, a cursor without its path. Each must throw.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/git-time-axis.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";

import { TIME_AXIS_CAP, gitTimeAxis, parseTimeAxis, timeAxisArgs } from "../electron/server/git.js";
import { COPY_READING, codeRoute } from "../electron/server/devtools/code-route.js";

// ── Isolation (like git-graph-log.test.js): no foreign ~/.gitconfig ──
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-time-axis-")));
after(() => { try { fs.rmSync(ISO, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ } });
fs.mkdirSync(path.join(ISO, "home"));
fs.mkdirSync(path.join(ISO, "xdg"));
Object.assign(process.env, { HOME: path.join(ISO, "home"), XDG_CONFIG_HOME: path.join(ISO, "xdg"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) delete process.env[k];

const git = (cwd, args, env = {}) => {
  const r = spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
let clock = 1_790_000_000;
const TIMES = [];
function commit(cwd, subject, who = "Testerin") {
  const time = (clock += 3600);
  TIMES.push(time);
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@example.com`, "commit", "-q", "-m", subject], { GIT_AUTHOR_DATE: `@${time} +0000`, GIT_COMMITTER_DATE: `@${time} +0000` });
  return { hash: git(cwd, ["rev-parse", "HEAD"]).trim(), time };
}

// The repo: a.txt created (1), c.txt foreign (2), a.txt changed (3), a.txt -> b.txt renamed (4), b.txt changed (5).
const REPO = path.join(ISO, "repo");
fs.mkdirSync(REPO);
git(REPO, ["init", "-q", "-b", "main"]);
const CONTENT = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n");
fs.writeFileSync(path.join(REPO, "a.txt"), `${CONTENT}\n`);
const c1 = commit(REPO, "a created");
fs.writeFileSync(path.join(REPO, "c.txt"), "foreign\n");
const c2 = commit(REPO, "foreign file");
fs.writeFileSync(path.join(REPO, "a.txt"), `${CONTENT}\nmore\n`);
const c3 = commit(REPO, "a changed: Ümlaut | pipe", "Second");
git(REPO, ["mv", "a.txt", "b.txt"]);
const c4 = commit(REPO, "renamed");
fs.writeFileSync(path.join(REPO, "b.txt"), `${CONTENT}\nmore\nstill more\n`);
const c5 = commit(REPO, "b changed");
fs.writeFileSync(path.join(REPO, "fresh.txt"), "untracked\n");

// The second repo: "Über.md" created (1), renamed to "Ärger.md" (2); "app/[id]/page.tsx" (3) next to "app/d/page.tsx" (4,
// changed again in 5); "a?.md" (6) next to "abc.md" (7).
const PATHS = path.join(ISO, "paths");
fs.mkdirSync(PATHS);
git(PATHS, ["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(PATHS, "Über.md"), `${CONTENT}\n`);
const u1 = commit(PATHS, "Über created");
git(PATHS, ["mv", "Über.md", "Ärger.md"]);
const u2 = commit(PATHS, "renamed to Ärger");
fs.mkdirSync(path.join(PATHS, "app", "[id]"), { recursive: true });
fs.mkdirSync(path.join(PATHS, "app", "d"), { recursive: true });
fs.writeFileSync(path.join(PATHS, "app", "[id]", "page.tsx"), "square-bracket\n");
const p3 = commit(PATHS, "square");
fs.writeFileSync(path.join(PATHS, "app", "d", "page.tsx"), "d\n");
const p4 = commit(PATHS, "d created");
fs.writeFileSync(path.join(PATHS, "app", "d", "page.tsx"), "d2\n");
commit(PATHS, "d changed");
fs.writeFileSync(path.join(PATHS, "a?.md"), "question\n");
const f6 = commit(PATHS, "question mark");
fs.writeFileSync(path.join(PATHS, "abc.md"), "ab\n");
commit(PATHS, "ab created");

// The time axis over argv and reading — the counter-tests swap one of the two.
const over = (args = timeAxisArgs, read = parseTimeAxis, cwd = REPO) => (file, n, target = null) => {
  const out = spawnSync("git", args(file, n, target), { cwd, encoding: "utf8" }).stdout;
  return read(out, n, file, target);
};
// "Load more" as the view does it: page by page, the cursor is the last entry (hash and its path there).
const allPages = (z, file, n, pathThere = true) => {
  const pages = [];
  let target = null, filePath = file;
  for (let i = 0; i < 10; i++) {
    const s = z(filePath, n, target);
    pages.push(s);
    if (!s.clipped) break;
    const last = s.entries[s.entries.length - 1];
    target = last.hash;
    if (pathThere) filePath = last.file;
  }
  return pages;
};
// The old version (without -z, without quotePath, without literal-pathspecs, line reading) — the counter-test for (e).
const US = "\x1f";
const oldArgs = (file, n) => ["log", "--follow", "-M", "--no-show-signature", "--no-color", "--name-status", `--format=%x1e%H${US}%h${US}%an${US}%ae${US}%ct${US}%s`, "-n", String(n + 1), "--", file];
function oldReading(out, n, asked) {
  const entries = [];
  for (const block of String(out).split("\x1e")) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split("\n");
    const [hash, short, author, email, ct, ...subject] = header.split(US);
    if (!/^[0-9a-f]{40}$/.test(hash || "")) continue;
    let file = null, old = null;
    for (const row of rest) {
      const parts = row.split("\t");
      if (parts.length < 2) continue;
      if (/^[RC]\d*$/.test(parts[0]) && parts.length >= 3) { old = parts[1]; file = parts[2]; } else file = parts[1];
      break;
    }
    entries.push({ hash, short, subject: subject.join(US), author, email, time: Number(ct), file: file || asked, ...(old && old !== file ? { old: old } : {}) });
  }
  return { entries: entries.slice(0, n), clipped: entries.length > n };
}

const CHECKS = {
  follows: (z) => {
    const r = z("b.txt", TIME_AXIS_CAP);
    assert.deepEqual(r.entries.map((e) => e.hash), [c5.hash, c4.hash, c3.hash, c1.hash], "the commits of the file, newest first, across the rename");
    assert.equal(r.clipped, false);
    assert.deepEqual(r.entries.map((e) => e.file), ["b.txt", "b.txt", "a.txt", "a.txt"], "the path IN the commit");
    assert.equal(r.entries[1].old, "a.txt", "the old path at the rename commit");
    assert.equal(r.entries[0].old, undefined);
    assert.equal(r.entries[2].subject, "a changed: Ümlaut | pipe");
    assert.equal(r.entries[2].author, "Second");
    assert.equal(r.entries[2].email, "second@example.com");
    assert.equal(r.entries[2].time, c3.time);
    assert.equal(r.entries[0].short, c5.hash.slice(0, r.entries[0].short.length));
    assert.ok(!r.entries.some((e) => e.hash === c2.hash), "a foreign commit does not belong");
  },
  cap: (z) => {
    const two = z("b.txt", 2);
    assert.equal(two.entries.length, 2);
    assert.equal(two.clipped, true, "older ones exist — the cap must say so");
    const four = z("b.txt", 4);
    assert.equal(four.entries.length, 4);
    assert.equal(four.clipped, false, "exactly four — nothing clipped");
  },
  // (f) Pages of 2 (c5 c4 | c3 c1) and of 1 (c5 | c4 | c3 | c1 — the cursor sits ON the rename): together exactly the whole time axis,
  // `clipped` only up to the second-to-last page.
  paginate: (z) => {
    for (const n of [2, 1, 3]) {
      const pages = allPages(z, "b.txt", n);
      assert.deepEqual(pages.flatMap((s) => s.entries.map((e) => e.hash)), [c5.hash, c4.hash, c3.hash, c1.hash], `pages of ${n}: exactly the whole time axis, across the rename`);
      assert.deepEqual(pages.map((s) => s.clipped), pages.map((_, i) => i < pages.length - 1), `pages of ${n}: clipped up to the second-to-last`);
    }
    const two = z("a.txt", 2, c4.hash);
    assert.deepEqual(two.entries.map((e) => e.hash), [c3.hash, c1.hash], "the cursor itself drops out");
  },
};
// (e) Paths: unquoted, literal.
const PATH_CHECKS = {
  umlaut: (z) => {
    const r = z("Ärger.md", TIME_AXIS_CAP);
    assert.deepEqual(r.entries.map((e) => e.hash), [u2.hash, u1.hash]);
    assert.equal(r.entries[0].file, "Ärger.md", "the path arrives unquoted (not \"\\303\\204rger.md\")");
    assert.equal(r.entries[0].old, "Über.md", "the old path likewise");
    assert.equal(r.entries[1].file, "Über.md");
  },
  verbatim: (z) => {
    assert.deepEqual(z("app/[id]/page.tsx", TIME_AXIS_CAP).entries.map((e) => e.hash), [p3.hash], "\"[id]\" is a folder name, not a pattern");
    assert.deepEqual(z("a?.md", TIME_AXIS_CAP).entries.map((e) => e.hash), [f6.hash], "\"?\" is a character, not a wildcard");
    assert.ok(z("app/d/page.tsx", TIME_AXIS_CAP).entries.some((e) => e.hash === p4.hash));
  },
};

test("(a)(b) the commits of the file across the rename, with a cap", async () => {
  for (const [name, p] of Object.entries(CHECKS)) {
    try { p(over()); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  // The same path via gitTimeAxis (repoAt, raw).
  const r = await gitTimeAxis(REPO, "", "b.txt", {});
  assert.deepEqual(r.entries.map((e) => e.hash), [c5.hash, c4.hash, c3.hash, c1.hash]);
  const k = await gitTimeAxis(REPO, "", "b.txt", { limit: 1 });
  assert.deepEqual([k.entries.length, k.clipped], [1, true]);
  assert.equal((await gitTimeAxis(REPO, "", "b.txt", { limit: 10_000 })).entries.length, 4, "an oversized limit is clamped to the cap");
});

test("(e)(f) umlaut rename unquoted, pattern characters literal, paging via cursor — also via gitTimeAxis and the route", async () => {
  for (const [name, p] of Object.entries(PATH_CHECKS)) {
    try { p(over(timeAxisArgs, parseTimeAxis, PATHS)); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const r = await gitTimeAxis(PATHS, "", "Ärger.md", {});
  assert.deepEqual([r.entries[0].file, r.entries[0].old], ["Ärger.md", "Über.md"]);
  assert.deepEqual((await gitTimeAxis(PATHS, "", "app/[id]/page.tsx", {})).entries.map((e) => e.hash), [p3.hash]);
  const page2 = await gitTimeAxis(REPO, "", "b.txt", { limit: 2, after: c4.hash });
  assert.deepEqual(page2.entries.map((e) => e.hash), [c3.hash, c1.hash], "the cursor on the rename, with its path there");
  await assert.rejects(gitTimeAxis(REPO, "", "b.txt", { after: "--all" }), (e) => e.status === 400, "a cursor that is not a hash is a 400 (never an option)");
  const route = await logRoute({ repo: "", file: "a.txt", timeAxis: true, limit: 2, after: c3.hash });
  assert.deepEqual(route.body.entries.map((e) => e.hash), [c1.hash], "the route passes the cursor through");
});

test("(c) untracked => empty; without a file => 400", async () => {
  assert.deepEqual(await gitTimeAxis(REPO, "", "fresh.txt", {}), { entries: [], clipped: false });
  await assert.rejects(gitTimeAxis(REPO, "", "", {}), (e) => e.status === 400);
});

function stubResponse() {
  const r = { status: 0, parts: [], writeHead(c) { r.status = c; }, setHeader() {}, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function logRoute(body) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = stubResponse();
  await codeRoute(REPO, "/git/log", "POST", req, res, new URL("http://x/api/x/git/log"), {});
  return { status: res.status, body: res.json };
}

test("(d) the route passes timeAxis through, without the field the response stays as before, reading", async () => {
  const z = await logRoute({ repo: "", file: "b.txt", timeAxis: true });
  assert.equal(z.status, 200, JSON.stringify(z.body));
  assert.deepEqual(z.body.entries.map((e) => e.hash), [c5.hash, c4.hash, c3.hash, c1.hash]);
  assert.equal(z.body.entries[1].old, "a.txt");
  const old = await logRoute({ repo: "", file: "b.txt" });
  assert.equal(old.status, 200);
  assert.ok(Array.isArray(old.body.commits) && !("entries" in old.body), "without timeAxis the response stays as before");
  assert.ok(COPY_READING.includes("POST /git/log"), "the time axis is reading — a copy being torn down keeps reading");
});

// ── Counter-tests ──
test("counter-tests: every wrong version is caught", () => {
  const without = (args, way) => (d, n) => args(d, n).filter((a) => a !== way);
  const SABOTAGES = [
    ["without --follow", over(without(timeAxisArgs, "--follow")), "follows"],
    ["-n without the one extra", over((d, n) => timeAxisArgs(d, n).map((a, i, l) => (l[i - 1] === "-n" ? String(n) : a))), "cap"],
    ["rename not read", over(timeAxisArgs, (out, n, d) => {
      const r = parseTimeAxis(out, n, d);
      return { ...r, entries: r.entries.map(({ old, ...e }) => e) }; // eslint-disable-line no-unused-vars
    }), "follows"],
    ["without status lines", over(without(timeAxisArgs, "--name-status")), "follows"],
    // An offset path (today's file, `--skip` = entries already shown) — this is how git lost the rename.
    ["--skip instead of a cursor", (_file, n, target) => {
      const full = [c5.hash, c4.hash, c3.hash, c1.hash];
      const skip = target ? full.indexOf(target) + 1 : 0;
      const args = timeAxisArgs("b.txt", n), i = args.indexOf("--");
      const out = spawnSync("git", [...args.slice(0, i), ...(skip ? [`--skip=${skip}`] : []), ...args.slice(i)], { cwd: REPO, encoding: "utf8" }).stdout;
      return parseTimeAxis(out, n, "b.txt");
    }, "paginate"],
    ["cursor without its path", (file, n, target) => over()(target ? "b.txt" : file, n, target), "paginate"],
  ];
  for (const [name, z, check] of SABOTAGES) {
    assert.throws(() => CHECKS[check](z), `counter-test "${name}" stayed green — "${check}" measures nothing there`);
  }
  const PATH_SABOTAGES = [
    ["the old version (without -z, line reading): quoted paths", over(oldArgs, oldReading, PATHS), "umlaut"],
    ["without --literal-pathspecs", over(without(timeAxisArgs, "--literal-pathspecs"), parseTimeAxis, PATHS), "verbatim"],
  ];
  for (const [name, z, check] of PATH_SABOTAGES) {
    assert.throws(() => PATH_CHECKS[check](z), `counter-test "${name}" stayed green — "${check}" measures nothing there`);
  }
});
