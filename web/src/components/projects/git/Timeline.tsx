"use client";

// The timeline of the git overview: on top the axis with dates and the main line with its commits, below the groups in the order
// of GIT_VIEW_GROUPS; per row on the left the name in a fixed column, in the middle the lane (branches off at the branch point,
// reaches to the last commit), on the right the details (↑↓ against the main branch, age, "Main · 2 chats running ›",
// user · state).
//
// DRAWING: one SVG per row with x in PERCENT (`cx="37.5%"`) — circles stay round and no width measurement is needed (no
// ResizeObserver, no redraw while dragging the column). The calculation time → x, clipping at the window edge and dots/bar live
// in lib/git-view-time.ts; what a row IS (group, pairing, numbers, dots or bar) is decided by the server.
//   ● commit · ○ unpushed (hollow) · ┄ not fetched (dashed) · « branch point before the window (with date) · a bar with a
//   number if the server sends no dots (more than POINTS_MAX). No merge arc.
// COPIES: one identifying colour per copy (`color` of the instance → kit variable `--kit-copy-<n>`, globals.css) on lane, dot and
// the mark before the name; a copy row stands directly under the same-named main row of its group (the server pairs, here it is
// only placed). In "From cbase" everything that is not running stands under "Ended (n)", collapsed.
// SELECTION: the selected row carries `data-active="1"` and `bg-edge` (`edge` means "selected", the right step in both designs).
// Data attributes for test stands: `data-git-row`, `data-git-group`, `data-git-instance` per row, `data-git-group-header` per group.
//
// Container query (`@container/timeline`), not a window query: the details on the right appear only if the timeline itself is
// wide enough — next to the detail it is narrower than alone.
import { useMemo, useState } from "react";
import {
  GIT_VIEW_GROUPS,
  type GitView, type GitViewRow, type GitWindow, type GitGroup, type GitLine,
} from "@/lib/api";
import {
  axisMarkers, oldestBranchPoint, displayOf, windowArea, lineOf, laneOf,
  type Display, type Lane,
} from "@/lib/git-view-time";
import { dateLocale } from "@/lib/i18n";
import { Chevron } from "@/components/CbKit";
import {
  UserJump, ChatsJump, oldWord, groupWord, instanceWord, rowName, arrows, stateWord, type GitLocation, type Translator,
} from "@/components/projects/git/GitWords";

/** The key of a row (selection): instance and name — the same branch in main and in a copy are two rows. */
export const rowKey = (z: Pick<GitViewRow, "instance" | "name">) => `${z.instance}\u0000${z.name}`;

/** The colour of an instance for stroke and dot: a copy in its identifying colour, main in the text colour (dimmed via opacity). */
export function keyColor(color: number | null | undefined): string {
  return typeof color === "number" ? `var(--kit-copy-${color})` : "currentColor";
}

/** Short date ("18.10." or "10/18") for the axis and «. */
export const dateShort = (t: number) => new Date(t).toLocaleDateString(dateLocale(), { day: "numeric", month: "numeric" });

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const MIDDLE = 14; // half the row height (h-7)

/** Places every copy row directly under the same-named main row of its group; otherwise the server's order stays. */
export function arrangeRows(rows: GitViewRow[]): GitViewRow[] {
  const main = new Map<string, GitViewRow>();
  for (const z of rows) if (z.instance === "main") main.set(z.name, z);
  const children = new Map<string, GitViewRow[]>();
  const rest: GitViewRow[] = [];
  for (const z of rows) {
    if (z.instance !== "main" && main.has(z.name)) children.set(z.name, [...(children.get(z.name) ?? []), z]);
    else rest.push(z);
  }
  return rest.flatMap((z) => (z.instance === "main" ? [z, ...(children.get(z.name) ?? [])] : [z]));
}

// ── The lane of a row ───────────────────────────────────────────────────────────────────────────────────────────────────

function Raster({ markers }: { markers: { x: number }[] }) {
  return <>{markers.map((m, i) => <line key={i} x1={pct(m.x)} x2={pct(m.x)} y1={0} y2={MIDDLE * 2} style={{ stroke: "var(--color-edge)" }} strokeWidth={1} />)}</>;
}

