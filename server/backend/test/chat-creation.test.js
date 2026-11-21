// Chat creation as a calculation of its own: the normalisation of `POST /api/chats` is in chats/creation.js, so that the creation
// path of the scheduled jobs runs the SAME rules — `isProviderId`, `defaultModelFor`, `effortSavable`, `ultracodeSavable`,
// `PERMISSION_MODES`, folder, project, instance. Promise: `POST /api/chats` behaves UNCHANGED.
//
// Proof in two parts: (1) every refusal and every silent default of POST /api/chats with status and wording — this part first ran
// green against the old body in chats/routes.js and then unchanged against the new one; the golden fixtures (golden-runs.test.js)
// hold the success path byte-equal. (2) the calculation itself with `modeRequired` (scheduled): there an unknown or missing
// permission mode is a 400, for a chat it stays a silent "".
//
// Counter-tests (each shown red once and taken back):
//   in chats/creation.js the check `!isProviderId(b.provider)` removed  ⇒ "POST /api/chats …" red (foreign provider 201)
//   `modeRequired` in chats/creation.js without effect (always silent "")  ⇒ "modeRequired …" red
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/chat-creation.test.js

import assert from "node:assert/strict";
import test from "node:test";

import { json, ok, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";
import * as store from "../electron/server/store.js";
import { T } from "../electron/server/i18n.js";
import { defaultModelFor } from "../electron/server/account/providers.js";
import { getActiveProviderId } from "../electron/server/providers/index.js";
import { effortSavable, ultracodeSavable } from "../electron/server/workflows.js";
import { chatCreation } from "../electron/server/chats/creation.js";

const post = (base, b) => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify(b) });

