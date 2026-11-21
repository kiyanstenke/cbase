// The editor's gutter covers like VS Code (`editorGutter.background` = `editor.background`).
//
// Symptom: the gutter (line numbers, fold and git margin) stuck to the edge but was transparent — text ran visibly through
// the numbers when scrolled horizontally.
//
// (1) The calculation `opacity` RUN (pulled from the source, no DOM) and `backgroundUnder` with a rebuilt parent chain.
// (2) The sources: the theme attaches `gutterCovers`; the plugin measures the background under the editor and writes it to
//     `.cm-gutters`, on mount, on changed dimensions and on reconfiguration; Sticky Scroll takes the SAME calculation (no
//     second version).
// Each sabotage changes ONE spot and must break a check.
//
// Run:  node --test --test-reporter=tap web/test/gutter-background.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = path.resolve(here, "..", "src", "components", "code");
const read = (d) => fs.readFileSync(path.join(code, d), "utf8");
const Q = { gutter: read("gutter-background.ts"), theme: read("codeTheme.ts"), sticky: read("sticky-scroll.ts") };

/** The two calculations from the source, as functions (types stripped); `getComputedStyle` is passed in. */
function computations(source, getComputedStyle) {
  const chunk = (name) => {
    const a = source.indexOf(`export function ${name}(`);
    const b = source.indexOf("\n}\n", a);
    assert.ok(a >= 0 && b > a, `${name} is missing`);
    return source.slice(a + "export ".length, b + 2).replace(/\(c: string\): number/, "(c)").replace(/\(el: HTMLElement \| null\): string/, "(el)");
  };
  // eslint-disable-next-line no-new-func
  return new Function("getComputedStyle", `${chunk("opacity")}\n${chunk("backgroundUnder")}\nreturn { opacity, backgroundUnder };`)(getComputedStyle);
}

const CHECKS = {
  computation(q) {
    const chain = (colors) => { let e = null; for (const f of colors.slice().reverse()) e = { f, parentElement: e }; return e; };
    const R = computations(q.gutter, (e) => ({ backgroundColor: e.f }));
    assert.equal(R.opacity("transparent"), 0);
    assert.equal(R.opacity("rgba(0, 0, 0, 0)"), 0);
    assert.equal(R.opacity("rgb(24, 24, 24)"), 1);
    assert.equal(R.opacity("color(srgb 0.1 0.1 0.1 / 0.5)"), 0.5);
    assert.equal(R.backgroundUnder(chain(["rgba(0, 0, 0, 0)", "rgba(10, 10, 10, 0.5)", "rgb(24, 24, 24)", "rgb(1, 1, 1)"])), "rgb(24, 24, 24)", "the first OPAQUE background");
    assert.equal(R.backgroundUnder(chain(["transparent"])), "var(--color-panel)", "without an opaque background the panel");
  },
  sources(q) {
    assert.match(q.theme, /import \{ gutterCovers \} from "@\/components\/code\/gutter-background";/, "the theme does not import gutterCovers");
    const list = q.theme.slice(q.theme.indexOf("export const codeTheme: Extension = ["), q.theme.indexOf("];", q.theme.indexOf("export const codeTheme: Extension = [")));
    assert.match(list, /\n {2}gutterCovers,\n/, "the theme does not attach gutterCovers");
    assert.ok(q.gutter.includes("read: (v) => backgroundUnder(v.dom.parentElement),"), "what is measured is not the background UNDER the editor");
    assert.ok(q.gutter.includes("gutter.style.backgroundColor = background;"), "the gutter does not get the background");
    assert.ok(q.gutter.includes(`v.dom.querySelector<HTMLElement>(".cm-gutters")`), "it is not written to the gutter");
    assert.ok(q.gutter.includes("constructor(readonly view: EditorView) { this.measure(); }"), "not measured on mount");
    assert.ok(q.gutter.includes("if (u.geometryChanged || u.transactions.some((tr) => tr.reconfigured)) this.measure();"), "dimensions or theme do not change the gutter");
    assert.ok(q.sticky.includes(`import { backgroundUnder } from "@/components/code/gutter-background";`), "Sticky Scroll does not take the calculation from gutter-background.ts");
    assert.ok(!/function (backgroundUnder|opacity)\(/.test(q.sticky), "Sticky Scroll carries a second version of the calculation");
  },
};

const SABOTAGES = {
  "first background instead of first opaque": { field: "gutter", old: "if (opacity(c) > 0.98) return c;", fresh: "return c;", catches: "computation" },
  "rgba without opacity": { field: "gutter", old: "Number(rgba[1].split(\",\")[3] ?? 1)", fresh: "1", catches: "computation" },
  "theme without gutter": { field: "theme", old: "\n  gutterCovers,\n", fresh: "\n", catches: "sources" },
  "the editor's own background": { field: "gutter", old: "read: (v) => backgroundUnder(v.dom.parentElement),", fresh: "read: (v) => backgroundUnder(v.dom),", catches: "sources" },
  "never written": { field: "gutter", old: "gutter.style.backgroundColor = background;", fresh: "", catches: "sources" },
  "theme does not follow": { field: "gutter", old: " || u.transactions.some((tr) => tr.reconfigured)", fresh: "", catches: "sources" },
  "second version in sticky": { field: "sticky", old: `import { backgroundUnder } from "@/components/code/gutter-background";\n`, fresh: `function backgroundUnder(el: HTMLElement | null): string { return ""; }\n`, catches: "sources" },
};

test("(1)(2) The gutter covers like VS Code — calculation and sources (with counter-tests)", () => {
  for (const [k, p] of Object.entries(CHECKS)) {
    try { p(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const notCaught = [];
  for (const [name, s] of Object.entries(SABOTAGES)) {
    assert.equal(Q[s.field].split(s.old).length, 2, `sabotage “${name}”: spot not there exactly once`);
    let caught = false;
    try { CHECKS[s.catches]({ ...Q, [s.field]: Q[s.field].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [gutter-background] ${Object.keys(SABOTAGES).length} sabotages, each caught`);
});
