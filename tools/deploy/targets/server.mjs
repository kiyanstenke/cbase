// Server backend: compute the project box state → fill the release → CHECK the release folder against that state → build the image →
// CHECK the image → build the project box, check it (with sha256 of entry and wrapper against the state) and prepare it in every B →
// repoint → swap containers → bring the inner containers back → look twice. (The source of the project box comes from the
// bytes BEFORE the upload; if the release folder deviates, nothing is built.)
//
// The order is not cosmetic. Building and checking happen WHILE the old container keeps
// running; only afterwards does the swap cost any downtime. And the IMAGE is checked, not the
// source tree: a build from the wrong context once produced an image without Chromium (2.63
// instead of 3.38 GB) — the agent's browsing would have been broken without any exit code saying so.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO, config } from "../config.mjs";
import { BUILD_CONTEXT_FILES } from "../../check/lib/build-context.mjs";
import { isDryRun, sleep } from "../../check/lib/sh.mjs";
import { rsyncUp, sshAct, sshProbe } from "../lib/ssh.mjs";
import { HISTORY_FILE, ensureRelease, historyRead, pointCurrent, pruneReleases, currentRelease, candidatesToRemove } from "../lib/release.mjs";
import { containerSpec, readImageId, inspectContainer, remoteTreeSha, restoreInner, settleMany, waitHealthy } from "../lib/remote.mjs";
import { treeSha, treeShaShell } from "../../check/lib/asar.mjs";
import { composeInBPostObservation, innerContainers, idleBeforeSwap, projectRetrieval, remoteContainers, remoteGate, waitRemoteIdle } from "../lib/gates.mjs";
import { retrievalList, partsInner } from "../lib/project-container.mjs";
import { confirm } from "../lib/prompt.mjs";
import { BUILD_THROTTLE, throttleBuild } from "../lib/build-throttle.mjs";
import { importPrivate, needsPrivatePart } from "../lib/private-part.mjs";
import { removeScript, runCommand, swapScript } from "../lib/swap.mjs";
import { specWithLimits } from "../lib/limits.mjs";
import { limitsAfterSwap, limitsBeforeSwap } from "../lib/limits-swap.mjs";
import { RETREAT_EXIT } from "../lib/login-retreat.mjs"; // the rollback swaps through swapContainer
import {
  CLONE_IN_BACKEND, PROJECTBOX_FILES, SOURCE_RE, readProjectboxExpectation, projectboxBuildCommand, projectboxFileExpectation, projectboxSourceFiles,
  projectboxSource, projectboxCand, projectboxHostProbe, projectboxVerdict, releaseSourceProbe, releaseSourceVerdict,
} from "../../check/lib/projectbox.mjs";
import { prepareProjectbox, repointProjectbox } from "../lib/projectbox-distribution.mjs";
import { CAPABILITIES_FILE, CAPABILITIES_SOURCE } from "../lib/capabilities.mjs"; // rollback block
import { startStoppedB } from "../lib/stopped-b.mjs"; // step 0: start stopped B before the gate
import { BUILD_JSON } from "../lib/build-stamp.mjs";
import * as log from "../../check/lib/log.mjs";

// The TREE under electron/server — server.js is only the facade. Recipe in asar.mjs, the same for JS (local) and shell (image, container).
const SERVER_DIR = path.join(REPO, "server/backend/electron/server");
const IMAGE_SERVER_DIR = "/app/electron/server";

