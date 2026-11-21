// The fake docker of the project containers. Not a test (hence .mjs): harness AND program in one file. Imported it delivers the
// helpers; started as a program (through the wrapper script `bin`) it is the docker CLI.
//
// WHAT IT DELIVERS
//   fakeDocker(opts)            creates a temp folder (state, log, gates) and an executable `bin` to be set as CBASE_DOCKER_BIN
//                               (`env` carries exactly that). Returns:
//     bin, dir, env             path of the fake docker, its folder, `{ CBASE_DOCKER_BIN: bin }`
//     calls({ daemon })         the call log `calls.jsonl`: per call `{ daemon, args }`, written BEFORE the call does anything; an
//                               empty log means "no docker started". `daemon` is "host" (the daemon of the user container) or the
//                               name of the project container in which a `docker exec … docker …` ran (its own daemon); no filter: all.
//     state(daemon)             the state of a daemon (containers, networks, volumes, images) as an object
//     gateReached(name)         waits (without a deadline) until a `stop` stands at gate `name`
//     openGate(name)            opens it, instead of waiting out a duration
//     closeGate(name)           closes it again
//     errorAt(list)             injected failures (block "injected failures" below); replaces the list, `[]` withdraws it
//     volumeData(name, daemon)  the local folder that plays the `_data` of a volume
//     setDiff(w, rows, daemon)  the write layer of a container: what `docker diff` reports after the mount points
//     setLabel(w, k, v, daemon) a label of a container, e.g. one that an older version created (v null: removed)
//     setExit(w, code, daemon)  a stopped container ended by itself with `code` (not by hand)
//     streams() / endStreams()  the living `docker events` streams ({ pid, since, filter }), or end them hard
//     crash(w, { code, oom, silent, restart })  a container of the host daemon ends past cbase (block "event stream")
//     event(w, action, extra) / streamEvents()  write an event into the stream, or read all written ones
//     cleanUp()                 ends EVERY process group that an `exec` started (also orphans of killed callers) and deletes the
//                               folder. Belongs in `finally`.
//   opts
//     occupiedNetworks [CIDR]   address ranges that are already taken (foreign networks of the host): a `network create --subnet`
//                               inside fails like the real docker with "Pool overlaps with other one on this address space". An
//                               overlap with a network of THIS daemon does so anyway.
//     stopGate        name      `stop` waits until gate `name` is open (gateReached/openGate)
//     pauseGate       name      `pause` against the host daemon waits at the gate BEFORE it freezes
//     eventBuffer     n         size of the event buffer per daemon (default 256 as moby)
//     execGate        name      `exec` against the host daemon waits until gate `name` is open (a hanging inner dockerd); the mark
//                               `<name>.waiting` says that one is waiting
//     rmGate          name      `rm` against the host daemon waits until the gate is open (a cleanup of helper orphans still running)
//     inspectGate     name      like execGate, but ONLY an `exec <c> docker inspect …` against the host daemon waits (the inner
//                               dockerd answers `ps` but hangs on the second call of the snapshot)
//     images          {ref: id | { id, labels }}  images the host daemon already has (`image inspect/save`); with `labels` the image
//                               carries them in `inspect` under `Config.Labels` (else null); `save`/`load`/`tag` carry them along. A
//                               container INHERITS them at creation (`run`, `compose up`/`run`); its own labels win
//     instanceIp      ip        IPAddress of every container without `--ip`; in the test the second loopback address (secondLoopback)
//     programs        {path: local}  the DOCKING POINT OF THE WRAPPER (see below); `{path: null}` withdraws a default
//     infoFailures {pattern: n} `info` fails in every daemon whose name matches the RegExp `pattern`, on the first n calls, with
//                               "Cannot connect to the Docker daemon" (a dockerd that is still starting). Counted per daemon, no clock.
//     brokenImages  [id]        a `run -d` from an image with this id creates the container, which ends at once (exit 1)
//     execBroken     [name]     every `exec` into these containers fails as after a sysbox restart
//     runStartBroken [pattern]  a `run -d` with a name matching the RegExp CREATES the container (state `created`), then fails at the
//                               start with 125 like the real docker ("Address already in use"), with no id on stdout; the container stays
//     startAbort   {pattern: n} a `start` with SEVERAL containers in a daemon whose name matches starts only the FIRST on the first n
//                               calls and ends with exit 1, like a docker client aborted by its deadline: the rest stays `created`
//     infoDriver   {pattern: t} `info` reports the storage driver t (e.g. "vfs") instead of overlay2 in every matching daemon
//     stopsInside    bool       a `stop` of a container at the host daemon also stops every running container of ITS daemon (exit 143):
//                               the inner dockerd ends with the project container. Off by default
//     compose        {project: {service: …}}  the model for `compose config --hash`/`up --no-start`, see block "compose"
//     imageContent   {ref: {path: {rel: content}}}  the content of an image at a path: `compose up` fills an EMPTY volume at this path
//                               from it at creation (copy-up, see block "volume content")
//     dryrunSilent   bool       the dry run `--progress json --dry-run up …` writes NOTHING (a Compose version whose verdict the caller
//                               does not see: other stream, other format)
//     runReference   { source, target }  swap of a bind source at `run`; plus `exec <c> stat -c %d:%i` (fake-docker-stat.mjs)
//     composeBroken  [project]  `compose … config --format json` of this project writes the model with values to stdout, then ends
//                               with 1 and a message that carries the values
//     checkUsed      bool       `network rm` / `volume rm` refuse while a container uses them (fake-docker-stat.mjs)
//     upBroken       [project]  `compose … up -d --build` of this project ends with 1 "failed to solve" (a build that fails)
//   secondLoopback()            a second loopback address as instance IP: 127.0.0.2 where bindable, else ::1 (macOS has no 127.0.0.2).
//                               Build addresses from it only through hostPort.
//   hostPort(host, port)        the product helper (projectbox/address.js), passed through here
//
// WHAT THE PROGRAM EMULATES (only what the tests need; anything unknown ends with 125 like the real docker on an unknown flag, so a
// typo in the product becomes a red test instead of a silent success)
//   network create|rm|inspect   `--subnet` with a real overlap check (IPv4), `--label`, `--internal`, `-o`/`--opt` (in `Options`);
//                               `Containers` = the running endpoints; `connect`/`disconnect` NOT (125)
//   network ls                  `-q`, `--no-trunc`, `--format`, `--filter label=…`
//   volume create|rm|inspect    `create` is idempotent as for real; `--driver`/`-d` and `--opt`/`-o k=v` show in `inspect` (`Driver`,
//                               default local; `Options`, null without `--opt`; `Scope` local)
//   run                         `-d` (without: only WITHOUT a command, the container ends at once with 0; with a command 125, running it
//                               is not emulated), `--name`, `--label`, `--network` (also `none`: no network, no address, the helper),
//                               `--ip`, `--mount` (a bind source that does not exist is an error: the reason for `--mount` instead of
//                               `-v`), `-e`, `--restart`, `--rm`, … REFUSED (125) are `-p`, `-P`, `--publish`, `-v`/`--volume` and
//                               `--network host`
//   start | stop | rm           names, ids and id prefixes; `stop` ends the exec processes of the container (on request first at an open
//                               gate), `rm` of a running one only with `-f`
//   pause | unpause             as moby: `pause` only of a running, not yet paused container, `unpause` only of a paused one (else 1 "is
//                               not paused"); stdout the names as for real. Paused means: `inspect` reports `State.Status` "paused",
//                               `State.Paused` true, `Running` true; `ps` shows it (status "Up (Paused)", filter `status=paused`, not
//                               `status=running`); `exec` (also `-d`) refuses with "Container <id> is paused, unpause the container before
//                               exec" (1), `start` with "cannot start a paused container, try unpause instead" (1); `stop` of a paused one
//                               ends HARD (137, as after the deadline: TERM does not reach a frozen process), `rm -f` removes it. The
//                               processes of an exec keep running in the fake (not frozen).
//   inspect                     containers, networks, volumes, images; `--format`/`-f` with `{{.A.B}}` and `{{json .}}`
//   ps                          `-a`, `-q` (with `--no-trunc` full ids), `--filter label=…|name=…|id=…|status=…`, `--format json` or a
//                               template (for `ps` and `images` as for real with `\t`/`\n` in the format as tab/line end)
//   image inspect|save|load     `save -o` or stdout, `load -i` or stdin; `save`/`load` also without `image` before them
//   tag | images | rmi          `tag <source> <target>` (source as name or id); `images [repo]` with `--format` ({{.Repository}} {{.Tag}}
//                               {{.ID}}), `--no-trunc`, `-q`; `rmi` by name removes only the name (the image with the last one), by id
//                               the image; several names only with `-f`; an image that a container uses: always a conflict
//   info | logs                 `info [--format]` (see infoFailures), `logs [--tail n]` (empty, or the last line of a broken image).
//                               Containers carry `.Image` (id) and `HostConfig.Init` as for real
//   stats                       `--no-stream [--format V] [name …]`, fixed numbers; `State.StartedAt` per start
//   exec                        runs the command LOCALLY as leader of its OWN process group (like a process in the container, not in the
//                               caller's group); `-u` is logged, `-e NAME` takes the value from the docker child's environment, `-e NAME=W`
//                               sets it, `-w` must exist locally (else 126 like the real runc). Output goes through files of the state
//                               folder and is passed on: AS WITH THE REAL DOCKER a killed exec caller does not end its process, and the
//                               orphan keeps no pipe of the caller open (otherwise every `close` in the product would wait for it). `docker`
//                               as a command is the daemon OF the container: the same fake with its own state, logged with `daemon:
//                               <container>`. `lsof -i …:PORT` sees only the container IP (fake-docker-stat.mjs).
//   exec -d                     starts detached, output discarded, exit 0 at once
//   events                      only `--since S --until U` (Unix seconds, also with a fraction as for real) and `--format '{{json .}}'`: the
//                               events `container start` and `volume mount` (per mounted volume, Actor.ID = name) that `run -d` and `start`
//                               record in this daemon. As moby: the buffer holds the NEWEST `eventBuffer` events of all kinds (default
//                               256), `--until` excludes everything LATER (TimeNano > until, also within the second), `timeNano` exact; a
//                               `start` of a container of the host daemon restarts its inner dockerd, whose buffer is then empty
//   events (stream)             WITHOUT `--until`: the stream of the life-cycle events of the host daemon (create, start, kill, die, stop,
//                               destroy, pause, unpause, oom), `--since` optional, filters type/label/event (block "event stream" below)
//   copy view                   a container with /cbase-copy and overlays.tsv sees its overlays as local folders, until `.prepared` in
//                               `phase=prepare` without an inner daemon, then the transition like a fresh dockerd (fake-docker-copy-view.mjs;
//                               `copyView(dir, name)` for tests); its restart starts `always`, `unless-stopped` unless stopped by hand
//                               (`stop` of a running one remembers it, `start` withdraws it) and `on-failure[:n]` with exit != 0; `inspect`
//                               reports the RestartPolicy as `{ Name, MaximumRetryCount }`
//   health/end                  `run --health-cmd …` and the label `cbase.test.ends=<code>`: `inspect` reports `State.Health.Status` or the
//                               end of a one-shot container through the gates `healthy-<name>`, `unhealthy-<name>`, `finished-<name>`
//                               (block "health and end" below)
//   (inner daemon)              `inspect` carries `Config.Healthcheck` ({ Test, Retries }) for a container with `--health-cmd`
//                               (`--health-retries`, else 0); in the INNER daemon `run` accepts `-p [ip:]host:target[/proto]` and
//                               `--network-alias` (NetworkSettings.Ports or …Networks.<n>.Aliases). The compose model knows
//                               `build: { context, dockerfile }`, `aliases: [..]` and `environment: { K: V }`
//
// DOCKING POINT OF THE WRAPPER. The product calls the wrapper as a command in the container (`docker exec [-d] …
// /usr/sbin/cbase-wrapper --pgid-file … -- cmd`). `programs` maps paths in the image to local files; by default WRAPPER_IN_IMAGE → the
// repo file server/backend/cbase-wrapper (perl), so the fake runs the REAL wrapper with its real group semantics. The wrapper looks up
// the command behind `--` through the PATH of the exec.
//
// Guard and self-test: server/backend/test/projectbox-ops.test.js.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostPort } from "../electron/server/projectbox/address.js";
import { bindInodes, cidr, dfImages, inNetworkOfTheContainer, ipFrom, withSize, networkFree, statInContainer, intersect, rename, volumeFree } from "./fake-docker-stat.mjs";
import { COPY_VIEW, copyViewPart } from "./fake-docker-copy-view.mjs";
import { readJsonl } from "./jsonl.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";

export { hostPort };

const FAKE_PATH = fileURLToPath(import.meta.url);
// The project box wrapper: its path in the image (Dockerfile, stage projectbox) and the file in the repo.
export const WRAPPER_IN_IMAGE = "/usr/sbin/cbase-wrapper";
export const WRAPPER_IN_REPO = path.resolve(path.dirname(FAKE_PATH), "..", "cbase-wrapper");

// ── Harness side ─────────────────────────────────────────────────────────────────────────────

const daemonFolder = (root, daemon) => path.join(root, "daemon", encodeURIComponent(daemon || "host"));
const gatePath = (root, name) => path.join(root, "gates", encodeURIComponent(name));

