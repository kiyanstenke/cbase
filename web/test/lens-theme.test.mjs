// The cbase mark follows the theme. The source is drawn for a dark ground (light letter); on a light ground that letter vanishes, so
// tools/icon/build-icons.mjs writes two files and both clients pick by appearance:
//
// (1) Web: the mark is shown ONLY through the component CbaseLens (no `<img src="/cbase-lens…png">` of its own anywhere else in
//     web/src), the component carries both images with their classes, and globals.css hides the ink image in the dark theme and the
//     light one in the light theme — the rule line-exact.
// (2) iOS: the CbaseLens image set maps the default (any/light) appearance to lens-ink.png and the dark luminosity to lens.png.
// (3) Desktop client: client/connect.html (its only local page) carries both lenses inline, one slot each, and its
//     prefers-color-scheme block hides the ink one and shows the light one — and the generator writes that page.
// (4) The files exist where the generator writes them.
//
// Each sabotage is a copy of the source with ONE changed place (the place occurs exactly once, else the sabotage is outdated); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/lens-theme.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const COMPONENT = path.join("src", "components", "CbaseLens.tsx");
const IMAGESET = path.join(repo, "mobile", "CbaseMobile", "Assets.xcassets", "CbaseLens.imageset");
const CONNECT = path.join(repo, "client", "connect.html");
const GENERATOR = path.join(repo, "tools", "icon", "build-icons.mjs");
const RULE = ':root[data-theme="dark"] .cb-lens-on-light, :root:not([data-theme="dark"]) .cb-lens-on-dark { display: none; }';

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

