"use client";
// The approval card of a dynamic workflow without opt-in, modelled on the question card (AskCard): the agent wanted to
// start a workflow without the person having chosen multi-agent orchestration; the card shows name, description and
// phases from `meta`, Accept starts the run, Deny reports it to the agent. The decision goes to the server itself
// (POST /api/chats/:id/dyn-workflows/approval); the handlers live here, not in ChatPane (line guard). What holds
// afterwards is told by the server via the event `workflow_approval_decided` (reducer, lib/workflow-approval.ts). A card
// is decided exactly once.
import { useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type WorkflowApproval } from "@/lib/workflow-approval";
import { CARD, CARDS_HEADER, BUTTON_MAIN, BUTTON_BESIDE } from "@/components/chat/StatusLine";

export function WorkflowApprovalCard({ card, chatId }: { card: WorkflowApproval; chatId: string | null }) {
  const t = useT();
  const [sends, setSends] = useState(false);
  const [error, setError] = useState("");
  const open = card.decision === null;

  async function decide(decision: "accept" | "reject") {
    if (!chatId || sends || !open) return;
    setSends(true);
    setError("");
    try {
      await api(`/api/chats/${chatId}/dyn-workflows/approval`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, decision }) });
    } catch (e) {
      setError(String((e as Error).message || e));
      setSends(false);
    }
  }

  return (
    <div
      className={CARD}
      data-workflow-approval={card.requestId}
      {...(open ? { "data-open": "" } : {})}
    >
      <div className={CARDS_HEADER}>
        <span className="font-medium text-fg">{t("Allow this workflow?")}</span>
        {card.decision === "accepted" && <span data-workflow-approval-ruling="accepted">{t("accepted")}</span>}
        {card.decision === "rejected" && <span data-workflow-approval-ruling="rejected">{t("rejected")}</span>}
      </div>
      <div className="text-[13px] font-medium text-fg">{card.name || "workflow"}</div>
      {card.description && <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-dim">{card.description}</div>}
      {card.phases.length > 0 && (
        <ol className="mt-2 flex flex-col gap-0.5 pl-0.5 text-[12px] text-fg">
          {card.phases.map((p, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 tabular-nums text-dim">{i + 1}.</span>
              <span className="min-w-0 flex-1">
                {p.title}
                {p.detail && <span className="text-dim"> — {p.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {open && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {error && <span className="min-w-0 flex-1 truncate text-[11.5px] text-danger" title={error}>{error}</span>}
          <button type="button" disabled={sends || !chatId} onClick={() => decide("reject")} className={BUTTON_BESIDE} data-workflow-approval-reject>
            {t("Deny")}
          </button>
          <button type="button" disabled={sends || !chatId} onClick={() => decide("accept")} className={BUTTON_MAIN} data-workflow-approval-accept>
            {t("Accept")}
          </button>
        </div>
      )}
    </div>
  );
}
