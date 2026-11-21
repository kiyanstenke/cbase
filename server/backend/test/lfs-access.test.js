// Git LFS in the agent shells of a project container. The route `POST /api/projects/:id/lfs-access` (projectbox/lfs-access.js)
// over the real server and the fence, the sheet runs/lfs-environment.js and the environment of the agent starts at the wire of
// the fake docker (fake-docker.mjs: an exec runs LOCALLY, with the environment from its `-e NAME`). The helper itself has its
// guard in tools/check/lfs-helper.test.mjs, the "LFS environment" column of all start places (and Bash, hook, monitor, stdio MCP,
// terminal, debugger, browser, admin git, service at the wire) is held by server/backend/test/in-project-start-places.test.js.
//
// The promises, each with the sabotage that breaks it:
//   (a) without the operating mark 404 "only in server mode"; from B (loopback without token) and via the gateway without a
//       token 403 — without a fence context the route gives nothing out; from the project network without a token 401 (fence).
//   (b) with the token of an instance of P: the stored access of the host, `Cache-Control: no-store`, also with `path=g/r.git` —
//       the form in which git-lfs asks (no path gate); host uppercase and with a port finds the access stored for `hostname`
//       lowercase; host without access and `protocol` != https => `{ access: null }`; the workspace comes from the instance — a
//       `workspaceId` in the body changes nothing; a host that is not `hostname[:port]`, and a body that is not JSON, => 400; GET
//       has no row.
//   (c) token of another project => 401 from a foreign network or 403 on another's project (`:project`); token of a COPY of P =>
//       the value (copies included), 403 on another project.
//   (d) start places at the wire: the Claude turn and the Codex turn in a converted project carry `-e` of the four names, the
//       values only in the environment (the CLI sees them; address and credential open exactly this route); without an instance
//       row no name (golden-runs.test.js stays equal without re-recording); service detection (runOnceClaude) carries none.
//   (e) neither log (console) nor event (/api/events, read up to a stream barrier) carries a value or user.
//   Plus the sheet without a server: without instance, source, address or token `{}` and the same opts object.
//   (a') with a valid token but FROM OUTSIDE (loopback, gateway, another project network with a token the fence lets through
//       there) => 403 "only from the project network" — the fence gives the scope whatever the source, the route does not. The
//       helper reaches it via the address in the project network: in (d) the address the CLI sees opens the route from the
//       instance's subnet (in the test 127.0.0.0/8 — the instance's address is 127.0.0.1).
//   (b') `{ host, rejected }` with the fingerprint (sha256 hex of `username\npassword`) of the STORED access => `{ ok: true }`,
//       afterwards `{ access: null }` for this host (also uppercase, with a port, from another project of the same workspace);
//       a foreign fingerprint has no effect — neither before (it blocks nothing) nor after (it does not lift the rejection); a
//       newly stored access applies again at once; `rejected` that is not sha256 hex, 400; no value in response, log, event.
//   (f) the MCP configuration of a Claude turn WITH LFS environment carries the lock in the `env` of EVERY stdio entry
//       (CBASE_LFS_URL/CBASE_LFS_PASS empty, GIT_LFS_SKIP_SMUDGE=1, GIT_LFS_SKIP_DOWNLOAD_ERRORS empty) above its other values;
//       without an instance none of the names, and writeMcpConfig without `lfsLock` is byte-equal to `lfsLock: false`. The
//       subagent (runs/agents.js) is held at the source: every caller of writeMcpConfig passes `lfsLockForStdio(…)`.
//
// Counter-tests (one place sabotaged each): the route without the fence-context check (`fence = { projectId }` of the path) => "route
// without server" and (a) red ("from B (loopback): 200 !== 403", B got the access); the refuted path gate in the route (`path` must
// end in `/info/lfs`) => (b) red ("host with access": `null` instead of the value) and (d) red (the CLI's address opened nothing);
// the workspace from the body => (b) red ("workspaceId in the body changes nothing": the foreign access); the five start places
// without the LFS environment => (d) red ("Claude turn: -e CBASE_LFS_URL missing"); the route without the source check => "route
// without server" and (a') red ("with token from outside": 200 !== 403); without the `rejected` branch => (b') red (a `rejected`
// that is not sha256 hex: 200 !== 400); without the `null` answer on a rejected access => (b') red (the value instead of `null`);
// a foreign fingerprint remembered too => (b') red ("a foreign fingerprint lifted the rejection"); runs/do-run.js without `lfsLock`
// => (f) "every caller" and (d)(f) red; runs/agents.js without `lfsLock` => (f) "every caller" red; toolchain/mcp-config.js without
// the `lfsLock` branch => (d)(f) red.
// No clock: waiting is for quiet, states and stream marks, never for a duration.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { WRAPPER_PATH } from "../electron/server/runtime/inProject.js";
import { TOKEN_HEADER, setFenceSource } from "../electron/server/projectbox/fence.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { lfsAccessResponse, forgetLfsRejections } from "../electron/server/projectbox/lfs-access.js";
import { LFS_NAMES, LFS_STDIO_LOCK, lfsAgentEnvironment, withLfsEnvironment } from "../electron/server/runs/lfs-environment.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { setBackendAccess } from "../electron/server/runs/backend-access.js";
import { serviceScans } from "../electron/server/projects/scans.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { GLOBAL, streamBarrier } from "./quiet.mjs";

