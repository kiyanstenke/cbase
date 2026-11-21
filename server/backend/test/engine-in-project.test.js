// The loop engine of a converted project. Main seam through the real server: a chat on the fake preset endpoint
// (agent-harness.mjs startPresetEndpoint), operating mark, fake docker, instance row — and the same chat afterwards
// WITHOUT the operating mark.
//
// The promises, each with the way that breaks it:
//   (P) IN THE PROJECT: Bash runs through `docker exec … cbase-p-<id>` with `-w <project folder>`; Read follows no
//       symlink from the project into the neighbor project (realpath); WebFetch to localhost resp. 127.0.0.1 reaches the
//       service IN the instance (the second loopback address), never the decoy on 127.0.0.1; the engine's cbase MCP starts in
//       the container with the instance's address and token (mcpAccessFor via runs/backend-access.js) — the values only as
//       `-e NAME`, and its requests carry the token: the fence (here every request WITH a token counts as coming from the
//       project network, setFenceSource) filters the project list to the own project and appends the hint.
//   (B) WITHOUT OPERATING MARK: the same chat, the same calls — not a single docker call, Bash in the workspace, Read
//       follows the symlink (as today), WebFetch hits the decoy, the MCP has no token and delivers both projects.
//   (W) The output location `outputs/<chat>` (an ordinary subfolder of the runtime folder) is replaced by a link into the
//       neighbor project: in the project it no longer counts as a root (Read rejected), without the operating mark as
//       today. The backend's readers under the runtime folder: an image attachment that is a link into the neighbor
//       project does not go to the provider as an image nor beyond the attachment route (403), and the script of a dynamic
//       workflow from `outputs/` is "not readable: EOUTSIDE"; without the operating mark all three as today.
//   (C) CODE VIEW (files.js, devtools/code-route.js): the file routes run in B. With an instance none follows a link the
//       project container creates in the project folder (file `note -> ~/.bashrc`, folder `cache -> ~/data`, `dead` without
//       a target), neither on the project level nor on the workspace level (mapping via gitInstanceForWorkspace, path part
//       by path part from the root): read, tree, write, create, rename, delete, upload (also appended) and download are
//       rejected and the target unchanged; deleting and renaming a link move the link itself; a link INSIDE the project and
//       the search stay as they are; a FIFO does not stop B. Without the operating mark as today (the holes too: `dead`
//       creates the file at its target) and without docker.
//
// Counter-tests: providers/tool-runtime.js in its old state => (P) red (Read delivers "NEIGHBOR-SECRET", WebFetch
// "DECOY"); runs/do-run.js without `...backendAccessFor(instance)` => (P) red (no `-e CBASE_TOKEN`, list unfiltered);
// tool-runtime.js, providers/engine.js, chats/routes.js and dynworkflows/run.js in their old states => (W) red; files.js,
// devtools/code-route.js and runtime/real-path.js in their old states => (C) red. No clock: waiting is for the second
// model request (it carries all tool results) and for the server's quiet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { WRAPPER_PATH, openEscalations, openCatchUpKills } from "../electron/server/runtime/inProject.js";
import { setFenceSource } from "../electron/server/projectbox/fence.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { startDynWorkflow } from "../electron/server/dynworkflows/run.js";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";

const IP = await secondLoopback();
const NETWORK = "10.230.5.2";
const FENCE_HINT = "filtered: only the project of this container and the workspace-wide items without a project reference";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const listen = (s, host, port) => new Promise((resolve, reject) => {
  s.once("error", reject);
  s.listen(port, host, () => { s.off("error", reject); resolve(s.address().port); });
});
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });
// The service "in the instance" (IP) and the decoy (127.0.0.1) on the same port — each with its name and the host header.
async function serviceAndDecoy() {
  for (let attempt = 0; ; attempt++) {
    const build = (who) => http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`${who} host=${req.headers.host}`); });
    const inst = build("INSTANCE");
    const port = await listen(inst, IP, 0);
    const decoy = build("DECOY");
    try {
      await listen(decoy, "127.0.0.1", port);
      return { port, shutdown: async () => { await close(inst); await close(decoy); } };
    } catch (e) {
      await close(inst);
      if (e.code !== "EADDRINUSE" || attempt > 20) throw e;
    }
  }
}
const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

