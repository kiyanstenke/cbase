// Preview links in the web.
//
// What is bound here, and which break turns it red:
//   (a) The bodies carry EVERY key — also `instance: null` and `validDays: null` ("unlimited"), also `apiKey: null` ("unchanged").
//       The server answers a missing field with 400, and `JSON.stringify` silently drops `undefined`: an
//       `instance: body.instance ?? undefined` or a conditional spread would turn "unlimited" and "not switched" into a 400,
//       without a type error. Counter-test (by hand): `validDays: body.validDays ?? undefined` in `setUpPreviewLink` ⇒ "bodies" red.
//   (b) An access value never comes back into the UI: `normNgrokAccess` reads `authtoken`/`apiKey` ONLY as a truth value — if a
//       server sent the string by mistake, it appears in no field of the result. Counter-test: `authtoken: Boolean(r.authtoken)`
//       stays green (no string), `authtoken: r.authtoken as boolean` ⇒ red.
//   (c) The computations of the sheet lib/preview-links.ts: merging from the SSE stream (before the first fetch NO status —
//       "empty is not unknown"), the position of the share menu, the instance of a service row (before `/api/projects` nothing
//       goes out), the active link of a row, the remaining time (time passed in, no timer).
//   (d) By path: the Integrations page carries GitLab AND ngrok (as a list of services); both service lists of the pill carry
//       "Share link"; the state follows the SSE event without a polling loop (no setInterval in the hook).
//
// Run:  node --test --test-reporter=tap web/test/preview-links.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");
const withoutComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let module = null;
async function load(t) {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc)"); return null; }
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-preview-links-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "preview-links.ts"), src("lib", "api", "preview.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  module = {
    ...(await import(pathToFileURL(path.join(tmp, "preview-links.js")).href)),
    ...(await import(pathToFileURL(path.join(tmp, "api", "preview.js")).href)),
  };
  return module;
}

const link = (x = {}) => ({
  id: "l1", projectId: "p1", projectName: "ORBIT", instance: "main", serviceId: 1, serviceName: "Web", port: 3000,
  mode: "dev", url: "https://a.ngrok-free.dev", state: "online", error: "", createdAt: 1, runningSinceAt: null,
  endedAt: null, endedReason: null, ...x,
});
const snapshot = (x = {}) => ({ active: [], history: [], mode: "dev", limit: 1, sdk: true, ...x });

// ── (a) Bodies ───────────────────────────────────────────────────────────────────────────────────

test("bodies: POST carries all four keys (null too), PUT both — nothing drops out as undefined", async (t) => {
  const m = await load(t);
  if (!m) return;
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    const body = url.includes("/api/preview-links") ? link({ state: "start", url: "" }) : { authtoken: true, apiKey: false, mode: "dev", limit: 1, active: 0, sdk: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await m.setUpPreviewLink({ projectId: "p1", instance: null, serviceId: 4, validDays: null });
    await m.setUpPreviewLink({ projectId: "p1", instance: "copy-k1", serviceId: 4, validDays: 7 });
    await m.setNgrokAccess({ authtoken: "test-token-xyz", apiKey: null });
    await m.setNgrokAccess({ authtoken: null, apiKey: "" });
  } finally { globalThis.fetch = old; }
  assert.deepEqual(sent[0], { url: "/api/preview-links", method: "POST", body: { projectId: "p1", instance: null, serviceId: 4, validDays: null } });
  assert.deepEqual(sent[1].body, { projectId: "p1", instance: "copy-k1", serviceId: 4, validDays: 7 });
  assert.deepEqual(sent[2], { url: "/api/integrations/ngrok", method: "PUT", body: { authtoken: "test-token-xyz", apiKey: null } });
  assert.deepEqual(Object.keys(sent[3].body).sort(), ["apiKey", "authtoken"], "\"remove API key\" sends both keys");
  assert.deepEqual(m.PREVIEW_VALIDITIES, [1, 7, 30, null]);
  assert.equal(m.PREVIEW_VALIDITY_DEFAULT, 7, "7 days are preselected");
});

// ── (b) Access values never come back ───────────────────────────────────────────────────────────

test("normNgrokAccess: a value that a server wrongly sends back appears in no field", async (t) => {
  const m = await load(t);
  if (!m) return;
  const z = m.normNgrokAccess({ authtoken: "secret-123", apiKey: "secret-456", mode: "names", limit: 3, active: 2, sdk: true });
  assert.equal(JSON.stringify(z).includes("secret"), false);
  assert.equal(z.authtoken, false, "only `true` means stored — a string is not an answer according to the contract");
  assert.equal(z.mode, "names");
  // Empty is not unknown: a missing mode means "off", a missing limit 0 — never "works".
  assert.deepEqual(m.normPreviewStatus({}), { active: [], history: [], mode: "off", limit: 0, sdk: false });
  assert.equal(m.normPreviewLink({ state: "online" }), null, "a link without an id is not a link");
});

