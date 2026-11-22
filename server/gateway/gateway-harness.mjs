// The REAL gateway (index.js) as a child process — against a fake `docker` and an echo backend. For the guards that must enter
// through index.js: index.js starts a server on load and is therefore not importable. Not a .test.js — the gate runs only the test
// files that use this harness (index.test.js, administration.test.js, administration-proofread.test.js).
//
// Flow: `const gw = await prepareSetup()` creates data folder, web UI, fake docker and the echo backend and opens the gateway DB in
// the test process (users.js) — users, sessions and tokens arise BEFORE the start (two processes on one SQLite file: the test
// process only writes while the gateway is not running yet). `await gw.start()` starts index.js and waits for its line
// "cbase gateway v… on …" AND the resources initial-fill line (events, no deadline; if the second is missing, the fakes'
// emergency brake turns it into a red line after RIPCORD_MS). `await gw.end()` in the finally.
//
// The fake docker (shell, state under `<tmp>/state`):
//   inspect <name>   running, port = echo backend; `gone-<name>` ⇒ "No such object"; marker `hangs-inspect` ⇒ waits at gate `inspect`;
//                    marker `inspect-fails` ⇒ the daemon does not answer (exit 1 without "No such")
//   exec …           marker `hangs-exec` ⇒ waits at gate `exec`
//   stop …           marker `hangs-stop` ⇒ the NEXT stop waits at gate `stop` (the marker is consumed — a second stop, e.g. a
//                    delete's, runs through)
//   rm -f <name>     sets `gone-<name>`; marker `rm-fails` ⇒ exit 1
//   volume rm|inspect  `vol-gone-<v>`; marker `volume-rm-fails` ⇒ rm fails
//   anything else    exit 0 without output (network, system df …)
// A container carries limits and a run state — per name `N` one file (all optional):
//   `id-N` the id (otherwise "id-N"; a 64-digit hex id makes it measurable for the meter), `stopped-N` (State.Running false, no
//   ports), `mem-N` `swap-N` `shares-N` `cpus-N` (HostConfig Memory, MemorySwap, CpuShares, NanoCpus = cpus × 1e9).
//   update <args> <Id>  writes the limits of the container with this id; marker `update-fails` ⇒ exit 1; marker `hangs-update`
//                       ⇒ the NEXT update waits at gate `update` (the marker is consumed like `hangs-stop`)
//   run … --name N …    creates N (undoes `gone-N` and `stopped-N`) and writes its limits
//   start N / stop … N  undoes resp. sets `stopped-N`
//   ps -q --no-trunc …  the content of `ps-ids` (the ids the meter sees); other `ps` without output
//   info --format …CgroupDriver…  "systemd 2" — the cgroup files then lie under GW_CGROUP_ROOT (test: `gw.cgroup(...)`)
// A gate: the fake writes `<gate>-waiting` and waits until `<gate>-gate` exists — with the fakes' ripcord
// (server/backend/test/ripcord.mjs), so a failure does not become a hang.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RIPCORD_MS } from "../../server/backend/test/ripcord.mjs";
import * as users from "./users.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const INDEX = path.join(HERE, "index.js");
const TICKS = Math.ceil(RIPCORD_MS / 50);

