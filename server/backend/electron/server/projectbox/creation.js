// The creation of a project container, PURE. A leaf: only `node:crypto` and `node:path`, no store, no docker, no file system —
// what it must know about the file system (exists? which content? which inode?) it gets as a function. The flow with the docker
// call, state and teardown is projectbox/instance.js.
//
// WHAT IS HERE
//   selectSubnet({ area, dockerNetworks, routes, addresses, innerPool, blockList })
//       The first /24 of `area` (level 2, 10.230.0.0/16) that touches none of those. The inner pool (10.241.0.0/16) must be
//       included because the Docker of the user container does not know it (it lives only in the daemon.json of the project
//       containers). Exhausted ⇒ error, never a silent overlap. An entry that is no CIDR throws — an unreadable occupancy is
//       not "free".
//   routesFrom(text)            the routes of /proc/net/route (without the default route): the user container has no iproute2,
//                              and a route that is no Docker network occupies all the same (WireGuard, LAN).
//   networkArgs({ projectId, network, instance, chatId })  `network create …` of the project network `cbase-pn-<id>` (of a
//                              copy: `cbase-kn-<id>-<name>`) with the bridge `cbp-<n>` (BRIDGE_PREFIX, n = third octet — at most 15 characters
//                              for the interface name).
//   mountsFor({ home, wsPath, projectPath, runtime, cliHome, data, system, exists, entries })
//       The mounts, from ONE rule table (mountRules): source = target, except the exception table of the CLI homes
//       (exceptionTable). Each row of the workspace level and of the exception table only if the source exists (`--mount
//       type=bind` on a missing source makes `docker run` fail — a `-v` would silently create it as a root-owned folder instead)
//       — except `cli-vscode-server`: it is ALWAYS there (`condition: "create"`), instance.js creates its source before the first
//       link check. The exception table has two kinds of targets: the HOME rules (`HOME_EXCEPTIONS`: `~/.local`,
//       `~/.vscode-server` — at the user path in the home of the container, source in the CLI home of the project) and the
//       files under `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (source in the home of B).
//   mountsHash(mounts, { inode })  the desired state of the mounts as sha256 (label `cbase.mounts.v2`; a recreation follows when
//       it differs): the sorted list, the inode of EVERY single file (a file bind binds the inode: a write in place the container
//       sees anyway, only a replacement by rename needs the recreation) and for each row of the frozen HASH_EXCEPTION_RULES
//       "existing" or "missing".
//   mountsHashV1(mounts, { content, inode })  the older formula (content of the read-only single files), UNCHANGED in the label
//       `cbase.mounts` — an older release reads that one, so a rollback does not recreate a container as long as the mount list is
//       the same: both formulas hash the list of mounts and per name in HASH_EXCEPTION_RULES "existing/missing". A new mount row
//       such as `cli-vscode-server` in a main changes both; a copy does not mount that row, so its two hashes stay unchanged. This
//       release reads `cbase.mounts.v2` first; a container WITHOUT it counts as equal if its v1 label equals the v1 of the CURRENT
//       state — then recreate.js records the current v2 as acknowledged in the instance row and compares against it from then on
//       (otherwise the first in-place write after a rollout would recreate every old container after all).
//   creationArgs({ projectId, network, image, mounts, hash, hashV1, cliHome })   `run -d --privileged --restart unless-stopped
//       --stop-timeout 30 …` — no `-p`, no `--init` (tini comes from the image), no `--memory`/`--cpus`; `hash` (v2) and `hashV1`
//       in their two labels.
//   creationViolations(args, ctx)           the CHECK FUNCTION over a finished argument array: every deviation from the contract
//       as a sentence. createInstance calls it before every `run` (a violation ⇒ no creation); the guard runs it against variants.
//
// THE CONTRACT: a project container never has a published port, never a mount outside the list, never a home directory other
// than its own. Guard: server/backend/test/projectbox-creation.test.js.
//
// THE INSTANCE: every name, label, network and mount function takes the instance — `main` (default) or `copy-<name>` (container
// `cbase-k-<pid>-<name>`, network `cbase-kn-<pid>-<name>`, volume `cbase-k-<pid>-<name>-docker`, labels `cbase.instance=copy-<name>`
// and `cbase.chat=<chatId>`). A copy has its own rule table (mountRulesCopy): the project folder read-only under
// `/cbase-main<orig>`, its root `<data>/copies/<pid>/<name>` under `/cbase-copy`, no bind for `~/.local` and none for
// `~/.vscode-server`. For `main`, arguments, mounts, `mountsHash` and names are byte-equal with the stage before copies (anchor
// server/backend/test/fixtures/projectbox/main-creation.json) — except the second label `cbase.mounts.v2` and the row
// `cli-vscode-server` (one mount more, both hashes new). For a COPY, mounts and both hashes are unchanged by that row (it is
// missing there, and the hash rows "exception …" run over the frozen list HASH_EXCEPTION_RULES — otherwise every running copy
// would have been recreated for nothing: terminals and write layer gone; anchor in projectbox-creation.test.js "N56 Kopie").
import crypto from "node:crypto";
import path from "node:path";

// ── Names and fixed values ──────────────────────────────────────────────────────────────────────────────────────────

export const MAIN = "main";
export const LABEL_PROJECT = "cbase.project";
export const LABEL_INSTANCE = "cbase.instance";
export const LABEL_MOUNTS = "cbase.mounts";
/** The hash by the NEW formula (mountsHash, inode of every single file) in a label of its own — `cbase.mounts` keeps the old one
 *  (mountsHashV1), which the older release understands. This release reads this one first. */
export const LABEL_MOUNTS_V2 = "cbase.mounts.v2";
/** The image of the project containers in the user container — `:latest` points there only at tested images. */
export const PROJECTBOX_IMAGE = "cbase-projectbox:latest";
/** Level 2: one /24 per project. The fence of the API recognises project networks by this range. */
export const LEVEL2_AREA = "10.230.0.0/16";
/** The pool of the inner dockerd of EVERY project container (daemon.json of the entrypoint), size 24. */
export const INNER_POOL = "10.241.0.0/16";
/**
 * Host networks a project network must never touch that B cannot see from inside its container (the host's LAN, VPN interfaces,
 * host bridges): comma-separated IPv4 CIDRs in CBASE_SUBNET_BLOCK_LIST, which the gateway hands to every user container it creates.
 * Empty by default — routes, addresses and Docker networks visible in B are always checked (selectSubnet).
 */
