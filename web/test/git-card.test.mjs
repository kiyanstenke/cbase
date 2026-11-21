// The hover card of a commit in the git bar graph — the pure computations src/lib/git-card.ts and the allowlist
// src/lib/api/git.ts `normGitCommitInfo`, EXECUTED, not re-implemented (compiled with the local tsc, like git-graph.test.mjs),
// plus the BINDING of the components (CommitCard.tsx, GitGraph.tsx, GitSidebar.tsx, globals.css).
//
// What hangs here and why it is a latch:
// - The numbers row like VS Code: "1 file changed, 92 insertions(+), 79 deletions(−)" — singular and plural in BOTH languages
//   (the English keys from i18n-de.ts, executed), zero parts are dropped, binary files are stated ("(1 binary)") instead of being
//   hidden as 0 lines; a card without numbers (old server) has NO row, never "0 files changed".
// - The time: "10 months ago" in the steps of VS Code, the full date with time in the language of the UI.
// - What the card shows: the answer ONLY if it belongs to this commit (a stale answer never lands in the card of another row);
//   without it, what the graph knows (commit time in seconds → ms).
// - The position: left of the bar at the height of the row, otherwise below/above, NEVER out of the window and never wider than
//   it — checked over a grid of windows, bars and rows.
// - The allowlist: an old server (the whole commit) is "unknown", a foreign answer too; the four numbers are ONE block.
// - The seam: `normGitCommitInfo` reads EXACTLY the fields of server git.js `COMMIT_INFO_FIELDS` (that the route sends exactly
//   these is held by server/backend/test/git-commit-files.test.js) — no field the server never sends, none that gets lost.
// - The translations: every `t("…")` key of the card is in i18n-de.ts.
// - The binding: loaded only through the path builder of the bar, with `info: true`, through the allowlist, once per hash (again
//   after an error), and ONLY after the dwell (the only call of `load` is in `show`); no timer; the listeners on the wrapper of
//   the commit row, not on the file rows; a drag and a pressed button block; Escape closes; on the body, `cb-kit` + `cb-pop`; the
//   colours of the numbers are those of "A"/"D"; the dot grows via CSS on `.cb-git-dot`, the lanes still depend only on the log;
//   GitGraph.tsx has no clock.
//
// COUNTER-PROOFS built in: sabotages on copies of the sources (one place each), the check must throw on each; plus sabotages on
// the component source text for the binding. The DOM probe (real mouse, counting requests, measuring the radius) lives outside
// the gate (visual probe).
//
// Run:  node --test web/test/git-card.test.mjs
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
const source = read("src", "lib", "git-card.ts");
const apiSource = read("src", "lib", "api", "git.ts");
const enSource = read("src", "lib", "i18n-de.ts");

const SABOTAGES = {
  "singular never": { old: `z.files === 1 ? "{n} file changed"`, fresh: `false ? "{n} file changed"` },
  "insertion always plural": { old: `z.plus === 1 ? "{n} insertion(+)"`, fresh: `false ? "{n} insertion(+)"` },
  "deletion always plural": { old: `z.minus === 1 ? "{n} deletion(−)"`, fresh: `false ? "{n} deletion(−)"` },
  "zero insertions shown": { old: `if (z.plus > 0) parts.push(`, fresh: `if (z.plus >= 0) parts.push(` },
  "binary files hidden": { old: `if (z.binary > 0) parts.push(`, fresh: `if (false) parts.push(` },
  "no files as \"0 files\"": { old: `  if (z.files === 0) return [{ key: "No files changed.", n: 0, tone: "files", before: "" }];\n`, fresh: `` },
  "card right of the bar": { old: `const left = bar.left - gap - width;`, fresh: `const left = bar.right + gap;` },
  "card not kept in the window": { old: `const holdY = (y: number) => Math.max(margin, Math.min(y, window.h - margin - h));`, fresh: `const holdY = (y: number) => y;` },
  "card wider than the window": { old: `const width = Math.max(0, Math.min(card.w, window.w - 2 * margin));`, fresh: `const width = card.w;` },
  "bottom without check": { old: `if (bottom + h <= window.h - margin) return`, fresh: `if (true) return` },
  "relative time with \"last month\"": { old: `new Intl.RelativeTimeFormat(locale, { numeric: "always" })`, fresh: `new Intl.RelativeTimeFormat(locale, { numeric: "auto" })` },
  "time without weeks": { old: `      : a < MONTH ? [a / WEEK, "week"]`, fresh: `` },
  "future as past": { old: `(d >= 0 ? -1 : 1) * Math.floor(n)`, fresh: `-Math.floor(n)` },
  "foreign answer in the card": { old: `const i = info && info.hash.startsWith(c.hash) ? info : null;`, fresh: `const i = info;` },
  "old server shows 0 files": { old: `counts: i?.counts ?? null,`, fresh: `counts: i?.counts ?? { files: 0, plus: 0, minus: 0, binary: 0 },` },
  "graph time in seconds": { old: `(c.time ? c.time * 1000 : null)`, fresh: `c.time` },
  "no dwell": { old: `export const CARD_DWELL_MS = 400;`, fresh: `export const CARD_DWELL_MS = 0;` },
};
const SABOTAGES_API = {
  "old server as card": {
    old: `if (typeof o.message !== "string" || typeof o.author !== "string") return null;`,
    fresh: `if (typeof o.message !== "string" || typeof o.author !== "string") return { hash: text(o.hash), parent: null, author: "", email: null, time: null, message: "", messageClipped: null, counts: { files: 0, plus: 0, minus: 0, binary: 0 }, countsClipped: null };`,
  },
  "foreign hash": { old: `  if (!hash || !h.startsWith(hash)) return null;\n  const [files`, fresh: `  const [files` },
  "missing number as 0": { old: `const count = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);`, fresh: `const count = (x: unknown): number | null => (typeof x === "number" ? x : 0);` },
  "binary more than files": { old: ` && binary <= files ? { files`, fresh: ` ? { files` },
  "reads a field the server does not send": {
    old: `typeof o.time === "number" && Number.isFinite(o.time) && o.time > 0 ? o.time : null`,
    fresh: `typeof o.moment === "number" && Number.isFinite(o.moment) && o.moment > 0 ? o.moment : null`,
  },
};

