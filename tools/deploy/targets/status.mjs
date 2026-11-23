// Pure measurement — changes nothing. Answers the question that comes first before every deploy:
// is something NEWER than the working tree already running somewhere?
//
// Not an academic question: three shipped features once lay only on a branch while `main` was
// behind — a deploy from `main` would have silently removed them. The working tree is not the
// truth about what is shipped; so it is compared here, not assumed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, config, desktopUser } from "../config.mjs";
import { probe, shProbe } from "../../check/lib/sh.mjs";
import { rsyncUp, sshProbe } from "../lib/ssh.mjs";
import { limitsCommand, limitsRow, desiredFrom } from "../lib/limits.mjs";
import { gatewayRow } from "../lib/gateway-stand.mjs";
import { bundleSha, fileSha, treeSha, treeShaShell } from "../../check/lib/asar.mjs";
import { electronBundleAgainstModule } from "../../check/lib/electron-version.mjs";
import { findIphones, xcrunCaller } from "../lib/iphone.mjs";
import { prePushStatusMeasured } from "../../check/lib/git.mjs";
import { currentRelease, listReleases } from "../lib/release.mjs";
import { imageDigest, inspectContainer, remoteOpsStatus, remoteTreeSha } from "../lib/remote.mjs";
import { dynWorkflowRow, backgroundAgentsRow, innerContainers, projectWorkRow, remoteBusy, remoteContainers } from "../lib/gates.mjs";
import { networkSeparationCommand, networkSeparationRow } from "../lib/network-separation.mjs";
import { composeInBRow, setupRow, projectContainerRow, partsInner } from "../lib/project-container.mjs";
import { projectboxStatus } from "../lib/projectbox-distribution.mjs";
import { layoutRow, copiesRow, convertedRow, relocationsOpenRow } from "../lib/capabilities.mjs"; // rollback block, copies, layouts
import * as log from "../../check/lib/log.mjs";
import { readCliPins } from "../../check/lib/cli-pins.mjs";
import { importPrivate, needsPrivatePart } from "../lib/private-part.mjs";
import { containerSituation, situationCommand } from "../lib/stopped-b.mjs"; // stopped B
import { BUILD_JSON, describeBuild, stampBuildText } from "../lib/build-stamp.mjs";

// The TREE under electron/server, not one file: server.js is only the facade, and a file hash would
// report "== working tree" while a feature folder runs something else. Recipe in asar.mjs, once for JS and shell.
const SERVER_DIR = path.join(REPO, "server/backend/electron/server");
// The provider CLIs in the image: the pin from the Dockerfile — the status does not see the version in the running
// container; it is known only after `docker exec <c> claude --version`.
// The pin-sync guard (whether the baseline for the Claude pin is brought along) is private (the deploy tool's private remainder), loaded
// where the tree carries it; without it the row says so instead of a verdict.
const DOCKERFILE = "server/backend/Dockerfile";
const pinSync = await importPrivate("lib/pinSync.mjs");
export function cliPinRows() {
  try {
    const p = readCliPins(fs.readFileSync(path.join(REPO, DOCKERFILE), "utf8"));
    const rows = [
      ["Claude CLI in image (pin)", p.claude, null],
      ["Codex CLI in image (pin)", p.codex, null],
    ];
    if (!pinSync) return [...rows, ["Baseline for the Claude pin", needsPrivatePart("the check", "lib/pinSync.mjs"), null]];
    const m = pinSync.checkPinSync(REPO);
    return [
      ...rows,
      ["Baseline for the Claude pin", m.error.length ? `not brought along (${m.error.length} finding(s)) — ./deploy baseline ${p.claude}` : `brought along (${m.artifacts.length} artifacts)`, m.error.length ? "bad" : "ok"],
    ];
  } catch (e) {
    return [["CLI pins in image", e.message.replace(/\n\s*/g, " "), "bad"]];
  }
}

const short = (s) => (s ? String(s).replace(/^sha256:/, "").slice(0, 12) : "—");