export async function deployServer({ release, stamp = null, force, wait, settleSeconds, settleBackground = false }) {
  const root = config.remote.root;
  const rel = `${root}/releases/${release}`;

  // ------------------------------------------------------- pin-sync guard
  //
  // A new Claude version rolls out only once the baseline of the workflow tool has been brought along. The guard
  // reads only files — it stands BEFORE any upload and before the image build, and its verdict also appears in a dry run.
  // The guard is private (part of the deploy tool's private remainder, like the baseline); a tree without it says so.
  log.step("Pin-sync guard: Claude pin against the baseline");
  const pinSyncGuard = await importPrivate("lib/pinSync.mjs");
  if (!pinSyncGuard) log.warn(`${needsPrivatePart("The pin-sync guard", "lib/pinSync.mjs")} Skipped.`);
  else {
    const { pinSyncBeforeBuild } = pinSyncGuard;
    const pinSync = pinSyncBeforeBuild(REPO, { force });
    for (const z of pinSync.text.split("\n")) (pinSync.stage === "ok" ? log.ok : pinSync.stage === "warn" ? log.warn : log.fail)(z);
    if (!pinSync.further) throw new Error("Pin jump without a baseline brought along — ./deploy server aborts before the image build (--force overrides).");
  }

  // The state of the project box BEFORE the upload — Dockerfile, sha256 per file of the chain, source. After the upload
  // checkReleaseSource holds the bytes in the release folder against it, the host probe those in the built candidate.
  const projectboxStatus = localProjectboxStatus();

  // ---------------------------------------------------------------- sources
  log.step("Fill server release");
  const before = await currentRelease();
  log.info(`previous release: ${before || "(no)"} → new: ${release}`);
  await ensureRelease(release);

  // Preview deliberately against `current/` (the LIVE state), not against the fresh copy —
  // the question is "what changes compared to what runs".
  const dry = await rsyncUp(`${path.join(REPO, "server/backend/electron")}/`, `${root}/current/backend/electron/`, {
    del: true,
    dryRunOnly: true,
  });
  const deltas = dry.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("sending") && !/^cd\+/.test(l.trim()));
  log.info(`${deltas.length} backend file(s) differ from the running state`);
  for (const d of deltas.slice(0, 15)) log.detail(d);
  if (deltas.length > 15) log.detail(`… and ${deltas.length - 15} more`);

  // Always the WHOLE electron tree: new imports regularly lie in further files
  // (happened with providers/monitor-runtime.js, browsers.js, tunnel.js). Copying single
  // files is the classic way into a half-updated image.
  await rsyncUp(`${path.join(REPO, "server/backend/electron")}/`, `${rel}/backend/electron/`, { del: true });
  // The list lives next to build.sh (server/backend/build-context-files.json): the Dockerfile, the files build.sh stages (among them
  // entrypoint and wrapper of the project box, `cbase-project`, `cbase-git`, `cbase-clone`), the manifest
  // program of the relocation (backend image, /usr/local/bin — the same in B, in the helper and in the project container) and the LFS
  // helper of the agent shells (backend image, /usr/local/bin — mounted read-only into every project container).
  for (const f of BUILD_CONTEXT_FILES) {
    await rsyncUp(path.join(REPO, "server/backend", f), `${rel}/backend/${f}`);
  }
  // Rollback block (lib/capabilities.mjs): what this release knows — in the release tree, NOT in the image; the rollback
  // onto this release reads it over ssh like its Dockerfile. If it is missing there, the release knows nothing.
  await rsyncUp(path.join(REPO, CAPABILITIES_SOURCE), `${rel}/${CAPABILITIES_FILE}`);
  await rsyncUp(`${path.join(REPO, "server/gateway")}/`, `${rel}/gateway/`, { extraExcludes: ["data"] });
  // The build stamp (lib/build-stamp.mjs): next to the release only (the gateway reads it through `current/`). NOT in the build
  // context: a stamp in the image would change it on every deploy and swap every user container even with an unchanged backend.
  // The release folder began as a copy of `current/` — without a stamp of this run the predecessor's is removed, never carried
  // over as if it were this build.
  await placeStamp(stamp, rel, release);
  // What lies in the release folder is the state from before — otherwise the project box would carry a source that is not its own.
  await checkReleaseSource({ rel, projectboxStatus });

  // ------------------------------------------------------------------ image
  //
  // Build under a CANDIDATE tag first, check, and repoint to `:latest` only if the check passes. Otherwise the tag
  // from which the gateway creates a new container at any time by itself points to an unchecked image in the meantime.
  const cand = `${config.remote.image}:cand-${release}`;
  log.step("Build backend image");
  await sshAct(`cd ${root} && ${BUILD_THROTTLE} docker build -t ${cand} -f releases/${release}/backend/Dockerfile releases/${release}/backend`, {
    timeout: 1800000,
  });
  return rollOutAfterBackendBuild({ release, force, wait, settleSeconds, settleBackground, projectboxStatus });
}

// build.json into the release folder — or, without a stamp of this run, the predecessor's out of it.
async function placeStamp(stamp, rel, release) {
  if (!stamp?.file) {
    await sshAct(`rm -f ${rel}/${BUILD_JSON}`);
    return;
  }
  log.info(`build ${stamp.build} → ${BUILD_JSON} of release ${release}`);
  await rsyncUp(stamp.file, `${rel}/${BUILD_JSON}`);
}

// Everything after the backend build, up to the swap: check the backend image → build and check the project box → PREPARE the
// project box in every B (load, start probe) → repoint `:latest` and `current` → swapContainerValue. A function of its own so
// tools/check/projectbox-distribution.test.mjs can drive exactly this sequence against a fake ssh and a fake docker — with a
// verdict that throws and the tag it holds back. deployServer hands over with the same release (text guard "the place in the
// deploy" in projectbox-dockerfile.test.mjs).
export async function rollOutAfterBackendBuild({ release, force, wait, settleSeconds, settleBackground = false, projectboxStatus }) {
  // Mandatory — a missing state is no statement (otherwise the seam would compute the source from the tree only now).
  if (!projectboxStatusValid(projectboxStatus)) throw new TypeError("rollOutAfterBackendBuild: projectboxStatus (localProjectboxStatus BEFORE the upload) is missing or incomplete");
  const root = config.remote.root;
  const cand = `${config.remote.image}:cand-${release}`;
  await checkBackendImage(cand);

  // ------------------------------------------------------------- project box
  //
  // The image of the project containers from the same Dockerfile (stage `projectbox`, the stage `base` comes from the cache of the
  // backend build), on the host ONLY as a candidate — there is no host `:latest`, inside it is repointed after its start probe.
  // Build and probe come BEFORE every tag: if either fails, `cbase-backend:latest` stays untouched and nothing is rolled out.
  // The source as a label — the distribution compares it, not only the id, and the check demands that the label arrived. The
  // source of the state from BEFORE the upload (deployServer held the bytes in the release folder against it), never a new
  // computation from the tree; the host probe holds entry and wrapper in the candidate against the same state.
  const pbCand = projectboxCand(release, config.remote.projectboxImage);
  const { source, imageFiles } = projectboxStatus;
  log.step("Build project box image");
  await sshAct(throttleBuild(projectboxBuildCommand({ root, release, cand: pbCand, source })), { timeout: 1800000 });
  await checkProjectbox({ cand, pbCand, source, files: imageFiles });

  // In two steps: load in every running B and run the start probe BEFORE anything is repointed (lib/projectbox-distribution.mjs).
  // A failure in one B holds back only its tag inside and does not throw; it throws here only if the just built host candidate is
  // missing or not readable — then nothing is repointed yet. Inside it is repointed at the start of swapContainerValue, after the
  // host tag.
  // Step 0: a STOPPED B (the gateway puts B to sleep when idle) is started here — after both image checks, before preparing the
  // project box and thus before the idle gate — and then swapped like every other. Otherwise it would keep the old image
  // (`remoteContainers()` sees only running ones), and the gateway would later start it with old code.
  await startStoppedB();
  const projectbox = await prepareProjectbox({ containers: await remoteContainers(), release, cause: "Deploy", candidateGetsBuilt: true });

  // From here on the new state is the valid one.
  await sshAct(`docker tag ${cand} ${config.remote.image}:latest`);
  await pointCurrent(release);
  await pruneCandidates(release);
  await pruneCandidates(release, config.remote.projectboxImage);
  return swapContainerValue({ release, force, wait, settleSeconds, settleBackground, projectbox });
}

