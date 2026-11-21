// The scenario of a project creation over the fake docker — shared by the guards of the project containers that need a real
// project container. Not a test (hence .mjs): ONE place instead of three diverging copies.
//
// STAT(start)          a real line from /proc/<pid>/stat (field 22 = start)
// routeText(routes)    /proc/net/route from [[iface, cidr], …] (plus a default route that does not count)
// ID                   the image id of `cbase-projectbox:latest` in the fake docker
// HOSTS_TEST           a throwaway file instead of /etc/hosts (every successful creation writes there); `after` removes it in
//                      every test file that loads this module
// withOps(fd, fn, values)   the marks ONLY around the call (otherwise the server in the test process would start in operation:
//                      CBASE_CONTAINER loads onnxruntime at start, projectbox-server-end.test.js); tick small, creation
//                      cap large (opposite direction), `CBASE_HOSTS_FILE` on HOSTS_TEST; `values` wins (undefined deletes).
//                      The upfront fetch of the VS Code server (projectbox/vscode-upfront.js) is OFF (`CBASE_VSCODE_UPFRONT_MS`
//                      "0"): a late start in operation would ask Microsoft and put the helper into the developer's REAL home
//                      if `~/.vscode-remote-containers/bin` exists there — projectbox-vscode-upfront.test.js turns it on
//                      through `values`; `CBASE_VSCODE_ARCH` "x64" (the Mac is arm64 — every run would say
//                      "other-architecture"); `CBASE_VSCODE_VERSION_API` (the query for the version in use) points to a port
//                      without a listener — never Microsoft, `values` sets the endpoint of the test
// scenario(ctx, opts)  own project, own home, own root (network marker, routes), own "inside" of the container (the entrypoint's
//                      status file and cgroup.subtree_control, read through a `cat` the fake redirects to this folder). opts:
//                      marker, routes, status, cgroup, cliHome — and `name` (project name, default "Project s<n>"), `workspace`
//                      ({ id, path }, default the harness workspace) and `projectId` (default `p<n>x…`; whoever goes through
//                      `/api/projects/:id` needs a UUID as in the product)
// raises(p, check)     the promise MUST throw; `check(e)` examines the error
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

import * as store from "../electron/server/store.js";
import { NETWORK_MARKER } from "../electron/server/projectbox/network-marker.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";

