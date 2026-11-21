"use client";

// "Share link" on a service row of the services pill.
//
// Two parts, so the pill row keeps its shape:
//  · `PreviewButton` sits IN the row (icon, right) and unfolds/folds the area below. It shows only for a service with a port,
//    only once the state is loaded (before that it claims nothing) and only while the row has no active link.
//  · `PreviewArea` sits BELOW the row: the active link (address, remaining time, copy, revoke) or — unfolded — the menu with the
//    visibility sentences and ONE row below: the duration as segments "1 day · 7 days · 30 days · ∞" (7 preselected) and "Create" on the right.
//
// The menu unfolds IN PLACE (`data-open`) instead of floating as its own `cb-pop` over the ports menu: the ports menu scrolls
// (`overflow-y-auto`) and would clip an absolutely positioned child, and a portal on the body would sit outside
// `[data-status-ports-pop]` — the pill's click catcher would take every click on it for "outside" and close everything.
//
// Without access the area leads to Settings (Integrations → ngrok). At the plan limit it lists the active links
// (project · service · address) with "Revoke" — they often sit on no visible row. This file never sees the access values.
//
// The area reports the results of create and revoke UPWARD (`onNotice`), not into its own state: the answer can arrive when the
// menu is already closed or another row is unfolded — this area is then gone or shows nothing, and a 502 would vanish without a
// trace. The pill holds the message until the ports menu has shown it. For the same reason `onClose` closes only the OWN menu
// (the caller compares the key).
//
// `instanceStopped`: the link's instance is not running — the link stays, visitors see 502 "Instance stopped". The row then
// shows the neutral dot and exactly that sentence instead of the green "online" (whoever shared it would otherwise pass around a 502 page).
import { useState } from "react";
import { setUpPreviewLink, normPreviewLink, revokePreviewLink, PREVIEW_VALIDITIES, PREVIEW_VALIDITY_DEFAULT, type PreviewValidity, type PreviewLink, type PreviewStatus } from "@/lib/api";
import { linkErrorShown, validityText, shortAddress, remainingTime, remainingTimeText, shareSituation } from "@/lib/preview-links";
import { openSettings } from "@/lib/settings-jump";
import { useT } from "@/lib/i18n";
import { Segments } from "@/components/CbKit";

const SymbolShare = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
  </svg>
);

const SMALL = "shrink-0 rounded-full px-1.5 py-0.5 text-[11px]";
/** Key of a duration in the segments (and at the test rig: `data-preview-days`). */
const daysKey = (g: PreviewValidity) => (g == null ? "unlimited" : String(g));

export function PreviewButton({ state, port, link, open, onToggle }: {
  state: PreviewStatus | null;
  port: number | null | undefined;
  link: PreviewLink | null;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  if (!state || port == null || link) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      data-preview-share
      aria-expanded={open}
      title={t("Share link")}
      aria-label={t("Share link")}
      className={`${SMALL} flex items-center ${open ? "bg-hover text-fg" : "text-dim hover:bg-hover hover:text-fg"}`}
    >
      <SymbolShare />
    </button>
  );
}

