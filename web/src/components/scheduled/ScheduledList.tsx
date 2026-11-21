"use client";

// The list of the "Scheduled" tab: ONE row per job in the form of the coding pages (kit, "instances look": tile in front in the
// colour of the state, name, below it the facts line; no surface, no hairlines) — cadence in the server's plain text, the next
// occurrence (upcoming) or the last run, and the state when it is not the normal case.
import { useEffect, useState } from "react";
import type { ScheduledJob } from "@/lib/api";
import { FACTS, Fact, SELECTED, Tile, EmptyRow, SYM, RowsArrow } from "@/components/CbKit";
import { useT, dateLocale } from "@/lib/i18n";
import { relative } from "@/lib/chat-format";
import { type Segment, runTone, runWord, stateWord } from "@/lib/scheduled";

const TONE: Record<ReturnType<typeof runTone>, string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger", dim: "text-dim" };

/** A time, short: "Wed 22.10., 22:00" in the interface language. */
export function occurrenceText(ms: number): string {
  return new Date(ms).toLocaleString(dateLocale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** The tile colour: running (accent), queued/parked (yellow), last run with error (red), paused/done (dimmed). */
function tileColor(a: ScheduledJob): string {
  if (a.state === "running") return "text-accent";
  if (a.state) return "text-warn";
  if (a.status !== "active") return "text-dim";
  if (a.lastRun && runTone(a.lastRun.status) === "danger") return "text-danger";
  return "text-fg/80";
}

export function ScheduledList({ jobs, selected, segment, onSelect }: {
  jobs: ScheduledJob[];
  selected: string | null;
  segment: Segment;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  // The remaining time ("in 3 h 20 min") keeps running — once per half minute is enough for a value in minutes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);
  if (!jobs.length) {
    return (
      <EmptyRow>
        {segment === "active" ? t("No upcoming task.") : segment === "paused" ? t("No paused task.") : t("No completed task.")}
      </EmptyRow>
    );
  }
  return (
    <div className="flex flex-col gap-0.5" data-scheduled-list>
      {jobs.map((a) => {
        const active = a.id === selected;
        const state = stateWord(a.state);
        const last = a.lastRun;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            aria-current={active ? "true" : undefined}
            data-active={active ? "1" : undefined}
            data-scheduled-job={a.id}
            className={`group flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors ${active ? SELECTED : "hover:bg-hover"}`}
          >
            <Tile color={tileColor(a)}>{SYM.clock()}</Tile>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{a.name || t("Scheduled task")}</span>
                {state && <span className={`shrink-0 text-[12px] ${a.state === "running" ? "text-accent" : "text-warn"}`} data-scheduled-state={a.state ?? ""}>{t(state)}</span>}
              </span>
              <span className={`mt-0.5 ${FACTS}`}>
                {a.cadenceText && <Fact>{a.cadenceText}</Fact>}
                {a.status === "active" && a.nextAt > 0 && (
                  <Fact title={occurrenceText(a.nextAt)} data={{ "data-scheduled-next": String(a.nextAt) }}>{relative(a.nextAt, now, t)}</Fact>
                )}
                {last && (
                  <Fact className={TONE[runTone(last.status)]} title={last.error || last.short || undefined}>
                    {t("last {word}", { word: t(runWord(last.status)) })}
                  </Fact>
                )}
              </span>
            </span>
            <span className="flex shrink-0 items-center @5xl/kit:hidden"><RowsArrow /></span>
          </button>
        );
      })}
    </div>
  );
}
