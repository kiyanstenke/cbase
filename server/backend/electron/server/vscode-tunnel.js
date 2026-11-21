// VS Code Remote Tunnels in the user's own container.
//
// `code tunnel` (the VS Code CLI, in the image at /usr/local/bin/code) registers the container with
// Microsoft's tunnel service; VS Code (desktop or vscode.dev in the browser) then connects from any
// machine, without ssh, without a cbase client, without a script, without an open port. The price
// of this route: traffic goes through Microsoft, VS Code only, a GitHub/Microsoft account, one
// process per user.
//
// Shape: a child process of the backend, started on a button press and then at every server start
// while `vscode_tunnel.active` is set. The state is a state machine over the CLI's output lines;
// the CLI has no machine-readable interface for the login flow, only these lines:
//   To grant access to the server, please log into https://github.com/login/device and use code 5064-7E71
//   Open this link in your browser https://vscode.dev/tunnel/<name>/<cwd>
// Login runs as a SEPARATE step (`code tunnel user login --provider ...`) so the provider is
// selectable; the tunnel command itself silently takes GitHub. All CLI metadata (account token,
// registration) lives under ~/.cbase-vscode in the home volume and survives a container swap; the
// CLI downloads the servers per VS Code version itself (~/.vscode/cli/servers).
//
// TRAP: the CLI encrypts the account token in token.json with a key derived from the HOSTNAME
// (cli/src/auth.rs: `vscode_encrypt::encrypt(&HOSTNAME, ...)`). A container's hostname is its id,
// which changes on every swap, so `user show` then says "not logged in" and the restart lands in
// the login step although the file is there. `VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT` makes the CLI
// store the token unencrypted (0600, in the home volume next to ~/.claude and ~/.codex); on
// reading it accepts both forms. A token still encrypted with the old hostname costs ONE last login.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { T } from "./i18n.js";

const enabled = () => process.env.CBASE_VSCODE_TUNNEL === "1";
const dataDir = () => process.env.CBASE_VSCODE_DIR || path.join(os.homedir(), ".cbase-vscode");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const DEVICE_RE = /log into (https?:\/\/\S+) and use code ([A-Z0-9-]{4,})/i;
const LINK_RE = /(https:\/\/vscode\.dev\/tunnel\/[^\s"']+)/;
const ERROR_RE = /\berror\b\s+(.+?)\s*$/;
const MAX_ROWS = 60;
const MAX_RESTARTS = 5;
const backoffMs = () => Number(process.env.CBASE_VSCODE_BACKOFF_MS) || 3000;

let cliPath;
function findCli() {
  if (cliPath !== undefined) return cliPath;
  const candidates = [process.env.CBASE_CODE_CLI, "/usr/local/bin/code", ...String(process.env.PATH || "").split(path.delimiter).map((d) => d && path.join(d, "code"))].filter(Boolean);
  cliPath = candidates.find((k) => { try { fs.accessSync(k, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  return cliPath;
}
export const tunnelAvailable = () => enabled() && !!findCli();
export const normName = (x) => String(x || "").trim().toLowerCase();
export const nameValid = (x) => NAME_RE.test(normName(x));

// ── State ──────────────────────────────────────────────────────────────────────────────────
let proc = null;          // running child: login step or tunnel
let intended = false;      // should the tunnel run? (button, or setting at start)
let phase = "off";        // off · login · starts · connected · error
let name = "";
let provider = "github";
let account = "";           // output of `code tunnel user show`, empty = not logged in
let loginUrl = "", loginCode = "", link = "", error = "";
let version = null;       // `code --version`, read once
let rows = [];          // the last output lines, for "Details" in the pill
let restarts = 0;
let restartTimer = null;
let runItem = 0;             // counter so a late exit event does not overwrite a newer run

function env() { return { ...process.env, VSCODE_CLI_DATA_DIR: dataDir(), VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT: "1", NO_COLOR: "1" }; }
function remember(row) {
  const z = row.replace(/\r$/, "");
  if (!z.trim()) return;
  rows.push(z);
  if (rows.length > MAX_ROWS) rows = rows.slice(-MAX_ROWS);
}
function run(args, timeoutMs = 30_000) {
  const cli = findCli();
  if (!cli) return Promise.resolve({ code: 127, out: "", err: "no VS Code CLI" });
  return new Promise((resolve) => {
    execFile(cli, args, { env: env(), timeout: timeoutMs, maxBuffer: 1 << 20 }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out || ""), err: String(err || "") });
    });
  });
}
async function readAccount() {
  const r = await run(["tunnel", "user", "show"]);
  account = r.code === 0 ? r.out.trim().split(/\r?\n/).pop() || "" : "";
  return account;
}

// Read line by line: the CLI writes banner lines with \r\n, and a chunk can end in the middle of a
// line; the markers (device code, link) always sit in a whole line.
function rowsReader(stream, onTextLine) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    rest += chunk;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop();
    for (const z of parts) onTextLine(z);
  });
  stream.on("end", () => { if (rest.trim()) onTextLine(rest); rest = ""; });
}
function interpret(row) {
  remember(row);
  const d = DEVICE_RE.exec(row);
  if (d) { loginUrl = d[1]; loginCode = d[2]; phase = "login"; return; }
  const l = LINK_RE.exec(row);
  if (l) { link = l[1]; phase = "connected"; error = ""; loginUrl = ""; loginCode = ""; return; }
  const e = ERROR_RE.exec(row);
  if (e && !/^\[.*\]\s*(info|warn|debug|trace)\b/.test(row)) error = e[1];
}

