// Roll back to the previous state.
//
// Server: without `--to` the target is the release that was active BEFORE `current` (activation history in lib/release.mjs — never
// the newest in stock: `./deploy web` and a server deploy that failed before repointing create releases that were never active;
// without a known predecessor the rollback aborts and names `--to`). Target image (candidate tag or newly built), swap the
// containers (through swapContainer like the deploy, with swapVerdict), THEN repoint `:latest` and `current` to the previous
// release, last inside every B `cbase-projectbox:latest` to the candidate of the target release (lib/projectbox-distribution.mjs;
// if it is cleaned up it is built from the release like the backend and checked). The user volume (`/home/agent`) stays
// untouched — a rollback concerns code, not data. Database migrations therefore do NOT go back; if a migration changed the
// schema, the old code may no longer be compatible.
// Rollback block (lib/capabilities.mjs): if the target release does not know the relocation (`backend/capabilities.json`), the
// rollback refuses per B with converted projects, a relocation in progress or an unknown number — before the image build, after
// the idle gate and per B right before its swap. `--force` does NOT override it; only `--rollback-without-relocation` overrides
// unknown relocation numbers, `--rollback-without-copy` those of the copies, a known one never. The copy count of a stopped or
// silent B is read by a throwaway container from the database in the home volume (copiesReadingCommand) — without `docker exec`.
// Further axes, each with its own switch and never `--force`: `episodes-per-workspace` (a source id in two workspaces — their start
// failed on the old unique index; `--rollback-without-episodes`), `lfs` (the git-lfs hooks in the repos of the project containers
// would break push, checkout and `git worktree add`; no number, only "unknown"; `--rollback-without-lfs`), `layout` (a layout
// under rebuild; `--rollback-without-layout`), `instance-stopped` (a stopped instance or one being stopped;
// `--rollback-without-instance-stopped`), `bridge-cbp` (converted projects whose networks carry the bridge `cbp-<n>` — an older
// entry.sh guards only the old prefix; `--rollback-without-bridge-cbp`).
// Local (only the client now): push back the bundle put aside at every deploy.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { act, isDryRun, probe, waitFor } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "../lib/ssh.mjs";
import { currentRelease, historyRead, listReleases, pointCurrent, predecessor } from "../lib/release.mjs";
import { containerSpec, imageEnv, readImageId, inspectContainer, restoreInner, waitHealthy } from "../lib/remote.mjs";
import { innerContainers, idleBeforeSwap, remoteContainers, remoteGate, remoteRuns } from "../lib/gates.mjs";
import { CAPABILITIES_FILE, capabilitiesFrom, missingCopyStage, copiesFromReading, copiesReadingCommand, copiesCount, rollbackLock, lockRuling, lockChecks, lockSet } from "../lib/capabilities.mjs"; // rollback block, copies
import { episodesFromReading, episodesReadingCommand, episodesMultipleCount, episodesChecks, episodesLock, episodesLockSentence } from "../lib/capabilities.mjs"; // episodes axis
import { lfsChecks, lfsLock, lfsLockSentence } from "../lib/capabilities.mjs"; // git-lfs axis
import { layoutFromReading, layoutReadingCommand, layoutChecks, layoutLock, layoutLockSentence, layoutsOpenCount } from "../lib/capabilities.mjs"; // layout axis
import { instanceStoppedFromReading, instanceStoppedReadingCommand, instanceStoppedChecks, instanceStoppedLock, instanceStoppedLockSentence, instancesStoppedCount } from "../lib/capabilities.mjs"; // instance-stopped axis
import { bridgeFromReading, bridgeReadingCommand, bridgeChecks, bridgeLock, bridgeLockSentence, convertedCount } from "../lib/capabilities.mjs"; // bridge axis
import { retrievalList } from "../lib/project-container.mjs"; // project containers
import { swapContainer } from "./server.mjs"; // the same swap as in the deploy (swapScript + swapVerdict)
import { specWithLimits } from "../lib/limits.mjs"; // the limits as in the deploy
import { limitsAfterSwap, limitsBeforeSwap } from "../lib/limits-swap.mjs";
import { distributeProjectbox } from "../lib/projectbox-distribution.mjs";
import { readProjectboxExpectation, projectboxBuildCommand, projectboxCand, projectboxHostProbe, projectboxVerdict } from "../../check/lib/projectbox.mjs";
import { confirm } from "../lib/prompt.mjs";
import { BUILD_THROTTLE, throttleBuild } from "../lib/build-throttle.mjs";
import * as log from "../../check/lib/log.mjs";
import { loginRetreat, retreatFailedFrom, retreatRow } from "../lib/login-retreat.mjs";

