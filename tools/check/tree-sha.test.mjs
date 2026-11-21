// The deploy tool's tree hash.
//
// The whole tree is measured (not only the `server.js` facade, which would report "== working tree" while something else runs in a
// feature folder), and the same computation runs as a shell line in the container, in the image and in current/. Two versions that
// drift apart would be worse than none: a false "DIFFERS" for identical code or a false "==" for different code. Every guard here
// has been shown red once.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { asarRead, bundleSha, readAsar, sha256, treeFiles, treeSha, treeShaOf, treeShaShell } from "./lib/asar.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const e = (rel, text) => ({ rel, buf: Buffer.from(text) });
const rels = (entries) => entries.map((x) => x.rel);
const byteSorted = (list) => [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-deploytest-"));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// Writes [{ rel, text }] under dir; subfolders are created.
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

// A tree whose order is only right bytewise: `.` (0x2E) before `/` (0x2F) and `Z` (0x5A) before
// `a` (0x61) — a locale sort put `alpha.js` before `Zeta.js` and `providers/index.js` before `providers.js` depending on the
// locale. Plus one file that does NOT count.
const TREE = {
  "providers.js": "export const a = 1;\n",
  "providers/index.js": "export const b = 2;\n",
  "providers/connectors/codex.js": "export const c = 3;\n",
  "Zeta.js": "export const z = 26;\n",
  "alpha.js": "export const alpha = 1;\n",
  "README.md": "# does not count\n",
};
const TREE_JS = Object.entries(TREE).filter(([rel]) => rel.endsWith(".js")).map(([rel, text]) => e(rel, text));

// ── treeShaOf ────────────────────────────────────────────────────────────────────────────────

test("treeShaOf: entry order does not matter — two permutations, one hash", () => {
  const a = [e("a.js", "1"), e("b/c.js", "2"), e("z.js", "3")];
  const b = [a[2], a[0], a[1]];
  const c = [a[1], a[2], a[0]];
  assert.match(treeShaOf(a), HEX64);
  assert.equal(treeShaOf(b), treeShaOf(a));
  assert.equal(treeShaOf(c), treeShaOf(a));
});

test("treeShaOf/treeFiles: sorted bytewise — providers.js before providers/index.js, Zeta.js before alpha.js", () => {
  const tmp = tmpDir();
  try {
    writeTree(tmp, TREE);
    const files = treeFiles(tmp);
    const order = rels(files);
    // Exactly the order Buffer.compare gives — that is `LC_ALL=C sort`.
    assert.deepEqual(order, byteSorted(order));
    assert.deepEqual(order, ["Zeta.js", "alpha.js", "providers.js", "providers/connectors/codex.js", "providers/index.js"]);
    assert.ok(order.indexOf("providers.js") < order.indexOf("providers/index.js"), "`.` (0x2E) sorts before `/` (0x2F)");
    assert.ok(order.indexOf("Zeta.js") < order.indexOf("alpha.js"), "`Z` (0x5A) sorts before `a` (0x61)");
    // README.md does not count — TREE_GLOB is *.js.
    assert.ok(!order.includes("README.md"));
  } finally {
    clean(tmp);
  }
});

// Counter-test: a hash that stayed the same under these three changes would prove nothing.
test("counter-test: one byte, one more file, a different name — each changes the hash", () => {
  const base = [e("a.js", "hello"), e("sub/b.js", "world")];
  const h = treeShaOf(base);
  assert.match(h, HEX64);
  const oneByte = [e("a.js", "hello"), e("sub/b.js", "world!")];
  const oneMore = [...base, e("c.js", "")];
  const renamed = [e("a.js", "hello"), e("sub/c.js", "world")];
  assert.notEqual(treeShaOf(oneByte), h, "one byte in the content");
  assert.notEqual(treeShaOf(oneMore), h, "one more file (even empty)");
  assert.notEqual(treeShaOf(renamed), h, "same content under a different name");
});

// ── treeSha(dir) ─────────────────────────────────────────────────────────────────────────────

test("treeSha(dir): subfolders count, non-.js files do not — expectation by hand from treeShaOf", () => {
  const tmp = tmpDir();
  try {
    writeTree(tmp, TREE);
    // By hand: only the .js entries, passed in any order.
    const expected = treeShaOf([...TREE_JS].reverse());
    assert.equal(treeSha(tmp), expected);
    // The non-.js file is really invisible: changing it keeps the hash.
    fs.writeFileSync(path.join(tmp, "README.md"), "# changed, still does not count\n");
    assert.equal(treeSha(tmp), expected);
    // Counter-test: change a .js file in a subfolder → different hash.
    fs.writeFileSync(path.join(tmp, "providers/connectors/codex.js"), "export const c = 4;\n");
    assert.notEqual(treeSha(tmp), expected);
  } finally {
    clean(tmp);
  }
});

test("treeSha: a missing folder is null, not a hash over nothing", () => {
  const tmp = tmpDir();
  try {
    assert.equal(treeSha(path.join(tmp, "exists-not")), null);
    // An empty folder, by contrast, IS a tree (without files) — hash of the empty list.
    assert.equal(treeSha(tmp), treeShaOf([]));
  } finally {
    clean(tmp);
  }
});

// ── Shell version ────────────────────────────────────────────────────────────────────────────
//
// The recipe lives exactly once in asar.mjs; the shell line is generated from it. This test really runs it (/bin/sh) and holds it
// against the JS revision — before and after a change, so two wrong versions cannot agree by accident.
// On macOS sha256sum is not everywhere; where it is missing a shim falls back to shasum. If `command -v` already finds one, the shim
// is left out — the real tool is then what is checked.
function shellEnvironment(shimDir) {
  const existing = execFileSync("/bin/sh", ["-c", "command -v sha256sum >/dev/null 2>&1 && echo yes || echo no"], { encoding: "utf8" }).trim() === "yes";
  if (existing) return { env: process.env, shim: false };
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "sha256sum"), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  return { env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }, shim: true };
}

