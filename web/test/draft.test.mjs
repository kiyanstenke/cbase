// Drafts per chat (src/lib/draft.ts): the unsent composer text lives in localStorage — key shape,
// write/read/delete, moving from the hero to the freshly created chat, and that a storage that throws does not take
// the page down. Checked without a browser against a stand-in for `localStorage`; the VIEW is checked by hand in a
// real browser (tab switch, chat switch, send).
//
// This file is the ONLY guard in the gate: `./check` runs `web/test/*.mjs`, no browser.
//
// Counter-test, cases that catch a WRONG version: "empty text removes the entry" (a naive setItem would let empty
// entries grow), "throwing storage" (without try/catch the first keystroke in private mode would break the page) and
// "moving without a source leaves the target" (an unconditional setItem(to, "") would delete a draft of the target).
//
// Run:  node --test web/test/draft.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const source = path.join(webDir, "src", "lib", "draft.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// The source is compiled to JS with the local tsc and imported — the real module text is checked, not a copy. The
// output directory lies under node_modules so that the hook's `react` import resolves (model: appearance.test.mjs).
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".draft-test-"));
execFileSync(process.execPath, [
  tsc, source, "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
], { cwd: webDir, stdio: "pipe" });

// Stand-in: a Map-backed storage that throws on every access on demand.
const storage = new Map();
let raises = false;
globalThis.localStorage = {
  getItem: (k) => { if (raises) throw new Error("QuotaExceededError"); return storage.has(k) ? storage.get(k) : null; },
  setItem: (k, v) => { if (raises) throw new Error("QuotaExceededError"); storage.set(k, String(v)); },
  removeItem: (k) => { if (raises) throw new Error("QuotaExceededError"); storage.delete(k); },
};

const mod = await import(pathToFileURL(path.join(out, "draft.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }
const { DRAFT_PREFIX, DRAFT_THROTTLE, draftKey, draftKeyNew, readDraft, writeDraft, deleteDraft, moveDraft, useDraft } = mod;

test("key shape: the app prefix, then the chat id; the hero per workspace and project", () => {
  assert.equal(DRAFT_PREFIX, "cbase-draft:");
  assert.equal(draftKey("c-1"), "cbase-draft:c-1");
  assert.equal(draftKeyNew("ws-1", null), "cbase-draft:new:ws-1:ws");
  assert.equal(draftKeyNew("ws-1", undefined), "cbase-draft:new:ws-1:ws");
  assert.equal(draftKeyNew("ws-1", "p-7"), "cbase-draft:new:ws-1:p-7");
  // Two chats never share a key (chat ids are UUIDs — "neu:…" is not one).
  assert.notEqual(draftKey("a"), draftKey("b"));
  assert.ok(DRAFT_THROTTLE >= 100 && DRAFT_THROTTLE <= 1000, "the throttle lies in a sensible range");
});

test("write, read, delete — and an empty text removes the entry", () => {
  storage.clear();
  const k = draftKey("c-1");
  writeDraft(k, "Please check the export");
  assert.equal(readDraft(k), "Please check the export");
  assert.equal(storage.get(k), "Please check the export");

  // Empty means gone. Never empty entries — storage would grow with every chat.
  writeDraft(k, "");
  assert.equal(storage.has(k), false, "empty text removes the entry");
  assert.equal(readDraft(k), "");

  writeDraft(k, "once more");
  deleteDraft(k);
  assert.equal(storage.has(k), false);
  assert.equal(readDraft(k), "");

  // Without a key (read-only view): read nothing, write nothing.
  writeDraft(null, "lost");
  assert.equal(storage.size, 0);
  assert.equal(readDraft(null), "");
  deleteDraft(null);
});

test("a storage that throws takes nothing down — the text then simply stays in the field", () => {
  storage.clear();
  const k = draftKey("c-2");
  storage.set(k, "prior");
  raises = true;
  try {
    assert.doesNotThrow(() => writeDraft(k, "fresh"));
    assert.doesNotThrow(() => deleteDraft(k));
    assert.doesNotThrow(() => moveDraft(k, draftKey("c-3")));
    assert.equal(readDraft(k), "", "reading silently falls back to empty");
  } finally {
    raises = false;
  }
  assert.equal(storage.get(k), "prior", "a throwing storage was not half-written");
});

test("moving: the hero draft moves to the new chat id, the source is empty afterwards", () => {
  storage.clear();
  const from = draftKeyNew("ws-1", null);
  const after = draftKey("c-new");
  writeDraft(from, "First task");
  moveDraft(from, after);
  assert.equal(readDraft(after), "First task");
  assert.equal(storage.has(from), false, "the source is gone");

  // Without a source the target stays as it was — an empty hero must not delete a draft.
  writeDraft(after, "stays");
  moveDraft(from, after);
  assert.equal(readDraft(after), "stays");

  // Same key: nothing happens (otherwise the source would delete the target).
  moveDraft(after, after);
  assert.equal(readDraft(after), "stays");

  // Null on one side: nothing.
  moveDraft(null, after);
  moveDraft(after, null);
  assert.equal(readDraft(after), "stays");
});

test("the hook is exported and carries the React contract (handle with flush and erase)", () => {
  // It does not run here without a React renderer; only that it exists and is a function with three parameters is
  // checked — more would be a re-implementation of React.
  assert.equal(typeof useDraft, "function");
  assert.equal(useDraft.length, 3);
});
