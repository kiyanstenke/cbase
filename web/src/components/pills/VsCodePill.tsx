"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useEdgeClamp } from "@/lib/viewport";
import { containerLink, tunnelLinks, tunnelNameValid, type TunnelPhase } from "@/lib/vscode-tunnel";

// VS Code in the user's own container over Remote Tunnels: `code tunnel` runs in the container (electron/server/vscode-tunnel.js),
// the user signs in once with a GitHub or Microsoft account, after which VS Code connects from any machine — desktop via vscode://,
// browser via vscode.dev. No ssh, no client, no script. The pill shows only the logo (the bar is tight); the state sits in the
// background and the dot. As little text as possible — every row is a state, a button or a link.
type Status = {
  available: boolean;
  phase: TunnelPhase;
  active: boolean;
  name: string;
  provider: "github" | "microsoft";
  account: string;
  loginUrl: string;
  loginCode: string;
  link: string;
  error: string;
  version: string;
  rows: string[];
  workspaces: { id: string; name: string; path: string }[];
  // Project-box operation only — per relocated project main and copies in `ready` (devtools/routes.js); also a main in
  // `start`/`recreate` whose container already stands (the stack is still coming up).
  projects?: VsProject[];
  // Projects whose main container is being created or started right now — without a link, only so they do not go missing.
  starting?: { id: string; name: string; workspaceId: string | null; state: string }[];
};
type VsProject = {
  id: string;
  name: string;
  path: string;
  workspaceId: string | null;
  instances: { identifier: string; kind: "main" | "copy"; name: string | null; container: string; state: string }[];
};

// The original VS Code logo (Microsoft, MIT-licensed), reduced to the three colored areas: the original's drop-shadow filter and
// gloss gradient are invisible at 16 px. The mask ID is prefixed so it collides with no other SVG on the page.
function VsCodeLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <mask id="cbase-vscode-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path fillRule="evenodd" clipRule="evenodd" fill="white" d="M70.9119 99.3171C72.4869 99.9307 74.2828 99.8914 75.8725 99.1264L96.4608 89.2197C98.6242 88.1787 100 85.9892 100 83.5872V16.4133C100 14.0113 98.6243 11.8218 96.4609 10.7808L75.8725 0.873756C73.7862 -0.130129 71.3446 0.11576 69.5135 1.44695C69.252 1.63711 69.0028 1.84943 68.769 2.08341L29.3551 38.0415L12.1872 25.0096C10.589 23.7965 8.35363 23.8959 6.86933 25.2461L1.36303 30.2549C-0.452552 31.9064 -0.454633 34.7627 1.35853 36.417L16.2471 50.0001L1.35853 63.5832C-0.454633 65.2374 -0.452552 68.0938 1.36303 69.7453L6.86933 74.7541C8.35363 76.1043 10.589 76.2037 12.1872 74.9905L29.3551 61.9587L68.769 97.9167C69.3925 98.5406 70.1246 99.0104 70.9119 99.3171ZM75.0152 27.2989L45.1091 50.0001L75.0152 72.7012V27.2989Z" />
      </mask>
      <g mask="url(#cbase-vscode-mask)">
        <path fill="#0065A9" d="M96.4614 10.7962L75.8569 0.875542C73.4719 -0.272773 70.6217 0.211611 68.75 2.08333L1.29858 63.5832C-0.515693 65.2373 -0.513607 68.0937 1.30308 69.7452L6.81272 74.754C8.29793 76.1042 10.5347 76.2036 12.1338 74.9905L93.3609 13.3699C96.086 11.3026 100 13.2462 100 16.6667V16.4275C100 14.0265 98.6246 11.8378 96.4614 10.7962Z" />
        <path fill="#007ACC" d="M96.4614 89.2038L75.8569 99.1245C73.4719 100.273 70.6217 99.7884 68.75 97.9167L1.29858 36.4169C-0.515693 34.7627 -0.513607 31.9063 1.30308 30.2548L6.81272 25.246C8.29793 23.8958 10.5347 23.7964 12.1338 25.0095L93.3609 86.6301C96.086 88.6974 100 86.7538 100 83.3334V83.5726C100 85.9735 98.6246 88.1622 96.4614 89.2038Z" />
        <path fill="#1F9CF0" d="M75.8578 99.1263C73.4721 100.274 70.6219 99.7885 68.75 97.9166C71.0564 100.223 75 98.5895 75 95.3278V4.67213C75 1.41039 71.0564 -0.223106 68.75 2.08329C70.6219 0.211402 73.4721 -0.273666 75.8578 0.873633L96.4587 10.7807C98.6234 11.8217 100 14.0112 100 16.4132V83.5871C100 85.9891 98.6234 88.1786 96.4586 89.2196L75.8578 99.1263Z" />
      </g>
    </svg>
  );
}