// ── (c) Computations ───────────────────────────────────────────────────────────────────────────────

test("withLink: no status before the first fetch; active replaces in place; ended moves to the top of the history", async (t) => {
  const m = await load(t);
  if (!m) return;
  assert.equal(m.withLink(null, link()), null, "a single event is not a complete list");
  const s0 = snapshot({ active: [link({ id: "a" }), link({ id: "b" })] });
  const s1 = m.withLink(s0, link({ id: "a", url: "https://new.example.com" }));
  assert.deepEqual(s1.active.map((l) => [l.id, l.url]), [["a", "https://new.example.com"], ["b", "https://a.ngrok-free.dev"]]);
  const s2 = m.withLink(s1, link({ id: "c" }));
  assert.deepEqual(s2.active.map((l) => l.id), ["a", "b", "c"]);
  const full = snapshot({ active: [link({ id: "a" })], history: Array.from({ length: 20 }, (_, i) => link({ id: `v${i}`, state: "ended", endedAt: 5 })) });
  const s3 = m.withLink(full, link({ id: "a", state: "ended", endedAt: 9, endedReason: "revoke" }));
  assert.deepEqual(s3.active, []);
  assert.equal(s3.history[0].id, "a");
  assert.equal(s3.history.length, 20, "the history stays at the last 20");
  // A second `ended` of the same link (response + SSE) appears only once.
  assert.equal(m.withLink(s3, s3.history[0]).history.filter((l) => l.id === "a").length, 1);
});

test("shareSituation: loading · without SDK · without access · limit · ready", async (t) => {
  const m = await load(t);
  if (!m) return;
  assert.equal(m.shareSituation(null), "loading");
  assert.equal(m.shareSituation(snapshot({ sdk: false })), "without-sdk");
  assert.equal(m.shareSituation(snapshot({ mode: "off", limit: 0 })), "without-access");
  assert.equal(m.shareSituation(snapshot({ active: [link()] })), "limit", "free plan: one link at a time");
  assert.equal(m.shareSituation(snapshot({ mode: "names", limit: 3, active: [link(), link({ id: "b" })] })), "ready");
  assert.equal(m.shareSituation(snapshot({ mode: "names", limit: 3, active: [link(), link({ id: "b" }), link({ id: "c" })] })), "limit");
});

test("serviceTargetInstance: nothing before /api/projects, not switched null, otherwise the name after the last slash", async (t) => {
  const m = await load(t);
  if (!m) return;
  assert.equal(m.serviceTargetInstance(null, "p1"), undefined, "not loaded is not \"not switched\"");
  const inst = new Map([["p1", "p1/main"]]);
  assert.equal(m.serviceTargetInstance(inst, "p2"), null);
  assert.equal(m.serviceTargetInstance(inst, "p1"), "main");
  assert.equal(m.serviceTargetInstance(inst, "p1", "p1/copy-k1"), "copy-k1", "the chosen copy takes precedence over the main");
  assert.equal(m.serviceTargetInstance(null, "p1", "p1/copy-k1"), "copy-k1");
  assert.equal(m.serviceTargetInstance(inst, "p1", "p9/main"), undefined, "a foreign id is not guessed");
  assert.equal(m.serviceTargetInstance(new Map([["a/b", "a/b/main"]]), "a/b"), "main", "project ids with a slash");
});

test("linkOfTheRow: project, instance AND service — `null` (B) is not `main`, an unknown instance never matches", async (t) => {
  const m = await load(t);
  if (!m) return;
  const active = [link({ id: "h", instance: "main" }), link({ id: "k", instance: "copy-k1" }), link({ id: "b", instance: null, projectId: "p2" })];
  assert.equal(m.linkOfTheRow(active, "p1", "main", 1).id, "h");
  assert.equal(m.linkOfTheRow(active, "p1", "copy-k1", 1).id, "k");
  assert.equal(m.linkOfTheRow(active, "p1", null, 1), null);
  assert.equal(m.linkOfTheRow(active, "p2", null, 1).id, "b");
  assert.equal(m.linkOfTheRow(active, "p1", "main", 2), null);
  assert.equal(m.linkOfTheRow(active, "p1", undefined, 1), null);
  assert.equal(m.linkOfTheRow(null, "p1", "main", 1), null);
});

