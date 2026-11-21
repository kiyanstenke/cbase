// Guards for the creation of a project container: the backend side of the network separation and the creation itself
// (projectbox/creation.js: pure parts, projectbox/instance.js: createInstance).
//
// NETWORK MARKER. The marker /run/cbase/network-separation.ok counts ONLY if its content is the start time of the RUNNING PID 1
// (field 22 of /proc/1/stat, counted behind the last `)`). A marker with a foreign start time — e.g. from the previous start,
// which the container file system survives — counts as missing, so do an empty one, a missing one and one /proc says nothing
// about. Counter-test: the same file WITH the matching start time is valid (otherwise "invalid" would only prove a reader that
// always says no). The test seam is `root` (same role as CBASE_ENTRY_ROOT in server/backend/entry.sh); the same calculation as
// entry.sh is checked by tools/check/entry-sh.test.mjs on the shell side.
//
// CREATION. The contract: a project container never has a published port, never a mount outside the list, never a home
// directory other than its own. Held here:
//   - the check function `creationViolations` against the real arguments (empty) and against one variant each (each red, with a sentence);
//   - the exception table of the CLI homes: targets below CLAUDE_CONFIG_DIR/CODEX_HOME, missing sources without a mount and with
//     "missing" in the hash, a new inode of auth.json changes the hash, a change of its content in place does not — the same for
//     EVERY read-only file (settings.json, config.toml, …);
//   - the mounts over a tree with decoys (database, .ssh, .docker, login stock, skills, transcripts, .claude.json);
//   - the choice of the subnet (routes, inner pool, block list, exhausted) — sabotage: a copy without the route check picks a route's /24;
//   - createLocation: the pure location creates nothing, only createLocation does;
//   - createInstance over the fake docker (fake-docker.mjs, CBASE_DOCKER_BIN) on a server in the test process: the way to
//     `ready` (network before `run`, `busy` while waiting), and for every precondition and every check the failure case —
//     without operation, without network marker, in the old login state or without CLI home NO docker call and no row; after a
//     failure behind the `run` the container is gone (by id), this call's network gone, the volume still there — even if `run`
//     itself created the container and failed with 125 (no id, the rollback looks it up by name);
//   - `containerOf` names the stable name for the main instance — a start from a snapshot of the row (a core holds it for hours)
//     hits the NEW container after a recreate;
//   - during the server end the creation refuses (own process, because endServer ends the process);
//   - `~/.vscode-server` per project (rule `cli-vscode-server`, section "vscode-server" at the end) — the clean-up of old versions
//     is held by server/backend/test/projectbox-vscode-server.test.js.
//
// Counter-tests (which sabotage turns which test red):
//   runs/server-end.js: `ends = true;` struck                              => "during the server end …" red (inHook false)
//   instance.js: the server-end check of the preconditions struck           => "during the server end …" red (the creation went on)
//   instance.js: network marker, login check or CLI home not checked        => "createInstance …" red (did not throw)
//   instance.js: `rm -f <id>` or `network rm` in the rollback struck        => red ("vfs: the container/the network stayed")
//   instance.js: driver, memory or status check struck                      => red (did not throw)
//   instance.js: no new attempt after "Pool overlaps"                       => red (CreationError network create)
//   instance.js: the subnets of other instances not in the occupation       => red (10.230.0.0/24 instead of .3)
//   instance.js: `run` from the image NAME instead of the id                => red (the check function refuses)
//   instance.js: placeholder not created or empty one not removed           => red (ENOENT or "the empty placeholder stayed")
//   instance.js: an own creation also on a ready row                        => red (CONTAINER_EXISTS instead of OCCUPIED)
//   creation.js: `--init` in creationArgs                                   => "mounts …", "check function …", "createInstance …" red
//   creation.js: workspace .claude/ rule lifted (every file)                => "mounts …" and "check function …" red
//   creation.js: automater.db not in neverMounted                           => "check function …" red (data folder)
//   creation.js: routes not in the occupation                               => copy IN the test (see "selectSubnet …").
//   instance.js without the rollback by name                                => "createInstance …" red (run creates, returns 125: the created container stayed)
//   run-instance.js: containerOf takes the row's id                         => "containerOf …" red ("No such container")
//   creation.js: mountsHash calculates with content (old formula)           => "exception table …" red ("… in place … changed the hash"), main anchor red
//   instance.js: creation without `hashV1` (only `cbase.mounts.v2`), creation.js checks only v2 => "check function …" ("without label cbase.mounts="),
//                                                                              main call-sequence anchor, "createInstance …" red
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import {
  EXCEPTION_RULES, B_CACHE_FOLDER, LEVEL2_AREA, HASH_EXCEPTION_RULES, HOME_EXCEPTIONS, INNER_POOL, COPY_RULES, LABEL_MOUNTS, LABEL_MOUNTS_V2, BLOCK_LIST, VSCODE_SERVER, creationArgs, creationViolations, exceptionTable,
  containerName, mountRules, mountRulesCopy, mountsFor, mountsHash, mountsHashV1, networkArgs, networkFromSubnet, networkName, neverMounted, routesFrom, volumeName, selectSubnet,
} from "../electron/server/projectbox/creation.js";
import { GIT_PROJECTS_FILE, GIT_ACCESS_FILE } from "../electron/server/projectbox/git-assignment.js";
import { POST_WORK_FOLDER } from "../electron/server/runs/git-post-work.js";
import { dockerfileStages, stagesEnv } from "../../../tools/check/lib/projectbox.mjs";
import { CreationError, occupancyOfProject, instanceOccupied, createInstance, withInstanceOccupancy, withProjectOccupancy, projectOccupied, setNeverMountedAddition, desiredMounts } from "../electron/server/projectbox/instance.js";
import { neverMountedCopies } from "../electron/server/stacks/location.js";
import { deleteLock } from "../electron/server/projectbox/erase.js";
import { cleanUpRecreate, resumeRecreate, recreateStatus, earmarkRecreate } from "../electron/server/projectbox/recreate.js";
import { restoreInstance } from "../electron/server/projectbox/restore.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectContainerName } from "../electron/server/projectbox/cleanUp.js";
import { docker } from "../electron/server/projectbox/docker.js";
import { containerOf } from "../electron/server/projectbox/run-instance.js";
import { networkSeparation, NETWORK_MARKER, startTimeFromStat } from "../electron/server/projectbox/network-marker.js";
import { createLocation, locationFor } from "../electron/server/runs/runtime-location.js";
import { OCCUPIED_RANGES, rangesIntersect } from "../../../tools/check/lib/projectbox-plan.mjs";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { setUiLang } from "../electron/server/i18n.js";
// STAT, routeText, ID, withOps, scenario and raises live ONCE there.
import { ID, STAT, withOps, routeText, scenario, raises } from "./projectbox-scenario.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const SERVER = path.resolve(TESTDIR, "..", "electron", "server");

function rootWith({ marker, stat }) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-marker-"));
  fs.mkdirSync(path.join(w, "run/cbase"), { recursive: true });
  fs.mkdirSync(path.join(w, "proc/1"), { recursive: true });
  if (marker !== undefined) fs.writeFileSync(path.join(w, NETWORK_MARKER), marker);
  if (stat !== undefined) fs.writeFileSync(path.join(w, "proc/1/stat"), stat);
  return w;
}

test("startTimeFromStat: field 22 behind the last `)`, also with parentheses and spaces in the name", () => {
  assert.equal(startTimeFromStat(STAT(4242)), "4242");
  assert.equal(startTimeFromStat(STAT(99, "a) b (c")), "99", "the name contains `)` and spaces");
  assert.equal(startTimeFromStat("broken"), null);
  assert.equal(startTimeFromStat("1 (x) S 0 1"), null, "too few fields");
  assert.equal(startTimeFromStat(""), null);
});

