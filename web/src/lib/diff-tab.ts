// The diff tab of the code tabs in the chat — the PURE computations. Drawn in components/code/DiffTab.tsx (@codemirror/merge, side by side or inline).
//
// What lives here:
// - the SOURCES of a diff (`DiffSource`, the shapes of the calls in GitSidebar.tsx `showDiff`/`diffText` and
//   git-bar/GitGraph.tsx openFile/openWhole) and what a source may do (write on the right, stage/revert/discard blocks);
// - the PATCH COMPUTATION (`parseDiff`, the patch of a block `hunkPatch`) — DiffModal
//   imports it from here, and so does the diff tab: ONE computation for "stage hunk" in the modal and "stage block" in the tab;
// - the position of a block in both texts (`blocks`) and whether the blocks fit the texts shown (`blocksMatch` — otherwise the
//   buttons are locked: a block that does not fit would go into the index at the wrong place);
// - the kind of a diff (binary, combined, rename), the files of a multi-file patch (stash), the texts from a patch alone
//   (`patchDocuments`, when the server delivers no whole text: old server, stash, file too large) with line numbers;
// - what the tab shows (`display`) — never silently empty: binary, clipped, too large, submodule, conflict, error stand there as an announcement;
// - side by side/inline (`effectiveView`, threshold like VS Code `renderSideBySideInlineBreakpoint`);
// - the whitelist of an answer with content (`normPage`, `normContent`): an old server does not know `content` — then the content is
//   UNKNOWN (null), not empty.
//
// A LEAF except for ONE import from the leaf lib/chat-tabs.ts: the source of a diff (`DiffSource`) stands exactly once, in the tab model
// (the call of /git/stash/show needs the ref), plus the roots of a comparison of two targets (`twoRoots`, `withRoot`);
// web/test/diff-tab.test.mjs transpiles both leaves and runs this one. Announcements carry English UI keys (i18n-de.ts translates them;
// the test ensures every one is in there).
import { withRoot, targetEqual, targetIdentifier, twoRoots, type DiffSource, type TabTarget, type RootName } from "./chat-tabs.js";

// ── Sources ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `repo` is the path of the repo relative to the root of the target (`GitRepo.relPath`, "" = the root), `file`/`old` relative to the repo.
export type DiffView = "sideBySide" | "inline";
export type BlockAction = "stage" | "revert" | "dismiss";

/** Write on the right (⌘S via files/write): an unstaged change and the comparison of two files (the file itself stands on the right,
 *  as in the diff editor of VS Code) — if staged the right is the index, a commit is history. */
export function sourceWritable(q: DiffSource): boolean {
  return (q.kind === "change" && !q.staged) || q.kind === "files";
}
/** The file of the editable right side (relative to the target) — its buffer (lib/buffer.ts) is the same as that of a file tab; null: the
 *  source is not writable. The ONE computation for the diff building block, the editor groups (lib/editor-inputs.ts
 *  `bufferFile`) and the tabs in the chat (chat/chatTabs.ts `tabBuffer`); a renamed change writes to `current`. */
export function writeFile(q: DiffSource): string | null {
  if (q.kind === "files") return q.right;
  return q.kind === "change" && !q.staged ? targetPath(q.repo, q.current ?? q.file) : null;
}
/** Whose changes the diff re-reads live (a nudge from the chat, a save, relative to the target): the file of a change, for the comparison
 *  of two files both — history (commit, time axis, stash) never re-reads. */
export function followUpFiles(q: DiffSource): string[] {
  if (q.kind === "files") return q.left === q.right ? [q.left] : [q.left, q.right];
  return q.kind === "change" ? [targetPath(q.repo, q.current ?? q.file)] : [];
}
/** The same, each with a target: for the comparison of two files each side in ITS target (the left may come from another area of the window), otherwise the
 *  target of the tab. A nudge with a target (a save) counts only for the sides of that target. */
export function followUpLocations(q: DiffSource, target: TabTarget): { target: TabTarget; path: string }[] {
  if (q.kind !== "files") return followUpFiles(q).map((path) => ({ target, path }));
  const l = { target: q.leftTarget, path: q.left }, r = { target: q.rightTarget, path: q.right };
  return targetEqual(l.target, r.target) && l.path === r.path ? [r] : [l, r];
}
/** A save in the window (`saved`: target and path of the buffer, lib/buffer.ts `atSave`): does the diff re-read?
 *  Yes if it is the LEFT side of a comparison of two files — it comes through files/read, without a buffer; the right side holds the buffer
 *  and is live anyway. "The same" means canonically the same (`equal`: components/code/comparison-connection.ts `sameFileInWindow`) —
 *  saved at workspace level, in the project, in Coding → Files or in a chat. */
