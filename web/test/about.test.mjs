// Settings → About: which cbase build runs, its API level, the gateway in front and the desktop app around the page.
//
// The promise: a value the server (or the shell) did not send reads "unknown" — never a guessed or borrowed number. Three ways
// break it silently, without a type error: (1) a version without a build id shown bare (it reads like a clean release build —
// the gateway sends `build: "unknown"` next to its own package version when its build file is missing, an old gateway sends no
// build at all); (2) a missing field rendered as an empty cell or a fallback from elsewhere; (3) a seam that drops the field on
// the way: the gate's copy of `/gw/info` (an allowlist), the shell bridge (an older client has no `appVersion`), the page.
//
// Setup: lib/about.ts and lib/shell-bridge.ts (both leaf modules) are compiled with tsc and run; ThirdPartyHints.tsx and
// gateway.tsx are read BY PATH without comments (a comment describing the rule is not code obeying it). The desktop side of the
// bridge (client/preload.cjs → client/main.js `app.getVersion()`) is held in client/test/shell-client.test.mjs.
//
// Counter-tests: `cbaseRow` returns the bare version without `note` ⇒ "build unknown" red; `text()` accepts "unknown" ⇒ the same;
// `apiLevelOf` accepts the string "1" ⇒ "API level" red; `pickVersionInfo` drops `gatewayVersion` ⇒ "allowlist" red;
// `shellAppVersion` returns "" for a throwing bridge ⇒ "shell" red; the page renders `r.value ?? ""` ⇒ "page" red; the gate
// no longer stores `pickVersionInfo(j)` ⇒ "gate" red.
//
// Run:  node --test web/test/about.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8");

// Both modules import nothing, so the output may live outside web/ — as ES modules.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-about-test-"));
let about, bridge;
try {
  execFileSync(process.execPath, [
    tsc, path.join(src, "lib", "about.ts"), path.join(src, "lib", "shell-bridge.ts"), "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022", "--outDir", out,
  ], { cwd: webDir, stdio: "pipe" });
  fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module" }));
  about = await import(pathToFileURL(path.join(out, "about.js")).href);
  bridge = await import(pathToFileURL(path.join(out, "shell-bridge.js")).href);
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
}
const { aboutRows, pickVersionInfo, apiLevelOf } = about;
const { shellAppVersion } = bridge;

const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

