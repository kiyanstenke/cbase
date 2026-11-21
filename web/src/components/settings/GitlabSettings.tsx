"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type GitlabAccount } from "@/lib/api";
import { Hint, accent, field, ghostSm, quietDangerSm } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";
import { useT } from "@/lib/i18n";

// Settings → Integrations. The page is named as the navigation calls it — the title is carried by the modal's header, the content
// begins here. GitLab is therefore a SECTION (a `Group`) and not the page: a second service fits below it without anyone having to
// rebuild the file first.
//
// Connected GitLab accounts are the basis of the trigger nodes in workflows (also creatable there directly) — here they stand
// centrally, with check and delete. The token is stored and used but NEVER returned: the row shows only THAT one is stored, plus the
// account name that GitLab itself reported.
//
// `field`/`chip` come from `CbKit` — two ways to one building block are two building blocks as soon as one changes.

function GitlabMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21 3.4 14.8a1 1 0 0 1-.35-1.09L4.6 8.6 12 21l7.4-12.4 1.55 5.11a1 1 0 0 1-.35 1.09z" />
      <path d="M4.6 8.6 6.4 3.2a.5.5 0 0 1 .94-.02L9.5 8.6M19.4 8.6l-1.8-5.4a.5.5 0 0 0-.94-.02L14.5 8.6" />
    </svg>
  );
}

