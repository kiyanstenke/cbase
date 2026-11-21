// The build context list (server/backend/build-context-files.json): the named files of server/backend/ that go into the server
// build context. build.sh stages them with `cp`; the deploy tool uploads them from the same list (that binding is a deploy test).
// Here: the list matches what build.sh copies, every file exists and the scripts are executable.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const list = JSON.parse(fs.readFileSync(path.join(BACKEND, "build-context-files.json"), "utf8")).files;
const build = fs.readFileSync(path.join(BACKEND, "build.sh"), "utf8");

// The files build.sh stages: every `cp <files...> "$CTX/"` line (not `cp -R electron`).
function stagedByBuild(text) {
  const staged = [];
  for (const m of text.matchAll(/^cp ((?!-)[^\n]*?) "\$CTX\/"/gm)) staged.push(...m[1].trim().split(/\s+/));
  return staged;
}

test("build-context-files.json: named files, no duplicates, all present", () => {
  assert.ok(list.length > 0);
  assert.equal(new Set(list).size, list.length, "duplicate in the list");
  for (const f of list) {
    assert.match(f, /^[A-Za-z0-9._-]+$/, `${f}: a directory or pattern instead of a named file`);
    assert.ok(fs.existsSync(path.join(BACKEND, f)), `${f} is missing in server/backend/`);
  }
});

test("build.sh stages exactly the list (plus the Dockerfile, which is built from)", () => {
  assert.deepEqual([...stagedByBuild(build)].sort(), list.filter((f) => f !== "Dockerfile").sort());
  assert.ok(list.includes("Dockerfile"));
});

test("the programs of the list are executable", () => {
  for (const f of list.filter((x) => x.startsWith("cbase-") || x === "projectbox-entry.sh")) {
    assert.equal(fs.statSync(path.join(BACKEND, f)).mode & 0o111, 0o111, `${f} is not executable`);
  }
});

test("the staging parser sees the counter-state: a file dropped from build.sh is caught", () => {
  const without = build.replace("cbase-git cbase-clone", "cbase-git");
  assert.notDeepEqual([...stagedByBuild(without)].sort(), list.filter((f) => f !== "Dockerfile").sort());
});