export function leftSaved(q: DiffSource, saved: { target: TabTarget; path: string }, equal: (a: { target: TabTarget; path: string }, b: { target: TabTarget; path: string }) => boolean): boolean {
  return q.kind === "files" && equal({ target: q.leftTarget, path: q.left }, saved);
}
/** The buttons per block (only diffs from "Changes"): stage and discard when unstaged, revert when staged. An UNSTAGED change
 *  renamed since opening (`current`) has none: git sees a deletion and a new file in the working tree, no block
 *  fit. The staged one keeps "revert block": index ↔ HEAD stands under the old name, the block fits. */
export function blockActions(q: DiffSource): BlockAction[] {
  if (q.kind !== "change" || (q.current && !q.staged)) return [];
  return q.staged ? ["revert"] : ["stage", "dismiss"];
}
/** The body of `POST …/git/apply` (server git.js gitApply): stage against the index, revert reversed against the index, discard
 *  reversed against the working tree (`workingTree`). */
export function applyBody(action: BlockAction, repo: string, patch: string): { repo: string; patch: string; reverse: boolean; workingTree?: true } {
  if (action === "stage") return { repo, patch, reverse: false };
  if (action === "revert") return { repo, patch, reverse: true };
  return { repo, patch, reverse: true, workingTree: true };
}
/** The path for files/read and files/write: relative to the root of the target (repo + file). For the git routes the tab uses
 *  lib/git-files.ts `diffPath` (a name with a leading "-" as "./-x"). */
export function targetPath(repo: string, file: string): string {
  const r = repo.replace(/\/+$/, "");
  return r ? `${r}/${file}` : file;
}
// The equality of two sources is `sourceKey` in the tab model (lib/chat-tabs.ts) — the same computation as the key of a tab.
/** What the source is called — ONE label for the building block's own header and the title row of the code tabs
 *  (chat/ChatTabBar.tsx `sourceText`): a UI key with values. `short` = the short hash as the git bar knows it (otherwise
 *  seven characters). */
export function sourceLabel(q: DiffSource, short?: string, root: RootName = targetIdentifier): { key: string; values?: Record<string, string | number> } {
  const hash = "hash" in q ? short || q.hash.slice(0, 7) : "";
  switch (q.kind) {
    // The time axis comparison names both commits, the comparison of two files the left one (the right one stands before it as a path).
    // Eight characters like the title (lib/timeAxis.ts `shortRef`, VS Code `shortenRef` = substr(0, 8)) — here without an import, the leaf stays one;
    // equality is held by web/test/comparison.test.mjs.
    case "comparison": return { key: "Compare {left} ↔ {right}", values: { left: q.left.hash.slice(0, 8), right: q.right.hash.slice(0, 8) } };
    // If the left side comes from another target, it names its root (VS Code, window with several roots: "{root} • {path}").
    case "files": return { key: "Compare with {file}", values: { file: twoRoots(q) ? withRoot(root(q.leftTarget), q.left) : q.left } };
    case "change": return { key: q.staged ? "Index ↔ HEAD" : "Working tree ↔ Index" };
    case "commit": return { key: "Commit {hash}", values: { hash } };
    case "commit-whole": return { key: "Commit {hash} · all files", values: { hash } };
    case "history": return { key: "History · {hash}", values: { hash } };
    case "stash": return { key: "Stash {ref}", values: { ref: q.ref } };
  }
}
/** Several files one below the other (each collapsible) instead of one file. */
export function isMultiFile(q: DiffSource): boolean {
  return q.kind === "commit-whole" || q.kind === "history" || q.kind === "stash";
}

// ── The patch computation ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Header (everything before the first `@@`) and blocks of a diff of ONE file. */
export function parseDiff(diff: string) {
  const lines = diff.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  if (at < 0) return { header: "", hunks: [] as string[] };
  const header = lines.slice(0, at).join("\n");
  const hunks: string[] = [];
  let cur: string[] | null = null;
  for (let i = at; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) { if (cur) hunks.push(cur.join("\n")); cur = [lines[i]]; }
    else if (cur) cur.push(lines[i]);
  }
  if (cur) hunks.push(cur.join("\n"));
  return { header, hunks };
}
/** The patch of ONE block for `git apply`: the file header, the block, a line ending. */
export function hunkPatch(header: string, hunk: string): string {
  return header + "\n" + hunk + "\n";
}

// ── Blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HunkHeader { oldStart: number; oldCount: number; newStart: number; newCount: number }
/** `@@ -a[,b] +c[,d] @@` → the four numbers (without a number it is 1, as in git). A combined header (`@@@`) is none. */
export function hunkHeader(row: string): HunkHeader | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
  if (!m) return null;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) };
}
export interface Block {
  seq: number;
  header: HunkHeader;
  /** First changed line (1-based) on the new side — the buttons stand there; for a pure deletion the line after. */
  firstNew: number;
  /** The changed lines of the new side (1-based, `newUntil` inclusive; empty for a pure deletion: newUntil < newFrom). */
  newFrom: number; newUntil: number;
  oldOf: number; oldTo: number;
  /** The patch of this block (`hunkPatch`). */
  patch: string;
  /** The lines of the block without the header (for `blocksMatch`). */
  rows: string[];
}
/** The blocks of a diff of ONE file — null if it has none that can be applied individually (combined, binary, without `@@`). */
export function blocks(diff: string): Block[] | null {
  if (diffKind(diff).combined) return null;
  const { header, hunks } = parseDiff(diff);
  if (!header || hunks.length === 0) return null;
  const out: Block[] = [];
  for (const [seq, hunk] of hunks.entries()) {
    const rows = hunk.split("\n");
    const hunkHeaderText = hunkHeader(rows[0]);
    if (!hunkHeaderText) return null;
    const body = rows.slice(1);
    while (body.length && body[body.length - 1] === "") body.pop(); // the line ending of the patch, no context line
    let a = hunkHeaderText.oldCount === 0 ? hunkHeaderText.oldStart + 1 : hunkHeaderText.oldStart;
    let n = hunkHeaderText.newCount === 0 ? hunkHeaderText.newStart + 1 : hunkHeaderText.newStart;
    let firstNew = 0, newFrom = 0, newUntil = -1, oldOf = 0, oldTo = -1;
    for (const z of body) {
      const c = z[0];
      if (c === "\\") continue;
      if (c === "+") { if (!firstNew) firstNew = n; if (!newFrom) newFrom = n; newUntil = n; n += 1; }
      else if (c === "-") { if (!firstNew) firstNew = n; if (!oldOf) oldOf = a; oldTo = a; a += 1; }
      else { a += 1; n += 1; }
    }
    out.push({ seq, header: hunkHeaderText, firstNew: firstNew || hunkHeaderText.newStart || 1, newFrom: newFrom || firstNew, newUntil, oldOf: oldOf || a, oldTo, patch: hunkPatch(header, hunk), rows: body });
  }
  return out;
}
/** Do the blocks fit the texts shown? Every context and "-" line stands in `old`, every context and "+" line in `fresh`, at the
 *  place the header names. No ⇒ the buttons are locked (a stale state, a filter of git, line endings). */
export function blocksMatch(bl: readonly Block[], old: string, fresh: string): boolean {
  const az = old.split("\n"), nz = fresh.split("\n");
  for (const b of bl) {
    let a = b.header.oldCount === 0 ? b.header.oldStart : b.header.oldStart - 1;
    let n = b.header.newCount === 0 ? b.header.newStart : b.header.newStart - 1;
    for (const z of b.rows) {
      const c = z[0], text = z.slice(1);
      if (c === "\\") continue;
      if (c === "+") { if (nz[n] !== text) return false; n += 1; }
      else if (c === "-") { if (az[a] !== text) return false; a += 1; }
      else { if (az[a] !== text || nz[n] !== text) return false; a += 1; n += 1; }
    }
    if (a - (b.header.oldCount === 0 ? b.header.oldStart : b.header.oldStart - 1) !== b.header.oldCount) return false;
    if (n - (b.header.newCount === 0 ? b.header.newStart : b.header.newStart - 1) !== b.header.newCount) return false;
  }
  return true;
}

