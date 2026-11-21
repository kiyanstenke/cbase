"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSettings } from "@/components/settings/ProviderSettings";
import { AgentModelSettings } from "@/components/settings/AgentModelSettings";
import { AgentHooksSettings } from "@/components/settings/AgentHooksSettings";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { WorkflowsSettings } from "@/components/settings/WorkflowsSettings";
import { LanguageSettings } from "@/components/settings/LanguageSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { BrowserSettings } from "@/components/settings/BrowserSettings";
import { ChatSettings } from "@/components/settings/ChatSettings";
import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { EnvironmentSettings } from "@/components/settings/EnvironmentSettings";
import { AdministrationSettings } from "@/components/settings/AdministrationSettings";
import { ThirdPartyHints } from "@/components/settings/ThirdPartyHints";
import { Overline } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { useGateway } from "@/lib/gateway";
import { sheetTakesEscape } from "@/lib/escape-level";

function ProviderIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /><circle cx="8" cy="7" r="1.6" fill="currentColor" stroke="none" /><circle cx="16" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LanguageIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </svg>
  );
}

function HooksIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6a3 3 0 0 0-3 3v6a3 3 0 0 1-6 0V8" /><circle cx="6" cy="6" r="2" /><path d="M18 4v2" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20V10M10 20V4M16 20v-6M22 20H2" />
    </svg>
  );
}

function WorkflowsIcon() {
  // Three nodes converging: the same shape as a workflow graph, without its details.
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="6" height="5" rx="1.2" /><rect x="3" y="15" width="6" height="5" rx="1.2" /><rect x="15" y="9.5" width="6" height="5" rx="1.2" />
      <path d="M9 6.5h2.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9M13 12h2" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" stroke="none" /><circle cx="9" cy="6.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChatsIcon() {
  // A speech bubble with a filing-tray stroke: the page governs when chats move to the archive.
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z" /><path d="M9 11h6" />
    </svg>
  );
}

function BellSettingsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function AppearanceIcon() {
  // Two "A"s in two sizes — text size and color scheme live on this page.
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 18L8 6h1l5 12" /><path d="M5.2 14h6.6" /><path d="M14.5 18l2.7-6h.6l2.7 6" /><path d="M15.7 15.5h4.6" />
    </svg>
  );
}

function IntegrationsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4H7a3 3 0 0 0 0 6h3" /><path d="M14 20h3a3 3 0 0 0 0-6h-3" /><path d="M8 7h8a3 3 0 0 1 0 6H8" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" strokeWidth="2.4" />
    </svg>
  );
}

