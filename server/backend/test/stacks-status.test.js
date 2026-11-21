// The delete preview of a copy (stacks/status.js copyStatus, route GET /api/projects/:pid/stack-copies/:name/state in
// stacks/routes.js) with real repos: a copy built through the real sequence up to `ready` (harness stacks-copy-harness.mjs),
// in which the "agent" works via docker exec — the preview reads INSIDE the copy.
//
// What holds here:
//   (1) A commit on main in the copy ⇒ `app` reports `commits: 1` (feature unmoved, no second one), branch main; a new file ⇒
//       `open: ["open.txt"]`, `openCount: 1` (the ignored old.log is not counted); a new repo of the copy (`git init fresh` plus
//       two commits) ⇒ one row `fresh: true`, `commits: 2`; the chat moved in is listed under `chats` (`running: false`). The
//       preview changes nothing: refs in the main instance and in the copy stay. 404 for an unknown copy.
//   (2) Read error: the container of the copy is stopped ⇒ `loaded: false` with a reason — never an empty list (empty is not
//       unknown); a copy that is not ready ⇒ 409 COPY_STATE with `state`.
//
// Counter-proof: without stacks/status.js and the `/state` branch in stacks/routes.js both (1) and (2) are red (the route
// answers 404). In status.js `knownRepo` with `commits = 0` instead of rev-list ⇒ (1) red ("commits 0 instead of 1");
// `newReposTheCopy` as an empty list ⇒ (1) red (the new repo is missing); the route without try (throw instead of
// `loaded: false`) ⇒ (2) red (500).
//
// No clock: the sequence and the build run on states (waitForTruthy in buildCopy). macOS: real TMPDIR (harness).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { setCopyState } from "../electron/server/stacks/state.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, dx, gitCopy, inCopy, situationDefault, withCopy, refs, writeInCopy } from "./stacks-copy-harness.mjs";

async function response(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test("(1) Status: commit, open file and new repo appear, the copy's chats are listed; read-only; 404 for an unknown copy", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const chat = ctx.chat;
    await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: chat.id });
    const app = b.app;
    writeInCopy(b, path.join(app, "fresh.txt"), "new\n");
    gitCopy(b, app, "add", "fresh.txt");
    gitCopy(b, app, "commit", "-q", "-m", "in the copy");
    writeInCopy(b, path.join(app, "open.txt"), "open\n");
    const fresh = path.join(b.s.path, "fresh");
    inCopy(b, b.s.path, "mkdir", "fresh");
    gitCopy(b, fresh, "init", "-q", "-b", "main");
    for (const n of ["x", "y"]) {
      writeInCopy(b, path.join(fresh, `${n}.txt`), `${n}\n`);
      gitCopy(b, fresh, "add", `${n}.txt`);
      gitCopy(b, fresh, "commit", "-q", "-m", n);
    }
    const mainPrior = refs(app, "refs");
    const copyPrior = gitCopy(b, app, "for-each-ref", "--format=%(refname) %(objectname)");

    const url = `${ctx.base}/api/projects/${pid}/stack-copies`;
    assert.equal((await response(`${url}/k9/state`)).status, 404);
    const r = await response(`${url}/k1/state`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.loaded, true, JSON.stringify(r.body));
    const row = (rel) => r.body.repos.find((x) => x.rel === rel);
    const a = row("app");
    assert.ok(a, `app missing: ${JSON.stringify(r.body.repos)}`);
    assert.deepEqual([a.name, a.branch, a.detached, a.commits, a.open, a.openCount, a.fresh], ["app", "main", false, 1, ["open.txt"], 1, false], JSON.stringify(a));
    const n = row("fresh");
    assert.ok(n, `the new repo is missing: ${JSON.stringify(r.body.repos)}`);
    assert.deepEqual([n.branch, n.commits, n.fresh, n.openCount], ["main", 2, true, 0], JSON.stringify(n));
    assert.equal(r.body.repos.some((x) => x.rel === "."), false, "the project repo merges the clearing away itself — it is not in the preview");
    assert.deepEqual(r.body.chats, [{ id: chat.id, title: store.getChat(chat.id).title, running: false }]);
    // Read-only: no ref changed in the main instance or in the copy.
    assert.deepEqual(refs(app, "refs"), mainPrior, "the preview changed refs in the main instance");
    assert.equal(gitCopy(b, app, "for-each-ref", "--format=%(refname) %(objectname)"), copyPrior, "the preview changed refs in the copy");
  });
});

test("(2) read error ⇒ loaded: false with a reason (never an empty list); not ready ⇒ 409 COPY_STATE", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const k = await buildCopy(b);
    const url = `${ctx.base}/api/projects/${pid}/stack-copies/k1/state`;
    // The container of the copy is stopped (the rows still say `ready`): nothing can be read.
    dx(b.fd, "stop", b.copy);
    const r = await response(url);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.loaded, false, JSON.stringify(r.body));
    assert.equal("repos" in r.body, false, "a read error must not carry an (empty) list of repos");
    assert.ok(typeof r.body.error === "string" && r.body.error.length > 0, JSON.stringify(r.body));
    // Not ready: 409 with the state.
    setCopyState(k.id, "clearAway", { phase: "earmarked", reason: "Test" });
    const z = await response(url);
    assert.equal(z.status, 409, JSON.stringify(z.body));
    assert.deepEqual([z.body.code, z.body.state], ["COPY_STATE", "clearAway"]);
  });
});