export async function fakeDocker({ occupiedNetworks = [], stopGate = null, execGate = null, inspectGate = null, rmGate = null, images: imageList = {}, instanceIp = null, programs = {}, infoFailures = {}, infoDriver = {}, brokenImages = [], execBroken = [], runStartBroken = [], startAbort = {}, stopsInside = false, compose = {}, imageContent = {}, dryrunSilent = false, composeBroken = [], pauseGate = null, eventBuffer = 256, runReference = null, checkUsed = false, upBroken = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fake-docker-"));
  fs.mkdirSync(path.join(dir, "gates"), { recursive: true });
  const mapped = { [WRAPPER_IN_IMAGE]: WRAPPER_IN_REPO, ...programs };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ occupiedNetworks, stopGate, execGate, inspectGate, rmGate, instanceIp, programs: mapped, infoFailures, infoDriver, brokenImages, execBroken, runStartBroken, startAbort /* Abnahme Scheibe 8 */, stopsInside, compose /* Scheibe E, Welle 2a */, imageContent /* Gegenlesen E, betr#1 */, dryrunSilent /* Abnahme S1-26, Befund 3 */, composeBroken /* ST2-10, Bau 2B */, pauseGate, eventBuffer /* Gegenlesen 2B */, runReference /* NB-2 */, checkUsed /* AN-25 */, upBroken /* IN-7 */ }));
  const host = emptyState();
  for (const [ref, value] of Object.entries(imageList)) host.images[normRef(ref)] = imageEntry(value && typeof value === "object" ? value : { id: value });
  writeState(daemonFolder(dir, "host"), host);
  const bin = path.join(dir, "docker");
  // A shell wrapper instead of the .mjs itself: the path must carry no extension, and FAKE_DOCKER_DIR travels along fixed,
  // since the product hands the docker child its own environment, not the test's.
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_DOCKER_DIR='${dir}' exec '${process.execPath}' '${FAKE_PATH}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    env: { CBASE_DOCKER_BIN: bin },
    calls: ({ daemon } = {}) => readJsonl(path.join(dir, "calls.jsonl")).filter((a) => !daemon || a.daemon === daemon),
    state: (daemon = "host") => readState(daemonFolder(dir, daemon)),
    async gateReached(name) {
      const marker = `${gatePath(dir, name)}.waiting`;
      while (!fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 15)); // poll interval, no deadline
    },
    openGate: (name) => fs.writeFileSync(gatePath(dir, name), ""),
    // closes a gate again (e.g. after seeding through `exec`, before the test needs the hanging case)
    closeGate: (name) => fs.rmSync(gatePath(dir, name), { force: true }),
    // Injected failures (block "injected failures" below): replaces the list, `[]` withdraws it.
    errorAt: (list) => errorAtSet(dir, list),
    // The local folder that plays the `_data` of a volume of this daemon (block "volume content").
    volumeData: (name, daemon = "host") => volumeData(dir, daemon, name),
    // The write layer of a container (name or id): the rows that `docker diff` reports after the mount points.
    setDiff: (w, rows, daemon = "host") => withState(daemonFolder(dir, daemon), (z) => {
      const c = find(z, w);
      if (!c) throw new Error(`setDiff: no container ${w}`);
      c.diff = [...rows];
    }),
    // Set a label of a container: a container that an older version created (e.g. the label cbase.mounts of the old hash
    // formula). `value` null removes the label entirely (a container from before carries `cbase.mounts.v2` not at all).
    setLabel: (w, key, value, daemon = "host") => withState(daemonFolder(dir, daemon), (z) => {
      const c = find(z, w);
      if (!c) throw new Error(`setLabel: no container ${w}`);
      const labels = { ...c.labels };
      if (value === null) delete labels[key]; else labels[key] = String(value);
      c.labels = labels;
    }),
    // A container that ended by itself with `code` (e.g. an `on-failure:3` worker after three crashes), not stopped by hand; for
    // the transition of the copy view (restart rules of the real dockerd).
    setExit: (w, code, daemon = "host") => withState(daemonFolder(dir, daemon), (z) => {
      const c = find(z, w);
      if (!c) throw new Error(`setExit: no container ${w}`);
      if (c.status === "running") throw new Error(`setExit: ${w} is still running`);
      c.exitCode = Number(code);
      delete c.ofHand;
    }),
    // Block "event stream": the living `docker events` streams ({ pid, since, filter }), ending them hard (a stream that ends
    // unexpectedly), a crash past cbase, an injected event, all written events.
    streams: () => streamsOf(dir),
    endStreams() {
      const all = streamsOf(dir);
      for (const s of all) { try { process.kill(s.pid, "SIGKILL"); } catch {} }
      return all.length;
    },
    crash: (w, opts) => crashIn(dir, w, opts),
    event: (w, action, extra = {}) => {
      const c = find(readState(daemonFolder(dir, "host")), w);
      if (!c) throw new Error(`event: no container ${w}`);
      writeLifeLog(daemonFolder(dir, "host"), c, action, extra);
    },
    streamEvents: () => readJsonl(path.join(daemonFolder(dir, "host"), "stream.jsonl")),
    cleanUp() {
      for (const s of streamsOf(dir)) { try { process.kill(s.pid, "SIGKILL"); } catch {} } // event stream
      for (const d of fs.existsSync(path.join(dir, "daemon")) ? fs.readdirSync(path.join(dir, "daemon")) : []) {
        const z = readState(path.join(dir, "daemon", d));
        for (const c of Object.values(z.container)) for (const g of c.processes || []) killGroup(g);
      }
      // Like every harness (agent-harness, server-harness): a test must not fail at cleanup; a docker call of the server that was
      // just running writes its state into this folder (ENOTEMPTY).
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch {}
    },
  };
}

export async function secondLoopback() {
  for (const address of ["127.0.0.2", "::1"]) {
    if (await bindable(address)) return address;
  }
  throw new Error("secondLoopback: neither 127.0.0.2 nor ::1 is bindable");
}

function bindable(address) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, address, () => s.close(() => resolve(true)));
  });
}

// ── State (shared by both sides) ───────────────────────────────────────────────────────

function emptyState() {
  return { container: {}, networks: {}, volumes: {}, images: {}, counter: 0 };
}
function readState(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, "state.json"), "utf8")); } catch { return emptyState(); }
}
function writeState(folder, z) {
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, `state.json.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(z));
  fs.renameSync(tmp, path.join(folder, "state.json"));
}
function killGroup(pgid) {
  try { process.kill(-pgid, "SIGKILL"); } catch {}
}
const normRef = (ref) => {
  const r = String(ref);
  if (r.startsWith("sha256:")) return r;
  const last = r.split("/").pop();
  return last.includes(":") || last.includes("@") ? r : `${r}:latest`;
};

// ── Program side ────────────────────────────────────────────────────────────────────────────

class Abort extends Error {
  constructor(code, notice) { super(notice); this.exitCode = code; }
}
const error = (code, notice) => { throw new Abort(code, notice); };

// Several fake dockers run at the same time (parallel calls of the product): the state of a daemon is read and written only
// under its lock. The lock is a folder; it is held only for one read-modify-write, never across a running command.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
// ── An ORPHANED lock is dropped ────────────────────────────────────────────
// A signal to the docker caller (every `.kill` of the in-project runner, e.g. at a deadline or the output cap) can hit the fake docker
// in the middle of this lock, and then every further call would spin here forever. The holder is stored as a pid in the lock; if it
// is no longer alive, the lock is renamed (only if it is still ITS) and removed.
// The lock NEVER stands without its holder: it is built aside with the pid file and renamed into place (rename(2) is atomic and
// fails while another lock stands — that one always contains its holder), and it is renamed away before it is deleted. With
// `mkdir` + write + `rm -r` there were two windows in which the folder stood without `holders` — after the mkdir and inside the
// recursive delete —, undetectable as an orphan; and the second one DOES contain a call: the output cap kills the `exec` right after
// its child ended, when it passes on the last output and then deregisters the process under this lock. git-view-detail.test.js
// hit it (the next exec spun for the whole 20 s deadline: 504 READ_TIME). Guard: projectbox-git.test.js "(G2)".
// Test seam: FAKE_DOCKER_DIE_AT=<point> ends the fake with SIGKILL at that point of the lock (LOCK_DIE_POINTS, in order).
export const LOCK_DIE_POINTS = Object.freeze(["built", "taken", "worked", "handed-back"]);
const dieAt = (point) => { if (process.env.FAKE_DOCKER_DIE_AT === point) process.kill(process.pid, "SIGKILL"); };
function lockOrphaned(lock) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(lock, "holders"), "utf8")); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); return null; } catch (e) { return e.code === "ESRCH" ? pid : null; }
}
function cleanOrphanedLock(lock) {
  const tot = lockOrphaned(lock);
  if (!tot) return;
  const way = `${lock}.verwaist-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try { fs.renameSync(lock, way); } catch { return; }
  let holders = null;
  try { holders = Number(fs.readFileSync(path.join(way, "holders"), "utf8")); } catch { /* empty */ }
  if (holders !== tot) { try { fs.renameSync(way, lock); } catch { /* another one already holds it */ } return; }
  fs.rmSync(way, { recursive: true, force: true });
}
function withState(folder, fn) {
  fs.mkdirSync(folder, { recursive: true });
  const lock = path.join(folder, "lock");
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const own = `${lock}.built-${tag}`;
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, "holders"), String(process.pid)); // the holder, for cleanOrphanedLock
  dieAt("built");
  for (;;) {
    try { fs.renameSync(own, lock); break; } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e; }
    cleanOrphanedLock(lock); // S1-29
    Atomics.wait(sleepBuffer, 0, 0, 5); // lock poll interval
  }
  dieAt("taken");
  try {
    const z = readState(folder);
    const result = fn(z);
    writeState(folder, z);
    dieAt("worked");
    return result;
  } finally {
    const gone = `${lock}.gone-${tag}`;
    fs.renameSync(lock, gone);
    dieAt("handed-back");
    fs.rmSync(gone, { recursive: true, force: true });
  }
}

// Read flags up to the first positional argument. `value`: flags with a value; `toggle`: without. `--x=value` and bundled short
// switches (`-it`) work as with the real docker. An unknown flag is 125.
function read2(args, { value = [], toggle = [], forbidden = [] } = {}) {
  const W = new Set(value);
  const S = new Set(toggle);
  const V = new Set(forbidden);
  const f = new Map();
  const add = (k, v) => { if (!f.has(k)) f.set(k, []); f.get(k).push(v); };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (!a.startsWith("-") || a === "-") break;
    const [name, equal] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (V.has(name)) error(125, `fake-docker: ${name} is forbidden for project containers`);
    if (W.has(name)) { add(name, equal !== undefined ? equal : args[++i]); continue; }
    if (S.has(name)) { add(name, true); continue; }
    if (/^-[a-zA-Z]{2,}$/.test(name) && [...name.slice(1)].every((c) => S.has(`-${c}`))) {
      for (const c of name.slice(1)) add(`-${c}`, true);
      continue;
    }
    error(125, `unknown flag: ${name}\nSee 'docker --help'.`);
  }
  const contains = (...n) => n.some((x) => f.has(x));
  const all = (...n) => n.flatMap((x) => f.get(x) || []);
  const one = (...n) => { const v = all(...n); return v.length ? v[v.length - 1] : undefined; };
  return { has: contains, all, one, rest: args.slice(i) };
}

const labelsFrom = (list) => Object.fromEntries(list.map((l) => {
  const k = String(l).indexOf("=");
  return k < 0 ? [l, ""] : [l.slice(0, k), l.slice(k + 1)];
}));

