"use client";

// The "Message" button on a live agent and its sheet. The human writes to a subagent (card in the agent bar, address =
// agentId) or to a workflow agent (row in the progress tree, also while waiting; the address is always the run address
// `wf:<runId>:<n>`) — the same path as the main agent, sender "human", without a running turn.
//
// The sheet: agent name and state on top, a multi-line field, send (⌘⏎). Afterwards the server's sentence is shown
// (delivered / queued / after its turn / rejected — the reply's `text`, never our own wording) and the sheet closes by
// itself after a moment. A rejection stays open, so the text is not lost.
// That promise only holds if the sheet does NOT hang on a view that disappears when the agent ends: the "open, to whom"
// state therefore lives in the run's card (DynWorkflowTree.tsx `messageTo`) or the bar (AgentBar `messageTo`), never in
// the row — that goes away with its collapsing phase (guard web/test/dyn-tree.test.mjs).
// Shape: kit `Modal` (cb-overlay + cb-sheet, portal at the body, flat under `.cb-flat`).
//
// Hooks: data-agent-message (the sheet, value = address), data-agent-message-field, data-agent-message-send,
// data-agent-message-response (value = state). The buttons carry data-agent-message (subagent card) or
// data-dynwf-message=<n> (tree row).

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { messageToAgent, type MessageResponse } from "@/lib/api";
import { field, ghostSm, Hint, Modal, ModalTitle, primary } from "@/components/CbKit";
import { SpinnerIcon } from "@/components/chat/ChatIcons";

/** Whom the sheet writes to: address for the route, name and state (already translated) for the header. */
export type MessageTarget = { address: string; name: string; kind: string; state: string };

/** How long the server's sentence stays after an accepted message before the sheet closes. */
const STANDS_MS = 1800;

/** The word for a transcript line of kind "message" (state on the journal entry). Unknown values stay raw. */
export function messageStateWord(state: string | undefined): string {
  switch (state) {
    case "delivered": return "delivered";
    case "after_turn": return "after its turn";
    case "earmarked": return "queued";
    case "not_delivered": return "not delivered";
    default: return state ?? "";
  }
}

export function AgentMessageSheet({ chatId, target, onClose }: { chatId: string; target: MessageTarget; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [sends, setSends] = useState(false);
  const [response, setResponse] = useState<MessageResponse | null>(null);
  const fieldName = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { fieldName.current?.focus(); }, []);
  // Accepted: the sentence stays a moment, then the sheet closes. Rejected: it stays open. `onClose` goes through a ref:
  // the agent bar re-renders every second (new arrow function) — as a dependency that would reset the timer every
  // second and the sheet would never close.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!response?.ok) return;
    const id = setTimeout(() => close.current(), STANDS_MS);
    return () => clearTimeout(id);
  }, [response]);

  async function send() {
    const message = text.trim();
    if (!message || sends || response?.ok) return;
    setSends(true);
    setResponse(null);
    const a = await messageToAgent(chatId, target.address, message);
    setSends(false);
    setResponse(a);
  }

  const finished = Boolean(response?.ok);
  return (
    <Modal onClose={onClose} width={460} label={t("Message to {name}", { name: target.name })}>
      <div data-agent-message={target.address}>
        <ModalTitle hint={`${target.kind} · ${target.state}`}>
          <span className="block truncate" title={target.name}>{t("Message to {name}", { name: target.name })}</span>
        </ModalTitle>
        <textarea
          ref={fieldName}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          rows={5}
          disabled={sends || finished}
          placeholder={t("What should the agent know?")}
          className={`${field} cb-scroll w-full resize-y leading-relaxed disabled:opacity-60`}
          data-agent-message-field
        />
        <div className="mt-1 text-[11px] text-dim">{t("⌘⏎ sends. The agent sees it as “Message from the human”.")}</div>
        {response && (
          <div className="mt-3" data-agent-message-response={response.state}>
            <Hint tone={response.ok ? "ok" : "danger"}>{response.text || (response.ok ? t("delivered") : t("rejected"))}</Hint>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostSm}>{finished ? t("Close") : t("Cancel")}</button>
          {!finished && (
            <button type="button" onClick={() => void send()} disabled={!text.trim() || sends}
              className={`${primary} inline-flex items-center gap-1.5 bg-accent disabled:opacity-50`} data-agent-message-send>
              {sends && <SpinnerIcon size={12} />}
              {sends ? t("Sending…") : t("Send")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