function spawnCli(args) {
  const k = spawn(findCli(), args, { env: env(), cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"] });
  rowsReader(k.stdout, interpret);
  rowsReader(k.stderr, interpret);
  return k;
}

// The tunnel itself. If it ends unintentionally it comes back with backoff, up to the cap; then
// "error" stands with the last message, and the next click on Start begins anew.
function startTunnelValue() {
  const meinRun = ++runItem;
  phase = "starts"; link = ""; loginUrl = ""; loginCode = "";
  const k = spawnCli(["tunnel", "--accept-server-license-terms", "--name", name]);
  proc = k;
  k.on("error", (e) => { if (meinRun !== runItem) return; error = T`VS Code CLI cannot be started: ${e.message}`; phase = "error"; proc = null; });
  k.on("exit", (code, signal) => {
    if (meinRun !== runItem) return;
    proc = null;
    if (!intended) { phase = "off"; return; }
    if (restarts < MAX_RESTARTS) {
      restarts++;
      remember(`[cbase] tunnel ended (${signal || `code ${code}`}) - restart ${restarts}/${MAX_RESTARTS} in ${backoffMs() / 1000} s`);
      phase = "starts";
      restartTimer = setTimeout(() => { restartTimer = null; if (intended && meinRun === runItem) startTunnelValue(); }, backoffMs());
    } else {
      phase = "error";
      error = error || T`Tunnel ended repeatedly (${signal || `code ${code}`})`;
    }
  });
}

// Login as a separate step: show the device code, wait for the human, then start the tunnel.
function startLogin() {
  const meinRun = ++runItem;
  phase = "login"; loginUrl = ""; loginCode = ""; link = ""; error = "";
  const k = spawnCli(["tunnel", "user", "login", "--provider", provider]);
  proc = k;
  k.on("error", (e) => { if (meinRun !== runItem) return; error = T`VS Code CLI cannot be started: ${e.message}`; phase = "error"; proc = null; });
  k.on("exit", async (code) => {
    if (meinRun !== runItem) return;
    proc = null;
    if (!intended) { phase = "off"; return; }
    if (code !== 0) { phase = "error"; error = error || T("Sign-in not completed (code expired?)"); intended = false; return; }
    await readAccount();
    if (meinRun !== runItem || !intended) return;
    startTunnelValue();
  });
}

function end() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  runItem++;
  const k = proc;
  proc = null;
  if (k) { try { k.kill("SIGTERM"); } catch { /* already gone */ } }
}

// ── VS Code takes the `cbase-git` wrapper ─────────────────────────────────────────────────
// VS Code's git extension runs `git status`/`commit` itself, in B, including in repos of relocated projects whose hooks and
// `core.fsmonitor` the project container can write. So VS Code gets the wrapper server/backend/cbase-git (in the image
// /usr/bin/cbase-git) as `git.path`: if the working directory lies in a relocated project, the call goes through
// `cbase-project <id> -- git ...`, otherwise `exec git`. It is written into the server's MACHINE settings
// (`~/.vscode-server/data/Machine/settings.json`, the same place for Remote Tunnels and the Dev Containers route), ONLY this one
// key; everything else stays. Content that is not a JSON object (also JSON with comments) is NOT overwritten but reported (a
// line in the pill). Without the wrapper (local server, old image) nothing is written, since a `git.path` into the void would
// take VS Code's git away. Test seams: CBASE_GIT_WRAPPER, CBASE_VSCODE_MACHINE.
// If the file is a symlink (dotfiles), the TARGET is written (tmp in the target's folder, then rename); a rename onto the link
// would replace it with a plain file; a dangling link is not replaced but reported. A foreign `git.path` (also a list) is
// replaced and reported with its old value (console, `overwritten`, at tunnel start also in the pill): the old value must not
// vanish silently.
export const GIT_WRAPPER = "/usr/bin/cbase-git";
const gitWrapper = () => process.env.CBASE_GIT_WRAPPER || GIT_WRAPPER;
export const machineSettings = () => process.env.CBASE_VSCODE_MACHINE || path.join(os.homedir(), ".vscode-server", "data", "Machine", "settings.json");

/** `git.path` = the wrapper in the machine settings (see above). Never throws. */
export function enterGitPath() {
  const wrapper = gitWrapper();
  const file = machineSettings();
  try { fs.accessSync(wrapper, fs.constants.X_OK); } catch { return { skipped: `no wrapper ${wrapper}`, file }; }
  let values = {};
  let old = null;
  try { old = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e?.code !== "ENOENT") return { error: `${file} not readable: ${e?.message || e} - git.path not set`, file };
  }
  if (old !== null && old.trim()) {
    try { values = JSON.parse(old); } catch (e) { return { error: `${file} is not JSON (${e?.message || e}) - not overwritten, git.path not set`, file }; }
    if (!values || typeof values !== "object" || Array.isArray(values)) return { error: `${file} is not a JSON object - not overwritten, git.path not set`, file };
  }
  if (values["git.path"] === wrapper) return { unchanged: true, file };
  // The target: a symlink stays a symlink (see above). If the file does not exist, it is itself the target.
  let target = file;
  try { target = fs.realpathSync(file); } catch (e) {
    if (e?.code !== "ENOENT") return { error: `${file} not resolvable: ${e?.message || e} - git.path not set`, file };
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch { /* it does not exist */ }
    if (link) return { error: `${file} is a dangling symlink - not replaced, git.path not set`, file };
  }
  const prior = Object.prototype.hasOwnProperty.call(values, "git.path") ? values["git.path"] : undefined;
  values["git.path"] = wrapper;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(values, null, 4)}\n`);
    fs.renameSync(tmp, target);
  } catch (e) { return { error: `${file} not written: ${e?.message || e}`, file }; }
  if (prior === undefined) return { written: true, file };
  console.warn(`[vscode] git.path in ${file} was ${JSON.stringify(prior)} - replaced by ${wrapper}`);
  return { written: true, file, overwritten: prior };
}

// ── Public ─────────────────────────────────────────────────────────────────────────────────
// `code tunnel` runs Microsoft's VS Code Server, which is under Microsoft's own licence (not MIT). The CLI refuses to start without
// --accept-server-license-terms; cbase passes it only after the user accepted the terms in the UI (the pill shows the link) — the
// acceptance is stored per container, and the autostart after a restart needs it too. Guard: test/vscode-tunnel.test.js.
export const VSCODE_SERVER_LICENSE_URL = "https://aka.ms/vscode-server-license";
export const licenseAccepted = (store) => !!store?.getSetting("vscode_tunnel.license_accepted", "");

export async function startTunnel(store, { name: n, provider: p, acceptLicense = false } = {}) {
  if (!tunnelAvailable()) throw Object.assign(new Error(T("VS Code Remote Tunnels are not available in this environment")), { status: 409 });
  const fresh = normName(n || store.getSetting("vscode_tunnel.name", "") || "cbase");
  if (!nameValid(fresh)) throw Object.assign(new Error(T("Name: 1-20 characters, lowercase letters, digits and hyphens")), { status: 400 });
  if (acceptLicense === true && !licenseAccepted(store)) store.setSetting("vscode_tunnel.license_accepted", new Date().toISOString());
  if (!licenseAccepted(store)) {
    throw Object.assign(new Error(T`Accept the VS Code Server license terms first (${VSCODE_SERVER_LICENSE_URL})`), { status: 409, code: "LICENSE" });
  }
  provider = p === "microsoft" ? "microsoft" : p === "github" ? "github" : (store.getSetting("vscode_tunnel.provider", "") || "github");
  name = fresh;
  store.setSetting("vscode_tunnel.name", name);
  store.setSetting("vscode_tunnel.provider", provider);
  store.setSetting("vscode_tunnel.active", "1");
  end();
  intended = true;
  restarts = 0;
  error = "";
  await readAccount();
  // VS Code gets the wrapper as git.path before the tunnel starts; an error shows in the pill, the tunnel starts anyway.
  const gp = enterGitPath();
  if (gp.error) { remember(`[cbase] ${gp.error}`); console.warn(`[vscode-tunnel] ${gp.error}`); }
  if (gp.overwritten !== undefined) remember(`[cbase] git.path was ${JSON.stringify(gp.overwritten)} - replaced by ${gitWrapper()}`);
  if (account) startTunnelValue(); else startLogin();
}

export function stopTunnel(store) {
  intended = false;
  end();
  phase = "off"; link = ""; loginUrl = ""; loginCode = "";
  if (store) store.setSetting("vscode_tunnel.active", "0");
}

// Sign out = tunnel off, unregister the machine from the service, delete the account token. Both
// are idempotent (unregister without login: 0; logout without login: 1, irrelevant).
export async function unregister(store) {
  stopTunnel(store);
  await run(["tunnel", "unregister"]);
  await run(["tunnel", "user", "logout"]);
  account = ""; error = "";
}

export async function autostart(store) {
  if (!tunnelAvailable() || store.getSetting("vscode_tunnel.active", "") !== "1") return;
  if (!licenseAccepted(store)) return; // never accept on the user's behalf — the pill asks
  await startTunnel(store, {});
}

export async function tunnelStatus(store) {
  const available = tunnelAvailable();
  const out = { available, licenseAccepted: licenseAccepted(store), licenseUrl: VSCODE_SERVER_LICENSE_URL, phase, active: intended, name: name || normName(store?.getSetting("vscode_tunnel.name", "") || "cbase"), provider, account, loginUrl, loginCode, link, error, version: version || "", rows: rows.slice(-12) };
  if (!available) return out;
  if (version === null) { version = ""; const r = await run(["--version"], 10_000); version = (r.out.trim().split(/\r?\n/)[0] || "").replace(/\s*\(commit .*\)$/, ""); out.version = version; }
  if (!account && !proc) { await readAccount(); out.account = account; }
  if (!proc && !intended && phase !== "error") out.phase = phase = "off";
  return out;
}

export const _intern = { get proc() { return proc; }, get intended() { return intended; }, get restarts() { return restarts; }, get rows() { return rows; }, resetCli() { cliPath = undefined; } };
