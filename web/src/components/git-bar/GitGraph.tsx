"use client";

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api, normGitCommitFiles, normGitGraphLog,
  type GitCommitFile, type GitCommitFiles, type GitGraphEntry, type GitGraphLog, type GitGraphExtent, type GitRepo,
} from "@/lib/api";
import { Menu, MenuEntry } from "@/components/CbKit";
import { useCommitCard, type CardsPointer } from "@/components/git-bar/CommitCard";
import { useT } from "@/lib/i18n";
import { GRAPH_MAX, GRAPH_STEP } from "@/lib/git-bar";
import { commitStatusDisplay, fileKind, partsPath, type FileKind } from "@/lib/git-files";
import type { DiffSource } from "@/lib/chat-tabs";
import {
  GRAPH_EXTENT_KEY, LANE_COLORS, continuousLanes, graphMaxPx, graphState, readExtent, loadMore, badges, laneGeometry, computeLanes,
  type ThroughLane, type GraphRow, type Badge, type LaneColor, type LaneGeometry,
} from "@/lib/git-graph";

// The graph of the git bar, like the VS Code Source Control graph: one line with dots, only the current branch. Mounted in the "Graph"
// section of components/GitSidebar.tsx, which carries the header (repo choice, this extent choice `GraphExtentChoice`, actions).
//
// One 22 px row per commit: on the left an SVG strip with the lanes (computed by lib/git-graph.ts `computeLanes`, after the VS Code
// swim lanes), on the right the subject, the author dimmed, the badges of its refs. Dots: HEAD a hollow ring, a merge commit a ring with a
// core, otherwise a filled dot. The lane of the HEAD branch is always cobalt (`--color-accent`), the others come from `--git-lane-0…4`
// (globals.css). Badges (`badges`): the HEAD branch as a filled cobalt capsule with a ring, other local branches outlined in their lane
// color, a remote with a cloud, a tag with a label; a remote branch on the same commit as its local one becomes the local one's cloud; more
// than fit ⇒ "+n" with a title.
//
// EXPANDING: a click on a commit (or Enter/Space, right arrow opens, left arrow closes; `aria-expanded`) expands it IN PLACE. Below it, one
// 22 px row per changed file: icon by file type (lib/git-files.ts `fileKind`), name, the folder relative to the repo dimmed, on the right the
// letter in the colors of the file rows under "Changes" (`commitStatusDisplay` — the same KIND_COLOR/KIND_LETTER), deleted struck through.
// On the left ALL lanes that run through at this point continue (`continuousLanes`: the outgoing ones of the commit row — the next commit
// row connects seamlessly), and the commit's own lane is a bar in its color from the dot to the last row of the list (like VS Code). A click
// on a file opens its diff in this commit (title the path, for a rename "old → new"; badge the short hash); the WHOLE commit stays reachable
// through the action shown when hovering the commit row ("Show whole commit"). The graph only names the SOURCE (`onDiff`); the bar opens it
// as a tab in the chat, otherwise (Coding → Files, Projects → Git) in the DiffModal (GitSidebar.tsx `showDiff`/`diffText`).
// DECIDED: several commits open at once (like VS Code). The file list is loaded on first expand (`POST …/git/show` with `files: true`) and
// kept per hash — a commit never changes; no polling, no reload with the state; after an error or with an old server the next expand loads
// again. An old server does not know `files`: then "not yet available" shows, never an empty list read as "no changes"
// (lib/api/git.ts normGitCommitFiles). A merge commit shows (like VS Code) the changes against its FIRST parent — a line above says so.
//
// HOVER: after dwelling on a commit row (not on its file rows) the commit's card appears left of the bar, as in VS Code —
// components/git-bar/CommitCard.tsx (`useCommitCard`: the listeners on the row's wrapper, the card on the body, loading per hash; the
// clocks live there, this file has none). The dot of the hovered or keyboard-focused row (and of the row whose card is showing, `data-card`)
// grows by 2 px — pure CSS (app/globals.css `.cb-git-dot`, target per circle `--point-large`); the lanes are not recomputed. The native
// title of the row is gone: the card replaces it (two tooltips on top of each other).
//
// LOADING (no polling of its own — web/test/git-graph.test.mjs enforces it): `POST …/git/log` with `graph` through the bar's path builder
// (`path`, with `?chat=`/`instance=` — the graph of a copy chat is that of its copy), only while the section is open (the component only
// mounts then), again when the repo state in the tree changes (`graphState`: last commit, branch, upstream, ahead/behind — a fetch moves
// remote branches without changing the last commit), when the user refreshes (`fresh`) or chooses the extent. "Load more" asks the same
// list longer (+50, at most 500); at the cap the last row says there are older ones. Files and diff go through the same path builder.
//
// WIDTH: container, not window — the same bar is 272 px in the code tab and 280–640 in the chat. Measured by a ResizeObserver on its own
// root (no timer): the graph takes at most just under a quarter (`graphMaxPx`), each lane 11 px, narrower down to 6 px when tight, capped
// below that (`laneGeometry`: the right columns in ONE dashed collector column, with a note above the list). Below 340 px one badge per
// row, above it two.