// ── The kind of a diff ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface DiffKind {
  empty: boolean;
  binary: boolean;
  /** `diff --cc` (conflict, merge): blocks with `@@@` cannot be applied individually. */
  combined: boolean;
  renaming: { from: string; destination: string } | null;
  fresh: boolean;
  deleted: boolean;
  /** Only the mode (e.g. executable) — no text changed. */
  onlyMode: boolean;
  /** The NEW side is a symbolic link (mode 120000 in the header) — then the link itself is compared, not its target. */
  referenceNew: boolean;
  /** File ↔ link (git writes two sections for it: deleted and new) — no side-by-side comparison. */
  typeSwitch: boolean;
}
export function diffKind(diff: string): DiffKind {
  const d = String(diff ?? "");
  const from = /^rename from (.*)$/m.exec(d)?.[1];
  const renamedTo = /^rename to (.*)$/m.exec(d)?.[1];
  const mode = /^old mode \d+$/m.test(d) && /^new mode \d+$/m.test(d);
  return {
    empty: d.trim() === "",
    binary: /^Binary files .* differ$/m.test(d) || /^GIT binary patch$/m.test(d),
    combined: /^diff --(cc|combined) /m.test(d),
    renaming: from !== undefined && renamedTo !== undefined ? { from: unquote(from), destination: unquote(renamedTo) } : null,
    fresh: /^new file mode /m.test(d),
    deleted: /^deleted file mode /m.test(d),
    onlyMode: mode && !/^@@/m.test(d),
    referenceNew: /^(?:new file mode|new mode) 120000$/m.test(d) || /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m.test(d),
    typeSwitch: /^deleted file mode /m.test(d) && /^new file mode /m.test(d),
  };
}
/** A path as git writes it (with `core.quotePath` in quotation marks, C escapes, octal bytes in UTF-8) → the path. */
export function unquote(s: string): string {
  const t = s.replace(/\t$/, "");
  if (!(t.startsWith("\"") && t.endsWith("\"") && t.length >= 2)) return t;
  const bytes: number[] = [];
  const inside = t.slice(1, -1);
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, "\"": 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c !== "\\") { for (const b of new TextEncoder().encode(c)) bytes.push(b); continue; }
    const n = inside[i + 1];
    if (/[0-7]/.test(n ?? "")) { bytes.push(parseInt(inside.slice(i + 1, i + 4), 8)); i += 3; }
    else if (n === undefined) bytes.push(92);
    else { bytes.push(ESC[n] ?? n.charCodeAt(0)); i += 1; }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ── Multi-file patch (stash, whole commit via one patch) ───────────────────────────────────────────────────────────────────────
export interface PatchFile { path: string; old: string | null; status: "A" | "D" | "R" | "M"; diff: string; plus: number; minus: number; binary: boolean }
const pathFrom = (row: string | undefined, prefix: string) => {
  if (row === undefined) return null;
  const p = unquote(row);
  if (p === "/dev/null") return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
};
/** A patch over several files (`git stash show -p`, `git show -p`) → per file its diff. Text before the first `diff --git` (header of a
 *  commit, `--stat`) is dropped. */
export function splitFiles(patch: string): PatchFile[] {
  const rows = String(patch ?? "").split("\n");
  const beginnings: number[] = [];
  rows.forEach((z, i) => { if (z.startsWith("diff --git ")) beginnings.push(i); });
  return beginnings.map((from, k) => {
    const until = k + 1 < beginnings.length ? beginnings[k + 1] : rows.length;
    const part = rows.slice(from, until);
    const diff = part.join("\n").replace(/\n*$/, "\n");
    const kind = diffKind(diff);
    const minusRow = part.find((z) => z.startsWith("--- "))?.slice(4);
    const plusRow = part.find((z) => z.startsWith("+++ "))?.slice(4);
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(part[0]);
    const newPath = kind.renaming?.destination ?? pathFrom(plusRow, "b/") ?? pathFrom(minusRow, "a/") ?? (header ? unquote(header[2]) : "");
    const oldPath = kind.renaming?.from ?? null;
    let plus = 0, minus = 0, inBlock = false;
    for (const z of part) {
      if (z.startsWith("@@")) { inBlock = true; continue; }
      if (!inBlock) continue;
      if (z.startsWith("+")) plus += 1; else if (z.startsWith("-")) minus += 1;
    }
    const status = kind.renaming ? "R" : kind.fresh ? "A" : kind.deleted ? "D" : "M";
    return { path: newPath, old: oldPath, status, diff, plus, minus, binary: kind.binary };
  });
}
/** The numbers of a multi-file patch — the same form as the hover card (lib/git-card.ts, the number parts). */
export function patchCounts(d: readonly PatchFile[]): { files: number; plus: number; minus: number; binary: number } {
  return d.reduce((s, x) => ({ files: s.files + 1, plus: s.plus + x.plus, minus: s.minus + x.minus, binary: s.binary + (x.binary ? 1 : 0) }), { files: 0, plus: 0, minus: 0, binary: 0 });
}