function strayImages(files) {
  return Object.entries(files)
    .filter(([rel, text]) => rel !== COMPONENT && /src=\{?["'`]\/cbase-lens(-ink)?\.png/.test(text))
    .map(([rel]) => rel);
}

function checkComponent(text) {
  assert.match(text, /<img src="\/cbase-lens-ink\.png"[^>]*className=\{`cb-lens-on-light /, "the ink image is not the light-ground one");
  assert.match(text, /<img src="\/cbase-lens\.png"[^>]*className=\{`cb-lens-on-dark /, "the light image is not the dark-ground one");
}

function checkCss(text) {
  assert.ok(text.split("\n").includes(RULE), "globals.css does not hide the wrong mark per theme");
}

function checkImageset(json) {
  const images = JSON.parse(json).images;
  const plain = images.filter((i) => !i.appearances);
  const dark = images.filter((i) => (i.appearances || []).some((a) => a.appearance === "luminosity" && a.value === "dark"));
  assert.deepEqual(plain.map((i) => i.filename), ["lens-ink.png"], "the light appearance does not show the ink mark");
  assert.deepEqual(dark.map((i) => i.filename), ["lens.png"], "the dark appearance does not show the light mark");
}

function checkConnect(html) {
  for (const slot of ["mark-ink", "mark-light"]) {
    const n = (html.match(new RegExp(`<img class="mark ${slot}" alt="" src="data:image/png;base64,[A-Za-z0-9+/=]{200,}">`, "g")) || []).length;
    assert.equal(n, 1, `connect.html: slot ${slot} not filled exactly once`);
  }
  assert.equal((html.match(/<img /g) || []).length, 2, "connect.html carries another image (the old lens?)");
  assert.ok(html.includes("  .brand .mark-light { display: none; }\n"), "connect.html shows the light lens on the light card");
  const dark = html.slice(html.indexOf("@media (prefers-color-scheme: dark)"));
  assert.match(dark, /^    \.brand \.mark-ink \{ display: none; \}$/m, "connect.html shows the ink lens on the dark card");
  assert.match(dark, /^    \.brand \.mark-light \{ display: inline; \}$/m, "connect.html hides the light lens on the dark card");
}

const files = Object.fromEntries(sources(path.join(webDir, "src")).map((p) => [path.relative(webDir, p), fs.readFileSync(p, "utf8")]));
const css = read("src", "app", "globals.css");
const connect = fs.readFileSync(CONNECT, "utf8");
const imageset = fs.readFileSync(path.join(IMAGESET, "Contents.json"), "utf8");

test("web: the mark only through CbaseLens", () => {
  assert.deepEqual(strayImages(files), [], "an <img> of the mark outside CbaseLens ignores the theme");
});

test("web: the component carries both images, CSS hides the wrong one", () => {
  checkComponent(files[COMPONENT]);
  checkCss(css);
});

test("iOS: the image set picks by appearance", () => checkImageset(imageset));

test("desktop client: the connect page picks by colour scheme, the generator writes it", () => {
  checkConnect(connect);
  assert.match(fs.readFileSync(GENERATOR, "utf8"), /connect: path\.join\(REPO, "client\/connect\.html"\)/, "build-icons.mjs no longer writes connect.html");
});

test("the files exist", () => {
  for (const f of ["cbase-lens.png", "cbase-lens-ink.png"]) assert.ok(fs.existsSync(path.join(webDir, "public", f)), `public/${f} missing`);
  for (const f of ["lens.png", "lens-ink.png"]) assert.ok(fs.existsSync(path.join(IMAGESET, f)), `${f} missing in the image set`);
});

const once = (text, old, fresh) => {
  assert.equal(text.split(old).length - 1, 1, `sabotage outdated: ${JSON.stringify(old)}`);
  return text.replace(old, fresh);
};

test("counter-tests: each sabotage turns its check red", () => {
  const top = path.join("src", "components", "TopNav.tsx");
  const strayed = { ...files, [top]: once(files[top], '<CbaseLens alt="cbase" className="h-5.5 w-5.5" />', '<img src="/cbase-lens.png" alt="cbase" className="h-7 w-7" />') };
  assert.notDeepEqual(strayImages(strayed), [], "a bare <img> in TopNav went unnoticed");

  assert.throws(() => checkComponent(once(files[COMPONENT], "cb-lens-on-light ${className}", "cb-lens-on-dark ${className}")));
  assert.throws(() => checkCss(once(css, RULE, RULE.replace('.cb-lens-on-light, :root:not([data-theme="dark"]) .cb-lens-on-dark', '.cb-lens-on-dark, :root:not([data-theme="dark"]) .cb-lens-on-light'))));
  assert.throws(() => checkImageset(once(imageset, '"filename" : "lens-ink.png"', '"filename" : "lens.png"')));
  assert.throws(() => checkConnect(once(connect, "    .brand .mark-ink { display: none; }\n", "")));
  assert.throws(() => checkConnect(connect.replace(/<img class="mark mark-ink"[^>]*>/, '<img class="mark" alt="" src="data:image/png;base64,AAAA">')));
});

// (5) The brand heads the window too: in the desktop client (Electron) lens and wordmark stand right of the traffic lights, not only
//     in the browser — the placeholder for the native buttons comes FIRST, the brand after it, unconditionally. And every left
//     drawer of the iOS app starts with lens + "cbase" (`LeftDrawer` in Shell/AppShell.swift) instead of the section's name.
const SWIFT_SHELL = path.join(repo, "mobile", "CbaseMobile", "Shell", "AppShell.swift");
function brandProblems(top, swift) {
  const out = [];
  const hole = top.indexOf('<span aria-hidden className="h-9 w-[62px] shrink-0" />');
  const lens = top.indexOf('<CbaseLens alt="cbase" className="h-5.5 w-5.5" />');
  const word = top.indexOf('data-brand-wordmark>cbase</span>');
  if (hole < 0 || lens < 0 || word < 0) out.push("TopNav: placeholder, lens or wordmark missing");
  else {
    if (!(hole < lens && lens < word)) out.push("TopNav: order is not placeholder → lens → wordmark");
    const between = top.slice(hole, lens);
    if (/\)\s*:\s*\(/.test(between)) out.push("TopNav: the brand hangs on an inElectron branch — the window would lose it");
  }
  const a = swift.indexOf("struct LeftDrawer: View {");
  const drawer = a < 0 ? "" : swift.slice(a, swift.indexOf("LeftDrawerBody()", a));
  if (!drawer) out.push("iOS: LeftDrawer not found");
  else {
    if (!/CbaseLogo\(size: \d+\)\s*\n\s*Text\(verbatim: "cbase"\)/.test(drawer)) out.push("iOS: the left drawer header has no lens + \"cbase\"");
    if (/Text\(drawerTitle\)/.test(drawer)) out.push("iOS: the left drawer still shows the section title");
  }
  return out;
}

test("brand: lens and wordmark in the desktop window header and atop every left drawer on iOS", () => {
  const top = read("src", "components", "TopNav.tsx");
  const swift = fs.readFileSync(SWIFT_SHELL, "utf8");
  assert.deepEqual(brandProblems(top, swift), []);
  // Counter-tests: the old shapes turn it red.
  const once = (src, from, to) => { assert.equal(src.split(from).length, 2, `sabotage outdated: ${from}`); return src.replace(from, to); };
  const ternary = once(top, '<span aria-hidden className="h-9 w-[62px] shrink-0" />\n        )}', '<span aria-hidden className="h-9 w-[62px] shrink-0" />\n        ) : (\n        <span />\n        )}');
  assert.notDeepEqual(brandProblems(ternary, swift), [], "a brand only outside the window went unnoticed");
  const oldTitle = once(swift, 'CbaseLogo(size: 21)\n                        Text(verbatim: "cbase")', 'Text(drawerTitle)');
  assert.notDeepEqual(brandProblems(top, oldTitle), [], "the section title instead of the brand went unnoticed");
});