export const BLOCK_LIST = Object.freeze(String(process.env.CBASE_SUBNET_BLOCK_LIST || "").split(",").map((x) => x.trim()).filter(Boolean));
/**
 * The prefix of bridge AND hostname of a project container: `cbp-<n>` (n = third octet of its /24). ONE place — entry.sh matches it as
 * `-i cbp-+` (chain CBASE-PROJ), browser-network.js as PROJECT_HOSTNAME, the deploy tool's network-separation check as `-i cbp-+`. Four
 * characters, so `cbp-255` stays far below the 15 characters of an interface name. Older releases used another prefix
 * (hard cut, no alias): an older network is recreated by instance.js networkFor, an older container is stopped by the restore
 * (restore.js, step container) and recreated; a rollback to a release before it is locked (capability `bridge-cbp`).
 */
export const BRIDGE_PREFIX = "cbp-";
/** Bridge and hostname of the /24 with the third octet `n`. */
export const bridgeName = (n) => `${BRIDGE_PREFIX}${n}`;
/** `--stop-timeout` of the project container: 30 s (measured 11.6–12.4 s with a running stack). */
export const STOP_DEADLINE_S = 30;
/** The environment names `run` may set — paths, no secrets. */
export const CREATION_ENVIRONMENT = Object.freeze(["CBASE_DOCKER_POOL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HISTFILE"]);

// ── The instance ───────────────────────────────────────────────────────────────────────────────────────────────────
// An instance is called `main` or `copy-<name>`. The FORM of the name lives here (not in stacks/names.js) because every name,
// network and mount function of this leaf must check it and projectbox/ never imports from stacks/; stacks/names.js builds the
// rule on it (not `main`, automatic `k<n>`, free only without a living row and without a ref). For `main` all names, labels and
// arguments are unchanged (anchor server/backend/test/fixtures/projectbox/main-creation.json).
export const COPY_PREFIX = "copy-";
/** The form of the name of a copy: usable as DNS and branch name, 1–24 characters, no hyphen at the edge. */
export const COPY_NAME = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;
/** The label of the trace to the chat of a copy — a trace, never the truth (that stands in `stack_copies`). */
export const LABEL_CHAT = "cbase.chat";
/**
 * The value of this label for a copy WITHOUT a chat (a human creates it, `chat_id` is NULL). A copy still carries the label exactly
 * once (creationViolations) so the orphan search (stacks/remove.js: filter on the label) finds it; the chat "without-chat" never
 * exists — so it is an orphan as soon as its row and instance row are gone.
 */
export const LABEL_CHAT_WITHOUT = "without-chat";
// Chat and project ids: the same form as runs/runtime-location.js (they stand in labels and paths).
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/**
 * The folder of the copies under the data folder: `<data>/copies/<projectId>/<name>/` — never mounted into the main, in a copy only
 * its own subfolder (under COPY_ROOT_INSIDE). The subpaths (layers, objects, journal files) belong to stacks/location.js; only the
 * name of the folder and the root of a copy (`copyRoot`) stand here, and stacks/location.js takes the latter over.
 */
export const COPIES_FOLDER = "copies";
/** Where a copy in the container sees its root and the main (server/backend/projectbox-entry.sh). */
export const COPY_ROOT_INSIDE = "/cbase-copy";
export const MAIN_BOTTOM_INSIDE = "/cbase-main";

/** The name of the copy from its instance (`copy-<name>` → `<name>`), `null` for `main`; any other form THROWS. */
export function copyNameOf(instance = MAIN) {
  const i = instance === undefined || instance === null ? MAIN : String(instance);
  if (i === MAIN) return null;
  const name = i.startsWith(COPY_PREFIX) ? i.slice(COPY_PREFIX.length) : "";
  if (!COPY_NAME.test(name) || name === MAIN) throw new TypeError(`not an instance: “${i}” — “${MAIN}” or “${COPY_PREFIX}<name>”`);
  return name;
}
/** The instance of a copy (`<name>` → `copy-<name>`); a name outside the form THROWS. */
export function copyInstance(name) {
  const i = `${COPY_PREFIX}${name}`;
  copyNameOf(i);
  return i;
}
export const isCopy = (instance) => copyNameOf(instance) !== null;
const checkChat = (chatId, instance) => {
  if (!VALID_ID.test(String(chatId ?? ""))) throw new TypeError(`copy ${instance}: without a valid chat id (label ${LABEL_CHAT}) — “${chatId ?? ""}”`);
  return String(chatId);
};

export const containerName = (projectId, instance = MAIN) => {
  const k = copyNameOf(instance);
  return k === null ? `cbase-p-${projectId}` : `cbase-k-${projectId}-${k}`;
};
export const networkName = (projectId, instance = MAIN) => {
  const k = copyNameOf(instance);
  return k === null ? `cbase-pn-${projectId}` : `cbase-kn-${projectId}-${k}`;
};
export const volumeName = (projectId, instance = MAIN) => {
  const k = copyNameOf(instance);
  return k === null ? `cbase-p-${projectId}-docker` : `cbase-k-${projectId}-${k}-docker`;
};
/** `<data>/copies/<projectId>/<name>` of a copy. For `main` it THROWS — the main has none. */
export function copyRoot({ data, projectId, instance }) {
  const k = copyNameOf(instance);
  if (k === null) throw new TypeError("copyRoot: the main has no copy root");
  if (typeof data !== "string" || !path.isAbsolute(data)) throw new TypeError("copyRoot: data must be an absolute path");
  if (!VALID_ID.test(String(projectId ?? ""))) throw new TypeError(`copyRoot: invalid project id “${projectId}”`);
  return path.join(data, COPIES_FOLDER, String(projectId), k);
}

// ── Addresses ───────────────────────────────────────────────────────────────────────────────────────────────────────

function ipCount(ip) {
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
}
const ipText = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** "a.b.c.d/n" (or a bare address = /32) → `{ start, end }` of the network; anything else → null. */
export function cidrRange(cidr) {
  const [ip, length = "32", rest] = String(cidr).trim().split("/");
  if (rest !== undefined || !/^\d{1,2}$/.test(length) || Number(length) > 32) return null;
  const base = ipCount(ip);
  if (base === null) return null;
  const size = 2 ** (32 - Number(length));
  const start = base - (base % size);
  return { start, end: start + size - 1 };
}
const touched = (a, b) => a.start <= b.end && b.start <= a.end;

