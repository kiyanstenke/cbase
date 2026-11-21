// The runtime folder per project: runs/runtime-location.js and its consumers.
//
// What holds here:
//   (1)  Pure table: without a project, with a non-converted project and without a row EVERY path is byte-equal to the old one (held
//        against the old formulas, not against the new function); a converted project lies under `<data>/projects/<id>/…`; an id
//        that would lead out throws. The Playwright configuration lies beside the root of its profile; the spelling of the profile
//        names is bound to browser-profiles.js.
//   (1c) flat only without a store or without the table — every other read error of the instance row throws.
//   (1d) `serviceLogFile(pid, svc, instance)`: without an instance `main_<svc>.log` as before.
//   (1e) `worktreeRoot(place, instance)`: `main`/no argument as before (`place.worktrees`), `copy-<name>` =>
//        `<runtime>/copy-worktrees/<name>`; the form of the name is bound to projectbox/creation.js; flat and a name outside the form
//        throw (a path from a wrong input would otherwise fall next to the copy).
//   (1f) `archiveFile(place, archiveId)` = `<runtime>/setup/archive-<uuid>.zip`; flat and an id outside the UUID form throw;
//        `archiveIdFromName` is the inverse (a foreign name => null). Counter-test: archiveFile without the id check => (1f) red.
//   (2)  Path guard: `DIRS.scratch`, `DIRS.attachments`, `DIRS.outputs` and the literals "playwright-configs", "playwright-profiles",
//        "service-logs", "worktrees", "browser-profiles", "copy-worktrees" stand under server/backend/electron only in
//        runs/runtime-location.js — except PATH_EXCEPTIONS (login stock, workspace browser profile; file, count, reason, printed at
//        every run; a hit without an entry, an entry without a hit and another count are red); the same for the setup subfolder and
//        the archive file name. Built-in sabotage: `path.join(DIRS.scratch, …)` in a copy of do-run.js is red (also `DIRS?.scratch`
//        and a literal in backticks), a deleted exception too.
//   (3)  Integration (withAgentsServer + fakeClaude) WITH an instance row: `--mcp-config` of the turn and the MCP file of the subagent
//        lie under `data/projects/<id>/scratch/`, attachments, outputs and `--add-dir` there too; nothing of the chat lies flat;
//        after deleting, nothing of it is left in the runtime folder. WITHOUT a row: everything flat, and `data/projects` is not
//        created at all.
//   (4)  Project switch: while a background agent of the chat lives, the next turn already works at the new place, but the old files
//        stay where they are; after the agent ends the next turn moves them, and EXACTLY ONE turn carries the silent hint with old and
//        new path. The agent cleans up at ITS place — checked at NO place instead of only at the old path.
//   (4b) after a project switch (without a turn, and while the move is deferred) attachment GET, `/message` and channel (`attachment`
//        and `path`) find the files at the old place.
//   (4c) an old core that knows a finished agent defers the move; an agent continued from the inventory writes to its old path, and
//        when merging the younger version wins.
//   (4d) the job of an open approval card moves along; a decision before the move finds it at the old place.
//   (5)  EACCES fallback: a root-owned remainder in the runtime folder goes to `docker exec -u root cbase-p-<id> rm -rf <path>` (the
//        fake docker logs it, the remainder is gone); without an operation marker no docker call, the remainder stays. The remainder is
//        an ordinary file whose removal the seam `setRmSeam` refuses (`chmod` does not take effect as root), and the temp tree of the
//        test is gone afterwards.
//   (5b) WITH an instance row and in operation B deletes NOTHING in the runtime folder (the seam `rm` sees no path below it) — every
//        trace of the chat goes as `exec -u root cbase-p-<id> rm -rf <path>` to the project container that mounted the place; without
//        an operation marker no docker, B deletes every trace itself.
//   (5c) if the project container is stopped on delete, the fallback fails — the trace stays remembered (app setting
//        `runtime.traces_catch_up`) and falls in the container as soon as the main is `ready` again (server.js, state waker ->
//        catchUpLanes).
//   (6)  Move in small: merge (the target wins), defer, `afterRelocation`, `relocationHint`.
//   (6b) the younger file wins, on a tie the target; the readers with fallback.
//   (7)  the closing path removes the changed worktree of a subagent in the runtime folder (the branch stays).
//   (8)  a turn in the project container with a deferred move — the attachments are COPIED to the place of the run (also one the
//        message does not name), `/message` names the path there, ONE hint names copy and outputs; afterwards the move follows,
//        without duplicates.
//   (9)  the closing path also removes the changed worktree of a workflow agent (only in the journal) — branch stays.
//   (10) an engine turn with an image and a deferred move reads the image at the OLD place (attachmentPath at the call site).
//
// COUNTER-TESTS (each shown red, taken back):
//   chats/erase.js tidyUp at the old state (only the flat place)                              => (3) "with row" red: leftovers in
//                                                                                                 the runtime folder after deleting
//   runs/do-run.js `mcpFile(chat, runLocation)` replaced by the old `path.join(DIRS.scratch, …)` => (2) red (guard) and (3) "with row"
//                                                                                                 red at `--mcp-config`
//   runs/do-run.js `backgroundAlive: () => false`                                             => (4) red: the attachments moved while
//                                                                                                 the agent lived
//   runs/do-run.js the call `runtimeBringAlong(chat, runLocation)` deleted                    => (4) red: nothing moves along
//   runs/agents.js `cleanUpAgent(… place: runLocation)` without `place`                       => (4) red: the MCP file of the agent
//                                                                                                 stays at the old place
//   chats/erase.js without `rootFallback`                                                     => (5) red: no `exec -u root`
//   runs/runtime-location.js `locationFor` without the condition `converted`                  => (1) and (3) "without row" red
//   runs/runtime-location.js removeTrace without the branch "with an instance first to the fallback" => (5b) red (B deleted
//                                                                                                 attachments/<chat> and outputs/<chat>)
//   runs/runtime-location.js and server.js without the remembered traces (5c)                 => (5c) red
//   runs/routes.js without the `fetchAttachmentAtLocation` / old-place reading                => (4b) red, (8) "/message names the
//                                                                                                 attachment at the place of the run"
//   chats/routes.js, channels/messages.js (also only channelFileRoots without the old place)   => (4b) red
//   runs/do-run.js without `coresElsewhereWithAgents`                                         => (4) and (4c) red: the move ran despite
//                                                                                                 the old core
//   runs/runtime-location.js move without the mtime rule                                      => (4c) and (6b) red: the older version won
//   runs/runtime-location.js isConverted swallows every error                                 => (1c) red: no throw
//   dynworkflows/approval.js without the old place                                            => (4d) red: 410 "job"
//   runs/runtime-location.js chatTraces without the output place                              => (4d) red: "moved along"
//   chats/erase.js without worktree removal                                                   => (7) red: the worktree stays
//   runs/runtime-location.js removeTrace without the seam                                     => (5) red: the remainder went
//   rootRest again with `chmod 0555`                                                          => (5) red: the temp tree stayed
//   do-run.js runtimeBringAlong without the instance branch                                   => (8) ENOENT at two.txt
//   runs/runtime-location.js cleanUpWorktreesInRuntimeFolder removed                          => (9) "the worktree of the workflow agent
//                                                                                                 is gone"
//   do-run.js with the old line `path.join(attachmentLocation(chat, runLocation), a.file)`     => (10) "the engine got the image"
//   `createLocation` has its counter-test in projectbox-creation.test.js.
//
// No clock: the tests wait for files, states and the quiet of the server (waitForTruthy/waitForQuiet without a deadline).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { chatProfileDir } from "../electron/server/browser-profiles.js";
import { idleNow } from "../electron/server/runs/agents.js";
import { resolveChannelFiles } from "../electron/server/channels/messages.js";
import { createCard } from "../electron/server/dynworkflows/approval.js";
import {
  allLocations, attachmentFile, attachmentFolderToRead, attachmentPath, archiveFile, archiveIdFromName, outputFile, chatTraces, serviceLogFile,
  isArchiveId, mcpFile, afterRelocation, locationFor, locationForProject, playwrightConfigFile, setRmSeam, relocationHint, worktreeRoot,
  bringAlongChat,
} from "../electron/server/runs/runtime-location.js";
import { cleanUpOpenRoot } from "../electron/server/projectbox/cleanUp.js";
import { docker } from "../electron/server/projectbox/docker.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const ELECTRON = path.resolve(TESTDIR, "..", "electron");
const HOME_BASE = "server/runs/runtime-location.js";

// ── (1) Pure table ─────────────────────────────────────────────────────────────────────────────────────────────

