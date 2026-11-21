// The guard over the guard before the push.
//
// Two kinds, and the second is the real one:
//
//  1. `prePushState` as a pure function — the row that the operator's status check prints.
//  2. The HOOK ITSELF, executed. A test that only checks the status row could be kept green with a gutted `.githooks/pre-push`:
//     the file would be there, executable and do nothing. So the real script runs here in a throwaway repo against a fake
//     runner `check` — once green, once red, plus the exits (delete push, no runner, and the parts protocol of
//     .githooks/pre-push.d: 0 continue, 10 allow and skip the check, else refuse). What is measured is the exit code git reads.
//     Parts a clone adds are held where they live.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { prePushState, HOOKS_PATH } from "./lib/git.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(REPO, HOOKS_PATH, "pre-push");
const NULL_SHA = "0".repeat(40);
const SHA = "1".repeat(40);

test("prePushState: not switched on, foreign path, missing, not executable, active", () => {
  const out = prePushState({ hooksPath: "", existing: true, executable: true });
  assert.equal(out.active, false);
  assert.equal(out.stage, "warn");
  assert.match(out.text, /git config core\.hooksPath \.githooks/);

  const foreign = prePushState({ hooksPath: ".husky", existing: true, executable: true });
  assert.equal(foreign.active, false);
  assert.match(foreign.text, /\.husky/, "the foreign path must be in the text, else one searches for it");

  const missing = prePushState({ hooksPath: HOOKS_PATH, existing: false, executable: false });
  assert.equal(missing.stage, "bad", "switched on, but the file is missing — that is no hint, that is broken");

  const blunt = prePushState({ hooksPath: HOOKS_PATH, existing: true, executable: false });
  assert.equal(blunt.stage, "bad");
  assert.match(blunt.text, /chmod \+x/);

  const on = prePushState({ hooksPath: HOOKS_PATH, existing: true, executable: true });
  assert.deepEqual([on.active, on.stage], [true, "ok"]);
});

test("the hook is versioned in the tree and executable", () => {
  const st = fs.statSync(HOOK);
  assert.ok(st.isFile(), `${HOOKS_PATH}/pre-push missing`);
  assert.ok((st.mode & 0o111) !== 0, "not executable — git then silently does not call it");
  const text = fs.readFileSync(HOOK, "utf8");
  assert.match(text, /check --quick/, "the hook must run the quick check, else it checks nothing");
  assert.match(text, /--no-verify/, "the way out belongs in the message, else the hook is deleted instead of bypassed");
});

// A throwaway repo with a fake runner. The hook calls `$(git rev-parse --show-toplevel)/check`, so a directory that IS a repo and
// carries a file of this name suffices. `parts` = { name: script body } for pre-push.d.
function fixture(runnerExit, { runner = "check", parts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-prepush-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (runnerExit !== null) {
    fs.writeFileSync(path.join(dir, runner), `#!/bin/sh\necho "fake ${runner}: $*"\nexit ${runnerExit}\n`);
    fs.chmodSync(path.join(dir, runner), 0o755);
  }
  fs.mkdirSync(path.join(dir, HOOKS_PATH));
  fs.copyFileSync(HOOK, path.join(dir, HOOKS_PATH, "pre-push"));
  fs.chmodSync(path.join(dir, HOOKS_PATH, "pre-push"), 0o755);
  if (Object.keys(parts).length) {
    fs.mkdirSync(path.join(dir, HOOKS_PATH, "pre-push.d"));
    for (const [name, body] of Object.entries(parts)) {
      fs.writeFileSync(path.join(dir, HOOKS_PATH, "pre-push.d", name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(dir, HOOKS_PATH, "pre-push.d", name), 0o755);
    }
  }
  return dir;
}

function run(dir, { stdin, env = {}, args = ["origin", "https://example.invalid/x.git"] }) {
  try {
    const stdout = execFileSync(path.join(dir, HOOKS_PATH, "pre-push"), args, {
      cwd: dir, input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CBASE_GATE_OK: "", ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const row = (local, remote) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test("the hook lets through when the quick check is green", () => {
  const dir = fixture(0);
  try {
    const r = run(dir, { stdin: row(SHA, NULL_SHA) });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /fake check: --quick/, "the quick check must really have run");
  } finally { cleanup(dir); }
});

test("the hook stops the push when the quick check is red", () => {
  const dir = fixture(1);
  try {
    const r = run(dir, { stdin: row(SHA, NULL_SHA) });
    assert.equal(r.code, 1, "red check, but exit 0 — git would push");
    assert.match(r.stdout, /--no-verify/);
  } finally { cleanup(dir); }
});

test("a delete push carries no bytes and starts nothing", () => {
  const dir = fixture(1);
  try {
    const r = run(dir, { stdin: row(NULL_SHA, SHA) });
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /fake check/);
  } finally { cleanup(dir); }
});

// The deliberately chosen limit, named instead of concealed: without a runner the push goes through. A bisect worktree on an
// old commit does not have the tool, and a hook that refuses every push there is deleted instead of bypassed. It says so, though.
test("without ./check the push goes through — and the hook says so", () => {
  const dir = fixture(null);
  try {
    const r = run(dir, { stdin: row(SHA, NULL_SHA) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /check is not present/);
  } finally { cleanup(dir); }
});

test("parts: exit 0 continues to the quick check, exit 10 allows and skips it, any other exit refuses — in name order", () => {
  const cont = fixture(0, { parts: { "10-a": "cat >/dev/null; exit 0" } });
  const skip = fixture(1, { parts: { "10-a": "cat >/dev/null; echo part-skip; exit 10", "20-b": "cat >/dev/null; exit 1" } });
  const refuse = fixture(0, { parts: { "10-a": "cat >/dev/null; echo part-refuses >&2; exit 3", "20-b": "cat >/dev/null; exit 10" } });
  try {
    const c = run(cont, { stdin: row(SHA, NULL_SHA) });
    assert.equal(c.code, 0, c.stdout);
    assert.match(c.stdout, /fake check: --quick/, "a part that says 0 must not stop the quick check");
    const s = run(skip, { stdin: row(SHA, NULL_SHA) });
    assert.equal(s.code, 0, s.stdout);
    assert.match(s.stdout, /part-skip/);
    assert.doesNotMatch(s.stdout, /fake check/, "exit 10 must skip the quick check — and the later part must not run");
    const r = run(refuse, { stdin: row(SHA, NULL_SHA) });
    assert.equal(r.code, 3, "a refusing part must refuse the push with its own code");
    assert.match(r.stdout, /part-refuses/);
  } finally { cleanup(cont); cleanup(skip); cleanup(refuse); }
});

test("parts get the hook's arguments and the pushed refs on stdin; a part that is not executable is ignored", () => {
  const dir = fixture(0, { parts: { "10-echo": 'printf "args=%s %s\\n" "$1" "$2"; cat' } });
  try {
    fs.writeFileSync(path.join(dir, HOOKS_PATH, "pre-push.d", "20-not-executable"), "#!/bin/sh\nexit 1\n");
    const r = run(dir, { stdin: row(SHA, NULL_SHA), args: ["origin", "https://example.invalid/y.git"] });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /args=origin https:\/\/example\.invalid\/y\.git/);
    assert.match(r.stdout, new RegExp(`refs/heads/main ${SHA}`), "the part did not receive the refs on stdin");
  } finally { cleanup(dir); }
});