// ── Texts from a patch alone ───────────────────────────────────────────────────────────────────────────────────────────────────
// Without the whole text (old server, stash, file too large) the tab shows only the places of the patch: both texts from the blocks
// (context on both sides, "-" left, "+" right), between two blocks ONE gap line on both sides (equal, so never marked as a
// change) with the number of hidden lines. The numbers per line come from the headers (`null` = gap).
export interface PatchDoc { old: string; fresh: string; oldNumbers: (number | null)[]; newNumbers: (number | null)[]; gaps: { rowOld: number; rowNew: number; count: number }[] }
export const GAP = "⋯";
export function patchDocuments(diff: string): PatchDoc | null {
  const { hunks } = parseDiff(diff);
  if (hunks.length === 0 || diffKind(diff).combined) return null;
  const old: string[] = [], fresh: string[] = [], oldNumbers: (number | null)[] = [], newNumbers: (number | null)[] = [];
  const gaps: PatchDoc["gaps"] = [];
  let oldEnd = 0;
  for (const hunk of hunks) {
    const rows = hunk.split("\n");
    const header = hunkHeader(rows[0]);
    if (!header) return null;
    const body = rows.slice(1);
    while (body.length && body[body.length - 1] === "") body.pop();
    const oldBeginning = header.oldCount === 0 ? header.oldStart + 1 : header.oldStart;
    const hidden = oldBeginning - oldEnd - 1;
    if (hidden > 0) {
      gaps.push({ rowOld: old.length + 1, rowNew: fresh.length + 1, count: hidden });
      old.push(GAP); fresh.push(GAP); oldNumbers.push(null); newNumbers.push(null);
    }
    let a = oldBeginning, n = header.newCount === 0 ? header.newStart + 1 : header.newStart;
    for (const z of body) {
      const c = z[0], text = z.slice(1);
      if (c === "\\") continue;
      if (c === "+") { fresh.push(text); newNumbers.push(n++); }
      else if (c === "-") { old.push(text); oldNumbers.push(a++); }
      else { old.push(text); fresh.push(text); oldNumbers.push(a++); newNumbers.push(n++); }
    }
    oldEnd = a - 1;
  }
  return { old: old.join("\n"), fresh: fresh.join("\n"), oldNumbers, newNumbers, gaps };
}

// ── What the server says about a side (whitelist) ──────────────────────────────────────────────────────────────────────────────
export type Page =
  | { kind: "text"; text: string; reference?: boolean; stage?: number }
  | { kind: "missing" } | { kind: "binary" } | { kind: "large" } | { kind: "submodule" } | { kind: "workingTree" };
const PAGES_KINDS: readonly string[] = ["text", "missing", "binary", "large", "submodule", "workingTree"];
/** Null = unknown (the server does not say it or in a form nobody here knows) — NEVER an empty text in its place. */
export function normPage(raw: unknown): Page | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== "string" || !PAGES_KINDS.includes(o.kind)) return null;
  if (o.kind === "text") {
    if (typeof o.text !== "string") return null;
    return { kind: "text", text: o.text, ...(o.reference === true ? { reference: true } : {}), ...(o.stage === 2 ? { stage: 2 } : {}) };
  }
  return { kind: o.kind } as Page;
}
/** `conflict`: the path has only stages 1–3 in the index (server git.js `isConflict`) — also without our side (DU, UA). */
export interface ContentResponse { diff: string; clipped: boolean; prior: Page; after: Page; conflict?: true }
/** The answer of `/git/diff` or `/git/show` with `content: true`. `path` = the path as it was requested (the server echoes it).
 *  Null: an old server (it does not know `content` and answers without `prior`/`after`) or a foreign
 *  answer — then the tab shows the patch alone, with an announcement. */
export function normContent(raw: unknown, path: string): ContentResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if ((o.path ?? o.path) !== path || typeof o.diff !== "string") return null;
  const prior = normPage(o.prior), after = normPage(o.after);
  if (!prior || !after) return null;
  return { diff: o.diff, clipped: o.clipped === true, prior, after, ...(o.conflict === true ? { conflict: true as const } : {}) };
}
/** The content of a time axis comparison: per side the file IN its commit — the answer with `content`
 *  carries it as `after` (`prior` would be the parent state) —, left the selected entry, right the clicked one; like the git extension of
 *  VS Code 1.143 (`vscode.diff(n.ref === "" ? t : toGitUri(t, n.ref), e.ref === "" ? t : toGitUri(t, e.ref), …)`, n = selected). `read` fetches
 *  one side (null: the server does not know `content`) — null if one is missing. */