// ── Helpers (a test file never imports another; the same are in fence.test.js and inProject.test.js) ──────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// The CLIs' homes in B live in a throwaway folder — never in the machine's real ~/.claude (as inProject.test.js).
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
const withoutOps = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };
function containerStart(fd, name) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const command = (a) => a.args.slice(a.args.indexOf("--") + 1);
// The four names at the exec exactly when `yes` — and ONLY as `-e NAME` before the wrapper; no value in argv.
function lfsAt(a, yes, what, values = []) {
  const header = a.args.slice(0, a.args.indexOf(WRAPPER_PATH));
  const names = header.flatMap((x, i) => (x === "-e" ? [header[i + 1]] : []));
  for (const n of LFS_NAMES) assert.equal(names.includes(n), yes, `${what}: -e ${n} ${yes ? "missing" : "is in the exec"} (${header.join(" ").slice(0, 400)})`);
  for (const x of a.args) {
    assert.ok(!/(?:CBASE_LFS_|GIT_LFS_)[A-Z_]*=/.test(x) && !x.includes("/lfs-access"), `${what}: a value of the LFS environment in argv: ${x.slice(0, 120)}`);
    for (const w of values) assert.ok(!x.includes(w), `${what}: a value in argv`);
  }
}

// The source of a test request (as fence.test.js): the server listens only on 127.0.0.1, a header says which network it comes from.
const SOURCE_HEADER = "x-cbase-test-source";
const testSource = (req) => req.headers?.[SOURCE_HEADER] || req.socket?.remoteAddress;
const NETWORK_A = "10.230.5.2";
const NETWORK_B = "10.230.6.2";
const NETWORK_K = "10.230.7.2";

