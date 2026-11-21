// The tool result of creating a copy (stacks/result.js) against the fake docker (fake-docker.mjs): the copy container
// `cbase-k-<pid>-k1` and the main `cbase-p-<pid>` on the host daemon, their inner daemons via `exec … docker`; the env script
// really runs (local `sh`, `find`, `base64`), `ss` is injected.
//
// What holds here:
//   (1) Bait values in `.env`, in Compose's `environment` and in a container's `Config.Env` appear neither in the result
//       (JSON) nor in any log line; the keys with a real target do. Classification local (localhost, 127/8, ::1, 0.0.0.0,
//       host.docker.internal, *.cbase, Compose services, aliases, container names) against real (FQDN, Azure, LAN); also the
//       further target forms (jdbc, ADO.NET, Azure connection string, Npgsql, PDO, broker list, JSON list, Oracle) with "not
//       classified", and every `*.cbase` except the copy's own name as real; services with kind, state, addresses and
//       `buildsCode`, `healthcheckRetries1` from the main, the unregistered listeners, what did not come along (stashes,
//       alternates, partial clones, LFS) and the hints.
//   (2) `compose config` ends with 1 after stdout carried the values and stderr quotes them; the env script ends with 1 after
//       output with bait — the result comes anyway, both sources are under `unknown` with "Exit 1", and NO bait is in the
//       result or the log. `collectResult` does not throw.
//   (3) The snapshot summary (numbers only) ⇒ the refs come from the snapshot file; `base` per repo: text a repo knows / does
//       not know / id prefix; object per repo; the result of the preparation (`code.preparation`) wins.
//   (4) Pure: buildResult distinguishes "not read" (null) from "none" ([]); envOutput requires the end marker; a named but
//       unread file makes `complete` false.
//   (5) Linear: the form of every regex literal in env-key.js, plus counted indexOf steps — no clock.
//   (6) `.env*` as a symlink and unreadable.
//   (7) `services` in the form of the start.
//   (8) The hidden changes of the snapshot (`open.hidden`/`hiddenMissing`) arrive as numbers and a hint, null stays null.
//   (9) If `compose config` fails because a file from the label is missing, the reason names it (relative to the project
//       folder) instead of "Exit 1" — without bait; if none is missing, "Exit 1" stays ((2)).
//
// COUNTER-PROOFS (each shown red):
//   result.js "result with values": a container's state = JSON.stringify(Config.Env) ⇒ (1) and (2) red (bait in the result)
//   result.js reasonWithoutValue: `return String(e?.message)` as first line ⇒ (2) red (bait from stderr in the result)
//   result.js realKey with every target instead of only "foreign" ⇒ (1) and (2) red (LOCAL_API etc. as real)
//   env-key.js without the further forms ⇒ (1) red (SPRING_DATASOURCE_URL etc. missing); `unclear` always false ⇒ (1) red
//   (OPEN_URL missing); every `*.cbase` "cbase" ⇒ (1) red (MAIN_API, FOREIGN_CBASE_DB missing); the old comment regex
//   `/\s+#.*$/` ⇒ (5) red (the form); the old loop of the open quote ⇒ (5) red (400,020,000 steps for 40,003 characters);
//   result.js without the symlink branch in the env script ⇒ (6) red; without "notRead ⇒ incomplete" ⇒ (4), (6) red; every
//   start entry native ⇒ (7) red; the preparation discarded on re-reading ⇒ (3) red; result.js without the fields
//   `hidden`/`hiddenMissing` ⇒ (1), (8) red (and stacks-creation.test.js (1)); without the rule "all 0 is clean" ⇒ (8) red
//   (d appears as open with 0 paths); without the call of missingLabelFiles ⇒ (9) red ("Exit 1"); with the old filter
//   `!s.container` (without the start's finding) ⇒ (1) red (the natively started service with a registered container is
//   missing among the native ones).
// Plus the BUILT-IN sabotage: the bait finder must recognize a result with a value as such (otherwise it would check nothing).
//
// No clock: nothing waits for a time here. macOS: real TMPDIR (composeConfig requires normalized absolute paths).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { containerName, copyInstance } from "../electron/server/projectbox/creation.js";
import { envKey } from "../electron/server/projectbox/env-key.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { SET, buildResult, envOutput, collectResult } from "../electron/server/stacks/result.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();

