"use client";

// Gateway mode (client/server operation): detects at startup whether the UI is served by a
// cbase gateway (GET /gw/info). A local server (no gateway, localhost) does not have the
// endpoint → the app behaves exactly as before. In gateway mode the gate sits in front of
// the app: login (or first-time setup) → start environment → app.
import { createContext, useContext, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { CbaseLens } from "@/components/CbaseLens";

export interface GatewayUser { username: string; role: "admin" | "user" }
interface GatewayCtx { user: GatewayUser; logout: () => void }

const Ctx = createContext<GatewayCtx | null>(null);
// null = local (no gateway) — all chrome elements stay invisible.
export const useGateway = () => useContext(Ctx);

type Phase = "checking" | "local" | "login" | "starting" | "ready";

export function GatewayGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [setup, setSetup] = useState(false);
  const [user, setUser] = useState<GatewayUser | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/gw/info", { headers: { accept: "application/json" } });
        if (!r.ok) return setPhase("local");
        const j = await r.json();
        if (!j?.gateway) return setPhase("local");
        setSetup(!!j.setup);
        if (!j.authenticated) return setPhase("login");
        setUser(j.user);
        setPhase("starting");
        await fetch("/gw/env/ensure", { method: "POST" }).catch(() => {});
        setPhase("ready");
      } catch {
        setPhase("local");
      }
    })();
  }, []);

  async function handleLogin(u: GatewayUser) {
    setUser(u);
    setPhase("starting");
    await fetch("/gw/env/ensure", { method: "POST" }).catch(() => {});
    setPhase("ready");
  }

  function logout() {
    fetch("/gw/logout", { method: "POST" }).finally(() => window.location.reload());
  }

  if (phase === "checking") return null; // milliseconds — the BootSplash covers it anyway
  if (phase === "login") return <GatewayLogin setup={setup} onDone={handleLogin} />;
  if (phase === "starting") return <EnvStarting />;
  if (phase === "local") return <>{children}</>;
  return <Ctx.Provider value={{ user: user!, logout }}>{children}</Ctx.Provider>;
}

function EnvStarting() {
  const t = useT();
  return (
    <div className="grid h-screen place-items-center bg-bg">
      <div className="flex flex-col items-center gap-4">
        <CbSpinner />
        <div className="text-sm text-dim">{t("Starting your server environment…")}</div>
      </div>
    </div>
  );
}

// Spinning hexagon — the same shape language as the run indicator of the chat sidebar.
function CbSpinner() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" className="animate-spin text-accent" style={{ animationDuration: "1.6s" }} aria-hidden>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function GatewayLogin({ setup, onDone }: { setup: boolean; onDone: (u: GatewayUser) => void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // First-time setup: the gateway prints a one-time token in its log and stores it in <data>/setup-token (server/gateway/setup-token.js).
  const [setupToken, setSetupToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "w-full rounded-full border border-edge bg-bg px-4 py-2.5 text-fg outline-none focus:border-accent";

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(setup ? "/gw/setup" : "/gw/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(setup ? { username, password, setupToken } : { username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || t("Login failed"));
      onDone(j.user);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setBusy(false);
    }
  }

  return (
    <div className="cb-kit grid h-screen place-items-center bg-bg">
      <form onSubmit={submit} className="cb-kit-pane w-[min(340px,calc(100vw-2rem))] rounded-2xl p-7">
        <div className="mb-6 flex items-center gap-2.5">
          <CbaseLens className="h-8 w-8" />
          <div>
            <div className="text-[15px] font-bold tracking-tight text-fg">cbase</div>
            <div className="text-xs text-dim">{setup ? t("First-time setup — create the admin account") : t("Sign in to the server")}</div>
          </div>
        </div>
        <label className="mb-3 block text-sm text-dim">
          {t("Username")}
          <input className={`mt-1.5 ${field}`} value={username} onChange={(e) => setUsername(e.target.value)}
                 autoFocus autoComplete="username" />
        </label>
        <label className="mb-5 block text-sm text-dim">
          {t("Password")}
          <input className={`mt-1.5 ${field}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete={setup ? "new-password" : "current-password"} />
        </label>
        {setup && (
          <label className="mb-5 block text-sm text-dim">
            {t("Setup token")}
            <input className={`mt-1.5 ${field}`} value={setupToken} onChange={(e) => setSetupToken(e.target.value)}
                   autoComplete="off" spellCheck={false} />
            <span className="mt-1.5 block text-xs">{t("Printed in the gateway log at start and stored in <data>/setup-token on the server.")}</span>
          </label>
        )}
        {err && <div className="mb-3 text-sm text-danger">{err}</div>}
        <button type="submit" disabled={busy || !username || !password || (setup && !setupToken.trim())}
                className="w-full rounded-full bg-accent px-4 py-2.5 font-medium text-white transition-opacity disabled:opacity-50">
          {busy ? t("Signing in…") : setup ? t("Create account") : t("Sign in")}
        </button>
      </form>
    </div>
  );
}
