// The desktop client (remote mode). It has NO UI bundle of its own — it loads the web UI
// from the gateway (`win.loadURL(<gateway>)`). "Rolling out the client" therefore almost always means:
// web-out is current + restart the client. Only when the shell itself changed
// (main.js/preload/connect.html) — or the Electron version it is built against — must the bundle be swapped too.
//
// Order: AFTER the container swap and AFTER bringing the inner containers back.
// The client start calls `/gw/env/ensure` — if that finds a running, healthy
// container, the gateway leaves it alone; otherwise it replaces it (and the inner services
// are gone a second time).
import fs from "node:fs";
import path from "node:path";
import { REPO, config } from "../config.mjs";
import { act, isDryRun, probe, waitFor } from "../../check/lib/sh.mjs";
import { bundleSha, fileSha } from "../../check/lib/asar.mjs";
import { electronBundleAgainstModule } from "../../check/lib/electron-version.mjs";
import { machoSignatureVerdict } from "../../check/lib/macho-signature.mjs";
import { assertNoRootArtifacts } from "./web.mjs";
import { confirm } from "../lib/prompt.mjs";
import * as log from "../../check/lib/log.mjs";

const BUILT = path.join(REPO, "client/dist/mac-arm64/cbase Client.app");
const MAIN_SRC = path.join(REPO, "client/main.js");
// `node_modules/electron` lives here — the target version of every client bundle.
const CLIENT_DIR = path.join(REPO, "client");

// What goes into the bundle: the shell files live in app.asar, icon and asset catalog are files in
// Contents/Resources. A file missing from this list is NOT noticed and the old bundle stays — and one
// that is also missing from `files` in `client/package.json` is not packed at all.
// client/test/forwarding-rules.test.mjs holds every relative import of the shell against both lists.
// The list is the product file client/shell-files.json (client/test/forwarding-rules.test.mjs binds it to the imports of the shell).
const SHELL_FILES = JSON.parse(fs.readFileSync(path.join(REPO, "client/shell-files.json"), "utf8")).files;
const RESOURCES = [
  ["client/build/icon.icns", "Contents/Resources/icon.icns"],
  ["client/build/Assets.car", "Contents/Resources/Assets.car"],
];

// The files: shell in app.asar, icon and asset catalog. Hash comparisons, fractions of a second.
function clientShellDeviations(app) {
  const ab = [];
  for (const f of SHELL_FILES) if (bundleSha(app, f) !== fileSha(path.join(REPO, "client", f))) ab.push(f);
  for (const [src, rel] of RESOURCES) if (fileSha(path.join(app, rel)) !== fileSha(path.join(REPO, src))) ab.push(path.basename(rel));
  return ab;
}

// The runtime: Electron in the bundle against `client/node_modules/electron`. The decision above
// sees files only — a pure version jump (same main.js) would mean "unchanged → restart only", and
// the old bundle would stay. `opts` (`read`, `target`) only for the test.
export function clientElectron(app = config.local.clientApp, { read, target = CLIENT_DIR } = {}) {
  return electronBundleAgainstModule(app, target, { read });
}

// Does the installed bundle deviate from the working tree anywhere? List of deviations (empty =
// nothing to do). An UNKNOWN Electron version is a deviation — better one build too many
// than an old framework nobody read taken for current.
export function clientBundleDeviations(app = config.local.clientApp, electronOpts = {}) {
  if (!fs.existsSync(app)) return ["bundle missing"];
  const ab = clientShellDeviations(app);
  const el = clientElectron(app, electronOpts);
  if (!el.equal) ab.push(el.short);
  return ab;
}

// Does this client deploy ship any code at all? The answer decides whether the expensive
// test phase is needed (see deploy.mjs). "Shell" here means everything that demands a rebuild —
// files AND Electron version.
export function clientShellChanged() {
  return clientBundleDeviations().length > 0;
}