// The baits: each appears ONLY in a value. Plus host names of real targets (they are part of a value too).
const K = Object.freeze({
  envPass: "BAITenvPass4711", envBlob: "baitblob0815", envWithoutTarget: "BAITonlySecret99", envLocal: "BAITlocal42",
  composeTok: "BAITcomposeTok7", composeHost: "baitcompose3", inspectTok: "BAITinspect5v", soloHost: "baitsolo8",
  // The further forms and the instance names:
  adoPass: "BAITadoPass31", azAccount: "baitaccount77", azKey: "BAITazKey0N", npgPass: "BAITnpgPass2", openPass: "BAITopen64",
  cbasePass: "BAITcbasePass19",
  // Symlink and unreadable file
  linkPass: "BAITlinkPass8", lockedPass: "BAITlocked3",
});
const HOSTS = ["db.prod.example.com", "blob.core.windows.net", "192.168.178.20", "db.intern.example.org", "api.example.org", "svc.example.net",
  "jdbc.prod.example.com", "mssql.database.windows.net", "npgsql.prod.example.com", "pdo.prod.example.com", "b1.kafka.example.com",
  "es.prod.example.com", "ora.prod.example.com", "project-s.cbase", "orbit.cbase", "link.prod.example.com", "locked.example.com"];
// The copy's name rightly appears in the result (dnsName, addresses) and contains the main's as its ending — it is removed
// before the search so that `project-s.cbase` (the main, a bait) triggers only where it stands alone.
const OWN_DNS = "k1.project-s.cbase";
const decoyIn = (text) => { const t = String(text).split(OWN_DNS).join(""); return [...Object.values(K), ...HOSTS].filter((k) => t.includes(k)); };

// Record the log (console.*) — baits must stay out of the log too.
async function withLog(fn) {
  const rows = [];
  const old = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    old[k] = console[k];
    console[k] = (...a) => { rows.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")); };
  }
  try { return { value: await fn(), log: rows.join("\n") }; } finally { Object.assign(console, old); }
}

function programFile(dir, name, text) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, { mode: 0o755 });
  return f;
}

const SS = [
  "LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*", // db in the main, published
  "LISTEN 0 511 *:3000 *:*", //              registered native service
  "LISTEN 0 4096 [::]:8080 [::]:*", //         web in the main, published
  "LISTEN 0 128 127.0.0.1:9999 0.0.0.0:*", //  without an entry — the listener
  "LISTEN 0 4096 127.0.0.11:38000 0.0.0.0:*", // DNS of a Docker network
].join("\n");