test("shell version = JS revision: treeShaShell via /bin/sh yields the same 64 characters as treeSha", () => {
  const tmp = tmpDir();
  try {
    const tree = path.join(tmp, "tree");
    writeTree(tree, TREE);
    const { env } = shellEnvironment(path.join(tmp, "bin"));
    const shell = () => execFileSync("/bin/sh", ["-c", treeShaShell(tree)], { encoding: "utf8", env }).trim();

    const prior = shell();
    assert.match(prior, HEX64);
    assert.equal(prior, treeSha(tree));

    // Counter-test: change one byte — both versions move, to the same value.
    fs.writeFileSync(path.join(tree, "providers/index.js"), "export const b = 3;\n");
    const after = shell();
    assert.notEqual(after, prior);
    assert.equal(after, treeSha(tree));
  } finally {
    clean(tmp);
  }
});

// ── Bundle (asar) ────────────────────────────────────────────────────────────────────────────
//
// Format from the head of asar.mjs: 4 B pickle size (4) | 4 B header pickle size | 4 B header string size | 4 B JSON length | JSON
// (padded to 4) | payload from 8 + header pickle size. Header pickle size = 8 + JSON length rounded up to 4.
function writeAsar(file, files) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const d of files) {
    const parts = d.rel.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) node = node.files[p] ??= { files: {} };
    node.files[parts.at(-1)] = { size: d.buf.length, offset: String(offset) };
    chunks.push(d.buf);
    offset += d.buf.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const on4 = (json.length + 3) & ~3;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + on4, 4);
  head.writeUInt32LE(4 + on4, 8);
  head.writeUInt32LE(json.length, 12);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, json, Buffer.alloc(on4 - json.length), ...chunks]));
}

// An archive like the real one: the server tree, next to it a second folder (mcp/) and files that do not count — the JSON length
// is deliberately not a multiple of 4 so the padding kicks in.
const ARCHIVE = [
  e("electron/server/a.js", "export const a = 1;\n"),
  e("electron/server/sub/b.js", "export const b = 2;\n"),
  e("electron/server/README.md", "# does not count\n"),
  e("electron/mcp/cbase-mcp.js", "export const mcp = true;\n"),
  e("package.json", '{"name":"cbase"}\n'),
];

// The tree hash INSIDE the former standalone app's bundle is no longer read. Reading single files stays: the client's shell.
test("asarRead/bundleSha against a synthetic asar: payload from the right offset, missing bundle and missing file are null", () => {
  const tmp = tmpDir();
  try {
    const app = path.join(tmp, "Probe.app");
    const asar = path.join(app, "Contents/Resources/app.asar");
    writeAsar(asar, ARCHIVE);
    // The reader sees the archive as such (pickle size 4, header parsable).
    assert.ok(readAsar(asar).header.files.electron.files.server.files["a.js"]);
    assert.equal(asarRead(asar, "electron/server/sub/b.js").toString(), "export const b = 2;\n", "payload from the right offset");
    assert.equal(bundleSha(app, "package.json"), sha256(Buffer.from('{"name":"cbase"}\n')));
    assert.equal(bundleSha(app, "electron/server/exists-not.js"), null);
    assert.equal(bundleSha(app, "electron/server"), null, "a folder is not a file");
    assert.equal(bundleSha(path.join(tmp, "missing.app"), "package.json"), null);
    // Counter-test: one byte different ⇒ a different hash.
    writeAsar(asar, ARCHIVE.map((d) => (d.rel === "package.json" ? e(d.rel, '{"name":"other"}\n') : d)));
    assert.notEqual(bundleSha(app, "package.json"), sha256(Buffer.from('{"name":"cbase"}\n')));
  } finally {
    clean(tmp);
  }
});
