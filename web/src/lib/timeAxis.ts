// The timeline of the active file styled like VS Code — the PURE computations. Drawn in components/code/explorer/TimeAxis.tsx; the
// server is `POST …/git/log` with `timeAxis: true` (server git.js gitTimeAxis).
//
//   timeAxisTarget   which repo carries the file (the one with the longest matching relPath, like CodePane `repoForPath`) and its path in it —
//                   or why there is no timeline: no file in front, the file is in no repo (VS Code: "The active editor cannot
//                   provide timeline information."). If the repos are not read yet (`null`), that is UNKNOWN ("loading"), not "no
//                   repo" (empty is not unknown).
//   normTimeAxis   the allow-list for the response: entries without hash or file are dropped, missing fields are unknown (null), never invented.
//                   An old server does not know `timeAxis` and answers `{ commits }` — that is `null` (UNKNOWN, not "empty").
//   entrySource   the source of the diff tab for an entry: the commit, the file THERE (relative to the repo), for a rename the
//                   old path, the file TODAY (`current`, if it is named differently — title, timeline and "Open File" mean it) and the
//                   entry before it (`prior`, VS Code `previousRef`: the hash of the next older entry, for the oldest the empty tree)
//                   (lib/chat-tabs.ts `DiffSource` "commit" — the type is mirrored here, the leaf module stays without imports).
//   diffTitle       the title of that diff as VS Code 1.143 (`git.timeline.openDiff`: "{0} ({1}) ↔ {0} ({2})" with `shortenRef`, eight characters):
//                   "README.md (prev1234) ↔ README.md (abcd1234)"; without a known predecessor "README.md (abcd1234^) ↔ README.md (abcd1234)".
//   commitTitle     the title of the whole commit as VS Code (`git.timeline.viewCommit`): "abcd1234 - <first line of the subject>".
//   shortTime       the relative time as VS Code `fromNow(t)` (without "ago", short units: "now", "45 secs", "3 days", "2 wks").
//   timeColumn      per entry this time and whether it equals the one of the row above (VS Code `hideRelativeTime` — then only
//                   a fine dash is shown, the time only on hover).
//   pagesSize       how many entries a page has (VS Code `timeline.pageSize: null`: as many rows as the view shows, minus
//                   one, at least 20; at most the server's cap).
//   cursorOf /     "Load more" (VS Code): the cursor is the LAST entry — its hash and the path of the file IN it (across a
//   appendTo        rename; an offset would lose it, server git.js); the next page is appended (duplicate hashes are dropped).
// Guard: web/test/timeAxis.test.mjs (with counter-proofs).

/** The server's cap per page (server git.js TIME_AXIS_CAP). */
export const TIME_AXIS_CAP = 200;
/** The height of a row (VS Code `TimelineListVirtualDelegate.ItemHeight`). */
export const TIME_AXIS_ROW = 22;

export type TimeAxisEntry = {
  hash: string; short: string; subject: string; author: string; email: string | null;
  /** Unix seconds (committer time); null = unknown. */
  time: number | null;
  /** The path of the file IN this commit (relative to the repo). */
  file: string;
  /** At the commit of a rename, the old path. */
  old?: string;
};
export type TimeAxis = { entries: TimeAxisEntry[]; clipped: boolean };
export type TimeAxisTarget = { kind: "ok"; repo: string; file: string } | { kind: "no-file" } | { kind: "no-repo" } | { kind: "unknown" };
type T = (key: string, params?: Record<string, string | number>) => string;

/** The repo of file `path` (project-relative) from the repos `relPaths` (null: not read yet), and its path in it. */
export function timeAxisTarget(path: string | null, relPaths: readonly string[] | null): TimeAxisTarget {
  if (!path) return { kind: "no-file" };
  if (!relPaths) return { kind: "unknown" };
  let best: string | null = null;
  for (const r of relPaths) {
    if (r === "" || path.startsWith(`${r}/`)) { if (best === null || r.length > best.length) best = r; }
  }
  if (best === null) return { kind: "no-repo" };
  return { kind: "ok", repo: best, file: best ? path.slice(best.length + 1) : path };
}

const text = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

/** The response checked — `null`: the server does not know the timeline (an old server answers `{ commits }`). */
export function normTimeAxis(raw: unknown): TimeAxis | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { entries?: unknown }).entries)) return null;
  const r = raw as { entries: unknown[]; clipped?: unknown };
  const entries: TimeAxisEntry[] = [];
  for (const x of r.entries) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    const hash = text(e.hash), file = text(e.file);
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || !file) continue;
    const time = typeof e.time === "number" && Number.isFinite(e.time) ? e.time : null;
    const old = text(e.old);
    entries.push({
      hash, short: text(e.short) ?? hash.slice(0, 7), subject: typeof e.subject === "string" ? e.subject : "", author: typeof e.author === "string" ? e.author : "",
      email: text(e.email), time, file, ...(old && old !== file ? { old: old } : {}),
    });
  }
  return { entries, clipped: r.clipped === true };
}