function Commits({ d, lane, color }: { d: Display | null; lane: Lane | null; color: string }) {
  if (!d) return null;
  if (d.kind === "progressBar") {
    const width = Math.max(d.x1 - d.x0, 0.01);
    return (
      <>
        <rect x={pct(d.x0)} width={pct(width)} y={MIDDLE - 5} height={10} rx={5} fill={color} fillOpacity={0.22} stroke={color} strokeOpacity={0.5} />
        {d.count !== null && (
          <text x={pct(d.x0 + width / 2)} y={MIDDLE + 3.5} textAnchor="middle" fill="currentColor" className="text-[10px] tabular-nums" data-git-progress-bar={d.count}>{d.count}</text>
        )}
      </>
    );
  }
  const fetchedUntil = lane?.x1 ?? 0;
  const notUntil = d.notFetched.length ? Math.max(...d.notFetched) : null;
  return (
    <>
      {notUntil !== null && notUntil > fetchedUntil && (
        <line x1={pct(fetchedUntil)} x2={pct(notUntil)} y1={MIDDLE} y2={MIDDLE} stroke={color} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="3 3" />
      )}
      {d.notFetched.map((x, i) => <circle key={`n${i}`} cx={pct(x)} cy={MIDDLE} r={3} fill="none" stroke={color} strokeWidth={1.2} strokeDasharray="2 1.5" />)}
      {d.points.map((p, i) => (
        <circle key={i} cx={pct(p.x)} cy={MIDDLE} r={3.5} fill={p.pushed ? color : "none"} stroke={color} strokeWidth={p.pushed ? 0 : 1.5} data-git-point={p.pushed ? "pushed" : "unpushed"} />
      ))}
    </>
  );
}

function LaneSvg({ lane, d, color, markers, t }: { lane: Lane | null; d: Display | null; color: string; markers: { x: number }[]; t: Translator }) {
  return (
    <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      <Raster markers={markers} />
      {lane && (
        <>
          {/* └ — the branch point off the line above; clipped, the lane starts at the edge, without an arc. */}
          {!lane.clipped && <line x1={pct(lane.x0)} x2={pct(lane.x0)} y1={0} y2={MIDDLE} stroke={color} strokeOpacity={0.45} strokeWidth={1.5} />}
          <line x1={pct(lane.x0)} x2={pct(lane.x1)} y1={MIDDLE} y2={MIDDLE} stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />
          {lane.clipped && lane.branchPoint !== null && (
            <text x="0" dx={2} y={MIDDLE - 4} fill="currentColor" fillOpacity={0.6} className="text-[9.5px]" data-git-clipped={dateShort(lane.branchPoint)}>
              <title>{t("Branched off before the window: {date}", { date: dateShort(lane.branchPoint) })}</title>
              «{dateShort(lane.branchPoint)}
            </text>
          )}
        </>
      )}
      <Commits d={d} lane={lane} color={color} />
    </svg>
  );
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const NAME_COLUMN = "w-[9rem] @3xl/timeline:w-[12rem]";
const DETAILS_COLUMN = "hidden w-[17rem] @3xl/timeline:flex";

function Details({ z, location, t, now }: { z: GitViewRow; location: GitLocation; t: Translator; now: number }) {
  const parts: React.ReactNode[] = [];
  if (z.toMain) parts.push(<span key="h" className="font-mono tabular-nums" title={t("to the main branch")}>{z.toMain.merged ? t("merged") : arrows(z.toMain)}</span>);
  else if (z.sinceCreation) parts.push(<span key="s" className="font-mono tabular-nums" title={t("since the copy was created")}>{arrows(z.sinceCreation)}</span>);
  const age = oldWord(z.last?.t ?? null, now, t);
  if (age) parts.push(<span key="a" className="tabular-nums">{age}</span>);
  for (const a of z.checkedOut ?? []) {
    const place = `${instanceWord(a.instance, t)}${a.worktree ? ` · ${t("Worktree")}` : ""}`;
    parts.push(a.chats && a.chats.length
      ? <ChatsJump key={`c${a.instance}${a.worktree ?? ""}`} chats={a.chats} t={t} front={`${place} · `} />
      : <span key={`c${a.instance}${a.worktree ?? ""}`} className="truncate">{place}</span>);
  }
  if (z.user) parts.push(<UserJump key="b" b={z.user} state={z.state} location={location} t={t} />);
  else if (z.state) parts.push(<span key="z">{stateWord(z.state, t)}</span>);
  return (
    <div className={`${DETAILS_COLUMN} min-w-0 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-dim`}>
      {parts.map((x, i) => <span key={i} className="flex min-w-0 items-center gap-1.5">{i > 0 && <span aria-hidden>·</span>}{x}</span>)}
    </div>
  );
}

function Row({ z, active, color, area, markers, location, now, t, onSelect }: {
  z: GitViewRow; active: boolean; color: number | null; area: [number, number]; markers: { x: number }[];
  location: GitLocation; now: number; t: Translator; onSelect: () => void;
}) {
  const lane = laneOf(z.branchPoint, z.last?.t ?? null, area);
  const d = displayOf(z.commits, lane, area);
  const copy = z.instance !== "main";
  const stroke = keyColor(copy ? color : null);
  return (
    <div
      onClick={onSelect}
      data-git-row={z.name}
      data-git-group={z.group}
      data-git-instance={z.instance}
      data-active={active ? "1" : undefined}
      title={z.last ? `${rowName(z, t)} — ${z.last.subject}` : rowName(z, t)}
      className={`flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 transition-colors ${active ? "bg-edge" : "hover:bg-hover"}`}
    >
      {/* The name is the choice's button (keyboard); the row itself only catches the click — no button around the jump buttons on the right. */}
      <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(); }} aria-current={active ? "true" : undefined}
        className={`${NAME_COLUMN} flex min-w-0 shrink-0 items-center gap-1.5 text-left ${copy ? "pl-3" : ""}`}>
        {copy && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stroke }} title={instanceWord(z.instance, t)} aria-label={instanceWord(z.instance, t)} />}
        <span className={`min-w-0 truncate font-mono text-[12px] ${z.group === "remote" ? "text-dim" : ""}`}>{rowName(z, t)}</span>
      </button>
      <div className="relative h-full min-w-0 flex-1 text-fg/70">
        <LaneSvg lane={lane} d={d} color={stroke} markers={markers} t={t} />
      </div>
      <Details z={z} location={location} t={t} now={now} />
    </div>
  );
}

