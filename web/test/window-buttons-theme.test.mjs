// The web UI reports its CHOSEN mode to the Electron shell, and the header draws the window buttons only for a shell that cannot
// do that.
//
// Why: the native window buttons were never gone in an unfocused window, only invisible — a DarkAqua fill (system dark,
// `nativeTheme.themeSource` unset) on a light page, contrast 1.00. If the shell sets `themeSource` to the page's mode they look
// like in any other app, and the redrawing in TopNav.tsx falls away. Two promises hang on this, and both fail silently:
//  (1) The CHOSEN mode is reported — "system" stays "system". `themeSource` shifts `prefers-color-scheme` in the renderer; whoever
//      reported the resolved theme would pin matchMedia, and the "System" mode would never follow the operating system again. No
//      type error, no red line — just an app that looks wrong after the next appearance change. And it is reported on EVERY path
//      that sets data-theme (start, switching, init script) — a path without a report would leave the shell on the old mode.
//  (2) The header draws exactly when the bridge is there and `setTheme` is missing. If it also drew with a new shell, drawn buttons
//      would lie OVER the native ones, which stay there; if it no longer drew with an old one, nothing would be top left without
//      focus (the old shell hides the native ones on focus loss).
//
// Setup: lib/theme.ts (with lib/shell-bridge.ts) is compiled with tsc and run against stubs of `window`, `document` and
// `localStorage`; ThemeToggle.tsx, TopNav.tsx and the rest of web/src are read BY PATH — without comments, through TypeScript's
// parser (a comment describing a rule is not code obeying it). Plus the seam to the shell: client/preload.cjs exposes `setTheme`
// on `cbaseShell` and sends on `cbase:theme`.
//
// Counter-tests: applyMode reports `resolveMode(mode)` instead of `mode` ⇒ "CHOSEN mode", "switching", "start", "every path" red;
// the report removed from applyMode ⇒ the same four; ThemeToggle sets data-theme itself on mount instead of via applyMode ⇒ "start"
// and "every path" red; the matchMedia listener not registered ⇒ "start" red; TopNav again `{inElectron && <WindowButtons />}` ⇒
// "TopNav … no second path" red; TopNav reads `cbaseShell` itself ⇒ the same and "cbaseShell reads only the sheet" red; the switch as
// `return !!s` ⇒ "drawsWindowButtons" red; the init script without a report ⇒ "init script" red; a second data-theme writer in
// AppearanceSettings.tsx ⇒ "every path" red; the placeholder `w-[54px]` (ends at 74 < 76) ⇒ "placeholder" red. The shell files
// belong to another strand and were sabotaged only in a MIRROR: `setThemeMode` instead of `setTheme` in client/preload.cjs ⇒ "seam"
// red; `THEME_MODES` without "system" in client/main.js ⇒ "seam: the modes" red; `x: 24` in client/main.js ⇒ "placeholder" red.
// (A fourth mode only in the web already fails at compile time: resolveMode would return it as a ResolvedTheme — tsc, here as in
// the gate.)

// Run:  node --test web/test/window-buttons-theme.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const ts = createRequire(path.join(webDir, "package.json"))("typescript");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

// theme.ts imports react — the output must find it, so it goes under web/node_modules (like appearance.test.mjs). tsc follows
// the import `./shell-bridge.js` and compiles the sheet too.
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".window-buttons-theme-test-"));
let theme, bridge;
try {
  execFileSync(process.execPath, [
    tsc, path.join(src, "lib", "theme.ts"), "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
  ], { cwd: webDir, stdio: "pipe" });
  theme = await import(pathToFileURL(path.join(out, "theme.js")).href);
  bridge = await import(pathToFileURL(path.join(out, "shell-bridge.js")).href);
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
}
const { applyMode, getStoredMode, resolveMode, setThemeMode, THEME_INIT_SCRIPT } = theme;
const { reportThemeMode, shellBridge, drawsWindowButtons } = bridge;

// Stubs: localStorage, <html data-theme>, matchMedia (dark or light) and — per case — a bridge that records every report.
// `shell: null` means: no `cbaseShell` (browser).
const KEY = "cbase-theme";
function world({ saved = null, dark = false, shell = "fresh" } = {}) {
  const storage = new Map();
  if (saved !== null) storage.set(KEY, saved);
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const html = { dataset: {} };
  globalThis.document = { documentElement: html };
  const notices = [];
  const windowActions = { windowClose() {}, windowMinimize() {}, windowZoom() {} };
  const bridgePerSide = {
    fresh: { ...windowActions, setTheme: (m) => { notices.push(m); } },
    old: { ...windowActions },
    raises: { ...windowActions, setTheme: () => { throw new Error("bridge broken"); } },
  };
  globalThis.window = {
    matchMedia: (q) => ({ matches: q === "(prefers-color-scheme: dark)" ? dark : false }),
    ...(shell ? { cbaseShell: bridgePerSide[shell] } : {}),
  };
  return { storage, html, notices };
}