// A real line from /proc/<pid>/stat (Linux 6.8), the command name with a parenthesis and a space — the trap that is why counting
// starts behind the LAST `)`. Start time (field 22) = 4242.
export const STAT = (start, name = "docker-init") =>
  `1 (${name}) S 0 1 1 0 -1 4194560 1060 0 0 0 1 2 0 0 20 0 1 0 ${start} 1150976 1 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;

// /proc/net/route: destination and mask in base-16, little-endian.
const hexLe = (ip) => ip.split(".").map((x) => Number(x).toString(16).padStart(2, "0").toUpperCase()).reverse().join("");
const maskFrom = (n) => {
  const z = n ? (0xffffffff << (32 - n)) >>> 0 : 0;
  return hexLe([z >>> 24, (z >>> 16) & 255, (z >>> 8) & 255, z & 255].join("."));
};
export function routeText(routes) {
  const header = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
  const rows = [
    `eth0\t00000000\t${hexLe("172.24.0.1")}\t0003\t0\t0\t0\t00000000\t0\t0\t0`, // default route: does not count
    ...routes.map(([iface, cidr]) => {
      const [ip, n] = cidr.split("/");
      return `${iface}\t${hexLe(ip)}\t00000000\t0001\t0\t0\t0\t${maskFrom(Number(n))}\t0\t0\t0`;
    }),
  ];
  return `${header}\n${rows.join("\n")}\n`;
}

export const ID = "4f".repeat(32);

const TUNABLES = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_PROJECTBOX_TICK_MS", "CBASE_PROJECTBOX_CREATION_MS", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CBASE_HOSTS_FILE", "CBASE_VSCODE_UPFRONT_MS", "CBASE_VSCODE_ARCH", "CBASE_VSCODE_UPFRONT_CATCH_UP_MS", "CBASE_VSCODE_VERSION_API"];
// The version interface points to a port nobody listens on in test operation — a test that turns the upfront fetch on and has a trace
// of the Mac lying around would otherwise ask Microsoft for the version in use. `values` wins.
const NO_NETWORK_VERSION_API = "http://127.0.0.1:9/cbase-test-no-network/{commit}";
export const HOSTS_TEST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-test-hosts-")), "hosts");
fs.writeFileSync(HOSTS_TEST, "127.0.0.1 localhost\n");
after(() => fs.rmSync(path.dirname(HOSTS_TEST), { recursive: true, force: true }));

export async function withOps(fd, fn, values = {}) {
  const saved = Object.fromEntries(TUNABLES.map((k) => [k, process.env[k]]));
  const desired = { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECTBOX_TICK_MS: "10", CBASE_PROJECTBOX_CREATION_MS: "3600000", CBASE_HOSTS_FILE: HOSTS_TEST, CBASE_VSCODE_UPFRONT_MS: "0", CBASE_VSCODE_ARCH: "x64", CBASE_VSCODE_VERSION_API: NO_NETWORK_VERSION_API, ...values };
  try {
    for (const k of TUNABLES) { if (desired[k] === undefined) delete process.env[k]; else process.env[k] = desired[k]; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

let counter = 0;
export function scenario(ctx, { marker = "4242\n", routes = [["eth0", "172.24.0.0/16"]], status = "phase=ready\nnotice=DNAT set\n", cgroup = "cpu io memory pids\n", cliHome = true, name: projectName, workspace, projectId: id } = {}) {
  const name = `s${++counter}`;
  const ws = workspace || { id: ctx.ws.id, path: path.join(ctx.root, "workspace") };
  const dir = path.join(ctx.root, name);
  const filePath = path.join(ws.path, `project-${name}`);
  fs.mkdirSync(path.join(filePath, "repo"), { recursive: true });
  const projectId = id ?? `p${counter}x${Date.now().toString(36)}`;
  store.addProject(ws.id, { id: projectId, name: projectName ?? `Project ${name}`, path: filePath, createdAt: Date.now() });
  const home = path.join(dir, "home");
  for (const d of [".claude/agents", ".codex", ".claude-login", ".ssh"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "decoy\n");
  const system = { usrLocalBin: path.join(dir, "sys", "bin"), usrLocalNodeModules: path.join(dir, "sys", "nm"), mcp: path.join(dir, "sys", "mcp") };
  for (const d of Object.values(system)) fs.mkdirSync(d, { recursive: true });
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "run", "cbase"), { recursive: true });
  fs.mkdirSync(path.join(root, "proc", "1"), { recursive: true });
  fs.mkdirSync(path.join(root, "proc", "net"), { recursive: true });
  if (marker !== null) fs.writeFileSync(path.join(root, NETWORK_MARKER), marker);
  fs.writeFileSync(path.join(root, "proc", "1", "stat"), STAT(4242));
  fs.writeFileSync(path.join(root, "proc", "net", "route"), routeText(routes));
  const inside = path.join(dir, "inside");
  fs.mkdirSync(path.join(inside, "run"), { recursive: true });
  fs.mkdirSync(path.join(inside, "sys", "fs", "cgroup"), { recursive: true });
  fs.writeFileSync(path.join(inside, "run", "cbase-projectbox.status"), status);
  fs.writeFileSync(path.join(inside, "sys", "fs", "cgroup", "cgroup.subtree_control"), cgroup);
  const cat = path.join(dir, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh\nexec /bin/cat '${inside}'"$1"\n`);
  fs.chmodSync(cat, 0o755);
  const location = locationFor({ projectId, converted: true });
  if (cliHome) for (const d of [".claude", ".codex", ".local"]) fs.mkdirSync(path.join(location.home, d), { recursive: true });
  const opts = { home, system, root, addresses: ["192.0.2.10/24"] };
  return { projectId, path: filePath, home, system, root, inside, location, opts, programs: { cat } };
}

export async function raises(p, check) {
  try { await p; } catch (e) { check(e); return e; }
  assert.fail("the creation did not throw");
}