test("a marker with a foreign start time counts as missing — counter-test: valid with the matching start time", () => {
  const dirs = [];
  try {
    const foreign = rootWith({ marker: "4100\n", stat: STAT(4242) });
    dirs.push(foreign);
    const r = networkSeparation({ root: foreign });
    assert.equal(r.valid, false, "a marker from the previous start passed as valid");
    assert.equal(r.reason, "foreign-start");
    assert.equal(r.marker, "4100");
    assert.equal(r.start, "4242");

    const matching = rootWith({ marker: "4242\n", stat: STAT(4242) });
    dirs.push(matching);
    assert.deepEqual(networkSeparation({ root: matching }), { valid: true, reason: "ok", marker: "4242", start: "4242" });
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("missing and empty marker and unreadable /proc count as missing", () => {
  const dirs = [];
  try {
    const without = rootWith({ stat: STAT(4242) });
    const empty = rootWith({ marker: " \n", stat: STAT(4242) });
    const withoutStat = rootWith({ marker: "4242\n" });
    const broken = rootWith({ marker: "4242\n", stat: "no stat" });
    dirs.push(without, empty, withoutStat, broken);
    assert.equal(networkSeparation({ root: without }).reason, "missing");
    assert.equal(networkSeparation({ root: empty }).reason, "empty");
    assert.equal(networkSeparation({ root: withoutStat }).reason, "stat-unreadable");
    assert.equal(networkSeparation({ root: broken }).reason, "stat-unreadable");
    for (const d of dirs) assert.equal(networkSeparation({ root: d }).valid, false, d);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("without a root the leaf reads the real paths (no marker on the Mac: missing)", () => {
  assert.equal(NETWORK_MARKER, "/run/cbase/network-separation.ok");
  if (!fs.existsSync(NETWORK_MARKER)) assert.equal(networkSeparation().reason, "missing");
  else assert.equal(typeof networkSeparation().valid, "boolean");
});

// ── The pure parts ─────────────────────────────────────────────────────────────────────────────────────────

// The tree of a creation: user home with decoys, workspace with a neighbouring project, data folder, runtime folder, system.
// `flat` is the flat location (locationFor({}) under a temporarily set DIRS — the paths come from there, not as literals).
function tree({ withAgents = true, withAuth = true } = {}) {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-creation-")));
  const home = path.join(r, "home");
  const ws = path.join(r, "ws");
  const proj = path.join(ws, "till");
  const neighbor = path.join(ws, "depot");
  const data = path.join(r, "cbase", "data");
  const runtime = path.join(data, "projects", "p1");
  const cliHome = path.join(runtime, "home");
  const system = { usrLocalBin: path.join(r, "sys", "bin"), usrLocalNodeModules: path.join(r, "sys", "nm"), mcp: path.join(r, "sys", "mcp") };
  const file = (p, content = "x\n") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  const folder = (p) => fs.mkdirSync(p, { recursive: true });
  for (const d of [path.join(proj, "repo"), neighbor, cliHome, path.join(cliHome, ".claude"), path.join(cliHome, ".codex"), path.join(cliHome, ".local"),
    system.usrLocalBin, system.usrLocalNodeModules, system.mcp, path.join(home, ".npm"), path.join(home, ".claude-login")]) folder(d);
  file(path.join(home, ".gitconfig"));
  file(path.join(home, ".bashrc"));
  file(path.join(home, ".claude", "settings.json"), "{\"a\":1}\n");
  file(path.join(home, ".claude", "CLAUDE.md"));
  if (withAgents) file(path.join(home, ".claude", "agents", "checker.md"));
  file(path.join(home, ".claude", "projects", "x", "history.jsonl")); // decoy: transcripts
  file(path.join(home, ".claude", ".credentials.json")); // decoy
  file(path.join(home, ".codex", "config.toml"));
  if (withAuth) file(path.join(home, ".codex", "auth.json"), "{}\n");
  file(path.join(home, ".codex", "sessions", "s.jsonl")); // decoy
  file(path.join(home, ".claude.json")); // decoy
  file(path.join(home, ".ssh", "id_ed25519")); // decoy
  file(path.join(home, ".docker", "config.json")); // decoy
  file(path.join(ws, "CLAUDE.md"));
  file(path.join(ws, ".mcp.json"));
  file(path.join(ws, ".claude", "settings.json"));
  file(path.join(ws, ".claude", "settings.local.json"));
  file(path.join(ws, ".claude", "skills", "s", "SKILL.md")); // decoy: all workspace skills
  file(path.join(ws, ".claude", "agents", "a.md")); // decoy
  file(path.join(ws, ".claude", "secret.json")); // decoy: only settings*.json and CLAUDE.md
  file(path.join(data, "automater.db")); // decoy
  const old = DIRS;
  let flat;
  try {
    setDirs({ data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
    flat = locationFor({});
  } finally { setDirs(old); }
  file(path.join(flat.playwrightProfiles, "ws1", "Default", "Cookies")); // decoy: login stock
  const entries = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const kind = (p) => { try { const s = fs.statSync(p); return s.isDirectory() ? "folder" : "file"; } catch { return null; } };
  const ctx = {
    projectId: "p1", home, wsPath: ws, projectPath: proj, runtime, cliHome, data, system, entries,
    isFile: (p) => kind(p) === "file", foreignRoots: [neighbor, ws], neverMounted: neverMounted({ home, data, flat }),
  };
  const exists = (p, a) => kind(p) === a;
  return { r, home, ws, proj, neighbor, data, runtime, cliHome, system, flat, ctx, exists, cleanUp: () => fs.rmSync(r, { recursive: true, force: true }) };
}

const NETWORK = networkFromSubnet("10.230.0.0/24");
const argsFor = (b, mounts = mountsFor({ ...b.ctx, exists: b.exists })) =>
  creationArgs({ projectId: "p1", network: NETWORK, image: `sha256:${ID}`, mounts, hash: mountsHash(mounts), hashV1: mountsHashV1(mounts), cliHome: b.cliHome });
const bind = (source, target = source, ro = true) => `type=bind,src=${source},dst=${target}${ro ? ",readonly" : ""}`;

test("mounts: exactly the list over a tree with decoys — no decoy, no foreign root", () => {
  const b = tree();
  try {
    const mounts = mountsFor({ ...b.ctx, exists: b.exists });
    const h = (...t) => path.join(b.home, ...t);
    assert.deepEqual(mounts.map((m) => m.source).sort(), [
      b.proj, path.join(b.ws, "CLAUDE.md"), path.join(b.ws, ".mcp.json"), path.join(b.ws, ".claude", "settings.json"),
      path.join(b.ws, ".claude", "settings.local.json"), b.runtime, h(".npm"), h(".cache/uv"), h(".cache/ms-playwright"),
      h(".cache/pip"), h(".gitconfig"), h(".bashrc"), b.system.usrLocalBin, b.system.usrLocalNodeModules, b.system.mcp,
      h(".claude-login"), path.join(b.cliHome, ".local"), h(".claude", "settings.json"), h(".claude", "CLAUDE.md"),
      h(".claude", "agents"), h(".codex", "config.toml"), h(".codex", "auth.json"),
      // `~/.vscode-server` per project — the row is ALWAYS there, even if (as here) its source is still missing.
      path.join(b.cliHome, VSCODE_SERVER),
    ].sort());
    const decoy = [h(".ssh"), h(".docker"), h(".claude", "projects"), h(".claude", ".credentials.json"), h(".claude.json"),
      h(".codex", "sessions"), path.join(b.data, "automater.db"), b.flat.playwrightProfiles, path.join(b.ws, ".claude", "skills"),
      path.join(b.ws, ".claude", "agents"), path.join(b.ws, ".claude", "secret.json"), b.neighbor];
    for (const m of mounts) {
      for (const k of decoy) {
        const rel = path.relative(k, m.source);
        assert.ok(rel.startsWith("..") || path.isAbsolute(rel), `${m.source} lies in/on the decoy ${k}`);
        assert.ok(path.relative(m.source, k).startsWith(".."), `${m.source} contains the decoy ${k}`);
      }
    }
    // only what the contract calls writable is writable
    assert.deepEqual(mounts.filter((m) => m.rw).map((m) => m.rule).sort(),
      ["cache-.cache/ms-playwright", "cache-.cache/pip", "cache-.cache/uv", "cache-.npm", "cli-codex-auth", "cli-local", "cli-vscode-server", "login", "project", "runtime"]);
    assert.deepEqual(creationViolations(argsFor(b, mounts), b.ctx), [], "the real arguments violate the contract");
  } finally { b.cleanUp(); }
});

test("check function: every deviation from the contract is a violation with a sentence — counter-test: the real arguments are empty", () => {
  const b = tree();
  try {
    const base = argsFor(b);
    assert.deepEqual(creationViolations(base, b.ctx), []);
    const beforeImage = (...x) => [...base.slice(0, -1), ...x, base.at(-1)];
    const without = (...xs) => { const out = [...base]; for (const x of xs) out.splice(out.indexOf(x), 1); return out; };
    const swap = (old, fresh) => base.map((a) => (a === old ? fresh : a));
    const h = (...t) => path.join(b.home, ...t);
    const hash = base.find((a) => a.startsWith(`${LABEL_MOUNTS}=`));
    const hashV2 = base.find((a) => a.startsWith(`${LABEL_MOUNTS_V2}=`));
    const pool = base.find((a) => a.startsWith("CBASE_DOCKER_POOL="));
    const cases = [
      ["-p", beforeImage("-p", "8080:80"), "published port (-p)"],
      ["--publish=", beforeImage("--publish=80:80"), "published port (--publish)"],
      ["-P", beforeImage("-P"), "all ports published (-P)"],
      ["--init", beforeImage("--init"), "--init (tini comes from the image)"],
      ["-v", beforeImage("-v", `${h(".ssh")}:${h(".ssh")}`), "mount per -v"],
      ["--memory", beforeImage("--memory", "4g"), "limit --memory"],
      ["--network host", swap(networkName("p1"), "host"), "forbidden: --network host"],
      ["without --stop-timeout", without("--stop-timeout", "30"), "without --stop-timeout 30"],
      ["without --privileged", without("--privileged"), "without --privileged"],
      ["without pool", base.filter((a, i) => !(a === pool || (a === "-e" && base[i + 1] === pool))), "without -e CBASE_DOCKER_POOL"],
      ["without label mounts", base.filter((a, i) => !(a === hash || (a === "--label" && base[i + 1] === hash))), "without label cbase.mounts="],
      // The new label is mandatory like the old one, and each appears exactly once.
      ["without label mounts.v2", base.filter((a, i) => !(a === hashV2 || (a === "--label" && base[i + 1] === hashV2))), "without label cbase.mounts.v2="],
      ["label mounts twice", beforeImage("--label", `${LABEL_MOUNTS}=${"0".repeat(64)}`), "without label cbase.mounts="],
      ["-e without value", beforeImage("-e", "ANTHROPIC_API_KEY"), "without a value"],
      ["foreign environment", beforeImage("-e", "FOO=1"), "environment FOO is not named"],
      ["workspace instead of project", swap(bind(b.proj, b.proj, false), bind(b.ws, b.ws, false)), `contains the foreign root ${b.neighbor}`],
      ["source ≠ target outside the table", beforeImage("--mount", bind(b.neighbor, "/work", false)), "source ≠ target outside the exception table"],
      ["CLI file at the user path", swap(bind(h(".claude", "settings.json"), path.join(b.cliHome, ".claude", "settings.json")), bind(h(".claude", "settings.json"))),
        `belongs at ${path.join(b.cliHome, ".claude", "settings.json")}`],
      ["whole ~/.claude", beforeImage("--mount", bind(h(".claude"))), `touches ${h(".claude")}`],
      [".claude.json", beforeImage("--mount", bind(h(".claude.json"))), "file mount on .claude.json"],
      ["data folder (database)", beforeImage("--mount", bind(b.data)), `touches ${path.join(b.data, "automater.db")}`],
      ["flat login stock", beforeImage("--mount", bind(path.join(b.flat.playwrightProfiles, "ws1"))), `touches ${b.flat.playwrightProfiles}`],
      ["workspace skills", beforeImage("--mount", bind(path.join(b.ws, ".claude", "skills"))), "mount outside the list"],
      ["file other than the named ones", beforeImage("--mount", bind(path.join(b.proj, "..", ".mcp.json.bak"))), "mount outside the list"],
      ["second volume", beforeImage("--mount", "type=volume,src=other,dst=/data"), "foreign volume other:/data"],
      ["writable instead of read-only", swap(bind(path.join(b.ws, "CLAUDE.md")), bind(path.join(b.ws, "CLAUDE.md"), path.join(b.ws, "CLAUDE.md"), false)), "is meant to be read-only"],
      ["an image name instead of the id", [...base.slice(0, -1), "cbase-projectbox:latest"], "image cbase-projectbox:latest instead of"],
    ];
    const ctx = { ...b.ctx, image: `sha256:${ID}` };
    for (const [name, args, set] of cases) {
      assert.ok(Array.isArray(args), name);
      const v = creationViolations(args, ctx);
      assert.ok(v.some((s) => s.includes(set)), `${name}: no violation "${set}" — reported: ${JSON.stringify(v)}`);
    }
  } finally { b.cleanUp(); }
});

test("exception table: targets in the project's CLI home, missing sources without a mount, the hash follows source, content and inode", () => {
  const b = tree({ withAgents: false, withAuth: false });
  try {
    const args = argsFor(b);
    const env = Object.fromEntries(args.filter((_, i) => args[i - 1] === "-e").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(b.cliHome, ".claude"));
    assert.equal(env.CODEX_HOME, path.join(b.cliHome, ".codex"));
    assert.equal(env.HISTFILE, path.join(b.cliHome, ".bash_history"), "HISTFILE into the runtime folder");
    // Two kinds of targets: the HOME rules directly in the project container's home, at the user path, source in the project's
    // CLI home — every other row below CLAUDE_CONFIG_DIR/CODEX_HOME.
    assert.deepEqual([...HOME_EXCEPTIONS].sort(), ["cli-local", "cli-vscode-server"]);
    for (const a of exceptionTable({ home: b.home, cliHome: b.cliHome })) {
      if (HOME_EXCEPTIONS.has(a.rule)) {
        assert.equal(a.target, path.join(b.home, path.basename(a.source)), `${a.rule}: target not at the user path`);
        assert.equal(path.dirname(a.source), b.cliHome, `${a.rule}: source not in the project's CLI home`);
        assert.equal(a.rw, true, a.rule);
        continue;
      }
      const under = [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].some((d) => a.target.startsWith(d + path.sep));
      assert.ok(under, `${a.rule}: ${a.target} is not below CLAUDE_CONFIG_DIR/CODEX_HOME`);
    }
    assert.deepEqual([...EXCEPTION_RULES].sort(), exceptionTable({ home: b.home, cliHome: b.cliHome }).map((a) => a.rule).sort());

    const io = { content: (p) => { try { return fs.readFileSync(p); } catch { return null; } }, inode: (p) => { try { return fs.statSync(p).ino; } catch { return null; } } };
    const snapshot = () => { const m = mountsFor({ ...b.ctx, exists: b.exists }); return { rules: m.map((x) => x.rule), hash: mountsHash(m, io) }; };
    const s1 = snapshot();
    assert.ok(!s1.rules.includes("cli-claude-agents") && !s1.rules.includes("cli-codex-auth"), "a missing source got a mount");
    assert.equal(snapshot().hash, s1.hash, "the same state gives the same hash");

    const auth = path.join(b.home, ".codex", "auth.json");
    fs.writeFileSync(auth, "{\"tokens\":1}\n");
    const s2 = snapshot();
    assert.ok(s2.rules.includes("cli-codex-auth"));
    assert.notEqual(s2.hash, s1.hash, "a newly appeared source of the exception table does not change the hash");

    fs.appendFileSync(auth, " "); // content in place: same inode — the file bind sees it, no recreate needed
    assert.equal(snapshot().hash, s2.hash, "a change in place (same inode) changed the hash");
    fs.writeFileSync(`${auth}.new`, "{\"tokens\":2}\n");
    fs.renameSync(`${auth}.new`, auth); // `codex login` replaces by rename: new inode, the bind would hold the old one
    const s3 = snapshot();
    assert.notEqual(s3.hash, s2.hash, "a new inode of auth.json does not change the hash");

    // Also for read-only files the inode, not the content — new content IN PLACE leaves the hash alone (the file bind shows it),
    // only a replace by rename changes it. The old formula (mountsHashV1) followed the content; it remains only as a transition
    // for the labels of already created containers (recreate.js).
    const settings = path.join(b.home, ".claude", "settings.json");
    const v1 = () => mountsHashV1(mountsFor({ ...b.ctx, exists: b.exists }), io);
    const v1Prior = v1();
    fs.writeFileSync(settings, "{\"a\":2}\n");
    assert.equal(snapshot().hash, s3.hash, "new content in place of a read-only file changed the hash");
    assert.notEqual(v1(), v1Prior, "the old formula no longer follows the content — the transition checked nothing");
    fs.writeFileSync(`${settings}.new`, "{\"a\":3}\n");
    fs.renameSync(`${settings}.new`, settings);
    assert.notEqual(snapshot().hash, s3.hash, "a replace by rename (new inode) of a read-only file does not change the hash");
  } finally { b.cleanUp(); }
});

test("neverMounted requires the flat location — a list without it would look complete", () => {
  assert.throws(() => neverMounted({ home: "/h", data: "/d" }), /flat place/);
});

// ── B never loads code from a place a project container can write ────
// The four package caches of B (npm, uv, pip, Playwright) are read by the guard from the backend stage of the REAL Dockerfile
// (the deploy's parser, tools/check/lib/projectbox.mjs) — if a variable is missing, the tool's default applies (`~/.npm`, …),
// and exactly those are the SHARED, writable caches of the project containers. Red if a writable source of mountRules or
// mountRulesCopy lies in one of these places or contains it, or if a place is not in "never mounted".
// Counter-tests (built in): the Dockerfile at the state before the caches were separated and the same Dockerfile without the four
// ENV names are red (`~/.npm` etc. are mounted rw); a value below `~/.npm` is red. On the product: creation.js without
// `h(B_CACHE_FOLDER, …)` in neverMounted => red ("not in never mounted").
const DOCKERFILE = path.resolve(TESTDIR, "..", "Dockerfile");
// The Dockerfile before the caches were separated (reduced from d1633595): the backend stage set none of the four package caches.
const BEFORE_IMAGE_SHELL_1 = [
  "FROM node:22-bookworm-slim AS base",
  "ENV DEBIAN_FRONTEND=noninteractive",
  "ENV CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/agent/.claude-login",
  "FROM base AS projectbox",
  "ENV LIBMOUNT_FORCE_MOUNT2=always",
  "FROM base AS backend",
  "ENV HOME=/home/agent \\",
  "    SHELL=/bin/bash \\",
  "    CBASE_HOST=0.0.0.0 \\",
  "    PORT=7718 \\",
  "    CBASE_CHROMIUM=/usr/bin/chromium \\",
  "    CBASE_VSCODE_TUNNEL=1",
  "",
].join("\n");
const B_CODE_DEFAULT = Object.freeze({ npm_config_cache: ".npm", UV_CACHE_DIR: ".cache/uv", PIP_CACHE_DIR: ".cache/pip", PLAYWRIGHT_BROWSERS_PATH: ".cache/ms-playwright" });
const liesUnder = (p, root) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
function bCodeLocations(text, home) {
  const env = stagesEnv(dockerfileStages(text), "backend");
  const imageHome = env.HOME || "/home/agent";
  return Object.entries(B_CODE_DEFAULT).map(([name, preset]) => {
    const value = env[name];
    if (!value) return { name, path: path.join(home, preset) };
    const rel = path.posix.relative(imageHome, value);
    return { name, path: rel.startsWith("..") || path.posix.isAbsolute(rel) ? value : path.join(home, rel) };
  });
}
function bCodeViolations(text, b) {
  const rules = [...mountRules(b.ctx), ...mountRulesCopy({ ...b.ctx, instance: "copy-k1" })].filter((r) => r.rw);
  const v = [];
  for (const o of bCodeLocations(text, b.home)) {
    for (const r of rules) if (liesUnder(r.source, o.path) || liesUnder(o.path, r.source)) v.push(`${o.name} (${o.path}) and the writable source ${r.rule} (${r.source})`);
    if (!b.ctx.neverMounted.some((n) => n.below && liesUnder(o.path, n.path))) v.push(`${o.name} (${o.path}) not in "never mounted"`);
  }
  return v;
}

test("no writable mount (main and copy) lies at a place from which B loads code — the four values from the Dockerfile; counter-tests built in", () => {
  const b = tree();
  try {
    const real = fs.readFileSync(DOCKERFILE, "utf8");
    assert.deepEqual(bCodeViolations(real, b), []);
    for (const o of bCodeLocations(real, b.home)) assert.ok(liesUnder(o.path, path.join(b.home, B_CACHE_FOLDER)), `${o.name} is not below ${B_CACHE_FOLDER}: ${o.path}`);
    assert.ok(bCodeViolations(BEFORE_IMAGE_SHELL_1, b).some((x) => x.includes("cache-.npm")), "counter-test: the state before the separation is not red");
    const without = real.replace(/\b(npm_config_cache|UV_CACHE_DIR|PIP_CACHE_DIR|PLAYWRIGHT_BROWSERS_PATH)=/g, "UNUSED_$1=");
    assert.notEqual(without, real);
    const withoutV = bCodeViolations(without, b).filter((x) => x.includes("writable source"));
    for (const n of Object.keys(B_CODE_DEFAULT)) assert.ok(withoutV.some((x) => x.startsWith(`${n} `)), `counter-test: without the ENV ${n} is not red`);
    const inNpm = real.replace(/npm_config_cache=\S+/, "npm_config_cache=/home/agent/.npm/b");
    assert.ok(bCodeViolations(inNpm, b).some((x) => x.includes("cache-.npm")), "counter-test: a value below ~/.npm is not red");
  } finally { b.cleanUp(); }
});

// ── The database's WAL files are never mounted ──
// With WAL (store/db.js initStore) the last commits live in automater.db-wal. Counter-test: creation.js without the two
// entries => red.
test("automater.db-wal and -shm are in \"never mounted\"; a mount on the WAL is a violation", () => {
  const b = tree();
  try {
    for (const name of ["automater.db-wal", "automater.db-shm"]) {
      assert.ok(b.ctx.neverMounted.some((n) => n.path === path.join(b.data, name) && n.below), `${name} is missing in "never mounted"`);
    }
    const args = argsFor(b);
    const q = path.join(b.data, "automater.db-wal");
    const v = creationViolations([...args.slice(0, -1), "--mount", bind(q, q), args.at(-1)], b.ctx);
    assert.ok(v.some((x) => x.includes(`touches ${q} (never mounted`)), JSON.stringify(v));
  } finally { b.cleanUp(); }
});

// ── The files of the administration git are never mounted ──
// The names come from their modules (creation.js imports nothing, this test does the binding). Counter-test: creation.js
// without the three lines => both parts red.
test("git-post-work, git-access key and git-projects are in \"never mounted\" as <data>/<name>; a mount on them is a violation", () => {
  const b = tree();
  try {
    for (const name of [POST_WORK_FOLDER, GIT_ACCESS_FILE, GIT_PROJECTS_FILE]) {
      assert.ok(b.ctx.neverMounted.some((n) => n.path === path.join(b.data, name) && n.below), `${name} is missing in "never mounted"`);
    }
    const args = argsFor(b);
    const q = path.join(b.data, POST_WORK_FOLDER);
    const v = creationViolations([...args.slice(0, -1), "--mount", bind(q, q), args.at(-1)], b.ctx);
    assert.ok(v.some((x) => x.includes(`touches ${q} (never mounted`)), JSON.stringify(v));
  } finally { b.cleanUp(); }
});

// ── The copies' backups are never mounted ──
// `<data>/copies-backup` gets into "never mounted" only via the addition from stacks/location.js (neverMountedCopies, set in
// server.js via instance.js setNeverMountedAddition) — projectbox/ never imports stacks/. Red if creation.js drops the
// `addition`, neverMountedCopies returns [], the creation context does not pass it on or the creation goes on without a setter
// (counter-tests: `...addition.map(…)` struck in creation.js => both red; neverMountedCopies returns [] => both red; context()
// without the `!neverAddition` check => the second red).
test("the copies' backups are never mounted — via the addition; without it the row is missing (built-in counter-test)", () => {
  const b = tree();
  try {
    const backup = path.join(b.data, "copies-backup");
    const addition = neverMountedCopies({ data: b.data });
    assert.deepEqual(addition.map((z) => [z.path, z.below]), [[backup, true]]);
    const including = { ...b.ctx, neverMounted: neverMounted({ home: b.home, data: b.data, flat: b.flat, addition }) };
    const args = argsFor(b);
    const before = (...x) => [...args.slice(0, -1), ...x, args.at(-1)];
    assert.deepEqual(creationViolations(args, including), [], "the real arguments violate with the addition");
    for (const q of [backup, path.join(backup, "p1"), path.join(backup, "p1", "k1")]) {
      const v = creationViolations(before("--mount", bind(q, q)), including);
      assert.ok(v.some((x) => x.includes(`touches ${backup}`)), `${q}: no violation "touches ${backup}" — reported: ${JSON.stringify(v)}`);
    }
    // Built-in counter-test: without the addition the list says nothing about the backups — the row comes only through it.
    const without = creationViolations(before("--mount", bind(path.join(backup, "p1"))), b.ctx);
    assert.ok(!without.some((x) => x.includes(`touches ${backup}`)), JSON.stringify(without));
  } finally { b.cleanUp(); }
});

test("the context of a creation carries the backups (setter from server.js); without a setter it throws NEVER_MOUNTED", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    try {
      const k = desiredMounts(s.projectId, s.opts).ctx;
      const backup = path.join(k.data, "copies-backup");
      assert.ok(k.neverMounted.some((n) => n.path === backup && n.below), `the backups are missing in "never mounted": ${JSON.stringify(k.neverMounted.map((n) => n.path))}`);
      setNeverMountedAddition(null);
      assert.throws(() => desiredMounts(s.projectId, s.opts), (e) => e instanceof CreationError && e.code === "NEVER_MOUNTED", "the context went on without a setter");
    } finally {
      setNeverMountedAddition(neverMountedCopies);
    }
  });
});

test("routesFrom: /proc/net/route without the default route", () => {
  const text = routeText([["eth0", "172.24.0.0/16"], ["wg0", "10.0.0.0/24"], ["cbp-0", "10.230.0.0/24"], ["wg1", "10.10.0.2/32"]]);
  assert.deepEqual(routesFrom(text), ["172.24.0.0/16", "10.0.0.0/24", "10.230.0.0/24", "10.10.0.2/32"]);
  assert.deepEqual(routesFrom(""), []);
});

test("BLOCK_LIST comes from CBASE_SUBNET_BLOCK_LIST (comma-separated, trimmed) and is empty without it", () => {
  const read = (env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { BLOCK_LIST } from ${JSON.stringify(pathToFileURL(path.join(SERVER, "projectbox", "creation.js")).href)}; console.log(JSON.stringify(BLOCK_LIST));`], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  assert.deepEqual(read({}), []);
  assert.deepEqual(read({ CBASE_SUBNET_BLOCK_LIST: " 192.0.2.0/24, 198.51.100.7/32 ,," }), ["192.0.2.0/24", "198.51.100.7/32"]);
});

test("selectSubnet: routes, inner pool, block list, exhausted — sabotage: a copy without the route check picks a route's /24", async () => {
  assert.deepEqual(selectSubnet(), { subnet: "10.230.0.0/24", n: 0, gateway: "10.230.0.1", ip: "10.230.0.2", bridge: "cbp-0", hostname: "cbp-0" });
  const withRoute = selectSubnet({ routes: ["10.230.0.0/24"] });
  assert.equal(withRoute.subnet, "10.230.1.0/24", "a route that is no Docker network occupies anyway");
  assert.equal(selectSubnet({ dockerNetworks: ["10.230.0.0/23"], addresses: ["10.230.2.7/24"] }).subnet, "10.230.3.0/24");
  assert.throws(() => selectSubnet({ area: INNER_POOL.replace("/16", "/22") }), /no free \/24/, "the inner pool belongs in the occupation");
  assert.equal(selectSubnet({ area: "10.241.0.0/22", innerPool: "192.0.2.0/24" }).subnet, "10.241.0.0/24", "counter-test: free without this pool");
  assert.equal(selectSubnet({ area: "10.210.0.0/21", blockList: ["10.210.0.0/22", "10.210.4.0/24"] }).subnet, "10.210.5.0/24", "the block list belongs in the occupation");
  assert.equal(selectSubnet({ area: "10.210.0.0/21", blockList: [] }).subnet, "10.210.0.0/24", "counter-test: free without the block list");
  assert.throws(() => selectSubnet({ dockerNetworks: [LEVEL2_AREA] }), /no free \/24 left in 10\.230\.0\.0\/16/);
  assert.throws(() => selectSubnet({ routes: ["broken"] }), /route “broken” is not an IPv4 CIDR/);

  // Sabotage in a copy under the temp folder: without the routes in the occupation the function picks the occupied /24.
  const source = fs.readFileSync(path.join(SERVER, "projectbox", "creation.js"), "utf8");
  assert.ok(source.includes('["route", routes], '), "the sabotage spot is missing — the guard checks nothing any more");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-creation-sabotage-"));
  try {
    const copy = path.join(dir, "creation.mjs");
    fs.writeFileSync(copy, source.replace('["route", routes], ', ""));
    const sabotaged = await import(pathToFileURL(copy).href);
    assert.equal(sabotaged.selectSubnet({ routes: ["10.230.0.0/24"] }).subnet, "10.230.0.0/24", "the sabotage has no effect");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("binding: every occupation of the creation is in the deploy's occupied ranges (probe pool of the distribution)", () => {
  const contained = (inside, outside) => {
    const [ip, n] = inside.split("/");
    const [aip, enabled] = outside.split("/");
    return Number(n) >= Number(enabled) && rangesIntersect(inside, outside) && rangesIntersect(`${ip}/32`, `${aip}/${enabled}`);
  };
  for (const c of [LEVEL2_AREA, INNER_POOL, ...BLOCK_LIST]) {
    assert.ok(OCCUPIED_RANGES.some((b) => contained(c, b.cidr)), `${c} is missing in OCCUPIED_RANGES (tools/check/lib/projectbox-plan.mjs)`);
  }
});

test("createLocation: the pure location creates nothing, createLocation creates scratch, attachments and outputs — the flat location stays untouched", () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-location-"));
  const old = DIRS;
  try {
    const data = path.join(r, "data");
    setDirs({ data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
    const location = locationFor({ projectId: "p1", converted: true });
    const three = [location.scratch, location.attachments, location.outputs];
    for (const d of three) assert.equal(fs.existsSync(d), false, `${d} existed before createLocation`);
    assert.equal(createLocation(location), location);
    for (const d of three) assert.equal(fs.statSync(d).isDirectory(), true, d);
    assert.equal(fs.existsSync(location.home), false, "the CLI home is created by the creation, not by createLocation");
    const flat = locationFor({});
    createLocation(flat);
    for (const d of [flat.scratch, flat.attachments, flat.outputs]) assert.equal(fs.existsSync(d), false, `${d}: createLocation created the flat location`);
  } finally {
    setDirs(old);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test("the project container's name is defined once (cleanUp.js passes creation.js through)", () => {
  assert.equal(projectContainerName, containerName);
  assert.equal(containerName("abc"), "cbase-p-abc");
  assert.equal(volumeName("abc"), "cbase-p-abc-docker");
});

// ── The main's anchor ─────────────────────────────────────────────────────────────────────────────────────────────
// A VIRTUAL tree (no file, fixed paths): the pure functions ask the file system only via `exists`, `entries`, `content` and
// `inode` — mounts, hash and arguments are therefore a function of this table and are to be compared byte for byte with the
// anchor fixtures/projectbox/main-creation.json. The anchor is NEVER re-recorded to turn a red test green: for the main nothing
// changes, not even with copies. Named exceptions, each re-recorded by hand with the difference shown:
//   - the hash formula takes the inode instead of the content for read-only files (`hash` carries the new value, the old one
//     is under `hashV1`; the label `cbase.mounts` keeps the old value, the new one is an extra `--label cbase.mounts.v2=<hash>`);
//   - the exception table carries the row `cli-vscode-server` (always; source `<cliHome>/.vscode-server`, target
//     `<home>/.vscode-server`, rw): one row in `mounts` behind `cli-local`, one `--mount` in `creationArgs`, both hashes new;
//     the "exception … existing/missing" rows run over the frozen list HASH_EXCEPTION_RULES. Every main is thereby recreated
//     once in the next idle phase; a copy is NOT (anchor "copy keeps its mount list" below);
//   - the renames of the product name and of the German words (file/folder, existing/missing, till, projects) changed only
//     names in the hash input;
//   - bridge and hostname `cbp-4` (creation.js BRIDGE_PREFIX; glossary row of the old prefix → `cbp-<n>`) — the two
//     strings `com.docker.network.bridge.name=cbp-4` and the value of `--hostname`, nothing else (both hashes unchanged: neither
//     enters the mount list). The same two strings (`cbp-0`) in main-creation-calls.json.
const ANCHOR_DIR = path.join(TESTDIR, "fixtures", "projectbox");
function virtual() {
  const j = path.posix.join;
  const home = "/v/home";
  const ws = "/v/ws";
  const proj = j(ws, "till");
  const data = "/v/cbase/data";
  const runtime = j(data, "projects", "p1");
  const cliHome = j(runtime, "home");
  const system = { usrLocalBin: "/v/sys/bin", usrLocalNodeModules: "/v/sys/nm", mcp: "/v/sys/mcp" };
  const existing = new Map([
    [proj, "folder"], [runtime, "folder"], [j(ws, "CLAUDE.md"), "file"], [j(ws, ".mcp.json"), "file"],
    [j(ws, ".claude", "settings.json"), "file"], [j(ws, ".claude", "settings.local.json"), "file"],
    [j(home, ".gitconfig"), "file"], [j(home, ".bashrc"), "file"], [j(home, ".claude-login"), "folder"],
    [j(cliHome, ".local"), "folder"], [j(home, ".claude", "settings.json"), "file"], [j(home, ".claude", "CLAUDE.md"), "file"],
    [j(home, ".claude", "agents"), "folder"], [j(home, ".codex", "config.toml"), "file"], [j(home, ".codex", "auth.json"), "file"],
  ]);
  const names = [...existing.keys()];
  const entries = (dir) => (dir === j(ws, ".claude") ? ["settings.json", "secret.json", "skills", "settings.local.json", "agents"] : []);
  const ctx = { projectId: "p1", home, wsPath: ws, projectPath: proj, runtime, cliHome, data, system, entries };
  return {
    ctx, cliHome, data, proj, runtime,
    // The content string stays as recorded with the anchor (main-creation.json): it feeds the old hash formula, so a change here
    // would move hashV1 without any change in creation.js.
    exists: (p, a) => existing.get(p) === a,
    content: (p) => (existing.get(p) === "file" ? `inhalt von ${p}\n` : null),
    inode: (p) => (existing.get(p) === "file" ? 1000 + names.indexOf(p) : null),
  };
}
function mainStatus() {
  const b = virtual();
  const mounts = mountsFor({ ...b.ctx, exists: b.exists });
  const hash = mountsHash(mounts, { content: b.content, inode: b.inode });
  const hashV1 = mountsHashV1(mounts, { content: b.content, inode: b.inode });
  const network = networkFromSubnet("10.230.4.0/24");
  return {
    mounts: mounts.map((m) => ({ rule: m.rule, source: m.source, target: m.target, kind: m.kind, rw: m.rw })),
    hash,
    hashV1,
    networkArgs: networkArgs({ projectId: "p1", network }),
    creationArgs: creationArgs({ projectId: "p1", network, image: `sha256:${ID}`, mounts, hash, hashV1, cliHome: b.cliHome }),
    names: { container: containerName("p1"), network: networkName("p1"), volume: volumeName("p1") },
  };
}
const anchorText = (file) => { try { return fs.readFileSync(path.join(ANCHOR_DIR, file), "utf8"); } catch { return ""; } };

test("main: mounts, mountsHash, network and run args and names are byte-equal with the anchor", () => {
  const now = `${JSON.stringify(mainStatus(), null, 2)}\n`;
  assert.equal(now, anchorText("main-creation.json"), "the main deviates from the anchor — never re-record to turn green");
});

// ── The copy, pure parts ──────────────────────────────────────────────────────────────────────────────────
// Counter-tests: in creation.js creationViolations the line `if (instances.includes(MAIN)) …` struck => "instance=main" red;
// the check "at the original path of the project folder" struck => "project folder rw at the original path" red; in
// mountRulesCopy the rule "project" passed through => "rules" red.
test("copy: own names, labels and rules — violation for instance=main, for the project folder rw at the original path, without chat", () => {
  const b = tree();
  try {
    const inst = "copy-k1";
    const root = path.join(b.data, "copies", "p1", "k1");
    fs.mkdirSync(root, { recursive: true });
    // Names; an instance outside the form throws instead of silently landing at the main.
    assert.deepEqual([containerName("p1", inst), networkName("p1", inst), volumeName("p1", inst)], ["cbase-k-p1-k1", "cbase-kn-p1-k1", "cbase-k-p1-k1-docker"]);
    for (const wrong of ["copy-K1", "copy--a", "copy-a-", "copy-main", "copy-a/b", `copy-${"a".repeat(25)}`, "copy-", "k1"]) {
      assert.throws(() => containerName("p1", wrong), TypeError, wrong);
    }
    // Rules: like the main, only "project" → "main-bottom" + "copy-root", no bind for ~/.local and none for ~/.vscode-server
    // (a copy shares the main's CLI home — two VS Code servers on one data folder).
    const ctx = { ...b.ctx, instance: inst };
    const mounts = mountsFor({ ...ctx, exists: b.exists });
    const main = mountsFor({ ...b.ctx, exists: b.exists });
    assert.deepEqual(mounts.filter((m) => !COPY_RULES.has(m.rule)), main.filter((m) => m.rule !== "project" && !HOME_EXCEPTIONS.has(m.rule)));
    assert.ok(main.some((m) => m.rule === "cli-vscode-server"), "counter-test: the main carries ~/.vscode-server");
    const own = (r) => { const m = mounts.find((x) => x.rule === r); return m && { source: m.source, target: m.target, rw: m.rw, condition: m.condition }; };
    assert.deepEqual(own("main-bottom"), { source: b.proj, target: path.join("/cbase-main", b.proj), rw: false, condition: "required" });
    assert.deepEqual(own("copy-root"), { source: root, target: "/cbase-copy", rw: true, condition: "required" });
    assert.ok(!mounts.some((m) => m.target === b.proj || HOME_EXCEPTIONS.has(m.rule)), "a copy mounts at the original path, ~/.local or ~/.vscode-server");
    // Network and run: instance and chat label, own names, own volume.
    assert.deepEqual(networkArgs({ projectId: "p1", network: NETWORK, instance: inst, chatId: "c1" }), [
      "network", "create", "--driver", "bridge", "--subnet", NETWORK.subnet, "--gateway", NETWORK.gateway, "-o", `com.docker.network.bridge.name=${NETWORK.bridge}`,
      "--label", "cbase.project=p1", "--label", "cbase.instance=copy-k1", "--label", "cbase.chat=c1", "cbase-kn-p1-k1",
    ]);
    assert.throws(() => networkArgs({ projectId: "p1", network: NETWORK, instance: inst }), TypeError, "a copy without chat");
    const hash = mountsHash(mounts);
    const hashV1 = mountsHashV1(mounts);
    const args = creationArgs({ projectId: "p1", network: NETWORK, image: `sha256:${ID}`, mounts, hash, hashV1, cliHome: b.cliHome, instance: inst, chatId: "c1" });
    const next = (opt) => args.flatMap((a, i) => (a === opt ? [args[i + 1]] : []));
    assert.deepEqual(next("--name"), ["cbase-k-p1-k1"]);
    assert.deepEqual(next("--network"), ["cbase-kn-p1-k1"]);
    assert.deepEqual(next("--label"), ["cbase.project=p1", "cbase.instance=copy-k1", "cbase.chat=c1", `${LABEL_MOUNTS}=${hashV1}`, `${LABEL_MOUNTS_V2}=${hash}`]);
    assert.ok(next("--mount").includes("type=volume,src=cbase-k-p1-k1-docker,dst=/var/lib/docker"));
    const check = { ...ctx, image: `sha256:${ID}`, chatId: "c1" };
    assert.deepEqual(creationViolations(args, check), [], "the real arguments of the copy violate the contract");

    // The counter-tests — and what a copy never carries otherwise.
    const beforeImage = (...x) => [...args.slice(0, -1), ...x, args.at(-1)];
    const swap = (old, fresh) => args.map((a) => (a === old ? fresh : a));
    const withoutLabel = (l) => args.filter((a, i) => !(a === l || (a === "--label" && args[i + 1] === l)));
    const cases = [
      ["instance=main", beforeImage("--label", "cbase.instance=main"), "a copy carries the label cbase.instance=main"],
      ["only instance=main", swap("cbase.instance=copy-k1", "cbase.instance=main"), "a copy carries the label cbase.instance=main"],
      ["project folder rw at the original path", swap(bind(b.proj, path.join("/cbase-main", b.proj)), bind(b.proj, b.proj, false)), "at the original path of the project folder"],
      ["project folder additionally at the original path", beforeImage("--mount", bind(b.proj, b.proj, false)), "at the original path of the project folder"],
      ["a folder inside it", beforeImage("--mount", bind(path.join(b.proj, "repo"), path.join(b.proj, "repo"), false)), "at the original path of the project folder"],
      ["without chat", withoutLabel("cbase.chat=c1"), "a copy does not carry exactly one valid label cbase.chat"],
      ["foreign chat", swap("cbase.chat=c1", "cbase.chat=c2"), "label cbase.chat=c2 instead of c1"],
      ["main's name", swap("cbase-k-p1-k1", "cbase-p-p1"), "without --name cbase-k-p1-k1"],
      ["main's network", swap("cbase-kn-p1-k1", "cbase-pn-p1"), "without --network cbase-kn-p1-k1"],
      ["main's volume", swap("type=volume,src=cbase-k-p1-k1-docker,dst=/var/lib/docker", "type=volume,src=cbase-p-p1-docker,dst=/var/lib/docker"), "foreign volume cbase-p-p1-docker"],
      ["root of another copy", beforeImage("--mount", bind(path.join(b.data, "copies", "p1", "k2"), "/k2", false)), `touches ${path.join(b.data, "copies")}`],
      ["all copies", beforeImage("--mount", bind(path.join(b.data, "copies"), "/k", false)), `touches ${path.join(b.data, "copies")}`],
    ];
    for (const [name, a, set] of cases) {
      const v = creationViolations(a, check);
      assert.ok(v.some((s) => s.includes(set)), `${name}: no violation "${set}" — reported: ${JSON.stringify(v)}`);
    }
    // The main: never a chat label, never a copy's root.
    const mainArgs = argsFor(b);
    const mainBefore = (...x) => [...mainArgs.slice(0, -1), ...x, mainArgs.at(-1)];
    assert.ok(creationViolations(mainBefore("--label", "cbase.chat=c1"), b.ctx).some((s) => s.includes("the main carries a label cbase.chat")));
    assert.ok(creationViolations(mainBefore("--mount", bind(root, "/cbase-copy", false)), b.ctx).some((s) => s.includes(`touches ${path.join(b.data, "copies")}`)));
    // An invalid instance in the context is a violation, no fallback to the main.
    assert.deepEqual(creationViolations(mainArgs, { ...b.ctx, instance: "copy" }).length, 1);
  } finally { b.cleanUp(); }
});

// ── createInstance over the fake docker ────────────────────────────────────────────────────────────────────

const hostCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args);

// The call sequence of a creation of the main against the fake docker, normalised (scenario paths, project id, every 64-digit
// base-16 number — container id, image id, mountsHash), against the anchor fixtures/projectbox/main-creation-calls.json. Named
// changes, made by hand: the bridge and hostname `cbp-0` (the two strings only); two rows `--label cbase.mounts.v2=<id>` behind `cbase.mounts`; ONE call at the end, `exec -u agent
// <id> stat -c %d:%i -- <scenario>/home/.local` (the identity of the only source below an anchor, cli-local); a `--mount
// type=bind,src=<…>/home/.vscode-server,dst=<scenario>/home/.vscode-server` behind the one of cli-local in the `run` and the
// target `<scenario>/home/.vscode-server` as the second path of the same `stat`. The sequence of calls stays the same
// (creating the source is no docker call).
function normalized(calls, { s, ctx }) {
  // The placeholders are the ones recorded in the anchor fixture.
  const replace = [[s.path, "<project>"], [path.dirname(s.home), "<scenario>"], [ctx.root, "<root>"], [s.projectId, "<pid>"]];
  return calls.map((args) => args.map((a) => {
    let x = String(a);
    for (const [from, to] of replace) x = x.split(from).join(to);
    return x.replace(/[0-9a-f]{64}/g, "<hex>");
  }));
}

test("createInstance for the main — the call sequence to docker equals the anchor", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    try {
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const now = `${JSON.stringify(normalized(hostCalls(fd), { s, ctx }), null, 2)}\n`;
      assert.equal(now, anchorText("main-creation-calls.json"), "the main's call sequence deviates from the anchor");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fd.cleanUp();
    }
  });
});
const place = (calls, pred) => calls.findIndex(pred);

// The swap BETWEEN the check and `mount`. The fake docker replaces, at `run`, the source `<runtime>/home/.local` for the moment
// of mounting by a link to a folder of B (`runReference`) and restores it afterwards — the link check before the `run` saw a real
// folder. After the `run` the creation compares dev:ino (in B without a link against `stat` in the container): SOURCE_REFERENCE,
// the container is removed by id, the row `error`. Built-in counter-test: the same without the swap => `ready`. Counter-test:
// instance.js without the call of `mountIdentity` after the inside check => red (the creation ends `ready` with B's folder at
// the project's ~/.local).
test("a link the dockerd saw at run but the check before did not — SOURCE_REFERENCE, container removed by id; without the swap ready", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const b = path.join(s.home, ".local-b");
    fs.mkdirSync(path.join(b, "bin"), { recursive: true });
    const source = path.join(s.location.home, ".local");
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, runReference: { source, destination: b } });
    let fd2 = null;
    try {
      let errorCreation = null;
      try { await withOps(fd, () => createInstance(s.projectId, s.opts)); } catch (e) { errorCreation = e; }
      assert.ok(errorCreation, "the creation went through despite the swap at run");
      assert.equal(errorCreation.code, "SOURCE_REFERENCE", errorCreation.message);
      assert.match(errorCreation.message, /\.local/);
      assert.ok(fs.lstatSync(source).isDirectory() && !fs.lstatSync(source).isSymbolicLink(), "the source is a folder again");
      const calls = hostCalls(fd);
      const run = calls.findIndex((a) => a[0] === "run");
      const statCall = calls.findIndex((a) => a[0] === "exec" && a.includes("stat"));
      const rm = calls.findIndex((a) => a[0] === "rm" && a[1] === "-f" && /^[0-9a-f]{64}$/.test(a[2] || ""));
      assert.ok(run >= 0 && statCall > run && rm > statCall, `sequence run → stat → rm -f <id>: ${JSON.stringify(calls.map((a) => a.slice(0, 3)))}`);
      assert.deepEqual(Object.values(fd.state().container).map((c) => c.name), [], "the container is removed");
      assert.equal(store.projectInstance(s.projectId).state, "error");
      // Built-in counter-test: without the swap the source in the container is the same — ready.
      fd2 = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
      const row = await withOps(fd2, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fd.cleanUp();
      fd2?.cleanUp();
    }
  });
});

// The creation of a copy in the build — over a fake docker WITHOUT an inner dockerd (the entrypoint of a copy waits for
// `.prepared`; `info` in it always fails, the status file says `phase=prepare`). Counter-tests: in instance.js `creation` for
// the build today's `waitForInside(containerId)` => red (cap, START, `rm -f` — the creation cap is 2 s here, only the
// counter-test reaches it); in networkFor the old filter `z.projectId !== pid` => red (the copy gets the main's /24).
test("createInstance of a copy in the build: only up to phase=prepare (no docker info), own /24 next to the main, row stays in create", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { status: "phase=prepare\nnotice=waiting for .prepared\n" });
    const inst = "copy-k1";
    const kname = `cbase-k-${s.projectId}-k1`;
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, infoFailures: { [kname]: 1e9 } });
    const copyData = path.join(DIRS.data, "copies", s.projectId, "k1");
    try {
      // The main: row with subnet, its network just gone — exactly the /24 the OLD filter would give the copy (it left out the
      // rows of the own project): the same inputs as networkFor, without the main row.
      const oldChoice = selectSubnet({
        dockerNetworks: store.projectInstances().filter((z) => z.projectId !== s.projectId && z.subnet).map((z) => z.subnet),
        routes: routesFrom(routeText([["eth0", "172.24.0.0/16"]])), addresses: s.opts.addresses,
      });
      setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now(), subnet: oldChoice.subnet, ip: oldChoice.ip, network: networkName(s.projectId) });
      fs.mkdirSync(copyData, { recursive: true });

      await withOps(fd, async () => {
        // Preconditions without docker.
        const prior = hostCalls(fd).length;
        await assert.rejects(createInstance(s.projectId, { ...s.opts, build: true, occupancyHeld: true }), TypeError, "build for the main");
        await assert.rejects(createInstance(s.projectId, { ...s.opts, instance: inst }), TypeError, "a copy without a held occupation");
        await assert.rejects(createInstance(s.projectId, { ...s.opts, instance: "copy", build: true, occupancyHeld: true }), TypeError, "invalid instance");
        await assert.rejects(withProjectOccupancy(s.projectId, "creation", () => createInstance(s.projectId, { ...s.opts, instance: inst, build: true, occupancyHeld: true })),
          TypeError, "build under a foreign occupation");
        await assert.rejects(withProjectOccupancy(s.projectId, "copy", () => createInstance(s.projectId, { ...s.opts, instance: inst, build: true, occupancyHeld: true })),
          (e) => e.code === "OCCUPIED" && /the build holds it in "create"/.test(e.message), "build without the row in create");
        assert.deepEqual(hostCalls(fd).slice(prior), [], "preconditions called docker");

        // The row the build holds in `create`.
        setInstanceState(s.projectId, inst, "create", { phase: "creation", chatId: "c1", copyName: "k1" });
        const row = await withProjectOccupancy(s.projectId, "copy", () =>
          createInstance(s.projectId, { ...s.opts, instance: inst, build: true, occupancyHeld: true }));
        assert.deepEqual([row.identifier, row.state, row.phase, row.error], [`${s.projectId}/${inst}`, "create", "created", ""]);
        assert.ok(row.containerId, "without container id");
        assert.equal(row.network, `cbase-kn-${s.projectId}-k1`);
        assert.ok(!row.convertedAt, "converted_at comes only with ready");
        assert.ok(!row.dnsName, "a main without a name, and the copy got one after all (`<copy>.<main's name>`)");
        assert.notEqual(row.subnet, oldChoice.subnet, "the copy got its main's /24 (old filter)");
        assert.equal(store.projectInstance(s.projectId).subnet, oldChoice.subnet, "the main did not stay as it was");

        const a = hostCalls(fd);
        const run = a.find((x) => x[0] === "run");
        const next = (opt) => run.flatMap((x, i) => (x === opt ? [run[i + 1]] : []));
        assert.deepEqual(next("--name"), [kname]);
        assert.deepEqual(next("--label").slice(0, 3), [`cbase.project=${s.projectId}`, `cbase.instance=${inst}`, "cbase.chat=c1"]);
        assert.ok(next("--mount").includes(`type=bind,src=${copyData},dst=/cbase-copy`), "without the copy root");
        assert.ok(!next("--mount").some((m) => m.includes(`dst=${s.path},`) || m.endsWith(`dst=${s.path}`)), "the project folder at the original path");
        assert.ok(a.some((x) => x[0] === "volume" && x[1] === "create" && x.includes(`cbase.instance=${inst}`) && x.at(-1) === `${kname}-docker`), "volume of the copy");
        assert.ok(a.some((x) => x[0] === "network" && x[1] === "create" && x.at(-1) === `cbase-kn-${s.projectId}-k1` && x.includes("cbase.chat=c1")), "network of the copy");
        // No `docker info` in the copy, no cgroup check — only the status file.
        const inside = a.filter((x) => x[0] === "exec");
        assert.deepEqual(inside.filter((x) => x.includes("info")), [], "docker info in the copy");
        assert.ok(inside.length >= 1 && inside.every((x) => x.at(-1) === "/run/cbase-projectbox.status"), JSON.stringify(inside));
        assert.ok(!a.some((x) => x[0] === "rm"), "the copy was rolled back");
        assert.ok(Object.values(fd.state().container).some((c) => c.name === kname && c.status === "running"), "the copy is not running");
      }, { CBASE_PROJECTBOX_CREATION_MS: "2000" });
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fs.rmSync(path.join(DIRS.data, "copies"), { recursive: true, force: true });
      fd.cleanUp();
    }
  });
});

