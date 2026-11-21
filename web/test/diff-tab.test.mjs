// The diff tab of the code tabs in the chat — the pure computations in src/lib/diff-tab.ts EXECUTED (compiled with the
// local tsc, like git-card.test.mjs), the blocks applied against a REAL git, plus the binding of components/code/DiffTab.tsx,
// GitSidebar.tsx (DiffModal) and components/code/codeTheme.ts.
//
// What hangs here and why it is a guard:
// - Blocks: boundaries per block from a real `git diff`; the patch of ONE block can be applied with the arguments of
//   server git.js gitApply — stage (against the index), revert (reverse against the index), dismiss (reverse against the
//   WORKING TREE) — and hits exactly its block. A block that does not fit the shown texts (stale state) locks the buttons.
// - Who may write: only an unstaged change; staged has only "revert", commit/stash/history have no buttons.
// - Never silently empty: binary, clipped, too large, submodule, conflict, rename, read error, old server — every
//   situation with ITS announcement.
// - A missing field is no statement: an old server (without `content`) and a foreign answer are UNKNOWN (null), never an
//   empty text; the kinds of a page are exactly those of the server (git.js `CONTENT_KINDS`).
// - Texts from a patch alone (stash, old server, too large): line numbers from the headers, gaps with the number of
//   hidden lines.
// - Multi-file patch: paths in git quoting (octal UTF-8), rename with both paths, counts without the header lines.
// - Side by side/inline: narrower than 900 px (the TAB) => inline; unmeasured (0) the choice holds — no jump on the first frame.
// - Text from outside: the smallest replacement rebuilds the new text exactly (the insertion mark stays outside).
// - Binding: the patch computation exists ONCE (GitSidebar imports it); the tab writes only via ⌘S and the file's buffer
//   (`lib/buffer.ts` `save` → `files/write`; checked in buffer.test.mjs), applies blocks via `applyBody` + `/git/apply`,
//   asks before dismissing, hands the fresh tree to the shared state, measures the container (no window query); the
//   editor theme exists ONCE (codeTheme.ts).
// - Translations: every key from DiffTab.tsx and diff-tab.ts is in i18n-de.ts, with the same placeholders.
//
// COUNTER-TESTS built in: sabotages on copies of the sources (one place each), the check must throw on every one.
//
// Run:  node --test web/test/diff-tab.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repoDir = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const source = read("src", "lib", "diff-tab.ts");
const enSource = read("src", "lib", "i18n-de.ts");
const tabSource = read("src", "components", "code", "DiffTab.tsx");
const sidebarSource = read("src", "components", "GitSidebar.tsx");
const themeSource = read("src", "components", "code", "codeTheme.ts");
const codePaneSource = read("src", "components", "CodePane.tsx");
const gitJs = fs.readFileSync(path.join(repoDir, "server", "backend", "electron", "server", "git.js"), "utf8");

const SABOTAGES = {
  "stage reversed": { old: `if (action === "stage") return { repo, patch, reverse: false };`, fresh: `if (action === "stage") return { repo, patch, reverse: true };` },
  "revert not reversed": { old: `if (action === "revert") return { repo, patch, reverse: true };`, fresh: `if (action === "revert") return { repo, patch, reverse: false };` },
  "dismiss in the index": { old: `return { repo, patch, reverse: true, workingTree: true };`, fresh: `return { repo, patch, reverse: true };` },
  "staged writable": { old: `return (q.kind === "change" && !q.staged) || q.kind === "files";`, fresh: `return q.kind === "change" || q.kind === "files";` },
  "commit with blocks": { old: `if (q.kind !== "change" || (q.current && !q.staged)) return [];`, fresh: `if (q.kind !== "change") return q.kind === "commit" ? ["stage"] : [];` },
  "staged with dismiss": { old: `return q.staged ? ["revert"] : ["stage", "dismiss"];`, fresh: `return ["stage", "dismiss"];` },
  "block without file header": { old: `return header + "\\n" + hunk + "\\n";`, fresh: `return hunk + "\\n";` },
  "blocks always fit": { old: `export function blocksMatch(bl: readonly Block[], old: string, fresh: string): boolean {\n`, fresh: `export function blocksMatch(bl: readonly Block[], old: string, fresh: string): boolean {\n  if (bl.length >= 0) return true;\n` },
  "block length unchecked": { old: `    if (a - (b.header.oldCount === 0 ? b.header.oldStart : b.header.oldStart - 1) !== b.header.oldCount) return false;\n`, fresh: `` },
  "context checked on the left only": { old: `else { if (az[a] !== text || nz[n] !== text) return false; a += 1; n += 1; }`, fresh: `else { if (az[a] !== text) return false; a += 1; n += 1; }` },
  "block at the wrong row": { old: `if (c === "+") { if (!firstNew) firstNew = n;`, fresh: `if (c === "+") { if (!firstNew) firstNew = n + 1;` },
  "gap concealed": { old: `    if (hidden > 0) {\n`, fresh: `    if (hidden < 0) {\n` },
  "gap miscounted": { old: `const hidden = oldBeginning - oldEnd - 1;`, fresh: `const hidden = oldBeginning - oldEnd;` },
  "octal not decoded": { old: `if (/[0-7]/.test(n ?? "")) { bytes.push(parseInt(inside.slice(i + 1, i + 4), 8)); i += 3; }`, fresh: `if (false) { i += 0; }` },
  "rename without old path": { old: `const oldPath = kind.renaming?.from ?? null;`, fresh: `const oldPath = null;` },
  "header lines counted": { old: `      if (!inBlock) continue;\n`, fresh: `` },
  "old server as empty text": { old: `if (!prior || !after) return null;`, fresh: `if (!prior || !after) return { diff: o.diff, clipped: o.clipped === true, prior: { kind: "text", text: "" }, after: { kind: "text", text: "" } };` },
  "foreign answer accepted": { old: `if ((o.path ?? o.path) !== path || typeof o.diff !== "string") return null;`, fresh: `if (typeof o.diff !== "string") return null;` },
  "unknown kind accepted": { old: `if (typeof o.kind !== "string" || !PAGES_KINDS.includes(o.kind)) return null;`, fresh: `if (typeof o.kind !== "string") return null;` },
  "text without text": { old: `if (typeof o.text !== "string") return null;`, fresh: `if (typeof o.text !== "string") return { kind: "text", text: "" };` },
  "binary compared": { old: `if (prior.kind === "binary" || after.kind === "binary" || kind.binary) return`, fresh: `if (false) return` },
  "clipped without lock": { old: `if (clipped) locked = A(`, fresh: `if (false) locked = A(` },
  "stale state without lock": { old: `else if (b && !blocksMatch(b, oldText, newText)) locked`, fresh: `else if (b && b.length < 0) locked` },
  "conflict without announcement": { old: `if (prior.kind === "text" && prior.stage === 2) announcements.push(`, fresh: `if (false) announcements.push(` },
  "read error silent": { old: `else return { kind: "announcement", announcements: [...announcements, A("The file could not be read: {error}", "danger", { error: w.error })], raw: null };`, fresh: `else newText = "";` },
  "old server without announcement": { old: `if (e.source.kind !== "stash") announcements.push(`, fresh: `if (false) announcements.push(` },
  "too large as empty": { old: `const textOf = (s: Page): string | null => (s.kind === "text" ? s.text : s.kind === "missing" ? "" : null);`, fresh: `const textOf = (s: Page): string | null => (s.kind === "text" ? s.text : "");` },
  "deleted file writable": { old: `const writable = sourceWritable(e.source) && !newMissing;`, fresh: `const writable = sourceWritable(e.source);` },
  "equal texts silent": { old: `else if (oldText === newText && prior.kind === "text" && !newMissing) announcements.push(`, fresh: `else if (oldText === null) announcements.push(` },
  "submodule as comparison": { old: `if (prior.kind === "submodule" || after.kind === "submodule") return`, fresh: `if (prior.kind === "submodule" && after.kind === "binary") return` },
  "narrow stays side by side": { old: `if (choice === "sideBySide" && width > 0 && width < INLINE_UNDER_PX)`, fresh: `if (false)` },
  "first frame jumps": { old: `width > 0 && width < INLINE_UNDER_PX`, fresh: `width < INLINE_UNDER_PX` },
  "threshold moved": { old: `export const INLINE_UNDER_PX = 900;`, fresh: `export const INLINE_UNDER_PX = 700;` },
  "unknown choice as inline": { old: `return raw === "inline" ? "inline" : "sideBySide";`, fresh: `return raw === "sideBySide" ? "sideBySide" : "inline";` },
  "cap without announcement": { old: `if (total !== null && total > n) return A(`, fresh: `if (total !== null && total < 0) return A(` },
  "clipped list without announcement": { old: `if (shown > WHOLE_MAX || clipped) return`, fresh: `if (shown > WHOLE_MAX) return` },
  "replacement overlaps": { old: `while (e < max - a && `, fresh: `while (e < max && ` },
  "equal draft counts": { old: `return typeof draft === "string" && draft !== saved;`, fresh: `return typeof draft === "string";` },
  // Review findings (conflict, both missing, link, lock reason):
  "conflict without our side silent": { old: `const conflict = e.content.conflict === true || (prior.kind === "text" && prior.stage === 2);`, fresh: `const conflict = prior.kind === "text" && prior.stage === 2;` },
  "conflict not read": { old: `...(o.conflict === true ? { conflict: true as const } : {})`, fresh: `` },
  "conflict blocks open": { old: `else if (conflict || kind.combined) locked`, fresh: `else if (kind.combined) locked` },
  "staged conflict like unstaged": { old: `else if (e.source.kind === "change" && e.source.staged) announcements.push(`, fresh: `else if (false) announcements.push(` },
  "both missing silent": { old: `if (prior.kind === "missing" && newMissing && !conflict) return`, fresh: `if (false) return` },
  "link in the working tree writable": { old: `if (after.kind === "workingTree" && ((prior.kind === "text" && prior.reference) || kind.referenceNew)) {`, fresh: `if (after.kind === "workingTree" && prior.kind === "text" && prior.reference && kind.typeSwitch) {` },
  "new link not recognised": { old: `referenceNew: /^(?:new file mode|new mode) 120000$/m.test(d) || /^index [0-9a-f]+\\.\\.[0-9a-f]+ 120000$/m.test(d),`, fresh: `referenceNew: false,` },
  "type change as comparison": { old: `if (kind.typeSwitch) return { kind: "announcement"`, fresh: `if (kind.typeSwitch && kind.empty) return { kind: "announcement"` },
  "CRLF as stale state": { old: `if ((old.includes("\\r\\n") || fresh.includes("\\r\\n")) && blocksMatch(b, lf(old), lf(fresh))) {`, fresh: `if (false) {` },
};