function template(tpl, obj) {
  if (tpl === "json" || tpl === "{{json .}}") return JSON.stringify(obj);
  return tpl.replace(/\{\{\s*(json\s+)?\.([\w.]*)\s*\}\}/g, (_, json, way) => {
    const v = way ? way.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj) : obj;
    if (json) return JSON.stringify(v ?? null);
    if (v === undefined || v === null) return "<no value>";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// As the real CLI for `ps` and `images` (cli/command/formatter, preFormat): `\t` and `\n` in the format become tab and line end
// BEFORE the template runs (not for `inspect`). Without it `{{.Names}}\t{{.Status}}` would arrive as ONE field with a backslash.
const cliFormat = (f) => String(f).replace(/\\t/g, "\t").replace(/\\n/g, "\n");

function find(z, who) {
  const w = String(who).replace(/^\//, "");
  const list = Object.values(z.container);
  const exact = list.find((c) => c.id === w || c.name === w);
  if (exact) return exact;
  const prefix = list.filter((c) => c.id.startsWith(w));
  return prefix.length === 1 ? prefix[0] : null;
}
const findNetwork = (z, who) => Object.values(z.networks).find((n) => n.name === who || n.id === who || (who.length >= 3 && n.id.startsWith(who))) || null;
const findImage = (z, who) => {
  const r = normRef(who);
  if (z.images[r]) return { ref: r, ...z.images[r] };
  const id = String(who).replace(/^sha256:/, "");
  const e = Object.entries(z.images).find(([, b]) => b.id === id || (id.length >= 3 && b.id.startsWith(id)));
  return e ? { ref: e[0], ...e[1] } : null;
};

// The RestartPolicy as for real `{ Name, MaximumRetryCount }`: `--restart on-failure:3` means name "on-failure" with 3.
function restartPolicy(raw) {
  const [name, n] = String(raw || "no").split(":");
  return { Name: name || "no", MaximumRetryCount: name === "on-failure" && Number(n) > 0 ? Number(n) : 0 };
}
// Does dockerd restart this container on resumption? As moby `daemon.restore` → `ShouldRestart` with a NEW RestartManager (the
// attempt counter starts at 0): `always` always, `unless-stopped` unless stopped by hand, `on-failure[:n]` on an exit != 0 (also
// the 255 of a container that was running when the daemon died).
function startsAtResumption(c) {
  const { Name } = restartPolicy(c.restart);
  if (Name === "always") return true;
  if (Name === "unless-stopped") return !c.ofHand;
  if (Name === "on-failure") return Number(c.exitCode) !== 0;
  return false;
}

const containerView = (c) => ({
  Id: c.id,
  Name: `/${c.name}`,
  Created: c.created,
  Image: c.imageId ? `sha256:${c.imageId}` : "",
  Config: {
    Image: c.image, Hostname: c.hostname || c.id.slice(0, 12), Labels: c.labels, Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`), Cmd: c.cmd,
    // As for real only with `--health-cmd`; `Retries` 0 means "the daemon's default" (3).
    ...(c.health ? { Healthcheck: { Test: ["CMD-SHELL", c.health], Retries: c.healthRetries || 0 } } : {}),
  },
  // `StartedAt` as the real docker (the time of the last start, the zero date if never started); an entry of a service is valid
  // only for the container run in which it arose (services.js).
  State: { Status: c.paused ? "paused" : c.status, Running: c.status === "running", Paused: Boolean(c.paused), ExitCode: c.exitCode, StartedAt: c.started || "0001-01-01T00:00:00Z" },
  HostConfig: { RestartPolicy: restartPolicy(c.restart), Runtime: c.runtime || "runc", Init: !!c.init, AutoRemove: !!c.autoRemove },
  Mounts: c.mounts,
  NetworkSettings: {
    Networks: Object.fromEntries(c.networks.map((n) => [n.name, { IPAddress: n.ip, ...(c.aliases?.length ? { Aliases: c.aliases } : {}) }])),
    // Published ports of a container in the INNER daemon (`run -p`, only there), form as for real.
    ...(c.ports?.length ? { Ports: Object.fromEntries(c.ports.map((x) => [x.target, [{ HostIp: x.ip || "0.0.0.0", HostPort: String(x.host) }]])) } : {}),
  },
});
// `Options` as for real (`-o k=v` of `network create`, else `{}`: docker then names the bridge `br-<id>`); `Containers` as for real only
// the RUNNING endpoints (a stopped container is no endpoint) — projectbox/instance.js networkFor reads both (the bridge name).
const networkView = (n, z = null) => ({
  Name: n.name, Id: n.id, Internal: n.internal, Labels: n.labels, Options: { ...(n.options || {}) },
  IPAM: { Config: n.subnet ? [{ Subnet: n.subnet, ...(n.gateway ? { Gateway: n.gateway } : {}) }] : [] },
  Containers: Object.fromEntries(Object.values(z?.container || {}).filter((c) => c.status === "running").flatMap((c) => (c.networks || [])
    .filter((x) => x.name === n.name).map((x) => [c.id, { Name: c.name, IPv4Address: x.ip ? `${x.ip}/24` : "" }]))),
});
const volumeView = (v) => ({ Name: v.name, Driver: v.driver || "local", Labels: v.labels, Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Options: v.options && Object.keys(v.options).length ? v.options : null, Scope: "local" });
const imageView = (b) => ({ Id: `sha256:${b.id}`, RepoTags: [b.ref], Config: { Labels: b.labels || null } });
// An image in the state: `{ id, labels? }` (the labels travel with save/load/tag). A container INHERITS the labels of its image
// as with the real docker (at creation: `Config.Labels` = image labels ∪ own, the own win), in `inspect`, in `ps --format
// {{.Labels}}` and in `ps --filter label=…`.
const withImageLabels = (imageValue, own) => ({ ...(imageValue?.labels || {}), ...own });
const imageEntry = (b) => ({ id: String(b.id), ...(b.labels && Object.keys(b.labels).length ? { labels: b.labels } : {}) });
// `{{.ID}}` as for real: shortened, with `--no-trunc` the full id (the deploy side matches through it).
const psRow = (c, full = false) => ({
  Command: JSON.stringify(c.cmd.join(" ")), CreatedAt: c.created, ID: full ? c.id : c.id.slice(0, 12), Image: c.image,
  Labels: Object.entries(c.labels).map(([k, v]) => `${k}=${v}`).join(","), LocalVolumes: "0", Mounts: "",
  Names: c.name, Networks: c.networks.map((n) => n.name).join(","), Ports: "", RunningFor: "", Size: "",
  State: c.paused ? "paused" : c.status, Status: c.paused ? "Up (Paused)" : c.status === "running" ? "Up" : `Exited (${c.exitCode})`,
});

const newId = () => crypto.randomBytes(32).toString("hex");

// ── Health and end of inner services, driven through gates (the restoration runs compose stages) ──────────
// `--health-cmd` (only remembered, never run): `inspect` reports `State.Health.Status`: "healthy" as soon as the gate
// `healthy-<name>` is open, "unhealthy" with the gate `unhealthy-<name>` open, else "starting" and the mark
// `healthy-<name>.waiting`. Label `cbase.test.ends=<code>` (a one-shot container like `migrate`): while running it ends with
// <code> as soon as the gate `finished-<name>` is open (state saved); until then the mark `finished-<name>.waiting`. Both only in
// `inspect`, the only way in which the product reads health and end.
const HEALTH_VALUE = ["--health-cmd", "--health-interval", "--health-timeout", "--health-retries", "--health-start-period"];
function liveView(c, ctx) {
  const open = (name) => fs.existsSync(gatePath(ctx.root, name));
  const marker = (name) => { try { fs.writeFileSync(`${gatePath(ctx.root, name)}.waiting`, ""); } catch { /* gates folder missing */ } };
  let x = c;
  const ends = c.labels?.["cbase.test.ends"];
  if (ends !== undefined && c.status === "running") {
    if (open(`finished-${c.name}`)) {
      const code = Number(ends) || 0;
      withState(ctx.folder, (z) => { const y = z.container[c.id]; if (y && y.status === "running") { y.status = "exited"; y.exitCode = code; } });
      x = { ...c, status: "exited", exitCode: code };
    } else marker(`finished-${c.name}`);
  }
  const view = containerView(x);
  if (x.health) {
    let status = "starting";
    if (x.status === "running") {
      if (open(`unhealthy-${x.name}`)) status = "unhealthy";
      else if (open(`healthy-${x.name}`)) status = "healthy";
      else marker(`healthy-${x.name}`);
    }
    view.State.Health = { Status: status };
  }
  return view;
}

const RUN_VALUE = ["--name", "--label", "-l", "--network", "--net", "--mount", "-e", "--env", "--restart", "--hostname", "-h",
  "--user", "-u", "--workdir", "-w", "--entrypoint", "--memory", "-m", "--cpus", "--runtime", "--cgroupns", "--security-opt",
  "--cap-add", "--cap-drop", "--device", "--tmpfs", "--add-host", "--dns", "--ip", "--stop-timeout", "--stop-signal",
  "--pids-limit", "--shm-size", "--ulimit", "--log-opt", "--log-driver", ...HEALTH_VALUE];
const RUN_TOGGLE = ["-d", "--detach", "--rm", "--privileged", "--init", "-i", "--interactive", "-t", "--tty", "--read-only"];
const RUN_FORBIDDEN = ["-p", "--publish", "-P", "--publish-all", "-v", "--volume"];
// In the INNER daemon of a project container a stack publishes its ports as everywhere: `-p
// [ip:]host:target[/proto]` is allowed there (the ban applies only to B's daemon), `inspect` reports them under
// `NetworkSettings.Ports`. `--network-alias` ebenso (unter `NetworkSettings.Networks.<n>.Aliases`).
const RUN_PORT = ["-p", "--publish"];
function portFrom(raw) {
  const m = String(raw).match(/^(?:([0-9.]+|\[[0-9a-fA-F:]+\]):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/);
  if (!m) error(125, `invalid argument "${raw}" for "-p, --publish" flag`);
  return { ip: m[1] ? m[1].replace(/^\[|\]$/g, "") : "", host: Number(m[2]), target: `${m[3]}/${m[4] || "tcp"}` };
}

function mount(raw, z) {
  const parts = Object.fromEntries(String(raw).split(",").map((t) => { const k = t.indexOf("="); return k < 0 ? [t, "true"] : [t.slice(0, k), t.slice(k + 1)]; }));
  const type = parts.type || "volume";
  const source = parts.source || parts.src || "";
  const target = parts.target || parts.destination || parts.dst || "";
  if (!target) error(125, "invalid argument \"" + raw + "\" for \"--mount\" flag: target is required");
  if (type === "bind" && !fs.existsSync(source)) error(125, `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${source}`);
  if (type === "volume" && source && !z.volumes[source]) z.volumes[source] = { name: source, labels: {} };
  // A volume mount carries its `Name` (and `Driver`) as for real; `Source` stays the name here (real: the path under
  // /var/lib/docker/volumes; tests read it this way).
  return { Type: type, ...(type === "volume" && source ? { Name: source, Driver: "local" } : {}), Source: source, Destination: target, RW: !("readonly" in parts || "ro" in parts) };
}

function run(args, ctx) {
  const inside = ctx.daemon !== "host";
  const o = read2(args, {
    value: inside ? [...RUN_VALUE, ...RUN_PORT, "--network-alias"] : RUN_VALUE, toggle: RUN_TOGGLE,
    forbidden: inside ? RUN_FORBIDDEN.filter((x) => !RUN_PORT.includes(x)) : RUN_FORBIDDEN,
  });
  if (["host"].includes(o.one("--network", "--net"))) error(125, "fake-docker: --network host is forbidden for project containers");
  const [image, ...cmd] = o.rest;
  if (!image) error(125, "\"docker run\" requires at least 1 argument.");
  // Without -d WITH a command the real docker would run the command and return output and exit code; that is not emulated.
  // Silently reporting "done with 0" without running the command would turn such a call in the product into a green test with no
  // meaning, hence 125 like everything unknown. Without a command it stays the one-shot container that ends at once with 0 (this is
  // how projectbox-server-end.test.js seeds an ended compose container).
  if (!o.has("-d", "--detach") && cmd.length) error(125, `fake-docker: run without -d with a command (${cmd.join(" ")}) is not replicated - the command would not run`);
  const env = {};
  for (const e of o.all("-e", "--env")) {
    const k = e.indexOf("=");
    if (k < 0) { if (process.env[e] !== undefined) env[e] = process.env[e]; } else env[e.slice(0, k)] = e.slice(k + 1);
  }
  const detach = o.has("-d", "--detach");
  const res = withState(ctx.folder, (z) => {
    const name = o.one("--name") || `fake_${z.counter + 1}`;
    const occupied = find(z, name);
    if (occupied && occupied.name === name) error(125, `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${occupied.id}".`);
    const networks = [];
    for (const nn of o.all("--network", "--net")) {
      // Helper (projectbox/helper.js): `none` as for real, no network, no address.
      if (nn === "none") { networks.push({ name: "none", ip: "" }); continue; }
      const n = nn === "bridge" ? { name: "bridge", subnet: "172.17.0.0/16" } : findNetwork(z, nn);
      if (!n) error(125, `docker: Error response from daemon: network ${nn} not found.`);
      z.counter++;
      const ip = o.one("--ip") || ctx.config.instanceIp || (cidr(n.subnet) ? ipFrom(cidr(n.subnet).start + 1 + z.counter) : "");
      networks.push({ name: n.name, ip });
    }
    const mounts = o.all("--mount").map((m) => mount(m, z));
    z.counter++;
    const imageValue = findImage(z, image);
    const imageId = imageValue?.id || "";
    const broken = !!imageId && (ctx.config.brokenImages || []).includes(imageId);
    const c = {
      id: newId(), name, image, imageId, cmd, env, labels: withImageLabels(imageValue, labelsFrom(o.all("--label", "-l"))), networks, mounts,
      hostname: o.one("--hostname", "-h") || "", // `Config.Hostname`; without it, as for real, the short id
      restart: o.one("--restart") || "", runtime: o.one("--runtime") || "", created: new Date(0 + z.counter * 1000).toISOString(),
      autoRemove: detach && o.has("--rm"), // `run -d --rm` as for real: gone after the stop
      status: detach && !broken ? "running" : "exited", exitCode: broken ? 1 : 0, processes: [], init: o.has("--init"),
      started: detach ? new Date().toISOString() : "", // S1-16: State.StartedAt
      health: o.one("--health-cmd") || "", // S1-19
      ...(o.one("--health-retries") ? { healthRetries: Number(o.one("--health-retries")) } : {}), // ST2-10
      ...(inside && o.all(...RUN_PORT).length ? { ports: o.all(...RUN_PORT).map(portFrom) } : {}), // ST2-10
      ...(inside && o.all("--network-alias").length ? { aliases: o.all("--network-alias") } : {}), // ST2-10
      logs: broken ? "fake-docker: der Entrypoint dieses Images scheiterte (brokenImages)\n" : "",
      ...(ctx.daemon === "host" ? { mountInodes: bindInodes(mounts, ctx.config.runReference) } : {}), // (not in `inspect`)
    };
    if (!detach && o.has("--rm")) return c.id;
    const startBroken = detach && (ctx.config.runStartBroken || []).some((m) => new RegExp(m).test(name));
    if (startBroken) { c.status = "created"; c.exitCode = 128; }
    z.container[c.id] = c;
    if (c.status === "running") rememberStart(z, c); // ST2-7: events
    return startBroken ? { startBroken: c.id } : c.id;
  });
  if (res?.startBroken) error(125, "docker: Error response from daemon: failed to set up container networking: Address already in use.");
  if (detach && ctx.daemon === "host") lifeLogOf(ctx, res, ["create", "start"]); // the event stream
  if (detach && ctx.daemon === "host") copyViewAfterRun(ctx, res); // ST2-9
  if (detach) ctx.stdout(`${res}\n`);
}

function start(args, ctx) {
  const { rest } = read2(args, { toggle: ["-a", "--attach", "-i", "--interactive"] });
  const started = []; // event stream
  let aborted = false;
  withState(ctx.folder, (z) => {
    const rule = rest.length > 1 && Object.entries(ctx.config.startAbort || {}).find(([m]) => new RegExp(m).test(ctx.daemon));
    if (rule && (z.startAborts || 0) < Number(rule[1])) { z.startAborts = (z.startAborts || 0) + 1; aborted = true; }
    for (const w of (aborted ? rest.slice(0, 1) : rest)) {
      const c = find(z, w);
      if (!c) error(1, `Error response from daemon: No such container: ${w}`);
      if (c.paused) error(1, `Error response from daemon: cannot start a paused container, try unpause instead\nError: failed to start containers: ${w}`); // ST2-3
      c.status = "running";
      delete c.ofHand; // a start withdraws "stopped by hand" (moby)
      c.started = new Date().toISOString(); // S1-16: State.StartedAt
      rememberStart(z, c); // ST2-7: events
      if (ctx.daemon === "host") newInnerDaemon(ctx, c.name); // a fresh dockerd, an empty buffer
      started.push(c);
    }
  });
  for (const c of started) lifeLog(ctx, c, "start");
  if (aborted) error(1, "docker start: aborted (startAbort)");
  ctx.stdout(rest.map((w) => `${w}\n`).join(""));
}

// A gate: the mark `<name>.waiting`, then poll until the gate is open. The wait BLOCKS the event loop (Atomics.wait), so the
// ripcord from program() (setTimeout) never fired here. Hence the gate counts its own: after RIPCORD_MS the fake ends with 9 and a
// line on stderr instead of letting a test hang forever whose product never aborts (a removed deadline). An emergency brake, not a
// deadline (ripcord.mjs).
function waitAtGate(ctx, name) {
  const gate = gatePath(ctx.root, name);
  fs.writeFileSync(`${gate}.waiting`, "");
  const ripcord = Date.now() + RIPCORD_MS;
  while (!fs.existsSync(gate)) {
    if (Date.now() > ripcord) error(9, `fake-docker: ripcord at the gate "${name}" - nobody opened it, and no cap aborted`);
    Atomics.wait(sleepBuffer, 0, 0, 15); // poll interval, no deadline
  }
}

function endContainer(c, code) {
  for (const g of c.processes || []) killGroup(g);
  c.processes = [];
  c.status = "exited";
  c.exitCode = code;
  delete c.paused; // ST2-3
}

// pause | unpause (see head).
function pause(args, ctx, on = false) {
  const { rest } = read2(args);
  if (!rest.length) error(1, `"docker ${on ? "unpause" : "pause"}" requires at least 1 argument.`);
  if (!on && ctx.daemon === "host" && ctx.config.pauseGate) waitAtGate(ctx, ctx.config.pauseGate); // pause gate (header)
  const missing = [];
  const ok = [];
  const moved = []; // event stream
  withState(ctx.folder, (z) => {
    for (const w of rest) {
      const c = find(z, w);
      if (!c) { missing.push(`Error response from daemon: No such container: ${w}`); continue; }
      if (on) {
        if (!c.paused) { missing.push(`Error response from daemon: Container ${c.id} is not paused`); continue; }
        delete c.paused;
      } else {
        if (c.status !== "running") { missing.push(`Error response from daemon: Container ${c.id} is not running`); continue; }
        if (c.paused) { missing.push(`Error response from daemon: Container ${c.id} is already paused`); continue; }
        c.paused = true;
      }
      ok.push(w);
      moved.push(c);
    }
  });
  for (const c of moved) lifeLog(ctx, c, on ? "unpause" : "pause"); // event stream
  ctx.stdout(ok.map((w) => `${w}\n`).join(""));
  if (missing.length) error(1, missing.join("\n"));
}

function stop(args, ctx) {
  const { rest } = read2(args, { value: ["-t", "--time", "--timeout", "-s", "--signal"] });
  if (!rest.length) error(1, "\"docker stop\" requires at least 1 argument.");
  if (ctx.config.stopGate) waitAtGate(ctx, ctx.config.stopGate);
  const halted = []; // S1-20 (stopsInside)
  const stream = []; // P2A-9: [Container, Ereignisse]
  withState(ctx.folder, (z) => {
    for (const w of rest) {
      const c = find(z, w);
      if (!c) error(1, `Error response from daemon: No such container: ${w}`);
      // a paused container ends HARD (137); TERM does not reach the frozen process (see head).
      // as moby `HasBeenManuallyStopped`: only a running one is "stopped by hand" (unless-stopped stays off then).
      if (c.status === "running") {
        const hart = Boolean(c.paused);
        endContainer(c, hart ? 137 : 143); c.ofHand = true; halted.push(c.name);
        stream.push([{ ...c }, [["kill", { signal: hart ? "9" : "15" }], ["die", { exitCode: String(c.exitCode) }], ["stop", {}]]]);
      }
      if (c.autoRemove) { delete z.container[c.id]; stream.push([{ ...c }, [["destroy", {}]]]); } // AutoRemove (Compose `run --rm`): Docker removes it on stopp selbst
    }
  });
  for (const [c, list] of stream) for (const [action, extra] of list) lifeLog(ctx, c, action, extra);
  // with `stopsInside` the inner daemon ends with the container: its running containers stop (see head, opts).
  if (ctx.config.stopsInside && ctx.daemon === "host") {
    for (const n of halted) {
      withState(daemonFolder(ctx.root, n), (zi) => {
        for (const x of Object.values(zi.container || {})) if (x.status === "running") endContainer(x, 143);
      });
    }
  }
  ctx.stdout(rest.map((w) => `${w}\n`).join(""));
}

function rm(args, ctx) {
  const o = read2(args, { toggle: ["-f", "--force", "-v", "--volumes"] });
  if (ctx.config.rmGate && ctx.daemon === "host") waitAtGate(ctx, ctx.config.rmGate); // Gegenlesen 2B, G2-4
  const stream = []; // P2A-9: [Container, Ereignisse]
  withState(ctx.folder, (z) => {
    for (const w of o.rest) {
      const c = find(z, w);
      if (!c) error(1, `Error response from daemon: No such container: ${w}`);
      if (c.status === "running" && !o.has("-f", "--force")) {
        error(1, `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
      }
      const ran = c.status === "running";
      endContainer(c, 137);
      delete z.container[c.id];
      stream.push([{ ...c }, [...(ran ? [["kill", { signal: "9" }], ["die", { exitCode: "137" }]] : []), ["destroy", {}]]]); // event stream
      if (ctx.daemon === "host") fs.rmSync(viewFolder(ctx.root, c.name), { recursive: true, force: true }); // ST2-9
    }
  });
  for (const [c, list] of stream) for (const [action, extra] of list) lifeLog(ctx, c, action, extra);
  ctx.stdout(o.rest.map((w) => `${w}\n`).join(""));
}

function output(objects, format, ctx) {
  if (format) ctx.stdout(objects.map((x) => `${template(format, x)}\n`).join(""));
  else ctx.stdout(`${JSON.stringify(objects, null, 4)}\n`);
}

function inspect(args, ctx, only = null) {
  const o = read2(args, { value: ["-f", "--format", "--type"], toggle: ["-s", "--size"] });
  const z = readState(ctx.folder);
  const type = only || o.one("--type");
  const found = [];
  const missing = [];
  for (const w of o.rest) {
    const c = (!type || type === "container") && find(z, w);
    const n = !c && (!type || type === "network") && findNetwork(z, w);
    const v = !c && !n && (!type || type === "volume") && z.volumes[w];
    const b = !c && !n && !v && (!type || type === "image") && findImage(z, w);
    const view = c ? liveView(c, ctx) : n ? networkView(n, z) : v ? volumeView(v) : b ? imageView(b) : null; // S1-19
    if (view) found.push(c && o.has("-s", "--size") ? withSize(view, c) : view); else missing.push(w); // AN-25: `--size`
  }
  output(found, o.one("-f", "--format"), ctx);
  if (missing.length) {
    const what = type === "image" ? "image" : type === "network" ? "network" : type === "volume" ? "volume" : "object";
    error(1, missing.map((w) => `Error: No such ${what}: ${w}`).join("\n"));
  }
}

function ps(args, ctx) {
  const o = read2(args, { value: ["--format", "-f", "--filter"], toggle: ["-a", "--all", "-q", "--quiet", "--no-trunc", "-s", "--size"] });
  const z = readState(ctx.folder);
  let list = Object.values(z.container).sort((a, b) => (a.created < b.created ? 1 : -1));
  if (!o.has("-a", "--all")) list = list.filter((c) => c.status === "running");
  for (const f of o.all("--filter", "-f")) {
    const [k, ...r] = String(f).split("=");
    const v = r.join("=");
    if (k === "label") {
      const [lk, ...lv] = v.split("=");
      list = list.filter((c) => lk in c.labels && (!lv.length || c.labels[lk] === lv.join("=")));
    } else if (k === "name") list = list.filter((c) => c.name.includes(v));
    else if (k === "id") list = list.filter((c) => c.id.startsWith(v));
    else if (k === "status") list = list.filter((c) => (c.paused ? "paused" : c.status) === v); // paused as for real
    else error(1, `Error response from daemon: invalid filter '${k}'`);
  }
  // As the real docker: `-q` shortened, with `--no-trunc` the full id (compared with the id of the instance row).
  if (o.has("-q", "--quiet")) return ctx.stdout(list.map((c) => `${o.has("--no-trunc") ? c.id : c.id.slice(0, 12)}\n`).join(""));
  const format = o.one("--format");
  if (!format) return ctx.stdout(list.map((c) => `${c.id.slice(0, 12)}   ${c.image}   ${c.status}   ${c.name}\n`).join(""));
  ctx.stdout(list.map((c) => `${template(cliFormat(format), psRow(c, o.has("--no-trunc")))}\n`).join(""));
}

function network(args, ctx) {
  const [what, ...rest] = args;
  if (what === "create") {
    const o = read2(rest, { value: ["--subnet", "--gateway", "--driver", "-d", "--label", "--opt", "-o", "--ip-range"], toggle: ["--internal", "--attachable"] });
    const name = o.rest[0];
    if (!name) error(1, "\"docker network create\" requires exactly 1 argument.");
    const subnet = o.one("--subnet") || "";
    const id = withState(ctx.folder, (z) => {
      if (findNetwork(z, name)?.name === name) error(1, `Error response from daemon: network with name ${name} already exists`);
      const occupied = [...(ctx.config.occupiedNetworks || []), ...Object.values(z.networks).map((n) => n.subnet).filter(Boolean)];
      if (subnet && occupied.some((b) => intersect(b, subnet))) error(1, "Error response from daemon: Pool overlaps with other one on this address space");
      const n = { id: newId(), name, subnet, gateway: o.one("--gateway") || "", internal: o.has("--internal"), labels: labelsFrom(o.all("--label")), options: labelsFrom(o.all("--opt", "-o")) };
      z.networks[n.id] = n;
      return n.id;
    });
    return ctx.stdout(`${id}\n`);
  }
  if (what === "rm" || what === "remove") {
    const o = read2(rest, { toggle: ["-f", "--force"] });
    withState(ctx.folder, (z) => {
      for (const w of o.rest) {
        const n = findNetwork(z, w);
        if (!n) error(1, `Error response from daemon: network ${w} not found`); networkFree(ctx, z, n, error); // AN-25
        delete z.networks[n.id];
      }
    });
    return ctx.stdout(o.rest.map((w) => `${w}\n`).join(""));
  }
  if (what === "inspect") return inspect(rest, ctx, "network");
  if (what === "ls" || what === "list") {
    // The networks of the daemon: `-q` (ids, shortened without --no-trunc), `--format` against the inspect view.
    const o = read2(rest, { value: ["--format", "-f", "--filter"], toggle: ["-q", "--quiet", "--no-trunc"] });
    let list = Object.values(readState(ctx.folder).networks).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of o.all("--filter", "-f")) {
      const [k, ...r] = String(f).split("=");
      if (k !== "label") error(1, `Error response from daemon: invalid filter '${k}'`);
      const [lk, ...lv] = r.join("=").split("=");
      list = list.filter((n) => lk in n.labels && (!lv.length || n.labels[lk] === lv.join("=")));
    }
    if (o.has("-q", "--quiet")) return ctx.stdout(list.map((n) => `${o.has("--no-trunc") ? n.id : n.id.slice(0, 12)}\n`).join(""));
    const format = o.one("--format");
    if (!format) return ctx.stdout(list.map((n) => `${n.id.slice(0, 12)}   ${n.name}   bridge   local\n`).join(""));
    return ctx.stdout(list.map((n) => `${template(format, networkView(n, readState(ctx.folder)))}\n`).join(""));
  }
  error(125, `fake-docker: network ${what} is not replicated`);
}

function volume(args, ctx) {
  const [what, ...rest] = args;
  if (what === "create") {
    const o = read2(rest, { value: ["--label", "--driver", "-d", "--opt", "-o", "--name"] });
    const name = o.rest[0] || o.one("--name") || newId();
    const options = labelsFrom(o.all("--opt", "-o")); // `k=v` like a label
    const driver = o.one("--driver", "-d") || "local";
    withState(ctx.folder, (z) => { if (!z.volumes[name]) z.volumes[name] = { name, labels: labelsFrom(o.all("--label")), ...(driver !== "local" ? { driver } : {}), ...(Object.keys(options).length ? { options } : {}) }; });
    fs.mkdirSync(volumeData(ctx.root, ctx.daemon, name), { recursive: true }); // `_data` as for real
    return ctx.stdout(`${name}\n`);
  }
  if (what === "rm" || what === "remove") {
    const o = read2(rest, { toggle: ["-f", "--force"] });
    withState(ctx.folder, (z) => {
      for (const w of o.rest) {
        if (!z.volumes[w]) error(1, `Error response from daemon: get ${w}: no such volume`); volumeFree(ctx, z, w, error); // AN-25
        delete z.volumes[w];
        fs.rmSync(path.dirname(volumeData(ctx.root, ctx.daemon, w)), { recursive: true, force: true }); // the content goes with it
      }
    });
    return ctx.stdout(o.rest.map((w) => `${w}\n`).join(""));
  }
  if (what === "inspect") return inspect(rest, ctx, "volume");
  if (what === "ls" || what === "list") return volumeLs(rest, ctx); // the "collect" part (block below)
  error(125, `fake-docker: volume ${what} is not replicated`);
}

async function image(args, ctx) {
  const [what, ...rest] = args;
  if (what === "inspect") return inspect(rest, ctx, "image"); if (what === "rm" || what === "remove") return rmi(rest, ctx); // AN-25
  if (what === "save") {
    const o = read2(rest, { value: ["-o", "--output"] });
    const z = readState(ctx.folder);
    const imageList = o.rest.map((w) => findImage(z, w) || error(1, `Error response from daemon: reference does not exist: ${w}`));
    const content = JSON.stringify({ fakeDockerImages: imageList.map((b) => ({ ref: b.ref, ...imageEntry(b) })) });
    const target = o.one("-o", "--output");
    if (target) fs.writeFileSync(target, content); else ctx.stdout(content);
    return;
  }
  if (what === "load") {
    const o = read2(rest, { value: ["-i", "--input"], toggle: ["-q", "--quiet"] });
    const source = o.one("-i", "--input");
    let raw = "";
    if (source) raw = fs.readFileSync(source, "utf8");
    else for await (const b of process.stdin) raw += b;
    let imageList;
    try { imageList = JSON.parse(raw).fakeDockerImages; } catch { imageList = null; }
    if (!Array.isArray(imageList)) error(1, "Error response from daemon: unexpected EOF");
    withState(ctx.folder, (z) => { for (const b of imageList) z.images[normRef(b.ref)] = imageEntry(b); });
    return ctx.stdout(imageList.map((b) => `Loaded image: ${b.ref}\n`).join(""));
  }
  error(125, `fake-docker: image ${what} is not replicated`);
}

// ── Images benennen, auflisten, entfernen; info, logs (S1-7) ──────────────────────────────────────────────────────────

const used = (z, id) => Object.values(z.container).find((c) => c.imageId === id) || null;
const refsOf = (z, id) => Object.keys(z.images).filter((r) => z.images[r].id === id).sort();
const partsRef = (ref) => { const i = ref.lastIndexOf(":"); return { Repository: ref.slice(0, i), Tag: ref.slice(i + 1) }; };

function tag(args, ctx) {
  const { rest } = read2(args);
  if (rest.length !== 2) error(1, "\"docker tag\" requires exactly 2 arguments.");
  const [source, target] = rest;
  withState(ctx.folder, (z) => {
    const b = findImage(z, source);
    if (!b) error(1, `Error response from daemon: No such image: ${source}`);
    z.images[normRef(target)] = imageEntry(b);
  });
}

function images(args, ctx) {
  const o = read2(args, { value: ["--format", "--filter", "-f"], toggle: ["-q", "--quiet", "--no-trunc", "-a", "--all", "--digests"] });
  const z = readState(ctx.folder);
  const [repo] = o.rest;
  const longId = o.has("--no-trunc");
  let list = Object.keys(z.images).filter((r) => !r.startsWith("sha256:")).sort().map((r) => ({
    ...partsRef(r), ID: longId ? `sha256:${z.images[r].id}` : z.images[r].id.slice(0, 12),
  }));
  if (repo) {
    const [onlyRepo, onlyTag] = repo.includes(":") ? [repo.slice(0, repo.lastIndexOf(":")), repo.slice(repo.lastIndexOf(":") + 1)] : [repo, null];
    list = list.filter((b) => b.Repository === onlyRepo && (!onlyTag || b.Tag === onlyTag));
  }
  if (o.has("-q", "--quiet")) return ctx.stdout(list.map((b) => `${b.ID}\n`).join(""));
  const format = o.one("--format");
  if (!format) return ctx.stdout(list.map((b) => `${b.Repository}   ${b.Tag}   ${b.ID}\n`).join(""));
  ctx.stdout(list.map((b) => `${template(cliFormat(format), b)}\n`).join(""));
}

function rmi(args, ctx) {
  const o = read2(args, { toggle: ["-f", "--force", "--no-prune"] });
  if (!o.rest.length) error(1, "\"docker rmi\" requires at least 1 argument.");
  withState(ctx.folder, (z) => {
    for (const w of o.rest) {
      const byName = !String(w).startsWith("sha256:") && z.images[normRef(w)];
      const b = findImage(z, w);
      if (!b) error(1, `Error response from daemon: No such image: ${w}`);
      const refs = refsOf(z, b.id);
      const c = used(z, b.id);
      if (byName) {
        if (refs.length === 1 && c) error(1, `Error response from daemon: conflict: unable to remove repository reference "${w}" (must force) - container ${c.id.slice(0, 12)} is using its referenced image ${b.id.slice(0, 12)}`);
        delete z.images[normRef(w)];
        ctx.stdout(`Untagged: ${normRef(w)}\n`);
        continue;
      }
      if (c) error(1, `Error response from daemon: conflict: unable to delete ${b.id.slice(0, 12)} (cannot be forced) - image is being used by container ${c.id.slice(0, 12)}`);
      if (refs.length > 1 && !o.has("-f", "--force")) error(1, `Error response from daemon: conflict: unable to delete ${b.id.slice(0, 12)} (must be forced) - image is referenced in multiple repositories`);
      for (const r of refs) delete z.images[r];
      ctx.stdout(`${refs.map((r) => `Untagged: ${r}\n`).join("")}Deleted: sha256:${b.id}\n`);
    }
  });
}

function info(args, ctx) {
  const o = read2(args, { value: ["--format", "-f"] });
  const n = withState(ctx.folder, (z) => { z.infoCalls = (z.infoCalls || 0) + 1; return z.infoCalls; });
  const failed = Object.entries(ctx.config.infoFailures || {}).find(([pattern]) => new RegExp(pattern).test(ctx.daemon));
  if (failed && n <= Number(failed[1])) error(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  // `infoDriver`: the storage driver per daemon whose name matches the RegExp (vfs is a setup error).
  const driver = Object.entries(ctx.config.infoDriver || {}).find(([pattern]) => new RegExp(pattern).test(ctx.daemon));
  const view = { ServerVersion: "20.10.24+fake", Driver: driver ? String(driver[1]) : "overlay2", CgroupVersion: "2" };
  const format = o.one("--format", "-f");
  ctx.stdout(format ? `${template(format, view)}\n` : `Server Version: ${view.ServerVersion}\n Storage Driver: ${view.Driver}\n`);
}

// `stats --no-stream [--format V] [name …]`: one line per container with fixed numbers (the resource display checks the form, not
// the load); without names the running ones, a stopped one with zeros as for real, an unknown name is an error. Without
// --no-stream it would run endlessly, so not emulated (125).
function stats(args, ctx) {
  const o = read2(args, { value: ["--format"], toggle: ["--no-stream", "-a", "--all", "--no-trunc"] });
  if (!o.has("--no-stream")) error(125, "fake-docker: stats without --no-stream is not replicated");
  const z = readState(ctx.folder);
  const list = o.rest.length
    ? o.rest.map((w) => find(z, w) || error(1, `Error response from daemon: No such container: ${w}`))
    : Object.values(z.container).filter((c) => c.status === "running");
  const format = cliFormat(o.one("--format") || "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}");
  const running = (c) => c.status === "running";
  ctx.stdout(list.map((c) => `${template(format, { Name: c.name, ID: c.id.slice(0, 12), CPUPerc: running(c) ? "1.50%" : "0.00%", MemUsage: running(c) ? "64MiB / 8GiB" : "0B / 0B" })}\n`).join(""));
}

function logs(args, ctx) {
  const o = read2(args, { value: ["--tail", "-n", "--since", "--until"], toggle: ["-f", "--follow", "-t", "--timestamps"] });
  const c = find(readState(ctx.folder), o.rest[0] || "");
  if (!c) error(1, `Error response from daemon: No such container: ${o.rest[0]}`);
  ctx.stdout(c.logs || "");
}

// The docking point of the wrapper (see head): a path in the image is mapped to a local file. `docker` is always the daemon of
// the container: the same fake with its own state.
function map(cmd, c, ctx) {
  const [first, ...rest] = cmd;
  if (first === "docker") {
    const inside = ctx.daemon === "host" ? c.name : `${ctx.daemon}>${c.name}`;
    return { argv: [process.execPath, FAKE_PATH, ...rest], env: { FAKE_DOCKER_DIR: ctx.root, FAKE_DOCKER_DAEMON: inside } };
  }
  const local = (ctx.config.programs || {})[first];
  return { argv: [local || first, ...rest], env: {} };
}

async function exec(args, ctx) {
  const o = read2(args, { value: ["-u", "--user", "-e", "--env", "-w", "--workdir"], toggle: ["-d", "--detach", "-i", "--interactive", "-t", "--tty", "--privileged"] });
  const [who, ...cmd] = o.rest;
  if (!who || !cmd.length) error(1, "\"docker exec\" requires at least 2 arguments.");
  const gateName = ctx.daemon !== "host" ? null
    : ctx.config.execGate || (cmd[0] === "docker" && cmd[1] === "inspect" ? ctx.config.inspectGate : null);
  if (gateName) waitAtGate(ctx, gateName);
  const z = readState(ctx.folder);
  const c = find(z, who);
  if (!c) error(1, `Error response from daemon: No such container: ${who}`);
  if (c.status !== "running") error(1, `Error response from daemon: container ${c.id} is not running`);
  if (c.paused) error(1, `Error response from daemon: Container ${c.id} is paused, unpause the container before exec`); // ST2-3
  if ((ctx.config.execBroken || []).includes(c.name)) {
    error(126, "OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1: unknown");
  }
  if (ctx.daemon === "host" && !o.has("-d", "--detach") && statInContainer(c, cmd, ctx)) return; // NB-2
  // A copy container sees its overlays (copy view): first the transition, then the translation.
  const view = ctx.daemon === "host" && viewExists(ctx.root, c.name);
  if (view) copyViewTransition(ctx, c.name);
  const cwdRaw = o.one("-w", "--workdir");
  const cwd = view && cwdRaw ? copyViewPath(readState(viewFolder(ctx.root, c.name)), viewFolder(ctx.root, c.name), cwdRaw) : cwdRaw;
  if (cwd && !fs.existsSync(cwd)) {
    error(126, `OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("${cwd}") set in config.json failed: no such file or directory: unknown`);
  }
  // The "container" is this machine: PATH and HOME come along — and the gate's GIT_CONFIG_NOSYSTEM (tools/check/targets/check.mjs):
  // otherwise a git in the container read the machine's /etc/gitconfig, on a runner with git-lfs installed system-wide that is
  // `filter.lfs.process`, and every checkout went to the tests' fake git-lfs (copy checkouts died with "clean filter 'lfs' failed").
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.GIT_CONFIG_NOSYSTEM ? { GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM } : {}), ...c.env };
  for (const e of o.all("-e", "--env")) {
    const k = e.indexOf("=");
    if (k < 0) { if (process.env[e] !== undefined) env[e] = process.env[e]; } else env[e.slice(0, k)] = e.slice(k + 1);
  }
  let { argv, env: addition } = view ? mapCopyView(cmd, c, ctx) : map(cmd, c, ctx);
  // In a HELPER the programs see the volumes as local folders (block "volume content").
  if (c.labels?.["cbase.helper"]) ({ argv, env: addition } = inHelper(c, ctx, cmd, argv, addition));
  argv = inNetworkOfTheContainer(c, cmd, argv, ctx);
  const remember = (pid) => withState(ctx.folder, (s) => { const x = s.container[c.id]; if (x) x.processes = [...(x.processes || []), pid]; });
  const forget = (pid) => withState(ctx.folder, (s) => { const x = s.container[c.id]; if (x) x.processes = (x.processes || []).filter((p) => p !== pid); });

  if (o.has("-d", "--detach")) {
    const subprocess = spawn(argv[0], argv.slice(1), { cwd: cwd || undefined, env: { ...env, ...addition }, detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { subprocess.once("spawn", resolve); subprocess.once("error", reject); })
      .catch((e) => error(127, `OCI runtime exec failed: exec: "${cmd[0]}": ${e.message}`));
    remember(subprocess.pid);
    subprocess.unref();
    return;
  }

  // The output goes into files of the state folder, not into pipes of the caller: if the caller dies, the process keeps writing
  // (as in a real container) and holds no foreign pipe open.
  const execFolder = path.join(ctx.folder, "exec");
  fs.mkdirSync(execFolder, { recursive: true });
  const stem = path.join(execFolder, `${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const fdOut = fs.openSync(`${stem}.out`, "w");
  const fdErr = fs.openSync(`${stem}.err`, "w");
  const subprocess = spawn(argv[0], argv.slice(1), {
    cwd: cwd || undefined, env: { ...env, ...addition }, detached: true,
    stdio: [o.has("-i", "--interactive") ? "pipe" : "ignore", fdOut, fdErr],
  });
  fs.closeSync(fdOut);
  fs.closeSync(fdErr);
  const started = await new Promise((resolve) => { subprocess.once("spawn", () => resolve(true)); subprocess.once("error", () => resolve(false)); });
  if (!started) error(127, `OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH: unknown`);
  remember(subprocess.pid);
  if (subprocess.stdin) { subprocess.stdin.on("error", () => {}); process.stdin.pipe(subprocess.stdin); }
  const read = { out: 0, err: 0 };
  const passOn = () => {
    for (const [k, target] of [["out", process.stdout], ["err", process.stderr]]) {
      const b = fs.readFileSync(`${stem}.${k}`);
      if (b.length > read[k]) { target.write(b.subarray(read[k])); read[k] = b.length; }
    }
  };
  const tick = setInterval(passOn, 20);
  const [code, signal] = await new Promise((resolve) => subprocess.once("exit", (c2, s2) => resolve([c2, s2])));
  clearInterval(tick);
  passOn();
  forget(subprocess.pid);
  if (view) copyViewReconcile(ctx, c.name); // what the command wrote into the overlays now lies on top
  ctx.exitCode = code ?? 128 + (os.constants.signals[signal] || 0);
}

// ── Compose, update, builder prune, injected failures ─────────────────────────────────────────────────────────────────────
// Only what the relocation calls is emulated; everything else ends with 125 as elsewhere.
//   update --restart=<p> <c…>     sets the restart policy (visible in `HostConfig.RestartPolicy.Name`); other flags 125
//   builder prune -f [--filter …] does nothing (the build cache is not emulated), exit 0; without `-f` 125 (it would ask). Like dockerd
//                                 20.10 it ACCEPTS `--filter label=…` without applying it (builder-next `Prune`)
//   compose <global> config --hash <sel>
//                                 per ACTIVE service of the model one line "<service> <hash>" (sel `*` = all active, else service names
//                                 separated by commas); every file from `-f`/`--env-file` must exist (else 1 like the real Compose). A
//                                 service is active without `profiles` or with a profile from the global `--profile` options (`*` = all).
//                                 As the real Compose (v2.40.3 measured): `*` without an active profile leaves profile services OUT, a
//                                 named inactive one ends with 1 "no such service: <d>: disabled"; `config` activates no profile, unlike `up`.
//   compose <global> run -d --no-deps <service>
//                                 (for seeding in tests only) a one-shot container like `compose run` without `--rm`: name
//                                 `<project>-<service>-run-<12 hex>`, labels like `up` with `oneoff=True` and `slug`, own NEW anonymous
//                                 volumes, named ones shared; runs at once. Without `-d`/`--no-deps` 125.
//   compose <global> up --no-start --no-build --pull never <services…>
//                                 ONLY in exactly this form (else 125) and only with services (without, 125: an empty `up` would not
//                                 create profile services either). Creates per service with `dependsOn` the container
//                                 `<project>-<service>-1` (state `created`, Compose labels as for real, among them `config-hash`,
//                                 `depends_on`, `image`, `working_dir`, `config_files`, `environment_file`); an existing one with the same
//                                 hash stays, one with another hash is created ANEW (new id). The image must exist in the daemon (`--pull
//                                 never`). Networks `<project>_<short>` with Compose labels if they do not exist; `external` must exist.
//                                 Named volumes `<project>_<name>` with labels if they do not exist; anonymous ones get a new 64-hex volume
//                                 with the label `com.docker.volume.anonymous` at EVERY creation, the unfavourable case (the real Compose
//                                 adopts them on recreation); a relocation that filled anonymous volumes would lose their content.
//                                 `Mounts` carry `Name` and `Driver` as for real.
//   The model `compose: { <project>: { <service>: { image, profiles, dependsOn, volumes, … } } }` (volName = own `name:` of the volume,
//   `${X:-v}` is interpolated from `<dir>/.env`; `{ extern: <volume>, target }` like `external: true`, `nocopy: true` without copy-up;
//   envFile: [path] (`env_file:`, relative to --project-directory), build: { context, dockerfile }, aliases: [a], environment: { K: V }.
//   It applies in EVERY daemon. `up` creates a named profile service (a named service is created whatever its profile).
//   fakeComposeHash({ service, files, envFiles, folder, envFile, kind })  the hash the fake computes: sha256 over the service, every file
//                                 from `-f` (path AND content) and the env files (without `--env-file` `<folder>/.env`). A set-aside
//                                 override file or a changed `.env` key changes it. For a service WITH `envFile` as the real Compose 5.3.1
//                                 (measured): `kind: "up"` (the label that `up`/`run` set) includes the CONTENT of every env_file, `kind:
//                                 "config"` (`config --hash`) only its path; the two are NEVER equal for such a service, and `config --hash`
//                                 stays equal when the content changes. Without `envFile` both are equal.
//   compose <global> config --format json [--no-interpolate]
//                                 `{ name, services: { <service>: { image, … } } }` of the active services (profiles as `--hash`). As
//                                 Compose v2.40.3 (measured locally, without a daemon): ONLY with `--no-interpolate` a service carries
//                                 `env_file: [{ path, required: true }]` and no value from it; without (also with `--no-env-resolution`
//                                 alone) `env_file` is missing and `environment` carries the VALUES of the env_file. Above, `volumes` (as
//                                 5.3.1): per named volume `{ name: "<project>_<name>" }`, per `extern` `{ external: true, name }`; without
//                                 volumes the key is missing.
//   compose <global> --progress json --dry-run up …
//                                 changes NOTHING in the state and writes Compose's verdict as JSON lines to STDERR (as the real Compose its
//                                 progress): per missing network "Network <n>" Creating/Created; a warning `{ level: "warning", msg: "Found
//                                 orphan containers ([…]) …", time }` if a container of this Compose project belongs to no service of the
//                                 model; per container `<project>-<service>-1`: if missing "Creating" (Working) + "Created" (Done); if its
//                                 label differs from the hash of `up` (or `--force-recreate`) "Recreate" (Working) on "Container <name>" +
//                                 "Recreated" (Done) on "Container <short-id>_<name>"; if current and running "Running" (Done); if current and
//                                 not running NO line (as measured with 5.3.1). `--dry-run` only with `--progress json` and only at `up`;
//                                 `--force-recreate` also at the real `up` (creates every one anew). A missing env_file is an error 1 at `up`
//                                 (also in the dry run) as for real.
//   errorAt([{ daemon?, pattern, nr? }])  (harness) a call whose `args.join(" ")` matches the RegExp `pattern` (and, with `daemon`, runs
//                                 exactly in this daemon) ends with 1 and "fake-docker: injected error", BEFORE any effect. With `nr`
//                                 only at the nr-th hit (from 1), counted per entry. Note: an `exec … docker …` appears TWICE in the log (host
//                                 daemon with `exec`, inner without), `daemon` picks the side.
const ERROR_AT = "error-at.json";
function errorAtSet(dir, list) {
  const l = Array.isArray(list) ? list : [];
  for (const e of l) if (!e || typeof e.pattern !== "string") throw new TypeError("errorAt: je Eintrag { daemon?, muster, nr? }");
  fs.writeFileSync(path.join(dir, ERROR_AT), JSON.stringify(l));
  for (const f of fs.readdirSync(dir)) if (f.startsWith("error-at-") && f.endsWith(".counter")) fs.rmSync(path.join(dir, f), { force: true });
}
function playedInError(root, daemon, argv) {
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(root, ERROR_AT), "utf8")); } catch { return null; }
  const text = argv.join(" ");
  for (const [i, e] of list.entries()) {
    if (e.daemon && e.daemon !== daemon) continue;
    if (!new RegExp(e.pattern).test(text)) continue;
    if (e.seq === undefined) return `fake-docker: injected error (${e.pattern})`;
    const counter = path.join(root, `error-at-${i}.counter`);
    fs.appendFileSync(counter, "x"); // O_APPEND: one byte per hit, also with parallel calls
    if (fs.statSync(counter).size === Number(e.seq)) return `fake-docker: injected error (${e.pattern}, hit ${e.seq})`;
  }
  return null;
}

const CL = Object.freeze({
  project: "com.docker.compose.project", folder: "com.docker.compose.project.working_dir",
  files: "com.docker.compose.project.config_files", envFiles: "com.docker.compose.project.environment_file",
  service: "com.docker.compose.service", hash: "com.docker.compose.config-hash", dependsOn: "com.docker.compose.depends_on",
  image: "com.docker.compose.image", oneoff: "com.docker.compose.oneoff", number: "com.docker.compose.container-number",
  network: "com.docker.compose.network", volume: "com.docker.compose.volume", version: "com.docker.compose.version",
});
const readOrEmpty = (p) => { try { return fs.readFileSync(p); } catch { return Buffer.alloc(0); } };
// A volume with its own `name:` (`volName`) that Compose interpolates: `${X}`, `${X:-default}` and `${X-default}` from
// `<folder>/.env` (like Compose's standard env file), else the default. Under `config --no-interpolate` the text stays literal
// (measured v2.40.3).
function interpolateFake(s, folder) {
  const env = {};
  for (const z of String(readOrEmpty(path.join(folder, ".env"))).split("\n")) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(z.trim()); if (m) env[m[1]] = m[2]; }
  return String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}/g, (_, n, op, preset) => (env[n] !== undefined && !(op === ":-" && env[n] === "") ? env[n] : preset ?? ""));
}
const volumeNameFake = (g, v) => (v.volName ? interpolateFake(v.volName, g.folder) : `${g.project}_${v.name}`);
export function fakeComposeHash({ service, files = [], envFiles = [], folder = "", envFile = [], kind = "up" }) {
  if (kind !== "up" && kind !== "config") throw new TypeError(`fakeComposeHash: kind "${kind}"`);
  const h = crypto.createHash("sha256");
  h.update(`dienst\0${service}\0`);
  for (const d of files) { h.update(`datei\0${d}\0`); h.update(readOrEmpty(d)); h.update("\0"); }
  for (const e of envFiles.length ? envFiles : [path.join(folder, ".env")]) { h.update(`env\0${e}\0`); h.update(readOrEmpty(e)); h.update("\0"); }
  // With env_file `up` and `config --hash` compute differently, only `up` reads the content (see head).
  if (envFile.length) {
    h.update(`env_file\0${kind}\0`);
    for (const e of envFile) { h.update(`${e}\0`); if (kind === "up") h.update(readOrEmpty(e)); h.update("\0"); }
  }
  return h.digest("hex");
}
// The env_file of a service of the model as absolute paths (relative to --project-directory as for real).
const envFileOf = (g, m) => (m?.envFile || []).map((p) => path.resolve(g.folder, p));
function envFileExists(g, m) {
  for (const f of envFileOf(g, m)) if (!fs.existsSync(f)) error(1, `env file ${f} not found: stat ${f}: no such file or directory`);
}
// The values of an env_file (only for `config --format json` WITHOUT --no-interpolate; as for real they then appear in the output).
function envFileValues(files) {
  const w = {};
  for (const f of files) for (const z of String(readOrEmpty(f)).split(/\r?\n/)) {
    const m = z.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (m) w[m[1]] = m[2];
  }
  return w;
}

function update(args, ctx) {
  const o = read2(args, { value: ["--restart"] });
  const p = o.one("--restart");
  if (!p) error(125, "fake-docker: update without --restart is not replicated");
  if (!o.rest.length) error(1, "\"docker update\" requires at least 1 argument.");
  withState(ctx.folder, (z) => {
    for (const w of o.rest) {
      const c = find(z, w);
      if (!c) error(1, `Error response from daemon: No such container: ${w}`);
      c.restart = p === "no" ? "" : p;
    }
  });
  ctx.stdout(o.rest.map((w) => `${w}\n`).join(""));
}

function builder(args, ctx) {
  const [what, ...rest] = args;
  if (what !== "prune") error(125, `fake-docker: builder ${what} is not replicated`);
  const o = read2(rest, { value: ["--filter", "--keep-storage"], toggle: ["-f", "--force", "-a", "--all"] });
  if (!o.has("-f", "--force")) error(125, "fake-docker: builder prune without -f would ask - not replicated");
  ctx.stdout("Total reclaimed space: 0B\n");
}

function composeGlobal(args) {
  const o = read2(args, { value: ["-p", "--project-name", "--project-directory", "-f", "--file", "--env-file", "--profile", "--progress"], toggle: ["--dry-run"] });
  const project = o.one("-p", "--project-name");
  const folder = o.one("--project-directory");
  const files = o.all("-f", "--file");
  const envFiles = o.all("--env-file");
  if (!project || !folder || !files.length) error(125, "fake-docker: compose is replicated only with -p, --project-directory and -f");
  for (const d of [...files, ...envFiles]) if (!fs.existsSync(d)) error(1, `open ${d}: no such file or directory`);
  const progress = o.one("--progress");
  if (progress !== undefined && progress !== "json") error(125, `fake-docker: compose --progress ${progress} is not replicated (json only)`);
  return { project, folder, files, envFiles, profile: o.all("--profile"), progress, dryRun: o.has("--dry-run"), rest: o.rest };
}

function compose(args, ctx) {
  const g = composeGlobal(args);
  const model = ctx.config.compose?.[g.project];
  if (!model) error(1, `fake-docker: compose project "${g.project}" is not in the model (fakeDocker({ compose }))`);
  const [what, ...rest] = g.rest;
  const hash = (service, kind = "up") => fakeComposeHash({ service, files: g.files, envFiles: g.envFiles, folder: g.folder, envFile: envFileOf(g, model[service]), kind });
  if (g.dryRun && what !== "up") error(125, `fake-docker: compose --dry-run ${what} is not replicated`);
  if (g.progress && what !== "up") error(125, `fake-docker: compose --progress ${what} is not replicated`);
  if (what === "config") {
    const o = read2(rest, { value: ["--hash", "--format"], toggle: ["--no-interpolate", "--no-env-resolution"] });
    const sel = o.one("--hash");
    const format = o.one("--format");
    if (!sel && format !== "json") error(125, "fake-docker: compose config is replicated only with --hash or --format json");
    if (sel && (format || o.has("--no-interpolate", "--no-env-resolution"))) error(125, "fake-docker: compose config --hash is replicated only without further switches");
    const active = (d) => !(model[d].profiles || []).length || g.profile.includes("*") || model[d].profiles.some((p) => g.profile.includes(p));
    if (format === "json") {
      // Only `--no-interpolate` leaves `env_file` in the model and does not read the file (see head).
      const services = {};
      for (const d of Object.keys(model).filter(active).sort()) {
        const m = model[d];
        const ef = envFileOf(g, m);
        services[d] = { image: m.image, ...(m.profiles?.length ? { profiles: m.profiles } : {}) };
        // As for real: `build` with an absolute `context`, `networks.default.aliases`, `environment` from the model (VALUES, literal
        // under --no-interpolate, emulated here without interpolation). Without these fields in the model: as before.
        if (m.build) services[d].build = { context: path.resolve(g.folder, m.build.context || "."), dockerfile: m.build.dockerfile || "Dockerfile" };
        if (m.aliases?.length) services[d].networks = { default: { aliases: [...m.aliases] } };
        if (m.environment) services[d].environment = { ...m.environment };
        if (!ef.length) continue;
        if (o.has("--no-interpolate")) services[d].env_file = ef.map((p) => ({ path: p, required: true }));
        else { envFileExists(g, m); services[d].environment = { ...(services[d].environment || {}), ...envFileValues(ef) }; }
      }
      // (measured with 5.3.1) above `volumes: { <key>: { name: "<project>_<key>" } }`, an `external` with `external: true` and its
      // name, over ALL services of the model (Compose names every declared volume).
      const volumes = {};
      for (const m of Object.values(model)) {
        for (const v of m.volumes || []) {
          if (v.extern) volumes[v.extern] = { external: true, name: v.extern };
          else if (v.name) volumes[v.name] = { name: v.volName ? (o.has("--no-interpolate") ? v.volName : interpolateFake(v.volName, g.folder)) : `${g.project}_${v.name}` };
        }
      }
      const header = Object.keys(volumes).length ? { volumes: Object.fromEntries(Object.entries(volumes).sort(([a], [b]) => (a < b ? -1 : 1))) } : {};
      ctx.stdout(`${JSON.stringify({ name: g.project, services, ...header }, null, 2)}\n`);
      // `composeBroken: [project]`: the model WITH values is already on stdout, then the call ends with 1 and a message that also
      // carries values (like Compose's "invalid interpolation format … "<value>"").
      if ((ctx.config.composeBroken || []).includes(g.project)) {
        const values = Object.values(services).flatMap((x) => Object.values(x.environment || {}));
        error(1, `invalid interpolation format for services: ${JSON.stringify(values)}`);
      }
      return;
    }
    const serviceList = sel === "*" ? Object.keys(model).filter(active).sort() : sel.split(",");
    for (const d of serviceList) if (!model[d]) error(1, `no such service: ${d}`);
    for (const d of serviceList) if (!active(d)) error(1, `no such service: ${d}: disabled`);
    return ctx.stdout(serviceList.map((d) => `${d} ${hash(d, "config")}\n`).join(""));
  }
  if (what === "run") return composeRun(g, model, rest, ctx, hash);
  if (what !== "up") error(125, `fake-docker: compose ${what} is not replicated`);
  if (!g.dryRun && (rest.includes("-d") || rest.includes("--detach"))) return composeUpBuild(g, model, rest, ctx, hash);
  const o = read2(rest, { value: ["--pull"], toggle: ["--no-start", "--no-build", "--force-recreate"] });
  if (!o.has("--no-start") || !o.has("--no-build") || o.one("--pull") !== "never") {
    error(125, "fake-docker: compose up is replicated only as `up --no-start --no-build --pull never <services...>`");
  }
  if (!o.rest.length) error(125, "fake-docker: compose up without services is not replicated");
  if (g.dryRun !== Boolean(g.progress)) error(125, "fake-docker: compose up --dry-run is replicated only with --progress json (and --progress only with --dry-run)");
  const fresh = o.has("--force-recreate"); // also at the real `up`
  // The services with their dependencies, dependencies first.
  const followUp = [];
  const visits = (d, filePath = []) => {
    if (!model[d]) error(1, `no such service: ${d}`);
    if (followUp.includes(d)) return;
    if (filePath.includes(d)) error(1, `dependency cycle detected: ${[...filePath, d].join(" -> ")}`);
    for (const x of model[d].dependsOn || []) visits(x, [...filePath, d]);
    followUp.push(d);
  };
  for (const d of o.rest) visits(d);
  if (g.dryRun) return composeDryrun(g, model, followUp, o.has("--force-recreate"), ctx, hash);
  withState(ctx.folder, (z) => {
    for (const service of followUp) {
      const m = model[service];
      const b = findImage(z, m.image);
      if (!b) error(1, `Error response from daemon: No such image: ${m.image} (--pull never)`);
      envFileExists(g, m);
      for (const e of m.extern || []) if (!findNetwork(z, e)) error(1, `network ${e} declared as external, but could not be found`);
      const networks = [];
      for (const short of m.networks || ["default"]) {
        const name = `${g.project}_${short}`;
        if (!findNetwork(z, name)) {
          const n = { id: newId(), name, subnet: "", gateway: "", internal: false, labels: { [CL.project]: g.project, [CL.network]: short, [CL.version]: "5.3.1" } };
          z.networks[n.id] = n;
        }
        networks.push({ name, ip: "" });
      }
      for (const e of m.extern || []) networks.push({ name: findNetwork(z, e).name, ip: "" });
      const h = hash(service);
      const name = `${g.project}-${service}-1`;
      const old = Object.values(z.container).find((c) => c.name === name) || null;
      if (old && old.labels[CL.hash] === h && !fresh) continue;
      if (old) { endContainer(old, 0); delete z.container[old.id]; }
      const mounts = (m.volumes || []).map((v) => {
        let vname;
        if (v.extern) {
          // `external: true`: the volume is named as it is named and must exist (as the real Compose).
          vname = v.extern;
          if (!z.volumes[vname]) error(1, `external volume "${vname}" not found`);
        } else if (v.name) {
          vname = volumeNameFake(g, v);
          if (!z.volumes[vname]) z.volumes[vname] = { name: vname, labels: { [CL.project]: g.project, [CL.volume]: v.name, [CL.version]: "5.3.1" } };
        } else {
          vname = newId();
          z.volumes[vname] = { name: vname, labels: { "com.docker.volume.anonymous": "" } };
        }
        fs.mkdirSync(volumeData(ctx.root, ctx.daemon, vname), { recursive: true }); // `_data` as for real
        copyUp(ctx, m.image, v, vname);
        return { Type: "volume", Name: vname, Source: `/var/lib/docker/volumes/${vname}/_data`, Destination: v.target, Driver: "local", RW: true };
      });
      z.counter++;
      const labels = {
        [CL.project]: g.project, [CL.folder]: g.folder, [CL.files]: g.files.join(","),
        ...(g.envFiles.length ? { [CL.envFiles]: g.envFiles.join(",") } : {}),
        [CL.service]: service, [CL.hash]: h, [CL.dependsOn]: (m.dependsOn || []).map((x) => `${x}:service_started:false`).join(","),
        [CL.image]: `sha256:${b.id}`, [CL.oneoff]: "False", [CL.number]: "1", [CL.version]: "5.3.1",
      };
      const c = {
        id: newId(), name, image: m.image, imageId: b.id, cmd: [], env: {}, labels: withImageLabels(b, labels), networks, mounts,
        restart: m.restart && m.restart !== "no" ? m.restart : "", runtime: "", created: new Date(0 + z.counter * 1000).toISOString(),
        status: "created", exitCode: 0, processes: [], init: false, started: "", health: "", logs: "",
      };
      z.container[c.id] = c;
    }
  });
}
// "Restart stack" (projectbox instance actions): `compose <global> up -d --build [services…]` ONLY in exactly this form (else 125).
// Without services all active ones of the model (without profile, as for real). Per service with `dependsOn` create the container
// `<project>-<service>-1` if it is missing or its hash differs (like `up --no-start`, without volumes and networks, the restart does
// not need them), then RUNNING (`State.StartedAt` anew, also an already running one: `--build` rebuilds and replaces it). A service
// with `build` does not need its image (it arises at the build), one without must exist in the daemon. Option `upBroken:
// [project]`: the `up` of this Compose project ends with 1 and "failed to solve" (a build that fails); nothing happens before.
function composeUpBuild(g, model, rest, ctx, hash) {
  const o = read2(rest, { toggle: ["-d", "--detach", "--build"] });
  if (!o.has("--build")) error(125, "fake-docker: compose up -d is replicated only as `up -d --build [services...]`");
  if ((ctx.config.upBroken || []).includes(g.project)) error(1, `failed to solve: process "/bin/sh -c false" did not complete successfully: exit code: 1 (${g.project})`);
  const active = (d) => !(model[d].profiles || []).length;
  const followUp = [];
  const visits = (d) => {
    if (!model[d]) error(1, `no such service: ${d}`);
    if (followUp.includes(d)) return;
    for (const x of model[d].dependsOn || []) visits(x);
    followUp.push(d);
  };
  for (const d of (o.rest.length ? o.rest : Object.keys(model).filter(active).sort())) visits(d);
  withState(ctx.folder, (z) => {
    for (const service of followUp) {
      const m = model[service];
      const b = findImage(z, m.image) || (m.build ? { id: crypto.createHash("sha256").update(`${g.project}/${service}`).digest("hex"), labels: null } : null);
      if (!b) error(1, `Error response from daemon: No such image: ${m.image}`);
      const h = hash(service);
      const name = `${g.project}-${service}-1`;
      let c = Object.values(z.container).find((x) => x.name === name) || null;
      if (c && c.labels[CL.hash] !== h) { endContainer(c, 0); delete z.container[c.id]; c = null; }
      if (!c) {
        z.counter++;
        const labels = {
          [CL.project]: g.project, [CL.folder]: g.folder, [CL.files]: g.files.join(","),
          ...(g.envFiles.length ? { [CL.envFiles]: g.envFiles.join(",") } : {}),
          [CL.service]: service, [CL.hash]: h, [CL.dependsOn]: (m.dependsOn || []).map((x) => `${x}:service_started:false`).join(","),
          [CL.image]: `sha256:${b.id}`, [CL.oneoff]: "False", [CL.number]: "1", [CL.version]: "5.3.1",
        };
        c = {
          id: newId(), name, image: m.image, imageId: b.id, cmd: [], env: {}, labels: withImageLabels(b, labels), networks: [], mounts: [],
          restart: m.restart && m.restart !== "no" ? m.restart : "", runtime: "", created: new Date(0 + z.counter * 1000).toISOString(),
          status: "created", exitCode: 0, processes: [], init: false, started: "", health: "", logs: "",
        };
        z.container[c.id] = c;
      }
      c.status = "running";
      c.started = new Date().toISOString();
      rememberStart(z, c);
    }
  });
}

// The dry run `--progress json --dry-run up …` (head of the block): reads the state, writes nothing.
function composeDryrun(g, model, followUp, allNew, ctx, hash) {
  const z = readState(ctx.folder);
  const rows = [];
  const ev = (id, status, text) => rows.push({ id, status, text });
  const orphans = Object.values(z.container).filter((c) => c.labels?.[CL.project] === g.project && c.labels?.[CL.oneoff] !== "True" && !model[c.labels?.[CL.service]]);
  if (orphans.length) {
    rows.push({ level: "warning", msg: `Found orphan containers ([${orphans.map((c) => c.name).sort().join(" ")}]) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up.`, time: new Date(0).toISOString() });
  }
  const networksNew = new Set();
  for (const service of followUp) {
    const m = model[service];
    if (!findImage(z, m.image)) error(1, `Error response from daemon: No such image: ${m.image} (--pull never)`);
    for (const e of m.extern || []) if (!findNetwork(z, e)) error(1, `network ${e} declared as external, but could not be found`);
    envFileExists(g, m);
    for (const short of m.networks || ["default"]) {
      const name = `${g.project}_${short}`;
      if (findNetwork(z, name) || networksNew.has(name)) continue;
      networksNew.add(name);
      ev(`Network ${name}`, "Working", "Creating");
      ev(`Network ${name}`, "Done", "Created");
    }
    const name = `${g.project}-${service}-1`;
    const old = Object.values(z.container).find((c) => c.name === name) || null;
    if (!old) { ev(`Container ${name}`, "Working", "Creating"); ev(`Container ${name}`, "Done", "Created"); continue; }
    if (allNew || old.labels[CL.hash] !== hash(service)) {
      ev(`Container ${name}`, "Working", "Recreate");
      ev(`Container ${old.id.slice(0, 12)}_${name}`, "Done", "Recreated");
      continue;
    }
    if (old.status === "running") ev(`Container ${name}`, "Done", "Running");
  }
  if (ctx.config.dryrunSilent) return;
  ctx.failed(rows.map((x) => `${JSON.stringify(x)}\n`).join(""));
}
// `compose run -d --no-deps <service>` (for seeding only): a one-shot container like the real Compose without `--rm`: name
// `<project>-<service>-run-<slug[:12]>`, `oneoff=True`, an own new anonymous volume per target, named volumes and networks like
// `up`; runs at once.
function composeRun(g, model, rest, ctx, hash) {
  const o = read2(rest, { toggle: ["-d", "--detach", "--no-deps"] });
  if (!o.has("-d", "--detach") || !o.has("--no-deps") || o.rest.length !== 1) error(125, "fake-docker: compose run is replicated only as `run -d --no-deps <service>`");
  const service = o.rest[0];
  const m = model[service];
  if (!m) error(1, `no such service: ${service}`);
  envFileExists(g, m);
  const slug = newId();
  const name = `${g.project}-${service}-run-${slug.slice(0, 12)}`;
  withState(ctx.folder, (z) => {
    const b = findImage(z, m.image);
    if (!b) error(1, `Error response from daemon: No such image: ${m.image}`);
    const networks = [];
    for (const short of m.networks || ["default"]) {
      const nname = `${g.project}_${short}`;
      if (!findNetwork(z, nname)) {
        const n = { id: newId(), name: nname, subnet: "", gateway: "", internal: false, labels: { [CL.project]: g.project, [CL.network]: short, [CL.version]: "5.3.1" } };
        z.networks[n.id] = n;
      }
      networks.push({ name: nname, ip: "" });
    }
    const mounts = (m.volumes || []).map((v) => {
      let vname;
      if (v.name) {
        vname = volumeNameFake(g, v);
        if (!z.volumes[vname]) z.volumes[vname] = { name: vname, labels: { [CL.project]: g.project, [CL.volume]: v.name, [CL.version]: "5.3.1" } };
      } else {
        vname = newId();
        z.volumes[vname] = { name: vname, labels: { "com.docker.volume.anonymous": "" } };
      }
      return { Type: "volume", Name: vname, Source: `/var/lib/docker/volumes/${vname}/_data`, Destination: v.target, Driver: "local", RW: true };
    });
    z.counter++;
    const labels = {
      [CL.project]: g.project, [CL.folder]: g.folder, [CL.files]: g.files.join(","),
      ...(g.envFiles.length ? { [CL.envFiles]: g.envFiles.join(",") } : {}),
      [CL.service]: service, [CL.hash]: hash(service), [CL.dependsOn]: (m.dependsOn || []).map((x) => `${x}:service_started:false`).join(","),
      [CL.image]: `sha256:${b.id}`, [CL.oneoff]: "True", "com.docker.compose.slug": slug, [CL.number]: "1", [CL.version]: "5.3.1",
    };
    const c = {
      id: newId(), name, image: m.image, imageId: b.id, cmd: [], env: {}, labels: withImageLabels(b, labels), networks, mounts, restart: "", runtime: "",
      created: new Date(0 + z.counter * 1000).toISOString(), status: "running", exitCode: 0, processes: [], init: false,
      started: new Date().toISOString(), health: "", logs: "",
    };
    z.container[c.id] = c;
  });
  ctx.stdout(`${name}\n`);
}
// ── Volume content and copy-up ─────────────────────────────────────────────────────────
// A volume has a local folder that plays its `_data`: `<docker root of the daemon>/volumes/<name>/_data`. The docker root of the
// host daemon lies in the state folder; that of an INNER daemon is the `_data` of the volume that its project container mounts at
// /var/lib/docker, as for real: the helper sees under /relocation/target/volumes/<n>/_data exactly the volume <n> of the inner daemon.
//   exec in a HELPER (label cbase.helfer): every program gets FAKE_DOCKER_MOUNTS (JSON: target in the container → local folder or
//     bind source; a volume folder is created on the way); a program that `programs` does NOT map (`find`, `cp`, …) runs locally with
//     translated paths: an argument equal to a mount target or below it becomes the local path. Mapped programs see the paths
//     unchanged (and translate themselves if they want).
//   compose up: a volume that is EMPTY (or missing) when a container is created is filled by the fake from `imageContent[image]
//     [target]`, the copy-up of the real dockerd (`populateVolumes`, CopyData without `nocopy`; only into an empty target). A service
//     with `nocopy: true` at the volume in the model stays empty.
//   volume rm: the folder goes with it.
export function dockerRoot(root, daemon = "host") {
  if (daemon && daemon !== "host" && !String(daemon).includes(">")) {
    const c = Object.values(readState(daemonFolder(root, "host")).container).find((x) => x.name === daemon);
    const m = (c?.mounts || []).find((x) => x.Type === "volume" && x.Destination === "/var/lib/docker" && x.Name);
    if (m) return volumeData(root, "host", m.Name);
  }
  return path.join(daemonFolder(root, daemon), "docker-root");
}
export function volumeData(root, daemon, name) {
  return path.join(dockerRoot(root, daemon), "volumes", name, "_data");
}
function copyUp(ctx, image, v, vname) {
  const content = ctx.config.imageContent?.[image]?.[v.target];
  if (!content || v.nocopy) return;
  const dir = volumeData(ctx.root, ctx.daemon, vname);
  if (fs.readdirSync(dir).length) return;
  for (const [rel, text] of Object.entries(content)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
function inHelper(c, ctx, cmd, argv, addition) {
  const table = (c.mounts || []).map((m) => {
    if (m.Type === "volume" && m.Name) {
      const local = volumeData(ctx.root, ctx.daemon, m.Name);
      fs.mkdirSync(local, { recursive: true });
      return [m.Destination, local];
    }
    return [m.Destination, m.Source];
  }).sort((a, b) => b[0].length - a[0].length);
  const env = { ...addition, FAKE_DOCKER_MOUNTS: JSON.stringify(Object.fromEntries(table)) };
  if ((ctx.config.programs || {})[cmd[0]]) return { argv, env };
  const translate = (a) => {
    for (const [target, local] of table) {
      if (a === target) return local;
      if (a.startsWith(`${target}/`)) return local + a.slice(target.length);
    }
    return a;
  };
  return { argv: [argv[0], ...argv.slice(1).map(translate)], env };
}
// ── end of the operation-mark part ────────────────────────────────────────────────────────────────────────────────────────
// ── end of wave 2a ─────────────────────────────────────────────────────────────────────────────────────
// ── What the data collection of the relocation plan reads ─────────────
// (projectbox/relocation collect; guard server/backend/test/relocation-collect.test.js). Read only, nothing in the state changes:
//   volume ls        `-q` (names), else one line per volume; `--format` against the inspect view; `--filter label=k[=v]`
//   system df        `-v --format '{{json .}}'` bzw. `json`: { Images, Containers, Volumes: [{ Name, Size }], BuildCache } —
//                    `Size` as the real CLI as a human-readable size ("0B", "1.2MB"); the number comes from the field `size`
//                    of a volume in the state (missing: "0B")
//   diff <c>         `A <target>` per mount target that is not in `imageContent[image]`, then the rows from the field `diff`
//                    of the container; an unknown container is 1
function volumeLs(args, ctx) {
  const o = read2(args, { value: ["--format", "-f", "--filter"], toggle: ["-q", "--quiet"] });
  let list = Object.values(readState(ctx.folder).volumes).sort((a, b) => a.name.localeCompare(b.name));
  // `--filter label=k[=v]` as for `network ls` (deleting clears the volumes of all instances by label).
  for (const f of o.all("--filter")) {
    const [k, ...v] = String(f).split("=");
    if (k !== "label") error(1, `Error response from daemon: invalid filter '${k}'`);
    const [lk, ...lv] = v;
    list = list.filter((x) => lk in (x.labels || {}) && (!lv.length || x.labels[lk] === lv.join("=")));
  }
  if (o.has("-q", "--quiet")) return ctx.stdout(list.map((v) => `${v.name}\n`).join(""));
  const format = o.one("--format", "-f");
  if (!format) return ctx.stdout(list.map((v) => `local     ${v.name}\n`).join(""));
  ctx.stdout(list.map((v) => `${template(format, volumeView(v))}\n`).join(""));
}
const human = (n) => (!Number.isFinite(n) || n <= 0 ? "0B" : n < 1000 ? `${n}B` : n < 1e6 ? `${(n / 1e3).toFixed(1)}kB` : n < 1e9 ? `${(n / 1e6).toFixed(1)}MB` : `${(n / 1e9).toFixed(1)}GB`);
function system(args, ctx) {
  const [what, ...rest] = args;
  if (what !== "df") error(125, `fake-docker: system ${what} is not replicated`);
  const o = read2(rest, { value: ["--format"], toggle: ["-v", "--verbose"] });
  const format = o.one("--format");
  if (!o.has("-v", "--verbose") || (format !== "json" && format !== "{{json .}}")) error(125, "fake-docker: system df is replicated only as `-v --format json`");
  const z = readState(ctx.folder);
  const volumes = Object.values(z.volumes).map((v) => ({ Driver: "local", Labels: "", Links: "0", Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Name: v.name, Scope: "local", Size: human(v.size) }));
  ctx.stdout(`${JSON.stringify({ Images: dfImages(z, human) /* AN-25 */, Containers: [], Volumes: volumes, BuildCache: [] })}\n`);
}
function diff(args, ctx) {
  const [w] = args;
  if (!w || args.length !== 1) error(1, "\"docker diff\" requires exactly 1 argument.");
  const c = find(readState(ctx.folder), w);
  if (!c) error(1, `Error response from daemon: No such container: ${w}`);
  // Measured at the real dockerd (`A /data`, `A /conf`): if a mount target is missing in the image, dockerd creates the mount point
  // in the write layer and `docker diff` reports it, for EVERY container with such a mount, without it ever writing. "Present in the
  // image" means here: `imageContent[image]` knows the path. Only the target, not its created parents.
  const points = (c.mounts || []).map((m) => m?.Destination).filter((z) => typeof z === "string" && z && !ctx.config.imageContent?.[c.image]?.[z]).map((z) => `A ${z}`);
  ctx.stdout([...points, ...(c.diff || [])].map((z) => `${z}\n`).join(""));
}
// ── end of the part “collect” ───────────────────────────────────────────────────────────────────────────────────────

// ── events — what `run -d`/`start` recorded (head) ─────────────────────────────────────────────────────────────────────
function rememberStart(z, c) {
  const time = Date.now();
  const fresh = [{ time, type: "container", action: "start", id: c.id, attrs: { name: c.name } }];
  for (const m of c.mounts || []) if (m.Type === "volume" && m.Name) fresh.push({ time, type: "volume", action: "mount", id: m.Name, attrs: { container: c.id, destination: m.Destination } });
  z.events = [...(z.events || []), ...fresh];
}
// Unix seconds, also with a fraction ("1727712345.123", moby ParseTimestamps: the decimals are nanoseconds), in ms.
function asMs(text) {
  if (!/^\d+(\.\d{1,9})?$/.test(String(text || ""))) return NaN;
  const [s, b = ""] = String(text).split(".");
  return Number(s) * 1000 + Number(b.padEnd(9, "0")) / 1e6;
}
function events(args, ctx) {
  const o = read2(args, { value: ["--since", "--until", "--format", "--filter", "-f"] });
  if (o.one("--until") === undefined) return eventsStream(o, ctx); // the event stream
  const since = asMs(o.one("--since"));
  const until = asMs(o.one("--until"));
  if (!Number.isFinite(since) || !Number.isFinite(until)) error(125, "fake-docker: events only with --since/--until as Unix seconds (an open stream would never end)");
  if (o.one("--format") !== "{{json .}}" || o.all("--filter", "-f").length) error(125, "fake-docker: events only with --format '{{json .}}' and without --filter");
  // As moby (daemon/events loadBufferedEvents): the buffer holds the newest N, `since` cuts older ones, `until` later ones.
  const buffer = (readState(ctx.folder).events || []).slice(-Math.max(1, Number(ctx.config.eventBuffer) || 256));
  const list = buffer.filter((e) => e.time >= since && e.time <= until);
  // timeNano exact (as a number in the JSON, as for real; e.time is whole ms): without the detour through a double.
  ctx.stdout(list.map((e) => `${JSON.stringify({ Type: e.type, Action: e.action, Actor: { ID: e.id, Attributes: e.attrs }, scope: "local", time: Math.floor(e.time / 1000), timeNano: "@@NANO@@" }).replace('"@@NANO@@"', `${e.time}000000`)}\n`).join(""));
}
// A container of the host daemon starts (again): its inner dockerd is new, its event buffer empty.
function newInnerDaemon(ctx, name) {
  const folder = daemonFolder(ctx.root, name);
  if (!fs.existsSync(path.join(folder, "state.json"))) return;
  withState(folder, (zi) => { zi.events = []; });
}
// ── End of ST2-7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── Event stream: the life-cycle events, `docker events` WITHOUT `--until` ───────────────────────────────
// The host daemon writes every life-cycle event of a container into `<daemon>/stream.jsonl` (APPEND, no lock: one line is one
// write), like dockerd: `run -d` create + start, `start` start, `stop` of a running one kill (15, paused 9) + die (exitCode) +
// stop, `rm` of a running one kill (9) + die (137) + destroy, of a standing one destroy, `pause`/`unpause`, plus the harness
// (`crash`, `event`). Attributes as for real: the labels of the container, `name`, `image`, plus `exitCode` or `signal`.
// Separate from the buffer of the dated events (`z.events`, only start and volume mount), whose output stays unchanged.
// `events` without `--until` is the STREAM: `--since S` (Unix seconds) delivers first what is stored from S, without `--since` only
// new events; `--filter type=…|label=k[=v]|event=…` (same key OR, different keys AND), only `--format '{{json .}}'`. It polls
// (20 ms) until SIGTERM/SIGINT, until its caller is gone (ppid changes) or stdout breaks, and meanwhile stands as
// `<root>/streams/<pid>` in the folder (the harness counts and ends it through that).
function lifeLog(ctx, c, action, extra = {}) {
  if (ctx.daemon !== "host" || !c) return;
  writeLifeLog(ctx.folder, c, action, extra);
}
function writeLifeLog(folder, c, action, extra = {}) {
  const e = { time: Date.now(), type: "container", action, id: c.id, attrs: { ...(c.labels || {}), image: c.image || "", name: c.name, ...extra } };
  fs.mkdirSync(folder, { recursive: true });
  fs.appendFileSync(path.join(folder, "stream.jsonl"), `${JSON.stringify(e)}\n`);
}
function lifeLogOf(ctx, id, actions) {
  if (ctx.daemon !== "host" || typeof id !== "string") return;
  const c = readState(ctx.folder).container[id];
  if (c?.status === "running") for (const a of actions) lifeLog(ctx, c, a);
}
const streamRow = (e) => `${JSON.stringify({ status: e.action, id: e.id, from: e.attrs?.image || "", Type: e.type, Action: e.action, Actor: { ID: e.id, Attributes: e.attrs }, scope: "local", time: Math.floor(e.time / 1000), timeNano: "@@NANO@@" }).replace('"@@NANO@@"', `${e.time}000000`)}\n`;
function streamMatches(e, filter) {
  for (const [k, values] of Object.entries(filter)) {
    if (!values.length) continue;
    const hits = values.some((v) => {
      if (k === "type") return e.type === v;
      if (k === "event") return e.action === v;
      const [lk, ...lv] = v.split("=");
      return Object.hasOwn(e.attrs || {}, lk) && (!lv.length || e.attrs[lk] === lv.join("="));
    });
    if (!hits) return false;
  }
  return true;
}
function eventsStream(o, ctx) {
  const filter = { type: [], label: [], event: [] };
  for (const f of o.all("--filter", "-f")) {
    const [k, ...r] = String(f).split("=");
    if (!filter[k]) error(125, `fake-docker: events filter "${k}" is not replicated`);
    filter[k].push(r.join("="));
  }
  if (o.one("--format") !== "{{json .}}") error(125, "fake-docker: the stream only with --format '{{json .}}'");
  const sinceRaw = o.one("--since");
  const since = sinceRaw === undefined ? null : asMs(sinceRaw);
  if (sinceRaw !== undefined && !Number.isFinite(since)) error(125, `fake-docker: --since "${sinceRaw}" is no Unix time`);
  const file = path.join(ctx.folder, "stream.jsonl");
  const marker = path.join(ctx.root, "streams", String(process.pid));
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ since, filter }));
  let pos = since === null && fs.existsSync(file) ? fs.statSync(file).size : 0;
  let rest = "";
  const read2 = () => {
    let fd;
    try { fd = fs.openSync(file, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size > pos) {
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        rest += buf.toString("utf8");
      }
    } finally { fs.closeSync(fd); }
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const z = rest.slice(0, i);
      rest = rest.slice(i + 1);
      let e;
      try { e = JSON.parse(z); } catch { continue; }
      if (since !== null && e.time < since) continue;
      if (streamMatches(e, filter)) process.stdout.write(streamRow(e));
    }
  };
  return new Promise((resolve) => {
    const ppid = process.ppid;
    let tick = null;
    const end = () => { clearInterval(tick); try { fs.rmSync(marker, { force: true }); } catch {} resolve(); };
    process.once("SIGTERM", end);
    process.once("SIGINT", end);
    process.stdout.on("error", end);
    tick = setInterval(() => { if (process.ppid !== ppid) return end(); read2(); }, 20);
    read2();
  });
}
// The harness side: the living streams (mark AND process), a crash past cbase, an injected event.
function streamsOf(root) {
  const dir = path.join(root, "streams");
  const out = [];
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const pid = Number(n);
    try { process.kill(pid, 0); out.push({ pid, ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }); }
    catch { fs.rmSync(path.join(dir, n), { force: true }); }
  }
  return out;
}
// The container `w` of the host daemon ends by itself (not by hand: unless-stopped brings it back): exit `code`, its inner
// containers end with it (255, the dockerd died). `oom` writes an oom first, `silent` NO event (one that the stream never saw),
// `restart` lets the daemon start it again (start: a fresh inner dockerd whose containers stay stopped).
function crashIn(root, w, { code = 137, oom = false, silent = false, restart = false } = {}) {
  const folder = daemonFolder(root, "host");
  const c = withState(folder, (z) => {
    const x = find(z, w);
    if (!x) throw new Error(`crash: no container ${w}`);
    if (x.status !== "running") throw new Error(`crash: ${w} is not running`);
    endContainer(x, Number(code));
    delete x.ofHand;
    if (restart) { x.status = "running"; x.started = new Date().toISOString(); }
    return { ...x };
  });
  const inside = daemonFolder(root, c.name);
  if (fs.existsSync(path.join(inside, "state.json"))) {
    withState(inside, (zi) => {
      for (const x of Object.values(zi.container || {})) if (x.status === "running") endContainer(x, 255);
      if (restart) zi.events = [];
    });
  }
  if (silent) return c;
  if (oom) writeLifeLog(folder, c, "oom");
  writeLifeLog(folder, c, "die", { exitCode: String(code) });
  if (restart) writeLifeLog(folder, c, "start");
  return c;
}
// ── End of P2A-9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── The copy view lives in fake-docker-copy-view.mjs (line guard) ─────────
const { copyView, copyViewAfterRun, copyViewTransition, copyViewPath, mapCopyView, copyViewReconcile, copyViewWaiting, viewExists,
  viewFolder } = copyViewPart({ readState, writeState, withState, daemonFolder, killGroup, startsAtResumption, rememberStart, map });
export { COPY_VIEW, copyView };

async function program(argv) {
  const root = process.env.FAKE_DOCKER_DIR;
  if (!root) { process.stderr.write("fake-docker: FAKE_DOCKER_DIR missing\n"); process.exit(125); }
  const daemon = process.env.FAKE_DOCKER_DAEMON || "host";
  fs.appendFileSync(path.join(root, "calls.jsonl"), `${JSON.stringify({ daemon, args: argv })}\n`);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")); } catch {}
  const ctx = { root, daemon, config, folder: daemonFolder(root, daemon), exitCode: 0, stdout: (s) => process.stdout.write(s), failed: (s) => process.stderr.write(s) };
  // An injected failure ends BEFORE any effect (the call is in the log anyway).
  const playedIn = playedInError(root, daemon, argv);
  if (playedIn) { process.stderr.write(`${playedIn}\n`); process.exit(1); }
  // The emergency brake (ripcord.mjs): an exec whose command never ends at least ends the fake. Its process lives on, as with the
  // real docker; cleanUp() reaches it through the group.
  setTimeout(() => process.exit(9), RIPCORD_MS).unref();
  // The inner daemon of a copy runs only after `.prepared` (copy view).
  if (copyViewWaiting(root, daemon)) {
    process.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
    process.exit(1);
  }
  const [command, ...rest] = argv;
  const table = {
    run, start, stop, rm, inspect, ps, network, volume, image, exec, tag, images, rmi, info, logs,
    pause, unpause: (a, c) => pause(a, c, true), // ST2-3
    stats, // S1-16
    update, builder, compose, // Scheibe E, Welle 2a
    system, diff, // the "collect" part
    events, rename: (a, c) => rename(a, c, { withState, find, error }), // ST2-7; AN-19: rename (fake-docker-stat.mjs)
    save: (a, c) => image(["save", ...a], c), load: (a, c) => image(["load", ...a], c),
  };
  try {
    if (!table[command]) error(125, `fake-docker: "${command}" is not replicated`);
    await table[command](rest, ctx);
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    process.stderr.write(`${e.message}\n`);
    ctx.exitCode = e.exitCode;
  }
  // Flush stderr first: on macOS Node writes to a pipe asynchronously (the dry run writes there).
  process.stderr.write("", () => process.stdout.write("", () => process.exit(ctx.exitCode)));
}

// Started as a program (through `bin`), not imported: then argv[1] is this file. realpath, because temp and working folders can be
// linked through /private/… on macOS.
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(FAKE_PATH)) await program(process.argv.slice(2));
