// Following links and color squares like VS Code.
//
// (1) lib/link-follow-ups.ts, EXECUTED: a file opens, a folder only relative and without `..`, a web address only with http/https/mailto
//     (a foreign scheme would be a program launch, as in the chat); anything unknown nothing.
// (2) lib/color-square.ts, EXECUTED: `rgba(r, g, b, a)` like VS Code (channels ×255 rounded, alpha to three places, clamped), cap 500
//     (`editor.colorDecoratorsLimit`), re-ask after 1,000 ms (`ColorDetector.RECOMPUTE_TIME`).
// (3) The wiring (read): ⌘-click follows the link when there is no definition (also in a file whose server only knows links), F12 does not
//     (VS Code: "No definition found."); the link goes only through `linkWay`; a web address into a new tab without opener; a folder via
//     the connection into the explorer (CodePane `showInExplorer`, converted into the editor's coordinates); ⌘-hover underlines a link
//     only if it leads somewhere; the color squares hang on every editor with a language, ask only with `document_color`, with the
//     dimensions from colorPicker.css.
//
// Each sabotage changes exactly ONE place (otherwise it is stale) and must be caught.
//
// Run:  node --test --test-reporter=tap web/test/link-colors.test.mjs
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
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const SHEETS = { link: read("src", "lib", "link-follow-ups.ts"), color: read("src", "lib", "color-square.ts") };
const SAB_COMPUTATION = {
  link: {
    "folder absolute": { old: `if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;`, fresh: `if (!p || p.split("/").includes("..")) return null;` },
    "folder with ..": { old: `if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;`, fresh: `if (!p || p.startsWith("/")) return null;` },
    "any scheme": { old: `if (typeof z.url !== "string" || !WEB.test(z.url)) return null;`, fresh: `if (typeof z.url !== "string") return null;` },
    "file without path": { old: `return z.location && typeof z.location.file === "string" && z.location.file ? { kind: "file", location: z.location } : null;`, fresh: `return { kind: "file", location: z.location };` },
    "without mailto": { old: "const WEB = /^(https?:|mailto:)/i;", fresh: "const WEB = /^(https?:)/i;" },
  },
  color: {
    "channel truncated": { old: "Math.round(clamp(Number(x) || 0, 0, 1) * 255)", fresh: "Math.floor(clamp(Number(x) || 0, 0, 1) * 255)" },
    "without clamp": { old: "Math.round(clamp(Number(x) || 0, 0, 1) * 255)", fresh: "Math.round((Number(x) || 0) * 255)" },
    "alpha unrounded": { old: "places3(clamp(Number(c.alpha) || 0, 0, 1))", fresh: "clamp(Number(c.alpha) || 0, 0, 1)" },
    "without cap": { old: "colors.slice(0, COLOR_CAP)", fresh: "colors.slice(0)" },
    "cap wrong": { old: "export const COLOR_CAP = 500;", fresh: "export const COLOR_CAP = 50;" },
    "quiet period wrong": { old: "export const COLOR_NEW_MS = 1000;", fresh: "export const COLOR_NEW_MS = 300;" },
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-link-colors-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
const copies = [];
for (const [sheet, source] of Object.entries(SHEETS)) {
  fs.writeFileSync(path.join(src, `${sheet}.ts`), source);
  for (const [name, s] of Object.entries(SAB_COMPUTATION[sheet])) {
    const file = `${sheet}-sabotage-${copies.length}.ts`;
    fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
    copies.push({ sheet, name, file, places: source.split(s.old).length - 1 });
  }
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "link.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = { link: await load("link.ts"), color: await load("color.ts") };
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* irrelevant */ }

const R = { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } };
function linkComputation(M) {
  const { linkWay } = M;
  assert.deepEqual(linkWay({ kind: "file", location: { file: "docs/b.md", range: R } }), { kind: "file", location: { file: "docs/b.md", range: R } });
  const outside = { file: "/x/secret.md", range: R, external: { token: "t" } };
  assert.deepEqual(linkWay({ kind: "file", location: outside }), { kind: "file", location: outside }, "outside with token opens (read-only)");
  assert.equal(linkWay({ kind: "file", location: { file: "", range: R } }), null);
  assert.deepEqual(linkWay({ kind: "folder", file: "docs" }), { kind: "folder", path: "docs" });
  assert.equal(linkWay({ kind: "folder", file: "/etc" }), null, "an absolute folder is in no tree");
  assert.equal(linkWay({ kind: "folder", file: "docs/../.." }), null);
  assert.deepEqual(linkWay({ kind: "web", url: "https://example.com/a?b=1" }), { kind: "web", url: "https://example.com/a?b=1" });
  assert.deepEqual(linkWay({ kind: "web", url: "mailto:a@example.com" }), { kind: "web", url: "mailto:a@example.com" });
  for (const u of ["smb://host/x", "javascript:alert(1)", "file:///etc/passwd", "vscode://x"]) assert.equal(linkWay({ kind: "web", url: u }), null, u);
  assert.equal(linkWay(null), null);
  assert.equal(linkWay({ kind: "other" }), null);
}
function colorComputation(M) {
  const { colorCss, colorSquares, COLOR_CAP, COLOR_NEW_MS } = M;
  assert.equal(colorCss({ red: 1, green: 0, blue: 0, alpha: 1 }), "rgba(255, 0, 0, 1)");
  assert.equal(colorCss({ red: 0.5, green: 0.2, blue: 0.6, alpha: 0.12345 }), "rgba(128, 51, 153, 0.123)", "×255 rounded, alpha three places");
  assert.equal(colorCss({ red: 2, green: -1, blue: 0, alpha: 3 }), "rgba(255, 0, 0, 1)", "clamped");
  assert.equal(COLOR_CAP, 500, "VS Code editor.colorDecoratorsLimit");
  assert.equal(COLOR_NEW_MS, 1000, "VS Code ColorDetector.RECOMPUTE_TIME");
  const many = Array.from({ length: 520 }, (_, i) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } }, color: { red: 0, green: 0, blue: 1, alpha: 1 } }));
  const q = colorSquares(many);
  assert.equal(q.length, 500);
  assert.deepEqual(q[3], { start: { line: 3, character: 0 }, css: "rgba(0, 0, 255, 1)" });
}