/**
 * The first free /24 of `area`. Returns `{ subnet, n, gateway, ip, bridge, hostname }`: the network `<s>.0/24`, its gateway `<s>.1`
 * (the bridge in B, at the same time the address of the backend from the container's view), the fixed address of the container
 * `<s>.2`, bridge and hostname `cbp-<n>` (bridgeName) with n = third octet.
 */
export function selectSubnet({ area = LEVEL2_AREA, dockerNetworks = [], routes = [], addresses = [], innerPool = INNER_POOL, blockList = BLOCK_LIST } = {}) {
  const b = cidrRange(area);
  if (!b || b.end - b.start + 1 < 256) throw new Error(`selectSubnet: not a range of /24 networks: ${area}`);
  const occupied = [];
  for (const [what, list] of [["Docker network", dockerNetworks], ["route", routes], ["address", addresses], ["inner pool", [innerPool]], ["block list", blockList]]) {
    for (const entry of list || []) {
      const r = cidrRange(entry);
      if (!r) throw new Error(`selectSubnet: ${what} “${entry}” is not an IPv4 CIDR — an unreadable occupancy is not free`);
      occupied.push(r);
    }
  }
  for (let s = b.start; s + 255 <= b.end; s += 256) {
    const block = { start: s, end: s + 255 };
    if (occupied.some((r) => touched(r, block))) continue;
    const base = ipText(s).split(".").slice(0, 3).join(".");
    const n = (s >>> 8) & 255;
    return { subnet: `${base}.0/24`, n, gateway: `${base}.1`, ip: `${base}.2`, bridge: bridgeName(n), hostname: bridgeName(n) };
  }
  throw new Error(`no free /24 left in ${area} — each touches a Docker network, a route, an address, the inner pool or the block list`);
}

