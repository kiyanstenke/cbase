"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GitlabAccount, type GitlabEventKind, type GitlabTarget, type TriggerTestResult, type TriggerView, type WorkflowTrigger } from "@/lib/api";
import { Hint, Overline, Segments, ghostSm, primary } from "@/components/CbKit";
import { Info, PlaceholderChips } from "@/components/workflow/PlaceholderChips";
import { fieldFull, fieldDense, marker } from "@/components/workflow/workflowForm";
import { useT } from "@/lib/i18n";

// Settings of a GitLab trigger node (content of the node modal in the workflow editor):
// account → scope → events → filter. The account can be connected right here so that you do not
// have to leave the editor for a trigger (like credentials in n8n).
//
// `projectOnly` marks events that GitLab offers only per project (event feed and pipelines hang on
// the project). They are disabled for "All projects"/"Group" — otherwise you would save a trigger
// that silently never fires.
//
// Form: one surface per question with the marker INSIDE the box (instead of four framed boxes), the
// scope as a segment bar (ONE value of three), fields as wells. No explanatory paragraphs: what
// carries a rule (cadence, token, check) hangs as a tooltip on the (i) of the section marker; the
// event's placeholders are chips with a tooltip each — display only, the trigger has no text field.
// The fields have the same density as the node dialog whose content they are (`workflowForm.ts`:
// 28 px, 12.5 px); the checkbox rows sit at 12 px like its options.
const EVENTS: { kind: GitlabEventKind; label: string; projectOnly?: boolean }[] = [
  { kind: "mr_opened", label: "New merge request" },
  { kind: "mr_updated", label: "Merge request updated" },
  { kind: "mr_merged", label: "Merge request merged" },
  { kind: "mr_closed", label: "Merge request closed" },
  { kind: "mr_review_requested", label: "I was added as reviewer" },
  { kind: "issue_opened", label: "New work item" },
  { kind: "issue_closed", label: "Work item closed" },
  { kind: "issue_assigned", label: "Work item assigned to me" },
  { kind: "comment", label: "New comment", projectOnly: true },
  { kind: "push", label: "New commits (push)", projectOnly: true },
  { kind: "pipeline_failed", label: "Pipeline failed", projectOnly: true },
  { kind: "pipeline_succeeded", label: "Pipeline succeeded", projectOnly: true },
];
const GROUPS: { title: string; kinds: GitlabEventKind[] }[] = [
  { title: "Merge requests", kinds: ["mr_opened", "mr_updated", "mr_merged", "mr_closed", "mr_review_requested"] },
  { title: "Work items", kinds: ["issue_opened", "issue_closed", "issue_assigned"] },
  { title: "Repository & pipelines", kinds: ["comment", "push", "pipeline_failed", "pipeline_succeeded"] },
];

// The event data that may appear in every step text (`triggerVars`/`renderText` on the server) —
// chips with a tooltip instead of a sentence listing them.
const EVENT_PLACEHOLDER: { token: string; title: string }[] = [
  { token: "{{event}}", title: "Kind of event, e.g. “New merge request”" },
  { token: "{{title}}", title: "Title of the merge request or work item" },
  { token: "{{url}}", title: "Link to the item in GitLab" },
  { token: "{{project}}", title: "Path of the project" },
  { token: "{{author}}", title: "who triggered the event" },
  { token: "{{branch}}", title: "affected branch" },
  { token: "{{description}}", title: "Description of the merge request or work item" },
];

const pane = "cb-kit-pane rounded-2xl p-3";

function GitlabMark({ size = 15 }: { size?: number }) {
  // Tanuki as a line drawing — enough as a recognition mark and fits the monochrome iconography.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21 3.4 14.8a1 1 0 0 1-.35-1.09L4.6 8.6 12 21l7.4-12.4 1.55 5.11a1 1 0 0 1-.35 1.09z" />
      <path d="M4.6 8.6 6.4 3.2a.5.5 0 0 1 .94-.02L9.5 8.6M19.4 8.6l-1.8-5.4a.5.5 0 0 0-.94-.02L14.5 8.6" />
    </svg>
  );
}

