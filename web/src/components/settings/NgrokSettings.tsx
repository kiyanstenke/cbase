"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadNgrokAccess, deleteNgrokAccess, setNgrokAccess, revokePreviewLink,
  type NgrokBody, type NgrokAccess, type PreviewLink,
} from "@/lib/api";
import { Hint, accent, field, ghostSm, quietDangerSm } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";
import { usePreviewLinks } from "@/components/preview/usePreviewLinks";
import { NGROK_ACCESS_CHANGED, shortAddress, remainingTime, remainingTimeText } from "@/lib/preview-links";
import { dateLocale, useT } from "@/lib/i18n";

// Settings → Integrations, second section "ngrok" (preview links). Every user brings their own credentials and enters
// them HERE, never through the chat. Like GitLab they only go outward: the response says only WHETHER something is
// stored, and the fields are cleared after saving (a password field that showed the stored value again would be a leak).
//
// Two modes: authtoken only = free plan (`dev`, one fixed dev address, one link at a time); plus an API key = Hobbyist
// (`names`, one reserved name per link, up to three). The server computes the mode; here it is shown as a sentence.
//
// The PUT requires BOTH keys (`null` keeps the value, `""` deletes it, a string sets it). An empty field therefore
// means "unchanged", not "delete" — deletion only goes through the dedicated buttons, with a confirmation.

const SymbolNgrok = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 12h9" />
    <path d="m10 8 4 4-4 4" />
    <path d="M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
  </svg>
);

