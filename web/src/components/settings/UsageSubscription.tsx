"use client";

import { useEffect, useState } from "react";
import {
  api, SUBSCRIPTION_WINDOW, loadClaudeLimits, loadConsumption, loadHistory,
  type SubscriptionProvider, type ClaudeLimits, type UsageWindow, type UsageConsumption, type UsageHistory,
} from "@/lib/api";
import { creditAmount, creditReasonSentence, normCredit, type Credit } from "@/lib/credit";
import { claudeEmptySentence, codexEmptySentence, statusValue, type State as State } from "@/lib/usage-status";
import { dateLocale, useT } from "@/lib/i18n";
import { ProgressBar, Group, Row } from "@/components/settings/SettingsKit";
import {
  ChatList, WindowBar, WindowRow, EquivalentSurface, BackgroundList, ModelList, TokenSurface, HistoryProgressBar,
  claudeWindow, codexWindow, sinceText, sumKnown, tok, usd, beforeText, type CodexState,
} from "@/components/settings/UsageKit";

// Settings → Usage → Claude or Codex. The question "where does my quota go" — for EXACTLY one provider: mixing Claude
// and Codex tiles (input 1.5 M, of which 99.8% Codex), "cache" as read and write together (the most expensive item
// invisible in it), and a sliding 5-h window while the ring measures from the window start would never make number and
// ring agree.
//
// So: the windows like the ring (`session`/`week` from the start of the real window out of the stored snapshot) and 30
// days sliding; without a snapshot the bar says "Last 5 h"/"Last 7 days". The main number is the API equivalent with its
// breakdown and the hint that it is an estimate; below it the tokens in one surface, per model, per role of the
// background tasks, per chat (with "N more") and the history per day. Claude additionally shows ALL limits of the last
// snapshot ("measured N min ago") and the credit (extra usage). Only this view remembers the window choice.
// Limits and Codex state are three-valued as in the overview (lib/usage-status.ts): while they load, "Loading…"
// stands, after an error "Not retrievable" — never "no measurement" or "not connected", only an answer says that.

