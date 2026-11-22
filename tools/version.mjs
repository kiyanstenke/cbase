#!/usr/bin/env node
// The product version: ONE number for the whole tree (web, desktop client, backend, gateway, iOS app).
//
// cbase ships its parts together, so they carry the same version, SemVer 0.x until 1.0 (CONTRIBUTING.md, "Versions and
// releases"). The number is written in several files because every build system wants its own; PLACES below is the one list of
// them. Who adds a file that carries the version adds a row here — tools/check/version.test.mjs then holds it with the rest.
//
//   node tools/version.mjs                                  prints the version; exit 1 and the deviating places if they disagree
//   node tools/version.mjs set <x.y.z>                      writes the version into every place
//   node tools/version.mjs release <x.y.z> [--date Y-M-D]   `set`, then turns "## [Unreleased]" of CHANGELOG.md into the release
//   node tools/version.mjs places                           lists the files of PLACES (one per line) and CHANGELOG.md
//   --root <dir>                                            works on another copy of the tree (the guard's temp copies)
//
// Not here on purpose: the iOS build number (CURRENT_PROJECT_VERSION) counts uploads, not releases; the gateway reads its version
// from server/gateway/package.json at start, so it has no literal of its own.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG = "CHANGELOG.md";
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
  if (after.mismatches.length || after.version !== v) throw new Error(`set ${v} left deviating places: ${describe(after.mismatches)}`);
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

/** `set`, then the CHANGELOG section. Everything is checked before the first file is written. */
export function release(v, { date, root = REPO } = {}) {
  date ??= new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`"${date}" is not a date of the form YYYY-MM-DD`);
  const file = path.join(root, CHANGELOG);
  const changelog = releaseChangelog(fs.readFileSync(file, "utf8"), v, date);
  set(v, root);
  fs.writeFileSync(file, changelog);
  return v;
}

const describe = (list) => list.map((x) => `${x.file} (${x.label}): ${x.value === undefined ? "missing" : x.value}${x.link ? ` — expected ${x.link}` : ""}`).join("; ");

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
  const root = path.resolve(take("--root") ?? REPO);
  const date = take("--date");
  const [command, v, ...rest] = args;
  if (command === "places" && !v && !date) return console.log([...new Set(PLACES.map((p) => p.file)), CHANGELOG].join("\n"));
  if (rest.length || (command && !["set", "release"].includes(command)) || (command && !v) || (command !== "release" && date)) {
    throw new Error("usage: node tools/version.mjs [set <x.y.z> | release <x.y.z> [--date YYYY-MM-DD] | places] [--root <dir>]");
  }
  if (command === "set") return console.log(set(v, root));
  if (command === "release") return console.log(release(v, { date, root }));
  const { version, mismatches } = check(root);
  if (mismatches.length) {
    console.error(`The places disagree with ${version}:`);
    for (const x of mismatches) console.error(`  ${describe([x])}`);
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
