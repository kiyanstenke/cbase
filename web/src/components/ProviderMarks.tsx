// The marks of the providers: neutral glyphs, no company logos. ONE source for all places (provider settings, usage rings in the
// header, usage tab, chat tooltip, runs pill); the same path data lives as SVG assets in the iOS app (ProviderMark, assets
// ProviderClaude/ProviderCodex). Why no logos: the Anthropic and OpenAI marks may only be used with the owner's permission (Anthropic:
// prior approval, no alteration; OpenAI: permission is personal and not transferable, which is why Simple Icons dropped the OpenAI
// mark in 16.0.0) — a public repository cannot pass either on. The list of third-party marks that do ship: TRADEMARKS.md.
// All three draw in `currentColor`, so they follow the text colour in light and dark.

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Claude Code (provider `claude`): a speech bubble — the conversational agent. */
export function AnthropicMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.5L7 21v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

/** Codex (provider `codex`): code brackets. */
export function OpenAIMark({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 4.5l-3 15" />
    </svg>
  );
}

/**
 * OpenRouter, the third FIXED provider. Not a company logo but a neutral mark of what OpenRouter is: one route with
 * three targets.
 */
export function OpenRouterMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <circle cx="4.5" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <path d="M6.5 12h4M10.5 12c2.5 0 3.5-6 7-6M10.5 12c2.5 0 3.5 6 7 6M10.5 12h7" />
      <circle cx="19.5" cy="6" r="1.4" /><circle cx="19.5" cy="12" r="1.4" /><circle cx="19.5" cy="18" r="1.4" />
    </svg>
  );
}

/// Mark by provider identifier: `codex` is Codex, `openrouter` OpenRouter, anything else Claude.
export function ProviderMark({ provider, size }: { provider: string; size?: number }) {
  if (provider === "openrouter") return <OpenRouterMark size={size} />;
  return provider === "codex" || provider === "openai" ? <OpenAIMark size={size} /> : <AnthropicMark size={size} />;
}
