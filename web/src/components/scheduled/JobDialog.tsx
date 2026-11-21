"use client";

// Create and edit a scheduled job: instructions, repetition, time of day, below it "Advanced" with name, project/instance,
// permission mode, provider/model, effort and notification. Kit `Modal` (portal on the body, `cb-overlay` + `cb-sheet`).
//
// Two paths, as in the server: instructions and cadence are fields of the JOB (PATCH …/scheduled/:id), name and run values live on
// the CHAT (PATCH /api/chats/:id with its rules — 400 for an unknown effort level or provider, a provider switch starts a new
// session). When editing only what changed goes out ("a missing field means unchanged"). The instance of an existing job is
// switched by the instance choice in its chat's header (the same as in Coding → Chats), not by this dialog.
// Cadence and plan go out (and are validated) when editing only if the repetition was touched (`jobChange`); if the chat does not
// load, "Advanced" shows no run values and only instructions and repetition are saved. A new job runs in the browser's time zone;
// a differing zone of an existing one is shown under the time of day.
//
// Prefilled like a new chat: permission mode full access (`bypassPermissions` — a nightly run that stops at an approval card would
// never finish), provider and model "Default" (the server sets the global provider and its default model), effort "Default". A name
// is optional: without one the first line of the instructions becomes the chat's title.
import { useEffect, useMemo, useState } from "react";
import {
  type Chat, type ScheduledJob, type Project, type Workspace,
  SCHEDULED_INSTRUCTIONS_MAX, changeScheduledJob, api, setUpScheduledJob, deleteScheduledJob,
} from "@/lib/api";
import { Chevron, Hint, Loading, Modal, ModalTitle, Toggle, field, ghost, primary, quietDanger, select } from "@/components/CbKit";
import { ProviderModel, LevelChoice } from "@/components/ProviderModel";
import { useConfirm } from "@/components/Prompts";
import { PERM_MODES, type ProviderMeta } from "@/components/chat/ChatCatalog";
import { instanceTitle } from "@/components/projects/InstanceDialogs";
import { chatInstanceOptions, MAIN, type InstanceOption } from "@/lib/instances-tree";
import { effortDefaultLevel, effortChoiceBody } from "@/lib/effort";
import { useT } from "@/lib/i18n";
import {
  DAYS_OF_MONTH, CADENCE_CHOICE, type CadenceForm, type CadenceValue, WEEKDAYS, jobChange, ownTimeZone, formFromJob, foreignZone, levelToSave,
  emptyCadenceForm, planFromForm,
} from "@/lib/scheduled";

const lab = "text-[11px] font-semibold uppercase tracking-wider text-dim";

type RunValues = { name: string; projectId: string; instance: string; permissionMode: string; provider: string; model: string; effort: string; notification: boolean };

const preset = (projectId: string | null): RunValues => ({
  name: "", projectId: projectId ?? "", instance: MAIN, permissionMode: "bypassPermissions", provider: "", model: "", effort: "", notification: true,
});

function fromChat(c: Chat): RunValues {
  return {
    name: c.title || "", projectId: c.projectId ?? "", instance: c.instance || MAIN, permissionMode: c.permissionMode || "default",
    provider: c.provider || "", model: c.model || "", effort: c.effort || "", notification: c.notify?.schedule !== "off",
  };
}

