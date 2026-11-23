// The release workflow (.github/workflows/release.yml) only ever drafts: CI checks a pushed tag and creates a DRAFT release,
// publishing stays a maintainer's step (VERSIONING.md, "Release procedure").
//
// PROMISES:
//   (1) it runs on pushed tags v* and on nothing else (no branch push, no pull request, no schedule, no manual run)
//   (2) the release is created with --draft and --verify-tag; nothing publishes (no --latest, no --draft=false, no `gh release
//       edit`, no other release action)
//   (3) its permissions are exactly `contents: write` at the top level, and no job widens them
//   (4) every action is pinned to a 40-hex commit SHA, and an action that check.yml uses too carries the same SHA
//   (5) it checks tag == version, the tagged commit on main, the CHANGELOG section (`version.mjs notes`) and runs the version
//       tests before the release step; run blocks take the tag from the environment, never as `${{ … }}` inside the script
//
// The workflow is read as text with line anchors (no YAML library in tools/check); every anchor that finds nothing is a finding.
//
// COUNTER-PROOF (built in): `audit` is a pure function over the text; the test feeds it the workflow with each promise broken once
// (a branch trigger, --draft removed, --latest added, `gh release edit`, a wider permission, a job permission, a tag-pinned action,
// a SHA differing from check.yml, a missing check step, `${{ github.ref_name }}` inside a run block) and each must be named.
//
// Run:  node --test --test-reporter=tap tools/check/release-workflow.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "release.yml");
const CHECK = path.join(REPO, ".github", "workflows", "check.yml");

// The top-level block `name:` up to the next top-level key, without comment lines.
function block(text, key) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) return null;
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !l.startsWith("#")) break;
    if (!/^\s*#/.test(l) && l.trim()) out.push(l);
  }
  return out;
}

const uses = (text) => [...text.matchAll(/^\s*-?\s*uses:\s*([^@\s]+)@(\S+)/gm)].map((m) => ({ action: m[1], ref: m[2] }));