// `onAccounts`: the Integrations page (IntegrationsSettings.tsx) shows the state in its list and follows every load here.
export function GitlabSettings({ onAccounts }: { onAccounts?: (accounts: GitlabAccount[]) => void }) {
  const t = useT();
  const [accounts, setAccounts] = useState<GitlabAccount[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState("");   // account id whose token is being replaced
  const [newToken, setNewToken] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ accounts: GitlabAccount[] }>("/api/gitlab/accounts");
    setAccounts(r.accounts);
    onAccounts?.(r.accounts);
  }, [onAccounts]);
  useEffect(() => { load().catch((e) => setError(String(e))); }, [load]);

  async function add() {
    setBusy("add");
    setError("");
    try {
      await api("/api/gitlab/accounts", { method: "POST", body: JSON.stringify({ label, host, token }) });
      setToken("");
      setLabel("");
      setAdding(false);
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(""); }
  }
  async function test(a: GitlabAccount) {
    setBusy(a.id);
    try {
      const r = await api<{ ok: boolean; userName?: string; error?: string }>(`/api/gitlab/accounts/${a.id}/test`, { method: "POST" });
      setTested((prev) => ({ ...prev, [a.id]: r.ok ? t("Connection works — @{user}", { user: r.userName || "" }) : r.error || t("Error") }));
      await load();
    } catch (e) {
      setTested((prev) => ({ ...prev, [a.id]: String((e as Error)?.message || e) }));
    } finally { setBusy(""); }
  }
  async function remove(a: GitlabAccount) {
    if (!confirm(t("Remove account “{name}”? Triggers using it will stop firing.", { name: a.label || a.host }))) return;
    setBusy(a.id);
    try {
      await api(`/api/gitlab/accounts/${a.id}`, { method: "DELETE" });
      await load();
    } finally { setBusy(""); }
  }
  // Replace the token (e.g. after expiry) — as a field on the row, not via a dialog: a token belongs in a password field, and
  // `window.prompt` throws in Electron anyway.
  async function replaceToken(a: GitlabAccount) {
    if (!newToken.trim()) return;
    setBusy(a.id);
    setError("");
    try {
      await api(`/api/gitlab/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ token: newToken.trim() }) });
      setNewToken("");
      setReplacing("");
      await load();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally { setBusy(""); }
  }

  return (
    <div>
      {error && <div className="mb-3"><Hint tone="danger">{error}</Hint></div>}

      <Group
        title={t("Accounts")}
        hint={t("Connected accounts for workflow triggers: cbase polls GitLab regularly and starts workflows on new merge requests, work items, comments, pushes or pipelines.")}
      >
        {accounts.length === 0 && !adding && (
          <div className="px-3.5 py-6 text-center text-[13px] text-dim">
            {t("No GitLab account connected yet.")}
          </div>
        )}

        {/* ONE surface, hairlines between the accounts (house rule) — the hairline separates the wrappers, not the row from its own
            addendum. So both sit in a shared `div`: header as `Row`, token field and status message below. */}
        {accounts.map((a) => (
          <div key={a.id}>
            <Row
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`shrink-0 ${a.status ? "text-danger" : "text-accent"}`}><GitlabMark size={16} /></span>
                  <span className="truncate font-medium">{a.label || a.host}</span>
                </span>
              }
              hint={
                <>
                  {a.host}
                  {a.userName ? ` · @${a.userName}` : ""}
                  {a.hasToken ? ` · ${t("token stored")}` : ""}
                </>
              }
            >
              <button onClick={() => test(a)} disabled={busy === a.id} className={`${ghostSm} disabled:opacity-40`}>
                {busy === a.id ? t("Checking…") : t("Check")}
              </button>
              <button
                onClick={() => { setReplacing((v) => (v === a.id ? "" : a.id)); setNewToken(""); }}
                disabled={busy === a.id}
                className={`${ghostSm} disabled:opacity-40`}
              >
                {replacing === a.id ? t("Cancel") : t("Replace token")}
              </button>
              <button onClick={() => remove(a)} disabled={busy === a.id} className={`${quietDangerSm} disabled:opacity-40`}>{t("Remove")}</button>
            </Row>
            {replacing === a.id && (
              <div className="flex items-center gap-2 px-3.5 pb-2.5">
                <input
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") replaceToken(a); }}
                  type="password"
                  autoComplete="off"
                  autoFocus
                  placeholder="glpat-…"
                  className={`min-w-0 flex-1 ${field}`}
                />
                <button onClick={() => replaceToken(a)} disabled={busy === a.id || !newToken.trim()} className={`shrink-0 ${accent} disabled:opacity-40`}>
                  {t("Save")}
                </button>
              </div>
            )}
            {/* Only a saved error (`a.status`) is red. What `Check` just returned can be either — success OR the server's error text;
                green would then be a claim that the text beside it refutes. */}
            {(a.status || tested[a.id]) && (
              <div className="px-3.5 pb-2.5">
                {a.status
                  ? <Hint tone="danger">{a.status}</Hint>
                  : <div className="rounded-xl bg-hover px-3 py-2 text-[12px] leading-relaxed text-dim">{tested[a.id]}</div>}
              </div>
            )}
          </div>
        ))}

        {/* The two sentences about the token stand HERE, not as a footnote under the page: they belong in the moment someone wants
            to fetch and enter a token. */}
        <Row
          wide
          title={t("Connect GitLab")}
          hint={
            <>
              {t("Create one in GitLab under Profile → Access Tokens. read_api is enough for listening; use api if the agent should also write (comments, MRs).")}{" "}
              {t("The token stays on this machine (or in your server environment) and is never returned to the interface.")}
            </>
          }
        >
          {adding ? (
            <div className="flex flex-col gap-2">
              <label className="text-[11.5px] font-medium text-dim">{t("Name (free-form)")}</label>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("e.g. company GitLab")} className={`w-full ${field}`} />
              <label className="text-[11.5px] font-medium text-dim">{t("Host")}</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://gitlab.com" className={`w-full ${field}`} />
              <label className="text-[11.5px] font-medium text-dim">{t("Personal access token")}</label>
              <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" placeholder="glpat-…" className={`w-full ${field}`} />
              <div className="flex items-center gap-2">
                <button onClick={add} disabled={busy === "add" || !token.trim()} className={`${accent} disabled:opacity-40`}>
                  {busy === "add" ? t("Checking…") : t("Connect")}
                </button>
                <button onClick={() => { setAdding(false); setToken(""); }} className={ghostSm}>{t("Cancel")}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className={ghostSm}>{t("+ Connect GitLab")}</button>
          )}
        </Row>
      </Group>
    </div>
  );
}