// Without a main branch (`name === null`) there is no line, no dots, no bar and no number — the server then sends
// `line: { commits: null, count: 0 }`, and drawn from that an invented main line with "0 commits" would stand there. The sentence instead.
function Mainline({ name, line: mainLine, area, markers, t }: { name: string | null; line: GitLine | null; area: [number, number]; markers: { x: number }[]; t: Translator }) {
  const d: Display | null = mainLine ? lineOf(name !== null, mainLine.commits, mainLine.count, area) : null;
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 px-1.5" data-git-mainline={name ?? ""}>
      <div className={`${NAME_COLUMN} min-w-0 shrink-0 truncate font-mono text-[12px] font-semibold`}>{name ?? <span className="font-sans font-normal text-dim">—</span>}</div>
      <div className="relative h-full min-w-0 flex-1 text-fg/80">
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <Raster markers={markers} />
          {name !== null && mainLine && <line x1="0" x2="100%" y1={MIDDLE} y2={MIDDLE} stroke="currentColor" strokeOpacity={0.6} strokeWidth={2} />}
          <Commits d={d} lane={{ x0: 0, x1: 1, clipped: false, branchPoint: null }} color="currentColor" />
        </svg>
        {name === null && (
          <span className="absolute inset-y-0 left-0 flex items-center text-[11.5px] text-dim" data-git-no-main-branch>{t("no main branch detected")}</span>
        )}
      </div>
      <div className={`${DETAILS_COLUMN} min-w-0 shrink-0 text-[11.5px] text-dim`}>
        {name !== null && mainLine?.count !== null && mainLine?.count !== undefined && <span className="tabular-nums">{t("{n} commits", { n: mainLine.count })}</span>}
      </div>
    </div>
  );
}

