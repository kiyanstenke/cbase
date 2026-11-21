// Skills live in the Coding sidebar, per project or per whole workspace (same principle as credentials). No browser: the real
// modules (lib/skills.ts and lib/api/skills.ts, compiled with the local tsc) and the source text of the pages that must contain
// or must NOT contain something are checked.
//
// The promises:
//   1. Computations (lib/skills.ts): sorting, covering, "Hidden in" without invented knowledge, token count in readable size.
//   2. Wire (lib/api/skills.ts) against the contract: every route, method, body — the area is always in the POST, a PUT carries
//      only description and content, hiding goes by skill id, the catalogue takes `projectId` only for Coding.
//   3. Place: Coding -> Skills right after Credentials on BOTH levels; no `/skills` tab at the top any more, the page redirects.
//   4. Form like credentials: project level with two origin sections and a switch per workspace row; the workspace row names
//      "Hidden in" read-only; every view carries the cost line from the SERVER.
//   5. The flags are gone from the UI, the dialog knows only description · content, there is only ONE wire.
//   6. Translations of the new strings.
//   7. The page procedure (lib/skills-procedure.ts) RUN against a fake `fetch`: a failed hide/delete reloads and keeps its
//      message, the cost line takes only the latest answer and says when it is not readable, "in flight" is a set, an unknown
//      switch state does not switch.
//
// Counter-tests (each turns red once): in lib/api/skills.ts `area` struck from the create body => "Wire" red; `projectId`
// also appended for Managing => "Wire" red; in coding-tab.ts "skills" moved behind "code" => "Place" red; in SkillsPane.tsx the
// workspace section without `<Toggle` => "Form" red; the "projects" tab back in the dialog => "Flags and dialog" red; in
// skills-procedure.ts `toggle` with `load()` instead of `load({ keepError: true })` => "Procedure: hiding fails" red (the message
// was gone); `erase` without reload on failure => "Procedure: deleting fails" red; `loadCatalog` without a sequence counter =>
// "Procedure: cost line" red; `busy` in the `finally` set to `[]` instead of the set without this id => "Procedure: in flight" red;
// `onlyArea` without a filter => "Wire: foreign area" red; `tabFromAddress` without `isCodingTab` => "Place: ?tab=" red.
//
// This file runs in the gate (`./check` runs `web/test/*.mjs`), browser checks do not. The Managing skills list is
// gone with the Managing UI: `SkillArea` is only "coding" in the web.
//
// Run:  node --test --test-reporter=tap web/test/skills.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-skills-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "skills.ts"),
  "--outDir", path.join(out, "sheet"), "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { byName, covered, hiddenText, tokenShort } = await import(pathToFileURL(path.join(out, "sheet", "skills.js")).href);
// The wire: lib/api/skills.ts with its imports (core.ts, events.ts) — leaf modules with `.js` specifiers (README in lib/api/).
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "api", "skills.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", path.join(out, "api"),
], { cwd: webDir, stdio: "pipe" });
const wire = await import(pathToFileURL(path.join(out, "api", "skills.js")).href);
// The page procedure: lib/skills-procedure.ts with lib/skills.ts and lib/api/ (common root src/lib — the output is flat).
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "skills-procedure.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", path.join(out, "procedure"),
], { cwd: webDir, stdio: "pipe" });
const { skillsProcedure, SKILLS_BEGINNING } = await import(pathToFileURL(path.join(out, "procedure", "skills-procedure.js")).href);
// The tabs of the Coding page (leaf without imports) — for the address request `?tab=`.
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "coding-tabs.ts"),
  "--outDir", path.join(out, "tab"), "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const tab = await import(pathToFileURL(path.join(out, "tab", "coding-tabs.js")).href);

const read2 = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
// Comments drop out before every measurement — history may stand there without colouring the test.
const withoutComments = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 1. Computations ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Computations: sorted by name, without re-sorting the state", () => {
  const raw = [{ name: "zebra" }, { name: "alpha" }, { name: "middle" }];
  assert.deepEqual(byName(raw).map((s) => s.name), ["alpha", "middle", "zebra"]);
  assert.deepEqual(raw.map((s) => s.name), ["zebra", "alpha", "middle"], "byName re-sorts the passed list");
});

test("Computations: covered names the workspace skills that a same-named project skill displaces", () => {
  const own = [{ name: "deploy" }, { name: "only-here" }];
  const ws = [{ name: "deploy" }, { name: "review" }];
  assert.deepEqual([...covered(own, ws)], ["deploy"]);
  assert.deepEqual([...covered([], ws)], []);
});