const H = 22;
const M = 11;
const MARGIN = 3;
const STROKE = 1.6;

const color = (f: LaneColor) => (f === "accent" ? "var(--color-accent)" : `var(--git-lane-${((f % LANE_COLORS) + LANE_COLORS) % LANE_COLORS})`);
// The bar of the lane of an expanded commit: 4 px like VS Code, a little thinner in a narrow lane (capping from 6 px).
const progressBarWidth = (w: number) => Math.min(4, Math.max(2.5, w - 3));
// The x position of a column (with the collector column, see laneGeometry) — ONE computation for commit and file rows, otherwise the bar
// would sit beside its lane.
function columnsSituation(geo: LaneGeometry) {
  const { w, clipFrom } = geo;
  const column = (c: number) => (clipFrom !== null && c >= clipFrom ? clipFrom : c);
  return {
    width: MARGIN * 2 + w * geo.columns,
    x: (c: number) => MARGIN + w * column(c) + w / 2,
    collected: (c: number) => clipFrom !== null && c >= clipFrom,
  };
}

/** The choice in the section header: all branches (default) or the current one with its upstream — in localStorage (try/catch). */
export function useGraphExtent(): [GitGraphExtent, (u: GitGraphExtent) => void] {
  // The bar mounts only after the first tree (fetched in the browser) — no server rendering, so no hydration mismatch here.
  const [extent, setExtent] = useState<GitGraphExtent>(() => {
    try { return readExtent(localStorage.getItem(GRAPH_EXTENT_KEY)); } catch { return "all"; }
  });
  const select = useCallback((u: GitGraphExtent) => {
    setExtent(u);
    try { localStorage.setItem(GRAPH_EXTENT_KEY, u); } catch { /* only for this session */ }
  }, []);
  return [extent, select];
}

export function GraphExtentChoice({ extent, onChoice }: { extent: GitGraphExtent; onChoice: (u: GitGraphExtent) => void }) {
  const t = useT();
  const name = extent === "all" ? t("All") : t("Current Branch");
  return (
    <Menu label={t("Graph shows: {name}", { name })} width={250} alignment="left" shrinks
      button={{
        content: <span className="flex min-w-0 items-center gap-1"><span className="shrink-0"><BranchesIcon /></span><span className="min-w-0 truncate">{name}</span></span>,
        className: "flex h-[18px] min-w-0 max-w-full items-center rounded px-1 text-[11px] text-dim transition-colors hover:bg-edge hover:text-fg aria-expanded:bg-edge aria-expanded:text-fg",
        data: { "data-git-graph-extent": extent },
      }}>
      <MenuEntry label={t("All")} hint={t("Local and remote branches, tags")} selected={extent === "all"} onClick={() => onChoice("all")} data={{ "data-git-graph-extent-choice": "all" }} />
      <MenuEntry label={t("Current Branch")} hint={t("HEAD and its upstream")} selected={extent === "current"} onClick={() => onChoice("current")} data={{ "data-git-graph-extent-choice": "current" }} />
    </Menu>
  );
}

// A diff from the graph: the source (lib/chat-tabs.ts `DiffSource`) and its display — GitSidebar.tsx `showDiff` decides tab or modal.
type OnDiff = (q: DiffSource, a: { title?: string; short?: string }) => void;
// The file list of an expanded commit: loading · present · error · "the server does not know the route" (old server — never "no files").
type FilesStatus = { kind: "loading" } | { kind: "loaded"; value: GitCommitFiles } | { kind: "error"; text: string } | { kind: "unknown" };