// ── The situation ─────────────────────────────────────────────────────────────────────────
async function build(ctx, { composeBroken = [], shBroken = false } = {}) {
  const s = scenario(ctx);
  const pdir = path.join(ctx.root, `programs-${s.projectId}`);
  fs.mkdirSync(pdir, { recursive: true });
  const ss = programFile(pdir, "fake-ss", `#!/bin/sh\ncat <<'EOF'\n${SS}\nEOF\n`);
  const programs = { ...s.programs, ss };
  // A `sh` that runs the real script, then writes a bait to stderr and ends with 1.
  if (shBroken) programs.sh = programFile(pdir, "fake-sh", `#!/bin/sh\n/bin/sh "$@"\nprintf '%s\\n' 'broken ${K.envPass}' >&2\nexit 1\n`);
  const compose = {
    app: {
      web: {
        image: "img-web", build: { context: "." }, aliases: ["api-intern"],
        environment: {
          API_BASE: `https://${K.composeHost}.example.com/v1?token=${K.composeTok}`,
          LOCAL_UPSTREAM: "http://localhost:3000", REDIS_URL: "redis://redis:6379", INTERN: "http://api-intern:8080",
        },
      },
      redis: { image: "redis:7" },
    },
  };
  const fd = await fakeDocker({ programs, compose, composeBroken });
  const pid = s.projectId;
  const main = containerName(pid);
  const copy = containerName(pid, copyInstance("k1"));
  const cidH = dx(fd, "run", "-d", "--name", main, "--label", `cbase.project=${pid}`, "cbase-projectbox:latest");
  const cidK = dx(fd, "run", "-d", "--name", copy, "--label", `cbase.project=${pid}`, "--label", `cbase.instance=${copyInstance("k1")}`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: cidH, desired: desiredFromInspect([]), ip: "127.0.0.1" });
  // Main inside: db with retries 1 (publishes 5432), web with retries 3 (publishes 8080).
  dx(fd, "exec", main, "docker", "run", "-d", "--name", "db", "--health-cmd", "pg_isready", "--health-retries", "1", "-p", "5432:5432", "postgres");
  dx(fd, "exec", main, "docker", "run", "-d", "--name", "web", "--health-cmd", "curl -f localhost", "--health-retries", "3", "-p", "8080:80", "img-web");
  // Copy inside: two Compose containers (labels as Compose sets them) and a loose container.
  const composeFile = path.join(s.path, "compose.yml");
  fs.writeFileSync(composeFile, "services: {}\n");
  const cl = (service) => ["--label", "com.docker.compose.project=app", "--label", `com.docker.compose.service=${service}`,
    "--label", `com.docker.compose.project.working_dir=${s.path}`, "--label", `com.docker.compose.project.config_files=${composeFile}`];
  dx(fd, "exec", copy, "docker", "run", "-d", "--name", "app-web-1", ...cl("web"), "-p", "8080:80",
    "-e", `SECRET_URL=https://svc.example.net/hook?t=${K.inspectTok}`, "-e", "CACHE=redis://redis:6379", "img-web");
  dx(fd, "exec", copy, "docker", "run", "-d", "--name", "app-redis-1", ...cl("redis"), "redis:7");
  dx(fd, "exec", copy, "docker", "run", "-d", "--name", "solo", "-e", `SOLO_TARGET=http://${K.soloHost}.internal.example:81`, "-e", "SOLO_SELF=http://solo:81", "busybox");
  // The `.env*` of the project folder (at the same path in the copy).
  fs.writeFileSync(path.join(s.path, ".env"), [
    `DATABASE_URL=postgres://app:${K.envPass}@db.prod.example.com:5432/app`,
    `AZURE_STORAGE=https://${K.envBlob}.blob.core.windows.net/data`,
    "LAN_API=http://192.168.178.20:8080",
    "DB_HOST=db.intern.example.org",
    `PASSWORD=${K.envWithoutTarget}`,
    `LOCAL_API=http://localhost:3000/${K.envLocal}`,
    "LOOP_ADDR=127.0.0.5:6000",
    "V6_URL=http://[::1]:9000",
    "ZEROS=http://0.0.0.0:8000",
    "DOCKER_HOST_URL=http://host.docker.internal:2375",
    `OWN_URL=http://${OWN_DNS}:80`,
    "STACK_URL=redis://redis:6379",
    "ALIAS_URL=http://api-intern:8080",
    "CONT_URL=http://app-web-1:80",
    // From the copy, `<project>.cbase` is the MAIN and `<other>.cbase` the main of another project — real.
    "MAIN_API=http://project-s.cbase:8000",
    `FOREIGN_CBASE_DB=postgres://app:${K.cbasePass}@orbit.cbase:5432/x`,
    // The further forms — real …
    "SPRING_DATASOURCE_URL=jdbc:postgresql://jdbc.prod.example.com:5432/app",
    `ConnectionStrings__Default=Server=tcp:mssql.database.windows.net,1433;Initial Catalog=app;Password=${K.adoPass};`,
    `AZURE_CONN=DefaultEndpointsProtocol=https;AccountName=${K.azAccount};AccountKey=${K.azKey};EndpointSuffix=core.windows.net`,
    `NPGSQL=Host=npgsql.prod.example.com;Port=5432;Username=app;Password=${K.npgPass}`,
    "PDO_DSN=mysql:host=pdo.prod.example.com;dbname=app;port=3306",
    "KAFKA_BROKERS=b1.kafka.example.com:9092,b2.kafka.example.com:9092",
    'ES_NODES=["https://es.prod.example.com:9200"]',
    "ORA_URL=jdbc:oracle:thin:@ora.prod.example.com:1521:ORCL",
    // … local …
    "LOCAL_JDBC=jdbc:postgresql://localhost:5432/app",
    "LOCAL_ADO=Server=(localdb)\\MSSQLLocalDB;Database=app",
    "LOCAL_LIST=localhost:9092,redis:6379",
    "SQLITE_CS=Data Source=app.db",
    // … and not classifiable: named, not silently local.
    `OPEN_URL=postgres://app:${K.openPass}@\${DB_HOST}:5432/x`,
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(s.path, "sub"), { recursive: true });
  fs.writeFileSync(path.join(s.path, "sub", ".env.local"), "OTHER=https://api.example.org\n");
  fs.mkdirSync(path.join(s.path, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(s.path, "node_modules", "x", ".env"), "NM_URL=https://nm.example.com\n");
  // Registered services: a native one (3000, ran in the main), one in a container (8080) and one WITH a registered container
  // that ran natively (`npm run dev` next to a Compose entry — it is in the desired state, nativeServicesStatus).
  const services = store.replaceProjectServices(pid, [
    { name: "api", kind: "app", port: 3000, container: "", startCommand: "npm start" },
    { name: "web-service", kind: "app", port: 8080, container: "web" },
    { name: "frontend", kind: "frontend", port: null, container: "orbit-frontend", startCommand: "npm run dev" },
  ]);
  const api = services.find((x) => x.name === "api");
  const frontend = services.find((x) => x.name === "frontend");
  const copyRow = { id: 1, projectId: pid, name: "k1", chatId: "chat-result", base: null };
  const instance = { projectId: pid, instance: copyInstance("k1"), dnsName: OWN_DNS, ip: "10.230.7.2", containerId: cidK };
  const code = {
    version: 1, projectRepo: true, commit: "a".repeat(40),
    repos: [
      { part: "p", rel: ".", head: { symref: "refs/heads/main", oid: "b".repeat(40) }, refs: [{ name: "refs/heads/main", oid: "b".repeat(40) }], stash: 0,
        open: { tar: "p.tar", size: 10, paths: ["a.txt", "fresh.txt"], erase: ["way.txt"] }, objects: { alternates: false, promisor: false }, shallow: false, lfs: false },
      { part: "r0", rel: "repo", head: { symref: null, oid: "c".repeat(40) }, refs: [{ name: "refs/heads/dev", oid: "c".repeat(40) }], stash: 2,
        open: null, objects: { alternates: true, promisor: true }, shallow: false, lfs: true },
    ],
    notLinked: [{ rel: "wt", reason: "gitfile" }], unreadable: [],
  };
  return { s, fd, pid, main, copy, cidK, api, copyRow, instance, code, desired: { container: [], services: [api.id, frontend.id] } };
}

const collect = (b, extra = {}) => withOps(b.fd, () => collectResult({
  copy: b.copyRow, project: store.getProject(b.pid), instance: b.instance, containerId: b.cidK, code: b.code, desired: b.desired, ...extra,
}));

test("(0) built-in sabotage: the bait finder recognizes a result with a value", () => {
  assert.deepEqual(decoyIn(JSON.stringify({ envRealTargets: { value: `postgres://app:${K.envPass}@db.prod.example.com` } })), [K.envPass, "db.prod.example.com"]);
  assert.deepEqual(decoyIn(JSON.stringify(buildResult({ copy: { name: "k1", projectId: "p1" } }))), []);
});

test("(1) bait: none in result or log; real targets, classification, services, healthcheck, listeners, what is missing, hints", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const { value: e, log } = await withLog(() => collect(b));
      assert.deepEqual(decoyIn(JSON.stringify(e)), [], "bait in the result");
      assert.deepEqual(decoyIn(log), [], "bait in the log");
      assert.deepEqual(e.unknown, [], JSON.stringify(e.unknown));
      // Real against local: only foreign hosts — FQDN, Azure, LAN, a name outside the stack; plus the further forms (jdbc,
      // ADO.NET, Azure connection string, Npgsql, PDO, broker list, JSON list, Oracle) and every `*.cbase` except the copy's
      // name (the main, the main of another project).
      assert.deepEqual(e.envRealTargets.key, ["API_BASE", "AZURE_CONN", "AZURE_STORAGE", "ConnectionStrings__Default", "DATABASE_URL", "DB_HOST",
        "ES_NODES", "FOREIGN_CBASE_DB", "KAFKA_BROKERS", "LAN_API", "MAIN_API", "NPGSQL", "ORA_URL", "OTHER", "PDO_DSN", "SECRET_URL", "SOLO_TARGET",
        "SPRING_DATASOURCE_URL"]);
      for (const local of ["LOCAL_API", "LOOP_ADDR", "V6_URL", "ZEROS", "DOCKER_HOST_URL", "OWN_URL", "STACK_URL", "ALIAS_URL", "CONT_URL",
        "LOCAL_UPSTREAM", "REDIS_URL", "INTERN", "CACHE", "SOLO_SELF", "PASSWORD", "NM_URL", "LOCAL_JDBC", "LOCAL_ADO", "LOCAL_LIST", "SQLITE_CS"]) {
        assert.ok(!e.envRealTargets.key.includes(local), `${local} counts as real`);
        assert.ok(!e.envRealTargets.notClassified.includes(local), `${local} counts as not classified`);
      }
      // What looks like a target and cannot be classified is listed as "not classified" (only the key).
      assert.deepEqual(e.envRealTargets.notClassified, ["OPEN_URL"]);
      assert.ok(e.hints.includes(`${SET.notClassified}: OPEN_URL.`), "hint for the not classified keys missing");
      assert.deepEqual(e.envRealTargets.where.map((w) => `${w.source}:${w.location}:${w.key.join(",")}:${w.notClassified.join(",")}`), [
        "compose:app/web:API_BASE:", "container:app-web-1:SECRET_URL:", "container:solo:SOLO_TARGET:",
        "env-file:.env:AZURE_CONN,AZURE_STORAGE,ConnectionStrings__Default,DATABASE_URL,DB_HOST,ES_NODES,FOREIGN_CBASE_DB,KAFKA_BROKERS,LAN_API,MAIN_API," +
          "NPGSQL,ORA_URL,PDO_DSN,SPRING_DATASOURCE_URL:OPEN_URL",
        "env-file:sub/.env.local:OTHER:",
      ]);
      assert.equal(e.envRealTargets.complete, true);
      assert.equal(e.envRealTargets.set, SET.realTargets);
      // Services: kind, state, addresses, buildsCode.
      const d = Object.fromEntries(e.services.map((x) => [x.name, x]));
      assert.deepEqual(Object.keys(d).sort(), ["api", "frontend", "redis", "solo", "web"]);
      assert.equal(d.web.kind, "compose");
      assert.equal(d.web.buildsCode, true);
      assert.equal(d.redis.buildsCode, false);
      assert.equal(d.solo.kind, "container");
      assert.equal(d.solo.buildsCode, null);
      assert.equal(d.web.state, "running");
      assert.deepEqual(d.web.addresses, [{ port: 8080, name: "k1.project-s.cbase:8080", fromB: "10.230.7.2:8080", fromNextTurn: "localhost:8080" }]);
      // Without the start's finding: the registered ones with the desired state, in the start's words ("running", not "started").
      assert.deepEqual({ kind: d.api.kind, state: d.api.state, ports: d.api.ports }, { kind: "native", state: "running", ports: [3000] });
      // With a registered container but started natively in the desired state: native, "running" (the container entry without desired state is missing).
      assert.deepEqual({ kind: d.frontend.kind, state: d.frontend.state, ports: d.frontend.ports }, { kind: "native", state: "running", ports: [] });
      // Main: retries 1 (the pause hits the main) and the listener without an entry.
      assert.deepEqual(e.healthcheckRetries1, ["db"]);
      assert.deepEqual(e.unregisteredListener, [9999]);
      // What did not come along, and the hints.
      assert.deepEqual(e.notBroughtAlong.stashes, [{ rel: "repo", count: 2 }]);
      assert.deepEqual(e.notBroughtAlong.notLinked, [{ rel: "wt", reason: "gitfile" }]);
      assert.deepEqual([e.notBroughtAlong.alternates, e.notBroughtAlong.partClones, e.notBroughtAlong.lfs], [["repo"], ["repo"], ["repo"]]);
      assert.deepEqual(e.code.repos.map((r) => [r.rel, r.head, r.state]), [
        [".", { branch: "main", oid: "b".repeat(12) }, { kind: "open", paths: 2, erase: 1, hidden: null, hiddenMissing: null }],
        ["repo", { branch: null, oid: "c".repeat(12) }, { kind: "clean" }],
      ]);
      assert.equal(e.branchSpace, "copy/k1/");
      for (const set of [SET.branchSpace("k1"), SET.openTrap, SET.reflogs, SET.index, SET.outside, SET.buildsCode, SET.realTargets,
        SET.buildOutputs, SET.translucent, SET.addresses]) {
        assert.ok(e.hints.includes(set), `hint missing: ${set.slice(0, 60)}`);
      }
      for (const beginning of [SET.stashes, SET.notLinked, SET.alternates, SET.partClones, SET.lfs, SET.healthcheck, SET.listener]) {
        assert.ok(e.hints.some((h) => h.startsWith(beginning)), `hint missing: ${beginning.slice(0, 60)}`);
      }
      assert.match(SET.translucent, /git status. before .git add -A/);
      assert.match(SET.buildOutputs, /as long as it has not written the file itself/);
      // The storage takes it unchanged (JSON), and no bait there either.
      assert.deepEqual(decoyIn(JSON.stringify(JSON.parse(JSON.stringify(e)))), []);
    } finally {
      b.fd.cleanUp();
    }
  });
});