test("Computations: \"Hidden in\" — the names in server order, `null` yields no knowledge", () => {
  assert.equal(hiddenText([{ id: "p1", name: "Checkout" }, { id: "p2", name: "Warehouse" }]), "Checkout, Warehouse");
  assert.equal(hiddenText([]), "");
  assert.equal(hiddenText(null), "", "without a statement from the server the row stays silent");
});

test("Computations: token count below a thousand exact, above that the order of magnitude", () => {
  assert.equal(tokenShort(0), "0");
  assert.equal(tokenShort(-5), "0");
  assert.equal(tokenShort(Number.NaN), "0");
  assert.equal(tokenShort(942), "942");
  assert.equal(tokenShort(1000), "1,0k");
  assert.equal(tokenShort(1234), "1,2k");
  assert.equal(tokenShort(999_950), "1M");
});

// ── 2. Wire ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Wire: every route per contract — area in the POST, PUT without area, hiding by id, catalogue per level", async () => {
  const prior = globalThis.fetch;
  const calls = [];
  let response = {};
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ?? null });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  const last = () => calls.at(-1);
  const ws = { kind: "workspace", workspaceId: "w1" };
  const pr = { kind: "project", projectId: "p1" };
  const meta = { id: "s1", name: "deploy", description: "d", area: "coding", forCoding: true, forManaging: false };
  try {
    // Lists
    response = [{ ...meta, hiddenIn: [{ id: "p2", name: "Warehouse" }, { id: "", name: "broken" }, "nonsense"] }, { ...meta, id: "s2" }];
    const coding = await wire.loadWorkspaceSkills("w1", "coding");
    assert.deepEqual(last(), { url: "/api/workspaces/w1/skills?area=coding", method: "GET", body: null });
    assert.deepEqual(coding[0].hiddenIn, [{ id: "p2", name: "Warehouse" }], "only entries with an id get through");
    assert.equal(coding[1].hiddenIn, null, "without a statement from the server `null` — never \"hidden in no project\"");

    response = [meta];
    await wire.loadProjectSkills("p1");
    assert.deepEqual(last(), { url: "/api/projects/p1/skills", method: "GET", body: null });
    response = [{ ...meta, enabled: true }, { ...meta, id: "s2", enabled: false }, { ...meta, id: "s3" }, { ...meta, id: "s4", enabled: "yes" }];
    const fromView = await wire.loadProjectWorkspaceSkills("p1");
    assert.deepEqual(last(), { url: "/api/projects/p1/workspace-skills", method: "GET", body: null });
    assert.deepEqual(fromView.map((s) => s.enabled), [true, false, null, null], "a missing state is `null`, never \"hidden\"");

    // A skill with content — via ITS owner
    response = { ...meta, body: "# x" };
    await wire.loadSkill(ws, "s1");
    assert.equal(last().url, "/api/workspaces/w1/skills/s1");
    await wire.loadSkill(pr, "s1");
    assert.equal(last().url, "/api/projects/p1/skills/s1");

    // Create: the area is ALWAYS in the body, the name trimmed, no flags
    response = meta;
    await wire.setUpSkill(ws, "coding", { name: "  report  ", description: "when", body: "# b" });
    assert.equal(last().method, "POST");
    assert.equal(last().url, "/api/workspaces/w1/skills");
    assert.deepEqual(JSON.parse(last().body), { name: "report", description: "when", body: "# b", area: "coding" });
    await wire.setUpSkill(pr, "coding", { name: "till", description: "", body: "#" });
    assert.equal(last().url, "/api/projects/p1/skills");
    assert.deepEqual(JSON.parse(last().body), { name: "till", description: "", body: "#", area: "coding" });

    // Change: only description and content — neither name nor area nor a flag
    await wire.changeSkill(pr, "s1", { name: "different", description: "fresh", body: "# n", area: "coding", forManaging: true });
    assert.deepEqual(last(), { url: "/api/projects/p1/skills/s1", method: "PUT", body: '{"description":"fresh","body":"# n"}' });

    await wire.deleteSkill(ws, "s1");
    assert.deepEqual(last(), { url: "/api/workspaces/w1/skills/s1", method: "DELETE", body: null });

    // Hiding: by skill id, the body always carries `enabled`
    response = { ok: true };
    await wire.setSkillAvailable("p1", "s1", false);
    assert.deepEqual(last(), { url: "/api/projects/p1/workspace-skills/s1/enabled", method: "PATCH", body: '{"enabled":false}' });
    await wire.setSkillAvailable("p1", "s1", true);
    assert.equal(last().body, '{"enabled":true}');

    // Catalogue: Coding with/without project; an answer without two numbers is `null`, not 0
    response = { count: 3, token: 120 };
    assert.deepEqual(await wire.loadSkillCatalog("w1", "coding", "p1"), { count: 3, token: 120 });
    assert.equal(last().url, "/api/workspaces/w1/skill-catalog?area=coding&projectId=p1");
    await wire.loadSkillCatalog("w1", "coding", null);
    assert.equal(last().url, "/api/workspaces/w1/skill-catalog?area=coding");
    response = {};
    assert.equal(await wire.loadSkillCatalog("w1", "coding"), null);
    response = { count: "3", token: 120 };
    assert.equal(await wire.loadSkillCatalog("w1", "coding"), null);

    // Ids go out encoded
    await wire.deleteSkill({ kind: "project", projectId: "p 1" }, "s/1");
    assert.equal(last().url, "/api/projects/p%201/skills/s%2F1");
  } finally {
    globalThis.fetch = prior;
  }
});