// The occupation in two levels. Counter-test: withProjectOccupancy without the look at the instance occupations (`running.get(pid)`
// instead of occupancyOfProject) => red (the build would start next to a restore); recreate.js with `projectOccupied` alone and
// withProjectOccupancy => stays green here, but "main and copy side by side" (projectbox-restore.test.js) turns red.
test("occupation: the build of a copy holds the project — recreate and restore of the main are REFUSED, delete names it; conversely side by side per identifier", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    setUiLang("en"); // after the server start: the occupancy sentences are the English source texts
    try {
      setInstanceState(s.projectId, "main", "ready", { convertedAt: Date.now() });
      await withOps(fd, async () => {
        let go;
        const gate = new Promise((r) => { go = r; });
        const build = withProjectOccupancy(s.projectId, "copy", () => gate);
        try {
          assert.equal(projectOccupied(s.projectId), "copy");
          const occupied = (e) => e.code === "OCCUPIED" && /the build of a copy/.test(e.message);
          await assert.rejects(resumeRecreate({ projectId: s.projectId, reason: "Test" }), occupied, "recreate (resume) next to the build");
          assert.equal(earmarkRecreate(s.projectId, { reason: "Test" }), true);
          assert.equal(recreateStatus(s.projectId).last?.reason, "project occupied (copy)", JSON.stringify(recreateStatus(s.projectId)));
          await assert.rejects(restoreInstance(s.projectId, "main"), (e) => e.code === "OCCUPIED", "restore next to the build");
          await assert.rejects(withInstanceOccupancy(s.projectId, "copy-k1", "restore", () => null), occupied, "instance occupation next to the project occupation");
          assert.match(deleteLock([s.projectId])?.error || "", /the build of a copy is running — delete only afterwards/);
          assert.equal(store.projectInstance(s.projectId).state, "ready", "the row was touched");
        } finally { go(); await build; }
        cleanUpRecreate();

        // Conversely: an instance occupation holds off the project occupation, another identifier runs beside it.
        let free;
        const hold = withInstanceOccupancy(s.projectId, "main", "restore", () => new Promise((r) => { free = r; }));
        try {
          assert.equal(instanceOccupied(s.projectId, "main"), "restore");
          assert.deepEqual(occupancyOfProject(s.projectId), { what: "restore", instance: "main" });
          await assert.rejects(withProjectOccupancy(s.projectId, "copy", () => null), (e) => e.code === "OCCUPIED" && /\(instance main\) a restoration is already running/.test(e.message));
          await assert.rejects(withInstanceOccupancy(s.projectId, "main", "recreate", () => null), (e) => e.code === "OCCUPIED");
          assert.equal(await withInstanceOccupancy(s.projectId, "copy-k1", "restore", () => "beside"), "beside");
          assert.match(deleteLock([s.projectId])?.error || "", new RegExp(`${s.projectId}/main a restoration is running`));
        } finally { free(); await hold; }
        assert.equal(occupancyOfProject(s.projectId), null);
      });
    } finally {
      setUiLang("de");
      cleanUpRecreate();
      fd.cleanUp();
    }
  });
});