export function GitGraph({ repo, extent, fresh, path, onDiff, turn = false }: {
  repo: GitRepo; extent: GitGraphExtent; fresh: number; path: (rest: string) => string; onDiff: OnDiff;
  /** A drag runs in the bar's stack (moving a section, dragging the splitter) — no card. */
  turn?: boolean;
}) {
  const t = useT();
  const rel = repo.relPath;
  const card = useCommitCard({ path, rel, locked: turn });
  const state = graphState(repo);
  const [limit, setLimit] = useState(GRAPH_STEP);
  const [log, setLog] = useState<GitGraphLog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    api<unknown>(path("/git/log"), { method: "POST", body: JSON.stringify({ repo: rel, limit, graph: extent }) })
      .then((raw) => { if (!cancelled) { setLog(normGitGraphLog(raw)); setError(""); } })
      .catch((e) => { if (!cancelled) setError(String((e as Error).message)); });
    return () => { cancelled = true; };
  }, [path, rel, extent, limit, state, fresh]);

  const root = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setPx(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((e) => { const b = e[0]?.contentRect.width; if (b) setPx(Math.round(b)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const computation = useMemo(() => (log ? computeLanes(log.commits) : null), [log]);
  const geo = useMemo(() => laneGeometry(computation?.width ?? 1, graphMaxPx(px || 280)), [computation, px]);
  const twoBadges = px >= 340;

  // Expanded (several at once) and the file lists per hash. The refs mirror the state for the toggle handler (a click loads only what is missing).
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [files, setFiles] = useState<ReadonlyMap<string, FilesStatus>>(() => new Map());
  const openNow = useRef(open);
  openNow.current = open;
  const filesNow = useRef(files);
  filesNow.current = files;
  const loadFiles = useCallback((hash: string) => {
    const set = (s: FilesStatus) => setFiles((m) => new Map(m).set(hash, s));
    set({ kind: "loading" });
    api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: rel, hash, files: true }) })
      .then((raw) => { const w = normGitCommitFiles(raw); set(w ? { kind: "loaded", value: w } : { kind: "unknown" }); })
      .catch((e) => set({ kind: "error", text: String((e as Error).message) }));
  }, [path, rel]);
  const toggle = useCallback((c: GitGraphEntry, on?: boolean) => {
    const before = openNow.current.has(c.hash);
    const desired = on ?? !before;
    if (desired === before) return;
    setOpen((s) => { const n = new Set(s); if (desired) n.add(c.hash); else n.delete(c.hash); return n; });
    const present = filesNow.current.get(c.hash);
    if (desired && (!present || present.kind === "error" || present.kind === "unknown")) loadFiles(c.hash);
  }, [loadFiles]);
  // Both open a diff through the bar (`onDiff`, GitSidebar.tsx `showDiff`): as a tab in the chat or as a modal — the graph only names
  // the source (raw paths relative to the repo; whoever loads it builds the route body).
  const openWhole = useCallback((c: GitGraphEntry) => {
    onDiff({ kind: "commit-whole", repo: rel, hash: c.hash }, { title: c.subject || c.hash, short: c.short });
  }, [onDiff, rel]);
  const openFile = useCallback((c: GitGraphEntry, d: GitCommitFile) => {
    // For a rename both paths (otherwise git would show a creation); a copy (C) without the source — its own changes do not belong
    // in this diff.
    const old = d.status === "R" && d.old ? d.old : null;
    const title = d.old && (d.status === "R" || d.status === "C") ? `${d.old} → ${d.path}` : d.path;
    onDiff({ kind: "commit", repo: rel, hash: c.hash, file: d.path, old: old }, { title, short: c.short });
  }, [onDiff, rel]);

  let content: React.ReactNode;
  if (!log || !computation) content = <Row>{error || t("Loading…##inline")}</Row>;
  else if (log.commits.length === 0) content = <Row>{error || t("No commits.")}</Row>;
  else {
    const more = loadMore(limit, log.commits.length, log.clipped, GRAPH_STEP, GRAPH_MAX);
    content = (
      <>
        {computation.linear && <Row data={{ "data-git-graph-linear": "" }}>{t("Linear: the server does not send parents yet (the full graph arrives with its next deploy).")}</Row>}
        {geo.clipFrom !== null && (
          <Row data={{ "data-git-graph-clipped-lanes": String(computation.width) }}>
            {t("{n} lanes side by side — from lane {k} on merged into one dashed lane.", { n: computation.width, k: geo.clipFrom + 1 })}
          </Row>
        )}
        {log.commits.map((c, i) => {
          const on = open.has(c.hash);
          return (
            <Fragment key={c.hash}>
              <CommitRow c={c} z={computation.rows[i]} geo={geo} two={twoBadges} open={on} onToggle={toggle} onWhole={openWhole}
                pointer={card.pointer} cardId={card.active === c.hash ? card.id : null} />
              {on && <CommitFiles c={c} z={computation.rows[i]} geo={geo} state={files.get(c.hash)} onFile={openFile} />}
            </Fragment>
          );
        })}
        {more !== null && (
          <button type="button" onClick={() => setLimit(more)} style={{ paddingLeft: MARGIN * 2 + geo.w * geo.columns + 4 }}
            className="flex h-[22px] w-full items-center rounded-md text-left text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-fg" data-git-more>
            {t("Load more")}
          </button>
        )}
        {more === null && log.clipped === true && (
          <Row data={{ "data-git-graph-cap": String(log.commits.length) }}>{t("Only the latest {n} commits — the graph does not show older ones.", { n: log.commits.length })}</Row>
        )}
        {error && <Row>{error}</Row>}
      </>
    );
  }
  return (
    <div ref={root} className="min-w-0" data-git-graph-list={log?.commits.length ?? 0} data-git-graph-extent-loaded={log?.extent ?? ""}>
      {content}
      {card.card}
    </div>
  );
}

