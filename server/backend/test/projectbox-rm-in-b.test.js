// Guard: B never deletes recursively in a tree that a running project or copy container writes to.
//
// THE REASON. `fs.rmSync(p, { recursive: true })` is a JS rimraf over PATH NAMES in Node 22 (lstat, rmdir, readdir, unlink per
// name). If `p` lies in a project folder or runtime folder that a running container has mounted at the same path
// (projectbox/creation.js: source = target), the container can swap a subfolder for a link between two steps — B then
// deletes its target IN B (DB, login, other projects). In the container the same `rm -rf` is harmless: a link resolves only
// in the namespace of the project there, and `rm -rf` does not follow it. Therefore: with a running container the container
// deletes (runtime/git-run.js commandRun, projectbox/cleanUp.js removeAsRoot, the stacks helpers), never B.
//
// THE PROMISES, each with the way that breaks it:
//   (1) SOURCE TABLE. Every deletion site under server/projectbox/** and server/stacks/** — `fs.rm/rmSync/rmdir/rmdirSync/
//       unlink/unlinkSync(`, `fs.promises`, `rimraf`, an import from `node:fs/promises` or a named delete import from
//       `node:fs`, an `rm` as child process in B (`execFile("rm"`, `spawn("rm"`, …) and the calls of the delete wrappers
//       (`removeTrace(`, `cleanUpChatRuntime(`, `purgeProjectDir(`, `removeNew(`, `removeCopyLocation(`) — is listed in
//       ALLOWED: file, a wording of the line, count, KIND and reason. The kinds:
//         b-location          a place in B that no project or copy container has mounted (data folder, relocation location, tmp);
//         without-container   at this point no container of the project or copy runs any more (removed before);
//         before-turnaround   relocation before the turnaround: the project is not yet converted, nothing of the user runs in the
//                             new container (stack only `up --no-start`), lock and idle hold, the old containers are stopped;
//         without-instance    only in the branch WITHOUT an instance (local, tests); with an instance the container deletes;
//         individual          not recursive, ONE path: a link at the place falls itself, its target never;
//         inContainer         the core of a container program: it stands as a function in the file but runs as text
//                             (`node -e <PROGRAM>`) through `commandRun` INSIDE the project container — in B only as a function
//                             in tests. A core that B also calls itself does NOT belong in this kind.
//       Red: a new site without an entry, a kind outside the list, an entry whose count is wrong (grown or gone — the table may
//       only shrink, and whoever removes a site removes its entry). Comment lines do not count.
//   (2) projectRepo.js: every `fs.rmSync` line stands behind `if (!instance)` in the same line (gitFolderRemove).
//   (3) erase.js: the body of `stopAll` (phase 1, the containers still run) has neither `runtimeAsServer(` nor `fs.rm`/
//       `rmSync`/`unlink` — step 1 goes entry by entry through `removeAsRoot` (in the container).
//   (4) The state before the repair (git show b387160) is red — projectRepo.js and erase.js each inserted alone.
//   (5) stacks/objects.js removeCopyWorktrees is NOT a delete wrapper in B: `copy-worktrees/` lies in the runtime folder that the
//       RUNNING main container mounts rw at the same path — the entry "the copy container is stopped" (kind without-container)
//       overlooked the main one. The body has neither `fs.rm`/`rmSync`/`rmdir`/`unlink` nor an `rm` as child process in B; the
//       first way is `removeAsRoot(` (rm in the main container), the fallback `withHelper(` with the runtime folder as bind
//       (`source: runLocation.root` — the main container can replace `copy-worktrees/` itself, not the mount point). The state
//       before (git show 1be1ed5e) is red.
// The built-in sabotage turns every rule red. The BEHAVIOR (with an instance the container deletes; step 1 deletes nothing in B
// while the container runs) is held by projectRepo.test.js (12)/(13) and projectbox-delete.test.js; the traces of a chat in the
// runtime folder (runs/runtime-location.js removeTrace — outside this table) by runtime-location.test.js (5b).
//
// COUNTER-TESTS: projectRepo.js and erase.js from b387160 => (4) red (built into this file); a new line
// `fs.rmSync(x, { recursive: true, force: true });` in stacks/remove.js => (1) red; stacks/objects.js removeCopyWorktrees with
// the old line `fs.rmSync(root, { recursive: true, force: true });` before the main path => (1) and (5) red, plus
// stacks-clear-away.test.js (7) and (7c) red; objects.js from 1be1ed5e => (5) red (built in).
//
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/projectbox-rm-in-b.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");
const REPO = path.resolve(SERVER, "..", "..", "..", "..");
const FOLDER = ["projectbox", "stacks"];
// The deletion sites before the repair (b387160, reduced to the sites the guard must catch): projectRepo.js removed `.git` without
// the instance guard, erase.js cleared the runtime folder in stopAll while the containers still ran.
const BEFORE_R2C_11 = {
  "projectbox/projectRepo.js": {
    text: [
      "export function cloneFailed(root) {",
      '  try { fs.rmSync(path.join(root, ".git"), { recursive: true, force: true }); } catch { /* the error above counts */ }',
      "}",
      "",
    ].join("\n"),
    rule: /^projectbox\/projectRepo\.js:2: fs\.rmSync without `if \(!instance\)` in the same line$/,
  },
  "projectbox/erase.js": {
    text: [
      "async function stopAll(plans, { purge }) {",
      "  for (const p of plans) {",
      "    if (purge && p.runtimeExists) {",
      "      const rootOwn = runtimeAsServer(p.location.root, []);",
      "      for (const filePath of rootOwn) await removeAsRoot({ projectId: p.pid, path: filePath });",
      "    }",
      '    for (const c of p.container) await docker(["stop", "-t", String(STOP_DEADLINE_S), c.id], { capMs: STOP_CAP_MS });',
      "  }",
      "}",
      "",
    ].join("\n"),
    rule: /^projectbox\/erase\.js stopAll \(containers still run\): "runtimeAsServer\("$/,
  },
};
// removeCopyWorktrees before the repair (1be1ed5e, reduced): it still deleted recursively in B and fell back to a helper that
// mounted the parent.
const BEFORE_WORKTREES_1 = [
  "export async function removeCopyWorktrees({ runLocation, root, projectId, instance }) {",
  "  const parent = runLocation.copyWorktrees;",
  "  try {",
  "    fs.rmSync(root, { recursive: true, force: true });",
  "    return { removed: true, overHelper: false };",
  "  } catch (e) {",
  '    if (e?.code !== "EACCES" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY") throw e;',
  "  }",
  '  await withHelper({ kind: "clearAway", projectId, instance, mounts: [{ type: "bind", source: parent, target: parent }] }, (h) => executeHelper(h, ["rm", "-rf", "--", root]));',
  "  return { removed: !fs.existsSync(root), overHelper: true };",
  "}",
  "",
].join("\n");