async function lfsRequest(base, pid, { source = null, token = null, body = { host: "git.example.test" }, raw = null, method = "POST" } = {}) {
  const headers = { Connection: "close" };
  if (source) headers[SOURCE_HEADER] = source;
  if (token) headers[TOKEN_HEADER] = token;
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}/api/projects/${pid}/lfs-access`, { method, headers, body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, cache: res.headers.get("cache-control"), data, text };
}

// The global event stream, read into an array (for the stream barrier); `shutdown()` belongs in the finally.
async function eventReader(base) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal, headers: { Accept: "text/event-stream" } });
  const reader = { events: [], raw: "" };
  let rest = "";
  const run = (async () => {
    try {
      for await (const chunk of res.body) {
        const t = Buffer.from(chunk).toString("utf8");
        reader.raw += t;
        rest += t;
        let i;
        while ((i = rest.indexOf("\n\n")) >= 0) {
          const block = rest.slice(0, i);
          rest = rest.slice(i + 2);
          for (const z of block.split("\n")) if (z.startsWith("data: ")) { try { reader.events.push(JSON.parse(z.slice(6))); } catch { /* not JSON */ } }
        }
      }
    } catch { /* aborted */ }
  })();
  reader.shutdown = async () => { ctrl.abort(); await run; };
  return reader;
}

// A recording of console (log, info, warn, error) — passed through, restored in the finally.
function recording() {
  const rows = [];
  const old = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    old[k] = console[k];
    console[k] = (...a) => { rows.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")); return old[k].apply(console, a); };
  }
  return { rows, back: () => Object.assign(console, old) };
}

// ── The sheet without a server ───────────────────────────────────────────────────────────────────────────────────
test("sheet: without instance, source, address or token {} and the same opts; otherwise the four names, env mixed in, envAlways extended, opts untouched", () => {
  const INST = Object.freeze({ projectId: "p/1", instance: "main", identifier: "p/1/main" });
  const opts = { cwd: "/x", env: { A: "1" }, envAlways: ["A"], detached: true };
  assert.deepEqual(LFS_NAMES, ["CBASE_LFS_URL", "CBASE_LFS_PASS", "GIT_LFS_SKIP_SMUDGE", "GIT_LFS_SKIP_DOWNLOAD_ERRORS"]);
  setBackendAccess(null);
  try {
    assert.deepEqual(lfsAgentEnvironment(null), {});
    assert.equal(withLfsEnvironment(null, opts), opts, "without an instance the same object");
    assert.deepEqual(lfsAgentEnvironment(INST), {}, "without a source nothing");
    assert.equal(withLfsEnvironment(INST, opts), opts);
    setBackendAccess(() => ({ backendUrl: "http://10.230.5.1:7718/", token: "" }));
    assert.deepEqual(lfsAgentEnvironment(INST), {}, "without a token nothing");
    setBackendAccess(() => ({ token: "t" }));
    assert.deepEqual(lfsAgentEnvironment(INST), {}, "without an address nothing");
    setBackendAccess(() => ({ backendUrl: "http://10.230.5.1:7718/", token: "pass-1" }));
    assert.deepEqual(lfsAgentEnvironment(INST), {
      CBASE_LFS_URL: "http://10.230.5.1:7718/api/projects/p%2F1/lfs-access", CBASE_LFS_PASS: "pass-1",
      GIT_LFS_SKIP_SMUDGE: "0", GIT_LFS_SKIP_DOWNLOAD_ERRORS: "1",
    });
    assert.deepEqual(lfsAgentEnvironment({ instance: "main" }), {}, "an instance without a project");
    const including = withLfsEnvironment(INST, opts);
    assert.notEqual(including, opts);
    assert.deepEqual(opts, { cwd: "/x", env: { A: "1" }, envAlways: ["A"], detached: true }, "opts changed");
    assert.deepEqual({ ...including, env: undefined, envAlways: undefined }, { cwd: "/x", env: undefined, envAlways: undefined, detached: true });
    assert.equal(including.env.A, "1");
    assert.equal(including.env.CBASE_LFS_PASS, "pass-1");
    assert.deepEqual(including.envAlways, ["A", ...LFS_NAMES]);
    // Without env in opts: process.env as the base (as inProject without env).
    const withoutEnv = withLfsEnvironment(INST, { cwd: "/y" });
    assert.equal(withoutEnv.env.PATH, process.env.PATH);
    assert.equal(withoutEnv.env.GIT_LFS_SKIP_SMUDGE, "0");
  } finally {
    setBackendAccess(null);
  }
});

// (f) at the source: EVERY call of writeMcpConfig (main run runs/do-run.js, subagent runs/agents.js) passes
// `lfsLockForStdio(<its instance>, <its provider>)` — (d) below runs only the main run; the subagent has the same
// sentence, held here at the text. A third caller without the lock is red, as is a call that does not carry it.
test("(f) every caller of writeMcpConfig passes lfsLockForStdio — main run and subagent, each with the run's instance", () => {
  const SERVER = path.join(import.meta.dirname, "..", "electron", "server");
  const EXPECTED = { "runs/do-run.js": "lfsLockForStdio(instance, providerId)", "runs/agents.js": "lfsLockForStdio(agentInstance, prov)" };
  const findings = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") run(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      const rel = path.relative(SERVER, p).split(path.sep).join("/");
      if (rel === "toolchain/mcp-config.js") continue; // the declaration itself
      const src = fs.readFileSync(p, "utf8");
      for (let i = src.indexOf("writeMcpConfig("); i >= 0; i = src.indexOf("writeMcpConfig(", i + 1)) {
        const row = src.slice(src.lastIndexOf("\n", i) + 1, i);
        if (/^\s*(\/\/|\*)/.test(row)) continue; // a comment
        // The call's parenthesis up to its counterpart (comments in it are balanced).
        let depth = 0, j = i + "writeMcpConfig".length;
        for (; j < src.length; j++) { if (src[j] === "(") depth++; else if (src[j] === ")" && --depth === 0) break; }
        findings.push({ rel, call: src.slice(i, j + 1) });
      }
    }
  };
  run(SERVER);
  assert.deepEqual(findings.map((f) => f.rel).sort(), Object.keys(EXPECTED).sort(), `writeMcpConfig( stands outside the known callers: ${findings.map((f) => f.rel).join(", ")}`);
  for (const { rel, call } of findings) {
    assert.ok(call.includes(`...(${EXPECTED[rel]} ? { lfsLock: true } : {})`), `${rel}: writeMcpConfig without \`...(${EXPECTED[rel]} ? { lfsLock: true } : {})\``);
  }
});

