// The seam of the preview links: backend, web and iOS bound to ONE sheet.
//
// `server/backend/electron/server/preview/contract.js` (a sheet without imports) carries the lists the server computes with: the
// required keys of the bodies (POST_FIELDS, PUT_FIELDS), the runtimes, modes, states and reasons, the fields of the responses
// (LINK_FIELDS, STATUS_FIELDS, ACCESS_FIELDS), the SSE type and the length of the history. Nothing bound the two clients to it —
// `seams-fields.test.mjs` rates the two send sites as "not measurable", and iOS stays completely outside there. A renamed field in
// the server let both clients silently carry on with default values.
//
// What is bound here:
//   (a) Web, EXECUTED: `web/src/lib/api/preview.ts` (compiled without tsconfig, as global-events.test.mjs does with the lib/api
//       parts) exports the same lists; `normPreviewLink`/`normPreviewStatus`/`normNgrokAccess` receive an object of EXACTLY the
//       fields of the contract and return every field with its value, in the order of the contract; every state, reason and mode of
//       the contract survives the normalization; the bodies that go out carry exactly POST_FIELDS or PUT_FIELDS (with `null` too).
//       Plus `PREVIEW_EVENT`/`HISTORY_CAP` from lib/preview-links.ts. In the type the lists are bound to the types via
//       `PREVIEW_TYPES_BOUND` (tsc).
//   (b) iOS, read as TEXT (pattern of the *-ios-binding tests): `Models/ServiceModels.swift` — the `CodingKeys` of
//       `PreviewLinkCreation`/`NgrokAccessBody` equal POST_FIELDS/PUT_FIELDS, every key is encoded, every optional one with
//       `encodeNil` (a synthesized or conditional Encodable would drop it ⇒ 400); the decoder keys of `PreviewLink`,
//       `PreviewLinksStatus`, `NgrokAccess` equal LINK_/STATUS_/ACCESS_FIELDS and each is read; `PreviewMode` equals MODES; the
//       compared state and reason literals (Shell/PreviewLinks.swift, Shell/ServicesButton.swift, Settings/NgrokSettings.swift) ⊆
//       STATES or ENDED_REASONS, and every reason has its word; runtimes and default.
//   (c) One built-in sabotage per binding on an in-memory copy: a renamed field in `normPreviewLink` (web), a dropped `encodeNil`
//       and a renamed decoder key (iOS), a foreign state literal — each ⇒ deviation.
//
// Ran the counter-tests against the real state: lib/api/preview.ts without the exported lists ⇒ (a) red; in ServiceModels.swift
// `else { try c.encodeNil(forKey: .validDays) }` removed ⇒ (b) red ("validDays" is optional, but without encodeNil). A field removed
// from PREVIEW_LINK_FIELDS additionally turns tsc red (`PREVIEW_TYPES_BOUND`: "Type 'true' is not assignable to type 'false'").
//
// Run:  node --test --test-reporter=tap web/test/preview-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/preview/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const ios = (...p) => path.join(repo, "mobile", "CbaseMobile", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

// ── (a) Web ─────────────────────────────────────────────────────────────────────────────────────

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules missing (tsc) — the binding cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-preview-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "preview-links.ts"), src("lib", "api", "preview.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = {
    ...(await import(pathToFileURL(path.join(tmp, "preview-links.js")).href)),
    ...(await import(pathToFileURL(path.join(tmp, "api", "preview.js")).href)),
  };
  return web;
}