function Row({ children, data }: { children: React.ReactNode; data?: Record<string, string> }) {
  return <div className="px-1.5 py-1 text-[11.5px] leading-snug text-dim" {...(data ?? {})}>{children}</div>;
}

// A commit row. Memoized: the bar often re-renders during a run, the rows change only with the log, the width and expanding. The hover
// background sits on the wrapper, not on the button: the "Show whole commit" action is a sibling (no button inside a button) — hovering
// it would otherwise take the button its hover. The hover-card listeners also hang on the wrapper (CommitCard.tsx — only here, not on the
// file rows below); `cardId` is set while the card of THIS row is showing.
const CommitRow = memo(function CommitRow({ c, z, geo, two, open, onToggle, onWhole, pointer, cardId }: {
  c: GitGraphEntry; z: GraphRow; geo: LaneGeometry; two: boolean; open: boolean;
  onToggle: (c: GitGraphEntry, on?: boolean) => void; onWhole: (c: GitGraphEntry) => void;
  pointer: CardsPointer; cardId: string | null;
}) {
  const t = useT();
  const all = badges(c.refs);
  return (
    <div className="group/commit relative min-w-0 rounded-md transition-colors hover:bg-hover" data-git-commit-row={c.short} data-open={open ? "1" : undefined}
      data-card={cardId ? "1" : undefined}
      onPointerEnter={(e) => pointer.enter(c, e)} onPointerMove={(e) => pointer.enter(c, e)} onPointerLeave={() => pointer.out(c)}
      onPointerDown={() => pointer.press(c)} onFocus={(e) => pointer.focus(c, e)} onBlur={(e) => pointer.focusLost(c, e)}>
      <button type="button" data-git-commit={c.short} data-git-graph-column={z.column} data-git-graph-kind={z.kind} aria-expanded={open}
        aria-describedby={cardId ?? undefined}
        onClick={() => onToggle(c)}
        onKeyDown={(e) => { if (e.key === "ArrowRight" && !open) { e.preventDefault(); onToggle(c, true); } else if (e.key === "ArrowLeft" && open) { e.preventDefault(); onToggle(c, false); } }}
        className="flex h-[22px] w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left group-focus-within/commit:pr-[22px] group-hover/commit:pr-[22px]">
        {/* On hover the row makes room on the right for "Show whole commit" (like VS Code: the subject shortens) instead of the
            button covering a badge — seen in the visual check: "v1.1" sat half under the button. */}
        <Strip z={z} geo={geo} open={open} />
        {/* The author yields first (shrink factor 100 against 1), the subject only when nothing of the author is left. */}
        <span className="min-w-0 shrink truncate text-[12px] font-medium">{c.subject || c.short}</span>
        <span className="min-w-0 shrink-[100] truncate text-[11px] text-dim">{c.author}</span>
        <span className="min-w-0 flex-1" />
        {all.length > 0 && <Badges all={all} lane={z.color} max={two ? 2 : 1} />}
      </button>
      <button type="button" onClick={() => onWhole(c)} title={t("Show whole commit")} aria-label={t("Show whole commit")} data-git-commit-whole={c.short}
        className="absolute right-0.5 top-[2px] hidden h-[18px] w-[18px] place-items-center rounded bg-hover text-dim transition-colors hover:bg-edge hover:text-fg focus-visible:grid group-focus-within/commit:grid group-hover/commit:grid">
        <WholeIcon />
      </button>
    </div>
  );
});

