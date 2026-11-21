// German is a complete translation: every key the code asks for (web t()/tr(), server T(), iOS L()) has a German entry.
// The rules and the reading live in ./translations.mjs.
//
// COUNTER-TEST (built in): a small tree whose code asks for one key the German file lacks reports exactly that key, on
// each of the three sides; with the entry present it reports nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { web, server, ios } from "./translations.mjs";

const show = (r) => r.missing.map(([k, at]) => `${at}  ${JSON.stringify(k).slice(0, 120)}`);

test("web: no key without a German entry", () => { const r = web(); assert.ok(r.used > 4000, `only ${r.used} calls read`); assert.deepEqual(show(r), []); });
test("server: no key without a German entry", () => { const r = server(); assert.ok(r.used > 1800, `only ${r.used} calls read`); assert.deepEqual(show(r), []); });
test("iOS: no key without a German entry", () => { const r = ios(); assert.ok(r.used > 3500, `only ${r.used} calls read`); assert.deepEqual(show(r), []); });

test("counter-test: a key the German file lacks is reported on every side", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tr-"));
  const put = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  try {
    put("web/src/lib/i18n-de.ts", 'export const DE: Record<string, string> = {\n  "Known": "Bekannt",\n};\n');
    put("web/src/a.tsx", 'export const A = () => <p>{t("Known")}{t("Not there")}{tr("Also missing##ctx")}{t("—")}</p>;\n');
    put("server/backend/electron/server/i18n-de.js", 'export const DE = {\n  "Known {}": "Bekannt {0}",\n};\n');
    put("server/backend/electron/server/a.js", 'const x = 1; export const a = [T`Known ${x}`, T("Missing here"), T`Missing ${x} too`];\n');
    put("mobile/CbaseMobile/Kit/LocDEBase.swift", 'let de: [String: String] = [\n    "Known": "Bekannt",\n]\n');
    put("mobile/CbaseMobile/A.swift", 'let a = L("Known")\nlet b = L("Gone")\n');
    const keys = (r) => r.missing.map(([k]) => k);
    assert.deepEqual(keys(web(root)), ["Not there", "Also missing##ctx"]);
    assert.deepEqual(keys(server(root)), ["Missing here", "Missing {} too"]);
    assert.deepEqual(keys(ios(root)), ["Gone"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