export async function rollback(what, { to = null, force = false, withoutRelocation = false, withoutCopy = false, withoutEpisodes = false, withoutLfs = false, withoutLayout = false, withoutInstanceStopped = false, withoutBridge = false } = {}) {
  if (what === "server") return rollbackServer({ to, force, withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge });
  if (what === "client") return rollbackApp(config.local.clientApp, config.local.clientAppName, "cbase Client.app.previous-", to);
  throw new Error(`Rollback for "${what}" does not exist (server | client).`);
}

async function rollbackServer({ to, force, withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge }) {
  log.step("Server-Rollback");
  const cur = await currentRelease();
  const all = await listReleases();
  // Without --to the release that was active BEFORE current — from the activation history that pointCurrent keeps
  // (lib/release.mjs). A "newest in stock ≠ current" would run "forward" after `./deploy web` or a server deploy that failed
  // before repointing: it would take over a rejected candidate as "checked" or build it without an image check, and point
  // `:latest` at it. Unknown ⇒ abort.
  const before = to ? null : predecessor(await historyRead(), cur);
  const target = to || before.release;
  if (!target) {
    throw new Error(`Rollback without --to refused: which release was active before ${cur || "?"} is unknown — ${before.reason}. ` +
      `Nothing was swapped or repointed. Name the target explicitly: ./deploy rollback server --to <release> (in stock: ${all.join(", ") || "none"}).`);
  }
  if (!all.includes(target)) {
    throw new Error(`Release ${target} does not exist (${all.join(", ")})${to ? "" : ` — it was active before ${cur} but is cleaned up; name a release in stock with --to`}.`);
  }
  log.info(`${cur} → ${target}${to ? " (--to)" : " (the release that was active before)"}`);
  log.warn("Database migrations do NOT roll back — check beforehand when the schema changed.");

  await confirm(`Reset the server to release ${target}?`);

  // The rollback block FIRST — it needs only ssh and /api/runs/active. Otherwise the image rebuild (up to 30 min) ran first,
  // and a refusal afterwards left the tag `rollback-<r>` lying around.
  const lock = await rollbackLockCheck({ target, withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge });

  // NOTHING is repointed — neither `current` nor `:latest` — before every B is swapped together with its login retreat.
  // Otherwise both were repointed before the gate: an abort afterwards (gate, failed retreat) left `:latest` on the old state,
  // and the gateway would eventually create B from it — without login. So first the target image and ITS environment; the swap
  // uses the target image itself, repointing comes after.
  //
  // The image of this release usually still exists as a candidate tag — exactly the image that was checked back then; for the
  // predecessor (target without --to) always, as long as it is among the three youngest activations (pruneCandidates protects
  // their candidates). Otherwise (only a `--to` further back) it is built from the tree of the release (not from `current/`,
  // which still stands on the current state here) — this image has not passed the image check of the deploy.
  const img = config.remote.image;
  const cand = `${img}:cand-${target}`;
  // Unknown is not "missing": an unreadable candidate would otherwise be rebuilt for up to 30 min — and swapped unchecked.
  const candReading = await readImageId(cand);
  if (candReading.unknown) throw new Error(`Candidate image ${cand} not readable (${candReading.unknown}) — nothing was swapped or repointed.`);
  const haveCand = candReading.id ? "yes" : "no";
  let targetItem = cand;
  if (haveCand === "yes") {
    log.info(`checked image ${cand} is reused`);
  } else {
    targetItem = `${img}:rollback-${target}`;
    log.info("no candidate image left — rebuilt from the release");
    await sshAct(
      `cd ${config.remote.root} && ${BUILD_THROTTLE} docker build -t ${targetItem} -f releases/${target}/backend/Dockerfile releases/${target}/backend`,
      { timeout: 1800000 },
    );
  }
  const targetEnv = await imageEnv(targetItem);
  // If the target lacks the shared login, it is copied back per B to ~/.claude and the variable is not passed
  // (lib/login-retreat.mjs) — without `docker exec`, so also for a B that is not running or does not answer.
  const retreat = loginRetreat(targetEnv);
  if (retreat.needed) log.warn(retreat.reason);

  // Like the rollout: ALL user containers, not only the first (`:latest` applies to each). For the retreat also those that
  // stand: the gateway starts them with their image, and if it replaces one from `:latest`, the login would be missing there.
  const containers = await remoteContainers();
  const stopped = retreat.needed ? (await allUserContainer()).filter((c) => !containers.includes(c)) : [];
  // If the lock aborts before a B is swapped, the auxiliary tag of a rebuild goes away again (it never carried `:latest`).
  const auxTagWay = async () => {
    if (targetItem !== cand) await sshAct(`docker rmi ${targetItem} >/dev/null 2>&1 || true`, { check: false });
  };
  // The id of the target image — swapVerdict takes over a gateway container only with THIS image (the gateway creates from
  // `:latest`, which in the rollback still stands on the current state). Unreadable ⇒ abort before any swap (in a dry run
  // a target still to be built does not exist yet).
  const targetImage = await readImageId(targetItem);
  if (!targetImage.id && !isDryRun()) {
    await auxTagWay();
    throw new Error(`Image id of the target ${targetItem} not readable (${targetImage.unknown || "missing"}) — nothing was swapped or repointed.`);
  }
  const inner = containers.length ? await remoteGate({ force, containers }) : new Map();
  // The rollback block (lib/capabilities.mjs): AFTER the idle gate (a B that does not answer stops there already) and BEFORE
  // every swap, copy and repointing — if the target release does not know the relocation, no B with converted projects, a
  // relocation in progress (or an unknown number) may go back. Once more, because the build takes time in between: a relocation
  // may have started since the first check.
  await rollbackLockCheck({ target, containers, withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge, known: lock.known, beforeAbort: auxTagWay });
  const insps = new Map();
  for (const c of [...containers, ...stopped]) insps.set(c, await inspectContainer(c));
  const specs = new Map();
  // The env against B's OWN image (lib/remote.mjs containerSpec), not against the target — otherwise the rollback would pin
  // every row the target knows differently or not at all with the value of the bad state as `-e`.
  try {
    for (const c of containers) specs.set(c, retreat.spec(await containerSpec(insps.get(c))));
  } catch (e) {
    await auxTagWay();
    throw e;
  }
  // Every B whose login retreat failed with --force — it stands in the verdict at the end, not only on stderr (only the log
  // saw it there, the console said "Server on release …"). Also the B for which the retreat is not feasible at all
  // (`k.missing` — no home volume, login directory outside, unsafe characters): with --force it stands without login on the
  // target just the same.
  const retreatFailed = [];
  const copies = new Map();
  for (const c of [...containers, ...stopped]) {
    const k = retreat.copy(insps.get(c), targetItem);
    if (k?.missing) {
      if (!force) throw new Error(`Login retreat not feasible — ${k.missing}. Nothing is repointed; --force rolls back without a copy (Claude would be logged out in the old state).`);
      log.warn(`${k.missing} — --force: without login retreat`);
      if (!retreatFailed.includes(c)) retreatFailed.push(c);
    } else if (k) copies.set(c, k.command);
  }
  if (containers.length) {
    await confirm(`Recreate ${containers.join(", ")} (rollback)?`, {
      // only the user's — project containers are brought back by the backend itself (restoreInner leaves them out).
      consequence: `${containers.reduce((n, c) => n + retrievalList(inner.get(c)?.running || []).length, 0)} inner containers are brought back afterwards.`,
    });
  }
  for (const c of stopped) {
    if (!copies.has(c)) continue;
    log.info(`${c} is stopped — login retreat without swap`);
    const r = await sshAct(copies.get(c), { check: false });
    if (r.code !== 0 && !force) throw new Error(`${c}: login retreat failed (exit ${r.code}) — nothing is repointed; --force overrides.`);
    if (r.code !== 0 && !r.skipped) {
      log.warn(`${c}: login retreat failed (exit ${r.code}) — --force`);
      retreatFailed.push(c);
    }
  }
  const swapped = [];
  const beforeSwap = new Map(); // per B the /api/runs/active answer that the idle gate read before ITS swap
  // The B whose login retreat failed — the swap script stopped it (`stop -t 60`) and started the retreat row again
  // (lib/login-retreat.mjs); its inner containers without a restart policy stayed down. It is brought back like a swapped one, even if it is the FIRST.
  let halted = null;
  try {
    for (const c of containers) {
      // Per B right before ITS swap — the question above can stand for any length of time, and a relocation that starts in
      // this time would stay half-done under the target. Only if the target does not know the relocation (otherwise without ssh).
      await rollbackLockCheck({
        target, containers: [c], withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge, known: lock.known, withStopped: false,
        beforeAbort: swapped.length ? null : auxTagWay,
        postscript: swapped.length ? ` Already on ${target}: ${swapped.join(", ")} — current and :latest are NOT repointed.` : "",
      });
      // Also the idleness per B right before ITS swap (lib/gates.mjs idleBeforeSwap; the rollback has no --wait, --force swaps
      // anyway) — the gate above applied to the state before the question and before the first swap.
      const before = await idleBeforeSwap(c, { force });
      if (!before.swap) {
        if (!swapped.length) await auxTagWay();
        throw new Error(`${c}: ${before.reason} — again later or \`--force\`.${swapped.length ? ` Already on ${target}: ${swapped.join(", ")} — current and :latest are NOT repointed.` : " Nothing is repointed."}`);
      }
      beforeSwap.set(c, before.row?.runs ?? null);
      // stop -t 60 before rm -f; the retreat between the two (lib/swap.mjs `beforeRemove`). Through swapContainer —
      // the same swapScript (guarded by the maintainer's private suite) and the same swapVerdict as in the deploy (gateway race: clear away, recreate).
      const beforeRemove = copies.has(c) ? retreatRow({ command: copies.get(c), container: c, force }) : "";
      // As in the deploy the limits from resources-desired.json, ONE ssh right before this swap (lib/limits-swap.mjs) — not from
      // the inspect from before the question; without a stored value as before.
      const limits = await limitsBeforeSwap(insps.get(c));
      const r = await swapContainer(c, specWithLimits(specs.get(c), limits.args), targetImage.id || null, { image: targetItem, beforeRemove });
      if (r.retreatExit) {
        halted = c;
        throw new Error(`${c}: login retreat failed — ${c} runs again on the current state; current and :latest are NOT repointed` +
          `${swapped.length ? ` (already on ${target}: ${swapped.join(", ")})` : ""}. --force rolls back without a copy.`);
      }
      for (const x of retreatFailedFrom(r.stdout)) if (!retreatFailed.includes(x)) retreatFailed.push(x);
      swapped.push(c);
      // …and right after, against the new B (a save during the swap hit the old one). Never throws, reports itself.
      if (!isDryRun()) await limitsAfterSwap(c);
    }
  } catch (e) {
    // If the loop aborts AFTER a swap (the next B busy, locked, its swap or retreat failed), the B already swapped stood
    // without their inner containers — restoreInner ran only after the loop. Now per swapped B health and retrieval, result per
    // B in the text. `:latest` and `current` deliberately stay as they are (swap first, then repoint — see above). Plus the B
    // whose login retreat failed (see `halted`).
    const restore = [...swapped, ...(halted ? [halted] : [])];
    if (restore.length && !isDryRun()) e.message += await retrieveAfterAbort(restore, inner, beforeSwap);
    throw e;
  }

  // Only now repoint: `:latest` (the gateway creates from it) and `current`.
  await sshAct(`docker tag ${targetItem} ${img}:latest`);
  if (targetItem !== cand) await sshAct(`docker rmi ${targetItem} >/dev/null 2>&1 || true`); // only the auxiliary tag, the image carries :latest
  await pointCurrent(target);

  // The UI from the snapshot of the same release — without --delete, as when rolling out.
  const hasWeb = (await sshProbe(`test -d ${config.remote.root}/releases/${target}/web-out && echo yes || echo no`)).stdout.trim();
  if (hasWeb === "yes") {
    await sshAct(`rsync -r --checksum ${config.remote.root}/releases/${target}/web-out/ ${config.remote.root}/web-out/`);
    log.ok("Web UI restored from the release snapshot");
  }

  if (!containers.length) {
    log.warn("No running container — the gateway starts a stopped one with its image or creates a new one from the old.");
    retreatVerdict(retreatFailed, target);
    return { loginRetreatFailed: retreatFailed };
  }
  // Inside, `cbase-projectbox:latest` back to the candidate of the target release — the same distribution as when rolling out
  // (if the id is already inside, no stream; start probe before the tag). ONLY HERE: every B is swapped, healthy and has its inner
  // containers back (restoreInner), `:latest` and `current` of the host are repointed (swap first, then repoint). Before, an
  // abort (gate, login retreat) would have left a B on the new backend with the old project box, and the probe would run next to
  // the returning stacks. Stopped B keep theirs (no `docker exec`). If the target release knows no project box (no host
  // candidate), everything inside stays as it is — a warning, in the real run as in the dry run. A failure in one B holds back
  // only its tag and does not throw: the rollback of the backend is done at this point (a second `rollback server` would go
  // one release FURTHER back, not onto this one). Also when a B did not become healthy — otherwise the first unhealthy B would
  // throw at once, the others would not get their inner containers back and the project box would stay the new one everywhere.
  // If the candidate is missing because it is cleaned up (pruneCandidates keeps per image the candidates of the three youngest
  // activations and two more, five releases remain — a `--to` further back does not find it), it is built like the
  // backend from the tree of the target release and checked (projectboxForRollback).
  const projectbox = async () => {
    const build = await projectboxForRollback(target);
    if (!build.further) return null;
    return distributeProjectbox({ containers, release: target, cause: "Rollback", candidateGetsBuilt: build.built && isDryRun() });
  };
  if (isDryRun()) {
    await projectbox();
    return {};
  }
  // Work through every B, collect errors — thrown only after the project box.
  const unhealthy = [];
  for (const c of containers) {
    try {
      if (!(await waitHealthy(c))) {
        unhealthy.push(`${c} did not become healthy`);
        continue;
      }
      await restoreInner(c, inner.get(c)?.running || [], { beforeSwap: beforeSwap.get(c) ?? null }); // "not up again" warns there, as in the deploy
    } catch (e) {
      unhealthy.push(`${c}: ${e.message}`);
    }
  }
  let back = 0;
  for (const c of containers) back += retrievalList((await innerContainers(c)).running).length; // without project containers
  if (!unhealthy.length) log.ok(`Server on release ${target} (${containers.length} containers, inner: ${back})`);
  await projectbox();
  retreatVerdict(retreatFailed, target);
  if (unhealthy.length) {
    throw new Error(`Server switched to release ${target} (current, :latest), but not every container is through: ${unhealthy.join("; ")}. ` +
      `Logs: ssh ${config.ssh.host} docker logs <name> | tail -50. Another \`rollback server\` would go one release FURTHER back.`);
  }
  return { loginRetreatFailed: retreatFailed };
}