// Compile: the real source, i18n-de.ts and one copy per sabotage, in ONE tsc run (every file a leaf without imports).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-diff-tab-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
fs.writeFileSync(path.join(src, "i18n-de.ts"), enSource);
// diff-tab.ts imports the TYPE `DiffSource` from lib/chat-tabs.ts (ONE type) — that leaf lies beside it.
fs.writeFileSync(path.join(src, "chat-tabs.ts"), read("src", "lib", "chat-tabs.ts"));
const sabotages = Object.entries(SABOTAGES).map(([name, { old, fresh }], i) => {
  const file = `sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(old, fresh));
  return { name, file, applies: source.includes(old) };
});
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
const { DE } = await load("i18n-de.ts");
const sabotaged = await Promise.all(sabotages.map(async (s) => ({ ...s, mod: await load(s.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── A real git, without foreign configuration ─────────────────────────────────────────────────────────────────────────────────────
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", LC_ALL: "C" };
const git = (cwd, args, input) => execFileSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
// The same arguments as server git.js (no programs, fixed prefixes, literal paths).
// `-U3`: a `diff.context=0` of the repo would otherwise take the blocks the context git apply needs.
const diffArgs = (filePath, staged) => ["-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", ...(staged ? ["--staged"] : []), "--", filePath];
// The same arguments as server git.js gitApply (the binding to it is in the test "seam" below).
const apply = (cwd, r) => git(cwd, ["apply", ...(r.workingTree === true ? [] : ["--cached"]), "--whitespace=nowarn", ...(r.reverse ? ["--reverse"] : []), "-"], r.patch.endsWith("\n") ? r.patch : r.patch + "\n");

const Z = (n) => Array.from({ length: n }, (_, i) => `z${i + 1}`);
const OLD = Z(30).join("\n") + "\n";
const WITH_NEW = [...Z(25), "fresh", ...Z(30).slice(25)].join("\n") + "\n"; // only the second block
const FRESH = WITH_NEW.replace("z3\n", "Z3\n"); // both blocks
function newRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-diff-tab-git-"));
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "a.txt"), OLD);
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "a"]);
  return dir;
}
const way = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* stays behind */ } };
// The diff working tree ↔ index with two blocks (row 3 changed, one row inserted after row 25) — produced once, for the pure checks.
const DIFF = (() => {
  const dir = newRepo();
  try { fs.writeFileSync(path.join(dir, "a.txt"), FRESH); return git(dir, diffArgs("a.txt", false)); } finally { way(dir); }
})();

// ── The checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const Q = { kind: "change", repo: "", file: "a.txt", staged: false };
const QS = { ...Q, staged: true };
const QC = { kind: "commit", repo: "", hash: "abc1234def", file: "a.txt" };
const QG = { kind: "commit-whole", repo: "", hash: "abc1234def" };
const QST = { kind: "stash", repo: "", ref: "stash@{2}" };
const QV = { kind: "history", repo: "app", hash: "abc1234def" };

function checkSources(m) {
  assert.equal(m.sourceWritable(Q), true, "an unstaged change is editable on the right");
  for (const q of [QS, QC, QG, QST, QV]) assert.equal(m.sourceWritable(q), false, `${q.kind}${q.staged ? " (staged)" : ""} is read-only`);
  assert.deepEqual(m.blockActions(Q), ["stage", "dismiss"]);
  assert.deepEqual(m.blockActions(QS), ["revert"], "staged: only revert (unstage) — dismissing would bypass the index");
  for (const q of [QC, QG, QST, QV]) assert.deepEqual(m.blockActions(q), [], `${q.kind}: no buttons (blocks only for changes)`);
  assert.deepEqual(m.applyBody("stage", "r", "P"), { repo: "r", patch: "P", reverse: false });
  assert.deepEqual(m.applyBody("revert", "r", "P"), { repo: "r", patch: "P", reverse: true });
  assert.deepEqual(m.applyBody("dismiss", "r", "P"), { repo: "r", patch: "P", reverse: true, workingTree: true });
  assert.equal(m.targetPath("", "a.txt"), "a.txt");
  assert.equal(m.targetPath("app/", "src/x.ts"), "app/src/x.ts");
  // The equality of two sources is computed ONLY by lib/chat-tabs.ts (`sourceKey` = the tab key, chat-tabs.test.mjs).
  assert.equal(m.sourceKey, undefined, "diff-tab.ts has its own equality of sources again");
  assert.deepEqual(m.sourceLabel(QST), { key: "Stash {ref}", values: { ref: "stash@{2}" } }, "a stash is named after its ref");
  assert.deepEqual([QG, QST, QV, Q, QC].map(m.isMultiFile), [true, true, true, false, false]);
}

function checkBlocks(m) {
  const bl = m.blocks(DIFF);
  assert.equal(bl?.length, 2, "two blocks");
  assert.deepEqual([bl[0].firstNew, bl[0].newFrom, bl[0].newUntil, bl[0].oldOf, bl[0].oldTo], [3, 3, 3, 3, 3], "block 1: row 3 on both sides");
  assert.deepEqual([bl[1].firstNew, bl[1].newFrom, bl[1].newUntil], [26, 26, 26], "block 2: the inserted row 26");
  for (const b of bl) {
    assert.ok(b.patch.startsWith("diff --git a/a.txt b/a.txt\n"), "the patch of a block carries the file header");
    assert.equal(b.patch.match(/^@@/gm)?.length, 1, "exactly one block per patch");
    assert.ok(b.patch.endsWith("\n"));
  }
  assert.equal(m.blocksMatch(bl, OLD, FRESH), true, "the blocks fit the texts they come from");
  assert.equal(m.blocksMatch(bl, OLD, FRESH.replace("z2\n", "x2\n")), false, "a context row differs on the right (stale state) ⇒ does not fit");
  assert.equal(m.blocksMatch(bl, OLD.replace("z3\n", "y3\n"), FRESH), false, "the deleted row differs on the left ⇒ does not fit");
  assert.equal(m.blocksMatch([{ ...bl[0], header: { ...bl[0].header, oldCount: bl[0].header.oldCount + 1 } }], OLD, FRESH), false, "a header that names more rows than the block has ⇒ does not fit");
  assert.equal(m.blocks(""), null);
  assert.equal(m.blocks("diff --cc a.txt\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n +b\n"), null, "a combined diff has no individually applicable blocks");
  assert.equal(m.blocks("diff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ\n"), null);
}

// The blocks against a real git: stage, revert, dismiss hit EXACTLY their block — with the arguments of gitApply.
function checkGit(m) {
  const dir = newRepo();
  const file = path.join(dir, "a.txt");
  const index = () => git(dir, ["show", ":a.txt"]);
  try {
    fs.writeFileSync(file, FRESH);
    const bl = m.blocks(git(dir, diffArgs("a.txt", false)));
    assert.equal(bl?.length, 2);
    apply(dir, m.applyBody("stage", "", bl[1].patch));
    assert.equal(index(), WITH_NEW, "\"stage block\" brings exactly the second block into the index");
    assert.equal(fs.readFileSync(file, "utf8"), FRESH, "the working tree stays");
    const staged = m.blocks(git(dir, diffArgs("a.txt", true)));
    assert.equal(staged?.length, 1, "one block is staged");
    assert.equal(m.blocksMatch(staged, OLD, WITH_NEW), true, "staged: HEAD on the left, the index on the right");
    const rest = m.blocks(git(dir, diffArgs("a.txt", false)));
    assert.equal(rest?.length, 1, "the first block stays unstaged");
    assert.equal(m.blocksMatch(rest, WITH_NEW, FRESH), true, "unstaged: the index on the left, the working tree on the right");
    apply(dir, m.applyBody("dismiss", "", rest[0].patch));
    assert.equal(fs.readFileSync(file, "utf8"), WITH_NEW, "\"dismiss block\" takes exactly the block out of the file");
    assert.equal(index(), WITH_NEW, "dismiss leaves the index alone");
    apply(dir, m.applyBody("revert", "", staged[0].patch));
    assert.equal(index(), OLD, "\"revert block\" takes it out of the index");
    assert.equal(fs.readFileSync(file, "utf8"), WITH_NEW, "revert leaves the file alone");
  } finally { way(dir); }
}

function checkPatchDocuments(m) {
  const d = m.patchDocuments(DIFF);
  assert.ok(d);
  const GAP = m.GAP;
  assert.deepEqual(d.old.split("\n"), [...Z(6), GAP, ...Z(28).slice(22)]);
  assert.deepEqual(d.fresh.split("\n"), ["z1", "z2", "Z3", "z4", "z5", "z6", GAP, "z23", "z24", "z25", "fresh", "z26", "z27", "z28"]);
  assert.deepEqual(d.oldNumbers, [1, 2, 3, 4, 5, 6, null, 23, 24, 25, 26, 27, 28], "numbers on the left from the headers, the gap without a number");
  assert.deepEqual(d.newNumbers, [1, 2, 3, 4, 5, 6, null, 23, 24, 25, 26, 27, 28, 29]);
  assert.deepEqual(d.gaps, [{ rowOld: 7, rowNew: 7, count: 16 }], "16 hidden rows (7 to 22)");
  assert.equal(m.patchDocuments(""), null);
}

// A multi-file patch from real git, with quoting (core.quotePath on): changed "ü.txt", renamed, deleted, new, binary.
const MORE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-diff-tab-more-"));
  try {
    git(dir, ["init", "-q"]);
    fs.writeFileSync(path.join(dir, "ü.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(dir, "old.txt"), "a\nb\nc\nd\ne\nf\n");
    fs.writeFileSync(path.join(dir, "d.txt"), "x\ny\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "a"]);
    fs.writeFileSync(path.join(dir, "ü.txt"), "one\nTWO\n");
    git(dir, ["mv", "old.txt", "new.txt"]);
    git(dir, ["rm", "-q", "d.txt"]);
    fs.writeFileSync(path.join(dir, "n.txt"), "new\n");
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
    git(dir, ["add", "-A"]);
    return git(dir, ["diff", "--cached", "-M", "--no-color", "--no-ext-diff"]);
  } finally { way(dir); }
})();
function checkMultiFile(m) {
  assert.ok(MORE.includes(`"a/\\303\\274.txt"`), "the sample carries a quoted path (otherwise it does not check the quoting)");
  const d = m.splitFiles(MORE);
  const byPath = Object.fromEntries(d.map((x) => [x.path, x]));
  assert.deepEqual(Object.keys(byPath).sort(), ["bin.dat", "d.txt", "n.txt", "new.txt", "ü.txt"]);
  assert.deepEqual([byPath["ü.txt"].status, byPath["ü.txt"].plus, byPath["ü.txt"].minus], ["M", 1, 1]);
  assert.deepEqual([byPath["new.txt"].status, byPath["new.txt"].old], ["R", "old.txt"], "rename with both paths");
  assert.deepEqual([byPath["d.txt"].status, byPath["d.txt"].minus], ["D", 2]);
  assert.deepEqual([byPath["n.txt"].status, byPath["n.txt"].plus], ["A", 1]);
  assert.equal(byPath["bin.dat"].binary, true);
  for (const x of d) assert.ok(x.diff.startsWith("diff --git ") && x.diff.endsWith("\n"));
  assert.deepEqual(m.patchCounts(d), { files: 5, plus: 2, minus: 3, binary: 1 }, "counts like the hover card, without the header lines ---/+++");
  assert.equal(m.unquote(`"\\303\\274 \\"x\\"\\t.txt"`), `ü "x"\t.txt`);
  assert.equal(m.unquote("plain.txt"), "plain.txt");
  assert.equal(m.unquote(`"a\\"`), `a\\`, "a backslash at the end does not crash");
  const kind = m.diffKind(byPath["new.txt"].diff);
  assert.deepEqual(kind.renaming, { from: "old.txt", destination: "new.txt" });
}

function checkAllowlist(m) {
  const PAGE = { kind: "text", text: "x\n" };
  const good = { path: "a.txt", staged: false, diff: DIFF, clipped: false, prior: PAGE, after: { kind: "workingTree" } };
  assert.deepEqual(m.normContent(good, "a.txt"), { diff: DIFF, clipped: false, prior: PAGE, after: { kind: "workingTree" } });
  assert.ok(m.normContent({ hash: "h", path: "a.txt", old: null, diff: "", clipped: true, prior: { kind: "missing" }, after: PAGE }, "a.txt")?.clipped, "/git/show: echo of `path`");
  assert.equal(m.normContent({ path: "a.txt", diff: DIFF }, "a.txt"), null, "an old server (without prior/after) is UNKNOWN, never an empty text");
  assert.equal(m.normContent({ ...good, path: "b.txt" }, "a.txt"), null, "a foreign answer (other path) does not belong in this tab");
  assert.equal(m.normContent({ ...good, diff: 3 }, "a.txt"), null);
  assert.equal(m.normContent(null, "a.txt"), null);
  assert.equal(m.normPage({ kind: "fresh" }), null, "a kind nobody knows here is unknown");
  assert.equal(m.normPage({ kind: "text" }), null, "a text without text is unknown, not empty");
  assert.deepEqual(m.normPage({ kind: "text", text: "t", reference: true, stage: 2 }), { kind: "text", text: "t", reference: true, stage: 2 });
  assert.deepEqual(m.normPage({ kind: "text", text: "t", reference: "yes", stage: 3 }), { kind: "text", text: "t" });
  for (const a of ["missing", "binary", "large", "submodule", "workingTree"]) assert.deepEqual(m.normPage({ kind: a, text: "x" }), { kind: a });
}

const has = (d, key) => d.announcements.some((a) => a.key === key);
const T = (text) => ({ kind: "text", text });
const content = (o) => ({ diff: DIFF, clipped: false, prior: T(OLD), after: { kind: "workingTree" }, ...o });
function checkDisplay(m) {
  // The normal case: unstaged, both texts, two blocks, writable on the right.
  let d = m.display({ source: Q, content: content(), patch: null, workingTree: { text: FRESH } });
  assert.equal(d.kind, "merge");
  assert.deepEqual([d.old === OLD, d.fresh === FRESH, d.writable, d.blocks.length, d.blocksLocked, d.announcements.length], [true, true, true, 2, null, 0]);
  // Stale state: the working tree is a different one than the one the diff came from ⇒ buttons locked, with a reason.
  d = m.display({ source: Q, content: content(), patch: null, workingTree: { text: FRESH.replace("z2\n", "x2\n") } });
  assert.equal(d.blocksLocked?.key, "The state has changed — reload to stage changes.");
  assert.equal(d.blocks.length, 0);
  // Staged: the index on the right, not writable; commit: no buttons.
  d = m.display({ source: QS, content: content({ after: T(FRESH) }), patch: null });
  assert.deepEqual([d.kind, d.writable, d.blocks.length], ["merge", false, 2]);
  d = m.display({ source: QC, content: content({ after: T(FRESH) }), patch: null });
  assert.deepEqual([d.kind, d.writable, d.blocks.length, d.blocksLocked], ["merge", false, 0, null]);
  // Clipped: announcement AND locked blocks.
  d = m.display({ source: Q, content: content({ clipped: true }), patch: null, workingTree: { text: FRESH } });
  assert.ok(has(d, "Cut at 2 MB — the rest of this file is not shown here."));
  assert.equal(d.blocksLocked?.key, "The diff is cut (over 2 MB) — changes cannot be staged one by one here.");
  // Binary (server) and binary (old server, patch only).
  const BIN = "diff --git a/b.png b/b.png\nindex 1..2 100644\nBinary files a/b.png and b/b.png differ\n";
  d = m.display({ source: QC, content: { diff: BIN, clipped: false, prior: { kind: "binary" }, after: { kind: "binary" } }, patch: null });
  assert.deepEqual([d.kind, has(d, "Binary file — no text comparison.")], ["announcement", true]);
  d = m.display({ source: QC, content: null, patch: BIN });
  assert.deepEqual([d.kind, has(d, "Binary file — no text comparison.")], ["announcement", true]);
  d = m.display({ source: Q, content: content({ prior: T("") }), patch: null, workingTree: { binary: true } });
  assert.deepEqual([d.kind, has(d, "Binary file — no text comparison.")], ["announcement", true]);
  // Too large: the patch alone (if complete), otherwise only the announcement — never an empty comparison.
  d = m.display({ source: Q, content: content({ prior: { kind: "large" } }), patch: null, workingTree: { tooBig: true } });
  assert.deepEqual([d.kind, has(d, "The file is too large for a side-by-side comparison (over 2 MB) — only the changed parts.")], ["patch", true]);
  d = m.display({ source: Q, content: content({ prior: { kind: "large" }, clipped: true }), patch: null, workingTree: { tooBig: true } });
  assert.deepEqual([d.kind, has(d, "The file is too large to compare (over 2 MB).")], ["announcement", true]);
  d = m.display({ source: QC, content: content({ prior: { kind: "large" }, after: T(FRESH) }), patch: null });
  assert.equal(d.kind, "patch", "a page that is too large is not an empty text (otherwise everything on the left would stand as deleted)");
  // Submodule, read error, no working tree.
  d = m.display({ source: QC, content: content({ prior: { kind: "submodule" }, after: { kind: "submodule" }, diff: "diff --git a/s b/s\n-Subproject commit 1\n+Subproject commit 2\n" }), patch: null });
  assert.deepEqual([d.kind, has(d, "Submodule — the commit it points to has changed.")], ["announcement", true]);
  d = m.display({ source: Q, content: content(), patch: null, workingTree: { error: "EACCES" } });
  assert.deepEqual([d.kind, d.announcements.at(-1)?.tone, d.announcements.at(-1)?.values?.error], ["announcement", "danger", "EACCES"], "a read error stands there in red, never an empty text");
  d = m.display({ source: Q, content: content(), patch: null });
  assert.equal(d.kind, "announcement", "no comparison without a working-tree read");
  // New, deleted (then not writable on the right), conflict, link, rename.
  d = m.display({ source: Q, content: content({ prior: { kind: "missing" }, diff: "" }), patch: null, workingTree: { text: "x\n" } });
  assert.ok(has(d, "New file (untracked)."));
  d = m.display({ source: QS, content: content({ prior: { kind: "missing" }, after: T("x\n"), diff: "" }), patch: null });
  assert.ok(has(d, "New file."));
  d = m.display({ source: Q, content: content({ diff: "" }), patch: null, workingTree: { missing: true } });
  assert.deepEqual([d.kind, d.writable, has(d, "Deleted file.")], ["merge", false, true], "a deleted file is not writable on the right (saving would recreate it)");
  const CC = "diff --cc a.txt\nindex 1,2..0\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n + a\n++=======\n+ b\n++>>>>>>> x\n";
  d = m.display({ source: Q, content: content({ diff: CC, prior: { kind: "text", text: "a\n", stage: 2 } }), patch: null, workingTree: { text: "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n" } });
  assert.ok(has(d, "Conflict — left our side (HEAD), right the file with the conflict markers."));
  assert.equal(d.blocksLocked?.key, "Conflict — changes can be staged one by one only after resolving it.");
  d = m.display({ source: QC, content: content({ prior: { kind: "text", text: "target", reference: true }, after: T("dest2") }), patch: null });
  assert.ok(has(d, "Symbolic link — the link itself is compared (the path it points to), not the file behind it."));
  const REN = "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n";
  d = m.display({ source: QC, content: content({ diff: REN, after: T(OLD) }), patch: null });
  assert.deepEqual(d.announcements.find((a) => a.key === "Renamed: {from} → {to}")?.values, { from: "old.txt", to: "new.txt" });
  assert.ok(has(d, "No text differences."), "renamed without change: that is said as well");
  // Equal texts (everything staged, everything reverted) and a pure mode change are a statement, not a silent surface.
  d = m.display({ source: Q, content: content({ diff: "" }), patch: null, workingTree: { text: OLD } });
  assert.deepEqual([d.kind, has(d, "No text differences.")], ["merge", true]);
  d = m.display({ source: QC, content: content({ diff: "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n", after: T(OLD) }), patch: null });
  assert.deepEqual([has(d, "Only the file mode changed."), has(d, "No text differences.")], [true, false]);
  // An old server: the patch alone, WITH announcement; a stash is always only the patch (without a server announcement).
  d = m.display({ source: QC, content: null, patch: DIFF });
  assert.deepEqual([d.kind, has(d, "Only the changed parts — the server does not deliver the full texts yet (after its next deploy).")], ["patch", true]);
  d = m.display({ source: QST, content: null, patch: DIFF });
  assert.deepEqual([d.kind, d.announcements.length], ["patch", 0]);
  d = m.display({ source: QC, content: null, patch: "" });
  assert.deepEqual([d.kind, has(d, "No text differences.")], ["announcement", true], "empty is an announcement, not an empty surface");
  d = m.display({ source: QC, content: null, patch: CC });
  assert.deepEqual([d.kind, d.raw === CC], ["announcement", true], "a combined diff stands there as text");
}

function checkView(m) {
  assert.equal(m.INLINE_UNDER_PX, 900);
  assert.deepEqual(m.effectiveView("sideBySide", 899), { view: "inline", forced: true });
  assert.deepEqual(m.effectiveView("sideBySide", 800), { view: "inline", forced: true });
  assert.deepEqual(m.effectiveView("sideBySide", 900), { view: "sideBySide", forced: false });
  assert.deepEqual(m.effectiveView("sideBySide", 0), { view: "sideBySide", forced: false }, "unmeasured, the choice holds (no jump on the first frame)");
  assert.deepEqual(m.effectiveView("inline", 1600), { view: "inline", forced: false });
  assert.deepEqual([m.readView(null), m.readView("x"), m.readView("inline"), m.readView("sideBySide")], ["sideBySide", "sideBySide", "inline", "sideBySide"]);
}

function checkCapAndText(m) {
  assert.equal(m.wholeCap(12, 12, false), null);
  assert.equal(m.wholeCap(12, null, null), null, "unknown total without cap: no invented announcement");
  assert.deepEqual(m.wholeCap(100, 250, true)?.values, { n: 100, m: 250 });
  assert.deepEqual(m.wholeCap(150, 150, false)?.values, { n: 100, m: 150 }, "more than WHOLE_MAX shown: the announcement names WHOLE_MAX");
  assert.equal(m.wholeCap(40, null, true)?.key, "Only the first {n} files — there are more.", "the server clipped the list: said, not concealed");
  const pairs = [["", "abc"], ["abc", ""], ["aa", "aaa"], ["aaa", "aa"], ["abcabc", "abc"], ["x\ny\nz\n", "x\nY\nz\n"], ["same", "same"], ["head torso foot", "head new foot"]];
  for (const [a, b] of pairs) {
    const c = m.minimalChange(a, b);
    if (a === b) { assert.equal(c, null); continue; }
    assert.ok(c.from <= c.to && c.to <= a.length, `range in "${a}"`);
    assert.equal(a.slice(0, c.from) + c.insert + a.slice(c.to), b, `"${a}" → "${b}" rebuilds exactly the new text`);
  }
  assert.deepEqual(m.minimalChange("head torso foot", "head new foot"), { from: 5, to: 10, insert: "new" }, "only the middle is replaced");
  assert.equal(m.draftCounts("a", "a"), false, "a draft equal to the saved one is nothing unsaved");
  assert.equal(m.draftCounts("a", "b"), true);
  assert.equal(m.draftCounts(null, "b"), false);
  assert.equal(m.draftCounts(undefined, ""), false);
}

// Review findings: conflict without our side, both sides missing, a link in the working tree and the right lock reason
// for CRLF.
const SYM = "diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-target\n\\ No newline at end of file\n+dest2\n\\ No newline at end of file\n";
const SYM_NEW = "diff --git a/l b/l\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+dest\n\\ No newline at end of file\n";
const TYPE = "diff --git a/l b/l\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/l\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/l b/l\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+dest\n\\ No newline at end of file\n";
const CONFLICT_BLOCK = "Conflict — changes can be staged one by one only after resolving it.";
function checkFindings(m) {
  // The server reports `conflict` (only stages 1–3 in the index) — the allowlist passes it on, a field other than true is none.
  const raw = { path: "a.txt", diff: "", clipped: false, prior: { kind: "missing" }, after: { kind: "workingTree" } };
  assert.equal(m.normContent({ ...raw, conflict: true }, "a.txt")?.conflict, true, "conflict falls through the allowlist");
  assert.equal(m.normContent({ ...raw, conflict: "yes" }, "a.txt")?.conflict, undefined);
  // DU (deleted by us) unstaged: our side is missing on the left — not "new file" but the conflict, and the blocks are locked.
  let d = m.display({ source: Q, content: content({ prior: { kind: "missing" }, conflict: true }), patch: null, workingTree: { text: FRESH } });
  assert.deepEqual([d.kind, has(d, "Conflict — our side (HEAD) does not have the file (deleted by us, or added only on the other side); on the right, the file in the working tree."), has(d, "New file (untracked).")], ["merge", true, false]);
  assert.equal(d.blocksLocked?.key, CONFLICT_BLOCK, "DU: the blocks of a conflict are locked");
  // Staged: the index holds no resolved version (stage 0 is missing) — neither "deleted file" nor, without HEAD, "both missing".
  d = m.display({ source: QS, content: content({ after: { kind: "missing" }, conflict: true }), patch: null });
  assert.deepEqual([has(d, "Conflict — the index holds no resolved version yet; resolve the conflict first."), has(d, "Deleted file.")], [true, false]);
  assert.equal(d.blocksLocked?.key, CONFLICT_BLOCK, "staged: the blocks of a conflict are locked");
  d = m.display({ source: QS, content: content({ prior: { kind: "missing" }, after: { kind: "missing" }, diff: "", conflict: true }), patch: null });
  assert.deepEqual([d.kind, has(d, "Conflict — the index holds no resolved version yet; resolve the conflict first.")], ["merge", true], "UA staged is a conflict, not \"does not exist\"");
  // Both sides missing (without a conflict) — an announcement, not an empty surface.
  d = m.display({ source: Q, content: content({ prior: { kind: "missing" }, diff: "" }), patch: null, workingTree: { missing: true } });
  assert.deepEqual([d.kind, has(d, "The file exists on neither side — it has been removed or renamed in the meantime.")], ["announcement", true]);
  // A link in the working tree — files/read would read the file BEHIND it; the places of the patch are shown, read-only on the right.
  const sym = (o, w) => m.display({ source: Q, content: content(o), patch: null, workingTree: w });
  d = sym({ prior: { kind: "text", text: "target", reference: true }, diff: SYM }, { text: "the content of the target file\n" });
  assert.deepEqual([d.kind, has(d, "Symbolic link — the link itself is compared (the path it points to); the right side is read-only.")], ["patch", true], "a link is not an editable comparison with its target file");
  assert.ok(!JSON.stringify(d).includes("target file"), "the content behind the link stands nowhere");
  d = sym({ prior: { kind: "missing" }, diff: SYM_NEW }, { text: "the content of the target file\n" });
  assert.equal(d.kind, "patch", "a new, untracked link (mode 120000) is read-only as well");
  d = sym({ prior: { kind: "text", text: "target", reference: true }, diff: "" }, { text: "x" });
  assert.deepEqual([d.kind, has(d, "No text differences."), has(d, "Symbolic link — the link itself is compared (the path it points to), not the file behind it.")], ["announcement", true, true]);
  d = sym({ prior: T("x\n"), diff: TYPE }, { text: "the content of the target file\n" });
  assert.deepEqual([d.kind, d.raw, has(d, "Type changed (file ↔ symbolic link) — shown as text.")], ["announcement", TYPE, true]);
  assert.equal(m.diffKind(SYM_NEW).referenceNew && m.diffKind(SYM).referenceNew && !m.diffKind(DIFF).referenceNew, true, "referenceNew reads mode 120000");
  // CRLF — the blocks fit only if CRLF is read as LF (git compared converted): THAT is the reason, not "stale".
  const crlf = (x) => x.replace(/\n/g, "\r\n");
  d = m.display({ source: Q, content: content({ prior: T(crlf(OLD)) }), patch: null, workingTree: { text: crlf(FRESH) } });
  assert.equal(d.blocksLocked?.key, "Line endings: the file uses CRLF and git compares it converted (core.autocrlf or eol in .gitattributes) — changes cannot be applied one by one here.");
  d = m.display({ source: Q, content: content({ prior: T(crlf(OLD)) }), patch: null, workingTree: { text: crlf(FRESH.replace("z2\n", "x2\n")) } });
  assert.equal(d.blocksLocked?.key, "The state has changed — reload to stage changes.", "CRLF and really stale: stale");
}

function check(m) {
  checkFindings(m);
  checkSources(m);
  checkBlocks(m);
  checkGit(m);
  checkPatchDocuments(m);
  checkMultiFile(m);
  checkAllowlist(m);
  checkDisplay(m);
  checkView(m);
  checkCapAndText(m);
}

test("sources: who may write, which buttons, the body of /git/apply", () => checkSources(real));
test("blocks: boundaries from a real git diff, fit only their texts", () => checkBlocks(real));
test("blocks against real git: stage, revert, dismiss hit exactly their block", () => checkGit(real));
test("texts from a patch alone: numbers from the headers, gaps with a count", () => checkPatchDocuments(real));
test("multi-file patch: quoting, rename, counts without header lines", () => checkMultiFile(real));
test("allowlist: old server and foreign answer are unknown, never empty", () => checkAllowlist(real));
test("display: every situation with its announcement — binary, clipped, too large, submodule, conflict, read error, old server", () => checkDisplay(real));
test("side by side/inline: narrower than INLINE_UNDER_PX (the tab) inline, unmeasured the choice", () => checkView(real));
test("file cap, smallest replacement, draft", () => checkCapAndText(real));
test("review findings: conflict without our side, both sides missing, link in the working tree, lock reason CRLF", () => checkFindings(real));
test("blocks with diff.context=0 in the repo: -U3 keeps the context, git apply takes the block (with counter-test without -U3)", () => {
  const dir = newRepo();
  try {
    git(dir, ["config", "diff.context", "0"]);
    fs.writeFileSync(path.join(dir, "a.txt"), FRESH);
    const bl = real.blocks(git(dir, diffArgs("a.txt", false)));
    assert.equal(bl?.length, 2);
    assert.equal(real.blocksMatch(bl, OLD, FRESH), true);
    apply(dir, real.applyBody("stage", "", bl[1].patch));
    assert.equal(git(dir, ["show", ":a.txt"]), WITH_NEW, "with -U3 the block stages as usual");
    git(dir, ["reset", "-q"]);
    const without = real.blocks(git(dir, diffArgs("a.txt", false).filter((a) => a !== "-U3")));
    assert.equal(without?.length, 2);
    assert.throws(() => apply(dir, real.applyBody("stage", "", without[0].patch)), "counter-test: without -U3 git apply would take the block without context — the guard would check nothing");
  } finally { way(dir); }
});
test("sabotage diff-tab.ts: every place turns the check red", () => {
  for (const s of sabotaged) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/diff-tab.ts`);
    assert.throws(() => check(s.mod), `sabotage "${s.name}" stays green`);
  }
});

