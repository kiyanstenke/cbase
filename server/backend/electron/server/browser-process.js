// The processes of the own browsers (browsers.js launchUserBrowser: chat, workspace and project browser in B) and their end.
// A leaf: node:* only. The start itself stays in browsers.js (the one start function inProject); this file says HOW it starts
// and HOW it ends.
//
// What went wrong before (measured 2026-11-21, Chrome 157 on macOS and Debian chromium in the backend image): the Chromium of an
// own browser was a plain child of B, in B's process group. `proc.kill()` reached only its main process, and nothing ended it at
// `server.close` or at SIGTERM/SIGINT without headless.js — only `process.on("exit")`, which a signal or SIGKILL never reaches.
// After SIGKILL of the parent the browser kept running (macOS: 7 → 10 processes three seconds later; Linux: 7 → 9). In the user
// container that does not leak past B: B (node, PID 73) is the only child of docker-init (PID 1, `--init` of the gateway), and when
// B dies, docker-init exits, the container ends and the kernel kills its whole PID namespace (measured with the same image
// layout: `docker run --init`, SIGKILL to node ⇒ container `exited 137`, no process left). On the local server and in the test
// bench nothing did that: orphaned Chromes with temp profiles stayed until reboot.
//
// The three ways, each measured:
//   1. ITS OWN PROCESS GROUP (`detached: true`, B only): the Chromium is the leader of a group that holds its helpers (zygotes,
//      renderer, GPU, network service; on Linux also both crashpad handlers end with it). `endGroup` sends TERM to the GROUP and,
//      if it still lives after `graceMs`, KILL — on macOS and Linux a group TERM leaves no process (measured).
//   2. DIES WITH ITS PARENT (Linux, B only): started as `setpriv --pdeathsig KILL -- <chromium> …` — setpriv sets
//      PR_SET_PDEATHSIG and replaces itself (exec) with the browser, the pid stays. SIGKILL of node ⇒ 0 processes three seconds
//      later (measured through Debian's /usr/bin/chromium launcher script, which execs the real binary). Only if setpriv knows
//      `--pdeathsig` (util-linux ≥ 2.33; the image carries 2.38.1). macOS has no such thing — there way 3 catches it.
//   3. THE MARKER AND THE SWEEP: every browser carries `--cbase-browser-owner=<pid of B>` in its argv (Chromium ignores unknown
//      switches). `sweepOrphanedBrowsers` (at every server start, server.js) ends every process with the marker whose owner is
//      dead — never by name, never a process without the marker, never one of a living owner (another server, another test
//      process). An owner pid reused by a foreign process leaves the leftover alone (the safe side).
// In a project container (instance) none of this applies: there the docker child's `kill` ends the wrapper's group in the
// container (runtime/inProject.js), and the marker only rides along.
//
// THE NETS: every started group stays in `liveGroups` until it is provably empty. `process.on("exit")` sends KILL to every one
// still there (synchronous — the gentle end belongs to `server.close`/"serverEnd", browsers.js). At SIGTERM/SIGINT the same,
// but ONLY if no one else listens for the signal (headless.js does: its endServer runs "serverEnd", which closes the browsers
// gently): then the signal is raised again with the default action — the process ends as it would have without this file.
//
// Guard: server/backend/test/browser-orphans.test.js.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export const OWNER_SWITCH = "--cbase-browser-owner";
export const ownerMarker = (pid = process.pid) => `${OWNER_SWITCH}=${pid}`;
const OWNER_RE = new RegExp(`(?:^|\\s)${OWNER_SWITCH}=(\\d+)(?=\\s|$)`);

// setpriv with --pdeathsig, once per process. `CBASE_BROWSER_PDEATHSIG=0` switches it off (test of way 3 on Linux).
let pdeathsig;
function setprivWithPdeathsig() {
  if (process.platform !== "linux" || process.env.CBASE_BROWSER_PDEATHSIG === "0") return null;
  if (pdeathsig !== undefined) return pdeathsig;
  pdeathsig = null;
  for (const bin of ["/usr/bin/setpriv", "/bin/setpriv"]) {
    if (!fs.existsSync(bin)) continue;
    try { if (/--pdeathsig/.test(execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 5_000 }))) pdeathsig = bin; } catch { /* old setpriv */ }
    break;
  }
  return pdeathsig;
}

/**
 * The call of an own browser: `{ cmd, args, opts }` for inProject. Without an instance its own group and (Linux) the death signal;
 * with one the call as before. The marker in both.
 */
export function browserCall(bin, args, opts, { instance = null } = {}) {
  const marked = [...args.slice(0, -1), ownerMarker(), ...args.slice(-1)]; // the start URL stays last
  if (instance) return { cmd: bin, args: marked, opts };
  const sp = setprivWithPdeathsig();
  return {
    cmd: sp || bin,
    args: sp ? ["--pdeathsig", "KILL", "--", bin, ...marked] : marked,
    opts: { ...opts, detached: true },
  };
}