export const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startEchoBackend() {
  const seen = [];
  const waiters = [];
  const srv = http.createServer((req, res) => {
    const e = { m: req.method, url: req.url, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null };
    seen.push(e);
    for (const w of [...waiters]) if (w.check(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    req.resume();
    if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    if (req.url.startsWith("/api/events")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": hallo\n\n"); return; }
    if (req.url.startsWith("/api/services/events")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ events: [], seq: 0 })); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: { m: req.method, url: req.url } }));
  });
  // An upgrade (port tunnel, DevTools WebSocket) gets 101 and stays open until a side closes it — like a real tunnel (otherwise the
  // echo would answer 200 and close after the keep-alive, and "the gateway closes the tunnel" could not be told from "the backend
  // closed it").
  const upgrades = new Set();
  srv.on("upgrade", (req, plinth) => {
    upgrades.add(plinth);
    plinth.on("error", () => {});
    plinth.on("end", () => plinth.end()); // an http server's socket allows half-open — the other side left, so do we
    plinth.on("close", () => upgrades.delete(plinth));
    const e = { m: req.method, url: req.url, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, upgrade: true };
    seen.push(e);
    for (const w of [...waiters]) if (w.check(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    plinth.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  return {
    port, seen,
    // Waits for a request that satisfies `check` (also one already seen).
    waitForTruthy(check) {
      const already = seen.find(check);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ check, resolve }));
    },
    close: () => new Promise((r) => { for (const s of upgrades) s.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

function dockerScript(state) {
  return `#!/bin/sh
S="${state}"
echo "$@" >> "$S/calls.log"
gate_wait() {
  : > "$S/$1-waiting"
  i=0
  while [ ! -f "$S/$1-gate" ]; do
    i=$((i + 1))
    if [ "$i" -ge ${TICKS} ]; then echo "ripcord $1" >> "$S/calls.log"; exit 9; fi
    sleep 0.05
  done
}
value() { if [ -f "$S/$1" ]; then cat "$S/$1"; else echo "$2"; fi; }
name_to_id() {
  for f in "$S"/id-*; do
    [ -f "$f" ] && [ "$(cat "$f")" = "$1" ] && { echo "\${f##*/id-}"; return; }
  done
  case "$1" in id-*) echo "\${1#id-}" ;; *) echo "$1" ;; esac
}
limits() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --memory) echo "$2" > "$S/mem-$N"; shift ;;
      --memory-swap) echo "$2" > "$S/swap-$N"; shift ;;
      --cpu-shares) echo "$2" > "$S/shares-$N"; shift ;;
      --cpus) echo "$2" > "$S/cpus-$N"; shift ;;
    esac
    shift
  done
}
case "$1" in
  inspect)
    [ -f "$S/hangs-inspect" ] && gate_wait inspect
    if [ -f "$S/inspect-fails" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    if [ -f "$S/gone-$2" ]; then echo "Error: No such object: $2" >&2; exit 1; fi
    N="$2"
    if [ -f "$S/stopped-$N" ]; then
      ST='{"Running":false,"Status":"exited","StartedAt":"2026-10-15T08:00:00Z","FinishedAt":"2026-10-15T09:00:00Z"}'; PORTS='{}'
    else
      ST='{"Running":true,"Status":"running","StartedAt":"2026-10-15T08:00:00Z","FinishedAt":"0001-01-01T00:00:00Z"}'
      PORTS='{"7718/tcp":[{"HostPort":"'"$(cat "$S/port")"'"}]}'
    fi
    NANO=$(awk -v c="$(value "cpus-$N" 0)" 'BEGIN { printf "%.0f", c * 1000000000 }')
    echo '[{"Id":"'"$(value "id-$N" "id-$N")"'","State":'"$ST"',"HostConfig":{"Memory":'"$(value "mem-$N" 0)"',"MemorySwap":'"$(value "swap-$N" 0)"',"NanoCpus":'"$NANO"',"CpuShares":'"$(value "shares-$N" 0)"'},"NetworkSettings":{"Ports":'"$PORTS"'}}]'
    ;;
  update)
    if [ -f "$S/hangs-update" ]; then rm -f "$S/hangs-update"; gate_wait update; fi
    [ -f "$S/update-fails" ] && { echo "Error response from daemon: Cannot update container" >&2; exit 1; }
    for a in "$@"; do LAST="$a"; done
    N=$(name_to_id "$LAST")
    [ -f "$S/gone-$N" ] && { echo "Error response from daemon: No such container: $LAST" >&2; exit 1; }
    shift; limits "$@"; echo "$LAST" ;;
  run)
    N=""; prior=""
    for a in "$@"; do [ "$prior" = "--name" ] && N="$a"; prior="$a"; done
    rm -f "$S/gone-$N" "$S/stopped-$N" "$S/mem-$N" "$S/swap-$N" "$S/shares-$N" "$S/cpus-$N"
    shift; limits "$@"; echo new-id ;;
  start) rm -f "$S/stopped-$2" ;;
  stop)
    if [ -f "$S/hangs-stop" ]; then rm -f "$S/hangs-stop"; gate_wait stop; fi
    for a in "$@"; do LAST="$a"; done; : > "$S/stopped-$LAST" ;;
  ps) case "$*" in *--no-trunc*) [ -f "$S/ps-ids" ] && cat "$S/ps-ids" ;; esac ;;
  info) case "$*" in *CgroupDriver*) echo "systemd 2" ;; esac ;;
  exec) [ -f "$S/hangs-exec" ] && gate_wait exec ;;
  rm) [ -f "$S/rm-fails" ] && exit 1; : > "$S/gone-$3" ;;
  volume)
    case "$2" in
      rm) if [ -f "$S/volume-rm-fails" ]; then echo "Error response from daemon: volume is in use" >&2; exit 1; fi; : > "$S/vol-gone-$3" ;;
      inspect) if [ -f "$S/vol-gone-$3" ]; then echo "Error response from daemon: get $3: no such volume" >&2; exit 1; fi ;;
    esac ;;
  *) : ;;
esac
`;
}

export async function prepareSetup({ env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-index-"));
  const data = path.join(tmp, "data");
  const web = path.join(tmp, "web");
  const bin = path.join(tmp, "bin");
  const state = path.join(tmp, "state");
  for (const d of [data, web, bin, state]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<html>gateway-test</html>");
  fs.writeFileSync(path.join(web, "404.html"), "<html>404</html>");
  fs.writeFileSync(path.join(bin, "docker"), dockerScript(state), { mode: 0o755 });
  const echo = await startEchoBackend();
  fs.writeFileSync(path.join(state, "port"), String(echo.port));
  users.initUsers(data);

  let subprocess = null;
  let log = "";
  let ended = null;
  let closed = null;
  // A start that is still looking for the port (start() without await, e.g. to hold the gateway at a gate mid-start): until the
  // spawn there is no `kind`, and `alive()` would be wrong. The waiters count such a start as alive, and end() awaits it before
  // killing — otherwise the gateway would come into being AFTER the cleanup and run on as an orphan (the test process hung on its
  // pipes).
  let beforeTheSpawn = null;
  const aliveOrStarts = () => gw.alive() || beforeTheSpawn !== null;
  const gw = {
    tmp, data, state, echo, users,
    port: 0, base: "",
    log: () => log,
    alive: () => !!subprocess && subprocess.exitCode === null && subprocess.signalCode === null,
    ended: () => ended,
    marker: (name) => fs.writeFileSync(path.join(state, name), ""),
    openGate: (name) => fs.writeFileSync(path.join(state, `${name}-gate`), ""),
    calls: () => { try { return fs.readFileSync(path.join(state, "calls.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } },
    // A container of the fake docker (see head): `{ id, stopped, mem, swap, shares, cpus, gone }` — missing fields stay as they are.
    container(name, { id, stopped, mem, swap, shares, cpus, gone } = {}) {
      const set = (file, w) => {
        const f = path.join(state, `${file}-${name}`);
        if (w === undefined) return;
        if (w === null || w === false) fs.rmSync(f, { force: true });
        else fs.writeFileSync(f, w === true ? "" : String(w));
      };
      set("id", id); set("stopped", stopped); set("mem", mem); set("swap", swap); set("shares", shares); set("cpus", cpus); set("gone", gone);
    },
    // The cgroup files of a container under GW_CGROUP_ROOT (systemd driver, cgroup v2; `start()` sets the root to `<tmp>/cgroup`) and
    // the ids `ps -q --no-trunc` reports. Only a container with a 64-digit hex id is measurable (`gw.container(name, { id })`).
    cgroup(id, files) {
      const dir = path.join(tmp, "cgroup", "sys/fs/cgroup/system.slice", `docker-${id}.scope`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), `${content}\n`);
    },
    psIds: (ids) => fs.writeFileSync(path.join(state, "ps-ids"), ids.map((i) => `${i}\n`).join("")),
    // Waits for a line in the gateway's log — or its end (then false). An event, no deadline.
    async waitForLog(pattern) {
      while (!pattern.test(log)) {
        if (!aliveOrStarts()) return false;
        await sleep(20);
      }
      return true;
    },
    async start() {
      let spawned;
      beforeTheSpawn = new Promise((r) => { spawned = r; });
      try {
        gw.port = await freePort();
        gw.base = `http://127.0.0.1:${gw.port}`;
        subprocess = spawn(process.execPath, [INDEX], {
          env: {
            ...process.env, GW_PORT: String(gw.port), GW_HOST: "127.0.0.1", GW_DATA: data, GW_WEB_DIR: web,
            PATH: `${bin}:${process.env.PATH}`, GW_HEALTH_GRACE_MS: "500",
            // The template of new users comes from the unit env — one inherited from the developer's shell must not colour a test.
            GW_CONTAINER_MEM: "", GW_CONTAINER_CPUS: "", GW_CONTAINER_CPU_SHARES: "",
            GW_CGROUP_ROOT: path.join(tmp, "cgroup"), ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } finally { beforeTheSpawn = null; spawned(); }
      ended = new Promise((r) => subprocess.on("exit", (code, signal) => r({ code, signal })));
      closed = new Promise((r) => subprocess.on("close", (code, signal) => r({ code, signal })));
      await new Promise((resolve, reject) => {
        // The gateway is ready when it listens AND the resources initial fill is done: it asks `docker inspect` per user, and a test
        // that sets a marker afterwards (hangs-inspect) should see ITS path at the gate, not that one. The initial-fill line comes on
        // stdout, its failure on stderr — check both streams. Should the line ever disappear (a rebuild of index.js), EVERY gateway
        // test file would hang here silently; the fakes' emergency brake (ONE number, server/backend/test/ripcord.mjs — no deadline,
        // it only acts in the hang case) turns that into a red line with a reason.
        const emergencyBrake = setTimeout(() => reject(new Error(
          `Gateway without a "[gateway] Resources…" line after ${RIPCORD_MS} ms (emergency brake) — does index.js still write it?\n${log}`)), RIPCORD_MS);
        emergencyBrake.unref();
        const on = (d) => {
          log += d;
          if (/cbase gateway v\S+ on /.test(log) && /\[gateway\] Resources(: | initial fill:)/.test(log)) { clearTimeout(emergencyBrake); resolve(); }
        };
        subprocess.stdout.on("data", on);
        subprocess.stderr.on("data", on);
        ended.then((e) => { clearTimeout(emergencyBrake); reject(new Error(`Gateway ended before starting (${JSON.stringify(e)}):\n${log}`)); });
      });
    },
    // Waits until `check()` is true (e.g. a row in gateway.db, read in the test process) — or the gateway ends (then false).
    async waitUntil(check) {
      while (!check()) {
        if (!aliveOrStarts()) return false;
        await sleep(20);
      }
      return true;
    },
    // Waits until the fake stands at the gate — or the gateway ends (then false).
    async waitAtGate(name) {
      const p = path.join(state, `${name}-waiting`);
      while (!fs.existsSync(p)) {
        if (!aliveOrStarts()) return false;
        await sleep(20);
      }
      return true;
    },
    // Raw bytes to the gateway; returns everything it sends until it closes.
    raw(text) {
      return new Promise((resolve) => {
        let out = "";
        const s = net.connect(gw.port, "127.0.0.1", () => s.write(text));
        s.on("data", (d) => { out += d; });
        s.on("error", () => resolve(out));
        s.on("close", () => resolve(out));
      });
    },
    // A raw connection that stays open: `write(text)`, `waitForTruthy(pattern)` (the collected response as soon as it matches — or
    // null if the connection closes first), `whenClosed` (promise: closed — end, error or reset; also resolves when the gateway ends),
    // `text()`, `isClosed()`, `end()`. Each belongs in a finally (`end`).
    connect() {
      return new Promise((resolve, reject) => {
        const s = net.connect(gw.port, "127.0.0.1");
        let out = "";
        let closed = false;
        const waiters = [];
        let toReport;
        const whenClosed = new Promise((r) => { toReport = r; });
        const finished = () => {
          if (closed) return;
          closed = true;
          for (const w of waiters.splice(0)) w.r(null);
          toReport();
        };
        s.on("data", (d) => {
          out += d;
          for (const w of [...waiters]) if (w.m.test(out)) { waiters.splice(waiters.indexOf(w), 1); w.r(out); }
        });
        s.on("end", finished);
        s.on("close", finished);
        s.on("error", finished);
        s.once("connect", () => resolve({
          write: (text) => s.write(text),
          waitForTruthy: (m) => (m.test(out) ? Promise.resolve(out) : closed ? Promise.resolve(null) : new Promise((r) => waiters.push({ m, r }))),
          whenClosed,
          text: () => out,
          isClosed: () => closed,
          end: () => { try { s.destroy(); } catch { /* already closed */ } },
        }));
        s.once("error", reject);
      });
    },
    // A request whose body comes only on cue: the head carries `Expect: 100-continue`, and Node writes "100 Continue" in the same
    // step in which it calls the handler — the line is read only once the part of the handler BEFORE its first await (the admin
    // check at the start of the branch) has run and it waits for the body. `rest()` sends the body and returns `{ status, json,
    // text }` of the final response.
    async halfRequest(method, filePath, sess, bodyText) {
      const v = await gw.connect();
      const body = JSON.stringify(bodyText);
      v.write(`${method} ${filePath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nCookie: cbase_gw=${sess}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\n\r\n`);
      const further = await v.waitForTruthy(/HTTP\/1\.1 100 Continue\r\n\r\n/);
      if (further === null) { v.end(); throw new Error(`no "100 Continue" for ${method} ${filePath}: ${v.text().slice(0, 200)}`); }
      return {
        async rest() {
          v.write(body);
          await v.whenClosed;
          const t = v.text().replace(/^HTTP\/1\.1 100 Continue\r\n\r\n/, "");
          const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(t)?.[1] || 0);
          const raw = t.slice(t.indexOf("\r\n\r\n") + 4);
          let json = null;
          try { json = JSON.parse(raw); } catch { /* not JSON */ }
          return { status, json, text: t };
        },
        end: v.end,
      };
    },
    // Ends the gateway and waits until its stdio is CLOSED — only then is everything it ever wrote in `log()`. `start()` waits for a
    // line on STDOUT, and a line the gateway wrote to STDERR just before it can still be undelivered at that moment: under load the
    // gate saw startup-warnings (3) read the log without the warning block that was long since printed. A test that reads the whole
    // log — above all one that asserts a line is ABSENT — takes this instead of reading right after `start()`.
    async drain() {
      if (beforeTheSpawn) await beforeTheSpawn;
      if (!closed) return;
      try { if (gw.alive()) subprocess.kill("SIGKILL"); } catch { /* already gone */ }
      await closed;
    },
    async end() {
      if (beforeTheSpawn) await beforeTheSpawn; // a start that is still looking for the port would otherwise spawn AFTER the cleanup (see `beforeTheSpawn`)
      try { if (gw.alive()) { subprocess.kill("SIGKILL"); await ended; } } catch { /* already gone */ }
      await echo.close();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  return gw;
}
