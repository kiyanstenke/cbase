// Unknown effort levels are a 400, never silently empty.
//
// Three statements, three answers — at every saving place a human or an agent reaches:
//   • MISSING  (no field)  => unchanged, or the provider's default;
//   • EMPTY    ("")        => reset, only where allowed (app agent, default level; on the chat change a 400);
//   • UNKNOWN  (any other word, null, numbers) => 400 with wording.
// Chat creation and chat change once turned an unknown level silently into "no level" — the chat change even left
// non-strings standing without a word.
//
// Only what is CHANGED is checked: stored data whose level the catalog no longer knows stays (same rule as for the
// workflow definitions).
//
// Counter-tests: removing the checks in chats/routes.js (two) and chats/creation.js one by one turns the matching
// claim red. The two remaining saving places of the settings are `PUT /api/agent-models` (settings/routes.js) and
// `PUT /api/default-effort` (account/routes.js): deleting the line `if (levelAnnounced && level.kind === "unknown") …` in
// settings/routes.js turns "settings …" red (200 instead of 400, the level silently empty).
import assert from "node:assert/strict";
import test from "node:test";

import { withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";

async function raw(url, init) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (url, body) => raw(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url, body) => raw(url, { method: "PATCH", body: JSON.stringify(body) });

test("chat creation and chat change: unknown level => 400 with wording, missing => unchanged", async () => {
  await withAgentsServer(async ({ base, ws, chat, waitForIdle }) => {
    // Counted unfiltered (the client list shows only chats with a message) — a rejected creation must not leave an empty
    // chat behind.
    const count = async () => store.listChats(ws.id, { archive: "including" }).length;
    const prior = await count();
    const creation = { workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions" };

    for (const effort of ["turbo", "HIGH", "ultra", 5, null]) {
      const r = await post(`${base}/api/chats`, { ...creation, effort });
      assert.equal(r.status, 400, `creation with ${JSON.stringify(effort)} => 400 (${JSON.stringify(r.body)})`);
      assert.match(r.body.error, /Denkstufe|effort level/, "the wording names the reason");
    }
    assert.equal(await count(), prior, "none of the rejected creations left a chat");
    const withLevel = await post(`${base}/api/chats`, { ...creation, effort: "high" });
    assert.equal(withLevel.status, 201);
    assert.equal(withLevel.body.effort, "high");
    const without = await post(`${base}/api/chats`, creation);
    assert.equal(without.status, 201, "a missing field is no statement — the chat is created");

    const url = `${base}/api/chats/${chat.id}`;
    assert.equal((await patch(url, { effort: "medium" })).status, 200);
    for (const effort of ["turbo", "x-high", 3, null, false]) {
      const r = await patch(url, { effort });
      assert.equal(r.status, 400, `PATCH with ${JSON.stringify(effort)} => 400 (${JSON.stringify(r.body)})`);
      assert.match(r.body.error, /Denkstufe|effort level/);
      assert.equal((await raw(url)).body.effort, "medium", `… and ${JSON.stringify(effort)} stored nothing`);
    }
    assert.equal((await patch(url, { effort: "" })).status, 400, "empty stays a 400");
    assert.equal((await patch(url, { title: "Renamed" })).status, 200);
    assert.equal((await raw(url)).body.effort, "medium", "missing field => unchanged");
    await waitForIdle();
  });
});

test("settings: app agent and default level — unknown level => 400 with wording and nothing stored; empty means default; a stored level does not block changing the model", async () => {
  await withAgentsServer(async ({ base, waitForIdle }) => {
    const put = (url, body) => raw(url, { method: "PUT", body: JSON.stringify(body) });
    const agentModelsUrl = `${base}/api/agent-models`;
    const row = () => store.getSetting("agent_model_title", "");

    // (1) App agent: an unknown level is a 400, and the row stays as it was.
    assert.equal((await put(agentModelsUrl, { key: "title", effort: "high" })).status, 200);
    const prior = row();
    assert.equal(JSON.parse(prior).effort, "high");
    for (const effort of ["turbo", "Max", 7, null]) {
      const r = await put(agentModelsUrl, { key: "title", effort });
      assert.equal(r.status, 400, `effort ${JSON.stringify(effort)} => 400 (${JSON.stringify(r.body)})`);
      assert.match(r.body.error, /Denkstufe|effort level/);
      assert.equal(row(), prior, `effort ${JSON.stringify(effort)}: nothing stored`);
    }
    // Empty means default.
    assert.equal((await put(agentModelsUrl, { key: "title", effort: "" })).status, 200);
    assert.equal(row(), "", "empty => auto + default");

    // (2) Only what is changed: a stored level the catalog does not (any more) know does not block changing the MODEL.
    store.setSetting("agent_model_title", JSON.stringify({ effort: "turbo" }));
    const model = await put(agentModelsUrl, { key: "title", provider: "claude", model: "claude-sonnet-5-5" });
    assert.equal(model.status, 200, `an unchanged stored level does not block the change: ${JSON.stringify(model.body)}`);
    assert.deepEqual(JSON.parse(row()), { provider: "claude", model: "claude-sonnet-5-5" }, "the unknown stored level is not carried on");

    // (3) The provider's default level: missing and unknown => 400, nothing stored; empty => back to the preset.
    const dg = `${base}/api/default-effort`;
    const set = (await put(dg, { provider: "claude", effort: "low" })).body.effort;
    assert.equal(set, "low");
    for (const body of [{ provider: "claude" }, { provider: "claude", effort: "turbo" }, { provider: "claude", effort: 3 }]) {
      const r = await put(dg, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} => 400 (${JSON.stringify(r.body)})`);
    }
    assert.match((await put(dg, { provider: "claude", effort: "turbo" })).body.error, /Denkstufe|effort level/);
    const after = (await raw(`${base}/api/providers`)).body;
    assert.equal(JSON.stringify(after).includes('"defaultEffort":"low"'), true, "the default level stayed low");
    const back = await put(dg, { provider: "claude", effort: "" });
    assert.equal(back.status, 200);
    assert.notEqual(back.body.effort, "turbo");
    await waitForIdle();
  });
});
