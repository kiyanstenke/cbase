// Chat folders: a logical grouping of the chat list (no file-system folder) plus the actual promise of the feature — chats of ONE
// folder read each other's artifacts, and only as long as they are in the folder together.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { withMcp } from "./server-harness.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-folders-"));
  let server;
  try {
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspacePath, "project-a"), { recursive: true });
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const workspace = (await json(`${base}/api/workspaces`, {
      method: "POST", body: JSON.stringify({ name: "Test", path: workspacePath }),
    })).body;
    const project = (await json(`${base}/api/workspaces/${workspace.id}/projects`, {
      method: "POST", body: JSON.stringify({ name: "Project A", path: path.join(workspacePath, "project-a") }),
    })).body;
    await run({ base, workspace, project });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const newChat = (base, body) => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify(body) });
const writeArtifact = (base, chatId, body) =>
  json(`${base}/api/chats/${chatId}/artifacts/file`, { method: "PUT", body: JSON.stringify(body) });

test("create a folder, rename it, assign chats and dissolve it again", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const created = await json(`${base}/api/chat-folders`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "Research" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.projectId, null);
    assert.equal(created.body.chatCount, 0);
    const folder = created.body;

    // Start a chat DIRECTLY in the folder.
    const inside = await newChat(base, { workspaceId: workspace.id, folderId: folder.id });
    assert.equal(inside.status, 201);
    assert.equal(inside.body.folderId, folder.id);

    // An existing chat is assigned afterwards.
    const loose = await newChat(base, { workspaceId: workspace.id });
    assert.equal(loose.body.folderId, null);
    const moved = await json(`${base}/api/chats/${loose.body.id}`, {
      method: "PATCH", body: JSON.stringify({ folderId: folder.id }),
    });
    assert.equal(moved.body.folderId, folder.id);

    // `chatCount` counts only chats with at least one message — like the list.
    const count = async () => (await json(`${base}/api/chat-folders?workspaceId=${workspace.id}`)).body.map((f) => [f.name, f.chatCount]);
    assert.deepEqual(await count(), [["Research", 0]], "two empty chats do not count");
    for (const c of [inside.body, loose.body]) store.addMessage(c.id, "user", "Hello");
    assert.deepEqual(await count(), [["Research", 2]]);

    const renamed = await json(`${base}/api/chat-folders/${folder.id}`, {
      method: "PATCH", body: JSON.stringify({ name: "Research 2026" }),
    });
    assert.equal(renamed.body.name, "Research 2026");

    // A project folder takes no workspace chat (scope rule).
    const projectFolder = (await json(`${base}/api/chat-folders`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "Sprint", projectId: project.id }),
    })).body;
    const wrongScope = await json(`${base}/api/chats/${loose.body.id}`, {
      method: "PATCH", body: JSON.stringify({ folderId: projectFolder.id }),
    });
    assert.equal(wrongScope.status, 400);

    // A chat IN the project folder inherits the folder's project.
    const projectChat = await newChat(base, { workspaceId: workspace.id, folderId: projectFolder.id });
    assert.equal(projectChat.body.projectId, project.id);
    // If it leaves the project, it loses the (now unsuitable) folder by itself.
    const unlinked = await json(`${base}/api/chats/${projectChat.body.id}`, {
      method: "PATCH", body: JSON.stringify({ projectId: null }),
    });
    assert.equal(unlinked.body.folderId, null);

    // Deleting a folder only dissolves the grouping — the chats stay.
    const removed = await json(`${base}/api/chat-folders/${folder.id}`, { method: "DELETE" });
    assert.equal(removed.body.chats, 2);
    store.addMessage(projectChat.body.id, "user", "Hello"); // only chats with a message are in the list
    const after = await json(`${base}/api/chats?workspaceId=${workspace.id}`);
    assert.equal(after.body.length, 3);
    assert.equal(after.body.every((c) => c.folderId !== folder.id), true);
  });
});

