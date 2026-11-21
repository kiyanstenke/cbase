// Compact folders already in the collapsed tree: every folder entry of a listing carries its chain of single subfolders (`chain`), so
// "deep/a/b/c" shows collapsed (like VS Code's `resolveSingleChildDescendants`). The computation lives in files.js `chainsAlongside`
// (B, with and without limit) and in the core `list` of runtime/fileAccess.js (copy, project container): the same rule.
// The promises:
//   (a) A chain runs while a folder has EXACTLY one entry and that entry is a folder; `.git` does not count; a symlink is no link of
//       the chain and gets none; a heavy folder (node_modules) ends it as last link and gets no chain itself.
//   (b) With limit the same answer.
//   (c) Inward cap: at most CHAIN_DEPTH links per folder, at most CHAINS_READ_MAX folders read per listing; the remaining folders
//       have no chain (they load on expand like any folder).
//   (d) The core `list` with `chains` gives the same chains in B and as program as files.js.
//
// COUNTER-TESTS (one place changed each):
//   files.js `chainsAlongside`: `.filter((x) => x.name !== ".git")` removed    => (a)(b) red ("r" without chain)
//   files.js `chainsAlongside`: `|| e.symlink` removed                         => (a)(b) red ("link" with chain)
//   files.js `chainsAlongside`: `&& read < CHAINS_READ_MAX` removed            => (c) red (all 250 with chain)
//   core `list`: `.filter((d) => d.name !== ".git")` removed                   => (d) red
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/files-chains.test.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HEAVY_DIRS, CHAIN_DEPTH, CHAINS_READ_MAX, listDir } from "../electron/server/files.js";
import { CORES, PROGRAM } from "../electron/server/runtime/fileAccess.js";
import { realRoots } from "../electron/server/runtime/real-path.js";

function create(root, rel, content = "x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const withFolder = (f) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chains-")));
  try { return f(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
// Per entry: the paths of its chain (empty: none).
const chains = (r) => Object.fromEntries(r.entries.map((e) => [e.name, (e.chain ?? []).map((k) => k.path)]));

function build(P) {
  create(P, "deep/a/b/c/x.ts");
  create(P, "two/x/1.ts");
  create(P, "two/y/2.ts");
  fs.mkdirSync(path.join(P, "empty"), { recursive: true });
  fs.symlinkSync("deep", path.join(P, "link"));
  create(P, "pak/node_modules/q/index.js");
  create(P, "r/.git/HEAD", "ref: refs/heads/main\n");
  create(P, "r/sub/s.ts");
  create(P, "individual/f.ts");
  create(P, "node_modules/z/index.js");
  create(P, "middle/a/b.ts");
  create(P, "middle/a/c/d.ts");
}
const EXPECTED = {
  individual: [],
  empty: [],
  link: [],
  middle: ["middle/a"],
  node_modules: [],
  pak: ["pak/node_modules"],
  r: ["r/sub"],
  deep: ["deep/a", "deep/a/b", "deep/a/b/c"],
  two: [],
};

test("(a) chains of single subfolders in B: .git does not count, no symlink, a heavy folder ends them", () => withFolder((root) => {
  const P = path.join(root, "project");
  build(P);
  const r = listDir(P, "");
  assert.deepEqual(chains(r), EXPECTED);
  const pak = r.entries.find((e) => e.name === "pak").chain[0];
  assert.deepEqual(pak, { name: "node_modules", path: "pak/node_modules", type: "dir", size: 0, symlink: false, heavy: true });
  // One level deeper: the same rule, paths relative to the project.
  assert.deepEqual(chains(listDir(P, "deep")), { a: ["deep/a/b", "deep/a/b/c"] });
}));

test("(b) with limit: same response", () => withFolder((root) => {
  const P = path.join(root, "project");
  build(P);
  assert.deepEqual(chains(listDir(P, "", { limit: () => realRoots([P]) })), EXPECTED);
}));

test("(c) inward cap: CHAIN_DEPTH links, CHAINS_READ_MAX folders read per listing", () => withFolder((root) => {
  const P = path.join(root, "project");
  create(P, `lang/${Array.from({ length: CHAIN_DEPTH + 8 }, (_, i) => `t${i}`).join("/")}/x.ts`);
  const lang = listDir(P, "").entries.find((e) => e.name === "lang");
  assert.equal(lang.chain.length, CHAIN_DEPTH);
  // 250 folders `dNNN/x/` (empty): two folders read each => exactly CHAINS_READ_MAX / 2 get their chain, the rest none.
  const Q = path.join(root, "wide");
  for (let i = 0; i < 250; i++) fs.mkdirSync(path.join(Q, `d${String(i).padStart(3, "0")}`, "x"), { recursive: true });
  const r = listDir(Q, "");
  const including = r.entries.filter((e) => e.chain);
  assert.equal(including.length, CHAINS_READ_MAX / 2);
  assert.deepEqual(including.map((e) => e.name), r.entries.slice(0, CHAINS_READ_MAX / 2).map((e) => e.name), "the first ones get their chain");
}));

test("(d) the core `list` with `chains` (copy, project container): same chains in B and as program as files.js", () => withFolder((root) => {
  const P = path.join(root, "project");
  build(P);
  const o = { chains: { depth: CHAIN_DEPTH, max: CHAINS_READ_MAX, heavy: [...HEAVY_DIRS] } };
  const inB = CORES.programCore(fs, path, crypto, "list", o, [P], () => Buffer.alloc(0));
  const out = execFileSync(process.execPath, ["-e", PROGRAM, "--", "list", JSON.stringify(o), P], { encoding: "utf8" });
  const asProgram = JSON.parse(out.trim().split("\n").pop());
  // The core chain carries a name per link; the copy side computes the paths from it.
  const names = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.map((p) => p.split("/").pop())]));
  for (const r of [inB, asProgram]) {
    const byKey = Object.fromEntries(r.entries.filter((e) => e.kind === "folder" || e.kind === "reference").map((e) => [e.name, e.chain ?? []]));
    assert.deepEqual(byKey, names);
    assert.ok(r.entries.every((e) => typeof e.mode === "number"), "every entry carries its mode");
  }
}));
