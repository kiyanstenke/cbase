// Test fixture shared by electron-version.test.mjs and electron-version.ops.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ELECTRON_PLIST } from "./electron-version.mjs";

// A throwaway bundle with a framework plist (content free) and a throwaway target with
// `node_modules/electron/package.json`. Cleaned up in the `finally` of every test.
export function build({ plist = "", desired = "44.4.4" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-electronversion-"));
  const app = path.join(dir, "Probe.app");
  fs.mkdirSync(path.dirname(path.join(app, ELECTRON_PLIST)), { recursive: true });
  fs.writeFileSync(path.join(app, ELECTRON_PLIST), plist);
  const target = path.join(dir, "target");
  if (desired !== null) {
    fs.mkdirSync(path.join(target, "node_modules", "electron"), { recursive: true });
    fs.writeFileSync(path.join(target, "node_modules", "electron", "package.json"), JSON.stringify({ name: "electron", version: desired }));
  }
  return { dir, app, target, cleanUp: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A reader pretending to be plutil — so the verdict runs on every machine, even without plutil.
export const reads = (value) => () => ({ value, reason: value ? "" : "simulated: plutil fails" });
