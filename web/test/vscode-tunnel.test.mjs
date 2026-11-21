// The links of the VS Code pill (src/lib/vscode-tunnel.ts): vscode.dev and the vscode:// scheme with remote authority
// `tunnel+<name>`. In the gate because a space in the workspace name would silently tear the link — VS Code would then open
// anything but the folder.
//
// Run:  node --test web/test/vscode-tunnel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vscode-tunnel-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "vscode-tunnel.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { tunnelLinks, tunnelPath, tunnelNameValid } = await import(pathToFileURL(path.join(out, "vscode-tunnel.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

test("links: browser and desktop, path encoded segment by segment, slashes stay", () => {
  assert.deepEqual(tunnelLinks("cbase", "/home/agent/workspaces/My Project"), {
    browser: "https://vscode.dev/tunnel/cbase/home/agent/workspaces/My%20Project",
    desktop: "vscode://vscode-remote/tunnel+cbase/home/agent/workspaces/My%20Project",
  });
  // The name is lowercased as in the backend; a path without a leading slash gets one.
  assert.equal(tunnelLinks(" cbase-Test ", "home/agent").browser, "https://vscode.dev/tunnel/cbase-test/home/agent");
  assert.equal(tunnelPath("/a/b#c?d"), "/a/b%23c%3Fd");
});

test("name: the same rule as in the backend", () => {
  for (const ok of ["cbase", "a", "abc-123", "x".repeat(20), " cbase "]) assert.equal(tunnelNameValid(ok), true, ok);
  for (const not of ["", "-a", "a_b", "Bad Name", "x".repeat(21), "ä"]) assert.equal(tunnelNameValid(not), false, not);
});