// The verdict on the login retreat — one row if it failed with --force (nothing if everything is copied).
function retreatVerdict(failed, target) {
  if (!failed.length) return;
  log.table([["Login retreat", `FAILED (--force) for ${failed.join(", ")} — Claude is logged out there on ${target}: log in again or deploy forward`, "bad"]]);
  log.warn(`Rollback to ${target} with --force: login retreat failed for ${failed.join(", ")}.`);
}

// Bring back the inner containers of the already swapped B after an abort of the swap loop (the same steps as after a full
// swap: waitHealthy, restoreInner with the snapshot of the gate) — also the B whose login retreat failed (stopped and started
// again, on the current state). Does not throw — the abort itself is the error; what comes back is the addition for its text:
// "inner containers brought back: …" / "not brought back: …".
async function retrieveAfterAbort(swapped, inner, beforeSwap) {
  const back = [];
  const not = [];
  for (const c of swapped) {
    try {
      if (!(await waitHealthy(c))) { not.push(`${c} (backend not healthy)`); continue; }
      const r = await restoreInner(c, inner.get(c)?.running || [], { beforeSwap: beforeSwap.get(c) ?? null });
      if (r.restored.length) back.push(`${c}: ${r.restored.join(", ")}`);
      const missing = [...r.missing, ...r.relocation];
      if (missing.length) not.push(`${c}: ${missing.join(", ")}`);
      if (!r.restored.length && !missing.length) back.push(`${c}: none`);
    } catch (f) {
      not.push(`${c} (${f.message})`);
    }
  }
  return `${back.length ? ` Inner containers brought back: ${back.join("; ")}.` : ""}${not.length ? ` Not brought back: ${not.join("; ")}.` : ""}`;
}

