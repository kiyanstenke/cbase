"use client";

// The "Scheduled" tab in Coding: the scheduled jobs of a workspace — inside an entered project those of the project. On the left
// "New job", the segments upcoming · paused · done and the list (ScheduledList), on the right header and the job's chat
// (ScheduledDetail); create and edit in a dialog (JobDialog). A job hangs on EXACTLY one coding chat, every occurrence is a message
// to it — so the chat also appears in the chat list, with a clock (ChatListRows).
//
// Only the state lives here: load the list, choice, segment, dialog. It reloads on the `scheduled` event of the global stream
// (server scheduled/run.js, tick.js: run started, ended, missed, job deleted) and after every own action — which additionally
// reports it as a window event (`reportScheduledChanged`) so the hidden chat list reloads.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ScheduledJob, type Workspace, loadScheduledJobs, subscribeGlobalEvents } from "@/lib/api";
import { Hint, Loading, EmptySentence, Segments, SplitPane, primary } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { SEGMENTS, type Segment, jobsIn, selectedRow, reportScheduledChanged, segmentOf } from "@/lib/scheduled";
import { ScheduledList } from "@/components/scheduled/ScheduledList";
import { ScheduledDetail } from "@/components/scheduled/ScheduledDetail";
import { JobDialog } from "@/components/scheduled/JobDialog";

const choiceKey = (wsId: string, projectId: string | null) => `cbase-scheduled:${wsId}:${projectId ?? "ws"}`;

export function ScheduledTab({ workspace, projectId }: { workspace: Workspace; projectId: string | null }) {
  const t = useT();
  const wsId = workspace.id;
  const [list, setList] = useState<ScheduledJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>("active");
  // The choice survives a tab switch (localStorage per scope); `detailOpen` tells "list" from "detail" below the split threshold —
  // above it both stand side by side, and the selected row shows its detail even without a click.
  const [choice, setChoice] = useState<string | null>(() => {
    try { return localStorage.getItem(choiceKey(wsId, projectId)); } catch { return null; }
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "fresh" } | { kind: "edit"; job: ScheduledJob } | null>(null);

  const load = useCallback(async (): Promise<ScheduledJob[] | null> => {
    try {
      const l = await loadScheduledJobs(wsId, projectId);
      setList(l);
      setError(null);
      return l;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [wsId, projectId]);

  useEffect(() => {
    load();
    return subscribeGlobalEvents((evt) => {
      if (evt.type === "scheduled" && (!evt.workspaceId || evt.workspaceId === wsId)) load();
      // A renamed chat is a renamed job (the name lives on the chat).
      else if (evt.type === "chat_title") load();
    });
  }, [load, wsId]);

  const select = (id: string | null, open = true) => {
    setChoice(id);
    setDetailOpen(open && id !== null);
    try { if (id) localStorage.setItem(choiceKey(wsId, projectId), id); } catch { /* a local preference is optional */ }
  };

  const inSegment = useMemo(() => jobsIn(list ?? [], segment), [list, segment]);
  // The selected row if it is in the segment — otherwise the segment's first (above the split threshold an empty detail would show).
  const selected = selectedRow(inSegment, choice);
  // After an OWN action (pause, resume, save) the bar switches along with the job — it would stay selected but invisible. Never on
  // a mere reload: that would run on every `chat_title` in the workspace and throw back to the old segment.
  const followUp = (a: ScheduledJob | null | undefined) => {
    const s = segmentOf(a);
    if (s) setSegment(s);
  };
  // Once on first load: the remembered choice (localStorage) shows its segment.
  const firstStatus = useRef(false);
  useEffect(() => {
    if (!list || firstStatus.current) return;
    firstStatus.current = true;
    followUp(list.find((x) => x.id === choice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const detail = (a: ScheduledJob) => (
    <ScheduledDetail
      key={a.id}
      workspace={workspace}
      projectId={projectId}
      job={a}
      onEdit={() => setDialog({ kind: "edit", job: a })}
      onChanged={(fresh) => {
        if (fresh) { setList((l) => (l ?? []).map((x) => (x.id === fresh.id ? fresh : x))); followUp(fresh); }
        load();
        reportScheduledChanged(wsId);
      }}
      onBack={() => setDetailOpen(false)}
    />
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-scheduled-page={projectId ?? wsId}>
      <div className="flex shrink-0 flex-wrap items-center gap-3 pb-4">
        <Segments
          label={t("Scheduled")}
          items={SEGMENTS.map((s) => ({ key: s.key, label: t(s.label), data: { "data-scheduled-segment": s.key } }))}
          value={segment}
          onChange={(k) => { setSegment(k as Segment); setDetailOpen(false); }}
        />
        <span className="min-w-0 flex-1" />
        <button type="button" className={primary} onClick={() => setDialog({ kind: "fresh" })} data-scheduled-new>
          {t("New task")}
        </button>
      </div>
      {error && <div className="mb-3 shrink-0"><Hint tone={list ? "warn" : "danger"}>{t("The scheduled tasks could not be loaded: {reason}", { reason: error })}</Hint></div>}
      {!list ? (
        !error && <Loading />
      ) : !list.length ? (
        <EmptySentence title={t("No scheduled task yet")}>
          {t("A task sends its chat the same instructions at fixed times — daily, on weekdays, weekly, monthly or once. Every run shows up in the chat, which is also in the chat list.")}
        </EmptySentence>
      ) : (
        <SplitPane
          list={<ScheduledList jobs={inSegment} selected={selected?.id ?? null} segment={segment} onSelect={(id) => select(id)} />}
          detail={detailOpen && selected ? detail(selected) : null}
          placeholder={selected ? detail(selected) : <EmptySentence title={t("No task selected")} />}
        />
      )}
      {dialog && (
        <JobDialog
          workspace={workspace}
          projectId={projectId}
          job={dialog.kind === "edit" ? dialog.job : null}
          onClose={() => setDialog(null)}
          onSaved={(id) => { setDialog(null); load().then((l) => { followUp(l?.find((x) => x.id === id)); select(id); }); reportScheduledChanged(wsId); }}
          onDeleted={() => { setDialog(null); select(null, false); load(); reportScheduledChanged(wsId); }}
        />
      )}
    </section>
  );
}
