"use client";

import { useCallback, useEffect, useState } from "react";
import { primary, Toggle } from "@/components/CbKit";
import { Group, Preview, Row } from "@/components/settings/SettingsKit";
import { useT } from "@/lib/i18n";
import {
  loadNotify, loadPushDevices, saveNotify, testPush,
  type NotifyKind, type PushDevice, type PushInfo,
} from "@/lib/notify";

// Settings page "Notifications": the global defaults per kind — and the device status. The second part is not an
// extra: without it a silent push cannot be told from a disabled one, because the APNs response only landed in the
// gateway's console.error.
//
// Installation-wide, not per workspace: the devices that get delivered to are too.
//
// At the top sits a PREVIEW: eleven toggles answer "what reaches me" only if you read them all. The card shows the
// first enabled kind the way the lock screen shows it — and if none is on, it says exactly that. The labels come from
// the same source as the real push (`notify.js`, `kindLabel`), not from an invented example.

function BellIcon({ off }: { off?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      {off && <path d="M2 2l20 20" />}
    </svg>
  );
}

function time(ms: number, locale: string) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function DeviceRow({ g, t, locale }: { g: PushDevice; t: (s: string) => string; locale: string }) {
  const ok = g.lastStatus === 200;
  const never = !g.lastPushAt;
  return (
    <Row
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${never ? "bg-dim/50" : ok ? "bg-ok" : "bg-danger"}`} aria-hidden />
          <span className="truncate">{t("iPhone")} <span className="text-dim">· {g.environment}</span></span>
        </span>
      }
      hint={
        never
          ? t("No notification delivered yet.")
          : ok
            ? `${t("last delivered")} · ${time(g.lastPushAt, locale)}`
            : `${g.lastReason || `HTTP ${g.lastStatus}`} · ${time(g.lastPushAt, locale)}`
      }
    />
  );
}

/**
 * The notification as it arrives on the lock screen: app name, time, the kind as title, the text below. The real push
 * carries the chat name in the title and the kind as subtitle (`server/gateway/push.js`) — this page cannot know the
 * chat name, so the kind stands here. Nothing is invented: both lines come translated from the server.
 */
function NotificationCard({ kind, now }: { kind: NotifyKind; now: string }) {
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-2xl border border-edge bg-panel px-3 py-2.5 shadow-card">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-dark text-white">
        <BellIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px] font-semibold">cbase</span>
          <span className="ml-auto shrink-0 text-[11px] text-dim">{now}</span>
        </div>
        <div className="truncate text-[12.5px] font-medium">{kind.label}</div>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-dim">{kind.hint}</p>
      </div>
    </div>
  );
}

export function NotificationSettings() {
  const t = useT();
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  const [kinds, setKinds] = useState<NotifyKind[] | null>(null);
  const [push, setPush] = useState<PushInfo | null>(null);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState("");
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try { setKinds((await loadNotify()).kinds); setError(""); }
    catch (e) { setError(String((e as Error).message || e)); }
    setPush(await loadPushDevices());
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (kind: NotifyKind) => {
    const next = kinds!.map((a) => (a.key === kind.key ? { ...a, value: !a.value } : a));
    setKinds(next);                                   // visible immediately, like the color scheme
    try { await saveNotify({ [kind.key]: !kind.value }); }
    catch (e) { setError(String((e as Error).message || e)); void load(); }
  };

  const sendProbe = async () => {
    setRunning(true); setProbe("");
    const r = await testPush();
    setRunning(false);
    if (!r) { setProbe(t("The gateway did not accept the test.")); return; }
    if (r.reason === "no-devices" || !r.devices.length) { setProbe(t("No device registered — sign in from the iPhone app.")); return; }
    setProbe(r.devices.map((d) => `${d.environment}: ${d.ok ? t("delivered") : (d.reason || `HTTP ${d.status}`)}`).join(" · "));
    void load();
  };

  const chatKinds = (kinds || []).filter((a) => a.chat);
  const restKinds = (kinds || []).filter((a) => !a.chat);
  // The preview shows the FIRST enabled kind — the same order as the toggles below, so the connection is visible.
  const enabled = (kinds || []).filter((a) => a.value);

  return (
    <div>
      {error && <p className="mb-3 text-[13px] text-danger">{error}</p>}

      {kinds && (
        <Preview>
          {enabled.length ? (
            <>
              <NotificationCard kind={enabled[0]} now={t("now")} />
              <p className="mt-2 text-[11.5px] leading-relaxed text-dim">
                {t("{on} of {all} kinds go to your phone.", { on: enabled.length, all: kinds.length })}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[12px] leading-relaxed text-dim">
              {t("No kind is switched on — nothing appears on the iPhone. The bell in the header still shows everything.")}
            </p>
          )}
        </Preview>
      )}

      {/* The probe belongs under the preview — it answers the same question ("does anything arrive?"), only for the
          delivery path instead of the selection. It still hangs on the gateway: without a gateway there are no
          devices it could go to. */}
      {push && (
        <div className="mt-2.5 flex items-center gap-3">
          <button type="button" onClick={() => void sendProbe()} disabled={running} className={`${primary} disabled:opacity-50`}>
            {running ? t("Sending…") : t("Send test notification")}
          </button>
          {probe && <span className="min-w-0 flex-1 truncate text-[12px] text-dim" title={probe}>{probe}</span>}
        </div>
      )}

      <Group
        title={t("From a chat")}
        hint={t("Default for every chat. Individual chats can differ (⋯ → Notifications).")}
      >
        {chatKinds.map((a) => (
          // a.label and a.hint come TRANSLATED from the server (notify.js) — they also appear on the lock screen, and
          // two sources would inevitably drift apart. No t().
          <Row key={a.key} title={a.label} hint={a.hint}>
            <Toggle on={a.value} onClick={() => void toggle(a)} title={a.label} />
          </Row>
        ))}
      </Group>

      <Group
        title={t("Without a chat")}
        hint={t("These notifications belong to no conversation — they can only be set here.")}
      >
        {restKinds.map((a) => (
          <Row key={a.key} title={a.label} hint={a.hint}>
            <Toggle on={a.value} onClick={() => void toggle(a)} title={a.label} />
          </Row>
        ))}
      </Group>

      {push && (
        <>
          <Group title={<span className="inline-flex items-center gap-1.5"><BellIcon off={!push.devices.length} />{t("Devices")}</span>}>
            {push.devices.length === 0 ? (
              <p className="px-3.5 py-3 text-[12.5px] leading-relaxed text-dim">
                {t("No iPhone registered. Sign in to the cbase app and allow notifications — the device then appears here.")}
              </p>
            ) : push.devices.map((g) => (
              <DeviceRow key={g.installationId} g={g} t={t} locale={locale} />
            ))}
          </Group>
          {!push.sandbox && !push.production && (
            <p className="mt-2 text-[12px] text-danger">{t("The gateway has no APNs key — nothing can be delivered at all.")}</p>
          )}
        </>
      )}
    </div>
  );
}
