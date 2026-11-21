// Short name of a graph workflow: `workflows/shortName.js` (a leaf without imports) and the two picker lists that deliver
// it - `GET /api/chats/:id/workflows` and `GET /api/workspaces/:wid/effective-workflows`.
//
// The suffixes hang on the CREATION order, not on the order of the list: the effective set arrives sorted differently
// depending on the view (workspace first, then projects), and a short name that moved with the sorting would point to two
// different workflows in two lists with the same stock. The reordered input below is that counter-test.
//
// Counter-tests (which sabotage turns which test red):
//   - `withShortNames` assigns in input instead of creation order  => "reordered input" red.
//   - the mention without the anchor `(?:^|\s)`  => "path/workflow:x" red.
//   - one of the two routes without `withShortNames`  => the route test red (shortName missing).
// This file imports no other test file.
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { SHORT_MAX, WORKFLOW_MENTION, shortBase, withShortNames } from "../electron/server/workflows/shortName.js";
import { json, withAgentsServer } from "./agent-harness.mjs";

const mentions = (text) => [...String(text).matchAll(WORKFLOW_MENTION)].map((m) => m[1].toLowerCase());

test("shortBase: the spec example, umlauts, accents, edges, length, empty base", () => {
  assert.equal(shortBase("Order → Ship"), "order-ship");
  assert.equal(shortBase("Größe prüfen & Übergabe"), "groesse-pruefen-uebergabe");
  assert.equal(shortBase("Straße"), "strasse");
  assert.equal(shortBase("Café Crème"), "cafe-creme");
  assert.equal(shortBase("  --Review!!  "), "review");
  assert.equal(shortBase("Release 2026"), "release-2026");
  // Unlike slugifyTitle no "entry-" special case for purely numeric names.
  assert.equal(shortBase("42"), "42");
  assert.equal(shortBase("→ ★ …"), "workflow");
  assert.equal(shortBase(""), "workflow");
  assert.equal(shortBase(null), "workflow");
  const lang = shortBase("a".repeat(59) + " b" + "c".repeat(20));
  assert.ok(lang.length <= SHORT_MAX, lang);
  assert.equal(lang, "a".repeat(59), "a cut at \"-\" leaves no \"-\" at the end");
  assert.equal(shortBase("x".repeat(80)).length, SHORT_MAX);
});

test("withShortNames: suffixes by creation order, return in input order, reordered input gives the same", () => {
  const a = { id: "a", name: "Order → Ship", createdAt: 100 };
  const b = { id: "b", name: "order ship", createdAt: 300 };
  const c = { id: "c", name: "Order-Ship", createdAt: 200 };
  const d = { id: "d", name: "Deploy", createdAt: 50 };
  const first = withShortNames([a, b, c, d]);
  assert.deepEqual(first.map((w) => w.id), ["a", "b", "c", "d"], "input order");
  const short = (list) => Object.fromEntries(list.map((w) => [w.id, w.shortName]));
  assert.deepEqual(short(first), { a: "order-ship", c: "order-ship-2", b: "order-ship-3", d: "deploy" });
  assert.deepEqual(short(withShortNames([d, b, c, a])), short(first), "reordered input gives the same assignment");
  assert.deepEqual(short(withShortNames([c, d, a, b])), short(first));
  // The entries stay otherwise unchanged (no mutation of the input).
  assert.equal(a.shortName, undefined);
  assert.equal(first[0].name, "Order → Ship");
});

test("withShortNames: equal time is decided by the id; special-character names become workflow, workflow-2; a taken suffix is skipped", () => {
  const list = [
    { id: "z", name: "★", createdAt: 10 },
    { id: "m", name: "…", createdAt: 10 },
    { id: "q", name: "Workflow 2", createdAt: 5 },
  ];
  const short = Object.fromEntries(withShortNames(list).map((w) => [w.id, w.shortName]));
  assert.deepEqual(short, { q: "workflow-2", m: "workflow", z: "workflow-3" });
  assert.deepEqual(withShortNames([]), []);
  assert.deepEqual(withShortNames(null), []);
});

