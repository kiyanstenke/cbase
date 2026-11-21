// The watermark of an empty editor group as in VS Code 1.143:
//
// (1) The computation (lib/watermark.ts), EXECUTED: first "Open chat" and "Show All Commands", each only if its command is registered
//     AND bound to a key; below three entries, shuffled ones from Go to File · Find in Files · Start Debugging · Toggle Terminal ·
//     Open Settings (first filtered, then Fisher-Yates from the back as VS Code `shuffle`) until there are three; the shortcuts as
//     keys (Mac: one key per symbol in the order ⌃ ⇧ ⌥ ⌘, else Ctrl/Shift/Alt), chords separated; shortcuts only without editors in
//     another group.
// (2) The sources: the embossing is the LENS (/cbase-lens.png as mask, never the icon tile), the dimensions of VS Code (272 px,
//     narrow 200 px and 70 px shorter, no shortcuts below 478 px height — container query), the shortcuts come from the ONE command
//     table (lib/editor-commands.ts), the palette registers itself before the first editor, CodePane draws the watermark in every
//     empty group. The mask LINE-exact (the line `mask:` itself, not part of `-webkit-mask:`), shuffled ONCE per group (CodePane
//     keeps the draw per group, remounting does not shuffle again, a removed group takes its draw with it), the keys in the boxes of
//     the Quick Input (`.cb-qi-key`, `--qi-key-*` — no second set in globals.css).
//
// Each sabotage is a copy of the source with ONE changed place (the place occurs exactly once, else the sabotage is outdated); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/watermark.test.mjs
// Run:  node --test --test-reporter=tap web/test/watermark.test.mjs
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
const SOURCE = read("src", "lib", "watermark.ts");

const SABOTAGES = {
  "chat not first": { old: "  { id: \"workbench.action.chat.open\", title: \"Open chat\" },\n  { id: \"workbench.action.showCommands\", title: \"Show All Commands\" },", fresh: "  { id: \"workbench.action.showCommands\", title: \"Show All Commands\" },\n  { id: \"workbench.action.chat.open\", title: \"Open chat\" },", catches: "entries" },
  "unbound ones are shown": { old: "const present = (e: WaterEntry) => Boolean(shortcut(e.id));", fresh: "const present = (_e: WaterEntry) => true;", catches: "entries" },
  "four instead of three": { old: "export const WATER_AT_LEAST = 3;", fresh: "export const WATER_AT_LEAST = 4;", catches: "entries" },
  "not shuffled": { old: "rows.push(...shuffle(WATER_RANDOM.filter(present), random).slice(", fresh: "rows.push(...WATER_RANDOM.filter(present).slice(", catches: "entries" },
  "shuffled before filtering": { old: "shuffle(WATER_RANDOM.filter(present), random)", fresh: "shuffle(WATER_RANDOM, random).filter(present)", catches: "entries" },
  "height 400": { old: "export const WATER_HEIGHT = 478;", fresh: "export const WATER_HEIGHT = 400;", catches: "entries" },
  "shortcuts despite another group": { old: "=> !othersWithEditors;", fresh: "=> true;", catches: "entries" },
  "shuffle from the front": { old: "for (let i = a.length - 1; i > 0; i -= 1) {", fresh: "for (let i = 0; i < a.length - 1; i += 1) {", catches: "shuffle" },
  "shuffle changes the input": { old: "const a = [...list];", fresh: "const a = list as T[];", catches: "shuffle" },
  "Mac in plus form": { old: "    if (mac) return [...MAC_MODS.filter((m) => mods.has(m)), key];\n", fresh: "", catches: "keys" },
  "order of the input": { old: "[...MAC_MODS.filter((m) => mods.has(m)), key]", fresh: "[...mods, key]", catches: "keys" },
  "⌘ is not Ctrl": { old: "if (mods.has(\"⌃\") || mods.has(\"⌘\")) out.push(\"Ctrl\");", fresh: "if (mods.has(\"⌃\")) out.push(\"Ctrl\");", catches: "keys" },
  "chord as one key": { old: "shortcut.trim().split(/\\s+/)", fresh: "[shortcut.trim()]", catches: "keys" },
};