test("Wire: one place — only lib/api/skills.ts talks to the skill routes, the old ways are gone", () => {
  // `GET /api/skills` and the name-based PATCH (`…/workspace-skills/:name/enabled`) are gone.
  const foreign = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const rel = path.relative(webDir, p);
        const text = withoutComments(fs.readFileSync(p, "utf8"));
        if (/["'`]\/api\/skills["'`?]/.test(text)) foreign.push(`${rel}: /api/skills`);
        if (rel !== path.join("src", "lib", "api", "skills.ts")) {
          if (/workspace-skills\//.test(text)) foreign.push(`${rel}: workspace-skills/… bypassing the wire`);
          if (/\/skill-catalog/.test(text)) foreign.push(`${rel}: skill-catalog bypassing the wire`);
          if (/\/skills\?area=/.test(text)) foreign.push(`${rel}: skill list bypassing the wire`);
        }
      }
    }
  };
  walk(path.join(webDir, "src"));
  assert.deepEqual(foreign, []);
});

// A fake `fetch` for the tests below: `route(method, url)` returns `{ status, body }` (also as a promise — so answers can be
// released in any order). `back()` belongs in every `finally`.
function fakeFetch(route) {
  const prior = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ method, url: String(url), body: opts.body ?? null });
    const a = await route(method, String(url));
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, back: () => { globalThis.fetch = prior; } };
}
const deferral = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
// The state of a page as React would hold it: `change` receives a function of the old state.
const pagesStatus = () => {
  const s = { state: SKILLS_BEGINNING };
  s.change = (f) => { s.state = f(s.state); };
  return s;
};

test("Wire: foreign area — an area list drops entries with a foreign or missing `area` (old server)", async () => {
  // New web against an older server (a rollback to an older release): it ignores `?area=` and sends both areas.
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  const f = fakeFetch(() => ({ body: [
    { id: "c", name: "c", description: "", area: "coding" },
    { id: "m", name: "m", description: "", area: "managing" },
    { id: "x", name: "x", description: "" },
  ] }));
  try {
    assert.deepEqual((await wire.loadWorkspaceSkills("w1", "coding")).map((s) => s.id), ["c"]);
    assert.deepEqual((await wire.loadProjectSkills("p1")).map((s) => s.id), ["c"], "a project list is always Coding");
    assert.deepEqual((await wire.loadProjectWorkspaceSkills("p1")).map((s) => s.id), ["c"]);
    assert.equal(warnings.length, 3, "dropping does not stay silent");
    assert.match(warnings[0], /2 entries without area "coding" dropped/);
  } finally {
    f.back();
    console.warn = warn;
  }
});

// ── 2b. The page procedure (lib/skills-procedure.ts) ─────────────────────────────────────────────────────────────────────────

const WS_SKILL = { id: "s1", name: "deploy", description: "", area: "coding" };