export async function deployClient({ release, force }) {
  const app = config.local.clientApp;
  const deviations = clientBundleDeviations(app);
  const shellChanged = deviations.length > 0;
  // The target state checked against three times below. Keep this line: dropping it makes the
  // deploy run through and die only in the final check ("srcSha is not defined"), AFTER the client restart.
  const srcSha = fileSha(MAIN_SRC);

  log.step("Client");
  // The WHY goes in the row: the Electron version can also trigger a rebuild, and a "changed" without
  // a reason would leave one guessing whether main.js or the framework is meant.
  log.table([["Client shell", shellChanged ? `changed (${deviations.join(", ")}) → swap bundle` : "unchanged → restart only", null]]);

  // A bundle that does not belong to US cannot be moved away: moving a directory into another
  // parent requires write permission IN the directory itself (POSIX must repoint its ".."). Seen:
  // `/Applications/cbase Client.app` belonged to root, the `mv` into the backup folder failed with
  // "Permission denied" — only AFTER the three-minute build, so the whole deploy including `--commit` aborted.
  // There is no way around the one `chown`. So check here, very early.
  if (shellChanged && fs.existsSync(app) && !isDryRun()) {
    const uid = fs.statSync(app).uid;
    if (uid !== process.getuid()) {
      throw new Error(
        `${app} belongs to uid ${uid}, not you — the bundle cannot be replaced that way. ` +
          `Once by hand, then again: sudo chown -R "$(id -un):staff" "${app}"`,
      );
    }
  }

  if (shellChanged) {
    await assertNoRootArtifacts(["client/dist"]);
    await act("npm", ["--prefix", "client", "run", "dist"], { cwd: REPO, timeout: 900000 });
    if (!isDryRun()) {
      if (!fs.existsSync(BUILT)) throw new Error(`Build result missing: ${BUILT}`);
      const builtSha = bundleSha(BUILT, "main.js");
      if (builtSha !== srcSha) throw new Error("The built client bundle does not contain the current main.js.");
      // Before the swap, not after: a bundle with the wrong framework is never installed
      // (same rule as the main.js hash — the bundle content, not the exit code).
      const built = clientElectron(BUILT);
      // Every Mach-O validly signed on its own (719 → 22 codesign calls, build 272 → 4 s) — the extension
      // list in `signIgnore` is a heuristic, and the builder's `--deep --strict` does not see an unsigned Mach-O under Resources.
      const sig = await machoSignatureVerdict(BUILT);
      log.table([
        ["Electron in built bundle", built.text, built.equal ? "ok" : "bad"],
        ["Mach-O in built bundle signed", sig.text, sig.ok ? "ok" : "bad"],
      ]);
      if (!built.equal) throw new Error(`The built client bundle does not carry the Electron from client/node_modules (${built.short}).`);
      if (!sig.ok) throw new Error(`The built client bundle is not fully validly signed — NOT installed (${sig.text}).`);
      log.ok("Client bundle built and checked");
    }
  }

  const running = (await clientPids(app)).length > 0;
  if (running || shellChanged) {
    await confirm(shellChanged ? "Quit the client and replace the bundle?" : "Restart the client?", {
      consequence: running ? "The open client view closes." : "",
    });
  }

  if (running) {
    await act("osascript", ["-e", `quit app "${config.local.clientAppName}"`], { check: false });
    // A dry run does not quit — so do not wait 45 s for the quit either.
    const gone = isDryRun() || await waitFor(async () => !(await clientPids(app)).length, { timeoutMs: 45000, label: "the client quitting" });
    if (!gone && !isDryRun()) log.warn("Client still running — the bundle swap might fail.");
  }

  if (shellChanged) {
    const backupDir = config.local.backups;
    if (fs.existsSync(app)) {
      await act("mkdir", ["-p", backupDir]);
      await act("mv", [app, path.join(backupDir, `cbase Client.app.previous-${release}`)]);
    }
    await act("ditto", [BUILT, app]);
    await pruneBackups(backupDir, "cbase Client.app.previous-");
  }

  await act("open", ["-a", app]);
  if (isDryRun()) return;

  const up = await waitFor(async () => (await clientPids(app)).length > 0, { timeoutMs: 30000, label: "the client start" });
  const nowSha = bundleSha(app, "main.js");
  const rest = fs.existsSync(app) ? clientShellDeviations(app) : ["bundle missing"];
  const el = clientElectron(app);
  log.table([
    ["Client running", up ? "yes" : "NO", up ? "ok" : "bad"],
    ["main.js in bundle", nowSha === srcSha ? "== working tree" : "DEVIATES", nowSha === srcSha ? "ok" : "bad"],
    ["Bundle (shell, icon, asset catalog)", rest.length ? `DEVIATES: ${rest.join(", ")}` : "== working tree", rest.length ? "bad" : "ok"],
    ["Electron in bundle == node_modules", el.text, el.equal ? "ok" : "bad"],
  ]);
  if (!up || nowSha !== srcSha || rest.length || !el.equal) throw new Error("Client deploy not confirmed.");
  log.ok(`Client on release ${release}`);
}

async function clientPids(app) {
  const r = await probe("pgrep", ["-f", `${app}/Contents/MacOS/`]);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// Remove the oldest backups beyond `keepBackups`.
export async function pruneBackups(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  const keep = config.local.keepBackups;
  const items = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort();
  for (const old of items.slice(0, Math.max(0, items.length - keep))) {
    await act("rm", ["-rf", path.join(dir, old)], { check: false });
    log.detail(`old backup removed: ${old}`);
  }
}
