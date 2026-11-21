// The app agents are gone: no orb dock, no context agent, no run kinds "context"/"ingest". What they did is done by ordinary
// coding chats (server/projects/coding-jobs.js). Guarantees:
//   (1) A dump whose project routing says "unsure" lands in the workspace dumpster (201, target workspace) - NO chat, no
//       question, no notification is created.
//   (2) Files into the dumpster: POST .../context/ingest creates a coding chat (kind normal, bypassPermissions, titled) in the
//       chosen project or in the workspace and returns the job; the job names the target. A foreign project is 400.
//   (3) "Start service with agent": a coding chat in the project, the job as first message, the turn runs at once.
//   (4) /api/agent-chats and /api/context/route are gone (404); cbase_context_route is in no catalog.
//   (5) An old chat of a fallen kind (context, ingest, service, workflow) is in no list and starts no turn (409).
//
// Counter-tests: jobChat with kind "service" => red ("coding chat"); ONLY_READABLE_KINDS without "ingest" => red ((5), 409).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, projectWithoutInstance, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";

// Project routing (routeDumpToProject) says "unsure", as in the golden fake; every other oneshot (classify) answers with a
// category.
const UNSAFE = fakeClaude({ oneshot: `
    if (prompt.includes("PASTED TEXT:")) { respond(JSON.stringify({ decision: "unsure", projectId: null, candidates: [], question: "Till or shop?", reason: "both" })); return; }
    respond(JSON.stringify({ category: "notes", title: "Note", summary: "short", tags: [] }));
` });

const raw = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  let body = null;
  try { body = await r.json(); } catch { /* no JSON */ }
  return { status: r.status, body };
};

test("(1)-(5) the app-agent jobs are coding chats; an unclear dump falls into the workspace", async () => {
  await withAgentsServer(async ({ base, ws, root }) => {
    const till = projectWithoutInstance({ workspaceId: ws.id, name: "Till", path: path.join(root, "workspace", "till") });
    const shop = projectWithoutInstance({ workspaceId: ws.id, name: "Shop", path: path.join(root, "workspace", "shop") });
    const count = () => store.listChats(ws.id, { archive: "including" }).length;

    // (1) Unclear => workspace dumpster, no chat.
    const prior = count();
    const thrown = await raw(`${base}/api/workspaces/${ws.id}/context`, { method: "POST", body: JSON.stringify({ text: "The test system has been up since September 1." }) });
    assert.equal(thrown.status, 201, JSON.stringify(thrown.body));
    assert.equal(thrown.body.target, "workspace", JSON.stringify(thrown.body));
    assert.equal(thrown.body.chatId, undefined, "no chat for an unclear dump");
    assert.equal(count(), prior, "no chat was created");
    assert.ok(store.listContext(ws.id, { status: "all" }).some((r) => r.body === "The test system has been up since September 1."), "the dump is in the workspace dumpster");

    // (2) Files: project target, workspace target, automatic, foreign project.
    const inProject = await raw(`${base}/api/workspaces/${ws.id}/context/ingest`, { method: "POST", body: JSON.stringify({ target: till.id, text: "only the essentials" }) });
    assert.equal(inProject.status, 201, JSON.stringify(inProject.body));
    const c1 = store.getChat(inProject.body.chatId);
    assert.equal(c1.kind, "normal", "Coding-Chat");
    assert.equal(c1.projectId, till.id, "in the chosen project");
    assert.equal(c1.permissionMode, "bypassPermissions");
    assert.equal(c1.titled, true, "titled - no auto title over it");
    assert.match(inProject.body.job, new RegExp(`cbase_context_dump\\(projectId=${till.id}`));
    assert.match(inProject.body.job, /only the essentials/, "the user's hint is in the job");
    const inWs = await raw(`${base}/api/workspaces/${ws.id}/context/ingest`, { method: "POST", body: JSON.stringify({ target: "workspace" }) });
    assert.equal(store.getChat(inWs.body.chatId).projectId, null);
    assert.match(inWs.body.job, /cbase_workspace_context_add/);
    assert.doesNotMatch(inWs.body.job, /cbase_context_dump/);
    const auto = await raw(`${base}/api/workspaces/${ws.id}/context/ingest`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(store.getChat(auto.body.chatId).projectId, null);
    assert.match(auto.body.job, /cbase_projects_list/);
    fs.mkdirSync(path.join(root, "other"), { recursive: true });
    const other = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Other", path: path.join(root, "other") }) });
    const foreign = await raw(`${base}/api/workspaces/${other.id}/context/ingest`, { method: "POST", body: JSON.stringify({ target: shop.id }) });
    assert.equal(foreign.status, 400, "a project of another workspace is no target");

    // (3) Start service with agent.
    const service = await json(`${base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId: till.id, name: "web", startCommand: "true" }) });
    const start = await raw(`${base}/api/projects/${till.id}/services/${service.id}/start`, { method: "POST", body: JSON.stringify({ mode: "agent", instructions: "npm ci first" }) });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    const c3 = store.getChat(start.body.chatId);
    assert.equal(c3.kind, "normal", "Coding-Chat");
    assert.equal(c3.projectId, till.id);
    assert.equal(c3.permissionMode, "bypassPermissions");
    const first = store.listMessages(c3.id)[0];
    assert.equal(first.role, "user");
    assert.match(first.text, /Start the service "web" of the project "Till"/);
    assert.match(first.text, /npm ci first/);
    assert.ok(store.listChats(ws.id).some((c) => c.id === c3.id), "is in the coding list");
    await waitForTruthy(() => store.listMessages(c3.id).some((m) => m.role === "assistant"), "reply of the service chat");

    // (4) Gone.
    assert.equal((await raw(`${base}/api/agent-chats`)).status, 404);
    assert.equal((await raw(`${base}/api/context/route`, { method: "POST", body: JSON.stringify({ chatId: c1.id, target: "workspace" }) })).status, 404);
    assert.ok(!CATALOG_NAMES.includes("cbase_context_route"));

    // (5) Legacy chats.
    for (const kind of ["context", "ingest", "service", "workflow"]) {
      const t = Date.now();
      const old = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind, title: `old ${kind}`, permissionMode: "bypassPermissions", createdAt: t, updatedAt: t });
      store.addMessage(old.id, "user", "old job");
      assert.ok(!store.listChats(ws.id, { archive: "including" }).some((c) => c.id === old.id), `${kind}: in no list`);
      const n = await raw(`${base}/api/chats/${old.id}/message`, { method: "POST", body: JSON.stringify({ text: "further" }) });
      assert.equal(n.status, 409, `${kind}: ${JSON.stringify(n.body)}`);
      assert.equal(n.body.onlyReadable, true);
      assert.equal(store.listMessages(old.id).length, 1, `${kind}: nothing written`);
    }
  }, { claude: UNSAFE });
});