test("chats of a folder read each other's artifacts — but write only their own", async () => {
  await withServer(async ({ base, workspace }) => {
    const folder = (await json(`${base}/api/chat-folders`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "Feature X" }),
    })).body;
    const x = (await newChat(base, { workspaceId: workspace.id, folderId: folder.id })).body;
    const y = (await newChat(base, { workspaceId: workspace.id, folderId: folder.id })).body;
    const outside = (await newChat(base, { workspaceId: workspace.id })).body;

    const plan = await writeArtifact(base, y.id, { path: "plan.md", content: "# Plan\n" });
    assert.equal(plan.status, 200);
    await writeArtifact(base, outside.id, { path: "secret.md", content: "foreign\n" });

    // X sees Y's artifact with its origin, but not that of the chat outside the folder.
    const list = await json(`${base}/api/chats/${x.id}/artifacts`);
    assert.deepEqual(list.body.map((a) => [a.path, a.chatId, a.own]), [["plan.md", y.id, false]]);

    const read = await json(`${base}/api/chats/${x.id}/artifacts/file?path=plan.md&chatId=${y.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.content, "# Plan\n");
    assert.equal(read.body.own, false);

    // Without chatId X looks in its OWN stock — the file does not exist there.
    const ownRead = await json(`${base}/api/chats/${x.id}/artifacts/file?path=plan.md`);
    assert.equal(ownRead.status, 404);

    // Writing/deleting foreign artifacts is blocked.
    const forbiddenWrite = await writeArtifact(base, x.id, {
      path: "plan.md", content: "broken", chatId: y.id, expectedSha256: plan.body.sha256,
    });
    assert.equal(forbiddenWrite.status, 403);
    const forbiddenDelete = await json(
      `${base}/api/chats/${x.id}/artifacts/file?path=plan.md&chatId=${y.id}&expectedSha256=${plan.body.sha256}`,
      { method: "DELETE" },
    );
    assert.equal(forbiddenDelete.status, 403);

    // Chats outside the folder do not get near it at all.
    const stranger = await json(`${base}/api/chats/${outside.id}/artifacts/file?path=plan.md&chatId=${y.id}`);
    assert.equal(stranger.status, 403);

    // If Y leaves the folder, access ends at once — nothing was ever copied.
    await json(`${base}/api/chats/${y.id}`, { method: "PATCH", body: JSON.stringify({ folderId: null }) });
    const afterLeave = await json(`${base}/api/chats/${x.id}/artifacts`);
    assert.deepEqual(afterLeave.body, []);
    const denied = await json(`${base}/api/chats/${x.id}/artifacts/file?path=plan.md&chatId=${y.id}`);
    assert.equal(denied.status, 403);
    // Y itself still has its file unchanged.
    const still = await json(`${base}/api/chats/${y.id}/artifacts`);
    assert.deepEqual(still.body.map((a) => [a.path, a.own]), [["plan.md", true]]);
  });
});

// A folder's context files are what the HUMAN puts in — so they must be changeable, not just replaceable. The editor in
// web/client/mobile writes to the same route it read from, always with the SHA-256 it read.
test("folder context can be edited by hand — with the same protection as an artifact", async () => {
  await withServer(async ({ base, workspace }) => {
    const folder = (await json(`${base}/api/chat-folders`, {
      method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "Briefing" }),
    })).body;
    const file = `${base}/api/chat-folders/${folder.id}/context/file`;

    const uploaded = await json(`${base}/api/chat-folders/${folder.id}/context/upload?path=briefing.md`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "# Briefing\n",
    });
    assert.equal(uploaded.status, 201);

    // Without a read state no overwriting — otherwise foreign work would be lost silently.
    const blind = await json(file, {
      method: "PUT", body: JSON.stringify({ path: "briefing.md", content: "overwritten" }),
    });
    assert.equal(blind.status, 409);

    const saved = await json(file, {
      method: "PUT",
      body: JSON.stringify({ path: "briefing.md", content: "# Briefing\n\nNew.\n", expectedSha256: uploaded.body.sha256 }),
    });
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.sha256, uploaded.body.sha256);

    const read = await json(`${file}?path=briefing.md`);
    assert.equal(read.body.content, "# Briefing\n\nNew.\n");
    assert.equal(read.body.sha256, saved.body.sha256);

    // The stale state from the first read no longer counts.
    const stale = await json(file, {
      method: "PUT",
      body: JSON.stringify({ path: "briefing.md", content: "one more thing", expectedSha256: uploaded.body.sha256 }),
    });
    assert.equal(stale.status, 409);

    // A chat of the folder sees the changed version.
    const chat = (await newChat(base, { workspaceId: workspace.id, folderId: folder.id })).body;
    const seen = await json(`${base}/api/chats/${chat.id}/folder-context`);
    assert.deepEqual(seen.body.files.map((f) => [f.path, f.sha256]), [["briefing.md", saved.body.sha256]]);
  });
});

// Deleting a project: `chats.project_id` used to keep pointing at the dead project — the chat could not be put into a workspace
// folder (400 "other project"), "By project" lost it, and cbase_vars_* ended with 404. Now deleteProject takes the id from the
// chats (store/workspaces.js); for legacy stock with a dead id the readers are robust: the PATCH (chats/routes.js) and varsBase
// (mcp/lib.js) treat it like "no project".
test("a deleted project takes the project id from its chats — the chat survives as a chat without a project", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const c = (await newChat(base, { workspaceId: workspace.id, projectId: project.id })).body;
    assert.equal(c.projectId, project.id);
    const del = await json(`${base}/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const target = await json(`${base}/api/chats/${c.id}`);
    assert.equal(target.status, 200, "the chat survives its project");
    assert.equal(target.body.projectId, null, "the chat still points at the deleted project");
  });
});

test("legacy stock: a chat with a dead project id goes into a workspace folder, and cbase_vars_list returns the workspace set", async () => {
  await withServer(async ({ base, workspace }) => {
    // Legacy stock from before the repair: the dead id past the store.
    const old = (await newChat(base, { workspaceId: workspace.id })).body;
    store.updateChat(old.id, { projectId: "project-exists-not" });
    const folder = (await json(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, name: "Deposit" }) })).body;
    const r = await json(`${base}/api/chats/${old.id}`, { method: "PATCH", body: JSON.stringify({ folderId: folder.id }) });
    assert.equal(r.status, 200, `a chat with a dead project id could not be put into a workspace folder: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.folderId, folder.id);

    const v = await json(`${base}/api/workspaces/${workspace.id}/vars`, { method: "POST", body: JSON.stringify({ key: "WS_TOKEN", value: "secret-m32" }) });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    await withMcp({ CBASE_BASE_URL: base, CBASE_WORKSPACE_ID: workspace.id, CBASE_PROJECT_ID: "project-exists-not", CBASE_CHAT_ID: old.id, CBASE_TOOLS: JSON.stringify(["cbase_vars_list"]) }, async ({ call }) => {
      const l = await call("cbase_vars_list", {});
      assert.equal(l.isError, false, `cbase_vars_list with a dead project id: ${l.text}`);
      assert.ok(Array.isArray(l.data) && l.data.some((x) => x.key === "WS_TOKEN"), `the workspace set is missing: ${l.text}`);
    });
  });
});
