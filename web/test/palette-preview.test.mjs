// The preview of the command palette in the editor (components/code/palette-preview.ts) — EXECUTED against real CodeMirror states (no DOM:
// the computation only needs `view.state`).
//
// The promise: as long as the go-to-line or go-to-symbol palette is open, the editor highlights the target — in the SECOND file of the same
// view too. The buffer editor switches files via `setState`: a new state without the highlight field, same view. A memory kept per VIEW
// (WeakSet) would never bring the field back in the second file, `showPreview` would go nowhere and the highlight would be missing.
// `previewExtension` therefore asks only the state.
//
// COUNTER-TEST BUILT IN: the sabotage (the old memory per view) sits next to it as a copy of the source with ONE changed spot and must
// fail the check.
//
// Run:  node --test --test-reporter=tap web/test/palette-preview.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = fs.readFileSync(path.join(webDir, "src", "components", "code", "palette-preview.ts"), "utf8");
const SABOTAGE = {
  old: "  return view.state.field(field, false) === undefined ? [field] : [];",
  fresh: "  const g = ((globalThis as { __seen?: WeakSet<object> }).__seen ??= new WeakSet<object>());\n  if (g.has(view)) return [];\n  g.add(view);\n  return view.state.field(field, false) === undefined ? [field] : [];",
};

// Compile the module and the sabotage in ONE tsc run; the temp folder gets a link to web/node_modules (for tsc and loading — Node
// follows it to the real path, so module and check share the same @codemirror/state).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-palette-preview-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out"), reference = path.join(tmp, "node_modules");
fs.mkdirSync(src, { recursive: true });
fs.symlinkSync(path.join(webDir, "node_modules"), reference, "dir");
fs.writeFileSync(path.join(src, "palette-preview.ts"), SOURCE);
fs.writeFileSync(path.join(src, "palette-preview-sabotage.ts"), SOURCE.replace(SABOTAGE.old, () => SABOTAGE.fresh));
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  throw new Error(`tsc: ${String(e.stdout || "")}${String(e.stderr || "")}`.slice(0, 4000));
}
const real = await import(pathToFileURL(path.join(out, "palette-preview.js")).href);
const sabotaged = await import(pathToFileURL(path.join(out, "palette-preview-sabotage.js")).href);
const { EditorState, StateEffect } = await import(pathToFileURL(path.join(webDir, "node_modules", "@codemirror", "state", "dist", "index.js")).href);
try {
  fs.unlinkSync(reference); // remove the link first — never delete into web/node_modules
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

/** A view as the buffer editor uses it: ONE object whose state is replaced on a file switch (`setState`), and the field arrives via
 *  `appendConfig` as in `showPreview`. */
function check(M) {
  const view = { state: EditorState.create({ doc: "one\ntwo\n" }) };
  const dispatch = (extra) => { view.state = view.state.update({ effects: extra.length ? [StateEffect.appendConfig.of(extra)] : [] }).state; };
  const first = M.previewExtension(view);
  assert.equal(first.length, 1, "the first file gets the field");
  dispatch(first);
  assert.deepEqual(M.previewExtension(view), [], "with the field in the state it does not come twice");
  // The second file: same editor, a new state (setState) — the field is missing again and must come again.
  view.state = EditorState.create({ doc: "three\n" });
  assert.equal(M.previewExtension(view).length, 1, "the second file of the same view does not get the field (the highlight is missing)");
}

test("preview: the highlight field hangs on the state, not on the view — the second file is highlighted too", () => {
  check(real);
});

test("counter-test: the memory per view (the old behavior) is caught", () => {
  assert.equal(SOURCE.split(SABOTAGE.old).length - 1, 1, "the sabotage spot does not appear exactly once in the source");
  assert.throws(() => check(sabotaged), /second file/);
});