export function NgrokSettings() {
  const t = useT();
  const [access, setAccess] = useState<NgrokAccess | null>(null);
  const [authtoken, setAuthtoken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const { status, takeOver } = usePreviewLinks();

  const load = useCallback(async () => {
    setAccess(await loadNgrokAccess());
  }, []);
  useEffect(() => { load().catch((e) => setError(String((e as Error)?.message || e))); }, [load]);

  // The number of active links lives in the access record (for the 409 sentences); it follows the list below.
  const activeCount = status?.active.length;
  useEffect(() => {
    if (activeCount === undefined) return;
    setAccess((z) => (z && z.active !== activeCount ? { ...z, active: activeCount } : z));
  }, [activeCount]);

  async function send(body: NgrokBody, kind: string) {
    setBusy(kind);
    setError("");
    try {
      setAccess(await setNgrokAccess(body));
      setAuthtoken("");
      setApiKey("");
      window.dispatchEvent(new Event(NGROK_ACCESS_CHANGED));
    } catch (e) {
      // 400 validation: nothing stored — the fields stay so the typo can be found.
      setError(String((e as Error)?.message || e));
    } finally { setBusy(""); }
  }
  function save() {
    const a = authtoken.trim();
    const k = apiKey.trim();
    if (!a && !k) return;
    void send({ authtoken: a || null, apiKey: k || null }, "save");
  }
  function removeApiKey() {
    if (!confirm(t("Remove the API key? Afterwards only the fixed dev address of the free plan is left."))) return;
    void send({ authtoken: null, apiKey: "" }, "apikey");
  }
  async function removeEverything() {
    if (!confirm(t("Remove ngrok access? Without an authtoken no preview links can be created."))) return;
    setBusy("remove");
    setError("");
    try {
      await deleteNgrokAccess();
      await load();
      window.dispatchEvent(new Event(NGROK_ACCESS_CHANGED));
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(""); }
  }
  async function revoke(l: PreviewLink) {
    setBusy(l.id);
    setError("");
    try {
      const r = await revokePreviewLink(l.id);
      if (r) takeOver(r);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(""); }
  }

  const modeSet = !access ? t("…")
    : access.mode === "names" ? t("With API key: each link gets its own name, up to {n} at a time.", { n: access.limit })
    : access.mode === "dev" ? t("Authtoken only: always the same dev address, one link at a time.")
    : t("No authtoken stored yet — without it there are no preview links.");
  const checked = access?.checkedAt ? new Date(access.checkedAt).toLocaleString(dateLocale()) : "";
  const reasonText = (l: PreviewLink) =>
    l.endedReason === "revoke" ? t("revoked") : l.endedReason === "expired" ? t("expired") : l.endedReason === "error" ? t("Error") : t("terminated");
  const target = (l: PreviewLink) => `${l.projectName || l.projectId}${l.instance && l.instance !== "main" ? ` · ${l.instance}` : ""} · ${l.serviceName || `#${l.serviceId}`}${l.port != null ? ` :${l.port}` : ""}`;

  return (
    <div>
      {error && <div className="mb-3"><Hint tone="danger">{error}</Hint></div>}

      <Group
        title={t("Preview links")}
        hint={t("Preview links: a project's service becomes reachable at a public address through your ngrok account — for showing and testing with others. Links are created in the services list of the header.")}
      >
        {access && !access.sdk && (
          <div className="px-3.5 pt-2.5"><Hint tone="warn">{t("The ngrok module is missing in this cbase environment — links can't be created here.")}</Hint></div>
        )}

        <Row
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className={`shrink-0 ${access?.error ? "text-danger" : access?.authtoken ? "text-accent" : "text-dim"}`}><SymbolNgrok /></span>
              <span className="truncate font-medium">{t("Access details")}</span>
            </span>
          }
          hint={
            <>
              {modeSet}
              {access?.authtoken ? ` · ${t("authtoken stored")}` : ""}
              {access?.apiKey ? ` · ${t("API key stored")}` : ""}
              {checked ? ` · ${t("checked {time}", { time: checked })}` : ""}
            </>
          }
        >
          {access?.apiKey && (
            <button onClick={removeApiKey} disabled={busy !== ""} className={`${ghostSm} disabled:opacity-40`} data-ngrok-apikey-remove>
              {busy === "apikey" ? t("…") : t("Remove API key")}
            </button>
          )}
          {(access?.authtoken || access?.apiKey) && (
            <button onClick={() => void removeEverything()} disabled={busy !== ""} className={`${quietDangerSm} disabled:opacity-40`} data-ngrok-remove>
              {busy === "remove" ? t("…") : t("Remove")}
            </button>
          )}
        </Row>
        {access?.error && <div className="px-3.5 pb-2.5"><Hint tone="danger">{access.error}</Hint></div>}
        {/* cbase does not see the ngrok PLAN, only whether an API key is stored (the mode is computed, not detected), so
            an upgrade to Hobbyist changes nothing by itself — hence this visible sentence instead of only the
            shortened row hint. */}
        {access?.mode === "dev" && (
          <div className="px-3.5 pb-2.5" data-ngrok-plan-hint>
            <div className="rounded-xl bg-hover px-3 py-2 text-[12px] leading-relaxed text-dim">
              {t("cbase can't see your ngrok plan. On Hobbyist or higher, create a key in the ngrok dashboard under “API Keys” and enter it below — then every new link gets a name of its own, up to three at a time.")}
            </div>
          </div>
        )}

        {/* Both fields in ONE row with one Save: the server checks exactly the changed values and stores only afterwards.
            A field left empty goes out as `null` — "unchanged". */}
        <Row
          wide
          title={access?.authtoken ? t("Change access") : t("Store access")}
          hint={
            <>
              {t("Authtoken in the ngrok dashboard under “Your Authtoken”, API key under “API Keys”. Both stay in your cbase environment and are never returned to the interface.")}
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <label className="text-[11.5px] font-medium text-dim" htmlFor="ngrok-authtoken">
              {t("Authtoken")}{access?.authtoken ? ` · ${t("stored")}` : ""}
            </label>
            <input
              id="ngrok-authtoken"
              value={authtoken}
              onChange={(e) => setAuthtoken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              type="password"
              autoComplete="off"
              placeholder={access?.authtoken ? t("stored — leave empty to keep it") : t("Paste authtoken")}
              className={`w-full ${field}`}
              data-ngrok-authtoken
            />
            <label className="text-[11.5px] font-medium text-dim" htmlFor="ngrok-apikey">
              {t("API key (optional)")}{access?.apiKey ? ` · ${t("stored")}` : ""}
            </label>
            <input
              id="ngrok-apikey"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              type="password"
              autoComplete="off"
              placeholder={access?.apiKey ? t("stored — leave empty to keep it") : t("only for a name of its own per link")}
              className={`w-full ${field}`}
              data-ngrok-apikey
            />
            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={busy !== "" || (!authtoken.trim() && !apiKey.trim())}
                className={`${accent} disabled:opacity-40`}
                data-ngrok-save
              >
                {busy === "save" ? t("Checking…") : t("Save")}
              </button>
            </div>
          </div>
        </Row>

        {/* The active links — the same list as in the services pill, from the same state (first fetch + SSE). */}
        <Row
          title={t("Active links")}
          hint={status ? (status.limit > 0 ? t("{n} of {g}", { n: status.active.length, g: status.limit }) : t("{n} active", { n: status.active.length })) : t("…")}
        />
        {status?.active.length === 0 && (
          <div className="px-3.5 pb-2.5 text-[12px] text-dim">{t("No link active.")}</div>
        )}
        {status?.active.map((l) => (
          <div key={l.id} className="flex items-center gap-2 px-3.5 py-2" data-ngrok-link={l.id} data-ngrok-link-state={l.state}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${l.state === "online" ? "bg-ok" : l.state === "error" ? "bg-danger" : "border border-edge"}`} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12.5px]" title={target(l)}>{target(l)}</span>
              <span className="truncate text-[11.5px] text-dim">
                {l.url ? <a href={l.url} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">{shortAddress(l.url)}</a> : l.state === "start" ? t("Creating link …") : t("no address")}
                {` · ${remainingTimeText(remainingTime(l.runningSinceAt, Date.now()), t)}`}
                {/* A link keeps the address it was created with — even after an API key was added. */}
                {l.mode === "dev" && access?.mode === "names" ? ` · ${t("still on the dev address — create it again for a name of its own")}` : ""}
              </span>
              {l.state === "error" && l.error && <span className="text-[11.5px] text-danger">{l.error}</span>}
            </div>
            <button onClick={() => void revoke(l)} disabled={busy === l.id} className={`${quietDangerSm} shrink-0 disabled:opacity-40`}>
              {busy === l.id ? t("…") : t("Revoke")}
            </button>
          </div>
        ))}

        {status && status.history.length > 0 && (
          <div>
            <Row title={t("History")} hint={t("the last {n} ended links", { n: status.history.length })}>
              <button onClick={() => setHistoryOpen((v) => !v)} className={ghostSm} aria-expanded={historyOpen}>
                {historyOpen ? t("Dismiss##hide") : t("Show")}
              </button>
            </Row>
            {historyOpen && status.history.map((l) => (
              <div key={l.id} className="flex items-center gap-2 px-3.5 py-1.5 text-[12px]" data-ngrok-history={l.id}>
                <span className="min-w-0 flex-1 truncate text-dim" title={l.error || undefined}>
                  {target(l)}{l.url ? ` · ${shortAddress(l.url)}` : ""}
                </span>
                <span className={`shrink-0 text-[11px] ${l.endedReason === "error" ? "text-danger" : "text-dim"}`}>
                  {reasonText(l)}{l.endedAt ? ` · ${new Date(l.endedAt).toLocaleDateString(dateLocale())}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </Group>
    </div>
  );
}
