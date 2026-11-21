"use client";
// A file's timeline as in VS Code — the TIMELINE section at the bottom of the explorer (ExplorerSections.tsx; there also pin, refresh and
// the source filter). One row per commit of the file as in VS Code: the commit icon, the subject, the author dimmed beside it, on the
// right the short time like VS Code `fromNow` ("3 days", without "ago", lib/timeAxis.ts `shortTime`) — if the same stands above, only a thin
// dash (VS Code `hideRelativeTime`), the time on hover; the tooltip names author, e-mail, full date and subject. A click opens the commit's
// diff for the file, title as in VS Code "README.md (1a2b3c4d) ↔ README.md (5e6f7a8b)" (`diffTitle`, on the left the next older entry, for
// the oldest the empty tree; in the chat a diff tab, lib/diff-tab.ts). The server is `POST …/git/log` with `timeAxis: true` (across
// renames, capped per page): the first page as large as the view is high (VS Code `timeline.pageSize`, `pagesSize`), older ones via "Load
// more" as the last row (VS Code `LoadMoreCommand`) — with the cursor of the last entry (`cursorOf`), not an offset (across a rename it
// would lose the file, server git.js). Empty states as in VS Code: no editor or no file in a repo, loading, no entries, all sources
// filtered out. It is re-read on file change, when the repos' state changes (`state`, a new commit) and via "Refresh" (`seq`) — as many
// entries as were already loaded.
// The diff is a tab — a click opens it as a preview (italic, the next click replaces it), a double click pinned (VS Code: a single click in
// a list opens with `preview`, a double click `pinned`). The context menu like the git extension (`timeline/item/context`): "Open
// Changes" · "Open Commit" (the whole commit, `git.timeline.viewCommit`, also as a button in the row, codicon diff-multiple) | "Compare with
// Selected" · "Select for Compare" (`3_compare` — lib/comparison.ts `timeAxisPlan`, the comparison as a preview tab "README.md (abcd1234)
// ↔ README.md (ef567890)") | "Copy Commit Hash" · "Copy Commit Message" (`5_copy`). The timeline's own "Compare Selected" (VS Code: two
// marked entries) is missing — the timeline has no multi-selection.
import { useEffect, useRef, useState } from "react";
import type { DiffSource } from "@/lib/chat-tabs";
import { openEditorMenu } from "@/components/code/EditorMenu";
import { copyText } from "@/components/code/TabBar";
import { TitleSymbolSvg } from "@/components/code/EditorTitleSymbols";
import { dateLocale } from "@/lib/i18n";
import { timeAxisPlan, type TimeAxisChoice } from "@/lib/comparison";
import type { TimeAxisComparison } from "@/components/code/comparison-connection";
import { fullDate } from "@/lib/git-card";
import {
  TIME_AXIS_CAP, commitSource, commitTitle, cursorOf, diffTitle, entrySource, appendTo, shortTime, normTimeAxis, pagesSize, priorOf, timeAxisTarget, timeColumn,
  type TimeAxis as TimeAxisData, type TimeAxisEntry,
} from "@/lib/timeAxis";

type T = (key: string, params?: Record<string, string | number>) => string;
type Calls = <R = unknown>(rest: string, opts?: RequestInit) => Promise<R>;
/** `fixed`: a double click (otherwise a preview tab). */
/** `fixed`: double click (otherwise as a preview, italic); `focus: false`: focus stays in the timeline (VS Code `preserveFocus`). */
export type TimeAxisOpen = (source: DiffSource, o: { title: string; short: string; fixed?: boolean; focus?: boolean }) => void;

// The codicon git-commit: a circle on a line.
const CommitSymbol = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden><circle cx="8" cy="8" r="2.6" /><path d="M1.5 8h3.9M10.6 8h3.9" /></svg>
);

type Situation = { key: string; kind: "loading" } | { key: string; kind: "finished"; data: TimeAxisData } | { key: string; kind: "unknown" } | { key: string; kind: "error"; text: string };

const ROW = "cb-tree-row gap-1.5 pl-2 outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent";