const liveGroups = new Map(); // pgid -> proc (own group in B, not yet provably empty)
export const liveBrowserGroups = () => [...liveGroups.keys()];

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function signalGroup(proc, sig) {
  if (proc.cbaseGroup) {
    try { process.kill(-proc.cbaseGroup, sig); return; } catch { /* group gone */ }
    return;
  }
  try { proc.kill(sig); } catch { /* already gone */ }
}

/** Remember a just started browser (browserCall without an instance ⇒ own group). */
export function trackBrowser(proc, { instance = null } = {}) {
  if (instance || !proc?.pid) return proc;
  proc.cbaseGroup = proc.pid;
  liveGroups.set(proc.pid, proc);
  installNets();
  return proc;
}

/**
 * End the browser `proc`: TERM to its group (instance: to the docker child, whose kill reaches the group in the container), KILL
 * after `graceMs` if the group still lives. → promise, fulfilled when the group is gone (B) or the child has ended (instance).
 */
export function endGroup(proc, { graceMs = 2_000 } = {}) {
  if (!proc) return Promise.resolve();
  if (proc.cbaseEnd) return proc.cbaseEnd;
  signalGroup(proc, "SIGTERM");
  proc.cbaseEnd = proc.cbaseGroup ? groupGone(proc, graceMs) : childGone(proc, graceMs);
  return proc.cbaseEnd;
}
function childGone(proc, graceMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    const hard = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, graceMs);
    hard.unref?.();
    proc.once("exit", () => { clearTimeout(hard); resolve(); });
  });
}
// The group outlives its leader by a moment (helpers end after the browser process) — asked until empty, KILL after the grace.
function groupGone(proc, graceMs) {
  const pgid = proc.cbaseGroup;
  const start = Date.now();
  return new Promise((resolve) => {
    let killed = false;
    const look = () => {
      if (!groupAlive(pgid)) { liveGroups.delete(pgid); return resolve(); }
      if (!killed && Date.now() - start >= graceMs) { killed = true; try { process.kill(-pgid, "SIGKILL"); } catch {} }
      const t = setTimeout(look, 50);
      t.unref?.();
    };
    look();
  });
}

/** Every own group still alive: KILL at once (synchronous). → how many. For the exit net and tests. */
export function killAllBrowserGroups() {
  let n = 0;
  for (const pgid of liveGroups.keys()) { try { process.kill(-pgid, "SIGKILL"); n++; } catch { /* gone */ } }
  liveGroups.clear();
  return n;
}

let nets = false;
function installNets() {
  if (nets) return;
  nets = true;
  process.on("exit", killAllBrowserGroups);
  for (const sig of ["SIGTERM", "SIGINT"]) {
    const net = () => {
      if (process.listenerCount(sig) > 1) return; // someone else ends the process (headless.js → endServer → "serverEnd")
      killAllBrowserGroups();
      process.removeListener(sig, net);
      process.kill(process.pid, sig); // the default action, as without this listener
    };
    process.on(sig, net);
  }
}

// ── The sweep ────────────────────────────────────────────────────────────────
// Every process whose argv carries the marker: `{ pid, pgid, owner, args }`. Linux from /proc (no `ps` needed), otherwise `ps`.
export async function markedProcesses() {
  const rows = [];
  if (process.platform === "linux") {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const args = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ").trim();
        const m = args.match(OWNER_RE);
        if (!m) continue;
        // stat: "pid (comm) state ppid pgrp …" — comm may contain spaces and brackets, so after the LAST ")".
        const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (rest[0] === "Z") continue; // a zombie is no process any more
        rows.push({ pid: Number(d), pgid: Number(rest[2]), owner: Number(m[1]), args });
      } catch { /* gone in the meantime */ }
    }
    return rows;
  }
  const out = await new Promise((resolve) => execFile("ps", ["-A", "-ww", "-o", "pid=,pgid=,stat=,args="], { maxBuffer: 64 << 20, timeout: 10_000 }, (err, stdout) => resolve(err ? "" : stdout)));
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || m[3].startsWith("Z")) continue;
    const o = m[4].match(OWNER_RE);
    if (o) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), owner: Number(o[1]), args: m[4] });
  }
  return rows;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * End every marked process whose owner is dead: its group if it leads one (the Chromium of way 1), otherwise the process alone.
 * Never throws. → `{ ended: [{ pid, pgid, owner }] }`.
 */
export async function sweepOrphanedBrowsers({ list = markedProcesses } = {}) {
  const ended = [];
  let rows = [];
  try { rows = await list(); } catch (e) { console.warn(`[browser] sweep: process list failed: ${e?.message || e}`); return { ended }; }
  for (const r of rows) {
    if (r.owner === process.pid || pidAlive(r.owner)) continue;
    try { process.kill(r.pgid === r.pid ? -r.pid : r.pid, "SIGKILL"); ended.push({ pid: r.pid, pgid: r.pgid, owner: r.owner }); } catch { /* gone */ }
  }
  if (ended.length) console.warn(`[browser] sweep: ${ended.length} orphaned browser process(es) of an ended backend killed: ${ended.map((e) => e.pid).join(", ")}`);
  return { ended };
}