test("POST /api/chats: every refusal with status and wording, every silent default", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    const ws = await makeWorkspace(base, "Creation", wsPath);
    const foreign = await makeWorkspace(base, "Foreign", `${wsPath}-foreign`);
    const proj = await makeProject(base, ws.id, projPath, "Checkout");
    const wsFolder = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Loose" }) });
    const projFolder = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: proj.id, name: "Checkout folder" }) });
    const foreignFolder = await ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: foreign.id, name: "Foreign" }) });
    // A manager folder is only legacy stock: the route no longer accepts kind manager.
    const mgrFolder = store.createChatFolder({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Round", kind: "manager", createdAt: Date.now(), updatedAt: Date.now() });

    const refuse = [
      [{}, 400, T("workspaceId required — a chat always belongs to a workspace")],
      [{ workspaceId: "exists-not" }, 400, T("workspaceId required — a chat always belongs to a workspace")],
      [{ workspaceId: ws.id, projectId: "foreign" }, 400, T("Project does not belong to this workspace")],
      [{ workspaceId: ws.id, folderId: foreignFolder.id }, 400, T("Folder does not belong to this workspace")],
      [{ workspaceId: ws.id, folderId: "exists-not" }, 400, T("Folder does not belong to this workspace")],
      [{ workspaceId: ws.id, folderId: mgrFolder.id }, 400, T("Folder belongs to a different chat kind")],
      [{ workspaceId: ws.id, folderId: wsFolder.id, projectId: proj.id }, 400, T("Workspace folders do not take project chats")],
      [{ workspaceId: ws.id, provider: "foreign" }, 400, T("Unknown provider")],
      [{ workspaceId: ws.id, effort: "turbo" }, 400, effortSavable("turbo").error],
      [{ workspaceId: ws.id, ultracode: "yes" }, 400, ultracodeSavable("yes").error],
    ];
    for (const [b, status, error] of refuse) {
      const r = await post(base, b);
      assert.equal(r.status, status, `${JSON.stringify(b)} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { error }, `${JSON.stringify(b)}: wording`);
    }
    // The instance: the same rules as the PATCH (runs/instance-switch.js), with a code.
    const noText = await post(base, { workspaceId: ws.id, instance: 5 });
    assert.equal(noText.status, 400);
    assert.equal(noText.body.code, "INSTANCE_INVALID");
    const noProject = await post(base, { workspaceId: ws.id, instance: "copy-x" });
    assert.equal(noProject.status, 409);
    assert.equal(noProject.body.code, "NO_PROJECT");
    assert.equal(store.listChats(ws.id).length, 0, "no refusal created a chat");

    // The silent defaults: provider, model, profile, permission mode, browser mode, effort.
    const empty = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
    const provider = getActiveProviderId();
    assert.equal(empty.provider, provider, "without a provider the global one");
    assert.equal(empty.model, defaultModelFor(provider), "without a model the provider's default model");
    assert.equal(empty.profile, "default", "a missing profile is \"default\"");
    assert.equal(empty.permissionMode, "", "without a mode \"\"");
    assert.equal(empty.browserMode, "");
    assert.equal(empty.effort, "");
    assert.equal(empty.ultracode, false);
    assert.equal(empty.projectId, null);
    assert.equal(empty.folderId, null);
    assert.equal(empty.instance, null);
    assert.equal(empty.kind, "normal");
    assert.equal(empty.title, "New chat");
    const still = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "", model: "  ", profile: "", permissionMode: "nonsense", browserMode: "nonsense", effort: "" }) });
    assert.equal(still.permissionMode, "", "an unknown mode becomes a silent \"\" for a chat");
    assert.equal(still.browserMode, "", "an unknown browser mode likewise");
    assert.equal(still.profile, "", "an empty profile is a choice (\"without persona\")");
    assert.equal(still.model, defaultModelFor(provider), "an empty model is the default model");
    assert.equal(still.provider, provider, "an empty provider is the global one");

    // A folder in the project inherits the project; values that apply arrive.
    const full = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, folderId: projFolder.id, provider: "claude", model: " claude-sonnet-5 ", profile: " Reviewer ", permissionMode: "plan", effort: "high", instance: null }) });
    assert.equal(full.projectId, proj.id, "the project folder inherits its project");
    assert.equal(full.folderId, projFolder.id);
    assert.equal(full.model, "claude-sonnet-5", "the model trimmed");
    assert.equal(full.profile, "Reviewer", "the profile trimmed");
    assert.equal(full.permissionMode, "plan");
    assert.equal(full.effort, "high");
    assert.equal(full.instance, null);
    // Ultracode on: a switch next to the level (chats/ultracode.js) — the level sent along stays.
    const uc = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", effort: "low", ultracode: true }) });
    assert.equal(uc.ultracode, true);
    assert.equal(uc.effort, "low");
  });
});

test("modeRequired (scheduled): a missing or unknown permission mode is a 400, a known one arrives — without the option it stays a silent \"\"", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Scheduled creation", wsPath);
    for (const permissionMode of [undefined, "", "nonsense"]) {
      const r = chatCreation({ workspaceId: ws.id, permissionMode }, { modeRequired: true });
      assert.equal(r.error?.status, 400, `mode ${JSON.stringify(permissionMode)}: ${JSON.stringify(r)}`);
      assert.match(r.error.body.error, /bypassPermissions/, "the wording names the allowed modes");
      assert.equal(chatCreation({ workspaceId: ws.id, permissionMode }).fields?.permissionMode, "", "without the option silent \"\"");
    }
    const gut = chatCreation({ workspaceId: ws.id, permissionMode: "bypassPermissions" }, { modeRequired: true });
    assert.equal(gut.fields?.permissionMode, "bypassPermissions");
    assert.equal(gut.fields.workspaceId, ws.id);
    assert.equal("id" in gut.fields || "createdAt" in gut.fields, false, "the caller sets id and timestamp");
    // The other refusals apply with the option just the same — they come BEFORE the mode.
    assert.equal(chatCreation({ workspaceId: ws.id, provider: "foreign" }, { modeRequired: true }).error?.body.error, T("Unknown provider"));
    assert.equal(chatCreation({}, { modeRequired: true }).error?.status, 400);
  });
});
