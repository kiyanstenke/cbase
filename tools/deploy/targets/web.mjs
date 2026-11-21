// The shared web UI: build it and put it on the server without interruption.
//
// The gateway serves web-out statically itself and reads it fresh from disk on each request.
// A pure UI update is therefore an rsync — no gateway restart, no touching the container,
// no disturbance of running agent runs.
import fs from "node:fs";
import path from "node:path";
import { REPO, config } from "../config.mjs";
import { act, isDryRun, probe } from "../../check/lib/sh.mjs";
import { rsyncUp, sshProbe } from "../lib/ssh.mjs";
import { ensureRelease } from "../lib/release.mjs";
import * as log from "../../check/lib/log.mjs";

const OUT = path.join(REPO, "web/out");

// An earlier sudo build left ~1000 root-owned artifacts; npm fails on them at unlink — with
// exit code 0 in the wrapper. So look for them explicitly beforehand.
export async function assertNoRootArtifacts(dirs) {
  const existing = dirs.map((d) => path.join(REPO, d)).filter((d) => fs.existsSync(d));
  if (!existing.length) return;
  const r = await probe("find", [...existing, "-user", "root", "-print", "-quit"]);
  const hit = r.stdout.trim().split("\n").filter(Boolean)[0];
  if (hit) {
    throw new Error(
      `Root-owned build artifacts found (${path.relative(REPO, hit)}). npm fails on them ` +
        `when deleting but reports exit 0. Once beforehand:\n` +
        `      sudo chown -R $(id -un):staff ${existing.map((d) => path.relative(REPO, d)).join(" ")}`,
    );
  }
}

export async function buildWeb() {
  log.step("Build web UI");
  await assertNoRootArtifacts(["web/.next", "web/out"]);
  const started = Date.now();
  await act("npm", ["--prefix", "web", "run", "build"], { cwd: REPO, timeout: 900000 });
  if (isDryRun()) return;

  // The exit code alone is not enough: the wrapper has reported 0 while the build failed on
  // EACCES. The timestamp of the export is the reliable measurement.
  const index = path.join(OUT, "index.html");
  if (!fs.existsSync(index)) throw new Error("web/out/index.html is missing — the export did not run.");
  const age = fs.statSync(index).mtimeMs;
  if (age < started) {
    throw new Error(
      `web/out/index.html is older than the build start (${new Date(age).toLocaleString("de-DE")}). ` +
        `The build wrote nothing — check the log.`,
    );
  }
  const chunks = fs.existsSync(path.join(OUT, "_next")) ? countFiles(path.join(OUT, "_next")) : 0;
  log.ok(`web/out rebuilt (${chunks} _next files)`);
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

export async function deployWebOut({ release }) {
  log.step("Web UI to the server (without interruption)");
  const remote = `${config.remote.root}/web-out`;

  const dry = await rsyncUp(`${OUT}/`, `${remote}/`, { dryRunOnly: true });
  const deltas = dry.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("sending"));
  log.info(`${deltas.length} file(s) differ`);
  for (const d of deltas.slice(0, 12)) log.detail(d);
  if (deltas.length > 12) log.detail(`… and ${deltas.length - 12} more`);
  if (!deltas.length) {
    log.ok("Server UI is already current");
    return;
  }

  // Deliberately WITHOUT --delete: open sessions would otherwise load _next chunks that no longer exist.
  await rsyncUp(`${OUT}/`, `${remote}/`, { del: false });
  if (isDryRun()) return;

  // Cross-check: the same index.html here and there, and the gateway still answers.
  const localSha = await probe("shasum", ["-a", "256", path.join(OUT, "index.html")]);
  const remoteSha = await sshProbe(`sha256sum ${remote}/index.html`);
  const same = localSha.stdout.split(/\s+/)[0] === remoteSha.stdout.split(/\s+/)[0];
  const code = await sshProbe(
    `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${config.remote.gatewayPort}/ || true`,
  );
  log.table([
    ["index.html identical", same ? "yes" : "NO", same ? "ok" : "bad"],
    ["Gateway answers", code.stdout.trim(), /^(200|30\d|401|403)$/.test(code.stdout.trim()) ? "ok" : "bad"],
  ]);
  if (!same) throw new Error("web-out differs after the rsync.");

  // Put a snapshot into the release so a rollback can restore the UI too.
  await ensureRelease(release);
  await rsyncUp(`${OUT}/`, `${config.remote.root}/releases/${release}/web-out/`, { del: true });
  log.ok("Web UI rolled out (no restart needed)");
}
