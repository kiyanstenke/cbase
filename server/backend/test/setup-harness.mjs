// The harness of the setup tests, pulled out of project-setup.test.js because the findings tests need a file of their own — a
// `.test.js` never imports another (its tests would run twice), and project-setup.test.js was near the 2,000-line limit.
// New here: fakePython/pyHold/pyWaiting/pyContinue (a gate in front of a mode of the SETUP program), `pyGates` at withCreation and
// pyPid (the pid at the gate).
// USED BY: project-setup.test.js, project-setup-findings.test.js, project-unpack.test.js, project-upload.test.js.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { procedureAlive, setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLock } from "../electron/server/projectbox/idle.js";
import { setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { advanceStagesCap } from "../electron/server/projectbox/restore.js";
import { setupProcedureAlive } from "../electron/server/projectbox/setup/procedure.js";
import { setServicesDetection } from "../electron/server/projectbox/detection.js";
import { forgetUpload } from "../electron/server/runtime/upload-stamp.js";
import { fakeClaude, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { ID, STAT, withOps, routeText, scenario } from "./projectbox-scenario.mjs";

// ── Shared ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ONLY_IN_OPS_TEXT = /Server-Betrieb|server mode/i;
export const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// The fake git at the front of the PATH: passes EVERY call through to the real git — except one whose subcommand lies as a marker
// `halt-<command>` in the gate folder: the first such call takes the marker (mv, atomic), holds with the marker `waiting-<command>`
// until `continue-<command>` is there (both markers then fall), and ends with 1 WITHOUT calling git if `abort-<command>` lies next to
// it (a process that survived its server's crash writes nothing any more). The shell (commandRun) looks up git via the PATH of the
// exec — that of the fake docker is that of the test process resp. the server process.
export function fakeGit(bin, gates) {
  fs.mkdirSync(gates, { recursive: true });
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
for a in "$@"; do
  if mv '${gates}'/halt-"$a" '${gates}'/held-"$a".$$ 2>/dev/null; then
    : > '${gates}'/waiting-"$a"
    while [ ! -f '${gates}'/continue-"$a" ]; do sleep 0.02; done
    rm -f '${gates}'/waiting-"$a" '${gates}'/continue-"$a"
    if [ -f '${gates}'/abort-"$a" ]; then exit 1; fi
    break
  fi
done
exec '${REAL_GIT}' "$@"
`, { mode: 0o755 });
}
export const gitHold = (gates, command) => fs.writeFileSync(path.join(gates, `halt-${command}`), "");
export const gitWaiting = (gates, command) => waitForTruthy(() => fs.existsSync(path.join(gates, `waiting-${command}`)), `git ${command} at the gate`);
export const gitContinue = (gates, command) => fs.writeFileSync(path.join(gates, `continue-${command}`), "");

// The fake python3 at the front of the PATH, built like fakeGit: passes EVERY call through to the real python3 — except the SETUP
// program (`python3 -c <program> <mode>`), whose mode lies as a marker `halt-<mode>` in the gate folder: the first such call takes
// the marker, holds with `waiting-<mode>` until `continue-<mode>` is there, and then runs. A gate BETWEEN two modes (count, then
// insert) — the fake docker's exec gate holds every exec and lets all through after opening.
export const REAL_PYTHON = execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
// Plus a gate IN THE MIDDLE of the mode: if `hold-write-<mode>` lies there, the SETUP program runs under WRITE_GATE — the first
// `os.write` (the first block of the first file that arises) writes, then the process holds with the marker `waiting-write-<mode>`
// (content: its pid) until `continue-write-<mode>` is there. An abort hits it in the middle of a file.
export function fakePython(bin, gates) {
  fs.mkdirSync(gates, { recursive: true });
  fs.writeFileSync(path.join(gates, "write-gate.py"), WRITE_GATE);
  fs.writeFileSync(path.join(bin, "python3"), `#!/bin/sh
if [ "$1" = "-c" ] && [ -n "$3" ] && mv '${gates}'/halt-"$3" '${gates}'/held-"$3".$$ 2>/dev/null; then
  echo $$ > '${gates}'/pid-raw-"$3".$$ && mv '${gates}'/pid-raw-"$3".$$ '${gates}'/pid-"$3"
  : > '${gates}'/waiting-"$3"
  while [ ! -f '${gates}'/continue-"$3" ]; do sleep 0.02; done
  rm -f '${gates}'/waiting-"$3" '${gates}'/continue-"$3"
fi
if [ "$1" = "-c" ] && [ -n "$3" ] && mv '${gates}'/hold-write-"$3" '${gates}'/held-write-"$3".$$ 2>/dev/null; then
  exec '${REAL_PYTHON}' '${gates}'/write-gate.py "$3" "$2"
fi
exec '${REAL_PYTHON}' "$@"
`, { mode: 0o755 });
}
export const pyHold = (gates, mode) => fs.writeFileSync(path.join(gates, `halt-${mode}`), "");
export const pyWaiting = (gates, mode) => waitForTruthy(() => fs.existsSync(path.join(gates, `waiting-${mode}`)), `SETUP ${mode} at the gate`);
export const pyContinue = (gates, mode) => fs.writeFileSync(path.join(gates, `continue-${mode}`), "");
// The pid of the process holding at the gate in front of `mode` (a server end hits it there) — written BEFORE `waiting-<mode>`
// arises, so valid after pyWaiting.
export const pyPid = (gates, mode) => Number(fs.readFileSync(path.join(gates, `pid-${mode}`), "utf8"));

// The gate in the middle of the mode (see above): `python3 write-gate.py <mode> <program>` — the gate folder is the file's folder.
// The pid goes atomically into the marker (first a file without the prefix "waiting-", then renamed: the cleanup of withCreation
// opens every "waiting-" gate and must not see a half name).
export const WRITE_GATE = String.raw`import os, sys, time
gates = os.path.dirname(os.path.abspath(__file__))
mode, program = sys.argv[1], sys.argv[2]
real = os.write
first = [True]
def write(fd, buf):
    n = real(fd, buf)
    if first[0]:
        first[0] = False
        marker = os.path.join(gates, "waiting-write-" + mode)
        raw = os.path.join(gates, "pid-write-" + mode)
        with open(raw, "w") as f:
            f.write(str(os.getpid()))
        os.rename(raw, marker)
        further = os.path.join(gates, "continue-write-" + mode)
        while not os.path.exists(further):
            time.sleep(0.02)
        for p in (further, marker):
            try:
                os.unlink(p)
            except OSError:
                pass
    return n
os.write = write
sys.argv = ["-c", mode]
exec(compile(program, "<string>", "exec"), {"__name__": "__main__", "__builtins__": __builtins__})
`;
export const pyWriteHold = (gates, mode) => fs.writeFileSync(path.join(gates, `hold-write-${mode}`), "");
/** Until the SETUP program holds in the middle of the mode → its pid. */
export async function pyWriteWaiting(gates, mode) {
  const marker = path.join(gates, `waiting-write-${mode}`);
  await waitForTruthy(() => fs.existsSync(marker), `SETUP ${mode} in the middle of writing at the gate`);
  return Number(fs.readFileSync(marker, "utf8"));
}
/** Until the process `pid` is gone (an event: kill -0 fails). */
export const processGone = (pid, what = `process ${pid} gone`) => waitForTruthy(() => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; }
}, what);
export const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
export const read = (p) => fs.readFileSync(p, "utf8");

export async function request(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method, headers: { "Content-Type": "application/json", Connection: "close" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let b;
  try { b = JSON.parse(text); } catch { b = text; }
  return { status: res.status, body: b };
}
export const active = async (base) => (await request(`${base}/api/runs/active`)).body;
export const setupRoute = (base, pid, rest) => `${base}/api/projects/${pid}/setup/${rest}`;

// A reader of the global stream (/api/events) — built like project-instances.test.js.
export async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on closing */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

export const gatePath = (fd, name) => path.join(fd.dir, "gates", encodeURIComponent(name));
// Close a gate again AND remove its waiting marker (otherwise gateReached reports the previous stop).
export function gateClosed(fd, name) {
  fd.closeGate(name);
  fs.rmSync(`${gatePath(fd, name)}.waiting`, { force: true });
}

// Is a procedure (creation, restore, setup) still alive for any project?
export const aliveStill = () => store.projectInstances().some((z) => procedureAlive(z.projectId, z.instance))
  || store.listAllProjects().some((p) => setupProcedureAlive(p.id));

// After the body, STILL in operation: if a procedure is still alive (a failure in the middle of it, a counter-test), every gate
// opens and every stage cap goes off (built like projectbox-recreate.test.js). Cleanup only.
export async function carryOut(fd) {
  while (aliveStill()) {
    const gates = path.join(fd.dir, "gates");
    for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) {
      if (f.endsWith(".waiting")) fd.openGate(decodeURIComponent(f.slice(0, -".waiting".length)));
    }
    advanceStagesCap();
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Plus the upload stamp (module state, it would otherwise survive into the next test of this file).
export function cleanUpRows() {
  for (const p of store.listAllProjects()) forgetUpload(p.id);
  for (const e of store.setups()) store.deleteSetup(e.projectId);
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
    try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[setup-test] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}

// The frame of a test in operation: server, scenario (network marker, status file, B's home), fake docker with a `df` that reports
// the content of a file as free, the creation options for EVERY project (the POST assigns the id), a recorder instead of the
// services detection, a reader of the global stream.
// `claude` (the harness's fake CLI) and `environment(fd)` (variables while the body runs — e.g. those of the CLI in the project
// container) for the turn tests; plus always the fake git (`gitGates`, see fakeGit) next to the fake `df`.
export async function withCreation(fn, { fdOpts = {}, free = 10 ** 13, claude = null, environment = null } = {}) {
  await withAgentsServer(async (ctx) => {
    const dfFile = path.join(ctx.root, "df-free");
    fs.writeFileSync(dfFile, String(free));
    // `df` runs behind the shell (commandRun), which looks it up via the exec's PATH — the fake docker's PATH is the test process's;
    // a folder with the fake `df` at the front (macOS does not know `-B1`).
    const bin = path.join(ctx.root, "fake-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "df"), `#!/bin/sh\necho "    Avail"\n/bin/cat '${dfFile}'\n`, { mode: 0o755 });
    const gitGates = path.join(ctx.root, "git-gates");
    fakeGit(bin, gitGates);
    const pyGates = path.join(ctx.root, "py-gates");
    fakePython(bin, pyGates);
    const s = scenario(ctx);
    store.deleteProject(ctx.ws.id, s.projectId); // the scenario's own project would otherwise count as "without an instance row"
    fs.writeFileSync(path.join(s.home, ".gitconfig"), "[user]\n\tname = Test Nutzer\n\temail = test@example.invalid\n");
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, ...fdOpts });
    const detected = [];
    setCreationOptions(() => s.opts);
    // The recorder at the ONE seam of the detection (projectbox/detection.js): fn(projectId, { onlySupplement }) — the creation
    // reconciles, a call with `onlySupplement` would stand there as "<pid>+".
    setServicesDetection((pid, o) => { detected.push(o?.onlySupplement ? `${pid}+` : pid); });
    const reader = await globalReaderFor(ctx.base);
    const extra = environment ? environment(fd) : {};
    const prior = { stage: process.env.CBASE_PROJECT_STAGE_MS, root: process.env.CBASE_NETWORK_ROOT, path: process.env.PATH };
    const priorExtra = Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]]));
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.CBASE_PROJECT_STAGE_MS = "3600000";
    process.env.CBASE_NETWORK_ROOT = s.root;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    try {
      await withOps(fd, async () => {
        try {
          await fn({ ctx, fd, s, detected, reader, gitGates, pyGates, setFree: (n) => fs.writeFileSync(dfFile, String(n)) });
        } finally {
          // A git at the gate (a counter-test, a failure in the middle) continues — otherwise its procedure would live forever.
          for (const f of fs.readdirSync(gitGates)) if (f.startsWith("waiting-")) gitContinue(gitGates, f.slice("waiting-".length));
          for (const f of fs.readdirSync(pyGates)) if (f.startsWith("waiting-")) pyContinue(pyGates, f.slice("waiting-".length));
          await carryOut(fd);
          cleanUpRows();
          forgetUpload(`ws:${ctx.ws.id}`); // the stamp of an upload at the workspace level
        }
      });
    } finally {
      for (const [k, v] of [["CBASE_PROJECT_STAGE_MS", prior.stage], ["CBASE_NETWORK_ROOT", prior.root], ["PATH", prior.path], ...Object.entries(priorExtra)]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      setCreationOptions(null);
      setServicesDetection(null);
      await reader.shutdown();
      fd.cleanUp();
    }
  }, claude ? { claude } : {});
}

