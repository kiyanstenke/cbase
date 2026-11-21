// Handling of the user container on the server.
//
// The gateway is the source of truth about "which container belongs to whom" — it reads that fresh from `docker inspect` on every
// access. So the container itself may be recreated (all gateway routes need auth, an image change could not be triggered
// otherwise): with exactly the arguments of the old container it is created anew, the gateway adopts it.
//
// Two traps, both measured:
//  · The gateway replaces the container itself within ~10 s (ensure path: start → waitHealthy → else rm -f + new). RestartCount stays
//    0, it does NOT look like a restart. So look a second time after the swap — otherwise the inner containers are gone again.
//  · Inner containers without a restart policy do not come up by themselves after the swap.
import { config } from "../config.mjs";
import { OPS_STATUS_CURL_MAX_TIME_S } from "../../../server/backend/electron/server/projectbox/relocation/compose-in-b-limits.js";
import { sleep } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "./ssh.mjs";
import { treeShaShell } from "../../check/lib/asar.mjs";
import * as log from "../../check/lib/log.mjs";
import { B_STOP_DEADLINE } from "./swap.mjs";
import { limitsFromInspect } from "./limits.mjs"; // ONE computation of the limits from inspect
import { retrievalList, partsInner, relocationDeduction } from "./project-container.mjs";

export async function inspectContainer(name) {
  const r = await sshProbe(`docker inspect ${name} 2>/dev/null || echo '[]'`);
  try {
    const arr = JSON.parse(r.stdout);
    return arr[0] || null;
  } catch {
    return null;
  }
}

// Targets `:latest` explicitly — with candidate tags, `docker images cbase-backend` lists several entries, and `head -1` would pick any of them.
export async function imageDigest(image = `${config.remote.image}:latest`) {
  const r = await sshProbe(`docker image inspect --format '{{.Id}}' ${image} 2>/dev/null || true`);
  return r.stdout.trim() || null;
}

// The id of an image on the host WITH distinction: `{ id }` · `{ missing: true }` (the daemon says "No such image") · `{ unknown:
// reason }` (any other answer — ssh, daemon, an output that is not an id). `imageDigest` turns EVERY read error into `null`, i.e.
// "missing"; whoever concludes something from it (the project box distribution) needs this version. Empty is not unknown.
export async function readImageId(ref) {
  return imageIdFrom(await sshProbe(`docker image inspect --format '{{.Id}}' ${ref}`, { check: false }));
}

// Pure: the result of sshProbe → { id } | { missing: true } | { unknown }.
export function imageIdFrom({ code, stdout = "", stderr = "" }) {
  const out = String(stdout ?? "").trim();
  if (code === 0 && /^sha256:[0-9a-f]{64}$/.test(out)) return { id: out };
  const text = `${stderr ?? ""}\n${stdout ?? ""}`;
  if (code !== 0 && /No such image/i.test(text) && !/Cannot connect|connection refused|permission denied/i.test(text)) return { missing: true };
  const row = text.split("\n").map((z) => z.trim()).filter(Boolean).at(-1) || "no output";
  return { unknown: code === 0 ? `no image id: ${row}` : `Exit ${code}: ${row}` };
}