function Axis({ markers, t }: { markers: { t: number; x: number }[]; t: Translator }) {
  // The mark close to "today" is dropped — two labels on top of each other are none.
  const visible = markers.filter((m) => m.x < 0.9);
  return (
    <div className="flex h-6 min-w-0 items-end gap-2 px-1.5 text-[10.5px] text-dim" aria-hidden>
      <div className={`${NAME_COLUMN} shrink-0`} />
      <div className="relative h-full min-w-0 flex-1">
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {visible.map((m) => (
            <text key={m.t} x={pct(m.x)} y={16} textAnchor={m.x < 0.04 ? "start" : "middle"} fill="currentColor" className="text-[10.5px] tabular-nums">{dateShort(m.t)}</text>
          ))}
          <text x="100%" y={16} textAnchor="end" fill="currentColor" className="text-[10.5px]">{t("today")}</text>
        </svg>
      </div>
      <div className={`${DETAILS_COLUMN} shrink-0`} />
    </div>
  );
}

function GroupsHeader({ g, n, t }: { g: GitGroup; n: number; t: Translator }) {
  return (
    <div className="flex h-7 items-end gap-1.5 px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-dim" data-git-group-header={g}>
      {groupWord(g, t)} <span className="tabular-nums font-normal">{n}</span>
    </div>
  );
}

// ── The timeline ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function Timeline({ view, rows, window, from: origin, now, choice, location, t, onSelect }: {
  view: GitView;
  /** The rows of the answer (read — `null` shows the view itself as "not read"). */
  rows: GitViewRow[];
  window: GitWindow;
  /** Hidden groups (the toggles in the header). */
  from: ReadonlySet<GitGroup>;
  now: number;
  choice: string | null;
  location: GitLocation;
  t: Translator;
  onSelect: (z: GitViewRow) => void;
}) {
  const [endedOpen, setEndedOpen] = useState(false);
  const area = useMemo(
    () => windowArea(window, now, window === "everything" ? oldestBranchPoint(rows.map((z) => z.branchPoint)) : null),
    [window, now, rows],
  );
  const markers = useMemo(() => axisMarkers(area, 6), [area]);
  const colors = useMemo(() => new Map((view.instances ?? []).map((i) => [i.name, i.color])), [view.instances]);
  const groups = useMemo(() => GIT_VIEW_GROUPS.map((g) => ({ g, rows: arrangeRows(rows.filter((z) => z.group === g)) })), [rows]);

  const row = (z: GitViewRow) => (
    <Row key={rowKey(z)} z={z} active={choice === rowKey(z)} color={colors.get(z.instance) ?? null} area={area}
      markers={markers} location={location} now={now} t={t} onSelect={() => onSelect(z)} />
  );

  return (
    <div className="@container/timeline flex min-w-0 flex-col pb-4" data-git-view-timeline={window}>
      <Axis markers={markers} t={t} />
      <Mainline name={view.mainBranch?.name ?? null} line={view.line} area={area} markers={markers} t={t} />
      {groups.map(({ g, rows: groupRows }) => {
        if (origin.has(g) || groupRows.length === 0) return null;
        if (g !== "cbase") {
          return <div key={g} className="flex flex-col" data-git-group-block={g}><GroupsHeader g={g} n={groupRows.length} t={t} />{groupRows.map(row)}</div>;
        }
        // "From cbase": what runs stays open; everything else (ended, copy removed, origin unknown) under "Ended (n)", collapsed.
        const running = groupRows.filter((z) => z.state === "running");
        const ended = groupRows.filter((z) => z.state !== "running");
        return (
          <div key={g} className="flex flex-col" data-git-group-block={g}>
            <GroupsHeader g={g} n={groupRows.length} t={t} />
            {running.map(row)}
            {ended.length > 0 && (
              <button type="button" onClick={() => setEndedOpen((v) => !v)} aria-expanded={endedOpen} data-git-ended={ended.length}
                className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-dim transition-colors hover:bg-hover hover:text-fg">
                <Chevron open={endedOpen} />
                {t("Finished ({n})", { n: ended.length })}
              </button>
            )}
            {endedOpen && ended.map(row)}
          </div>
        );
      })}
    </div>
  );
}