// Until `pred(setup)` holds AND no procedure of this setup runs any more (the row is `null` when it is finished) — only then do the
// routes stop answering RUNNING. A state in which nothing runs any more and that is not the expected one throws — a sabotage makes
// the test red, not hanging.
export async function waitUntil(pid, pred, what, { errorAllowed = false } = {}) {
  return waitForTruthy(() => {
    const e = store.setupOf(pid);
    if (pred(e) && !setupProcedureAlive(pid)) return e || { finished: true };
    if (aliveStill()) return false;
    if (e?.state === "error" && !errorAllowed) throw new Error(`${what}: setup in error (${e.code}: ${e.error})`);
    // No procedure lives: the state stays as it is — check whether it fits after all (a transition in the same tick), otherwise red.
    const again = store.setupOf(pid);
    if (pred(again)) return again || { finished: true };
    throw new Error(`${what}: no procedure lives any more, state ${JSON.stringify(again && { step: again.step, state: again.state, waiting: again.waiting, code: again.code, error: again.error, sources: again.sources.map((q) => [q.seq, q.state, q.code]) })}`);
  }, what);
}
export const finished = (pid, what = "setup finished") => waitUntil(pid, (e) => !e, what);
export const inSources = (pid) => waitUntil(pid, (e) => e?.step === "sources", "setup waits for uploads");

