// Outputs visible: a chat's output location under Artifacts -> Outputs, read-only: runs/outputs-view.js (computation) and
// chats/outputs-routes.js (GET /outputs, GET /outputs/file).
//
// What this guard holds:
//   (1) List: newest first (folders by their newest file are sorted in the client), subfolders as a path, `internal` exactly for
//       agents/... and workflows/..., the roots (the current location first); the file comes with type, nosniff, `private, no-cache`,
//       disposition inline/attachment; active types (HTML) under the sandbox CSP.
//   (2) Boundary: `..`, absolute, empty part, backslash => 400; a link in place of the file, a subfolder that is a link leading
//       out, and an output location that is itself a link => never the content behind it (403/404) and not in the list.
//   (3) Archive: GET (list and file) on an archived chat works.
//   (4) Cap: `max` cuts off the oldest and says `clipped`; the walk cap likewise, `total` = cap.
//   (5) Runtime folder of a converted project: the location sits under <data>/projects/<p>/outputs/<chat>; the old flat location
//       (before the move) is read as well, for equal paths the current one wins.
//   (6) System prompt: a coding chat's main run carries the fixed paragraph with the SAME path it gets as --add-dir.
//
// COUNTER-TESTS (each shown red, then restored):
//   outputs-view.js `relativeOutputPath` without the ".." check => (2) red (400 expected, got 404 - and with a link-free `..`
//     the file NEXT TO the location);
//   outputs-view.js `openFileWithoutReference(...)` -> `fs.openSync(path.join(w.path, ...parts), "r")` => (2) red (content behind the link);
//   outputs-view.js `realRoots([w.path], [anchor], ...)` -> `realRoots([w.path], [])` (no anchor: the realpath of the location) => (2)
//     "location itself a link" red (removing `strict` alone stays green - the root always lies under its anchor, measured);
//   outputs-view.js the loop over the other locations removed (only the current one) => (5) red;
//   outputs-view.js `all.slice(0, max)` -> `all` => (4) red;
//   do-run.js the line `if (mainRun) systemPrompt += ... outputsSentence(...)` removed => (6) red.
//
// Run: ./check (a single file only with the gate environment)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { outputLocation, outputsSentence } from "../electron/server/runs/outputs.js";
import { outputsList, relativeOutputPath } from "../electron/server/runs/outputs-view.js";
import { outputLocationIn, locationFor } from "../electron/server/runs/runtime-location.js";
import { json, makeChat, makeProject, makeWorkspace, waitFor, withServer } from "./server-harness.mjs";

const write = (file, content, mtimeS = null) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeS !== null) fs.utimesSync(file, mtimeS, mtimeS);
};
const list = (base, id) => json(`${base}/api/chats/${id}/outputs`);
const file = (base, id, rel, inline = false) =>
  fetch(`${base}/api/chats/${id}/outputs/file?path=${encodeURIComponent(rel)}${inline ? "&inline=1" : ""}`);

test("(1) list newest first, internal only agents/ and workflows/, file with type and headers", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    write(path.join(location, "review-31.md"), "# Report\n", 1_800_000_300);
    write(path.join(location, "check.js"), "console.log(1)\n", 1_800_000_100);
    write(path.join(location, "screens", "qa31-a.png"), "PNG", 1_800_000_200);
    write(path.join(location, "agents", "a1.output"), "finished", 1_800_000_400);
    write(path.join(location, "workflows", "w.js"), "x", 1_800_000_050);
    write(path.join(location, "page.html"), "<script>alert(1)</script>", 1_800_000_010);

    const r = await list(base, chat.id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.roots, [location], "the root is the chat's output location");
    assert.deepEqual(r.body.entries.map((e) => e.path),
      ["agents/a1.output", "review-31.md", "screens/qa31-a.png", "check.js", "workflows/w.js", "page.html"], "newest first");
    assert.deepEqual(r.body.entries.filter((e) => e.internal).map((e) => e.path), ["agents/a1.output", "workflows/w.js"]);
    assert.equal(r.body.clipped, false);
    assert.equal(r.body.total, 6);
    const md = r.body.entries.find((e) => e.path === "review-31.md");
    assert.equal(md.size, 9);
    assert.equal(md.changed, 1_800_000_300_000);

    const d = await file(base, chat.id, "review-31.md", true);
    assert.equal(d.status, 200);
    assert.equal(await d.text(), "# Report\n");
    assert.match(d.headers.get("content-type"), /^text\/markdown/);
    assert.match(d.headers.get("content-disposition"), /^inline;/);
    assert.equal(d.headers.get("x-content-type-options"), "nosniff");
    assert.equal(d.headers.get("cache-control"), "private, no-cache");
    const image = await file(base, chat.id, "screens/qa31-a.png");
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-disposition"), /^attachment;/);
    assert.equal(await image.text(), "PNG");
    const html = await file(base, chat.id, "page.html", true);
    assert.match(html.headers.get("content-security-policy") || "", /^sandbox/, "active type only in the sandbox");
    await html.text();
    // Without an output location (a chat that never ran): empty, not created - GET writes nothing.
    const empty = await makeChat(base, ws.id);
    const l = await list(base, empty.id);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.entries, []);
    assert.equal(fs.existsSync(outputLocation(empty.id)), false, "the list does not create the location");
  });
});

