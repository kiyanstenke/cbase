// One base rule per class in globals.css.
//
// Why: the product rename turned two different classes into one name: the scroll strip without a scroll bar (also on the
// icon rail `#cbase-rail` in app/layout.tsx) and one row above the composer (`width: 100%`, today `cb-strip-row`) both
// became `cb-strip`. Both rules are unlayered, so the composer row's `width: 100%` beat the rail's `w-[52px]` utility:
// the rail took the whole window width and pushed the content card off screen (Coding page empty, 20.11.2026). Nothing
// failed: tsc, the tests and the rename probe (it even listed the clash in konflikte.tsv) were green.
//
// (1) Within one context (top level, or one @media/@supports/@layer block) no single bare class selector `.cb-x` heads two
//     separate rules. Grouped selectors (`.a, .b {`) and compound ones (`.a[data-x] {`) do not count; a second base rule for
//     the same class in the same context is either a merge waiting to happen or a clash like the one above.
// Counter-test built in: the old state (two `.cb-strip {` rules, one with `width: 100%`) must break (1).
//
// Run:  node --test --test-reporter=tap web/test/css-one-rule-per-class.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const globals = path.resolve(here, "..", "src", "app", "globals.css");

/** The bare single-class rules per context: "context␟.cb-x" → count. */
function baseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  const counts = new Map();
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const head = text.slice(start, i).trim();
      stack.push(head);
      if (!head.startsWith("@") && /^\.cb-[A-Za-z0-9_-]+$/.test(head)) {
        const key = `${stack.slice(0, -1).filter((h) => h.startsWith("@")).join(" › ") || "top"}␟${head}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      start = i + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    } else if (ch === ";" && stack.length === 0) {
      start = i + 1; // top-level @import/@charset
    }
  }
  return counts;
}

const twice = (css) => [...baseRules(css)].filter(([, n]) => n > 1).map(([k]) => k.replace("␟", " "));

test("(1) every class has at most one base rule per context in globals.css", () => {
  assert.deepEqual(twice(fs.readFileSync(globals, "utf8")), []);
});

test("(1) counter-test: the old cb-strip clash breaks the check", () => {
  const old = `.cb-strip { scrollbar-width: none; }\n@media (x) { .cb-strip { color: red; } }\n.cb-strip-slot { overflow: hidden; }\n.cb-strip {\n  position: relative;\n  width: 100%;\n}\n`;
  assert.deepEqual(twice(old), ["top .cb-strip"]);
  // Same class in another context, grouped or compound: allowed.
  assert.deepEqual(twice(`.cb-a { x: 1; }\n@media (y) { .cb-a { x: 2; } }\n.cb-a, .cb-b { x: 3; }\n.cb-a[data-x] { x: 4; }\n`), []);
});
