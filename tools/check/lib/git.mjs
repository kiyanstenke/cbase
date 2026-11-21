// Git part of the deploy.
//
// Two rules of this project, cast into code:
//
//  1. WORK IS ALWAYS DONE ON `main`. No feature branches, however large the change. A deploy from another branch is
//     an accident — once three shipped features lived only on a branch while `main` was behind.
//  2. `--commit` TAKES EVERYTHING ALONG. No picking of single files, no regard for whether other features sit in
//     the working tree: `git add -A`, commit, push. What should not come along belongs in `.gitignore` (which
//     already holds `deploy.local.json` and `.deploy-logs/`).
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../config-repo.mjs";
import { probe } from "./sh.mjs";
import * as log from "./log.mjs";

const git = (args, opts = {}) => probe("git", args, { cwd: REPO, ...opts });

export const HOOKS_PATH = ".githooks";

// The state of the pre-push guard (.githooks/pre-push), as a PURE function over three measured facts — so
// the operator's status check can read it and a test can play it through without a repo. The hook itself is versioned,
// enabling it is not: `core.hooksPath` lives in `.git/config` and comes with no clone. A line that is silent when it
// is missing could not be told from one that confirms it — so it always says something.
export function prePushState({ hooksPath, existing, executable }) {
  const enable = "git config core.hooksPath .githooks";
  if (hooksPath !== HOOKS_PATH) {
    return {
      active: false,
      stage: "warn",
      text: hooksPath
        ? `core.hooksPath points to "${hooksPath}", not to ${HOOKS_PATH} — ${enable}`
        : `not enabled — ${enable}`,
    };
  }
  if (!existing) return { active: false, stage: "bad", text: `core.hooksPath points to ${HOOKS_PATH}, but ${HOOKS_PATH}/pre-push is missing` };
  if (!executable) return { active: false, stage: "bad", text: `${HOOKS_PATH}/pre-push is not executable — chmod +x ${HOOKS_PATH}/pre-push` };
  return { active: true, stage: "ok", text: "active — ./check --quick before every push" };
}

// The same question, measured on the real working tree.
export async function prePushStatusMeasured() {
  const hooksPath = (await git(["config", "--get", "core.hooksPath"])).stdout.trim();
  const file = path.join(REPO, HOOKS_PATH, "pre-push");
  let existing = false;
  let executable = false;
  try {
    const st = fs.statSync(file);
    existing = st.isFile();
    executable = existing && (st.mode & 0o111) !== 0;
  } catch {}
  return prePushState({ hooksPath, existing, executable });
}

// A shallow clone (`git clone --depth …`, as CI runners and some tools create it) lacks the fixed states against
// which many counter-tests run `git show <sha>:…` — they then fail with "bad object" in the middle of the suites, a
// dozen red tests without a common cause. `./check` asks this BEFORE the suites (targets/check.mjs).
// → true (shallow) · false (full) · null (cannot be asked: no repo, git missing — unknown is not "full").
export async function isFlat(cwd = REPO) {
  const r = await probe("git", ["rev-parse", "--is-shallow-repository"], { cwd });
  const out = String(r.stdout || "").trim();
  if (r.code !== 0) return null;
  return out === "true" ? true : out === "false" ? false : null;
}