export async function create(ctx, body) {
  const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
export const staging = (proj, seq) => path.join(proj.path, `.cbase-source-${seq}`);
export function write(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
// An "uploaded" repo with one commit (built locally — as it would come from a folder upload including `.git`).
export function uploadedRepo(abs) {
  fs.mkdirSync(abs, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", abs]);
  execFileSync("git", ["-C", abs, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "uploaded"]);
  return git(abs, "rev-parse", "HEAD");
}
export const viewIn = async (ctx, pid) => (await request(`${ctx.base}/api/workspaces/${ctx.ws.id}`)).body.projects.find((p) => p.id === pid);

// ── Upload paths, turns, the server as a process ──────────────────────────────────────────────────────────────────────

export const b64 = (t) => Buffer.from(t).toString("base64");
// POST /api/projects/:id/upload — with `operation` in the BODY like web (`{ operation, files }`) and iOS; `location: "address"`
// puts it into the address (`?operation=`).
export const upload = (ctx, pid, body, operation = null, { location = "body" } = {}) => request(
  `${ctx.base}/api/projects/${pid}/upload${operation && location === "address" ? `?operation=${encodeURIComponent(operation)}` : ""}`,
  { method: "POST", body: operation && location === "body" ? { operation, ...body } : body },
);
export const inProject = (ctx, pid, sub, { method = "GET", body, query = "" } = {}) => request(`${ctx.base}/api/projects/${pid}${sub}${query ? `?${query}` : ""}`, { method, body });
export const inWorkspace = (ctx, sub, { method = "GET", body, query = "" } = {}) => request(`${ctx.base}/api/workspaces/${ctx.ws.id}${sub}${query ? `?${query}` : ""}`, { method, body });

// A chunked request with an OPEN body (the test's gate): head and one space are at the server, only `end(body)` sends the rest. It
// returns as soon as the server BEGINS to read the body (a `data` consumer on its request, seen via diagnostics_channel
// "http.server.request.start" — the server runs in the test process) or has already answered: an event, no duration. A stamp that
// would stand only at the end of the request is missing at this moment.
// `operation` null: the address carries none — the operation comes only with the body (the clients' way).
export async function openChunkRequest(ctx, pid, operation) {
  const filePath = `/api/projects/${pid}/upload${operation ? `?operation=${encodeURIComponent(operation)}` : ""}`;
  let page = null;
  const consumer = ({ request: requestData, response }) => { if (requestData.url === filePath) page = { request: requestData, response }; };
  diagnostics.subscribe("http.server.request.start", consumer);
  const anf = http.request(`${ctx.base}${filePath}`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" } });
  const responseValue = new Promise((resolve, reject) => {
    anf.on("response", (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => { let b; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    anf.on("error", reject);
  });
  anf.write(" "); // JSON allows leading whitespace: the head goes out, the body stays open
  try {
    await waitForTruthy(() => page && (page.request.listenerCount("data") > 0 || page.response.writableEnded), "the server reads the body");
  } finally { diagnostics.unsubscribe("http.server.request.start", consumer); }
  return { end: (body) => { anf.end(JSON.stringify(body)); return responseValue; } };
}

// Without an account (built like project-lock.test.js): waking checks the limit — without this the server would read the keychain
// and ask the usage endpoint of the REAL account; `npx` as idle.
export async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-setup-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, NPX_BIN: process.env.NPX_BIN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    process.env.NPX_BIN = path.join(shim, "npx");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleanup of ${root}: ${e.code || e.message}`); }
  }
}

// The main agent writes one line per turn to main.jsonl (built like projectbox-recreate.test.js).
export const CLAUDE_TURN = fakeClaude({ main: `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });` });
export const turns = (root) => readJsonl(path.join(root, "main.jsonl"));
// The environment of the CLI in the project container (built like projectbox-restore.test.js).
export const cliEnvironment = (fd) => ({
  CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
});
export const send = (ctx, text) => request(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: { text } });
export const runsNull = (ctx) => waitForTruthy(async () => (await active(ctx.base)).runs === 0, "no turn any more");
// Until the turn with `text` ran. If the lock still judges "wait" for the chat although no procedure lives any more that could wake
// it (e.g. the setup waits for uploads), it will never run — then red instead of a hang (the lock judges purely, idle.js projectLock).
export const turnRan = (ctx, text, what) => waitForTruthy(() => {
  if (turns(ctx.root).some((t) => String(t.text).includes(text))) return true;
  const u = projectLock(ctx.chat.id, "turn");
  if (u && !aliveStill()) throw new Error(`${what}: the turn waits (${u.reason}), and no procedure lives that would wake it`);
  return false;
}, what);

// The situation for the server as a PROCESS (built like relocation-end.test.js): B's home, system folders, network marker under a
// root of its own, the project container's status file behind a fake `cat`.
export function kindSituation(root) {
  const dir = path.join(root, "kind-situation");
  const home = path.join(dir, "home");
  for (const d of [".claude/agents", ".codex", ".claude-login", ".ssh"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Test Nutzer\n\temail = test@example.invalid\n");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}\n");
  const system = { usrLocalBin: path.join(dir, "sys", "bin"), usrLocalNodeModules: path.join(dir, "sys", "nm"), mcp: path.join(dir, "sys", "mcp") };
  for (const d of Object.values(system)) fs.mkdirSync(d, { recursive: true });
  const rootDir = path.join(dir, "root");
  fs.mkdirSync(path.join(rootDir, "run", "cbase"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "proc", "1"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "proc", "net"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "run", "cbase", "network-separation.ok"), "4242\n");
  fs.writeFileSync(path.join(rootDir, "proc", "1", "stat"), STAT(4242));
  fs.writeFileSync(path.join(rootDir, "proc", "net", "route"), routeText([["eth0", "172.24.0.0/16"]]));
  const inside = path.join(dir, "inside");
  fs.mkdirSync(path.join(inside, "run"), { recursive: true });
  fs.mkdirSync(path.join(inside, "sys", "fs", "cgroup"), { recursive: true });
  fs.writeFileSync(path.join(inside, "run", "cbase-projectbox.status"), "phase=ready\nnotice=DNAT set\n");
  fs.writeFileSync(path.join(inside, "sys", "fs", "cgroup", "cgroup.subtree_control"), "cpu io memory pids\n");
  const cat = path.join(dir, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh\nexec /bin/cat '${inside}'"$1"\n`);
  fs.chmodSync(cat, 0o755);
  return { home, creation: { home, system, root: rootDir, addresses: ["192.0.2.10/24"] }, programs: { cat } };
}