export function PreviewArea({ state, projectId, instance, serviceId, link, open, onClose, takeOver, onNotice, instanceStopped = false }: {
  state: PreviewStatus | null;
  projectId: string;
  /** `undefined` = instance not known yet (nothing goes out), `null` = not relocated. */
  instance: string | null | undefined;
  serviceId: number;
  link: PreviewLink | null;
  open: boolean;
  /** Closes ONLY this menu — if another row has been unfolded meanwhile, it stays open. */
  onClose: () => void;
  takeOver: (l: PreviewLink) => void;
  /** Result of an action that the pill holds (`""` withdraws an old message). */
  onNotice: (text: string) => void;
  /** The link's instance is stopped (stopping, starting) — neutral dot and "Instance stopped". */
  instanceStopped?: boolean;
}) {
  const t = useT();
  const [days, setDays] = useState<PreviewValidity>(PREVIEW_VALIDITY_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function create() {
    if (instance === undefined) return;
    setBusy(true);
    onNotice("");
    try {
      const l = await setUpPreviewLink({ projectId, instance, serviceId, validDays: days });
      takeOver(l);
      onClose();
    } catch (e) {
      // 502 NGROK carries the ended link along — it belongs in the history; the server's sentence goes to the pill.
      const including = normPreviewLink((e as { link?: unknown })?.link);
      if (including) takeOver(including);
      onNotice(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(l: PreviewLink) {
    setBusy(true);
    onNotice("");
    try {
      const r = await revokePreviewLink(l.id);
      if (r) takeOver(r);
    } catch (e) {
      onNotice(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("Copying isn't possible — the address can be selected."));
    }
  }

  if (link) {
    const rest = remainingTimeText(remainingTime(link.runningSinceAt, Date.now()), t);
    const point = instanceStopped ? "border border-edge" : link.state === "online" ? "bg-ok" : link.state === "error" ? "bg-danger" : "border border-edge";
    return (
      <div className="pb-1.5 pl-5 pr-2" data-preview-link={link.id} data-preview-state={link.state} data-preview-instance-stopped={instanceStopped ? "1" : undefined}>
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${point}`} />
          {link.url ? (
            <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[11px] text-accent hover:underline" title={link.url}>
              {shortAddress(link.url)}
            </a>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{link.state === "start" ? t("Creating link …") : t("no address")}</span>
          )}
          {instanceStopped && <span className="shrink-0 text-[10px] text-dim" data-preview-stopped>{t("Instance stopped")}</span>}
          <span className="shrink-0 text-[10px] tabular-nums text-dim" data-preview-rest>{rest}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          {link.url && (
            <button type="button" onClick={() => void copy(link.url)} className={`${SMALL} text-accent hover:bg-hover`} data-preview-copy>
              {copied ? t("Copied") : t("Copy")}
            </button>
          )}
          <button type="button" onClick={() => void revoke(link)} disabled={busy} className={`${SMALL} text-dim hover:bg-hover hover:text-danger disabled:opacity-50`} data-preview-revoke>
            {busy ? t("…") : t("Revoke")}
          </button>
        </div>
        {link.state === "error" && link.error && <div className="mt-0.5 text-[11px] text-danger">{linkErrorShown(link.error, t)}</div>}
        {error && <div className="mt-0.5 text-[11px] text-danger">{error}</div>}
      </div>
    );
  }

  if (!open) return null;
  const situation = shareSituation(state);
  return (
    <div className="mx-2 mb-1.5 rounded-xl border border-edge px-2.5 py-2" data-open data-preview-menu data-preview-situation={situation}>
      <div className="text-[11px] leading-snug text-dim">{t("Anyone with the link sees the app without signing in to cbase.")}</div>
      {state?.mode === "dev" && (
        <div className="mt-1 text-[11px] leading-snug text-dim">{t("Free plan: always the same address, one link at a time; visitors first see an ngrok warning page.")}</div>
      )}

      {situation === "loading" && <div className="mt-2 text-[11px] text-dim">{t("…")}</div>}
      {situation === "without-sdk" && <div className="mt-2 text-[11px] text-warn">{t("The ngrok module is missing in this cbase environment.")}</div>}
      {situation === "without-access" && (
        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] text-dim">{t("This needs an ngrok authtoken.")}</span>
          <button
            type="button"
            onClick={() => { onClose(); openSettings("integrations:ngrok"); }}
            data-preview-settings
            className={`${SMALL} border border-edge text-fg hover:bg-hover`}
          >
            {t("Store it in settings")}
          </button>
        </div>
      )}
      {situation === "limit" && state && (
        <>
          <div className="mt-2 text-[11px] text-warn" data-preview-limit>
            {state.mode === "dev"
              ? t("Free plan: one link at a time — revoke the active one first")
              : t("{n} of {g} links active (ngrok Hobbyist)", { n: state.active.length, g: state.limit })}
          </div>
          {/* The way to the active link: it often sits on no visible row (other workspace, stopped service). */}
          <div className="mt-1" data-preview-limit-left>
            {state.active.map((a) => (
              <div key={a.id} className="flex items-center gap-1.5 py-0.5" data-preview-limit-link={a.id}>
                <span className="min-w-0 flex-1 truncate text-[11px]" title={a.url || undefined}>
                  {[a.projectName, a.serviceName, a.url ? shortAddress(a.url) : t("no address")].filter(Boolean).join(" · ")}
                </span>
                <button type="button" onClick={() => void revoke(a)} disabled={busy} className={`${SMALL} text-dim hover:bg-hover hover:text-danger disabled:opacity-50`} data-preview-revoke>
                  {busy ? t("…") : t("Revoke")}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {situation === "ready" && (
        <>
          {/* ONE row: the duration as kit segments, "Create" beside it. The segments show only the NUMBER (1 · 7 · 30 · ∞), the unit
              stands once before them ("days"), the full word in the title: spelled out, the bar was ~213 px wide and overflowed the
              340 px services pill together with the button. The bar sits in a `min-w-0` box (its `max-w-full` then applies to that
              width): when it gets tighter still, it scrolls (kit) instead of sticking out. */}
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-dim">{t("days")}</span>
            <div className="min-w-0">
              <Segments
                label={t("Valid for")}
                items={PREVIEW_VALIDITIES.map((g) => ({
                  key: daysKey(g),
                  label: g == null ? "∞" : String(g),
                  title: validityText(g, t),
                  data: { "data-preview-days": daysKey(g) },
                }))}
                value={daysKey(days)}
                onChange={(k) => setDays(PREVIEW_VALIDITIES.find((g) => daysKey(g) === k) ?? PREVIEW_VALIDITY_DEFAULT)}
              />
            </div>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || instance === undefined}
              data-preview-create
              className="ml-auto shrink-0 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t("Creating …") : t("Create")}
            </button>
          </div>
          {instance === undefined && <div className="mt-1.5 text-[11px] text-dim">{t("Determining instance …")}</div>}
        </>
      )}
      {error && <div className="mt-1.5 text-[11px] text-danger" data-preview-error>{error}</div>}
    </div>
  );
}
