// The link of the VS Code pill into a project container: Dev Containers "attach" behind the remote tunnel,
// `vscode://vscode-remote/attached-container+<BASE16>@tunnel+<name><path>`. BASE16 is the base-16 encoded UTF-8 of
// `{"containerName":"/<container>","settings":{"context":"default"}}` — the leading slash is the name as docker carries it in
// `inspect`, `settings.context` pins the Docker context (a DOCKER_HOST on the Mac would otherwise point elsewhere).
// The ROUND TRIP is checked: the link's authority through the extension's parser regex (the same string as there), the base-16
// back to JSON, the path encoded segment by segment (space, umlaut), the tunnel name as in today's link.
//
// Counter-tests:
//   - without containerLink ⇒ the import yields undefined, every test red;
//   - base-16 from `charCodeAt` instead of UTF-8 ⇒ "umlaut in the container name" red (a "ü" would be one unit, not a byte pair);
//   - without the leading slash before the container name ⇒ "round trip" red.
// Run:  node --test web/test/vscode-container-link.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vscode-container-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "vscode-tunnel.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
], { stdio: "pipe" });
const { containerLink, tunnelLinks } = await import(pathToFileURL(path.join(out, "vscode-tunnel.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// The extension's regex (Dev Containers, authority `attached-container+<config>@<parentAuthority>`).
const PARSER = /^(?<name>[^@+]+)\+(?<config>[^@]+)(?:@(?<parentAuthority>.*))?$/;
const PRELUDE = "vscode://vscode-remote/";

function split(link) {
  assert.ok(link.startsWith(PRELUDE), link);
  const rest = link.slice(PRELUDE.length);
  const cut = rest.indexOf("/");
  const authority = rest.slice(0, cut);
  const filePath = rest.slice(cut);
  const m = PARSER.exec(authority);
  assert.ok(m, `authority does not match the parser regex: ${authority}`);
  assert.match(m.groups.config, /^[0-9a-f]+$/, "the configuration is plain base-16 (lowercase)");
  const json = JSON.parse(Buffer.from(m.groups.config, "hex").toString("utf8"));
  return { name: m.groups.name, json, parent: m.groups.parentAuthority, path: filePath };
}

test("round trip: base-16 ↔ JSON through the parser regex, leading slash, context default, tunnel as parent authority", () => {
  assert.equal(typeof containerLink, "function", "containerLink is missing");
  const link = containerLink("cbase", "cbase-k-p123-alpha", "/home/agent/workspaces/demo/till");
  const z = split(link);
  assert.equal(z.name, "attached-container");
  assert.deepEqual(z.json, { containerName: "/cbase-k-p123-alpha", settings: { context: "default" } });
  assert.equal(z.parent, "tunnel+cbase", "the tunnel name as in today's link (lowercase)");
  assert.equal(z.path, "/home/agent/workspaces/demo/till");
  // The same tunnel name as in the pill's tunnel link.
  assert.ok(tunnelLinks("cbase", "/x").desktop.startsWith(`${PRELUDE}${z.parent}/`));
});

test("path: space and umlaut encoded segment by segment, slashes stay; a path without a leading slash gets one", () => {
  const z = split(containerLink("cbase", "cbase-p-abc", "/home/agent/workspaces/Mein Prüf"));
  assert.equal(z.path, "/home/agent/workspaces/Mein%20Pr%C3%BCf");
  assert.equal(decodeURIComponent(z.path), "/home/agent/workspaces/Mein Prüf");
  assert.equal(split(containerLink("cbase", "cbase-p-abc", "home/agent")).path, "/home/agent");
});

test("umlaut in the container name: UTF-8 bytes, not UTF-16 units", () => {
  // cbase names never carry one — the encoding must still be the extension's (Buffer.from(…, base-16) → utf8).
  const z = split(containerLink("cbase", "prüf", "/a"));
  assert.equal(z.json.containerName, "/prüf");
});

test("empty is not unknown: no link without a container or tunnel name", () => {
  assert.equal(containerLink("", "cbase-p-abc", "/a"), null);
  assert.equal(containerLink("cbase", "", "/a"), null);
  assert.equal(containerLink("cbase", "  ", "/a"), null);
});
