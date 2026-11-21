"use client";

import { accent, ghost, Modal } from "@/components/CbKit";
import { svg } from "@/components/chat/ChatIcons";
import { PROVIDER_SWITCH_NOWARN } from "@/components/chat/ChatCatalog";

// Provider-switch warning modal: confirm -> compact the history -> switch provider.
// A glass sheet from the kit (`CbKit`), portalled to the body (`fixed` would otherwise bind to the page's `@container`).
// Escape and a click outside close it unless compaction is running.
// Only ChatPane renders it, and only conditionally (`{providerSwitch && …}`); the state, the target and both handlers
// stay there: `pickModel` opens the sheet, `doProviderSwitch` compacts and switches.
// Contract: one line per value, all required; ChatPane passes each under its own name (a gate test counts).
export type ProviderSwitchModalProps = {
  providerSwitch: { providerId: string; model: string; label: string }; // the target: provider, model, label
  switching: boolean; // compacting + switching in progress; blocks closing and both buttons
  switchNoWarn: boolean; // "Don't show again" checkbox (ChatPane resets it on open)
  setSwitchNoWarn: React.Dispatch<React.SetStateAction<boolean>>;
  setProviderSwitch: React.Dispatch<React.SetStateAction<{ providerId: string; model: string; label: string } | null>>;
  doProviderSwitch: (providerId: string, id: string) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
};

export function ProviderSwitchModal({ providerSwitch, switching, switchNoWarn, setSwitchNoWarn, setProviderSwitch, doProviderSwitch, t }: ProviderSwitchModalProps) {
  return (
    <Modal onClose={() => { if (!switching) setProviderSwitch(null); }} width={440} className="p-5" label={t("Switch provider?")} z="z-[60]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warn/12 text-warn">
            {svg(<><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>, 18)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">{t("Switch provider?")}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-dim">
              {t("The active session is tied to the current provider and cannot be carried over. So the new model doesn't lose the thread, the history is first compacted into a summary and handed to the new provider as context.")}
            </p>
            <p className="mt-1.5 text-[12px] text-dim">{t("The visible chat history is fully preserved.")}</p>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-bg px-3 py-2 text-[12.5px]">
              <span className="text-dim">{t("Switch to")}</span>
              <span className="truncate font-medium text-fg">{providerSwitch.label}</span>
            </div>
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-dim">
          <input
            type="checkbox"
            checked={switchNoWarn}
            onChange={(e) => setSwitchNoWarn(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          {t("Don't show again")}
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={switching}
            onClick={() => setProviderSwitch(null)}
            className={`${ghost} disabled:opacity-50`}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={switching}
            onClick={async () => {
              const target = providerSwitch;
              if (!target) return;
              if (switchNoWarn && typeof window !== "undefined") localStorage.setItem(PROVIDER_SWITCH_NOWARN, "1");
              await doProviderSwitch(target.providerId, target.model);
              setProviderSwitch(null);
            }}
            className={`${accent} disabled:opacity-60`}
          >
            {switching ? t("compacting…") : t("Compact & switch")}
          </button>
        </div>
    </Modal>
  );
}
