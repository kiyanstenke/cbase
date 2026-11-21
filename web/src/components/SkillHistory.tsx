"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decideSkillRequest, loadDeletedSkills, loadSkillRequest, loadSkillSettings, loadSkillHistory, takeSkillChangeBack,
  setSkillSettings, skillWriteError, skillsEvent, subscribeGlobalEvents,
  type SkillRequest, type SkillMeta, type SkillWriteError, type SkillStatusImage, type SkillHistoryEntry, type SkillsEvent,
} from "@/lib/api";
import { FACTS, Fact, Hint, Tile, LIST_ROW, EmptyRow, SYM, Toggle, ghostSm, pillSm } from "@/components/CbKit";
import { fieldChanges, shortText, type SkillField } from "@/lib/skill-change";
import { sinceText } from "@/lib/agenda";
import { useT } from "@/lib/i18n";

// History, delete requests and switches of skills — the main agents of the coding chats write skills themselves. The
// building blocks here stand in two places:
//  · Coding → Skills (SkillsPane.tsx): per row "changed by agent · <chat> · <time>" and "Deletion requested"
//    (`SkillChangeFacts`), in the header of the workspace level the agents-write switch (`AgentsWriteToggle`), under the
//    list "Recently deleted" (`DeletedSkills`), in the edit dialog the "History" tab (`SkillHistorySection`) and the
//    request card (`SkillRequestCard`);
//  · in the chat on the tool block of `cbase_skill_write` (SkillToolCard.tsx): the same request card, plus Undo.
// Whether something can be undone is computed by the SERVER (`revertible`); a 409 shows its sentence and — on a
// conflict — both states. Every view reloads on the `skills` event of its workspace (or its request).

/** A consumer for the `skills` events. `workspaceId: null` = every event (the request card in the chat does not always
 *  know the workspace — it filters itself by request and skill id). */
export function useSkillsEvent(workspaceId: string | null, fn: (e: SkillsEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribeGlobalEvents((raw) => {
    const e = skillsEvent(raw);
    if (e && (workspaceId === null || e.workspaceId === workspaceId)) ref.current(e);
  }), [workspaceId]);
}

/** "3 min ago" — the same words as the agenda (lib/agenda.ts `sinceText`). */
export function useWhen() {
  const t = useT();
  return (at: number) => {
    const s = sinceText(at, Date.now());
    return s ? t(s.key, { n: s.n }) : "";
  };
}
const datum = (at: number) => (at ? new Date(at).toLocaleString() : "");

// ── List row ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The facts of a skill row: who changed it last (only an agent is named) and an open delete request. */
export function SkillChangeFacts({ s }: { s: SkillMeta }) {
  const t = useT();
  const when = useWhen();
  const l = s.lastChange;
  const a = s.openRequest;
  return (
    <>
      {l && l.who === "agent" && (
        <Fact symbol={SYM.agent(12)} title={datum(l.at)} data={{ "data-skill-changed-of": l.chatId ?? "" }}>
          <span className="min-w-0 truncate">
            {t("changed by agent")}{l.chatTitle ? ` · ${l.chatTitle}` : ""} · {when(l.at)}
          </span>
        </Fact>
      )}
      {a && (
        <Fact symbol={SYM.clock(12)} className="text-warn" title={a.chatTitle ? t("Requested in “{chat}” · {when}", { chat: a.chatTitle, when: datum(a.at) }) : datum(a.at)} data={{ "data-skill-request": a.id }}>
          <span className="shrink-0">{t("Deletion requested")}</span>
        </Fact>
      )}
    </>
  );
}

