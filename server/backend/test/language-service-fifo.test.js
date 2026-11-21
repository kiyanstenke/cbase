// The language service on the files of a CONVERTED project: lsp/limit.js, devtools/routes.js /api/lsp (lspTarget, lspAgentTarget),
// devtools/code-route.js /lsp/* (lspTargetFor).
//
// THE PROBLEM. The project folder is mounted rw in the project container; a process there creates FIFOs and links. B used to read
// there through the PATH (`readFileSync`): a FIFO in place of a file is a blocking open — the event loop stands, and with it the
// WHOLE backend B, until someone opens the FIFO from the other side. Now the language server computes IN the instance (it reads the
// project folder itself, in the project container); B reads only when an agent has no buffer (`source: "disk"`) or the editor asks
// without a buffer, and it writes only for an agent (rename) — both through the descriptor (lsp/limit.js).
//
// WHAT HOLDS HERE. The server runs as a CHILD PROCESS (withAgentsServer { childProcess: true }, operating marker, fake docker, a converted
// project "till"; the language server is test/fake-lsp.mjs via `CBASE_LSP_FAKE`, started through `docker exec` in the fake docker):
// a hang there is no hang of the test process. Every place gets a FIFO and a COUNTERPART — its own process that opens the FIFO
// blocking from the other side (for writing where B reads; for reading where B writes). Decided without a clock: if the counterpart
// opens and then succeeds at something that only succeeds when B REALLY stands at the FIFO, B hung (see atTheFifo).
//   (K0) precondition: the service works with a token (server in the project container, through docker exec)
//   (K1) /api/lsp with token, `file` is a FIFO                                 => 400 "Not a regular file" (lsp/limit.js readDisk)
//   (K4) web, project level, /lsp/diagnostics WITHOUT buffer on a FIFO         => 400 (readDisk in the area from `opts.instance`)
//   (K5) /api/lsp rename, a target is known (open document), on disk a FIFO    => 409, B does not write into it and does not hang;
//        B also reads a known document from disk before writing (lsp/actions.js, lsp/limit.js writeEverythingOrNothing) — the FIFO
//        shows already when reading: "not readable (ENOFILE) — nothing written", the other file stays too (all or nothing)
//   (K6) web, workspace level, /lsp/diagnostics WITHOUT buffer on a FIFO in till => 400 (target through lspTargetFor)
//   (K7) /api/lsp with token, rename, a file with hits became a FIFO           => 409 "not readable (ENOFILE)", nothing written
//   (K8) /api/lsp WITHOUT token (B itself), `file` is a FIFO in till           => 400 (lspTarget without fence: fileLimit of "/")
//   (K9) the instance is stopped => `{ supported: false, reason: "stopped" }`, no new language server; status: stopped
//   (K10) workspace level: a file under till goes to the server of the project, one without a project => no_project
// Writing through the opened parent folder is held by lsp-core.test.js (15).
//
// COUNTER-TEST: lsp/limit.js readDisk reads through the path (`fs.readFileSync(abs, "utf8")` instead of the descriptor) => (K1) red
// ("B read the FIFO … and hung"), the cases after it fail fast (server ended).
//
// No clock: waits on events (responses, messages of the counterpart over IPC). A counterpart that never opens, and the child, are
// killed hard in the finally (own pids, own process group).
//
// Run (from server/backend/): env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000
//   CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap test/language-service-fifo.test.js
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { LANGUAGES } from "../electron/server/lsp/contract.js";
import { TOKEN_HEADER } from "../electron/server/projectbox/fence.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

const FAKE_LSP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-lsp.mjs");

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const fifo = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.rmSync(p, { force: true });
  const r = spawnSync("mkfifo", [p]);
  assert.equal(r.status, 0, String(r.stderr));
};
const position = (text, row, column) => text.split("\n").slice(0, row - 1).reduce((n, z) => n + z.length + 1, 0) + column - 1;