test("(1)+(2) computations executed: link-follow-ups and color-square — and every sabotage is caught", () => {
  linkComputation(real.link);
  colorComputation(real.color);
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.sheet}: ${k.name}`), [], "sabotages whose spot does not occur exactly once");
  const through = sabotaged.filter((k) => { try { (k.sheet === "link" ? linkComputation : colorComputation)(k.M); return true; } catch { return false; } }).map((k) => `${k.sheet}: ${k.name}`);
  assert.deepEqual(through, [], "sabotages that are not caught");
});

const Q = {
  nav: read("src", "components", "code", "lsp-navigation.ts"),
  cmd: read("src", "components", "code", "cmd-hover.ts"),
  colors: read("src", "components", "code", "lsp-colors.ts"),
  extension: read("src", "components", "code", "lsp-extension.ts"),
  connection: read("src", "components", "code", "navigation-connection.tsx"),
  core: read("src", "components", "code", "lsp-nav-core.ts"),
  pane: read("src", "components", "CodePane.tsx"),
};
const has = (text, chunk, what) => assert.ok(withoutComments(text).includes(chunk), what);
function wiring(q) {
  // ⌘-click: definition, otherwise link; also without the definition capability if there are links. F12 without link.
  has(q.nav, `if (pos == null || !(can(d, "definition") || can(d, "document_link"))) return false;`, "⌘-click only with definition — a file with only links stays dead");
  has(q.nav, `void goTo({ view, file: d }, "definition", false, true);`, "⌘-click follows no link");
  has(q.nav, `"editor.action.revealDefinition": (k) => goTo(k, "definition", false),`, "F12 follows a link (VS Code: no definition)");
  has(q.nav, `if (w.kind === "none" && withLink && (await followUpLink(view, d, pos))) return;`, "no link without definition");
  has(q.nav, `const way = linkWay(r.link?.target);`, "the link does not go through linkWay");
  has(q.nav, `window.open(way.url, "_blank", "noopener,noreferrer");`, "web address not in a new tab without opener");
  has(q.nav, `if (way.kind === "folder") return Boolean(n.connection?.showFolder?.(d.buffer.target, way.path));`, "folder not into the explorer");
  has(q.nav, `if (way.kind === "file") return openLocation(view, way.location);`, "file link does not open");
  // The connection converts the folder into the view, CodePane shows it in the explorer.
  has(q.connection, `const path = inView(run.current.coordinates, target, path0);`, "folder not converted");
  has(q.connection, `f(path);`, "folder not passed on");
  has(q.pane, `showFolder: (p) => showInExplorer(p)`, "CodePane gives no way into the explorer");
  has(q.core, `showFolder?(target: BufferTarget, path: string): boolean;`, "NavConnection without showFolder");
  // ⌘-hover: only a link that leads somewhere is underlined.
  has(q.cmd, `if (abort.signal.aborted || isNotSupported(r) || !r.link || !linkWay(r.link.target)) return null;`, "⌘-hover underlines a link that ⌘-click does not follow");
  // Colors: on every editor with a language, only with the capability, dimensions like VS Code.
  has(q.extension, `outlineExtension, stickyScroll, lspColors,`, "color squares not in the editor");
  has(q.colors, `if (!can(d, "document_color")) {`, "colors asked without capability");
  has(q.colors, `this.running?.abort();\n    this.plane(COLOR_NEW_MS);`, "after a change not re-asked with the VS Code quiet period");
  has(q.colors, `b.add(q.at, q.at, Decoration.widget({ widget: new ColorSquare(q.css), side: -1 }));`, "square not BEFORE the value");
  has(q.colors, `border: "solid .1em #000", boxSizing: "border-box", margin: ".1em .2em 0", width: ".8em", height: ".8em", lineHeight: ".8em",`, "dimensions not from colorPicker.css");
  has(q.colors, `"&dark .cm-color-square": { borderColor: "#eee" },`, "border in dark not #eee");
}

const SAB_SOURCES = [
  ["nav", "definition only", `if (pos == null || !(can(d, "definition") || can(d, "document_link"))) return false;`, `if (pos == null || !can(d, "definition")) return false;`],
  ["nav", "⌘-click without link", `void goTo({ view, file: d }, "definition", false, true);`, `void goTo({ view, file: d }, "definition", false);`],
  ["nav", "F12 with link", `"editor.action.revealDefinition": (k) => goTo(k, "definition", false),`, `"editor.action.revealDefinition": (k) => goTo(k, "definition", false, true),`],
  ["nav", "link never followed", `if (w.kind === "none" && withLink && (await followUpLink(view, d, pos))) return;`, ``],
  ["nav", "without linkWay", `const way = linkWay(r.link?.target);`, `const way = r.link?.target as never;`],
  ["nav", "web with opener", `window.open(way.url, "_blank", "noopener,noreferrer");`, `window.open(way.url, "_blank");`],
  ["nav", "folder dead", `if (way.kind === "folder") return Boolean(n.connection?.showFolder?.(d.buffer.target, way.path));`, `if (way.kind === "folder") return false;`],
  ["connection", "folder without conversion", `const path = inView(run.current.coordinates, target, path0);`, `const path = path0;`],
  ["pane", "CodePane without explorer", `showFolder: (p) => showInExplorer(p)`, `showFolder: undefined`],
  ["cmd", "hover link without way", `|| !linkWay(r.link.target)) return null;`, `) return null;`],
  ["extension", "colors missing", `outlineExtension, stickyScroll, lspColors,`, `outlineExtension, stickyScroll,`],
  ["colors", "without capability", `if (!can(d, "document_color")) {`, `if (!d) {`],
  ["colors", "quiet period immediate", `this.running?.abort();\n    this.plane(COLOR_NEW_MS);`, `this.running?.abort();\n    this.plane(0);`],
  ["colors", "square behind", `widget: new ColorSquare(q.css), side: -1 }`, `widget: new ColorSquare(q.css), side: 1 }`],
  ["colors", "dimensions wrong", `width: ".8em", height: ".8em"`, `width: "10px", height: "10px"`],
  ["colors", "border dark", `"&dark .cm-color-square": { borderColor: "#eee" },`, ``],
];

test("(3) wiring: ⌘-click/F12, link ways, explorer, ⌘-hover, color squares — with counter-tests", () => {
  wiring(Q);
  const wrong = [], through = [];
  for (const [file, name, old, fresh] of SAB_SOURCES) {
    if (Q[file].split(old).length - 1 !== 1) { wrong.push(name); continue; }
    try { wiring({ ...Q, [file]: Q[file].replace(old, fresh) }); through.push(name); } catch { /* caught */ }
  }
  assert.deepEqual(wrong, [], "sabotages whose spot does not occur exactly once");
  assert.deepEqual(through, [], "sabotages that are not caught");
});