/** Git's empty tree (VS Code `getEmptyTree`) — the predecessor of the oldest entry. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** A ref shortened as VS Code `GitTimelineItem.shortenRef`: eight characters, a trailing "^" stays; "", "~", "HEAD" unchanged. */
export function shortRef(ref: string): string {
  if (ref === "" || ref === "~" || ref === "HEAD") return ref;
  return ref.endsWith("^") ? `${ref.slice(0, 8)}^` : ref.slice(0, 8);
}
/** The predecessor of entry `i` as in VS Code (`commits[i + 1]?.hash ?? emptyTree` — VS Code fetches one entry MORE than it shows): the
 *  next older loaded entry; at the last loaded one the empty tree if there is no older page (`more` false) — otherwise it is
 *  unknown (null: the title says `<ref>^`). */
export const priorOf = (entries: readonly TimeAxisEntry[], i: number, more = false): string | null => entries[i + 1]?.hash ?? (more ? null : EMPTY_TREE);

export type CommitSource = { kind: "commit"; repo: string; hash: string; file: string; old?: string; current?: string; prior?: string };
/** The source of the diff tab (lib/chat-tabs.ts `DiffSource` "commit"): the commit, the file there, for a rename the old path; `current`
 *  = the file today (relative to the repo — only if named differently than in the commit), `prior` = the predecessor (`priorOf`). */
export function entrySource(repo: string, e: TimeAxisEntry, o: { current?: string | null; prior?: string | null } = {}): CommitSource {
  return {
    kind: "commit", repo, hash: e.hash, file: e.file, ...(e.old ? { old: e.old } : {}),
    ...(o.current && o.current !== e.file ? { current: o.current } : {}), ...(o.prior ? { prior: o.prior } : {}),
  };
}

/** "Open Commit" (VS Code `timeline.viewCommit` of the Git extension): the WHOLE commit of an entry as a diff (all files). */
export function commitSource(repo: string, e: TimeAxisEntry): { kind: "commit-whole"; repo: string; hash: string } {
  return { kind: "commit-whole", repo, hash: e.hash };
}
/** … and its title as VS Code (`${shortRef} - ${first line of the message}`). */
export function commitTitle(e: TimeAxisEntry): string {
  const i = e.subject.indexOf("\n");
  return `${shortRef(e.hash)} - ${i < 0 ? e.subject : e.subject.slice(0, i)}`;
}

/** The title of a commit's diff as VS Code: "{0} ({1}) ↔ {0} ({2})" — `file` the file TODAY (VS Code takes the name of the timeline's
 *  resource), `ref` the commit, `prior` its predecessor (without it `<ref>^`, as the git bar shows a commit). */
export function diffTitle(file: string, ref: string, prior?: string | null): string {
  const n = file.slice(file.lastIndexOf("/") + 1);
  return `${n} (${shortRef(prior || `${ref}^`)}) ↔ ${n} (${shortRef(ref)})`;
}

const MINUTE = 60, HOUR = 3600, DAY = 86_400, WEEK = 7 * DAY, MONTH = 30 * DAY, YEAR = 365 * DAY;

/** The relative time as VS Code `fromNow(time)`: without "ago", short units; under 30 s "now", more than 30 s ahead "in …". */
export function shortTime(ms: number, now: number, t: T): string {
  const sec = Math.round((now - ms) / 1000);
  if (sec < -30) return t("in {time}", { time: shortTime(now + (now - ms), now, t) });
  if (sec < 30) return t("now");
  const unit = (n: number, one: string, more: string) => (n === 1 ? t(one) : t(more, { n }));
  if (sec < MINUTE) return unit(sec, "1 sec", "{n} secs");
  if (sec < HOUR) return unit(Math.floor(sec / MINUTE), "1 min", "{n} mins");
  if (sec < DAY) return unit(Math.floor(sec / HOUR), "1 hr", "{n} hrs");
  if (sec < WEEK) return unit(Math.floor(sec / DAY), "1 day", "{n} days");
  if (sec < MONTH) return unit(Math.floor(sec / WEEK), "1 wk", "{n} wks");
  if (sec < YEAR) return unit(Math.floor(sec / MONTH), "1 mo", "{n} mos");
  return unit(Math.floor(sec / YEAR), "1 yr", "{n} yrs");
}

/** Per entry the relative time (null: unknown) and whether it equals the one of the row above (VS Code `hideRelativeTime`). */
export function timeColumn(entries: readonly TimeAxisEntry[], now: number, t: T): { text: string | null; duplicate: boolean }[] {
  let prior: string | undefined;
  return entries.map((e) => {
    if (e.time === null) return { text: null, duplicate: false };
    const time = shortTime(e.time * 1000, now, t);
    const duplicate = prior !== undefined && time === prior;
    prior = time;
    return { text: time, duplicate };
  });
}

/** Entries per page from the view's height (VS Code `timeline.pageSize: null`). */
export function pagesSize(height: number): number {
  return Math.min(TIME_AXIS_CAP, Math.max(20, Math.floor(height / TIME_AXIS_ROW) - 1));
}

/** The cursor of the next page — null: there is no older one. `file` is the path IN this commit (relative to the repo). */
export function cursorOf(d: TimeAxis): { after: string; file: string } | null {
  const last = d.entries[d.entries.length - 1];
  return d.clipped && last ? { after: last.hash, file: last.file } : null;
}

/** Append the next page at the end; a hash that is already there is dropped. `clipped` is the new page's. */
export function appendTo(old: TimeAxis, fresh: TimeAxis): TimeAxis {
  const present = new Set(old.entries.map((e) => e.hash));
  return { entries: [...old.entries, ...fresh.entries.filter((e) => !present.has(e.hash))], clipped: fresh.clipped };
}