// Compile: the real sources and one copy per sabotage, in ONE tsc run (each file a leaf without imports).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-card-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
fs.writeFileSync(path.join(src, "api-git.ts"), apiSource);
fs.writeFileSync(path.join(src, "i18n-de.ts"), enSource);
const copies = (sabotages, template, prefix) => Object.entries(sabotages).map(([name, { old, fresh }], i) => {
  const file = `${prefix}-${i}.ts`;
  fs.writeFileSync(path.join(src, file), template.replace(old, fresh));
  return { name, file, applies: template.includes(old) };
});
const sabotageCard = copies(SABOTAGES, source, "sabotage");
const sabotageApi = copies(SABOTAGES_API, apiSource, "sabotage-api");
try {
  execFileSync(process.execPath, [
    tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict",
  ], { stdio: "pipe" });
} catch (e) {
  throw new Error(`tsc: ${String(e.stdout || "")}${String(e.stderr || "")}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const apiGit = await load("api-git.ts");
const { DE } = await load("i18n-de.ts");
const sabotaged = await Promise.all(sabotageCard.map(async (s) => ({ ...s, mod: await load(s.file) })));
const sabotagedApi = await Promise.all(sabotageApi.map(async (s) => ({ ...s, mod: await load(s.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed:", String(e?.message || e).slice(0, 120)); }

// The translation like lib/i18n.ts (`fmt`): English is the key, German from DE — a missing key shows.
const fmt = (s, p) => (p ? s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : s);
const plain = (k) => (k.indexOf("##") < 0 ? k : k.slice(0, k.indexOf("##")));
const en = (k, p) => fmt(plain(k), p);
const de = (k, p) => fmt(DE[k] ?? `‹missing: ${k}›`, p);
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 26, 12, 0);
const empty = (s) => s.replace(/[  ]/g, " "); // ICU puts a narrow no-break space before "PM"

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function checkTime(m) {
  const r = (before, l) => m.relativeTime(T0 - before, T0, l);
  assert.equal(r(10 * 30 * DAY + 5 * DAY, "de-DE"), "vor 10 Monaten");
  assert.equal(r(10 * 30 * DAY + 5 * DAY, "en-US"), "10 months ago");
  assert.equal(r(31 * DAY, "de-DE"), "vor 1 Monat", "\"vor 1 Monat\", not \"letzten Monat\" (like VS Code: always with a number)");
  assert.equal(r(31 * DAY, "en-US"), "1 month ago");
  assert.equal(r(20 * SEC, "de-DE"), "jetzt");
  assert.equal(r(20 * SEC, "en-US"), "now");
  assert.equal(r(45 * SEC, "de-DE"), "vor 45 Sekunden");
  assert.equal(r(3 * HOUR + 10 * MIN, "de-DE"), "vor 3 Stunden");
  assert.equal(r(14 * DAY, "de-DE"), "vor 2 Wochen");
  assert.equal(r(14 * DAY, "en-US"), "2 weeks ago");
  assert.equal(r(400 * DAY, "de-DE"), "vor 1 Jahr");
  assert.equal(m.relativeTime(T0 + 5 * MIN + SEC, T0, "de-DE"), "in 5 Minuten", "a clock that ran ahead: \"in …\", not \"vor …\"");
  const dec = Date.UTC(2025, 11, 15, 13, 32);
  assert.equal(m.fullDate(dec, "de-DE", "Europe/Berlin"), "15. Dezember 2025 um 14:32");
  assert.equal(empty(m.fullDate(dec, "en-US", "Europe/Berlin")), "December 15, 2025 at 2:32 PM");
}
function checkCounts(m) {
  const row = (z, t) => m.countsText(m.countsParts(z), t);
  const vsc = { files: 1, plus: 92, minus: 79, binary: 0 };
  assert.equal(row(vsc, de), "1 Datei geändert, 92 Einfügungen(+), 79 Löschungen(−)");
  assert.equal(row(vsc, en), "1 file changed, 92 insertions(+), 79 deletions(−)");
  assert.deepEqual(m.countsParts(vsc).map((x) => x.tone), ["files", "plus", "minus"], "insertions and deletions carry their colour role");
  const one = { files: 2, plus: 1, minus: 1, binary: 0 };
  assert.equal(row(one, de), "2 Dateien geändert, 1 Einfügung(+), 1 Löschung(−)");
  assert.equal(row(one, en), "2 files changed, 1 insertion(+), 1 deletion(−)");
  assert.equal(row({ files: 3, plus: 0, minus: 5, binary: 0 }, de), "3 Dateien geändert, 5 Löschungen(−)", "no \"0 insertions\" (like VS Code)");
  assert.equal(row({ files: 3, plus: 7, minus: 0, binary: 0 }, en), "3 files changed, 7 insertions(+)");
  assert.equal(row({ files: 2, plus: 4, minus: 0, binary: 1 }, de), "2 Dateien geändert (1 binär), 4 Einfügungen(+)");
  assert.equal(row({ files: 1, plus: 0, minus: 0, binary: 1 }, de), "1 Datei geändert (1 binär)", "a changed binary file — never hidden as \"0 lines\"");
  assert.equal(row({ files: 1, plus: 0, minus: 0, binary: 1 }, en), "1 file changed (1 binary)");
  assert.equal(row({ files: 0, plus: 0, minus: 0, binary: 0 }, de), "Keine Dateien geändert.");
  assert.equal(row({ files: 0, plus: 0, minus: 0, binary: 0 }, en), "No files changed.");
  // Every key the row can ever use is in i18n-de.ts.
  const key = new Set();
  for (const d of [0, 1, 2]) for (const p of [0, 1, 2]) for (const mi of [0, 1, 2]) for (const b of [0, 1]) {
    if (b > d) continue;
    for (const x of m.countsParts({ files: d, plus: p, minus: mi, binary: b })) key.add(x.key);
  }
  for (const k of key) assert.ok(k in DE, `"${k}" is missing in i18n-de.ts`);
}
const C = { hash: "a".repeat(40), short: "aaaaaaaa", subject: "Subject", author: "Maintainer", time: 1_790_000_000, parents: ["p1"] };
const INFO = {
  hash: C.hash, parent: ["p1", "p2"], author: "Jörg Müller", email: "j@example.com", time: 1_789_000_000_000, message: "Subject\n\nBody",
  messageClipped: false, counts: { files: 1, plus: 92, minus: 79, binary: 0 }, countsClipped: false,
};
function checkData(m) {
  const without = m.cardsData(C, null);
  assert.deepEqual(without, {
    hash: C.hash, short: "aaaaaaaa", author: "Maintainer", email: null, time: 1_790_000_000_000, message: "Subject", messageClipped: false,
    counts: null, countsClipped: false, merge: false,
  }, "without answer (old server, loading): what the graph knows — commit time in ms, NO numbers");
  const including = m.cardsData(C, INFO);
  assert.deepEqual([including.author, including.email, including.time, including.message, including.counts, including.merge], ["Jörg Müller", "j@example.com", INFO.time, "Subject\n\nBody", INFO.counts, true]);
  assert.deepEqual(m.cardsData(C, { ...INFO, hash: "b".repeat(40) }), without, "the answer of ANOTHER commit never lands in this card");
  assert.deepEqual(m.cardsData({ ...C, time: null }, null).time, null, "no time without a time (not 1970)");
  assert.equal(m.cardsData({ ...C, short: "" }, null).short, "aaaaaaaa");
  assert.equal(m.cardsData(C, { ...INFO, counts: null, countsClipped: true }).countsClipped, true);
}
function checkSituation(m) {
  const F = { w: 1600, h: 1000 };
  const K = { w: 400, h: 220 };
  const bar = { left: 1240, right: 1600, top: 0, bottom: 1000 };
  const row = (top) => ({ left: 1244, right: 1596, top, bottom: top + 22 });
  assert.deepEqual(m.cardsSituation(row(300), bar, K, F), { left: 834, top: 300, width: 400, maxHeight: 984, page: "left" }, "left of the bar, flush at the top with the row");
  assert.deepEqual(m.cardsSituation(row(950), bar, K, F), { left: 834, top: 772, width: 400, maxHeight: 984, page: "left" }, "a row at the bottom of the window pushes the card up");
  assert.equal(m.cardsSituation(row(2), bar, K, F).top, 8, "at the top edge: not beyond the window");
  // Narrow window: no room on the left — below, right-aligned with the bar; no room at the bottom — above.
  const narrow = { w: 600, h: 1000 };
  const l2 = { left: 240, right: 600, top: 0, bottom: 1000 };
  assert.deepEqual(m.cardsSituation({ left: 244, right: 596, top: 300, bottom: 322 }, l2, K, narrow), { left: 192, top: 328, width: 400, maxHeight: 984, page: "bottom" });
  assert.deepEqual(m.cardsSituation({ left: 244, right: 596, top: 900, bottom: 922 }, l2, K, narrow), { left: 192, top: 674, width: 400, maxHeight: 984, page: "top" });
  const low = m.cardsSituation({ left: 244, right: 596, top: 100, bottom: 122 }, l2, K, { w: 600, h: 300 });
  assert.deepEqual([low.page, low.top], ["bottom", 72], "fits nowhere entirely: where there is more room, kept in the window");
  const tiny = m.cardsSituation({ left: 10, right: 290, top: 50, bottom: 72 }, { left: 0, right: 300, top: 0, bottom: 600 }, K, { w: 300, h: 600 });
  assert.deepEqual([tiny.left, tiny.width], [8, 284], "never wider than the window");
  // The grid: every position lies in the window; on the left never over the bar.
  for (const fw of [320, 700, 1200, 1920]) for (const fh of [240, 600, 1080]) for (const lb of [272, 360, 640]) for (const kh of [80, 220, 900]) for (const zt of [0, 0.3, 0.97]) {
    const window = { w: fw, h: fh };
    const l = { left: Math.max(0, fw - lb), right: fw, top: 0, bottom: fh };
    const top = Math.round(zt * (fh - 22));
    const situation = m.cardsSituation({ left: l.left + 4, right: fw - 4, top, bottom: top + 22 }, l, { w: 400, h: kh }, window);
    const h = Math.min(kh, situation.maxHeight);
    const what = JSON.stringify({ fw, fh, lb, kh, zt, situation });
    assert.ok(situation.left >= 8 && situation.left + situation.width <= fw - 8 + 1e-9, `out of the window (x): ${what}`);
    assert.ok(situation.top >= 8 && situation.top + h <= fh - 8 + 1e-9, `out of the window (y): ${what}`);
    if (situation.page === "left") assert.ok(situation.left + situation.width <= l.left - 6, `left over the bar: ${what}`);
  }
}
// Lower bounds only (no upper duration is checked — latch "upper duration limits" in server/backend/test/clock-counts.test.js):
// they catch what would be broken — no dwell (a sweep asks per row), a switch without distance to the first dwell, no time to
// move into the card.
function checkClocks(m) {
  assert.ok(m.CARD_DWELL_MS >= 300, `dwell ${m.CARD_DWELL_MS} ms — expected ~400 ms`);
  assert.ok(m.CARD_SWITCH_MS >= 80, "the switch does not ask per row when sweeping over the list");
  assert.ok(m.CARD_DWELL_MS - m.CARD_SWITCH_MS >= 100, "the switch is noticeably faster than the first dwell");
  assert.ok(m.CARD_GRACE_MS >= 150, "the grace period suffices to move into the card");
}
function check(m) { checkTime(m); checkCounts(m); checkData(m); checkSituation(m); checkClocks(m); }

test("time: \"10 months ago\" in the steps of VS Code, full date with time (de/en)", () => checkTime(real));
test("numbers row: singular/plural in de and en, zero parts dropped, binary files stated", () => checkCounts(real));
test("what the card shows: only its own answer, without it the graph and no numbers", () => checkData(real));
test("position: left of the bar at the height of the row, otherwise below/above, never out of the window", () => checkSituation(real));
test("clocks: dwell like VS Code, switch faster, grace period to move in", () => checkClocks(real));
test("sabotage git-card.ts: every place turns the check red", () => {
  for (const s of sabotaged) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/git-card.ts`);
    assert.throws(() => check(s.mod), `sabotage "${s.name}" stays green`);
  }
});