test("createInstance: preconditions, the way to ready, every failure with rollback", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      // ── Preconditions without docker: no call, no row ──
      {
        const s = scenario(ctx);
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
        open.push(fd);
        const cases = [
          ["without operation", { CBASE_CONTAINER: undefined }, (e) => { assert.equal(e.status, 404); assert.equal(e.code, "NO_OPS"); assert.equal(e.message, "only in server mode"); }],
          ["old login state", { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, (e) => { assert.equal(e.code, "LOGIN"); assert.match(e.message, /login move/); }],
        ];
        for (const [name, values, check] of cases) {
          await raises(withOps(fd, () => createInstance(s.projectId, s.opts), values), (e) => { assert.ok(e instanceof CreationError, name); check(e); });
          assert.deepEqual(fd.calls(), [], `${name}: docker was called`);
          assert.equal(store.projectInstance(s.projectId), null, `${name}: a row was created`);
        }
        const foreign = scenario(ctx, { marker: "4100\n" });
        await raises(withOps(fd, () => createInstance(foreign.projectId, foreign.opts)), (e) => { assert.equal(e.code, "NETWORK_SEPARATION"); assert.match(e.message, /foreign-start/); });
        const withoutMarker = scenario(ctx, { marker: null });
        await raises(withOps(fd, () => createInstance(withoutMarker.projectId, withoutMarker.opts)), (e) => { assert.equal(e.code, "NETWORK_SEPARATION"); assert.match(e.message, /marker missing/); });
        const withoutHome = scenario(ctx, { cliHome: false });
        await raises(withOps(fd, () => createInstance(withoutHome.projectId, withoutHome.opts)), (e) => { assert.equal(e.code, "CLI_HOME"); assert.match(e.message, /CLI home of the project is missing/); });
        await raises(withOps(fd, () => createInstance("exists-not", s.opts)), (e) => assert.equal(e.code, "NO_PROJECT"));
        await raises(withOps(fd, () => createInstance(s.projectId, { ...s.opts, state: "ready" })), (e) => assert.ok(e instanceof TypeError));
        assert.deepEqual(fd.calls(), [], "a precondition called docker");
        for (const x of [foreign, withoutMarker, withoutHome]) assert.equal(store.projectInstance(x.projectId), null);
      }

      // ── The way to ready: network before run, busy while waiting, container per contract ──
      const gut = scenario(ctx);
      {
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: gut.programs, execGate: "inside", infoFailures: { "cbase-p-": 2 } });
        open.push(fd);
        const runItem = withOps(fd, () => createInstance(gut.projectId, gut.opts));
        // Wait for the gate OR the end of the creation — if it fails before, waiting for the gate would hang forever.
        let finished = false;
        runItem.finally(() => { finished = true; }).catch(() => {});
        await waitForTruthy(() => finished || fs.existsSync(path.join(fd.dir, "gates", "inside.waiting")), "creation at the gate \"inside\"");
        if (finished) await runItem;
        const active = await json(`${ctx.base}/api/runs/active`);
        assert.equal(active.busy, true, "a creation in the middle of waiting does not hold busy");
        const work = active.projectWork.find((a) => a.projectId === gut.projectId);
        assert.deepEqual({ state: work?.state, phase: work?.phase }, { state: "create", phase: "wait" });
        fd.openGate("inside");
        const row = await runItem;
        assert.equal(row.state, "ready");
        assert.equal(row.phase, "");
        assert.equal(row.error, "");
        assert.equal(row.convertedAt, null, "the creation does not convert — the relocation does");
        assert.deepEqual({ network: row.network, subnet: row.subnet, bridge: row.bridge, ip: row.ip, gateway: row.gateway, hostname: row.hostname },
          { network: networkName(gut.projectId), subnet: "10.230.0.0/24", bridge: "cbp-0", ip: "10.230.0.2", gateway: "10.230.0.1", hostname: "cbp-0" });
        assert.equal(row.imageId, `sha256:${ID}`);
        const c = Object.values(fd.state().container);
        assert.equal(c.length, 1);
        assert.equal(row.containerId, c[0].id, "the row carries the container's id");
        assert.equal(c[0].name, containerName(gut.projectId));
        assert.equal(c[0].image, `sha256:${ID}`, "created from the id, not from the name");
        assert.equal(c[0].restart, "unless-stopped");
        assert.deepEqual(c[0].networks, [{ name: networkName(gut.projectId), ip: "10.230.0.2" }]);
        assert.equal(c[0].labels["cbase.project"], gut.projectId);
        // The new formula in its own label (the row carries it), the old one in `cbase.mounts`.
        assert.equal(c[0].labels[LABEL_MOUNTS_V2], row.mountsHash);
        assert.equal(c[0].labels[LABEL_MOUNTS], desiredMounts(gut.projectId, gut.opts).hashV1, "cbase.mounts does not carry the old formula");
        assert.equal(c[0].env.CLAUDE_CONFIG_DIR, path.join(gut.location.home, ".claude"));
        assert.equal(c[0].env.CBASE_DOCKER_POOL, INNER_POOL);
        const sources = c[0].mounts.filter((m) => m.Type === "bind").map((m) => m.Source);
        assert.ok(sources.includes(gut.path), "the project is not mounted");
        assert.ok(!sources.includes(path.join(ctx.root, "workspace")), "the workspace is mounted");
        assert.ok(!sources.some((q) => q.startsWith(path.join(gut.home, ".ssh"))), ".ssh is mounted");
        assert.ok(!sources.some((q) => q === ctx.dataRoot || q === path.join(ctx.dataRoot, "data")), "the data folder is mounted");
        const vol = c[0].mounts.filter((m) => m.Type === "volume");
        assert.deepEqual(vol.map((m) => [m.Source, m.Destination]), [[volumeName(gut.projectId), "/var/lib/docker"]]);

        const a = hostCalls(fd);
        const create = place(a, (x) => x[0] === "network" && x[1] === "create");
        const vcreate = place(a, (x) => x[0] === "volume" && x[1] === "create");
        const run = place(a, (x) => x[0] === "run");
        assert.ok(create >= 0 && vcreate > create && run > vcreate, `order network → volume → run: ${JSON.stringify(a.map((x) => x.slice(0, 2)))}`);
        assert.equal(a.filter((x) => x[0] === "run").length, 1);
        assert.deepEqual(creationViolations(a[run], { ...desiredMounts(gut.projectId, gut.opts).ctx, image: `sha256:${ID}` }), [], "the executed `run` violates the contract");
        assert.equal(fd.calls({ daemon: containerName(gut.projectId) }).filter((x) => x.args[0] === "info").length, 3, "the inner dockerd was not waited for (two failures, then the answer)");
        assert.equal(desiredMounts(gut.projectId, gut.opts).hash, row.mountsHash, "the desired hash deviates from the label");
        // The target placeholders of the single-file mounts are files of the server in the project's CLI home.
        const slot = path.join(gut.location.home, ".claude", "settings.json");
        assert.equal(fs.statSync(slot).size, 0);
        assert.equal(fs.statSync(slot).uid, process.getuid());

        // A second own creation on a ready instance: refused, nothing changed, no docker.
        const prior = fd.calls().length;
        await raises(withOps(fd, () => createInstance(gut.projectId, gut.opts)), (e) => { assert.equal(e.code, "OCCUPIED"); assert.match(e.message, /is ready — recreating/); });
        assert.equal(fd.calls().length, prior);
        assert.deepEqual(store.projectInstance(gut.projectId), row);
      }

      // ── The network: .0 has the instance above, .1 is a route, .2 is refused by Docker ("Pool overlaps") => .3;
      //    counter-test without the route: .1 ──
      {
        const s = scenario(ctx, { routes: [["eth0", "172.24.0.0/16"], ["wg9", "10.230.1.0/24"]] });
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, occupiedNetworks: ["10.230.2.0/24"] });
        open.push(fd);
        const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
        assert.equal(row.subnet, "10.230.3.0/24");
        const creates = hostCalls(fd).filter((x) => x[0] === "network" && x[1] === "create").map((x) => x[x.indexOf("--subnet") + 1]);
        assert.deepEqual(creates, ["10.230.2.0/24", "10.230.3.0/24"], "the /24 of another instance or of the route was tried");
        const g = scenario(ctx);
        const fd2 = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: g.programs, occupiedNetworks: ["10.230.2.0/24"] });
        open.push(fd2);
        assert.equal((await withOps(fd2, () => createInstance(g.projectId, g.opts))).subnet, "10.230.1.0/24", "counter-test: without the route .1");
      }

      // ── Recreate: the caller's state stays, the row's address too ──
      {
        const s = scenario(ctx);
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
        open.push(fd);
        setInstanceState(s.projectId, "main", "recreate", { subnet: "10.230.7.0/24" });
        const row = await withOps(fd, () => createInstance(s.projectId, { ...s.opts, state: "recreate" }));
        assert.deepEqual({ state: row.state, phase: row.phase, subnet: row.subnet, ip: row.ip }, { state: "recreate", phase: "created", subnet: "10.230.7.0/24", ip: "10.230.7.2" });
        setInstanceState(s.projectId, "main", "ready");
      }

      // ── Failures behind the run: container gone (by id), network gone, volume there, row error with reason ──
      const afterRun = [
        ["vfs", { infoDriver: { "cbase-p-": "vfs" } }, {}, /storage driver "vfs" instead of overlay2/],
        ["without memory", {}, { cgroup: "cpu io pids\n" }, /cgroup\.subtree_control without memory/],
        ["entrypoint error", {}, { status: "phase=error\nnotice=dnat: iptables missing\n" }, /phase=error: dnat: iptables missing/],
        ["container ends at once", { brokenImages: [ID] }, {}, /ended at once \(exited, exit 1\)/],
        ["Cap", {}, { status: "phase=wait\nnotice=dockerd started\n" }, /cap of 300 ms hit \(status file phase=wait\)/, { CBASE_PROJECTBOX_CREATION_MS: "300" }],
        // `run` creates the container and fails at the start (125, no id) — the rollback finds it by name.
        ["run creates, start fails", { runStartBroken: ["^cbase-p-"] }, {}, /Address already in use/],
      ];
      for (const [name, fdOpts, sOpts, set, values = {}] of afterRun) {
        const s = scenario(ctx, sOpts);
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, ...fdOpts });
        open.push(fd);
        await raises(withOps(fd, () => createInstance(s.projectId, s.opts), values), (e) => { assert.ok(e instanceof CreationError, name); assert.match(e.message, set, name); });
        const z = fd.state();
        assert.deepEqual(Object.values(z.container), [], `${name}: the container stayed`);
        assert.deepEqual(Object.values(z.networks), [], `${name}: the network stayed`);
        assert.ok(z.volumes[volumeName(s.projectId)], `${name}: the volume is gone (it survives every recreate)`);
        const rm = hostCalls(fd).find((x) => x[0] === "rm");
        assert.match(rm?.[2] || "", /^[0-9a-f]{64}$/, `${name}: not removed by id`);
        const row = store.projectInstance(s.projectId);
        assert.equal(row.state, "error", name);
        assert.match(row.error, set, name);
        assert.equal(row.containerId, "", name);
      }

      // ── Failures before the row: image missing, container name taken — the row stays as it was ──
      {
        const s = scenario(ctx);
        const fd = await fakeDocker({ programs: s.programs });
        open.push(fd);
        await raises(withOps(fd, () => createInstance(s.projectId, s.opts)), (e) => { assert.equal(e.code, "IMAGE"); assert.match(e.message, /is missing in the user container/); });
        assert.equal(store.projectInstance(s.projectId), null);
        assert.ok(!hostCalls(fd).some((x) => x[0] === "run" || x[0] === "network" || x[0] === "volume"));

        const fd2 = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
        open.push(fd2);
        await withOps(fd2, async () => {
          const { docker } = await import("../electron/server/projectbox/docker.js");
          await docker(["run", "-d", "--name", containerName(s.projectId), "alpine"]);
        });
        setInstanceState(s.projectId, "main", "error", { error: "prior" });
        const prior = store.projectInstance(s.projectId);
        await raises(withOps(fd2, () => createInstance(s.projectId, s.opts)), (e) => assert.equal(e.code, "CONTAINER_EXISTS"));
        assert.deepEqual(store.projectInstance(s.projectId), prior, "a precondition touched the row");
        assert.equal(Object.values(fd2.state().container).length, 1, "the foreign container was removed");
      }

      // ── An empty placeholder whose source is missing goes; a written one stays ──
      {
        const s = scenario(ctx);
        fs.rmSync(path.join(s.home, ".codex", "auth.json"));
        fs.mkdirSync(path.join(s.location.home, ".claude"), { recursive: true });
        const empty = path.join(s.location.home, ".codex", "auth.json");
        const described = path.join(s.location.home, ".claude", "CLAUDE.md");
        fs.writeFileSync(empty, "");
        fs.writeFileSync(described, "from the project itself\n");
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
        open.push(fd);
        await withOps(fd, () => createInstance(s.projectId, s.opts));
        assert.equal(fs.existsSync(empty), false, "the empty placeholder stayed (the CLI would read an empty auth.json)");
        assert.equal(fs.readFileSync(described, "utf8"), "from the project itself\n");
      }
    } finally {
      // No working row may outlive the test: the harness's wait for quiet would otherwise last forever.
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      for (const fd of open) fd.cleanUp();
    }
  });
});