test("WORKFLOW_MENTION: at the start, in the middle, before punctuation, compared lowercase - never in the middle of a path", () => {
  assert.deepEqual(mentions("/workflow:order-ship please"), ["order-ship"]);
  assert.deepEqual(mentions("Start /workflow:review and then /workflow:deploy-2"), ["review", "deploy-2"]);
  assert.deepEqual(mentions("first /workflow:a, then /workflow:b."), ["a", "b"]);
  assert.deepEqual(mentions("(/workflow:x) does not work, but /workflow:y) does"), ["y"]);
  assert.deepEqual(mentions("row\n/workflow:new!"), ["new"]);
  assert.deepEqual(mentions("/workflow:Order-SHIP"), ["order-ship"]);
  assert.deepEqual(mentions("see path/workflow:x and a/workflow:y"), []);
  assert.deepEqual(mentions("/workflow:"), []);
  assert.deepEqual(mentions("/workflow:-x"), [], "a short name never starts with \"-\"");
  assert.deepEqual(mentions("/workflow:a_b"), [], "an underscore is not part of the short name and is not an end");
  assert.deepEqual(mentions("/workflow:" + "a".repeat(64)), ["a".repeat(64)]);
  assert.deepEqual(mentions("/workflow:" + "a".repeat(65)), []);
  // Twice in a row (global flag): matchAll starts from the beginning each time.
  assert.deepEqual(mentions("/workflow:q"), ["q"]);
});

test("both picker lists deliver shortName: workspace view, project view and the chat - unique across the effective set", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    const fresh = (name, createdAt, projectId = null) =>
      store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, projectId, name, createdAt, updatedAt: createdAt });
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST", body: JSON.stringify({ name: "Checkout", path: path.join(root, "workspace", "till") }),
    });
    const ship = fresh("Order → Ship", 1000);
    const review = fresh("Review", 2000);
    // A project workflow whose short base coincides with "Order → Ship", younger => suffix.
    const shipProj = fresh("order ship", 3000, project.id);
    // Same NAME as a workspace workflow: in the workspace view withAllProjectItems keeps the first.
    fresh("Review", 500, project.id);

    const shortOf = (list) => Object.fromEntries(list.map((w) => [w.id, w.shortName]));

    const wsView = await json(`${base}/api/workspaces/${ws.id}/effective-workflows`);
    assert.deepEqual(shortOf(wsView), { [ship.id]: "order-ship", [review.id]: "review", [shipProj.id]: "order-ship-2" });
    assert.equal(wsView.length, 3, "\"Review\" from the project does not appear twice");
    const entry = wsView.find((w) => w.id === shipProj.id);
    assert.equal(entry.name, "order ship");
    assert.equal(entry.originProject, "Checkout", "the origin stays part of the list entry");
    assert.equal(typeof entry.nodeCount, "number", "the rest of the list entry (workflowMeta) stays");

    // The coding chat of the harness is a workspace chat: same set, same short names.
    const chatView = await json(`${base}/api/chats/${chat.id}/workflows`);
    assert.deepEqual(shortOf(chatView), shortOf(wsView));

    // Project view: only the project workflows plus the adopted ones - there "order ship" is alone and without suffix.
    const projView = await json(`${base}/api/workspaces/${ws.id}/effective-workflows?projectId=${project.id}`);
    assert.deepEqual(projView.map((w) => w.shortName).sort(), ["order-ship", "review"]);
    store.setWorkflowEnabled(project.id, "Order → Ship", true);
    const withTakeover = await json(`${base}/api/workspaces/${ws.id}/effective-workflows?projectId=${project.id}`);
    assert.deepEqual(shortOf(withTakeover)[ship.id], "order-ship", "the older adopted workflow keeps the base");
    assert.deepEqual(shortOf(withTakeover)[shipProj.id], "order-ship-2");

    const projChat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    const projChatView = await json(`${base}/api/chats/${projChat.id}/workflows`);
    assert.deepEqual(shortOf(projChatView), shortOf(withTakeover));
  });
});