// The files of an expanded commit — every row (also "Loading…" and the hints) carries the continuous lanes and the bar.
function CommitFiles({ c, z, geo, state, onFile }: {
  c: GitGraphEntry; z: GraphRow; geo: LaneGeometry; state: FilesStatus | undefined; onFile: (c: GitGraphEntry, d: GitCommitFile) => void;
}) {
  const t = useT();
  const lanes = useMemo(() => continuousLanes(z), [z]);
  const hint = (text: string, data?: Record<string, string>, error = false) => <FileHint lanes={lanes} geo={geo} text={text} error={error} data={data} />;
  let parts: React.ReactNode;
  if (!state || state.kind === "loading") parts = hint(t("Loading…##inline"), { "data-git-commit-files-loading": "" });
  else if (state.kind === "error") parts = hint(state.text, { "data-git-commit-files-error": "" }, true);
  else if (state.kind === "unknown") parts = hint(t("The server does not know a commit's files yet (after its next deploy) — \"Show whole commit\" works."), { "data-git-commit-files-unknown": "" });
  else {
    const w = state.value;
    const merge = (w.parent?.length ?? c.parents?.length ?? 0) > 1;
    const first = w.parent?.[0] ?? c.parents?.[0] ?? "";
    const clipped = w.clipped === true || (w.total !== null && w.total > w.files.length);
    parts = (
      <>
        {merge && first && hint(t("Against the first parent {short}", { short: first.slice(0, 8) }), { "data-git-commit-against": first.slice(0, 8) })}
        {w.files.length === 0 && hint(merge ? t("No changes against the first parent.") : t("No files changed."), { "data-git-commit-files-empty": "" })}
        {w.files.map((d) => <FileRow key={`${d.status}\u0000${d.old ?? ""}\u0000${d.path}`} c={c} d={d} lanes={lanes} geo={geo} onFile={onFile} />)}
        {clipped && hint(w.total !== null
          ? t("Only the first {n} of {m} files — the rest is not shown here.", { n: w.files.length, m: w.total })
          : t("Only the first {n} files — there are more.", { n: w.files.length }), { "data-git-commit-files-clipped": String(w.total ?? "") })}
        {w.unreadable > 0 && hint(t("{n} entries could not be read and are missing above.", { n: w.unreadable }))}
      </>
    );
  }
  return (
    <div role="group" aria-label={t("Files of {short}", { short: c.short })} data-git-commit-files={c.short}
      data-git-commit-files-n={state?.kind === "loaded" ? String(state.value.files.length) : undefined}>
      {parts}
    </div>
  );
}

