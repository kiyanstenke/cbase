"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, API_BASE } from "@/lib/api";
import { instancePath } from "@/lib/code-instance";
import { useResolvedTheme, type ResolvedTheme } from "@/lib/theme";
import { getAccent, useAccent, xtermWithAccent } from "@/lib/accent";
import { useT, tr } from "@/lib/i18n";
import { listenTextSize, textCount } from "@/lib/appearance";
import { writeTerminalChunk } from "@/lib/terminal-stream";

// Integrated terminal (VS Code-like) on xterm.js. Starts a real PTY session in the project folder (backend node-pty),
// output via SSE, input/resize via POST.
export const XTERM_THEMES: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    background: "#ffffff", foreground: "#2a2a2a", cursor: "#1f57f7", cursorAccent: "#ffffff",
    selectionBackground: "rgba(31,87,247,0.22)",
    black: "#2a2a2a", red: "#b91c1c", green: "#1a7f37", yellow: "#9a6700", blue: "#1f57f7", magenta: "#9333ea", cyan: "#0e7490", white: "#e6e3db",
    brightBlack: "#8d919b", brightRed: "#dc2626", brightGreen: "#22a34a", brightYellow: "#b7791f", brightBlue: "#4a7dff", brightMagenta: "#a855f7", brightCyan: "#0891b2", brightWhite: "#111111",
  },
  dark: {
    background: "#181818", foreground: "#d6d6d6", cursor: "#4d89ff", cursorAccent: "#181818",
    selectionBackground: "rgba(77,137,255,0.30)",
    black: "#3a3a3a", red: "#e5705c", green: "#46b483", yellow: "#cfa24a", blue: "#4d89ff", magenta: "#c084fc", cyan: "#4cc4d8", white: "#cccccc",
    brightBlack: "#8f8f8f", brightRed: "#f08a78", brightGreen: "#63cf9d", brightYellow: "#e0b968", brightBlue: "#7aa6ff", brightMagenta: "#d0a5ff", brightCyan: "#6fd6e6", brightWhite: "#f3f3f3",
  },
};
// Cursor and selection follow the chosen accent colour (Settings → Appearance); without a choice the values above
// stay — they ARE the default accent. The ANSI colour `blue` stays blue: it belongs to the programs' output, not the app.
/** Background of a terminal that sits on the page background (terminal tab and the terminal under the editor). xterm
 *  does not read CSS variables; it gets the COMPUTED background colour of the element that carries the page background
 *  (`bg-panel` on the tub = the stage colour, `cb-kit-stage bg-panel` in app/workspaces/page.tsx). Deliberately not
 *  transparent: xterm paints inverted text in the OPAQUE base colour (`opaque(background)`), transparent would mean
 *  black there — in the light theme black text on a dark foreground (less status line, fzf selection). Without an
 *  element or a readable colour the theme's background stays. */
export function xtermOnBackground(theme: Record<string, string>, el: HTMLElement | null): Record<string, string> {
  if (!el) return theme;
  const color = getComputedStyle(el).backgroundColor;
  if (!color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color)) return theme;
  return { ...theme, background: color };
}

const currentTheme = (): Record<string, string> => {
  const mode: ResolvedTheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return xtermWithAccent(XTERM_THEMES[mode], mode, getAccent());
};

