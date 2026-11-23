#!/usr/bin/env node
// The product version: ONE number for the whole tree (web, desktop client, backend, gateway, iOS app), and the ids derived from it.
//
// The policy (what SemVer is measured against, the API level, build ids and build numbers, when and how a release is cut) is
// VERSIONING.md; this file is its tool. The number is written in several files because every build system wants its own; PLACES
// below is the one list of them. Who adds a file that carries the version adds a row here — tools/check/version.test.mjs then holds
// it with the rest.
//
//   node tools/version.mjs                       prints the version; exit 1 and the deviating places if they disagree
//   node tools/version.mjs set <x.y.z>           writes the version into every place
//   node tools/version.mjs release <x.y.z> [--date Y-M-D] [--commit]
//                                                preflight (branch main, clean tree, HEAD == origin/main if that ref exists), then
//                                                `set` and "## [Unreleased]" of CHANGELOG.md becomes the release; --commit also commits
//                                                "Release x.y.z" and creates the annotated local tag vx.y.z (never pushes)
//   node tools/version.mjs describe [--json]     the build id: "x.y.z" exactly on a clean tag vx.y.z, else "x.y.z+N.g<sha7>[.dirty]",
//                                                "x.y.z+unknown" without git; --json adds commit and dirty
//   node tools/version.mjs ios-build             the build number: BUILD_OFFSET + commits up to HEAD (refuses a shallow clone)
//   node tools/version.mjs notes <x.y.z>         prints the CHANGELOG.md section of that release (the body of the GitHub release)
//   node tools/version.mjs places                lists the files of PLACES (one per line) and CHANGELOG.md
//   --root <dir>                                 works on another copy of the tree (the guard's temp copies and temp git repos)
//
// The release preflight has no escape switch: the tests run `release` in temp git repositories that satisfy it, so the tool has
// no flag that exists only for them. The gateway reads its version from server/gateway/package.json at start, so it has no literal
// of its own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG = "CHANGELOG.md";
/** iOS (and desktop) build numbers are BUILD_OFFSET + the number of commits up to HEAD — above every number uploaded by hand. */
export const BUILD_OFFSET = 100;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INFO_PLIST_LINK = "$(MARKETING_VERSION)";