function withDirs(fn) {
  const old = DIRS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-runtime-"));
  const data = path.join(root, "data");
  // Deliberately NOT the form of startServer: scratch lies elsewhere — the flat place must be built from DIRS.*, not from
  // `<data>/scratch` (otherwise it would be right only by chance).
  setDirs({ data, scratch: path.join(root, "elsewhere", "scr"), attachments: path.join(root, "anh"), outputs: path.join(root, "out") });
  try { return fn({ root, data }); } finally {
    setDirs(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("(1) without project, not converted and without row: every path as before; converted under data/projects/<id>/", () => {
  withDirs(({ data }) => {
    const flat = {
      scratch: DIRS.scratch, attachments: DIRS.attachments, outputs: DIRS.outputs,
      worktrees: path.join(DIRS.scratch, "worktrees"),
      playwrightConfigs: path.join(DIRS.data, "playwright-configs"),
      playwrightProfiles: path.join(DIRS.data, "playwright-profiles"),
      browserProfiles: path.join(DIRS.data, "browser-profiles"),
      serviceLogs: path.join(DIRS.data, "service-logs"),
      setup: null, // flat there is no place for archives (a ZIP source only in operation)
    };
    for (const input of [{}, { projectId: "p1" }, { projectId: "p1", converted: false }, { projectId: null, converted: true }]) {
      const o = locationFor(input);
      assert.equal(o.projectId, null, JSON.stringify(input));
      for (const [k, v] of Object.entries(flat)) assert.equal(o[k], v, `${JSON.stringify(input)} ${k}`);
    }
    const w = path.join(data, "projects", "p1");
    const p = locationFor({ projectId: "p1", converted: true });
    assert.equal(p.root, w);
    for (const k of ["scratch", "attachments", "outputs", "worktrees", "processes", "home", "setup"]) assert.equal(p[k], path.join(w, k));
    for (const k of ["playwright-configs", "playwright-profiles", "browser-profiles", "service-logs"]) {
      assert.equal(p[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())], path.join(w, k));
    }
    for (const malicious of ["..", "../x", "a/b", "", ".hidden"]) {
      assert.throws(() => locationFor({ projectId: malicious || "x/..", converted: true }), /invalid project id/, malicious);
    }
    // The old formulas of the sites that are switched — without a row byte-equal.
    assert.equal(mcpFile("c1", locationFor({})), path.join(DIRS.scratch, "c1.mcp.json"));
    assert.equal(mcpFile("c1", p), path.join(w, "scratch", "c1.mcp.json"));
    // Without an initialized store (no table) every project is flat — today's way.
    assert.equal(serviceLogFile("proj9", "svc"), path.join(DIRS.data, "service-logs", "proj9_svc.log"));
  });
});

test("(1) the Playwright configuration lies beside the root of its profile; profile names as in browser-profiles.js", () => {
  withDirs(({ data }) => {
    const flatProfile = path.join(data, "playwright-profiles", "chat-c1");
    // The old formula: `<data>/playwright-configs/<basename>-<h|s>.json` for every profile.
    assert.equal(playwrightConfigFile(flatProfile, true), path.join(DIRS.data, "playwright-configs", "chat-c1-h.json"));
    assert.equal(playwrightConfigFile(path.join(data, "playwright-profiles", "ws1"), false), path.join(DIRS.data, "playwright-configs", "ws1-s.json"));
    assert.equal(playwrightConfigFile("", true), path.join(DIRS.data, "playwright-configs", "default-h.json"));
    assert.equal(playwrightConfigFile("/anywhere/profile", true), path.join(DIRS.data, "playwright-configs", "profile-h.json"));
    const p = locationFor({ projectId: "p1", converted: true });
    assert.equal(playwrightConfigFile(path.join(p.playwrightProfiles, "chat-c1"), true), path.join(p.playwrightConfigs, "chat-c1-h.json"));
    // chatTraces recognizes the profiles by the same spelling as chatProfileDir (chat and subagent).
    fs.mkdirSync(chatProfileDir(p.playwrightProfiles, "c1"), { recursive: true });
    fs.mkdirSync(chatProfileDir(p.playwrightProfiles, "c1-agent-a7"), { recursive: true });
    fs.mkdirSync(chatProfileDir(p.playwrightProfiles, "c10"), { recursive: true }); // another chat with the same beginning
    const names = chatTraces(p, "c1").filter((s) => s.field === "playwrightProfiles").map((s) => s.name);
    assert.deepEqual(names, ["chat-c1", "chat-c1-agent-a7"]);
  });
});

// ── (2) Path guard ───────────────────────────────────────────────────────────────────────────────────────────────

const LITERALS = ["playwright-configs", "playwright-profiles", "service-logs", "worktrees", "browser-profiles", "copy-worktrees"];
const MARKERS = [
  ...["scratch", "attachments", "outputs"].map((f) => ({ name: `DIRS.${f}`, re: new RegExp(`\\bDIRS\\??\\.${f}\\b`, "g") })),
  ...LITERALS.map((l) => ({ name: `"${l}"`, re: new RegExp(`["'\`]${l}["'\`]`, "g") })),
  // The setup subfolder (a word that is everywhere else a lock reason, occupancy and table — therefore only as part of a path.join)
  // and the file name of the archives (`archive-${id}.zip`, a literal that continues with a marker or a quotation mark).
  { name: 'path.join(…, "setup")', re: /path\.join\([^)\n]*["'`]setup["'`]/g },
  { name: '"archive-…"', re: /["'`]archive-(?:\$\{|["'`])/g },
];

/**
 * The named exceptions (the login stock playwright-profiles/<wsId>/ and browser-profiles/ws-<wsId>/). Both stay FLAT, also for a
 * converted project — they belong to the workspace, not to a chat.
 */
const PATH_EXCEPTIONS = [
  {
    file: "server/toolchain/playwright.js", marker: '"playwright-profiles"', count: 1,
    reason: "loginStockRoot: the login stock `playwright-profiles/<wsId>/` stays flat, the backend copies into it and back as today.",
  },
  {
    file: "server/devtools/user-browser.js", marker: '"browser-profiles"', count: 1,
    reason: "the workspace browser profile `browser-profiles/ws-<wsId>/` (browser tab of the workspace level) stays flat — it belongs to no project.",
  },
  {
    file: "server/projectbox/relocation/plan.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of the data field in the message `data-missing` of the relocation plan.",
  },
  {
    file: "server/store/project-relocations.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of the journal section in `project_relocations` (worktrees from step 13).",
  },
  {
    file: "server/stacks/code-snapshot.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of a section in the read bundle of the code snapshot (`worktree list`).",
  },
  {
    file: "server/projectbox/setup/code-repos.js", marker: '"worktrees"', count: 1,
    reason: "no runtime path: the rule of the `.git` FILE — its gitdir must point to `.git/modules/…` or `.git/worktrees/…` of a repo in the project.",
  },
  {
    file: "server/projectbox/setup/provisioner.js", marker: '"worktrees"', count: 1,
    reason: "no runtime path: the same rule of the `.git` FILE in the Python program of the provisioner.",
  },
  {
    file: "server/projectbox/layout/read.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of the section in `unlesbar` of the check of a layout (`worktree list` could not be read).",
  },
  {
    file: "server/gitView/read.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of the field `worktrees` of the reading in the head comment (the worktrees from `worktree list --porcelain`).",
  },
  {
    file: "server/projectbox/layout/procedure.js", marker: '"worktrees"', count: 1,
    reason: "no path: the name of step 15 in the journal of the layout (`worktree repair` from the main repo).",
  },
];

function sourceFiles(root = ELECTRON) {
  const out = [];
  const run = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(root, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "utf8") });
    }
  };
  run(root);
  return out;
}

function pathHits(files) {
  const hits = new Map();
  for (const d of files) {
    if (d.path === HOME_BASE) continue;
    const rows = d.text.split("\n");
    for (const m of MARKERS) {
      rows.forEach((z, i) => {
        const n = (z.match(m.re) || []).length;
        if (!n) return;
        const k = `${d.path}#${m.name}`;
        const t = hits.get(k) || { file: d.path, marker: m.name, count: 0, rows: [] };
        t.count += n;
        t.rows.push(i + 1);
        hits.set(k, t);
      });
    }
  }
  return hits;
}

function pathViolations(hits, exceptions) {
  const v = [];
  const list = new Map(exceptions.map((e) => [`${e.file}#${e.marker}`, e]));
  for (const [k, t] of hits) {
    const e = list.get(k);
    if (!e) v.push(`NEW ${t.marker} in ${t.file} (line ${t.rows.join(", ")}) — the path belongs in ${HOME_BASE} or, with a reason, in PATH_EXCEPTIONS`);
    else if (e.count !== t.count) v.push(`${k}: ${t.count} instead of ${e.count} (line ${t.rows.join(", ")})`);
  }
  for (const [k] of list) if (!hits.has(k)) v.push(`entry without hit ${k} — moved? Then delete the entry`);
  return v;
}

test("(2) path guard: the runtime paths arise only in runs/runtime-location.js — except for the named list", () => {
  const files = sourceFiles();
  const homeBase = files.find((d) => d.path === HOME_BASE);
  assert.ok(homeBase, `${HOME_BASE} is missing — the guard looks in the wrong place`);
  // Every marker stands in its home: otherwise the guard would check a spelling that does not exist at all.
  for (const m of MARKERS) assert.ok((homeBase.text.match(m.re) || []).length > 0, `${m.name} is missing in ${HOME_BASE}`);
  for (const e of PATH_EXCEPTIONS) console.log(`[runtime-location] exception ${e.file} ${e.marker} (${e.count}x): ${e.reason}`);
  const hits = pathHits(files);
  console.log(`[runtime-location] measured: ${[...hits.values()].reduce((n, t) => n + t.count, 0)} hits outside ${HOME_BASE} across ${files.length} files`);
  assert.deepEqual(pathViolations(hits, PATH_EXCEPTIONS), []);
});

test("(2) path guard, built-in sabotage: a fresh path in do-run.js is red, a deleted exception too", () => {
  const real = sourceFiles();
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const one = (files) => pathViolations(pathHits(files), PATH_EXCEPTIONS);
  const doRun = real.find((d) => d.path === "server/runs/do-run.js").text;
  for (const addition of [
    "const x = path.join(DIRS.scratch, `${chat.id}.mcp.json`);",
    "const x = DIRS?.scratch;",
    "const y = path.join(DIRS.attachments, chat.id);",
    "const z = path.join(DIRS.data, `worktrees`);",
    "const q = path.join(DIRS.data, 'service-logs');",
    "const k = path.join(ort.root, `copy-worktrees`, name);", // the root of the worktrees of a copy
    "const e = path.join(ort.root, \"setup\", `a.zip`);", // the subfolder of the archives
    "const a = path.join(ort.setup, `archive-${id}.zip`);", // the file name of an archive
  ]) {
    const v = one(including("server/runs/do-run.js", `${doRun}\n${addition}\n`));
    assert.equal(v.length, 1, `not recognized: ${addition}\n${v.join("\n")}`);
    assert.match(v[0], /^NEW .* in server\/runs\/do-run\.js/);
  }
  const ws = real.find((d) => d.path === "server/devtools/user-browser.js").text;
  const without = ws.replace(/"browser-profiles"/, '"browser-profile"');
  assert.notEqual(without, ws, "the sabotage replaced nothing");
  assert.deepEqual(one(including("server/devtools/user-browser.js", without)), ['entry without hit server/devtools/user-browser.js#"browser-profiles" — moved? Then delete the entry']);
  const duplicate = one(including("server/toolchain/playwright.js", `${real.find((d) => d.path === "server/toolchain/playwright.js").text}\nconst k = "playwright-profiles";\n`));
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0], /: 2 instead of 1/);
});

