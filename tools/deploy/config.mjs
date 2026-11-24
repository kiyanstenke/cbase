// Configuration of the deploy tool.
//
// Structure (paths, ports, image/bundle names) is fixed here and versioned. Everything machine- or
// device-specific (SSH host, iPhone UDID, Xcode location, desktop user) comes from `deploy.local.json`
// in the repo root (gitignored, template: deploy.local.example.json) or from environment variables.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../check/config-repo.mjs";
import { importPrivate } from "./lib/private-part.mjs";

export { REPO };

const HOME = os.homedir();

const DEFAULTS = {
  // Work and rollout always happen on `main` — no feature branches. `remote` is deliberately the
  // configured name, not a fixed provider: `git remote -v` says what stands behind it.
  git: {
    branch: "main",
    remote: "origin",
  },
  ssh: {
    host: "", // e.g. "maintainer@buildhost"
    key: path.join(HOME, ".ssh/id_ed25519"),
    knownHosts: path.join(HOME, ".ssh/known_hosts"),
  },
  remote: {
    root: "/srv/cbase-server", // the installation root on the host; set remote.root in deploy.local.json or CBASE_REMOTE_ROOT
    image: "cbase-backend",
    // Image of the project containers: on the host only as `:cand-<release>` (lib/projectbox.mjs);
    // `:latest` exists only INSIDE each user container.
    projectboxImage: "cbase-projectbox",
    gatewayPort: 7719,
    backendPort: 7718,
    containerPrefix: "cbase-u-",
    keepReleases: 5,
    // Node binary on the host for the gateway unit (`./deploy init`).
    node: "/usr/bin/node",
    // UTC hour of a daily docker cleanup on the host (prunes unused images and stopped containers), or null when there is none:
    // with an hour set, image builds and swaps that would span it are refused (lib/cronWindow.mjs).
    cleanupCronUtcHour: null,
  },
  // Locally only the client exists. The backups stay where they always were.
  local: {
    clientApp: "/Applications/cbase Client.app",
    clientAppName: "cbase Client",
    backups: path.join(HOME, "Library/Application Support/cbase/deploy-backups"),
    keepBackups: 3,
  },
  mobile: {
    // xcodebuild needs the desktop user: Xcode accounts, keychain certificates and provisioning data
    // are per user. As root Xcode reports "No Accounts" although the account is visible in the Xcode app.
    desktopUser: "",
    xcodeApp: "/Applications/Xcode.app",
    udid: "",
    bundleId: "dev.cbase.mobile",
    scheme: "CbaseMobile",
    // Simulator for `mobile --tests`: device name (exact — "iPhone 17 Pro" is another device) or UDID.
    // With several of the same name the booted one wins.
    simulator: "iPhone 17",
    // Own DerivedData for the UI tests, separate from hand builds and the device
    // build (CbaseMobile-Device): a parallel build in the SAME folder would otherwise cost the finished test build.
    testDerivedData: path.join(HOME, "Library/Developer/Xcode/DerivedData/CbaseMobile-UITests"),
  },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(base[k] || {}, v);
    else if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

function fromFile() {
  const p = path.join(REPO, "deploy.local.json");
  // The gate's suites run with CBASE_DEPLOY_LOCAL=off (tools/check/targets/check.mjs): they test the code, never one installation.
  if (process.env.CBASE_DEPLOY_LOCAL === "off") return {};
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`deploy.local.json is not valid JSON: ${e.message}`);
  }
}

function fromEnv() {
  const e = process.env;
  return {
    git: { branch: e.CBASE_GIT_BRANCH, remote: e.CBASE_GIT_REMOTE },
    ssh: { host: e.CBASE_SSH_HOST, key: e.CBASE_SSH_KEY, knownHosts: e.CBASE_SSH_KNOWN_HOSTS },
    remote: {
      root: e.CBASE_REMOTE_ROOT,
      image: e.CBASE_IMAGE,
      projectboxImage: e.CBASE_PROJECTBOX_IMAGE,
      gatewayPort: e.CBASE_GATEWAY_PORT ? Number(e.CBASE_GATEWAY_PORT) : undefined,
      containerPrefix: e.CBASE_CONTAINER_PREFIX,
      node: e.CBASE_REMOTE_NODE,
      cleanupCronUtcHour: e.CBASE_CLEANUP_CRON_UTC_HOUR ? Number(e.CBASE_CLEANUP_CRON_UTC_HOUR) : undefined,
    },
    local: { clientApp: e.CBASE_CLIENT_APP },
    mobile: {
      desktopUser: e.CBASE_DESKTOP_USER,
      xcodeApp: e.CBASE_XCODE_APP,
      udid: e.CBASE_DEVICE_UDID,
      team: e.CBASE_DEVELOPMENT_TEAM,
      simulator: e.CBASE_SIMULATOR,
      testDerivedData: e.CBASE_TEST_DERIVED_DATA,
    },
  };
}

export const config = deepMerge(deepMerge(DEFAULTS, fromFile()), fromEnv());

// One release id for ALL targets of a run: server `releases/<id>`, the `cbase Client.app.previous-<id>`
// backups and the log file carry the same number. Format: YYYYMMDD-<epoch-ms>.
export function newReleaseId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `${day}-${now.getTime()}`;
}

// The latch against a foreign installation on the same host: a maintainer who runs another installation side by side keeps its
// identity (root, port, container prefix, images) in the private part of the deploy tool; a tree without it
// has nothing to refuse. Every rollout command and `init` call this before they reach the host.
/** Throws when a rollout would touch a foreign installation the private part knows of (root, port, container prefix, images). */
export async function assertOwnInstallation(remote = config.remote) {
  const mod = await importPrivate("lib/old-installation.mjs");
  const found = mod ? mod.oldInstallationFindings(remote) : [];
  if (found.length) throw new Error(`Rollout refused — the configuration points at the old installation: ${found.join("; ")}.`);
}

export function requireSsh() {
  if (!config.ssh.host) {
    throw new Error(
      "No SSH host configured. Create `deploy.local.json` (see deploy.local.example.json) " +
        "or set CBASE_SSH_HOST.",
    );
  }
  return config.ssh;
}

export function desktopUser() {
  return config.mobile.desktopUser || os.userInfo().username;
}