export async function comparisonContent<S>(left: S, right: S, read: (page: S) => Promise<ContentResponse | null>): Promise<ContentResponse | null> {
  const [l, r] = await Promise.all([read(left), read(right)]);
  if (!l || !r) return null;
  return { diff: "", clipped: false, prior: l.after, after: r.after };
}
/** What `/files/read` says about a file — only the fields the comparison of two files needs. */
export type FileReading = { content?: string | null; tooLarge?: boolean; binary?: boolean };
/** The comparison of two files: left the selected one as text, right the clicked one as the working tree (its buffer,
 *  editable — VS Code `{ original: selected, modified: clicked }`). `right` = the raw reading of the right file (text with checksum). */
export async function filesContent<P, L extends FileReading>(left: P, right: P, read: (path: P) => Promise<L>): Promise<{ content: ContentResponse; right: L }> {
  const [l, r] = await Promise.all([read(left), read(right)]);
  const prior: Page = typeof l.content === "string" ? { kind: "text", text: l.content } : l.tooLarge ? { kind: "large" } : l.binary ? { kind: "binary" } : { kind: "missing" };
  return { content: { diff: "", clipped: false, prior, after: { kind: "workingTree" } }, right: r };
}

// ── What the tab shows ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Tone = "dim" | "warn" | "danger";
export interface Announcement { key: string; values?: Record<string, string | number>; tone: Tone }
export type Display =
  | { kind: "merge"; old: string; fresh: string; oldMissing: boolean; newMissing: boolean; writable: boolean; blocks: Block[]; blocksLocked: Announcement | null; announcements: Announcement[] }
  | { kind: "patch"; doc: PatchDoc; announcements: Announcement[] }
  | { kind: "announcement"; announcements: Announcement[]; raw: string | null };