// The check of the built backend image, in ONE call over stdin to `sh -s` (heredoc with a quoted end): so the quotation marks of
// the tree recipe arrive in the image untouched.
//  · `node --check` over EVERY .js file of the tree — not only server.js.
//  · Import smoke test: the ONLY guard that sees a missing named export, a TDZ in an import cycle or a forgotten import at module
//    level (node --check is blind to that; headless.js imports server.js at start the same way, the import has few side effects).
//  · Tree hash with the same recipe as locally.
//  · The dead wrapper (onnxruntime-web) is gone, and the embedding package loads without it — an import of @huggingface/transformers
//    from /app (the import smoke test above does not reach it: embeddings.js loads it only at the first call). If the node build of
//    transformers ever went through onnxruntime-web after all, it would show up HERE, not in a user's first embedding.
//  · The clone program lies executable under /usr/local/bin and loads with the python3 of the image.
export function backendImageProbe(cand) {
  return (
    `docker run --rm -i --entrypoint sh ${cand} -s <<'HEXEOF'\n` +
    `command -v chromium; command -v task\n` +
    // Multi-stage Dockerfile: lsof belongs only in the project box. If backend inherited from it instead of from base,
    // `pidsOnPort` would change in the user container — the text guard (projectbox-dockerfile.test.mjs) sees that too,
    // this line sees it at the built image (also lsof that would come as a dependency of a package in `base`).
    `command -v lsof >/dev/null 2>&1 && echo lsof-da || echo lsof-missing\n` +
    // `node --check a b c` checks only a (argv[1]) — with `-exec … {} +` it would get all 55 paths and
    // check exactly one of them (adversarial review; the spec formula had the error).
    // So a loop per file.
    `find ${IMAGE_SERVER_DIR} -name '*.js' -type f -exec sh -c 'for f; do node --check "$f" || exit 1; done' sh {} + && echo syntax-ok\n` +
    `node --input-type=module -e "await import('${IMAGE_SERVER_DIR}/server.js'); await import('${IMAGE_SERVER_DIR}/store.js')" 2>/dev/null && echo import-ok\n` +
    `test -e /app/node_modules/onnxruntime-web && echo ortweb-da || echo ortweb-missing\n` +
    `(cd /app && node --input-type=module -e "await import('@huggingface/transformers')") >/dev/null 2>&1 && echo transformers-loadable\n` +
    `test -x ${CLONE_IN_BACKEND} && python3 ${CLONE_IN_BACKEND} --help >/dev/null 2>&1 && echo clone-ok\n` +
    `printf 'tree=%s\\n' "$(${treeShaShell(IMAGE_SERVER_DIR)})"\n` +
    `HEXEOF`
  );
}

// Pure: the output of backendImageProbe → { ok, rows } in the format of log.table. The same checks as once in the body of
// deployServer, each its own row — the guard drives a counter-test per row.
export function backendImageVerdict(stdout, { localSha, size = "" }) {
  const out = String(stdout ?? "");
  const has = (s) => out.includes(s);
  const imgSha = (out.match(/^tree=([0-9a-f]{64})$/m) || [])[1] || null;
  const rows = [
    ["chromium in image", has("/usr/bin/chromium") ? "yes" : "MISSING", has("chromium") ? "ok" : "bad"],
    ["task in image", has("task") ? "yes" : "MISSING", has("task") ? "ok" : "bad"],
    ["Syntax of all .js under electron/server", has("syntax-ok") ? "ok" : "ERROR", has("syntax-ok") ? "ok" : "bad"],
    ["Import smoke test (server.js, store.js)", has("import-ok") ? "importable" : "ERROR", has("import-ok") ? "ok" : "bad"],
    ["electron/server == working tree", imgSha && imgSha === localSha ? "yes" : `NO (${imgSha?.slice(0, 12)} ≠ ${localSha?.slice(0, 12)})`, imgSha && imgSha === localSha ? "ok" : "bad"],
    ["lsof in backend image (belongs only in the project box)", has("lsof-missing") && !has("lsof-da") ? "no" : "PRESENT", has("lsof-missing") && !has("lsof-da") ? "ok" : "bad"],
    ["onnxruntime-web in backend image (dead wrapper)", has("ortweb-missing") && !has("ortweb-da") ? "no" : "PRESENT", has("ortweb-missing") && !has("ortweb-da") ? "ok" : "bad"],
    ["Load smoke test embedding (@huggingface/transformers)", has("transformers-loadable") ? "loadable" : "ERROR", has("transformers-loadable") ? "ok" : "bad"],
    [`cbase-clone (${CLONE_IN_BACKEND}, python3)`, has("clone-ok") ? "ok" : "MISSING", has("clone-ok") ? "ok" : "bad"],
  ];
  return { ok: rows.every((z) => z[2] === "ok"), rows: [...rows, ["Image size", size, null]] };
}