// The environment of an image, a read error becomes `[]` — ONLY for the login retreat (lib/login-retreat.mjs: there `[]` is
// "unknown" and leads to the safe path). Whoever computes a list of `-e` from it uses `imageEnvRead`.
export async function imageEnv(image = config.remote.image) {
  const r = await sshProbe(`docker image inspect ${image} --format '{{json .Config.Env}}' 2>/dev/null || echo '[]'`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}

// The environment of an image WITH distinction — `{ env }` (docker `null` means: none) · `{ unknown: reason }` (ssh, daemon, an
// output that is not a list). Empty is not unknown.
export async function imageEnvRead(ref) {
  return imageEnvFrom(await sshProbe(`docker image inspect --format '{{json .Config.Env}}' ${ref}`, { check: false }));
}

/** Pure: the result of sshProbe → { env } | { unknown }. */
export function imageEnvFrom({ code, stdout = "", stderr = "" }) {
  const out = String(stdout ?? "").trim();
  if (code === 0) {
    try {
      const v = JSON.parse(out);
      if (v === null) return { env: [] };
      if (Array.isArray(v) && v.every((e) => typeof e === "string")) return { env: v };
    } catch { /* below */ }
    return { unknown: `no env list: ${out.split("\n").at(-1) || "no output"}` };
  }
  const row = `${stderr ?? ""}\n${out}`.split("\n").map((z) => z.trim()).filter(Boolean).at(-1) || "no output";
  return { unknown: `Exit ${code}: ${row}` };
}

// Reconstruct the `docker run` arguments of the running container. The computation is pure (`containerSpecFrom`, guard
// tools/check/container-spec.test.mjs); only the image's env is added here via ssh — that of the container's OWN image
// (`insp.Image`), not `cbase-backend:latest` (in the deploy the NEW image, in the rollback the target): every line the new image
// changed or removed would count as "not from the image" and be pinned with the OLD value as `-e` — permanently, passed on at
// every further swap. Unreadable ⇒ throw: with an empty list EVERY image line would be pinned.
//
// That prevents NEW pinning but heals none that exists: `CBASE_SSH=1` once stood as container env in B (no longer in the Dockerfile,
// pinned by an earlier deploy) — B's own image is long a state WITHOUT that line, so it counts as "not from the image" even against
// its own image and kept travelling along at every swap. Hence the one-off, named list STALE_IMAGE_ENV: variables the image once
// set and nothing reads any more — containerSpecFrom never passes them on as `-e`. Guard tools/check/container-spec.test.mjs: no
// name of the list is read or set in the repo.
export async function containerSpec(insp) {
  const name = String(insp?.Name || "?").replace(/^\//, "");
  if (!insp?.Image) throw new Error(`docker inspect ${name}: no image — the spec cannot be reconstructed, nothing swapped.`);
  const e = await imageEnvRead(insp.Image);
  if (e.unknown) {
    throw new Error(`Environment of the own image of ${name} (${String(insp.Image).slice(0, 19)}) not readable (${e.unknown}) — ` +
      "without it every line of the image would be pinned as -e; nothing swapped.");
  }
  const stale = (insp.Config?.Env || []).filter((z) => isStale(z)).map((z) => String(z).split("=")[0]);
  if (stale.length) log.detail(`${name}: stale variable(s) ${stale.join(", ")} drop out at the swap (STALE_IMAGE_ENV)`);
  return containerSpecFrom(insp, e.env);
}

// Variables the image once set and nothing reads any more. Only add, never guess: a name here disappears from EVERY B at the next swap.
export const STALE_IMAGE_ENV = Object.freeze(["CBASE_SSH"]);
const isStale = (row) => STALE_IMAGE_ENV.includes(String(row ?? "").split("=")[0]);
/** The user id in B; containerSpecFrom sets it from the label `cbase.user`. */
export const USER_ID_VAR = "CBASE_USER_ID";
const isUserId = (row) => String(row ?? "").split("=")[0] === USER_ID_VAR;

// Pure: `insp` = `docker inspect` of the running container, `imageEnvList` = `.Config.Env` of ITS image (`insp.Image`, not the image
// swapped to).
export function containerSpecFrom(insp, imageEnvList = []) {
  // `--init` ALWAYS, as at the gateway (`server/gateway/containers.js`): without tini the backend is PID 1 and reaps no orphaned
  // grandchildren — ended children of the agent CLIs would stay as zombies. Not read from `HostConfig.Init`: the containers this tool
  // created so far do NOT carry it, and the reconstruction would pass the defect on with every deploy.
  //
  // `--stop-timeout 60` ALWAYS, on the same pattern and for the same reason: the deadline of every `docker stop` without `-t` (host
  // restart, `docker restart`). On TERM the backend runs the stop chain of the project containers (`-t 30` each); the default of 10 s
  // would hit the inner dockerd with SIGKILL in the middle of it. Not read from `Config.StopTimeout`: no existing B carries it.
  const spec = ["-d", "--init", "--stop-timeout", String(B_STOP_DEADLINE), "--name", insp.Name.replace(/^\//, "")];

  for (const [k, v] of Object.entries(insp.Config?.Labels || {})) spec.push("--label", `${k}=${v}`);

  // Only env that does NOT already come from the own image — otherwise image internals that a new image may have changed
  // (NODE_VERSION etc.) are dragged along; the new image brings its own. A stale variable (STALE_IMAGE_ENV) never travels along —
  // not even one pinned long ago.
  const fromImage = new Set(imageEnvList || []);
  for (const e of insp.Config?.Env || []) if (!fromImage.has(e) && !isStale(e) && !isUserId(e)) spec.push("-e", e);
  // B knows its user id — from the SAME source as when the gateway creates it (the label `cbase.user`, server/gateway/containers.js).
  // An old value is replaced, never doubled; without a label the variable drops out (a B without a label is none of the gateway's,
  // and an id from the old env would be a guess).
  const user = insp.Config?.Labels?.["cbase.user"];
  if (user) spec.push("-e", `${USER_ID_VAR}=${user}`);

  for (const [portProto, binds] of Object.entries(insp.HostConfig?.PortBindings || {})) {
    for (const b of binds || []) {
      // HostPort deliberately 0: the gateway reads the dynamic port fresh from inspect anyway.
      spec.push("-p", `${b.HostIp || "127.0.0.1"}:0:${portProto.split("/")[0]}`);
    }
  }

  for (const m of insp.Mounts || []) {
    if (m.Type === "volume") spec.push("-v", `${m.Name}:${m.Destination}`);
    else if (m.Type === "bind") spec.push("-v", `${m.Source}:${m.Destination}${m.RW ? "" : ":ro"}`);
  }

  const hc = insp.HostConfig || {};
  if (hc.Runtime && hc.Runtime !== "runc") spec.push("--runtime", hc.Runtime);
  // The limits as the old B carried them (lib/limits.mjs limitsFromInspect): `--memory`, `--cpus`, and the weight under contention
  // (0 means "never set", kernel default cpu.weight 100, and drops out — what the number means in the kernel is in
  // server/gateway/containers.js at CPU_SHARES). This is only the substitute: immediately before the swap the deploy replaces them with
  // the STORED value from resources-desired.json (lib/limits-swap.mjs).
  spec.push(...limitsFromInspect(hc));
  if (hc.RestartPolicy?.Name && hc.RestartPolicy.Name !== "no") spec.push("--restart", hc.RestartPolicy.Name);

  const nets = Object.keys(insp.NetworkSettings?.Networks || {});
  if (nets.length === 1 && nets[0] !== "bridge") spec.push("--network", nets[0]);

  return spec;
}

// At most `timeoutMs` (default 120 s, `CBASE_DEPLOY_HEALTHY_MS` — the seam for the maintainer's private suite: 0 means exactly
// ONE question, without waiting). Asked at least once, even with an expired deadline.
export async function waitHealthy(name, timeoutMs = healthyDeadline()) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await sshProbe(
      `docker exec -u agent ${name} curl -sS --max-time 3 -o /dev/null -w '%{http_code}' ` +
        `http://127.0.0.1:${config.remote.backendPort}/api/health 2>/dev/null || true`,
    );
    if (r.stdout.trim() === "200") return true;
    if (Date.now() >= until) return false;
    await sleep(3000);
  }
}
function healthyDeadline() {
  const v = Number(process.env.CBASE_DEPLOY_HEALTHY_MS);
  return Number.isFinite(v) && v >= 0 && process.env.CBASE_DEPLOY_HEALTHY_MS !== "" ? v : 120000;
}

// Is this an answer of /api/runs/active? An error body (`{ error }` — the dispatcher answers a throw with 500 and JSON, `curl -sS`
// without `-f` passes it through), an array or an object without `busy` is NOT: `{ error: "database is locked" }` would count as
// idle (`busy` missing ⇒ falsy) and as "backend before the relocation field" (restoreInner would start every inner container, also
// those a relocation had taken over). Unknown is not free.
export function isRunsResponse(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x) && !("error" in x) && typeof x.busy === "boolean";
}

// The answer of /api/runs/active IN a B (via `docker exec`, at B's loopback) or null — the ONE reading; gates.mjs passes it on
// (gate, status, rollback lock), restoreInner asks it before the start. Null also for anything that is no answer of this route
// (`isRunsResponse`).
export async function remoteRuns(container) {
  const r = await sshProbe(
    `docker exec -u agent ${container} curl -sS --max-time 5 http://127.0.0.1:${config.remote.backendPort}/api/runs/active || true`,
  );
  try {
    const x = JSON.parse(r.stdout.trim());
    return isRunsResponse(x) ? x : null;
  } catch {
    return null;
  }
}

// The ops status IN a B (GET /api/projectbox/ops-status at the loopback — from a project network the fence rejects it, it carries
// project names) or null: `{ composeInB, withoutInstanceRow: [{ projectId, name }] }`. An older backend answers 404 with `{ error }` —
// the rows then say "unknown" (lib/project-container.mjs setupRow, composeInBRow).
export async function remoteOpsStatus(container) {
  const r = await sshProbe(
    `docker exec -u agent ${container} curl -sS --max-time ${OPS_STATUS_CURL_MAX_TIME_S} http://127.0.0.1:${config.remote.backendPort}/api/projectbox/ops-status || true`,
  );
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

// ONLY the user's inner containers (`retrievalList`) — a project container (`cbase-p-*`, label `cbase.project`) is fetched back by the
// backend itself after its start (projectbox/restore.js: marker of the network separation, then the stack in the order of
// depends_on). `projects` names what was left out.
// BEFORE the start restoreInner asks the backend of this B which containers a relocation took over (`relocationDeduction`,
// lib/project-container.mjs) — the snapshot `wanted` is from BEFORE the swap (with the `--force` swap and in the settle phase up to
// 150 s). If it does not answer, wait once for health and ask again; if it stays silent, NOTHING starts (unknown is not "no
// relocation"), and the warning names the command by hand. `relocation` names what was left out.
// `beforeSwap` = the answer of /api/runs/active that the idle gate read immediately before the swap of THIS B (targets/server.mjs,
// targets/rollback.mjs: `idleBeforeSwap(…).row.runs`). If the backend stays silent after the swap, this snapshot decides if it
// carries (lib/project-container.mjs relocationDeduction) — otherwise nothing, as before.
export async function restoreInner(name, wanted, { beforeSwap = null } = {}) {
  const projects = partsInner(wanted).projects.map((c) => c.name);
  if (projects.length) log.info(`The backend fetches project containers back itself: ${projects.join(", ")}`);
  if (!retrievalList(wanted).length) return { restored: [], missing: [], projects, relocation: [] };
  let runs = await remoteRuns(name);
  if (!runs && (await waitHealthy(name))) runs = await remoteRuns(name);
  const deduction = relocationDeduction(runs, wanted, { beforeSwap });
  const relocation = deduction.omitted.map((a) => a.name);
  if (deduction.beforeE) log.detail("Backend without the field `relocationContainer` (knows no relocation) — all inner containers back");
  if (deduction.snapshot) log.warn(`${name}: backend silent after the swap — the answer from before the swap applies (no relocation in progress, fingerprints known)`);
  if (relocation.length) {
    log.warn(`inner containers NOT fetched back: ${deduction.omitted.map((a) => `${a.name} — ${a.reason}`).join("; ")}`);
    if (!runs) log.warn(`by hand, if surely no relocation took them over: ssh ${config.ssh.host} docker exec -u agent ${name} docker start ${relocation.join(" ")}`);
  }
  const list = deduction.start;
  if (!list.length) return { restored: [], missing: [], projects, relocation };
  log.info(`fetching inner containers back: ${list.join(", ")}`);
  await sshAct(
    `docker exec -u agent ${name} docker start ${list.join(" ")} >/dev/null 2>&1 || true`,
  );
  await sleep(3000);
  const now = await sshProbe(`docker exec -u agent ${name} docker ps --format '{{.Names}}' || true`);
  const up = new Set(now.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const missing = list.filter((n) => !up.has(n));
  if (missing.length) log.warn(`not up again: ${missing.join(", ")}`);
  else log.ok(`all ${list.length} inner containers run again`);
  return { restored: list.filter((n) => up.has(n)), missing, projects, relocation };
}

// The gateway can replace the freshly created container within seconds. So look once more and, if needed, fetch the inner containers back a second time.
export async function settle(name, createdAfterSwap, inner, seconds = 150) {
  await settleMany([{ name, created: createdAfterSwap, inner }], seconds);
}

// Settle watching over SEVERAL containers in ONE time budget. Waiting sequentially would multiply the wait by the number of containers
// although the risk is the same: the gateway replaces containers from `:latest` by itself, and the user's inner containers then stay
// down if nobody fetches them back.
export async function settleMany(entries, seconds = 150) {
  const list = (entries || []).filter((e) => e?.name);
  if (!seconds || !list.length) return;
  log.info(`Settle watch ${seconds}s over ${list.length} container(s) (the gateway sometimes replaces them itself) …`);
  const until = Date.now() + seconds * 1000;
  const state = list.map((e) => ({ ...e, replaced: false }));
  while (Date.now() < until) {
    await sleep(15000);
    for (const e of state) {
      const insp = await inspectContainer(e.name);
      if (!insp) {
        log.warn(`${e.name} has just vanished — the gateway is probably recreating it.`);
        continue;
      }
      if (insp.Created === e.created) continue;
      e.replaced = true;
      e.created = insp.Created;
      log.warn(`The gateway replaced ${e.name} (Created ${insp.Created}).`);
      await waitHealthy(e.name);
      await restoreInner(e.name, e.inner?.running || []);
    }
  }
  const hit = state.filter((e) => e.replaced);
  if (!hit.length) log.ok("Containers unchanged (no silent replacement).");
}

// Tree hash IN the container — the same recipe as treeSha() locally (asar.mjs), as a shell line via stdin to `sh -s`: so the quotes of
// the recipe stay untouched, no matter how many shells (ssh → bash -s → docker exec → sh) lie in between.
export async function remoteTreeSha(container, dir = "/app/electron/server") {
  const r = await sshProbe(
    `docker exec -i -u agent ${container} sh -s <<'HEXEOF' 2>/dev/null || true\n${treeShaShell(dir)}\nHEXEOF`,
  );
  return r.stdout.trim().split(/\s+/)[0] || null;
}
