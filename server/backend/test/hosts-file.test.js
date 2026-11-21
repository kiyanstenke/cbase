// Guard of the names `<project>.cbase`. The contract: /etc/hosts of B holds for each instance exactly one line
// `<ip> <name>.cbase`, all other lines stay - byte-equal.
//
// Held here:
//   - the block (projectbox/hosts-file.js, pure): foreign lines stay, the block is replaced in its place, appended when it is
//     missing, gone without entries (byte-equal to the original), a second run byte-equal, a broken block is not "repaired",
//     bytes that are not UTF-8 survive, a name with a line break writes no foreign line;
//   - the writing: the same inode (`statSync().ino`) - counter-test: a copy with tmp + rename (under /tmp) changes it and
//     fails the same check; without write permission and without a file no throw, a message, the file unchanged;
//   - the rule (projectbox/names.js): slugifyTitle + `.cbase`, `-2`, `-3` in creation order, also across workspaces, fixed
//     after creation (renaming changes nothing), at most 63 characters per label, empty => `project`;
//   - at the server with a redirected path (CBASE_HOSTS_FILE) and the fake docker: after creation the name is there, after
//     deleting the project it is gone, the restart hook "project-names" rewrites a lost block (B rebuilds /etc/hosts at every
//     start), `GET /api/projects` carries `instance` only on projects with a row; without the operating mark nothing
//     touches the file and no docker runs.
//
// Counter-tests (which sabotage turns which test red):
//   hosts-file.js: tmp + rename instead of writeFileSync             => "Inode ..." red - as a copy IN the test (see there)
//   instance.js: drop `dnsName: dnsNameOf(pid)`                    => "at the server ..." red (no name after creation)
//   instance.js: drop `bringAlongNames()` after creation             => "at the server ..." red (file without block)
//   server.js: drop the registration "project-names"                 => "at the server ..." red (restart writes nothing)
//   erase.js: drop `bringAlongNames()` at the end                    => "at the server ..." red (the name stayed)
//   names.js: without shortening by the suffix                       => "Rule ..." red (64 characters)
//
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/hosts-file.test.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { BLOCK_BEGINNING, BLOCK_END, HOSTS_DEFAULT, hostsPath, withHostsBlock, writeHostsBlock } from "../electron/server/projectbox/hosts-file.js";
import { LABEL_MAX, NAMES_SUFFIX, dnsNameOf, freeName, nameBase, bringAlongNames } from "../electron/server/projectbox/names.js";
import { createInstance } from "../electron/server/projectbox/instance.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { HOSTS_TEST, ID, withOps, scenario } from "./projectbox-scenario.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const SOURCE = path.resolve(TESTDIR, "..", "electron", "server", "projectbox", "hosts-file.js");

const FOREIGN = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost\n# from docker\n172.24.0.5\tb-container\n";
const E = (ip, name) => ({ ip, name });

function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-hosts-"));
  return { d, file: (content) => { const p = path.join(d, "hosts"); fs.writeFileSync(p, content); return p; }, cleanUp: () => fs.rmSync(d, { recursive: true, force: true }) };
}

// ── The block, pure ──────────────────────────────────────────────────────────────────────────────────────────────