// ── Agents-write switch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Agents may change skills" — per workspace. A state the server does not report shows no switch. */
export function AgentsWriteToggle({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [on, setOn] = useState<boolean | null | undefined>(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    loadSkillSettings(workspaceId).then((e) => setOn(e.agentsWrite), (e) => { setOn(null); setError((e as Error).message); });
  }, [workspaceId]);
  useEffect(load, [load]);
  useSkillsEvent(workspaceId, (e) => { if (e.kind === "setting") load(); });

  async function toggle() {
    if (typeof on !== "boolean") return;
    setBusy(true);
    setError(null);
    try { setOn((await setSkillSettings(workspaceId, !on)).agentsWrite); }
    catch (e) { setError((e as Error).message); load(); }
    finally { setBusy(false); }
  }

  if (on === undefined) return null;
  return (
    <label className="flex shrink-0 items-center gap-2 text-[12px] text-dim" data-skills-agents-write={on === null ? "unknown" : on ? "on" : "off"}>
      <span title={error ?? t("On: the main agent of every coding chat in this workspace may create and change skills (immediately, with history) and request deletions. Off: the tool is not offered in any run.")}>
        {t("Agents may change skills")}
      </span>
      {on === null
        ? <span className="text-dim/70" title={error ?? undefined}>{t("state unknown")}</span>
        : <Toggle on={on} onClick={() => { toggle().catch(() => {}); }} disabled={busy} />}
    </label>
  );
}

// ── Error of an undo ──────────────────────────────────────────────────────────────────────────────────────────────

const fieldWord = (t: ReturnType<typeof useT>, f: SkillField) => (f === "name" ? t("Name") : f === "description" ? t("Description") : t("Instructions##guide"));

/** A 409 of the undo or the decision: the server's sentence, on a conflict both states, on references the definitions. */
export function SkillErrorDisplay({ f, onClose }: { f: SkillWriteError; onClose?: () => void }) {
  const t = useT();
  const state = (s: SkillStatusImage | null) =>
    !s ? "—" : [s.name, s.description !== null ? shortText(s.description, 80) : null, s.version ? `v ${s.version}` : null].filter(Boolean).join(" · ") || "—";
  return (
    <Hint tone="danger">
      <div className="flex flex-col gap-1" data-skill-error>
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words">{f.text}</span>
          {onClose && <button type="button" onClick={onClose} className="shrink-0 text-[11px] underline-offset-2 hover:underline">{t("Close")}</button>}
        </div>
        {f.conflict && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]" data-skill-conflict>
            <span className="opacity-80">{t("Expected")}</span><span className="min-w-0 break-words">{state(f.conflict.expected)}</span>
            <span className="opacity-80">{t("Now")}</span><span className="min-w-0 break-words">{state(f.conflict.current)}</span>
          </div>
        )}
        {f.references && f.references.length > 0 && (
          <div className="text-[11.5px]" data-skill-references>
            {t("Used by")}: {f.references.map((v) => v.name).join(", ")}
          </div>
        )}
        {f.existing && (
          <div className="text-[11.5px]" data-skill-existing>{t("Existing: {name}", { name: f.existing.name })}</div>
        )}
      </div>
    </Hint>
  );
}

// ── History of a skill ─────────────────────────────────────────────────────────────────────────────────────────────────

export function historyKindWord(t: ReturnType<typeof useT>, kind: SkillHistoryEntry["kind"]): string {
  return kind === "create" ? t("created") : kind === "change" ? t("modified") : t("deleted");
}

/** Who: "Human" or "Agent · <chat title>". */
function ActorText({ e }: { e: SkillHistoryEntry }) {
  const t = useT();
  if (e.who === "agent") return <span className="min-w-0 truncate">{t("Agent")}{e.chatTitle ? ` · ${e.chatTitle}` : ""}</span>;
  if (e.who === "human") return <span className="shrink-0">{t("Human")}</span>;
  return null;
}