test("(2) compose config and the env script fail with values on stdout/stderr — result without bait, unknown with exit", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { composeBroken: ["app"], shBroken: true });
    try {
      const { value: e, log } = await withLog(() => collect(b));
      assert.deepEqual(decoyIn(JSON.stringify(e)), [], "bait in the result");
      assert.deepEqual(decoyIn(log), [], "bait in the log");
      assert.deepEqual(e.unknown, [
        { what: "compose config (app)", reason: "Exit 1" },
        { what: "`.env*` files of the copy", reason: "Exit 1" },
      ]);
      // What was read anyway is there — without a Compose model `buildsCode` is unknown, not "no".
      const d = Object.fromEntries(e.services.map((x) => [x.name, x]));
      assert.equal(d.web.buildsCode, null);
      assert.deepEqual(e.envRealTargets.key, ["SECRET_URL", "SOLO_TARGET"]);
      assert.equal(e.envRealTargets.complete, false);
      // The other side: the bait really was in the error (otherwise this test would check nothing).
      const raw = await withOps(b.fd, async () => {
        const { dockerIn } = await import("../electron/server/projectbox/docker.js");
        const { composeConfig, configResolvedArgs } = await import("../electron/server/projectbox/compose-config.js");
        const [c] = JSON.parse(dx(b.fd, "exec", b.copy, "docker", "inspect", "app-web-1"));
        return dockerIn(b.cidK, configResolvedArgs(composeConfig(c))).then(() => null, (err) => err);
      });
      assert.ok(raw && decoyIn(`${raw.message}\n${raw.stdout}`).includes(K.composeTok), "the error of compose config did not carry the bait");
    } finally {
      b.fd.cleanUp();
    }
  });
});

