"use client";

// Settings → "Administration": users and resources per user container. Only for admins in gateway mode (SettingsModal filters the
// page, the gateway checks every route itself). Replaces the separate page `/gw/admin` — it redirects here
// (`?settings=administration`).
//
// On top the server: how much RAM the limits allocate together, against the host and its reserve. Overbooking is allowed (limits
// are ceilings, not reservations), it is only said. Below ONE surface with all users; a click unfolds the row in place
// (`data-open`): RAM, CPU priority and CPU upper limit as a draft with Save, plus the actions on the account and the container.
// What the gateway rejects (RAM below the consumption, demoting the last admin, locking oneself) is shown with its sentence at the
// row — the page computes none of it, at most it warns beforehand.
//
// It reloads every 15 s while the page is open and the window visible (the consumption), and after every action. A draft survives
// the reload: it belongs to the person, not to the last answer. It arises ONLY from an input, and Save or Discard delete it —
// otherwise an unchanged draft would hide newer saved values, and Save would write foreign changes back (the calculation lives in
// lib/administration-procedure.ts). If the answer to an action fails to arrive (524 behind the tunnel), "still running" stays at
// the row, the work mark stays, and the page reloads until the state shows it — otherwise a second press on "Restart" would start a
// second time.
//
// The sheets (create, password, delete) sit by portal on the body at z-70 — the settings modal stands at z-60, a kit modal with its
// default z-50 would lie behind it. `useConfirm` does not work here for the same reason (its sheet stands at z-60 in the tree and
// thus under the modal's portal).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Chevron, Hint, Loading, Modal, ModalTitle, Toggle, Segments, field, ghost, ghostSm, primary, quietDangerSm,
} from "@/components/CbKit";
import { ProgressBar, Group, Row } from "@/components/settings/SettingsKit";
import { useT, dateLocale } from "@/lib/i18n";
import {
  RELOAD_MS, arrived, displayedStatus, draftAfterInput, draftGone, sameValues, runningStill, gracePeriodMs,
} from "@/lib/administration-procedure";
import {
  CPU_PRIO, CPU_PRIO_WEIGHT, RAM_MIN_GIB, RAM_BUFFER_BYTES, ROLES,
  containerAction, loadAdministration, setUpUser, deleteUser, setLocked, setPassword as setUserPassword, setResources, setRole as setUserRole,
  type ContainerAction, type ContainerState, type CpuPrio, type Resources, type ResourcesActual, type Role, type Administration,
  type AdministrationUser,
} from "@/lib/api";

const GIB = 1024 ** 3;
/** How often the consumption is reloaded while the page is open. */
const TICK_MS = 15_000;

// Data values, translated at the render site (t()).
const PRIORITY_WORD: Record<CpuPrio, string> = { low: "low", normal: "normal", up: "high" };
const ROLE_WORD: Record<Role, string> = { user: "User", admin: "Admin##role" };
const STATE_WORD: Record<ContainerState, string> = { running: "running", stopped: "stopped", missing: "no container" };
const STATE_POINT: Record<ContainerState, string> = { running: "bg-ok", stopped: "bg-dim/50", missing: "bg-dim/25" };

const countText = (n: number, places = 1) => n.toLocaleString(dateLocale(), { maximumFractionDigits: places });
const gibText = (bytes: number) => `${countText(bytes / GIB)} GiB`;

/** The step a cgroup weight carries — `null` if it matches no step (then the number is shown). */
function stageOfWeight(weight: number | null): CpuPrio | null {
  if (weight === null) return null;
  return CPU_PRIO.find((p) => CPU_PRIO_WEIGHT[p] === weight) ?? null;
}

/** An action on a row; the identifier is the `data-administration-action` on the button. */
type Work = "save" | "role" | "lock" | "erase" | ContainerAction;

