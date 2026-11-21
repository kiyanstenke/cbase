"use client";

import { useEffect, useState } from "react";
import {
  ORIGIN_LABEL, ORIGIN_TALLY_FIELDS, OPENROUTER_WINDOW, OPENROUTER_ID,
  loadOpenRouterCredit, loadOpenRouterPrices, loadConsumption, loadHistory,
  type ModelPrices, type UsageWindow, type UsageModel, type UsageConsumption, type UsageHistory, type OpenRouterCredit,
} from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { Group, Row } from "@/components/settings/SettingsKit";
import {
  ChatList, WindowBar, BackgroundList, ModelList, TokenSurface, HistoryProgressBar, sumKnown, usd, beforeText,
} from "@/components/settings/UsageKit";

// Settings → Usage → OpenRouter. OpenRouter accounts in money, not against a quota: on top the account credit (live from
// OpenRouter, cached for 60 s), below the cost per window (`30d · total`) with its ORIGIN — reported (per response),
// queried (via the generation id), estimated (old runs without id, catalog price) and unknown. A number without origin
// would look like a reported one; hence the count stands beside every sum. Per model the price range per provider
// behind it and the provider of the last response (`/api/usage/openrouter-prices`, own fetch — if it fails only this
// line is missing), plus per chat, the background tasks including outer loop, and the history per day.

/** "$0.43–0.60" or "$0.50" if all providers charge the same — per 1M tokens. */
function spanText(min: number, max: number, loc: string): string {
  const z = (n: number) => n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return min === max ? `$${z(min)}` : `$${z(min)}–${z(max)}`;
}

function PriceRow({ p }: { p: ModelPrices | undefined }) {
  const t = useT();
  const loc = dateLocale();
  if (!p) return null;
  if (!p.known || !p.span) return <span className="block">{t("Prices per provider unavailable")}</span>;
  return (
    <span className="block" data-or-prices>
      {t("per provider {in} in · {out} out (1M)", { in: spanText(p.span.inMin, p.span.inMax, loc), out: spanText(p.span.outMin, p.span.outMax, loc) })}
      {p.upstream && p.last && (
        <> · {t("last {provider}: {in} in · {out} out", { provider: p.upstream, in: spanText(p.last.inMin, p.last.inMax, loc), out: spanText(p.last.outMin, p.last.outMax, loc) })}</>
      )}
    </span>
  );
}

export function UsageOpenRouter() {
  const t = useT();
  const loc = dateLocale();
  const [window, setWindow] = useState<UsageWindow>("30d");
  const [data, setData] = useState<UsageConsumption | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [credit, setCredit] = useState<OpenRouterCredit | null | "error">(null);
  const [prices, setPrices] = useState<Record<string, ModelPrices> | null>(null);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadConsumption(OPENROUTER_ID, window)
      .then((v) => { if (!cancelled) { setData(v); setError(""); } })
      .catch((e) => { if (!cancelled) { setData(null); setError(String((e as Error).message)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [window]);

  useEffect(() => {
    let cancelled = false;
    loadOpenRouterCredit().then((g) => { if (!cancelled) setCredit(g); }).catch(() => { if (!cancelled) setCredit("error"); });
    loadOpenRouterPrices().then((p) => { if (!cancelled) setPrices(p); }).catch(() => { if (!cancelled) setPrices({}); });
    loadHistory(OPENROUTER_ID, 30).then((v) => { if (!cancelled) setHistory(v); }).catch(() => { if (!cancelled) setHistory(null); });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; clearInterval(clock); };
  }, []);

  const s = data?.sums ?? null;
  const g = credit === "error" ? null : credit;
  const origin = s?.costOrigin;
  const originSet = origin
    ? ORIGIN_TALLY_FIELDS.filter((h) => (origin[h] ?? 0) > 0).map((h) => `${origin[h]} ${t(ORIGIN_LABEL[h])}`).join(" · ")
    : "";
  const empty = !loading && !error && (!s || !(sumKnown(s.input, s.output, s.cacheRead, s.cacheWrite, s.cacheUnsplit) ?? 0));

  return (
    <div>
      <Group title={t("Credits")} hint={g?.at ? t("fetched {before}", { before: beforeText(g.at, now, t) }) : undefined}>
        {credit === null ? (
          <Row title={<span className="text-dim">{t("Loading…")}</span>} />
        ) : !g || !g.known ? (
          <Row title={t("Unavailable")} hint={t("Without a key, or when OpenRouter does not answer, there is no figure here.")} />
        ) : (
          <>
            <Row title={t("Left")}><span className="text-[15px] font-semibold tabular-nums" data-or-credit-rest>{usd(g.restUsd, loc)}</span></Row>
            <Row title={t("Spent")}><span className="text-[13px] tabular-nums">{usd(g.consumedUsd, loc)}</span></Row>
            <Row title={t("Topped up")}><span className="text-[13px] tabular-nums">{usd(g.totalUsd, loc)}</span></Row>
            {g.keyLimitUsd !== null && (
              <Row title={t("Key limit")} hint={g.keyRestUsd !== null ? t("{rest} left", { rest: usd(g.keyRestUsd, loc) }) : undefined}>
                <span className="text-[13px] tabular-nums">{usd(g.keyLimitUsd, loc)}</span>
              </Row>
            )}
          </>
        )}
      </Group>

      <div className="mt-5">
        <WindowBar window={OPENROUTER_WINDOW} value={window} onChoice={setWindow} />
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
          <Group title={t("Cost")}>
            <div className="px-3.5 py-3" data-or-cost>
              <div className="text-[22px] font-semibold tabular-nums tracking-tight">{usd(s?.costUsd, loc)}</div>
              {originSet && <div className="mt-0.5 text-[11.5px] text-dim" data-or-origin>{t("Runs: {set}", { set: originSet })}</div>}
              {(origin?.unknown ?? 0) > 0 && <div className="mt-0.5 text-[11.5px] text-warn">{t("incomplete — not every run has an amount")}</div>}
            </div>
          </Group>
          <div className="mt-5"><TokenSurface sums={s} subagentsShare={data.subagentsShare} /></div>
          <div className="mt-5">
            <ModelList models={data.models} kind="cost" subline={(m: UsageModel) => <PriceRow p={prices?.[`${OPENROUTER_ID}::${m.model}`]} />} />
          </div>
          <div className="mt-5"><ChatList chats={data.chats} additional={data.chatsAdditional} kind="cost" /></div>
          <div className="mt-5"><BackgroundList rows={data.background} kind="cost" /></div>
        </div>
      )}

      {history && history.points.length > 0 && (
        <div className="mt-5">
          <HistoryProgressBar title={t("Cost per day, 30 days")} points={history.points} value={(p) => p.costUsd} format={(n) => usd(n, loc)} />
        </div>
      )}
    </div>
  );
}
