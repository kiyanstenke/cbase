// The whole app is flat (DESIGN.md, AGENTS.md "The form system"): no glass in the web CSS. Two promises, each of which would come
// back silently, because the flat rules under `.cb-flat` used to override the glass layer and so hid it:
//  (1) globals.css sets `backdrop-filter` only to `none` — no blur, no saturate — and defines none of the removed glass variables
//      (`--kit-glass*`, `--kit-veil`, `--kit-shadow`, `--cb-sheet*`, `--cb-pop`, `--cb-pop-edge`, `--cb-overlay`).
//  (2) No component under web/src carries a blur of its own: no `backdrop-blur*` utility, no inline `backdropFilter`, and no use
//      of a removed glass variable.
// Counter-tests built in: the old veil rule and the old WorkflowEditor shadow must break (1) and (2).
//
// Run:  node --test --test-reporter=tap web/test/flat-css.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globals = path.join(web, "src", "app", "globals.css");

const GLASS_VARS = /--(kit-glass[a-z-]*|kit-veil|kit-shadow|cb-sheet[a-z-]*|cb-pop(?:-edge)?|cb-overlay)(?![a-z-])/g;

/** Glass in a stylesheet: every `backdrop-filter` that is not `none`, every definition or use of a removed glass variable. */
function cssGlass(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hits = [];
  for (const m of text.matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;}]+)/g)) if (m[1].trim() !== "none") hits.push(`backdrop-filter: ${m[1].trim()}`);
  for (const m of text.matchAll(GLASS_VARS)) hits.push(`--${m[1]}`);
  return hits;
}

/** Glass in a component: a blur utility, an inline backdrop filter, a removed glass variable. */
function componentGlass(text) {
  const hits = [];
  for (const m of text.matchAll(/\bbackdrop-blur[a-z0-9-]*|\bbackdropFilter\b/g)) hits.push(m[0]);
  for (const m of text.matchAll(GLASS_VARS)) hits.push(`--${m[1]}`);
  return hits;
}

test("(1) globals.css has no backdrop blur and no glass variables", () => {
  const css = fs.readFileSync(globals, "utf8");
  assert.ok(/\.cb-kit-veil-top/.test(css) && /\.cb-overlay\s*\{/.test(css), "anchor: veil and overlay rules not found in globals.css");
  assert.deepEqual(cssGlass(css), []);
});

test("(2) no component under web/src carries a blur or a glass variable", () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) for (const h of componentGlass(fs.readFileSync(full, "utf8"))) hits.push(`${path.relative(web, full)}: ${h}`);
    }
  };
  walk(path.join(web, "src"));
  const scanned = path.join(web, "src", "components", "workflow", "WorkflowEditor.tsx");
  assert.ok(fs.existsSync(scanned), "anchor: WorkflowEditor.tsx missing — the scan would walk an empty tree");
  assert.deepEqual(hits, []);
});

test("counter-test: the old veil, the old sheet and the old node shadow break the checks", () => {
  const oldVeil = ".cb-kit-veil-top,\n.cb-kit-veil-bottom {\n  background: var(--kit-veil);\n  -webkit-backdrop-filter: blur(16px) saturate(1.3);\n  backdrop-filter: blur(16px) saturate(1.3);\n}\n";
  assert.deepEqual(cssGlass(oldVeil), ["backdrop-filter: blur(16px) saturate(1.3)", "backdrop-filter: blur(16px) saturate(1.3)", "--kit-veil"]);
  assert.deepEqual(cssGlass(":root { --cb-sheet: rgb(36 36 36 / 0.94); }\n.x { backdrop-filter: none; }\n/* --kit-glass in a comment */"), ["--cb-sheet"]);
  assert.deepEqual(componentGlass('boxShadow: `0 0 0 1px ${c}, var(--kit-shadow), inset 0 1px 0 var(--kit-glass-hi)`'), ["--kit-shadow", "--kit-glass-hi"]);
  assert.deepEqual(componentGlass('className="backdrop-blur-md" style={{ backdropFilter: "blur(4px)" }}'), ["backdrop-blur-md", "backdropFilter"]);
  // Flat names that only look alike stay green.
  assert.deepEqual(cssGlass(":root { --cb-flat-pop: #2d2d2d; --kit-row-hover: #fff; --cb-pop-in: x; }"), []);
});