test("loop engine in the project: Bash in the container with -w project folder, Read without a symlink out, WebFetch into the instance, cbase MCP with token — without the operating mark everything as today", async () => {
  const fd = await fakeDocker();
  const service = await serviceAndDecoy();
  const R = { root: null, proj: null, outputs: null };
  const requests = {};
  const arrival = {};
  const arrived = (phase) => new Promise((r) => { arrival[phase] = r; });
  const round = async (b) => {
    const user = (b.messages || []).filter((m) => m.role === "user");
    const phase = /PHASE-B/.test(textOf(user[user.length - 1])) ? "b" : "p";
    const ids = new Set((b.messages || []).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    if (ids.has(`${phase}_bash`)) { requests[phase] = b; arrival[phase]?.(b); return { text: "finished" }; }
    return { toolCalls: [
      { id: `${phase}_bash`, name: "Bash", arguments: { command: `pwd > '${R.root}/pwd-${phase}.txt'` } },
      { id: `${phase}_read`, name: "Read", arguments: { file_path: path.join(R.proj, "link.txt") } },
      { id: `${phase}_read_root`, name: "Read", arguments: { file_path: path.join(R.outputs, "secret.txt") } },
      { id: `${phase}_web_ip`, name: "WebFetch", arguments: { url: `http://127.0.0.1:${service.port}/page` } },
      ...(phase === "p" ? [{ id: "p_web_local", name: "WebFetch", arguments: { url: `http://localhost:${service.port}/local` } }] : []),
      { id: `${phase}_list`, name: "mcp__cbase__cbase_projects_list", arguments: {} },
    ] };
  };
  // Every request WITH a token counts as coming from the instance's project network — so the fence shows the token arrived.
  setFenceSource((req) => (req.headers?.["x-cbase-token"] ? NETWORK : req.socket?.remoteAddress));
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, engine } = ctx;
      R.root = ctx.root;
      const npx = path.join(ctx.root, "npx");
      fs.writeFileSync(npx, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(npx, 0o755);
      process.env.NPX_BIN = npx;
      const project = async (name) => {
        const filePath = path.join(ctx.root, "workspace", name);
        fs.mkdirSync(filePath, { recursive: true });
        return { ...(await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) })), path: filePath };
      };
      const till = await project("till");
      const depot = await project("depot");
      R.proj = till.path;
      fs.writeFileSync(path.join(depot.path, "secret.txt"), "NEIGHBOR-SECRET\n");
      fs.symlinkSync(path.join("..", "depot", "secret.txt"), path.join(till.path, "link.txt"));
      const name = `cbase-p-${till.id}`;
      await withEnvironment({ CBASE_DOCKER_BIN: fd.bin }, async () => {
        const { execFileSync } = await import("node:child_process");
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
      });
      const inst = store.createProjectInstance({ projectId: till.id, state: "ready", convertedAt: Date.now(), containerId: name, ip: IP, gateway: "127.0.0.1", subnet: "10.230.5.0/24" });
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: till.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Engine in the project" }) });
      const tool = (b, id) => textOf((b.messages || []).find((m) => m.role === "tool" && m.tool_call_id === id));
      // (W) The chat's output location — replaced in the container by a link into the neighbor project; an image attachment
      // that is a link into the neighbor project; a "script" in the neighbor project, reachable via the output location.
      const lz = path.join(ctx.dataRoot, "data", "projects", till.id);
      R.outputs = path.join(lz, "outputs", chat.id);
      fs.mkdirSync(path.dirname(R.outputs), { recursive: true });
      fs.symlinkSync(depot.path, R.outputs);
      fs.writeFileSync(path.join(depot.path, "image.png"), "NEIGHBOR_IMAGE");
      fs.writeFileSync(path.join(depot.path, "script.js"), "NEIGHBOR - SCRIPT");
      const attachments = path.join(lz, "attachments", chat.id);
      fs.mkdirSync(attachments, { recursive: true });
      fs.symlinkSync(path.join(depot.path, "image.png"), path.join(attachments, "image.png"));
      const IMAGE64 = Buffer.from("NEIGHBOR_IMAGE").toString("base64");
      const fetchAttachment = () => fetch(`${base}/api/chats/${chat.id}/attachments/image.png`, { headers: { Connection: "close" } });
      const dynScript = () => JSON.stringify(startDynWorkflow(store.getChat(chat.id), { scriptPath: path.join(R.outputs, "script.js") }));
      // An absolute path OUTSIDE every runtime folder (here directly in the neighbor project) used to read any file in B with an
      // instance — the parse error then named a word of the file.
      const dynScriptOutside = () => JSON.stringify(startDynWorkflow(store.getChat(chat.id), { scriptPath: path.join(depot.path, "script.js") }));

      // ── (P) In the project ──
      await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" }, async () => {
        const existing = arrived("p");
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "PHASE-P: go", attachments: [{ file: "image.png" }] }) });
        const b = await existing;
        await ctx.waitForQuiet();
        const execs = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && a.args.includes(WRAPPER_PATH));
        const command = (a) => a.args.slice(a.args.indexOf("--") + 1);
        // Bash: in the container, working folder = project folder.
        const bash = execs.find((a) => command(a)[1] === "-c" && command(a)[2].includes("pwd-p.txt"));
        assert.ok(bash, `Bash did not run in the project container: ${JSON.stringify(execs.map(command)).slice(0, 500)}`);
        assert.ok(bash.args.includes(name), "exec in cbase-p-<id>");
        assert.equal(bash.args[bash.args.indexOf("-w") + 1], till.path, "-w is the project folder");
        assert.equal(fs.realpathSync(fs.readFileSync(path.join(ctx.root, "pwd-p.txt"), "utf8").trim()), fs.realpathSync(till.path));
        // Read: no way over the symlink into the neighbor project.
        const read = tool(b, "p_read");
        assert.match(read, /symlink/, read);
        assert.ok(!read.includes("NEIGHBOR-SECRET"), "the neighbor is not readable");
        // (W) the output location as a link is no root.
        const root = tool(b, "p_read_root");
        assert.match(root, /leads out of the allowed area|outside the allowed area/, root);
        assert.ok(!root.includes("NEIGHBOR-SECRET"), "the neighbor is not readable via the output location");
        // (W) no image from the neighbor project to the provider, none via the attachment route, no script.
        assert.ok(!JSON.stringify(b.messages).includes(IMAGE64), "the image attachment from the neighbor project went to the provider");
        const attachment = await fetchAttachment();
        assert.equal(attachment.status, 403, `attachment route: ${attachment.status} ${await attachment.text()}`);
        assert.match(dynScript(), /EOUTSIDE/);
        const outside = dynScriptOutside();
        assert.match(outside, /EOUTSIDE/, outside);
        assert.ok(!outside.includes("NEIGHBOR"), `a word of the neighbor in the error: ${outside}`);
        // WebFetch: the service in the instance, with the URL's host header.
        assert.match(tool(b, "p_web_ip"), new RegExp(`INSTANCE host=127\\.0\\.0\\.1:${service.port}`), tool(b, "p_web_ip"));
        assert.match(tool(b, "p_web_local"), new RegExp(`INSTANCE host=localhost:${service.port}`), tool(b, "p_web_local"));
        // The engine's cbase MCP: in the container, address and token only as names.
        const mcp = execs.find((a) => command(a)[0] === process.execPath && /cbase-mcp\.js$/.test(command(a)[1] || ""));
        assert.ok(mcp, "the engine's cbase MCP did not run in the container");
        const names = mcp.args.flatMap((x, i) => (x === "-e" ? [mcp.args[i + 1]] : []));
        assert.ok(names.includes("CBASE_TOKEN") && names.includes("CBASE_BASE_URL"), `-e ${names.join(" -e ")}`);
        assert.ok(names.every((n) => !n.includes("=")), "no value behind -e");
        const token = tokenFor(store.projectInstance(till.id, "main") || inst);
        assert.ok(fd.calls().every((a) => !a.args.some((x) => String(x).includes(token))), "the token is in no argv");
        // … and its requests carried the token: the fence filters to the own project and says so.
        const list = tool(b, "p_list");
        assert.ok(list.includes(till.id), list);
        assert.ok(!list.includes(depot.id), `unfiltered: ${list}`);
        assert.ok(list.includes(FENCE_HINT), `without the hint: ${list}`);
        // The phase's children are gone (their pgid files drop only when nothing hangs on them any more, no escalation
        // check either) — after that no docker call comes from them.
        const processes = path.join(ctx.dataRoot, "data", "projects", till.id, "processes");
        await waitForTruthy(() => fs.readdirSync(processes).every((f) => !f.endsWith(".pgid")) && openEscalations() === 0 && openCatchUpKills() === 0, "children of phase P ended");
      });

      // ── (B) The same chat without the operating mark ──
      const prior = fd.calls().length;
      const existing = arrived("b");
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "PHASE-B: once more", attachments: [{ file: "image.png" }] }) });
      const b = await existing;
      await ctx.waitForQuiet();
      assert.equal(fd.calls().length, prior, `without the operating mark not a single docker call: ${JSON.stringify(fd.calls().slice(prior - 2))}`);
      assert.equal(fs.realpathSync(fs.readFileSync(path.join(ctx.root, "pwd-b.txt"), "utf8").trim()), fs.realpathSync(ws.path), "Bash in B, in the workspace");
      assert.match(tool(b, "b_read"), /NEIGHBOR-SECRET/, "today Read follows the symlink (only with an instance)");
      // (W) without the operating mark as today: the root, the image, the attachment route, the script.
      assert.match(tool(b, "b_read_root"), /NEIGHBOR-SECRET/, "today the output location counts via its realpath");
      assert.ok(JSON.stringify(b.messages).includes(IMAGE64), "today the image attachment goes to the provider");
      const attachmentToday = await fetchAttachment();
      assert.equal(attachmentToday.status, 200);
      assert.equal(await attachmentToday.text(), "NEIGHBOR_IMAGE");
      assert.ok(!dynScript().includes("EOUTSIDE"), "today the script is readable");
      assert.ok(!dynScriptOutside().includes("EOUTSIDE"), "without an instance scriptPath reads as today");
      assert.match(tool(b, "b_web_ip"), /DECOY/, "without an instance B's service, as today");
      const list = tool(b, "b_list");
      assert.ok(list.includes(till.id) && list.includes(depot.id), list);
      assert.ok(!list.includes(FENCE_HINT));
      await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
    }, { engine: { round } });
  } finally {
    setFenceSource(null);
    delete process.env.NPX_BIN;
    await service.shutdown();
    fd.cleanUp();
  }
});