test("(1c) without the table the flat place — every OTHER read error throws (\"unknown\" is not \"not converted\")", () => {
  withDirs(({ root }) => {
    // Before initStore: flat (test (1) above reads serviceLogFile without a store). Now a store in this process.
    const dir = path.join(root, "db");
    fs.mkdirSync(dir);
    store.initStore(dir);
    store.createProjectInstance({ projectId: "p1", state: "ready", convertedAt: Date.now() });
    assert.equal(locationForProject("p1").projectId, "p1");
    // A read error that is not a missing table (like a SQLITE_BUSY after the busy_timeout): a view in place of the table that
    // overflows when read.
    db.exec("ALTER TABLE project_instances RENAME TO pi_aside");
    db.exec("CREATE VIEW project_instances AS SELECT 'p1' AS project_id, 'main' AS instance, abs(-9223372036854775807 - 1) AS converted_at");
    assert.throws(() => locationForProject("p1"), /integer overflow/, "a read error does not silently become the flat place");
    // Without the table: today's way.
    db.exec("DROP VIEW project_instances");
    assert.equal(locationForProject("p1").projectId, null, "flat without the table");
    db.exec("ALTER TABLE pi_aside RENAME TO project_instances");
    assert.equal(locationForProject("p1").projectId, "p1");
  });
});

test("(1d) the instance in the name of the service logs — without an argument `main` as before, with one its name, flat without effect", () => {
  withDirs(({ root }) => {
    const dir = path.join(root, "db");
    fs.mkdirSync(dir);
    store.initStore(dir);
    store.createProjectInstance({ projectId: "p1", state: "ready", convertedAt: Date.now() });
    // Held against the OLD formula `<runtime folder>/service-logs/main_<svc>.log`, not against the new function; a name that would
    // lead out throws; p2 (without a row) lies flat, the argument has no effect there.
    const logs = path.join(root, "data", "projects", "p1", "service-logs");
    for (const without of [undefined, "", null, "main"]) assert.equal(serviceLogFile("p1", 7, without), path.join(logs, "main_7.log"), String(without));
    assert.equal(serviceLogFile("p1", "svc"), path.join(logs, "main_svc.log"));
    assert.equal(serviceLogFile("p1", 7, "copy-a"), path.join(logs, "copy-a_7.log"));
    for (const malicious of ["../x", "a/b", "..", ".hidden", "-x"]) assert.throws(() => serviceLogFile("p1", 7, malicious), /invalid instance/, malicious);
    assert.equal(serviceLogFile("p2", 7, "copy-a"), path.join(DIRS.data, "service-logs", "p2_7.log"), "flat without an instance");
  });
});

test("(1f) the archive of a ZIP source — `<runtime>/setup/archive-<uuid>.zip`; flat and a foreign id throw", () => {
  withDirs(({ data }) => {
    const p = locationFor({ projectId: "p1", converted: true });
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    assert.equal(archiveFile(p, id), path.join(data, "projects", "p1", "setup", `archive-${id}.zip`));
    assert.equal(archiveIdFromName(`archive-${id}.zip`), id);
    assert.ok(isArchiveId(id));
    for (const foreign of ["", "../x", `${id}/../y`, id.toUpperCase(), `${id}x`, "archive", null, 7]) {
      assert.equal(isArchiveId(foreign), false, String(foreign));
      assert.throws(() => archiveFile(p, foreign), /invalid archive id/, String(foreign));
    }
    assert.throws(() => archiveFile(locationFor({}), id), /only in the runtime folder/);
    for (const name of [`archive-${id}.zip.part`, `x-${id}.zip`, `archive-${id}`, "archive-.zip", ".DS_Store"]) assert.equal(archiveIdFromName(name), null, name);
  });
});

test("(1e) the worktree root of a copy — `<runtime>/copy-worktrees/<name>`; main as before; flat and wrong names throw", () => {
  withDirs(({ data }) => {
    const w = path.join(data, "projects", "p1");
    const p = locationFor({ projectId: "p1", converted: true });
    assert.equal(p.copyWorktrees, path.join(w, "copy-worktrees"));
    // The main: every spelling of the no-argument yields the old root, byte-equal.
    for (const without of [undefined, null, "", "main"]) assert.equal(worktreeRoot(p, without), path.join(w, "worktrees"), String(without));
    assert.equal(worktreeRoot(p), p.worktrees);
    assert.equal(worktreeRoot(locationFor({})), path.join(DIRS.scratch, "worktrees"), "flat: as before");
    // The copy: an own place NEXT TO `worktrees/` (never below it: the git assignment attributes `worktrees/` to the main).
    assert.equal(worktreeRoot(p, "copy-k1"), path.join(w, "copy-worktrees", "k1"));
    assert.equal(worktreeRoot(p, "copy-a-b2"), path.join(w, "copy-worktrees", "a-b2"));
    assert.ok(!liesUnder(worktreeRoot(p, "copy-k1"), p.worktrees), "not under worktrees/");
    // The form of the name is that of the instance (projectbox/creation.js): the same names pass, the same throw.
    const names = ["k1", "a", "a-b", "x".repeat(24), "x".repeat(25), "-a", "a-", "A", "a_b", "a.b", "a/b", "..", "", "main", "k 1"];
    for (const n of names) {
      let valid = true;
      try { copyInstance(n); } catch { valid = false; }
      if (valid) assert.equal(worktreeRoot(p, `copy-${n}`), path.join(w, "copy-worktrees", n), n);
      else assert.throws(() => worktreeRoot(p, `copy-${n}`), /instance/, `„${n}“`);
    }
    for (const malicious of ["copy", "copy-", "k1", "main/../x", "copy-../x"]) assert.throws(() => worktreeRoot(p, malicious), /instance/, malicious);
    // Flat there is no copy: a throw instead of a path next to the main.
    assert.throws(() => worktreeRoot(locationFor({}), "copy-k1"), /flat location|runtime folder/);
    // The closing path does not know the place — chatTraces never names anything under copy-worktrees/.
    fs.mkdirSync(path.join(w, "copy-worktrees", "k1", "agent-c1"), { recursive: true });
    assert.deepEqual(chatTraces(p, "c1"), []);
  });
});

// ── (3)/(4) Integration ───────────────────────────────────────────────────────────────────────────────────────────

// The main agent stores `--mcp-config`, `--add-dir` and its input text per turn; "AG:{json}" calls cbase_agent, "SEND:{json}"
// cbase_agent_send (a finished agent is continued; result under send-<turn>). SEND first — "{TAG:" contains "AG:". `turn` counts per
// CLI process, and every turn of the chat is its own: read right afterwards.
const MAIN = `
  const addDirs = argv.filter((a, i) => argv[i - 1] === "--add-dir");
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, cfg: cfgPath, addDirs, text }) + "\\n");
  const s = text.indexOf("SEND:");
  const i = s >= 0 ? -1 : text.indexOf("AG:");
  if (s >= 0 || i >= 0) {
    const tool = s >= 0 ? "cbase_agent_send" : "cbase_agent";
    const args = JSON.parse(text.slice(s >= 0 ? s + 5 : i + 3));
    const id = "toolu_ag_" + turn;
    say({ type: "assistant", message: { id: "a-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__" + tool, input: args }] } });
    let t = "";
    try { const r = await mcpCall(tool, args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, (s >= 0 ? "send-" : "ag-") + turn), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + turn + "-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;
// A subagent: {TAG:x} names it, {GATE:x} holds it at the gate; it stores its MCP configuration and its working folder;
// {AENDERN} writes a file into it (a changed worktree stays at its end).
const SUB = `
    const tag = text.includes("{TAG:") ? text.split("{TAG:").pop().split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "sub-" + tag), JSON.stringify({ cfg: cfgPath, cwd: process.cwd() }));
    if (text.includes("{AENDERN}")) fs.writeFileSync(path.join(process.cwd(), "changed.txt"), "from the agent");
    if (text.includes("{GATE:")) await gate(text.split("{GATE:").pop().split("}")[0]);
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const CLAUDE = fakeClaude({ main: MAIN, sub: SUB });