test("(3) summary ⇒ refs from the snapshot file; base per repo: knows, does not know, id prefix, object", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const location = copyLocation({ data: DIRS.data, projectId: b.pid, name: "k1" });
      fs.mkdirSync(location.root.base, { recursive: true });
      fs.writeFileSync(location.root.snapshot, `${JSON.stringify(b.code)}\n`, { mode: 0o600 });
      const summary = {
        version: 1, projectRepo: true, commit: b.code.commit, notLinked: b.code.notLinked,
        repos: b.code.repos.map((r) => ({ part: r.part, rel: r.rel, refs: r.refs.length, stash: r.stash, open: null, objects: r.objects, shallow: false, lfs: r.lfs })),
      };
      const including = (base) => collect(b, { copy: { ...b.copyRow, base }, code: summary });
      const e1 = await including("main");
      assert.deepEqual(e1.unknown, []);
      assert.deepEqual(e1.code.repos.map((r) => [r.rel, r.head?.branch ?? null, r.state]), [
        [".", "main", { kind: "base", base: "main", applies: true }],
        ["repo", null, { kind: "base", base: "main", applies: false }],
      ]);
      assert.ok(e1.hints.includes(SET.base));
      assert.ok(!e1.hints.includes(SET.openTrap), "with a base no open changes come along");
      const e2 = await including("cccc");
      assert.deepEqual(e2.code.repos.map((r) => r.state.applies), [null, true]);
      const e3 = await including({ repo: "dev" });
      assert.deepEqual(e3.code.repos.map((r) => r.state), [{ kind: "base", base: null, applies: false }, { kind: "base", base: "dev", applies: true }]);
      // With the result of the preparation (the build passes it on as `code.preparation`), what IT resolved in the copy counts —
      // also an expression that is no ref name ("HEAD~1") and a full id without a ref; the repo then stands detached on it, not
      // on the snapshot's HEAD. The preparation survives re-reading the snapshot file.
      const id = "d".repeat(40);
      const withPreparation = (base, repos) => collect(b, { copy: { ...b.copyRow, base }, code: { ...summary, preparation: { repos, passes: 1 } } });
      const e4 = await withPreparation("HEAD~1", [{ part: "p", rel: ".", base: id }, { part: "r0", rel: "repo", base: null }]);
      assert.deepEqual(e4.unknown, []);
      assert.deepEqual(e4.code.repos.map((r) => [r.rel, r.head, r.state]), [
        [".", { branch: null, oid: "d".repeat(12) }, { kind: "base", base: "HEAD~1", applies: true }],
        ["repo", { branch: null, oid: "c".repeat(12) }, { kind: "base", base: "HEAD~1", applies: false }],
      ]);
      const e5 = await withPreparation("e".repeat(40), [{ part: "p", rel: ".", base: "e".repeat(40) }, { part: "r0", rel: "repo", base: "empty" }]);
      assert.deepEqual(e5.code.repos.map((r) => [r.head?.oid, r.state.applies]), [["e".repeat(12), true], ["c".repeat(12), false]]);
    } finally {
      b.fd.cleanUp();
    }
  });
});