const KINDS = new Set(["b-location", "without-container", "before-turnaround", "without-instance", "individual", "inContainer"]);

const PATTERN = [
  /\bfs\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\(/,
  /\bfs\.promises\b/,
  /\brimraf\b/,
  /["']node:fs\/promises["']/,
  /import\s*\{[^}]*\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|promises)\b[^}]*\}\s*from\s*["']node:fs["']/,
  /\b(?:execFile|execFileSync|spawn|spawnSync|pexec|exec|execSync)\(\s*["'](?:\/bin\/|\/usr\/bin\/)?rm["']/,
  /(?<!function )\b(?:removeTrace|cleanUpChatRuntime|purgeProjectDir|removeNew|removeCopyLocation)\(/,
];

// The allowed deletion sites (header, (1)). `contains` is a wording of the line; `count` the number of matching lines.
const ALLOWED = [
  // projektbox/
  { file: "projectbox/projectRepo.js", contains: "if (!instance) { try { fs.rmSync(target,", count: 1, kind: "without-instance",
    reason: "gitFolderRemove: `.git` falls in B without an instance; with an instance `rm -rf` in the container" },
  { file: "projectbox/git-assignment.js", contains: "fs.rmSync(tmp, { force: true });", count: 1, kind: "b-location",
    reason: "`<data>/git-access.key.<pid>.tmp` — data folder of B, mounted in no container" },
  { file: "projectbox/cli-home.js", contains: "fs.rmSync(tmp, { force: true })", count: 1, kind: "individual",
    reason: "writeAtomic: its own tmp remainder (fixed name with pid and time) next to a file of the CLI home, not recursive — a container mounts the CLI home; a parent folder swapped there would steer the unlink to a file of the same name in B (only this one name, no tree)" },
  { file: "projectbox/instance.js", contains: "fs.rmSync(a.target, { force: true })", count: 1, kind: "individual",
    reason: "an EMPTY placeholder (statSync size 0) before the start, not recursive; first removeInRuntimeFolder (runs/runtime-write.js, if it lies in the runtime folder), rmSync only as fallback — a swapped parent folder would steer this fallback to a file of the same name in B (one fixed name, no tree)" },
  // Project creation: the project folder that the creation POST itself has just created falls again if something fails afterwards —
  // `rmdirSync` (only an EMPTY folder, not recursive) and BEFORE any container of the project (the instance row comes later or in
  // the same step).
  { file: "projectbox/setup/routes.js", contains: "try { fs.rmdirSync(p); } catch { /* a link or not empty", count: 1, kind: "individual",
    reason: "createProjectFolder: the folder just created leads through a link — rmdir of an empty folder, a link or content stays (ENOTDIR/ENOTEMPTY); no container yet" },
  { file: "projectbox/setup/routes.js", contains: "try { fs.rmdirSync(projPath); } catch { /* stays */ }", count: 1, kind: "individual",
    reason: "projectCreateInOps: runtime folder cannot be created — the empty project folder just created falls; no instance row yet, no container" },
  { file: "projectbox/setup/routes.js", contains: "try { fs.rmdirSync(projPath); } catch { /* */ }", count: 1, kind: "individual",
    reason: "projectCreateInOps: setup/instance/project cannot be created — the same empty folder; the rows were just rolled back, no container" },
  { file: "projectbox/erase.js", contains: "if (st.isDirectory()) fs.rmSync(location, { recursive: true, force: true });", count: 1, kind: "without-container",
    reason: "step 9: copies-backup/<pid> (never mounted) and the copies folder of the pid — after phase 2 and probe 7, without a living copy" },
  { file: "projectbox/erase.js", contains: "else fs.unlinkSync(location);", count: 1, kind: "without-container",
    reason: "step 9: a link/file at the place of a copy folder falls itself" },
  { file: "projectbox/erase.js", contains: "try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {", count: 1, kind: "without-container",
    reason: "runtimeAsServer — only from runtimeLast: step 6 (all containers of the project removed) and operation without the marker" },
  { file: "projectbox/erase.js", contains: "try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* counted below */ }", count: 1, kind: "without-container",
    reason: "runtimeLast, step 6 or without the marker" },
  { file: "projectbox/erase.js", contains: "purgeProjectDir(project.path)", count: 1, kind: "without-container",
    reason: "projectDelete AFTER deleteProjectbox: no container of the project stands any more (or there was no row)" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(tmp, { force: true });", count: 1, kind: "b-location",
    reason: "writeAtomic in the relocation location of the pid" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(backup, { force: true });", count: 1, kind: "b-location", reason: ".env backup in the relocation location" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(checkFile, { force: true });", count: 1, kind: "b-location", reason: "checksum of the .env backup in the relocation location" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(path.join(projectPath, \".git\"), { recursive: true, force: true });", count: 2, kind: "before-turnaround",
    reason: "step 11: a half project repo of its own from an earlier run falls before it is created anew" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(path.join(filePath, \".git\"), { recursive: true, force: true });", count: 2, kind: "before-turnaround",
    reason: "rw-project-repo: after rw-container (the new container is removed)" },
  { file: "projectbox/relocation/data.js", contains: "if (inventory == null) { fs.rmSync(root, { recursive: true, force: true }); return 1; }", count: 1, kind: "before-turnaround",
    reason: "removeNew — only from runtimeBack (rw-runtime, nothing ran inside; the endangered check stops it)" },
  { file: "projectbox/relocation/data.js", contains: "{ fs.rmSync(abs, { recursive: true, force: true }); n++; }", count: 1, kind: "before-turnaround", reason: "removeNew, as above" },
  { file: "projectbox/relocation/data.js", contains: "removeTrace(c.to, projectLocation)", count: 2, kind: "before-turnaround", reason: "runtimeBack: the copies from step 13" },
  { file: "projectbox/relocation/data.js", contains: "removeNew(k.local.root, k.local.inventory)", count: 1, kind: "before-turnaround", reason: "runtimeBack: ~/.local" },
  { file: "projectbox/relocation/data.js", contains: "removeNew(s.root, s.inventory)", count: 1, kind: "before-turnaround", reason: "runtimeBack: sessions" },
  { file: "projectbox/relocation/data.js", contains: "fs.rmSync(d, { recursive: true, force: true });", count: 1, kind: "b-location", reason: "step 15: backups/overrides in the relocation location" },
  { file: "projectbox/relocation/data.js", contains: "removeTrace(c.from, flatLocation)", count: 1, kind: "b-location", reason: "step 15: the flat location (never mounted)" },
  { file: "projectbox/relocation/data.js", contains: "try { fs.rmSync(p, { recursive: true, force: true }); report.sessions++; }", count: 1, kind: "b-location",
    reason: "step 15: old session copies in ~/.claude or ~/.codex of B" },
  { file: "projectbox/relocation/collect.js", contains: "fs.rmSync(tmp, { recursive: true, force: true });", count: 1, kind: "b-location", reason: "mkdtemp in os.tmpdir() of B" },
  // Layout rebuild: the cores of the container programs (kind inContainer, header).
  { file: "projectbox/layout/rebuild-program.js", contains: "const r = cp.spawnSync(\"rm\", process.platform === \"linux\"", count: 1, kind: "inContainer",
    reason: "rebuildCore op `way` with asRoot: `rm -rf --one-file-system` INSIDE the project container (cleanUp.js removeAsRoot, procedure.js step 11) — after the check of the path parts" },
  { file: "projectbox/layout/rebuild-program.js", contains: "try { fs.rmSync(x.abs, { recursive: true, force: true }); out.push({ rel, outcome: \"deleted\" }); }", count: 1, kind: "inContainer",
    reason: "rebuildCore op `way`: a path left out of the layout, INSIDE the project container (procedure.js step 11)" },
  { file: "projectbox/layout/rebuild-program.js", contains: "fs.rmdirSync(x.abs);", count: 1, kind: "inContainer",
    reason: "rebuildCore op `empty`: the empty parking folder `.cbase-layout` after the insertion, not recursive, INSIDE the project container" },
  { file: "projectbox/layout/rebuild-program.js", contains: "finally { try { fs.rmSync(tmp, { force: true }); }", count: 1, kind: "inContainer",
    reason: "rebuildCore op `alternates`: its own tmp remainder next to `objects/info/alternates`, INSIDE the project container" },
  { file: "projectbox/layout/rebuild-program.js", contains: "finally { try { if (lst(tmp)) fs.unlinkSync(tmp); }", count: 1, kind: "inContainer",
    reason: "rebuildCore op `links`: its own tmp reference next to a link of a graph worktree if the `rename` over it failed, INSIDE the project container" },
  { file: "projectbox/layout/proc-program.js", contains: "if (!ign.includes(sig)) fs.rmSync(path.join(root, String(pid))", count: 1, kind: "inContainer",
    reason: "procCore mode `end` only with the test seam (`o.root`, setProcSearchSeam): the fake process in the FAKE /proc ends — in operation a signal goes out there, and `end` runs only INSIDE the project container (procInB asks only processes/foreground)" },
  { file: "projectbox/devtools-ui.js", contains: "fs.rmSync(dir, { recursive: true, force: true });", count: 3, kind: "b-location",
    reason: "mkdtemp in os.tmpdir() of B: the profile of the own headless Chromium of the DevTools UI — start error, end, error; mounted in no container" },
  { file: "projectbox/vscode-upfront.js", contains: "try { fs.rmSync(p, { recursive: true, force: true }); return true; }", count: 1, kind: "b-location",
    reason: "wayInB: only the tarball cache `<data>/vscode-server-upfront/` and `~/.vscode-remote-containers/bin` of B — both in creation.js neverMounted (bound in projectbox-vscode-upfront.test.js); into a project the script writes and deletes INSIDE the container" },
  // stacks/
  { file: "stacks/objects.js", contains: "fs.rmSync(base, { recursive: true, force: true });", count: 1, kind: "without-container",
    reason: "removeCopyLocation — copy container and helper are removed before (dismantling.js 1.; dismantlingClone only if the helper is gone — `if (!helperGone)`)" },
  { file: "stacks/objects.js", contains: "fs.unlinkSync(file);", count: 1, kind: "b-location", reason: "dismissBackupFile: copies-backup (never mounted), regular file checked" },
  { file: "stacks/objects.js", contains: "fs.rmdirSync(location.backup)", count: 1, kind: "b-location", reason: "cleanUpBackup: an EMPTY folder, not recursive" },
  { file: "stacks/freeze.js", contains: "removeCopyLocation({ location, projectId: pid, instance })", count: 1, kind: "without-container",
    reason: "dismantlingClone: only behind `if (!helperGone) … else` — a clone helper that was not removed (throw, NoHelper) leaves the location standing" },
];

// The sources: rel → text. Comment lines (// … and block comment lines starting with *) do not count.
function sources() {
  const out = new Map();
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) go(p);
      else if (e.name.endsWith(".js")) out.set(path.relative(SERVER, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8"));
    }
  };
  for (const o of FOLDER) go(path.join(SERVER, o));
  return out;
}

const comment = (z) => /^\s*(?:\/\/|\*|\/\*)/.test(z);

function hits(files) {
  const out = [];
  for (const [file, text] of files) {
    text.split("\n").forEach((z, i) => {
      if (!comment(z) && PATTERN.some((m) => m.test(z))) out.push({ file, row: i + 1, text: z.trim() });
    });
  }
  return out;
}

function bodyOf(text, header) {
  const a = text.indexOf(header);
  return a < 0 ? "" : text.slice(a, text.indexOf("\n}\n", a) + 3);
}

function violations(files, table = ALLOWED) {
  const v = [];
  const all = hits(files);
  const gedeckt = new Set();
  for (const e of table) {
    if (!KINDS.has(e.kind)) v.push(`${e.file}: kind "${e.kind}" does not exist (${[...KINDS].join(", ")})`);
    if (!e.reason) v.push(`${e.file}: "${e.contains}" without a reason`);
    const h = all.filter((t) => t.file === e.file && t.text.includes(e.contains));
    if (h.length !== e.count) v.push(`${e.file}: "${e.contains}" ${h.length}x instead of ${e.count}x — adjust the table (it may only shrink) or justify the site`);
    for (const t of h) gedeckt.add(`${t.file}:${t.row}`);
  }
  for (const t of all) {
    if (!gedeckt.has(`${t.file}:${t.row}`)) v.push(`new deletion site in B without an entry: ${t.file}:${t.row} ${t.text}`);
  }
  const repo = files.get("projectbox/projectRepo.js") || "";
  repo.split("\n").forEach((z, i) => {
    if (!comment(z) && /\bfs\.rmSync\(/.test(z) && !z.includes("if (!instance)")) v.push(`projectbox/projectRepo.js:${i + 1}: fs.rmSync without \`if (!instance)\` in the same line`);
  });
  const stop = bodyOf(files.get("projectbox/erase.js") || "", "async function stopAll(");
  if (!stop) v.push("projectbox/erase.js: stopAll not found");
  for (const forbidden of ["runtimeAsServer(", "fs.rm", "rmSync", "unlink"]) {
    if (stop.includes(forbidden)) v.push(`projectbox/erase.js stopAll (containers still run): "${forbidden}"`);
  }
  if (stop && !stop.includes("removeAsRoot(")) v.push("projectbox/erase.js stopAll: step 1 does not go through removeAsRoot");
  // (5) removeCopyWorktrees never deletes in B — the main container mounts `copy-worktrees/` rw.
  const wt = bodyOf(files.get("stacks/objects.js") || "", "export async function removeCopyWorktrees(");
  if (!wt) v.push("stacks/objects.js: removeCopyWorktrees not found");
  const wtCode = wt.split("\n").filter((z) => !comment(z)).map((z) => z.replace(/\/\/.*$/, "")).join("\n");
  for (const forbidden of ["fs.rm", "rmSync", "rmdir", "unlink"]) {
    if (wtCode.includes(forbidden)) v.push(`stacks/objects.js removeCopyWorktrees (the main container mounts copy-worktrees/ rw): "${forbidden}" — deletion happens in the container`);
  }
  if (PATTERN.slice(0, 6).some((m) => m.test(wtCode))) v.push("stacks/objects.js removeCopyWorktrees: a deletion site in B");
  if (wt && !wtCode.includes("removeAsRoot(")) v.push("stacks/objects.js removeCopyWorktrees: the first way does not go through removeAsRoot (rm in the main container)");
  if (wt && !/withHelper\(\{[^}]*source: runLocation\.root, target: runLocation\.root/.test(wtCode)) v.push("stacks/objects.js removeCopyWorktrees: the helper does not mount the runtime folder (mount point in the main container)");
  return v;
}

test("(1)–(3), (5) every deletion site under projectbox/ and stacks/ is named; with an instance and with a running container B never deletes", () => {
  const d = sources();
  assert.ok(d.size > 40, `only ${d.size} files found — the path is wrong`);
  assert.deepEqual(violations(d), []);
  console.log(`# deletion sites in B under ${FOLDER.join(", ")}: ${hits(d).length} lines, ${ALLOWED.length} entries`);
});

test("(4) the state before the repair (b387160) is red — projectRepo.js and erase.js each alone, each by its own rule", () => {
  for (const [rel, { text, rule }] of Object.entries(BEFORE_R2C_11)) {
    const d = sources();
    d.set(rel, text);
    const v = violations(d);
    assert.ok(v.some((x) => rule.test(x)), `${rel} before the repair: not noticed by its rule — ${JSON.stringify(v)}`);
  }
});

test("(5) the state before the repair (1be1ed5e: stacks/objects.js) is red", () => {
  const d = sources();
  d.set("stacks/objects.js", BEFORE_WORKTREES_1);
  const v = violations(d);
  assert.ok(v.some((x) => x.includes("removeCopyWorktrees") && x.includes("rmSync")), `objects.js before the repair: not noticed — ${JSON.stringify(v)}`);
});

test("the built-in sabotage: every rule turns red", () => {
  const d = sources();
  const including = (rel, fn) => { const x = new Map(d); x.set(rel, fn(x.get(rel) || "")); return violations(x); };
  const cases = {
    "new recursive rm in stacks/": () => including("stacks/remove.js", (t) => `${t}\nfs.rmSync(x, { recursive: true, force: true });\n`),
    "fs.promises.rm": () => including("stacks/remove.js", (t) => `${t}\nawait fs.promises.rm(x, { recursive: true });\n`),
    "import from node:fs/promises": () => including("stacks/remove.js", (t) => `import { rm } from "node:fs/promises";\n${t}`),
    "named import from node:fs": () => including("stacks/remove.js", (t) => `import { rmSync } from "node:fs";\n${t}`),
    "rm as child process in B": () => including("projectbox/ops.js", (t) => `${t}\nexecFile("rm", ["-rf", p]);\n`),
    "delete wrapper": () => including("stacks/remove.js", (t) => `${t}\nremoveTrace(p, ort);\n`),
    "rmSync in removeCopyWorktrees": () => including("stacks/objects.js", (t) => t.replace("  let inMain = false;\n", "  fs.rmSync(wurzel, { recursive: true, force: true });\n  let inMain = false;\n")),
    "main path removed": () => including("stacks/objects.js", (t) => t.replace("inMain = await removeAsRoot({ projectId, path: root });", "inMain = false;")),
    "helper with the bind of the parent": () => including("stacks/objects.js", (t) => t.replace("source: runLocation.root, target: runLocation.root }] }", "source: parent, target: parent }] }")),
    "guard removed in projectRepo.js": () => including("projectbox/projectRepo.js", (t) => t.replace("if (!instance) { try { fs.rmSync(target,", "{ try { fs.rmSync(target,")),
    "runtimeAsServer in stopAll": () => including("projectbox/erase.js", (t) => t.replace("    if (purge && p.runtimeExists) {\n      const not = [];", "    if (purge && p.runtimeExists) {\n      runtimeAsServer(p.location.root, []);\n      const not = [];")),
    "entry without a site": () => violations(d, [...ALLOWED, { file: "stacks/remove.js", contains: "fs.rmSync(exists-not", count: 1, kind: "b-location", reason: "x" }]),
    "unknown kind": () => violations(d, ALLOWED.map((e, i) => (i === 0 ? { ...e, kind: "whatever" } : e))),
    "grown site": () => including("stacks/objects.js", (t) => `${t}\nfs.unlinkSync(datei);\n`),
  };
  for (const [name, fn] of Object.entries(cases)) assert.notDeepEqual(fn(), [], `${name}: not noticed`);
  // Comments do not count.
  assert.deepEqual(including("stacks/remove.js", (t) => `${t}\n// fs.rmSync(x, { recursive: true });\n *   removeTrace(p)\n`), []);
});
