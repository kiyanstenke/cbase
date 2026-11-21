// `POST …/files/copy {from, to}` — copy, paste, duplicate and ⌥-drag in the explorer. The computation lives in files.js `copyEntry`
// (B) and files-in-copy.js `copyEntry` (copy; files-in-copy.test.js measures it), the route in devtools/code-route.js on BOTH levels
// (code-scopes.test.js holds the anchor). Promises proven here:
//   (a) file and folder with content to a new place; a link is copied AS a link (its target verbatim, never its content), a FIFO is
//       left out (`omitted`); never overwritten (`TARGET_EXISTS`, the target stays byte-equal); no folder into itself, not the project
//       folder, a missing source is an error.
//   (b) With a boundary (a relocated project): a link out of the project is never read (its content appears nowhere), a target folder
//       leading outside writes nothing outside (EOUTSIDE).
//   (c) Cap with notice: above COPY_MAX_ENTRIES entries or COPY_MAX_BYTES bytes NOTHING is copied, the error says so
//       (`COPY_TOO_LARGE`) — bytes measured on a thin file (size without space).
//   (d) The route: 201 with `{ ok, path, copied, omitted }`, 409 `TARGET_EXISTS`, 400 with reason — on project and workspace level.
//   (e) No folder into itself via a link in the target path (`link → src`, target `link/zz`): the real place counts, nothing is
//       created. And exactly the PLAN of the count is copied: even when the location check is blind (descriptor test seam), 40 files
//       land in `src/zz`, not 12,480 (a second walk saw the entries just created and copied in a circle).
//
// COUNTER-TESTS (one place in files.js changed, only this file run):
//   `| fs.constants.O_EXCL` dropped when creating a file                                 ⇒ (a)(d) red (b.txt overwritten)
//   `if (e?.code === "EEXIST") throw withCode(…)` after the top entry dropped            ⇒ (a)(d) red (EEXIST instead of TARGET_EXISTS/409)
//   `kindOf`: a link counts as a file                                                    ⇒ (a)(b) red
//   the count before the first effect dropped (`entries` stays 1)                        ⇒ (c) red (the folder was copied)
//   the `/files/copy` branch in code-route.js (B) dropped                                ⇒ (d) red (404)
//   `checkTarget(targetLocationUpfront(…))` AND `checkTarget(locationOf(fd, path))` dropped (both location checks) ⇒ (e) red (src/zz appears)
//   `|| bytes > COPY_MAX_BYTES` in the count dropped                                     ⇒ (c) red (copied)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/files-copy.test.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyEntry, COPY_MAX_BYTES, COPY_MAX_ENTRIES } from "../electron/server/files.js";
import { realRoots, setDescriptorSeam } from "../electron/server/runtime/real-path.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