// The project box candidate of the target release. pruneCandidates (targets/server.mjs) keeps per image the running one and the two
// youngest candidates (plus always those of the three youngest activations — the predecessor of a rollback without --to has
// its own), keepReleases five releases: a rollback onto the third to fifth oldest found the backend image (it is rebuilt above)
// but not the project box — inside the NEWER one stayed under the older backend.
// If the candidate is missing and the Dockerfile of the target release knows the stage `projectbox`, it is built like when
// rolling out (`--target projectbox` from releases/<target>/backend) and checked with the SAME host probe, the expectation from
// THAT Dockerfile (not from the working tree — the pins can differ). If it does not pass, it goes away again (an unchecked
// candidate would otherwise lie ready at the next rollback). Nothing here throws. Returns { further, built }:
// `further` false ⇒ do not distribute (the warning is already there); `built` ⇒ in a dry run the candidate does not exist yet.
async function projectboxForRollback(target) {
  const pbCand = projectboxCand(target, config.remote.projectboxImage);
  const host = await readImageId(pbCand);
  if (!host.missing) return { further: true, built: false }; // there — or not readable: the distribution reports that
  const df = await sshProbe(`cat ${config.remote.root}/releases/${target}/backend/Dockerfile 2>/dev/null || true`);
  let expectation;
  try {
    expectation = readProjectboxExpectation(df.stdout);
  } catch (e) {
    log.detail(`Target release ${target} builds no project box (${e.message}) — no rebuild`);
    return { further: true, built: false };
  }
  log.step("Build the project box of the target release (its candidate is cleaned up)");
  const r = await sshAct(throttleBuild(projectboxBuildCommand({ root: config.remote.root, release: target, cand: pbCand })), { timeout: 1800000, check: false });
  if (r.skipped) {
    log.cmdLine(`[dry] ssh ${config.ssh.host} <<'EOF' (project box check)\n${projectboxHostProbe(pbCand)}\nEOF`);
    return { further: true, built: true };
  }
  const inside = "inside, cbase-projectbox:latest stays as it is";
  if (r.code !== 0) {
    log.warn(`Project box build of the target release ${target} failed (exit ${r.code}) — nothing distributed; ${inside}.`);
    return { further: false, built: false };
  }
  const verdict = projectboxVerdict((await sshProbe(projectboxHostProbe(pbCand))).stdout, expectation);
  log.table(verdict.rows);
  if (!verdict.ok) {
    await sshAct(`docker rmi ${pbCand} >/dev/null 2>&1 || true`, { check: false });
    log.warn(`Project box check of the target release ${target} failed — ${pbCand} removed again, nothing distributed; ${inside}.`);
    return { further: false, built: false };
  }
  return { further: true, built: true };
}