test("route without server: without the operating mark 404, without a fence context 403 — before anything is read", async () => {
  await withEnvironment(withoutOps, async () => {
    assert.deepEqual(lfsAccessResponse({ fence: { projectId: "p" }, projectId: "p", body: { host: "h" } }), { status: 404, body: { error: "only in server mode" } });
  });
  await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1" }, async () => {
    for (const fence of [undefined, null, {}, { projectId: "" }]) {
      const a = lfsAccessResponse({ fence, projectId: "p", body: { host: "h" } });
      assert.equal(a.status, 403, JSON.stringify(fence));
      assert.match(a.body.error, /nur aus einer Agenten-Shell|only from an agent shell/);
    }
    assert.equal(lfsAccessResponse({ fence: { projectId: "p" }, projectId: "q", body: { host: "h" } }).status, 403, "another project in the path");
    // (a') the source must be in the subnet of the token's instance — else 403, before the body counts.
    const fence = { projectId: "p", instance: { subnet: "10.230.5.0/24" } };
    for (const [what, z, source] of [["loopback", fence, "127.0.0.1"], ["gateway", fence, "172.17.0.1"], ["another project network", fence, "10.230.6.2"],
      ["without a source", fence, undefined], ["IPv6", fence, "::1"], ["instance without a subnet", { projectId: "p", instance: {} }, "10.230.5.2"], ["without an instance", { projectId: "p" }, "10.230.5.2"]]) {
      const a = lfsAccessResponse({ fence: z, projectId: "p", body: { host: "h" }, source });
      assert.equal(a.status, 403, `${what}: ${JSON.stringify(a)}`);
      assert.match(a.body.error, /nur aus dem Projektnetz|only from the project network/, what);
    }
  });
});