function withoutComments(text) {
  return text
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((z) => (/^\s*\/\//.test(z) ? "" : z))
    .join("\n");
}

// A current gateway answer (the shape of `GET /gw/info`).
const CURRENT = {
  gateway: true, version: "0.2.0", build: "0.2.0+3.gabc1234", commit: "abc1234".padEnd(40, "0"), release: "20261123-1",
  api: { level: 1, oldest: 1 }, gatewayVersion: "0.2.0", setup: false, authenticated: true, user: { username: "u", role: "user" },
};

test("rows: a current gateway shows build id, API level and gateway version; no desktop row outside the shell", () => {
  const rows = aboutRows({ server: pickVersionInfo(CURRENT), gatewayMode: true, desktop: undefined });
  assert.deepEqual(rows.map((r) => r.key), ["cbase", "api", "gateway"]);
  const r = byKey(rows);
  assert.deepEqual(r.cbase, { key: "cbase", label: "cbase", value: "0.2.0+3.gabc1234" });
  assert.equal(r.api.value, "1");
  assert.equal(r.gateway.value, "0.2.0");
});

test("build unknown: a version without a build id never stands bare — with the remark, or unknown", () => {
  // The gateway without its build file: its own package version plus build "unknown".
  const fallback = byKey(aboutRows({ server: { version: "0.2.0", build: "unknown", gatewayVersion: "0.2.0", api: { level: 1, oldest: 1 } }, gatewayMode: true }));
  assert.deepEqual(fallback.cbase, { key: "cbase", label: "cbase", value: "0.2.0", note: "build unknown" });
  // An old gateway: only `version` — no build, no API level, no gateway version.
  const old = byKey(aboutRows({ server: pickVersionInfo({ gateway: true, version: "0.1.9", setup: false }), gatewayMode: true }));
  assert.deepEqual(old.cbase, { key: "cbase", label: "cbase", value: "0.1.9", note: "build unknown" });
  assert.equal(old.api.value, null, "an old gateway shows an API level it never sent");
  assert.equal(old.gateway.value, null, "an old gateway shows a gateway version it never sent");
  // Nothing at all (no answer, unreadable answer): every server row unknown.
  for (const server of [null, {}, { version: "", build: "  " }, { version: 2, build: { x: 1 } }]) {
    const rows = aboutRows({ server, gatewayMode: true });
    assert.deepEqual(rows.map((r) => r.value), [null, null, null], `server ${JSON.stringify(server)}`);
    assert.equal(rows[0].note, undefined);
  }
});

test("API level: only a whole number from 1 up counts", () => {
  for (const [api, want] of [[{ level: 1, oldest: 1 }, 1], [{ level: 3 }, 3], [{ level: 0 }, null], [{ level: "1" }, null], [{ level: 1.5 }, null], [1, null], [null, null], [undefined, null]]) {
    assert.equal(apiLevelOf(api), want, JSON.stringify(api));
  }
});

test("local server: no gateway row; the desktop row appears in the shell, unknown when the shell does not report", () => {
  const local = { version: "0.2.0", build: "0.2.0", api: { level: 1, oldest: 1 }, schema: 7 };
  assert.deepEqual(aboutRows({ server: local, gatewayMode: false }).map((r) => r.key), ["cbase", "api"]);
  const withShell = byKey(aboutRows({ server: local, gatewayMode: false, desktop: "0.2.0" }));
  assert.deepEqual(withShell.desktop, { key: "desktop", label: "Desktop app", value: "0.2.0" });
  assert.equal(byKey(aboutRows({ server: local, gatewayMode: false, desktop: null })).desktop.value, null);
});

test("allowlist: the gate's copy of /gw/info carries all six version fields and nothing else", () => {
  assert.deepEqual(Object.keys(pickVersionInfo(CURRENT)).sort(), ["api", "build", "commit", "gatewayVersion", "release", "version"]);
  assert.deepEqual(pickVersionInfo(CURRENT).gatewayVersion, "0.2.0");
  assert.deepEqual(pickVersionInfo(CURRENT).api, { level: 1, oldest: 1 });
  for (const j of [null, undefined, "x", 3]) assert.deepEqual(pickVersionInfo(j), {});
});

test("shell: no bridge = no row, older bridge or broken answer = unknown, else the version", async () => {
  assert.equal(await shellAppVersion(undefined), undefined);
  assert.equal(await shellAppVersion({}), undefined, "a browser window counts as desktop");
  assert.equal(await shellAppVersion({ cbaseShell: { setTheme() {} } }), null, "an older client must read unknown");
  assert.equal(await shellAppVersion({ cbaseShell: { appVersion: async () => { throw new Error("x"); } } }), null);
  assert.equal(await shellAppVersion({ cbaseShell: { appVersion: async () => 5 } }), null);
  assert.equal(await shellAppVersion({ cbaseShell: { appVersion: async () => "" } }), null);
  assert.equal(await shellAppVersion({ cbaseShell: { appVersion: async () => null } }), null);
  assert.equal(await shellAppVersion({ cbaseShell: { appVersion: async () => " 0.2.0 " } }), "0.2.0");
});

test("page: ThirdPartyHints renders the rows, a missing value as the translated \"unknown\", the remark behind the value", () => {
  const page = withoutComments(read("components", "settings", "ThirdPartyHints.tsx"));
  for (const [needle, what] of [
    ["<AboutGroup />", "the About group is not rendered on the page"],
    ["aboutRows({ server: gw ? gw.info : local ?? null, gatewayMode: !!gw, desktop })", "the rows are not computed from gateway info / /api/version / the shell"],
    ['fetch("/api/version"', "the local server is not asked for its version"],
    ["shellAppVersion(window)", "the desktop version is not read through the bridge"],
    ['r.value === null ? t("unknown")', "a missing value is not shown as \"unknown\""],
    ["r.note ? `${r.value} (${t(r.note)})`", "the remark (build unknown) is not shown"],
    ["<Row key={r.key} title={t(r.label)}>", "the rows are not rendered as kit rows"],
  ]) assert.ok(page.includes(needle), `ThirdPartyHints.tsx: ${what} (anchor: ${needle})`);
});

test("gate: GatewayGate keeps the version fields of /gw/info and hands them to the context", () => {
  const gate = withoutComments(read("lib", "gateway.tsx"));
  assert.ok(gate.includes("setInfo(pickVersionInfo(j));"), "gateway.tsx no longer stores the version fields of /gw/info");
  assert.ok(gate.includes("value={{ user: user!, logout, info }}"), "gateway.tsx does not hand `info` to the context");
});

test("translations: every row title, \"About\", \"unknown\" and the remark have a German entry", () => {
  const de = read("lib", "i18n-de.ts");
  const labels = new Set(aboutRows({ server: { version: "1", build: "unknown" }, gatewayMode: true, desktop: null }).flatMap((r) => [r.label, r.note].filter(Boolean)));
  for (const k of [...labels, "About", "unknown"]) {
    assert.ok(new RegExp(`^  ${JSON.stringify(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: "`, "m").test(de), `i18n-de.ts: no entry for ${JSON.stringify(k)}`);
  }
});
