"use client";
// The pill "3 running tasks" in the working line at the end of the history and its sheet. ONE building block for the coding
// chat; the list is computed by lib/running-tasks.ts (bound to iOS), the line the pill stands in is chat/RunDisplay.tsx.
//
// It replaces the chips ABOVE the input field: "1 background task" and "Alarm 14:05" there, subagents and workflows only in the
// right bar. What the chip cards said is now in the sheet: the description of every command and monitor, the wakeup time with
// countdown, reason and follow-up prompt of the wakeup, the two explanatory sentences. Plus per entry "Open" (the agent bar on
// the right; subagent and workflow, only where the conversation has it) and "Stop", where the server knows a human stop today
// (subagent, workflow, monitor, wakeup; lib/running-tasks.ts `hasStop`). Commands have none; the sheet invents none.
//
// Form: kit sheet via portal on the body with `cb-kit`, `popSurface` with `py-1` (the surface of `popClass` without its inner
// padding all round: the sheet is no menu, its hairlines run to the edge), ONE surface with hairlines, no click catcher as
// `fixed inset-0`: a document `mousedown` plus `closest("[data-tasks-pop]")` (pill and sheet carry the marker; the sheet hangs
// on the body, a `contains` on the button would not see it). `role="dialog"` and `cb-pop` are also the markers by which the
// agent's browser recognises an overlay (lib/browser-native.ts).
//
// Why not the kit `Menu`: it closes as soon as an ancestor of the trigger scrolls; the pill stands IN the history, which
// sticks to the end on every token (`toEnd` sets `scrollTop`). The sheet here FOLLOWS the pill instead of closing: while it
// is open a frame clock measures its position and sets it only when it changed.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { durationShort, elapsed, waitingUntilText } from "@/lib/agents";
import { clockTime } from "@/lib/chat-format";
import { TASK_KIND_WORD, pillsText, stopWay, type RunningTasks, type TaskKind, type TaskItem } from "@/lib/running-tasks";
import { ghostSm, popSurface, quietDangerSm, useFlat } from "@/components/CbKit";

const WIDTH = 380;
const MARGIN = 8;
const GAP = 6;