// ── The seam to the server ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The kinds of a page stand ONCE in the server (git.js `CONTENT_KINDS`); the allowlist here knows exactly these — a kind the
// server sends and that is missing here would be "unknown" (the tab would fall back to the patch), one it never sends is dead
// code. Plus the arguments of gitApply, which `apply` above replicates (otherwise the git test would check something other than
// what the server does).
function serverKinds(js) {
  const m = /^export const CONTENT_KINDS = Object\.freeze\(\[([^\]]*)\]\);$/m.exec(js);
  if (!m) throw new Error("server git.js: `export const CONTENT_KINDS = Object.freeze([ … ]);` not found");
  return [...m[1].matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]);
}
function webKinds(ts) {
  const m = /^const PAGES_KINDS: readonly string\[\] = \[([^\]]*)\];$/m.exec(ts);
  if (!m) throw new Error("lib/diff-tab.ts: `const PAGES_KINDS: readonly string[] = [ … ];` not found");
  return [...m[1].matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]);
}
function checkSeam(js, ts) {
  const s = serverKinds(js), w = webKinds(ts);
  assert.ok(s.length >= 5, `only ${s.length} kinds read in the server`);
  assert.deepEqual([...w].sort(), [...s].sort(), "the allowlist knows other kinds than the server sends (CONTENT_KINDS)");
  const type = /export type Page =([\s\S]*?);\n/.exec(ts)?.[1] ?? "";
  assert.deepEqual([...new Set([...type.matchAll(/kind: "([a-zA-Z]+)"/g)].map((x) => x[1]))].sort(), [...s].sort(), "the type `Page` names other kinds than the server");
  const body = js.slice(js.indexOf("export async function gitApply("), js.indexOf("// ── Stash"));
  assert.ok(body.includes(`const args = ["apply", ...(opts.workingTree === true ? [] : ["--cached"]), "--whitespace=nowarn"];`), "gitApply: other arguments than replicated in the test");
  assert.ok(body.includes(`if (opts.reverse) args.push("--reverse");`), "gitApply: --reverse differs from the replica");
  // The fields of the answer: what normContent reads, the server sends (the diff-with-content answers and the commit-part
  // answer, `path`) — a field it never sends would stay silently unknown, and the tab would fall back to the patch forever.
  // Both diff-with-content answers carry `conflict` (only when true).
  const responses = [
    /return \{ (path: filePath, staged, diff, clipped, prior, after), \.\.\.\(isConflict\(stages\) \? \{ (conflict): true \} : \{\}\) \};/,
    /return \{ (path: filePath, staged, diff, clipped, prior), after: \{ kind: "workingTree" \}, \.\.\.\(conflict \? \{ (conflict): true \} : \{\}\) \};/,
    /return \{ (hash: full, path: filePath, old(?:: \w+)?, diff, clipped, prior, after) \};/,
  ].map((re) => {
    const m = re.exec(js);
    if (!m) throw new Error(`server git.js: answer with content not found (${re.source.slice(0, 40)}…)`);
    return [...m[1].split(",").map((x) => x.split(":")[0].trim()), ...(m[2] ? [m[2]] : [])];
  });
  // The arguments of the server (WITHOUT_PROGRAM, including -U3) are those with which this test produces its diffs.
  const op = /^const WITHOUT_PROGRAM = \[([^\]]*)\];$/m.exec(js);
  if (!op) throw new Error("server git.js: `const WITHOUT_PROGRAM = [ … ];` not found");
  const serverArgs = [...op[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.ok(serverArgs.includes("-U3"), "WITHOUT_PROGRAM without -U3: a diff.context of the repo would take the context from the blocks");
  assert.deepEqual(diffArgs("x", false).slice(4, 4 + serverArgs.length), serverArgs, "the diff arguments of the test differ from WITHOUT_PROGRAM");
  const dispatched = new Set(responses.flat());
  const i = ts.indexOf("export function normContent("), j = ts.indexOf("\n}\n", i);
  if (i < 0 || j < 0) throw new Error("lib/diff-tab.ts: normContent not found");
  const read = [...new Set([...ts.slice(i, j).matchAll(/\bo\.([A-Za-z]+)/g)].map((x) => x[1]))];
  assert.ok(read.length >= 5, `normContent: only ${read.length} fields read`);
  assert.deepEqual(read.filter((x) => !dispatched.has(x)), [], "normContent reads a field the server does not send");
}
test("seam: the kinds of a page are exactly those of the server, gitApply as replicated (with counter-test)", () => {
  checkSeam(gitJs, source);
  assert.throws(() => checkSeam(gitJs.replace(`"submodule", "workingTree"]);`, `"submodule", "workingTree", "lfs"]);`), source), /CONTENT_KINDS/, "a new kind in the server stays green");
  assert.throws(() => checkSeam(gitJs, source.replace(`"submodule", "workingTree"];`, `"submodule"];`)), /CONTENT_KINDS/, "a missing kind in the allowlist stays green");
  assert.throws(() => checkSeam(gitJs.replace(`opts.workingTree === true ? [] : ["--cached"]`, `["--cached"]`), source), /gitApply/, "dismiss in the index stays green");
  assert.throws(() => checkSeam(gitJs, source.replace("const prior = normPage(o.prior), after = normPage(o.after);", "const prior = normPage(o.left), after = normPage(o.after);")), /does not send/, "a field the server never sends stays green");
  assert.throws(() => checkSeam("", source), /not found/);
  assert.throws(() => checkSeam(gitJs.replace(`"--no-textconv", "-U3", `, `"--no-textconv", `), source), /-U3/, "WITHOUT_PROGRAM without -U3 stays green");
  assert.throws(() => checkSeam(gitJs.replace(`, ...(isConflict(stages) ? { conflict: true } : {}) };`, ` };`), source), /not found/, "staged without conflict stays green");
  assert.throws(() => checkSeam(gitJs.replace(`, ...(conflict ? { conflict: true } : {}) };`, ` };`), source), /not found/, "unstaged without conflict stays green");
});

// ── Translations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The keys stand as the first argument of t(…)/A(…) or as `key:` — also in branches (`a ? "x" : "y"`); comparisons
// (`=== "stage"`) are no keys.
function expression(s, i, end) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") { const q = c; j++; while (j < s.length && s[j] !== q) { if (s[j] === "\\") j++; j++; } continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return s.slice(i, j); depth--; }
    else if (depth === 0 && end.includes(c)) return s.slice(i, j);
  }
  return s.slice(i);
}
function literals(expr) {
  const output = [];
  for (const m of expr.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (expr.slice(0, m.index).trimEnd().match(/[!=]==$/)) continue;
    if (expr.slice(m.index + m[0].length).trimStart().match(/^[!=]==/)) continue;
    output.push(JSON.parse(`"${m[1]}"`));
  }
  return output;
}
function uiKey(s) {
  const out = new Set();
  for (const m of s.matchAll(/\b(?:t|A)\(/g)) for (const l of literals(expression(s, m.index + m[0].length, ","))) out.add(l);
  // `key:` is also the key of a CodeMirror keymap (`{ key: "Mod-s", run }`) — that is no interface text.
  for (const m of s.matchAll(/\bkey:(?!\s*"[^"]*",\s*(?:run|preventDefault)\b)\s*/g)) for (const l of literals(expression(s, m.index + m[0].length, ",;"))) out.add(l);
  return out;
}
const placeholder = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
function checkTranslated(sources, en) {
  const all = new Set(sources.flatMap((q) => [...uiKey(q)]));
  if (all.size < 40) throw new Error(`only ${all.size} keys found — the reader no longer finds the texts`);
  const missing = [...all].filter((k) => !(k in en));
  assert.deepEqual(missing, [], "keys without a German entry in i18n-de.ts");
  for (const k of all) assert.equal(placeholder(en[k]), placeholder(k), `"${k}": different placeholders in the German text`);
  return all.size;
}
test("translations: every key from DiffTab.tsx and diff-tab.ts is in i18n-de.ts, with the same placeholders (with counter-test)", (t) => {
  t.diagnostic(`${checkTranslated([tabSource, source], DE)} keys`);
  const without = { ...DE };
  delete without["Discard change"];
  assert.throws(() => checkTranslated([tabSource, source], without), /Discard change/, "a missing key stays green");
  assert.throws(() => checkTranslated([tabSource, source], { ...DE, "Stash {ref}": "Stash" }), /placeholders/, "a lost placeholder stays green");
  assert.throws(() => checkTranslated([""], DE), /only 0/, "a reader that finds nothing stays green");
});

// ── Binding ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The patch computation exists ONCE: DiffModal (GitSidebar.tsx) imports it instead of keeping its own.
function checkSidebar(s) {
  assert.match(s, /^import \{[^}]*\bhunkPatch\b[^}]*\} from "@\/lib\/diff-tab";$/m, "GitSidebar imports hunkPatch from lib/diff-tab");
  assert.match(s, /^import \{[^}]*\bparseDiff\b[^}]*\} from "@\/lib\/diff-tab";$/m, "GitSidebar imports parseDiff from lib/diff-tab");
  assert.doesNotMatch(s, /function parseDiff\b|\bparseDiff\s*=/, "GitSidebar keeps its own parseDiff");
  assert.doesNotMatch(s, /function hunkPatch\b|\bhunkPatch\s*=/, "GitSidebar keeps its own hunkPatch");
  assert.match(s, /const patch = hunkPatch\(parsed\.header, hunkText\);/, "\"stage hunk\" builds its patch via hunkPatch");
  assert.doesNotMatch(s, /header \+ "\\n" \+ hunk/, "GitSidebar assembles a patch by hand");
}
test("binding: DiffModal takes the patch computation from lib/diff-tab.ts — no second one (with counter-test)", () => {
  checkSidebar(sidebarSource);
  const S = {
    "own parseDiff": sidebarSource.replace(`const parsed = useMemo(`, `function parseDiff(d: string) { return { header: "", hunks: [d] }; }\n  const parsed = useMemo(`),
    "patch by hand": sidebarSource.replace(`const patch = hunkPatch(parsed.header, hunkText);`, `const patch = parsed.header + "\\n" + hunkText + "\\n";`),
    "import gone": sidebarSource.replace(`import { hunkPatch, parseDiff } from "@/lib/diff-tab";`, ``),
  };
  for (const [name, s] of Object.entries(S)) {
    assert.notEqual(s, sidebarSource, `sabotage "${name}" no longer applies`);
    assert.throws(() => checkSidebar(s), `sabotage "${name}" stays green`);
  }
});

