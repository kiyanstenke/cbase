import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ArtifactError,
  artifactExists,
  copyChatArtifacts,
  deleteArtifact,
  initArtifacts,
  listArtifacts,
  readArtifact,
  removeChatArtifacts,
  sanitizeArtifactPath,
  writeArtifact,
} from "../electron/server/artifacts.js";

function withArtifacts(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-artifacts-"));
  initArtifacts(root);
  try { return run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("artifacts are free-form nested files of a chat", () => withArtifacts(() => {
  const created = writeArtifact("chat-a", "issues/01-login.md", "# Login\n");
  assert.equal(created.path, "issues/01-login.md");
  assert.equal(created.unchanged, false);

  const list = listArtifacts("chat-a");
  assert.equal(list.length, 1);
  assert.equal(list[0].path, "issues/01-login.md");
  assert.equal(list[0].mime, "text/markdown; charset=utf-8");

  const read = readArtifact("chat-a", "issues/01-login.md");
  assert.equal(read.content, "# Login\n");
  assert.equal(read.encoding, "utf8");
  assert.equal(read.truncated, false);
}));

test("overwriting and deleting need the current hash", () => withArtifacts(() => {
  const first = writeArtifact("chat-a", "spec.md", "v1");
  assert.throws(() => writeArtifact("chat-a", "spec.md", "v2"), (e) => e instanceof ArtifactError && e.status === 409);
  assert.throws(() => writeArtifact("chat-a", "spec.md", "v2", { expectedSha256: "stale" }), /zwischenzeitlich/);

  const second = writeArtifact("chat-a", "spec.md", "v2", { expectedSha256: first.sha256 });
  assert.equal(readArtifact("chat-a", "spec.md").content, "v2");
  assert.throws(() => deleteArtifact("chat-a", "spec.md", first.sha256), /aktuellen expectedSha256/);
  assert.deepEqual(deleteArtifact("chat-a", "spec.md", second.sha256), { path: "spec.md", deleted: true });
  assert.deepEqual(listArtifacts("chat-a"), []);
}));

test("binary content is read losslessly as base64", () => withArtifacts(() => {
  const data = Buffer.from([0, 1, 2, 250, 255]);
  writeArtifact("chat-a", "result.bin", data.toString("base64"), { encoding: "base64" });
  const read = readArtifact("chat-a", "result.bin");
  assert.equal(read.encoding, "base64");
  assert.deepEqual(Buffer.from(read.content, "base64"), data);
}));

test("manual upload: raw buffer, trimmed name, overwrite only on request", () => withArtifacts(() => {
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const created = writeArtifact("chat-a", "image.png", bytes);
  assert.equal(created.size, 5);
  assert.deepEqual(Buffer.from(readArtifact("chat-a", "image.png").content, "base64"), bytes);

  // Without overwrite the agents' hash rule still applies …
  assert.throws(() => writeArtifact("chat-a", "image.png", Buffer.from("fresh")), (e) => e.status === 409);
  // … with overwrite the human replaces the file without a read hash.
  assert.equal(writeArtifact("chat-a", "image.png", Buffer.from("fresh"), { overwrite: true }).unchanged, false);
  assert.equal(Buffer.from(readArtifact("chat-a", "image.png").content, "base64").toString(), "fresh");

  assert.equal(artifactExists("chat-a", "image.png"), true);
  assert.equal(artifactExists("chat-a", "missing.png"), false);
}));

test("uploaded file names are trimmed instead of rejected", () => {
  assert.equal(sanitizeArtifactPath("Spec v2 (final).md"), "Spec v2 (final).md");
  assert.equal(sanitizeArtifactPath("folder\\under/file.md"), "folder/under/file.md");
  assert.equal(sanitizeArtifactPath("/../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizeArtifactPath("  ...  "), "upload");
  assert.equal(sanitizeArtifactPath(""), "upload");
  const long = sanitizeArtifactPath(`${"a".repeat(400)}.md`);
  assert.equal(long.length, 180);
  assert.ok(long.endsWith(".md"));
});

test("traversal and symbolic links do not escape the chat", () => withArtifacts((root) => {
  assert.throws(() => writeArtifact("chat-a", "../escape.md", "no"), /ungültige Segmente/);
  assert.throws(() => writeArtifact("chat-a", "/tmp/escape.md", "no"), /relativ/);
  fs.mkdirSync(path.join(root, "chat-a"), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, "chat-a", "outside"));
  assert.throws(() => writeArtifact("chat-a", "outside/escape.md", "no"), /Symbolische Links/);
  assert.throws(() => listArtifacts("chat-a"), /Symbolische Links/);
}));

test("fork copies a snapshot and deleting the chat cleans it up", () => withArtifacts((root) => {
  writeArtifact("parent", "spec.md", "parent");
  writeArtifact("parent", "issues/01.md", "issue");
  assert.equal(copyChatArtifacts("parent", "child"), 2);
  const child = readArtifact("child", "spec.md");
  writeArtifact("parent", "spec.md", "changed", { expectedSha256: readArtifact("parent", "spec.md").sha256 });
  assert.equal(readArtifact("child", "spec.md").content, "parent");
  assert.equal(child.content, "parent");
  removeChatArtifacts("parent");
  assert.equal(fs.existsSync(path.join(root, "parent")), false);
  assert.equal(readArtifact("child", "issues/01.md").content, "issue");
}));
