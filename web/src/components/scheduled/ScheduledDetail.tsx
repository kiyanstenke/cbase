"use client";

// The detail of a scheduled job: on top the header — name, cadence, next occurrence, state, plus "Run now", "Pause"/"Resume", the
// runs (kit `Menu`, sheet `cb-pop` on the body) and "Settings" —, below it the job's chat as ChatPane in mode `onlyChat` (no chat
// list; the same chat appears in Coding → Chats with a clock). Every occurrence is a message to this chat; what the agent
// answered is there.
import { useEffect, useState } from "react";
import {
  type ScheduledJob, type ScheduledRun, type Workspace,
  changeScheduledJob, executeScheduledJob, loadScheduledRuns,
} from "@/lib/api";
import { Hint, Loading, Menu, SplitBackButton, ghostSm, menuRow, primary } from "@/components/CbKit";
import { ChatPane } from "@/components/chat/ChatPane";
import { useT } from "@/lib/i18n";
import { relative } from "@/lib/chat-format";
import { causeWord, foreignZone, runTone, runWord, stateWord } from "@/lib/scheduled";
import { occurrenceText } from "@/components/scheduled/ScheduledList";

const TONE: Record<ReturnType<typeof runTone>, string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger", dim: "text-dim" };

export function ScheduledDetail({ workspace, projectId, job: a, onEdit, onChanged, onBack }: {
  workspace: Workspace;
  /** The entered project of the page (ChatPane focus as in the Chats tab), not the job's. */
  projectId: string | null;
  job: ScheduledJob;
  onEdit: () => void;
  onChanged: (fresh: ScheduledJob | null) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [working, setWorking] = useState<"run" | "status" | null>(null);
  const [notice, setNotice] = useState<{ tone: "danger" | "ok"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);

  const nowExecute = async () => {
    setWorking("run"); setNotice(null);
    try {
      onChanged(await executeScheduledJob(a.workspaceId, a.id));
      setNotice({ tone: "ok", text: t("Run started — it shows up in the chat below.") });
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally { setWorking(null); }
  };
  const toggle = async () => {
    setWorking("status"); setNotice(null);
    try {
      onChanged(await changeScheduledJob(a.workspaceId, a.id, { status: a.status === "active" ? "paused" : "active" }));
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally { setWorking(null); }
  };

  const state = stateWord(a.state);
  // The cadence is in the job's zone, the next occurrence in the browser's — if they differ the line names the zone.
  const zone = foreignZone(a.timeZone);
  const under = [
    zone ? `${a.cadenceText} (${zone})` : a.cadenceText,
    a.status === "active" && a.nextAt > 0 ? t("next run {when}", { when: `${occurrenceText(a.nextAt)} (${relative(a.nextAt, now, t)})` }) : null,
    a.status === "paused" ? t("paused") : a.status === "done" ? t("done") : null,
    a.retryAt > 0 && a.status === "active" ? t("retry {when}", { when: occurrenceText(a.retryAt) }) : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-scheduled-detail={a.id}>
      <SplitBackButton label={t("All tasks")} onClick={onBack} />
      <header className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="min-w-0 truncate text-[18px] font-medium tracking-[-0.01em]">{a.name || t("Scheduled task")}</h2>
            {state && <span className={`shrink-0 text-[12px] ${a.state === "running" ? "text-accent" : "text-warn"}`}>{t(state)}</span>}
          </div>
          {under.length > 0 && <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim" data-scheduled-under>{under.join(" · ")}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" className={primary} disabled={working !== null || a.state !== null || !a.chatId} onClick={nowExecute}
            title={a.state ? t("A run of this task is already open.") : undefined} data-scheduled-now>
            {working === "run" ? t("Starting…") : t("Run now")}
          </button>
          {a.status !== "done" && (
            <button type="button" className={ghostSm} disabled={working !== null} onClick={toggle} data-scheduled-pause={a.status === "active" ? "pause" : "resume"}>
              {a.status === "active" ? t("Pause") : t("Resume")}
            </button>
          )}
          <Menu
            label={t("runs")}
            width={360}
            button={{ content: t("runs"), className: ghostSm, data: { "data-scheduled-runs": "" } }}
          >
            <RunsSheet job={a} />
          </Menu>
          <button type="button" className={ghostSm} onClick={onEdit} data-scheduled-settings>{t("Settings")}</button>
        </div>
      </header>
      {notice && (
        <div className="mb-3 flex shrink-0 items-start gap-2" data-scheduled-notice={notice.tone}>
          <div className="min-w-0 flex-1"><Hint tone={notice.tone}>{notice.text}</Hint></div>
          <button type="button" className={ghostSm} onClick={() => setNotice(null)}>{t("Dismiss##hide")}</button>
        </div>
      )}
      {a.chatId ? (
        <div className="flex min-h-0 min-w-0 flex-1" data-scheduled-chat={a.chatId}>
          <ChatPane key={a.chatId} workspace={workspace} focusProjectId={projectId} onlyChat={a.chatId} />
        </div>
      ) : (
        <Hint tone="warn">{t("The chat of this task is missing.")}</Hint>
      )}
    </div>
  );
}

/** The runs sheet: loaded on opening (the kit renders content only while open), newest first, "Load older" pages — without closing
 *  the sheet (a click inside would otherwise close it, CbKit `Menu`). */
function RunsSheet({ job: a }: { job: ScheduledJob }) {
  const t = useT();
  const [runs, setRuns] = useState<ScheduledRun[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (before?: string) => {
    try {
      const r = await loadScheduledRuns(a.workspaceId, a.id, { before, limit: 20 });
      setRuns((old) => (before ? [...(old ?? []), ...r.items] : r.items));
      setNext(r.next);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [a.id]);
  if (error) return <div className="px-3 py-2"><Hint tone="danger">{error}</Hint></div>;
  if (!runs) return <Loading />;
  if (!runs.length) return <div className="px-3 py-2 text-dim" data-scheduled-runs-empty>{t("No run yet.")}</div>;
  return (
    <div className="cb-scroll max-h-[min(420px,60vh)] overflow-y-auto" data-scheduled-runs-list>
      {runs.map((l) => {
        const cause = causeWord(l.cause);
        const time = l.startedAt || l.scheduledAt;
        return (
          <div key={l.id} className="px-2.5 py-1.5" data-scheduled-run={l.status ?? ""}>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate tabular-nums">{time ? occurrenceText(time) : "—"}{cause ? ` · ${t(cause)}` : ""}</span>
              <span className={`shrink-0 text-[11.5px] ${TONE[runTone(l.status)]}`}>{t(runWord(l.status))}{l.question ? ` · ${t("Question##ask")}` : ""}</span>
            </div>
            {(l.error || l.short) && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-dim">{l.error || l.short}</div>}
          </div>
        );
      })}
      {next && (
        <button type="button" className={`${menuRow} text-dim hover:text-fg focus-visible:text-fg`} onClick={(e) => { e.stopPropagation(); load(next); }}>
          {t("Load older")}
        </button>
      )}
    </div>
  );
}