/** A version of lib/api/preview.ts with altered source — compiled next to the real one (same `./core.js` imports). */
async function loadWebSabotaged(change) {
  await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const source = change(read(src("lib", "api", "preview.ts")));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, "api", `preview-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

/** Example values per field of the contract — none of them is the default of the normalization, otherwise a lost field would look right. */
const EXAMPLE_LINK = {
  id: "l9", projectId: "p1", projectName: "ORBIT", instance: "copy-k1", serviceId: 4, serviceName: "Web", port: 3000,
  mode: "names", url: "https://a.ngrok.app", state: "ended", error: "broken", createdAt: 11, runningSinceAt: 22,
  endedAt: 33, endedReason: "expired",
};
const fromFields = (fields, example, location) => Object.fromEntries(fields.map((f) => {
  assert.ok(Object.hasOwn(example, f), `the contract names "${f}" (${location}), this test has no example value for it — add one`);
  return [f, example[f]];
}));

/** All deviations of the web side from the contract (empty = bound). */
async function webDeviations(m, contract = V) {
  const out = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { out.push(`${what}: web ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };
  equal([...m.PREVIEW_POST_FIELDS], [...contract.POST_FIELDS], "POST fields");
  equal([...m.NGROK_PUT_FIELDS], [...contract.PUT_FIELDS], "PUT fields");
  equal([...m.PREVIEW_VALIDITIES], [...contract.VALID_DAYS, null], "runtimes (+ unlimited)");
  equal(m.PREVIEW_VALIDITY_DEFAULT, contract.VALID_DEFAULT, "preselected runtime");
  equal([...m.PREVIEW_MODES], [...contract.MODES], "modes");
  equal([...m.PREVIEW_STATES], [...contract.STATES], "states");
  equal([...m.PREVIEW_ENDED_REASONS], [...contract.ENDED_REASONS], "reasons");
  equal([...m.PREVIEW_LINK_FIELDS], [...contract.LINK_FIELDS], "fields of a link");
  equal([...m.PREVIEW_STATUS_FIELDS], [...contract.STATUS_FIELDS], "fields of the status");
  equal([...m.NGROK_ACCESS_FIELDS], [...contract.ACCESS_FIELDS], "fields of the access");
  if (m.PREVIEW_EVENT !== undefined) equal(m.PREVIEW_EVENT, contract.SSE_TYPE, "SSE-Type");
  if (m.HISTORY_CAP !== undefined) equal(m.HISTORY_CAP, contract.HISTORY, "length of the history");

  // The normalization: a link of EXACTLY the fields of the contract comes back complete, in the order of the contract.
  const raw = fromFields(contract.LINK_FIELDS, EXAMPLE_LINK, "LINK_FIELDS");
  const link = m.normPreviewLink(raw);
  equal(link && Object.keys(link), [...contract.LINK_FIELDS], "normPreviewLink: keys");
  equal(link, raw, "normPreviewLink: values");
  for (const state of contract.STATES) equal(m.normPreviewLink({ ...raw, state })?.state, state, `state "${state}"`);
  for (const reason of contract.ENDED_REASONS) equal(m.normPreviewLink({ ...raw, endedReason: reason })?.endedReason, reason, `reason "${reason}"`);
  for (const mode of contract.MODES.filter((x) => x !== "off")) equal(m.normPreviewLink({ ...raw, mode })?.mode, mode, `link mode "${mode}"`);

  const statusRaw = fromFields(contract.STATUS_FIELDS, { active: [raw], history: [{ ...raw, id: "v1" }], mode: "names", limit: 3, sdk: true }, "STATUS_FIELDS");
  const snapshot = m.normPreviewStatus(statusRaw);
  equal(Object.keys(snapshot), [...contract.STATUS_FIELDS], "normPreviewStatus: keys");
  equal(snapshot, statusRaw, "normPreviewStatus: values");
  for (const mode of contract.MODES) equal(m.normPreviewStatus({ ...statusRaw, mode }).mode, mode, `mode "${mode}"`);

  const accessRaw = fromFields(contract.ACCESS_FIELDS, { authtoken: true, apiKey: true, mode: "dev", limit: 1, active: 1, checkedAt: 44, error: "x", sdk: true }, "ACCESS_FIELDS");
  const access = m.normNgrokAccess(accessRaw);
  equal(Object.keys(access), [...contract.ACCESS_FIELDS], "normNgrokAccess: keys");
  equal(access, accessRaw, "normNgrokAccess: values");

  // The bodies as they go out (fetch intercepted): exactly the required keys, with `null` too.
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify(url.includes("preview-links") ? raw : accessRaw), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await m.setUpPreviewLink({ projectId: "p1", instance: null, serviceId: 4, validDays: null });
    await m.setNgrokAccess({ authtoken: null, apiKey: null });
  } finally { globalThis.fetch = old; }
  equal(Object.keys(sent[0]?.body ?? {}), [...contract.POST_FIELDS], "body POST /api/preview-links");
  equal(Object.keys(sent[1]?.body ?? {}), [...contract.PUT_FIELDS], "body PUT /api/integrations/ngrok");
  return out;
}