export function JobDialog({ workspace, projectId, job, onClose, onSaved, onDeleted }: {
  workspace: Workspace;
  /** The entered project of the page — the preselection of a new job. */
  projectId: string | null;
  /** `null` = create new. */
  job: ScheduledJob | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const fresh = job === null;
  const [instructions, setInstructions] = useState(job?.instructions ?? "");
  const [form, setForm] = useState<CadenceForm>(() => (job ? formFromJob(job) : emptyCadenceForm()));
  const [values, setValues] = useState<RunValues>(() => preset(projectId));
  // The chat's state on opening — "what changed" is computed against it. When creating there is none.
  const [chatState, setChatState] = useState<Chat | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [active, setActive] = useState("");
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // If the chat could not be loaded there are no run values to show: "Advanced" would otherwise show the DEFAULTS (full access,
  // default) as the chat's values, and what was changed there would silently drop on save. Then only instructions and cadence are saved.
  const [chatError, setChatError] = useState<string | null>(null);
  const [saves, setSaves] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ active?: string; providers?: ProviderMeta[] }>("/api/providers")
      .then((d) => { if (!cancelled) { setProviders(d.providers || []); setActive(d.active || ""); } })
      .catch(() => { /* without the list "Default" stays — nothing wrong is saved */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!job?.chatId) return;
    let cancelled = false;
    api<Chat>(`/api/chats/${encodeURIComponent(job.chatId)}`)
      .then((c) => { if (!cancelled && c?.id) { setChatState(c); setValues(fromChat(c)); } })
      .catch((e) => { if (!cancelled) setChatError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [job?.chatId]);
  // The instances of the chosen project — only when creating and only for a converted project (like a new chat's instance choice,
  // components/chat/chatInstance.ts); without a read list there is no choice and the default stays main.
  const converted = Boolean(values.projectId && workspace.projects.find((p) => p.id === values.projectId)?.instance?.converted);
  useEffect(() => {
    setInstances([]);
    if (!fresh || !values.projectId || !converted) return;
    let cancelled = false;
    api<Project[]>("/api/projects")
      .then((l) => { if (!cancelled && Array.isArray(l)) setInstances(chatInstanceOptions(l.find((p) => p.id === values.projectId)?.instance ?? null)); })
      .catch(() => { /* without an answer no choice */ });
    return () => { cancelled = true; };
  }, [fresh, values.projectId, converted]);

  const result = useMemo(() => planFromForm(form), [form]);
  const set = <K extends keyof RunValues>(k: K, v: RunValues[K]) => setValues((w) => ({ ...w, [k]: v }));
  const patchForm = (part: Partial<CadenceForm>) => setForm((f) => ({ ...f, ...part }));

  const save = async () => {
    setError(null);
    if (!instructions.trim()) return setError(t("Instructions missing"));
    // When editing only what was touched is checked: an unchanged repetition with a past time does not block the rest.
    const check = fresh ? result : jobChange(job, instructions, form);
    if ("error" in check) return setError(t(check.error));
    setSaves(true);
    try {
      if ("cadence" in check) {
        const r = await setUpScheduledJob(workspace.id, {
          instructions, cadence: check.cadence, plan: check.plan, timeZone: ownTimeZone(), permissionMode: values.permissionMode,
          ...(values.name.trim() ? { name: values.name.trim() } : {}),
          ...(values.projectId ? { projectId: values.projectId } : {}),
          ...(values.projectId && values.instance !== MAIN ? { instance: values.instance } : {}),
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.effort ? { effort: values.effort } : {}),
          ...(values.notification ? {} : { notify: { schedule: "off" as const } }),
        });
        onSaved(r.job.id);
        return;
      }
      // Edit: first the job (instructions, cadence), then the chat — both only with what changed.
      if (!job) return;
      const { change } = check;
      if (Object.keys(change).length) await changeScheduledJob(job.workspaceId, job.id, change);
      if (chatState) {
        const old = fromChat(chatState);
        const body: Record<string, unknown> = {};
        if (values.name.trim() && values.name.trim() !== old.name) body.title = values.name.trim();
        if (values.projectId !== old.projectId) body.projectId = values.projectId || null;
        if (values.permissionMode !== old.permissionMode) body.permissionMode = values.permissionMode;
        if (values.provider !== old.provider || values.model !== old.model) { body.provider = values.provider; body.model = values.model; }
        // "Default" is no value on the chat: resolved to the chosen model's default effort level (otherwise the old one would stay).
        const level = levelToSave(values.effort, old.effort, effortDefaultLevel(values.provider, values.model, providers, active || "claude"));
        if (level) Object.assign(body, effortChoiceBody(level));
        if (values.notification !== old.notification) {
          // The server replaces the choice entirely — the other kinds go along; "on" here means "follows the default" (no entry).
          const rest: Record<string, "on" | "off"> = { ...(chatState.notify || {}) };
          delete rest.schedule;
          body.notify = values.notification ? rest : { ...rest, schedule: "off" };
        }
        if (Object.keys(body).length) await api(`/api/chats/${encodeURIComponent(chatState.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      onSaved(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaves(false); }
  };

  const erase = async () => {
    if (!job) return;
    if (!(await question(t("Delete this task? The chat stays with its whole history — it just gets no more runs."), { ok: t("Delete"), danger: true }))) return;
    try {
      await deleteScheduledJob(job.workspaceId, job.id);
      onDeleted();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const modes = PERM_MODES;
  // The run values appear only once they are the chat's (when creating: a new chat's defaults).
  const runValuesShown = fresh || chatState !== null;
  // A new job runs in the browser's time zone; an existing one in its own — if it differs it is shown under the time of day.
  const zone = fresh ? null : foreignZone(job.timeZone);
  const provider = values.provider || active;
  return (
    <Modal onClose={onClose} width={600} label={fresh ? t("New task") : t("Edit task")}>
      <div className="flex min-h-0 flex-col gap-4" data-scheduled-dialog={fresh ? "fresh" : job.id}>
        <ModalTitle hint={t("At every run the task's chat gets a short message and carries out these instructions. Nobody watches live; you answer questions later in the chat.")}>
          {fresh ? t("New task") : t("Edit task")}
        </ModalTitle>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={lab}>{t("Instructions")}</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={SCHEDULED_INSTRUCTIONS_MAX}
            rows={7}
            autoFocus
            placeholder={t("What should the agent do at every run?")}
            className={`${field} min-h-[140px] w-full resize-y leading-relaxed`}
            data-scheduled-instructions
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={lab}>{t("retry")}</span>
            <select value={form.cadence} onChange={(e) => patchForm({ cadence: e.target.value as CadenceValue })} className={select} data-scheduled-cadence>
              {CADENCE_CHOICE.map((r) => <option key={r.value} value={r.value}>{t(r.label)}</option>)}
            </select>
          </label>
          {form.cadence === "oneTime" ? (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={lab}>{t("Date and time")}</span>
              <input type="datetime-local" value={form.oneTime} onChange={(e) => patchForm({ oneTime: e.target.value })} className={field} data-scheduled-moment />
            </label>
          ) : (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={lab}>{t("Time")}</span>
              <input type="time" value={form.clockTime} onChange={(e) => patchForm({ clockTime: e.target.value })} className={field} data-scheduled-clock-time />
            </label>
          )}
          {form.cadence === "monthly" && (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={lab}>{t("Day of the month")}</span>
              <select value={form.day} onChange={(e) => patchForm({ day: Number(e.target.value) })} className={select} data-scheduled-day-of-month>
                {DAYS_OF_MONTH.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>
        {form.cadence === "weekly" && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Weekdays##days")} data-scheduled-days>
            {WEEKDAYS.map((d) => {
              const on = form.days.includes(d.value);
              return (
                <button key={d.value} type="button" aria-pressed={on}
                  onClick={() => patchForm({ days: on ? form.days.filter((x) => x !== d.value) : [...form.days, d.value] })}
                  className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${on ? "bg-accent text-white" : "bg-bg text-dim hover:bg-hover hover:text-fg"}`}>
                  {t(d.short)}
                </button>
              );
            })}
          </div>
        )}
        {form.cadence !== "oneTime" && zone && (
          <p className="-mt-2 text-[12px] text-dim" data-scheduled-zone={zone}>{t("The time applies in the task's time zone {zone}.", { zone })}</p>
        )}

        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          className="flex items-center gap-1.5 self-start text-[12.5px] text-dim transition-colors hover:text-fg" data-scheduled-expanded>
          <Chevron open={expanded} /> {t("Advanced")}
        </button>
        {!fresh && !runValuesShown && (chatError || !job.chatId) && (
          <Hint tone="warn">
            {job.chatId
              ? t("The chat's settings could not be loaded ({reason}) — only the instructions and the schedule will be saved.", { reason: chatError ?? "" })
              : t("The chat of this task is missing.")}
          </Hint>
        )}
        {expanded && !runValuesShown && !chatError && job?.chatId && <Loading />}
        {expanded && runValuesShown && (
          <div className="flex flex-col gap-3" data-scheduled-expanded-content>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={lab}>{t("Name")}</span>
              <input value={values.name} onChange={(e) => set("name", e.target.value)} maxLength={120}
                placeholder={t("Without a name: the first line of the instructions")} className={field} data-scheduled-name />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1">
                <span className={lab}>{t("Project")}</span>
                <select value={values.projectId} onChange={(e) => setValues((w) => ({ ...w, projectId: e.target.value, instance: MAIN }))} className={select} data-scheduled-project>
                  <option value="">{t("No project")}</option>
                  {workspace.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {fresh && instances.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1">
                  <span className={lab}>{t("Instance")}</span>
                  <select value={values.instance} onChange={(e) => set("instance", e.target.value)} className={select} data-scheduled-instance>
                    {instances.map((o) => <option key={o.name} value={o.name}>{instanceTitle(o.name, t)}</option>)}
                  </select>
                </label>
              )}
            </div>
            {!fresh && <p className="-mt-1 text-[12px] text-dim">{t("You switch the instance in the chat's header.")}</p>}
            <label className="flex min-w-0 flex-col gap-1">
              <span className={lab}>{t("Permission mode")}</span>
              <select value={values.permissionMode} onChange={(e) => set("permissionMode", e.target.value)} className={select} data-scheduled-mode>
                {modes.map((m) => <option key={m.id} value={m.id} title={t(provider === "codex" && m.codexHint ? m.codexHint : m.hint)}>{t(m.label)}</option>)}
              </select>
            </label>
            <ProviderModel provider={values.provider} model={values.model} providers={providers}
              onChange={(p, m) => setValues((w) => ({ ...w, provider: p, model: m, effort: "" }))} />
            <LevelChoice provider={values.provider} model={values.model} effort={values.effort} catalog={providers} global={active}
              onChange={(e) => set("effort", e)} />
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{t("Notification after every run")}</span>
                <span className="block text-[12px] text-dim">{t("Questions and approvals always notify.")}</span>
              </span>
              <Toggle on={values.notification} onClick={() => set("notification", !values.notification)} title={t("Notification after every run")} />
            </div>
          </div>
        )}

        {error && <Hint tone="danger">{error}</Hint>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!fresh && <button type="button" className={quietDanger} onClick={erase} data-scheduled-delete>{t("Delete task")}</button>}
          <span className="min-w-0 flex-1" />
          <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className={primary} disabled={saves || (!fresh && !runValuesShown && !!job?.chatId && !chatError)} onClick={save} data-scheduled-save>
            {saves ? t("Saving…") : fresh ? t("Create") : t("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