// The editor theme exists ONCE (components/code/codeTheme.ts): the two code editors define none and import it.
const CODE_EDITORS = { "CodePane.tsx": codePaneSource, "DiffTab.tsx": tabSource };
function checkOneTheme(editors, theme) {
  assert.match(theme, /^const darkHighlightStyle = HighlightStyle\.define\(\[$/m, "codeTheme.ts defines the theme");
  assert.match(theme, /^export const darkSyntax = /m);
  assert.match(theme, /^export const codeTheme: Extension = \[$/m); // surface + light syntax + brackets, lines, search
  for (const [file, s] of Object.entries(editors)) {
    assert.match(s, /^import \{ codeTheme, darkSyntax(?:, fontSize)? \} from "@\/components\/code\/codeTheme";$/m, `${file} imports the theme`);
    assert.doesNotMatch(s, /HighlightStyle\.define\(|\b(?:const|let|var|function)\s+(?:codeTheme|darkSyntax|darkHighlightStyle)\b/, `${file} defines its own theme`);
  }
}
test("guard: only ONE editor theme — CodePane and DiffTab import codeTheme.ts, none keeps a copy (with counter-test)", () => {
  checkOneTheme(CODE_EDITORS, themeSource);
  const copy = themeSource.slice(themeSource.indexOf("const darkHighlightStyle"), themeSource.indexOf("export const darkSyntax"));
  assert.ok(copy.length > 200, "the counter-test no longer finds the block in codeTheme.ts");
  const S = {
    "CodePane with own copy": { ...CODE_EDITORS, "CodePane.tsx": codePaneSource + "\n" + copy },
    "DiffTab with own codeTheme": { ...CODE_EDITORS, "DiffTab.tsx": tabSource + "\nconst codeTheme = EditorView.theme({});\n" },
    "CodePane without import": { ...CODE_EDITORS, "CodePane.tsx": codePaneSource.replace(`import { codeTheme, darkSyntax, fontSize } from "@/components/code/codeTheme";`, "") },
  };
  for (const [name, e] of Object.entries(S)) assert.throws(() => checkOneTheme(e, themeSource), `sabotage "${name}" stays green`);
});

// The tab: writes only via ⌘S and the buffer, blocks only via applyBody + /git/apply (dismiss asks first), the fresh tree goes to
// the shared state, the width is that of the container, the answers go through the allowlist, storage only in try.
function checkTab(s) {
  assert.equal((s.match(/\/files\/write"/g) ?? []).length, 0, "the tab writes itself — bypassing the file's buffer (a second state of the same file)");
  assert.equal((s.match(/\.save\(/g) ?? []).length, 1, "saving happens exactly once (in `save`) — no second, automatic write path");
  assert.match(s, /const save = useCallback\(async \(\) => \{[\s\S]{0,300}const r = await p\.save\(\{/, "saving via the buffer like a file tab");
  assert.match(s, /run\.current\.writable\s*\?\s*\[Prec\.highest\(keymap\.of\(\[\{ key: "Mod-s"/, "⌘S only on a writable side");
  assert.match(s, /api<GitTree>\(path\("\/git\/apply"\), \{ method: "POST", body: JSON\.stringify\(applyBody\(action, source\.repo, block\.patch\)\) \}\);\n\s*takeOverGitTree\(/, "block via applyBody + /git/apply, then the tree to the shared state");
  const questions = s.indexOf(`action === "dismiss" && !(await question(`), applyValue = s.indexOf(`path("/git/apply")`);
  assert.ok(questions > 0 && questions < applyValue, "dismiss asks BEFORE applying");
  assert.match(s, /new ResizeObserver\(/, "the width of the tab is measured");
  assert.match(s, /effectiveView\(choice, width\)/, "inline by the width of the tab (lib/diff-tab.ts effectiveView)");
  assert.doesNotMatch(s, /innerWidth|matchMedia|useMediaQuery|@media/, "a window query instead of the width of the tab");
  // The timeline comparison asks /git/show per side (web/test/comparison.test.mjs) — three bodies.
  assert.equal((s.match(/content: true \}\)/g) ?? []).length, 3, "/git/diff, /git/show and the timeline comparison ask for the content");
  assert.match(s, /normContent\(raw, file\)/, "answers only through the allowlist");
  assert.doesNotMatch(s, /\braw\b[^;\n]*\.(prior|after)\b/, "a page read past the allowlist");
  for (const z of s.split("\n").filter((x) => x.includes("localStorage."))) assert.match(z, /try \{[^}]*localStorage\./, `localStorage without try: ${z.trim().slice(0, 90)}`);
  // ⌥F5/⇧⌥F5 (next/previous change like VS Code) also apply with the focus on the left.
  assert.match(s, /a: \{ doc: run\.current\.old, extensions: \[\.\.\.common\("a"\), reading, CHANGE_KEYS\] \}/, "the left is always read-only");
  assert.match(s, /\{ key: "Alt-F5", run: goToNextChunk, preventDefault: true \},\s*\{ key: "Shift-Alt-F5", run: goToPreviousChunk, preventDefault: true \},/, "⌥F5/⇧⌥F5 do not jump from change to change");
}
test("binding: the tab writes only via ⌘S, blocks via /git/apply with a question, width of the container (with counter-test)", () => {
  checkTab(tabSource);
  const S = {
    "save automatically": tabSource.replace(`debounce.current = null; rememberDraft(); }, 250);`, `debounce.current = null; rememberDraft(); void bufRef.current?.save(); }, 250);`),
    "writes itself": tabSource.replace(`const r = await p.save({ onError`, `await api(path("/files/write"), { method: "PUT", body: "" }); const r = await p.save({ onError`),
    "⌘S also read-only": tabSource.replace(`run.current.writable\n        ? [Prec.highest(keymap.of([{ key: "Mod-s"`, `true\n        ? [Prec.highest(keymap.of([{ key: "Mod-s"`),
    "tree not shared": tabSource.replace(`      takeOverGitTree(target.apiBase, chatId, target.instance, tree);\n`, ``),
    "patch by hand": tabSource.replace(`JSON.stringify(applyBody(action, source.repo, block.patch))`, `JSON.stringify({ repo: source.repo, patch: block.patch, reverse: action !== "stage" })`),
    "dismiss without question": tabSource.replace(`if (action === "dismiss" && !(await question(`, `if (action === "never" && !(await question(`),
    "window width": tabSource.replace(`const effective = effectiveView(choice, width);`, `const effective = effectiveView(choice, window.innerWidth);`),
    "without content": tabSource.replace(`staged: source.staged, content: true })`, `staged: source.staged })`),
    "past the allowlist": tabSource.replace(`const content = normContent(raw, file);\n      if (!content) return { e: { source, content: null, patch:`, `const content = (raw as any).prior ? (raw as any) : normContent(raw, file);\n      if (!content) return { e: { source, content: null, patch:`),
    "storage without try": tabSource.replace(`try { localStorage.setItem(VIEW_KEY, a); } catch { /* for this session only */ }`, `localStorage.setItem(VIEW_KEY, a);`),
    "left writable": tabSource.replace(`a: { doc: run.current.old, extensions: [...common("a"), reading, CHANGE_KEYS] }`, `a: { doc: run.current.old, extensions: [...common("a"), CHANGE_KEYS] }`),
    "without ⌥F5": tabSource.replace(`  { key: "Alt-F5", run: goToNextChunk, preventDefault: true },\n`, ``),
  };
  for (const [name, s] of Object.entries(S)) {
    assert.notEqual(s, tabSource, `sabotage "${name}" no longer applies`);
    assert.throws(() => checkTab(s), `sabotage "${name}" stays green`);
  }
});