test("(C) code view of a converted project: no file path follows a link out of the project — project and workspace level; without the operating mark as today", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const project = async (name) => {
        const filePath = path.join(ctx.root, "workspace", name);
        fs.mkdirSync(filePath, { recursive: true });
        return { ...(await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) })), path: filePath };
      };
      const till = await project("till");
      const depot = await project("depot");
      // B: the user's files outside every project (here standing in for ~/.bashrc and ~/cbase/data).
      const home = path.join(ctx.root, "home");
      fs.mkdirSync(path.join(home, "data"), { recursive: true });
      const BASHRC = path.join(home, ".bashrc");
      const DB = path.join(home, "data", "db.txt");
      fs.writeFileSync(BASHRC, "B-SECRET\n");
      fs.writeFileSync(DB, "B-DATA\n");
      fs.writeFileSync(path.join(depot.path, "secret.txt"), "NEIGHBOR-SECRET\n");
      // What the project container creates in the project folder.
      const K = till.path;
      fs.mkdirSync(path.join(K, "src"));
      fs.writeFileSync(path.join(K, "src", "a.txt"), "INSIDE-TEXT\n");
      const references = () => {
        for (const n of ["note", "cache", "dead", "inside", "neighbor", "way", "note2"]) fs.rmSync(path.join(K, n), { force: true });
        fs.symlinkSync(BASHRC, path.join(K, "note"));
        fs.symlinkSync(path.join(home, "data"), path.join(K, "cache"));
        fs.symlinkSync(path.join(home, "dead.txt"), path.join(K, "dead"));
        fs.symlinkSync(path.join("src", "a.txt"), path.join(K, "inside"));
        fs.symlinkSync(path.join("..", "depot", "secret.txt"), path.join(K, "neighbor"));
      };
      references();
      execFileSync("mkfifo", [path.join(K, "pipe")]);
      const name = `cbase-p-${till.id}`;
      await withEnvironment({ CBASE_DOCKER_BIN: fd.bin }, async () => {
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
      });
      store.createProjectInstance({ projectId: till.id, state: "ready", convertedAt: Date.now(), containerId: name });
      const P = `${base}/api/projects/${till.id}`;
      const W = `${base}/api/workspaces/${ws.id}`;
      const enabled = async (url, init = {}) => {
        const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
        const text = await r.text();
        return { status: r.status, text };
      };
      const read = (e, p) => enabled(`${e}/files/read?path=${encodeURIComponent(p)}`);
      const tree = (e, p) => enabled(`${e}/files/tree?path=${encodeURIComponent(p)}`);
      const write = (e, p, content) => enabled(`${e}/files/write`, { method: "PUT", body: JSON.stringify({ path: p, content }) });
      const fresh = (e, p, type = "file") => enabled(`${e}/files/create`, { method: "POST", body: JSON.stringify({ path: p, type }) });
      const rename = (e, from, to) => enabled(`${e}/files/rename`, { method: "POST", body: JSON.stringify({ from, to }) });
      const erase = (e, p) => enabled(`${e}/files?path=${encodeURIComponent(p)}`, { method: "DELETE" });
      const up = (e, dir, files) => enabled(`${e}/upload`, { method: "POST", body: JSON.stringify({ dir, files }) });
      const fetchData = (e, p) => enabled(`${e}/files/download?path=${encodeURIComponent(p)}`);
      const b64 = (t) => Buffer.from(t).toString("base64");
      const HINAUS = /leads out of the allowed area|outside the allowed area/;
      const denied = (r, what) => {
        assert.equal(r.status, 400, `${what}: ${r.status} ${r.text}`);
        assert.match(r.text, HINAUS, `${what}: ${r.text}`);
        assert.ok(!/B-SECRET|B-DATA|NEIGHBOR-SECRET/.test(r.text), `${what} gives away the target: ${r.text}`);
      };
      const homeUnchanged = (what) => {
        assert.equal(fs.readFileSync(BASHRC, "utf8"), "B-SECRET\n", `${what}: ~/.bashrc changed`);
        assert.equal(fs.readFileSync(DB, "utf8"), "B-DATA\n", `${what}: data/db.txt changed`);
        assert.deepEqual(fs.readdirSync(home).sort(), [".bashrc", "data"], `${what}: new in B`);
        assert.deepEqual(fs.readdirSync(path.join(home, "data")), ["db.txt"], `${what}: new in data`);
        assert.equal(fs.readFileSync(path.join(depot.path, "secret.txt"), "utf8"), "NEIGHBOR-SECRET\n");
      };

      // ── With the operating mark ──
      await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin }, async () => {
        for (const e of [P, W]) {
          const before = e === P ? "" : "till/";
          const where = e === P ? "Project" : "Workspace";
          denied(await read(e, `${before}note`), `${where} read note`);
          denied(await read(e, `${before}cache/db.txt`), `${where} read cache/db.txt`);
          denied(await tree(e, `${before}cache`), `${where} tree cache`);
          denied(await fetchData(e, `${before}note`), `${where} download note`);
          denied(await fetchData(e, `${before}neighbor`), `${where} download neighbor`);
          denied(await write(e, `${before}note`, "OVER"), `${where} write note`);
          denied(await write(e, `${before}cache/fresh.txt`, "OVER"), `${where} write cache/fresh.txt`);
          assert.match((await fresh(e, `${before}dead`)).text, /Existiert bereits/, `${where} create dead`);
          denied(await write(e, `${before}dead`, "OVER"), `${where} write dead`);
          denied(await fresh(e, `${before}cache/n.txt`), `${where} create cache/n.txt`);
          denied(await fresh(e, `${before}cache/folder`, "dir"), `${where} create cache/folder`);
          denied(await erase(e, `${before}cache/db.txt`), `${where} delete cache/db.txt`);
          denied(await rename(e, `${before}cache/db.txt`, `${before}loot.txt`), `${where} rename out of cache`);
          denied(await rename(e, `${before}src/a.txt`, `${before}cache/a.txt`), `${where} rename into cache`);
          denied(await up(e, `${before}cache`, [{ path: "u.txt", dataB64: b64("UP") }]), `${where} upload into cache`);
          denied(await up(e, before.replace(/\/$/, ""), [{ path: "cache/u.txt", dataB64: b64("UP") }]), `${where} upload cache/u.txt`);
          denied(await up(e, before.replace(/\/$/, ""), [{ path: "note", dataB64: b64("APPENDED"), append: true }]), `${where} upload appended to note`);
          assert.ok(!fs.existsSync(path.join(K, "loot.txt")) && fs.existsSync(path.join(K, "src", "a.txt")));
          homeUnchanged(`${where}`);
          // A link INSIDE the project counts; the search finds what stands in the project, and nothing behind it.
          const inside = await read(e, `${before}inside`);
          assert.equal(inside.status, 200, inside.text);
          assert.equal(JSON.parse(inside.text).content, "INSIDE-TEXT\n");
          const search = JSON.parse((await enabled(`${e}/files/search`, { method: "POST", body: JSON.stringify({ query: "TEXT" }) })).text);
          assert.deepEqual(search.results.map((x) => x.path).filter((x) => x.startsWith(before)), [`${before}src/a.txt`], JSON.stringify(search));
          const nothing = JSON.parse((await enabled(`${e}/files/search`, { method: "POST", body: JSON.stringify({ query: "SECRET" }) })).text);
          assert.deepEqual(nothing.results.filter((x) => x.path.startsWith(before)), [], JSON.stringify(nothing));
          // The tree shows the links, but nothing of a target outside.
          const root = JSON.parse((await tree(e, before)).text).entries;
          const entry = (n) => root.find((x) => x.name === n);
          assert.deepEqual([entry("note"), entry("cache")].map((x) => [x.type, x.size, x.symlink]), [["file", 0, true], ["file", 0, true]], JSON.stringify(root));
          assert.deepEqual([entry("inside").type, entry("inside").size], ["file", "INSIDE-TEXT\n".length]);
          // A FIFO does not stop B.
          assert.match((await read(e, `${before}pipe`)).text, /Keine reguläre Datei/);
          // Renaming and deleting a link move the link, never its target.
          const renamed = await rename(e, `${before}note`, `${before}note2`);
          assert.equal(renamed.status, 200, renamed.text);
          assert.ok(fs.lstatSync(path.join(K, "note2")).isSymbolicLink() && !fs.existsSync(path.join(K, "note")));
          const way = await erase(e, `${before}cache`);
          assert.equal(way.status, 200, way.text);
          assert.throws(() => fs.lstatSync(path.join(K, "cache")), { code: "ENOENT" }, "the link cache is gone");
          const folder = await erase(e, `${before}src`);
          assert.equal(folder.status, 200, folder.text);
          homeUnchanged(`${where} after rename/delete`);
          // What lies in the project works as today.
          assert.equal((await write(e, `${before}src/b.txt`, "B\n")).status, 200);
          assert.equal((await up(e, `${before}src`, [{ path: "c.txt", dataB64: b64("C1") }, { path: "c.txt", dataB64: b64("C2"), append: true }])).status, 200);
          assert.equal(fs.readFileSync(path.join(K, "src", "c.txt"), "utf8"), "C1C2");
          assert.equal((await fresh(e, `${before}fresh/deep/x.txt`)).status, 201);
          assert.equal((await rename(e, `${before}fresh/deep/x.txt`, `${before}fresh/y.txt`)).status, 200);
          assert.equal((await erase(e, `${before}fresh`)).status, 200);
          fs.mkdirSync(path.join(K, "src"), { recursive: true });
          fs.writeFileSync(path.join(K, "src", "a.txt"), "INSIDE-TEXT\n");
          references();
        }
        // Workspace level: a path in B (no converted project) works as today.
        assert.equal((await write(W, "depot/ok.txt", "OK")).status, 200);
        assert.equal((await fetchData(W, "depot/secret.txt")).status, 200);
        assert.equal((await rename(W, "depot/ok.txt", "till/src/ok.txt")).status, 200);
        assert.equal(fs.readFileSync(path.join(K, "src", "ok.txt"), "utf8"), "OK");
        homeUnchanged("workspace level in B");
      });

      // ── Without the operating mark: as today, holes included — and no docker ──
      const prior = fd.calls().length;
      const today = await read(P, "note");
      assert.equal(today.status, 200, today.text);
      assert.match(today.text, /B-SECRET/, "today /files/read follows the link");
      assert.equal(JSON.parse((await tree(P, "")).text).entries.find((x) => x.name === "cache").type, "dir");
      assert.equal((await fetchData(W, "till/neighbor")).status, 200, "today the workspace level delivers the neighbor");
      assert.equal((await fresh(P, "dead")).status, 201);
      assert.ok(fs.existsSync(path.join(home, "dead.txt")), "today /files/create creates the file at the link's target");
      assert.equal(fd.calls().length, prior, `without the operating mark no docker call: ${JSON.stringify(fd.calls().slice(prior))}`);
    });
  } finally {
    fd.cleanUp();
  }
});