export function UsageSubscription({ provider }: { provider: SubscriptionProvider }) {
  const t = useT();
  const loc = dateLocale();
  const [window, setWindow] = useState<UsageWindow>("session");
  const [known, setKnown] = useState<Partial<Record<UsageWindow, boolean>>>({});
  const [data, setData] = useState<UsageConsumption | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [limits, setLimits] = useState<State<ClaudeLimits>>(null);
  const [codex, setCodex] = useState<State<CodexState>>(null);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The chosen window: its own effect, the rest of the page loads only once per provider.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadConsumption(provider, window)
      .then((v) => {
        if (cancelled) return;
        setData(v); setError("");
        setKnown((old) => ({ ...old, [window]: v.windowKnown }));
      })
      .catch((e) => { if (!cancelled) { setData(null); setError(String((e as Error).message)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [provider, window]);

  useEffect(() => {
    let cancelled = false;
    loadHistory(provider, 30).then((v) => { if (!cancelled) setHistory(v); }).catch(() => { if (!cancelled) setHistory(null); });
    setLimits(null);
    setCodex(null);
    if (provider === "claude") {
      loadClaudeLimits().then((l) => { if (!cancelled) setLimits(l); }).catch(() => { if (!cancelled) setLimits("error"); });
      // The credit (extra usage) is only in the response of /api/usage — the same way as the header rings.
      api<{ credit?: unknown; extra_usage?: unknown }>("/api/usage").then((d) => { if (!cancelled) setCredit(normCredit(d?.credit ?? d?.extra_usage)); }).catch(() => {});
    } else {
      api<CodexState>("/api/usage/codex").then((c) => { if (!cancelled) setCodex(c); }).catch(() => { if (!cancelled) setCodex("error"); });
    }
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; clearInterval(clock); };
  }, [provider]);

  const s = data?.sums ?? null;
  const empty = !loading && !error && (!s || !(sumKnown(s.input, s.output, s.cacheRead, s.cacheWrite, s.cacheUnsplit) ?? 0));
  const since = data && data.window === window ? sinceText(window, data.from, data.windowKnown, loc, t) : null;
  const lim = statusValue(limits);
  const limitWindow = provider === "claude" ? claudeWindow(lim, t) : codexWindow(statusValue(codex), t);

  return (
    <div>
      <Group
        title={provider === "claude" ? t("Limits") : t("Quota")}
        hint={provider === "claude" && lim?.measuredAt ? t("measured {before}", { before: beforeText(lim.measuredAt, now, t) }) : undefined}
      >
        <div className="px-3.5 pb-3" data-usage-limits={provider}>
          {limitWindow.length
            ? limitWindow.map((f) => <WindowRow key={f.key} f={f} />)
            : <div className="pt-3 text-[12.5px] text-dim">{t(provider === "claude" ? claudeEmptySentence(limits) : codexEmptySentence(codex))}</div>}
        </div>
        {provider === "claude" && credit && <CreditRow g={credit} />}
      </Group>

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <WindowBar window={SUBSCRIPTION_WINDOW} value={window} onChoice={setWindow} known={known} />
        {since && <span className="text-[12px] text-dim" data-usage-since>{since}</span>}
      </div>
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}

      {loading && !data ? (
        <div className="mt-4 text-[12.5px] text-dim">{t("Loading…")}</div>
      ) : empty ? (
        <div className="cb-kit-pane cb-kit-pane-dashed mt-4 rounded-2xl p-5 text-center text-[12.5px] text-dim">
          {t("Nothing was recorded in this time window.")}
        </div>
      ) : data && (
        <div className={`mt-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <EquivalentSurface sums={s} under={`${tok(s?.output)} ${t("Output")} · ${tok(sumKnown(s?.cacheRead, s?.cacheWrite))} ${t("Cache")}`} />
          <div className="mt-5"><TokenSurface sums={s} subagentsShare={data.subagentsShare} /></div>
          <div className="mt-5"><ModelList models={data.models} kind="equivalent" /></div>
          <div className="mt-5"><BackgroundList rows={data.background} kind="equivalent" /></div>
          <div className="mt-5"><ChatList chats={data.chats} additional={data.chatsAdditional} kind="equivalent" /></div>
        </div>
      )}

      {history && history.points.length > 0 && (
        <div className="mt-5">
          <HistoryProgressBar title={t("API equivalent per day, 30 days")} points={history.points} value={(p) => p.equivalentUsd} format={(n) => usd(n, loc)} />
        </div>
      )}
    </div>
  );
}

/**
 * The credit (extra usage) — the pot BEYOND the windows, without reset. "off" is a state, not a lack: `has_credits:false`
 * means "this account has no pot at all" (lib/credit.ts). Wording as before on the usage page.
 */
function CreditRow({ g }: { g: Credit }) {
  const t = useT();
  const loc = dateLocale();
  return (
    <Row
      title={t("Credits")}
      hint={g.on === false
        ? creditReasonSentence(g.reason, t)
        : g.limit != null
          ? t("{used} of {limit} this month", { used: creditAmount(g.used, g.currency, loc), limit: creditAmount(g.limit, g.currency, loc) })
          : g.used != null
            ? t("{used} spent — no monthly limit set", { used: creditAmount(g.used, g.currency, loc) })
            : t("On — work continues once a window is full.")}
    >
      {g.on === false ? (
        <span className="text-[12px] text-dim">{t("off")}</span>
      ) : g.utilization != null ? (
        <span className="flex w-[180px] items-center gap-2.5" data-usage-credit>
          <span className="min-w-0 flex-1"><ProgressBar percent={g.utilization} /></span>
          <span className="shrink-0 text-[12.5px] font-semibold tabular-nums">{t("{pct}% used", { pct: Math.round(g.utilization) })}</span>
        </span>
      ) : null}
    </Row>
  );
}