test("Procedure: hiding fails (PATCH 404) — the switch jumps to the server state, the message STAYS", async () => {
  const s = pagesStatus();
  const f = fakeFetch((m, url) => {
    if (m === "PATCH") return { status: 404, body: { error: "Skill not found" } };
    if (url === "/api/projects/p1/skills") return { body: [] };
    if (url === "/api/projects/p1/workspace-skills") return { body: [{ ...WS_SKILL, enabled: true }] };
    if (url.startsWith("/api/workspaces/w1/skill-catalog?")) return { body: { count: 1, token: 40 } };
    return { status: 500, body: { error: `unexpected: ${m} ${url}` } };
  });
  try {
    const a = skillsProcedure({ area: "coding", workspaceId: "w1", projectId: "p1" }, s.change);
    await a.load();
    assert.equal(s.state.error, null);
    assert.deepEqual(s.state.workspace.map((x) => x.enabled), [true]);
    assert.deepEqual(s.state.catalog, { kind: "loaded", value: { count: 1, token: 40 } });
    assert.ok(f.calls.some((x) => x.url === "/api/workspaces/w1/skill-catalog?area=coding&projectId=p1"), "the catalogue does not apply to the project level");

    const prior = f.calls.length;
    await a.toggle(s.state.workspace[0]);
    const afterwards = f.calls.slice(prior);
    assert.deepEqual(afterwards[0], { method: "PATCH", url: "/api/projects/p1/workspace-skills/s1/enabled", body: '{"enabled":false}' }, "hiding goes by skill id");
    assert.ok(afterwards.some((x) => x.url === "/api/projects/p1/workspace-skills"), "no reload after the failure");
    assert.equal(s.state.error, "Skill not found", "the message is gone after the reload — the switch jumped back for no reason");
    assert.deepEqual(s.state.workspace.map((x) => x.enabled), [true], "the switch does not show the server state");
    assert.deepEqual([...s.state.busy], []);

    // A later successful load clears the message (a new attempt succeeded) — it does not stick forever.
    await a.load();
    assert.equal(s.state.error, null);
  } finally {
    f.back();
  }
});

test("Procedure: deleting fails — reloaded anyway, the message stays; a successful delete clears it", async () => {
  const s = pagesStatus();
  let deleteStatus = 409;
  let list = [WS_SKILL];
  const f = fakeFetch((m, url) => {
    if (m === "DELETE") {
      if (deleteStatus !== 200) return { status: deleteStatus, body: { error: "locked" } };
      list = [];
      return { body: { ok: true } };
    }
    if (url === "/api/workspaces/w1/skills?area=coding") return { body: list };
    if (url === "/api/workspaces/w1/skill-catalog?area=coding") return { body: { count: list.length, token: 10 } };
    return { status: 500, body: { error: `unexpected: ${m} ${url}` } };
  });
  try {
    const a = skillsProcedure({ area: "coding", workspaceId: "w1", projectId: null }, s.change);
    await a.load();
    const prior = f.calls.length;
    await a.erase({ kind: "workspace", workspaceId: "w1" }, "s1");
    const afterwards = f.calls.slice(prior).map((x) => `${x.method} ${x.url}`);
    assert.deepEqual(afterwards, [
      "DELETE /api/workspaces/w1/skills/s1",
      "GET /api/workspaces/w1/skills?area=coding",
      "GET /api/workspaces/w1/skill-catalog?area=coding",
    ], "no reload after the failed delete");
    assert.equal(s.state.error, "locked");
    assert.deepEqual(s.state.own.map((x) => x.id), ["s1"]);

    deleteStatus = 200;
    await a.erase({ kind: "workspace", workspaceId: "w1" }, "s1");
    assert.equal(s.state.error, null);
    assert.deepEqual(s.state.own, []);
    assert.deepEqual(s.state.catalog, { kind: "loaded", value: { count: 0, token: 10 } });
  } finally {
    f.back();
  }
});

test("Procedure: cost line — only the latest answer counts; if it fails it is \"not readable\" instead of silent", async () => {
  const s = pagesStatus();
  const open = [];
  let catalog = null;
  const f = fakeFetch((m, url) => {
    if (url.startsWith("/api/workspaces/w1/skill-catalog?")) {
      if (catalog) return catalog;
      const a = deferral();
      open.push(a);
      return a.p;
    }
    return { body: [] };
  });
  try {
    // The workspace level of Coding — the promise of this test (the latest answer counts) is the same.
    const a = skillsProcedure({ area: "coding", workspaceId: "w1", projectId: null }, s.change);
    assert.deepEqual(s.state.catalog, { kind: "loading" }, "before the first answer the row is loading");
    const old = a.loadCatalog();
    const fresh = a.loadCatalog();
    assert.equal(open.length, 2);
    assert.equal(f.calls[0].url, "/api/workspaces/w1/skill-catalog?area=coding", "the workspace level asks without a project");
    open[1].resolve({ body: { count: 2, token: 80 } });
    await fresh;
    open[0].resolve({ body: { count: 1, token: 40 } });
    await old;
    assert.deepEqual(s.state.catalog, { kind: "loaded", value: { count: 2, token: 80 } }, "the older, slower answer overwrote the younger one");

    catalog = { status: 500, body: { error: "Catalogue broken" } };
    await a.loadCatalog();
    assert.deepEqual(s.state.catalog, { kind: "error", text: "Catalogue broken" });
    catalog = { body: { count: "2" } };
    await a.loadCatalog();
    assert.deepEqual(s.state.catalog, { kind: "error", text: null }, "an answer without two numbers is not readable — no invented 0");
  } finally {
    f.back();
  }
});