// The rollback block: read `backend/capabilities.json` of the TARGET release like its Dockerfile (if it is missing, the release
// knows nothing; `known` can be passed in by an earlier call); only if its `relocation` or a stage of the copy is missing, ask per B
// for the numbers from /api/runs/active — the running ones via `docker exec`, the stopped ones are "unknown" (never 0). If the
// target release lacks a stage of the copy and the answer carries no `copies` number (stopped, silent, backend without the
// field), `copiesFromVolume` reads it from the database in the home volume — without `docker exec`.
// `containers` missing ⇒ list the running ones itself (the check BEFORE the build). Blocked ⇒ throw BEFORE anything is swapped or
// repointed (`beforeAbort` cleans up the auxiliary tag of a rebuild); `--rollback-without-relocation` overrides ONLY unknown
// relocation numbers, `--rollback-without-copy` ONLY those of the copies, with a message; `--force` does not occur here.
// Every further axis (episodes, lfs, layout, instance-stopped, bridge-cbp) asks the B the same way — the
// same answer, the same reading from the volume, a verdict of its own in the same lock ruling, its own switch that overrides
// only its unknown numbers (lfs has no number, the B are only listed — without any other axis
// asking, `/api/runs/active` is skipped). The lfs sentence stands in the throw only if IT also blocks (without
// `--rollback-without-lfs`) — otherwise it would name a way out that is already chosen.
// Returns: `{ known, verdict }`.
async function rollbackLockCheck({ target, containers = null, withoutRelocation = false, withoutCopy = false, withoutEpisodes = false, withoutLfs = false, withoutLayout = false, withoutInstanceStopped = false, withoutBridge = false, known = null, withStopped = true, beforeAbort = null, postscript = "" }) {
  if (!known) {
    const text = (await sshProbe(`cat ${config.remote.root}/releases/${target}/${CAPABILITIES_FILE} 2>/dev/null || true`)).stdout;
    const f = capabilitiesFrom(text);
    if (f.notice) log.detail(`Target release ${target}: ${f.notice}`);
    known = f.known;
  }
  const bs = [];
  const episodesCounts = episodesChecks(known); // episodes axis: `episodes-per-workspace` missing
  const layoutCounts = layoutChecks(known); // layout axis: `layout` missing
  const stoppedCounts = instanceStoppedChecks(known); // instance-stopped axis: `instance-stopped` missing
  const bridgeCounts = bridgeChecks(known); // bridge axis: `bridge-cbp` missing
  const countsQuestions = lockChecks(known) || episodesCounts || layoutCounts || stoppedCounts || bridgeCounts; // relocation or a copy stage missing
  const lfsCounts = lfsChecks(known); // lfs missing — the B are only listed
  if (countsQuestions || lfsCounts) {
    const copyCounts = missingCopyStage(known);
    const running = containers ?? (await remoteContainers());
    for (const c of running) {
      const runs = countsQuestions ? await remoteRuns(c) : null;
      bs.push({
        name: c, runs, stopped: false,
        copiesReading: copyCounts && copiesCount(runs) === null ? await copiesFromVolume(c) : null,
        episodesReading: episodesCounts && episodesMultipleCount(runs) === null ? await episodesFromVolume(c) : null,
        layoutReading: layoutCounts && layoutsOpenCount(runs) === null ? await layoutFromVolume(c) : null,
        instanceStoppedReading: stoppedCounts && instancesStoppedCount(runs) === null ? await instanceStoppedFromVolume(c) : null,
        bridgeReading: bridgeCounts && convertedCount(runs) === null ? await bridgeFromVolume(c) : null,
      });
    }
    if (withStopped) {
      for (const c of await allUserContainer()) {
        if (!running.includes(c)) {
          bs.push({
            name: c, runs: null, stopped: true,
            copiesReading: copyCounts ? await copiesFromVolume(c) : null,
            episodesReading: episodesCounts ? await episodesFromVolume(c) : null,
            layoutReading: layoutCounts ? await layoutFromVolume(c) : null,
            instanceStoppedReading: stoppedCounts ? await instanceStoppedFromVolume(c) : null,
            bridgeReading: bridgeCounts ? await bridgeFromVolume(c) : null,
          });
        }
      }
    }
  }
  const verdict = rollbackLock({ known, bs, target: target });
  const episodes = episodesLock({ known, bs, target: target });
  const lfs = lfsLock({ known, bs, target: target });
  const layout = layoutLock({ known, bs, target: target });
  const stopped = instanceStoppedLock({ known, bs, target: target });
  const bridge = bridgeLock({ known, bs, target: target });
  log.table([...verdict.rows, ...episodes.rows, ...lfs.rows, ...layout.rows, ...stopped.rows, ...bridge.rows]);
  const { further, warning } = lockRuling({ locks: [...verdict.locks, ...episodes.locks, ...lfs.locks, ...layout.locks, ...stopped.locks, ...bridge.locks] }, { withoutRelocation, withoutCopy, withoutEpisodes, withoutLfs, withoutLayout, withoutInstanceStopped, withoutBridge });
  if (!further) {
    if (beforeAbort) await beforeAbort();
    const sets = [verdict.locks.length ? lockSet(verdict.locks, target, known) : "", episodes.locks.length ? episodesLockSentence(episodes.locks, target) : "",
      lfs.locks.length && !withoutLfs ? lfsLockSentence(lfs.locks, target) : "", layout.locks.length ? layoutLockSentence(layout.locks, target) : "",
      stopped.locks.length ? instanceStoppedLockSentence(stopped.locks, target) : "", bridge.locks.length ? bridgeLockSentence(bridge.locks, target) : ""];
    throw new Error(`Rollback block: ${sets.filter(Boolean).join(". ")}.${postscript || " Nothing was swapped or repointed."}`);
  }
  if (warning) log.warn(warning);
  return { known, verdict };
}

