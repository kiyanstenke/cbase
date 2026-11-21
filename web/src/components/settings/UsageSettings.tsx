"use client";

import { useEffect, useState, type ReactNode } from "react";
import { USAGE_SUBPAGES, SUBPAGE_LABEL, isSubpage, type UsageSubpage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { AnthropicMark, OpenAIMark, OpenRouterMark } from "@/components/ProviderMarks";
import { UsageOverview } from "@/components/settings/UsageOverview";
import { UsageSubscription } from "@/components/settings/UsageSubscription";
import { UsageOpenRouter } from "@/components/settings/UsageOpenRouter";
import { UsageLimit } from "@/components/settings/UsageLimit";

// Settings → Usage: five subpages modeled on Integrations — the list on the left (from 600 px stage width, below it a
// horizontal strip), the chosen one on the right. The keys and their order are those of the contract (`USAGE_SUBPAGES`,
// account/usage-contract.js, bound in web/test/usage-binding.test.mjs); a jump from outside is called
// `usage:<subpage>` (`usageJump`; the rings of the header jump to Claude or Codex that way).
//
// The settings of the dynamic workflows live under Behavior → Workflows (WorkflowsSettings.tsx); there is no price
// table (the equivalent prices come from the OpenRouter catalog, OpenRouter reports its cost itself). Each subpage
// loads on its own; the frame holds only the choice — the unchosen content is not mounted and queries nothing.

function OverviewCharacter({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function LimitCharacter({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 12l4-4" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

const CHARACTER: Record<UsageSubpage, (large: boolean) => ReactNode> = {
  overview: (g) => <OverviewCharacter size={g ? 22 : 17} />,
  claude: (g) => <AnthropicMark size={g ? 22 : 17} />,
  codex: (g) => <OpenAIMark size={g ? 21 : 16} />,
  openrouter: (g) => <OpenRouterMark size={g ? 22 : 17} />,
  limit: (g) => <LimitCharacter size={g ? 22 : 17} />,
};

/**
 * The content per subpage — as a `Record` over the keys of the contract, not as a chain of comparisons: a new subpage in
 * the contract (and thus in `USAGE_SUBPAGES`) is a type error here instead of silently landing in the last branch.
 */
const CONTENT: Record<UsageSubpage, (go: (u: UsageSubpage) => void) => ReactNode> = {
  overview: (go) => <UsageOverview onGo={go} />,
  claude: () => <UsageSubscription key="claude" provider="claude" />,
  codex: () => <UsageSubscription key="codex" provider="codex" />,
  openrouter: () => <UsageOpenRouter />,
  limit: () => <UsageLimit />,
};

/** The line below the name of the chosen subpage (header as in Integrations) — what stands there, in one sentence. */
const SUBLINE: Record<UsageSubpage, string> = {
  overview: "Quotas, cost and waiting runs at a glance",
  claude: "Subscription — usage, API equivalent and limits",
  codex: "Subscription — usage, API equivalent and quota",
  openrouter: "Billed by usage — cost and credits",
  limit: "Behavior at the limit and waiting runs",
};

export function UsageSettings({ start }: { start?: string }) {
  const t = useT();
  const [choice, setChoice] = useState<UsageSubpage>(isSubpage(start) ? start : USAGE_SUBPAGES[0]);
  // If a jump comes from outside while the page is already open, it follows.
  useEffect(() => { if (isSubpage(start)) setChoice(start); }, [start]);

  return (
    <div className="flex flex-col gap-4 @[600px]/kit:flex-row @[600px]/kit:items-start @[600px]/kit:gap-6">
      <nav
        aria-label={t("Usage")}
        className="cb-strip flex shrink-0 gap-1 overflow-x-auto @[600px]/kit:sticky @[600px]/kit:top-0 @[600px]/kit:w-[208px] @[600px]/kit:flex-col @[600px]/kit:overflow-visible"
        data-usage-list
      >
        {USAGE_SUBPAGES.map((u) => {
          const on = u === choice;
          return (
            <button
              key={u}
              type="button"
              onClick={() => setChoice(u)}
              aria-current={on ? "page" : undefined}
              data-usage-subpage={u}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors @[600px]/kit:w-full ${
                on ? "bg-edge" : "hover:bg-hover"
              }`}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-edge bg-panel text-fg">{CHARACTER[u](false)}</span>
              <span className={`truncate text-[13.5px] font-medium ${on ? "text-fg" : "text-fg/90"}`}>{t(SUBPAGE_LABEL[u])}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1">
        <AnimatedSwitch token={choice}>
          <div className="mb-5 flex items-center gap-3" data-usage-header={choice}>
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-edge bg-panel text-fg">{CHARACTER[choice](true)}</span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-tight">{t(SUBPAGE_LABEL[choice])}</div>
              <div className="truncate text-[12px] text-dim">{t(SUBLINE[choice])}</div>
            </div>
          </div>
          {CONTENT[choice](setChoice)}
        </AnimatedSwitch>
      </div>
    </div>
  );
}