// `instance`: the chosen copy of the Code tab — the terminal then starts in its container (web/src/lib/code-instance.ts).
// Without `onClose` it sits in the lower panel (components/code/panel/LowerPanel.tsx): no header of its own — tabs, close
// and "kill terminal" are carried by the panel's header; the end of the session then shows as a line above the terminal.
// `cwd`: the start folder relative to the root — the server checks that it lies inside (devtools/terminal-folder.js);
// without it the root.
// In the panel: `onEnded` — the process ended (VS Code disposes the terminal, the panel closes if it was the last);
// `letThrough` — keys that xterm does NOT take but leaves to the workbench (VS Code `commandsToSkipShell`: outside the
// Mac the shell would otherwise take Ctrl+B and Ctrl+J); the size goes debounced to the PTY (a drag on the resize handle
// would otherwise send a SIGWINCH per frame).
// `onShell`: the shell's name once the server has started it — the terminal's title, like VS Code `${process}`.
export function TerminalPanel({ apiBase, instance = null, cwd = "", onClose, onEnded, onShell, letThrough }: { apiBase: string; instance?: string | null; cwd?: string; onClose?: () => void; onEnded?: () => void; onShell?: (name: string) => void; letThrough?: (e: KeyboardEvent) => boolean }) {
  const t = useT();
  const panelCall = useRef({ onEnded, onShell, letThrough });
  panelCall.current = { onEnded, onShell, letThrough };
  const holder = useRef<HTMLDivElement>(null);
  // The tub in the page background colour — xterm takes its computed colour (`xtermOnBackground`).
  const tub = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<"init" | "ready" | "unavailable" | "exited">("init");
  const [err, setErr] = useState("");
  const resolved = useResolvedTheme();
  const accent = useAccent();

  // Follow the theme live (xterm does not read CSS variables — set the theme explicitly).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermOnBackground(xtermWithAccent(XTERM_THEMES[resolved], resolved, accent), tub.current);
  }, [resolved, accent]);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let es: EventSource | null = null;
    let ro: ResizeObserver | null = null;
    let offTextSize = () => {};
    let tid = "";

    (async () => {
      let sess: { id: string; available: boolean; error?: string; shell?: string };
      try {
        sess = await api(instancePath(`${apiBase}/terminal`, instance), { method: "POST", body: JSON.stringify(cwd ? { cols: 80, rows: 24, cwd } : { cols: 80, rows: 24 }) });
      } catch (e) { if (!disposed) { setErr(String((e as Error).message)); setStatus("unavailable"); } return; }
      if (disposed) { if (sess.id) fetch(`${API_BASE}/api/terminal/${sess.id}`, { method: "DELETE" }); return; }
      if (!sess.available) { setErr(sess.error || tr("node-pty not available")); setStatus("unavailable"); return; }
      tid = sess.id;
      if (typeof sess.shell === "string" && sess.shell) panelCall.current.onShell?.(sess.shell);
      if (!holder.current) return;

      // xterm gets a NUMBER, not CSS — `textCount` factors in the app's text size (lib/appearance.ts).
      term = new Terminal({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: textCount(12), cursorBlink: true, theme: xtermOnBackground(currentTheme(), tub.current), scrollback: 5000 });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(holder.current);
      // Hidden (the Code tab stays mounted but hidden, `display:none`) FitAddon measures "100%" as 100 px and computes
      // 11×7 — the PTY would get a SIGWINCH to 11 columns, and what the process writes meanwhile would stay garbled in
      // the scrollback. Like TerminalsPane: hidden → do not fit; when the tab becomes visible again the ResizeObserver reports the size.
      const visible = () => { const el = holder.current; return !!el && el.offsetWidth > 0 && el.offsetHeight > 0; };
      if (visible()) { try { fit.fit(); } catch { /* ignore */ } }
      setStatus("ready");

      const post = (op: string, body: Record<string, unknown>) =>
        fetch(`${API_BASE}/api/terminal/${tid}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

      es = new EventSource(`${API_BASE}/api/terminal/${tid}/stream`);
      // A reconnect resumes at Last-Event-ID, `replaced` resets the xterm (lib/terminal-stream.ts).
      es.onmessage = (e) => writeTerminalChunk(term, e.data);
      es.addEventListener("exit", () => { setStatus("exited"); es?.close(); panelCall.current.onEnded?.(); });

      term.attachCustomKeyEventHandler((e) => !panelCall.current.letThrough?.(e));
      term.onData((d) => post("input", { data: d }));
      let size = "", sizeClock: ReturnType<typeof setTimeout> | undefined;
      const doFit = () => {
        if (!visible()) return; // hidden → do not fit (see above)
        try { fit.fit(); } catch { /* ignore */ }
        clearTimeout(sizeClock);
        sizeClock = setTimeout(() => {
          if (!term || disposed || `${term.cols}x${term.rows}` === size) return;
          size = `${term.cols}x${term.rows}`;
          post("resize", { cols: term.cols, rows: term.rows });
        }, 100);
      };
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
  }, [apiBase, instance, cwd]);

  // Under the editor: hairline on top, label in the box. No recessed, rounded tub in the theme's own background: the
  // terminal sits borderless on the page background and takes its colour (`xtermOnBackground`).
  return (
    <div className={`flex h-full flex-col ${onClose ? "border-t border-edge" : ""}`}>
      {!onClose && status === "exited" && <div className="shrink-0 px-3 py-1 text-[10.5px] text-dim">{t("— session ended")}</div>}
      {onClose && <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-dim">Terminal</span>
        {status === "exited" && <span className="text-[10.5px] text-dim">{t("— session ended")}</span>}
        <span className="flex-1" />
        <button onClick={onClose} title={t("Close terminal (Ctrl+`)")} className="grid h-6 w-6 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
        </button>
      </div>}
      {status === "unavailable" ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[12px] text-dim">{t("Terminal not available")}{err ? `: ${err}` : ""}.</div>
      ) : (
        <div ref={tub} className="min-h-0 flex-1 overflow-hidden bg-panel">
          <div ref={holder} className="h-full w-full px-3 py-1" />
        </div>
      )}
    </div>
  );
}