function AdministrationIcon() {
  // Two heads above a slider: users and what their container may do.
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="7" r="2.6" /><circle cx="16" cy="7" r="2.6" /><path d="M3.5 14.5a4.5 4.5 0 0 1 9 0" /><path d="M11.5 14.5a4.5 4.5 0 0 1 9 0" />
      <path d="M4 20h16" /><circle cx="14" cy="20" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HintsIcon() {
  // A sheet with an "i": hints, not a control.
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4" /><path d="M12.5 11v6" /><circle cx="12.5" cy="8.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

// `under`: the part after the colon of a jump (`integrations:ngrok`) — only a page with its own list reads it.
type Section = { key: string; label: string; icon: ReactNode; render: (under?: string) => ReactNode };

// Extensible: add further settings pages here — AND in a group below, otherwise the page appears nowhere. `label` is the
// dictionary key (t() at render); it also carries the page heading, see `SettingsModal`.
const SECTIONS: Section[] = [
  { key: "provider", label: "Providers", icon: <ProviderIcon />, render: () => <ProviderSettings /> },
  // Usage: five subpages — jump `usage:<subpage>`.
  { key: "usage", label: "Usage", icon: <UsageIcon />, render: (under) => <UsageSettings start={under} /> },
  // Integrations: its own list of services (GitLab, ngrok) with their logos, the chosen one on the right.
  { key: "integrations", label: "Integrations", icon: <IntegrationsIcon />, render: (under) => <IntegrationsSettings start={under} /> },
  // Gateway mode only (client/server): the own server environment (memory, status).
  { key: "environment", label: "Environment", icon: <ServerIcon />, render: () => <EnvironmentSettings /> },
  { key: "models", label: "Models", icon: <ModelsIcon />, render: () => <AgentModelSettings /> },
  { key: "hooks", label: "Hooks", icon: <HooksIcon />, render: () => <AgentHooksSettings /> },
  { key: "browser", label: "Browser", icon: <BrowserIcon />, render: () => <BrowserSettings /> },
  // Chats: auto-archive — global.
  { key: "chats", label: "Chats", icon: <ChatsIcon />, render: () => <ChatSettings /> },
  // Workflows: cap and size guideline of the dynamic workflows. The key is WORKFLOWS_PAGE (lib/api/usage.ts, bound to
  // the contract).
  { key: "workflows", label: "Workflows", icon: <WorkflowsIcon />, render: () => <WorkflowsSettings /> },
  { key: "appearance", label: "Appearance", icon: <AppearanceIcon />, render: () => <AppearanceSettings /> },
  { key: "notify", label: "Notifications", icon: <BellSettingsIcon />, render: () => <NotificationSettings /> },
  { key: "language", label: "Language", icon: <LanguageIcon />, render: () => <LanguageSettings /> },
  // Admins in gateway mode only: users and resources per container — replaces the separate page /gw/admin. The key is
  // ADMINISTRATION_PAGE (lib/api/administration.ts, bound to the contract).
  { key: "administration", label: "Admin", icon: <AdministrationIcon />, render: () => <AdministrationSettings /> },
];

// The third-party notices (Codicons, VS Code — lib/thirdParty.ts) — not a page of a group (the groups are bound to iOS,
// web/test/settings-form.test.mjs) but its own row BELOW the list, like "About".
const HINTS: Section = { key: "hints", label: "Third-Party Notices", icon: <HintsIcon />, render: () => <ThirdPartyHints /> };

/**
 * The order of the list — and the ONLY source of the sequence: below `md` the headings drop out and the entries become
 * a horizontal strip again, so the sequence alone carries the order. Ten entries in one column are a list, in three
 * groups they are an answer to "what am I looking for right now".
 *
 * The same set, the same sequence stand on mobile in `Settings/SettingsView.swift`.
 */
export const SETTINGS_GROUPS: { title: string; keys: string[] }[] = [
  { title: "Account & connections", keys: ["provider", "usage", "integrations", "environment"] },
  { title: "Behavior", keys: ["models", "hooks", "browser", "chats", "workflows"] },
  { title: "Appearance & device", keys: ["appearance", "notify", "language"] },
  // A group of its own at the end: it belongs to the server, not to the own account or device — and exists only for admins.
  { title: "Admin", keys: ["administration"] },
];

// `start`: the page the modal opens with (jump from outside through `openSettings`, lib/settings-jump.ts) — `page` or
// `page:under` (e.g. `integrations:ngrok`).
export function SettingsModal({ onClose, start }: { onClose: () => void; start?: string }) {
  const t = useT();
  const gw = useGateway();

  // "Environment" is in the list only in gateway mode, "Admin" only for a gateway admin; a group without entries drops
  // out entirely. Both conditions are the named exceptions in web/test/settings-form.test.mjs.
  const groups = useMemo(
    () =>
      SETTINGS_GROUPS.map((g) => ({
        title: g.title,
        entries: g.keys
          .map((k) => SECTIONS.find((s) => s.key === k))
          .filter((s): s is Section => !!s && (!!gw || s.key !== "environment") && (gw?.user.role === "admin" || s.key !== "administration")),
      })).filter((g) => g.entries.length > 0),
    [gw],
  );
  const flat = useMemo(() => [...groups.flatMap((g) => g.entries), HINTS], [groups]);

  const [startPage, startUnder] = (start ?? "").split(":");
  const [section, setSection] = useState<string>(startPage && SECTIONS.some((s) => s.key === startPage) ? startPage : SETTINGS_GROUPS[0].keys[0]);
  // If the modal is already open and a second jump comes, it follows.
  useEffect(() => { if (startPage && SECTIONS.some((s) => s.key === startPage)) setSection(startPage); }, [startPage]);
  // The page that REALLY stands — not `section`: a jump to a filtered page (`?settings=administration` as a non-admin)
  // falls back to the first, and highlight and cross-fade must follow this page, not `section`; otherwise "Providers" is
  // shown but no entry is highlighted. Guard: web/test/administration-proofread.test.mjs.
  const active = flat.find((s) => s.key === section) ?? flat[0];

  // Escape closes — unless a sheet on top has already taken it (kit `Modal` on `document`, `preventDefault`): otherwise
  // Escape in the admin's password sheet would close the WHOLE settings including the input (lib/escape-level.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (sheetTakesEscape(e)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A click outside closes — but only if the POINTER PRESS was outside too. A text selection that begins in a field of
  // the modal and ends over the veil is a click on the veil for the browser; without this check the sheet would close
  // with its input.
  const pressOnVeil = useRef(false);

  const entry = (s: Section) => {
    const on = s.key === active.key;
    return (
      <button
        key={s.key}
        onClick={() => setSection(s.key)}
        data-set-page={s.key}
        aria-current={on ? "page" : undefined}
        // `edge` means "selected": since the shell carries `cb-kit`, `hover` in light mode lies only two breaths from
        // `panel` — as an active state it would not be visible.
        //
        // `md:w-full` is necessary, not cosmetic: from `md` on the group wrapper is `display: block` (below it
        // `contents`), and a `<button>` in it is inline-block — it would shrink to its text and the highlight would end
        // mid-column. Below `md` it stays content-wide, because there it stands beside the others in the scrolling strip.
        className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-left text-[13.5px] font-medium transition-colors md:w-full md:shrink ${
          on ? "bg-edge text-fg" : "text-dim hover:bg-hover hover:text-fg"
        }`}
      >
        <span className={on ? "text-accent" : ""}>{s.icon}</span>
        {t(s.label)}
      </button>
    );
  };

  // Through a portal to the body, never in place: the modal is opened from the header, and the header is a drag region
  // (TopNav.tsx, `style={drag}`). Since Electron 44 (Chromium 152) `app-region` is INHERITED — measured: the `fixed
  // inset-0` veil as a child of the nav computes `drag` under 44 and `none` under 37 (Chromium 138). The whole window
  // was thus a drag region, which swallows every click and scroll before the renderer sees it: "the app freezes", in the
  // client, never in an ordinary browser. Outside the nav the veil inherits nothing. Guard: web/test/drag-region.test.mjs.
  // On the body it is `none` and subtracted nothing from the header: where the sheet reached into it (window height
  // under ~860 px), a click on "Close" dragged the window. `.cb-overlay` itself therefore carries `no-drag`
  // (globals.css) — for the duration of the modal the header is no grip.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="cb-overlay cb-overlay-in fixed inset-0 z-[60] grid place-items-center p-3 sm:p-6"
      onMouseDown={(e) => { pressOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressOnVeil.current) onClose(); }}
    >
      {/* Below md the dialog flips from "sidebar + content" to "tab strip above content": at 420 px window width only
          ~160 px would remain beside the sidebar for the content — formally no overflow, but unusable. The strip
          scrolls horizontally (cb-strip). `cb-kit` on the shell: the cool color roles must apply in the modal — the two
          glass surfaces in it (Notifications, Hooks) are not built for the warm house palette. */}
      <div
        className="cb-kit cb-sheet cb-pop-in flex h-[720px] max-h-[92vh] w-[min(1040px,calc(100vw-1.5rem))] max-w-[94vw] flex-col overflow-hidden rounded-3xl md:flex-row"
        role="dialog"
        aria-modal="true"
        aria-label={t("Settings")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar (from md) or tab strip (below) */}
        <aside className="flex shrink-0 flex-col border-b border-edge bg-bg/60 p-2 md:w-[236px] md:overflow-y-auto md:border-b-0 md:border-r md:p-3">
          <div className="hidden px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-dim md:block">{t("Settings")}</div>
          {/* ONE list, two forms: below md the group wrapper is `display: contents`, so its buttons become children of the
              scrolling strip themselves and the heading drops out. Two separate versions would have put every button
              into the DOM twice. */}
          <nav className="cb-strip flex gap-0.5 overflow-x-auto md:flex-1 md:flex-col md:gap-0 md:overflow-visible">
            {groups.map((g) => (
              <div key={g.title} className="contents md:mt-4 md:block md:space-y-0.5 md:first:mt-0">
                <div className="hidden md:block"><Overline>{t(g.title)}</Overline></div>
                {g.entries.map(entry)}
              </div>
            ))}
            {/* Below the list (from md at the foot of the column, below at the end of the strip): the third-party notices. */}
            <div className="contents md:mt-auto md:block md:pt-4" data-set-footer>{entry(HINTS)}</div>
          </nav>
        </aside>

        {/* Content: header with icon and name of the open page, below it the stage. The close cross used to float above
            the content without reference and, depending on the page, lay over its first row. */}
        <div className="cb-kit-stage flex min-w-0 flex-1 flex-col bg-panel">
          <header className="flex shrink-0 items-center gap-2.5 border-b border-edge px-4 py-3 sm:px-6">
            <span className="shrink-0 text-accent">{active.icon}</span>
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{t(active.label)}</h2>
            <button
              onClick={onClose}
              title={t("Close (Esc)")}
              aria-label={t("Close (Esc)")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
            </button>
          </header>
          {/* Container queries instead of window queries: the same content area is about 800 px wide beside the sidebar
              and as wide as the window below md.

              The pages fill the stage completely. Before, each carried its own reading width between 560 and 760 px —
              on "Models" that left 150 px of empty space right of every row while the hints wrapped on the left. The
              chat has a reading column because it holds running text; here stand rows with a control at the right
              edge, and the width is capped by the modal anyway. */}
          <div className="@container/kit min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <AnimatedSwitch token={active.key}>{active.render(active.key === startPage ? startUnder : undefined)}</AnimatedSwitch>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
