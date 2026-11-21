// Branch rule and commit-and-push of a rollout — the installation-specific half of the git helpers
// (config.mjs: branch, remote). The gate's half (shallow-clone check, hook state) is lib/git.mjs.
import { REPO, config } from "../config.mjs";
import { act, probe, shProbe, isDryRun } from "../../check/lib/sh.mjs";
import * as log from "../../check/lib/log.mjs";

const git = (args, opts = {}) => probe("git", args, { cwd: REPO, ...opts });
const gitAct = (args, opts = {}) => act("git", args, { cwd: REPO, ...opts });

export async function currentBranch() {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

// Called before every deploy target. `force` exists so an emergency does not fail on the tool — when
// committing, the rule holds without exception.
export async function assertMainBranch({ force = false, strict = false } = {}) {
  const branch = await currentBranch();
  const want = config.git.branch;
  if (branch === want) return branch;
  const msg =
    `The working tree is on "${branch}", not on "${want}". In this project work is always done on ` +
    `${want} and rolled out from there.`;
  if (strict || !force) throw new Error(strict ? msg : `${msg} Possible anyway with --force.`);
  log.warn(`${msg} --force: rolling out anyway.`);
  return branch;
}

export async function commitAndPush({ release, targets, message }) {
  log.step("Commit and push");
  const branch = await assertMainBranch({ strict: true });
  const remote = config.git.remote;

  const before = (await shProbe("git status --short", { cwd: REPO })).stdout.split("\n").filter((l) => l.trim());
  log.info(`${before.length} changed/new file(s) — everything is taken along`);
  for (const l of before.slice(0, 20)) log.detail(l);
  if (before.length > 20) log.detail(`… and ${before.length - 20} more`);

  await gitAct(["add", "-A"]);

  const staged = isDryRun() ? before.length : (await git(["diff", "--cached", "--name-only"])).stdout.split("\n").filter((l) => l.trim()).length;
  if (staged) {
    const subject = message || `Deploy ${release}: ${targets.join(", ")}`;
    const body = `Rolled out: ${targets.join(", ")}\nRelease: ${release}\n\nAutomatic from ./deploy --commit — the whole working tree, not only the\nchanges of this deploy.`;
    await gitAct(["commit", "-m", subject, "-m", body]);
    log.ok(`committed: ${subject}`);
  } else {
    log.info("nothing to commit");
  }

  const ahead = isDryRun()
    ? 1
    : +(await git(["rev-list", "--count", `${remote}/${branch}..HEAD`])).stdout.trim() || 0;
  if (!ahead) {
    log.ok(`${remote}/${branch} is already at the state of the working tree`);
    return;
  }

  // `CBASE_GATE_OK` switches off the pre-push hook (.githooks/pre-push): the FULL gate ran minutes ago,
  // a second quick check would say nothing new. Without the hook the variable is harmless — it exists only
  // in the environment of THIS one child process.
  const push = await act("git", ["push", remote, branch], {
    cwd: REPO, check: false, timeout: 300000,
    env: { ...process.env, CBASE_GATE_OK: release },
  });
  if (push.code !== 0) {
    const rejected = /rejected|non-fast-forward|fetch first/i.test(push.stderr);
    throw new Error(
      rejected
        ? `Push rejected — ${remote}/${branch} is ahead of the local state. The deploy itself is ` +
          `done, only the push is missing. By hand: git pull --rebase ${remote} ${branch} && git push ${remote} ${branch}`
        : `git push failed: ${push.stderr.trim().split("\n").slice(-2).join(" ")}`,
    );
  }
  if (isDryRun()) return;

  // Counter-check instead of confidence: after a successful push the remote-tracking ref points
  // to the same commit.
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const onRemote = (await git(["rev-parse", `${remote}/${branch}`])).stdout.trim();
  log.table([
    ["HEAD", head.slice(0, 12), null],
    [`${remote}/${branch}`, onRemote.slice(0, 12), head === onRemote ? "ok" : "bad"],
    ["Number of pushed commits", String(ahead), null],
  ]);
  if (head !== onRemote) throw new Error(`After the push ${remote}/${branch} does not point to HEAD.`);
  log.ok(`${ahead} commit(s) pushed to ${remote}/${branch}`);
}