export function TimeAxisView({ t, calls, file, repos, state, seq, gitOn, onOpen, comparison }: {
  t: T;
  calls: Calls;
  /** The timeline's file (project-relative; the active or the pinned one) or null. */
  file: string | null;
  /** The repos (`relPath`) — null: not read yet. */
  repos: readonly string[] | null;
  /** The repos' state (changes with a commit) — a new one re-reads. */
  state: string;
  /** "Refresh": grows, re-reads. */
  seq: number;
  /** The source "Git History" is not filtered out (VS Code `timeline.excludeSources`). */
  gitOn: boolean;
  onOpen: TimeAxisOpen;
  /** "Select for Compare" (components/code/comparison-connection.ts) — without: no group in the menu. */
  comparison?: TimeAxisComparison;
}) {
  const target = timeAxisTarget(file, repos);
  const key = target.kind === "ok" ? `${target.repo}\u0000${target.file}` : target.kind;
  const [situation, setSituation] = useState<Situation | null>(null);
  const [more, setMore] = useState<{ key: string; error: string | null } | null>(null); // "Load more" is running or failed
  const run = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const loaded = useRef(0); // how many entries stand — "Refresh" re-reads that many
  useEffect(() => {
    if (target.kind !== "ok" || !gitOn) return;
    const mine = ++run.current;
    setMore(null);
    setSituation((l) => (l && l.key === key && l.kind === "finished" ? l : { key, kind: "loading" })); // re-read: the old list stays
    const equal = situation?.key === key ? loaded.current : 0;
    const limit = Math.min(TIME_AXIS_CAP, Math.max(pagesSize(surface.current?.clientHeight ?? 0), equal));
    calls<unknown>("/git/log", { method: "POST", body: JSON.stringify({ repo: target.repo, file: target.file, timeAxis: true, limit }) })
      .then((raw) => {
        if (mine !== run.current) return;
        const data = normTimeAxis(raw);
        loaded.current = data?.entries.length ?? 0;
        setSituation(data ? { key, kind: "finished", data } : { key, kind: "unknown" });
      })
      .catch((e: unknown) => { if (mine === run.current) setSituation({ key, kind: "error", text: String((e as Error)?.message || e) }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state, seq, gitOn, calls]);

  // "Load more": the next page from the last entry, with the file's path IN it (across a rename).
  const loadMore = () => {
    if (target.kind !== "ok" || situation?.kind !== "finished" || situation.key !== key || more?.error === null) return;
    const c = cursorOf(situation.data);
    if (!c) return;
    const mine = run.current;
    setMore({ key, error: null });
    calls<unknown>("/git/log", { method: "POST", body: JSON.stringify({ repo: target.repo, file: c.file, timeAxis: true, limit: pagesSize(surface.current?.clientHeight ?? 0), after: c.after }) })
      .then((raw) => {
        if (mine !== run.current) return;
        const fresh = normTimeAxis(raw);
        setMore(null);
        if (!fresh) return;
        setSituation((l) => {
          if (!l || l.kind !== "finished" || l.key !== key) return l;
          const data = appendTo(l.data, fresh);
          loaded.current = data.entries.length;
          return { ...l, data };
        });
      })
      .catch((e: unknown) => { if (mine === run.current) setMore({ key, error: String((e as Error)?.message || e) }); });
  };

  const empty = (text: string) => <div className="px-3 py-2 text-[12px] text-dim" data-time-axis-empty>{text}</div>;
  const name = file ? file.slice(file.lastIndexOf("/") + 1) : "";
  let content: React.ReactNode;
  if (target.kind === "no-file" || target.kind === "no-repo") content = empty(t("The active editor cannot provide timeline information."));
  else if (!gitOn) content = empty(t("All timeline sources have been filtered out."));
  else if (target.kind === "unknown" || !situation || situation.key !== key || situation.kind === "loading") content = empty(t("Loading timeline for {name}...", { name }));
  else if (situation.kind === "unknown") content = empty(t("The server does not know the timeline yet — after the next rollout."));
  else if (situation.kind === "error") content = <div className="px-3 py-2 text-[12px] text-danger" role="alert">{situation.text}</div>;
  else if (!situation.data.entries.length) content = empty(t("No timeline information was provided."));
  else {
    const locale = dateLocale();
    const now = Date.now();
    const repo = target.repo;
    const column = timeColumn(situation.data.entries, now, t);
    // An entry's diff as VS Code `git.timeline.openDiff`: on the left the predecessor (`prior`), on the right the commit, in the title
    // the file's name TODAY (`current` — across a rename; the content comes from the commit). "Open Commit" (`git.timeline.viewCommit`)
    // opens as a preview (italic) as in VS Code and leaves focus here (`preserveFocus`, `focus: false`).
    const entries = situation.data.entries, moreAvailable = Boolean(cursorOf(situation.data));
    const open = (e: TimeAxisEntry, fixed = false) => {
      const prior = priorOf(entries, entries.indexOf(e), moreAvailable);
      onOpen(entrySource(repo, e, { current: target.file, prior }), { title: diffTitle(target.file, e.hash, prior), short: e.short, fixed });
    };
    const openCommit = (e: TimeAxisEntry) => onOpen(commitSource(repo, e), { title: commitTitle(e), short: e.short, fixed: false, focus: false });
    // The choice of an entry — the timeline file today and its name in this commit.
    const choice = (e: TimeAxisEntry): TimeAxisChoice => ({ repo, file: target.file, hash: e.hash, backThen: e.file });
    const menu = (e: TimeAxisEntry, x: number, y: number) => openEditorMenu({ x, y, groups: [
      [
        { id: "timeline.openDiff", label: t("Open Changes"), execute: () => open(e) },
        { id: "timeline.viewCommit", label: t("Open Commit"), execute: () => openCommit(e) },
      ],
      comparison ? timeAxisPlan(comparison.status).map((p) => p === "with-selection"
        ? { id: "timeline.compareWithSelected", label: t("Compare with Selected"), execute: () => comparison.withSelected(choice(e)) }
        : { id: "timeline.selectForCompare", label: t("Select for Compare"), execute: () => comparison.select(choice(e)) }) : [],
      [
        { id: "timeline.copyCommitId", label: t("Copy Commit Hash"), execute: () => copyText(e.hash) },
        { id: "timeline.copyCommitMessage", label: t("Copy Commit Message"), execute: () => copyText(e.subject) },
      ],
    ] });
    const loadingMore = more?.key === key && more.error === null;
    content = (
      <div className="cb-tree min-h-0 pb-1" role="list" aria-label={t("Timeline")} data-time-axis>
        {situation.data.entries.map((e: TimeAxisEntry, i) => {
          const ms = e.time === null ? null : e.time * 1000;
          const hint = [`${e.author}${e.email ? ` <${e.email}>` : ""}`, ms === null ? null : fullDate(ms, locale), "", e.subject, e.old ? `${e.old} → ${e.file}` : null].filter((x) => x !== null).join("\n");
          const z = column[i];
          return (
            <div key={e.hash} role="listitem" tabIndex={0} className={`group/row ${ROW}`} title={hint}
              onClick={(m) => { if (m.detail < 2) open(e); }}
              onDoubleClick={() => open(e, true)}
              onContextMenu={(m) => { m.preventDefault(); m.stopPropagation(); menu(e, m.clientX, m.clientY); }}
              onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); open(e); } }}
              data-time-axis-entry={e.hash}>
              <span className="grid w-4 shrink-0 place-items-center text-dim"><CommitSymbol /></span>
              <span className="min-w-0 flex-1 truncate"><span>{e.subject || e.short}</span>{e.author && <span className="pl-1.5 text-[12px] text-dim">{e.author}</span>}</span>
              {/* VS Code `timeline.viewCommit` (group "inline"): on hover/focus on the right in the row. */}
              <button type="button" tabIndex={-1} title={t("Open Commit")} aria-label={t("Open Commit")} data-time-axis-commit
                onClick={(m) => { m.stopPropagation(); openCommit(e); }} onDoubleClick={(m) => m.stopPropagation()}
                className="hidden h-[20px] w-[20px] shrink-0 place-items-center rounded text-dim hover:bg-hover hover:text-fg group-hover/row:grid group-focus-visible/row:grid">
                <TitleSymbolSvg name="diff-multiple" />
              </button>
              {z.text !== null && (z.duplicate
                // VS Code `hideRelativeTime`: the same time as above stands only as a thin dash, on hover/focus the time.
                ? <span className="shrink-0 pr-2 text-[12px] text-dim" data-time-axis-time data-time-axis-duplicate>
                    <span aria-hidden className="inline-block w-2 border-b border-dim/50 align-middle group-hover/row:hidden group-focus-visible/row:hidden" />
                    <span className="hidden group-hover/row:inline group-focus-visible/row:inline">{z.text}</span>
                  </span>
                : <span className="shrink-0 pr-2 text-[12px] text-dim" data-time-axis-time>{z.text}</span>)}
            </div>
          );
        })}
        {cursorOf(situation.data) && (
          // VS Code `LoadMoreCommand`: the last row "Load more" (loading: "Loading…").
          <div role="listitem" tabIndex={0} className={`${ROW} text-dim`} aria-disabled={loadingMore}
            onClick={loadMore} onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); loadMore(); } }} data-time-axis-more>
            <span className="w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{loadingMore ? t("Loading…") : t("Load more")}</span>
          </div>
        )}
        {more?.key === key && more.error !== null && <div className="px-3 py-1 text-[12px] text-danger" role="alert">{more.error}</div>}
      </div>
    );
  }
  // The surface always stands (it measures the height for the page size), the content changes.
  return <div ref={surface} className="cb-scroll min-h-0 flex-1 overflow-auto" data-time-axis-surface>{content}</div>;
}