// ── (a) (b) (c) (e) The route over the fence ─────────────────────────────────────────────────────────────────────
test("(a)(b)(c)(e)(a')(b') route over the fence: without operation 404, from B 403, with the instance's token (also a copy's) the host's access from the instance's workspace, with a token from outside 403; a rejected access => null until the new one — never a value in log or event", async () => {
  const fd = await fakeDocker();
  const random = crypto.randomBytes(6).toString("hex");
  const SECRET = `lfs-secret-${random}`;
  const USER = `lfs-user-${random}`;
  const FOREIGN = `lfs-foreign-${random}`;
  const FRESH = `lfs-new-${random}`;
  const ACCESS = { access: { username: USER, password: SECRET } };
  const log = recording();
  setFenceSource(testSource);
  let reader = null;
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const project = async (name) => {
        const filePath = path.join(ctx.root, "workspace", name);
        fs.mkdirSync(filePath, { recursive: true });
        return ctx.projectWithoutInstance({ name, path: filePath });
      };
      const A = await project("checkout");
      const B = await project("warehouse");
      store.setGitCred(ws.id, "git.example.test", USER, SECRET);
      const w2 = store.createWorkspace({ id: "0a3c5e1e-9999-4a4a-8b8b-000000000024", name: "Other", path: path.join(ctx.root, "other"), createdAt: Date.now() });
      store.setGitCred(w2.id, "git.example.test", "foreign-user", FOREIGN);

      // (a) without the operating mark 404 — also with a body, without a token.
      await withEnvironment(withoutOps, async () => {
        const r = await lfsRequest(base, A.id);
        assert.equal(r.status, 404, r.text);
        assert.deepEqual(r.data, { error: "only in server mode" });
        assert.equal(r.cache, "no-store");
      });

      await withEnvironment(ops(fd), async () => {
        const instance = (p, n, inst = "main") => {
          const name = inst === "main" ? `cbase-p-${p.id}` : `cbase-p-${p.id}-${inst}`;
          containerStart(fd, name);
          return store.createProjectInstance({ projectId: p.id, instance: inst, state: "ready", convertedAt: Date.now(), containerId: name,
            subnet: `10.230.${n}.0/24`, gateway: "127.0.0.1", ip: `10.230.${n}.2`, bridge: `cbp-${n}`, hostname: `cbp-${n}` });
        };
        const iA = instance(A, 5);
        const iB = instance(B, 6);
        const iK = instance(A, 7, "copy-k1");
        const tA = tokenFor(iA);
        const tB = tokenFor(iB);
        const tK = tokenFor(iK);
        assert.ok(tA && tB && tK && new Set([tA, tB, tK]).size === 3);
        reader = await eventReader(base);
        await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the event stream");

        // (a) without a fence context nothing: from B (loopback) and via the gateway without a token 403, from the project network without a token 401.
        for (const [what, o, status] of [["from B (loopback)", {}, 403], ["via the gateway", { source: "172.17.0.1" }, 403], ["from the project network without a token", { source: NETWORK_A }, 401]]) {
          const r = await lfsRequest(base, A.id, o);
          assert.equal(r.status, status, `${what}: ${r.text}`);
          assert.ok(!r.text.includes(SECRET) && !r.text.includes(USER), `${what}: the access got out`);
          if (status === 403) {
            assert.match(r.data.error, /nur aus einer Agenten-Shell|only from an agent shell/, what);
            assert.equal(r.cache, "no-store", what);
          }
        }

        // (b) with the instance's token.
        for (const [what, body, expected] of [
          ["host with access", { host: "git.example.test" }, ACCESS],
          ["with the remote's path (how git-lfs asks)", { host: "git.example.test", path: "group/repo.git" }, ACCESS],
          ["with the LFS endpoint's path", { host: "git.example.test", path: "group/repo.git/info/lfs" }, ACCESS],
          ["host uppercase and with a port", { host: "GIT.Example.TEST:8443" }, ACCESS],
          ["protocol https", { host: "git.example.test", protocol: "https" }, ACCESS],
          ["workspaceId in the body changes nothing", { host: "git.example.test", workspaceId: w2.id }, ACCESS],
          ["host without access", { host: "without.example.test" }, { access: null }],
          ["protocol http", { host: "git.example.test", protocol: "http" }, { access: null }],
        ]) {
          const r = await lfsRequest(base, A.id, { source: NETWORK_A, token: tA, body });
          assert.equal(r.status, 200, `${what}: ${r.text}`);
          assert.deepEqual(r.data, expected, what);
          assert.equal(r.cache, "no-store", what);
          assert.ok(!r.text.includes(FOREIGN), `${what}: the access of another workspace`);
        }
        for (const [what, o] of [["host with a space", { body: { host: "a b" } }], ["host with a path", { body: { host: "git.example.test/x" } }], ["host with a user", { body: { host: "u@git.example.test" } }],
          ["without host", { body: {} }], ["host not a string", { body: { host: 7 } }], ["body not JSON", { raw: "not json" }], ["body a list", { raw: "[]" }]]) {
          const r = await lfsRequest(base, A.id, { source: NETWORK_A, token: tA, ...o });
          assert.equal(r.status, 400, `${what}: ${r.text}`);
          assert.equal(r.cache, "no-store", what);
        }
        const get = await lfsRequest(base, A.id, { source: NETWORK_A, token: tA, method: "GET" });
        assert.equal(get.status, 403, get.text);
        assert.match(get.data.error, /no row in the fence table/);

        // (c) foreign tokens and the copy.
        assert.equal((await lfsRequest(base, A.id, { source: NETWORK_A, token: tB })).status, 401, "B's token from A's network");
        const onB = await lfsRequest(base, B.id, { source: NETWORK_A, token: tA });
        assert.equal(onB.status, 403, onB.text);
        assert.match(onB.data.error, /Fence/);
        assert.deepEqual((await lfsRequest(base, B.id, { source: NETWORK_B, token: tB })).data, ACCESS, "B in the same workspace has the same access");
        assert.deepEqual((await lfsRequest(base, A.id, { source: NETWORK_K, token: tK })).data, ACCESS, "A's copy (copies included)");
        assert.equal((await lfsRequest(base, B.id, { source: NETWORK_K, token: tK })).status, 403, "A's copy on project B");
        // (a') A valid token gives the scope whatever the source (fence.js) — the route, however, only from the project network of the
        // token's instance: from outside 403, with a token, without a value.
        for (const [what, o] of [["with a token from outside (loopback)", { token: tA }], ["with a token via the gateway", { token: tA, source: "172.17.0.1" }],
          ["with a token from outside, body with rejected", { token: tA, body: { host: "git.example.test", rejected: "0".repeat(64) } }]]) {
          const r = await lfsRequest(base, A.id, o);
          assert.equal(r.status, 403, `${what}: ${r.text}`);
          assert.match(r.data.error, /nur aus dem Projektnetz|only from the project network/, what);
          assert.equal(r.cache, "no-store", what);
          assert.ok(!r.text.includes(SECRET) && !r.text.includes(USER), `${what}: the access got out`);
        }

        // (b') THE REJECTION: a foreign fingerprint has no effect; that of the stored access => `null` for this host (in the
        // workspace), until another access is stored.
        const fingerprint = (n, p) => crypto.createHash("sha256").update(`${n}\n${p}`).digest("hex");
        const reject = (pid, source, token, host, rejected) => lfsRequest(base, pid, { source, token, body: { host, rejected } });
        for (const [what, value] of [["not hex", "not-hex"], ["too short", "ab".repeat(16)], ["uppercase", "AB".repeat(32)], ["not a string", 7], ["null", null]]) {
          const r = await reject(A.id, NETWORK_A, tA, "git.example.test", value);
          assert.equal(r.status, 400, `rejected ${what}: ${r.text}`);
        }
        const foreign = await reject(A.id, NETWORK_A, tA, "git.example.test", fingerprint(USER, "one-other-password"));
        assert.deepEqual({ status: foreign.status, data: foreign.data }, { status: 200, data: { ok: true } }, foreign.text);
        assert.deepEqual((await lfsRequest(base, A.id, { source: NETWORK_A, token: tA })).data, ACCESS, "a foreign fingerprint blocked the access");
        const start = await reject(A.id, NETWORK_A, tA, "git.example.test", fingerprint(USER, SECRET));
        assert.deepEqual({ status: start.status, data: start.data, cache: start.cache }, { status: 200, data: { ok: true }, cache: "no-store" }, start.text);
        assert.ok(!start.text.includes(SECRET) && !start.text.includes(USER), "the answer to rejected carries a value");
        for (const [what, pid, source, token, body] of [
          ["the same host", A.id, NETWORK_A, tA, { host: "git.example.test" }],
          ["uppercase and with a port", A.id, NETWORK_A, tA, { host: "GIT.Example.TEST:8443", path: "group/repo.git" }],
          ["another project of the same workspace", B.id, NETWORK_B, tB, { host: "git.example.test" }],
          ["the copy", A.id, NETWORK_K, tK, { host: "git.example.test" }],
        ]) assert.deepEqual((await lfsRequest(base, pid, { source, token, body })).data, { access: null }, `after the rejection: ${what}`);
        // A foreign fingerprint AFTER the rejection does not lift it: only that of the stored access is remembered — otherwise it
        // would overwrite the remembered one, and the rejected access would come out again at the next get.
        assert.deepEqual((await reject(A.id, NETWORK_A, tA, "git.example.test", fingerprint(USER, "one-other-password"))).data, { ok: true });
        assert.deepEqual((await lfsRequest(base, A.id, { source: NETWORK_A, token: tA })).data, { access: null }, "a foreign fingerprint lifted the rejection");
        // A newly stored access (another fingerprint) applies again at once.
        store.setGitCred(ws.id, "git.example.test", USER, FRESH);
        assert.deepEqual((await lfsRequest(base, A.id, { source: NETWORK_A, token: tA })).data, { access: { username: USER, password: FRESH } }, "a new access stayed blocked");
        assert.deepEqual((await lfsRequest(base, B.id, { source: NETWORK_B, token: tB })).data, { access: { username: USER, password: FRESH } });

        // (e) read up to the stream barrier: no event carries a value or user; the log neither.
        await streamBarrier(reader, GLOBAL);
        assert.ok(!reader.raw.includes(SECRET) && !reader.raw.includes(USER) && !reader.raw.includes(FRESH), "an event carries a value or user");
      });
    });
    const everything = log.rows.join("\n");
    assert.ok(!everything.includes(SECRET) && !everything.includes(USER) && !everything.includes(FOREIGN) && !everything.includes(FRESH), "the log carries a value or user");
  } finally {
    if (reader) await reader.shutdown();
    log.back();
    setFenceSource(null);
    forgetLfsRejections();
    fd.cleanUp();
  }
});

