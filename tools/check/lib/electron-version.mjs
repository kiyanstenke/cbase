// Which Electron version is inside a bundle — and which should be?
//
// Nothing in the tool read the Electron version of a bundle. The client decided "rebuild or only restart" from the
// shell files and the icon alone (`targets/client.mjs`) — a pure version jump in `client/package.json` would have
// reported "client shell unchanged → restart only" and left the old bundle standing.
//
// Two sources, both without extra tools beyond what macOS ships:
//
//   · ACTUAL: `CFBundleVersion` from the Info.plist of the Electron Framework in the bundle (`ELECTRON_PLIST`). The
//     framework plist carries NO `CFBundleShortVersionString` — only `CFBundleVersion` is the value. Read with
//     `plutil -extract … raw`, which handles binary and XML plists.
//   · DESIRED: `version` from `<target>/node_modules/electron/package.json` — the package electron-builder builds
//     against. From Electron 42 the package downloads its binary on first start (`node_modules/electron/dist` is
//     then missing); the package.json is there anyway.
//
// Empty is not unknown: if the bundle, the plist or node_modules is missing, or plutil fails, that version is `null`
// with a reason, and two unknowns are NOT equal. `null === null` would otherwise be exactly the line that reports
// "== node_modules" while nobody read anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ELECTRON_PLIST = "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist";

// An Electron version: three numbers, optionally a prerelease suffix ("44.0.0-beta.3"). What plutil reads
// from a foreign plist is not yet a version.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// A value from a plist via `plutil -extract <key> raw`. Synchronous because the client's rebuild decision
// (`clientShellChanged`) is asked synchronously (deploy.mjs). `bin` only for the test — a missing tool
// (Linux runner) is "unknown", not "empty".
export function plutilValue(file, key, { bin = "plutil" } = {}) {
  const r = spawnSync(bin, ["-extract", key, "raw", "-o", "-", file], { encoding: "utf8", timeout: 10000 });
  if (r.error) return { value: null, reason: r.error.code === "ENOENT" ? `${bin} missing` : r.error.message };
  if (r.status !== 0) return { value: null, reason: `${bin}: ${(r.stderr || "").trim().split("\n").pop() || `Exit ${r.status}`}` };
  const value = (r.stdout || "").trim();
  return value ? { value, reason: "" } : { value: null, reason: `${bin}: empty value` };
}

// ACTUAL: the Electron version in the bundle. `read` is replaceable (test); default plutil.
export function electronInBundle(app, { read = plutilValue } = {}) {
  if (!app || !fs.existsSync(app)) return { version: null, reason: "bundle missing" };
  const plist = path.join(app, ELECTRON_PLIST);
  if (!fs.existsSync(plist)) return { version: null, reason: "no Info.plist of the Electron Framework in the bundle" };
  let r;
  try {
    r = read(plist, "CFBundleVersion");
  } catch (e) {
    r = { value: null, reason: e.message };
  }
  const value = r?.value ?? null;
  if (value && VERSION.test(value)) return { version: value, reason: "" };
  return { version: null, reason: value ? `CFBundleVersion "${value}" is not a version` : `CFBundleVersion unreadable (${r?.reason || "no reason"})` };
}

// DESIRED: the version of the electron package under `<target>/node_modules`.
export function electronDesired(target) {
  const file = path.join(target, "node_modules", "electron", "package.json");
  let version;
  try {
    version = JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch (e) {
    return { version: null, reason: e.code === "ENOENT" ? "node_modules/electron missing" : `package.json unreadable (${e.message})` };
  }
  return typeof version === "string" && VERSION.test(version)
    ? { version, reason: "" }
    : { version: null, reason: `version "${version}" in node_modules/electron/package.json is not a version` };
}

// The verdict. `equal` ONLY if both sides were read AND are identical. `text` is the cell for the tables in
// client/status: the version if equal, otherwise both sides with the reason.
export function electronComparison(actual, desired) {
  const equal = Boolean(actual.version && desired.version && actual.version === desired.version);
  const page = (x) => x.version || `unknown (${x.reason})`;
  return {
    equal,
    actual: actual.version,
    desired: desired.version,
    text: equal ? `== node_modules (${actual.version})` : `DEVIATES — bundle ${page(actual)}, node_modules ${page(desired)}`,
    // Short form for deviation lists ("Electron 37.10.3 → 44.4.4").
    short: `Electron ${page(actual)} → ${page(desired)}`,
  };
}

// The one call the targets need: bundle against `<target>/node_modules`.
export function electronBundleAgainstModule(app, target, { read } = {}) {
  return electronComparison(electronInBundle(app, read ? { read } : {}), electronDesired(target));
}
