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

// The original logos, both the unchanged Simple Icons drawing (CC0) — the same one the iOS app ships as an asset, so web and iOS show
// the same mark. GitLab: the single-colour tanuki in the brand orange — the same on light and dark ground. ngrok: the wordmark, single
// colour in `currentColor`, so black in light and white in dark, as ngrok itself shows it. The viewBox of the wordmark is cropped to it
// (the source sits centred in 24 × 24).
export function GitlabLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#FC6D26" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
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
