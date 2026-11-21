// The timeline of the active file as in VS Code: lib/timeAxis.ts, EXECUTED. The repo of the file is the one with the longest
// matching path and its path inside it is relative to it; no file, or none inside a repo, is VS Code's empty state; repos NOT YET
// READ are "unknown" (never "no repo"); the answer goes through an allow list (an old server without `entries` is unknown, not
// empty; broken entries drop out, nothing is invented); an entry opens the diff of its commit for the file THERE, with the old
// path on a rename. As in VS Code: the relative time `fromNow` (no "ago", short units), a time equal to the one above is not
// repeated (`hideRelativeTime`), the page is as large as the view (at least 20), "Load more" via a cursor (hash + path THERE);
// "Open commit" (the whole commit). Titles exactly as in VS Code 1.143 (Git extension): the diff "{0} ({1}) ↔ {0} ({2})" with
// the name of the file TODAY, the predecessor on the left (the next older entry, the empty tree for the oldest, unknown before
// an unloaded page => `<ref>^`), references at eight characters (`shortRef`, a "^" stays); the whole commit "<shortRef> - <first
// line>"; the source carries the file today (`current`) and the predecessor (`prior`).
// Every sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/timeAxis.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "timeAxis.ts"), "utf8");

const SABOTAGES = {
  "unread means no repo": { old: "if (!relPaths) return { kind: \"unknown\" };", fresh: "if (!relPaths) return { kind: \"no-repo\" };", catches: "target" },
  "first instead of longest repo": { old: "if (best === null || r.length > best.length) best = r;", fresh: "if (best === null) best = r;", catches: "target" },
  "prefix without slash": { old: "path.startsWith(`${r}/`)", fresh: "path.startsWith(r)", catches: "target" },
  "path not relative to the repo": { old: "file: best ? path.slice(best.length + 1) : path", fresh: "file: path", catches: "target" },
  "old server means empty": { old: "if (!raw || typeof raw !== \"object\" || !Array.isArray((raw as { entries?: unknown }).entries)) return null;", fresh: "if (!raw || typeof raw !== \"object\" || !Array.isArray((raw as { entries?: unknown }).entries)) return { entries: [], clipped: false };", catches: "norm" },
  "hash unchecked": { old: "if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || !file) continue;", fresh: "if (!hash || !file) continue;", catches: "norm" },
  "time invented": { old: "const time = typeof e.time === \"number\" && Number.isFinite(e.time) ? e.time : null;", fresh: "const time = Number(e.time) || 0;", catches: "norm" },
  "clipped from truthiness": { old: "clipped: r.clipped === true", fresh: "clipped: Boolean(r.clipped)", catches: "norm" },
  "old equals new": { old: "...(old && old !== file ? { old: old } : {})", fresh: "...(old ? { old: old } : {})", catches: "norm" },
  "source without old path": { old: ", ...(e.old ? { old: e.old } : {})", fresh: "", catches: "source" },
  "current also when equal to the path there": { old: "...(o.current && o.current !== e.file ? { current: o.current } : {})", fresh: "...(o.current ? { current: o.current } : {})", catches: "source" },
  "source without predecessor": { old: ", ...(o.prior ? { prior: o.prior } : {})", fresh: "", catches: "source" },
  "cap 100": { old: "export const TIME_AXIS_CAP = 200;", fresh: "export const TIME_AXIS_CAP = 100;", catches: "page" },
  "open commit only for the file": { old: "return { kind: \"commit-whole\", repo, hash: e.hash };", fresh: "return { kind: \"commit-whole\", repo, hash: e.hash, file: e.file } as never;", catches: "source" },
  "commit title with the short hash of the server": { old: "return `${shortRef(e.hash)} - ${i < 0 ? e.subject : e.subject.slice(0, i)}`;", fresh: "return `${e.short} - ${i < 0 ? e.subject : e.subject.slice(0, i)}`;", catches: "source" },
  "commit title with the whole message": { old: "${i < 0 ? e.subject : e.subject.slice(0, i)}", fresh: "${e.subject}", catches: "source" },
  "title without parent": { old: "return `${n} (${shortRef(prior || `${ref}^`)}) ↔ ${n} (${shortRef(ref)})`;", fresh: "return `${n} (Commit ${shortRef(ref)})`;", catches: "source" },
  "title on the left always ref^": { old: "shortRef(prior || `${ref}^`)", fresh: "shortRef(`${ref}^`)", catches: "source" },
  "reference at seven characters": { old: ": ref.slice(0, 8);", fresh: ": ref.slice(0, 7);", catches: "reference" },
  "caret drops": { old: "ref.endsWith(\"^\") ? `${ref.slice(0, 8)}^` : ", fresh: "", catches: "reference" },
  "wrong empty tree": { old: "\"4b825dc642cb6eb9a060e54bf8d69288fbee4904\"", fresh: "\"0000000000000000000000000000000000000000\"", catches: "reference" },
  "predecessor always the empty tree": { old: "entries[i + 1]?.hash ?? (more ? null : EMPTY_TREE)", fresh: "EMPTY_TREE", catches: "reference" },
  "empty tree before an unloaded page": { old: "(more ? null : EMPTY_TREE)", fresh: "EMPTY_TREE", catches: "reference" },
  "with \"ago\"": { old: "const unit = (n: number, one: string, more: string) => (n === 1 ? t(one) : t(more, { n }));", fresh: "const unit = (n: number, one: string, more: string) => t(\"{time} ago\", { time: n === 1 ? t(one) : t(more, { n }) });", catches: "time" },
  "now up to one minute": { old: "if (sec < 30) return t(\"now\");", fresh: "if (sec < 60) return t(\"now\");", catches: "time" },
  "week is 30 days": { old: "if (sec < WEEK) return unit(Math.floor(sec / DAY), \"1 day\", \"{n} days\");", fresh: "if (sec < MONTH) return unit(Math.floor(sec / DAY), \"1 day\", \"{n} days\");", catches: "time" },
  "future is now": { old: "if (sec < -30) return t(\"in {time}\", { time: shortTime(now + (now - ms), now, t) });", fresh: "", catches: "time" },
  "every time repeated": { old: "const duplicate = prior !== undefined && time === prior;", fresh: "const duplicate = false;", catches: "column" },
  "duplicate against the first": { old: "    prior = time;\n", fresh: "    if (prior === undefined) prior = time;\n", catches: "column" },
  "page fixed at 50": { old: "return Math.min(TIME_AXIS_CAP, Math.max(20, Math.floor(height / TIME_AXIS_ROW) - 1));", fresh: "return 50;", catches: "page" },
  "page without minimum": { old: "Math.max(20, Math.floor(height / TIME_AXIS_ROW) - 1)", fresh: "Math.floor(height / TIME_AXIS_ROW) - 1", catches: "page" },
  "cursor without path there": { old: "{ after: last.hash, file: last.file }", fresh: "{ after: last.hash, file: d.entries[0].file }", catches: "page" },
  "cursor even without older ones": { old: "return d.clipped && last ?", fresh: "return last ?", catches: "page" },
  "pages twice": { old: "...fresh.entries.filter((e) => !present.has(e.hash))", fresh: "...fresh.entries", catches: "page" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-time-axis-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "timeAxis.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `time-axis-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const H = "a".repeat(40), H2 = "b".repeat(40);
const CHECKS = {
  target: (m) => {
    assert.deepEqual(m.timeAxisTarget(null, [""]), { kind: "no-file" });
    assert.deepEqual(m.timeAxisTarget("src/a.ts", null), { kind: "unknown" }, "repos not yet read are unknown, not \"no repo\"");
    assert.deepEqual(m.timeAxisTarget("src/a.ts", []), { kind: "no-repo" });
    assert.deepEqual(m.timeAxisTarget("src/a.ts", [""]), { kind: "ok", repo: "", file: "src/a.ts" });
    assert.deepEqual(m.timeAxisTarget("web/src/a.ts", ["", "web", "web/src/x"]), { kind: "ok", repo: "web", file: "src/a.ts" }, "the repo with the longest matching path");
    assert.deepEqual(m.timeAxisTarget("webkit/a.ts", ["web"]), { kind: "no-repo" }, "\"web\" is not the folder of \"webkit/…\"");
  },
  norm: (m) => {
    assert.equal(m.normTimeAxis({ commits: [] }), null, "an old server (without `entries`) is unknown, not empty");
    assert.equal(m.normTimeAxis(null), null);
    const d = m.normTimeAxis({
      entries: [
        { hash: H, short: "aaaaaaa", subject: "Fresh", author: "Maintainer", email: "k@x", time: 1700000000, file: "b.txt", old: "a.txt" },
        { hash: "no-hash", file: "x" }, { hash: H2 }, "nonsense",
        { hash: H2, file: "b.txt", old: "b.txt", time: "yesterday" },
      ],
      clipped: "yes",
    });
    assert.equal(d.entries.length, 2, "broken entries drop out");
    assert.deepEqual(d.entries[0], { hash: H, short: "aaaaaaa", subject: "Fresh", author: "Maintainer", email: "k@x", time: 1700000000, file: "b.txt", old: "a.txt" });
    assert.deepEqual(d.entries[1], { hash: H2, short: "bbbbbbb", subject: "", author: "", email: null, time: null, file: "b.txt" }, "missing is unknown (null), no old path equal to the new one");
    assert.equal(d.clipped, false, "only an explicit true means clipped");
    assert.equal(m.normTimeAxis({ entries: [], clipped: true }).clipped, true);
  },
  source: (m) => {
    // VS Code `git.timeline.openDiff`: title "{0} ({1}) ↔ {0} ({2})", {0} the name of the timeline resource (the file TODAY), {1} the
    // predecessor, {2} the commit, both `shortenRef` (eight characters).
    assert.equal(m.diffTitle("web/README.md", H, H2), "README.md (bbbbbbbb) ↔ README.md (aaaaaaaa)", "the title of the diff as in VS Code");
    assert.equal(m.diffTitle("README.md", "abc1234def"), "README.md (abc1234d^) ↔ README.md (abc1234d)", "without a known predecessor \"<ref>^\"");
    const e = { hash: H, short: "a", subject: "", author: "", email: null, time: null, file: "b.txt", old: "a.txt" };
    assert.deepEqual(m.entrySource("web", e), { kind: "commit", repo: "web", hash: H, file: "b.txt", old: "a.txt" }, "the diff of the commit for the file there, with the old path");
    const { old: _a, ...without } = e;
    assert.deepEqual(m.entrySource("", without), { kind: "commit", repo: "", hash: H, file: "b.txt" });
    assert.deepEqual(m.entrySource("web", e, { current: "c.txt", prior: H2 }), { kind: "commit", repo: "web", hash: H, file: "b.txt", old: "a.txt", current: "c.txt", prior: H2 },
      "the file today (renamed) and the predecessor travel along in the source");
    assert.deepEqual(m.entrySource("web", without, { current: "b.txt", prior: null }), { kind: "commit", repo: "web", hash: H, file: "b.txt" }, "if it is called today as there, no `current`");
    // "Open commit" (VS Code `timeline.viewCommit`): the WHOLE commit, title "<shortRef> - <first line>".
    assert.deepEqual(m.commitSource("web", e), { kind: "commit-whole", repo: "web", hash: H }, "\"Open commit\" shows the whole commit");
    assert.equal(m.commitTitle({ ...e, short: "aaaaaaa", subject: "Fix" }), "aaaaaaaa - Fix", "the title of the whole commit (eight characters)");
    assert.equal(m.commitTitle({ ...e, short: "aaaaaaa", subject: "Fix\nmore" }), "aaaaaaaa - Fix", "only the first line");
  },
  reference: (m) => {
    assert.equal(m.EMPTY_TREE, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "the empty tree of Git");
    assert.equal(m.shortRef(H), "aaaaaaaa");
    assert.equal(m.shortRef(`${H}^`), "aaaaaaaa^", "a \"^\" stays");
    assert.equal(m.shortRef("HEAD"), "HEAD");
    const a = { hash: H, short: "a", subject: "", author: "", email: null, time: null, file: "x" }, b = { ...a, hash: H2 };
    assert.equal(m.priorOf([a, b], 0), H2, "the next older entry");
    assert.equal(m.priorOf([a, b], 1), m.EMPTY_TREE, "the oldest: the empty tree");
    assert.equal(m.priorOf([a, b], 1, true), null, "before an unloaded page: unknown");
    assert.equal(m.priorOf([a, b], 0, true), H2);
  },
  // VS Code `fromNow(t)`: limits 30 s, 1 min, 1 h, 1 d, 7 d, 30 d, 365 d; singular/plural via keys of their own.
  time: (m) => {
    const t = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, x) => String(w[x])) : k);
    const J = 1_800_000_000_000, before = (s) => m.shortTime(J - s * 1000, J, t);
    assert.equal(before(0), "now");
    assert.equal(before(29), "now");
    assert.equal(before(45), "45 secs");
    assert.equal(before(60), "1 min");
    assert.equal(before(150), "2 mins");
    assert.equal(before(3600), "1 hr");
    assert.equal(before(86_400 * 3), "3 days", "\"3 days\", not \"3 days ago\"");
    assert.equal(before(86_400), "1 day");
    assert.equal(before(86_400 * 7), "1 wk");
    assert.equal(before(86_400 * 20), "2 wks");
    assert.equal(before(86_400 * 30), "1 mo");
    assert.equal(before(86_400 * 364), "12 mos");
    assert.equal(before(86_400 * 365 * 3), "3 yrs");
    assert.equal(before(-600), "in 10 mins", "a time ahead (clock set wrong)");
    assert.equal(before(-10), "now");
  },
  column: (m) => {
    const t = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, x) => String(w[x])) : k);
    const J = 1_800_000_000, e = (sec) => ({ hash: H, short: "a", subject: "", author: "", email: null, time: sec === null ? null : J - sec, file: "x" });
    const z = m.timeColumn([e(86_400 * 3), e(86_400 * 3 + 5), e(86_400 * 3 + 9), e(86_400 * 10), e(null), e(86_400 * 10 + 1)], J * 1000, t);
    assert.deepEqual(z.map((x) => x.text), ["3 days", "3 days", "3 days", "1 wk", null, "1 wk"]);
    assert.deepEqual(z.map((x) => x.duplicate), [false, true, true, false, false, true], "the same time as above is not repeated (VS Code hideRelativeTime)");
  },
  page: (m) => {
    assert.equal(m.TIME_AXIS_CAP, 200, "at most the cap of the server per page");
    assert.equal(m.pagesSize(0), 20, "at least 20 (VS Code)");
    assert.equal(m.pagesSize(22 * 40), 39, "as many as the view shows, minus one");
    assert.equal(m.pagesSize(22 * 1000), 200, "never over the cap");
    const s1 = { entries: [{ hash: H, short: "a", subject: "", author: "", email: null, time: 1, file: "fresh.txt" }, { hash: H2, short: "b", subject: "", author: "", email: null, time: 1, file: "old.txt" }], clipped: true };
    assert.deepEqual(m.cursorOf(s1), { after: H2, file: "old.txt" }, "the cursor is the last entry with the path IN it");
    assert.equal(m.cursorOf({ ...s1, clipped: false }), null, "nothing older: no \"Load more\"");
    const H3 = "c".repeat(40);
    const s2 = { entries: [s1.entries[1], { ...s1.entries[1], hash: H3 }], clipped: false };
    const together = m.appendTo(s1, s2);
    assert.deepEqual(together.entries.map((x) => x.hash), [H, H2, H3], "the next page appended, without duplicates");
    assert.equal(together.clipped, false, "the new page says clipped");
  },
};

test("Timeline: repo of the file, allow list of the answer, source of the diff", async () => {
  const m = await load("timeAxis.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("Timeline: every sabotage fails at its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