test("web: lib/api/preview.ts carries the lists of the contract, the normalization loses no field, the bodies carry every key", async () => {
  const out = await webDeviations(await loadWeb());
  assert.deepEqual(out, [], `web ≠ contract.js:\n${out.join("\n")}`);
});

test("web, counter-test: a renamed field in normPreviewLink and a contract with a new state are noticed", async () => {
  const sabotaged = await loadWebSabotaged((q) => {
    assert.ok(q.includes("    endedReason: one("), "the line for the sabotage is no longer in normPreviewLink — update");
    return q.replace("    endedReason: one(", "    endedReasonX: one(");
  });
  const out = await webDeviations(sabotaged);
  assert.ok(out.some((z) => z.startsWith("normPreviewLink: keys")), `the renamed field went unnoticed:\n${out.join("\n")}`);
  const foreign = { ...V, STATES: [...V.STATES, "paused"] };
  const dev2 = await webDeviations(await loadWeb(), foreign);
  assert.ok(dev2.some((z) => z.startsWith("states")) && dev2.some((z) => z.startsWith("state \"paused\"")), dev2.join("\n"));
});

// ── (b) iOS ─────────────────────────────────────────────────────────────────────────────────────

const MODELS = ios("Models", "ServiceModels.swift");
const VIEWS = [ios("Shell", "PreviewLinks.swift"), ios("Shell", "ServicesButton.swift"), ios("Settings", "NgrokSettings.swift")];

/** A top-level type: from the head to the first `}` in column 0 (model: archive-binding.test.mjs). */
function block(text, header) {
  const rows = text.split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  if (start < 0) return null;
  const end = rows.findIndex((z, i) => i > start && z === "}");
  return end > start ? rows.slice(start, end + 1).join("\n") : null;
}

/** The keys of an `enum CodingKeys` — one line or several, with raw values (`case a = "b"` ⇒ "b"). */
function codingKeys(b) {
  const m = /enum CodingKeys: String, CodingKey \{([\s\S]*?)\n?\s*\}/.exec(b);
  if (!m) return null;
  const out = [];
  for (const row of m[1].split(/\n|(?=\bcase\b)/)) {
    const c = /\bcase\s+(.*)$/.exec(row.trim());
    if (!c) continue;
    for (const part of c[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const raw = /^(\w+)\s*=\s*"([^"]+)"$/.exec(t);
      out.push(raw ? raw[2] : t);
    }
  }
  return out;
}

const set = (xs) => [...new Set(xs)].sort();

