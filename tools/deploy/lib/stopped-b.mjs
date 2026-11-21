// Stopped user containers (B) — step 0 of `./deploy server` and the "stopped" rows of `./deploy status`.
//
// The gateway puts an idle B to sleep (`docker stop`). `remoteContainers()` sees only running ones, so a stopped B would keep its old
// image through a server deploy, and the gateway would later wake it with old code. Step 0 therefore starts every STOPPED B BEFORE the
// idle gate (targets/server.mjs `rollOutAfterBackendBuild`, before preparing the project box), after which it is swapped like every other.
//
// The commands and the reading of `docker ps -a` are pure (checkName, situationCommand, containerSituation, startCommand); only
// `startStoppedB()` runs them over ssh. Guard: tools/deploy/stopped-b.test.mjs.

import { config } from "../config.mjs";
import { isDryRun } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "./ssh.mjs";
import { waitHealthy } from "./remote.mjs";
import * as log from "../../check/lib/log.mjs";

// A user container name goes raw into shell text — only what has the form (prefix plus letters, digits, `_.-`).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function checkName(name) {
  if (!NAME_RE.test(String(name || ""))) throw new Error(`not a valid container name: ${JSON.stringify(name)}`);
  return name;
}

/** All user containers with state (stopped too) — `docker ps -a`, read-only. */
export const situationCommand = (prefix) => `docker ps -a --filter name=${prefix} --format '{{.Names}} {{.State}}'`;

/**
 * Pure: `{ running, stopped, other }` from situationCommand. Stopped means `exited` or `created` — only those the deploy starts; `other`
 * (restarting, paused, dead, …) it does not touch, it names them as a warning.
 */
export function containerSituation(stdout, prefix) {
  const running = [];
  const stopped = [];
  const other = [];
  for (const z of String(stdout || "").split("\n")) {
    const [name, state] = z.trim().split(/\s+/);
    if (!name || !name.startsWith(prefix) || !NAME_RE.test(name)) continue;
    if (state === "running") running.push(name);
    else if (state === "exited" || state === "created") stopped.push(name);
    else other.push({ name, state: state || "?" });
  }
  return { running, stopped, other };
}

/** Start a stopped B (row in DOCKER_ALLOWED of the maintainer's private suite). */
export const startCommand = (name) => `docker start ${checkName(name)} >/dev/null`;

// `docker start` runs with `check: false` — sshAct would otherwise throw on exit ≠ 0, and ONE B that does not start (port
// taken, sysbox error) would hold up the server deploy of all users. The reason: the last line.
const startError = (r) => String(r?.stderr || r?.stdout || "").trim().split("\n").at(-1)?.trim().slice(0, 160) || `Exit ${r?.code}`;
async function start(n) {
  const r = await sshAct(startCommand(n), { check: false });
  return isDryRun() || r.code === 0 ? null : startError(r);
}

/**
 * Step 0: start stopped B so they are swapped like every other. From targets/server.mjs BEFORE the idle gate
 * (before preparing the project box). Returns the started names. Does not throw on a B that does not start: it stays stopped,
 * keeps its image and is NOT swapped (`remoteContainers()` sees only running ones) — named as a warning.
 */
export async function startStoppedB() {
  const prefix = config.remote.containerPrefix;
  const situation = containerSituation((await sshProbe(situationCommand(prefix))).stdout, prefix);
  for (const a of situation.other) log.warn(`${a.name}: state ${a.state} — neither running nor stopped, not started.`);
  if (!situation.stopped.length) return [];
  log.step(`Start stopped user containers (${situation.stopped.length}) — they are swapped like every other`);
  const started = [];
  for (const n of situation.stopped) {
    const error = await start(n);
    if (error) {
      log.warn(`${n}: the start failed (${error}) — stays stopped and is NOT swapped (keeps the old image); the others carry on.`);
      continue;
    }
    started.push(n);
    if (isDryRun()) { log.detail(`(dry run: ${n} would be started and then swapped like every other)`); continue; }
    if (await waitHealthy(n)) log.ok(`${n}: started, backend answers`);
    else log.warn(`${n}: started, backend does not (yet) answer — the idle gate decides.`);
  }
  return started;
}
