import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { PromptProvider } from "@/components/Prompts";
import { BootSplash } from "@/components/BootSplash";
import { RouteTransition } from "@/components/RouteTransition";
import { ServiceToasts } from "@/components/ServiceToasts";
import { AdjustSelection, AdjustToast } from "@/components/TextAdjust";
import { TextSizeHint } from "@/components/TextSize";
import { GatewayGate } from "@/lib/gateway";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { LANG_INIT_SCRIPT } from "@/lib/i18n";
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance";
import { ACCENT_INIT_SCRIPT } from "@/lib/accent";

export const metadata: Metadata = {
  title: "cbase",
  description: "Private coding agent harness (Claude & Codex)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning on <html>: THEME_INIT_SCRIPT sets data-theme BEFORE hydration. Without the flag React treats that
  // as a mismatch (#418), discards the server markup and drops data-theme, so the app stays light despite "dark".
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The boot splash shows from frame 1, so its lens must be requested BEFORE first paint, else it shows only the text for a blink. */}
        <link rel="preload" as="image" href="/cbase-lens.png" />
      </head>
      {/* suppressHydrationWarning: browser extensions inject attributes into the body tag.
          `cb-flat` on the body: the flat form of menus, modals, scrims and cards (globals.css, `.cb-flat …`) applies
          EVERYWHERE, including every sheet hung at the body via portal. */}
      <body className="cb-flat flex h-screen flex-col overflow-hidden" suppressHydrationWarning>
        {/* Set theme, language and text size BEFORE first paint (no light flash, no wrong language, no jump on load). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LANG_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: ACCENT_INIT_SCRIPT }} />
        <BootSplash />
        {/* ⌘+ / ⌘− / ⌘0 in the client: BEFORE the GatewayGate so the text size gets the keys during login and environment
            start too (else only zoom would work there). Renders only the pill. */}
        <TextSizeHint />
        {/* Gateway gate: without a gateway it renders straight through; in client/server operation it puts login → environment
            start in front of the app (the BootSplash masks the check). */}
        <PromptProvider>
          <GatewayGate>
            <TopNav />
            {/* The frame (see `.cb-frame` in globals.css): header, rail and the ground behind the card share ONE colour
                (`bg-frame`); the page sits in it as a card, rounded 12 px on all four corners, with a hairline edge, and lifted
                3 px from the BOTTOM and RIGHT window edge (top and left are separated by header and rail).
                The rail (`cbase-rail`, 52 px) is on EVERY page, even without entries (skills, apps, profile), so the card does
                not jump on page change. The page fills it via portal (`SymbolRail`). It lies OUTSIDE the header and thus
                outside its drag region.
                The page change (`RouteTransition`) fades in INSIDE the card: frame and corner stay put.
                `data-content-card`: floating cards such as the chat list tooltip (chat/ChatTooltip.tsx) clamp to its edge, not the window's. */}
            <div className="flex min-h-0 flex-1 bg-frame">
              <div id="cbase-rail" className="cb-frame cb-strip flex w-[52px] shrink-0 flex-col overflow-y-auto" />
              <div data-content-card className="mb-[3px] mr-[3px] flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[12px] border border-frame-edge bg-bg">
                <RouteTransition>{children}</RouteTransition>
              </div>
            </div>
            <ServiceToasts />
            <AdjustSelection />
            <AdjustToast />
          </GatewayGate>
        </PromptProvider>
      </body>
    </html>
  );
}