// The number of live copies of a B from the database in its home volume — a throwaway container from B's own image, the volume
// read-only, without network and without `docker exec` (lib/capabilities.mjs copiesReadingCommand). Also runs in a dry run
// (sshProbe — it changes nothing). → `{ count, reason }` (copiesFromReading); does not throw.
async function copiesFromVolume(c) {
  const l = copiesReadingCommand(await inspectContainer(c));
  if (l.missing) return { count: null, reason: l.missing };
  const r = await sshProbe(l.command);
  return copiesFromReading(r.stdout, r.stderr);
}

// The number of source ids in two workspaces from the same database, with the same throwaway container (only another program,
// lib/capabilities.mjs episodesReadingCommand). → `{ count, reason }` (episodesFromReading); does not throw.
async function episodesFromVolume(c) {
  const l = episodesReadingCommand(await inspectContainer(c));
  if (l.missing) return { count: null, reason: l.missing };
  const r = await sshProbe(l.command);
  return episodesFromReading(r.stdout, r.stderr);
}

// The number of layouts under rebuild from the same database, with the same throwaway container (only another program,
// lib/capabilities.mjs layoutReadingCommand). → `{ count, reason }` (layoutFromReading); does not throw.
async function layoutFromVolume(c) {
  const l = layoutReadingCommand(await inspectContainer(c));
  if (l.missing) return { count: null, reason: l.missing };
  const r = await sshProbe(l.command);
  return layoutFromReading(r.stdout, r.stderr);
}

