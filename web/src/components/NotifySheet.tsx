"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, ModalTitle, Segments } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { jobNotificationKinds } from "@/lib/scheduled";
import {
  loadNotify, setPosition, position,
  type NotifyKind, type NotifyChoice,
} from "@/lib/notify";

// "Notifications" sheet of a chat. Five three-way switches fit in no menu row, and a cycling
// entry never says which states exist at all.
//
// "Default" is the first position and the shipped state: the chat follows the global default.
// Without this third position the promise "off by default" would only work together with
// "questions do not arrive either", and those are exactly the ones you want.

const POSITIONS = [
  { key: "standard", label: "Default" },
  { key: "on", label: "On" },
  { key: "off", label: "Off" },
];

export function NotifySheet({ chatId, title, choice, job = false, onClose, onSaved }: {
  chatId: string;
  title: string;
  choice: NotifyChoice;
  /** A job chat (Coding → Scheduled) carries the kinds of a chat AND those of a schedule (run end `schedule`), like the server
   *  (`scheduled/chat-field.js` JOB_NOTIFICATIONS) and the sheet on iOS. */
  job?: boolean;
  onClose: () => void;
  onSaved: (choice: NotifyChoice) => void;
}) {
  const t = useT();
  const [kinds, setKinds] = useState<NotifyKind[] | null>(null);
  const [key, setKey] = useState<string[]>([]);
  const [local, setLocal] = useState<NotifyChoice>(choice || {});
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const doc = await loadNotify();
        setKinds(doc.kinds);
        setKey(job ? jobNotificationKinds(doc.chatKinds, doc.scheduleKinds) : doc.chatKinds);
      } catch (e) { setError(String((e as Error).message || e)); }
    })();
  }, [job]);

  // The WHOLE set is written: "Default" is the absence of an entry, and a partial patch could
  // never take a set value back to default.
  const save = useCallback(async (next: NotifyChoice) => {
    setLocal(next);
    try {
      await api(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ notify: next }) });
      onSaved(next);
      setError("");
    } catch (e) { setError(String((e as Error).message || e)); }
  }, [chatId, onSaved]);

  const visible = (kinds || []).filter((a) => key.includes(a.key));
  const deviating = Object.keys(local).length > 0;

  return (
    <Modal onClose={onClose} width={560} label={t("Notifications")}>
      <ModalTitle hint={t("Applies to iPhone notifications only. The bell still shows everything.")}>
        {t("Notifications")} — <span className="font-normal text-dim">{title}</span>
      </ModalTitle>
      {error && <p className="mb-3 text-[12.5px] text-danger">{error}</p>}
      <div className="overflow-hidden rounded-2xl cb-kit-pane">
        {visible.length === 0 && !error && (
          <p className="px-3 py-3 text-[12.5px] text-dim">{t("Loading…")}</p>
        )}
        {visible.map((a, i) => (
          <div key={a.key} className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${i ? "border-t border-edge/60" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{a.label}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-dim">
                {a.hint}{" "}
                <span className="opacity-70">
                  {t("Default:")} {a.value ? t("on") : t("off")}
                </span>
              </div>
            </div>
            <Segments
              label={a.label}
              value={position(local, a.key)}
              items={POSITIONS.map((s) => ({ key: s.key, label: t(s.label) }))}
              onChange={(k) => void save(setPosition(local, a.key, k as "standard" | "on" | "off"))}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px] text-dim">
          {deviating ? t("This chat differs from the default.") : t("This chat follows the default everywhere.")}
        </span>
        <button
          type="button"
          disabled={!deviating}
          onClick={() => void save({})}
          className="rounded-full px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-hover disabled:opacity-40"
        >
          {t("Reset all to default")}
        </button>
      </div>
    </Modal>
  );
}

/** The marker on the chat row; it only appears when it says something. */
export function NotifyMarker({ marker, className = "" }: { marker: "" | "silent" | "loud"; className?: string }) {
  const t = useT();
  if (!marker) return null;
  const silent = marker === "silent";
  return (
    <span
      title={silent ? t("Notifications partly off for this chat") : t("Notifications raised for this chat")}
      className={`shrink-0 ${silent ? "text-dim" : "text-accent"} ${className}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        {silent && <path d="M2 2l20 20" />}
      </svg>
    </span>
  );
}