export interface Input {
  source: DiffSource;
  /** Answer with content or null (old server / patch source). */
  content: ContentResponse | null;
  /** The patch if there is no content (stash, old server). */
  patch: string | null;
  patchClipped?: boolean;
  /** The working tree (files/read) for `after: workingTree`: text, or why there is none. */
  workingTree?: { text: string } | { binary: true } | { tooBig: true } | { missing: true } | { error: string } | null;
}
const A = (key: string, tone: Tone = "dim", values?: Record<string, string | number>): Announcement => ({ key, tone, ...(values ? { values } : {}) });
const textOf = (s: Page): string | null => (s.kind === "text" ? s.text : s.kind === "missing" ? "" : null);
/** The decision of the tab — one of three forms, each with its announcements. */
export function display(e: Input): Display {
  const announcements: Announcement[] = [];
  const kind = diffKind(e.content?.diff ?? e.patch ?? "");
  if (kind.renaming) announcements.push(A("Renamed: {from} → {to}", "dim", { from: kind.renaming.from, to: kind.renaming.destination }));
  // The file was renamed since opening — the diff follows (title, buffer), the left side stays the index of the old name.
  else if (e.source.kind === "change" && e.source.current) announcements.push(A("Renamed: {from} → {to}", "dim", { from: targetPath(e.source.repo, e.source.file), to: targetPath(e.source.repo, e.source.current) }));
  if (!e.content) {
    const patch = e.patch ?? "";
    if (e.patchClipped) announcements.push(A("Cut at 2 MB — the rest of this file is not shown here.", "warn"));
    if (kind.binary) return { kind: "announcement", announcements: [...announcements, A("Binary file — no text comparison.")], raw: null };
    if (kind.combined) return { kind: "announcement", announcements: [...announcements, A("Combined diff (conflict or merge) — shown as text.", "warn")], raw: patch };
    if (kind.empty || kind.onlyMode) return { kind: "announcement", announcements: [...announcements, A(kind.onlyMode ? "Only the file mode changed." : "No text differences.")], raw: null };
    const doc = patchDocuments(patch);
    if (!doc) return { kind: "announcement", announcements: [...announcements, A("This diff cannot be shown side by side — shown as text.", "warn")], raw: patch };
    if (e.source.kind !== "stash") announcements.push(A("Only the changed parts — the server does not deliver the full texts yet (after its next deploy).", "warn"));
    return { kind: "patch", doc, announcements };
  }
  const { prior, after, clipped } = e.content;
  if (prior.kind === "submodule" || after.kind === "submodule") return { kind: "announcement", announcements: [...announcements, A("Submodule — the commit it points to has changed.")], raw: e.content.diff || null };
  if (prior.kind === "binary" || after.kind === "binary" || kind.binary) return { kind: "announcement", announcements: [...announcements, A("Binary file — no text comparison.")], raw: null };
  // A conflict: also without our side (DU "deleted by us", UA "added by them") — the server
  // says it (`conflict`); stage 2 on the left is also said by a server that does not know `conflict` yet.
  const conflict = e.content.conflict === true || (prior.kind === "text" && prior.stage === 2);
  // A link in the working tree: files/read follows it and delivers the file BEHIND it, git compares the link itself — on the left
  // would stand the path, on the right the content of its target, and saving would write into the target file. The places of the patch are
  // shown (both sides the link), the right only readable; a switch file ↔ link stands there as text.
  if (after.kind === "workingTree" && ((prior.kind === "text" && prior.reference) || kind.referenceNew)) {
    if (kind.typeSwitch) return { kind: "announcement", announcements: [...announcements, A("Type changed (file ↔ symbolic link) — shown as text.", "warn")], raw: e.content.diff || null };
    if (kind.empty) return { kind: "announcement", announcements: [...announcements, A("Symbolic link — the link itself is compared (the path it points to), not the file behind it."), A("No text differences.")], raw: null };
    const doc = patchDocuments(e.content.diff);
    const announcement = A("Symbolic link — the link itself is compared (the path it points to); the right side is read-only.");
    if (doc) return { kind: "patch", doc, announcements: [...announcements, announcement] };
    return { kind: "announcement", announcements: [...announcements, announcement], raw: e.content.diff || null };
  }
  let newText: string | null;
  let newMissing = after.kind === "missing";
  if (after.kind === "workingTree") {
    const w = e.workingTree;
    if (!w) return { kind: "announcement", announcements: [...announcements, A("The file could not be read: {error}", "danger", { error: "—" })], raw: null };
    if ("text" in w) newText = w.text;
    else if ("missing" in w) { newText = ""; newMissing = true; }
    else if ("binary" in w) return { kind: "announcement", announcements: [...announcements, A("Binary file — no text comparison.")], raw: null };
    else if ("tooBig" in w) newText = null;
    else return { kind: "announcement", announcements: [...announcements, A("The file could not be read: {error}", "danger", { error: w.error })], raw: null };
  } else newText = textOf(after);
  const oldText = textOf(prior);
  if (oldText === null || newText === null) {
    // Too large (a side over 2 MB): the patch alone, if it is complete.
    const doc = !clipped ? patchDocuments(e.content.diff) : null;
    const tooBig = A("The file is too large for a side-by-side comparison (over 2 MB) — only the changed parts.", "warn");
    if (doc) return { kind: "patch", doc, announcements: [...announcements, tooBig] };
    return { kind: "announcement", announcements: [...announcements, A("The file is too large to compare (over 2 MB).", "warn")], raw: null };
  }
  // Both sides are missing: the file exists neither left nor right — an empty area would read "no change", but it is not.
  if (prior.kind === "missing" && newMissing && !conflict) return { kind: "announcement", announcements: [...announcements, A("The file exists on neither side — it has been removed or renamed in the meantime.", "warn")], raw: null };
  if (conflict) {
    if (prior.kind === "text" && prior.stage === 2) announcements.push(A("Conflict — left our side (HEAD), right the file with the conflict markers.", "warn"));
    else if (e.source.kind === "change" && e.source.staged) announcements.push(A("Conflict — the index holds no resolved version yet; resolve the conflict first.", "warn"));
    else announcements.push(A("Conflict — our side (HEAD) does not have the file (deleted by us, or added only on the other side); on the right, the file in the working tree.", "warn"));
  } else {
    if (prior.kind === "missing" && !newMissing) announcements.push(A(e.source.kind === "change" && !e.source.staged ? "New file (untracked)." : "New file."));
    if (newMissing && prior.kind !== "missing") announcements.push(A("Deleted file."));
  }
  if (prior.kind === "text" && prior.reference) announcements.push(A("Symbolic link — the link itself is compared (the path it points to), not the file behind it."));
  // Equal texts are a statement, not an empty area: everything staged/reverted, only the mode, a rename without a change.
  if (kind.onlyMode) announcements.push(A("Only the file mode changed."));
  else if (oldText === newText && prior.kind === "text" && !newMissing) announcements.push(A("No text differences."));
  const writable = sourceWritable(e.source) && !newMissing;
  const actions = blockActions(e.source);
  let bl: Block[] = [];
  let locked: Announcement | null = null;
  if (actions.length) {
    const b = blocks(e.content.diff);
    if (clipped) locked = A("The diff is cut (over 2 MB) — changes cannot be staged one by one here.", "warn");
    else if (conflict || kind.combined) locked = A("Conflict — changes can be staged one by one only after resolving it.", "warn");
    else if (b && !blocksMatch(b, oldText, newText)) locked = lockReason(b, oldText, newText);
    else bl = b ?? [];
  }
  if (clipped) announcements.push(A("Cut at 2 MB — the rest of this file is not shown here.", "warn"));
  return { kind: "merge", old: oldText, fresh: newText, oldMissing: prior.kind === "missing", newMissing, writable, blocks: bl, blocksLocked: locked, announcements };
}

