"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { nativeAvailable } from "@/lib/browser-native";
import { instanceTitle, type ProjectWithInstance } from "@/lib/services-status";
import { Group, Row } from "@/components/settings/SettingsKit";
import { useT } from "@/lib/i18n";

// Settings page "Browser". It carries TWO browsers, because there are two:
//
//  • the AGENT's — Playwright in the container, which the agent runs for pages and e2e tests. Nothing is adjustable on it: it ALWAYS
//    runs headless (toolchain/playwright.js) — the "browser in the background" switch and the per-chat choice are gone.
//  • YOURS — the browser tab and the browser section of the right chat bar. In the cbase client it is a real window view
//    (BrowserNative), on the web a stream from the container.
//
// On the second NOTHING is adjustable, and that is no gap: whether native or streamed is decided by the client's version (version
// switch, `nativeAvailable`); the session profiles arise per scope by themselves (browser-rules.js `scopeProfile`); the client sets up
// the port forwarding itself when a page needs it. So this stands here as a STATE — a capsule, not a switch. A switch that switches
// nothing is worse than no display.

/** What the client's ports bridge delivers — read-only here, stopping belongs to the ports pill. */
// `instance`: two instances can forward the same port — the row's key carries it.
type Forward = { port: number; localPort: number; connections: number; source?: "manual" | "browser"; instance?: string | null };
type ClientPorts = { list: () => Promise<Forward[]>; onChanged: (cb: (l: Forward[]) => void) => () => void };
const portsBridge = (): ClientPorts | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { cbaseClient?: { ports?: ClientPorts } }).cbaseClient?.ports || null;
};

/**
 * A state as a capsule: the same form as a filter capsule, but without `button` and without hover.
 * Whoever touches it should notice that nothing happens — before clicking.
 */
function Marker({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${active ? "bg-accent-soft text-accent" : "border border-edge text-dim"}`}>
      {children}
    </span>
  );
}

export function BrowserSettings() {
  const t = useT();
  // Measure only AFTER mount: during the SSR build there is no `window`, and a first render that already assumes the bridge would be
  // a hydration mismatch (the same rule as in BrowserPane).
  const [native, setNative] = useState<boolean | null>(null);
  // `null` means "not measured yet", not "no bridge" — empty is not unknown, and on the first render (also the SSR build's) the two
  // are not the same.
  const [inClient, setInClient] = useState<boolean | null>(null);
  const [forwards, setForwards] = useState<Forward[] | null>(null);
  // The projects (`GET /api/projects`) only to name the instance of a forward: which copy stands behind localhost:3195 was shown by
  // no view. Fetched only once a forward carries an instance; without an answer the raw id stays in the tooltip — never a guessed name.
  const [projects, setProjects] = useState<ProjectWithInstance[] | null>(null);

  useEffect(() => {
    setNative(nativeAvailable(window));
    const b = portsBridge();
    setInClient(b !== null);
    if (!b) return;
    void b.list().then(setForwards).catch(() => {});
    return b.onChanged(setForwards);
  }, []);

  const withInstance = !!forwards?.some((f) => f.instance);
  useEffect(() => {
    if (!withInstance || projects) return;
    let alive = true;
    api<ProjectWithInstance[]>("/api/projects")
      .then((l) => { if (alive && Array.isArray(l)) setProjects(l); })
      .catch(() => {});
    return () => { alive = false; };
  }, [withInstance, projects]);

  return (
    <div>
      <Group
        title={t("The agents' browser")}
        hint={t(
          "Controls the built-in browser (Playwright) the agent uses to open web pages and run end-to-end tests. In the background everything runs invisibly — no window opens.",
        )}
      >
        <Row
          title={t("Always in the background (headless)")}
          hint={t(
            "No window ever opens. If you need to log in somewhere, open the agent's browser in the right chat sidebar and take over there — the profile is kept, and the login also applies to later runs.",
          )}
        />
      </Group>

      <Group
        title={t("Your browser")}
        hint={t("The browser in the “Browser” tab and in the chat's right-hand sidebar — yours, not the agent's.")}
      >
        <Row
          title={t("How it is drawn")}
          hint={t(
            "In the cbase client the window draws the page itself, with no picture going over the wire. Otherwise it arrives as a stream from the server environment. The client version decides this, not a setting.",
          )}
        >
          {native !== null && (
            <Marker active={native}>{native ? t("Native in the client") : t("Streamed via the server")}</Marker>
          )}
        </Row>

        <Row
          title={t("Session profiles")}
          hint={t(
            "One profile per project and per workspace: sign-ins, cookies and the open tabs survive a restart and apply only inside their scope. A chat uses the profile of its project or of its workspace.",
          )}
        >
          <Marker>{t("Per project")}</Marker>
          <Marker>{t("Per workspace")}</Marker>
        </Row>

        {/* `wide`: the list of bound ports needs the full width — at the right of the text it would stand in a column as narrow as the
            text is tall. */}
        <Row
          wide
          title={t("Automatic port forwarding")}
          hint={t(
            "When a page calls a localhost port that only the server environment has, the client binds it on this device — without asking. If another program is already listening on that port here, it asks instead of quietly redirecting it.",
          )}
        >
          {inClient === null ? null : !inClient ? (
            <div className="text-[12px] text-dim">{t("Only in the cbase client.")}</div>
          ) : !forwards?.length ? (
            <div className="text-[12px] text-dim">{t("No forwarding active yet.")}</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {forwards.map((f) => {
                // The tooltip names the instance (project or "project · copy") — the capsule stays short.
                const inst = f.instance ? (instanceTitle(f.instance, projects, null, t) ?? f.instance) : null;
                const title = [inst ? t("Instance: {instance}", { instance: inst }) : "", f.connections > 0 ? t("{n} open connection(s)", { n: f.connections }) : ""]
                  .filter(Boolean).join(" · ");
                return (
                  <span
                    key={`${f.instance ?? ""}:${f.port}`}
                    className="flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-[11.5px]"
                    title={title || undefined}
                    data-fwd-instance={f.instance ?? undefined}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    <span className="font-mono">localhost:{f.localPort}</span>
                    <span className="text-dim">← :{f.port}</span>
                    {f.source === "browser" && (
                      <span className="text-[10px] font-medium text-accent" title={t("Forwarded automatically by the browser")}>
                        {t("Browser")}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </Row>
      </Group>
    </div>
  );
}