/** The fields of an already chosen /24 (recreation with the same address). */
export function networkFromSubnet(subnet) {
  const m = String(subnet || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  if (!m || !cidrRange(subnet)) throw new Error(`not a /24: ${subnet}`);
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  const n = Number(m[3]);
  return { subnet: `${base}.0/24`, n, gateway: `${base}.1`, ip: `${base}.2`, bridge: bridgeName(n), hostname: bridgeName(n) };
}

const hexIp = (h) => [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => parseInt(x, 16)).join(".");
const bits = (n) => { let c = 0; for (let x = n >>> 0; x; x >>>= 1) c += x & 1; return c; };

/** /proc/net/route → ["a.b.c.d/n", …] without the default route (mask 0). Values stand there in hexadecimal, little-endian. */
export function routesFrom(text) {
  const out = [];
  const rows = String(text || "").split("\n");
  for (const row of rows.slice(1)) {
    const f = row.trim().split(/\s+/);
    if (f.length < 8 || !/^[0-9A-Fa-f]{8}$/.test(f[1]) || !/^[0-9A-Fa-f]{8}$/.test(f[7])) continue;
    const prefix = bits(ipCount(hexIp(f[7])));
    if (prefix === 0) continue;
    out.push(`${hexIp(f[1])}/${prefix}`);
  }
  return [...new Set(out)];
}

/**
 * `network create …` of the network of an instance. For `main` as before copies existed; a copy carries its instance and the trace
 * to the chat (`cbase.chat`) and is called `cbase-kn-<projectId>-<name>` — with its own /24 and its own bridge `cbp-<n>` (the chain
 * CBASE-PROJ of entry.sh matches it through `cbp-+` unchanged).
 */
export function networkArgs({ projectId, network, instance = MAIN, chatId }) {
  const copy = isCopy(instance);
  return [
    "network", "create", "--driver", "bridge", "--subnet", network.subnet, "--gateway", network.gateway,
    "-o", `com.docker.network.bridge.name=${network.bridge}`,
    "--label", `${LABEL_PROJECT}=${projectId}`, "--label", `${LABEL_INSTANCE}=${copy ? instance : MAIN}`,
    ...(copy ? ["--label", `${LABEL_CHAT}=${checkChat(chatId, instance)}`] : []),
    networkName(projectId, instance),
  ];
}

// ── Mounts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The exception table: source ≠ target. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point in the project container at `<cliHome>/.claude`
 * and `<cliHome>/.codex` (cliHome = `<runtime>/home`); the CLI then reads `settings.json`, `CLAUDE.md`, `agents/` and `config.toml`,
 * `auth.json` from THERE — mounted at the user path it would read none. `~/.local` is per project and lies at the user path in
 * the container.
 *
 * `~/.vscode-server` per project: VS Code (Dev Containers over the remote tunnel) puts its server in the home of the container —
 * formerly in the WRITE LAYER, and every recreation (image or mounts differ) threw it away; the next opening downloaded ≈ 221 MB
 * from the Mac through the tunnel relay (≈ 8½ min, no progress — it looked like a hang). Like `~/.local`: source in the CLI home of
 * the project, target at the user path, rw. Unlike `~/.local` the row is ALWAYS there (`condition: "create"` instead of
 * "exists"): a row that appeared only after the first creation would recreate every container a second time. The source is created
 * in instance.js BEFORE the first link check (it lies under the runtime folder that every container of the project mounts rw).
 * projectbox/vscode-server.js cleans up the old versions after each `ready` of the main.
 */
// The name in the home: target of the rule `cli-vscode-server`, its source lies in the CLI home of the project — and the
// `~/.vscode-server` of B (its own VS Code server, vscode-tunnel.js) is in `neverMounted`.
export const VSCODE_SERVER = ".vscode-server";
export function exceptionTable({ home, cliHome }) {
  const claude = path.join(cliHome, ".claude");
  const codex = path.join(cliHome, ".codex");
  return [
    { rule: "cli-local", source: path.join(cliHome, ".local"), target: path.join(home, ".local"), kind: "folder", rw: true, reason: "~/.local per project" },
    { rule: "cli-vscode-server", source: path.join(cliHome, VSCODE_SERVER), target: path.join(home, VSCODE_SERVER), kind: "folder", rw: true, condition: "create", reason: "~/.vscode-server per project — survives every recreation" },
    { rule: "cli-claude-settings", source: path.join(home, ".claude", "settings.json"), target: path.join(claude, "settings.json"), kind: "file", rw: false, reason: "settings of the Claude CLI" },
    { rule: "cli-claude-md", source: path.join(home, ".claude", "CLAUDE.md"), target: path.join(claude, "CLAUDE.md"), kind: "file", rw: false, reason: "CLAUDE.md of the user" },
    { rule: "cli-claude-agents", source: path.join(home, ".claude", "agents"), target: path.join(claude, "agents"), kind: "folder", rw: false, reason: "own agents of the user" },
    { rule: "cli-codex-config", source: path.join(home, ".codex", "config.toml"), target: path.join(codex, "config.toml"), kind: "file", rw: false, reason: "Codex configuration" },
    { rule: "cli-codex-auth", source: path.join(home, ".codex", "auth.json"), target: path.join(codex, "auth.json"), kind: "file", rw: true, reason: "Codex login, shared" },
  ];
}
export const EXCEPTION_RULES = Object.freeze(["cli-local", "cli-vscode-server", "cli-claude-settings", "cli-claude-md", "cli-claude-agents", "cli-codex-config", "cli-codex-auth"]);
/**
 * The names over which both hash formulas each write a row "exception <rule> existing|missing" — FROZEN to the table before
 * `cli-vscode-server`. A new rule is in the hash anyway through its `mount` row where it is mounted (`cli-vscode-server` always in
 * the main); a "missing" row would instead change the hash of EVERY instance that does not mount it — the copy (mountRulesCopy)
 * would have been recreated once without a changed mount list (terminals and write layer gone). This list never grows; a new
 * exception rule whose absence SHOULD change the hash needs a decision of its own.
 */
export const HASH_EXCEPTION_RULES = Object.freeze(["cli-local", "cli-claude-settings", "cli-claude-md", "cli-claude-agents", "cli-codex-config", "cli-codex-auth"]);
/**
 * The HOME rules of the exception table: their target lies directly in the home of the project container, at the user path
 * (`<home>/.local`, `<home>/.vscode-server`) — every other row of the table targets under `CLAUDE_CONFIG_DIR`/`CODEX_HOME`
 * (creationViolations checks both). A copy mounts neither (mountRulesCopy, each with its own reason).
 */
export const HOME_EXCEPTIONS = new Set(["cli-local", "cli-vscode-server"]);

// The workspace level: only these files, never the whole `.claude/` (all workspace skills lie there; a project chat gets only the
// adopted ones).
const WS_FILES = ["CLAUDE.md", "AGENTS.md", ".mcp.json"];
const WS_CLAUDE_FILE = (name) => name === "CLAUDE.md" || /^settings[^/]*\.json$/.test(name);
// Caches, shared and writable; created BEFORE the `run` as agent — otherwise the inner dockerd creates them as root. They apply
// ONLY between project containers: B itself loads from `B_CACHE_FOLDER` (below).
const CACHES = [".npm", ".cache/uv", ".cache/ms-playwright", ".cache/pip"];
/**
 * The package caches of B, relative to the home: the backend stage of the Dockerfile sets `npm_config_cache`, `UV_CACHE_DIR`,
 * `PIP_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` to folders below. B loads code from there (npx, uvx, pip, playwright) — a writable
 * mount over it would mean: a project container writes code that B executes. So it is in `neverMounted`, and no entry of CACHES
 * lies in it. Guard: projectbox-creation.test.js (reads the four values from the Dockerfile).
 */
export const B_CACHE_FOLDER = ".cache/cbase-b";
const HOME_FILES = [".gitconfig", ".bashrc", ".profile"];
/** The paths from the root file system of B (one version, one pin). */
export const SYSTEM_PATHS = Object.freeze({ usrLocalBin: "/usr/local/bin", usrLocalNodeModules: "/usr/local/lib/node_modules", mcp: "/app/electron/mcp" });
/** The shared login directory of the Claude CLI — at the same path in the container. */
export const LOGIN_FOLDER = ".claude-login";

/**
 * All mounts that MAY exist for this context — the ONE rule table. `condition`: "required" (if the source is missing there is no
 * creation), "exists" (only if the source exists), "create" (the creation creates the source beforehand as agent — the package
 * caches in the home of B and `cli-vscode-server` in the CLI home of the project). Rows of the exception table carry "exists" if
 * they name no condition themselves. `ws-claude` is a pattern (settings*.json), hence `entries`. The table creates nothing: a row
 * with "create" is always in, even if its source is (still) missing — the desired-state computation (instance.js, recreate.js) and
 * the creation see the same list.
 */
export function mountRules({ home, wsPath, projectPath, runtime, cliHome = path.join(runtime, "home"), system = SYSTEM_PATHS, entries = () => [] }) {
  const equal = (rule, p, kind, rw, condition, reason) => ({ rule, source: p, target: p, kind, rw, condition, reason });
  const r = [equal("project", projectPath, "folder", true, "required", "the project folder with all repos")];
  if (wsPath) {
    for (const n of WS_FILES) r.push(equal(`ws-${n}`, path.join(wsPath, n), "file", false, "exists", "workspace level, read-only"));
    const wsClaude = path.join(wsPath, ".claude");
    let names = [];
    try { names = (entries(wsClaude) || []).filter(WS_CLAUDE_FILE).sort(); } catch { names = []; }
    if (!names.includes("CLAUDE.md")) names.unshift("CLAUDE.md");
    for (const n of names) r.push(equal(`ws-.claude/${n}`, path.join(wsClaude, n), "file", false, "exists", "workspace level, only settings*.json and CLAUDE.md"));
  }
  r.push(equal("runtime", runtime, "folder", true, "required", "the runtime folder of the project"));
  for (const c of CACHES) r.push(equal(`cache-${c}`, path.join(home, c), "folder", true, "create", "package cache, shared"));
  for (const d of HOME_FILES) r.push(equal(`home-${d}`, path.join(home, d), "file", false, "exists", "user file, read-only"));
  r.push(equal("system-bin", system.usrLocalBin, "folder", false, "required", "Node and the pinned CLIs"));
  r.push(equal("system-node_modules", system.usrLocalNodeModules, "folder", false, "required", "Node and the pinned CLIs"));
  r.push(equal("system-mcp", system.mcp, "folder", false, "required", "the cbase MCP"));
  r.push(equal("login", path.join(home, LOGIN_FOLDER), "folder", true, "exists", "login directory, shared"));
  for (const a of exceptionTable({ home, cliHome })) r.push({ ...a, condition: a.condition || "exists" });
  return r;
}

/**
 * The second rule table: the mounts of a COPY. Like the main, except at three places:
 *   - the rule "project" (project folder rw at the original path) becomes "main-bottom" (the same folder READ-ONLY under
 *     `/cbase-main<orig>` — the bottom layer of the overlays that the entrypoint mounts before dockerd) and "copy-root"
 *     (`<data>/copies/<pid>/<name>` rw under `/cbase-copy` — layers, objects, overlays.tsv);
 *   - "cli-local" is dropped as a bind: `~/.local` becomes an overlay in the copy, the project's one below. No bind goes to a
 *     target from overlays.tsv.
 *   - "cli-vscode-server" is dropped: a copy shares the CLI home of the main (instance.js takes the same location for every
 *     instance), a bind would mean two VS Code servers — main and copy, each with its own processes and lock files — on ONE data
 *     folder. In the copy `~/.vscode-server` therefore stays in the write layer of its container.
 * So a copy never carries the project folder rw at the original path. The table of the main stays as it is.
 */
export function mountRulesCopy({ instance, data, projectId, ...ctx }) {
  const root = copyRoot({ data, projectId, instance });
  const r = [];
  for (const m of mountRules(ctx)) {
    if (m.rule === "project") {
      r.push({ rule: "main-bottom", source: m.source, target: path.join(MAIN_BOTTOM_INSIDE, m.source), kind: "folder", rw: false, condition: "required", reason: "the project folder of the main, read-only — the bottom layer of the overlays" });
      r.push({ rule: "copy-root", source: root, target: COPY_ROOT_INSIDE, kind: "folder", rw: true, condition: "required", reason: "the root of THIS copy: layers, objects, overlays.tsv" });
      continue;
    }
    if (m.rule === "cli-local") continue; // ~/.local becomes an overlay
    if (m.rule === "cli-vscode-server") continue; // the CLI home is the main's — one data folder, two servers (see header)
    r.push(m);
  }
  return r;
}

/** The two rules with which a copy may mount source ≠ target (besides the exception table of the CLI homes). */
export const COPY_RULES = new Set(["main-bottom", "copy-root"]);

/** The rule table of the instance in the context (`ctx.instance`, `main` by default). */
export const mountRulesFor = (ctx) => (isCopy(ctx.instance) ? mountRulesCopy(ctx) : mountRules(ctx));

/**
 * The mounts for the creation: the rules, each row with `condition: "exists"` only if `exists(source, kind)`. The required rows and
 * those to create always stay in — whether they exist is checked and ensured by the creation. The table is that of the instance
 * (`ctx.instance`); by default that of the main.
 * @returns {{ rule, source, target, kind, rw, condition, reason }[]}
 */
export function mountsFor({ exists = () => false, ...ctx }) {
  return mountRulesFor(ctx).filter((m) => m.condition !== "exists" || exists(m.source, m.kind));
}

const sha = (x) => crypto.createHash("sha256").update(x ?? "").digest("hex");

/**
 * The desired state of the mounts (label `cbase.mounts.v2`). `inode(path)` → number or null (unreadable). The same mounts and the
 * same inodes give the same hash; a new workspace file, a new inode of any single file (a rename: `codex login` for `auth.json`,
 * an editor that saves by replacing) or a newly appeared source of the exception table give another — a write in place does NOT
 * (the file bind shows it to the container anyway). `content` is no longer read (only mountsHashV1).
 */
export function mountsHash(mounts, { inode = () => null } = {}) {
  const h = crypto.createHash("sha256");
  h.update("cbase-mounts-v2\n");
  const sorted = [...mounts].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  for (const m of sorted) h.update(`mount\t${m.kind}\t${m.rw ? "rw" : "ro"}\t${m.source}\t${m.target}\n`);
  for (const m of sorted) {
    if (m.kind !== "file") continue;
    const i = inode(m.source);
    h.update(`inode\t${m.source}\t${i === null || i === undefined ? "unreadable" : String(i)}\n`);
  }
  const existing = new Set(mounts.map((m) => m.rule));
  for (const r of HASH_EXCEPTION_RULES) h.update(`exception\t${r}\t${existing.has(r) ? "existing" : "missing"}\n`);
  return h.digest("hex");
}

/**
 * The older formula, unchanged: instead of the inode the CONTENT of every read-only single file (`content(path)` → Buffer/text or
 * null). Every creation keeps writing it into the label `cbase.mounts` — for the older release (rollback; only holds with the same
 * mount list — a new mount row such as `cli-vscode-server` in the main changes it like the new one; a copy stays equal, see
 * header). This release compares it only for a container WITHOUT `cbase.mounts.v2` (transition, see header and recreate.js).
 */
export function mountsHashV1(mounts, { content = () => null, inode = () => null } = {}) {
  const h = crypto.createHash("sha256");
  h.update("cbase-mounts-v1\n");
  const sorted = [...mounts].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  for (const m of sorted) h.update(`mount\t${m.kind}\t${m.rw ? "rw" : "ro"}\t${m.source}\t${m.target}\n`);
  for (const m of sorted) {
    if (m.kind !== "file") continue;
    if (m.rw) {
      const i = inode(m.source);
      h.update(`inode\t${m.source}\t${i === null || i === undefined ? "unreadable" : String(i)}\n`);
    } else {
      const x = content(m.source);
      h.update(`content\t${m.source}\t${x === null || x === undefined ? "unreadable" : sha(x)}\n`);
    }
  }
  const existing = new Set(mounts.map((m) => m.rule));
  for (const r of HASH_EXCEPTION_RULES) h.update(`exception\t${r}\t${existing.has(r) ? "existing" : "missing"}\n`);
  return h.digest("hex");
}

// ── The arguments of `run` ────────────────────────────────────────────────────────────────────────────────────────

// A path in `--mount` is a CSV field: a comma, a quote or a line break in it would shift the fields (`src=/a,b` would make the
// option `b`). The check function rejects such paths instead of quoting them.
const MOUNT_ENEMY = /[,"\n\r]/;
const bindText = (m) => `type=bind,src=${m.source},dst=${m.target}${m.rw ? "" : ",readonly"}`;

// `instance` (default `main`, then identical to before copies) and for a copy `chatId` (label `cbase.chat`, a trace — the truth
// stands in `stack_copies`). Name, network and volume come from the instance. `hashV1` (old formula) in `cbase.mounts`, `hash`
// (new) in `cbase.mounts.v2`. If one is missing, its label is missing — the check function reports it (no creation).
export function creationArgs({ projectId, network, image, mounts, hash, hashV1, cliHome, instance = MAIN, chatId }) {
  const copy = isCopy(instance);
  return [
    "run", "-d", "--privileged", "--restart", "unless-stopped", "--stop-timeout", String(STOP_DEADLINE_S),
    "--name", containerName(projectId, instance), "--hostname", network.hostname,
    "--label", `${LABEL_PROJECT}=${projectId}`, "--label", `${LABEL_INSTANCE}=${copy ? instance : MAIN}`,
    ...(copy ? ["--label", `${LABEL_CHAT}=${checkChat(chatId, instance)}`] : []),
    ...(hashV1 ? ["--label", `${LABEL_MOUNTS}=${hashV1}`] : []),
    ...(hash ? ["--label", `${LABEL_MOUNTS_V2}=${hash}`] : []),
    "--network", networkName(projectId, instance), "--ip", network.ip,
    "-e", `CBASE_DOCKER_POOL=${INNER_POOL}`,
    "-e", `CLAUDE_CONFIG_DIR=${path.join(cliHome, ".claude")}`,
    "-e", `CODEX_HOME=${path.join(cliHome, ".codex")}`,
    // The history of the login shell (terminal `bash -l`) lies in the runtime folder, not in the layer of the container —
    // otherwise every recreation would lose it.
    "-e", `HISTFILE=${path.join(cliHome, ".bash_history")}`,
    "--mount", `type=volume,src=${volumeName(projectId, instance)},dst=/var/lib/docker`,
    ...mounts.flatMap((m) => ["--mount", bindText(m)]),
    image,
  ];
}

// ── The check function ─────────────────────────────────────────────────────────────────────────────────────────────

// The options `run` may carry for a project container — everything else is a violation. The named prohibitions get a sentence of
// their own (no published port, no host network; `-v` silently creates missing sources; `--init` doubles tini).
const WITH_VALUE = new Set(["--restart", "--stop-timeout", "--name", "--hostname", "--label", "--network", "--ip", "-e", "--mount"]);
const WITHOUT_VALUE = new Set(["-d", "--privileged"]);
const FORBIDDEN = {
  "-p": "published port (-p)", "--publish": "published port (--publish)", "-P": "all ports published (-P)",
  "--publish-all": "all ports published (--publish-all)", "-v": "mount per -v (silently creates missing sources)",
  "--volume": "mount per --volume (silently creates missing sources)", "--init": "--init (tini comes from the image)",
  "--memory": "limit --memory (none allowed)", "-m": "limit -m (none allowed)", "--cpus": "limit --cpus (none allowed)",
};
// The forbidden options that carry a value — the value belongs to them and is no argument of its own.
const FORBIDDEN_WITH_VALUE = new Set(["-p", "--publish", "-v", "--volume", "--memory", "-m", "--cpus"]);

function mountFields(text) {
  const f = {};
  for (const part of String(text).split(",")) {
    const k = part.indexOf("=");
    if (k < 0) f[part] = true; else f[part.slice(0, k)] = part.slice(k + 1);
  }
  return { type: f.type || "volume", source: f.src ?? f.source ?? "", target: f.dst ?? f.destination ?? f.target ?? "", ro: !!(f.readonly || f.ro) };
}

const liesIn = (p, root) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Violations of a `run` argument against the contract — `[]` means: may be created like this. `ctx.instance` (default `main`) —
 * checked against the instance: name, network, volume and labels from it, the rule table of the instance (mountRulesFor), exactly
 * ONE label `cbase.instance`; a copy carries exactly one label `cbase.chat` (with `ctx.chatId`, if given, this one), never
 * `cbase.instance=main`, never a mount at or above the original path of the project folder, and of `<data>/copies` only its own
 * subfolder.
 * @param {string[]} args
 * @param {object} ctx  projectId, home, runtime, cliHome, projectPath, wsPath, data, system, image (optional),
 *                      `foreignRoots` (the roots of OTHER projects and of EVERY workspace), `neverMounted` (neverMounted()),
 *                      `isFile(path)` (for the named file mounts), `entries(dir)` (as mountsFor)
 */
export function creationViolations(args, ctx) {
  const v = [];
  const { projectId } = ctx;
  const instance = ctx.instance ?? MAIN;
  let copy;
  try { copy = isCopy(instance); } catch (e) { return [e.message]; }
  const cliHome = ctx.cliHome || path.join(ctx.runtime, "home");
  if (!Array.isArray(args) || args[0] !== "run") return ["not a `run` call"];
  const values = new Map();
  const add = (k, x) => { if (!values.has(k)) values.set(k, []); values.get(k).push(x); };
  let i = 1;
  for (; i < args.length - 1; i++) {
    const raw = String(args[i]);
    const [name, equal] = raw.startsWith("--") && raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    if (FORBIDDEN[name]) {
      v.push(`forbidden: ${FORBIDDEN[name]}`);
      if (FORBIDDEN_WITH_VALUE.has(name) && equal === undefined) i++;
      continue;
    }
    if (WITHOUT_VALUE.has(name)) { add(name, true); continue; }
    if (WITH_VALUE.has(name)) { add(name, equal !== undefined ? equal : String(args[++i])); continue; }
    if (!name.startsWith("-")) { v.push(`positional argument “${name}” before the image`); continue; }
    v.push(`unknown option ${name}`);
  }
  const image = args[args.length - 1];
  if (String(image).startsWith("-")) v.push(`no image at the end (${image})`);
  if (ctx.image && image !== ctx.image) v.push(`image ${image} instead of ${ctx.image}`);

  const one = (k) => (values.get(k) || []);
  const required = (k, desired, set) => { if (!one(k).includes(desired)) v.push(set); };
  if (!values.has("-d")) v.push("without -d");
  if (!values.has("--privileged")) v.push("without --privileged (the inner dockerd needs it)");
  required("--restart", "unless-stopped", "without --restart unless-stopped");
  required("--stop-timeout", String(STOP_DEADLINE_S), `without --stop-timeout ${STOP_DEADLINE_S}`);
  required("--name", containerName(projectId, instance), `without --name ${containerName(projectId, instance)}`);
  required("--network", networkName(projectId, instance), `without --network ${networkName(projectId, instance)}`);
  if (one("--network").some((n) => n === "host")) v.push("forbidden: --network host");
  if (one("--network").length !== 1) v.push("not exactly one network");
  if (one("--ip").length !== 1) v.push("without a fixed --ip");
  for (const l of [`${LABEL_PROJECT}=${projectId}`, `${LABEL_INSTANCE}=${copy ? instance : MAIN}`]) required("--label", l, `without label ${l}`);
  // The instance stands exactly once; the trace to the chat is carried only by a copy, and exactly one.
  const labelValues = (k) => one("--label").filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
  const instances = labelValues(LABEL_INSTANCE);
  if (instances.length !== 1) v.push(`not exactly one label ${LABEL_INSTANCE} (${instances.join(", ") || "none"})`);
  const chats = labelValues(LABEL_CHAT);
  if (copy) {
    if (instances.includes(MAIN)) v.push(`a copy carries the label ${LABEL_INSTANCE}=${MAIN}`);
    if (chats.length !== 1 || !VALID_ID.test(chats[0])) v.push(`a copy does not carry exactly one valid label ${LABEL_CHAT}`);
    else if (ctx.chatId !== undefined && chats[0] !== String(ctx.chatId)) v.push(`label ${LABEL_CHAT}=${chats[0]} instead of ${ctx.chatId}`);
  } else if (chats.length) v.push(`the main carries a label ${LABEL_CHAT} (only copies do)`);
  // Both hash labels, exactly once each — the old one for the older release, the new one for this.
  for (const k of [LABEL_MOUNTS, LABEL_MOUNTS_V2]) {
    const w = labelValues(k);
    if (w.length !== 1 || !/^[0-9a-f]{64}$/.test(w[0])) v.push(`without label ${k}=<sha256>`);
  }

  // Environment: only named names, each WITH a value — a bare `-e NAME` would take the value from the environment of the backend.
  const env = new Map();
  for (const e of one("-e")) {
    const k = e.indexOf("=");
    if (k < 0) { v.push(`-e ${e} without a value (would take the environment of the backend)`); continue; }
    const name = e.slice(0, k);
    if (!CREATION_ENVIRONMENT.includes(name)) v.push(`environment ${name} is not named`);
    env.set(name, e.slice(k + 1));
  }
  if (env.get("CBASE_DOCKER_POOL") !== INNER_POOL) v.push(`without -e CBASE_DOCKER_POOL=${INNER_POOL}`);
  if (env.get("CLAUDE_CONFIG_DIR") !== path.join(cliHome, ".claude")) v.push(`CLAUDE_CONFIG_DIR is not ${path.join(cliHome, ".claude")}`);
  if (env.get("CODEX_HOME") !== path.join(cliHome, ".codex")) v.push(`CODEX_HOME is not ${path.join(cliHome, ".codex")}`);

  // Mounts.
  let rules;
  try { rules = mountRulesFor({ ...ctx, instance, cliHome }); } catch (e) { return [...v, `rule table of instance ${instance}: ${e.message}`]; }
  // The own copy root (only in a copy): the ONE place under `<data>/copies` that it may mount.
  const ownRoot = copy ? rules.find((r) => r.rule === "copy-root")?.source : null;
  const afterSource = new Map(rules.map((r) => [r.source, r]));
  const exceptions = new Map(exceptionTable({ home: ctx.home, cliHome }).map((a) => [a.source, a]));
  const allowedFiles = new Set(rules.filter((r) => r.kind === "file").map((r) => r.source));
  const never = ctx.neverMounted || [];
  const foreign = ctx.foreignRoots || [];
  let volumes = 0;
  const targets = new Set();
  for (const text of one("--mount")) {
    const m = mountFields(text);
    if (m.type === "volume") {
      volumes++;
      if (m.source !== volumeName(projectId, instance) || m.target !== "/var/lib/docker") v.push(`foreign volume ${m.source}:${m.target}`);
      continue;
    }
    if (m.type !== "bind") { v.push(`mount type ${m.type}`); continue; }
    const { source, target } = m;
    if (MOUNT_ENEMY.test(source) || MOUNT_ENEMY.test(target)) v.push(`path with comma, quote or line break: ${source}`);
    if (!path.isAbsolute(source) || !path.isAbsolute(target)) { v.push(`relative path: ${source} → ${target}`); continue; }
    if (targets.has(target)) v.push(`target twice: ${target}`);
    targets.add(target);
    const rule = afterSource.get(source);
    if (!rule) v.push(`mount outside the list: ${source}`);
    else {
      if (rule.target !== target) v.push(`${source} belongs at ${rule.target}, not at ${target}`);
      if (rule.rw === m.ro) v.push(`${source} is meant to be ${rule.rw ? "writable" : "read-only"}`);
    }
    // A copy: nothing at or above the original path of the project folder — the entrypoint mounts the overlay there.
    if (copy && ctx.projectPath && (liesIn(target, ctx.projectPath) || liesIn(ctx.projectPath, target))) {
      v.push(`a copy mounts ${source} at the original path of the project folder (${target})`);
    }
    // Source ≠ target only from the exception table — and in a copy from its two own rules; the CLI targets lie in the home OF THE
    // PROJECT: a HOME rule (HOME_EXCEPTIONS: `~/.local`, `~/.vscode-server`) at the user path, every other under
    // CLAUDE_CONFIG_DIR/CODEX_HOME.
    if (source !== target && !(copy && COPY_RULES.has(rule?.rule) && rule.target === target)) {
      const a = exceptions.get(source);
      if (!a || a.target !== target) v.push(`source ≠ target outside the exception table: ${source} → ${target}`);
      else if (!HOME_EXCEPTIONS.has(a.rule) && !liesIn(target, path.join(cliHome, ".claude")) && !liesIn(target, path.join(cliHome, ".codex"))) {
        v.push(`CLI target ${target} is not under CLAUDE_CONFIG_DIR/CODEX_HOME`);
      }
    }
    // Independent of the table: no source above a foreign project or workspace root, none at or in a place that is never mounted,
    // no file mount except the named ones, never the file `.claude.json` (53 empty states behind a file mount).
    for (const w of foreign) if (liesIn(w, source)) v.push(`${source} contains the foreign root ${w}`);
    for (const n of never) {
      // In a copy: its own subfolder of `<data>/copies` (and only it — it does not contain the place, it lies inside it).
      if (ownRoot && source === ownRoot && !liesIn(n.path, source) && liesIn(source, n.path)) continue;
      if (liesIn(n.path, source) || (n.below && liesIn(source, n.path))) v.push(`${source} touches ${n.path} (never mounted: ${n.reason})`);
    }
    if (path.basename(source) === ".claude.json") v.push(`file mount on .claude.json: ${source}`);
    if (typeof ctx.isFile === "function" && ctx.isFile(source) && !allowedFiles.has(source)) v.push(`file mount other than the named ones: ${source}`);
  }
  if (volumes !== 1) v.push(`${volumes} volumes instead of exactly one (${volumeName(projectId, instance)} → /var/lib/docker)`);
  return v;
}

/**
 * What is never mounted (the data folder places such as the database, backups and relocation journals, and the whole CLI homes of
 * the user). `below`: also nothing INSIDE — not for `~/.claude`/`~/.codex`, where the files of the exception table are allowed (and
 * only they: the rule table).
 * `flat` is the flat place (runs/runtime-location.js `locationFor({})`): its folders — scratch, attachments, outputs, playwright, the
 * login store, the workspace browser profiles, the service logs — carry the files of the NOT relocated chats and projects. The
 * paths come from there, not as a literal here (path guard in runtime-location.test.js); without `flat` the function throws — a
 * list that lacks half would look complete. `addition`: further entries of the same form from domain folders this leaf does not
 * know (the backups of the copies from stacks/).
 * @returns {{ path, reason, below }[]}
 */
export function neverMounted({ home, data, flat, addition = [] }) {
  if (!flat?.scratch || !flat?.playwrightProfiles) throw new Error("neverMounted: no complete list without the flat place (flat)");
  if (!Array.isArray(addition) || addition.some((z) => typeof z?.path !== "string" || !path.isAbsolute(z.path) || !z.reason)) {
    throw new TypeError("neverMounted: addition is a list of { path (absolute), reason, below }");
  }
  const d = (n, reason) => ({ path: path.join(data, n), reason, below: true });
  const f = (field, reason) => ({ path: flat[field], reason, below: true });
  const h = (n, reason, below = true) => ({ path: path.join(home, n), reason, below });
  return [
    // With WAL (store/db.js) the last commits live in `-wal` next to the file — as worth protecting as the database itself.
    d("automater.db", "the database"), d("automater.db-wal", "the write-ahead log of the database"),
    d("automater.db-shm", "the shared memory index of the database"), d("backups", "backups of the database"), { path: path.join(data, "..", "db-backups"), reason: "backups of the database", below: true },
    d("manager-docs", "manager documents"), d("manager-attachments", "manager attachments"), d("ingest-blobs", "foreign material"),
    d("channel-files", "channel files"), d("artifacts", "artifacts"), d("tts-cache", "speech output"), d("empty", "empty"),
    d("skill-resources", "skill resources"), d("service-runs.json", "service runs"), d("service-events.json", "notices"),
    d("git-askpass.sh", "the token goes only to backend git"),
    // Administration git: the post work, the key of the access route and the list of the relocated projects. The names are
    // POST_WORK_FOLDER (runs/git-post-work.js), GIT_ACCESS_FILE and GIT_PROJECTS_FILE (projectbox/git-assignment.js) — this leaf
    // imports nothing, bound in projectbox-creation.test.js.
    d("git-post-work", "post work of the administration git"), d("git-access.key", "key of the access route of the wrapper"),
    d("git-projects", "list of the relocated projects for cbase-git"),
    d("relocations", "relocation journal with .env backups (the name is RELOCATION_FOLDER in projectbox/journal.js — this leaf imports nothing, bound in projectbox-journal.test.js)"),
    // The layers and backups of the copies — like the relocation journal never mounted (in a copy only its own subfolder,
    // creationViolations). The subpaths belong to stacks/; only the root stands here, so it is fixed before the first relocation.
    d(COPIES_FOLDER, "copies of the stacks"),
    // The tarball cache of the upfront fetch — B unpacks from it the helper that B itself executes, and the server of every project.
    // The name is CACHE_FOLDER (projectbox/vscode-upfront.js) — this leaf imports nothing, bound in
    // projectbox-vscode-upfront.test.js.
    d("vscode-server-upfront", "tarball cache of the upfront fetch of the VS Code server — B unpacks code from it"),
    f("scratch", "scratch of the flat chats (with worktrees)"), f("attachments", "attachments of the flat chats"),
    f("outputs", "outputs of the flat chats"), f("playwrightConfigs", "playwright configurations of the flat chats"),
    f("playwrightProfiles", "login store and flat chat profiles"), f("browserProfiles", "workspace browser profiles"),
    f("serviceLogs", "service logs of the flat projects"),
    { path: path.join(data, "..", "profiles"), reason: "~/cbase/profiles", below: true },
    h(".ssh", "SSH keys"), h(".cloudflared", "Cloudflare access"), h("bin", "~/bin"), h(".git-credentials", "git credentials"),
    h(".config/gh", "GitHub access"), h(".docker", "Docker configuration"), h("models", "models"),
    // `~/.vscode-server` of B is B's OWN VS Code server (vscode-tunnel.js) — a project gets its own from the CLI home (rule
    // `cli-vscode-server`), never this one.
    h(".cache/cbase-models", "embedding models"), h(B_CACHE_FOLDER, "package caches of B — B loads code from them"), h(VSCODE_SERVER, "VS Code server of B"), h(".cbase-vscode", "VS Code tunnel"),
    // The helper of Dev Containers in B (`~/.vscode-remote-containers/bin/<commit>`, B executes it) — the upfront fetch puts it
    // there; the name is HELPER_FOLDER (projectbox/vscode-upfront.js), bound in projectbox-vscode-upfront.test.js.
    h(".vscode-remote-containers", "helper of Dev Containers — B executes it"),
    h(".claude", "the CLI home of the user", false), h(".codex", "the Codex home of the user", false),
    h(".claude.json", "state of the Claude CLI"),
    // What OTHER domain folders never want to see mounted, whose literals do not belong here: the backups of the copies
    // `<data>/copies-backup` (stacks/location.js) — through the creation context (instance.js setNeverMountedAddition, set in
    // server.js), because projectbox/ never imports stacks/.
    ...addition.map((z) => ({ path: z.path, reason: z.reason, below: z.below !== false })),
  ];
}