test("block: appended, replaced in its place, gone without entries - foreign lines byte-equal, second run the same", () => {
  const one = withHostsBlock(FOREIGN, [E("10.230.0.2", "till.cbase")]);
  assert.equal(one.text, `${FOREIGN}${BLOCK_BEGINNING}\n10.230.0.2 till.cbase\n${BLOCK_END}\n`);
  assert.equal(withHostsBlock(one.text, [E("10.230.0.2", "till.cbase")]).text, one.text, "second run not byte-equal");

  // A block in the middle of the file stays in its place, the lines after it stay behind it.
  const middle = `127.0.0.1 localhost\n${BLOCK_BEGINNING}\n10.230.0.2 old.cbase\n${BLOCK_END}\n10.0.0.9 after\n`;
  assert.equal(withHostsBlock(middle, [E("10.230.0.2", "till.cbase"), E("10.230.1.2", "depot.cbase")]).text,
    `127.0.0.1 localhost\n${BLOCK_BEGINNING}\n10.230.0.2 till.cbase\n10.230.1.2 depot.cbase\n${BLOCK_END}\n10.0.0.9 after\n`);
  assert.equal(withHostsBlock(middle, []).text, "127.0.0.1 localhost\n10.0.0.9 after\n", "without entries the block must go");

  // There and back: the same original.
  assert.equal(withHostsBlock(one.text, []).text, FOREIGN, "block in and out again is not the original");
  assert.equal(withHostsBlock(FOREIGN, []).text, FOREIGN, "without block and without entries nothing changes");
  assert.equal(withHostsBlock("", [E("10.230.0.2", "a.cbase")]).text, `${BLOCK_BEGINNING}\n10.230.0.2 a.cbase\n${BLOCK_END}\n`);
  assert.equal(withHostsBlock(`${BLOCK_BEGINNING}\n10.230.0.2 a.cbase\n${BLOCK_END}\n`, []).text, "");

  // Without a final line end: the last foreign line gets one (otherwise BEGIN would stand on it).
  assert.equal(withHostsBlock("127.0.0.1 localhost", [E("10.230.0.2", "a.cbase")]).text, `127.0.0.1 localhost\n${BLOCK_BEGINNING}\n10.230.0.2 a.cbase\n${BLOCK_END}\n`);
  // A block in the middle of a file without a final line end: the end stays as it was.
  assert.equal(withHostsBlock(`a\n${BLOCK_BEGINNING}\nx\n${BLOCK_END}\nb`, []).text, "a\nb");

  // Two complete blocks become one, in the place of the first.
  const two = `a\n${BLOCK_BEGINNING}\n1.1.1.1 x.cbase\n${BLOCK_END}\nb\n${BLOCK_BEGINNING}\n2.2.2.2 y.cbase\n${BLOCK_END}\nc\n`;
  assert.equal(withHostsBlock(two, [E("10.230.0.2", "k.cbase")]).text, `a\n${BLOCK_BEGINNING}\n10.230.0.2 k.cbase\n${BLOCK_END}\nb\nc\n`);
});