test("containerOf: a start from an old snapshot of the instance hits the NEW container after a recreate (stable name)", async () => {
  const fd = await fakeDocker();
  try {
    await withOps(fd, async () => {
      const pid = "pd6x";
      const create = async () => (await docker(["run", "-d", "--name", containerName(pid), "--label", `cbase.project=${pid}`, "cbase-projectbox:test"])).stdout.trim();
      const old = await create();
      // The snapshot a core holds (runs/instance.js: the row "as it travels").
      const image = { projectId: pid, instance: "main", identifier: `${pid}/main`, containerId: old };
      // Recreate: the old one is removed by id, the new one appears under the same name.
      await docker(["rm", "-f", old]);
      const fresh = await create();
      assert.notEqual(fresh, old);
      // First the effect (the counter-test against the row's id fails HERE: "No such container"), then the name.
      const r = await docker(["exec", containerOf(image), "true"]);
      assert.equal(r.code, 0);
      assert.equal(containerOf(image), containerName(pid));
      const ex = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").map((a) => a.args);
      assert.deepEqual(ex, [["exec", containerName(pid), "true"]]);
      // Also a copy via its stable name, never via the id of its row; an invalid instance throws.
      assert.equal(containerOf({ projectId: pid, instance: "copy-k1", containerId: "c0ffee" }), `cbase-k-${pid}-k1`);
      assert.throws(() => containerOf({ projectId: pid, instance: "copy", containerId: "c0ffee" }), TypeError);
      assert.equal(containerOf({ projectId: pid }), containerName(pid), "without id and instance: the name");
    });
  } finally { fd.cleanUp(); }
});