// ── Compile: the source and one copy per sabotage, in ONE tsc run (the computation imports nothing). ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-watermark-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "watermark.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `watermark-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "watermark.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("watermark.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── The checks ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const W = "workbench.action.";
const CHAT = `${W}chat.open`, ALL = `${W}showCommands`, FILE = `${W}quickOpen`, SEARCH = `${W}findInFiles`, DEBUG = `${W}debug.start`, TERM = `${W}terminal.toggleTerminal`, FORMER = `${W}openSettings`;
// What cbase binds today (lib/commandPalette.ts, lib/panel-layout.ts): no chat, no debug start, no settings with a key.
const CBASE = { [ALL]: "⇧⌘P", [FILE]: "⌘P", [SEARCH]: "⇧⌘F", [TERM]: "⌃`" };
const from = (k) => (id) => k[id] ?? null;
/** A fixed randomness: the values in turn, over and over. */
const followUp = (...w) => { let i = 0; return () => w[i++ % w.length]; };
const ids = (z) => z.map((x) => x.id);

const CHECKS = {
  entries: (m) => {
    // cbase: "Show All Commands" fixed, plus two shuffled ones from the BOUND (Go to File, Find in Files, Toggle Terminal).
    assert.deepEqual(m.watermark(from(CBASE), () => 0.999), [
      { id: ALL, title: "Show All Commands", shortcut: "⇧⌘P" }, { id: FILE, title: "Go to File", shortcut: "⌘P" }, { id: SEARCH, title: "Find in Files", shortcut: "⇧⌘F" },
    ], "without swaps: the order of the list");
    assert.deepEqual(ids(m.watermark(from(CBASE), () => 0)), [ALL, SEARCH, TERM], "shuffled like VS Code `shuffle`");
    assert.deepEqual(ids(m.watermark(from(CBASE), followUp(0.9, 0.1))), [ALL, SEARCH, FILE], "first filtered, then shuffled");
    // VS Code with everything bound: chat and All Commands fixed, one shuffled.
    const all = { [CHAT]: "⌃⌘I", [ALL]: "⇧⌘P", [FILE]: "⌘P", [SEARCH]: "⇧⌘F", [DEBUG]: "F5", [TERM]: "⌃`", [FORMER]: "⌘," };
    assert.deepEqual(ids(m.watermark(from(all), () => 0.999)), [CHAT, ALL, FILE], "the fixed ones first, in VS Code's order");
    assert.deepEqual(ids(m.watermark(from({ [CHAT]: "⌃⌘I", [ALL]: "⇧⌘P", [SEARCH]: "⇧⌘F" }), () => 0.999)), [CHAT, ALL, SEARCH]);
    assert.deepEqual(m.watermark(from({}), () => 0), [], "without a bound command: only the embossing");
    assert.deepEqual(ids(m.watermark(from({ [FILE]: "⌘P" }), () => 0)), [FILE], "at most what is bound");
    assert.equal(m.WATER_AT_LEAST, 3); assert.equal(m.WATER_HEIGHT, 478);
    assert.equal(m.withShortcuts(false), true); assert.equal(m.withShortcuts(true), false, "if another group carries editors, no shortcuts are shown");
  },
  shuffle: (m) => {
    const one = [1, 2, 3, 4];
    assert.deepEqual(m.shuffle(one, () => 0), [2, 3, 4, 1], "Fisher-Yates from the back like VS Code");
    assert.deepEqual(m.shuffle(one, () => 0.999), [1, 2, 3, 4]);
    assert.deepEqual(one, [1, 2, 3, 4], "the input stays");
  },
  keys: (m) => {
    assert.deepEqual(m.keysParts("⇧⌘P", true), [["⇧", "⌘", "P"]]);
    assert.deepEqual(m.keysParts("⇧⌘P", false), [["Ctrl", "Shift", "P"]]);
    assert.deepEqual(m.keysParts("⌃`", true), [["⌃", "`"]]);
    assert.deepEqual(m.keysParts("⌃`", false), [["Ctrl", "`"]]);
    assert.deepEqual(m.keysParts("⌘⇧P", true), [["⇧", "⌘", "P"]], "VS Code's order, not the input's");
    assert.deepEqual(m.keysParts("⇧⌥F", false), [["Shift", "Alt", "F"]]);
    assert.deepEqual(m.keysParts("⌘K V", true), [["⌘", "K"], ["V"]], "a chord is two groups");
    assert.deepEqual(m.keysParts("⌘K V", false), [["Ctrl", "K"], ["V"]]);
  },
};