async function request(base, filePath, { method = "GET", token = null, body, signal } = {}) {
  const headers = { Connection: "close" };
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${filePath}`, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
}

// The counterpart of a FIFO — its own process in its own process group. It opens the FIFO blocking (async: a thread of the pool
// waits, the loop stays free for IPC). Mode "w" (B reads there): after the open write 256 KiB — more than a pipe buffer; that
// only succeeds if a reader REALLY takes the bytes —, message "written" or "write-error" (EPIPE: the reader was already gone),
// then close on a word from the test. Mode "r" (B writes there): after the open, on a word from the test read to EOF, message
// "read" with the number of bytes.
const COUNTERPART = `
const fs = require("node:fs");
const [fifo, mode] = process.argv.slice(1);
const report = (m) => { try { process.send(m); } catch {} };
fs.open(fifo, mode === "w" ? fs.constants.O_WRONLY : fs.constants.O_RDONLY, (e, fd) => {
  if (e) return report({ kind: "error", code: e.code });
  report({ kind: "open" });
  if (mode === "w") {
    fs.write(fd, Buffer.alloc(256 * 1024, 0x0a), (e2, n) => {
      report(e2 ? { kind: "write-error", code: e2.code } : { kind: "written", n });
      process.once("message", () => fs.close(fd, () => report({ kind: "zu" })));
    });
  } else {
    process.once("message", () => {
      let n = 0;
      const buffer = Buffer.alloc(64 * 1024);
      const read = () => fs.read(fd, buffer, 0, buffer.length, null, (e3, k) => {
        if (e3) return report({ kind: "read", n, code: e3.code });
        if (k === 0) return fs.close(fd, () => report({ kind: "read", n }));
        n += k;
        read();
      });
      read();
    });
  }
});
report({ kind: "ready" });
`;
const counterparts = new Set();
function counterpart(filePath, mode) {
  const subprocess = spawn(process.execPath, ["-e", COUNTERPART, filePath, mode], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true });
  const inlet = [];
  const waiters = [];
  subprocess.on("message", (m) => {
    inlet.push(m);
    for (const w of [...waiters]) if (w.kinds.includes(m.kind)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const end = new Promise((resolve) => subprocess.once("exit", (code, signal) => resolve({ kind: "end", code, signal })));
  const g = {
    pid: subprocess.pid,
    next: (...kinds) => {
      const existing = inlet.find((m) => kinds.includes(m.kind));
      return existing ? Promise.resolve(existing) : Promise.race([new Promise((resolve) => waiters.push({ kinds, resolve })), end]);
    },
    send: (m = {}) => { try { subprocess.send(m); } catch { /* already gone */ } },
    kill: () => {
      try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* already gone */ }
      try { subprocess.kill("SIGKILL"); } catch { /* already gone */ }
      subprocess.channel?.unref?.();
      counterparts.delete(g);
      return end;
    },
  };
  counterparts.add(g);
  return g;
}

// A request in which B reads the FIFO at `filePath` (mode "w") or writes into it (mode "r") — without a clock and without a hang of
// B stopping the test process (see header). → { hing, lane, first, second }.
// If B demonstrably stands IN the read of the FIFO (mode "w": it took the 256 KiB, EOF is pending), the verdict is in: the second
// request goes out, then `abort` ends the server process hard (SIGKILL to its group), and both requests abort. Freeing it again
// would mean serving every further blocking open of B from the other side (on the old code one path reads the same FIFO twice or
// writes it afterwards) — which itself hung in the first draft. The following cases of the same file then fail fast (no server),
// never hang.
async function atTheFifo(base, filePath, mode, firstRequest, abort) {
  const g = counterpart(filePath, mode);
  const lane = [];
  const ac = new AbortController();
  const tot = (kind) => (e) => { if (ac.signal.aborted) return { status: 0, data: `${kind} aborted (server ended)` }; throw e; };
  try {
    await g.next("ready");
    const first = firstRequest(ac.signal).then((r) => { lane.push("first-response"); return r; }, tot("first"));
    const secondRequest = () => request(base, "/api/runs/active", { signal: ac.signal }).then((r) => { lane.push("second-response"); return r; }, tot("second"));
    const first2 = await Promise.race([first.then(() => "response"), g.next("open", "error").then((m) => m.kind)]);
    let hing = false;
    let second;
    if (first2 === "open") {
      lane.push("fifo-open");
      if (mode === "w") {
        // If B takes the 256 KiB, B stands in the read of the FIFO (only EOF ends it); otherwise EPIPE or already the response.
        const m = await Promise.race([first.then(() => ({ kind: "response" })), g.next("written", "write-error")]);
        if (m.kind === "written") {
          hing = true;
          lane.push("b-reads-fifo");
          second = secondRequest();
          lane.push("second-sent");
          // B stands synchronously in read() — the second request cannot be answered by it. The proof is made; end the server.
          lane.push("server-ended");
          abort();
          ac.abort();
        }
      } else {
        // B opened for writing (blocking) — or only knocked briefly and got ENXIO. The second request goes out BEFORE the
        // counterpart reads: if B stands in the write (more than a pipe buffer), it can answer it only afterwards.
        second = secondRequest();
        lane.push("approval");
        g.send(); // read to EOF
        const m = await g.next("read");
        if (m.n > 0) { hing = true; lane.push(`b-wrote-${m.n}-bytes`); }
      }
    }
    const e = await first;
    second = await (second || secondRequest());
    return { hing, lane, first: e, second };
  } finally {
    await g.kill();
  }
}
const verdict = (r, what) => `B ${what} and hung — GET /api/runs/active stayed unanswered (lane: ${r.lane.join(" → ")}; first response ${r.first.status} ${JSON.stringify(r.first.data).slice(0, 200)})`;

// The converted project in the server process: project through the route, instance row directly into its database (there is no
// route for it; runInstance reads it per request), container in the fake docker.
function instanceRow(dataRoot, { projectId, containerId }) {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try {
    const t = Date.now();
    raw.prepare(`INSERT INTO project_instances (project_id, instance, container_id, state, converted_at, subnet, gateway, ip, bridge, hostname,
      state_since, created_at, updated_at) VALUES (?, 'main', ?, 'ready', ?, '10.230.5.0/24', '127.0.0.1', '10.230.5.2', 'cbp-5', 'cbp-5', ?, ?, ?)`)
      .run(projectId, containerId, t, t, t, t);
  } finally { raw.close(); }
}


const instanceState = (dataRoot, projectId, state) => {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try { raw.prepare("UPDATE project_instances SET state = ? WHERE project_id = ? AND instance = 'main'").run(state, projectId); } finally { raw.close(); }
};

// ── (K0)–(K10): the server as a child process ────────────────────────────────────────────────────────────────────────────
test("FIFO in a converted project: the language service of the agents (with and without token) and of the editor reads and writes only through the descriptor — B answers the second request without anyone opening the FIFO", async (t) => {
  const fd = await fakeDocker();
  let childPid = null;
  const scenarioFile = path.join(fd.dir, "lsp-scenario.json");
  const scenario = (o = {}) => fs.writeFileSync(scenarioFile, JSON.stringify(o));
  scenario();
  try {
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_LSP_FAKE: JSON.stringify([process.execPath, FAKE_LSP, "--scenario", scenarioFile]) }, () =>
      withAgentsServer(async (ctx) => {
        const { base, ws, dataRoot } = ctx;
        childPid = ctx.childPid;
        const till = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(till, { recursive: true });
        const A = await ctx.projectWithoutInstance({ name: "till", path: till });
        const container = `cbase-p-${A.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        instanceRow(dataRoot, { projectId: A.id, containerId: container });
        const token = await ctx.token(A.id);
        const fall = (name) => { const d = path.join(till, name); fs.mkdirSync(d, { recursive: true }); return d; };
        const lsp = (body, withToken = true) => (signal) => request(base, "/api/lsp", { method: "POST", token: withToken ? token : null, body, signal });
        const abort = () => { try { process.kill(-childPid, "SIGKILL"); } catch { /* already gone */ } };
        const lspStarts = () => fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(FAKE_LSP)).length;

        await t.test("(K0) precondition: without a FIFO the service works with a token — the language server runs in the project container", async () => {
          const k0 = fall("k0");
          write(path.join(k0, "a.ts"), "export const x: number = 1;\n");
          const v = await request(base, "/api/lsp", { method: "POST", token, body: { file: path.join(k0, "a.ts"), action: "diagnostics" } });
          assert.equal(v.status, 200, `Vorbedingung: ${JSON.stringify(v.data)}`);
          assert.deepEqual(v.data.diagnostics, []);
          assert.equal(lspStarts(), 1, "the language server starts through docker exec in the instance");
        });

        await t.test("(K1) the file itself is a FIFO", async () => {
          const k1 = fall("k1");
          fifo(path.join(k1, "x.ts"));
          const r1 = await atTheFifo(base, path.join(k1, "x.ts"), "w", lsp({ file: path.join(k1, "x.ts"), action: "diagnostics" }), abort);
          assert.equal(r1.hing, false, verdict(r1, "read the FIFO (route /api/lsp)"));
          assert.equal(r1.first.status, 400, JSON.stringify(r1.first.data));
          assert.match(r1.first.data.error, /regul/i);
          assert.equal(r1.second.status, 200);
        });

        await t.test("(K7) rename: a file with hits became a FIFO", async () => {
          const k7 = fall("k7");
          const k7b = "import { alt } from './a';\nexport const y = alt + 1;\n";
          write(path.join(k7, "b.ts"), k7b);
          fifo(path.join(k7, "a.ts"));
          scenario({ renameAlongside: [{ path: path.join(k7, "a.ts") }] });
          const r7 = await atTheFifo(base, path.join(k7, "a.ts"), "w", lsp({ file: path.join(k7, "b.ts"), action: "rename", line: 2, column: 18, newName: "fresh" }), abort);
          scenario();
          assert.equal(r7.hing, false, verdict(r7, "read the FIFO (rename, text of a hit)"));
          // A 409 instead of 200 with `changed: []` — a write that did not happen is no success.
          assert.equal(r7.first.status, 409, JSON.stringify(r7.first.data));
          assert.equal(r7.first.data.changed, undefined, JSON.stringify(r7.first.data));
          assert.match(String(r7.first.data.error), /(nicht lesbar|not readable) \(ENOFILE\)/); // the language follows the system (German on a German Mac)
          assert.equal(fs.readFileSync(path.join(k7, "b.ts"), "utf8"), k7b, "nothing written");
          assert.equal(r7.second.status, 200);
        });

        await t.test("(K4) web, project level: diagnostics WITHOUT buffer on a FIFO", async () => {
          const k4 = fall("k4");
          fifo(path.join(k4, "x.ts"));
          const r4 = await atTheFifo(base, path.join(k4, "x.ts"), "w", (signal) => request(base, `/api/projects/${A.id}/lsp/diagnostics`, { method: "POST", body: { file: "k4/x.ts" }, signal }), abort);
          assert.equal(r4.hing, false, verdict(r4, "read the FIFO (web /lsp/diagnostics without buffer, project level)"));
          assert.equal(r4.first.status, 400, JSON.stringify(r4.first.data));
          assert.equal(r4.second.status, 200);
        });

        await t.test("(K5) /api/lsp rename — a target is known as a document, on disk there is now a FIFO", async () => {
          const k5 = fall("k5");
          const k5a = "export const oldName = 1;\n";
          const k5b = `import { oldName } from './a';\nexport const z = oldName;\n// ${"x".repeat(200 * 1024)}\n`;
          write(path.join(k5, "a.ts"), k5a);
          write(path.join(k5, "b.ts"), k5b);
          assert.equal((await request(base, "/api/lsp", { method: "POST", token, body: { file: path.join(k5, "a.ts"), action: "diagnostics" } })).status, 200);
          fifo(path.join(k5, "a.ts"));
          scenario({ renameAlongside: [{ path: path.join(k5, "a.ts"), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } } }] });
          const r5 = await atTheFifo(base, path.join(k5, "a.ts"), "r", lsp({ file: path.join(k5, "b.ts"), action: "rename", line: 2, column: 18, newName: "newName" }), abort);
          scenario();
          assert.equal(r5.hing, false, verdict(r5, "wrote into the FIFO (/api/lsp rename)"));
          assert.equal(r5.first.status, 409, JSON.stringify(r5.first.data).slice(0, 300));
          assert.match(String(r5.first.data.error), /a\.ts: (nicht lesbar \(ENOFILE\) — nichts geschrieben|not readable \(ENOFILE\) — nothing written)/);
          assert.ok(!(r5.first.data.changed || []).length, "nothing under changed — all or nothing");
          assert.equal(fs.readFileSync(path.join(k5, "b.ts"), "utf8"), k5b, "the other file of the rename stayed");
          assert.equal(r5.second.status, 200);
        });

        await t.test("(K6) web, workspace level: diagnostics WITHOUT buffer on a FIFO in till", async () => {
          const k6 = fall("k6");
          fifo(path.join(k6, "x.ts"));
          const r6 = await atTheFifo(base, path.join(k6, "x.ts"), "w", (signal) => request(base, `/api/workspaces/${ws.id}/lsp/diagnostics`, { method: "POST", body: { file: "till/k6/x.ts" }, signal }), abort);
          assert.equal(r6.hing, false, verdict(r6, "read the FIFO (web /lsp/diagnostics without buffer, workspace level)"));
          assert.equal(r6.first.status, 400, JSON.stringify(r6.first.data));
          assert.equal(r6.second.status, 200);
        });

        await t.test("(K8) /api/lsp without token (B itself): `file` is a FIFO in till", async () => {
          const k8 = fall("k8");
          fifo(path.join(k8, "x.ts"));
          const r8 = await atTheFifo(base, path.join(k8, "x.ts"), "w", lsp({ file: path.join(k8, "x.ts"), action: "diagnostics" }, false), abort);
          assert.equal(r8.hing, false, verdict(r8, "read the FIFO (route /api/lsp without token)"));
          assert.equal(r8.first.status, 400, JSON.stringify(r8.first.data));
          assert.equal(r8.second.status, 200);
        });

        await t.test("(K10) workspace level: a file under till goes to the server of the project, one without a project => no_project", async () => {
          const prior = lspStarts();
          const r = await request(base, `/api/workspaces/${ws.id}/lsp/hover`, { method: "POST", body: { file: "till/k0/a.ts", buffer: "w1", version: 1, text: "const value = 1;\n", position: { line: 0, character: 7 } } });
          assert.equal(r.status, 200, JSON.stringify(r.data));
          assert.equal(r.data.contents, "**value**");
          assert.equal(lspStarts(), prior, "the workspace level takes the session of the project (no second server)");
          const free = await request(base, `/api/workspaces/${ws.id}/lsp/hover`, { method: "POST", body: { file: "free.ts", buffer: "w2", version: 1, text: "x", position: { line: 0, character: 0 } } });
          assert.deepEqual(free.data, { supported: false, reason: "no_project" });
        });

        await t.test("(K9) stopped instance: no language server, `stopped` — and the running one ends", async () => {
          instanceState(dataRoot, A.id, "stopped");
          try {
            const prior = lspStarts();
            const r = await request(base, `/api/projects/${A.id}/lsp/diagnostics`, { method: "POST", body: { file: "k0/a.ts", buffer: "b1", version: 1, text: "x" } });
            assert.equal(r.status, 200, JSON.stringify(r.data));
            assert.deepEqual([r.data.supported, r.data.reason, r.data.state], [false, "stopped", "stopped"]);
            const st = await request(base, `/api/projects/${A.id}/lsp/status`, { method: "POST", body: {} });
            assert.deepEqual(st.data.languages.map((l) => l.state), LANGUAGES.map(() => "stopped"));
            assert.equal(lspStarts(), prior, "a stopped instance started a language server");
          } finally { instanceState(dataRoot, A.id, "ready"); }
        });
      }, { childProcess: true }));
  } finally {
    for (const g of [...counterparts]) await g.kill();
    if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch { /* already gone */ } }
    fd.cleanUp();
  }
});

