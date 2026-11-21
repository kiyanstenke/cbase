// The UI language of the backend before any client reports one: English, unless the operator sets CBASE_UI_LANG=de.
// Counter-test: with the old default ("de") the first test is red; with a setUiLang that maps every unknown value to German
// the third one is red.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const I18N = fileURLToPath(new URL("../electron/server/i18n.js", import.meta.url));
const run = (env, code) => {
  const e = { ...process.env, ...env };
  if (env.CBASE_UI_LANG === undefined) delete e.CBASE_UI_LANG;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(I18N)}); ${code}`], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("without a setting and without CBASE_UI_LANG the backend speaks English", () => {
  assert.equal(run({ CBASE_UI_LANG: undefined }, "console.log(m.getUiLang())"), "en");
});

test("CBASE_UI_LANG=de makes German the default", () => {
  assert.equal(run({ CBASE_UI_LANG: "de" }, "console.log(m.getUiLang())"), "de");
});

test("a stored setting wins, an unknown or empty one falls back to the default", () => {
  assert.equal(run({ CBASE_UI_LANG: undefined }, "m.setUiLang('de'); console.log(m.getUiLang())"), "de");
  assert.equal(run({ CBASE_UI_LANG: undefined }, "m.setUiLang(undefined); console.log(m.getUiLang())"), "en");
  assert.equal(run({ CBASE_UI_LANG: undefined }, "m.setUiLang('fr'); console.log(m.getUiLang())"), "en");
  assert.equal(run({ CBASE_UI_LANG: "de" }, "m.setUiLang('en'); console.log(m.getUiLang())"), "en");
});