// ── (d) The start places at the wire: Claude, Codex, service detection ─────────────────────────────────────────────
// The fake CLI writes what it sees of the four names (one file per turn); one-shot calls (detection, title) answer "[]".
// No backticks and no "${" in the body (it sits in a template of the harness).
const LFS_CLAUDE = fakeClaude({
  main: `
  const env = {};
  for (const k of ${JSON.stringify(LFS_NAMES)}) env[k] = process.env[k] === undefined ? null : process.env[k];
  let nr = 1;
  while (fs.existsSync(path.join(LOCATION, "lfs-claude-" + nr + ".json"))) nr++;
  fs.writeFileSync(path.join(LOCATION, "lfs-claude-" + nr + ".json"), JSON.stringify(env));
  const cfg = arg("--mcp-config");
  fs.writeFileSync(path.join(LOCATION, "lfs-mcp-" + nr + ".json"), cfg && fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "");
  finished();
  say({ type: "result", result: "finished", session_id: "lfs-session-" + nr });`,
  oneshot: `respond("[]");`,
});
const readClaude = (ctx, seq) => JSON.parse(fs.readFileSync(path.join(ctx.root, `lfs-claude-${seq}.json`), "utf8"));
// The MCP configuration as the CLI read it in turn `seq` (--mcp-config).
const readMcp = (ctx, seq) => {
  const t = fs.readFileSync(path.join(ctx.root, `lfs-mcp-${seq}.json`), "utf8");
  assert.ok(t, `Turn ${seq} got no --mcp-config`);
  return JSON.parse(t);
};
const stdioEntries = (cfg) => Object.entries(cfg.mcpServers || {}).filter(([, e]) => e && typeof e.command === "string");
const lfsValues = (e) => Object.fromEntries(LFS_NAMES.map((k) => [k, e.env?.[k]]));
async function turnThrough(ctx, chatId) {
  await ctx.waitForQuiet();
  const log = await json(`${ctx.base}/api/chats/${chatId}/log`);
  assert.ok(log.some((m) => m.role === "meta"), `the turn did not run through — its start failed (log: ${JSON.stringify(log).slice(-600)})`);
}