// Comments removed, strings and JSX text stay — via the parser, not a regex: a `https://` in a string or a `{/* … */}` over
// several JSX lines would otherwise swallow code. Comments are trivia BEFORE a token; `getTrailingCommentRanges` yields those up
// to the first line end, `getLeadingCommentRanges` those after it — only both together are all. JSX text and the middle/tail
// parts of a template string have no trivia (their text would otherwise start with "//"), and JSDoc nodes are not descended into
// (the whole block is already a comment).
const WITHOUT_TRIVIA = new Set([ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
function withoutComments(text, file = "x.tsx") {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const areas = new Map();
  const visits = (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = n.getChildren(sf);
    if (children.length) { for (const k of children) visits(k); return; }
    if (WITHOUT_TRIVIA.has(n.kind)) return;
    const pos = n.getFullStart();
    for (const c of [...(ts.getTrailingCommentRanges(text, pos) ?? []), ...(ts.getLeadingCommentRanges(text, pos) ?? [])]) {
      areas.set(c.pos, c.end);
    }
  };
  visits(sf);
  let t = text;
  for (const [from, until] of [...areas].sort((x, y) => y[0] - x[0])) t = t.slice(0, from) + " ".repeat(until - from) + t.slice(until);
  return t;
}
const code = (rel) => withoutComments(read(rel), rel);

function webFiles() {
  return fs.readdirSync(src, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.split("/").includes("node_modules"))
    .sort();
}

// The body of an `export function name(…) { … }` — an anchor that throws instead of returning empty.
function body(text, name, file) {
  const m = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(text);
  assert.ok(m, `anchor: "export function ${name}(…)" not found in ${file} — update the anchor, do not delete the test`);
  return m[1];
}

// ── (1) The report ───────────────────────────────────────────────────────────────────────────────

test("applyMode reports the CHOSEN mode to the shell — \"system\" stays \"system\", even with a dark system", () => {
  for (const dark of [false, true]) {
    for (const mode of ["light", "dark", "system"]) {
      const { html, notices } = world({ dark });
      applyMode(mode);
      const expectedTheme = mode === "system" ? (dark ? "dark" : "light") : mode;
      assert.equal(html.dataset.theme, expectedTheme, `data-theme for ${mode} (system ${dark ? "dark" : "light"})`);
      assert.deepEqual(notices, [mode],
        `"${mode}" is reported, not the resolved "${expectedTheme}" — else themeSource pins matchMedia`);
    }
  }
});

test("switching: setThemeMode stores, sets data-theme and reports — exactly one report per change", () => {
  const { storage, html, notices } = world({ dark: true });
  const followUp = ["light", "dark", "system", "light", "system"];
  for (const m of followUp) {
    setThemeMode(m);
    assert.equal(storage.get(KEY), m);
    assert.equal(html.dataset.theme, m === "system" ? "dark" : m);
  }
  assert.deepEqual(notices, followUp);
});

test("start: ThemeToggle's mount path reports the stored mode — unknown as \"system\"", () => {
  // The path itself, in the source: ThemeToggle applies `applyMode(getStoredMode())` after mount (in an effect with an empty
  // dependency list), and the matchMedia listener recomputes in "system" mode — both belong to the promise: after a report
  // matchMedia flips only 10–19 ms LATER (measured, Electron 37 and 44), and only this listener then pulls data-theme along.
  const toggle = code("src/components/ThemeToggle.tsx");
  assert.match(toggle, /useEffect\(\s*\(\)\s*=>\s*\{\s*applyMode\(\s*getStoredMode\(\)\s*\);?\s*\},\s*\[\]\s*\)/,
    "ThemeToggle.tsx: the mount effect `applyMode(getStoredMode())` with `[]` is missing — then the start reports nothing");
  assert.match(toggle, /matchMedia\(\s*"\(prefers-color-scheme: dark\)"\s*\)/, "ThemeToggle.tsx: the matchMedia listener is missing");
  assert.match(toggle, /addEventListener\(\s*"change"/, "ThemeToggle.tsx: the listener is not attached to \"change\"");
  assert.match(toggle, /if\s*\(\s*getStoredMode\(\)\s*===\s*"system"\s*\)\s*applyMode\(\s*"system"\s*\)/,
    "ThemeToggle.tsx: the listener does not recompute in \"system\" mode — the switch light → system would stay light");
  // And executed: every stored value.
  for (const [saved, expected] of [[null, "system"], ["light", "light"], ["dark", "dark"], ["system", "system"], ["broken", "system"]]) {
    const { notices } = world({ saved, dark: true });
    applyMode(getStoredMode());
    assert.deepEqual(notices, [expected], `stored ${JSON.stringify(saved)} ⇒ reported "${expected}"`);
  }
});

test("init script: reports before the first paint the same as getStoredMode, AFTER data-theme", () => {
  const init = new Function(THEME_INIT_SCRIPT);
  for (const dark of [false, true]) {
    for (const saved of [null, "light", "dark", "system", "broken"]) {
      const { html, notices } = world({ saved, dark });
      init();
      const expected = getStoredMode(); // reads the same stubs
      assert.equal(html.dataset.theme, resolveMode(expected), `data-theme for ${JSON.stringify(saved)}`);
      assert.deepEqual(notices, [expected], `init script reports for ${JSON.stringify(saved)} "${expected}"`);
    }
  }
  // Without a bridge, with an old and with a throwing bridge: data-theme is set anyway, and nothing throws out (the script runs in
  // the <body>, a throw there would stand in front of every further script).
  for (const shell of [null, "alt", "raises"]) {
    const { html, notices } = world({ saved: "dark", shell });
    init();
    assert.equal(html.dataset.theme, "dark", `data-theme with bridge ${shell}`);
    assert.deepEqual(notices, []);
  }
});

test("without, with an old and with a throwing bridge: applyMode and setThemeMode set data-theme and do not throw", () => {
  for (const shell of [null, "alt", "raises"]) {
    const { storage, html } = world({ shell });
    assert.doesNotThrow(() => applyMode("dark"), `applyMode with bridge ${shell}`);
    assert.equal(html.dataset.theme, "dark");
    assert.doesNotThrow(() => setThemeMode("light"), `setThemeMode with bridge ${shell}`);
    assert.equal(storage.get(KEY), "light");
    assert.equal(html.dataset.theme, "light");
    assert.equal(reportThemeMode(globalThis.window, "light"), false, `not reported with bridge ${shell}`);
  }
  world({ shell: "fresh" });
  assert.equal(reportThemeMode(globalThis.window, "system"), true);
  assert.equal(reportThemeMode(undefined, "system"), false, "without window (prerendered) no report");
});

test("every path that sets data-theme reports: only applyMode and the init script write it", () => {
  const writer = [];
  for (const rel of webFiles()) {
    const t = withoutComments(fs.readFileSync(path.join(src, rel), "utf8"), rel);
    const n = (t.match(/dataset\.theme\s*=(?!=)/g) ?? []).length
      + (t.match(/setAttribute\(\s*["'`]data-theme["'`]/g) ?? []).length
      + (t.match(/dataset\[\s*["'`]theme["'`]\s*\]\s*=(?!=)/g) ?? []).length;
    if (n) writer.push(`${rel}×${n}`);
  }
  console.log(`  [window-buttons] data-theme writers in web/src: ${writer.join(", ") || "none"}`);
  assert.deepEqual(writer, ["lib/theme.ts×2"],
    "data-theme is set outside applyMode/THEME_INIT_SCRIPT — this path reports nothing to the shell; route it through applyMode");
  const t = code("src/lib/theme.ts");
  const apply = body(t, "applyMode", "lib/theme.ts");
  assert.match(apply, /dataset\.theme\s*=/, "applyMode no longer sets data-theme");
  assert.match(apply, /reportThemeMode\([^,]+,\s*mode\s*\)/, "applyMode does not report the CHOSEN mode (`mode`)");
  assert.match(body(t, "setThemeMode", "lib/theme.ts"), /applyMode\(\s*mode\s*\)/, "setThemeMode does not go through applyMode");
  assert.match(THEME_INIT_SCRIPT, /dataset\.theme=[^;]+;[\s\S]*setTheme\(/, "the init script does not report, or BEFORE data-theme");
});

// ── (2) The header's switch ──────────────────────────────────────────────────────────────────────

test("drawsWindowButtons: exactly when the bridge is there and setTheme is missing", () => {
  const f = () => {};
  const fall = [
    [undefined, false, "prerendered (no window)"],
    [null, false, "no window"],
    [{}, false, "browser: no bridge"],
    [{ cbaseShell: null }, false, "bridge null"],
    [{ cbaseShell: "x" }, false, "bridge not an object"],
    [{ cbaseShell: { windowClose: f, windowMinimize: f, windowZoom: f } }, true, "old client (Electron 37)"],
    [{ cbaseShell: { windowClose: f, windowMinimize: f, windowZoom: f, setTheme: true } }, true, "setTheme not a function"],
    [{ cbaseShell: { windowClose: f, windowMinimize: f, windowZoom: f, setTheme: f } }, false, "new shell (Electron 44)"],
  ];
  for (const [w, expected, what] of fall) assert.equal(drawsWindowButtons(w), expected, what);
  assert.equal(shellBridge({}), null);
});

test("TopNav draws the window buttons exactly via this switch — no second path", () => {
  const nav = code("src/components/TopNav.tsx");
  assert.match(nav, /import\s*\{[^}]*\bdrawsWindowButtons\b[^}]*\}\s*from\s*"@\/lib\/shell-bridge"/,
    "TopNav.tsx does not import drawsWindowButtons from @/lib/shell-bridge");
  const places = [...nav.matchAll(/<WindowButtons\b/g)];
  assert.equal(places.length, 1, `TopNav.tsx renders <WindowButtons> ${places.length} times — exactly one place expected`);
  const m = /\{\s*([A-Za-z_$][\w$]*)\s*&&\s*<WindowButtons\s*\/>\s*\}/.exec(nav);
  assert.ok(m, "anchor: `{<state> && <WindowButtons />}` not found — the condition is no longer a single state variable");
  const state = m[1];
  const decl = new RegExp(`const\\s*\\[\\s*${state}\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\]\\s*=\\s*useState\\(\\s*false\\s*\\)`).exec(nav);
  assert.ok(decl, `"${state}" is not a useState(false) — nothing may be drawn before mount (prerendered)`);
  const setter = decl[1];
  const calls = [...nav.matchAll(new RegExp(`\\b${setter}\\(([^;]*)\\)\\s*;`, "g"))].map((a) => a[1].trim());
  assert.deepEqual(calls, ["drawsWindowButtons(window)"],
    `"${setter}" is set differently than with drawsWindowButtons(window): ${JSON.stringify(calls)}`);
});

test("cbaseShell is read only by the sheet (and the init script, which runs before every module)", () => {
  const reader = webFiles().filter((rel) => /\bcbaseShell\b/.test(withoutComments(fs.readFileSync(path.join(src, rel), "utf8"), rel)));
  console.log(`  [window-buttons] readers of cbaseShell in web/src: ${reader.join(", ")}`);
  assert.deepEqual(reader, ["lib/shell-bridge.ts", "lib/theme.ts"],
    "readers of cbaseShell differ: expected are the sheet and the init script in theme.ts — a file bypassing " +
    "lib/shell-bridge.ts sidesteps the switch, and without the init script the start reports nothing before the header");
  // In theme.ts only in the init script (a string), not as code.
  const t = code("src/lib/theme.ts").replace(/THEME_INIT_SCRIPT\s*=[\s\S]*?;\n/, "");
  assert.doesNotMatch(t, /\bcbaseShell\b/, "theme.ts accesses the bridge outside the init script");
});

test("the header placeholder reaches past the third NATIVE button — in the client's shell", () => {
  // The computation from the comment in TopNav.tsx, held against the sources: the nav's padding from sm plus the placeholder's
  // width against the third button's right edge. The edge follows from the shell's `trafficLightPosition.x` and the measured
  // AppKit geometry (button frame from `standardWindowButton`): under Electron 44 frame 14 at spacing 23 (x 16/39/62 ⇒ 76), under
  // 37 frame 14 at spacing 20 (x 16/36/56 ⇒ 70). px-3 below sm does not count as long as the window cannot get narrower than sm
  // at zoom 1 (minWidth).
  const nav = code("src/components/TopNav.tsx");
  const slot = /<span\s+aria-hidden\s+className="([^"]*\bh-9\b[^"]*)"\s*\/>/.exec(nav);
  assert.ok(slot, "anchor: the header's h-9 placeholder (`<span aria-hidden className=\"… h-9 …\" />`) not found");
  const width = /\bw-\[(\d+)px\]/.exec(slot[1]);
  assert.ok(width, `anchor: the placeholder carries no width w-[Npx]: "${slot[1]}"`);
  const navClass = /<nav\b[^>]*className=\{`([^`]*)`\}/.exec(nav);
  assert.ok(navClass, "anchor: the className of the <nav> in TopNav.tsx not found");
  const pad = /\bsm:px-(\d+(?:\.\d+)?)\b/.exec(navClass[1]);
  assert.ok(pad, `anchor: no sm:px-N on the <nav>: "${navClass[1]}"`);
  const padding = Number(pad[1]) * 4; // Tailwind: 1 unit = 4 px
  const right = padding + Number(width[1]);
  const SM = 640;
  for (const rel of ["client/main.js"]) {
    const t = fs.readFileSync(path.join(repo, rel), "utf8");
    const pos = /const TRAFFIC_LIGHT_POSITION\s*=\s*\{\s*x:\s*(\d+)\s*,\s*y:\s*(\d+)\s*\}/.exec(t);
    assert.ok(pos, `anchor: TRAFFIC_LIGHT_POSITION not found in ${rel}`);
    const min = /minWidth:\s*(\d+)/.exec(t);
    assert.ok(min, `anchor: minWidth not found in ${rel}`);
    assert.ok(Number(min[1]) >= SM, `${rel}: minWidth ${min[1]} < ${SM} — then px-3 applies, and the computation must be redone`);
    const x = Number(pos[1]);
    const edge44 = x + 2 * 23 + 14;
    const edge37 = x + 2 * 20 + 14;
    console.log(`  [window-buttons] ${rel}: x ${x} ⇒ third button up to ${edge44} (44) / ${edge37} (37); placeholder ${padding} + ${width[1]} = ${right}`);
    assert.ok(right > edge44 && right > edge37,
      `placeholder ends at ${right}, the third native button at ${edge44} (44) / ${edge37} (37) — content would slip under the traffic lights`);
  }
});

// ── The seam to the shell ────────────────────────────────────────────────────────────────────────

test("seam: preload.cjs exposes `setTheme` on cbaseShell and sends on \"cbase:theme\"", () => {
  for (const rel of ["client/preload.cjs"]) {
    const t = withoutComments(fs.readFileSync(path.join(repo, rel), "utf8"), "preload.js");
    const m = /exposeInMainWorld\(\s*"cbaseShell"\s*,\s*\{([\s\S]*?)\}\s*\)/.exec(t);
    assert.ok(m, `anchor: exposeInMainWorld("cbaseShell", {…}) not found in ${rel}`);
    assert.match(m[1], /\bsetTheme\s*:\s*\(\s*(\w+)\s*\)\s*=>\s*ipcRenderer\.send\(\s*"cbase:theme"\s*,\s*\1\s*\)/,
      `${rel}: cbaseShell.setTheme(mode) does not send unchanged on "cbase:theme" — the web calls exactly this name`);
  }
});

test("seam: the web's modes are exactly those main.js accepts — a foreign one would be silently dropped", () => {
  // The main process drops everything except its modes — no answer, no log. A fourth mode in the web would never arrive, and
  // the buttons would stand in the last one's coloring.
  const literals = (text, what) => {
    const l = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.ok(l.length, `anchor: no literals in ${what}`);
    return l;
  };
  const type = (rel, name) => {
    const m = new RegExp(`export type ${name}\\s*=\\s*([^;]+);`).exec(code(rel));
    assert.ok(m, `anchor: "export type ${name}" not found in ${rel}`);
    return literals(m[1], `${rel}:${name}`);
  };
  const web = type("src/lib/theme.ts", "ThemeMode");
  assert.deepEqual(type("src/lib/shell-bridge.ts", "ShellThemeMode"), web, "ShellThemeMode ≠ ThemeMode");
  for (const rel of ["client/main.js"]) {
    const t = withoutComments(fs.readFileSync(path.join(repo, rel), "utf8"), "main.js");
    const m = /const THEME_MODES\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)/.exec(t);
    assert.ok(m, `anchor: "const THEME_MODES = new Set([…])" not found in ${rel}`);
    assert.deepEqual(literals(m[1], `${rel}:THEME_MODES`), web, `${rel}: THEME_MODES ≠ the web's ThemeMode`);
    assert.match(t, /ipcMain\.on\(\s*"cbase:theme"/, `${rel}: no handler on "cbase:theme"`);
  }
  console.log(`  [window-buttons] modes web == shell: ${web.join(", ")}`);
});