async function checkBackendImage(cand) {
  if (isDryRun()) return;
  log.step("Check image");
  const tools = await sshProbe(backendImageProbe(cand));
  const size = (await sshProbe(`docker images --format '{{.Size}}' ${cand} | head -1`)).stdout.trim();
  const verdict = backendImageVerdict(tools.stdout, { localSha: treeSha(SERVER_DIR), size });
  log.table(verdict.rows);
  if (!verdict.ok) {
    throw new Error(
      `Image check failed. Neither \`${config.remote.image}:latest\` nor \`current\` was ` +
        `touched — everything keeps running unchanged. Candidate to look at: ${cand}`,
    );
  }
}

// The source of the project box from server/backend/ (lib/projectbox.mjs projectboxSource).
export function localProjectboxSource() {
  return localProjectboxStatus().source;
}

// The state of the project box in the tree, read ONCE — the Dockerfile as text, sha256 per file of the chain (the same bytes the
// source is computed from), the source and the expected sha256 of entry and wrapper in the image.
export function localProjectboxStatus(context = path.join(REPO, "server/backend")) {
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const dockerfile = fs.readFileSync(path.join(context, "Dockerfile"), "utf8");
  const files = {};
  for (const rel of projectboxSourceFiles(dockerfile)) files[rel] = sha(fs.readFileSync(path.join(context, rel)));
  const hash = (rel) => files[rel];
  return Object.freeze({
    dockerfile, dockerfileSha: sha(Buffer.from(dockerfile)), files: Object.freeze(files),
    source: projectboxSource(dockerfile, hash), imageFiles: Object.freeze(projectboxFileExpectation(dockerfile, hash)),
  });
}

function projectboxStatusValid(s) {
  return Boolean(s) && typeof s.dockerfile === "string" && SOURCE_RE.test(String(s.dockerfileSha)) && SOURCE_RE.test(String(s.source))
    && s.files && typeof s.files === "object" && Object.values(s.files).every((v) => SOURCE_RE.test(String(v)))
    && s.imageFiles && typeof s.imageFiles === "object" && Object.keys(s.imageFiles).length > 0;
}

// The bytes in the release folder against the state from BEFORE the upload — after all uploads, before any build. A deviation
// throws: nothing built, nothing repointed. Exported for tools/check/projectbox-distribution.test.mjs (fake ssh).
export async function checkReleaseSource({ rel, projectboxStatus }) {
  if (!projectboxStatusValid(projectboxStatus)) throw new TypeError("checkReleaseSource: projectboxStatus is missing or incomplete");
  const script = releaseSourceProbe(`${rel}/backend`, projectboxStatus.dockerfile);
  if (isDryRun()) {
    log.cmdLine(`[dry] ssh ${config.ssh.host} <<'EOF' (project box source in the release)\n${script}\nEOF`);
    return null;
  }
  log.step("Project box source in the release folder");
  const pr = await sshProbe(script);
  const verdict = releaseSourceVerdict(pr.stdout, projectboxStatus);
  log.table(verdict.rows);
  if (!verdict.ok) {
    throw new Error(
      `Project box source in the release folder deviates from the state before the upload (tree ${projectboxStatus.source.slice(0, 12)}, ` +
        `release ${verdict.sourceRelease ? verdict.sourceRelease.slice(0, 12) : "not computable"}) — nothing built, nothing repointed. ` +
        "Does server/backend/ change during the deploy? Restart afterwards.",
    );
  }
  return verdict;
}