test("Procedure: in flight is a set — two switches at once, neither releases the other; an unknown state does not switch", async () => {
  const s = pagesStatus();
  const patch = new Map();
  const f = fakeFetch((m, url) => {
    if (m === "PATCH") { const a = deferral(); patch.set(url.split("/")[5], a); return a.p; }
    if (url === "/api/projects/p1/skills") return { body: [] };
    if (url === "/api/projects/p1/workspace-skills") return { body: [{ ...WS_SKILL, enabled: true }, { ...WS_SKILL, id: "s2", name: "review", enabled: false }, { ...WS_SKILL, id: "s3", name: "old" }] };
    return { body: { count: 1, token: 1 } };
  });
  try {
    const a = skillsProcedure({ area: "coding", workspaceId: "w1", projectId: "p1" }, s.change);
    await a.load();
    // Grab by id, not by position (the list is sorted by name).
    const byId = (id) => s.state.workspace.find((x) => x.id === id);
    const one = a.toggle(byId("s1"));
    const two = a.toggle(byId("s2"));
    assert.deepEqual([...s.state.busy].sort(), ["s1", "s2"]);
    assert.equal(byId("s1").enabled, false, "the switch does not show the wish at once");
    assert.equal(byId("s2").enabled, true);
    patch.get("s1").resolve({ body: { ok: true } });
    await one;
    assert.deepEqual([...s.state.busy], ["s2"], "the first switch released the second while it was still running");
    patch.get("s2").resolve({ body: { ok: true } });
    await two;
    assert.deepEqual([...s.state.busy], []);

    // `enabled: null` (the server did not say): no PATCH, no state invented.
    const prior = f.calls.length;
    await a.toggle(byId("s3"));
    assert.equal(byId("s3").enabled, null);
    assert.equal(f.calls.length, prior, "an unknown state was switched");
  } finally {
    f.back();
  }
});