test("(1) computation: entries, shuffling, shortcuts — like VS Code 1.143", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: every sabotage occurs exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose place is not exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [watermark] ${sabotaged.length} sabotages of the computation, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  drawing: read("src", "components", "code", "Watermark.tsx"),
  css: read("src", "app", "globals.css"),
  pane: read("src", "components", "CodePane.tsx"),
  palette: read("src", "components", "code", "palette-host.ts"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
/** The watermark's block in globals.css (from its colors to the last shortcut rule), without comments. */
const CSS_END = ".cb-watermark-shortcut dd {";
const cssBlock = (css) => {
  const i = css.indexOf(":root[data-theme=\"dark\"] { --watermark-embossing"), j = css.indexOf(CSS_END), k = j < 0 ? -1 : css.indexOf("\n", j);
  return i < 0 || k < i ? "" : withoutComments(css.slice(i, k));
};
function sources(q) {
  const z = withoutComments(q.drawing), b = cssBlock(q.css), c = withoutComments(q.pane), p = withoutComments(q.palette);
  // The lens, never the icon tile — and the file exists. Line-exact: `mask:` as its own line, not as part of `-webkit-mask:`.
  assert.match(b, /^\s*mask: url\("\/cbase-lens\.png"\) center \/ contain no-repeat;$/m, "the embossing is not the lens (mask)");
  assert.match(b, /^\s*-webkit-mask: url\("\/cbase-lens\.png"\) center \/ contain no-repeat;$/m, "the embossing is not the lens (-webkit-mask)");
  assert.ok(!/icon|tile|orb\.png/i.test(b) && !/<img|cbase-icon/i.test(z), "the embossing is the icon tile");
  assert.ok(fs.existsSync(path.join(webDir, "public", "cbase-lens.png")), "the lens is missing under public/");
  // VS Code's dimensions.
  assert.ok(b.includes(".cb-watermark { position: absolute; inset: 0; container-type: size; container-name: watermark; }"), "no container query on the group");
  assert.ok(b.includes("@container watermark (max-height: 478px) { .cb-watermark-shortcut { display: none; } }"), "shortcuts shown below 478 px height");
  assert.ok(b.includes(".cb-watermark[data-narrow] .cb-watermark-surface { max-width: 200px; height: calc(100% - 70px); }"), "not narrow next to a group with editors");
  assert.ok(b.includes("height: 100%; max-width: 272px;") && b.includes("max-width: 256px;"), "the widths are not VS Code's");
  assert.ok(!/@media/.test(b), "a window query instead of the container query");
  // The shortcuts from the ONE command table, shuffled ONCE per group; narrow without shortcuts.
  assert.ok(z.includes("return watermark((id) => command(id)?.shortcut ?? null, () => thrown[i++ % thrown.length]);"), "the shortcuts do not come from the command table");
  assert.ok(z.includes("useEffect(() => subscribeCommands(tick), []);"), "a command registered late does not appear");
  assert.ok(z.includes("export function Watermark({ t, othersWithEditors, thrown }:") && !/useState\(\(\) => (newThrow|Array\.from)/.test(z), "shuffled per mount, not per group");
  assert.ok(c.includes("const throwOf = (gid: string) => { let w = thrown.current.get(gid); if (!w) thrown.current.set(gid, (w = newThrow())); return w; };"), "the draw does not belong to the group");
  assert.ok(c.includes("useEffect(() => { for (const k of [...thrown.current.keys()]) if (!groupsIds.split(\"|\").includes(k)) thrown.current.delete(k); }, [groupsIds]);"), "a removed group keeps its draw");
  // The keys in the Quick Input's boxes — no second set.
  assert.ok(z.includes("<kbd className=\"cb-qi-key\">{x}</kbd>") && z.includes("className=\"cb-qi-keys\"") && z.includes("className=\"cb-qi-chord\""), "own keys instead of the Quick Input's");
  assert.ok(!/\.cb-key\b|\.cb-keys\b|--key-/.test(withoutComments(q.css)), "a second set of keys in globals.css");
  assert.ok(z.includes("data-narrow={shortcutsOn ? undefined : \"\"}") && z.includes("{shortcutsOn && ("), "shortcuts shown next to a group with editors");
  assert.ok(p.includes("    enterW4One();\n    const w = host.current!;"), "the palette is registered only after the first editor — the empty group would have no \"Show All Commands\"");
  // In EVERY empty group; narrow if another carries editors.
  assert.ok(c.includes("{!g.active && <Watermark t={t} thrown={throwOf(g.id)} othersWithEditors={groupsStatus.groups.some((x) => x.id !== g.id && x.paths.length > 0)} />}"), "the empty group shows no watermark");
  for (const k of ["Open chat", "Show All Commands", "Go to File", "Find in Files", "Start Debugging", "Toggle Terminal", "Open Settings"]) {
    assert.ok(q.i18n.includes(`\n  ${JSON.stringify(k)}: `), `"${k}" without English text`);
  }
}
const SOURCE_SABOTAGES = [
  // A name the forbidden list does not know: the line-exact mask check must catch it.
  ["icon tile", "css", "  mask: url(\"/cbase-lens.png\") center / contain no-repeat;", "  mask: url(\"/logo-app.png\") center / contain no-repeat;"],
  ["icon tile only in WebKit", "css", "  -webkit-mask: url(\"/cbase-lens.png\") center / contain no-repeat;", "  -webkit-mask: url(\"/logo-app.png\") center / contain no-repeat;"],
  ["image instead of embossing", "drawing", "<div className=\"cb-watermark-embossing\" aria-hidden data-watermark-embossing />", "<img src=\"/cbase-icon.png\" alt=\"\" />"],
  ["no container query", "css", "container-type: size; container-name: watermark; }", "}"],
  ["height 400", "css", "@container watermark (max-height: 478px)", "@container watermarkx (max-height: 400px)"],
  ["narrow too wide", "css", "max-width: 200px; height: calc(100% - 70px); }", "max-width: 272px; }"],
  ["window query", "css", "@container watermark (max-height: 478px) { .cb-watermark-shortcut { display: none; } }", "@media (max-height: 478px) { .cb-watermark-shortcut { display: none; } }"],
  ["shortcuts hard-wired", "drawing", "return watermark((id) => command(id)?.shortcut ?? null, () => thrown[i++ % thrown.length]);", "return watermark((id) => ({ \"workbench.action.showCommands\": \"⇧⌘P\" } as Record<string, string>)[id], () => draw[i++ % draw.length]);"],
  ["not subscribed", "drawing", "useEffect(() => subscribeCommands(tick), []);", ""],
  ["shuffled per mount", "drawing", "export function Watermark({ t, othersWithEditors, thrown }: { t: T; othersWithEditors: boolean; thrown: readonly number[] }) {", "export function Watermark({ t, othersWithEditors }: { t: T; othersWithEditors: boolean; draw: readonly number[] }) {\n  const [draw] = useState(() => newThrow());"],
  ["shuffled on every render", "pane", "thrown={throwOf(g.id)}", "draw={newThrow()}"],
  ["draw not per group", "pane", "const throwOf = (gid: string) => { let w = thrown.current.get(gid); if (!w) thrown.current.set(gid, (w = newThrow())); return w; };", "const throwOf = (_gid: string) => newThrow();"],
  ["draw outlives the group", "pane", "useEffect(() => { for (const k of [...thrown.current.keys()]) if (!groupsIds.split(\"|\").includes(k)) thrown.current.delete(k); }, [groupsIds]);", ""],
  ["own keys", "drawing", "<kbd className=\"cb-qi-key\">{x}</kbd>", "<kbd className=\"cb-key\">{x}</kbd>"],
  ["second set of key colors", "css", ":root[data-theme=\"dark\"] { --watermark-embossing: rgb(0 0 0 / 0.3); }", ":root[data-theme=\"dark\"] { --watermark-embossing: rgb(0 0 0 / 0.3); --key-reason: rgb(128 128 128 / 0.17); }"],
  ["narrow with shortcuts", "drawing", "{shortcutsOn && (", "{true && ("],
  ["palette only in the editor", "palette", "    enterW4One();\n    const w = host.current!;", "    const w = host.current!;"],
  ["empty group without watermark", "pane", "{!g.active && <Watermark t={t}", "{false && <Missing t={t}"],
  ["never narrow", "pane", "othersWithEditors={groupsStatus.groups.some((x) => x.id !== g.id && x.paths.length > 0)}", "othersWithEditors={false}"],
  ["translation missing", "i18n", "  \"Show All Commands\": \"Alle Befehle anzeigen\",\n", ""],
];

test("(2) sources: lens instead of tile, dimensions and container query, shortcuts from the command table, every empty group, English (with counter-tests)", (tt) => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-test "${name}" is outdated: the place occurs ${n}× in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-test "${name}" is not caught`);
  }
  tt.diagnostic(`${SOURCE_SABOTAGES.length} counter-tests caught`);
});