test("during the server end the creation refuses — without a docker call (own process: endServer ends it)", async () => {
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-creation-end-"));
  let subprocess = null;
  try {
    const output = path.join(dir, "result.json");
    const url = (p) => JSON.stringify(pathToFileURL(path.join(SERVER, p)).href);
    const script = path.join(dir, "child.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";
const { registerHook } = await import(${url("runs/hooks.js")});
const { endServer, serverEnds } = await import(${url("runs/server-end.js")});
const { createInstance } = await import(${url("projectbox/instance.js")});
const result = { prior: serverEnds() };
registerHook("serverEnd", async () => {
  result.inHook = serverEnds();
  try { await createInstance("p1"); result.creation = "created"; }
  catch (e) { result.creation = { code: e.code ?? null, status: e.status ?? null, message: e.message }; }
  fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
}, { name: "test-creation", warten: true });
endServer(null);
`);
    const env = { ...process.env, CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000" };
    delete env.NODE_TEST_CONTEXT;
    subprocess = spawn(process.execPath, [script], { env, stdio: ["ignore", "ignore", "inherit"] });
    const code = await new Promise((resolve) => subprocess.once("exit", (c, s) => resolve(c ?? s)));
    assert.equal(code, 0);
    const e = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(e.prior, false);
    assert.equal(e.inHook, true, "serverEnds() is not set in the consumers of \"serverEnd\"");
    assert.deepEqual({ code: e.creation.code, status: e.creation.status }, { code: "SERVER_ENDS", status: 503 }, JSON.stringify(e.creation));
    assert.match(e.creation.message, /the server is ending/);
    assert.deepEqual(fd.calls(), []);
  } finally {
    if (subprocess && subprocess.exitCode === null && subprocess.signalCode === null) subprocess.kill("SIGKILL");
    fd.cleanUp();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── `~/.vscode-server` per project ───────────────────────────────────────────────────────────────────────────────────────
// The VS Code server used to live in the write layer of the project container; every recreate threw it away. Hence the rule
// `cli-vscode-server` of the exception table: source `<cliHome>/.vscode-server`, target `<home>/.vscode-server`, rw, ALWAYS there
// (the creation creates the source). Held:
//   - the pure side: the row is in mountsFor even without a source, the desired calculation creates nothing and its hash does
//     not depend on whether the source is already there; the check function accepts the real arguments (built-in counter-test:
//     without HOME_EXCEPTIONS the row would be a violation "not below CLAUDE_CONFIG_DIR/CODEX_HOME") and refuses B's own
//     `~/.vscode-server` as a source; a copy never mounts the shared folder;
//   - the creation over the fake docker: an existing project WITHOUT the folder gets it created (the source appears as a real
//     folder, the label carries the desired hash from before), existing content stays; a link in its place — outward, into
//     nothing or in the runtime folder — is SOURCE_REFERENCE without `run`, and nothing appears in B.
// Counter-tests (which sabotage turns which test red): see the end of this section.
test("cli-vscode-server: row always there (even without a source), desired creates nothing, check function allows it and refuses B's ~/.vscode-server; copy without", () => {
  const b = tree();
  try {
    const h = (...t) => path.join(b.home, ...t);
    const source = path.join(b.cliHome, VSCODE_SERVER);
    assert.equal(fs.existsSync(source), false, "the tree does not have the source (yet) — like every project before");
    const io = { inode: (p) => { try { return fs.statSync(p).ino; } catch { return null; } } };
    const mounts = mountsFor({ ...b.ctx, exists: b.exists });
    const row = mounts.find((m) => m.rule === "cli-vscode-server");
    assert.deepEqual(row && { source: row.source, target: row.target, kind: row.kind, rw: row.rw, condition: row.condition },
      { source, target: h(VSCODE_SERVER), kind: "folder", rw: true, condition: "create" });
    assert.equal(fs.existsSync(source), false, "the pure calculation created the source");
    const prior = mountsHash(mounts, io);
    fs.mkdirSync(source);
    const after = mountsFor({ ...b.ctx, exists: b.exists });
    assert.equal(mountsHash(after, io), prior, "the desired hash depends on whether the source is already there — check and creation would see two states");
    assert.equal(mountsHashV1(after, io), mountsHashV1(mounts, io));

    // The check function: the real arguments are empty; built-in counter-test — without the set of home rules the row would be a
    // violation (the set replaces the earlier `a.rule !== "cli-local"`).
    const args = argsFor(b, mounts);
    assert.deepEqual(creationViolations(args, b.ctx), []);
    HOME_EXCEPTIONS.delete("cli-vscode-server");
    try {
      const v = creationViolations(args, b.ctx);
      assert.ok(v.some((x) => x.includes(`CLI target ${h(VSCODE_SERVER)} is not under CLAUDE_CONFIG_DIR/CODEX_HOME`)), JSON.stringify(v));
    } finally { HOME_EXCEPTIONS.add("cli-vscode-server"); }

    // B's OWN ~/.vscode-server (vscode-tunnel.js) is never a source — neither in place of the project source nor beside it.
    const beforeImage = (...x) => [...args.slice(0, -1), ...x, args.at(-1)];
    const swap = (old, fresh) => args.map((a) => (a === old ? fresh : a));
    const real = bind(source, h(VSCODE_SERVER), false);
    assert.ok(args.includes(real), `no ${real} in the arguments`);
    const cases = [
      ["B's ~/.vscode-server instead of the project source", swap(real, bind(h(VSCODE_SERVER), h(VSCODE_SERVER), false)),
        [`mount outside the list: ${h(VSCODE_SERVER)}`, `touches ${h(VSCODE_SERVER)} (never mounted`]],
      ["B's ~/.vscode-server/bin at another place", beforeImage("--mount", bind(h(VSCODE_SERVER, "bin"), "/vs", false)), [`touches ${h(VSCODE_SERVER)} (never mounted`]],
      ["the project source below CLAUDE_CONFIG_DIR", swap(real, bind(source, path.join(b.cliHome, ".claude", "vs"), false)), [`belongs at ${h(VSCODE_SERVER)}`]],
      ["the project source read-only", swap(real, bind(source, h(VSCODE_SERVER), true)), ["is meant to be writable"]],
    ];
    for (const [name, a, sets] of cases) {
      const v = creationViolations(a, b.ctx);
      for (const set of sets) assert.ok(v.some((x) => x.includes(set)), `${name}: no violation "${set}" — reported: ${JSON.stringify(v)}`);
    }

    // A copy shares the main's CLI home — it never mounts the folder, and an attempt is a violation.
    const inst = "copy-k1";
    fs.mkdirSync(path.join(b.data, "copies", "p1", "k1"), { recursive: true });
    const kctx = { ...b.ctx, instance: inst };
    const kmounts = mountsFor({ ...kctx, exists: b.exists });
    assert.ok(!kmounts.some((m) => m.rule === "cli-vscode-server" || m.source === source), "a copy mounts the main's ~/.vscode-server");
    const kargs = creationArgs({ projectId: "p1", network: NETWORK, image: `sha256:${ID}`, mounts: kmounts, hash: mountsHash(kmounts), hashV1: mountsHashV1(kmounts), cliHome: b.cliHome, instance: inst, chatId: "c1" });
    const kcheck = { ...kctx, chatId: "c1" };
    assert.deepEqual(creationViolations(kargs, kcheck), []);
    const kv = creationViolations([...kargs.slice(0, -1), "--mount", real, kargs.at(-1)], kcheck);
    assert.ok(kv.some((x) => x.includes(`mount outside the list: ${source}`)), JSON.stringify(kv));
  } finally { b.cleanUp(); }
});

// The copy's anchor: over the same virtual tree as mainStatus(), for `copy-k1`, calculated ONCE against the creation.js from
// before the `cli-vscode-server` row. A copy does not mount `cli-vscode-server` — its mount list AND both hashes must therefore
// stay byte-equal, otherwise rolling out would recreate every running copy (terminals and write layer gone). Counter-test: the
// hash rows over EXCEPTION_RULES again => red. The rule list is unchanged, and the promise stays: the row changes nothing for a copy.
// Re-anchored ONCE (with fixtures/projectbox/main-creation.json): the hash input words became English (`exception`,
// `content`, projectbox/creation.js) before the first cbase rollout; the label key itself had already moved from the old product's
// prefix to `cbase.mounts`, so no running container carries a value of the old words.
const COPY_BEFORE_N56 = Object.freeze({
  rules: ["main-bottom", "copy-root", "ws-CLAUDE.md", "ws-.mcp.json", "ws-.claude/settings.json", "ws-.claude/settings.local.json", "runtime",
    "cache-.npm", "cache-.cache/uv", "cache-.cache/ms-playwright", "cache-.cache/pip", "home-.gitconfig", "home-.bashrc", "system-bin",
    "system-node_modules", "system-mcp", "login", "cli-claude-settings", "cli-claude-md", "cli-claude-agents", "cli-codex-config", "cli-codex-auth"],
  v2: "606bc12c95c820aa1afe797d61819fd24874ffcb4181968a57bd3ca24f34aa58",
  v1: "e02edd22030bce62de7e3e30050fb39f3fa3e07046ba6b5c3b716cb4ec58a134",
});
test("copy keeps its mount list: list and both hashes of a copy are byte-equal with the anchor from before the vscode-server row — the main's are not", () => {
  const b = virtual();
  const io = { content: b.content, inode: b.inode };
  const mounts = mountsFor({ ...b.ctx, instance: "copy-k1", exists: b.exists });
  assert.deepEqual({ rules: mounts.map((m) => m.rule), v2: mountsHash(mounts, io), v1: mountsHashV1(mounts, io) }, COPY_BEFORE_N56,
    "a copy's hash changed — every running copy would be recreated without use");
  // The list of hash rows is the table from before: all rules except `cli-vscode-server`, in the same order.
  assert.deepEqual([...HASH_EXCEPTION_RULES], EXCEPTION_RULES.filter((r) => r !== "cli-vscode-server"));
  // The other side: the main mounts the row, its hash is new (the row is in it via `mount`).
  const main = mountsFor({ ...b.ctx, exists: b.exists });
  assert.ok(main.some((m) => m.rule === "cli-vscode-server"));
  const without = main.filter((m) => m.rule !== "cli-vscode-server");
  assert.notEqual(mountsHash(main, io), mountsHash(without, io), "the mount row `cli-vscode-server` is not in the main's hash");
  assert.notEqual(mountsHashV1(main, io), mountsHashV1(without, io));
});

const runArgs = (fd) => hostCalls(fd).filter((a) => a[0] === "run");
const n56End = () => { for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" }); };

test("creation: an existing project without ~/.vscode-server gets it created — real folder, label = desired hash from before; existing content stays", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const source = path.join(s.location.home, VSCODE_SERVER);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    try {
      assert.equal(fs.existsSync(source), false, "the scenario has the folder — it is meant to be a project from before");
      const desired = desiredMounts(s.projectId, s.opts);
      assert.ok(desired.mounts.some((m) => m.rule === "cli-vscode-server" && m.source === source), "the desired calculation does not know the row");
      assert.equal(fs.existsSync(source), false, "desiredMounts created the source (the desired calculation is pure)");
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const st = fs.lstatSync(source);
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), "the source is not a real folder");
      const [run] = runArgs(fd);
      assert.ok(run.includes(`type=bind,src=${source},dst=${path.join(s.home, VSCODE_SERVER)}`), `no rw mount ~/.vscode-server: ${run.filter((a) => a.includes("vscode")).join(" | ")}`);
      assert.equal(run.find((a) => a.startsWith(`${LABEL_MOUNTS_V2}=`)), `${LABEL_MOUNTS_V2}=${desired.hash}`,
        "the desired hash BEFORE creating the source is not the container's — the check of recreate.js would find it deviating forever");
      assert.equal(row.mountsHash, desired.hash);
      assert.equal(desiredMounts(s.projectId, s.opts).hash, desired.hash, "a different desired hash after the creation");

      // A second project WITH a VS Code version in the folder (the case before a recreate): it stays.
      const s2 = scenario(ctx);
      const version = path.join(s2.location.home, VSCODE_SERVER, "bin", "a".repeat(40));
      fs.mkdirSync(version, { recursive: true });
      fs.writeFileSync(path.join(version, "node"), "VS-CODE\n");
      const z2 = await withOps(fd, () => createInstance(s2.projectId, s2.opts));
      assert.equal(z2.state, "ready", z2.error);
      assert.equal(fs.readFileSync(path.join(version, "node"), "utf8"), "VS-CODE\n", "the creation touched the content");
    } finally {
      n56End();
      fd.cleanUp();
    }
  });
});

test("link: the project's ~/.vscode-server is a link (outward, into nothing, in the runtime folder) — SOURCE_REFERENCE without run, nothing appears in B; as a folder ready", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const source = path.join(s.location.home, VSCODE_SERVER);
    const inB = path.join(s.home, "vs-of-b");
    fs.mkdirSync(path.join(inB, "bin"), { recursive: true });
    const empty = path.join(s.home, "vs-exists-not");
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    try {
      const cases = [
        ["outward (a folder of B)", inB],
        ["into nothing (a target in B that does not exist)", empty],
        ["in the runtime folder (onto the project's ~/.local)", ".local"],
      ];
      for (const [name, target] of cases) {
        fs.rmSync(source, { recursive: true, force: true });
        fs.symlinkSync(target, source);
        const prior = fs.readdirSync(inB).sort();
        let errorCreation = null;
        try { await withOps(fd, () => createInstance(s.projectId, s.opts)); } catch (e) { errorCreation = e; }
        assert.ok(errorCreation, `${name}: the creation went through despite the link`);
        assert.equal(errorCreation.code, "SOURCE_REFERENCE", `${name}: ${errorCreation.message}`);
        assert.match(errorCreation.message, /\.vscode-server/, name);
        assert.deepEqual(runArgs(fd), [], `${name}: a \`run\` despite the link`);
        assert.ok(fs.lstatSync(source).isSymbolicLink(), `${name}: the link is gone`);
        assert.deepEqual(fs.readdirSync(inB).sort(), prior, `${name}: something appeared in B`);
        assert.equal(fs.existsSync(empty), false, `${name}: the target of the link into nothing appeared in B`);
        assert.equal(store.projectInstance(s.projectId).state, "error", name);
      }
      // Counter-test: as a real folder — ready.
      fs.rmSync(source);
      fs.mkdirSync(source);
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
    } finally {
      n56End();
      fd.cleanUp();
    }
  });
});
// Counter-tests:
//   1. instance.js `creation`: createSourcesOn AFTER mountSourcesWithReference (the old place of creating) => "creation: an existing
//      project without ~/.vscode-server …" red (SOURCE_REFERENCE instead of ready) — every project without the folder would fail.
//   2. instance.js createSourcesOn: a bare `fs.mkdirSync(m.source, { recursive: true })` instead of createFolderInRuntimeFolder
//      => "link: …" red (into nothing: the target in B could appear; the link outward is caught by the strict check afterwards anyway).
//   3. creation.js `mountRulesCopy`: the skip over `cli-vscode-server` struck => "cli-vscode-server: …" (copy without) and two copy tests red.
//   4. creation.js `neverMounted`: `h(VSCODE_SERVER, …)` struck => "cli-vscode-server: …" red (B's ~/.vscode-server only "outside the
//      list", no longer "never mounted") — the other tests of the file stay green.
//   5. creation.js `exceptionTable`: `condition: "create"` struck (default "exists") => seven red, among them all three vscode-server tests and both anchors.
//   6. creation.js `mountsHash`/`mountsHashV1`: the "exception …" rows over `EXCEPTION_RULES` instead of `HASH_EXCEPTION_RULES`
//      => "copy keeps its mount list …" red (every copy would be recreated) and the main anchor red.
//   The set of home rules is checked by "cli-vscode-server: …" itself (built-in counter-test without `cli-vscode-server`).