// ── (C2) the workspace level's name search (`GET …/file-search`, @-mentions) ─────────────────────────────────────────────
// findFilesByName walked with readdirSync over PATHS through the whole workspace — also through the folders of a converted
// project. The project container replaces `<project>/sub` between listing `<project>` and descending into it with a link to a
// folder of B (here as a wrapper around fs.readdirSync: swapped as soon as a list names `sub` as a folder) — in the old state
// `till/sub/secret.txt` stood in the answer (the name of a file of B). Now the search under a path that the area boundary
// gives an area walks without following links (O_NOFOLLOW per folder). Without the operating mark as today: the same swap
// is followed. Counter-test: workspaces/routes.js without `{ limit }` passed to findFilesByName => red.
test("(C2) name search in the workspace follows no link that the project container lays between listing and descending — without the operating mark as today", async (t) => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const K = path.join(ctx.root, "workspace", "till");
      fs.mkdirSync(path.join(K, "sub"), { recursive: true });
      fs.writeFileSync(path.join(K, "sub", "harmless.txt"), "x\n");
      fs.writeFileSync(path.join(K, "secret-plan.md"), "PLAN\n");
      const till = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "till", path: K }) });
      const outside = path.join(ctx.root, "home", "outside");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "B-SECRET\n");
      const name = `cbase-p-${till.id}`;
      await withEnvironment({ CBASE_DOCKER_BIN: fd.bin }, async () => {
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
      });
      store.createProjectInstance({ projectId: till.id, state: "ready", convertedAt: Date.now(), containerId: name });
      const reset = () => {
        fs.rmSync(path.join(K, "sub"), { recursive: true, force: true });
        fs.mkdirSync(path.join(K, "sub"));
        fs.writeFileSync(path.join(K, "sub", "harmless.txt"), "x\n");
      };
      let armed = false;
      let swapped = 0;
      const real = fs.readdirSync;
      const rd = t.mock.method(fs, "readdirSync", function (p, ...r) {
        const list = real.call(fs, p, ...r);
        if (armed && !swapped && list.some((e) => (typeof e === "string" ? e : e.name) === "sub" && (typeof e === "string" || e.isDirectory()))
          && !fs.lstatSync(path.join(K, "sub")).isSymbolicLink()) {
          fs.rmSync(path.join(K, "sub"), { recursive: true });
          fs.symlinkSync(outside, path.join(K, "sub"));
          swapped++;
        }
        return list;
      });
      const search = async (q) => {
        armed = true;
        swapped = 0;
        try {
          const r = await fetch(`${base}/api/workspaces/${ws.id}/file-search?q=${encodeURIComponent(q)}`, { headers: { Connection: "close" } });
          return { status: r.status, body: await r.json() };
        } finally { armed = false; }
      };
      try {
        await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin }, async () => {
          const r = await search("secret");
          assert.equal(swapped, 1, "the swap did not happen — the test measures nothing");
          assert.equal(r.status, 200, JSON.stringify(r.body));
          assert.ok(!r.body.results.some((x) => x.includes("sub/secret")), `a name from B stood in the search: ${JSON.stringify(r.body)}`);
          assert.ok(r.body.results.includes("till/secret-plan.md"), `the search in the project is missing: ${JSON.stringify(r.body)}`);
        });
        reset();
        // Without the operating mark: today's path — the same swap is followed.
        const today = await search("secret");
        assert.equal(swapped, 1);
        assert.ok(today.body.results.includes("till/sub/secret.txt"), `today the search follows the link: ${JSON.stringify(today.body)}`);
      } finally {
        rd.mock.restore();
        reset();
      }
    });
  } finally {
    fd.cleanUp();
  }
});