function FileHint({ lanes, geo, text, error, data }: { lanes: ThroughLane[]; geo: LaneGeometry; text: string; error: boolean; data?: Record<string, string> }) {
  return (
    <div className={`flex h-[22px] min-w-0 items-center gap-1.5 pr-1 text-[11.5px] ${error ? "text-danger" : "text-dim"}`} title={text} {...(data ?? {})}>
      <ThroughStrip lanes={lanes} geo={geo} />
      <span className="w-1 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

// A file of the commit — the same form as the file row under "Changes" (GitSidebar.tsx FileRow): name mono 12 px, folder dimmed, on the
// right the letter in its color; plus the icon by file type and the lanes on the left.
const FileRow = memo(function FileRow({ c, d, lanes, geo, onFile }: {
  c: GitGraphEntry; d: GitCommitFile; lanes: ThroughLane[]; geo: LaneGeometry; onFile: (c: GitGraphEntry, d: GitCommitFile) => void;
}) {
  const t = useT();
  const { name, folder } = partsPath(d.path);
  const a = commitStatusDisplay(d.status);
  const location = d.old && (d.status === "R" || d.status === "C") ? `${d.old} → ${d.path}` : d.path;
  return (
    <button type="button" onClick={() => onFile(c, d)} title={t("{label}: {path} — click for diff", { label: t(a.label), path: location })}
      className="flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-md pr-1 text-left transition-colors hover:bg-hover"
      data-git-commit-file={d.path} data-git-commit-file-status={d.status}>
      <ThroughStrip lanes={lanes} geo={geo} />
      <span className="w-1 shrink-0" aria-hidden />
      <FileSymbol kind={fileKind(d.path)} />
      <span className={`min-w-0 shrink truncate font-mono text-[12px] ${a.deleted ? "text-dim line-through" : ""}`}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{folder}</span>
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${a.color}`}>{a.letter}</span>
    </button>
  );
});

// The icon of a file: an abbreviation in the color of its language (like the VS Code Seti icons) or a line icon; tones from
// `--file-<tone>` (app/globals.css), gray is `--color-dim`.
function FileSymbol({ kind }: { kind: FileKind }) {
  const tone = kind.tone === "gray" ? "var(--color-dim)" : `var(--file-${kind.tone})`;
  return (
    <span className="grid h-[14px] w-[15px] shrink-0 place-items-center" style={{ color: tone }} aria-hidden data-git-file-kind={kind.kind === "shortcut" ? kind.shortcut : kind.kind}>
      {kind.kind === "shortcut"
        ? <span className="font-mono text-[9px] font-bold leading-none tracking-[-0.06em]">{kind.shortcut}</span>
        : kind.kind === "image" ? <ImageIcon /> : kind.kind === "config" ? <ConfigIcon /> : kind.kind === "lock" ? <PadlockIcon /> : kind.kind === "text" ? <TextIcon /> : <SheetIcon />}
    </span>
  );
}

function Badges({ all, lane, max }: { all: Badge[]; lane: LaneColor; max: number }) {
  const shown = all.slice(0, max);
  const rest = all.slice(max);
  return (
    <span className={`flex min-w-0 shrink-0 items-center gap-1 ${max > 1 ? "max-w-[52%]" : "max-w-[44%]"}`}>
      {shown.map((p) => <RefBadge key={`${p.kind}:${p.name}`} p={p} lane={lane} />)}
      {rest.length > 0 && (
        <span className="flex h-4 shrink-0 items-center rounded-full border border-edge px-1 text-[10.5px] tabular-nums text-dim" title={rest.map((p) => (p.remote ? `${p.name} · ${p.remote}` : p.name)).join("\n")} data-git-ref-more={rest.length}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

function RefBadge({ p, lane }: { p: Badge; lane: LaneColor }) {
  const title = p.remote ? `${p.name} · ${p.remote}` : p.name;
  const data = { "data-git-ref": p.name, "data-git-ref-kind": p.kind };
  if (p.kind === "head") {
    return (
      <span className="flex h-4 min-w-0 shrink items-center gap-1 rounded-full bg-accent px-1.5 text-[10.5px] font-medium text-white" title={title} data-git-header-badge {...data}>
        <RingIcon />
        <span className="min-w-0 truncate">{p.name}</span>
        {p.remote && <CloudIcon />}
      </span>
    );
  }
  const local = p.kind === "local";
  return (
    <span title={title} {...data}
      className={`flex h-4 min-w-0 shrink items-center gap-1 rounded-full border px-1.5 text-[10.5px] ${local ? "text-fg/85" : "border-edge text-dim"}`}
      style={local ? { borderColor: `color-mix(in srgb, ${color(lane)} 62%, transparent)` } : undefined}>
      <span className="shrink-0" style={local ? { color: color(lane) } : undefined}>{local ? <BranchIcon /> : p.kind === "remote" ? <CloudIcon /> : <TagIcon />}</span>
      <span className="min-w-0 truncate">{p.name}</span>
      {p.remote && <span className="shrink-0 text-dim"><CloudIcon /></span>}
    </span>
  );
}

// ── The strip of a row ────────────────────────────────────────────────────────────────────────────────────────────────────
// Coordinates: x(column) = margin + w·column + w/2, y 0 (top) · 11 (dot) · 22 (bottom). Lines end just before the dot (the HEAD ring stays
// hollow, without mask and without background color — the row changes it on hover). Passing lanes that change column are an S-curve; a
// lane ending in the dot is a quarter arc into the horizontal (like VS Code); a further parent goes out horizontally and as an arc downward.
// What sits in the collector column (`kappe`) is dashed. If the commit is expanded, the bar of its lane (`continuousLanes` … `own`) starts
// below the dot instead of the thin line downward.
// Hover: every circle of the dot carries its target `--point-large` (ring and filled dot +2 px, the core of a merge in the same ratio as its
// ring — the shape stays); the CSS in app/globals.css sets it as `r` on the hovered, focused or described row.
// Memoized: the row re-renders when its card comes or goes — the strip does not.
const PLUS_R = 2;
const Strip = memo(function Strip({ z, geo, open }: { z: GraphRow; geo: LaneGeometry; open: boolean }) {
  const { w } = geo;
  const { width, x, collected } = columnsSituation(geo);
  const r = w >= 10 ? 3.4 : w >= 8 ? 3 : 2.5;
  const clearance = z.kind === "node" ? r + 1.4 : r + 2.2;
  const xs = x(z.column);
  const own = open ? continuousLanes(z).find((s) => s.own) : undefined;
  const lines: { d: string; f: LaneColor; stroke?: boolean }[] = [];
  for (const s of z.through) {
    const a = x(s.from), b = x(s.to);
    lines.push({ d: a === b ? `M${a} 0V${H}` : `M${a} 0C${a} ${M} ${b} ${M} ${b} ${H}`, f: s.color, stroke: collected(s.from) || collected(s.to) });
  }
  if (z.top !== null) lines.push({ d: `M${xs} 0V${M - clearance}`, f: z.top });
  for (const s of z.incoming) {
    const a = x(s.from);
    const far = Math.abs(a - xs) - clearance;
    if (far <= 0) { lines.push({ d: `M${a} 0V${M - clearance}`, f: s.color, stroke: true }); continue; }
    const rx = Math.min(w, far);
    lines.push({ d: a > xs ? `M${a} 0A${rx} ${M} 0 0 1 ${a - rx} ${M}H${xs + clearance}` : `M${a} 0A${rx} ${M} 0 0 0 ${a + rx} ${M}H${xs - clearance}`, f: s.color, stroke: collected(s.from) });
  }
  if (z.bottom && !own) lines.push({ d: `M${xs} ${M + clearance}V${H}`, f: z.color });
  for (const s of z.branching) {
    const b = x(s.to);
    const far = Math.abs(b - xs) - clearance;
    if (far <= 0) { lines.push({ d: `M${b} ${M + clearance}V${H}`, f: s.color, stroke: true }); continue; }
    const rx = Math.min(w, far);
    lines.push({ d: b > xs ? `M${xs + clearance} ${M}H${b - rx}A${rx} ${H - M} 0 0 1 ${b} ${H}` : `M${xs - clearance} ${M}H${b + rx}A${rx} ${H - M} 0 0 0 ${b} ${H}`, f: s.color, stroke: collected(s.to) });
  }
  const pf = color(z.color);
  const rPoint = z.kind === "head" ? r + 0.9 + 0.95 : z.kind === "merge" ? r + 0.7 + 0.75 : r;
  return (
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="shrink-0" aria-hidden data-git-graph-strip>
      {lines.map((l, i) => (
        <path key={i} d={l.d} fill="none" strokeWidth={STROKE} strokeDasharray={l.stroke ? "2 2" : undefined} style={{ stroke: color(l.f) }} />
      ))}
      {own && <path d={`M${xs} ${M + rPoint}V${H}`} fill="none" strokeWidth={progressBarWidth(w)} style={{ stroke: color(own.color) }} data-git-graph-progress-bar="commit" />}
      {z.kind === "head" ? (
        <circle cx={xs} cy={M} r={r + 0.9} fill="none" strokeWidth={1.9} className="cb-git-dot" style={{ stroke: pf, ...large(r + 0.9 + PLUS_R) }} data-git-graph-point="head" />
      ) : z.kind === "merge" ? (
        <>
          <circle cx={xs} cy={M} r={r + 0.7} fill="none" strokeWidth={1.5} className="cb-git-dot" style={{ stroke: pf, ...large(r + 0.7 + PLUS_R) }} data-git-graph-point="merge" />
          <circle cx={xs} cy={M} r={r * 0.45} className="cb-git-dot" style={{ fill: pf, ...large((r * 0.45 * (r + 0.7 + PLUS_R)) / (r + 0.7)) }} data-git-graph-core />
        </>
      ) : (
        <circle cx={xs} cy={M} r={r} className="cb-git-dot" style={{ fill: pf, ...large(r + PLUS_R) }} data-git-graph-point="node" />
      )}
    </svg>
  );
});
const large = (r: number) => ({ "--point-large": `${Math.round(r * 100) / 100}px` }) as React.CSSProperties;

// The strip of a file row: every continuous lane vertical in its color (the collector column once, dashed), the bar of the own lane on top
// — over the full height so row meets row without a seam.
function ThroughStrip({ lanes, geo }: { lanes: ThroughLane[]; geo: LaneGeometry }) {
  const { width, x, collected } = columnsSituation(geo);
  const seen = new Set<string>();
  const thin = lanes.filter((s) => {
    if (s.own) return false;
    const k = collected(s.column) ? "collecting" : String(s.column);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const own = lanes.find((s) => s.own);
  return (
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="shrink-0" aria-hidden data-git-graph-through={lanes.length}>
      {thin.map((s) => (
        <path key={s.column} d={`M${x(s.column)} 0V${H}`} fill="none" strokeWidth={STROKE} strokeDasharray={collected(s.column) ? "2 2" : undefined} style={{ stroke: color(s.color) }} />
      ))}
      {own && <path d={`M${x(own.column)} 0V${H}`} fill="none" strokeWidth={progressBarWidth(geo.w)} style={{ stroke: color(own.color) }} data-git-graph-progress-bar="file" />}
    </svg>
  );
}

// ── Icons (24 viewBox, stroke 1.9 — like GitSidebar.tsx) ──────────────────────────────────────────────────────────────────
const svg = (children: React.ReactNode, size = 10) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>);
const RingIcon = () => svg(<><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></>);
const CloudIcon = () => svg(<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />);
const BranchIcon = () => svg(<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>);
const TagIcon = () => svg(<><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" /></>);
// The choice "All / Current Branch": three branches from one root.
const BranchesIcon = () => svg(<><circle cx="6" cy="19" r="2.2" /><circle cx="6" cy="5" r="2.2" /><circle cx="18" cy="5" r="2.2" /><circle cx="12" cy="5" r="2.2" /><path d="M6 7.2v9.6" /><path d="M18 7.2c0 5-6 4.5-11 10" /><path d="M12 7.2c0 3.5-3 4.6-5.2 8" /></>, 11);
// "Show whole commit": two sheets on top of each other with plus and minus (the changes of all files).
const WholeIcon = () => svg(<><path d="M9 3h7l4 4v10a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 17V4.5A1.5 1.5 0 0 1 9 3z" /><path d="M4.5 7.5v12A1.5 1.5 0 0 0 6 21h9" /><path d="M12 8.5v4M10 10.5h4M10 15h4" /></>, 12);
// File types (13 px): sheet (neutral), image, config (sliders), lock file (padlock), text (sheet with lines).
const SheetIcon = () => svg(<><path d="M14 2.5H6.5A2 2 0 0 0 4.5 4.5v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" /><path d="M14 2.5V8h5.5" /></>, 13);
const TextIcon = () => svg(<><path d="M14 2.5H6.5A2 2 0 0 0 4.5 4.5v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" /><path d="M14 2.5V8h5.5" /><path d="M8.5 13h7M8.5 17h5" /></>, 13);
const ImageIcon = () => svg(<><rect x="3.5" y="4" width="17" height="16" rx="2" /><circle cx="9" cy="9.5" r="1.6" /><path d="M20.5 15.5l-4.5-4.5-9.5 9" /></>, 13);
const ConfigIcon = () => svg(<><path d="M5 20v-6M5 10V4M12 20v-8M12 8V4M19 20v-4M19 12V4" /><path d="M2.5 14h5M9.5 8h5M16.5 16h5" /></>, 13);
const PadlockIcon = () => svg(<><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" /></>, 13);