// The service writes itself and returns `{ changed }`, never `edits` — the apply branch of the route (readFileSync/writeFileSync
// over `r.edits`, through the PATH) was dead and a trap: whoever returned `edits` again would write past the boundary
// (lsp/limit.js writeEverythingOrNothing; writing is cbase_lsp_edit — cbase_lsp only reads). A source-text guard, because the branch
// is unreachable; besides, cbase_lsp no longer names `apply`. COUNTER-TESTS: the old branch back in devtools/routes.js => red;
// `apply` back in description and schema => red.
test("no dead apply branch over r.edits in /api/lsp; cbase_lsp and cbase_lsp_edit name no apply", async () => {
  const routes = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "server", "devtools", "routes.js"), "utf8");
  assert.ok(!/\br\??\.edits\b/.test(routes), "devtools/routes.js applies r.edits (dead branch through the path)");
  assert.ok(!/readFileSync\(f,|writeFileSync\(f,/.test(routes), "devtools/routes.js reads/writes hits through the path");
  const { workspaceTools } = await import("../electron/mcp/tools/workspace.js");
  for (const name of ["cbase_lsp", "cbase_lsp_edit"]) {
    const lsp = workspaceTools.find((x) => x.name === name);
    assert.ok(lsp, `${name} is missing`);
    assert.ok(!/apply/.test(lsp.description), `the description of ${name} names apply: ${lsp.description}`);
    assert.equal(lsp.inputSchema.properties.apply, undefined, `the parameter apply is still in the schema of ${name}`);
  }
  assert.match(workspaceTools.find((x) => x.name === "cbase_lsp_edit").description, /writes the result directly into the files/);
});