test("(4) pure: not read (null) is not none ([]); envOutput requires the end marker", () => {
  const e = buildResult({ copy: { name: "k2", projectId: "p9", chatId: "c", base: null }, instance: { dnsName: null, ip: null } });
  assert.equal(e.services, null);
  assert.equal(e.envRealTargets, null);
  assert.equal(e.code, null);
  assert.equal(e.notBroughtAlong, null);
  assert.equal(e.healthcheckRetries1, null);
  assert.equal(e.unregisteredListener, null);
  assert.equal(e.identifier, "p9/copy-k2");
  const empty = buildResult({ copy: { name: "k2", projectId: "p9" }, container: [], native: [], env: { where: [], notRead: [], complete: true }, healthcheckRetries1: [], listener: [] });
  assert.deepEqual([empty.services, empty.envRealTargets.key, empty.healthcheckRetries1, empty.unregisteredListener], [[], [], [], []]);
  assert.ok(!empty.hints.includes(SET.realTargets), "no hint without real targets");
  assert.throws(() => envOutput("./.env\0=QT0x\0"), /no end marker/);
  assert.throws(() => envOutput("/abs/.env\0=QT0x\0cbase-end\0" + "0\0"), /cannot be read/);
  assert.deepEqual(envOutput("./.env\0=QT0x\0cbase-end\0" + "1\0"), { files: [{ rel: ".env", content: "A=1" }], complete: false });
  // A named but unread file makes `complete` false — in the pure part too.
  const named = buildResult({ copy: { name: "k2", projectId: "p9" }, env: { where: [], notRead: [{ location: ".env", reason: "not readable" }], complete: true } });
  assert.equal(named.envRealTargets.complete, false);
});

// ── (5) linear ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_KEY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server", "projectbox", "env-key.js");