test("block: a broken block is not repaired, a broken entry is not written", () => {
  assert.match(withHostsBlock(`a\n${BLOCK_BEGINNING}\n1.1.1.1 x.cbase\nforeign\n`, []).error, /without “# cbase-projects END”/);
  assert.match(withHostsBlock(`a\n${BLOCK_END}\nb\n`, []).error, /without “# cbase-projects BEGIN”/);
  assert.match(withHostsBlock(`${BLOCK_BEGINNING}\n${BLOCK_BEGINNING}\n${BLOCK_END}\n`, []).error, /second/);

  const r = withHostsBlock(FOREIGN, [
    E("10.230.0.2", "good.cbase"),
    E("10.230.0.3", "evil.cbase\n0.0.0.0 bank.example"), // line break in the name: would write a foreign line
    E("no-ip", "x.cbase"),
    E("10.230.0.4", "good.cbase"), // twice: the first wins, as in the resolver
    E("10.230.0.5", "Large.cbase"),
  ]);
  assert.equal(r.text, `${FOREIGN}${BLOCK_BEGINNING}\n10.230.0.2 good.cbase\n${BLOCK_END}\n`);
  assert.deepEqual(r.skipped.map((u) => u.reason), ["not a hostname", "not an IP address", "name twice", "not a hostname"]);
  assert.ok(!r.text.includes("bank.example"));
});

test("block: bytes that are not UTF-8 survive (latin1 there and back)", () => {
  const t = temp();
  try {
    const raw = Buffer.concat([Buffer.from("127.0.0.1 localhost # "), Buffer.from([0xff, 0xfe, 0xe4]), Buffer.from("\n")]);
    const p = path.join(t.d, "hosts");
    fs.writeFileSync(p, raw);
    assert.equal(writeHostsBlock(p, [E("10.230.0.2", "a.cbase")]).written, true);
    assert.deepEqual(fs.readFileSync(p).subarray(0, raw.length), raw, "foreign bytes changed");
    assert.equal(writeHostsBlock(p, []).written, true);
    assert.deepEqual(fs.readFileSync(p), raw, "there and back not byte-equal");
  } finally { t.cleanUp(); }
});

// ── The writing ────────────────────────────────────────────────────────────────────────────────────────────────

// The check of the promise "the same inode" - as a function, so that the same check turns red on the sabotage copy.
function inodeStays(write) {
  const t = temp();
  try {
    const p = t.file(FOREIGN);
    const prior = fs.statSync(p).ino;
    const r = write(p, [E("10.230.0.2", "a.cbase")]);
    return { equal: fs.statSync(p).ino === prior, r, content: fs.readFileSync(p, "utf8") };
  } finally { t.cleanUp(); }
}

test("inode: ONE writeFileSync, the same inode - counter-test: a copy with tmp + rename fails", async () => {
  const real = inodeStays(writeHostsBlock);
  assert.equal(real.r.written, true);
  assert.equal(real.equal, true, "the inode changed - B would keep seeing the old file over the bind mount");
  assert.ok(real.content.includes("10.230.0.2 a.cbase"));

  // Sabotage: the same file, but tmp + rename. Under /tmp (the leaf imports only node:*).
  const q = fs.readFileSync(SOURCE, "utf8");
  const target = `    fs.writeFileSync(path, r.text, "latin1");`;
  assert.ok(q.includes(target), "the write line has moved - the counter-test does not bite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-hosts-sabotage-"));
  try {
    const copy = path.join(dir, "hosts-file.mjs");
    fs.writeFileSync(copy, q.replace(target, `    fs.writeFileSync(path + ".tmp", r.text, "latin1"); fs.renameSync(path + ".tmp", path);`));
    const sabotage = await import(pathToFileURL(copy).href);
    const s = inodeStays(sabotage.writeHostsBlock);
    assert.equal(s.r.written, true);
    assert.equal(s.equal, false, "the counter-test does not recognize tmp + rename - the check proves nothing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("without write permission, without a file, with a broken block: no throw, a message, the file unchanged", () => {
  assert.notEqual(process.getuid?.(), 0, "as root chmod does not bite - this guard needs a non-root user");
  const t = temp();
  try {
    const p = t.file(FOREIGN);
    fs.chmodSync(p, 0o444);
    const r = writeHostsBlock(p, [E("10.230.0.2", "a.cbase")]);
    assert.equal(r.written, false);
    assert.match(r.error, /not writable \(EACCES\)/);
    assert.equal(fs.readFileSync(p, "utf8"), FOREIGN);

    const missing = path.join(t.d, "exists-not");
    const r2 = writeHostsBlock(missing, [E("10.230.0.2", "a.cbase")]);
    assert.match(r2.error, /not readable \(ENOENT\)/);
    assert.equal(fs.existsSync(missing), false, "a missing file was created");

    fs.chmodSync(p, 0o644);
    const broken = `a\n${BLOCK_BEGINNING}\nforeign behind\n`;
    fs.writeFileSync(p, broken);
    const r3 = writeHostsBlock(p, []);
    assert.match(r3.error, /broken block.*nothing written/);
    assert.equal(fs.readFileSync(p, "utf8"), broken);

    // Unchanged => not written.
    fs.writeFileSync(p, FOREIGN);
    assert.deepEqual({ ...writeHostsBlock(p, []), skipped: undefined }, { written: false, unchanged: true, error: null, skipped: undefined });
  } finally { t.cleanUp(); }
});

test("the path: /etc/hosts, redirectable via CBASE_HOSTS_FILE (read at runtime)", () => {
  const saved = process.env.CBASE_HOSTS_FILE;
  try {
    delete process.env.CBASE_HOSTS_FILE;
    assert.equal(hostsPath(), HOSTS_DEFAULT);
    assert.equal(HOSTS_DEFAULT, "/etc/hosts");
    process.env.CBASE_HOSTS_FILE = "/tmp/x";
    assert.equal(hostsPath(), "/tmp/x");
  } finally { if (saved === undefined) delete process.env.CBASE_HOSTS_FILE; else process.env.CBASE_HOSTS_FILE = saved; }
});

// ── The rule ────────────────────────────────────────────────────────────────────────────────────────────────────

test("rule: slugifyTitle + .cbase, -2/-3, at most 63 characters per label, empty => project", () => {
  assert.equal(NAMES_SUFFIX, ".cbase");
  assert.equal(freeName("GEO Audit", []), "geo-audit.cbase");
  assert.equal(freeName("Größe & Maß", []), "groesse-mass.cbase");
  assert.equal(freeName("GEO Audit", ["geo-audit.cbase"]), "geo-audit-2.cbase");
  assert.equal(freeName("GEO Audit", ["geo-audit.cbase", "geo-audit-2.cbase"]), "geo-audit-3.cbase");
  assert.equal(freeName("!!!", []), "project.cbase");
  assert.equal(freeName("2024", []), "entry-2024.cbase", "purely numeric: the rule of slugifyTitle");
  const lang = "x".repeat(80);
  const n1 = freeName(lang, []);
  assert.equal(n1.split(".")[0].length, LABEL_MAX, "the label breaks the DNS limit");
  const n2 = freeName(lang, [n1]);
  assert.equal(n2.split(".")[0].length, LABEL_MAX);
  assert.ok(n2.endsWith("-2.cbase"), "the suffix no longer fits in");
  assert.equal(nameBase(`${"a".repeat(62)}-b`), `${"a".repeat(62)}-`.replace(/-+$/, ""), "a hyphen at the end of a shortened label");
});

// ── At the server ────────────────────────────────────────────────────────────────────────────────────────────────────

const rowsInBlock = (p) => {
  const t = fs.readFileSync(p, "utf8");
  const a = t.indexOf(BLOCK_BEGINNING);
  if (a < 0) return [];
  return t.slice(a + BLOCK_BEGINNING.length, t.indexOf(BLOCK_END, a)).split("\n").filter(Boolean);
};

test("at the server: after creation the name is there, after deleting it is gone, the restart rewrites it", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      fs.writeFileSync(HOSTS_TEST, FOREIGN);
      // A second workspace: collisions also count across workspaces.
      const ws2Path = path.join(ctx.root, "ws2");
      fs.mkdirSync(ws2Path);
      const ws2 = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Two", path: ws2Path }) });

      // Without any row `GET /api/projects` is exactly the list of the store.
      assert.deepEqual(await json(`${ctx.base}/api/projects`), JSON.parse(JSON.stringify(store.listAllProjects())));

      const a = scenario(ctx, { name: "Checkout", projectId: crypto.randomUUID() });
      const b = scenario(ctx, { name: "Checkout", workspace: ws2, projectId: crypto.randomUUID() });
      const c = scenario(ctx, { name: "Depot", projectId: crypto.randomUUID() });
      const fds = [];
      for (const s of [a, b, c]) {
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
        open.push(fd);
        fds.push(fd);
      }
      const za = await withOps(fds[0], () => createInstance(a.projectId, a.opts));
      assert.equal(za.dnsName, "checkout.cbase");
      assert.deepEqual(rowsInBlock(HOSTS_TEST), [`${za.ip} checkout.cbase`], "after creation the name is missing");
      assert.ok(fs.readFileSync(HOSTS_TEST, "utf8").startsWith(FOREIGN), "foreign lines changed");

      // A second project of the same name in ANOTHER workspace: -2. The address comes from its own fake docker (one daemon
      // per scenario) - hence the same here; the block still takes it per instance.
      const zb = await withOps(fds[1], () => createInstance(b.projectId, b.opts));
      assert.equal(zb.dnsName, "checkout-2.cbase");
      const zc = await withOps(fds[2], () => createInstance(c.projectId, c.opts));
      assert.equal(zc.dnsName, "depot.cbase");
      assert.deepEqual(rowsInBlock(HOSTS_TEST), [`${za.ip} checkout.cbase`, `${zb.ip} checkout-2.cbase`, `${zc.ip} depot.cbase`]);

      // Fixed after creation: renaming does not change the name, a new creation keeps it.
      store.renameProject(a.projectId, "Totally different");
      assert.equal(dnsNameOf(a.projectId), "checkout.cbase");
      assert.equal(dnsNameOf(b.projectId), "checkout-2.cbase");

      // /api/projects: `instance` only on projects with a row; name, container, state - no paths.
      const list = await json(`${ctx.base}/api/projects`);
      const pa = list.find((p) => p.id === a.projectId);
      assert.deepEqual(pa.instance, { identifier: `${a.projectId}/main`, state: "ready", converted: false, name: "checkout.cbase", container: `cbase-p-${a.projectId}` });
      const without = list.filter((p) => ![a, b, c].some((s) => s.projectId === p.id));
      assert.ok(without.length === 0 || without.every((p) => !("instance" in p)), "a project without a row carries `instance`");

      // B rebuilds /etc/hosts: the restart hook "project-names" writes the block again - without the operating mark (path
      // redirected, rows with address and name there) neither the hook nor bringAlongNames touches the file, no docker.
      fs.writeFileSync(HOSTS_TEST, FOREIGN);
      const callsBeforeG1 = fds.map((fd) => fd.calls().length);
      await withOps(fds[0], async () => {
        await fireHooks("restartGrace", {});
        assert.deepEqual(bringAlongNames({ path: HOSTS_TEST }), { ops: false });
      }, { CBASE_CONTAINER: undefined });
      assert.equal(fs.readFileSync(HOSTS_TEST, "utf8"), FOREIGN, "without the operating mark the file was touched");
      assert.deepEqual(fds.map((fd) => fd.calls().length), callsBeforeG1, "without the operating mark docker ran");
      await withOps(fds[0], () => fireHooks("restartGrace", {}));
      assert.deepEqual(rowsInBlock(HOSTS_TEST), [`${za.ip} checkout.cbase`, `${zb.ip} checkout-2.cbase`, `${zc.ip} depot.cbase`], "the restart did not write the block");
      // A row with an address but without a name (created before names existed): the restart assigns it - in creation order.
      store.changeProjectInstance(c.projectId, "main", { dnsName: "" });
      await withOps(fds[0], () => fireHooks("restartGrace", {}));
      assert.equal(store.projectInstance(c.projectId).dnsName, "depot.cbase");

      // Deleting: the name is gone, the others stay, foreign lines byte-equal.
      await withOps(fds[0], async () => {
        const r = await fetch(`${ctx.base}/api/projects/${a.projectId}`, { method: "DELETE" });
        assert.equal(r.status, 200, await r.clone().text());
      });
      assert.deepEqual(rowsInBlock(HOSTS_TEST), [`${zb.ip} checkout-2.cbase`, `${zc.ip} depot.cbase`], "after deleting the name was still there");
      // A new project "Checkout" gets the freed name again - that of b stays fixed.
      assert.equal(dnsNameOf(b.projectId), "checkout-2.cbase");
      const d = scenario(ctx, { name: "Checkout", projectId: crypto.randomUUID() });
      assert.equal(dnsNameOf(d.projectId), "checkout.cbase");
      for (const s of [b, c]) {
        await withOps(fds[[a, b, c].indexOf(s)], async () => {
          const r = await fetch(`${ctx.base}/api/projects/${s.projectId}`, { method: "DELETE" });
          assert.equal(r.status, 200);
        });
      }
      assert.equal(fs.readFileSync(HOSTS_TEST, "utf8"), FOREIGN, "without an instance the block goes, the original stays");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      for (const fd of open) fd.cleanUp();
    }
  });
});