test("(d)(f) Claude and Codex turns of a converted project carry the four names (values only in the environment, they open the route from the instance's subnet), without an instance row none; service detection none; the stdio MCP servers of the Claude turn carry the lock", async () => {
  const fd = await fakeDocker();
  const random = crypto.randomBytes(6).toString("hex");
  const SECRET = `lfs-secret-${random}`;
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws } = ctx;
      await withEnvironment(ops(fd), async () => {
        const filePath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Register", path: filePath });
        const name = `cbase-p-${p.id}`;
        containerStart(fd, name);
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        store.setGitCred(ws.id, "git.example.test", "lfs-user", SECRET);

        // Without an instance row: the turn runs in B, without exec, and the CLI sees none of the four names.
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
        await turnThrough(ctx, chat.id);
        assert.deepEqual(execCalls(fd), [], "without an instance row no docker exec");
        assert.deepEqual(readClaude(ctx, 1), Object.fromEntries(LFS_NAMES.map((k) => [k, null])), "without an instance the CLI carries one of the names");
        // (f) without an instance: no stdio entry carries one of the names.
        const mcp1 = readMcp(ctx, 1);
        assert.ok(stdioEntries(mcp1).length >= 1, JSON.stringify(mcp1).slice(0, 300));
        for (const [n, e] of stdioEntries(mcp1)) for (const k of LFS_NAMES) assert.ok(!(e.env && k in e.env), `without an instance the MCP entry ${n} carries ${k}`);
        // (f) writeMcpConfig without `lfsLock` is byte-equal to `lfsLock: false`; with `true` EXACTLY every stdio entry gets the
        // lock above its other env, nothing else changes.
        const comparison = path.join(ctx.root, "mcp-comparison");
        fs.mkdirSync(comparison);
        const baseValue = { projectId: p.id, workspaceId: ws.id, chatId: chat.id, headless: true };
        const write = (file, extra) => { writeMcpConfig(path.join(comparison, file), { ...baseValue, ...extra }); return fs.readFileSync(path.join(comparison, file), "utf8"); };
        const withoutDetail = write("without.json", {});
        assert.equal(write("wrong.json", { lfsLock: false }), withoutDetail, "lfsLock: false is not byte-equal to no indication");
        const withLock = JSON.parse(write("including.json", { lfsLock: true }));
        const withoutLock = JSON.parse(withoutDetail);
        assert.deepEqual(Object.keys(withLock.mcpServers), Object.keys(withoutLock.mcpServers));
        for (const [n, e] of Object.entries(withoutLock.mcpServers)) {
          const expected = typeof e.command === "string" ? { ...e, env: { ...(e.env || {}), ...LFS_STDIO_LOCK } } : e;
          assert.deepEqual(withLock.mcpServers[n], expected, `lfsLock: ${n}`);
        }

        // With an instance row: the next turn in the container — `-e` of the four names, the values only in the environment. The
        // instance's subnet contains its address 127.0.0.1 (the route answers only from the instance's project network).
        const inst = store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name, gateway: "127.0.0.1", ip: "127.0.0.1", subnet: "127.0.0.0/8" });
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Again" }) });
        await turnThrough(ctx, chat.id);
        const pass = tokenFor(inst);
        const url = `http://127.0.0.1:${ctx.port}/api/projects/${p.id}/lfs-access`;
        const claudeExecs = execCalls(fd).filter((a) => a.args.includes(name) && command(a)[0] === process.env.CLAUDE_BIN);
        assert.equal(claudeExecs.length, 1, "the turn did not run (exactly once) in the project container");
        lfsAt(claudeExecs[0], true, "Claude-Turn", [pass, url]);
        const seen = readClaude(ctx, 2);
        assert.deepEqual(seen, { CBASE_LFS_URL: url, CBASE_LFS_PASS: pass, GIT_LFS_SKIP_SMUDGE: "0", GIT_LFS_SKIP_DOWNLOAD_ERRORS: "1" });
        // Address and credential the CLI sees open exactly this route (how the helper asks).
        const r = await fetch(seen.CBASE_LFS_URL, { method: "POST", headers: { "Content-Type": "application/json", [TOKEN_HEADER]: seen.CBASE_LFS_PASS, Connection: "close" }, body: JSON.stringify({ host: "git.example.test", path: "group/repo.git" }) });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { access: { username: "lfs-user", password: SECRET } });
        // (f) with an instance: every stdio server of the CLI gets the lock above its env — the CLI itself carries the names (above), its
        // MCP servers do not inherit the access. The cbase MCP keeps its instance's address and token.
        const mcp2 = readMcp(ctx, 2);
        const stdio2 = stdioEntries(mcp2);
        assert.ok(stdio2.some(([n]) => n === "cbase"), `no stdio entry cbase: ${Object.keys(mcp2.mcpServers).join(", ")}`);
        for (const [n, e] of stdio2) assert.deepEqual(lfsValues(e), LFS_STDIO_LOCK, `the stdio server ${n} inherits the CLI's LFS environment`);
        assert.ok(mcp2.mcpServers.cbase.env.CBASE_BASE_URL && mcp2.mcpServers.cbase.env.CBASE_TOKEN, "the cbase MCP lost address or token");
        assert.ok(!JSON.stringify(mcp2).includes(SECRET), "a value of the access in the MCP configuration");

        // Service detection (runOnceClaude in the project container) carries none of the names.
        const beforeDetection = execCalls(fd).length;
        const scan = await json(`${base}/api/projects/${p.id}/services/scan`, { method: "POST" });
        assert.equal(scan.ok, true, JSON.stringify(scan));
        await waitForTruthy(() => { const s = serviceScans.get(String(p.id)); return s && s.status !== "running" ? s : null; }, "detection finished");
        await ctx.waitForQuiet();
        const detection = execCalls(fd).slice(beforeDetection).filter((a) => a.args.includes(name) && command(a)[0] === process.env.CLAUDE_BIN);
        assert.equal(detection.length, 1, `detection did not run (exactly once) in the project container: ${JSON.stringify(execCalls(fd).slice(beforeDetection).map(command)).slice(0, 400)}`);
        lfsAt(detection[0], false, "service detection");

        // Codex: a turn in the same project — `-e` of the four names.
        const cx = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: p.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${cx.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex with LFS" }) });
        const beforeCodex = execCalls(fd).length;
        await json(`${base}/api/chats/${cx.id}/message`, { method: "POST", body: JSON.stringify({ text: "Compute" }) });
        await turnThrough(ctx, cx.id);
        const codexExecs = execCalls(fd).slice(beforeCodex).filter((a) => a.args.includes(name) && command(a)[0] === process.env.CODEX_BIN);
        assert.ok(codexExecs.length >= 1, "the Codex turn did not run in the project container");
        for (const a of codexExecs) lfsAt(a, true, "Codex-Turn", [pass, url]);
      });
    }, { claude: LFS_CLAUDE, codex: true });
  } finally {
    fd.cleanUp();
  }
});