// Each kind reads every occurrence of the version in a file ({ label, value }) and writes a new one. Writing replaces only the
// version text (no re-serialising: client/package.json keeps its one-line arrays, the lockfiles their exact bytes elsewhere).
const KINDS = {
  // package.json: the top-level "version" (two spaces of indentation = the root object).
  package: {
    read: (text) => [{ label: "version", value: JSON.parse(text).version }],
    write: (text, v) => replaceOnce(text, /^( {2}"version": )"[^"]*"/m, `$1"${v}"`),
  },
  // package-lock.json: the root "version" and that of the root package, packages[""].
  lock: {
    read: (text) => {
      const j = JSON.parse(text);
      return [{ label: "version", value: j.version }, { label: 'packages[""].version', value: j.packages?.[""]?.version }];
    },
    write: (text, v) => replaceOnce(replaceOnce(text, /^( {2}"version": )"[^"]*"/m, `$1"${v}"`),
      /^( {4}"": \{\n(?: {6}.*\n)*? {6}"version": )"[^"]*"/m, `$1"${v}"`),
  },
  // Xcode project: MARKETING_VERSION in every build configuration (app and UI tests, Debug and Release).
  pbxproj: {
    read: (text) => [...text.matchAll(/\bMARKETING_VERSION = "?([^";]*)"?;/g)].map((m, i) => ({ label: `MARKETING_VERSION #${i + 1}`, value: m[1] })),
    write: (text, v) => text.replace(/\bMARKETING_VERSION = "?[^";]*"?;/g, `MARKETING_VERSION = ${v};`),
  },
  // The app's Info.plist must take the marketing version from the build setting; a literal here would win over the project.
  plistLink: {
    read: (text) => [{ label: "CFBundleShortVersionString", value: plistShortVersion(text) }],
    write: (text) => replaceOnce(text, /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${INFO_PLIST_LINK}$2`),
    expected: () => INFO_PLIST_LINK,
  },
};

/** THE table of the places that carry the product version. */
export const PLACES = [
  { file: "web/package.json", kind: "package" },
  { file: "web/package-lock.json", kind: "lock" },
  { file: "client/package.json", kind: "package" },
  { file: "client/package-lock.json", kind: "lock" },
  { file: "server/backend/package.json", kind: "package" },
  { file: "server/backend/package-lock.json", kind: "lock" },
  { file: "server/gateway/package.json", kind: "package" },
  { file: "mobile/CbaseMobile.xcodeproj/project.pbxproj", kind: "pbxproj" },
  { file: "mobile/CbaseMobile/Info.plist", kind: "plistLink" },
];

function plistShortVersion(text) {
  const m = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1] : undefined;
}

function replaceOnce(text, re, by) {
  if (!re.test(text)) throw new Error(`version text not found (${re})`);
  return text.replace(re, by);
}

export function isSemver(v) {
  return typeof v === "string" && SEMVER.test(v);
}

/** -1, 0 or 1; both arguments are MAJOR.MINOR.PATCH. */
export function compare(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Every occurrence: [{ file, label, value, link }] — `link` marks a place that must name the build setting, not the number. */
export function readPlaces(root = REPO) {
  const out = [];
  for (const p of PLACES) {
    const kind = KINDS[p.kind];
    let found;
    try {
      found = kind.read(fs.readFileSync(path.join(root, p.file), "utf8"));
    } catch (e) {
      out.push({ file: p.file, label: "(unreadable)", value: undefined, error: e.message });
      continue;
    }
    if (!found.length) out.push({ file: p.file, label: "(no version found)", value: undefined });
    for (const f of found) out.push({ file: p.file, ...f, link: kind.expected ? kind.expected() : null });
  }
  return out;
}

/**
 * The verdict over the tree: { version, mismatches }. `version` is the number most places carry (the package.json of the web
 * client on a tie); every place that deviates from it — or a link place that does not name the build setting — is a mismatch.
 */
export function check(root = REPO) {
  const all = readPlaces(root);
  const numbers = all.filter((x) => !x.link);
  const counts = new Map();
  for (const x of numbers) if (x.value !== undefined) counts.set(x.value, (counts.get(x.value) || 0) + 1);
  let version = numbers[0]?.value;
  for (const [v, n] of counts) if (n > (counts.get(version) || 0)) version = v;
  const mismatches = all.filter((x) => (x.link ? x.value !== x.link : x.value !== version || !isSemver(x.value)));
  return { version, mismatches };
}

function assertTarget(v, current) {
  if (!isSemver(v)) throw new Error(`"${v}" is not a version of the form MAJOR.MINOR.PATCH (SemVer, without pre-release or build)`);
  if (current && isSemver(current) && compare(v, current) < 0) throw new Error(`${v} is lower than the current version ${current}`);
}

/** Writes `v` into every place. Refuses a malformed or a lower version (lower than the highest number in the tree). */
export function set(v, root = REPO) {
  const numbers = readPlaces(root).filter((x) => !x.link && isSemver(x.value)).map((x) => x.value);
  const highest = numbers.sort(compare).at(-1);
  assertTarget(v, highest);
  const texts = PLACES.map((p) => [p, KINDS[p.kind].write(fs.readFileSync(path.join(root, p.file), "utf8"), v)]);
  for (const [p, text] of texts) fs.writeFileSync(path.join(root, p.file), text);
  const after = check(root);
  if (after.mismatches.length || after.version !== v) throw new Error(`set ${v} left deviating places: ${describeList(after.mismatches)}`);
  return v;
}

const RELEASED = /^## \[(\d+\.\d+\.\d+)\]/gm;
const UNRELEASED_LINK = /^\[Unreleased\]: (\S+)\/compare\/(\S+)\.\.\.HEAD$/m;

/** The new CHANGELOG text for releasing `v` on `date` — pure, so the guard can hold the transformation exactly. */
export function releaseChangelog(text, v, date) {
  const heads = text.match(/^## \[Unreleased\]$/gm) || [];
  if (heads.length !== 1) throw new Error(`${CHANGELOG} must have exactly one "## [Unreleased]" section (found ${heads.length})`);
  const released = [...text.matchAll(RELEASED)].map((m) => m[1]);
  if (released.includes(v)) throw new Error(`${CHANGELOG} already has a section for ${v}`);
  const latest = [...released].sort(compare).at(-1);
  if (latest && compare(v, latest) <= 0) throw new Error(`${v} is not higher than the last release ${latest} in ${CHANGELOG}`);
  const body = text.split(/^## \[Unreleased\]$/m)[1].split(/^## \[|^\[[^\]]+\]: /m)[0];
  if (!body.trim()) throw new Error(`the "## [Unreleased]" section of ${CHANGELOG} is empty — nothing to release`);
  let out = text.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${v}] - ${date}`);
  if (/^\[Unreleased\]:/m.test(out)) {
    const m = out.match(UNRELEASED_LINK);
    if (!m) throw new Error(`the "[Unreleased]:" link of ${CHANGELOG} is not of the form <repo>/compare/<tag>...HEAD`);
    out = out.replace(UNRELEASED_LINK, `[Unreleased]: ${m[1]}/compare/v${v}...HEAD\n[${v}]: ${m[1]}/compare/${m[2]}...v${v}`);
  }
  return out;
}

/** The body of the CHANGELOG section of release `v` (without its heading), trimmed. Throws when there is none or it is empty. */
export function releaseNotes(text, v) {
  if (!isSemver(v)) throw new Error(`"${v}" is not a version of the form MAJOR.MINOR.PATCH`);
  const m = text.match(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\][^\\n]*$`, "m"));
  if (!m) throw new Error(`${CHANGELOG} has no "## [${v}]" section`);
  const body = text.slice(m.index + m[0].length).split(/^## \[|^\[[^\]]+\]: /m)[0].trim();
  if (!body) throw new Error(`the "## [${v}]" section of ${CHANGELOG} is empty`);
  return body;
}

// ---- git: build ids, build numbers, the release preflight ----

// One git call in `root`: { ok, out, err }. ok is false when git is missing, `root` is no repository or the command fails. Git
// never asks (no terminal prompt, no pager).
function git(root, args, input) {
  const r = spawnSync("git", args, { cwd: root, input, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

/** The repository state of `root` (which must be the top level), or null without git, without a repository or without a commit. */
function repoState(root) {
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head.ok || !head.out) return null;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(root)) return null;
  const status = git(root, ["status", "--porcelain"]);
  if (!status.ok) return null;
  const tag = git(root, ["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD"]);
  return { commit: head.out, dirty: status.out !== "", lastTag: tag.ok && tag.out ? tag.out : null };
}

/**
 * The build id of the tree in `root`: { version, build, commit, dirty }. `build` is the bare version only exactly on a clean tag
 * v<version>; every other state says how far it is from the last v* tag (or from the root commit) and whether it carries
 * uncommitted changes. Without git there is no claim of a clean build: "+unknown", commit null.
 */
export function describe(root = REPO) {
  const { version } = check(root);
  const state = repoState(root);
  if (!state) return { version, build: `${version}+unknown`, commit: null, dirty: false };
  const onTag = git(root, ["tag", "--points-at", "HEAD"]).out.split("\n").includes(`v${version}`);
  if (onTag && !state.dirty) return { version, build: version, commit: state.commit, dirty: false };
  const count = git(root, ["rev-list", "--count", state.lastTag ? `${state.lastTag}..HEAD` : "HEAD"]);
  const short = git(root, ["rev-parse", "--short=7", "HEAD"]);
  if (!count.ok || !short.ok) return { version, build: `${version}+unknown`, commit: state.commit, dirty: state.dirty };
  return { version, build: `${version}+${count.out}.g${short.out}${state.dirty ? ".dirty" : ""}`, commit: state.commit, dirty: state.dirty };
}

/** BUILD_OFFSET + the commits up to HEAD. Refuses without git and in a shallow clone (its count would be too low). */
export function iosBuild(root = REPO) {
  if (!repoState(root)) throw new Error("ios-build needs a git repository with at least one commit (the build number counts commits)");
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok || shallow.out !== "false") throw new Error("ios-build refuses a shallow clone: its commit count is too low (fetch the full history)");
  const count = git(root, ["rev-list", "--count", "HEAD"]);
  if (!count.ok || !/^\d+$/.test(count.out)) throw new Error(`git rev-list --count HEAD failed: ${count.err}`);
  return BUILD_OFFSET + Number(count.out);
}

/**
 * What must hold before `release` writes a byte: a git repository whose top level is `root`, on branch main, a clean tree, HEAD
 * equal to origin/main when that ref exists. Which number to raise is the maintainer's call (VERSIONING.md, "Bump rules"); the
 * tool does not enforce it. Throws with every reason at once.
 */
export function releasePreflight(v, root = REPO) {
  const state = repoState(root);
  if (!state) throw new Error(`release refused: ${root} is not the top level of a git repository with at least one commit`);
  const reasons = [];
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.out !== "main") reasons.push(`not on branch main (${branch.out || "detached HEAD"})`);
  if (state.dirty) reasons.push("the working tree is not clean (commit or remove the changes first)");
  const origin = git(root, ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]);
  if (origin.ok && origin.out && origin.out !== state.commit) reasons.push("HEAD is not origin/main (push or pull first)");
  if (reasons.length) throw new Error(`release ${v} refused: ${reasons.join("; ")}`);
}

/**
 * Preflight, `set`, then the CHANGELOG section. Everything is checked before the first file is written. With `commit`, the written
 * files are committed as "Release x.y.z" and tagged vx.y.z (annotated, local); nothing is ever pushed.
 */
export function release(v, { date, root = REPO, commit = false } = {}) {
  date ??= new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`"${date}" is not a date of the form YYYY-MM-DD`);
  assertTarget(v);
  const file = path.join(root, CHANGELOG);
  const changelog = releaseChangelog(fs.readFileSync(file, "utf8"), v, date);
  releasePreflight(v, root);
  if (commit && git(root, ["rev-parse", "--verify", "-q", `refs/tags/v${v}`]).ok) throw new Error(`release ${v} refused: the tag v${v} exists already`);
  set(v, root);
  fs.writeFileSync(file, changelog);
  if (commit) {
    const files = [...new Set([...PLACES.map((p) => p.file), CHANGELOG])];
    for (const args of [["add", "--", ...files], ["commit", "-q", "-m", `Release ${v}`], ["tag", "-a", `v${v}`, "-m", `cbase ${v}`]]) {
      const r = git(root, args);
      if (!r.ok) throw new Error(`git ${args[0]} failed (the files are written; finish by hand): ${r.err}`);
    }
  }
  return v;
}

const describeList = (list) => list.map((x) => `${x.file} (${x.label}): ${x.value === undefined ? "missing" : x.value}${x.link ? ` — expected ${x.link}` : ""}`).join("; ");

const USAGE = "usage: node tools/version.mjs [set <x.y.z> | release <x.y.z> [--date YYYY-MM-DD] [--commit] | describe [--json] | ios-build | notes <x.y.z> | places] [--root <dir>]";

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    args.splice(i, 2);
    return value;
  };
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const root = path.resolve(take("--root") ?? REPO);
  const date = take("--date");
  const commit = flag("--commit");
  const json = flag("--json");
  const [command, v, ...rest] = args;
  const takesVersion = ["set", "release", "notes"].includes(command);
  const known = command === undefined || takesVersion || ["describe", "ios-build", "places"].includes(command);
  if (!known || rest.length || (takesVersion ? !v : v !== undefined) || (command !== "release" && (date !== undefined || commit)) || (command !== "describe" && json)) {
    throw new Error(USAGE);
  }
  if (command === "places") return console.log([...new Set(PLACES.map((p) => p.file)), CHANGELOG].join("\n"));
  if (command === "set") return console.log(set(v, root));
  if (command === "release") return console.log(release(v, { date, root, commit }));
  if (command === "notes") return console.log(releaseNotes(fs.readFileSync(path.join(root, CHANGELOG), "utf8"), v));
  if (command === "ios-build") return console.log(iosBuild(root));
  if (command === "describe") {
    const d = describe(root);
    return console.log(json ? JSON.stringify(d) : d.build);
  }
  const { version, mismatches } = check(root);
  if (mismatches.length) {
    console.error(`The places disagree with ${version}:`);
    for (const x of mismatches) console.error(`  ${describeList([x])}`);
    process.exitCode = 1;
    return;
  }
  console.log(version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`version: ${e.message}`);
    process.exitCode = 1;
  }
}