/** Findings over the workflow text (and check.yml for the shared SHAs): [] when every promise holds. */
function audit(text, checkText) {
  const out = [];
  // (1) the trigger
  const on = block(text, "on");
  if (!on) out.push("no top-level `on:`");
  else {
    const body = on.slice(1).map((l) => l.trim());
    const expected = ["push:", 'tags: ["v*"]'];
    if (body.length !== expected.length || body.some((l, i) => l !== expected[i])) out.push(`the trigger is not exactly push of tags v*: ${body.join(" | ")}`);
  }
  // (2) draft only
  const create = text.split("\n").filter((l) => /\bgh release create\b/.test(l) && !/^\s*#/.test(l));
  if (create.length !== 1) out.push(`expected exactly one \`gh release create\`, found ${create.length}`);
  for (const l of create) {
    if (!/\s--draft(\s|$)/.test(l)) out.push("`gh release create` without --draft");
    if (!/\s--verify-tag(\s|$)/.test(l)) out.push("`gh release create` without --verify-tag");
  }
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (/--latest\b/.test(code)) out.push("--latest publishes the release as the latest");
  if (/--draft=false\b/.test(code)) out.push("--draft=false publishes the release");
  if (/\bgh release (edit|upload|delete)\b/.test(code)) out.push("a `gh release edit/upload/delete` step changes a release beyond the draft");
  if (/\bgh api\b/.test(code)) out.push("a raw `gh api` call could publish the release");
  for (const u of uses(text)) if (/release/i.test(u.action)) out.push(`a release action (${u.action}) besides the gh draft`);
  // (3) permissions
  const perms = block(text, "permissions");
  const permBody = perms ? perms.slice(1).map((l) => l.trim()) : [];
  if (!perms || permBody.length !== 1 || permBody[0] !== "contents: write") out.push(`top-level permissions are not exactly contents: write: ${permBody.join(" | ") || "(none)"}`);
  const jobs = block(text, "jobs") || [];
  if (jobs.some((l) => /^\s+permissions:/.test(l))) out.push("a job sets its own permissions");
  // (4) pinned actions
  const pinned = new Map(uses(checkText).map((u) => [u.action, u.ref]));
  const mine = uses(text);
  if (!mine.length) out.push("no `uses:` found — the anchor is broken");
  for (const u of mine) {
    if (!/^[0-9a-f]{40}$/.test(u.ref)) out.push(`${u.action} is not pinned to a commit SHA (${u.ref})`);
    else if (pinned.has(u.action) && pinned.get(u.action) !== u.ref) out.push(`${u.action} is pinned to ${u.ref}, check.yml to ${pinned.get(u.action)}`);
  }
  // (5) the checks before the release step
  const at = (re) => code.search(re);
  const release = at(/\bgh release create\b/);
  for (const [what, re] of [
    ["the tag == version check", /"\$TAG" != "v\$version"/],
    ["the main ancestry check", /git merge-base --is-ancestor "\$commit" origin\/main/],
    ["the CHANGELOG section", /node tools\/version\.mjs notes "\$VERSION"/],
    ["the version tests", /node --test [^\n]*tools\/check\/version\.test\.mjs/],
    ["the full history (fetch-depth: 0)", /fetch-depth: 0/],
  ]) {
    const i = at(re);
    if (i < 0) out.push(`${what} is missing`);
    else if (release >= 0 && i > release) out.push(`${what} runs after the release step`);
  }
  for (const m of code.matchAll(/^(\s*)run: \|?\n?([\s\S]*?)(?=^\s*- (?:name|uses):|(?![\s\S]))/gm)) {
    if (/\$\{\{/.test(m[2])) out.push(`a run block interpolates \${{ … }} into the script: ${m[2].trim().split("\n")[0]}`);
  }
  return out;
}

const workflow = () => fs.readFileSync(WORKFLOW, "utf8");
const checkYml = () => fs.readFileSync(CHECK, "utf8");

test("(1)-(5) the release workflow runs on tags v*, only drafts, writes only contents, pins every action and checks first", () => {
  assert.deepEqual(audit(workflow(), checkYml()), []);
});

test("counter-proof: every broken promise is named", () => {
  const good = workflow();
  const check = checkYml();
  const sabotage = [
    ["branch trigger", good.replace('    tags: ["v*"]', '    tags: ["v*"]\n    branches: [main]'), /trigger is not exactly/],
    ["pull request trigger", good.replace("on:\n", "on:\n  pull_request:\n"), /trigger is not exactly/],
    ["no --draft", good.replace(" --draft ", " "), /without --draft/],
    ["no --verify-tag", good.replace(" --verify-tag ", " "), /without --verify-tag/],
    ["--latest", good.replace(" --draft ", " --draft --latest "), /--latest/],
    ["--draft=false", good.replace(" --draft ", " --draft=false "), /without --draft|--draft=false/],
    ["gh release edit", good.replace('--notes-file "$RUNNER_TEMP/notes.md"', '--notes-file "$RUNNER_TEMP/notes.md" && gh release edit "$TAG" --draft=false'), /gh release edit|--draft=false/],
    ["release action", good.replace("      - name: Version tests", "      - uses: softprops/action-gh-release@0123456789abcdef0123456789abcdef01234567\n      - name: Version tests"), /release action/],
    ["wider permission", good.replace("  contents: write\n", "  contents: write\n  packages: write\n"), /not exactly contents: write/],
    ["read-all", good.replace("permissions:\n  contents: write\n", "permissions: write-all\n"), /not exactly contents: write/],
    ["job permission", good.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      actions: write\n"), /job sets its own permissions/],
    ["tag pin", good.replace(/actions\/setup-node@[0-9a-f]{40}/, "actions/setup-node@v4"), /not pinned to a commit SHA/],
    ["other SHA", good.replace(/actions\/checkout@[0-9a-f]{40}/, `actions/checkout@${"a".repeat(40)}`), /check\.yml to/],
    ["no tag check", good.replace('"$TAG" != "v$version"', '"$TAG" != "$TAG"'), /tag == version check is missing/],
    ["no ancestry check", good.replace("git merge-base --is-ancestor", "git log -1"), /main ancestry check is missing/],
    ["no notes", good.replace('node tools/version.mjs notes "$VERSION"', 'echo "$VERSION"'), /CHANGELOG section is missing/],
    ["no tests", good.replace("tools/check/version.test.mjs", "tools/check/other.test.mjs"), /version tests is missing/],
    ["shallow", good.replace("fetch-depth: 0", "fetch-depth: 1"), /fetch-depth: 0\) is missing/],
    ["interpolation", good.replace('if [ "$TAG" != "v$version" ]; then', 'if [ "${{ github.ref_name }}" != "v$version" ] || [ "$TAG" != "v$version" ]; then'), /interpolates/],
  ];
  for (const [name, text, why] of sabotage) {
    assert.notEqual(text, good, `${name}: the sabotage did not change the workflow (stale anchor in the test)`);
    const out = audit(text, check);
    assert.ok(out.some((f) => why.test(f)), `${name}: not named; findings: ${JSON.stringify(out)}`);
  }
});