/** Why the blocks do not fit the texts shown — the RIGHT reason: if it fits once
 *  CRLF is read as LF, git compares after a line-ending conversion (core.autocrlf, `eol` in .gitattributes), and
 *  "reload" would never help; otherwise the state is stale. (A link no longer arrives here — it stands as a patch, see `display`.) */
function lockReason(b: readonly Block[], old: string, fresh: string): Announcement {
  const lf = (t: string) => t.replace(/\r\n/g, "\n");
  if ((old.includes("\r\n") || fresh.includes("\r\n")) && blocksMatch(b, lf(old), lf(fresh))) {
    return A("Line endings: the file uses CRLF and git compares it converted (core.autocrlf or eol in .gitattributes) — changes cannot be applied one by one here.", "warn");
  }
  return A("The state has changed — reload to stage changes.", "warn");
}

// ── Side by side or inline ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Below this width of the tab (container, not window) the diff stands inline — like VS Code `renderSideBySideInlineBreakpoint`. */
export const INLINE_UNDER_PX = 900;
export const VIEW_KEY = "cbase-diff-view";
/** `width` 0 = not measured yet: then the choice applies (no jumping on the first frame). */
export function effectiveView(choice: DiffView, width: number): { view: DiffView; forced: boolean } {
  if (choice === "sideBySide" && width > 0 && width < INLINE_UNDER_PX) return { view: "inline", forced: true };
  return { view: choice, forced: false };
}
export function readView(raw: string | null): DiffView {
  return raw === "inline" ? "inline" : "sideBySide";
}

// ── Several files ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** At most this many files stand one below the other (one editor per file); the rest with an announcement. */
export const WHOLE_MAX = 100;
/** Up to here the files of a commit are expanded on opening (and load), beyond that collapsed. */
export const WHOLE_OPEN = 30;
export function wholeCap(shown: number, total: number | null, clipped: boolean | null): Announcement | null {
  const n = Math.min(shown, WHOLE_MAX);
  if (total !== null && total > n) return A("Only the first {n} of {m} files — the rest is not shown here.", "warn", { n, m: total });
  if (shown > WHOLE_MAX || clipped) return A("Only the first {n} files — there are more.", "warn", { n });
  return null;
}

// ── A text is reset from outside ───────────────────────────────────────────────────────────────────────────────────────────────
/** The smallest replacement from `old` to `fresh` (common start and common end stay) — a re-read text replaces this way
 *  only what changed: cursor, selection and scroll position outside it stay where they were. Null = equal. */
export function minimalChange(old: string, fresh: string): { from: number; to: number; insert: string } | null {
  if (old === fresh) return null;
  const max = Math.min(old.length, fresh.length);
  let a = 0;
  while (a < max && old.charCodeAt(a) === fresh.charCodeAt(a)) a++;
  let e = 0;
  while (e < max - a && old.charCodeAt(old.length - 1 - e) === fresh.charCodeAt(fresh.length - 1 - e)) e++;
  return { from: a, to: old.length - e, insert: fresh.slice(a, fresh.length - e) };
}

// ── Unsaved ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A draft (held per tab) counts only if it differs from the saved text. */
export function draftCounts(draft: string | null | undefined, saved: string): boolean {
  return typeof draft === "string" && draft !== saved;
}
