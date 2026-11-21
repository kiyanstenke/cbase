// Guard: every write site in the files that write into a project's runtime folder stands at the guard or is named (the behaviour
// itself is held by runtime-write.test.js).
//
// THE REASON. The runtime folder `<data>/projects/<pid>` is mounted rw in the main and the copy container; a process there can create
// arbitrary links. `writeFileSync`, `mkdirSync`, `copyFileSync`, `renameSync`, `cpSync` and `rmSync` by path name follow them — B
// would write, copy and delete in its own files that way. The ONE way there is runs/runtime-write.js (via runtime/real-path.js:
// descriptor, pinned folders, device + inode); outside a runtime folder its helpers answer `false` and the site writes as before
// (the old path). Every site therefore has the same shape:
//     if (!writeInRuntimeFolder(p, x)) fs.writeFileSync(p, x);        // at the guard (same line)
//     if (!writeInRuntimeFolder(p, x)) { fs.mkdirSync(…); fs.writeFileSync(p, x); }   // in the guard's block
//     if (copyInRuntimeFolder(a, b)) return;  …old path…               // old-path branch behind it — named here
//
// THE PROMISES, each with the way that breaks it:
//   (1) Every file that imports runs/runtime-write.js is read — and the files in REQUIRED must import it (otherwise a file would
//       silently drop out of view together with its guards). What is read: the write calls of `fs` (PATTERN: the synchronous and
//       asynchronous ones, `fs.promises.*`, `createWriteStream`, `openSync` — also as a value, `rm = fs.rmSync`) and every import
//       from `node:fs/promises` or a named write import from `node:fs`. Comment lines do not count.
//   (2) Every hit line is (a) AT THE GUARD — an `if (!<helper>(` stands in the same line BEFORE the call —, (b) IN THE BLOCK of a
//       guard — the line that opens the enclosing block is `if (!<helper>(…)) {` —, or (c) named in ALLOWED: file, function, the
//       lines, kind and reason. The kinds:
//         g2-branch      the old path BEHIND a guard of the same function (`behind` stands in the body before the line) — or,
//                       with `over`, a helper function that is called ONLY from this function behind the guard;
//         without-instance  only without a project instance (`behind` is the switch that branches off earlier with an instance);
//         b-location         a place in B that no container mounts (data folder, login stock, workspace root);
//         own-tmp     the own temp folder (mkdtemp in os.tmpdir()) in the runtime-folder case, otherwise the old path;
//         anchor-kind    direct children of the runtime root: recursive `mkdirSync` does not follow a link AT THIS place
//                       (measured, Node 22/24: dangling ENOENT, otherwise nothing created);
//         individual       not recursive, ONE name that does not exist in B (random id): a link there fails by itself.
//       Red: a line without guard and without entry, a kind outside the list, an entry without reason, a count that is off (the
//       table may only shrink), a `behind` missing in the body, an `over` that is called where no guard stands before it.
//   (3) The state before the repair is red — each file from REQUIRED inserted singly, without the import rule (otherwise the red
//       would be a gift).
//   (4) The archives of a ZIP source (projectbox/setup/archive.js): B writes them ONLY via runtime/real-path.js `writeInArea` with
//       the area `areaInRuntimeFolder(…)` and `offset` (the SAME offset rule as the pieces of a provisioning — no second append
//       path), removes them via `removeInRuntimeFolder`, and does not import `node:fs` at all. Built-in sabotage: another area,
//       `append` instead of `offset`, an import of `node:fs`, an `fs.writeFileSync` => red.
// The built-in sabotage shows every rule red.
//
// WHAT THIS GUARD DOES NOT SEE: whether the guard checks the same path the old path writes afterwards; writers outside the files that
// import the sheet (a NEW file that gets a runtime path and writes only shows up once it uses the sheet — the map in runs/README.md
// and the head of runs/runtime-write.js stand for that); child processes (ffmpeg writes into its own temp folder in the
// runtime-folder case, see ALLOWED captures.js; `cp -a` in projectbox/cli-home.js copyLocal gets a checked parent folder — cp
// creates the name itself, a link that appears BETWEEN lstat and cp remains a race; git is a follow-up); mount sources dockerd
// follows — runtime-read.test.js holds those by behaviour (projectbox/instance.js SOURCE_REFERENCE).
// THE READ SIDE is deliberately NOT a guard: the files here contain 39 read calls by path name, most on places in B (data folder,
// home, login stock), and the switch has a different form at each site (`?? fs.readFileSync`, `readInRuntimeFolder` with an
// instance, area of an instance, descriptor via `openFromRuntimeFolder`) — a line rule would be a list of exceptions, not a guard.
// runtime-read.test.js holds the read sites by behaviour.
//
// COUNTER-TESTS: (3) is built into this file; in addition one guard removed each in the working tree —
// `if (!writeInRuntimeFolder(rec.outputFile, text)) {` -> `{` in providers/agent-runtime.js => (2) red with two lines; the line
// `if (copyInRuntimeFolder(src, dst, { onlyIfMissing: true })) continue;` in channels/messages.js deleted => (2) red ("the guard
// ... is not before it").
//
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/runtime-write-guard.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "server");
const REPO = path.resolve(SERVER, "..", "..", "..", "..");
const BEFORE = "1be1ed5e";
// One write site per runtime writer as it stood at BEFORE (before the repair), in its function, without the guard in front —
// reduced from the files of that state to the first site the guard reported there.
const beforeFn = (header, ...body) => [header, ...body.map((z) => `  ${z}`), "}", ""].join("\n");
const BEFORE_REPAIR = {
  "browser-profiles.js": beforeFn("function copyFileAtomic(src, dst) {", 'const tmp = dst + ".cbase-tmp";', "fs.mkdirSync(path.dirname(dst), { recursive: true });", "fs.copyFileSync(src, tmp);"),
  "browsers.js": beforeFn("function scheduleSaveTabs(s, urls) {", "try { fs.writeFileSync(tabsFile(s), JSON.stringify({ urls })); } catch {}"),
  "captures.js": beforeFn("function writeManifest(m) {", "fs.writeFileSync(manifestPath(m.chatId, m.id), JSON.stringify(m, null, 2));"),
  "channels/messages.js": beforeFn("function stageChannelFiles(src, dst, target) {", "fs.mkdirSync(target, { recursive: true });", "fs.copyFileSync(src, dst);"),
  "chats/routes.js": beforeFn("function captureKeyOf(dir) {", "fs.mkdirSync(dir, { recursive: true });"),
  "dynworkflows/approval.js": beforeFn("function createCard(file, card) {", "fs.mkdirSync(path.dirname(file), { recursive: true });", "fs.writeFileSync(file, JSON.stringify(card));"),
  "dynworkflows/run.js": beforeFn("async function startChecked(folder) {", "fs.mkdirSync(folder, { recursive: true });"),
  "projectbox/cli-home.js": beforeFn("export function prefillHome(target, before) {", 'writeAtomic(target, JSON.stringify(before, null, 2) + "\\n", 0o600);'),
  "projectbox/instance.js": beforeFn("async function creation(mounts) {", 'for (const m of mounts) if (m.condition === "create") fs.mkdirSync(m.source, { recursive: true });'),
  "providers/agent-runtime.js": beforeFn("function writeOutputFile(rec, text) {", "fs.mkdirSync(path.dirname(rec.outputFile), { recursive: true });", "fs.writeFileSync(rec.outputFile, text);"),
  "runs/agents.js": beforeFn("export function cleanUpAgent(chatId, agentId, { rm = fs.rmSync } = {}) {", "for (const p of agentTraces(chatId, agentId)) rm(p, { recursive: true, force: true });"),
  "runs/outputs.js": beforeFn("export function createOutputLocation(dir) {", "fs.mkdirSync(dir, { recursive: true });"),
  "runs/runtime-location.js": beforeFn("function move(from, to) {", "if (!fs.existsSync(to)) {", "  fs.mkdirSync(path.dirname(to), { recursive: true });", "  rename(from, to);", "  return;", "}"),
  "runs/session-transfer.js": beforeFn("function copyFile(from, to) {", "fs.mkdirSync(path.dirname(to), { recursive: true });", 'fs.copyFileSync(from, to + ".move");'),
  "toolchain/mcp-config.js": beforeFn("export function writeMcpConfig(filePath, mcpServers) {", "fs.writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2));"),
  "toolchain/playwright.js": beforeFn("export function playwrightMcpEntry(userDataDir, headless) {", "fs.mkdirSync(path.dirname(playwrightConfigPath(userDataDir, headless)), { recursive: true });"),
  "workflows/graph-background.js": beforeFn("function runEnds(file, content) {", 'try { fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\\n"); } catch (e) { console.error("[graph-background] output file:", e?.message || e); }'),
  "workflows/graph-start.js": beforeFn("function copyAttachments(paths, target) {", "fs.mkdirSync(target, { recursive: true });"),
};
const SHEET = "runs/runtime-write.js";

