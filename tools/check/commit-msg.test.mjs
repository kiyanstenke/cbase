// The hook on the commit message (.githooks/commit-msg), EXECUTED: the dispatcher runs every executable part in commit-msg.d with
// the message file and refuses the commit on the first part that exits non-zero. A clone without parts commits as before. The
// parts a clone adds are held where they live, next to the parts.
// COUNTER-TEST: a dispatcher that ignores a part's exit code (`"$part" "$@" || true`) => (2) and (3) red.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(REPO, ".githooks", "commit-msg");

// A hooks folder of its own: the real dispatcher, plus parts as given ({ name: [exitCode, executable] }).
function hooks(parts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-commit-msg-"));
  fs.copyFileSync(HOOK, path.join(dir, "commit-msg"));
  fs.chmodSync(path.join(dir, "commit-msg"), 0o755);
  if (parts) {
    fs.mkdirSync(path.join(dir, "commit-msg.d"));
    for (const [name, [code, exec = true]] of Object.entries(parts)) {
      const f = path.join(dir, "commit-msg.d", name);
      fs.writeFileSync(f, `#!/bin/sh\necho "${name} saw $(cat "$1")" >> "${dir}/seen"\nexit ${code}\n`);
      fs.chmodSync(f, exec ? 0o755 : 0o644);
    }
  }
  return dir;
}
const run = (dir, text = "A message") => {
  const msg = path.join(dir, "MSG");
  fs.writeFileSync(msg, text);
  const r = spawnSync(path.join(dir, "commit-msg"), [msg], { encoding: "utf8" });
  const seen = fs.existsSync(path.join(dir, "seen")) ? fs.readFileSync(path.join(dir, "seen"), "utf8").trim().split("\n") : [];
  return { code: r.status, seen };
};

test("(1) the hook exists and is executable; without parts (or with only non-executable ones) the commit goes through", () => {
  assert.ok((fs.statSync(HOOK).mode & 0o111) !== 0, ".githooks/commit-msg is missing or not executable — git would skip it silently");
  const a = hooks(null), b = hooks({ "10-off": [1, false] });
  try {
    assert.equal(run(a).code, 0);
    const r = run(b);
    assert.equal(r.code, 0, "a non-executable part must not refuse");
    assert.deepEqual(r.seen, []);
  } finally { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("(2) every part sees the message; the first part that refuses stops the commit with its exit code, later parts do not run", () => {
  const ok = hooks({ "10-a": [0], "20-b": [0] }), bad = hooks({ "10-a": [0], "20-no": [3], "30-c": [0] });
  try {
    const g = run(ok, "Fix the thing");
    assert.equal(g.code, 0);
    assert.deepEqual(g.seen, ["10-a saw Fix the thing", "20-b saw Fix the thing"]);
    const r = run(bad);
    assert.equal(r.code, 3, "a refusing part must refuse the commit");
    assert.deepEqual(r.seen.map((l) => l.split(" ")[0]), ["10-a", "20-no"]);
  } finally { for (const d of [ok, bad]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("(3) through real git: a refusing part leaves no commit, a passing one makes it", () => {
  const dir = hooks({ "10-no": [1] });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-commit-msg-repo-"));
  const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${dir}`, ...a], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
    git("add", "a.txt");
    assert.notEqual(git("commit", "-q", "-m", "refused").status, 0, "git committed although the part refused");
    assert.notEqual(git("rev-parse", "--verify", "-q", "HEAD").status, 0, "a commit exists after the refusal");
    fs.chmodSync(path.join(dir, "commit-msg.d", "10-no"), 0o644);
    assert.equal(git("commit", "-q", "-m", "fine").status, 0);
    assert.equal(git("log", "--format=%s").stdout.trim(), "fine");
  } finally { for (const d of [dir, repo]) fs.rmSync(d, { recursive: true, force: true }); }
});
