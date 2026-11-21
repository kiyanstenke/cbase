// Text size of the whole app (src/lib/appearance.ts): the level lives in localStorage, the init script writes its
// factor BEFORE first paint as `--cb-text-scale` on <html>, and the setter keeps storage, variable, event and shell
// notice together. Also the migration from the old chat key `cbase-chat-fs` (px) to `cbase-text-size` (level name),
// with fallback to the old key as long as the new one is missing (the old one stays for one release so that a
// rollback reads it harmlessly). Checked without a browser, with a stub `document`, because this is only about the
// contract between script, storage and variable. That the variable also TAKES EFFECT in the CSS is held by
// web/test/textScale.test.mjs.
//
// Run:  node --test web/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const source = path.join(webDir, "src", "lib", "appearance.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

function mocks() {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const vars = new Map();
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (k, v) => vars.set(k, v),
        removeProperty: (k) => vars.delete(k),
      },
    },
  };
  const events = [];
  const notices = [];
  globalThis.window = {
    dispatchEvent: (e) => { events.push(e.type); return true; },
    // The shell bridge (client): `setTextSize` sets the check mark in the "View" menu there.
    cbaseShell: { setTextSize: (s) => { notices.push(s); } },
  };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  return { storage, vars, events, notices };
}

test("text size: init script, storage, migration, variable, event and shell notice hang together", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc); appearance cannot be checked"); return; }
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".appearance-test-"));
  const { storage, vars, events, notices } = mocks();
  try {
    execFileSync(process.execPath, [
      tsc, source, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
    ], { cwd: webDir, stdio: "pipe" });
    const mod = await import(pathToFileURL(path.join(out, "appearance.js")).href);
    const {
      APPEARANCE_INIT_SCRIPT, LEGACY_CHAT_FS_KEY, TEXT_SIZE_EVENT, TEXT_SIZE_KEY, TEXT_STANDARD, TEXT_LEVELS,
      getTextSize, setTextSize, step, stageFromOldPx,
    } = mod;
    const factor = (k) => TEXT_LEVELS.find((s) => s.key === k).factor;
    const init = new Function(APPEARANCE_INIT_SCRIPT);

    // The levels: ascending, the default is one of them and has the factor 1.
    assert.equal(factor(TEXT_STANDARD), 1, "\"Normal\" is the factor 1; there the app must render identically to the old one");
    for (let i = 1; i < TEXT_LEVELS.length; i++) assert.ok(TEXT_LEVELS[i].factor > TEXT_LEVELS[i - 1].factor);

    // Init script, new key: without a value nothing, "normal" nothing, "large" the factor 17/15.5.
    init();
    assert.equal(vars.has("--cb-text-scale"), false, "without a stored value the variable stays away");
    storage.set(TEXT_SIZE_KEY, "normal");
    init();
    assert.equal(vars.has("--cb-text-scale"), false, "the default sets no variable (then the fallback 1 in the CSS applies)");
    storage.set(TEXT_SIZE_KEY, "large");
    init();
    assert.ok(Math.abs(Number(vars.get("--cb-text-scale")) - 17 / 15.5) < 1e-9, "factor of \"large\"");
    storage.set(TEXT_SIZE_KEY, "huge"); vars.clear();
    init();
    assert.equal(vars.has("--cb-text-scale"), false, "a nonsense value under the new key is ignored");
    assert.equal(getTextSize(), TEXT_STANDARD, "… and does NOT fall back to the old key");

    // Migration: without the new key the script reads the old one (px → nearest level) and WRITES nothing.
    storage.clear(); vars.clear();
    for (const [px, stage] of [["13.5", "compact"], ["14.5", "small"], ["15.5", "normal"], ["17", "large"], ["19", "veryLarge"], ["16", "normal"], ["16.5", "large"], ["12", "compact"], ["24", "veryLarge"]]) {
      assert.equal(stageFromOldPx(Number(px)), stage, `old value ${px} px`);
      storage.clear(); vars.clear();
      storage.set(LEGACY_CHAT_FS_KEY, px);
      init();
      if (stage === "normal") assert.equal(vars.has("--cb-text-scale"), false, "old value 15.5 sets nothing");
      else assert.ok(Math.abs(Number(vars.get("--cb-text-scale")) - factor(stage)) < 1e-9, `init script: old value ${px} → ${stage}`);
      assert.equal(storage.has(TEXT_SIZE_KEY), false, "the init script writes nothing");
    }
    for (const nonsense of ["99", "broken", "11"]) {
      storage.clear(); vars.clear();
      storage.set(LEGACY_CHAT_FS_KEY, nonsense);
      init();
      assert.equal(vars.has("--cb-text-scale"), false, `old nonsense value ${nonsense} is ignored`);
      assert.equal(getTextSize(), TEXT_STANDARD);
    }
    // The first getter call writes the level under the new key; the old one stays (rollback).
    storage.clear();
    storage.set(LEGACY_CHAT_FS_KEY, "17");
    assert.equal(getTextSize(), "large");
    assert.equal(storage.get(TEXT_SIZE_KEY), "large", "the getter migrates");
    assert.equal(storage.get(LEGACY_CHAT_FS_KEY), "17", "the old key stays for one release");
    // After that the new one applies, even when the old one says something else.
    storage.set(LEGACY_CHAT_FS_KEY, "13.5");
    assert.equal(getTextSize(), "large");

    // Setting: storage, variable, event, resize and shell notice.
    setTextSize("veryLarge");
    assert.equal(events.filter((e) => e === TEXT_SIZE_EVENT).length, 1, "one event per change");
    assert.equal(events.filter((e) => e === "resize").length, 1, "one resize per change (measurements outside the storage brake)");
    assert.equal(storage.get(TEXT_SIZE_KEY), "veryLarge");
    assert.ok(Math.abs(Number(vars.get("--cb-text-scale")) - 19 / 15.5) < 1e-9);
    assert.deepEqual(notices, ["veryLarge"], "the shell learns the level (check mark in the \"View\" menu)");

    // Steps: at the edge it stays put, 0 is Normal and clears the variable instead of writing "1".
    assert.equal(step(1), "veryLarge");
    assert.equal(step(-1), "large");
    assert.equal(step(0), TEXT_STANDARD);
    assert.equal(vars.has("--cb-text-scale"), false);
    assert.equal(step(-1), "small");
    assert.equal(step(-1), "compact");
    // At the edge nothing changes: then also no event, no resize (it would close every open kit menu)
    // and no notice to the shell; likewise ⌘0 at "Normal".
    const prior = { events: events.length, notices: notices.length };
    assert.equal(step(-1), "compact");
    assert.deepEqual({ events: events.length, notices: notices.length }, prior, "a step at the edge set anew");
    assert.equal(step(0), TEXT_STANDARD);
    const atNormal = events.length;
    assert.equal(step(0), TEXT_STANDARD);
    assert.equal(events.length, atNormal, "⌘0 at \"Normal\" set anew");

    // An unknown level falls back to the default; no variable with nonsense.
    setTextSize("huge");
    assert.equal(getTextSize(), TEXT_STANDARD);
    assert.equal(vars.has("--cb-text-scale"), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