/** An entry with undo: the button only if the server says `revertible`; a 409 stays on the entry. */
function HistoryRow({ e, onBack, button: buttonEl }: { e: SkillHistoryEntry; onBack: () => void; button: string }) {
  const t = useT();
  const when = useWhen();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SkillWriteError | null>(null);
  const [open, setOpen] = useState(false);
  const fields = fieldChanges(e.prior, e.after);

  async function back() {
    setBusy(true);
    setError(null);
    try { await takeSkillChangeBack(e.id); onBack(); }
    catch (err) { setError(skillWriteError(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 py-2.5" data-skill-history-entry={e.id} data-kind={e.kind} data-revertible={e.revertible ? "" : undefined}>
      <div className="flex min-w-0 items-center gap-2">
        <div className={`${FACTS} min-w-0 flex-1`}>
          <span className="shrink-0 font-medium text-fg/90">{historyKindWord(t, e.kind)}</span>
          <ActorText e={e} />
          <span className="shrink-0" title={datum(e.at)}>{when(e.at)}</span>
          {e.revertedAt !== null && <span className="shrink-0" title={datum(e.revertedAt)}>{t("undone")}</span>}
        </div>
        {fields.length > 0 && (
          <button type="button" onClick={() => setOpen((v) => !v)} className={`${pillSm} shrink-0 text-dim hover:text-fg`} aria-expanded={open}>
            {open ? t("Less") : t("Fields")}
          </button>
        )}
        {e.revertible && (
          <button type="button" onClick={() => { back().catch(() => {}); }} disabled={busy} className={`${ghostSm} shrink-0 disabled:opacity-50`} data-skill-revert={e.id}>
            {buttonEl}
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 pt-0.5">
          {fields.map((f) => (
            <div key={f.field} className="grid min-w-0 grid-cols-[88px_1fr] gap-x-3 text-[12px]" data-skill-field={f.field}>
              <span className="text-dim">{fieldWord(t, f.field)}</span>
              {f.field === "body" ? (
                <div className="flex min-w-0 flex-col gap-1">
                  {f.prior !== null && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg px-2 py-1 text-[11.5px] text-dim line-through decoration-dim/50">{f.prior}</pre>}
                  {f.after !== null && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg px-2 py-1 text-[11.5px] text-fg/85">{f.after}</pre>}
                </div>
              ) : (
                <span className="min-w-0 break-words">
                  {f.prior !== null && <span className="text-dim line-through decoration-dim/50">{f.prior || "—"}</span>}
                  {f.prior !== null && f.after !== null && <span className="text-dim"> → </span>}
                  {f.after !== null && <span className="text-fg/90">{f.after || "—"}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <SkillErrorDisplay f={error} onClose={() => setError(null)} />}
    </div>
  );
}

/** The "History" tab in the edit dialog: all entries of this skill, newest first — ONE surface, rows separated by hairlines. */
export function SkillHistorySection({ workspaceId, skillId, onBack }: { workspaceId: string; skillId: string; onBack: () => void }) {
  const t = useT();
  const [list, setList] = useState<SkillHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    loadSkillHistory(workspaceId, { skillId, limit: 50 }).then((l) => { setList(l); setError(null); }, (e) => setError((e as Error).message));
  }, [workspaceId, skillId]);
  useEffect(load, [load]);
  useSkillsEvent(workspaceId, (e) => { if (!e.skillId || e.skillId === skillId) load(); });

  if (error) return <Hint tone="danger">{error}</Hint>;
  if (list === null) return null;
  if (list.length === 0) return <EmptyRow>{t("No changes in the history yet.")}</EmptyRow>;
  return (
    <div className="flex min-w-0 flex-col divide-y divide-edge rounded-2xl bg-bg px-3" data-skill-history={skillId}>
      {list.map((e) => <HistoryRow key={e.id} e={e} button={t("Undo")} onBack={() => { load(); onBack(); }} />)}
    </div>
  );
}

// ── Recently deleted ────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Recently deleted" under a level's list: the workspace level shows workspace skills, the project level those of this
 *  project. "Restore" is the undo of the delete entry. Without entries the section is not shown at all. */
export function DeletedSkills({ workspaceId, projectId, onRestored }: { workspaceId: string; projectId: string | null; onRestored: () => void }) {
  const t = useT();
  const when = useWhen();
  const [list, setList] = useState<SkillHistoryEntry[] | null>(null);
  const [error, setError] = useState<{ id: string; f: SkillWriteError } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    loadDeletedSkills(workspaceId).then((l) => setList(l.filter((e) => (e.projectId ?? null) === projectId)), () => setList(null));
  }, [workspaceId, projectId]);
  useEffect(load, [load]);
  useSkillsEvent(workspaceId, load);

  async function restore(e: SkillHistoryEntry) {
    setBusy(e.id);
    setError(null);
    try { await takeSkillChangeBack(e.id); load(); onRestored(); }
    catch (err) { setError({ id: e.id, f: skillWriteError(err) }); }
    finally { setBusy(null); }
  }

  if (!list || list.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-1.5" data-skills-deleted>
      <h4 className="px-2.5 text-[12px] font-semibold uppercase tracking-wider text-dim">{t("Recently deleted")}</h4>
      <div className="flex shrink-0 flex-col gap-0.5">
        {list.map((e) => (
          <div key={e.id} className="flex min-w-0 flex-col gap-1">
            <div className={`${LIST_ROW} items-center hover:bg-hover`} data-skill-deleted={e.prior?.name ?? e.skillId}>
              <Tile color="text-dim">{SYM.skill(16)}</Tile>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] font-medium text-dim">{e.prior?.name ?? e.skillId}</div>
                <div className={`${FACTS} mt-0.5`}>
                  <span className="shrink-0" title={datum(e.at)}>{t("deleted")} {when(e.at)}</span>
                  <ActorText e={e} />
                  {e.trash && <span className="shrink-0">{t("with files")}</span>}
                </div>
              </div>
              {e.revertible && (
                <button type="button" onClick={() => { restore(e).catch(() => {}); }} disabled={busy === e.id} className={`${ghostSm} shrink-0 disabled:opacity-50`} data-skill-restore={e.id}>
                  {t("Restore")}
                </button>
              )}
            </div>
            {error?.id === e.id && <SkillErrorDisplay f={error.f} onClose={() => setError(null)} />}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Request card ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function requestStatusWord(t: ReturnType<typeof useT>, s: SkillRequest["status"]): string {
  return s === "open" ? t("open") : s === "approved" ? t("approved — deleted") : s === "rejected" ? t("rejected") : t("expired — the skill has changed since");
}

/**
 * A delete request with approve/deny — on the skill page (edit dialog) and in the chat on the tool block. Loaded fresh
 * via `GET /api/skill-requests/:id`; reloaded after the decision and on every event of this request (or its skill).
 * Deciding only while it is `open` AND `current` — a stale request says so instead of offering a button that ends in a 409.
 */
export function SkillRequestCard({ requestId, onDecided }: { requestId: string; onDecided?: (a: SkillRequest | null) => void }) {
  const t = useT();
  const when = useWhen();
  const [a, setA] = useState<SkillRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<SkillWriteError | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    loadSkillRequest(requestId).then((x) => { setA(x); setLoadError(null); }, (e) => setLoadError((e as Error).message));
  }, [requestId]);
  useEffect(load, [load]);
  useSkillsEvent(null, (e) => { if (e.requestId === requestId || (a && e.skillId === a.skillId)) load(); });

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const fresh = await decideSkillRequest(requestId, approve);
      if (fresh) setA(fresh); else load();
      onDecided?.(fresh);
    } catch (err) { setError(skillWriteError(err)); load(); }
    finally { setBusy(false); }
  }

  if (loadError && !a) return <Hint tone="danger">{t("Request not readable")}: {loadError}</Hint>;
  if (!a) return null;
  const decidable = a.status === "open" && a.current;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-skill-request-card={a.id} data-status={a.status}>
      <Hint tone={a.status === "open" ? "warn" : a.status === "approved" ? "ok" : "danger"}>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 font-medium">
              {t("Deletion of “{name}” requested", { name: a.skillName || a.skillId })}
            </span>
            {decidable && (
              <span className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => { decide(false).catch(() => {}); }} disabled={busy} className={`${ghostSm} disabled:opacity-50`} data-skill-request-reject>
                  {t("Deny")}
                </button>
                <button type="button" onClick={() => { decide(true).catch(() => {}); }} disabled={busy} className={`${pillSm} bg-danger text-white hover:opacity-90 disabled:opacity-50`} data-skill-request-approve>
                  {t("Approve")}
                </button>
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap gap-x-2 text-[11.5px] opacity-85">
            <span>{t("Agent")}{a.chatTitle ? ` · ${a.chatTitle}` : ""}</span>
            {a.at > 0 && <span title={datum(a.at)}>{when(a.at)}</span>}
            {a.status !== "open" && <span data-skill-request-status>{requestStatusWord(t, a.status)}</span>}
            {a.status === "open" && !a.current && <span data-skill-request-stale>{t("outdated — the skill has changed since")}</span>}
          </div>
          {a.reason && <div className="whitespace-pre-wrap break-words text-[12px]">{a.reason}</div>}
        </div>
      </Hint>
      {error && <SkillErrorDisplay f={error} onClose={() => setError(null)} />}
    </div>
  );
}
