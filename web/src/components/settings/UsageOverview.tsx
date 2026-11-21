"use client";

import { useEffect, useState } from "react";
import {
  api, loadClaudeLimits, loadOpenRouterCredit, loadConsumption, EQUIVALENT_HINT,
  type Provider, type ClaudeLimits, type LimitWait, type UsageSubpage, type UsageConsumption, type OpenRouterCredit,
} from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { AnthropicMark, OpenAIMark } from "@/components/ProviderMarks";
import { Overline, ghostSm } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";
import { SubscriptionCard, claudeWindow, codexWindow, usd, beforeText, type CodexState } from "@/components/settings/UsageKit";
import { claudeEmptySentence, codexEmptySentence, statusValue, incompleteSet, type State as State } from "@/lib/usage-status";

// Settings → Usage → Overview: the answer to "how much do I have left, and what did it cost" at a glance — the rings of
// Claude and Codex (window + reset), the API equivalent of the last 30 days per subscription provider, the OpenRouter
// cost of the same 30 days with credit, and the number of runs waiting at the limit. Every row leads into its
// subpage; the numbers behind it stand there, here only the one per provider.
//
// Each source loads on its own (`Promise.allSettled`): if one route fails, the other numbers stay, and the failed one
// says "—" instead of an invented zero. `null` means "still loading", `"error"` "not retrievable" (lib/usage-status.ts —
// also the sentences when no window is there, and the reason of an incomplete equivalent).

export function UsageOverview({ onGo }: { onGo: (u: UsageSubpage) => void }) {
  const t = useT();
  const loc = dateLocale();
  const [limits, setLimits] = useState<State<ClaudeLimits>>(null);
  const [codex, setCodex] = useState<State<CodexState>>(null);
  const [consumption, setConsumption] = useState<Partial<Record<Provider, State<UsageConsumption>>>>({});
  const [credit, setCredit] = useState<State<OpenRouterCredit>>(null);
  const [waiting, setWaiting] = useState<State<number>>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const set = <T,>(f: (v: State<T>) => void) => (v: State<T>) => { if (!cancelled) f(v); };
    loadClaudeLimits().then(set(setLimits)).catch(() => set(setLimits)("error"));
    api<CodexState>("/api/usage/codex").then(set(setCodex)).catch(() => set(setCodex)("error"));
    for (const a of ["claude", "codex", "openrouter"] as const) {
      loadConsumption(a, "30d")
        .then((v) => { if (!cancelled) setConsumption((old) => ({ ...old, [a]: v })); })
        .catch(() => { if (!cancelled) setConsumption((old) => ({ ...old, [a]: "error" })); });
    }
    loadOpenRouterCredit().then(set(setCredit)).catch(() => set(setCredit)("error"));
    api<{ waiting?: LimitWait[] }>("/api/auto-continue")
      .then((d) => set(setWaiting)(Array.isArray(d.waiting) ? d.waiting.length : "error"))
      .catch(() => set(setWaiting)("error"));
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; clearInterval(clock); };
  }, []);

  const lim = statusValue(limits);
  const cdx = statusValue(codex);
  const amount = (a: Provider) => {
    const v = consumption[a];
    if (v === undefined || v === null) return t("Loading…");
    if (v === "error") return "—";
    return a === "openrouter" ? usd(v.sums?.costUsd, loc) : usd(v.sums?.equivalentUsd, loc);
  };
  const incomplete = (a: Provider) => {
    const set = incompleteSet(statusValue(consumption[a] ?? null));
    return set ? t(set) : undefined;
  };
  const open = (u: UsageSubpage) => (
    <button type="button" onClick={() => onGo(u)} className={ghostSm} data-usage-go={u}>{t("Details")}</button>
  );

  return (
    <div>
      <section>
        <Overline>{t("Plan quotas")}</Overline>
        <div className="grid grid-cols-1 gap-3 @md/kit:grid-cols-2">
          <SubscriptionCard
            marker={<AnthropicMark size={18} />}
            name="Claude"
            window={claudeWindow(lim, t)}
            empty={t(claudeEmptySentence(limits))}
            bottom={lim?.measuredAt ? <div className="mt-2 text-[11px] text-dim">{t("measured {before}", { before: beforeText(lim.measuredAt, now, t) })}</div> : null}
            onOpen={() => onGo("claude")}
          />
          <SubscriptionCard
            marker={<OpenAIMark size={17} />}
            name="Codex"
            window={codexWindow(cdx, t)}
            empty={t(codexEmptySentence(codex))}
            onOpen={() => onGo("codex")}
          />
        </div>
      </section>

      <div className="mt-5">
        <Group title={t("Last 30 days")} hint={t(EQUIVALENT_HINT)}>
          <Row title={t("Claude — API equivalent")} hint={incomplete("claude")}>
            <span className="text-[13px] font-semibold tabular-nums" data-usage-sum="claude">{amount("claude")}</span>
            {open("claude")}
          </Row>
          <Row title={t("Codex — API equivalent")} hint={incomplete("codex")}>
            <span className="text-[13px] font-semibold tabular-nums" data-usage-sum="codex">{amount("codex")}</span>
            {open("codex")}
          </Row>
          <Row
            title={t("OpenRouter — cost")}
            hint={credit && credit !== "error" && credit.known
              ? t("Credits: {rest} left", { rest: usd(credit.restUsd, loc) })
              : credit === null ? undefined : t("Credits unavailable")}
          >
            <span className="text-[13px] font-semibold tabular-nums" data-usage-sum="openrouter">{amount("openrouter")}</span>
            {open("openrouter")}
          </Row>
        </Group>
      </div>

      <div className="mt-5">
        <Group title={t("At the limit")}>
          <Row title={t("Waiting runs")} hint={t("Parked until the reset or until released in the chat.")}>
            <span className="text-[13px] font-semibold tabular-nums" data-usage-waiting>{waiting === null ? "…" : waiting === "error" ? "—" : waiting}</span>
            {open("limit")}
          </Row>
        </Group>
      </div>
    </div>
  );
}