// In the "Instances" tab the TREE is the source of the link of a service row (refreshed on the beat), the link status only adds to it.
// Reading only the status would let a failed first fetch (status `null`) mean "no link" forever, although the tree delivered it every
// 5 s. Counter-test: `linkInTree` with the `if (tree)` branch removed (so only the status again) ⇒ this test red.
test("linkImTree: the tree is the source, the status adds to it — without a status the link of the tree is there", async (t) => {
  const m = await load(t);
  if (!m) return;
  const row = { projectId: "p1", instance: "copy-k1", serviceId: 1, serviceName: "Web", port: 3000 };
  const fromTree = { id: "l1", url: "https://k1.ngrok.app", procedure: 4_000_000, state: "online" };
  // The first fetch of the links failed (status null): the link of the tree is there anyway — copying and revoking need id and address.
  const withoutStatus = m.linkInTree(fromTree, 1000, null, row);
  assert.deepEqual([withoutStatus?.id, withoutStatus?.url, withoutStatus?.runningSinceAt, withoutStatus?.state, withoutStatus?.instance, withoutStatus?.serviceId],
    ["l1", "https://k1.ngrok.app", 4_000_000, "online", "copy-k1", 1], "without a link status the link of the tree vanished");
  assert.equal(m.linkInTree({ ...fromTree, state: "nonsense" }, 1000, null, row)?.state, "start", "an unknown state never becomes \"online\"");
  // The status knows it as active: its version (error text, state via SSE).
  const fresh = link({ id: "l1", instance: "copy-k1", state: "error", error: "tunnel gone", createdAt: 10 });
  assert.equal(m.linkInTree(fromTree, 1000, snapshot({ active: [fresh] }), row), fresh);
  // The status knows it as ended (just revoked, the tree is older): gone.
  assert.equal(m.linkInTree(fromTree, 1000, snapshot({ history: [link({ id: "l1", state: "ended", endedAt: 1200 })] }), row), null);
  // No link in the tree: only one that the status learned of AFTER the tree (just created) is there; an older one is not.
  const newer = link({ id: "l2", instance: "copy-k1", createdAt: 2000 });
  assert.equal(m.linkInTree(null, 1000, snapshot({ active: [newer] }), row), newer);
  assert.equal(m.linkInTree(null, 3000, snapshot({ active: [newer] }), row), null, "a link the younger tree no longer carries was still there");
  assert.equal(m.linkInTree(null, 1000, snapshot({ active: [link({ id: "l3", instance: "main", createdAt: 2000 })] }), row), null, "the link of another instance");
  assert.equal(m.linkInTree(null, 1000, null, row), null);
});

test("remainingTime: rounded down like a clock — \"6 d left\", \"23 h left\", \"unlimited\" never expired", async (t) => {
  const m = await load(t);
  if (!m) return;
  const MIN = 60_000, H = 60 * MIN, T = 24 * H, now = 1_791_450_000_000;
  assert.deepEqual(m.remainingTime(null, now), { kind: "unlimited" });
  assert.deepEqual(m.remainingTime(now + 7 * T - MIN, now), { kind: "days", n: 6 });
  assert.deepEqual(m.remainingTime(now + 2 * T, now), { kind: "days", n: 2 });
  assert.deepEqual(m.remainingTime(now + T - MIN, now), { kind: "hours", n: 23 });
  assert.deepEqual(m.remainingTime(now + 30 * MIN, now), { kind: "minutes", n: 30 });
  assert.deepEqual(m.remainingTime(now + 10_000, now), { kind: "minutes", n: 1 });
  assert.deepEqual(m.remainingTime(now, now), { kind: "expired" });
  const t0 = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (_, n) => String(p[n])) : k);
  assert.equal(m.remainingTimeText(m.remainingTime(now + 5 * H + 1, now), t0), "5 h left");
  assert.equal(m.validityText(null, t0), "unlimited");
  assert.equal(m.validityText(1, t0), "1 day");
  assert.equal(m.validityText(30, t0), "30 days");
  assert.equal(m.shortAddress("https://calm-tidy-example.ngrok-free.dev/"), "calm-tidy-example.ngrok-free.dev");
});

// ── (d) By path ────────────────────────────────────────────────────────────────────────────────

