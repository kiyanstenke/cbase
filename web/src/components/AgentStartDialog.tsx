"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Modal, ModalTitle, accent, field, ghost } from "@/components/CbKit";

// Dialog for starting a service with an agent: the user can add start instructions. The server stores them per service
// and suggests them again via `initial` next time.
export function AgentStartDialog({
  serviceName,
  initial,
  onStart,
  onClose,
}: {
  serviceName: string;
  initial: string;
  onStart: (instructions: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);

  // A sheet from the kit (`CbKit`, portal at the body): same form as every other modal; Escape and a click outside close it.
  return (
    <Modal onClose={onClose} width={560} label={t("Start with agent")} z="z-[60]">
        <ModalTitle hint={<>{t("Service")} <span className="font-medium text-fg">{serviceName}</span> — {t("optional instructions for the agent. They are saved and suggested again on the next start.")}</>}>
          {t("Start with agent")}
        </ModalTitle>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onStart(text);
          }}
          placeholder={t("e.g. activate venv, start in dev mode, run migrations first, use port 3200 …")}
          className={`${field} min-h-[140px] w-full resize-y px-3.5 py-2.5 leading-relaxed`}
        />
        <div className="mt-4 flex items-center justify-end gap-2.5">
          <button type="button" onClick={onClose} className={ghost}>
            {t("Cancel")}
          </button>
          <button type="button" onClick={() => onStart(text)} className={accent}>
            {t("Start")}
          </button>
        </div>
    </Modal>
  );
}