function create(root, rel, content = "x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
const errorOf = async (f) => { try { await f(); } catch (e) { return e; } return null; };
const withFolder = async (f) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-copy-")));
  try { return await f(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
const count = (d) => { let n = 0; for (const x of fs.readdirSync(d, { withFileTypes: true })) n += x.isDirectory() ? count(path.join(d, x.name)) : 1; return n; };

test("(a) file and folder with content, links as links, FIFO omitted, never overwritten", () => withFolder(async (root) => {
  const P = path.join(root, "project");
  create(P, "a.txt", "A\n");
  create(P, "src/x.ts", "X\n");
  create(P, "src/deep/y.ts", "Y\n");
  fs.symlinkSync("x.ts", path.join(P, "src", "pointer"));
  fs.symlinkSync("../../outside", path.join(P, "src", "outward"));
  execFileSync("mkfifo", [path.join(P, "src", "pipe")]);

  assert.deepEqual(await copyEntry(P, "a.txt", "a copy.txt"), { ok: true, path: "a copy.txt", copied: 1, omitted: 0 });
  assert.equal(fs.readFileSync(path.join(P, "a copy.txt"), "utf8"), "A\n");

  const r = await copyEntry(P, "src", "lib/src");
  assert.deepEqual(r, { ok: true, path: "lib/src", copied: 6, omitted: 1 }, "folder, two files, subfolder, two links; the FIFO is left out");
  assert.equal(fs.readFileSync(path.join(P, "lib/src/deep/y.ts"), "utf8"), "Y\n");
  assert.equal(fs.readlinkSync(path.join(P, "lib/src/pointer")), "x.ts", "a link stays a link with the same target");
  assert.equal(fs.readlinkSync(path.join(P, "lib/src/outward")), "../../outside");
  assert.equal(fs.existsSync(path.join(P, "lib/src/pipe")), false);

  // Never overwrite — not even a dangling link as target; the target stays as it was.
  create(P, "b.txt", "B\n");
  let e = await errorOf(() => copyEntry(P, "a.txt", "b.txt"));
  assert.deepEqual([e?.code, e?.message], ["TARGET_EXISTS", "Ziel existiert bereits"]);
  assert.equal(fs.readFileSync(path.join(P, "b.txt"), "utf8"), "B\n");
  fs.symlinkSync("exists-not", path.join(P, "dead"));
  assert.equal((await errorOf(() => copyEntry(P, "a.txt", "dead")))?.code, "TARGET_EXISTS");
  assert.equal((await errorOf(() => copyEntry(P, "src", "lib/src")))?.code, "TARGET_EXISTS", "an existing folder is not merged");

  assert.equal((await errorOf(() => copyEntry(P, "src", "src/inside")))?.message, "Ein Ordner lässt sich nicht in sich selbst kopieren");
  assert.equal((await errorOf(() => copyEntry(P, "src", "src")))?.message, "Ein Ordner lässt sich nicht in sich selbst kopieren");
  assert.equal((await errorOf(() => copyEntry(P, "", "fresh")))?.message, "Der Projektordner selbst lässt sich nicht kopieren");
  assert.equal((await errorOf(() => copyEntry(P, "missing.txt", "x.txt")))?.message, "Quelle nicht gefunden");
  assert.match((await errorOf(() => copyEntry(P, "a.txt", "../out.txt")))?.message ?? "", /außerhalb des Projekts/);
  assert.equal(fs.existsSync(path.join(root, "out.txt")), false);
}));

test("(b) With boundary: no link out of the project is read, a target folder leading out writes nothing outside", () => withFolder(async (root) => {
  const P = path.join(root, "project");
  const home = path.join(root, "home");
  create(home, ".bashrc", "B-SECRET\n");
  create(home, "data/db.txt", "B-DATA\n");
  create(P, "src/a.txt", "INSIDE\n");
  fs.symlinkSync(path.join(home, ".bashrc"), path.join(P, "src", "note"));
  fs.symlinkSync(path.join(home, "data"), path.join(P, "cache"));
  fs.symlinkSync(path.join(home, "data"), path.join(P, "out"));
  const limit = () => realRoots([P]);

  assert.deepEqual(await copyEntry(P, "src", "src2", { limit }), { ok: true, path: "src2", copied: 3, omitted: 0 });
  assert.equal(fs.lstatSync(path.join(P, "src2", "note")).isSymbolicLink(), true, "the link was read instead of copied");
  // A folder link as source: the link is copied, never the folder behind it.
  assert.deepEqual(await copyEntry(P, "cache", "cache2", { limit }), { ok: true, path: "cache2", copied: 1, omitted: 0 });
  assert.equal(fs.lstatSync(path.join(P, "cache2")).isSymbolicLink(), true);
  // A target below a link leading out: nothing is created outside.
  const e = await errorOf(() => copyEntry(P, "src/a.txt", "out/a.txt", { limit }));
  assert.equal(e?.code, "EOUTSIDE", String(e?.message));
  assert.deepEqual(fs.readdirSync(path.join(home, "data")), ["db.txt"], "something was written outside");
  // What is in B appears nowhere in the project.
  const all = [];
  const go = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.lstatSync(p); if (s.isDirectory()) go(p); else if (s.isFile()) all.push(fs.readFileSync(p, "utf8")); } };
  go(P);
  assert.ok(!all.some((x) => /B-SECRET|B-DATA/.test(x)), "content of B is in the project");
}));

test("(c) cap with notice: above COPY_MAX_ENTRIES or COPY_MAX_BYTES nothing is copied", () => withFolder(async (root) => {
  const P = path.join(root, "project");
  for (let i = 0; i <= COPY_MAX_ENTRIES; i++) create(P, `many/${i}.txt`, "");
  let e = await errorOf(() => copyEntry(P, "many", "many2"));
  assert.equal(e?.code, "COPY_TOO_LARGE", String(e?.message));
  assert.match(e.message, new RegExp(`${COPY_MAX_ENTRIES} Einträge`));
  assert.equal(fs.existsSync(path.join(P, "many2")), false, "already copied above the cap");
  // The bytes: a thin file (size without space) just above the cap — in a folder and alone.
  create(P, "large/small.txt", "k\n");
  fs.closeSync(fs.openSync(path.join(P, "large", "thin.bin"), "w"));
  fs.truncateSync(path.join(P, "large", "thin.bin"), COPY_MAX_BYTES + 1);
  e = await errorOf(() => copyEntry(P, "large", "large2"));
  assert.equal(e?.code, "COPY_TOO_LARGE", String(e?.message));
  assert.equal(fs.existsSync(path.join(P, "large2")), false, "already copied above the byte cap");
  e = await errorOf(() => copyEntry(P, "large/thin.bin", "thin2.bin"));
  assert.equal(e?.code, "COPY_TOO_LARGE", String(e?.message));
  assert.equal(fs.existsSync(path.join(P, "thin2.bin")), false);
}));

test("(e) no folder into itself via a link in the target, and exactly the plan is copied", () => withFolder(async (root) => {
  const P = path.join(root, "project");
  for (let i = 0; i < 40; i++) create(P, `src/f${String(i).padStart(2, "0")}.txt`, "x".repeat(1000));
  fs.symlinkSync("src", path.join(P, "link"));
  const e = await errorOf(() => copyEntry(P, "src", "link/zz"));
  assert.equal(e?.message, "Ein Ordner lässt sich nicht in sich selbst kopieren", String(e?.message));
  assert.equal(fs.existsSync(path.join(P, "src", "zz")), false, "something appeared in the source via the link");
  assert.equal(count(path.join(P, "src")), 40);
  assert.equal(await errorOf(() => copyEntry(P, "src", "link/fresh/zz")).then((x) => x?.message), "Ein Ordner lässt sich nicht in sich selbst kopieren");
  assert.equal(fs.existsSync(path.join(P, "src", "fresh")), false, "the upfront check already created folders");
  // Blind location check (every descriptor at its own invented place): the plan alone keeps the copy at 40 files.
  setDescriptorSeam((fd) => `/blind/${fd}`);
  try {
    const r = await copyEntry(P, "src", "link/zz");
    assert.deepEqual(r, { ok: true, path: "link/zz", copied: 41, omitted: 0 });
  } finally { setDescriptorSeam(null); }
  assert.equal(count(path.join(P, "src", "zz")), 40, "more was copied than the plan");
  assert.equal(count(path.join(P, "src")), 80);
}));

test("(d) the route on both levels: 201 with counts, 409 TARGET_EXISTS, 400 with reason", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    create(projPath, "src/a.ts", "A\n");
    create(projPath, "src/b.ts", "B\n");
    const ws = await makeWorkspace(base, "Copying", wsPath);
    const proj = await makeProject(base, ws.id, projPath, "Checkout");
    const copy = (route, from, to) => json(`${base}${route}/files/copy`, { method: "POST", body: JSON.stringify({ from, to }) });

    let r = await copy(`/api/projects/${proj.id}`, "src/a.ts", "src/a copy.ts");
    assert.deepEqual([r.status, r.body], [201, { ok: true, path: "src/a copy.ts", copied: 1, omitted: 0 }]);
    r = await copy(`/api/projects/${proj.id}`, "src/a.ts", "src/b.ts");
    assert.deepEqual([r.status, r.body?.code], [409, "TARGET_EXISTS"], JSON.stringify(r.body));
    assert.equal(fs.readFileSync(path.join(projPath, "src", "b.ts"), "utf8"), "B\n");
    r = await copy(`/api/projects/${proj.id}`, "src", "src/inside");
    assert.deepEqual([r.status, r.body?.error], [400, "Ein Ordner lässt sich nicht in sich selbst kopieren"]);

    const rel = path.relative(wsPath, projPath).split(path.sep).join("/");
    r = await copy(`/api/workspaces/${ws.id}`, `${rel}/src`, `${rel}/src2`);
    assert.deepEqual([r.status, r.body], [201, { ok: true, path: `${rel}/src2`, copied: 4, omitted: 0 }]);
    assert.deepEqual(fs.readdirSync(path.join(projPath, "src2")).sort(), ["a copy.ts", "a.ts", "b.ts"]);
    r = await copy(`/api/workspaces/${ws.id}`, `${rel}/src`, `${rel}/src2`);
    assert.deepEqual([r.status, r.body?.code], [409, "TARGET_EXISTS"]);
  });
});