test("UI: Integrations carries GitLab AND ngrok; both service lists of the pill carry \"Share link\"; no polling beat", () => {
  // The page has its own list of services (IntegrationsSettings.tsx), the chosen one on the right; "Share link" without access jumps
  // straight to ngrok.
  const modal = withoutComments(read(src("components", "settings", "SettingsModal.tsx")));
  assert.match(modal, /key: "integrations"[^\n]*<IntegrationsSettings start=\{under\} \/>/, "the Integrations page does not render its list of services");
  const integrations = withoutComments(read(src("components", "settings", "IntegrationsSettings.tsx")));
  assert.match(integrations, /<GitlabSettings\b/, "the list of integrations does not open GitLab");
  assert.match(integrations, /<NgrokSettings\b/, "the list of integrations does not open ngrok");
  assert.match(withoutComments(read(src("components", "preview", "PreviewShare.tsx"))), /openSettings\("integrations:ngrok"\)/, "the jump without access does not land at ngrok");
  const pill = withoutComments(read(src("components", "pills", "ServicesPill.tsx")));
  // Two lists: the selection (chosen instance, a copy too) and "Running services" (main). Each builds its button.
  assert.equal([...pill.matchAll(/<PreviewButton\b/g)].length, 2, "not both service lists carry \"Share link\"");
  assert.match(pill, /previewRow\(projectOfTheIdentifier\(active\) \?\? "", d\.id, active\)/, "the selection list does not share the CHOSEN instance");
  assert.match(pill, /previewRow\(d\.projectId, d\.id, null\)/, "\"Running services\" does not share the main instance");
  const hook = withoutComments(read(src("components", "preview", "usePreviewLinks.ts")));
  assert.ok(!/setInterval|setTimeout/.test(hook), "the state of the links polls on a beat — it follows the SSE event");
  assert.match(hook, /PREVIEW_EVENT/);
  const ngrok = withoutComments(read(src("components", "settings", "NgrokSettings.tsx")));
  assert.equal([...ngrok.matchAll(/type="password"/g)].length, 2, "authtoken and API key are password fields");
  assert.ok(!/value=\{access/.test(ngrok), "a field shows a value from the response of the server");
});

// ── (e) By path ──────────────────────────────────────────────────────────────────────────────────
// At the limit of the plan the menu names the active links with "Revoke" (otherwise the active link often sits at no visible row).
// Creating closes only the OWN menu (not another row that was expanded in the meantime), and its error goes to the pill, which keeps it
// beyond the closing (an error inside the section would vanish with the ports menu). iOS: the same menu at the limit, the model lives
// in the button instead of the popover, the service row assigns via the target (computed in preview-rules-binding.test.mjs).
test("limit names the active links; creating closes only the own menu; an error survives closing (web and iOS)", () => {
  const share = withoutComments(read(src("components", "preview", "PreviewShare.tsx")));
  const limit = share.slice(share.indexOf('situation === "limit"'), share.indexOf('situation === "ready"'));
  assert.match(limit, /state\.active\.map\(/, "limit: the \"limit\" situation does not name the active links");
  assert.match(limit, /revoke\(a\)/, "limit: \"Revoke\" is missing at the limit");
  const create = share.slice(share.indexOf("async function create"), share.indexOf("async function revoke"));
  assert.ok(!/setError\(/.test(create) && /onNotice\(String/.test(create), "the error of creating stays inside the section (dies with it)");
  const pill = withoutComments(read(src("components", "pills", "ServicesPill.tsx")));
  assert.match(pill, /onClose=\{\(\) => setShareOpen\(\(v\) => \(v === row\.key \? null : v\)\)\}/, "onClose does not close only the own menu");
  assert.match(pill, /onNotice=\{setPreviewNotice\}/, "the pill does not hold the notice");
  assert.match(pill, /data-preview-notice\b/, "the notice is not in the ports menu");
  assert.match(pill, /data-preview-notice-point/, "with the menu closed the trigger shows no waiting notice");

  const mobile = (...p) => withoutComments(read(path.join(webDir, "..", "mobile", "CbaseMobile", ...p)));
  const button = mobile("Shell", "ServicesButton.swift");
  const buttonStruct = button.slice(button.indexOf("struct ServicesButton"), button.indexOf("private struct PortsMenu"));
  const menu = button.slice(button.indexOf("private struct PortsMenu"));
  assert.match(buttonStruct, /@StateObject private var preview = PreviewLinksModel\(\)/, "iOS: the model does not live in the button");
  assert.ok(!/@StateObject private var preview/.test(menu), "iOS: the popover holds a model of its own (dies on closing)");
  assert.match(buttonStruct, /preview\.errorUnseen/, "iOS: the button does not show an unseen error");
  assert.match(menu, /PreviewRules\.assignment\(/, "iOS: the service row does not assign via the target");
  const rules = mobile("Shell", "PreviewLinks.swift");
  const shareButton = rules.slice(rules.indexOf("struct PreviewShareButton"), rules.indexOf("struct PreviewLinkRow"));
  assert.match(shareButton, /if model\.limitReached[\s\S]*?ForEach\(snapshot\.active\)[\s\S]*?model\.revoke\(link\)/, "iOS: at the limit the menu does not name the active links");
});