// The files that write into a runtime folder (see the head of runtime-write.test.js).
const REQUIRED = [
  "browser-profiles.js", "browsers.js", "captures.js", "channels/messages.js", "chats/routes.js", "dynworkflows/approval.js",
  "dynworkflows/run.js", "projectbox/cli-home.js", "projectbox/instance.js", "providers/agent-runtime.js", "runs/agents.js", "runs/outputs.js", "runs/runtime-location.js",
  "runs/session-transfer.js", "toolchain/mcp-config.js", "toolchain/playwright.js", "workflows/graph-background.js",
  "workflows/graph-start.js",
];
// Same duty (import of the sheet, read in (1)/(2)), but NOT in (3) — the file did not exist at the old state. Its form is held
// additionally by (4).
const REQUIRED_SINCE_AN11 = ["projectbox/setup/archive.js"];

const HELPER = "writeInRuntimeFolder|createFolderInRuntimeFolder|copyInRuntimeFolder|removeInRuntimeFolder|renameInRuntimeFolder|cloneWithoutReference";
const AT_GUARD = new RegExp(`\\bif \\(!\\s*(?:${HELPER})\\(`);
const GUARD_BLOCK = new RegExp(`\\bif \\(!\\s*(?:${HELPER})\\(.*\\{\\s*$`);
const WRITE = "writeFileSync|appendFileSync|mkdirSync|copyFileSync|cpSync|renameSync|rmSync|unlinkSync|symlinkSync|mkdtempSync|rmdirSync|linkSync|truncateSync|utimesSync|chmodSync|openSync|createWriteStream|writeFile|appendFile|mkdir|copyFile|cp|rename|rm|unlink|symlink|rmdir|truncate";
const PATTERN = [
  new RegExp(`\\bfs\\.(?:${WRITE})\\b`), // also as a value (`rm = fs.rmSync` — that is how the agent clean-up stood before the repair)
  new RegExp(`\\bfs\\.promises\\.(?:${WRITE}|open|utimes|chmod|link|mkdtemp)\\(`),
  /["']node:fs\/promises["']/,
  new RegExp(`import\\s*\\{[^}]*\\b(?:${WRITE}|promises)\\b[^}]*\\}\\s*from\\s*["']node:fs["']`),
];
const KINDS = new Set(["g2-branch", "without-instance", "b-location", "own-tmp", "anchor-kind", "individual"]);
const WITH_BEHIND = new Set(["g2-branch", "without-instance"]);

// The named sites (header, (2c)). `rows`: ONE hit line per entry that contains the wording (listed twice = two lines); `fn`: the
// function they are in.
const ALLOWED = [
  { file: "browser-profiles.js", fn: "copyFileAtomic", kind: "g2-branch", behind: "if (copyInRuntimeFolder(src, dst, { times: true })) return;",
    rows: ["fs.mkdirSync(path.dirname(dst), { recursive: true });", "fs.copyFileSync(src, tmp);", "fs.utimesSync(tmp, stat.atimeMs / 1000, stat.mtimeMs / 1000);", "fs.renameSync(tmp, dst);", "try { fs.rmSync(tmp, { force: true }); } catch {}"],
    reason: "stock <-> flat profile (old path); if one side is in the runtime folder, the sheet copies" },
  { file: "browser-profiles.js", fn: "cloneTree", kind: "g2-branch", behind: "const k = cloneWithoutReference(from, to,",
    rows: ["fs.mkdirSync(to, { recursive: true });", "fs.copyFileSync(src, dst);", "fs.utimesSync(dst, stat.atimeMs / 1000, stat.mtimeMs / 1000);"],
    reason: "old path; if one side is in the runtime folder, the sheet clones (`if (k) return …`)" },
  { file: "browser-profiles.js", fn: "saveChatLogins", kind: "b-location",
    rows: ["fs.mkdirSync(path.join(jar, \"Default\"), { recursive: true });"],
    reason: "the login stock — both callers (do-run.js, mcp-config.js) pass `vorrat: loginStockRoot()`, flat in B, in no container" },
  { file: "captures.js", fn: "startRecording", kind: "g2-branch", behind: "const own = createFolderInRuntimeFolder(dir);",
    rows: ["else fs.mkdirSync(framesDir, { recursive: true });"],
    reason: "the frames under `dir` only without a runtime folder (old path); with it `own` (line before)" },
  { file: "captures.js", fn: "startRecording", kind: "own-tmp",
    rows: ["if (own) framesDir = fs.mkdtempSync(path.join(os.tmpdir(), \"cbase-capture-\"));"],
    reason: "the own temp folder of the frames in os.tmpdir()" },
  { file: "captures.js", fn: "tick", kind: "own-tmp",
    rows: ["fs.writeFileSync(path.join(framesDir, `f-${String(rec.frames).padStart(5, \"0\")}.jpg`), Buffer.from(f.data, \"base64\"));"],
    reason: "`framesDir` is the own temp folder in the runtime-folder case (startRecording, `own`), otherwise the old path" },
  { file: "captures.js", fn: "doFinalize", kind: "own-tmp",
    rows: ["try { fs.rmSync(rec.framesDir, { recursive: true, force: true }); } catch {}"],
    reason: "ditto; ffmpeg writes the video there and the sheet brings it to its place" },
  { file: "channels/messages.js", fn: "depositChannelFiles", kind: "b-location",
    rows: ["fs.mkdirSync(dir, { recursive: true });", "fs.writeFileSync(path.join(dir, file), d.data);", "else fs.copyFileSync(d.src, path.join(dir, file));"],
    reason: "`DIRS.channelFiles/<channel>` — data folder of B, in no container; the source `d.src` is read within the area of an instance or in the runtime folder by `channelSourceCopy` via the descriptor, `copyFileSync` only with neither (old path)" },
  { file: "channels/messages.js", fn: "stageChannelFiles", kind: "g2-branch", behind: "if (copyInRuntimeFolder(src, dst, { onlyIfMissing: true })) continue;",
    rows: ["fs.mkdirSync(target, { recursive: true });", "fs.copyFileSync(src, dst);"],
    reason: "attachments of a chat without a runtime folder (old path)" },
  { file: "dynworkflows/approval.js", fn: "writeRuling", kind: "individual",
    rows: ["try { fs.rmSync(jobFileExisting(chatId, ruling.requestId), { force: true }); }"],
    reason: "`<requestId>.json` (random UUID), not recursive: a link at that place fails by itself; through a swapped intermediate folder it would only hit a file of this name in B — which does not exist" },
  { file: "projectbox/cli-home.js", fn: "writeAtomic", kind: "g2-branch", over: "createCliHome",
    behind: "if (!writeInRuntimeFolder(target, text, { mode: 0o600 })) {",
    rows: ["fs.writeFileSync(tmp, text, { mode });", "fs.renameSync(tmp, target);", "} catch (e) { try { fs.rmSync(tmp, { force: true }); }"],
    reason: "the `.claude.json` of a CLI home outside a runtime folder (old path) — only from createCliHome behind the guard" },
  { file: "projectbox/cli-home.js", fn: "enterCodexTrust", kind: "b-location",
    rows: ["fs.appendFileSync(configPath, attachment);"],
    reason: "the config.toml of B (`~/.codex/config.toml`) — no container mounts it" },
  // projectbox/vscode-upfront.js imports the sheet only to LOOK into the `.vscode-server` of a project (`areaInRuntimeFolder` +
  // descriptor, read-only; likewise the trace of the used version in `.vscode-server/data/Machine` — `readTrace`, also read-only).
  // B never writes into the project folder — the script in the container does that (it also creates a missing `bin` there). B
  // writes only at two places no container mounts (head of the module).
  { file: "projectbox/vscode-upfront.js", fn: "removeInB", kind: "b-location",
    rows: ["try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) {"],
    reason: "the ONE delete site of the module (projectbox-rm-in-b.test.js): only cache and helper folder — the cache `<data>/vscode-server-upfront/` — data folder of B, listed in the setup module `neverMounted` (no container mounts it); `~/.vscode-remote-containers/bin` of B (the Dev Containers helper) — listed in `neverMounted`" },
  { file: "projectbox/vscode-upfront.js", fn: "rememberDenied", kind: "b-location",
    rows: ["const fd = fs.openSync(part, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);", "fs.renameSync(part, deniedFile(folder, info.commit));"],
    reason: "the marker `<commit>.denied` in the cache — the cache `<data>/vscode-server-upfront/` — data folder of B, listed in `neverMounted` (no container mounts it)" },
  { file: "projectbox/vscode-upfront.js", fn: "createCache", kind: "b-location",
    rows: ["fs.mkdirSync(folder, { recursive: true, mode: 0o700 });"],
    reason: "the cache `<data>/vscode-server-upfront/` — data folder of B, listed in `neverMounted` (no container mounts it); afterwards checked as a real folder" },
  { file: "projectbox/vscode-upfront.js", fn: "load", kind: "b-location",
    rows: ["const fd = fs.openSync(target, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);", "await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(target, { fd }), { signal: ac.signal });"],
    reason: "the download `<commit>.tar.gz.part` into the cache — the cache `<data>/vscode-server-upfront/` — data folder of B, listed in `neverMounted` (no container mounts it)" },
  { file: "projectbox/vscode-upfront.js", fn: "writeMeta", kind: "b-location",
    rows: ["const fd = fs.openSync(part, O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW || 0), 0o600);", "fs.renameSync(part, target);"],
    reason: "`<commit>.json` in the cache — the cache `<data>/vscode-server-upfront/` — data folder of B, listed in `neverMounted` (no container mounts it)" },
  { file: "projectbox/vscode-upfront.js", fn: "fetchTarball", kind: "b-location",
    rows: ["fs.renameSync(part, tarballFile(folder, info.commit));"],
    reason: "the checked tarball in the cache — the cache `<data>/vscode-server-upfront/` — data folder of B, listed in `neverMounted` (no container mounts it)" },
  { file: "projectbox/vscode-upfront.js", fn: "helperInB", kind: "b-location",
    rows: ["fs.mkdirSync(tmp, { mode: 0o755 }); // not recursive: an existing name throws (EEXIST)", "if (entry.meta?.buildTime) fs.utimesSync(tmp, entry.meta.buildTime, entry.meta.buildTime);", "try { fs.renameSync(tmp, target); } catch (e) {"],
    reason: "`~/.vscode-remote-containers/bin` of B (the Dev Containers helper) — listed in `neverMounted`; only if Dev Containers has already created it (both real folders, no link)" },
  // projectbox/setup/routes.js imports the sheet (the runtime folder of the POST, `~/.local` per project — at the guard) and in
  // addition creates the PROJECT FOLDER itself.
  { file: "projectbox/setup/routes.js", fn: "createProjectFolder", kind: "b-location",
    rows: ["try { fs.mkdirSync(p); }", "try { fs.rmdirSync(p); }"],
    reason: "the project folder `<ws>/<slug>`: direct child of the workspace root (no container mounts it), NOT recursive, free beforehand per lstat (a link there => next suffix); `rmdir` follows no link. At this moment there is no project container yet — only the setup creates it afterwards" },
  { file: "projectbox/setup/routes.js", fn: "projectCreateInOps", kind: "b-location",
    rows: ["try { fs.rmdirSync(projPath); } catch { /* stays */ }", "try { fs.rmdirSync(projPath); } catch { /* */ }"],
    reason: "the roll-back of the just created, empty project folder (createProjectFolder) in the synchronous part of the POST, before the 201 — no container yet; `rmdir` follows no link and takes only an empty folder" },
  // The package caches in projectbox/instance.js are no longer a b-location: the sources with `create` are created by
  // `createSourcesOn` — at the guard (`if (!createFolderInRuntimeFolder(m.source)) fs.mkdirSync(…)`), because `cli-vscode-server`
  // lives in the runtime folder; the caches in the home of B take the old path behind the guard.
  { file: "providers/connectors/codex.js", fn: "runOnceCodex", kind: "own-tmp",
    rows: ["try { fs.unlinkSync(outFile); } catch {}", "if (imageFolder) { try { fs.rmSync(imageFolder, { recursive: true, force: true }); } catch {} }"],
    reason: "the result file of a oneshot in os.tmpdir() (random name) and the own image folder (mkdtemp, imagesAsFiles); codex.js imports the sheet only to READ the rollouts from project homes (`openFromRuntimeFolder`)" },
  // The images of a Codex oneshot (caps.vision): `-i` takes only paths — an own folder per call in os.tmpdir().
  { file: "providers/connectors/codex.js", fn: "imagesAsFiles", kind: "own-tmp",
    rows: ["const folder = fs.mkdtempSync(path.join(os.tmpdir(), \"cbase-codex-images-\"));", "fs.writeFileSync(p, Buffer.from(String(b.dataB64), \"base64\"), { mode: 0o600 });"],
    reason: "the images of a oneshot as files for `-i`, in the own mkdtemp folder in os.tmpdir() (runOnceCodex never runs with an instance)" },
  // Codex prefix: imports the sheet only to READ the rollout (like codex.js). The `openSync` is O_RDONLY without O_CREAT — it
  // creates and writes nothing; it applies only when the sheet says `null` (outside a runtime folder, the Codex home of B, old
  // path). In the runtime folder `openFromRuntimeFolder` opens without a link or throws (=> `false`).
  { file: "providers/connectors/codex-prefix.js", fn: "prefixInThread", kind: "g2-branch",
    behind: "fd = file.project ? openFromRuntimeFolder(file.p) : null;",
    rows: ["if (fd === null) fd = fs.openSync(file.p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));"],
    reason: "open the rollout for reading, only outside a runtime folder (old path: the Codex home of B); in the runtime folder the sheet opens without a link" },
  // The compaction by Codex (codexCompactedFrom): the same reading path as the prefix — O_RDONLY without O_CREAT.
  { file: "providers/connectors/codex.js", fn: "codexCompactedFrom", kind: "g2-branch",
    behind: "fd = r.project ? openFromRuntimeFolder(r.p) : null;",
    rows: ["if (fd === null) fd = fs.openSync(r.p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));"],
    reason: "open the growth of the rollout for reading, only outside a runtime folder (old path: the Codex home of B); in the runtime folder the sheet opens without a link" },
  { file: "providers/agent-runtime.js", fn: "makeWorktree", kind: "without-instance", behind: "if (kg) return worktreeInProject(",
    rows: ["fs.mkdirSync(root, { recursive: true });"],
    reason: "`isolation: \"worktree\"` without a project instance (old path); with an instance worktreeInProject creates it in the container" },
  { file: "runs/runtime-location.js", fn: "removeTrace", kind: "without-instance", behind: "if (withInstance) {",
    rows: ["export function removeTrace(filePath, location, { rm = rmSeam || fs.rmSync,"],
    reason: "with an instance row the container deletes (`rootFallback`), B only without an instance or without a way; guard runtime-location.test.js (5b)" },
  { file: "runs/runtime-location.js", fn: "createLocation", kind: "anchor-kind",
    rows: ["if (location?.projectId) for (const d of [location.scratch, location.attachments, location.outputs]) fs.mkdirSync(d, { recursive: true });"],
    reason: "scratch/attachments/ausgaben are children of the runtime root (the mount point)" },
  { file: "runs/runtime-location.js", fn: "rename", kind: "g2-branch", over: "move",
    behind: "if (areaInRuntimeFolder(from) || areaInRuntimeFolder(to)) { moveWithoutReference(from, to); return; }",
    rows: ["try { fs.renameSync(from, to); } catch (e) {", "fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, force: true });", "fs.rmSync(from, { recursive: true, force: true });"],
    reason: "flat <-> flat (old path), only from move behind the area guard" },
  { file: "runs/runtime-location.js", fn: "move", kind: "g2-branch",
    behind: "if (areaInRuntimeFolder(from) || areaInRuntimeFolder(to)) { moveWithoutReference(from, to); return; }",
    rows: ["fs.mkdirSync(path.dirname(to), { recursive: true });", "fs.rmSync(from, { recursive: true, force: true });", "fs.rmSync(from, { recursive: true, force: true });"],
    reason: "flat <-> flat (old path); the recursion goes through the guard again" },
  { file: "runs/runtime-location.js", fn: "copyFallsMissing", kind: "g2-branch", behind: "const inLocation = copyInRuntimeFolder(from, to, { onlyIfMissing: true, times: true });",
    rows: ["fs.mkdirSync(path.dirname(to), { recursive: true });", "fs.copyFileSync(from, tmp);", "fs.utimesSync(tmp, st.atime, st.mtime);", "fs.renameSync(tmp, to);", "try { fs.rmSync(tmp, { force: true }); }"],
    reason: "attachment flat -> flat (old path)" },
  // The monitors of a chat.
  { file: "runs/monitors.js", fn: "writeInventory", kind: "b-location",
    rows: ["if (!rows.length) { fs.rmSync(f, { force: true }); return; }", "fs.writeFileSync(f, JSON.stringify(rows));"],
    reason: "the inventory of live monitors `<DIRS.data>/monitors-open.json` — data folder of B, in no container" },
  { file: "runs/monitors.js", fn: "openLog", kind: "g2-branch", behind: "const fd = openForAppendInRuntimeFolder(file);",
    rows: ["return fd ?? fs.openSync(file, \"a\");"],
    reason: "the log file of a monitor in the output place without a runtime folder (old path); in the runtime folder the sheet opens the descriptor without a link" },
  { file: "runs/session-transfer.js", fn: "copyFile", kind: "g2-branch", behind: "if (copyInRuntimeFolder(from, to, { times: true })) return;",
    rows: ["fs.mkdirSync(path.dirname(to), { recursive: true });", "fs.copyFileSync(from, tmp);", "fs.utimesSync(tmp, st.atime, st.mtime);", "fs.renameSync(tmp, to);", "try { fs.rmSync(tmp, { force: true }); }"],
    reason: "session between two CLI homes in B (old path)" },
  { file: "runs/session-transfer.js", fn: "copyFolder", kind: "g2-branch", behind: "try { k = cloneWithoutReference(from, tmp); }",
    rows: ["fs.cpSync(from, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });", "fs.rmSync(to, { recursive: true, force: true });", "fs.renameSync(tmp, to);", "try { fs.rmSync(tmp, { recursive: true, force: true }); }"],
    reason: "ditto (old path); `if (k) { … return; }` before it" },
  { file: "toolchain/mcp-config.js", fn: "writeWorkspaceMcpJson", kind: "b-location",
    rows: ["fs.writeFileSync(path.join(wsPath, \".mcp.json\"), JSON.stringify(cfg, null, 2));"],
    reason: "the root of the workspace — project folders and runtime folders are mounted, never the workspace root" },
  { file: "workflows/graph-start.js", fn: "copyAttachments", kind: "g2-branch", behind: "(inLocation = copyInRuntimeFolder(source, dest, { onlyIfMissing: true })) === \"present\"",
    rows: ["fs.mkdirSync(target, { recursive: true });", "fs.copyFileSync(source, dest);"],
    reason: "child chat without a runtime folder (old path), behind `if (!inLocation)`" },
];

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const rel = (p) => path.relative(SERVER, p).split(path.sep).join("/");
const importedSheet = (text, file) => {
  const target = path.posix.relative(path.posix.dirname(file), SHEET);
  const spec = target.startsWith(".") ? target : `./${target}`;
  return new RegExp(`from\\s+["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(text);
};

function sources() {
  const out = new Map();
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") go(p); } else if (e.name.endsWith(".js")) out.set(rel(p), fs.readFileSync(p, "utf8"));
    }
  };
  go(SERVER);
  return out;
}

const comment = (z) => /^\s*(?:\/\/|\*|\/\*)/.test(z);
const HEADER = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(\s*)(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$/;
const inset = (z) => z.match(/^\s*/)[0].length;

// The enclosing function of a line: the next header above with a smaller indent — or the line itself if it is a header (a writer as
// default value of a parameter, `rm = fs.rmSync`).
function functionOf(rows, i) {
  const k = rows[i].match(HEADER);
  if (k) return { name: k[2] || k[4], start: i, header: true };
  const e = inset(rows[i]);
  for (let j = i - 1; j >= 0; j--) {
    const m = rows[j].match(HEADER);
    if (m && inset(rows[j]) < e) return { name: m[2] || m[4], start: j };
  }
  return { name: null, start: 0 };
}

// Does the line that opens the block around line i open a guard `if (!<helper>(…)) {`?
function inGuardBlock(rows, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (comment(rows[j])) continue;
    depth += (rows[j].match(/\{/g) || []).length - (rows[j].match(/\}/g) || []).length;
    if (depth > 0) return GUARD_BLOCK.test(rows[j]);
  }
  return false;
}

function atGuard(z) {
  const r = z.match(AT_GUARD);
  if (!r) return false;
  const call = PATTERN.map((m) => z.search(m)).filter((x) => x >= 0);
  return call.every((x) => x > r.index);
}

function hits(files, only = null) {
  const out = [];
  for (const [file, text] of files) {
    if (file === SHEET) continue;
    if (!(only ? only.has(file) : importedSheet(text, file) || REQUIRED.includes(file) || REQUIRED_SINCE_AN11.includes(file))) continue;
    const rows = text.split("\n");
    rows.forEach((z, i) => {
      if (comment(z) || !PATTERN.some((m) => m.test(z))) return;
      const kind = atGuard(z) ? "at-guard" : inGuardBlock(rows, i) ? "in-block" : "open";
      out.push({ file, row: i + 1, text: z.trim(), kind, fn: functionOf(rows, i) });
    });
  }
  return out;
}

function body(rows, name) {
  const i = rows.findIndex((z) => { const m = z.match(HEADER); return m && (m[2] || m[4]) === name; });
  if (i < 0) return null;
  const e = inset(rows[i]);
  let j = i + 1;
  while (j < rows.length && !(inset(rows[j]) === e && /^\s*\}/.test(rows[j]))) j++;
  return { start: i, end: j };
}

function violations(files, { table = ALLOWED, withImport = true, only = null } = {}) {
  const v = [];
  if (withImport) for (const d of [...REQUIRED, ...REQUIRED_SINCE_AN11]) if (!importedSheet(files.get(d) || "", d)) v.push(`${d}: does not import ${SHEET} (REQUIRED)`);
  const all = hits(files, only);
  const open = all.filter((t) => t.kind === "open");
  const gedeckt = new Set();
  for (const e of table) {
    if (!KINDS.has(e.kind)) v.push(`${e.file} ${e.fn}: kind "${e.kind}" does not exist (${[...KINDS].join(", ")})`);
    if (!e.reason) v.push(`${e.file} ${e.fn}: no reason`);
    if (WITH_BEHIND.has(e.kind) && !e.behind) v.push(`${e.file} ${e.fn}: kind ${e.kind} without \`behind\``);
    const rows = (files.get(e.file) || "").split("\n");
    const desired = new Map();
    for (const w of e.rows) desired.set(w, (desired.get(w) || 0) + 1);
    for (const [w, n] of desired) {
      const h = open.filter((t) => t.file === e.file && t.fn.name === e.fn && t.text.includes(w));
      if (h.length !== n) v.push(`${e.file} ${e.fn}: "${w}" ${h.length}x instead of ${n}x — update the table (shrink only) or put the site behind the guard`);
      for (const t of h) {
        gedeckt.add(`${t.file}:${t.row}`);
        if (!e.behind) continue;
        if (e.over) continue; // below, per call
        // A writer as default value in the header: the guard must stand in the body (it takes effect before the call).
        const r = t.fn.header ? body(rows, e.fn) : null;
        const beforehand = r ? rows.slice(r.start, r.end).join("\n") : rows.slice(t.fn.start, t.row - 1).join("\n");
        if (!beforehand.includes(e.behind)) v.push(`${e.file}:${t.row} (${e.fn}): the guard "${e.behind}" is not before it`);
      }
    }
    if (e.over) {
      // Every call of the helper function lies in `over`, behind the guard.
      const calls = [];
      rows.forEach((z, i) => {
        if (comment(z) || HEADER.test(z)) return;
        if (new RegExp(`\\b${e.fn}\\(`).test(z)) calls.push(i);
      });
      const r = body(rows, e.over);
      if (!calls.length) v.push(`${e.file}: ${e.fn} is called nowhere — delete the entry`);
      for (const i of calls) {
        const f = functionOf(rows, i);
        if (f.name !== e.over || !r) { v.push(`${e.file}:${i + 1}: ${e.fn}( outside ${e.over}`); continue; }
        if (!rows.slice(r.start, i).join("\n").includes(e.behind)) v.push(`${e.file}:${i + 1}: ${e.fn}( before the guard "${e.behind}"`);
      }
    }
  }
  for (const t of open) {
    if (!gedeckt.has(`${t.file}:${t.row}`)) v.push(`write site without guard and without entry: ${t.file}:${t.row} (${t.fn.name}) ${t.text}`);
  }
  return v;
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────

test("(1)/(2) every write site in the runtime writers stands at the guard, in its block, or is named", () => {
  const d = sources();
  assert.ok(d.size > 200, `only ${d.size} files found — the path is wrong`);
  assert.deepEqual(violations(d), []);
  const t = hits(d);
  const z = (a) => t.filter((x) => x.kind === a).length;
  const files = new Set(t.map((x) => x.file));
  console.log(`# write sites in ${files.size} runtime writers: ${t.length} lines — at the guard ${z("at-guard")}, in block ${z("in-block")}, named ${z("open")} (${ALLOWED.length} entries)`);
});

test("(3) the state before the repair is red — each file from REQUIRED singly, without the import rule", () => {
  const d = sources();
  assert.deepEqual(Object.keys(BEFORE_REPAIR).sort(), [...REQUIRED].sort(), "every file from REQUIRED needs its form before the repair");
  for (const file of REQUIRED) {
    const x = new Map(d);
    x.set(file, BEFORE_REPAIR[file]);
    const v = violations(x, { withImport: false }).filter((s) => s.includes(file) && /without guard|is not before it|before the guard|\( outside /.test(s));
    assert.notDeepEqual(v, [], `${file} at state ${BEFORE}: no open write site noticed`);
    console.log(`# ${BEFORE} ${file}: ${v.length} — ${v[0]}`);
  }
});

test("built-in sabotage: every rule goes red", () => {
  const d = sources();
  const including = (file, fn, opts) => {
    const x = new Map(d);
    const old = x.get(file) || "";
    const fresh = fn(old);
    assert.notEqual(fresh, old, `${file}: the sabotage did not apply`);
    x.set(file, fresh);
    return violations(x, opts);
  };
  const cases = {
    "guard before a block removed": () => including("providers/agent-runtime.js", (t) => t.replace("if (!writeInRuntimeFolder(rec.outputFile, text)) {", "{")),
    "guard in the same line removed": () => including("toolchain/mcp-config.js", (t) => t.replace("if (!writeInRuntimeFolder(filePath, content)) fs.writeFileSync", "fs.writeFileSync")),
    "guard BEHIND the call": () => including("toolchain/mcp-config.js", (t) => t.replace("if (!writeInRuntimeFolder(filePath, content)) fs.writeFileSync(filePath, content);", "fs.writeFileSync(filePath, content); if (!writeInRuntimeFolder(filePath, content)) {}")),
    "new write site": () => including("captures.js", (t) => `${t}\nfunction fresh(dir) {\n  fs.writeFileSync(path.join(dir, "x"), "");\n}\n`),
    "fs.promises.writeFile": () => including("captures.js", (t) => `${t}\nasync function fresh(dir) {\n  await fs.promises.writeFile(dir, "");\n}\n`),
    "Import from node:fs/promises": () => including("captures.js", (t) => `import { writeFile } from "node:fs/promises";\n${t}`),
    "named write import from node:fs": () => including("captures.js", (t) => `import { copyFileSync } from "node:fs";\n${t}`),
    "the guard before an old-path branch is missing": () => including("channels/messages.js", (t) => t.replace("        if (copyInRuntimeFolder(src, dst, { onlyIfMissing: true })) continue;\n", "")),
    "helper function (over) called before the guard": () => including("runs/runtime-location.js", (t) => t.replace("function move(from, to) {\n", "function move(from, to) {\n  rename(from, to);\n")),
    "helper function (over) called elsewhere": () => including("runs/runtime-location.js", (t) => `${t}\nexport function foreign(a, b) {\n  rename(a, b);\n}\n`),
    "guard before a helper function (over) removed": () => including("projectbox/cli-home.js", (t) => t.replace("if (!writeInRuntimeFolder(target, text, { mode: 0o600 })) {", "{")),
    "REQUIRED file without import of the sheet": () => including("toolchain/playwright.js", (t) => t.replace('import { writeInRuntimeFolder } from "../runs/runtime-write.js";\n', "")),
    "new file with import and open site": () => { const x = new Map(d); x.set("fresh/location.js", 'import { writeInRuntimeFolder } from "../runs/runtime-write.js";\nfunction f(p) {\n  fs.writeFileSync(p, "");\n}\n'); return violations(x); },
    "entry without site": () => violations(d, { table: [...ALLOWED, { file: "captures.js", fn: "doFinalize", kind: "b-location", rows: ["fs.rmSync(exists-not"], reason: "x" }] }),
    "grown count": () => violations(d, { table: ALLOWED.map((e, i) => (i === 0 ? { ...e, rows: [...e.rows, e.rows[0]] } : e)) }),
    "unknown kind": () => violations(d, { table: ALLOWED.map((e, i) => (i === 0 ? { ...e, kind: "whatever" } : e)) }),
    "entry without reason": () => violations(d, { table: ALLOWED.map((e, i) => (i === 0 ? { ...e, reason: "" } : e)) }),
    "g2-branch without behind": () => violations(d, { table: ALLOWED.map((e, i) => (i === 0 ? { ...e, behind: undefined } : e)) }),
    "wrong function": () => violations(d, { table: ALLOWED.map((e, i) => (i === 0 ? { ...e, fn: "cloneTree" } : e)) }),
  };
  for (const [name, fn] of Object.entries(cases)) assert.notDeepEqual(fn(), [], `${name}: not noticed`);
  // Comments do not count; a guard in the same line before the call and a guard block cover.
  assert.deepEqual(including("captures.js", (t) => `${t}\n// fs.writeFileSync(x, "");\n *   fs.rmSync(p, { recursive: true })\n`), []);
  assert.deepEqual(including("captures.js", (t) => `${t}\nfunction fresh(p) {\n  if (!writeInRuntimeFolder(p, "")) fs.writeFileSync(p, "");\n  if (!createFolderInRuntimeFolder(p)) {\n    fs.mkdirSync(p, { recursive: true });\n  }\n}\n`), []);
});

// ── (4) The archives of the project setup ─────────────────────────────────────────────────────────────────────────────────

const ARCHIVE = "projectbox/setup/archive.js";

function archiveViolations(text) {
  const v = [];
  if (/from\s+["']node:fs(?:\/promises)?["']/.test(text)) v.push("imports node:fs — B touches the archive only via the descriptor (runtime/real-path.js)");
  if (!importedSheet(text, ARCHIVE)) v.push(`does not import ${SHEET} (area and removal come from there)`);
  const code = text.split("\n").filter((z) => !comment(z) && !/^\s*import\b/.test(z));
  for (const z of code) if (PATTERN.some((m) => m.test(z))) v.push(`fs write call: ${z.trim()}`);
  const calls = code.filter((z) => /\bwriteInArea\(/.test(z));
  if (!calls.length) v.push("no writeInArea( — the guard measures at the wrong place");
  for (const z of calls) {
    if (!/writeInArea\([^,]+,\s*[^,]+,\s*areaInRuntimeFolder\(/.test(z)) v.push(`without the area areaInRuntimeFolder(…): ${z.trim()}`);
    if (!/\boffset\b/.test(z)) v.push(`without offset (the offset rule): ${z.trim()}`);
  }
  if (code.some((z) => /\bappend\b/.test(z))) v.push("append — a second append path next to the offset rule");
  if (!code.some((z) => /\bremoveInRuntimeFolder\(/.test(z))) v.push("no removeInRuntimeFolder( — how does the file go?");
  return v;
}

test("(4) B writes the archives only via writeInArea in the area of the runtime folder with offset — with built-in sabotage", () => {
  const t = sources().get(ARCHIVE);
  assert.ok(t, `${ARCHIVE} is missing`);
  assert.deepEqual(archiveViolations(t), []);
  const chunk = "writeInArea(abs, data, areaInRuntimeFolder(abs), { display: display(archiveId), offset });";
  assert.ok(t.includes(chunk), "the write site of the pieces has changed — update the guard");
  const cases = {
    "another area": t.replace(chunk, "writeInArea(abs, data, [path.dirname(abs)], { display: display(archiveId), offset });"),
    "append instead of offset": t.replace(chunk, "writeInArea(abs, data, areaInRuntimeFolder(abs), { display: display(archiveId), append: true });"),
    "Import of node:fs": `import fs from "node:fs";\n${t}`,
    "fs.writeFileSync": `${t}\nfunction fresh(p, d) {\n  fs.writeFileSync(p, d);\n}\n`,
    "without sheet": t.replace(/import \{[^}]*\} from "\.\.\/\.\.\/runs\/runtime-write\.js";\n/, ""),
  };
  for (const [name, fresh] of Object.entries(cases)) {
    assert.notEqual(fresh, t, `${name}: the sabotage did not apply`);
    assert.notDeepEqual(archiveViolations(fresh), [], `${name}: not noticed`);
  }
});