// ── 3. Place ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Place: Coding -> Skills right after Credentials, on both levels, rendered with workspace or project", () => {
  const tab = read2("src/lib/coding-tabs.ts");
  const list = tab.match(/export const CODING_TABS = \[([\s\S]*?)\] as const;/);
  assert.ok(list, "CODING_TABS not found — update the anchor");
  const keys = [...list[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(keys[keys.indexOf("vars") + 1], "skills", `"skills" does not stand right after "vars": ${keys.join(", ")}`);
  assert.ok(!/ONLY_WORKSPACE[^\n]*"skills"/.test(tab) && !/ONLY_PROJECT[^\n]*"skills"/.test(tab), "\"skills\" exists on only one level");
  assert.ok(!/NOT_RESTORED[^\n]*"skills"/.test(tab), "\"skills\" does not come back after ⌘R");

  const page = withoutComments(read2("src/app/workspaces/page.tsx"));
  assert.match(page, /import \{ SkillsPane \} from "@\/components\/SkillsPane";/);
  assert.match(page, /\{ key: "vars", label: "Credentials", icon: <TabIcon kind="vars" \/> \},\s*\{\s*key: "skills",/, "the tab does not stand right after Credentials");
  assert.match(page, /\{tab === "skills" && activeId && \(\s*<SkillsPane\s+key=\{enteredProject \? `sk:\$\{enteredProject\.id\}` : `sk:\$\{activeId\}`\}\s+workspaceId=\{activeId\}\s+projectId=\{enteredProject\?\.id \?\? null\}/,
    "Coding -> Skills does not render SkillsPane with workspace and (in the entered project) project");
  assert.match(page, /case "skills": return p\(/, "TabIcon does not know \"skills\"");
  // The remembered tab: ONE spelling of the key (lib/coding-tabs.ts), read and written only via the function.
  assert.match(page, /localStorage\.getItem\(codingTabKey\(id\)\)/);
  assert.match(page, /localStorage\.setItem\(codingTabKey\(activeId\), tab\)/);
  assert.doesNotMatch(page, /cbase-tab:/, "the page writes the tab key itself again");
});

test("Place: ?tab= — only known tabs, once, read before any storage access and removed from the address", () => {
  assert.equal(tab.tabAddress("skills"), "/workspaces/?tab=skills");
  const output = (q) => tab.tabFromAddress(new URLSearchParams(q));
  assert.equal(output(new URL(tab.tabAddress("skills"), "http://x").search), "skills", "the redirect and the page do not understand each other");
  assert.equal(output("?tab=vars"), "vars");
  assert.equal(output("?tab=project"), "project", "the level is resolved by the page (tabOnLevel), not the address");
  for (const q of ["", "?tab=", "?tab=nonsense", "?tab=SKILLS", "?tab=dynworkflows", "?tab=__proto__", "?tab=toString"]) {
    assert.equal(output(q), null, `"${q}" was accepted as a tab`);
  }

  // The page: read BEFORE the first storage access (without storage the wish still counts), take it from the address, move it on the FIRST
  // `open()` (even if a workspace is only chosen then) — and only once.
  const page = withoutComments(read2("src/app/workspaces/page.tsx"));
  const read = page.indexOf("const wantedTab = tabFromAddress(params);");
  assert.ok(read > 0, "the page does not read ?tab= via tabFromAddress");
  assert.ok(read < page.indexOf('localStorage.getItem("cbase-ws")'), "?tab= is read only after a storage access");
  assert.match(page, /u\.searchParams\.delete\(TAB_PARAMETER\);\s*window\.history\.replaceState\(/, "?tab= stays in the address — every ⌘R would jump again");
  assert.match(page, /const wish = tabWish\.current;\s*tabWish\.current = null;\s*setTab\(wish \? \(tabOnLevel\(wish, !!savedEntered\) \?\? "chats"\) : savedTabOf\(savedTab, !!savedEntered\)\);/,
    "open() does not apply the wish (once, laid onto the level)");
  assert.match(page, /try \{ remembered = localStorage\.getItem\("cbase-ws"\); \} catch/, "without storage the setup throws before the wish applies");
  assert.match(page, /try \{ savedTab = localStorage\.getItem\(codingTabKey\(id\)\); \} catch/, "without storage open() throws before the wish applies");
});

test("Place: no /skills tab at the top — the page redirects to Coding -> Skills", () => {
  const nav = withoutComments(read2("src/components/TopNav.tsx"));
  assert.ok(!nav.includes('href="/skills"'), "the /skills tab is back in the top bar");
  // Anchor: Coding before Apps.
  assert.ok(nav.indexOf('href="/workspaces"') >= 0 && nav.indexOf('href="/workspaces"') < nav.indexOf('href="/apps"'), "anchor: Coding before Apps not found");
  assert.doesNotMatch(read2("src/components/RouteTransition.tsx"), /const ORDER = \[[^\]]*"\/skills"/, "RouteTransition still counts /skills as a tab");

  const further = withoutComments(read2("src/app/skills/page.tsx"));
  assert.match(further, /router\.replace\(tabAddress\("skills"\)\)/, "the page does not redirect via the address wish to Coding -> Skills");
  assert.doesNotMatch(further, /localStorage|readActiveScope/, "the redirect depends on storage or the remembered workspace again");
  assert.doesNotMatch(further, /SkillDialog|WorkspaceRail|\bapi\(/, "/skills is a page of its own again");
  // The key itself: the same function for the page.
  assert.match(read2("src/lib/coding-tabs.ts"), /export function codingTabKey\(workspaceId: string\): string \{\s*return `cbase-tab:\$\{workspaceId\}`;/);
  assert.match(read2("src/app/workspaces/page.tsx"), /localStorage\.setItem\(codingTabKey\(activeId\), tab\)/);

  assert.match(read2("src/components/AgentDialog.tsx"), /t\("No skills here yet — create them under Coding → Skills\."\)/, "the hint in the subagent dialog does not point to Coding -> Skills");
});


// ── 4. Form like credentials ─────────────────────────────────────────────────────────────────────────────────────────────────

test("Form: workspace level only the workspace skills with \"Hidden in\", project level two origins with a switch", () => {
  const pane = withoutComments(read2("src/components/SkillsPane.tsx"));
  // What is read is loaded by the procedure: workspace level the workspace Coding skills, project level own + workspace skills.
  assert.match(pane, /useSkillsProcedure\("coding", workspaceId, projectId\)/);
  const procedure = withoutComments(read2("src/lib/skills-procedure.ts"));
  assert.match(procedure, /loadWorkspaceSkills\(level\.workspaceId, level\.area\)/, "the workspace level does not read the list of its area");
  assert.match(procedure, /Promise\.all\(\[loadProjectSkills\(project\), loadProjectWorkspaceSkills\(project\)\]\)/, "the project level does not read own + workspace skills");
  assert.match(procedure, /const project = level\.area === "coding" \? level\.projectId : null;/, "Managing gets a project");
  assert.doesNotMatch(pane, /"managing"/, "Coding -> Skills knows Managing");
  // Read-only in the workspace row, hiding only in the project.
  assert.match(pane, /const hidden = hiddenText\(s\.hiddenIn \?\? null\);/);
  assert.match(pane, /\{t\("Hidden in"\)\}: \{hidden\}/);
  // Two origin sections in the project, the workspace section with a switch per row via the skill id.
  assert.match(pane, /\{inProject \? <OriginSection kind="project">\{ownRows\}<\/OriginSection> : ownRows\}/);
  const wsSection = pane.slice(pane.indexOf('kind="workspace"'), pane.indexOf("{upkeep.dialog}"));
  assert.ok(wsSection.length > 0, "anchor: the workspace section is missing");
  assert.match(wsSection, /<Toggle\s+on=\{s\.enabled\}\s+onClick=\{\(\) => \{ procedure\.toggle\(s\)/, "the workspace section has no switch per row");
  assert.match(wsSection, /disabled=\{busy\.includes\(s\.id\)\}/, "\"in flight\" is a single id again");
  assert.match(procedure, /await setSkillAvailable\(project, skill\.id, target\);/, "hiding does not go by skill id");
  assert.match(wsSection, /<OriginMarker kind="workspace" \/>/);
  // An unknown state (`enabled: null`): no switch but a dimmed word with an explanation; only `true` is counted.
  assert.match(wsSection, /\{s\.enabled === null \? \(\s*<span[\s\S]*?data-skill-status-unknown[\s\S]*?\{t\("state unknown"\)\}\s*<\/span>\s*\) : \(\s*<Toggle/, "an unknown state shows a switch");
  assert.match(wsSection, /\{s\.enabled === false && <span className="shrink-0">\{t\("hidden in this project"\)\}<\/span>\}/, "an unknown state reads as \"hidden\"");
  assert.match(pane, /\(wsSkills \?\? \[\]\)\.filter\(\(s\) => s\.enabled === true\)\.length/, "the summary counts an unknown state");
  // Creating goes to the owner of this level, with the area Coding.
  assert.match(pane, /const owner: SkillOwner = projectId \? \{ kind: "project", projectId \} : \{ kind: "workspace", workspaceId \};/);
  // With the workspace for the "History" tab.
  assert.match(pane, /useSkillUpkeep\("coding", procedure, workspaceId\)/);
  assert.match(pane, /else await setUpSkill\(openDraft\.owner, area, d\);/);
  // Errors belong to the procedure (it keeps them across the reload); the upkeep has no error state of its own that would overtake it.
  assert.match(pane, /await procedure\.erase\(owner, s\.id\);/);
  assert.doesNotMatch(pane, /useState<string \| null>\(null\)/, "a second error state next to the procedure's");
  for (const d of ["src/components/SkillsPane.tsx"]) {
    assert.match(withoutComments(read2(d)), /<SkillError error=\{state\.error\} onClose=\{\(\) => procedure\.setError\(null\)\} \/>/, `${d}: the error line does not read the procedure state`);
  }
});

test("Form: every skills view carries the cost line — from the server, for exactly this level", () => {
  const pane = withoutComments(read2("src/components/SkillsPane.tsx"));
  const procedure = withoutComments(read2("src/lib/skills-procedure.ts"));
  assert.match(procedure, /loadSkillCatalog\(level\.workspaceId, level\.area, project\)/, "the catalogue does not apply to the level of the page");
  for (const [name, text] of [["SkillsPane.tsx", pane], ["skills-procedure.ts", procedure]]) {
    if (name !== "skills-procedure.ts") assert.match(text, /<SkillCost\s+catalog=\{state\.catalog\}/, `${name}: no cost line from the procedure state`);
    assert.doesNotMatch(text, /\.length \/ 4|\/ 4\)/, `${name}: estimates tokens in the client — the computation belongs to the server`);
  }
  assert.doesNotMatch(read2("src/lib/skills.ts"), /\/ 4\b/, "lib/skills.ts estimates tokens in the client");
  assert.match(pane, /t\("In the catalogue here: \{n\} skills · ~\{token\} tokens per request", \{ n: count, token \}\)/);
  // While it loads, the row is silent; if it fails, it says so dimmed with the message in the tooltip — no invented 0.
  const cost = pane.slice(pane.indexOf("export function SkillCost("), pane.indexOf("export function SkillError("));
  assert.match(cost, /if \(catalog\.kind === "loading"\) return null;/);
  assert.match(cost, /if \(catalog\.kind === "error"\) \{\s*return \(\s*<span className="text-dim\/70" title=\{catalog\.text \?\? t\("The response carried no numbers\."\)\} data-skill-catalog-error>\s*\{t\("Catalogue not readable"\)\}/,
    "a failed catalogue stays silent (or does not say so dimmed with the message)");
});

// ── 5. Flags and dialog ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("Flags and dialog: no flags in the UI, the dialog knows only description · content", () => {
  const dialog = withoutComments(read2("src/components/SkillDialog.tsx"));
  const items = dialog.match(/items=\{\[\s*\{ key: "description"[\s\S]*?\]\}/);
  assert.ok(items, "anchor: the dialog tabs not found");
  // Plus "History" — only if the page passes it (Coding, existing skill); a choice of area or projects stays out.
  assert.deepEqual([...items[0].matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]), ["description", "content", "history"]);
  assert.match(dialog, /\.\.\.\(history \? \[\{ key: "history"/, "the \"History\" tab stands there without content");
  assert.doesNotMatch(dialog, /projects|takenOver|forCoding|forManaging|\barea\b/, "the dialog knows projects, takeover, flags or an area again");

  // No file under web/src reads the flags any more.
  const foreign = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /\bfuer(Coding|Managing)\b/.test(withoutComments(fs.readFileSync(p, "utf8")))) foreign.push(path.relative(webDir, p));
    }
  };
  walk(path.join(webDir, "src"));
  assert.deepEqual(foreign, [], "a file reads the \"for Coding/Managing\" flags again");
});

// ── Alarms from the probes that do not run in the gate ───────────────────────────────────────────────────────────────────────

test("Skill dialog: the editor scrolls itself (className=h-full next to height=100%)", () => {
  // `height="100%"` alone resolves against an auto height — the editor grows to the whole document height and its
  // `.cm-scroller` catches every wheel without being able to scroll (measured 0 px). The container needs the height: `className="h-full"`.
  const dialog = read2("src/components/SkillDialog.tsx");
  const editor = dialog.slice(dialog.indexOf("<MarkdownEditor"), dialog.indexOf("/>", dialog.indexOf("<MarkdownEditor")));
  assert.ok(editor.includes('height="100%"'), "the editor fills the height");
  assert.ok(editor.includes('className="h-full"'), "and its container has one");
});

test("Menu: the sheet hangs on the body via portal and the click catcher knows it", () => {
  const kit = read2("src/components/CbKit.tsx");
  const menu = kit.slice(kit.indexOf("export function Menu("), kit.indexOf("export function MenuEntry("));
  assert.ok(menu.includes("createPortal("), "the sheet sits at the body, not in the overflow-hidden surface");
  assert.ok(menu.includes('closest?.("[data-kit-pop]")'), "the document mousedown spares shell AND sheet");
  assert.ok(!menu.includes("box.current?.contains(e.target"), "box.contains would not see the portaled sheet");
  assert.ok(menu.includes("cb-kit fixed"), "cb-kit at the portal node (cool colour roles only below it), position in window coordinates");
});

// ── 6. Translations ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Translations: every t(\"…\") of the new files has exactly one line in i18n-de.ts", () => {
  const en = read2("src/lib/i18n-de.ts").split("\n");
  const exactly = (k) => en.filter((z) => z.trimStart().startsWith(`"${k}":`)).length;
  const files = ["src/components/SkillsPane.tsx", "src/components/SkillDialog.tsx"];
  const missing = [];
  const notLiteral = [];
  let n = 0;
  for (const d of files) {
    const text = read2(d);
    for (const m of text.matchAll(/\bt\(([^)]?)/g)) if (m[1] !== '"') notLiteral.push(`${d}: t(${m[1]}…`);
    for (const m of text.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
      n++;
      if (exactly(m[1]) !== 1) missing.push(`${d}: "${m[1]}" (${exactly(m[1])} lines)`);
    }
  }
  console.log(`  [i18n] ${n} keys in ${files.length} files`);
  assert.ok(n >= 30, `only ${n} t("…") found — does the regex still work?`);
  assert.deepEqual(notLiteral, [], "a t(…) with a non-literal key — nobody can hold that against i18n-de.ts");
  assert.deepEqual(missing, [], "keys without (or with a duplicate) German line — the UI would show English, a duplicate breaks the build (TS1117)");
});
