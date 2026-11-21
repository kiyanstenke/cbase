"use client";

import { useCallback, useEffect, useState } from "react";
import {
  outerLoopInventory, outerLoopChat, outerLoopChatActive, outerLoopChatNotes, deleteOuterLoop, subscribeGlobalEvents,
  type OuterLoopInventory, type OuterLoopChatAgent, type OuterLoopChatState, type OuterLoopNote,
} from "@/lib/api";
import { ghost, ghostSm, Hint, Loading, Menu, MenuEntry, Modal, ModalTitle, Toggle, select } from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";
import { dateLocale, useT } from "@/lib/i18n";
import { OuterLoopEditor } from "@/components/outerloop/OuterLoopEditor";
import { fixedName, originName, runError, sourceText, ineffectiveText, stateName } from "@/components/outerloop/outerLoopText";

// The outer loop "chat info": a sheet from the ⋯ menu of the Coding chat header (chat/ChatStage.tsx). The web has no other chat info; a
// sheet of its own instead of a section in a foreign view.
//
//  · Agents: per available agent a switch for THIS chat (row on/off, three-valued with "no row") and the reason of the state (`source`).
//    Locked where the server says it cannot be switched (ineffective, archived, …). The fixed ones carry their role as an accent mark
//    ("Summarizer", "Agenda keeper").
//  · Create and edit chat-own agents — only the human creates them, via the same editor.
//  · Notes: read-only, newest first, an unlimited history ("more" pages via `before`).
// No stop button: a run ends by itself; it is aborted by deleting.