// ── The bridge prefix (creation.js BRIDGE_PREFIX) ───────────────────────────────────────────────────────────────────────────────
// A project network an older release created carries the old bridge name; entry.sh of this release guards only `-i cbp-+`. The
// creation (instance.js networkFor) must not adopt it: removed and created again on THE SAME subnet with the derived bridge — the
// container gets the same IP and the hostname `cbp-<n>`. A network that still has an endpoint is refused (CreationError NETWORK),
// nothing removed. Built-in counter-tests: a network that already carries `cbp-0` is adopted unchanged (same id, no `network rm`),
// and the old network passes every check the creation had before (project label, subnet) — without the bridge check it would have
// been kept. Counter-test by sabotage (run once by hand): the block "THE BRIDGE" in instance.js networkFor struck =>
// this test red at "the old network was kept".
test("bridge prefix: an existing project network with the old bridge is recreated on its subnet with cbp-<n>; with an endpoint refused; a cbp- network is adopted", async () => {
  const OLD = `${"hx" + "p-"}0`;
  const net = (fd, pid) => Object.values(fd.state().networks).find((n) => n.name === networkName(pid));
  const seed = (fd, pid, bridge) => withOps(fd, () => docker(["network", "create", "--driver", "bridge", "--subnet", "10.230.0.0/24", "--gateway", "10.230.0.1",
    "-o", `com.docker.network.bridge.name=${bridge}`, "--label", `cbase.project=${pid}`, "--label", "cbase.instance=main", networkName(pid)]));
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID, "busybox:latest": "b".repeat(64) }, programs: s.programs });
    try {
      // (1) old bridge, no endpoint => recreated, same subnet, new bridge, hostname cbp-0.
      await seed(fd, s.projectId, OLD);
      const old = net(fd, s.projectId);
      assert.equal(old.options["com.docker.network.bridge.name"], OLD);
      assert.equal(old.labels["cbase.project"], s.projectId, "the old network carries the project label — the check before would have adopted it");
      assert.equal(old.subnet, networkFromSubnet("10.230.0.0/24").subnet, "the old network carries the derived subnet — the check before would have adopted it");
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      const now = net(fd, s.projectId);
      assert.notEqual(now.id, old.id, "the old network was kept — its bridge stands outside the separation");
      assert.equal(now.options["com.docker.network.bridge.name"], "cbp-0");
      assert.equal(now.subnet, "10.230.0.0/24", "not the same subnet");
      assert.deepEqual({ bridge: row.bridge, hostname: row.hostname, subnet: row.subnet, ip: row.ip }, { bridge: "cbp-0", hostname: "cbp-0", subnet: "10.230.0.0/24", ip: "10.230.0.2" });
      const c = Object.values(fd.state().container).find((x) => x.name === containerName(s.projectId));
      assert.equal(c.hostname, "cbp-0");
      const calls = hostCalls(fd);
      const rm = place(calls, (a) => a[0] === "network" && a[1] === "rm" && a[2] === old.id);
      const create = place(calls, (a) => a[0] === "network" && a[1] === "create" && a.includes("com.docker.network.bridge.name=cbp-0"));
      assert.ok(rm >= 0 && create > rm, "not removed by id before the new network");

      // (2) the cbp- network is adopted unchanged at the next creation (recreate path: container gone, row with subnet).
      const before = net(fd, s.projectId);
      await withOps(fd, () => docker(["rm", "-f", row.containerId]));
      setInstanceState(s.projectId, "main", "error", { error: "test", containerId: "" });
      const mark = hostCalls(fd).length;
      const again = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(again.state, "ready", again.error);
      assert.equal(net(fd, s.projectId).id, before.id, "a cbp- network was recreated");
      assert.equal(place(hostCalls(fd).slice(mark), (a) => a[0] === "network" && a[1] === "rm"), -1, "a network rm although the bridge is right");

      // (3) old bridge WITH an endpoint (a foreign running container) => refused, nothing removed, row error.
      await withOps(fd, () => docker(["rm", "-f", again.containerId]));
      setInstanceState(s.projectId, "main", "error", { error: "test", containerId: "" });
      await withOps(fd, () => docker(["network", "rm", networkName(s.projectId)]));
      await seed(fd, s.projectId, OLD);
      const held = net(fd, s.projectId);
      await withOps(fd, () => docker(["run", "-d", "--name", "squatter", "--network", networkName(s.projectId), "busybox:latest"]));
      await assert.rejects(withOps(fd, () => createInstance(s.projectId, s.opts)), (e) => e instanceof CreationError && /carries the bridge .* still attached — not recreated/.test(e.message));
      assert.equal(net(fd, s.projectId)?.id, held.id, "the network with an endpoint was removed");
      assert.equal(store.projectInstance(s.projectId).state, "error");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fd.cleanUp();
    }
  });
});
