"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, loadNgrokAccess, type GitlabAccount, type NgrokAccess } from "@/lib/api";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { GitlabSettings } from "@/components/settings/GitlabSettings";
import { NgrokSettings } from "@/components/settings/NgrokSettings";
import { NGROK_ACCESS_CHANGED } from "@/lib/preview-links";
import { useT } from "@/lib/i18n";

// Settings → Integrations (the services you can connect cbase to, each with its original logo as SVG). On the left the services with
// logo and state, on the right the chosen one — each service its own component (`GitlabSettings`, `NgrokSettings`), the page holds
// only the choice and the list's state. A new service is one row in `SERVICES` plus its component below.
//
// The page loads the list's state itself, because the service not chosen is not mounted. After that it follows the services: GitLab
// reports its accounts after every load (`onAccounts`), ngrok through the window event that `NgrokSettings` throws after every save.
// `null` means "not loaded yet" — never "not connected".
//
// Below 600 px stage width (phone width, narrow window) the list becomes a horizontal bar above the service.

type ServiceKey = "gitlab" | "ngrok";
const isService = (k: string | undefined): k is ServiceKey => k === "gitlab" || k === "ngrok";

// The original logos. GitLab: the tanuki from the press kit (about.gitlab.com/press/press-kit) in its four brand colours — the same on
// light and dark ground. ngrok: the wordmark from ngrok.com (path via Simple Icons), single colour in `currentColor`, so black in
// light and white in dark, as ngrok itself shows it. The viewBox is cropped to the wordmark (the source sits centred in 24 × 24).
export function GitlabLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="m31.46 12.78-.04-.12-4.35-11.35A1.14 1.14 0 0 0 25.94.6c-.24 0-.47.1-.66.24-.19.15-.33.36-.39.6l-2.94 9h-11.9l-2.94-9A1.14 1.14 0 0 0 6.07.58a1.15 1.15 0 0 0-1.14.72L.58 12.68l-.05.11a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48 6.67-5h.02a8.09 8.09 0 0 0 2.7-9.36Z" fill="#E24329" />
      <path d="m31.46 12.78-.04-.12a14.75 14.75 0 0 0-5.86 2.64l-9.55 7.24 6.09 4.6 6.67-5h.02a8.09 8.09 0 0 0 2.67-9.36Z" fill="#FC6D26" />
      <path d="m9.9 27.14 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48-6.1-4.6-6.07 4.6Z" fill="#FCA326" />
      <path d="M6.44 15.3a14.71 14.71 0 0 0-5.86-2.63l-.05.12a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 6.1-4.6-9.56-7.24Z" fill="#FC6D26" />
    </svg>
  );
}

export function NgrokLogo({ width = 26 }: { width?: number }) {
  return (
    <svg width={width} height={(width * 9.2) / 24} viewBox="0 7.4 24 9.2" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M18.951 7.598v6.713h1.463v-1.69l1.61 1.69H24v-.08l-2.123-2.153 2.002-1.846v-.07H21.95l-1.537 1.496v-4.06zm-2.93 2.41a2.626 2.626 0 00-1.787.635 2.049 2.049 0 00-.703 1.556c-.002.75.311 1.287.7 1.643.526.478 1.221.626 1.767.623.666 0 1.34-.195 1.805-.62.521-.483.713-1.029.713-1.607 0-.73-.31-1.247-.71-1.603-.553-.475-1.202-.628-1.785-.627zm-9.062.039c-1.188-.005-2.1.977-2.104 2.25-.004 1.296.908 2.108 2.032 2.096.664.002.983-.244 1.308-.541v1.193h-1.37l-1.03 1.158v.2H9.66v-6.24H8.195v.435c-.381-.408-.772-.542-1.236-.551zm-4.805.11l-.691.786v-.771H0v4.15h1.463v-2.799c.547.002 1.023-.002 1.49-.003v2.802h1.465v-2.595c-.004-.547-.1-.819-.307-1.061a1.431 1.431 0 00-.914-.51zm8.114.005v4.15h1.468l.002-2.779h1.065l1.164-1.314v-.057h-1.598l-.635.715v-.715zm-2.946 1.115c.504 0 .96.444.948.948a.956.956 0 01-.948.945c-.523 0-.931-.403-.947-.945-.002-.52.443-.94.947-.948zm8.703.001c.525 0 .94.434.944.95-.027.544-.42.95-.944.95s-.934-.417-.95-.95a.955.955 0 01.95-.95z" />
    </svg>
  );
}