test("(2) boundary: .., absolute, link in place of the file, link folder leading out, location itself a link", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    const outside = path.join(root, "outside");
    write(path.join(outside, "secret.txt"), "SECRET");
    write(path.join(location, "ok.txt"), "ok");
    // Next to it (the output-location folder of all chats) - `..` pointed exactly here.
    write(path.join(path.dirname(location), "neighbor.txt"), "NEIGHBOR");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(location, "reference.txt"));
    fs.symlinkSync(outside, path.join(location, "screens"));

    for (const malicious of ["../neighbor.txt", "a/../../neighbor.txt", "/etc/passwd", "a//b", "./ok.txt", "a\\b", ""]) {
      const r = await file(base, chat.id, malicious);
      const text = await r.text();
      assert.equal(r.status, 400, `400 for ${JSON.stringify(malicious)}`);
      assert.doesNotMatch(text, /NEIGHBOR|SECRET/);
    }
    for (const rel of ["reference.txt", "screens/secret.txt"]) {
      const r = await file(base, chat.id, rel);
      const text = await r.text();
      assert.ok(r.status === 403 || r.status === 404, `${rel}: ${r.status}`);
      assert.doesNotMatch(text, /SECRET/, `${rel}: never the content behind the link`);
    }
    assert.deepEqual((await list(base, chat.id)).body.entries.map((e) => e.path), ["ok.txt"], "links do not appear");
    assert.equal(relativeOutputPath("screens/a.png").join("|"), "screens|a.png");

    // The output location itself a link leading out: nothing in the list, no file.
    const second = await makeChat(base, ws.id);
    fs.symlinkSync(outside, outputLocation(second.id));
    assert.deepEqual((await list(base, second.id)).body.entries, [], "a location that is itself a link contributes nothing");
    const r = await file(base, second.id, "secret.txt");
    assert.equal(r.status, 403);
    assert.doesNotMatch(await r.text(), /SECRET/);
  });
});

test("(3) archive: list and file work on an archived chat", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    write(path.join(outputLocation(chat.id), "report.md"), "# R");
    store.archiveChat(chat.id, Date.now(), "user");
    assert.ok(store.getChat(chat.id).archivedAt, "initial state: archived");
    const l = await list(base, chat.id);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.entries.map((e) => e.path), ["report.md"]);
    const d = await file(base, chat.id, "report.md");
    assert.equal(d.status, 200);
    assert.equal(await d.text(), "# R");
    // There is no writing route under /outputs - and in the archive it would be 409 anyway.
    assert.equal((await json(`${base}/api/chats/${chat.id}/outputs`, { method: "POST", body: "{}" })).status, 409);
  });
});

test("(4) cap: max cuts off the oldest and says so; the walk cap likewise", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    const location = outputLocation(chat.id);
    for (let i = 0; i < 6; i++) write(path.join(location, "screens", `s${i}.png`), "x", 1_800_000_000 + i);
    const c = store.getChat(chat.id);
    const r = outputsList(c, { max: 3 });
    assert.deepEqual(r.entries.map((e) => e.path), ["screens/s5.png", "screens/s4.png", "screens/s3.png"], "the newest three");
    assert.equal(r.clipped, true);
    assert.equal(r.total, 6);
    assert.equal(r.max, 3);
    const g = outputsList(c, { walkMax: 4 });
    assert.equal(g.clipped, true);
    assert.equal(g.total, 4);
    assert.equal(g.entries.length, 4);
    assert.equal(outputsList(c).clipped, false);
  });
});

test("(5) converted project: the location in the runtime folder, the old flat one is read as well", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const chat = await makeChat(base, ws.id);
    const flat = outputLocation(chat.id);
    write(path.join(flat, "old.md"), "OLD", 1_800_000_000);
    write(path.join(flat, "both.md"), "FLAT", 1_800_000_000);
    assert.equal((await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: proj.id }) })).status, 200);
    store.createProjectInstance({ projectId: proj.id, state: "ready", convertedAt: Date.now() });
    const fresh = outputLocationIn(locationFor({ projectId: proj.id, converted: true }), chat.id);
    assert.equal(outputLocation(chat.id), fresh, "initial state: the location is now in the runtime folder");
    assert.match(fresh, new RegExp(`projects[/\\\\]${proj.id}[/\\\\]outputs[/\\\\]${chat.id}$`));
    write(path.join(fresh, "fresh.md"), "FRESH", 1_800_000_100);
    write(path.join(fresh, "both.md"), "NOW", 1_800_000_050);

    const l = await list(base, chat.id);
    assert.deepEqual(l.body.roots, [fresh, flat], "the current location first, then the old one");
    assert.deepEqual(l.body.entries.map((e) => e.path), ["fresh.md", "both.md", "old.md"]);
    assert.equal(await (await file(base, chat.id, "both.md")).text(), "NOW", "same path: the current location wins");
    assert.equal(await (await file(base, chat.id, "old.md")).text(), "OLD", "fallback to the old location");
  });
});

test("(6) system prompt: the main run carries the fixed paragraph with the path of its --add-dir", async () => {
  await withServer(async ({ base, wsPath, turns }) => {
    const ws = await makeWorkspace(base, "AU", wsPath);
    const chat = await makeChat(base, ws.id);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "outputs sentence" }) });
    const turn = await waitFor(async () => turns().find((x) => x.text.includes("outputs sentence")), "Turn");
    const i = turn.argv.indexOf("--append-system-prompt");
    const prompt = i >= 0 ? String(turn.argv[i + 1]) : "";
    const location = outputLocation(chat.id);
    assert.ok(prompt.includes(outputsSentence(location)), "the fixed paragraph is in the system prompt");
    assert.ok(turn.argv.some((a, k) => a === "--add-dir" && turn.argv[k + 1] === location) || turn.argv.includes(location), "the same path as --add-dir");
    assert.match(outputsSentence("/x/y"), /Artifacts → Outputs/);
  });
});