// The regex literals of a source text (without comments and strings) — a literal starts with `/` after a character after which
// no value stands.
function regexLiterals(src) {
  const out = [];
  let prior = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j + 1; prior = c; continue;
    }
    if (c === "/" && (prior === "" || "(,=:[!&|?;{}".includes(prior))) {
      let j = i + 1;
      let kind = false;
      while (j < src.length && src[j] !== "\n" && (kind || src[j] !== "/")) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") kind = true;
        else if (src[j] === "]") kind = false;
        j += 1;
      }
      out.push(src.slice(i + 1, j));
      i = j + 1; prior = "x"; continue;
    }
    if (!/\s/.test(c)) prior = c;
    i += 1;
  }
  return out;
}

// Does the pattern start unanchored with an element that carries a quantifier `*`, `+` or `{n,}`? Then the engine tries it at
// every position and backtracks over the whole run each time (`/\s+#.*$/`: quadratic in the length of the whitespace).
function quadraticBeginning(pattern) {
  if (pattern.startsWith("^")) return false;
  let j = 1;
  if (pattern[0] === "\\") j = 2;
  else if (pattern[0] === "[") { j = 1; while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1; j += 1; }
  else if (pattern[0] === "(") {
    for (let t = 0, k = 0; k < pattern.length; k += 1) {
      if (pattern[k] === "\\") { k += 1; continue; }
      if (pattern[k] === "(") t += 1;
      else if (pattern[k] === ")" && --t === 0) { j = k + 1; break; }
    }
  }
  return /^[*+{]/.test(pattern.slice(j));
}

test("(5) the classification is linear — no regex literal in env-key.js starts unanchored with a quantifier; an open quote and the comment cost at most 4 counted steps per character", () => {
  // The form, with built-in sabotage: the old comment regex is recognized, an anchored and a literal one are not.
  assert.deepEqual(regexLiterals('rest = rest.replace(/\\s+#.*$/, "").trim(); const a = /^\\s+x/; const b = "/\\s+/"; // /\\s+/').filter(quadraticBeginning), ["\\s+#.*$"]);
  assert.equal(quadraticBeginning("[ \\t]{2,}"), true);
  assert.equal(quadraticBeginning("(?:^|_)PORT$"), false);
  const literals = regexLiterals(fs.readFileSync(ENV_KEY_FILE, "utf8"));
  assert.ok(literals.length >= 30, `only ${literals.length} regex literals found — the finder is broken`);
  assert.deepEqual(literals.filter(quadraticBeginning), [], "unanchored with quantifier: quadratic over a value");

  // Counted, no clock: every character indexOf looks at (the search for the end of a quote and for `#`).
  const indexOf = String.prototype.indexOf;
  let steps = 0;
  String.prototype.indexOf = function counted(s, from) {
    const r = indexOf.call(this, s, from);
    const start = Math.min(Math.max(Number(from) || 0, 0), this.length);
    steps += (r < 0 ? this.length : r + 1) - start;
    return r;
  };
  let open;
  let lang;
  try {
    const text1 = `A="${"\nx".repeat(20000)}`; // a quote that never closes
    steps = 0;
    open = envKey(text1);
    const s1 = steps;
    assert.ok(s1 > 0 && s1 <= 4 * text1.length, `open quote: ${s1} steps for ${text1.length} characters`);
    const text2 = [`B=${"a#".repeat(50000)}`, `C=http://db.prod.example.com${" ".repeat(65536)}# comment`, `D=x${" ".repeat(65536)}y`, "E=http://localhost:1/#anchor"].join("\n");
    steps = 0;
    lang = envKey(text2);
    const s2 = steps;
    assert.ok(s2 > 0 && s2 <= 4 * text2.length, `comment: ${s2} steps for ${text2.length} characters`);
  } finally {
    String.prototype.indexOf = indexOf;
  }
  // Same result as before: the open quote makes line 1 unreadable; the comment only falls after whitespace.
  assert.deepEqual([open.unreadable, open.entries], [[1], []]);
  const z = Object.fromEntries(lang.entries.map((e) => [e.key, e.targets.map((x) => x.host)]));
  assert.deepEqual(z, { B: [], C: ["foreign"], D: [], E: ["local"] });
});

// ── (6) `.env*` as a symlink, unreadable files ────────────────────────────────────────────────────────────

test("(6) a `.env*` symlink is read in the container; a dangling symlink and an unreadable file are under notRead, complete is false", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const outside = path.join(ctx.root, `shared-${b.pid}`);
    const locked = path.join(b.s.path, ".env.locked");
    try {
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "app.env"), `SHARED_DB=postgres://app:${K.linkPass}@link.prod.example.com:5432/x\n`);
      fs.symlinkSync(path.join(outside, "app.env"), path.join(b.s.path, ".env.shared"));
      fs.symlinkSync(path.join(outside, "missing.env"), path.join(b.s.path, ".env.broken"));
      fs.writeFileSync(locked, `LOCKED_API=https://locked.example.com/?t=${K.lockedPass}\n`);
      fs.chmodSync(locked, 0o000);
      const { value: e, log } = await withLog(() => collect(b));
      assert.deepEqual(decoyIn(JSON.stringify(e)), [], "bait in the result");
      assert.deepEqual(decoyIn(log), [], "bait in the log");
      assert.deepEqual(e.envRealTargets.where.find((w) => w.location === ".env.shared")?.key, ["SHARED_DB"], "the symlink was not read");
      assert.deepEqual(e.envRealTargets.notRead, [
        { location: ".env.broken", reason: "symlink to no regular file — not read" },
        { location: ".env.locked", reason: "not readable" },
      ]);
      assert.equal(e.envRealTargets.complete, false, "named, not read — and still complete");
    } finally {
      try { fs.chmodSync(locked, 0o600); } catch { /* already gone */ }
      b.fd.cleanUp();
    }
  });
});