// ── The allowlist (lib/api/git.ts normGitCommitInfo) ─────────────────────────────────────────────────────────────────────────────
const H = "c0ffee".padEnd(40, "1");
const FULL = { hash: H, parent: ["p1"], author: "Jörg", email: "j@x", time: 1_790_000_000_000, message: "B\n\nR", messageClipped: false, files: 2, plus: 3, minus: 1, binary: 1, countsClipped: false };
function checkInfoNorm(m) {
  const n = m.normGitCommitInfo;
  assert.equal(n({ hash: H, diff: "commit …" }, H), null, "an old server (the whole commit) is \"unknown\", no card with 0");
  assert.equal(n(null, H), null);
  assert.equal(n({ ...FULL, hash: "f".repeat(40) }, H), null, "the answer of another commit");
  assert.equal(n(FULL, ""), null);
  assert.deepEqual(n(FULL, H), {
    hash: H, parent: ["p1"], author: "Jörg", email: "j@x", time: 1_790_000_000_000, message: "B\n\nR", messageClipped: false,
    counts: { files: 2, plus: 3, minus: 1, binary: 1 }, countsClipped: false,
  });
  assert.equal(n(FULL, H.slice(0, 7)).hash, H, "asked for a short hash, the full one comes back");
  const { plus: _p, ...withoutPlus } = FULL;
  assert.equal(n(withoutPlus, H).counts, null, "if a number is missing, the whole block is unknown — never a silent 0");
  assert.equal(n({ ...FULL, minus: -1 }, H).counts, null);
  assert.equal(n({ ...FULL, files: 1.5 }, H).counts, null);
  assert.equal(n({ ...FULL, binary: 3 }, H).counts, null, "more binary files than files is nonsense");
  assert.equal(n({ ...FULL, files: [{ path: "a", status: "M" }] }, H).counts, null, "the file list of another option is not a number");
  assert.deepEqual(n({ ...FULL, files: null, plus: null, minus: null, binary: null, countsClipped: true }, H).counts, null);
  const empty = n({ hash: H, author: "", message: "" }, H);
  assert.deepEqual([empty.email, empty.time, empty.parent, empty.messageClipped, empty.countsClipped], [null, null, null, null, null], "what the server does not say is unknown");
  assert.equal(n({ ...FULL, time: "yesterday" }, H).time, null);
}
test("normGitCommitInfo: a missing field is no statement (with counter-proof)", () => {
  checkInfoNorm(apiGit);
  for (const s of sabotagedApi) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/api/git.ts`);
    assert.throws(() => checkInfoNorm(s.mod), `sabotage "${s.name}" stays green`);
  }
});

// ── Translations of the card ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Every `t("…")` key in CommitCard.tsx is in i18n-de.ts (a missing one silently shows German in English — the web build says
// nothing about it). The keys of the numbers row come from git-card.ts and are checked above.
const tKey = (src) => [...new Set([...src.matchAll(/(?<![\w$.])t\("([^"]+)"/g)].map((x) => x[1]))];
function checkTranslated(src, en) {
  const keys = tKey(src);
  if (keys.length < 5) throw new Error(`CommitCard.tsx: only ${keys.length} t("…") keys read`);
  const missing = keys.filter((k) => !(k in en));
  assert.deepEqual(missing, [], `without a German row in i18n-de.ts: ${missing.join(" · ")}`);
  return keys.length;
}
test("translations: every t(\"…\") key of the card is in i18n-de.ts (with counter-proof)", (t) => {
  const src = read("src", "components", "git-bar", "CommitCard.tsx");
  t.diagnostic(`${checkTranslated(src, DE)} keys`);
  const without = { ...DE };
  delete without["Copy hash"];
  assert.throws(() => checkTranslated(src, without), /Copy hash/, "a missing key stays green");
  assert.throws(() => checkTranslated("", DE), /only 0/, "a reader that finds nothing stays green");
});

// ── The seam to the server: the fields of the answer ────────────────────────────────────────────────────────────────────────────────────
// The ONE list lives in the server (git.js `COMMIT_INFO_FIELDS`); that the route sends exactly these fields is held by
// server/backend/test/git-commit-files.test.js. Here the other half: `normGitCommitInfo` reads EXACTLY these fields (no field the
// server never sends — it would stay silently `null`; none that it sends and that gets lost here), and each survives the
// normalisation. Read by path as a literal (git.js is not a leaf — it would pull the starters along); the anchor throws instead
// of delivering an empty list.
const gitJs = fs.readFileSync(path.resolve(webDir, "..", "server", "backend", "electron", "server", "git.js"), "utf8");
function infoFields(src) {
  const m = /^export const COMMIT_INFO_FIELDS = \[([^\]]*)\];$/m.exec(src);
  if (!m) throw new Error("server git.js: `export const COMMIT_INFO_FIELDS = [ … ];` not found");
  const fields = [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
  if (fields.length < 5) throw new Error(`server git.js: COMMIT_INFO_FIELDS read with only ${fields.length} fields`);
  return fields;
}
function normBody(api) {
  const i = api.indexOf("export function normGitCommitInfo(");
  if (i < 0) throw new Error("lib/api/git.ts: normGitCommitInfo not found");
  const j = api.indexOf("\n}\n", i);
  if (j < 0) throw new Error("lib/api/git.ts: end of normGitCommitInfo not found");
  return api.slice(i, j);
}
const PROBE = { hash: H, parent: ["p1", "p2"], author: "Jörg", email: "j@x", time: 1_790_000_000_000, message: "B\n\nR", messageClipped: true, files: 3, plus: 2, minus: 1, binary: 1, countsClipped: false };
const COUNT_FIELDS = ["files", "plus", "minus", "binary"];
function checkSeam(fields, apiSrc, norm) {
  const read = [...new Set([...normBody(apiSrc).matchAll(/\bo\.([A-Za-z]+)/g)].map((x) => x[1]))].sort();
  assert.deepEqual(read, [...fields].sort(), "normGitCommitInfo reads other fields than the server sends (COMMIT_INFO_FIELDS)");
  for (const f of fields) assert.ok(f in PROBE, `the server field "${f}" is unknown to this probe — and to the card`);
  const w = norm(Object.fromEntries(fields.map((f) => [f, PROBE[f]])), H);
  assert.ok(w, "an answer made of exactly the fields of the server is discarded");
  for (const f of fields) assert.deepEqual(COUNT_FIELDS.includes(f) ? w.counts?.[f] : w[f], PROBE[f], `the field "${f}" gets lost in the normalisation`);
}
test("seam: normGitCommitInfo reads exactly the fields the server sends (COMMIT_INFO_FIELDS in git.js, with counter-proof)", (t) => {
  const fields = infoFields(gitJs);
  checkSeam(fields, apiSource, apiGit.normGitCommitInfo);
  t.diagnostic(`${fields.length} fields: ${fields.join(", ")}`);
  // The server renames a field, the web does not follow ⇒ red.
  assert.throws(() => checkSeam(fields.map((f) => (f === "plus" ? "insertions" : f)), apiSource, apiGit.normGitCommitInfo), "a renamed server field stays green");
  // A new field in the server that the card does not read ⇒ red.
  assert.throws(() => checkSeam([...fields, "signature"], apiSource, apiGit.normGitCommitInfo), "a new server field stays green");
  // The web reads a field the server does not send ⇒ red (on the compiled sabotage copy).
  const s = sabotagedApi.find((x) => x.name === "reads a field the server does not send");
  assert.ok(s?.applies, "sabotage \"reads a field the server does not send\" no longer applies");
  const { old, fresh } = SABOTAGES_API[s.name];
  assert.throws(() => checkSeam(fields, apiSource.replace(old, fresh), s.mod.normGitCommitInfo), "a field the server never sends stays green");
  // The anchor throws instead of reading empty.
  assert.throws(() => infoFields(gitJs.replace("export const COMMIT_INFO_FIELDS", "export const COMMIT_FIELDS")), /not found/);
});

// ── Binding: CommitCard.tsx, GitGraph.tsx, GitSidebar.tsx, globals.css ────────────────────────────────────────────────────────────
// On the source text without comment lines (like git-graph.test.mjs): a comment naming the call is not a call.
const code = (s) => s.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*)/.test(z)).join("\n").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `"${a}" is missing`); const j = s.indexOf(b, i); return s.slice(i, j < 0 ? undefined : j); };
function checkBinding({ card, graph, bar, css }) {
  // Loading: through the path builder, with `info: true`, through the allowlist, once per hash (again after an error).
  const calls = [...card.matchAll(/\bapi(?:<[^(]*?>)?\(/g)].map((x) => card.slice(x.index + x[0].length, x.index + x[0].length + 40));
  assert.equal(calls.length, 1, `CommitCard.tsx: ${calls.length} api calls instead of one`);
  assert.ok(/api<unknown>\(path\("\/git\/show"\), \{ method: "POST", body: JSON\.stringify\(\{ repo: rel, hash, info: true \}\) \}\)/.test(card), "the card does not ask through the path builder with `info: true`");
  assert.ok(/const w = normGitCommitInfo\(raw, hash\);/.test(card), "the answer does not pass normGitCommitInfo (with the hash of the request)");
  assert.ok(/if \(present && present\.kind !== "error"\) return;/.test(card), "the info is not kept per hash (or not asked again after an error)");
  // Only after the dwell: the ONLY call of `load` is in `show`, and `show` runs only from the clock of `plane`.
  assert.equal((card.match(/\bload\(/g) || []).length, 1, "load( is called in more than one place");
  assert.ok(/\bload\(/.test(between(card, "const show = useCallback(", "const plane = useCallback(")), "load( is not in show");
  assert.ok(/window\.setTimeout\(\(\) => \{ clocks\.current\.show = null; show\(z\); \}, ms\)/.test(card), "show does not run from the dwell clock");
  assert.ok(/warm \? CARD_SWITCH_MS : CARD_DWELL_MS/.test(card) && /from "@\/lib\/git-card"/.test(card), "the clocks do not come from lib/git-card.ts");
  for (const v of ["setInterval(", "EventSource", "useGitState(", "requestAnimationFrame("]) assert.ok(!card.includes(v), `CommitCard.tsx contains ${v} — no timer`);
  // Blocking and closing.
  assert.ok(/if \(turn \|\| e\.buttons !== 0 \|\| quietFor\.current === c\.hash\) return;/.test(card), "during a drag (or with a pressed button) the card would appear");
  assert.ok(/useEffect\(\(\) => \{ if \(locked\) hide\(\); \}, \[locked, hide\]\);/.test(card), "a starting drag does not close the card");
  assert.ok(/if \(e\.key !== "Escape"\) return;/.test(card), "Escape does not close the card");
  assert.ok(/matches\?\.\(":focus-visible"\)/.test(card), "the keyboard gets no card (or every mouse click gets one)");
  // Shape: on the body, `cb-kit` + `cb-pop`, role tooltip, no click catcher, the position from cardsSituation, the colours of A/D.
  assert.ok(/createPortal\([\s\S]{0,400}document\.body/.test(card), "the card is not attached to the body via a portal");
  assert.ok(/className=\{`cb-pop [^`]*cb-kit /.test(card), "the card does not carry cb-pop + cb-kit");
  assert.ok(/role="tooltip"/.test(card) && /id=\{id\}/.test(card), "the card is not a describing element with an id");
  assert.ok(!/fixed inset-0/.test(card), "click catcher as fixed inset-0");
  assert.ok(/const n = cardsSituation\(z, l, /.test(card) && /closest\("\[data-git-bar\]"\)/.test(card), "the position does not come from cardsSituation against the bar");
  assert.ok(/plus: KIND_COLOR\.added, minus: KIND_COLOR\.deleted/.test(card), "insertions/deletions not in the colours of \"A\"/\"D\"");
  assert.ok(/countsParts\(d\.counts\)/.test(card) && /relativeTime\(d\.time, now, locale\)/.test(card) && /fullDate\(d\.time, locale\)/.test(card), "the card computes time or numbers itself");
  // GitGraph: listeners on the wrapper of the commit row (not on the file rows), aria-describedby, the card mounted, no clock.
  const row = between(graph, "const CommitRow = memo(", "function CommitFiles(");
  assert.ok(/onPointerEnter=\{\(e\) => pointer\.enter\(c, e\)\}/.test(row) && /onPointerLeave=\{\(\) => pointer\.out\(c\)\}/.test(row), "the commit row does not report enter/leave");
  assert.ok(/onPointerDown=\{\(\) => pointer\.press\(c\)\}/.test(row) && /onFocus=\{\(e\) => pointer\.focus\(c, e\)\}/.test(row) && /onBlur=\{\(e\) => pointer\.focusLost\(c, e\)\}/.test(row), "press or focus are missing on the commit row");
  assert.ok(/aria-describedby=\{cardId \?\? undefined\}/.test(row), "the commit row does not refer to its card (aria-describedby)");
  assert.ok(!/pointer\./.test(between(graph, "function CommitFiles(", "// ── The strip of a row")), "file rows carry the listeners of the card");
  assert.ok(/const card = useCommitCard\(\{ path, rel, locked: turn \}\);/.test(graph) && /\{card\.card\}/.test(graph), "GitGraph.tsx does not mount the card (or without path builder/turn)");
  assert.ok(!graph.includes("setTimeout("), "GitGraph.tsx contains a clock — the clocks of the card live in CommitCard.tsx");
  // The dot: CSS on every circle, +2 px; the lanes still depend only on the log (no recomputation on hover).
  assert.equal((graph.match(/className="cb-git-dot"/g) || []).length, 4, "not every circle of the dot carries .cb-git-dot");
  assert.ok(/const PLUS_R = 2;/.test(graph), "the dot does not grow by 2 px");
  assert.ok(/const computation = useMemo\(\(\) => \(log \? computeLanes\(log\.commits\) : null\), \[log\]\);/.test(graph), "the lanes depend on more than the log");
  assert.ok(/\[data-git-commit-row\]:is\(:hover, :has\(:focus-visible\), \[data-card\]\) \.cb-git-dot \{ r: var\(--point-large\); \}/.test(css), "globals.css does not enlarge the dot (hover, focus, card)");
  assert.ok(/\.cb-git-dot \{ transition: r 120ms ease-out; \}/.test(css), "the dot grows without a transition");
  // GitSidebar: the drag comes from the stack.
  assert.ok(/turn: dragging !== null \|\| splitDrag !== null,/.test(bar), "the stack does not report every drag (head AND gap)");
  assert.ok(/const \{ turn \} = useContext\(StackK\);/.test(bar) && / turn=\{turn\} \/>/.test(bar), "the \"Graph\" section does not pass the drag to the graph");
}
test("binding: the card loads only after the dwell through the path builder, hangs on the commit row; the dot grows via CSS (with counter-proof)", () => {
  const parts = {
    card: code(read("src", "components", "git-bar", "CommitCard.tsx")),
    graph: code(read("src", "components", "git-bar", "GitGraph.tsx")),
    bar: code(read("src", "components", "GitSidebar.tsx")),
    css: read("src", "app", "globals.css"),
  };
  checkBinding(parts);
  const including = (part, old, fresh) => ({ ...parts, [part]: parts[part].replace(old, fresh), applies: parts[part].includes(old) });
  const sabotages = {
    "loading already on enter": including("card", "        if (turn || e.buttons !== 0 || quietFor.current === c.hash) return;", "        load(c.hash);\n        if (turn || e.buttons !== 0 || quietFor.current === c.hash) return;"),
    "answer without allowlist": including("card", "const w = normGitCommitInfo(raw, hash);", "const w = raw as GitCommitInfo;"),
    "asked again on every show": including("card", `if (present && present.kind !== "error") return;`, ""),
    "bypassing the path builder": including("card", `api<unknown>(path("/git/show")`, "api<unknown>(`/api/git/show`"),
    "with its own timer": including("card", "  const cardEl = useRef<HTMLDivElement>(null);", "  const cardEl = useRef<HTMLDivElement>(null);\n  useEffect(() => { const u = setInterval(() => {}, 5000); return () => clearInterval(u); }, []);"),
    "drag ignored": including("card", "if (turn || e.buttons !== 0 || ", "if ("),
    "card in the tree instead of on the body": including("card", "      document.body,\n", "      target.anchor,\n"),
    "own colours of the numbers": including("card", "plus: KIND_COLOR.added, minus: KIND_COLOR.deleted", `plus: "text-green-500", minus: "text-red-500"`),
    "file rows with listeners": including("graph", `<div role="group" aria-label=`, `<div onPointerEnter={(e) => pointer.rein(c, e)} role="group" aria-label=`),
    "without aria-describedby": including("graph", "aria-describedby={cardId ?? undefined}", ""),
    "clock in the graph": including("graph", "  const card = useCommitCard({ path, rel, locked: turn });", "  const card = useCommitCard({ path, rel, locked: turn });\n  useEffect(() => { const u = setTimeout(() => {}, 400); return () => clearTimeout(u); }, []);"),
    "lanes recomputed on hover": including("graph", "computeLanes(log.commits) : null), [log]);", "computeLanes(log.commits) : null), [log, card.active]);"),
    "dot does not grow": including("css", "[data-git-commit-row]:is(:hover, :has(:focus-visible), [data-card]) .cb-git-dot { r: var(--point-large); }", ""),
    "drag not passed on": including("bar", " turn={turn} />", " />"),
    "gap no drag": including("bar", "turn: dragging !== null || splitDrag !== null,", "turn: dragging !== null,"),
  };
  for (const [name, { applies, ...s }] of Object.entries(sabotages)) {
    assert.ok(applies, `sabotage "${name}" no longer applies (wording changed?)`);
    assert.throws(() => checkBinding(s), `sabotage "${name}" stays green`);
  }
});
