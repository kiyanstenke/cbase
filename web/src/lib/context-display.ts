// The context bar under the composer: denominator, share and the provider of the last answer.
//
// OpenRouter picks the provider PER REQUEST (by price and load), and its window can be far below the catalog number
// (GLM 5.3 Flash: 1,048,576 in the catalog, Reka 262,144). The bar therefore names the provider that delivered the LAST answer
// and computes its share against ITS window — "Context 26k / 1.05 M · DeepInfra · 2 %". CALCULATION still uses the catalog number
// (transcript budget in runs/do-run.js, compaction within the run in providers/engine.js `contextWindowOf`, autocompact in
// runs/post-run.js `contextWindowForChat`) — the title says so. The server delivers name and window on the chat (`upstreamProvider`,
// `upstreamWindow`) and in the stream (`harness/provider`).
//
// The rule, exactly (twin: mobile/CbaseMobile/Chat/ContextDisplay.swift, bound in
// web/test/context-display-binding.test.mjs):
//   • without a provider (empty or only whitespace) the denominator is the catalog number and the visible text EXACTLY as before
//     ("Context {used} / {total} · {pct} %");
//   • with a provider AND a known window (> 0) the denominator is its window, with a provider and an unknown window (0)
//     the catalog number — the name is shown in both cases;
//   • `share` = tokens / denominator, clamped to [0, 1] (0 without a denominator); `percent` = rounded (half up), at most 100;
//   • `title`: "" without a provider, "window" with a known, "unknown" with an unknown window — the sentences live in the
//     surfaces (i18n), the choice here;
//   • the autocompact marker stays at its token threshold (calculated with the catalog number) and is positioned on the
//     DISPLAYED denominator: `markerOnDenominator(share of the catalog)` = share × catalog / denominator, on [0, 1].

export type ContextTitle = "" | "window" | "unknown";

export interface ContextDisplay {
  /** The denominator of the bar: the provider's window, else the catalog number. */
  denominator: number;
  /** The provider of the last answer ("" = none known). */
  provider: string;
  /** Tokens / denominator on [0, 1]. */
  share: number;
  /** Rounded percent, at most 100. */
  percent: number;
  /** The catalog number — cbase calculates with it. */
  catalogWindow: number;
  title: ContextTitle;
}

const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function contextDisplay(e: { tokens: number; catalogWindow: number; provider?: string | null; providerWindow?: number | null }): ContextDisplay {
  const provider = String(e.provider ?? "").trim();
  const catalogWindow = whole(e.catalogWindow);
  const own = provider ? whole(e.providerWindow) : 0;
  const denominator = own || catalogWindow;
  const tokens = whole(e.tokens);
  const share = denominator > 0 ? Math.min(1, tokens / denominator) : 0;
  const percent = Math.min(100, Math.round(share * 100));
  const title: ContextTitle = !provider ? "" : own > 0 ? "window" : "unknown";
  return { denominator, provider, share, percent, catalogWindow, title };
}

/** The autocompact marker on the displayed denominator: its share OF THE CATALOG, converted; [0, 1]. */
export function markerOnDenominator(shareOfCatalog: number, catalogWindow: number, denominator: number): number {
  const a = Number.isFinite(shareOfCatalog) && shareOfCatalog > 0 ? shareOfCatalog : 0;
  const k = whole(catalogWindow);
  const n = whole(denominator);
  const r = k > 0 && n > 0 ? (a * k) / n : a;
  return Math.max(0, Math.min(1, r));
}

/**
 * The title (tooltip) of the bar, translated through `t` — "" without a provider. It says honestly WHOSE window the denominator is and
 * what cbase calculates with; `fmt` is the token format of the chat (`fmtTokens` from components/chat/ChatCatalog.tsx).
 */
export function contextTitleText(a: ContextDisplay, t: (key: string, params?: Record<string, string | number>) => string, fmt: (n: number) => string): string {
  if (a.title === "window") return t("Window of {provider}, the provider of the last response. cbase calculates with {catalog}.", { provider: a.provider, catalog: fmt(a.catalogWindow) });
  if (a.title === "unknown") return t("{provider} delivered the last response; its window is unknown. cbase calculates with {catalog}.", { provider: a.provider, catalog: fmt(a.catalogWindow) });
  return "";
}
