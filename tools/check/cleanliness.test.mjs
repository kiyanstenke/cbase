// The cleanliness guard in the gate (tools/check/cleanliness.mjs carries the promise and the rules).
//
// COUNTER-TEST (built in, runs every time): a tree with one planted file per kind — a private term (the canary of the
// hash list), a routable IP, a foreign host, a mail address, a key shape, a device identifier, a signing team — must
// report every kind; the same tree without the plants must report nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, loadTerms, loadAllow, hashTerms, publicFiles, isPrivate, loadPrivatePaths, PRIVATE_PATHS, PRIVATE_LIST, TERMS_FILE, PRIVATE_TERMS_FILE } from "./cleanliness.mjs";

const CANARY = "cbase" + "canary" + "privateterm";

test("the public tree carries nothing private", () => {
  const findings = scan();
  assert.deepEqual(findings.map((f) => `${f.kind}  ${f.file}  ${f.what}`), [], "private content in the public tree");
});

test("the public terms file holds the canary alone — a published salt next to real hashes would let anyone test guesses", () => {
  const pub = JSON.parse(fs.readFileSync(TERMS_FILE, "utf8"));
  const expect = hashTerms([], { salt: pub.salt, extra: [CANARY] });
  assert.deepEqual({ s: pub.substring, w: pub.whole }, { s: expect.substring, w: expect.whole },
    "tools/check/cleanliness-terms.json carries more than the canary — rebuild it: node tools/check/cleanliness.mjs --hash");
});

test("where the private part is present, its hash list is filled, fresh, and the one the guard uses", () => {
  if (!fs.existsSync(PRIVATE_LIST)) return;   // a tree without the private part: the canary is all there is
  assert.ok(fs.existsSync(PRIVATE_TERMS_FILE), "the private hash list is missing — run: node tools/check/cleanliness.mjs --hash");
  const terms = loadTerms();
  assert.ok(terms.substring.size + terms.whole.size >= 10, "the private hash list is nearly empty — the guard would see nothing");
  const now = JSON.parse(fs.readFileSync(PRIVATE_TERMS_FILE, "utf8"));
  assert.equal(terms.salt, now.salt, "the guard must load the private list where it exists");
  assert.notEqual(now.salt, JSON.parse(fs.readFileSync(TERMS_FILE, "utf8")).salt, "the public file must not share the private salt");
  const d = hashTerms(fs.readFileSync(PRIVATE_LIST, "utf8").split("\n"), { salt: now.salt, extra: [CANARY] });
  assert.deepEqual({ s: now.substring, w: now.whole, l: now.lengths }, { s: d.substring, w: d.whole, l: d.lengths },
    "the private hash list is stale — run: node tools/check/cleanliness.mjs --hash");
});

test("the private part of the tree is not scanned as public, and nothing else is left out", () => {
  const files = publicFiles();
  assert.ok(files.length > 1000, `only ${files.length} files — the file list is broken`);
  assert.equal(files.filter((p) => isPrivate(p)).length, 0);
  // Which paths are private is the private part's own fact (its path list, held by the maintainer's private suite);
  // a tree without it has none — then everything is scanned.
  assert.deepEqual(PRIVATE_PATHS, loadPrivatePaths());
});

