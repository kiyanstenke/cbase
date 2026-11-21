"use client";

import { useCallback, useEffect, useState } from "react";
import { outerLoopRuns, subscribeGlobalEvents, type OuterLoopAgent, type OuterLoopRun, type OuterLoopSum } from "@/lib/api";
import { ghost, ghostSm, Hint, Loading, Modal, ModalTitle } from "@/components/CbKit";
import { dateLocale, useT } from "@/lib/i18n";
import { triggerKindName, costText, runError, runUpkeepText, tokenShort, stateName, stateTone } from "@/components/outerloop/outerLoopText";

// The runs of an outer-loop agent, as a list on the agent — time, chat, trigger, tokens/cost, error. ONE surface, rows separated by
// hairlines, newest first; "more" pages via `after` (id of the last run — the server resolves it to (startedAt, rowid), so runs started at
// the same time are not lost at the page boundary). A click on a row expands the toolset the run REALLY had (after the fence cut) — what
// was dropped is shown with it. Cost `null` means subscription or no price and shows as "—", never as 0.
// A run of the agenda keeper names its tally ("3 changes · 1 corrected") in the header; without `upkeep` (every other agent, an older
// server) nothing shows there. A run the server ended ON PURPOSE (a code from server/…/outerloop/intended-end.js: `turn` — a turn in the
// observed chat; `quiet` — the wakeup arrived in a chat that was not quiet) is not shown as a red code but calmly with its own text
// ("Stopped: the chat went back to work", "Postponed: the chat was not quiet" — `runError`, outerLoopText.ts).

function Marker({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "accent" | "warn" | "ok" | "danger" }) {
  const color = { dim: "bg-edge text-dim", accent: "bg-accent/12 text-accent", warn: "bg-warn/15 text-warn", ok: "bg-ok/15 text-ok", danger: "bg-danger/12 text-danger" }[tone];
  return <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold ${color}`}>{children}</span>;
}

const time = (ms: number) => new Date(ms).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function OuterLoopRuns({ workspaceId, agent, onClose, onOpenChat }: {
  workspaceId: string;
  agent: OuterLoopAgent;
  onClose: () => void;
  /** Jumps to the observed Coding chat — offered only for the kind "normal". */
  onOpenChat?: (chatId: string) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<OuterLoopRun[] | null>(null);
  const [additional, setAdditional] = useState(false);
  const [sum, setSum] = useState<OuterLoopSum | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await outerLoopRuns(workspaceId, agent.id, { limit: 50 });
      setItems(s.items); setAdditional(s.additional); setSum(s.sum); setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, [workspaceId, agent.id]);
  useEffect(() => { void load(); }, [load]);
  // A run of this agent changes state ⇒ reload (event `outer_loop`).
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type === "outer_loop" && String(evt.agentId ?? "") === agent.id) void load();
  }), [agent.id, load]);

  // The error of a run: red, except an intended end (abort at the turn, deferral in a busy chat) — `runError` shows that calmly with
  // its own text.
  const errorOf = (l: OuterLoopRun) => {
    const f = runError(l, t);
    return f && (
      <span className={`mt-0.5 block line-clamp-2 text-[11.5px] ${f.quiet ? "text-dim" : "text-danger"}`} data-outerloop-run-error={f.quiet ? "quiet" : "error"}>{f.text}</span>
    );
  };

  async function more() {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const s = await outerLoopRuns(workspaceId, agent.id, { limit: 50, after: items[items.length - 1].id });
      setItems([...items, ...s.items.filter((l) => !items.some((x) => x.id === l.id))]);
      setAdditional(s.additional);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoadingMore(false); }
  }

  return (
    <Modal onClose={onClose} width={720} label={t("Runs of {name}", { name: agent.name })}>
      <ModalTitle hint={sum ? t("{n} runs · {in} tokens in · {out} out · cost {cost}", {
        n: sum.runs, in: tokenShort(sum.input), out: tokenShort(sum.output), cost: costText(sum.cost),
      }) : undefined}>
        {t("Runs of {name}", { name: agent.name })}
      </ModalTitle>
      {err && <Hint tone="danger">{err}</Hint>}
      {!items && !err && <Loading />}
      {items && (
        <div className="cb-kit-pane overflow-hidden rounded-2xl" data-outerloop-runs={agent.id}>
          {items.length === 0 && <div className="px-4 py-3 text-[12.5px] text-dim">{t("No run yet.")}</div>}
          {items.map((l) => {
            const on = open === l.id;
            return (
              <div key={l.id} className="border-b border-edge/60 last:border-b-0">
                <button type="button" onClick={() => setOpen(on ? null : l.id)} data-open={on ? "1" : undefined}
                  className="cb-row flex w-full items-start gap-3 px-4 py-2.5 text-left">
                  <span className="w-[86px] shrink-0 font-mono text-[11.5px] tabular-nums text-dim">{time(l.startedAt)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-[13px]">{l.chatTitle || t("(deleted chat)")}</span>
                      <Marker tone={stateTone(l.state)}>{stateName(l.state, t)}</Marker>
                      {l.upkeep && (
                        <span className="shrink-0 text-[11.5px] tabular-nums text-dim" data-outerloop-run-upkeep={l.id}>
                          {runUpkeepText(l.upkeep, t)}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-dim">
                      {triggerKindName(l.trigger, t)}
                      {` · ${t("{in} in · {out} out", { in: tokenShort(l.input), out: tokenShort(l.output) })}`}
                      {` · ${costText(l.cost)}`}
                      {l.attempts > 1 && ` · ${t("Attempt {n}", { n: l.attempts })}`}
                    </span>
                    {errorOf(l)}
                  </span>
                </button>
                {on && (
                  <div className="flex flex-col gap-1 px-4 pb-3 pl-[118px] text-[11.5px] text-dim">
                    {l.model && <span>{t("Model")}: <span className="font-mono">{l.provider}::{l.model}</span></span>}
                    <span>{t("cbase")}: <span className="font-mono">{l.set.cbase.join(" · ") || "—"}</span></span>
                    <span>{t("Built-in")}: <span className="font-mono">{l.set.builtin.join(" · ") || "—"}</span></span>
                    {l.set.extern.length > 0 && <span>{t("External")}: <span className="font-mono">{l.set.extern.join(" · ")}</span></span>}
                    {l.set.dropped.fence.length > 0 && <span>{t("Blocked by the fence")}: <span className="font-mono">{l.set.dropped.fence.join(" · ")}</span></span>}
                    {l.set.dropped.approval.length > 0 && <span>{t("Dropped for an approval mark")}: <span className="font-mono">{l.set.dropped.approval.join(" · ")}</span></span>}
                    {l.set.dropped.locked.length > 0 && <span>{t("Deselected for coding chats at the server (Coding → MCP)")}: <span className="font-mono">{l.set.dropped.locked.join(" · ")}</span></span>}
                    {l.parkedUntil && l.state === "parked" && <span>{t("Parked until {time}", { time: time(l.parkedUntil) })}</span>}
                    {onOpenChat && l.chatTitle && l.chatKind === "normal" && (
                      <span><button type="button" onClick={() => onOpenChat(l.chatId)} className={ghostSm}>{t("Back to chat")}</button></span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        {additional && <button type="button" onClick={() => { void more(); }} disabled={loadingMore} className={ghostSm}>{loadingMore ? t("Loading…") : t("Load more")}</button>}
        <span className="flex-1" />
        <button type="button" onClick={onClose} className={ghost}>{t("Close")}</button>
      </div>
    </Modal>
  );
}