// The number of stopped (and being-stopped) instances from the same database, with the same throwaway container
// (lib/capabilities.mjs instanceStoppedReadingCommand). → `{ count, reason }` (instanceStoppedFromReading); does not throw.
async function instanceStoppedFromVolume(c) {
  const l = instanceStoppedReadingCommand(await inspectContainer(c));
  if (l.missing) return { count: null, reason: l.missing };
  const r = await sshProbe(l.command);
  return instanceStoppedFromReading(r.stdout, r.stderr);
}

// The number of converted projects from the same database, with the same throwaway container (lib/capabilities.mjs
// bridgeReadingCommand) — the eighth axis. → `{ count, reason }` (bridgeFromReading); does not throw.
async function bridgeFromVolume(c) {
  const l = bridgeReadingCommand(await inspectContainer(c));
  if (l.missing) return { count: null, reason: l.missing };
  const r = await sshProbe(l.command);
  return bridgeFromReading(r.stdout, r.stderr);
}

// Also the stopped user containers (`docker ps -a`) — for the login retreat.
async function allUserContainer() {
  const r = await sshProbe(`docker ps -a --filter name=${config.remote.containerPrefix} --format '{{.Names}}'`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function rollbackApp(app, appName, prefix, to) {
  log.step(`Rollback ${appName}`);
  const dir = config.local.backups;
  const items = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort() : [];
  const pick = to ? items.find((n) => n.endsWith(to)) : items[items.length - 1];
  if (!pick) throw new Error(`No backup in ${dir} (prefix ${prefix}).`);
  const src = path.join(dir, pick);
  log.info(`back to ${pick}`);

  await confirm(`Reset ${appName} to ${pick}?`);
  await act("osascript", ["-e", `quit app "${appName}"`], { check: false });
  await waitFor(async () => !fs.existsSync(app) || !(await isRunning(app)), { timeoutMs: 60000, label: "the quit" });
  if (fs.existsSync(app)) await act("rm", ["-rf", app]);
  await act("ditto", [src, app]);
  await act("open", ["-a", app]);
  if (isDryRun()) return;
  log.ok(`${appName} reset`);
}

async function isRunning(app) {
  const r = await probe("pgrep", ["-f", `${app}/Contents/MacOS/`]);
  return !!r.stdout.trim();
}