const time = (ms: number) => new Date(ms).toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function Marker({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "accent" | "warn" }) {
  const color = { dim: "bg-edge text-dim", accent: "bg-accent/12 text-accent", warn: "bg-warn/15 text-warn" }[tone];
  return <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold ${color}`}>{children}</span>;
}

export function OuterLoopChatSheet({ chatId, workspaceId, onClose }: { chatId: string; workspaceId: string; onClose: () => void }) {
  const t = useT();
  const question = useConfirm();
  const [status, setStatus] = useState<OuterLoopChatState | null>(null);
  const [notes, setNotes] = useState<OuterLoopNote[] | null>(null);
  const [additional, setAdditional] = useState(false);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState("");
  const [toggles, setToggles] = useState<string | null>(null);
  // The catalog for the editor comes only when it is needed (most people open the sheet to read).
  const [inventory, setInventory] = useState<OuterLoopInventory | null>(null);
  const [editor, setEditor] = useState<{ agentId: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await outerLoopChat(chatId);
      setStatus(s);
      setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, [chatId]);
  const loadNotes = useCallback(async (agentId: string) => {
    try {
      const n = await outerLoopChatNotes(chatId, { agentId: agentId || null, limit: 20 });
      setNotes(n.items); setAdditional(n.additional);
    } catch (e) { setErr((e as Error).message); }
  }, [chatId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadNotes(filter); }, [loadNotes, filter]);
  // A run on this chat changes state ⇒ reload state and notes (the note is created at the end of the run).
  useEffect(() => subscribeGlobalEvents((evt) => {
    if (evt.type === "outer_loop" && String(evt.chatId ?? "") === chatId) { void load(); void loadNotes(filter); }
  }), [chatId, filter, load, loadNotes]);

  async function more() {
    if (!notes?.length) return;
    try {
      const n = await outerLoopChatNotes(chatId, { agentId: filter || null, limit: 20, before: notes[notes.length - 1].id });
      setNotes([...notes, ...n.items.filter((x) => !notes.some((y) => y.id === x.id))]);
      setAdditional(n.additional);
    } catch (e) { setErr((e as Error).message); }
  }

  async function toggle(a: OuterLoopChatAgent) {
    setToggles(a.id); setErr("");
    try { await outerLoopChatActive(chatId, a.id, !a.active); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setToggles(null); }
  }

  async function openEditor(agentId: string | null) {
    setErr("");
    try {
      const b = inventory ?? await outerLoopInventory(workspaceId);
      setInventory(b);
      setEditor({ agentId });
    } catch (e) { setErr((e as Error).message); }
  }

  async function erase(a: OuterLoopChatAgent) {
    if (!(await question(t("Delete outer-loop agent “{name}”? Its notes and runs go with it.", { name: a.name }), { ok: t("Delete"), danger: true }))) return;
    try { await deleteOuterLoop(workspaceId, a.id); await load(); await loadNotes(filter); }
    catch (e) { setErr((e as Error).message); }
  }

  const editorAgent = editor?.agentId ? inventory?.items.find((x) => x.id === editor.agentId) ?? null : null;
  // The error of the last run: red, except an intended end (agenda keeper: abort at the turn, deferral in a busy chat) — that
  // shows calmly with its own text (`runError`).
  const errorOf = (a: OuterLoopChatAgent) => {
    const f = a.lastRun ? runError(a.lastRun, t) : null;
    return f && (
      <div className={`mt-0.5 line-clamp-2 text-[11.5px] ${f.quiet ? "text-dim" : "text-danger"}`} data-outerloop-run-error={f.quiet ? "quiet" : "error"}>{f.text}</div>
    );
  };

  // The editor INSTEAD of the sheet, not over it: two sheets would both listen to Escape and close together.
  if (editor && inventory && (editor.agentId === null || editorAgent)) {
    return (
      <OuterLoopEditor
        workspaceId={workspaceId}
        inventory={inventory}
        agent={editorAgent}
        fresh={editor.agentId === null ? { origin: "chat", chatId } : undefined}
        onClose={() => { setEditor(null); void load(); }}
        onSaved={() => { outerLoopInventory(workspaceId).then(setInventory).catch(() => {}); }}
      />
    );
  }

  return (
    <Modal onClose={onClose} width={640} label={t("Outer loop")}>
      <div className="flex flex-col gap-4" data-outerloop-chat={chatId}>
        <ModalTitle hint={t("Background agents watching this chat. Their notes are below; only the summarizer's notes are visible to other agents.")}>
          {t("Outer loop")}
        </ModalTitle>
        {err && <Hint tone="danger">{err}</Hint>}
        {!status && !err && <Loading />}
        {status && !status.targetChat && (
          <Hint tone="warn">{status.reason || t("This chat is not a target of the outer loop — it observes regular coding chats.")}</Hint>
        )}

        {status && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-0.5">
              <span className="text-[13px] font-semibold">{t("Agents")}</span>
              <span className="flex-1" />
              {status.targetChat && <button type="button" onClick={() => { void openEditor(null); }} className={ghostSm} data-outerloop-chat-new="">{t("+ Own agent")}</button>}
            </div>
            <div className="cb-kit-pane overflow-hidden rounded-2xl">
              {status.agents.length === 0 && <div className="px-4 py-3 text-[12.5px] text-dim">{t("No outer-loop agent is available here.")}</div>}
              {status.agents.map((a) => (
                <div key={a.id} data-outerloop-chat-agent={a.id} className="flex items-start gap-3 border-b border-edge/60 px-4 py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={`min-w-0 truncate text-[13.5px] font-medium ${a.active ? "" : "text-dim"}`}>{a.name}</span>
                      {a.summarizer || a.agendaKeeper || a.timeline ? <Marker tone="accent">{fixedName(a, t)}</Marker> : <Marker>{originName(a.origin, t)}</Marker>}
                      {!a.effective && <Marker tone="warn">{ineffectiveText(a.ineffectiveReason, t) || t("off")}</Marker>}
                      {a.running && <Marker tone="accent">{t("running")}</Marker>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-dim">
                      {sourceText(a.source, t)}
                      {a.active && a.since ? ` · ${t("since {time}", { time: time(a.since) })}` : ""}
                      {a.lastRun ? ` · ${t("last run {time}, {state}", { time: time(a.lastRun.startedAt), state: stateName(a.lastRun.state, t) })}` : ""}
                    </div>
                    {errorOf(a)}
                  </div>
                  <Toggle on={a.active} disabled={!a.toggleable || toggles === a.id} onClick={() => { void toggle(a); }}
                    title={!a.toggleable ? sourceText(a.source, t) : a.active ? t("On for this chat — click to switch off") : t("Off for this chat — click to switch on")} />
                  {a.origin === "chat" && (
                    <Menu label={t("More")} silent>
                      <MenuEntry label={t("Edit")} onClick={() => { void openEditor(a.id); }} />
                      <MenuEntry label={t("Delete")} onClick={() => { void erase(a); }} danger />
                    </Menu>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 px-0.5">
            <span className="text-[13px] font-semibold">{t("Notes")}</span>
            <span className="flex-1" />
            {status && status.agents.length > 1 && (
              <select value={filter} onChange={(e) => setFilter(e.target.value)} className={select} aria-label={t("Notes by")}>
                <option value="">{t("All agents")}</option>
                {status.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </div>
          {!notes && !err && <Loading />}
          {notes && (
            <div className="cb-kit-pane overflow-hidden rounded-2xl" data-outerloop-notes="">
              {notes.length === 0 && <div className="px-4 py-3 text-[12.5px] text-dim">{t("No note on this chat yet.")}</div>}
              {notes.map((n) => (
                <div key={n.id} className="border-b border-edge/60 px-4 py-2.5 last:border-b-0">
                  <div className="flex items-center gap-2 text-[11.5px] text-dim">
                    <span className="font-medium text-fg/80">{n.agentName || status?.agents.find((a) => a.id === n.agentId)?.name || t("(deleted agent)")}</span>
                    <span className="tabular-nums">{time(n.at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{n.text}</p>
                </div>
              ))}
            </div>
          )}
          {additional && <div><button type="button" onClick={() => { void more(); }} className={ghostSm}>{t("Load more")}</button></div>}
        </section>

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={ghost}>{t("Close")}</button>
        </div>
      </div>

    </Modal>
  );
}