const SERVICES: { key: ServiceKey; name: string; logo: (large: boolean) => ReactNode }[] = [
  { key: "gitlab", name: "GitLab", logo: (large) => <GitlabLogo size={large ? 26 : 19} /> },
  { key: "ngrok", name: "ngrok", logo: (large) => <span className="text-fg"><NgrokLogo width={large ? 34 : 26} /></span> },
];

type Situation = { text: string; tone: "ok" | "off" | "error" | "open" };

function Point({ tone }: { tone: Situation["tone"] }) {
  const cls = tone === "ok" ? "bg-ok" : tone === "error" ? "bg-danger" : "border border-dim/60";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

export function IntegrationsSettings({ start }: { start?: string }) {
  const t = useT();
  const [choice, setChoice] = useState<ServiceKey>(isService(start) ? start : "gitlab");
  // If a jump comes from outside while the page is already open, it follows.
  useEffect(() => { if (isService(start)) setChoice(start); }, [start]);

  const [accounts, setAccounts] = useState<GitlabAccount[] | null>(null);
  const [access, setAccess] = useState<NgrokAccess | null>(null);
  const loadNgrok = useCallback(() => { loadNgrokAccess().then(setAccess).catch(() => {}); }, []);
  useEffect(() => {
    api<{ accounts: GitlabAccount[] }>("/api/gitlab/accounts").then((r) => setAccounts(r.accounts)).catch(() => {});
    loadNgrok();
    window.addEventListener(NGROK_ACCESS_CHANGED, loadNgrok);
    return () => window.removeEventListener(NGROK_ACCESS_CHANGED, loadNgrok);
  }, [loadNgrok]);

  const situation = (k: ServiceKey): Situation => {
    if (k === "gitlab") {
      if (!accounts) return { text: t("…"), tone: "open" };
      if (accounts.some((a) => a.status)) return { text: t("Error on an account"), tone: "error" };
      if (accounts.length === 0) return { text: t("not connected"), tone: "off" };
      return { text: accounts.length === 1 ? t("1 account connected") : t("{n} accounts connected", { n: accounts.length }), tone: "ok" };
    }
    if (!access) return { text: t("…"), tone: "open" };
    if (access.error) return { text: t("Access error"), tone: "error" };
    if (!access.authtoken) return { text: t("not connected"), tone: "off" };
    return { text: access.mode === "names" ? t("own name per link") : t("dev address only"), tone: "ok" };
  };
  const active = SERVICES.find((d) => d.key === choice) ?? SERVICES[0];
  const activeSituation = situation(active.key);

  return (
    <div className="flex flex-col gap-4 @[600px]/kit:flex-row @[600px]/kit:items-start @[600px]/kit:gap-6">
      <nav
        aria-label={t("Services")}
        className="cb-strip flex shrink-0 gap-1 overflow-x-auto @[600px]/kit:sticky @[600px]/kit:top-0 @[600px]/kit:w-[208px] @[600px]/kit:flex-col @[600px]/kit:overflow-visible"
        data-integrations-list
      >
        {SERVICES.map((d) => {
          const on = d.key === choice;
          const l = situation(d.key);
          return (
            <button
              key={d.key}
              onClick={() => setChoice(d.key)}
              aria-current={on ? "page" : undefined}
              data-integration={d.key}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors @[600px]/kit:w-full ${
                on ? "bg-edge" : "hover:bg-hover"
              }`}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-edge bg-panel">{d.logo(false)}</span>
              <span className="flex min-w-0 flex-col">
                <span className={`truncate text-[13.5px] font-medium ${on ? "text-fg" : "text-fg/90"}`}>{d.name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-dim">
                  <Point tone={l.tone} />
                  <span className="truncate">{l.text}</span>
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1">
        <AnimatedSwitch token={choice}>
          <div className="mb-5 flex items-center gap-3" data-integration-header={active.key}>
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-edge bg-panel">{active.logo(true)}</span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-tight">{active.name}</div>
              <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-dim">
                <Point tone={activeSituation.tone} />
                <span className="truncate">{activeSituation.text}</span>
              </div>
            </div>
          </div>
          {active.key === "gitlab" ? <GitlabSettings onAccounts={setAccounts} /> : <NgrokSettings />}
        </AnimatedSwitch>
      </div>
    </div>
  );
}