const turns = (root) => readJsonl(path.join(root, "main.jsonl"));
async function send(ctx, text, attachments = undefined) {
  const prior = turns(ctx.root).length;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text, ...(attachments ? { attachments } : {}) }) });
  await waitForTruthy(() => turns(ctx.root).length > prior, `turn after "${text.slice(0, 40)}"`);
  await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn finished");
  return turns(ctx.root)[prior];
}
async function upload(ctx, name, content) {
  const res = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/attachments?name=${encodeURIComponent(name)}&artifact=0`, { method: "POST", body: content, headers: { Connection: "close" } });
  assert.equal(res.status, 201);
  return (await res.json()).file;
}
async function project(ctx, name, { converted = true } = {}) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  fs.mkdirSync(filePath, { recursive: true });
  if (converted) store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
  return p;
}
const inChat = (ctx, projectId) => json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId }) });
// Everything under a folder whose path carries the chat id — independent of the product's list (chatTraces).
function lanesOf(dir, chatId) {
  const out = [];
  const run = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const abs = path.join(d, n.name);
      if (n.name.includes(chatId)) out.push(abs);
      else if (n.isDirectory()) run(abs);
    }
  };
  run(dir);
  return out;
}
const flat = () => locationFor({});
const liesUnder = (p, dir) => { const r = path.relative(dir, p); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };

test("(3) with an instance row: every file of the chat under data/projects/<id>/, nothing flat — and after deleting nothing of it there", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot } = ctx;
    const p = await project(ctx, "Till");
    await inChat(ctx, p.id);
    const w = path.join(dataRoot, "data", "projects", p.id);
    const file = await upload(ctx, "note.txt", "hello");
    assert.ok(fs.existsSync(path.join(w, "attachments", chat.id, file)), "the attachment lies in the runtime folder");

    const t = await send(ctx, `AG:${JSON.stringify({ description: "Check", prompt: "Read {TAG:a}", run_in_background: false })}`);
    assert.equal(t.cfg, path.join(w, "scratch", `${chat.id}.mcp.json`), "--mcp-config des Turns");
    assert.ok(t.addDirs.includes(path.join(w, "attachments", chat.id)), `attachments in --add-dir: ${t.addDirs}`);
    assert.ok(t.addDirs.includes(path.join(w, "outputs", chat.id)), `output place in --add-dir: ${t.addDirs}`);
    const ag = fs.readFileSync(path.join(ctx.root, "ag-1"), "utf8");
    assert.ok(!ag.startsWith("ERROR"), ag);
    const sub = JSON.parse(fs.readFileSync(path.join(ctx.root, "sub-a"), "utf8"));
    assert.match(sub.cfg, new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scratch/${chat.id}\\.agent-[^/]+\\.mcp\\.json$`), "MCP file of the subagent");
    await ctx.waitForQuiet();
    assert.ok(!fs.existsSync(sub.cfg), "the MCP file of the subagent is gone at its end");
    assert.ok(fs.readdirSync(path.join(w, "outputs", chat.id, "agents")).some((n) => n.endsWith(".output")), "the output file lies in the runtime folder");
    // Nothing of the chat lies flat.
    for (const dir of [flat().scratch, flat().attachments, flat().outputs, flat().playwrightProfiles, flat().playwrightConfigs]) {
      assert.deepEqual(lanesOf(dir, chat.id), [], `flat under ${dir}`);
    }
    assert.ok(lanesOf(w, chat.id).length >= 3, "scratch, attachments and outputs lie in the runtime folder");

    const res = await fetch(`${ctx.base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(res.status, 200);
    assert.deepEqual(lanesOf(w, chat.id), [], "after deleting nothing of the chat is left in the runtime folder");
    for (const o of allLocations()) assert.deepEqual(chatTraces(o, chat.id), [], o.root);
  }, { claude: CLAUDE });
});

test("(3) without an instance row: everything flat as before, and data/projects is not created at all", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot } = ctx;
    const p = await project(ctx, "Old", { converted: false });
    await inChat(ctx, p.id);
    const file = await upload(ctx, "note.txt", "hello");
    assert.ok(fs.existsSync(path.join(DIRS.attachments, chat.id, file)));
    const t = await send(ctx, `AG:${JSON.stringify({ description: "Check", prompt: "Read {TAG:b}", run_in_background: false })}`);
    const ag = fs.readFileSync(path.join(ctx.root, "ag-1"), "utf8");
    assert.ok(!ag.startsWith("ERROR"), ag);
    assert.equal(t.cfg, path.join(DIRS.scratch, `${chat.id}.mcp.json`), "--mcp-config as before");
    assert.equal(path.join(DIRS.scratch, `${chat.id}.mcp.json`), path.join(dataRoot, "data", "scratch", `${chat.id}.mcp.json`));
    const sub = JSON.parse(fs.readFileSync(path.join(ctx.root, "sub-b"), "utf8"));
    assert.equal(path.dirname(sub.cfg), DIRS.scratch, "MCP file of the subagent flat");
    assert.ok(t.addDirs.includes(path.join(DIRS.outputs, chat.id)));
    await ctx.waitForQuiet();
    assert.ok(!fs.existsSync(path.join(dataRoot, "data", "projects")), "without a row no runtime folder");
  }, { claude: CLAUDE });
});

test("(4) project switch: with a living background agent everything stays at the old place; afterwards a turn moves it, and exactly one carries the hint", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot } = ctx;
    const a = await project(ctx, "Start");
    const b = await project(ctx, "Target");
    await inChat(ctx, a.id);
    const wa = path.join(dataRoot, "data", "projects", a.id);
    const wb = path.join(dataRoot, "data", "projects", b.id);
    const file = await upload(ctx, "plan.txt", "A");
    const t1 = await send(ctx, `AG:${JSON.stringify({ description: "On the side", prompt: "Job {TAG:h} {GATE:h}", run_in_background: true })}`);
    assert.ok(liesUnder(t1.cfg, wa));
    await ctx.gate.reached("h");
    const sub = JSON.parse(fs.readFileSync(path.join(ctx.root, "sub-h"), "utf8"));
    assert.ok(liesUnder(sub.cfg, wa), `the agent started at the old place: ${sub.cfg}`);

    // Switch while the agent lives: the next turn already runs at the new place, the files stay at the old one.
    await inChat(ctx, b.id);
    const t2 = await send(ctx, "continue in the new project");
    assert.equal(t2.cfg, path.join(wb, "scratch", `${chat.id}.mcp.json`), "the new turn works in the new runtime folder");
    assert.ok(fs.existsSync(path.join(wa, "attachments", chat.id, file)), "while the agent lives the attachments stay at the old place");
    assert.ok(!fs.existsSync(path.join(wb, "attachments", chat.id)), "and do not arrive at the new one");
    assert.ok(!t2.text.includes("cbase-hint"), "without a move no hint");
    assert.ok(fs.existsSync(sub.cfg), "the MCP file of the living agent stays where it read it");

    ctx.gate.open("h");
    await ctx.waitForQuiet();
    // At NO place: only `!existsSync(sub.cfg)` stayed green if the agent cleaned up at the wrong place — the turn of the completion
    // notice had moved its file to the new place beforehand.
    for (const o of allLocations()) {
      assert.ok(!fs.existsSync(path.join(o.scratch, path.basename(sub.cfg))), `the agent cleans up at ITS place — remainder under ${o.root}`);
    }
    // The core of the agent still knows it (finished) and stands at the old place: it counts when deferring until it closes — the
    // turn of the completion notice therefore moved nothing yet. The idle seam closes it now.
    assert.ok(fs.existsSync(path.join(wa, "attachments", chat.id, file)), "while its core knows it everything stays at the old place");
    assert.ok(idleNow() >= 1, "the idle core at the old place is closed");
    await send(ctx, "afterwards");
    await ctx.waitForQuiet();
    assert.deepEqual(chatTraces(locationFor({ projectId: a.id, converted: true }), chat.id), [], "at the old place nothing of the chat is left");
    // The MCP file of the agent is nowhere any more — not even as a remainder a move took along (the agent cleaned up at the WRONG
    // place, and the next turn carried its file to the new one).
    for (const o of allLocations()) {
      assert.deepEqual(chatTraces(o, chat.id).filter((x) => x.name.startsWith(`${chat.id}.agent-`)), [], `MCP file of an agent under ${o.root}`);
    }
    assert.equal(fs.readFileSync(path.join(wb, "attachments", chat.id, file), "utf8"), "A", "the attachment has moved");
    assert.ok(fs.readdirSync(path.join(wb, "outputs", chat.id, "agents")).some((n) => n.endsWith(".output")), "the output of the agent too");
    const withHint = turns(ctx.root).filter((t) => t.text.includes("cbase-hint") && t.text.includes("switched projects"));
    assert.equal(withHint.length, 1, `exactly one turn carries the hint: ${withHint.length}`);
    assert.ok(withHint[0].text.includes(`${path.join(wa, "attachments", chat.id)} → ${path.join(wb, "attachments", chat.id)}`), withHint[0].text);
    assert.ok(withHint[0].text.includes(`${path.join(wa, "outputs", chat.id)} → ${path.join(wb, "outputs", chat.id)}`), withHint[0].text);
  }, { claude: CLAUDE });
});

const fetchAttachment = (ctx, file) => fetch(`${ctx.base}/api/chats/${ctx.chat.id}/attachments/${encodeURIComponent(file)}`, { headers: { Connection: "close" } });
const agentIdFrom = (root, turn) => {
  const t = fs.readFileSync(path.join(root, `ag-${turn}`), "utf8");
  assert.ok(!t.startsWith("ERROR"), t);
  return JSON.parse(t).agentId;
};

test("(4b) after a project switch the readers read the files at the OLD place — without a turn and while the move is deferred", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot } = ctx;
    const a = await project(ctx, "Source");
    const b = await project(ctx, "Sink");
    const wa = path.join(dataRoot, "data", "projects", a.id);
    const wb = path.join(dataRoot, "data", "projects", b.id);
    await inChat(ctx, a.id);
    const one = await upload(ctx, "one.txt", "ONE");

    // Upload in A, switch to B WITHOUT a turn — the attachment lies in A until the next turn.
    await inChat(ctx, b.id);
    assert.ok(fs.existsSync(path.join(wa, "attachments", chat.id, one)) && !fs.existsSync(path.join(wb, "attachments", chat.id)));
    const get1 = await fetchAttachment(ctx, one);
    assert.equal(get1.status, 200, "the attachment GET finds it at the old place");
    assert.equal(await get1.text(), "ONE");
    const t1 = await send(ctx, "with attachment", [{ file: one, name: "one.txt" }]);
    const message = store.listMessages(chat.id).filter((m) => m.role === "user").pop();
    assert.deepEqual((message.attachments || []).map((x) => x.file), [one], "the attachment is in the message");
    assert.ok(t1.text.includes(`- ${path.join(wa, "attachments", chat.id, one)}`), `the prompt names the attachment: ${t1.text}`);
    assert.ok(t1.text.includes(`${path.join(wa, "attachments", chat.id)} → ${path.join(wb, "attachments", chat.id)}`), "and the turn moved and says so");
    assert.equal(fs.readFileSync(path.join(wb, "attachments", chat.id, one), "utf8"), "ONE");

    // A background agent lives in B, the chat switches back to A — the move stays deferred.
    const t2 = await send(ctx, `AG:${JSON.stringify({ description: "On the side", prompt: "Job {TAG:g} {GATE:g}", run_in_background: true })}`);
    assert.ok(liesUnder(t2.cfg, wb));
    await ctx.gate.reached("g");
    await inChat(ctx, a.id);
    const t3 = await send(ctx, "continue in A", [{ file: one, name: "one.txt" }]);
    const oldB = path.join(wb, "attachments", chat.id);
    assert.ok(fs.existsSync(path.join(oldB, one)) && !fs.existsSync(path.join(wa, "attachments", chat.id, one)), "deferred: the attachment lies in B");
    assert.ok(t3.text.includes(`- ${path.join(oldB, one)}`), `/message found it at the old place: ${t3.text}`);
    assert.ok(t3.addDirs.includes(oldB) && t3.addDirs.includes(path.join(wb, "outputs", chat.id)), `--add-dir carries the old place: ${t3.addDirs}`);
    const get2 = await fetchAttachment(ctx, one);
    assert.equal(get2.status, 200, "the attachment GET finds it at the old place while the move is deferred");
    await get2.text();
    const now = store.getChat(chat.id);
    // Channel: the own attachment by its name, and a path in the own attachments at the old place.
    const [perName] = resolveChannelFiles(now, [{ attachment: "one.txt" }]);
    assert.equal(perName.src, path.join(oldB, one), "channel attachment at the old place");
    const [perPath] = resolveChannelFiles(now, [{ path: path.join(oldB, one) }]);
    assert.equal(perPath.src, path.join(oldB, one), "a path in the own attachments at the old place is in reach");
    assert.deepEqual(attachmentFolderToRead(now), [path.join(wa, "attachments", chat.id), oldB], "first the current place, then the old one");

    // End of the agent, its core closes: the next turn moves the files, and the readers see the current place.
    ctx.gate.open("g");
    await ctx.waitForQuiet();
    assert.ok(idleNow() >= 1);
    await send(ctx, "afterwards");
    await ctx.waitForQuiet();
    assert.equal(fs.readFileSync(path.join(wa, "attachments", chat.id, one), "utf8"), "ONE");
    assert.deepEqual(chatTraces(locationFor({ projectId: b.id, converted: true }), chat.id), [], "in B nothing of the chat is left");
    assert.deepEqual(attachmentFolderToRead(store.getChat(chat.id)), [path.join(wa, "attachments", chat.id)]);
    const get3 = await fetchAttachment(ctx, one);
    assert.equal(get3.status, 200);
    await get3.text();
  }, { claude: CLAUDE });
});

test("(4c) an old core that knows a finished agent defers the move — and a continuation from the inventory loses nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot, root } = ctx;
    const a = await project(ctx, "First");
    const b = await project(ctx, "Then");
    const wa = path.join(dataRoot, "data", "projects", a.id);
    const wb = path.join(dataRoot, "data", "projects", b.id);
    await inChat(ctx, a.id);
    await send(ctx, `AG:${JSON.stringify({ description: "Check", prompt: "Read {TAG:one}", run_in_background: false })}`);
    const x = agentIdFrom(root, 1);
    const output = (w) => path.join(w, "outputs", chat.id, "agents", `${x}.output`);
    await ctx.waitForQuiet();
    assert.match(fs.readFileSync(output(wa), "utf8"), /Finding one/);

    // Switch to B; the main agent continues X. X lives on in ITS core (place A) and writes there.
    await inChat(ctx, b.id);
    const prior = turns(root).length;
    await send(ctx, `SEND:${JSON.stringify({ agentId: x, message: "Continue {TAG:two}" })}`);
    assert.match(fs.readFileSync(path.join(root, "send-1"), "utf8"), /^(?!ERROR)/, "the continuation was accepted");
    await waitForTruthy(() => turns(root).some((t, i) => i > prior && t.text.includes("<task-notification>")), "turn of the completion notice");
    await ctx.waitForQuiet();
    assert.match(fs.readFileSync(output(wa), "utf8"), /Finding two/, "the continuation wrote to the old place, and it is still there");
    assert.ok(!fs.existsSync(output(wb)), "no turn moved while the old core knows X");

    // The old core closes (idle) — the next turn moves the files, with the newest version.
    assert.ok(idleNow() >= 1);
    await send(ctx, "afterwards");
    await ctx.waitForQuiet();
    assert.match(fs.readFileSync(output(wb), "utf8"), /Finding two/, "the continued version has moved");
    assert.deepEqual(chatTraces(locationFor({ projectId: a.id, converted: true }), chat.id), []);

    // The rest: X continued from the INVENTORY (its core is gone) writes to its stored, old path in A — the next move finds the younger
    // version there and the older one in B. The younger wins (move, mtime).
    const n = turns(root).length;
    fs.rmSync(path.join(root, "send-1"));
    await send(ctx, `SEND:${JSON.stringify({ agentId: x, message: "Once more {TAG:three}" })}`);
    assert.match(fs.readFileSync(path.join(root, "send-1"), "utf8"), /^(?!ERROR)/, "the continuation from the inventory was accepted");
    await waitForTruthy(() => turns(root).some((t, i) => i > n && t.text.includes("<task-notification>")), "turn of the second completion notice");
    await ctx.waitForQuiet();
    await send(ctx, "last");
    await ctx.waitForQuiet();
    assert.match(fs.readFileSync(output(wb), "utf8"), /Finding three/, "the younger version wins when merging");
    assert.deepEqual(chatTraces(locationFor({ projectId: a.id, converted: true }), chat.id), []);
  }, { claude: CLAUDE });
});

test("(4d) the job of an open approval card moves along — and a decision before the move finds it at the old place", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, dataRoot, base, root } = ctx;
    const a = await project(ctx, "Card-A");
    const b = await project(ctx, "Card-B");
    const wa = path.join(dataRoot, "data", "projects", a.id);
    const wb = path.join(dataRoot, "data", "projects", b.id);
    await inChat(ctx, a.id);
    const script = "export const meta = { name: 'card', description: 'Probe', phases: [{ title: 'Read' }] }\nreturn 'done';\n";
    const card = () => createCard(chat.id, { script, meta: { name: "card", description: "Probe", phases: [{ title: "Read" }] }, callId: "", request: null }).requestId;
    const k1 = card();
    const k2 = card();
    const job = (w, k) => path.join(w, "outputs", chat.id, "workflows", "approvals", `${k}.json`);
    for (const k of [k1, k2]) assert.ok(fs.existsSync(job(wa, k)), "the job lies in the output place in A");
    await inChat(ctx, b.id);
    const decide = async (k) => {
      const r = await fetch(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, {
        method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ requestId: k, decision: "accept" }),
      });
      return { status: r.status, body: await r.json() };
    };
    const noticesFrom = (mark) => turns(root).filter((t, i) => i >= mark && t.text.includes("<task-notification>")).length;

    // Before the next turn: the job still lies in A — the decision finds it there.
    const prior = turns(root).length;
    const e1 = await decide(k1);
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    assert.ok(e1.body.runId, "the workflow runs");
    assert.ok(!fs.existsSync(job(wa, k1)), "the job is gone after the decision — at the place where it lay");
    // The workflow ends, its completion notice wakes a turn in B — which moves the files of the chat.
    await waitForTruthy(() => noticesFrom(prior) >= 1, "turn of the completion notice");
    await ctx.waitForQuiet();
    assert.ok(fs.existsSync(job(wb, k2)) && !fs.existsSync(job(wa, k2)), "the job of the open card has moved along");
    const e2 = await decide(k2);
    assert.equal(e2.status, 200, JSON.stringify(e2.body));
    assert.ok(!fs.existsSync(job(wb, k2)));
    await waitForTruthy(() => noticesFrom(prior) >= 2, "second completion notice");
    await ctx.waitForQuiet();
  }, { claude: CLAUDE });
});

// ── (5) EACCES fallback ───────────────────────────────────────────────────────────────────────────────────────────

const OPS = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(OPS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// A root-owned remainder: an ordinary file whose removal the seam `rm` (runs/runtime-location.js setRmSeam) refuses with EACCES —
// like `fs.rmSync` on a root-owned remainder in the project container. A `chmod 0555` does not take effect as root (the remainder
// went and the fallback never came up), and a folder without write permission would leave the temp tree of the test behind.
function rootRest(w, chatId) {
  const agents = path.join(w, "outputs", chatId, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "a1.output"), "from root");
  return path.join(w, "outputs", chatId);
}
const eaccesFor = (locked) => (p, o) => {
  if (locked.has(p)) throw Object.assign(new Error(`EACCES: permission denied, rm '${p}'`), { code: "EACCES" });
  return fs.rmSync(p, o);
};

test("(5) EACCES in the runtime folder: docker exec -u root <container> rm -rf <path>; without an operation marker no docker call, the remainder stays", async () => {
  const fake = await fakeDocker({ programs: { rm: path.join(TESTDIR, "fixtures", "runtime-location", "rm-as-root.sh") } });
  const locked = new Set();
  const prior = setRmSeam(eaccesFor(locked));
  let root = "";
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, dataRoot } = ctx;
      root = ctx.root;
      const pid = "project-root";
      const w = path.join(dataRoot, "data", "projects", pid);
      const newChat = async () => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });

      // Without operation (the local server): no docker, the remainder stays.
      const c1 = await newChat();
      locked.add(rootRest(w, c1.id));
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined, ...fake.env }, async () => {
        const r = await fetch(`${base}/api/chats/${c1.id}`, { method: "DELETE", headers: { Connection: "close" } });
        assert.equal(r.status, 200);
        await cleanUpOpenRoot();
      });
      assert.deepEqual(fake.calls(), [], "without an operation marker no docker starts");
      assert.ok(fs.existsSync(path.join(w, "outputs", c1.id, "agents", "a1.output")), "the root-owned remainder stays (and stands as a message)");

      // In operation: the project container cleans up as root.
      const c2 = await newChat();
      const target = rootRest(w, c2.id);
      locked.add(target);
      await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", ...fake.env }, async () => {
        await docker(["run", "-d", "--name", `cbase-p-${pid}`, "cbase-projectbox"]);
        const r = await fetch(`${base}/api/chats/${c2.id}`, { method: "DELETE", headers: { Connection: "close" } });
        assert.equal(r.status, 200);
        await cleanUpOpenRoot();
      });
      const exec = fake.calls().filter((a) => a.args[0] === "exec");
      assert.deepEqual(exec.map((a) => a.args), [["exec", "-u", "root", `cbase-p-${pid}`, "rm", "-rf", target]]);
      assert.ok(!fs.existsSync(target), "the remainder is gone");
      assert.deepEqual(chatTraces(locationFor({ projectId: pid, converted: true }), c2.id), []);
    }, { claude: CLAUDE });
  } finally {
    setRmSeam(prior);
    fake.cleanUp();
  }
  // The temp tree of the test is gone — also with the remainder of the first chat left lying.
  assert.ok(root && !fs.existsSync(root), `the temp tree ${root} stayed behind`);
});

// With an instance row the running project container mounts the runtime folder — B deletes nothing recursively there (fs.rmSync
// followed a link the container sets between two steps), EVERY trace goes as `exec -u root … rm -rf` to it. Without an operation
// marker no docker, B as before.
test("(5b) with an instance row and in operation the project container deletes every trace of the chat — B does not; without an operation marker B as before", async () => {
  const fake = await fakeDocker();
  const inB = [];
  const prior = setRmSeam((p, o) => { inB.push(p); return fs.rmSync(p, o); });
  try {
    await withAgentsServer(async (ctx) => {
      const p = await project(ctx, "Till");
      const w = locationFor({ projectId: p.id, converted: true }).root;
      const lanes = async () => {
        const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
        await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        const res = await fetch(`${ctx.base}/api/chats/${c.id}/attachments?name=note.txt&artifact=0`, { method: "POST", body: "hello", headers: { Connection: "close" } });
        assert.equal(res.status, 201);
        fs.mkdirSync(path.join(w, "outputs", c.id, "agents"), { recursive: true });
        fs.writeFileSync(path.join(w, "outputs", c.id, "agents", "a1.output"), "x");
        const list = chatTraces(locationFor({ projectId: p.id, converted: true }), c.id).map((s) => s.path);
        assert.ok(list.length >= 2, `traces in the runtime folder: ${list}`);
        return { c, list };
      };
      const erase = async (c) => {
        const r = await fetch(`${ctx.base}/api/chats/${c.id}`, { method: "DELETE", headers: { Connection: "close" } });
        assert.equal(r.status, 200);
        await cleanUpOpenRoot();
      };
      const inLocation = () => inB.filter((x) => liesUnder(x, w) || x === w);

      // In operation: the container cleans up, B deletes nothing in the place.
      const one = await lanes();
      await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", ...fake.env }, async () => {
        await docker(["run", "-d", "--name", `cbase-p-${p.id}`, "cbase-projectbox"]);
        await erase(one.c);
      });
      assert.deepEqual(inLocation(), [], "B deleted in the runtime folder while the project container ran");
      // The calls run side by side — their order in the log is that of their end, not of their start.
      const exec = fake.calls().filter((a) => a.args[0] === "exec").map((a) => a.args).sort((a, b) => a.at(-1).localeCompare(b.at(-1)));
      assert.deepEqual(exec, [...one.list].sort().map((filePath) => ["exec", "-u", "root", `cbase-p-${p.id}`, "rm", "-rf", filePath]));
      assert.deepEqual(chatTraces(locationFor({ projectId: p.id, converted: true }), one.c.id), [], "the traces are gone");

      // Without an operation marker: no docker, B deletes as before.
      const n = fake.calls().length;
      const two = await lanes();
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined, ...fake.env }, () => erase(two.c));
      assert.deepEqual(fake.calls().slice(n), [], "without an operation marker no docker starts");
      assert.deepEqual([...inLocation()].sort(), [...two.list].sort(), "without operation B deletes every trace itself");
      assert.deepEqual(chatTraces(locationFor({ projectId: p.id, converted: true }), two.c.id), []);
    }, { claude: CLAUDE });
  } finally {
    setRmSeam(prior);
    fake.cleanUp();
  }
});

// If the project container is stopped, the fallback fails (`exec` on a stopped container) — the promise was discarded, and the trace
// stayed forever. Now it stays remembered and falls in the container as soon as the main is `ready` again; B deletes nothing in
// the runtime folder meanwhile. No clock: the waker is a microtask (projectbox/instances.js), after that cleanUpOpenRoot waits for
// every fallback.
test("(5c) if the project container is stopped the trace stays remembered — at the next `ready` of the main the container removes it", async () => {
  const fake = await fakeDocker();
  const inB = [];
  const prior = setRmSeam((p, o) => { inB.push(p); return fs.rmSync(p, o); });
  try {
    await withAgentsServer(async (ctx) => {
      const p = await project(ctx, "Hall");
      const location = locationFor({ projectId: p.id, converted: true });
      const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
      await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
      const res = await fetch(`${ctx.base}/api/chats/${c.id}/attachments?name=note.txt&artifact=0`, { method: "POST", body: "hello", headers: { Connection: "close" } });
      assert.equal(res.status, 201);
      fs.mkdirSync(path.join(location.outputs, c.id, "agents"), { recursive: true });
      fs.writeFileSync(path.join(location.outputs, c.id, "agents", "a1.output"), "x");
      const list = chatTraces(location, c.id).map((s) => s.path).sort();
      assert.ok(list.length >= 2, `traces in the runtime folder: ${list}`);
      const container = `cbase-p-${p.id}`;
      await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", ...fake.env }, async () => {
        await docker(["run", "-d", "--name", container, "cbase-projectbox"]);
        await docker(["stop", container]);
        const r = await fetch(`${ctx.base}/api/chats/${c.id}`, { method: "DELETE", headers: { Connection: "close" } });
        assert.equal(r.status, 200);
        await cleanUpOpenRoot();
        assert.deepEqual(chatTraces(location, c.id).map((s) => s.path).sort(), list, "with a stopped container the traces stay (and B does not delete)");
        const n = fake.calls().length;
        // The main starts again: start -> ready (like post-start and recovery).
        await docker(["start", container]);
        setInstanceState(p.id, "main", "start");
        setInstanceState(p.id, "main", "ready");
        await null; // the waker is a microtask
        await cleanUpOpenRoot();
        const exec = fake.calls().slice(n).filter((a) => a.args[0] === "exec").map((a) => a.args).sort((a, b) => a.at(-1).localeCompare(b.at(-1)));
        assert.deepEqual(exec, list.map((filePath) => ["exec", "-u", "root", container, "rm", "-rf", filePath]), "after `ready` the container cleans up every remembered trace");
      });
      assert.deepEqual(chatTraces(location, c.id), [], "the traces are gone after `ready`");
      assert.deepEqual(inB.filter((x) => liesUnder(x, location.root) || x === location.root), [], "B deleted in the runtime folder");
      assert.equal(store.getSetting("runtime.traces_catch_up", "[]"), "[]", "nothing stays remembered");
    }, { claude: CLAUDE });
  } finally {
    setRmSeam(prior);
    fake.cleanUp();
  }
});

// ── (6) Move in small ──────────────────────────────────────────────────────────────────────────────────────────

test("(6) merge: if the target is missing the trace moves; if it exists the target wins; with living work deferred", () => {
  withDirs(() => {
    const old = locationFor({ projectId: "pa", converted: true });
    const fresh = locationFor({ projectId: "pb", converted: true });
    const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
    write(path.join(old.attachments, "c1", "x.txt"), "old-x");
    write(path.join(old.attachments, "c1", "y.txt"), "old-y");
    write(path.join(fresh.attachments, "c1", "y.txt"), "new-y");
    write(path.join(old.outputs, "c1", "agents", "a1.output"), "report");
    write(path.join(old.scratch, "c1.mcp.json"), "{}");
    write(path.join(old.attachments, "c2", "foreign.txt"), "another chat");

    assert.equal(bringAlongChat("c2", { location: old }), null, "if everything lies at the own place there is nothing to do");
    const wait = bringAlongChat("c1", { location: fresh, backgroundAlive: () => true });
    assert.equal(wait.deferred, true);
    assert.ok(fs.existsSync(path.join(old.attachments, "c1", "x.txt")), "deferred means: nothing moved");

    const r = bringAlongChat("c1", { location: fresh });
    assert.equal(r.deferred, false);
    assert.deepEqual(r.error, []);
    assert.equal(fs.readFileSync(path.join(fresh.attachments, "c1", "x.txt"), "utf8"), "old-x");
    assert.equal(fs.readFileSync(path.join(fresh.attachments, "c1", "y.txt"), "utf8"), "new-y", "the target wins");
    assert.equal(fs.readFileSync(path.join(fresh.outputs, "c1", "agents", "a1.output"), "utf8"), "report");
    assert.deepEqual(chatTraces(old, "c1"), []);
    assert.ok(fs.existsSync(path.join(old.attachments, "c2", "foreign.txt")), "another chat stays untouched");
    assert.equal(bringAlongChat("c1", { location: fresh }), null, "idempotent");

    const hint = relocationHint(r);
    assert.ok(hint.includes(`${path.join(old.attachments, "c1")} → ${path.join(fresh.attachments, "c1")}`), hint);
    assert.ok(hint.includes(`${path.join(old.outputs, "c1")} → ${path.join(fresh.outputs, "c1")}`), hint);
    assert.equal(relocationHint({ relocated: [] }), "");

    // A stored path from the old place (dynworkflows: script of a run) — the chat without a row is now flat.
    const flatLocation = locationFor({});
    write(path.join(flatLocation.outputs, "c3", "workflows", "r1", "script.js"), "x");
    const oldPath = path.join(old.outputs, "c3", "workflows", "r1", "script.js");
    assert.equal(afterRelocation({ id: "c3", projectId: null }, oldPath), path.join(flatLocation.outputs, "c3", "workflows", "r1", "script.js"));
    assert.equal(afterRelocation({ id: "c3", projectId: null }, "/nowhere/script.js"), "/nowhere/script.js", "foreign paths stay");
    write(oldPath, "still there");
    assert.equal(afterRelocation({ id: "c3", projectId: null }, oldPath), oldPath, "a path that exists stays");
  });
});

test("(6b) two files at the same place — the YOUNGER wins, on a tie the target; the readers with fallback", () => {
  withDirs(() => {
    const old = locationFor({ projectId: "pa", converted: true });
    const fresh = locationFor({ projectId: "pb", converted: true });
    const early = new Date("2026-09-01T10:00:00Z");
    const late = new Date("2026-09-01T11:00:00Z");
    const write = (p, t, time) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); fs.utimesSync(p, time, time); };
    const ag = (o, n) => path.join(o.outputs, "c1", "agents", n);
    write(ag(old, "a1.output"), "continued at the old place", late); // the source is younger (continuation from the inventory)
    write(ag(fresh, "a1.output"), "first version", early);
    write(ag(old, "a2.output"), "old", early);                      // the source is older
    write(ag(fresh, "a2.output"), "after the switch", late);
    write(path.join(old.attachments, "c1", "g.txt"), "source", early); // tie: the target
    write(path.join(fresh.attachments, "c1", "g.txt"), "target", early);

    // The readers with fallback while the move is pending — the current place first, then the old one.
    const chat = { id: "c1", projectId: null };
    write(path.join(old.attachments, "c1", "only-old.txt"), "x", early);
    write(path.join(old.outputs, "c1", "workflows", "approvals", "r.json"), "{}", early);
    assert.equal(attachmentPath(chat, "only-old.txt", fresh), path.join(old.attachments, "c1", "only-old.txt"));
    assert.equal(attachmentPath(chat, "g.txt", fresh), path.join(fresh.attachments, "c1", "g.txt"), "at the current place first");
    assert.equal(attachmentPath(chat, "missing.txt", fresh), path.join(fresh.attachments, "c1", "missing.txt"), "nowhere: the current path");
    assert.equal(attachmentFile(chat, "only-old.txt", fresh), `${path.join(old.attachments, "c1")}/only-old.txt`);
    assert.equal(outputFile(chat, path.join("workflows", "approvals", "r.json"), fresh), path.join(old.outputs, "c1", "workflows", "approvals", "r.json"));
    assert.deepEqual(attachmentFolderToRead(chat, fresh), [path.join(fresh.attachments, "c1"), path.join(old.attachments, "c1")]);

    const r = bringAlongChat("c1", { location: fresh });
    assert.deepEqual(r.error, []);
    assert.equal(fs.readFileSync(ag(fresh, "a1.output"), "utf8"), "continued at the old place", "the younger source wins");
    assert.equal(fs.readFileSync(ag(fresh, "a2.output"), "utf8"), "after the switch", "the younger target wins");
    assert.equal(fs.readFileSync(path.join(fresh.attachments, "c1", "g.txt"), "utf8"), "target", "tie: the target");
    assert.deepEqual(chatTraces(old, "c1"), []);
    assert.equal(attachmentPath(chat, "only-old.txt", fresh), path.join(fresh.attachments, "c1", "only-old.txt"), "after the move the current place");
    assert.deepEqual(attachmentFolderToRead(chat, fresh), [path.join(fresh.attachments, "c1")]);
  });
});

// ── (7) Worktrees of the subagents at the closing path ───────────────────────────────────────────────────────────────

// Git without a personal configuration.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "core.excludesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.attributesFile", GIT_CONFIG_VALUE_3: "/dev/null",
  GIT_CONFIG_KEY_4: "init.defaultBranch", GIT_CONFIG_VALUE_4: "main",
};
async function withGitEnvironment(fn) {
  const prior = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const gitIn = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};

test("(7) the closing path removes the changed worktree of a subagent in the runtime folder — the branch stays", async () => {
  await withGitEnvironment(() => withAgentsServer(async (ctx) => {
    const { chat, dataRoot, base, root } = ctx;
    const p = await project(ctx, "Repo");
    const repo = path.join(root, "workspace", "repo");
    gitIn(["init", "-q"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    gitIn(["add", "a.txt"], repo);
    gitIn(["commit", "-qm", "start"], repo);
    await inChat(ctx, p.id);
    await send(ctx, `AG:${JSON.stringify({ description: "Change", prompt: "Write {TAG:w} {AENDERN}", run_in_background: false, isolation: "worktree" })}`);
    const x = agentIdFrom(root, 1);
    await ctx.waitForQuiet();
    const wt = path.join(dataRoot, "data", "projects", p.id, "worktrees", `agent-${x}`);
    assert.equal(fs.realpathSync(JSON.parse(fs.readFileSync(path.join(root, "sub-w"), "utf8")).cwd), fs.realpathSync(wt), "the agent worked in the worktree of the runtime folder");
    assert.ok(fs.existsSync(path.join(wt, "changed.txt")), "a changed worktree stays at its end");
    assert.ok(gitIn(["worktree", "list", "--porcelain"], repo).includes(`agent-${x}`));

    const res = await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(wt), "after deleting the chat its worktree is gone");
    assert.ok(!gitIn(["worktree", "list", "--porcelain"], repo).includes(`agent-${x}`), "and deregistered in git");
    assert.equal(gitIn(["branch", "--list", `cbase/agent-${x}`], repo).replace(/^[*+ ]+/, ""), `cbase/agent-${x}`, "the branch stays (commits of the agent)");
    assert.deepEqual(lanesOf(path.join(dataRoot, "data", "projects", p.id), chat.id), [], "nothing of the chat left in the runtime folder");
  }, { claude: CLAUDE }));
});

// ── Closing paths and deferred moves in the project container ──────────────────────────────────────────────────────────

// Set the environment and take back EVERY set key in the finally (withEnvironment above takes back only the operation marker).
async function withValues(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("(8) in the project container with a deferred move — attachments COPIED to the place of the run, /message names it, a hint names the outputs", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { chat, dataRoot, base, root } = ctx;
      await withValues({
        CBASE_CONTAINER: "1", CBASE_DIND: "1", ...fd.env, CBASE_IN_PROJECT_ESCALATION_MS: "200",
        CLAUDE_CONFIG_DIR: path.join(root, "b-home", ".claude"), CODEX_HOME: path.join(root, "b-home", ".codex"),
      }, async () => {
        // Attachments at the flat place, plus a finished subagent whose core stays open there (the move stays deferred until the
        // core closes). A finished one suffices (every known agent counts); a living one would also do — the project switch is
        // allowed next to living work.
        const one = await upload(ctx, "one.txt", "ONE");
        const two = await upload(ctx, "two.txt", "TWO");
        await send(ctx, `AG:${JSON.stringify({ description: "Check", prompt: "Read {TAG:c}", run_in_background: false })}`);
        await ctx.waitForQuiet();
        const fa = path.join(flat().attachments, chat.id);

        // Switch to a converted project WITH a container: the next turn runs there.
        const filePath = path.join(root, "workspace", "container");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Container", path: filePath });
        const name = `cbase-p-${p.id}`;
        await docker(["run", "-d", "--name", name, "cbase-projectbox:test"]);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await inChat(ctx, p.id);
        const wp = path.join(dataRoot, "data", "projects", p.id);
        const pa = path.join(wp, "attachments", chat.id);

        const t2 = await send(ctx, "in the container", [{ file: one, name: "one.txt" }]);
        assert.ok(fd.calls({ daemon: "host" }).some((a) => a.args[0] === "exec" && a.args.includes(process.env.CLAUDE_BIN)), "the turn ran in the project container");
        assert.ok(t2.text.includes(`- ${path.join(pa, one)}`), `/message names the attachment at the place of the run: ${t2.text}`);
        assert.ok(!t2.text.includes(`- ${path.join(fa, one)}`), "not the old place, which the container does not see");
        assert.equal(fs.readFileSync(path.join(pa, one), "utf8"), "ONE");
        assert.equal(fs.readFileSync(path.join(pa, two), "utf8"), "TWO", "also an attachment the message does not name (the history names it)");
        assert.ok(fs.existsSync(path.join(fa, one)) && fs.existsSync(path.join(fa, two)), "copied, not moved — the move stays deferred");
        assert.ok(t2.addDirs.every((d) => !liesUnder(d, flat().attachments) && !liesUnder(d, flat().outputs)), `no old place in --add-dir: ${t2.addDirs}`);
        assert.ok(t2.text.includes("cbase-hint") && t2.text.includes(`- ${fa} → ${pa}`), `the hint names the copy: ${t2.text}`);
        assert.ok(t2.text.includes(`- ${path.join(flat().outputs, chat.id)}`) && t2.text.includes("NOT readable"), "and the outputs at the old place as not readable");

        // Still deferred: no second, identical hint.
        const t3 = await send(ctx, "once more");
        assert.ok(!t3.text.includes("the move of its files is deferred"), "the same hint only once");

        // The core at the old place closes (idle seam): the next turn moves the files — the same files at the target stay.
        assert.ok(idleNow() >= 1);
        await send(ctx, "afterwards");
        await ctx.waitForQuiet();
        assert.equal(fs.readFileSync(path.join(pa, one), "utf8"), "ONE");
        assert.equal(fs.readFileSync(path.join(pa, two), "utf8"), "TWO");
        assert.deepEqual(chatTraces(flat(), chat.id).filter((s) => s.field === "attachments" || s.field === "outputs"), [], "at the flat place nothing of the chat is left");
      });
    }, { claude: CLAUDE });
  } finally {
    fd.cleanUp();
  }
});

test("(9) the closing path also removes the changed worktree of a workflow agent in the runtime folder — the branch stays", async () => {
  await withGitEnvironment(() => withAgentsServer(async (ctx) => {
    const { chat, dataRoot, base } = ctx;
    const p = await project(ctx, "Repo");
    const repo = path.join(ctx.root, "workspace", "repo");
    gitIn(["init", "-q"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    gitIn(["add", "a.txt"], repo);
    gitIn(["commit", "-qm", "start"], repo);
    await inChat(ctx, p.id);
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const script = "export const meta = { name: 'wt', description: 'lauf6', phases: [{ title: 'Work' }] }\nreturn await agent('Write {TAG:wf} {AENDERN}', { isolation: 'worktree' });\n";
    const r = await json(`${base}/api/chats/${chat.id}/dyn-workflows/run`, { method: "POST", body: JSON.stringify({ script }) });
    assert.equal(r.status, "started", JSON.stringify(r));
    const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `Lauf ${r.runId}`);
    assert.equal(end.status, "finished", end.error);
    await ctx.waitForQuiet();
    const root = path.join(dataRoot, "data", "projects", p.id, "worktrees");
    const names = fs.readdirSync(root).filter((n) => n.startsWith("agent-"));
    assert.equal(names.length, 1, `one worktree of the workflow agent: ${names}`);
    const wt = path.join(root, names[0]);
    assert.ok(fs.existsSync(path.join(wt, "changed.txt")), "a changed worktree stays at the end of the run");
    assert.ok(gitIn(["worktree", "list", "--porcelain"], repo).includes(names[0]));
    assert.ok(store.subagentsOf(chat.id).every((b) => b.agentId !== names[0].slice("agent-".length)), "it is not in the inventory of the subagents — only in the journal");

    const res = await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(wt), "after deleting the chat the worktree of the workflow agent is gone");
    assert.ok(!gitIn(["worktree", "list", "--porcelain"], repo).includes(names[0]), "and deregistered in git");
    assert.equal(gitIn(["branch", "--list", `cbase/${names[0]}`], repo).replace(/^[*+ ]+/, ""), `cbase/${names[0]}`, "the branch stays");
  }, { claude: CLAUDE }));
});

// The loop engine: on "TASK" the main agent calls a subagent (cbase_agent, foreground) — its core stays open after the turn and
// knows the finished agent (the move stays deferred); otherwise it answers with text.
const isEngineSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));
const lastUserRow = (b) => JSON.stringify([...(b.messages || [])].reverse().find((m) => m.role === "user")?.content ?? "");
const engineRound = (b) => {
  if (isEngineSub(b)) return { text: "SUB-FINISHED" };
  if (lastUserRow(b).includes("TASK") && !(b.messages || []).some((m) => m.role === "tool")) {
    return { toolCalls: [{ id: "call_run8", name: "mcp__cbase__cbase_agent", arguments: { description: "Look into it", prompt: "Look and report.", run_in_background: false } }] };
  }
  return { text: "finished" };
};

test("(10) an engine turn with an image and a deferred move — the image reaches the model from the OLD place", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, dataRoot, engine } = ctx;
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Image" }) });
    const cx = { ...ctx, chat: c };
    const a = await project(cx, "Image-A");
    const b = await project(cx, "Image-B");
    await inChat(cx, a.id);
    const image = Buffer.from("run8-imagebytes-\u0000\u0001\u0002");
    const file = await upload(cx, "image.png", image);
    const message = async (text, attachments) => {
      const n = engine.requests.length;
      await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text, ...(attachments ? { attachments } : {}) }) });
      await waitForTruthy(() => engine.requests.length > n, `engine request after "${text}"`);
      await ctx.waitForQuiet();
      return engine.requests.slice(n);
    };
    await message("TASK");
    assert.ok(engine.requests.some(isEngineSub), "the subagent ran — its core stays open at place A");

    await inChat(cx, b.id);
    const requests = await message("IMAGE", [{ file, name: "image.png" }]);
    const wa = path.join(dataRoot, "data", "projects", a.id, "attachments", c.id);
    const wb = path.join(dataRoot, "data", "projects", b.id, "attachments", c.id);
    assert.ok(fs.existsSync(path.join(wa, file)) && !fs.existsSync(path.join(wb, file)), "the move is deferred: the image lies at the old place");
    assert.ok(requests.some((q) => JSON.stringify(q).includes(image.toString("base64"))), "the engine got the image — read at the old place (attachmentPath)");
  }, { claude: CLAUDE, engine: { round: engineRound } });
});
