// The jump "agenda item in the chat" as a hook (sheet lib/agenda-jump.ts): waits until the chat of the wish is open and
// loaded, then opens the right bar on "Agenda". AgendaPanel.tsx highlights the item itself (it collects the wish). A hook
// because ChatPane sits at the line guard; only the call stays there. Only in the chat tab itself (`disabled` = ChatPane
// `onlyChat`), otherwise two ChatPanes would open the same jump.
import { useEffect, useState } from "react";
import { AGENDA_JUMP_EVENT, agendaWish } from "@/lib/agenda-jump";

export function useAgendaJump({ off: disabled, activeId, chatLoading, open }: {
  off: boolean;
  activeId: string | null;
  chatLoading: boolean;
  /** ChatPane `openRightSidebar("agenda")`. */
  open: () => void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const on = () => setTick((x) => x + 1);
    window.addEventListener(AGENDA_JUMP_EVENT, on);
    return () => window.removeEventListener(AGENDA_JUMP_EVENT, on);
  }, [disabled]);
  useEffect(() => {
    if (disabled || chatLoading || !agendaWish(activeId)) return;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, tick, activeId, chatLoading]);
}