const svg = (children: React.ReactNode) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
// One sign per kind: command and wakeup as before on the chips (terminal, alarm), agent and workflow new.
const KIND_CHAR: Record<TaskKind, React.ReactNode> = {
  agent: svg(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>),
  workflow: svg(<><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /><path d="M6.5 10v3.5a2 2 0 0 0 2 2H14" /></>),
  // The graph workflow in the background: three nodes, two edges; with "Open" (the card in the bar).
  graph: svg(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5l3 8" /><path d="M16 7.5l-3 8" /></>),
  command: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 2.5 2.5L7 14" /><path d="M12.5 14h4" /></>),
  monitor: svg(<><path d="M22 12h-4l-3 8-6-16-3 8H2" /></>),
  wakeup: svg(<><circle cx="12" cy="13" r="7" /><path d="M12 10v3.5l2 1.5" /><path d="m5 4 2 2" /><path d="m19 4-2 2" /></>),
};

type Situation = { left: number; top?: number; bottom?: number; width: number; maxHeight: number };

export function TasksPill({ tasks, chatId, onOpen }: {
  tasks: RunningTasks;
  /** The chat the stop paths hang on; `null` ⇒ no stop. */
  chatId: string | null;
  /** "Open" of a subagent or workflow; absent when the conversation has no agent bar. */
  onOpen?: (p: TaskItem) => void;
}) {
  const t = useT();
  const flat = useFlat();
  const [open, setOpen] = useState(false);
  const buttonEl = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState<Situation | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stops, setStops] = useState("");
  const [error, setError] = useState("");

  // Escape and a press beside it close; Escape gives focus back to the pill.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonEl.current?.focus({ preventScroll: true });
    };
    const beside = (e: MouseEvent) => {
      const pop = (e.target as Element | null)?.closest?.("[data-tasks-pop]") ?? null;
      if (pop !== wrapper.current && pop !== sheet.current) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", beside);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", beside);
    };
  }, [open]);

  // Second clock ONLY while the sheet is open ("since …", countdown of the wakeup); the pill itself counts nothing, a clock
  // without reason would wake the history on every tick.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  // The position: above the pill (the line stands at the end of the history, the dock lies below), otherwise below; it stays in
  // the window in any case. The frame clock follows the pill while the sheet is open.
  useLayoutEffect(() => {
    if (!open) { setSituation(null); return; }
    let frame = 0;
    let old = "";
    const measure = () => {
      const r = buttonEl.current?.getBoundingClientRect();
      const h = sheet.current?.getBoundingClientRect().height ?? 0;
      if (r) {
        const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
        const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
        // Above the pill if it fits; otherwise on the side with more room, and never taller than that side (a low window once
        // let the sheet stick 173 px over the edge, so the wakeup with its reason was unreachable).
        const slotTop = r.top - GAP - MARGIN;
        const slotBottom = window.innerHeight - r.bottom - GAP - MARGIN;
        const top = h <= slotTop || slotTop >= slotBottom;
        const fresh: Situation = top
          ? { left, bottom: window.innerHeight - r.top + GAP, width, maxHeight: Math.max(120, slotTop) }
          : { left, top: r.bottom + GAP, width, maxHeight: Math.max(120, slotBottom) };
        const key = JSON.stringify(fresh);
        if (key !== old) { old = key; setSituation(fresh); }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Focus goes into the sheet as soon as it stands (it used to stay on the pill, and the sheet at the end of the body was only
  // reachable by tab after the whole page). Escape and "Close" give it back to the pill.
  const focused = useRef(false);
  useEffect(() => {
    if (!open) { focused.current = false; return; }
    if (situation && !focused.current) { focused.current = true; sheet.current?.focus({ preventScroll: true }); }
  }, [open, situation]);

  const text = pillsText(tasks);
  if (!text) return null;

  async function stop(p: TaskItem) {
    const way = chatId ? stopWay(chatId, p) : null;
    if (!way) return;
    setStops(p.key);
    setError("");
    try {
      const response = await api<{ ok?: boolean }>(way.path, { method: "POST", body: JSON.stringify(way.body) });
      // "Not found" comes as ok:false, not as an error: an ineffective click must not look like an effective one (the same rule
      // as in the agent bar). The stream shows the end: the entry drops out.
      if (p.kind === "agent" && response && response.ok === false) {
        setError(t("The subagent did not stop — it is either already finished or not managed by cbase (a subagent of the CLI)."));
      }
    } catch (e) {
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setStops("");
    }
  }

  const timeRow = (p: TaskItem): string => {
    if (p.kind === "wakeup" && p.until !== null) {
      return `${t("at {time}", { time: clockTime(p.until) })} · ${t("in {time}", { time: durationShort(p.until - now) })}`;
    }
    if (p.kind === "agent" && p.until !== null) return waitingUntilText(p.until, t);
    if (p.since !== null) return t("for {duration}", { duration: elapsed(now - p.since) });
    return "";
  };
  const hasCommand = tasks.item.some((p) => p.kind === "command" || p.kind === "monitor");

  return (
    <span ref={wrapper} className="inline-flex" data-tasks-pop>
      <button
        ref={buttonEl}
        type="button"
        data-tasks-pill
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="whitespace-nowrap rounded-full bg-accent-soft px-2 py-px text-[0.8em] font-medium leading-normal text-accent transition-colors hover:bg-accent/20 aria-expanded:bg-accent/20"
      >
        {t(text.key, { n: text.n })}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={sheet}
          role="dialog"
          aria-label={t("Running tasks")}
          data-tasks-pop
          tabIndex={-1}
          style={situation ? { left: situation.left, top: situation.top, bottom: situation.bottom, width: situation.width, maxHeight: situation.maxHeight } : { left: 0, top: 0, width: WIDTH, visibility: "hidden" }}
          className={`${popSurface} py-1 cb-kit fixed overflow-y-auto outline-none${flat}`}
        >
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-1">
            <span className="min-w-0 flex-1 truncate font-semibold">{t("Running tasks")}</span>
            <button
              type="button"
              onClick={() => { setOpen(false); buttonEl.current?.focus({ preventScroll: true }); }}
              aria-label={t("Close")}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
            >
              {svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)}
            </button>
          </div>
          <ul className="cb-scroll max-h-[min(60vh,420px)] overflow-y-auto">
            {tasks.item.map((p) => {
              const row = timeRow(p);
              const way = chatId ? stopWay(chatId, p) : null;
              const open = onOpen && (p.kind === "agent" || p.kind === "workflow" || p.kind === "graph");
              const name = p.kind === "wakeup" ? t("Scheduled to continue") : p.name || t("No description");
              return (
                <li key={p.key} className="border-t border-edge px-3 py-2" data-task-kind={p.kind} data-task-key={p.key}>
                  <div className="flex items-start gap-2">
                    <span className="mt-[2px] shrink-0 text-accent">{KIND_CHAR[p.kind]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={name} data-task-name>{name}</div>
                      <div className="text-[11.5px] text-dim" data-task-time>
                        {t(TASK_KIND_WORD[p.kind])}{row && <> · <span className="tabular-nums">{row}</span></>}
                      </div>
                    </div>
                    {(open || way) && (
                      <div className="flex shrink-0 items-center gap-1">
                        {open && (
                          <button type="button" className={ghostSm} data-task-open onClick={() => { setOpen(false); onOpen(p); }}>
                            {t("Open")}
                          </button>
                        )}
                        {way && (
                          <button type="button" className={quietDangerSm} data-task-stop disabled={stops === p.key} onClick={() => { void stop(p); }}>
                            {stops === p.key ? t("Stopping…") : t("Stop")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {p.kind === "wakeup" && (
                    <>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-dim">
                        {t("The chat is woken at the given time by itself — until then you can keep writing.")}
                      </p>
                      {(p.reason || p.prompt) && (
                        <dl className="mt-1.5 flex flex-col gap-1 text-[12px]">
                          {p.reason && (
                            <div className="flex gap-2" data-task-reason>
                              <dt className="w-20 shrink-0 text-dim">{t("Reason")}</dt>
                              <dd className="min-w-0 flex-1 break-words">{p.reason}</dd>
                            </div>
                          )}
                          {p.prompt && (
                            <div className="flex gap-2" data-task-prompt>
                              <dt className="w-20 shrink-0 text-dim">{t("Then")}</dt>
                              <dd className="min-w-0 flex-1 break-words font-mono text-[11.5px]">{p.prompt}</dd>
                            </div>
                          )}
                        </dl>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {(hasCommand || !tasks.complete || error) && (
            <div className="flex flex-col gap-1 border-t border-edge px-3 pb-1 pt-2 text-[12px] leading-relaxed">
              {hasCommand && (
                <p className="text-dim">{t("Keeps running alongside while the chat stays responsive. As soon as it finishes, the agent evaluates the result on its own.")}</p>
              )}
              {!tasks.complete && (
                <p className="text-dim" data-task-incomplete>{t("This chat's workflows have not loaded yet — more may be running.")}</p>
              )}
              {error && <p className="text-danger" data-task-error>{error}</p>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