/** All deviations of the iOS side from the contract; `texts` = { models, views: [...] } (for the sabotage on copies). */
function iosDeviations(texts, contract = V) {
  const out = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { out.push(`${what}: iOS ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };

  // Bodies: keys, each encoded, each optional one with encodeNil.
  for (const [header, fields, what] of [["struct PreviewLinkCreation", contract.POST_FIELDS, "POST"], ["struct NgrokAccessBody", contract.PUT_FIELDS, "PUT"]]) {
    const b = block(texts.models, header);
    if (!b) { out.push(`${header} missing in ServiceModels.swift`); continue; }
    equal(set(codingKeys(b) ?? []), set(fields), `${header}: CodingKeys (${what})`);
    const encode = b.slice(b.indexOf("func encode(to encoder"));
    for (const f of fields) {
      if (!new RegExp(`forKey: \\.${f}\\)`).test(encode)) out.push(`${header}: "${f}" is not encoded`);
      const type = new RegExp(`\\b(?:let|var) ${f}: ([^\\n=]+)`).exec(b)?.[1]?.trim();
      if (!type) { out.push(`${header}: no property "${f}"`); continue; }
      if (type.endsWith("?") && !new RegExp(`encodeNil\\(forKey: \\.${f}\\)`).test(encode)) out.push(`${header}: "${f}" is optional, but without encodeNil — a nil value would be missing in the body (400)`);
    }
  }
  // Responses: decoder keys equal to the contract, each read.
  for (const [header, fields] of [["struct PreviewLink:", contract.LINK_FIELDS], ["struct PreviewLinksStatus:", contract.STATUS_FIELDS], ["struct NgrokAccess:", contract.ACCESS_FIELDS]]) {
    const b = block(texts.models, header);
    if (!b) { out.push(`${header} missing in ServiceModels.swift`); continue; }
    equal(set(codingKeys(b) ?? []), set(fields), `${header} CodingKeys`);
    const read = b.slice(b.indexOf("init(from decoder"));
    for (const f of fields) if (!new RegExp(`\\(\\.${f}\\b`).test(read)) out.push(`${header} does not read "${f}"`);
  }
  // Modes.
  const mode = block(texts.models, "enum PreviewMode");
  equal(set((/\bcase\s+([^\n]+)/.exec(mode ?? "")?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean)), set(contract.MODES), "PreviewMode");

  // Compared literals in the views.
  const all = texts.views.join("\n");
  const states = [...all.matchAll(/state\s*(?:==|!=)\s*"([^"]+)"/g)].map((m) => m[1]);
  const reasons = [...all.matchAll(/endedReason\s*(?:==|!=)\s*"([^"]+)"/g)].map((m) => m[1]);
  const fn = /func previewStateText[\s\S]*?\n\}/.exec(all)?.[0] ?? "";
  const cut = fn.indexOf("switch link.endedReason");
  if (!fn.includes("switch link.state") || cut < 0) out.push("previewStateText no longer switches over state and endedReason — this test reads the literals there");
  states.push(...[...fn.slice(0, Math.max(0, cut)).matchAll(/case "([^"]+)"/g)].map((m) => m[1]));
  const reasonWords = [...fn.slice(Math.max(0, cut)).matchAll(/case "([^"]+)"/g)].map((m) => m[1]);
  reasons.push(...reasonWords);
  for (const z of set(states)) if (!contract.STATES.includes(z)) out.push(`iOS compares the state "${z}", which the contract does not know`);
  for (const g of set(reasons)) if (!contract.ENDED_REASONS.includes(g)) out.push(`iOS compares the reason "${g}", which the contract does not know`);
  for (const g of contract.ENDED_REASONS) if (!reasonWords.includes(g)) out.push(`previewStateText has no word for the reason "${g}"`);
  if (states.length === 0) out.push("no state literals found — does the test still read the right files?");

  // Runtimes and default.
  const lz = /static let runtimes: \[Int\?\] = \[([^\]]*)\]/.exec(all)?.[1];
  equal(lz?.split(",").map((x) => x.trim()).map((x) => (x === "nil" ? null : Number(x))), [...contract.VALID_DAYS, null], "PreviewRules.runtimes");
  equal(Number(/static let defaultDays = (\d+)/.exec(all)?.[1]), contract.VALID_DEFAULT, "PreviewRules.defaultDays");
  return out;
}

const iosTexts = () => ({ models: read(MODELS), views: VIEWS.map(read) });

test("iOS: bodies with every key (encodeNil), decoder keys, modes, states, reasons and runtimes as in contract.js", () => {
  const out = iosDeviations(iosTexts());
  assert.deepEqual(out, [], `iOS ≠ contract.js:\n${out.join("\n")}`);
});

test("iOS, counter-test: a dropped encodeNil, a renamed decoder key and a foreign literal are noticed", () => {
  const t = iosTexts();
  const withoutNil = "} else { try c.encodeNil(forKey: .validDays) }";
  assert.ok(t.models.includes(withoutNil), "the line for the sabotage is no longer in ServiceModels.swift — update");
  const a = iosDeviations({ ...t, models: t.models.replace(withoutNil, "}") });
  assert.ok(a.some((z) => z.includes("\"validDays\" is optional, but without encodeNil")), a.join("\n"));

  const key = "case createdAt, runningSinceAt, endedAt, endedReason";
  assert.ok(t.models.includes(key), "the CodingKeys row of PreviewLink no longer looks like this — update");
  const b = iosDeviations({ ...t, models: t.models.replace(key, "case createdAm, runningSinceAt, endedAt, endedReason") });
  assert.ok(b.some((z) => z.startsWith("struct PreviewLink: CodingKeys")), b.join("\n"));

  const c = iosDeviations({ ...t, views: [...t.views, 'if link.state == "paused" {}'] });
  assert.ok(c.some((z) => z.includes("\"paused\"")), c.join("\n"));

  const d = iosDeviations(t, { ...V, ENDED_REASONS: [...V.ENDED_REASONS, "locked"] });
  assert.ok(d.some((z) => z.includes("no word for the reason \"locked\"")), d.join("\n"));
});