export async function status() {
  const srcSha = treeSha(SERVER_DIR);

  log.section("Working tree");
  const branch = (await shProbe("git rev-parse --abbrev-ref HEAD", { cwd: REPO })).stdout.trim();
  const hook = await prePushStatusMeasured();
  const dirty = (await shProbe("git status --short", { cwd: REPO })).stdout.split("\n").filter((l) => l.trim());
  const unpushed = (await shProbe("git log --oneline @{u}..HEAD 2>/dev/null || true", { cwd: REPO })).stdout
    .split("\n")
    .filter((l) => l.trim());
  const branches = (await shProbe("git for-each-ref --format='%(refname:short)' refs/heads", { cwd: REPO })).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const behind = [];
  for (const b of branches.filter((b) => b !== branch)) {
    const n = (await shProbe(`git rev-list --count ${branch}..${b}`, { cwd: REPO })).stdout.trim();
    if (n && n !== "0") behind.push(`${b} (+${n})`);
  }
  const described = await describeBuild();
  log.table([
    ["Build (working tree)", described.describe.build, described.warning || described.describe.dirty ? "warn" : null],
    ["Branch", branch === config.git.branch ? branch : `${branch} — work always happens on ${config.git.branch}`, branch === config.git.branch ? "ok" : "bad"],
    ["uncommitted changes", dirty.length ? `${dirty.length} file(s)` : "none", dirty.length ? "warn" : "ok"],
    ["not pushed", unpushed.length ? `${unpushed.length} commit(s)` : "none", unpushed.length ? "warn" : "ok"],
    ["commits only on other branches", behind.length ? behind.join(", ") : "none", behind.length ? "warn" : "ok"],
    ["electron/server (tree, working tree)", short(srcSha), null],
    ["pre-push-Guard", hook.text, hook.stage],
    ...cliPinRows(),
  ]);

  log.section("Client (local)");
  const capp = config.local.clientApp;
  if (!fs.existsSync(capp)) {
    log.table([["installed", "no", "warn"]]);
  } else {
    const mainSha = bundleSha(capp, "main.js");
    const srcMain = fileSha(path.join(REPO, "client/main.js"));
    const el = electronBundleAgainstModule(capp, path.join(REPO, "client"));
    const pids = (await probe("pgrep", ["-f", `${capp}/Contents/MacOS/`])).stdout.trim();
    log.table([
      ["main.js in bundle", mainSha === srcMain ? "== working tree" : "DEVIATES", mainSha === srcMain ? "ok" : "warn"],
      ["Electron in bundle == node_modules", el.text, el.equal ? "ok" : "warn"],
      ["Process", pids ? "running" : "not running", null],
    ]);
  }

  log.section("Server");
  if (!config.ssh.host) {
    log.table([["SSH", "not configured (deploy.local.json)", "warn"]]);
  } else {
    const ping = await sshProbe("echo ok", { check: false });
    if (ping.stdout.trim() !== "ok") {
      log.table([
        ["SSH", `unreachable (${config.ssh.host})`, "bad"],
        ["Hint", "SSH unreachable? Check the host in deploy.local.json and that a non-interactive `ssh -o BatchMode=yes <host>` works.", null],
      ]);
    } else {
      const rel = await currentRelease();
      const all = await listReleases();
      const img = await imageDigest();
      // Situation PER user container. A false picture arose here twice: "active runs: 0" showed only the
      // first container (a workflow was running in the second), then "server.js in container == working tree"
      // reported the state of the first while the second ran eight days on the old image. So every
      // container gets its own rows here.
      const containers = await remoteContainers();
      // Stopped B — the next `./deploy server` starts and swaps them (otherwise they would keep the old image).
      const situation = containerSituation((await sshProbe(situationCommand(config.remote.containerPrefix))).stdout, config.remote.containerPrefix);
      // The project box candidate of the running release on the host and per B whether inside :latest points to it (read-only;
      // the wiring is ONE function that projectbox-distribution.test.mjs drives against a fake docker).
      const projectbox = await projectboxStatus({ release: rel, containers });
      const busyRows = await remoteBusy();
      // The limits PER container — against the stored value of the user (GW_DATA/resources-desired.json, label cbase.user),
      // without the file against the unit (lib/limits.mjs).
      const limitsDesired = desiredFrom((await sshProbe(limitsCommand(config.remote.root), { check: false })).stdout);
      const perContainer = [];
      for (const name of containers) {
        perContainer.push({
          name,
          insp: await inspectContainer(name),
          deployed: await remoteTreeSha(name),
          inner: await innerContainers(name),
          busy: busyRows.find((r) => r.name === name) || null,
          // Names of the projects without an instance row and compose containers in B (own route with names, not
          // /api/runs/active).
          opsStatus: await remoteOpsStatus(name),
          // The CBASE-PROJ chain, the jump and the marker of this start (lib/network-separation.mjs).
          network: (await sshProbe(networkSeparationCommand(name))).stdout,
        });
      }
      // The build stamps the deploy wrote: the live server release (the gateway reports it on /gw/info) and the web UI.
      const currentStampText = (await sshProbe(`cat ${config.remote.root}/current/${BUILD_JSON} 2>/dev/null || true`, { check: false })).stdout;
      let currentStamp = null;
      try { currentStamp = JSON.parse(currentStampText); } catch { /* missing: an older release */ }
      const webStampText = (await sshProbe(`cat ${config.remote.root}/web-out/${BUILD_JSON} 2>/dev/null || true`, { check: false })).stdout;
      const relSha = (await sshProbe(`${treeShaShell(`${config.remote.root}/current/backend/electron/server`)} 2>/dev/null || true`)).stdout.trim().split(/\s+/)[0];
      const localIndex = fileSha(path.join(REPO, "web/out/index.html"));
      const remoteIndex = (await sshProbe(`sha256sum ${config.remote.root}/web-out/index.html 2>/dev/null || true`)).stdout.split(/\s+/)[0];
      // The gateway code is not in the release tree — only `--gateway` rolls it out (and restarts).
      // The same dry run as deployGateway (lib/gateway-stand.mjs); rsync is read-only in a dry run.
      const gateway = gatewayRow(await rsyncUp(`${path.join(REPO, "server/gateway")}/`, `${config.remote.root}/gateway/`, { dryRunOnly: true, extraExcludes: ["data"] }));
      // Write the name on each row only with several containers — otherwise the report stays short.
      const tag = (name) => (perContainer.length > 1 ? ` (${name.slice(0, 26)}…)` : "");

      log.table([
        ["current release", rel || "—", null],
        ["build in current/", stampBuildText(currentStampText), currentStamp ? null : "warn"],
        ["build of web-out", stampBuildText(webStampText), null],
        ["releases in stock", String(all.length), null],
        ["Image", short(img), null],
        projectbox.header,
        ["user containers", containers.length ? String(containers.length) : "none", containers.length ? "ok" : "warn"],
        ["stopped user containers", situation.stopped.length ? `${situation.stopped.join(", ")} — the next ./deploy server starts and swaps them` : "none", situation.stopped.length ? "warn" : "ok"],
        ["electron/server in current/", relSha === srcSha ? "== working tree" : `DEVIATES (${short(relSha)})`, relSha === srcSha ? "ok" : "warn"],
        ["web-out == web/out", remoteIndex && remoteIndex === localIndex ? "yes" : "DEVIATES", remoteIndex === localIndex ? "ok" : "warn"],
        gateway,
        ...perContainer.flatMap((c) => {
          const runs = c.busy?.runs || null;
          const one = c.busy?.oneshots || [];
          // "inner" are the user's; project containers stand in a row of their own (the backend brings them back, no warn).
          const userRunning = partsInner(c.inner.running).user;
          const stopped = partsInner(c.inner.all).user.length - userRunning.length;
          const pz = projectContainerRow(c.inner.all, c.inner.running);
          return [
            ["Container", c.name, null],
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(limitsRow(c.insp?.HostConfig, limitsDesired, c.insp?.Config?.Labels?.["cbase.user"])),
            [`container image == image${tag(c.name)}`, c.insp ? (c.insp.Image === img ? "yes" : "NO (hot-patched or old)") : "—", c.insp ? (c.insp.Image === img ? "ok" : "bad") : null],
            [`electron/server in container${tag(c.name)}`, c.deployed === srcSha ? "== working tree" : `DEVIATES (${short(c.deployed)})`, c.deployed === srcSha ? "ok" : "warn"],
            // An unreadable process list in the container is "unknown", never "no oneshots".
            [`active runs${tag(c.name)}`, `${runs ? `runs=${runs.runs}${one.length ? ` oneshots=${one.length}` : ""}` : "unreachable"}${c.busy?.processesUnknown ? ` · process list unknown (${c.busy.processesUnknown})` : ""}`, (runs && (runs.runs || one.length)) || c.busy?.processesUnknown ? "warn" : "ok"],
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2] === "bad" ? "warn" : z[2]])(backgroundAgentsRow(runs)),
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(dynWorkflowRow(runs)),
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2] === "bad" ? "warn" : z[2]])(projectWorkRow(runs)),
            // The count the rollback block hangs on (lib/capabilities.mjs) — unknown is not zero.
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(convertedRow(runs)),
            // The second count of the block — a relocation in progress (before the turn `converted` does not count it).
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(relocationsOpenRow(runs)),
            // The third count of the block — live copies (count, waiting, in progress, `cbase-k-*` containers without helper).
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(copiesRow(runs, c.inner.all)),
            // The fifth count of the block — layouts being rebuilt, plus the waiting ones.
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(layoutRow(runs)),
            // Open and failed setups, projects without an instance row — counts from /api/runs/active, names from
            // the ops status.
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(setupRow(runs, c.opsStatus)),
            // Compose containers in B next to a converted project (from the same answer, the ops-status route).
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(composeInBRow(c.opsStatus)),
            ((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]])(networkSeparationRow(c.network)),
            ...projectbox.perB.get(c.name).map((z) => [`${z[0]}${tag(c.name)}`, z[1], z[2]]),
            [`inner containers${tag(c.name)}`, userRunning.length ? userRunning.map((x) => x.name).join(", ") : "none", null],
            [`inner stopped${tag(c.name)}`, stopped ? String(stopped) : "0", stopped ? "warn" : "ok"],
            ...(pz ? [[`${pz[0]}${tag(c.name)}`, pz[1], pz[2]]] : []),
          ];
        }),
      ]);
    }
  }

  log.section("iOS");
  // The same computation as the pre-check of `mobile --device` (lib/iphone.mjs). A text search for
  // "connected" in the table would miss `available (paired)`, and a Wi-Fi iPhone (like any sleeping
  // cabled device) would show as "none". Sleeping, paired devices are woken for it; `all` shows every one.
  const user = desktopUser();
  const xcrun = xcrunCaller({
    probe, user, needSudo: os.userInfo().username !== user,
    developerDir: `${config.mobile.xcodeApp}/Contents/Developer`, timeout: 45000,
  });
  const { devices } = await findIphones({ xcrun, udid: config.mobile.udid, all: true });
  const archives = path.join(process.env.HOME || "", "Library/Developer/Xcode/Archives");
  // Depending on the route the archives lie directly in Archives/ (our .command scripts set
  // ARCHIVE_PATH themselves) or in Xcode's date folders — search both levels.
  let latest = "—";
  if (fs.existsSync(archives)) {
    const found = [];
    for (const d of fs.readdirSync(archives)) {
      const p = path.join(archives, d);
      if (!fs.statSync(p).isDirectory()) continue;
      if (d.startsWith("cbase")) found.push({ name: d, at: fs.statSync(p).mtimeMs });
      else for (const a of fs.readdirSync(p)) if (a.startsWith("cbase")) found.push({ name: a, at: fs.statSync(path.join(p, a)).mtimeMs });
    }
    found.sort((a, b) => a.at - b.at);
    const last = found.pop();
    if (last) latest = `${last.name} (${new Date(last.at).toLocaleString("de-DE")})`;
  }
  log.table([
    ["connected devices", devices.length ? devices.map((g) => g.text).join(", ") : "none", null],
    ["latest archive", latest, null],
  ]);
}