export function WorkflowTriggerSettings({ trigger, status, onChange, onTest }: {
  trigger: WorkflowTrigger;
  status?: TriggerView | null;
  onChange: (patch: Partial<WorkflowTrigger>) => void;
  onTest: () => Promise<TriggerTestResult>;
}) {
  const t = useT();
  const [accounts, setAccounts] = useState<GitlabAccount[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [host, setHost] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<GitlabTarget[]>([]);
  const [picking, setPicking] = useState(false);
  const [test, setTest] = useState<TriggerTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const loadAccounts = useCallback(async () => {
    const r = await api<{ accounts: GitlabAccount[] }>("/api/gitlab/accounts");
    setAccounts(r.accounts);
    // Exactly one account and none chosen yet → that is the one meant.
    if (r.accounts.length === 1 && !trigger.accountId) onChange({ accountId: r.accounts[0].id });
    return r.accounts;
  }, [trigger.accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadAccounts().catch((e) => setError(String(e))); }, [loadAccounts]);

  const account = accounts.find((a) => a.id === trigger.accountId) ?? null;
  const needsTarget = trigger.scope === "project" || trigger.scope === "group";
  const targetLabel = trigger.scope === "project" ? trigger.projectPath : trigger.scope === "group" ? trigger.groupPath : "";

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const acc = await api<GitlabAccount>("/api/gitlab/accounts", {
        method: "POST", body: JSON.stringify({ host, token }),
      });
      setToken("");
      setConnecting(false);
      await loadAccounts();
      onChange({ accountId: acc.id });
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(false); }
  }

  // Search the account's projects/groups (server-side so that the token stays on the server).
  const loadTargets = useCallback(async (q: string) => {
    if (!trigger.accountId) return;
    setBusy(true);
    setError("");
    try {
      const kind = trigger.scope === "group" ? "groups" : "projects";
      const r = await api<{ items: GitlabTarget[] }>(`/api/gitlab/accounts/${trigger.accountId}/${kind}?search=${encodeURIComponent(q)}`);
      setTargets(r.items);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(false); }
  }, [trigger.accountId, trigger.scope]);

  useEffect(() => {
    if (!picking) return;
    loadTargets(search).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, trigger.scope]);

  function toggleEvent(kind: GitlabEventKind, on: boolean) {
    const next = on ? [...new Set([...trigger.events, kind])] : trigger.events.filter((e) => e !== kind);
    onChange({ events: next as GitlabEventKind[] });
  }

  const chosen = useMemo(() => new Set(trigger.events), [trigger.events]);
  const when = (ms: number) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—");

  return (
    <div className="flex flex-col gap-3">
      {/* Account */}
      <div className={pane}>
        <div className="flex items-center gap-2">
          <span className="text-dim"><GitlabMark /></span>
          <span className="text-[12.5px] font-semibold">{t("GitLab account")}</span>
          {accounts.length > 0 && (
            <button type="button" onClick={() => setConnecting((v) => !v)} className={`ml-auto ${ghostSm}`}>
              {connecting ? t("Cancel") : t("Connect another")}
            </button>
          )}
        </div>
        {accounts.length > 0 && (
          <select
            value={trigger.accountId}
            onChange={(e) => onChange({ accountId: e.target.value })}
            className={`mt-2 ${fieldFull}`}
          >
            <option value="">{t("— choose account —")}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{`${a.label || a.host}${a.userName ? ` — @${a.userName}` : ""}`}</option>
            ))}
          </select>
        )}
        {account?.status && <div className="mt-2"><Hint tone="danger">{account.status}</Hint></div>}
        {(connecting || accounts.length === 0) && (
          <div className="mt-2 flex flex-col gap-2">
            <label className={marker}>{t("Host")}</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://gitlab.com" className={fieldFull} />
            <label className={`flex items-center gap-1.5 ${marker}`}>
              {t("Access token (scope api; read_api is enough for triggers)")}
              <Info text={t("The token stays on this machine and is never handed back.")} />
            </label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder="glpat-…"
              className={fieldFull}
            />
            <div className="flex items-center gap-2">
              <button type="button" onClick={connect} disabled={busy || !token.trim()} className={`${primary} disabled:opacity-40`}>
                {busy ? t("Checking…") : t("Connect")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scope — ONE value of three, so a segment bar instead of three capsules. */}
      <div className={pane}>
        <Overline>{t("Where should it listen?")}</Overline>
        <Segments
          label={t("Where should it listen?")}
          items={[
            { key: "all", label: t("All my projects") },
            { key: "group", label: t("One group") },
            { key: "project", label: t("One project") },
          ]}
          value={trigger.scope}
          onChange={(value) => {
            onChange({ scope: value as WorkflowTrigger["scope"] });
            setPicking(value !== "all");
            setTargets([]);
          }}
        />
        {needsTarget && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {targetLabel || <span className="text-dim">{trigger.scope === "project" ? t("No project chosen yet") : t("No group chosen yet")}</span>}
              </span>
              <button type="button" onClick={() => { setPicking((v) => !v); if (!picking) loadTargets(search).catch(() => {}); }} disabled={!trigger.accountId} className={`${ghostSm} disabled:opacity-40`}>
                {picking ? t("Close") : targetLabel ? t("Choose another") : t("Choose")}
              </button>
            </div>
            {picking && (
              // The hit list is a well (one step below the surface) with hairlines — no second frame
              // inside the frame.
              <div className="mt-2 overflow-hidden rounded-xl bg-bg">
                <div className="flex gap-1.5 p-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") loadTargets(search).catch(() => {}); }}
                    placeholder={trigger.scope === "project" ? t("Search project…") : t("Search group…")}
                    className="min-w-0 flex-1 rounded-lg bg-panel px-2.5 py-1 text-[12.5px] leading-5 outline-none placeholder:text-dim focus:ring-1 focus:ring-accent/50"
                  />
                  <button type="button" onClick={() => loadTargets(search).catch(() => {})} disabled={busy} className={ghostSm}>{t("Search")}</button>
                </div>
                <div className="cb-scroll max-h-[168px] divide-y divide-edge/60 overflow-y-auto border-t border-edge/60">
                  {targets.length === 0 && <div className="px-3 py-3 text-[12px] text-dim">{busy ? t("Searching…") : t("No matches.")}</div>}
                  {targets.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => {
                        onChange(trigger.scope === "project"
                          ? { projectId: it.id, projectPath: it.path }
                          : { groupId: it.id, groupPath: it.path });
                        setPicking(false);
                      }}
                      className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <span className="text-[12.5px] font-medium">{it.path}</span>
                      <span className="text-[11px] text-dim">{it.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Events */}
      <div className={pane}>
        <div className="flex items-center gap-2">
          <Overline>{t("When should the workflow start?")}</Overline>
          <span className="mb-1.5"><Info text={t("The server polls GitLab regularly and starts the workflow in its own chat for every new event. Arm it at the top of the editor (“Active”).")} /></span>
          <span className="mb-1.5 ml-auto text-[11px] text-dim">{t("{n} selected", { n: trigger.events.length })}</span>
        </div>
        {GROUPS.map((g) => (
          <div key={g.title} className="mt-1.5">
            <div className="mb-1 text-[11px] font-semibold text-dim">{t(g.title)}</div>
            <div className="flex flex-col gap-0.5">
              {g.kinds.map((kind) => {
                const meta = EVENTS.find((e) => e.kind === kind)!;
                const blocked = !!meta.projectOnly && trigger.scope !== "project";
                return (
                  <label
                    key={kind}
                    title={blocked ? t("Only available for ONE project — GitLab does not offer this event group- or instance-wide.") : ""}
                    className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] ${blocked ? "opacity-45" : "cursor-pointer hover:bg-hover"}`}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(kind)}
                      disabled={blocked}
                      onChange={(e) => toggleEvent(kind, e.target.checked)}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span>{t(meta.label)}</span>
                    {meta.projectOnly && <span className="text-[10px] text-dim">{t("(project only)")}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Filter + cadence */}
      <div className={pane}>
        <Overline>{t("Fine tuning")}</Overline>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={marker}>{t("Only with labels (comma separated)")}</label>
            <input value={trigger.labels} onChange={(e) => onChange({ labels: e.target.value })} placeholder={t("e.g. bug, review")} className={`mt-1 ${fieldFull}`} />
          </div>
          <div>
            <label className={marker}>{t("Only branch")}</label>
            <input value={trigger.branch} onChange={(e) => onChange({ branch: e.target.value })} placeholder="main" className={`mt-1 ${fieldFull}`} />
          </div>
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] hover:bg-hover">
          <input type="checkbox" checked={trigger.skipMine} onChange={(e) => onChange({ skipMine: e.target.checked })} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
          {t("Ignore my own events")}
          <span className="text-[11px] text-dim">{t("(otherwise a push by the agent triggers the workflow again)")}</span>
        </label>
        <div className="mt-2 flex items-center gap-2">
          <label className={marker}>{t("Check every N seconds")}</label>
          <input
            type="number" min={30} max={3600} step={30}
            value={trigger.intervalSec}
            onChange={(e) => onChange({ intervalSec: Math.max(30, Math.min(3600, Number(e.target.value) || 60)) })}
            className={`${fieldDense} w-24`}
          />
        </div>
      </div>

      {/* Check + state */}
      <div className={pane}>
        <div className="flex items-center gap-2">
          <Overline>{t("Check")}</Overline>
          <span className="mb-1.5"><Info text={t("Shows events from the last 24 hours that would trigger — without starting anything and without consuming events. Once armed, only new ones count.")} /></span>
          <button
            type="button"
            onClick={async () => {
              setTesting(true);
              setError("");
              try { setTest(await onTest()); }
              catch (e) { setError(String((e as Error)?.message || e)); }
              finally { setTesting(false); }
            }}
            className={`mb-1.5 ml-auto ${ghostSm}`}
          >
            {testing ? t("Asking GitLab…") : t("Check now")}
          </button>
        </div>
        {test && (
          <div className="mt-2 flex flex-col gap-1">
            {test.error && <Hint tone="warn">{test.error}</Hint>}
            {test.events.length === 0 && !test.error && <div className="text-[12px] text-dim">{t("Nothing new — the trigger is waiting.")}</div>}
            {test.events.map((e, i) => (
              <div key={i} className="rounded-lg bg-bg px-2 py-1.5 text-[11.5px]">{e.summary}</div>
            ))}
          </div>
        )}
        {status && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
            <span>{t("Last poll: {when}", { when: when(status.lastPollAt) })}</span>
            <span>{t("Last trigger: {when}", { when: when(status.lastFireAt) })}</span>
            <span>{t("triggered {n}×", { n: status.fires })}</span>
            {status.lastError && <span className="text-warn">{status.lastError}</span>}
          </div>
        )}
      </div>

      {error && <Hint tone="danger">{error}</Hint>}
      {/* The event data as placeholders for the step texts — chips, display only (no field here). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={marker}>{t("Placeholders")}</span>
        <PlaceholderChips chips={EVENT_PLACEHOLDER.map((c) => ({ token: c.token, title: t(c.title) }))} />
      </div>
    </div>
  );
}