// ── (7) the services from the start ───────────────────────────────────────────────────────────────────────────────

test("(7) seam of the start: every container exactly once with its kind, \"failed\" at its entry; native only what is native", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      // This is how stacks/start.js returns `services`: the inner containers (kind "container", name = container name) and the native ones.
      const services = [
        { name: "app-redis-1", kind: "container", state: "failed", port: null },
        { name: "app-web-1", kind: "container", state: "running", port: null },
        { name: "solo", kind: "container", state: "running", port: null },
        { name: "way-1", kind: "container", state: "failed", port: null },
        { name: "api", kind: "native", state: "running", port: 3000 },
        { name: "worker", kind: "native", state: "failed", port: null },
      ];
      const e = await collect(b, { services });
      assert.deepEqual(e.services.map((d) => `${d.kind}:${d.name}:${d.state}`), [
        "compose:redis:failed", "compose:web:running", "container:solo:running", "container:way-1:failed",
        "native:api:running", "native:worker:failed",
      ]);
      assert.deepEqual(e.services.find((d) => d.name === "web").addresses.map((a) => a.port), [8080], "the container keeps ports and addresses");
    } finally {
      b.fd.cleanUp();
    }
  });
});

test("(8) hidden changes in the result: per repo as a number with a hint; null without data, no hint at 0; all 0 is clean", () => {
  const repo = (rel, open) => ({ part: rel, rel, head: null, refs: [], stash: 0, open, objects: {}, shallow: false, lfs: false });
  const e = buildResult({
    copy: { name: "k3", projectId: "p9", base: null },
    code: { version: 1, repos: [
      repo("a", { paths: 3, erase: 0, hidden: 2, hiddenMissing: 4 }),
      repo("b", { paths: ["x"], erase: [], hidden: [], hiddenMissing: 0 }),
      repo("c", { paths: 1, erase: 1 }),
      repo("d", { paths: [], erase: [], hidden: [], hiddenMissing: 0 }),
      repo("e", { paths: 0, erase: 0 }),
    ], notLinked: [], unreadable: [] },
  });
  assert.deepEqual(e.code.repos.map((r) => [r.rel, r.state]), [
    ["a", { kind: "open", paths: 3, erase: 0, hidden: 2, hiddenMissing: 4 }],
    ["b", { kind: "open", paths: 1, erase: 0, hidden: 0, hiddenMissing: 0 }],
    ["c", { kind: "open", paths: 1, erase: 1, hidden: null, hiddenMissing: null }],
    ["d", { kind: "clean" }], // the project repo whose status only an embedded repo names
    ["e", { kind: "open", paths: 0, erase: 0, hidden: null, hiddenMissing: null }], // unknown is not 0
  ]);
  assert.ok(e.hints.includes(`${SET.hidden}: a (2).`), JSON.stringify(e.hints));
  assert.ok(e.hints.includes(`${SET.hiddenMissing}: a (4).`));
  const without = buildResult({ copy: { name: "k3", projectId: "p9", base: null }, code: { version: 1, repos: [repo("c", { paths: 1, erase: 1 })] } });
  assert.ok(!without.hints.some((h) => h.startsWith(SET.hidden) || h.startsWith(SET.hiddenMissing)), "no hint without hidden changes");
});

test("(9) a file from the label is missing: the reason names it instead of \"Exit 1\"", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { composeBroken: ["app"] });
    try {
      fs.rmSync(path.join(b.s.path, "compose.yml"));
      const { value: e, log } = await withLog(() => collect(b));
      assert.deepEqual(decoyIn(JSON.stringify(e)), [], "bait in the result");
      assert.deepEqual(decoyIn(log), [], "bait in the log");
      assert.deepEqual(e.unknown.filter((u) => u.what.startsWith("compose config")), [
        { what: "compose config (app)", reason: "file from the label is missing: compose.yml" },
      ]);
    } finally {
      b.fd.cleanUp();
    }
  });
});
