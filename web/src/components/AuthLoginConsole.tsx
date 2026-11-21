"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, API_BASE } from "@/lib/api";
import { useResolvedTheme, type ResolvedTheme } from "@/lib/theme";
import { getAccent, useAccent, xtermWithAccent } from "@/lib/accent";
import { useT, tr } from "@/lib/i18n";
import { listenTextSize, textCount } from "@/lib/appearance";
import { writeTerminalChunk } from "@/lib/terminal-stream";

// Compact terminal for `claude auth login` (via /api/account/connect). Output arrives over SSE, input by POST — the same
// generic /api/terminal/:id endpoints as the project terminal. When the login process ends, onExit tells the parent, which
// then re-checks the connection status.
const THEMES: Record<ResolvedTheme, Record<string, string>> = {
  light: { background: "#ffffff", foreground: "#2a2a2a", cursor: "#1f57f7", cursorAccent: "#ffffff", selectionBackground: "rgba(31,87,247,0.22)" },
  dark: { background: "#181818", foreground: "#d6d6d6", cursor: "#4d89ff", cursorAccent: "#181818", selectionBackground: "rgba(77,137,255,0.30)" },
};

// Read the theme LIVE (like TerminalPanel): useResolvedTheme starts hydration-safe with "light" and flips only after mount —
// the asynchronously created terminal must not freeze the stale closure value (else: white console in dark mode).
// Cursor and selection follow the chosen accent color (as in TerminalPanel).
const liveTheme = (): Record<string, string> => {
  const mode: ResolvedTheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return xtermWithAccent(THEMES[mode], mode, getAccent());
};

export function AuthLoginConsole({ onExit, connectPath = "/api/account/connect", title = "Claude sign-in" }: { onExit: () => void; connectPath?: string; title?: string }) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"init" | "ready" | "unavailable">("init");
  const [err, setErr] = useState("");
  const resolved = useResolvedTheme();
  const termRef = useRef<Terminal | null>(null);
  const postRef = useRef<((op: string, body: Record<string, unknown>) => void) | null>(null);

  // Explicit paste button: depending on focus, Cmd+V does not always reach the xterm textarea (modal/client) — but the OAuth
  // code MUST be pasteable.
  async function pasteFromClipboard() {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) postRef.current?.("input", { data: txt });
    } catch { /* clipboard denied — the user can still type */ }
    termRef.current?.focus();
  }

  const accent = useAccent();
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermWithAccent(THEMES[resolved], resolved, accent);
  }, [resolved, accent]);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let es: EventSource | null = null;
    let ro: ResizeObserver | null = null;
    let offTextSize = () => {};
    let tid = "";

    (async () => {
      let sess: { id: string; available: boolean; error?: string };
      try {
        sess = await api(connectPath, { method: "POST", body: JSON.stringify({}) });
      } catch (e) { if (!disposed) { setErr(String((e as Error).message)); setStatus("unavailable"); } return; }
      if (disposed) { if (sess.id) fetch(`${API_BASE}/api/terminal/${sess.id}`, { method: "DELETE" }); return; }
      if (!sess.available) { setErr(sess.error || tr("node-pty not available")); setStatus("unavailable"); return; }
      tid = sess.id;
      if (!holder.current) return;

 // xterm gets a NUMBER, not CSS — the app's text size is folded in by `textCount` (lib/appearance.ts).
      term = new Terminal({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: textCount(12), cursorBlink: true, theme: liveTheme(), scrollback: 2000 });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(holder.current);
      try { fit.fit(); } catch { /* ignore */ }
      setStatus("ready");

      const post = (op: string, body: Record<string, unknown>) =>
        fetch(`${API_BASE}/api/terminal/${tid}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
      postRef.current = post;

      es = new EventSource(`${API_BASE}/api/terminal/${tid}/stream`);
 // A reconnect resumes at Last-Event-ID; `replaced` resets the xterm (lib/terminal-stream.ts).
      es.onmessage = (e) => writeTerminalChunk(term, e.data);
      es.addEventListener("exit", () => { es?.close(); if (!disposed) onExit(); });

      term.onData((d) => post("input", { data: d }));
      const doFit = () => { try { fit.fit(); if (term) post("resize", { cols: term.cols, rows: term.rows }); } catch { /* ignore */ } };
      ro = new ResizeObserver(() => doFit());
      ro.observe(holder.current);
      doFit();
      offTextSize = listenTextSize(() => { if (term) { term.options.fontSize = textCount(12); doFit(); } });
      term.focus();
    })();

    return () => {
      disposed = true;
      offTextSize();
      try { es?.close(); } catch { /* ignore */ }
      try { ro?.disconnect(); } catch { /* ignore */ }
      try { term?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      if (tid) fetch(`${API_BASE}/api/terminal/${tid}`, { method: "DELETE" }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "unavailable") {
    return (
      <div className="rounded-2xl border border-edge bg-bg p-4 text-[12.5px] text-dim">
        {t("Login not available")}{err ? `: ${err}` : ""}. {t("Alternatively, sign in from the terminal with")}{" "}
        <code className="rounded bg-panel px-1 font-mono text-[11px]">claude auth login</code>{t(".")}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-bg">
      <div className="flex items-center justify-between border-b border-edge bg-panel px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">{t(title)}</span>
        <button
          onClick={pasteFromClipboard}
          disabled={status !== "ready"}
          className="rounded-full border border-edge px-2.5 py-0.5 text-[11px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          title={t("Paste clipboard into the console")}
        >
          {t("Paste")}
        </button>
      </div>
      <div ref={holder} className="h-[240px] px-2 py-1.5" />
    </div>
  );
}