async function checkProjectbox({ cand, pbCand, source, files }) {
  if (isDryRun()) {
    log.cmdLine(`[dry] ssh ${config.ssh.host} <<'EOF' (project box check)\n${projectboxHostProbe(pbCand)}\nEOF`);
    return;
  }
  log.step("Check project box image");
  const expectation = { ...readProjectboxExpectation(fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8")), source, files };
  const pr = await sshProbe(projectboxHostProbe(pbCand));
  const pbSize = (await sshProbe(`docker images --format '{{.Size}}' ${pbCand} | head -1`)).stdout.trim();
  const verdict = projectboxVerdict(pr.stdout, expectation);
  log.table([...verdict.rows, ["Project box size", pbSize, null]]);
  if (!verdict.ok) {
    throw new Error(
      `Project box check failed. Neither \`${config.remote.image}:latest\` nor \`current\` was touched — ` +
        `everything keeps running unchanged. Candidates to look at: ${cand}, ${pbCand}`,
    );
  }
}

// The last part of the server target: repoint the project box inside, swap containers, look afterwards. `projectbox` is the result
// of prepareProjectbox (rollOutAfterBackendBuild) — mandatory: a missing field is no statement.
export async function swapContainerValue({ release, force, wait, settleSeconds, settleBackground = false, projectbox }) {
  if (!projectbox) throw new TypeError("swapContainerValue: projectbox (result of prepareProjectbox) is missing");
  // -------------------------------------------------------------- container
  //
  // ALL user containers, not only the first. A `docker ps | head -1` once left the second user's container running EIGHT DAYS
  // on the old image — and `./deploy status` reported "server.js in container == working tree" because the report also looked
  // only at the first. It became visible only when new routes answered with 404 in that container. The tag `:latest` applies to
  // every container, so every one must be swapped.
  const containers = await remoteContainers();
  // Inside, `cbase-projectbox:latest` to the candidate prepared in rollOutAfterBackendBuild — right here, before the early return
  // "all already run this image" (if only the project box changes, the flow would otherwise end there and it would never arrive)
  // and before the idle gate. A B whose preparation failed keeps its :latest; nothing throws (lib/projectbox-distribution.mjs).
  await repointProjectbox(projectbox, { containers });
  if (!containers.length) {
    log.warn("No running user container — image is built, the gateway creates one anew on the next access.");
    await pruneReleases();
    return;
  }

  // First measure which containers need the swap at all — hold nobody up with a gate or end anything before.
  // The id of `:latest` WITH distinction (lib/remote.mjs readImageId). `imageDigest` once turned every read error into null —
  // then EVERY B counted as "another image" and was swapped, the adoption in the gateway race no longer checked the image
  // (swapVerdict without newDigest), and the verdict afterwards was red with a rollback hint.
  // Unknown is not "swap everything": abort before any B is touched (`:latest` and `current` are already repointed — the next
  // deploy or the gateway swaps). In a dry run `:latest` is still the old image (not repointed) — there only one row.
  const latest = await readImageId(`${config.remote.image}:latest`);
  if (!latest.id && !isDryRun()) {
    throw new Error(
      `Image id of ${config.remote.image}:latest not readable (${latest.unknown || "missing"}) — which B is already on the new ` +
        "state is unknown; NO container swapped. `:latest` and `current` already point to the new release — " +
        "`./deploy status` and `./deploy server` again.",
    );
  }
  if (!latest.id) log.detail(`(dry run: id of ${config.remote.image}:latest not readable — ${latest.unknown || "missing"})`);
  const newDigest = latest.id || null;
  const targets = [];
  for (const name of containers) {
    const insp = await inspectContainer(name);
    if (!insp) throw new Error(`docker inspect ${name} returned nothing.`);
    // Without `--init` (tini) a container needs a swap even with the same image — otherwise a container this tool created
    // before would get it only with the next image (see `containerSpec`).
    const withInit = insp.HostConfig?.Init === true;
    if (insp.Image === newDigest && withInit && !force && !isDryRun()) {
      log.ok(`${name} already runs this image — no swap needed.`);
      continue;
    }
    if (insp.Image === newDigest && !withInit) log.detail(`${name}: same image, but without --init — will be swapped.`);
    targets.push({ name, insp });
  }
  if (!targets.length) {
    log.ok(`All ${containers.length} user containers already run this image.`);
    await pruneReleases();
    return;
  }
  if (isDryRun()) log.detail("(dry run: the image was not built, the swap is planned anyway)");

  if (wait) {
    log.step(`Wait for idle in all containers (max. ${wait}s)`);
    if (!(await waitRemoteIdle(targets[0].name, wait))) log.warn("Wait time expired — the gate decides.");
  }
  const inner = await remoteGate({ force, containers: targets.map((t) => t.name) });

  log.step(targets.length > 1 ? `Swap containers (${targets.length})` : "Swap container");
  for (const t of targets) {
    t.spec = await containerSpec(t.insp); // env against B's OWN image (lib/remote.mjs), unreadable ⇒ throw before any swap
    log.detail(runCommand(t.spec, config.remote.image));
  }
  // Only the user's are brought back; the backend brings the project containers back itself after the start.
  const back = targets.flatMap((t) => retrievalList(inner.get(t.name)?.running || []));
  const projectC = targets.flatMap((t) => partsInner(inner.get(t.name)?.running || []).projects.map((c) => c.name));
  await confirm(`Recreate ${targets.map((t) => t.name).join(", ")}?`, {
    consequence:
      `This ends the backend AND the inner Docker daemon of each container. ` +
      `${back.length} inner containers are brought back afterwards: ` +
      `${back.join(", ") || "(no)"}` +
      // restoreInner asks the backend after the swap and leaves out the containers of a relocation.
      " (without those a relocation took over — the backend names them after the swap)" +
      (projectC.length ? `. ${projectC.length} project containers the backend brings back itself: ${projectC.join(", ")}` : ""),
  });

  // A container that does not become healthy does NOT abort the run at once: `:latest` already points
  // to the new image, so the gateway would create the others from it anyway. Half
  // swapped is the worst state — so try every one and judge only at the end.
  const localSha = isDryRun() ? "" : treeSha(SERVER_DIR);
  const rows = [];
  const failed = [];
  const skipped = [];
  for (const t of targets) {
    const tag = targets.length > 1 ? ` (${t.name.slice(0, 26)}…)` : "";
    // The gate above applied to the state BEFORE the first swap — per container anew, with the same rules for
    // --wait/--force (lib/gates.mjs idleBeforeSwap); the inner containers then fresh (one may have started since the gate).
    const before = await idleBeforeSwap(t.name, { force, wait });
    if (!before.swap) {
      log.warn(`${t.name}: ${before.reason} — not swapped.`);
      rows.push([`Swap${tag}`, `NOT swapped — ${before.reason}`, "bad"]);
      failed.push(t.name);
      skipped.push(t.name);
      t.skipped = true;
      continue;
    }
    if (!isDryRun()) inner.set(t.name, await innerContainers(t.name));
    const mine = inner.get(t.name) || { running: [], all: [] };
    // The limits NOT from the inspect from before the gate (an admin who has saved since would otherwise see their value reset by
    // the swap), but from resources-desired.json, ONE ssh right before this swap (lib/limits-swap.mjs). Without a stored value as
    // before from inspect — as a warning.
    const limits = await limitsBeforeSwap(t.insp);
    await swapContainer(t.name, specWithLimits(t.spec, limits.args), newDigest);
    if (isDryRun()) continue;
    // …and right after, against the new B: a save DURING the swap still hit the old one with its `docker update`.
    const limitsAfterwards = await limitsAfterSwap(t.name);
    rows.push([`${limitsAfterwards.row[0]}${tag}`, limitsAfterwards.row[1], limitsAfterwards.row[2]]);

    if (!(await waitHealthy(t.name))) {
      rows.push([`Backend${tag}`, "did NOT become healthy", "bad"]);
      failed.push(t.name);
      continue;
    }
    log.ok(`${t.name}: backend answers`);
    await restoreInner(t.name, mine.running, { beforeSwap: before.row?.runs ?? null }); // snapshot of the idle gate

    const after = await inspectContainer(t.name);
    t.created = after?.Created;
    const deployedSha = await remoteTreeSha(t.name);
    const runs = await sshProbe(
      `docker exec -u agent ${t.name} curl -sS --max-time 5 http://127.0.0.1:${config.remote.backendPort}/api/runs/active`,
    );
    const imageOk = after?.Image === newDigest;
    const shaOk = deployedSha === localSha;
    rows.push(
      [`Image of the container${tag}`, imageOk ? "current" : "DEVIATES", imageOk ? "ok" : "bad"],
      [`electron/server in container${tag}`, shaOk ? "== working tree" : "DEVIATES", shaOk ? "ok" : "bad"],
      [`Host-Port${tag}`, Object.values(after?.NetworkSettings?.Ports || {})[0]?.[0]?.HostPort || "?", null],
      [`/api/runs/active${tag}`, runs.stdout.trim(), "ok"],
    );
    if (!imageOk || !shaOk) failed.push(t.name);
  }

  if (!isDryRun()) {
    log.table(rows);
    if (failed.length) {
      throw new Error(
        `These containers do not run the expected state: ${failed.join(", ")}. ` +
          (skipped.length ? `Not swapped because not idle before the swap: ${skipped.join(", ")} — deploy again (\`--wait 300\` or \`--force\`). ` : "") +
          `Logs: ssh ${config.ssh.host} docker logs <name> | tail -50. Rollback: tools/deploy rollback server`,
      );
    }
    // The post-observation (150 s) may run in the background if local targets still build after the server —
    // `deploy all` waits for it before "done". Alone (`deploy server`) it stays in the foreground, otherwise the tool
    // would end before its own check. A rejection stays a rejection: it is only thrown later, not swallowed.
    const postObservation = settleMany(
      targets.map((t) => ({ name: t.name, created: t.created, inner: inner.get(t.name) || { running: [] } })),
      settleSeconds,
    ).then(() => projectRetrieval(inner, targets.map((t) => t.name))) // afterwards: does the backend bring them back?
      .then(() => composeInBPostObservation(targets.map((t) => t.name))); // compose containers in B next to converted projects
    if (settleBackground && settleSeconds) {
      let error = null;
      const still = postObservation.catch((e) => { error = e; });
      await pruneReleases();
      log.ok(`Server on release ${release} (rollback: tools/deploy rollback server)`);
      log.info("Post-observation continues in the background — result before \"done\".");
      return { postObservation: still.then(() => { if (error) throw error; }) };
    }
    await postObservation;
  }

  await pruneReleases();
  log.ok(`Server on release ${release} (rollback: tools/deploy rollback server)`);
  return {};
}

// Mount targets from our own spec ("-v name:target" or "-v source:target:ro").
export function mountTargets(spec) {
  const out = [];
  for (let i = 0; i < spec.length - 1; i++) {
    if (spec[i] !== "-v") continue;
    const target = String(spec[i + 1]).split(":")[1];
    if (target) out.push(target);
  }
  return out;
}

// How to react to the result of `docker run` AFTER removing.
//
// Deliberately pure and exported: exactly this branch struck in production and was untested (held by the maintainer's private suite).
//
// Between `docker rm -f` and `docker run` the name belongs to nobody for a moment — and the gateway watches for that:
// gateway-managed containers it creates anew from `:latest` by itself. If it wins the race, our `docker run` fails with
// "name is already in use" (exit 125). Earlier the run aborted there, BEFORE restoreInner — the user's inner containers
// stayed lying around.
//
// The right thing is ADOPT instead of abort: the gateway owns these containers, its spec comes from gateway/containers.js and is
// the authoritative one; our reconstructed spec is only the substitute for when no gateway is watching. But only what is
// right is adopted — otherwise adopting would be a silent step back:
//  · same image (otherwise the gateway accessed before the `docker tag` → clear away, again),
//  · no mount missing that our spec provided (a missing /var/lib/docker volume, for instance, silently throws the inner
//    Docker back to vfs: 11.5 GB of images then lay as 76 GB on the disk).
export function swapVerdict({ code, stderr = "", insp = null, newDigest = null, wantMounts = [] }) {
  if (code === 0) return { action: "created" };
  if (!/already in use|Conflict\./i.test(stderr)) {
    return { action: "fail", reason: `docker run failed (exit ${code})` };
  }
  if (!insp) return { action: "retry", reason: "name taken, but no container to be found" };
  if (newDigest && insp.Image !== newDigest) {
    return { action: "recreate", reason: "the gateway took another image" };
  }
  const have = new Set((insp.Mounts || []).map((m) => m.Destination));
  const missing = wantMounts.filter((d) => !have.has(d));
  if (missing.length) {
    return { action: "fail", reason: `the container of the gateway lacks mounts: ${missing.join(", ")}`, missing };
  }
  return { action: "adopt" };
}

// Swap a container: remove and recreate — or adopt the one the gateway created itself in the gap (see swapVerdict).
//
// The SAME way for the rollback (targets/rollback.mjs). There `image` is the target image, `newDigest` its id and `beforeRemove`
// the row of the login retreat (lib/login-retreat.mjs). The rollback once swapped with its own `sshAct(swapScript(…))` without
// swapVerdict: if the gateway created B itself in the gap — from `:latest`, which in the rollback still stands on the bad state —,
// the rollback ended with "Conflict", B ran the bad state, and its inner containers stayed down. Now that container is cleared away
// (other image ⇒ `recreate`) and the target created.
// Returns `{ adopted, stdout }` (stdout of all attempts — the rollback reads a failed login retreat from it) or
// `{ retreatExit: true }`: the copy failed without --force, the script ended with RETREAT_EXIT BEFORE the `rm -f`, B runs
// again on the previous state — the caller decides.
export async function swapContainer(container, spec, newDigest, { image = config.remote.image, beforeRemove = "" } = {}) {
  const wantMounts = mountTargets(spec);
  // stop, rm and run in ONE SSH call: that shrinks the window in which the name is free from two network
  // rounds to zero. It is not closed with that — that is what swapVerdict is for. It begins with
  // `docker stop -t 60` (lib/swap.mjs): the backend runs the stop chain of the project containers instead of dying on `rm -f`.
  let script = swapScript({ container, spec, image, beforeRemove });
  let stdout = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await sshAct(script, { check: false });
    if (r.skipped) return { adopted: false, stdout }; // dry run: nothing executed
    stdout += r.stdout || "";
    if (attempt === 1 && beforeRemove && r.code === RETREAT_EXIT) return { retreatExit: true, stdout };
    const insp = r.code === 0 ? null : await inspectContainer(container);
    const v = swapVerdict({ code: r.code, stderr: r.stderr, insp, newDigest, wantMounts });

    if (v.action === "created") return { adopted: false, stdout };
    if (v.action === "adopt") {
      log.ok(`The gateway was faster — adopted its container (image current, ${wantMounts.length} mounts complete).`);
      return { adopted: true, stdout };
    }
    if (v.action === "fail") {
      const tail = (r.stderr || "").trim().split("\n").slice(-2).join(" ");
      const hint = v.missing?.length
        ? " Is an old gateway/containers.js still running there? Roll out with --gateway, then again."
        : "";
      throw new Error(`${v.reason}.${hint} ${tail}`.trim());
    }
    // retry | recreate — on the second attempt do NOT remove again. `recreate` clears away the container of the gateway — in the
    // rollback WITH the login retreat before it: the foreign B started from `:latest`, and its entry.sh already touched the
    // login again; the copy therefore runs once more between its stop and its removal.
    log.warn(`${v.reason} — attempt ${attempt}/3.`);
    if (v.action === "recreate") {
      const removal = await sshAct(removeScript(container, { beforeRemove }), { check: false });
      stdout += removal.stdout || "";
      if (beforeRemove && removal.code === RETREAT_EXIT) return { retreatExit: true, stdout };
    }
    script = swapScript({ container, spec, image, remove: false });
    await sleep(2000);
  }
  throw new Error(`Container ${container} could neither be created nor adopted after 3 attempts.`);
}

// Clean up candidate tags — the last few stay so a rollback does not have to rebuild the image. For both images (backend and project
// box), the same rule. The rule is lib/release.mjs candidatesToRemove — the candidate of the just activated release and those of the
// most recent activations ALWAYS stay (the same rule as pruneReleases), of the rest the two youngest. Otherwise only the two youngest
// names stayed, rejected candidates included: the candidate of the predecessor that `rollback server` without --to aims at could
// be missing, and the rollback would rebuild it and swap without an image check.
// Runs after pointCurrent (the history already carries the new release). Exported for the maintainer's private suite.
export async function pruneCandidates(keepRelease, image = config.remote.image) {
  const r = await sshProbe(
    `docker images --format '{{.Repository}}:{{.Tag}}' ${image} | grep ':cand-' || true`,
  );
  const tags = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const stack = await historyRead();
  if (stack === null) {
    log.detail(`Candidate images of ${image} not cleaned up: ${HISTORY_FILE} not readable — which ones a rollback needs is unknown`);
    return;
  }
  const drop = candidatesToRemove({ tags, keep: keepRelease, stack });

  for (const t of drop) await sshAct(`docker rmi ${t} >/dev/null 2>&1 || true`);
  if (drop.length) log.detail(`old candidate images removed: ${drop.length}`);
}

// Rolling out anew means: swap files, restart the process. Deliberately opt-in (--gateway),
// because all open SSE connections break off.
//
// The gateway runs under the systemd USER unit `cbase-gateway.service` (the environment is in the unit and its drop-in, not in a
// shell). So `systemctl --user restart` is the only right way: a `kill` + `nohup` would leave a process systemd does not
// know — at the next `systemctl start` or reboot two gateways would fight over port 7719.
// `--user` needs XDG_RUNTIME_DIR set over SSH; without it systemctl does not find the user's bus.
// The earlier manual operation stays as a fallback for hosts without a unit.
const GW_UNIT = "cbase-gateway.service";
const SYSTEMCTL = `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user`;

export async function deployGateway({ force }) {
  log.step("Roll out gateway code");
  const root = config.remote.root;

  const managed =
    (await sshProbe(`${SYSTEMCTL} cat ${GW_UNIT} >/dev/null 2>&1 && echo yes || echo no`)).stdout.trim() === "yes";
  log.info(managed ? `Gateway is managed by systemd (${GW_UNIT})` : "Gateway runs without a systemd unit");

  // Character class `inde[x]`: the search pattern stands in the command line of the SSH shell that runs it —
  // `pgrep -f` would otherwise find THIS shell. Measured: `head -1` picked the shell (smaller PID), the real gateway
  // would have stayed and the session been ended instead; afterwards the gateway would run without any GW_ variable, so without the sysbox runtime.
  const pid = (await sshProbe(`pgrep -f 'cbase-server/gateway/inde[x].js' | head -1`)).stdout.trim();
  if (!pid && !managed) throw new Error("No running gateway process and no systemd unit — manual start needed.");

  const dry = await rsyncUp(`${path.join(REPO, "server/gateway")}/`, `${root}/gateway/`, {
    dryRunOnly: true,
    extraExcludes: ["data"],
  });
  const deltas = dry.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("sending"));
  if (!deltas.length) {
    log.ok("Gateway code is already current");
    return;
  }
  for (const d of deltas) log.detail(d);
  if (!force) {
    await confirm("Restart the gateway?", { consequence: "All open SSE connections and terminals break off." });
  }

  await sshAct(`cp -a ${root}/gateway ${root}/backups/gateway-$(date +%Y%m%d-%H%M%S)`);
  await rsyncUp(`${path.join(REPO, "server/gateway")}/`, `${root}/gateway/`, { extraExcludes: ["data"] });

  if (managed) {
    await sshAct(`${SYSTEMCTL} restart ${GW_UNIT}\nsleep 2`);
  } else {
    // Without a unit: take over the environment from the running process, otherwise the gateway starts
    // without GW_RUNTIME and would create containers without the sysbox runtime.
    const env = (await sshProbe(`tr '\\0' '\\n' < /proc/${pid}/environ | grep -E '^GW_' || true`)).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const exe = (await sshProbe(`readlink /proc/${pid}/exe`)).stdout.trim() || "node";
    log.info(`Gateway pid ${pid}, ${env.length} GW_ variables, node: ${exe}`);
    if (!env.length) throw new Error("No GW_ variables found in the running gateway — restart aborted.");
    await sshAct(
      `kill ${pid} || true\n` +
        `for i in $(seq 1 20); do kill -0 ${pid} 2>/dev/null || break; sleep 0.5; done\n` +
        `cd ${root} && env ${env.map((e) => `'${e}'`).join(" ")} nohup ${exe} ${root}/gateway/index.js ` +
        `>> ${root}/gateway.log 2>&1 &\n` +
        `sleep 2`,
    );
  }

  if (isDryRun()) return;
  if (managed) {
    const state = (await sshProbe(`${SYSTEMCTL} is-active ${GW_UNIT} || true`)).stdout.trim();
    if (state !== "active") throw new Error(`Unit ${GW_UNIT} is '${state}' after the restart.`);
  }
  const code = (
    await sshProbe(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${config.remote.gatewayPort}/ || true`)
  ).stdout.trim();
  if (!/^(200|30\d|401|403)$/.test(code)) throw new Error(`Gateway answers after the restart with ${code || "nothing"}.`);
  log.ok(`Gateway restarted (HTTP ${code})`);
}
