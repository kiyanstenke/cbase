// Import cycles in `web/src`.
//
// The server tree has a cycle guard; `web/src` needs one too. Why cycles hurt on the web, unlike on the server: an ES module
// cycle yields `undefined` instead of the binding for one of the participants at load time. On the server you notice at
// startup; in the browser the moment depends on the bundler and the order of chunks — the error then shows up as a component
// that "sometimes" does not render.
//
// ONLY RUNTIME EDGES ARE COUNTED. `import type` / `export type` and type specifiers inside a mixed list
// (`import { type A, b }`) vanish at compile time; a cycle made only of them does not exist at runtime. The difference is
// measured: with type edges there would be an additional cycle (TopNav ↔ SettingsModal ↔ settings pages, because
// `settings/UsageKit.tsx` imports a type back) — a false alarm that cannot be resolved without duplicating types.
//
// The calculation shares its file with the server guard (`tools/check/lib/import-cycles.mjs`); what is here is only what
// concerns the language: the `@/` alias, `.js → .ts/.tsx` (Webpack resolves that via `experimental.extensionAlias` in
// next.config.ts) and the type filtering.
//
// Run:  node --test web/test/import-cycles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importCycles, cycleShort, cycleViolations } from "../../tools/check/lib/import-cycles.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const SUFFIXES = [".ts", ".tsx"];

function fileList() {
  return fs.readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => SUFFIXES.includes(path.extname(p)) && !p.split("/").includes("node_modules"))
    .sort()
    .map((p) => ({ path: p, text: fs.readFileSync(path.join(SRC, p), "utf8") }));
}

const withoutComments = (text) => text
  .split("\n").map((z) => z.replace(/\/\/.*$/, "")).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The RUNTIME import specifiers of a TS/TSX file. A pure type import is no edge.
 *
 * Three forms: `import … from "x"`, `export … from "x"`, `import("x")`. The clause text before `from` decides: if it starts
 * with `type`, the whole statement is a type; if every name in a list is preceded by `type`, likewise. A default import, a
 * namespace import or a side-effect import (`import "x"`) is always runtime.
 */
export function runtimeImports(text) {
  const body = withoutComments(text);
  const deviations = [];
  for (const m of body.matchAll(/(?:^|[\s;}])(import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const [, kind, clause, spec] = m;
    if (/^type\b/.test(clause.trim())) continue;
    const list = clause.match(/\{([\s\S]*)\}/);
    if (list && !/^[^{]*[\w*]/.test(clause.slice(0, clause.indexOf("{")))) {
      // A pure list without default/namespace before it: runtime only if ONE name stands without `type`.
      const names = list[1].split(",").map((x) => x.trim()).filter(Boolean);
      if (names.length && names.every((n) => /^type\s/.test(n))) continue;
      if (kind === "export" && !names.length) continue;
    }
    deviations.push(spec);
  }
  for (const m of body.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) deviations.push(m[1]);
  for (const m of body.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g)) deviations.push(m[1]);
  return deviations;
}

/**
 * A specifier as a path relative to `web/src` (posix), or null if it does not point there. `@/x` is `web/src/x`; a missing
 * extension and a `.js` are resolved against the real file set (Webpack does the same via `experimental.extensionAlias`).
 */
export function resolved(ofRel, spec, inSet) {
  let raw;
  if (spec.startsWith("@/")) raw = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) raw = path.posix.normalize(path.posix.join(path.posix.dirname(ofRel), spec));
  else return null;
  if (raw.startsWith("..")) return null;
  const withoutJs = raw.endsWith(".js") ? raw.slice(0, -3) : raw;
  for (const k of [raw, ...SUFFIXES.map((e) => withoutJs + e), ...SUFFIXES.map((e) => `${withoutJs}/index${e}`)]) {
    if (inSet.has(k)) return k;
  }
  return null;
}

const webCycles = (files) => importCycles(files, (f, inSet) =>
  runtimeImports(f.text).map((spec) => resolved(f.path, spec, inSet)).filter(Boolean));

// ── The inventory, named ─────────────────────────────────────────────────────────────────────
//
// EMPTY: both web cycles are gone. A new cycle needs an entry again, with a reason and a follow-up job.
const CYCLES_ALLOWED = [];

test("Cycle freedom in web/src: Tarjan over the RUNTIME edges — every cycle named, every entry with a cycle", () => {
  const files = fileList();
  assert.ok(files.length > 100, `only ${files.length} files under web/src — does the reader still work?`);
  const cycles = webCycles(files);
  for (const e of CYCLES_ALLOWED) {
    console.log(`  [web-cycles] allowed ${cycleShort(e.files)}: ${e.files.join(", ")} — ${e.reason} FOLLOW-UP JOB: ${e.followUpJob}`);
  }
  console.log(`  [web-cycles] measured: ${cycles.length} cycle(s) over ${cycles.reduce((n, k) => n + k.length, 0)} of ${files.length} files`);
  const violations = cycleViolations(cycles, CYCLES_ALLOWED);
  assert.deepEqual(violations, [], `cycle freedom (web/src) violated:\n  ${violations.join("\n  ")}`);
});

// The type filtering is no subtlety but the difference between two and three cycles — and it only shows in a real case.
// TopNav → SettingsModal → UsageSettings → … → TopNav is NOT a cycle at runtime, because the closing edge is `import type`.
// The closing edge is `settings/UsageKit.tsx` (`CodexState.ring` is the header's `RingWindow`): TopNav → SettingsModal →
// UsageSettings → UsageKit ⇢ TopNav.
test("Type edges are no edges: the TopNav/settings cycle is no cycle at runtime", () => {
  const files = fileList();
  const inSet = new Set(files.map((f) => f.path));
  const kit = files.find((f) => f.path === "components/settings/UsageKit.tsx");
  assert.ok(kit, "UsageKit.tsx not found — update the anchor");
  assert.match(kit.text, /import type \{[^}]*\} from "@\/components\/TopNav"/,
    "the closing edge is no longer an `import type` — then the cycle belongs in the list or must be resolved");
  assert.ok(!runtimeImports(kit.text).some((s) => s.includes("TopNav")),
    "the type edge is counted as a runtime edge — the guard reported a cycle that does not exist");
  // With type edges the triple would be there: the same calculation, just without the filter.
  const withTypes = importCycles(files, (f) => [...f.text.matchAll(/from\s*["']([^"']+)["']/g)]
    .map((m) => resolved(f.path, m[1], inSet)).filter(Boolean));
  assert.ok(withTypes.length > webCycles(files).length,
    "without the type filter there would have to be MORE cycles — otherwise the filter measures nothing");
});

// The split rule: under `components/` imports go only via `@/components/…`, never via `./X`. Today 0 hits — pure discipline
// until it stands here.
test("components/: no more `./X` import (split rule)", () => {
  const hits = fileList()
    .filter((f) => f.path.startsWith("components/"))
    .flatMap((f) => [...withoutComments(f.text).matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((m) => `${f.path} → ${m[1]}`));
  assert.deepEqual(hits, [], `relative sibling imports under components/:\n  ${hits.join("\n  ")}`);
});