export function VsCodePill() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const popRef = useEdgeClamp<HTMLDivElement>(open);
  const [st, setSt] = useState<Status | null>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"github" | "microsoft">("github");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api<Status>("/api/vscode-tunnel");
      setSt(s);
      setName((v) => v || s.name);
      setProvider((v) => (s.account ? v : s.provider || v));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Open: every 2 s (the device code and the link come from the container, without a click). Closed but in flight (login/start):
  // every 5 s, so the dot in the bar keeps up.
  const inFlight = st?.phase === "login" || st?.phase === "starts";
  useEffect(() => {
    if (!open && !inFlight) return;
    void load();
    const id = setInterval(() => void load(), open ? 2000 : 5000);
    return () => clearInterval(id);
  }, [open, inFlight, load]);
  // Click catcher as a document mousedown, not as fixed inset-0 (globals.css rule).
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest?.("[data-vscode-pop]")) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => { if (!open) { setErr(""); setDetails(false); setCopied(false); } }, [open]);

  if (!st || !st.available) return null;

  const phase = st.phase;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setErr("");
    try { await fn(); } catch (e) { setErr(String((e as Error)?.message || e)); } finally { setBusy(""); }
  };
  const start = () => run("start", async () => {
    const n = name.trim().toLowerCase();
    if (!tunnelNameValid(n)) throw new Error(t("Name: 1–20 characters, lowercase letters, digits, hyphens"));
    setSt(await api<Status>("/api/vscode-tunnel/start", { method: "POST", body: JSON.stringify({ name: n, provider }) }));
  });
  const stop = () => run("stop", async () => { setSt(await api<Status>("/api/vscode-tunnel/stop", { method: "POST", body: "{}" })); });
  const unregister = () => run("logout", async () => { setSt(await api<Status>("/api/vscode-tunnel/logout", { method: "POST", body: "{}" })); });
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setErr(t("Copying failed — select the text by hand")); }
  };

  const phaseWord: Record<TunnelPhase, string> = { off: t("off"), login: t("sign-in"), starts: t("starting …"), connected: t("connected"), error: t("Error") };
  const pointColor = phase === "connected" ? "bg-ok" : phase === "error" ? "bg-danger" : phase === "off" ? "bg-dim" : "bg-warn";
  const Button = ({ id, text, onClick, primary }: { id: string; text: string; onClick: () => void; primary?: boolean }) => (
    <button
      onClick={onClick}
      disabled={!!busy}
      className={primary
        ? "rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        : "rounded-lg border border-edge px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-50"}
    >
      {busy === id ? t("…") : text}
    </button>
  );
  const Link = ({ href, text, fresh }: { href: string; text: string; fresh?: boolean }) => (
    <a href={href} target={fresh ? "_blank" : undefined} rel={fresh ? "noreferrer" : undefined} className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] hover:bg-hover">{text}</a>
  );
  // The container's home from the CLI's link (…/tunnel/<name>/home/agent), otherwise /home/agent.
  const home = (() => { try { const p = new URL(st.link).pathname.split("/").slice(3).join("/"); return p ? `/${p}` : "/home/agent"; } catch { return "/home/agent"; } })();
  // The POST answers (start/stop/logout) once carried no workspaces — `...undefined` took the whole page down on the first click on
  // Start ("r.workspaces is not iterable"). The server now returns them everywhere; the pill still relies on no field.
  const targets = [{ id: "home", name: t("Home"), path: home }, ...(st.workspaces ?? [])];
  // Main and ready copies as Dev Containers windows — desktop link only (vscode.dev cannot "attach"). A missing field (local,
  // older server) hides the group. Which instance gets a link is decided by the server (ready, or a main whose container already
  // stands); the pill takes only rows with a container name.
  const projects = (st.projects ?? [])
    .map((p) => ({ ...p, instances: (p.instances ?? []).filter((i) => i.container) }))
    .filter((p) => p.instances.length > 0);
  const starting = st.starting ?? [];
  const rows = st.rows ?? [];

  return (
    <span className="relative shrink-0" data-vscode-pop>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t("Connect VS Code to your container")}
        aria-label={t("VS Code")}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          phase === "connected" ? "bg-accent-soft" : "opacity-70 hover:bg-hover hover:opacity-100"
        }`}
      >
        <VsCodeLogo size={16} />
      </button>
      {open && (
        <div data-overlay ref={popRef} className="absolute right-0 top-full z-40 mt-2 flex max-h-[min(80vh,560px)] w-[min(380px,calc(100vw-2rem))] flex-col rounded-2xl cb-pop">
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
            <span className="text-[12px] font-semibold">{t("VS Code")}</span>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-dim" title={st.version || undefined}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${pointColor}`} />
              {phaseWord[phase]}
            </span>
          </div>

          <div className="min-h-0 overflow-y-auto px-3 pb-2.5">
            {(phase === "off" || phase === "error") && (
              <>
                {phase === "error" && <div className="pb-1.5 text-[11px] text-danger">{st.error || t("Tunnel ended")}</div>}
                <div className="flex items-center gap-1.5">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
                    placeholder="cbase"
                    spellCheck={false}
                    className="h-7 min-w-0 flex-1 rounded-lg border border-edge bg-card px-2 font-mono text-[12px] outline-none focus:border-accent"
                    title={t("Tunnel name (1–20 characters, a–z, 0–9, hyphen)")}
                  />
                  {!st.account && (
                    <span className="flex shrink-0 overflow-hidden rounded-full border border-edge">
                      {(["github", "microsoft"] as const).map((p) => (
                        <button key={p} onClick={() => setProvider(p)} className={`px-2 py-0.5 text-[11px] ${provider === p ? "bg-accent-soft text-accent" : "hover:bg-hover"}`}>
                          {p === "github" ? "GitHub" : "Microsoft"}
                        </button>
                      ))}
                    </span>
                  )}
                  <Button id="start" text={phase === "error" ? t("Retry") : t("Start")} onClick={start} primary />
                </div>
                <div className="pt-1.5 text-[11px] text-dim">
                  {st.account
                    ? <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{st.account}</span><button onClick={unregister} disabled={!!busy} className="shrink-0 hover:text-fg">{t("Sign out")}</button></span>
                    : t("Tunnel via Microsoft's service; sign in with a GitHub or Microsoft account.")}
                </div>
              </>
            )}

            {phase === "login" && (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5">
                  <code className="flex-1 select-all font-mono text-[15px] font-semibold tracking-wider">{st.loginCode || "…"}</code>
                  <button onClick={() => void copy(st.loginCode)} disabled={!st.loginCode} className="shrink-0 rounded-full border border-edge bg-panel px-1.5 py-0.5 text-[10px] hover:bg-hover">{copied ? t("Copied") : t("Copy")}</button>
                </div>
                <div className="flex items-center gap-2 pt-2">
                  {st.loginUrl
                    ? <a href={st.loginUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90">{t("Sign in")}</a>
                    : <span className="text-[11px] text-dim">{t("…")}</span>}
                  <span className="min-w-0 flex-1 text-[11px] text-dim">{t("Enter the code there — the tunnel connects on its own afterwards.")}</span>
                  <Button id="stop" text={t("Cancel")} onClick={stop} />
                </div>
              </>
            )}

            {phase === "starts" && (
              <div className="flex items-center gap-2 text-[11px] text-dim">
                <span className="flex-1">{t("Tunnel starting …")}</span>
                <Button id="stop" text={t("Cancel")} onClick={stop} />
              </div>
            )}

            {phase === "connected" && (
              <>
                <div className="rounded-lg border border-edge bg-card">
                  {targets.map((w, i) => {
                    const l = tunnelLinks(st.name, w.path);
                    return (
                      <div key={w.id} className={`flex items-center gap-2 px-2 py-1 text-[12px] ${i ? "border-t border-edge" : ""}`}>
                        <span className="min-w-0 flex-1 truncate" title={w.path}>{w.name}</span>
                        <Link href={l.desktop} text={t("VS Code")} />
                        <Link href={l.browser} text={t("Browser")} fresh />
                      </div>
                    );
                  })}
                </div>
                {(projects.length > 0 || starting.length > 0) && (
                  <div className="pt-2" data-vscode-projects>
                    <div className="px-0.5 pb-1 text-[11px] font-semibold text-dim">{t("Projects")}</div>
                    <div className="rounded-lg border border-edge bg-card">
                      {projects.flatMap((p) => p.instances.map((inst) => ({ p, inst }))).map(({ p, inst }, i) => {
                        const href = containerLink(st.name, inst.container, p.path);
                        const who = inst.kind === "main" ? t("Main") : `${t("Copy##noun")} ${inst.name ?? ""}`.trim();
                        return (
                          <div key={inst.identifier} data-vscode-instance={inst.identifier} className={`flex items-center gap-2 px-2 py-1 text-[12px] ${i ? "border-t border-edge" : ""}`}>
                            <span className="min-w-0 flex-1 truncate" title={`${p.path} · ${inst.container}`}>
                              {p.name} <span className="text-dim">· {who}</span>
                            </span>
                            {inst.state !== "ready" && <span className="shrink-0 text-[11px] text-dim" title={t("The container is running; its services are still coming up.")}>{t("Services starting …")}</span>}
                            {href && <Link href={href} text={t("VS Code")} />}
                          </div>
                        );
                      })}
                      {starting.map((p, i) => (
                        <div key={p.id} data-vscode-starting={p.id} className={`flex items-center gap-2 px-2 py-1 text-[12px] text-dim ${i || projects.length ? "border-t border-edge" : ""}`}>
                          <span className="min-w-0 flex-1 truncate">{p.name} <span>· {t("Main")}</span></span>
                          <span className="shrink-0 text-[11px]">{p.state === "create" ? t("being created …") : t("starting …")}</span>
                        </div>
                      ))}
                    </div>
                    <div className="px-0.5 pt-1 text-[10px] leading-snug text-dim">
                      {t("The window runs inside the container: while it is open, processes there can request the Mac's git and ssh credentials. Tearing down a copy and recreating the project container (at the next idle moment after a change to its image or mounts — an open window does not hold it back) close it hard: unsaved work and anything running in the window's terminal end without notice. Requires Dev Containers with “dev.containers.dockerPath” = “docker”.")}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 pt-2 text-[11px] text-dim">
                  <span className="min-w-0 flex-1 truncate" title={st.account}><span className="font-mono">{st.name}</span>{st.account ? ` · ${st.account}` : ""}</span>
                  <button onClick={unregister} disabled={!!busy} className="shrink-0 hover:text-fg">{t("Sign out")}</button>
                  <Button id="stop" text={t("Stop##noun")} onClick={stop} />
                </div>
              </>
            )}

            {err && <div className="pt-1.5 text-[11px] text-danger">{err}</div>}
            {rows.length > 0 && phase !== "off" && (
              <div className="pt-1.5">
                <button onClick={() => setDetails((v) => !v)} className="text-[10px] text-dim hover:text-fg">{details ? t("Hide details") : t("Details")}</button>
                {details && <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-edge bg-card px-2 py-1 font-mono text-[10px] leading-snug text-dim">{rows.join("\n")}</pre>}
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
