// The build stamp of a rollout and the store gate of the iOS app (VERSIONING.md).
//
// BUILD STAMP. Every deploy writes `build.json` — { version, build, commit, dirty, release, builtAt } — computed once per run from
// `node tools/version.mjs describe --json` (the build id: "x.y.z" exactly on a clean tag, else "x.y.z+N.g<sha7>[.dirty]"). It goes
// into the release folder (`releases/<id>/build.json`, which the gateway reads through `current/`) and into web-out — NOT into
// the image: a stamp there would change the image on every deploy and swap every user container even with an unchanged
// backend. Never committed (.gitignore). If describe fails, the stamp says build "<version>+unknown" (the version from
// `node tools/version.mjs`, as describe itself says without git) with dirty false, and the deploy warns — it never invents a
// clean build. A dirty rollout checkout only warns.
//
// STORE GATE. TestFlight and IPA builds are releases: only from a clean tree whose HEAD is exactly at the tag v<version>. No
// --force escape for this check. `--device` is always allowed.
//
// BUILD NUMBER. iOS (CURRENT_PROJECT_VERSION) and the desktop client (electron-builder buildVersion) get
// `node tools/version.mjs ios-build` (100 + commits on HEAD), inserted at build time, never committed.
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../config.mjs";
import { probe } from "../../check/lib/sh.mjs";

export const BUILD_JSON = "build.json";
const VERSION_TOOL = path.join(REPO, "tools/version.mjs");
const SEMVER = /^\d+\.\d+\.\d+$/;
// What may stand in a build id or a commit.
const BUILD_ID = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

const nodeTool = (args, run) => run(process.execPath, [VERSION_TOOL, ...args], { cwd: REPO });

/** Pure: the output of `describe --json` → { version, build, commit, dirty }; throws on anything else. */
export function parseDescribe(stdout) {
  const j = JSON.parse(String(stdout ?? "").trim());
  if (!j || !SEMVER.test(String(j.version))) throw new Error(`describe --json: no version (${String(stdout).slice(0, 120)})`);
  if (!BUILD_ID.test(String(j.build))) throw new Error(`describe --json: unreadable build "${j.build}"`);
  if (j.commit !== null && !SHA.test(String(j.commit))) throw new Error(`describe --json: unreadable commit "${j.commit}"`);
  if (typeof j.dirty !== "boolean") throw new Error(`describe --json: "dirty" is not a boolean (${j.dirty})`);
  return { version: j.version, build: j.build, commit: j.commit, dirty: j.dirty };
}

/**
 * `describe --json` as a subprocess → { describe, warning }. On failure the build is "<version>+unknown" ("unknown" when even the
 * version is unreadable), commit null and dirty false — `dirty` stays a boolean, as describe says it without git; the warning
 * carries the doubt.
 */
export async function describeBuild({ run = probe } = {}) {
  try {
    const r = await nodeTool(["describe", "--json"], run);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").at(-1));
    return { describe: parseDescribe(r.stdout), warning: null };
  } catch (e) {
    let version = null;
    try {
      const v = await nodeTool([], run);
      if (v.code === 0 && SEMVER.test(v.stdout.trim())) version = v.stdout.trim();
    } catch { /* stays null */ }
    return {
      describe: { version, build: version ? `${version}+unknown` : "unknown", commit: null, dirty: false },
      warning: `The build id could not be computed (node tools/version.mjs describe --json: ${e.message}) — build.json says "${version ? `${version}+unknown` : "unknown"}".`,
    };
  }
}

/** Pure: the content of build.json, in the order of the contract. */
export function buildStamp(describe, { release, builtAt = new Date().toISOString() }) {
  return {
    version: describe.version,
    build: describe.build,
    commit: describe.commit ?? null,
    dirty: describe.dirty === true,
    release: String(release),
    builtAt,
  };
}

/** Pure: the warning for a rollout from a dirty checkout, or null (clean; a failed describe already warned through describeBuild). */
export function dirtyWarning(stamp) {
  return stamp.dirty === true ? `The rollout checkout has uncommitted changes — this rollout carries the build id ${stamp.build} (warning only).` : null;
}

/** Writes the stamp to a local file (for the uploads) and returns its path. */
export function writeStampFile(stamp, dir = path.join(REPO, ".deploy-logs")) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `build-${stamp.release}.json`);
  fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
  return file;
}

/** Pure: a stamp file's text → its build id, or "—" (missing/unreadable). */
export function stampBuildText(text) {
  try {
    const j = JSON.parse(String(text ?? ""));
    return typeof j?.build === "string" ? `${j.build}${j.release ? ` (release ${j.release})` : ""}` : "—";
  } catch {
    return "—";
  }
}

// ── store gate ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Pure: may `mode` build for the store? → the refusal, or null. `tags` are the tags pointing at HEAD; no `force` parameter on purpose. */
export function storeGateVerdict({ mode, dirty, version, tags }) {
  if (mode !== "testflight" && mode !== "ipa") return null;
  const why = [];
  if (!SEMVER.test(String(version))) why.push("the product version is unreadable (node tools/version.mjs)");
  if (dirty !== false) why.push(dirty === true ? "the working tree has uncommitted changes" : "whether the working tree is clean is unknown");
  const want = `v${version}`;
  if (SEMVER.test(String(version)) && !(tags || []).includes(want)) {
    const at = (tags || []).filter((t) => /^v\d/.test(t));
    why.push(at.length ? `HEAD carries ${at.join(", ")}, not ${want} (tag and version disagree)` : `HEAD is not at the tag ${want}`);
  }
  if (!why.length) return null;
  return `A ${mode === "testflight" ? "TestFlight" : "IPA"} build is a release build: only from a clean tree exactly at the tag v<version>. ` +
    `Refused: ${why.join("; ")}. Release first (node tools/version.mjs release <x.y.z>, commit, tag), or build for your own iPhone with --device. ` +
    "There is no --force for this check.";
}

/** Reads what the store gate needs from git: { dirty, version, tags }. Unknown stays unknown (null). */
export async function storeGitState({ run = probe } = {}) {
  const git = (args) => run("git", args, { cwd: REPO });
  const st = await git(["status", "--porcelain"]);
  const tags = await git(["tag", "--points-at", "HEAD"]);
  const v = await nodeTool([], run);
  return {
    dirty: st.code === 0 ? st.stdout.trim().length > 0 : null,
    tags: tags.code === 0 ? tags.stdout.split("\n").map((t) => t.trim()).filter(Boolean) : [],
    version: v.code === 0 ? v.stdout.trim() : null,
  };
}

/** `node tools/version.mjs ios-build` → { number, warning }. A failure is a warning with number null — the caller decides. */
export async function buildNumber({ run = probe } = {}) {
  const r = await nodeTool(["ios-build"], run);
  const n = Number(r.stdout?.trim());
  if (r.code === 0 && Number.isInteger(n) && n >= 100) return { number: n, warning: null };
  return { number: null, warning: `No build number (node tools/version.mjs ios-build: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").at(-1)}).` };
}
