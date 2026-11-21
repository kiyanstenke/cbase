// The location of a chat in the chat list. The leaf web/src/lib/chat-location.ts is compiled with tsc and EXECUTED; the three callers
// are read at their source.
//
// The claims, each with the way that breaks it:
//   (a) the short info shows the copy the chat works IN (`instance` = `copy-<name>`), never the one it created: a chat in main with a
//       `copy` field (an older server that still delivers `stack_copies.chat_id`) shows NONE; the name comes from `instance`, the
//       state only from a `copy` field with the same name (otherwise unknown — no foreign state word).
//   (b) the event `project/copy` applies to every row that works in exactly this copy (same project AND `copy-<name>`) —
//       not to the creator (`msg.chatId`), not to a same-named copy of another project; without a change the same list.
//   (c) `removed` stays as a state (as GET /api/chats reports a binding without a live row) and has a word.
//   (d) the callers: ChatListPane computes `location` via `chatCopyLocation`, ChatPane applies `project/copy` via `applyCopyEvent`
//       (no `msg.chatId` any more in this branch), and chatInstance.ts offers the child chat of a graph run (`parentChatId`) no
//       instance choice (the server answers 409 INSTANCE_PINNED).
//
// Run:  node --test web/test/chat-location.test.mjs
// Counter-tests (ONE place each via a script, shown red; without sabotage 4/4):
//   lib/chat-location.ts   chatCopyLocation takes the name from `c.copy` instead of `instance`   ⇒ (a) red
//   lib/chat-location.ts   applyCopyEvent assigns via `chatId`                                   ⇒ (b), (c) red
//   chat/ChatListPane.tsx  `copyText(c.copy, t)` again (the state before the repair)             ⇒ (d) red
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "chat-location.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...parts) => fs.readFileSync(path.join(webDir, "src", ...parts), "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleaning up says nothing about the product */ } });

let module = null;
async function load() {
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-location-"));
  execFileSync(process.execPath, [tsc, SOURCE, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  module = await import(pathToFileURL(path.join(tmp, "chat-location.js")).href);
  return module;
}

test("(a) the short info shows the copy the chat works in — never the created one; the state only with the same name", async () => {
  const { chatCopyLocation, copyNameFromInstance } = await load();
  // The creator works in main — an older server still delivers "its" copy: no display.
  assert.equal(chatCopyLocation({ id: "a", projectId: "p1", instance: null, copy: { name: "k1", state: "ready" } }), null);
  assert.equal(chatCopyLocation({ id: "a", projectId: "p1", copy: { name: "k1", state: "ready" } }), null);
  // A chat started in the tab inside the copy (it created nothing): name from `instance`, state from the matching field.
  assert.deepEqual(chatCopyLocation({ id: "b", projectId: "p1", instance: "copy-k1", copy: { name: "k1", state: "build" } }), { name: "k1", state: "build" });
  // Without a field or with a foreign name: the copy is there, its state is unknown.
  assert.deepEqual(chatCopyLocation({ id: "c", projectId: "p1", instance: "copy-k2" }), { name: "k2", state: "" });
  assert.deepEqual(chatCopyLocation({ id: "c", projectId: "p1", instance: "copy-k2", copy: { name: "k1", state: "error" } }), { name: "k2", state: "" });
  assert.equal(chatCopyLocation({ id: "d", projectId: "p1", instance: "main" }), null);
  assert.equal(chatCopyLocation(null), null);
  assert.equal(copyNameFromInstance("copy-"), "");
  assert.equal(copyNameFromInstance("copy-a-b"), "a-b");
  assert.equal(copyNameFromInstance(undefined), "");
});

test("(b) `project/copy` hits every row in exactly this copy — not the creator, not the same word in another project", async () => {
  const { applyCopyEvent } = await load();
  const list = [
    { id: "creator", projectId: "p1", instance: null, copy: null },
    { id: "inside1", projectId: "p1", instance: "copy-k1", copy: { name: "k1", state: "build" } },
    { id: "inside2", projectId: "p1", instance: "copy-k1", copy: null },
    { id: "otherProject", projectId: "p2", instance: "copy-k1", copy: { name: "k1", state: "build" } },
    { id: "otherCopy", projectId: "p1", instance: "copy-k2", copy: { name: "k2", state: "build" } },
  ];
  const fresh = applyCopyEvent(list, { type: "project/copy", projectId: "p1", name: "k1", chatId: "creator", state: "ready" });
  const target = Object.fromEntries(fresh.map((c) => [c.id, c.copy]));
  assert.equal(target.creator, null, "the creator (msg.chatId) works in main — it gets no copy");
  assert.deepEqual(target.inside1, { name: "k1", state: "ready" });
  assert.deepEqual(target.inside2, { name: "k1", state: "ready" });
  assert.deepEqual(target.otherProject, { name: "k1", state: "build" }, "a same-named copy of another project");
  assert.deepEqual(target.otherCopy, { name: "k2", state: "build" });
  assert.equal(fresh.find((c) => c.id === "creator"), list[0], "untouched rows stay the same objects");
  // Nothing to change ⇒ the same list (React does not re-render); incomplete events change nothing.
  assert.equal(applyCopyEvent(fresh, { projectId: "p1", name: "k1", state: "ready" }), fresh);
  assert.equal(applyCopyEvent(list, { projectId: "p1", name: "k1" }), list);
  assert.equal(applyCopyEvent(list, { name: "k1", state: "ready" }), list);
});

test("(c) `removed` stays as a state and has a word in the tooltip (and in German)", async () => {
  const { applyCopyEvent, chatCopyLocation } = await load();
  const list = [{ id: "x", projectId: "p1", instance: "copy-k1", copy: { name: "k1", state: "clearAway" } }];
  const fresh = applyCopyEvent(list, { projectId: "p1", name: "k1", state: "removed" });
  assert.deepEqual(chatCopyLocation(fresh[0]), { name: "k1", state: "removed" });
  const short = read("lib", "chat-tooltip.ts");
  assert.match(short, /removed: "removed"/, "copyText knows no word for `removed`");
  assert.match(read("lib", "i18n-de.ts"), /^ {2}"removed": "abgeräumt",$/m);
});

test("(d) the callers: list via chatCopyLocation, event via applyCopyEvent, no instance choice in the child chat", () => {
  const list = read("components", "chat", "ChatListPane.tsx");
  assert.match(list, /copyText\(chatCopyLocation\(c\), t\)/, "the short info does not compute the location via chatCopyLocation");
  assert.doesNotMatch(list, /copyText\(c\.copy/, "the short info reads the raw `copy` field again");
  const pane = read("components", "chat", "ChatPane.tsx");
  const i = pane.indexOf('msg.type === "project/copy"');
  assert.ok(i > 0, "ChatPane no longer listens to `project/copy`");
  const branch = pane.slice(i, pane.indexOf("}", pane.indexOf("applyCopyEvent", i)));
  assert.match(branch, /setChats\(\(prev\) => applyCopyEvent\(prev, msg\)\)/, branch);
  assert.doesNotMatch(branch.replace(/\/\/.*$/gm, ""), /msg\.chatId/, "the branch assigns via the creator again");
  const instance = read("components", "chat", "chatInstance.ts");
  assert.match(instance, /const pinned = Boolean\(activeChat\?\.parentChatId\);/);
  assert.match(instance, /\(\) => \(!pinned && converted && read/, "the choice is offered to the child chat");
});