test("private paths: a trailing slash is a directory prefix, any other entry is exactly that file or a directory below it; no file, no list", () => {
  const list = ["priv/", "deploy", ".hooks/part.d/", "DEPLOY.md"];
  for (const p of ["priv/x/y.md", "deploy", ".hooks/part.d/10-block", "DEPLOY.md"]) assert.equal(isPrivate(p, list), true, p);
  for (const p of ["privx/y.md", "deployment/x.js", "deploy.local.example.jsonx", ".hooks/part", "docs/DEPLOY.md", "tools/deploy/x.mjs"]) assert.equal(isPrivate(p, list), false, p);
  assert.equal(isPrivate("deploy/lib/x.mjs", ["deploy"]), true, "a name without a slash also covers what lies below it");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-privpaths-"));
  try {
    assert.deepEqual(loadPrivatePaths(path.join(dir, "absent.json")), [], "a tree without the file has no private part");
    fs.writeFileSync(path.join(dir, "bad.json"), '{"priv/": true}');
    assert.throws(() => loadPrivatePaths(path.join(dir, "bad.json")), /list of non-empty path strings/);
    fs.writeFileSync(path.join(dir, "ok.json"), '["a/", "b"]');
    assert.deepEqual(loadPrivatePaths(path.join(dir, "ok.json")), ["a/", "b"]);
    // publicFiles takes the list as an argument: the same tree, another list, other files.
    fs.writeFileSync(path.join(dir, "keep.md"), "x\n"); fs.mkdirSync(path.join(dir, "a")); fs.writeFileSync(path.join(dir, "a", "hide.md"), "x\n");
    assert.deepEqual(publicFiles(dir, ["a/"]).sort(), ["bad.json", "keep.md", "ok.json"]);
    assert.deepEqual(publicFiles(dir, []).sort(), ["a/hide.md", "bad.json", "keep.md", "ok.json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("counter-test: every kind of planted private content is reported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clean-"));
  try {
    const plant = { "clean.md": "Nothing here. See https://example.com and 127.0.0.1, mail a@example.com.\n",
      "term.js": `const owner = "my${CANARY}Name";\n`,
      "ip.txt": "host " + ["8", "8", "4", "4"].join(".") + "\n",
      "host.txt": "see https://intra." + "corp-portal.de/path\n",
      "mail.txt": "write to someone@" + "corp-portal.de\n",
      "secret.txt": "token gh" + "p_" + "A".repeat(30) + "\n",
      "device.txt": "udid 0000" + "8150-" + "0123456789ABCDEF\n",
      "team.pbxproj": "DEVELOPMENT_" + "TEAM = ABCDE12345;\n" };
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    const args = { root, terms: loadTerms(), allow: loadAllow() };
    const kinds = (files) => [...new Set(scan({ ...args, files }).map((f) => `${f.kind}:${f.file}`))].sort();
    assert.deepEqual(kinds(["clean.md"]), [], "the clean file must pass");
    assert.deepEqual(kinds(Object.keys(plant)), ["account:team.pbxproj", "device:device.txt", "host:host.txt", "ip:ip.txt", "mail:mail.txt", "secret:secret.txt", "term:term.js"]);
    // The path counts as well: a private term in a file name is found.
    fs.writeFileSync(path.join(root, `notes-${CANARY}.md`), "x\n");
    assert.deepEqual(kinds([`notes-${CANARY}.md`]), [`term:notes-${CANARY}.md`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the copyright line of LICENSE passes, the same name anywhere else does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clean-"));
  try {
    const name = ["Ki", "yan"].join("") + " " + ["Sten", "ke"].join("");
    fs.writeFileSync(path.join(root, "LICENSE"), `Apache text\n   Copyright 2026 ${name}\n`);
    fs.writeFileSync(path.join(root, "notes.md"), `written by ${name}\n`);
    // A list that knows the name (the public file holds only the canary; the private list is not in every tree).
    const args = { root, terms: (({ salt, substring, whole, lengths }) => ({ salt, substring: new Set(substring), whole: new Set(whole), lengths }))(hashTerms(name.split(" "))), allow: loadAllow() };
    assert.deepEqual(scan({ ...args, files: ["LICENSE"] }), [], "the copyright line must pass");
    assert.ok(scan({ ...args, files: ["notes.md"] }).some((f) => f.kind === "term"), "the name elsewhere must be found");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the project's GitHub Pages site passes; another Pages site of the owner, a bare owner host, a look-alike path, http or no scheme does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clean-"));
  try {
    const owner = (["Ki", "yan"].join("") + ["Sten", "ke"].join("")).toLowerCase();
    const pages = `https://${owner}.github.io`;
    const plant = {
      "ok.md": `Privacy: ${pages}/cbase/privacy/\nSupport: [support](${pages}/cbase/support/)\nHome: ${pages}/cbase\n`,
      "other.md": `See ${pages}/other/\n`,
      "bare.md": `Hosted at ${owner}.github.io for now.\n`,
      "evil.md": `See ${pages}/cbase-evil/\n`,
      "http.md": `Privacy: http://${owner}.github.io/cbase/privacy/\n`,
      "noscheme.md": `Privacy: ${owner}.github.io/cbase/privacy/\n` };
    for (const [n, c] of Object.entries(plant)) fs.writeFileSync(path.join(root, n), c);
    // A list that knows the owner name (the public file holds only the canary; the private list is not in every tree).
    const args = { root, terms: (({ salt, substring, whole, lengths }) => ({ salt, substring: new Set(substring), whole: new Set(whole), lengths }))(hashTerms([owner])), allow: loadAllow() };
    const kinds = (file) => [...new Set(scan({ ...args, files: [file] }).map((f) => f.kind))].sort();
    assert.deepEqual(kinds("ok.md"), [], "the Pages URLs of this repository must pass");
    assert.ok(kinds("other.md").includes("host"), "another Pages site of the owner is a foreign host");
    assert.ok(kinds("bare.md").includes("term"), "the owner name outside the repository's addresses must be found");
    assert.ok(kinds("evil.md").includes("host"), "a path that only starts with cbase is not the repository's site");
    assert.ok(kinds("http.md").includes("term"), "the exemption is https only: the same site over http:// must be found");
    assert.ok(kinds("noscheme.md").includes("term"), "the exemption needs the scheme: a scheme-less address must be found");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
