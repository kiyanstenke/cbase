"use client";

import { useEffect, useState } from "react";
import { api, loadArchiveChat, type LimitWait } from "@/lib/api";
import { CREDIT_GATE_PERCENT, isGateWaitRow, loadCreditGate, setCreditGate } from "@/lib/credit";
import { openCodingChat } from "@/lib/chat-jump";
import { closeSettings } from "@/lib/settings-jump";
import { dateLocale, useT } from "@/lib/i18n";
import { Toggle } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";

// Settings → Usage → At the limit: the two toggles for the behavior at the limit and the runs that are waiting right
// now. The usage overview names the number of waiting runs and leads here.
//
// The waiting list is TAPPABLE (in both clients): a click jumps into the chat of the row — to where the button "Start
// anyway" stands. The chat itself decides where to (`GET /api/chats/:id`, also for archived ones): a coding chat of
// this view through the event of the chat list (the modal then closes), any other through the address — the same
// switch as the pill "Active runs" (pills/ActiveRunsPill.tsx `openRun`), which knows only runs, no waiting rows.
//
// The wording of the toggles is identical with iOS; a DOM probe in a real browser reads it literally.

export function UsageLimit() {
  const t = useT();
  const loc = dateLocale();
  const [error, setError] = useState("");
  // Automatic continuation at the limit (default: on) + the runs currently waiting.
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  const [waiting, setWaiting] = useState<LimitWait[]>([]);
  // Credit gate (default: OFF — it holds back work, which may only happen on explicit request).
  // OWN route, own state, own loading: the two toggles are two settings with two defaults and two side effects. If one
  // route fails, the other toggle must stay operable.
  const [gateOn, setGateOn] = useState<boolean | null>(null);
  // The percent mark comes from the SERVER (`threshold`), the constant is only the preset until the route has answered —
  // a label without a number would be meaningless.
  const [threshold, setThreshold] = useState(CREDIT_GATE_PERCENT);

  useEffect(() => {
    api<{ enabled: boolean; waiting: LimitWait[] }>("/api/auto-continue")
      .then((d) => { setAutoOn(d.enabled); setWaiting(d.waiting || []); })
      .catch(() => setAutoOn(true));
    // The gate has its own route. A failure assumes the server default (OFF) — a gate that is not set slows nothing.
    loadCreditGate(api)
      .then((g) => { setGateOn(g ? g.on : false); if (g) setThreshold(g.threshold); })
      .catch(() => setGateOn(false));
  }, []);

  async function toggleAuto(next: boolean) {
    setAutoOn(next); // optimistic
    try {
      const r = await api<{ enabled: boolean }>("/api/auto-continue", { method: "PUT", body: JSON.stringify({ enabled: next }) });
      setAutoOn(r.enabled);
      // On switching OFF the server discards the waiting continuations — but not those parked by the credit gate: they
      // belong to the toggle below. So reload the list instead of emptying it; an empty box would be a claim about rows
      // that are still there.
      if (!r.enabled) {
        try { setWaiting((await api<{ waiting: LimitWait[] }>("/api/auto-continue")).waiting || []); } catch { setWaiting([]); }
      }
    } catch (e) { setAutoOn(!next); setError(String((e as Error).message)); }
  }

  // The gate is global (credit is a property of the ACCOUNT) — but it is its OWN setting on its own route. Hanging it on
  // `/api/auto-continue` kept the toggle silently stuck for nine days and shifted the toggle above.
  async function toggleGate(next: boolean) {
    setGateOn(next); // optimistic
    try {
      const state = await setCreditGate(api, next);
      setGateOn(state.on);       // server truth wins over the optimistic value
      setThreshold(state.threshold);
      // On switching OFF the server immediately releases the runs parked by the gate. Leaving the old waiting list would
      // be a claim about runs that are long running again.
      if (!state.on) {
        try { setWaiting((await api<{ waiting: LimitWait[] }>("/api/auto-continue")).waiting || []); } catch {}
      }
    } catch (e) { setGateOn(!next); setError(String((e as Error).message)); }
  }

  // The jump into the chat of a waiting row. The row carries only the chat id; workspace and kind are told by the chat itself.
  async function openChat(chatId: string) {
    setError("");
    let chat;
    try { chat = await loadArchiveChat(chatId); } catch (e) { setError(String((e as Error).message)); return; }
    if (!chat) { setError(t("The chat no longer exists.")); return; }
    openCodingChat(chatId, chat.workspaceId, { prior: closeSettings });
  }

  const time = (ms: number) => new Date(ms).toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      {error && <p className="mb-4 text-[12.5px] text-danger">{error}</p>}

      {/* The waiting list: STATE ("these runs are stuck right now"), hence above the toggles. Without waiting runs it is
          not there at all — the overview counts them, an empty box would be mere noise here. */}
      {waiting.length > 0 && (
        <div className="cb-kit-pane cb-kit-pane-warn mb-5 rounded-2xl p-4" data-usage-waitlist>
          <p className="text-[13px] font-semibold">{t("Waiting for a reset")}</p>
          <ul className="mt-1.5 space-y-0.5">
            {waiting.map((w) => (
              <li key={w.chatId}>
                <button
                  type="button"
                  onClick={() => openChat(w.chatId)}
                  title={t("Back to chat")}
                  data-usage-waiting={w.chatId}
                  className="-mx-1.5 w-[calc(100%+12px)] rounded-lg px-1.5 py-1 text-left text-[12px] leading-relaxed text-dim transition-colors hover:bg-hover hover:text-fg"
                >
                  {w.limitText}
                  {" · "}
                  {isGateWaitRow(w)
                    // The gate row is self-sufficient: it continues at the reset, the button in the chat is the second
                    // way, not the only one.
                    ? t("Credit gate: parked — continues at the reset or when you release it in the chat")
                    : w.reason === "probe"
                    ? t("Reset time unknown — checking")
                    : w.kind === "compact"
                      ? t("Compacting {reset}", { reset: time(w.dueAt) })
                      : t("Continues {reset}", { reset: time(w.dueAt) })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Both toggles are the kit `Toggle`. (The class name of the old hand-built switch is deliberately NOT written
          here: the guard against it greps this directory, and it also reads comments.) */}
      <Group title={t("Behavior at the limit")}>
        <Row
          title={t("Continue automatically when the limit resets")}
          hint={t("When a chat, a workflow or a scheduled task runs into the 5-hour or weekly limit, the work is parked and resumed as soon as the limit resets — even across a restart. After 12 consecutive continuations it gives up. Usage credits and spend caps do not recover on their own, so those are not waited on. Switching this off discards waiting continuations — except those parked by the usage gate, which belong to the switch below.")}
        >
          <Toggle on={autoOn !== false} onClick={() => toggleAuto(!(autoOn !== false))} disabled={autoOn === null} />
        </Row>

        {/* ── Credit gate: from 99% start nothing new ──
            The label says explicitly what it can NOT do. Whether credit is consumed beyond the window is decided by the
            provider's server; there is no flag for it. What is prevented is the START, not the consumption of a running
            turn — and whoever wants it hard switches it off in the account. A cap must say that it is one.
            Wording identical with iOS: the gate applies to EVERY model work (also verdicts and the filing chain) and
            INDEPENDENTLY of the toggle above — an older version promised a parking that silently did not happen with
            auto-continue switched off.
            The two paragraphs go out as ONE hint, separated by a blank line: the clipped row reads them as running text,
            the bubble at the (i) as two paragraphs (`whitespace-pre-line`). Both sentences remain their own dictionary
            keys. */}
        <div data-credit-gate>
          <Row
            title={t("Do not start a new turn above {pct}%", { pct: threshold })}
            hint={`${t("Once the blocking time window is {pct} percent full, cbase starts no new model work — no turn, no verdict — but parks it until the reset, regardless of the switch above. The chat then offers a button that releases this one turn, including its subagents.", { pct: threshold })}\n\n${t("cbase prevents the START — not the credit spend of work that is already running: the provider's server decides that. The hard stop lives in your account. Applies to Claude only: Codex reports its utilization only after a run, third-party providers have no windows.")}`}
          >
            <Toggle on={!!gateOn} onClick={() => toggleGate(!gateOn)} disabled={gateOn === null} />
          </Row>
        </div>
      </Group>
    </div>
  );
}