export function AdministrationSettings() {
  const t = useT();
  const [status, setStatus] = useState<Administration | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Resources>>({});
  const [work, setWork] = useState<Record<string, Work | undefined>>({});
  const [error, setError] = useState<Record<string, string | undefined>>({});
  // Rows whose action stayed without an answer and which are reloaded until the state shows it.
  const [stillOpen, setStillOpen] = useState<Record<string, true | undefined>>({});
  // Whether the page still stands — set on mount, not only cleared on unmount: StrictMode unmounts and remounts once in development,
  // and a ref that only falls would stay `false` forever after (the reload would stop at once, the mark would stay).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [create, setCreate] = useState(false);
  const [passwordFor, setPasswordFor] = useState<AdministrationUser | null>(null);
  const [deleteFor, setDeleteFor] = useState<AdministrationUser | null>(null);

  // Only the LATEST answer counts: a reload from the tick that started before an action would arrive after it and show the
  // state before. Returns: the state if THIS answer was the latest (otherwise `null`) — the reload after an action without an answer reads it.
  const followUp = useRef(0);
  const load = useCallback(async (): Promise<Administration | null> => {
    const seq = ++followUp.current;
    try {
      const fresh = await loadAdministration();
      if (seq !== followUp.current) return null;
      setStatus(fresh);
      setLoadError("");
      return fresh;
    } catch (e) {
      if (seq !== followUp.current) return null;
      setLoadError(String((e as Error).message || e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = window.setInterval(() => { if (!document.hidden) void load(); }, TICK_MS);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(tick); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  const replace = (n: AdministrationUser) =>
    setStatus((s) => (s ? { ...s, user: s.user.map((x) => (x.id === n.id ? n : x)) } : s));

  /** An action on ONE row: error and work mark belong to it; afterwards it reloads (sum, overbooking, consumption).
   *  `target`: the limits sent (Save only) — the reload sees by them whether they arrived. */
  async function manualAction(id: string, what: Work, action: () => Promise<AdministrationUser | void>, target: Resources | null = null) {
    const prior = status?.user.find((x) => x.id === id) ?? null;
    setWork((a) => ({ ...a, [id]: what }));
    setError((f) => ({ ...f, [id]: undefined }));
    let further = false;
    try {
      const n = await action();
      if (n) replace(n);
    } catch (e) {
      // The tunnel gave up, the gateway keeps working: no "failed", the mark stays until the state shows it.
      if (runningStill(e)) { further = true; void bringAlong(id, what, prior, target); }
      else setError((f) => ({ ...f, [id]: String((e as Error).message || e) }));
    } finally {
      if (!further) setWork((a) => ({ ...a, [id]: undefined }));
      void load();
    }
  }

  /** After an action without an answer: reload every RELOAD_MS until the state shows it — at most `gracePeriodMs(what)` long. */
  async function bringAlong(id: string, what: Work, prior: AdministrationUser | null, target: Resources | null) {
    setStillOpen((o) => ({ ...o, [id]: true }));
    const end = Date.now() + gracePeriodMs(what);
    let present = false;
    while (!present && alive.current && Date.now() < end) {
      await new Promise((r) => window.setTimeout(r, RELOAD_MS));
      const fresh = await load();
      if (fresh) present = arrived(what, prior, fresh.user.find((x) => x.id === id) ?? null, target);
    }
    if (!alive.current) return;
    setStillOpen((o) => ({ ...o, [id]: undefined }));
    setWork((a) => ({ ...a, [id]: undefined }));
    if (!present) setError((f) => ({ ...f, [id]: t("No answer from the gateway — the user's state shows whether the action went through.") }));
    else if (what === "save" && target) setDrafts((e) => draftGone(e, id, target));
    else if (what === "erase") setOpen((o) => (o === id ? null : o));
  }

  function toggle(n: AdministrationUser) {
    // Only fold and unfold: a draft arises only from an input.
    setOpen(open === n.id ? null : n.id);
  }

  async function save(n: AdministrationUser, draft: Resources) {
    await manualAction(n.id, "save", async () => {
      const fresh = await setResources(n.id, draft);
      // Saved: the draft falls — from now on the saved state is shown. An input WHILE saving is a new draft and stays (`onlyIf`).
      setDrafts((e) => draftGone(e, n.id, draft));
      return fresh;
    }, draft);
  }

  const server = status?.server ?? null;
  const ramTotalGiB = server?.ramTotalBytes ? Math.floor(server.ramTotalBytes / GIB) : null;

  return (
    <div>
      {loadError && (
        <div className="mb-4"><Hint tone="danger">{t("Admin page not loaded: {msg}", { msg: loadError })}</Hint></div>
      )}
      {!status && !loadError && <Loading />}

      {server && (
        <Group title={t("Server")}>
          <ServerRow server={server} />
          <Row title={t("Threads")}>
            <span className="font-mono text-[12.5px] font-medium tabular-nums">{server.threads ?? "–"}</span>
          </Row>
          {server.overcommitted && (
            <div className="px-3.5 py-2.5">
              <Hint tone="warn">
                {t("Overcommitted: the RAM limits together exceed what the host has after its reserve. That is allowed — limits are caps, not reservations.")}
              </Hint>
            </div>
          )}
        </Group>
      )}

      {status && (
        <Group title={t("Users")}>
          <Row
            title={t("{n} users", { n: status.user.length })}
            hint={t("Every change applies to the container right away and also holds when the gateway recreates it.")}
          >
            <button type="button" onClick={() => setCreate(true)} className={primary} data-administration-create>
              {t("Create user")}
            </button>
          </Row>
          {status.user.map((n) => {
            const isOpen = open === n.id;
            const draft = displayedStatus(drafts, n.id, n.resources);
            return (
              <div key={n.id} data-administration-row={n.id}>
                <button
                  type="button"
                  onClick={() => toggle(n)}
                  data-open={isOpen ? "1" : undefined}
                  aria-expanded={isOpen}
                  className="cb-row flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors"
                >
                  <UserHeader n={n} />
                  <Chevron open={isOpen} />
                </button>
                {error[n.id] && (
                  <div className="px-3.5 pb-2.5" data-administration-error={n.id}>
                    <Hint tone="danger">{error[n.id]}</Hint>
                  </div>
                )}
                {stillOpen[n.id] && (
                  <div className="px-3.5 pb-2.5" data-administration-running-still={n.id}>
                    <Hint tone="warn">
                      {t("Still running — the gateway did not answer in time and keeps working. The page reloads until the state shows it.")}
                    </Hint>
                  </div>
                )}
                {isOpen && (
                  <div className="space-y-3 border-t border-edge/60 px-3.5 py-3">
                    <UserStatus n={n} />
                    {draft ? (
                      <ResourcesEditor
                        n={n}
                        draft={draft}
                        threads={server?.threads ?? null}
                        ramMaxGiB={ramTotalGiB}
                        work={work[n.id]}
                        onChange={(r) => setDrafts((e) => draftAfterInput(e, n.id, r, n.resources))}
                        onSave={() => save(n, draft)}
                        onDismiss={() => setDrafts((e) => draftGone(e, n.id))}
                      />
                    ) : (
                      <p className="text-[12px] text-dim">{t("The gateway reported no stored limits for this user.")}</p>
                    )}
                    <ManualActions
                      n={n}
                      work={work[n.id]}
                      onRole={(role) => manualAction(n.id, "role", () => setUserRole(n.id, role))}
                      onLock={(locked) => manualAction(n.id, "lock", () => setLocked(n.id, locked))}
                      onContainer={(action) => manualAction(n.id, action, () => containerAction(n.id, action))}
                      onPassword={() => setPasswordFor(n)}
                      onDelete={() => setDeleteFor(n)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </Group>
      )}

      {create && <CreateSheet onClose={() => setCreate(false)} onFinished={() => { setCreate(false); void load(); }} />}
      {passwordFor && <PasswordSheet n={passwordFor} onClose={() => setPasswordFor(null)} />}
      {deleteFor && (
        <DeleteSheet
          n={deleteFor}
          onClose={() => setDeleteFor(null)}
          onFinished={() => {
            const id = deleteFor.id;
            setDeleteFor(null);
            setOpen((o) => (o === id ? null : o));
            void load();
          }}
          onRunningStill={() => {
            // Without an answer: the sheet closes, the row carries the "erase" mark until the user drops out of the list.
            const n = deleteFor;
            setDeleteFor(null);
            setWork((a) => ({ ...a, [n.id]: "erase" }));
            setError((f) => ({ ...f, [n.id]: undefined }));
            void bringAlong(n.id, "erase", n, null);
          }}
        />
      )}
    </div>
  );
}

/** RAM allocated against the host, with the mark from which the host's reserve would be touched. */
function ServerRow({ server }: { server: Administration["server"] }) {
  const t = useT();
  const { ramTotalBytes: total, ramAllocatedBytes: allocated, reserveBytes: reserve } = server;
  const percent = total && allocated !== null ? (allocated / total) * 100 : 0;
  const marker = total && reserve !== null ? Math.max(0, Math.min(100, ((total - reserve) / total) * 100)) : null;
  return (
    <Row
      title={t("RAM allocated")}
      hint={reserve !== null ? t("The mark shows where the host's reserve ({r}) begins.", { r: gibText(reserve) }) : undefined}
      wide
    >
      <div className="flex items-center gap-3">
        <span className="relative min-w-0 flex-1" data-administration-ram-allocated>
          {/* Colored deliberately: here the reserve mark counts, not the 70/90 thresholds of the usage ring. */}
          <ProgressBar percent={percent} tone={server.overcommitted ? "warn" : "accent"} />
          {marker !== null && (
            <span aria-hidden className="absolute -top-1 h-4 w-0.5 rounded-full bg-fg/70" style={{ left: `calc(${marker}% - 1px)` }} />
          )}
        </span>
        <span className="shrink-0 font-mono text-[12.5px] font-medium tabular-nums">
          {allocated !== null && total !== null ? t("{v} of {g}", { v: gibText(allocated), g: gibText(total) }) : "–"}
        </span>
      </div>
    </Row>
  );
}

function shortForm(t: ReturnType<typeof useT>, r: Resources): string {
  const max = r.cpuMax === null ? t("no CPU limit") : t("at most {n} threads", { n: r.cpuMax });
  return `${countText(r.ramGiB, 0)} GiB · ${t("priority {p}", { p: t(PRIORITY_WORD[r.cpuPrio]) })} · ${max}`;
}

/** The folded row: state, name, role, marks; below it the short form of the limits; at the right the consumption. */
function UserHeader({ n }: { n: AdministrationUser }) {
  const t = useT();
  const z = n.container.state;
  const ram = n.consumption?.ramBytes ?? null;
  const limit = n.resources ? n.resources.ramGiB * GIB : null;
  return (
    <>
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${z ? STATE_POINT[z] : "bg-dim/25"}`} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
          <span className="truncate font-medium">{n.username}</span>
          {n.itself && <span className="shrink-0 text-[11px] text-dim">{t("you")}</span>}
          <span className="shrink-0 text-[11px] text-dim">{n.role ? t(ROLE_WORD[n.role]) : t("role unknown")}</span>
          {n.locked && <span className="shrink-0 text-[11px] font-medium text-danger">{t("locked")}</span>}
          {n.deviating && (
            <span className="shrink-0 text-[11px] font-medium text-warn" title={t("The container carries different limits than stored.")}>
              {t("differs")}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-dim">
          {z ? t(STATE_WORD[z]) : t("state unknown")}
          {n.resources ? ` · ${shortForm(t, n.resources)}` : ""}
        </span>
      </span>
      {/* The consumption at the right only from a width at which name and short form beside it stay legible. */}
      <span className="hidden w-[150px] shrink-0 @xl/kit:block">
        {ram !== null && limit ? (
          <>
            <ProgressBar percent={(ram / limit) * 100} />
            <span className="mt-1 block text-right font-mono text-[11px] tabular-nums text-dim">
              {gibText(ram)}
              {n.consumption?.cpuThreads != null ? ` · ${t("{n} threads", { n: countText(n.consumption.cpuThreads) })}` : ""}
            </span>
          </>
        ) : null}
      </span>
    </>
  );
}

/** What the container is doing and carrying right now — read-only, above the draft. */
function UserStatus({ n }: { n: AdministrationUser }) {
  const t = useT();
  const v = n.consumption;
  const limit = n.resources ? n.resources.ramGiB * GIB : null;
  const since = n.container.since ? new Date(n.container.since) : null;
  return (
    <div className="space-y-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-dim">
        <span>{n.container.state ? t(STATE_WORD[n.container.state]) : t("state unknown")}</span>
        {since && !Number.isNaN(since.getTime()) && (
          <span>{t("since {time}", { time: since.toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</span>
        )}
        {n.createdAt !== null && (
          <span>{t("created {date}", { date: new Date(n.createdAt).toLocaleDateString(dateLocale()) })}</span>
        )}
      </div>
      {v && (
        <div className="flex items-center gap-3">
          <span className="w-[92px] shrink-0 text-dim">{t("Usage")}</span>
          <span className="min-w-0 flex-1">
            {v.ramBytes !== null && limit ? <ProgressBar percent={(v.ramBytes / limit) * 100} /> : null}
          </span>
          <span className="shrink-0 font-mono text-[12px] tabular-nums">
            {v.ramBytes !== null ? gibText(v.ramBytes) : "–"}
            {limit ? ` / ${gibText(limit)}` : ""}
            {" · "}
            {v.cpuThreads !== null ? t("{n} threads", { n: countText(v.cpuThreads) }) : "–"}
          </span>
        </div>
      )}
      {n.deviating && n.actual && (
        <div data-administration-deviating>
          <Hint tone="warn">{t("The container currently carries: {actual}", { actual: isText(t, n.actual) })}</Hint>
        </div>
      )}
    </div>
  );
}

function isText(t: ReturnType<typeof useT>, actual: ResourcesActual): string {
  const ram = actual.ramBytes !== null ? gibText(actual.ramBytes) : t("RAM without limit");
  const stage = stageOfWeight(actual.cpuWeight);
  const prio = stage ? t("priority {p}", { p: t(PRIORITY_WORD[stage]) }) : actual.cpuWeight !== null ? t("Weight {n}", { n: actual.cpuWeight }) : "–";
  const max = actual.cpuMax === null ? t("no CPU limit") : t("at most {n} threads", { n: countText(actual.cpuMax, 2) });
  return `${ram} · ${prio} · ${max}`;
}

/** A row in the unfolded area: label on the left, control on the right — narrow, one under the other. */
function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-1.5 @md/kit:grid-cols-[150px_minmax(0,1fr)] @md/kit:gap-3">
      <span className="text-[12.5px] text-dim">{title}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ResourcesEditor({ n, draft, threads, ramMaxGiB, work, onChange, onSave, onDismiss }: {
  n: AdministrationUser;
  draft: Resources;
  threads: number | null;
  ramMaxGiB: number | null;
  work: Work | undefined;
  onChange: (r: Resources) => void;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const max = ramMaxGiB !== null ? Math.max(RAM_MIN_GIB, ramMaxGiB) : null;
  const changed = !sameValues(draft, n.resources);
  // Warned beforehand, not locked: the consumption is up to 15 s old, and the gateway decides (409 with its number).
  const consumption = n.consumption?.ramBytes ?? null;
  const toTight = consumption !== null && draft.ramGiB * GIB < consumption + RAM_BUFFER_BYTES;
  // "none" and 1 … the host's threads; a saved value beyond that (host shrunk) stays visibly selectable.
  const upperLimits = Math.max(threads ?? 0, draft.cpuMax ?? 0);
  const maxItems = [
    { key: "no", label: t("none") },
    ...Array.from({ length: upperLimits }, (_, i) => ({ key: String(i + 1), label: String(i + 1) })),
  ];
  return (
    <div className="space-y-2.5" data-administration-editor={n.id}>
      <Field title={t("RAM")}>
        <button
          type="button"
          className={ghostSm}
          disabled={draft.ramGiB <= RAM_MIN_GIB}
          onClick={() => onChange({ ...draft, ramGiB: Math.max(RAM_MIN_GIB, draft.ramGiB - 1) })}
          aria-label={t("One GiB less")}
        >
          −
        </button>
        <span className="min-w-[64px] text-center font-mono text-[13px] font-medium tabular-nums" data-administration-ram>{draft.ramGiB} GiB</span>
        <button
          type="button"
          className={ghostSm}
          disabled={max !== null && draft.ramGiB >= max}
          onClick={() => onChange({ ...draft, ramGiB: max !== null ? Math.min(max, draft.ramGiB + 1) : draft.ramGiB + 1 })}
          aria-label={t("One GiB more")}
        >
          +
        </button>
        {toTight && consumption !== null && (
          <span className="text-[12px] text-warn">
            {t("Less than the usage ({v}) plus {clearance} headroom — the gateway rejects that.", { v: gibText(consumption), clearance: `${RAM_BUFFER_BYTES / 1024 ** 2} MiB` })}
          </span>
        )}
      </Field>
      <Field title={t("CPU priority")}>
        <Segments
          label={t("CPU priority")}
          items={CPU_PRIO.map((p) => ({ key: p, label: t(PRIORITY_WORD[p]) }))}
          value={draft.cpuPrio}
          onChange={(k) => onChange({ ...draft, cpuPrio: k as CpuPrio })}
        />
      </Field>
      <Field title={t("CPU limit")}>
        <Segments
          label={t("CPU limit")}
          items={maxItems}
          value={draft.cpuMax === null ? "no" : String(draft.cpuMax)}
          onChange={(k) => onChange({ ...draft, cpuMax: k === "no" ? null : Number(k) })}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        {changed && (
          <button type="button" className={ghost} onClick={onDismiss} disabled={!!work}>{t("Discard changes##draft")}</button>
        )}
        <button
          type="button"
          className={`${primary} disabled:opacity-40`}
          onClick={onSave}
          disabled={!changed || !!work}
          data-administration-action="save"
        >
          {work === "save" ? t("Saving…") : t("Save")}
        </button>
      </div>
    </div>
  );
}

function ManualActions({ n, work, onRole, onLock, onContainer, onPassword, onDelete }: {
  n: AdministrationUser;
  work: Work | undefined;
  onRole: (r: Role) => void;
  onLock: (locked: boolean) => void;
  onContainer: (a: ContainerAction) => void;
  onPassword: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const busy = !!work;
  const running = n.container.state === "running";
  const buttonEl = (action: ContainerAction, word: string) => (
    <button
      type="button"
      className={`${ghostSm} disabled:opacity-40`}
      disabled={busy}
      onClick={() => onContainer(action)}
      data-administration-action={action}
    >
      {work === action ? "…" : t(word)}
    </button>
  );
  return (
    <div className="space-y-2.5 border-t border-edge/60 pt-3">
      <Field title={t("Role")}>
        <Segments
          label={t("Role")}
          items={ROLES.map((r) => ({ key: r, label: t(ROLE_WORD[r]) }))}
          value={n.role ?? ""}
          onChange={(k) => { if (!busy && k !== n.role) onRole(k as Role); }}
        />
      </Field>
      <Field title={t("Account")}>
        <button type="button" className={`${ghostSm} disabled:opacity-40`} onClick={onPassword} disabled={busy}>
          {t("Set password")}
        </button>
        <button
          type="button"
          className={`${n.locked ? ghostSm : quietDangerSm} disabled:opacity-40`}
          onClick={() => onLock(!n.locked)}
          disabled={busy || (n.itself && !n.locked)}
          title={n.itself && !n.locked ? t("Your own account cannot be locked.") : undefined}
          data-administration-action="lock"
        >
          {work === "lock" ? "…" : n.locked ? t("Unlock") : t("Lock")}
        </button>
      </Field>
      <Field title={t("User container")}>
        {running ? <>{buttonEl("restart", "Restart")}{buttonEl("stop", "Stop")}</> : buttonEl("start", "Start")}
      </Field>
      <Field title={t("Delete")}>
        <button
          type="button"
          className={`${quietDangerSm} disabled:opacity-40`}
          onClick={onDelete}
          disabled={busy || n.itself}
          title={n.itself ? t("Your own account cannot be deleted.") : undefined}
          data-administration-action="erase"
        >
          {t("Delete user…")}
        </button>
      </Field>
    </div>
  );
}

function CreateSheet({ onClose, onFinished }: { onClose: () => void; onFinished: () => void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (running || !username.trim() || !password) return;
    setRunning(true); setError("");
    try { await setUpUser({ username: username.trim(), password, role }); onFinished(); }
    catch (err) { setError(String((err as Error).message || err)); setRunning(false); }
  }
  return (
    <Modal onClose={onClose} width={440} label={t("Create user")} z="z-[70]">
      <form onSubmit={run} className="space-y-3">
        <ModalTitle hint={t("The new user gets the template limits; you can change them afterwards in their row.")}>
          {t("Create user")}
        </ModalTitle>
        <label className="block text-[12.5px] text-dim">
          {t("Username")}
          <input className={`${field} mt-1 w-full`} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="off" />
        </label>
        <label className="block text-[12.5px] text-dim">
          {t("Password")}
          <input className={`${field} mt-1 w-full`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <div className="flex items-center justify-between gap-3 text-[12.5px] text-dim">
          {t("Role")}
          <Segments label={t("Role")} items={ROLES.map((r) => ({ key: r, label: t(ROLE_WORD[r]) }))} value={role} onChange={(k) => setRole(k as Role)} />
        </div>
        {error && <Hint tone="danger">{error}</Hint>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className={`${primary} disabled:opacity-40`} disabled={running || !username.trim() || !password}>
            {running ? t("Creating…") : t("Create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordSheet({ n, onClose }: { n: AdministrationUser; onClose: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (running || !password) return;
    setRunning(true); setError("");
    try { await setUserPassword(n.id, password); onClose(); }
    catch (err) { setError(String((err as Error).message || err)); setRunning(false); }
  }
  return (
    <Modal onClose={onClose} width={420} label={t("Set password")} z="z-[70]">
      <form onSubmit={run} className="space-y-3">
        <ModalTitle>{t("Set password for “{name}”", { name: n.username })}</ModalTitle>
        <input
          className={`${field} w-full`}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="new-password"
          aria-label={t("New password")}
          placeholder={t("New password")}
        />
        {error && <Hint tone="danger">{error}</Hint>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className={`${primary} disabled:opacity-40`} disabled={running || !password}>
            {running ? t("Saving…") : t("Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteSheet({ n, onClose, onFinished, onRunningStill }: {
  n: AdministrationUser;
  onClose: () => void;
  onFinished: () => void;
  /** The answer failed to arrive (524), the gateway keeps tearing down — the row takes over. */
  onRunningStill: () => void;
}) {
  const t = useT();
  const [withData, setWithData] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    if (running) return;
    setRunning(true); setError("");
    try { await deleteUser(n.id, withData); onFinished(); }
    catch (err) {
      if (runningStill(err)) { onRunningStill(); return; }
      setError(String((err as Error).message || err)); setRunning(false);
    }
  }
  return (
    <Modal onClose={onClose} width={460} label={t("Delete user")} z="z-[70]">
      <ModalTitle hint={t("The container is removed, and “{name}” can no longer sign in.", { name: n.username })}>
        {t("Delete “{name}”?", { name: n.username })}
      </ModalTitle>
      <div className="flex items-start justify-between gap-3 rounded-xl bg-bg px-3.5 py-2.5">
        <span className="min-w-0">
          <span className="block text-[13px]">{t("Delete data too")}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-dim">
            {t("Workspaces, chats and provider logins (the volumes) — cannot be undone. Without it they stay on the server.")}
          </span>
        </span>
        <Toggle on={withData} onClick={() => setWithData((x) => !x)} title={t("Delete data too")} />
      </div>
      {error && <div className="mt-3"><Hint tone="danger">{error}</Hint></div>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={ghost} onClick={onClose}>{t("Cancel")}</button>
        <button
          type="button"
          className="rounded-full bg-danger px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={run}
          disabled={running}
          data-administration-action="delete-confirm"
        >
          {running ? t("Deleting…") : withData ? t("Delete with data") : t("Delete")}
        </button>
      </div>
    </Modal>
  );
}
