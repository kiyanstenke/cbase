"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { ACK_CHANNEL_START, GONE_STATE_START, ackDue, ackDueFrom, ackSent, rememberAck, ackNewViewer, ackWithoutWait, ackBack, responseApplies, foldInput, ensureAfterGone, ensureTarget, tabAfterHello, tabAfterTabs, countGone, type Input } from "@/lib/browser-stream";
import { nativeAvailable, scopeFromApiBase } from "@/lib/browser-native";
import { MESS_TOGGLE, MEASURE_TICK_MS, measuringOn, messSummary, streamUrl, type MessFrame, type MessClick } from "@/lib/browser-wire";
import { streamSource, type StreamSource } from "@/lib/browser-source";
import { chatPath } from "@/lib/chat-instance";
import { fitting, wheelTarget, viewportMatches } from "@/lib/browser-surface";
import { BrowserNative } from "@/components/BrowserNative";
import { useT } from "@/lib/i18n";
import { Hint, Placeholder, ghostSm } from "@/components/CbKit";

// Streamed browser: server-side Chromium, frames over SSE (JPEG screencast), input by POST — so it works identically without
// the gateway AND in client/server operation (through the gateway, like the terminal). Two modes:
//  • apiBase set   → browser tab: own user browser per scope (ensure + full control)
//  • browserId set → viewer (agent browser): watch + intervene, but no navigation/tab management (the browser belongs to the
//    agent)
// Two forms: `page` is the page's browser tab, `bar` the browser section of the right chat bar — flush on the panel, no second
// frame; tab row, address row and page image are the same. Neither has a glass surface: tab row, address row and page image
// stand edge-to-edge on the stage; a hairline under the address row, the page image below without rounding, border and tray of
// its own — on the page background where the image does not fill it. DevTools hang under a hairline (it is also the handle).
// The "Agent browser" badge is a dot with a word instead of a capsule.
//
// In front of it sits a VERSION SWITCH: in the cbase Client with the bridge `window.cbaseClient.browser` the USER browser gets a
// real WebContentsView of the window (BrowserNative) instead of the stream — rendered locally, no round trip per frame. The
// AGENT browser (browserId) streams in every case: it belongs to the agent and runs in the container. An old client without
// the bridge falls back to the stream because it does not exist — a switch, not an error path.
//
// `chatId` and `onlyStream`: the right chat bar passes its chat along — `/browser/ensure?chat=<id>` (lib/chat-instance.ts
// `chatPath`, only on a project route) then returns the browser of THAT chat's INSTANCE: in a copy chat that of the copy
// (scope `proj:<id>@copy-<name>`, own profile), otherwise that of the project. `onlyStream` turns the switch off: the native
// browser is that of scope `proj:<id>` (the page's tab), never the copy.
//
// lib/browser-surface.ts computes how the page image sits: in the bar it fills the HEIGHT and scrolls sideways where wider, in
// the tab and the extra window it is fitted fully visible. The page view (`data-browser-surface`) is itself the scroll surface;
// a NATIVE listener hears the wheel (React registers `wheel` as passive; without preventDefault the surface scrolled along on
// every diagonal swipe and at the edge macOS swiped the page back). The pointer conversion (`toPage`) reads the canvas
// rectangle — so after scrolling it is right by itself.
// `agent`: the tab in which the agent last acted (new tab, new address — browsers.js rememberActivity).
type TabInfo = { id: string; title: string; url: string; active: boolean; agent?: boolean };

const MOD = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BTN = ["left", "middle", "right"] as const;

export function BrowserPane(props: {
  apiBase?: string;
  chatId?: string | null;
  onlyStream?: boolean;
  browserId?: string;
  active?: boolean;
  variant?: "page" | "bar";
}) {
  // The switch stands BEFORE the hooks of the streamed pane, in a thin component of its own: an `if` in the middle of
  // BrowserStream would break the hook order as soon as the bridge appears. And it decides only AFTER mount — the SSR build has
  // no `window`, and a first render that already assumes the bridge would be a hydration mismatch.
  //
  // Until the decision stands (`null`), NEITHER pane is mounted. The reason is React's order: child effects run before parent
  // effects — a pre-mounted BrowserStream would first call `/browser/ensure` (starts Chromium in the container) and then be
  // thrown out of the tree. An empty surface for one frame is cheaper than a browser nobody wanted.
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => { setNative(nativeAvailable(window)); }, []);
  const scope = props.apiBase ? scopeFromApiBase(props.apiBase) : null;
  if (native === null) {
    return <div className="min-h-0 flex-1" />;
  }
  if (native && scope && !props.browserId && !props.onlyStream) {
    return <BrowserNative scope={scope} active={props.active} variant={props.variant} />;
  }
  return <BrowserStream {...props} />;
}

function BrowserStream({
  apiBase,
  chatId = null,
  browserId: fixedId,
  active = true,
  variant = "page",
}: {
  apiBase?: string;
  chatId?: string | null;
  onlyStream?: boolean;
  browserId?: string;
  active?: boolean;
  variant?: "page" | "bar";
}) {
  // What still differs per form: the hairline under the address row and the page image (page: edge-to-edge, bar: the inset
  // tray).
  const page = variant !== "bar";
  const t = useT();
  const [browserId, setBrowserId] = useState(fixedId || "");
  const [kind, setKind] = useState<"user" | "agent">(fixedId ? "agent" : "user");
  const [label, setLabel] = useState("");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [selTab, setSelTab] = useState(""); // tab chosen by the client (determines the stream)
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [gone, setGone] = useState(false);
  const [devOpen, setDevOpen] = useState(false); // Chrome DevTools drawer (docked at the bottom)
  const [devH, setDevH] = useState(320);
  const [devDrag, setDevDrag] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null); // focusable input layer — and the scroll surface
  const wrapRef = useRef<HTMLDivElement>(null); // measures the pane size (resize → emulation)
  const frameMeta = useRef({ w: 1280, h: 800 }); // CSS viewport of the page (coordinate mapping)
  // The fitting (lib/browser-surface): the viewport of the shown frame, the size of the page view and the measured height of a
  // horizontal scroll bar. The elements enter the state via stable callback refs — the surface is rendered only after the
  // start/error branch, an effect with [] would never find it.
  const [frameGr, setFrameGr] = useState<{ w: number; h: number } | null>(null);
  const frameGrRef = useRef<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [scrollbar, setScrollbar] = useState(0);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const hostCb = useCallback((el: HTMLDivElement | null) => { hostRef.current = el; setHostEl(el); }, []);
  const wrapCb = useCallback((el: HTMLDivElement | null) => { wrapRef.current = el; setWrapEl(el); }, []);
  const handleRef = useRef(false); // a press on the scroll bar: belongs to the scroll bar, not the page
  const fetchViewportRef = useRef<() => void>(() => {}); // own browser: pull the viewport to THIS pane
  const frameToken = useRef(0); // draw only the NEWEST frame (image decode is async)
  const queueRef = useRef<Input[]>([]);
  const esRef = useRef<StreamSource | null>(null);
  // Live measurement (lib/browser-wire.ts): read once per pane — localStorage toggle or `?measure=1` in the address.
  const measureRef = useRef<boolean | null>(null);
  if (measureRef.current === null) {
    try { measureRef.current = typeof window !== "undefined" && measuringOn(window.location.search, window.localStorage.getItem(MESS_TOGGLE)); }
    catch { measureRef.current = false; }
  }
  const messFrames = useRef<MessFrame[]>([]);
  const messClicks = useRef<MessClick[]>([]);
  const messEncoding = useRef("");
  const idRef = useRef(""); // browserId for callbacks without re-subscribing
  idRef.current = browserId;
  const selRef = useRef("");
  selRef.current = selTab;
  const vidRef = useRef(""); // viewer id (from the server, for frame acks/flow control)
  // Loop breaker: "gone" calls ensure() at most ONCE per incident — lib/browser-stream.
  const goneRef = useRef(GONE_STATE_START);
  // The agent's tab as the server last named it (hello/tabs `agentTab`). If it changes — the agent opens a tab or navigates in
  // another —, the view of an AGENT viewer follows; a click on a tab holds until the agent switches. On a chat's browser it
  // never jumps — there the tab is only marked (lib/browser-stream.ts tabAfterTabs).
  const agentTabRef = useRef("");

  const base = `${API_BASE}/api/browsers`;

  // ── The pane's target ── If it changes (another chat, another scope), nothing of the old one belongs any more: session, tabs,
  // selection and image drop, the stream ends with the session (its effect hangs on browserId), an image being decoded lapses
  // (frameToken), and a still-running ensure() answer no longer applies (responseApplies).
  const target = ensureTarget(apiBase, chatId);
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetPrior = useRef(target);
  useEffect(() => {
    if (targetPrior.current === target) return;
    targetPrior.current = target;
    frameToken.current++;
    goneRef.current = GONE_STATE_START;
    agentTabRef.current = "";
    setBrowserId(fixedId || "");
    setTabs([]);
    setSelTab("");
    setError("");
    setGone(false);
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [target, fixedId]);

  // ── Ensure the user browser (browser tab) ──
  const ensure = useCallback(async () => {
    if (!apiBase) return;
    const asked = ensureTarget(apiBase, chatId);
    setStarting(true);
    setError("");
    try {
      const r = await api<{ id?: string; error?: string }>(chatPath(apiBase, "/browser/ensure", chatId), { method: "POST" });
      if (!responseApplies(asked, targetRef.current)) return; // the pane meanwhile shows another target (chat switch)
      if (r.error || !r.id) setError(r.error || "Error");
      else {
        setGone(false);
        setBrowserId(r.id);
      }
    } catch (e) {
      if (responseApplies(asked, targetRef.current)) setError(String((e as Error).message || e));
    } finally {
      setStarting(false);
    }
  }, [apiBase, chatId]);

  useEffect(() => {
    if (!fixedId && active && !browserId && ensureAfterGone(goneRef.current)) void ensure();
  }, [fixedId, active, browserId, ensure]);

  // ── Send input at once, but strictly serialized: only ONE POST in flight. ──
  // Parallel POSTs can overtake each other over HTTP (mouseReleased arrives before mousePressed → "dead" clicks, broken drags).
  // While a batch is in flight, new events collect and go out afterwards bundled — order guaranteed, latency = 1 RTT.
  const inflightRef = useRef(false);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushInput = useCallback(() => {
    // Over the wire (lib/browser-source): the socket keeps the order itself, no POST in flight. Hover and wheel collect for up
    // to one frame tick (16 ms, foldInput), everything else goes at once — with what was collected before it.
    if (esRef.current?.transport === "ws" && queueRef.current.length && idRef.current) {
      const onlyFoldable = queueRef.current.every((e) => e.type === "mouseMoved" || e.type === "mouseWheel");
      if (onlyFoldable && !foldTimer.current) { foldTimer.current = setTimeout(() => { foldTimer.current = null; flushInput(); }, 16); return; }
      if (onlyFoldable && foldTimer.current) return;
      if (esRef.current.send({ tab: selRef.current, events: queueRef.current })) { queueRef.current = []; return; }
    }
    if (inflightRef.current || !queueRef.current.length || !idRef.current) return;
    const events = queueRef.current;
    queueRef.current = [];
    inflightRef.current = true;
    void api(`${base}/${idRef.current}/input`, {
      method: "POST",
      body: JSON.stringify({ tab: selRef.current, events }),
    })
      .catch(() => {})
      .finally(() => {
        inflightRef.current = false;
        if (queueRef.current.length) flushInput();
      });
  }, [base]);
  const push = useCallback((e: Record<string, unknown>) => {
 // Hover replaces, wheel sums, everything else stays single (lib/browser-stream foldInput).
    queueRef.current = foldInput(queueRef.current, e as Input);
    flushInput();
  }, [flushInput]);

  // ── Frame acknowledgements on a CHANNEL of their own, not behind the input POST. ──
  // Serialized behind the input POST, one ack went out per round trip and released ONE frame — fps ≈ 1/RTT, 2 fps over
  // Cloudflare. Acks may overtake each other (seq is monotonic, the server takes the maximum), mouse and keyboard may not — so
  // two channels on the same route. The rules (one POST in flight, only the newest seq) live in lib/browser-stream.
  // And the ack waits for the burst: sent at once, it acknowledged only the FIRST frame of a burst, the rest arrived during the
  // POST and went out only after it returned — two round trips per window, 16.8 fps at 150 as at 300 ms instead of the 30 the
  // window would carry. So flushAck schedules via setTimeout for the due time (ackDueFrom: 20 ms after the last frame, at the
  // latest 50 after the first unacknowledged) instead of sending at once; one POST in flight remains.
  // Except in a HIDDEN tab: there Chrome aligns setTimeout to whole seconds (925–1077 ms for 20 ms), the ack would come up to
  // 1 s late, and the server would read the base RTT from it. fetch is not throttled — the ack goes at once there
  // (ackWithoutWait), and switching to the background sends a scheduled one right away (visibilitychange below).
  const ackRef = useRef(ACK_CHANNEL_START);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ackTimerClean = useCallback(() => { if (ackTimer.current) { clearTimeout(ackTimer.current); ackTimer.current = null; } }, []);
  const flushAck = useCallback(() => {
    ackTimerClean();
    if (!idRef.current || !vidRef.current) return;
    const now = Date.now();
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const seq = hidden ? ackWithoutWait(ackRef.current) : ackDue(ackRef.current, now);
    if (seq === null) {
 // Not due yet: schedule for the time. Every further frame reschedules (ack → flushAck).
      const start = ackDueFrom(ackRef.current);
      if (start !== null) ackTimer.current = setTimeout(flushAck, start - now);
      return;
    }
    ackRef.current = ackSent(ackRef.current, seq);
    void api(`${base}/${idRef.current}/input`, {
      method: "POST",
      body: JSON.stringify({ tab: selRef.current, events: [{ t: "ack", v: vidRef.current, seq }] }),
    })
      .catch(() => {})
      .finally(() => {
        ackRef.current = ackBack(ackRef.current);
        flushAck();
      });
  }, [base, ackTimerClean]);
  const ack = useCallback((seq: number) => {
    ackRef.current = rememberAck(ackRef.current, seq, Date.now());
 // Over the wire every ack goes at once — the socket has no "one POST in flight", bundling was that path's price.
    if (esRef.current?.transport === "ws" && vidRef.current && esRef.current.send({ tab: selRef.current, events: [{ t: "ack", v: vidRef.current, seq }] })) return;
    flushAck();
  }, [flushAck]);
  // If the tab is hidden while an ack is scheduled, its timer would fire only on the full second: flushAck sends it now (hidden
  // ⇒ without waiting). Coming back only reschedules.
  useEffect(() => {
    document.addEventListener("visibilitychange", flushAck);
    return () => document.removeEventListener("visibilitychange", flushAck);
  }, [flushAck]);

  // ── Stream: hello → metadata, tabs → tab bar, frame → canvas ──
  // Over lib/browser-source: first the WebSocket wire (frames binary), else SSE — the same handlers.
  useEffect(() => {
    if (!browserId || !active) return;
    const measure = Boolean(measureRef.current);
    const sseUrl = `${base}/${browserId}/stream${selTab || measure ? "?" : ""}${new URLSearchParams({ ...(selTab ? { tab: selTab } : {}), ...(measure ? { measure: "1" } : {}) }).toString()}`;
    const es = streamSource({ wsUrl: streamUrl(API_BASE, window.location.href, browserId, selTab, measure), sseUrl });
    esRef.current = es;
    const token = ++frameToken.current;
    es.addEventListener("hello", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      setKind(d.kind);
      setLabel(d.label || "");
      setTabs(d.tabs || []);
      setGone(false);
      vidRef.current = d.vid || "";
      ackTimerClean(); // a scheduled ack belonged to the old viewer
      ackRef.current = ackNewViewer(ackRef.current); // seq counts from the start
      if (fixedId && d.agentTab) agentTabRef.current = d.agentTab; // hello already hangs on it (the server's active tab)
      const tab = tabAfterHello({ sel: selRef.current, tab: d.tab || "", agentTab: d.agentTab || "", fixed: Boolean(fixedId) });
      if (tab && tab !== selRef.current) setSelTab(tab);
    });
    es.addEventListener("tabs", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      setTabs(d.tabs || []);
      const followUp = tabAfterTabs({ sel: selRef.current, agentTab: d.agentTab || "", prior: agentTabRef.current, fixed: Boolean(fixedId) });
      if (fixedId && d.agentTab) agentTabRef.current = d.agentTab;
      if (followUp) setSelTab(followUp);
    });
    es.addEventListener("frame", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data);
      // Acknowledge receipt at once (flow control): the server holds only one window of unacknowledged frames in the line per
      // link — so no old images pile up on slow links.
      if (d.seq && vidRef.current) ack(d.seq);
      // An image means the browser lives — only that ends a "gone" incident (not "hello").
      goneRef.current = countGone(goneRef.current, "frame");
      if (selRef.current && d.tab !== selRef.current) return; // frame of an old tab
      const my = ++frameToken.current;
      const ta = Date.now();
      // createImageBitmap decodes off the main thread — smoother than <img> decode. From the wire the bytes already arrive raw.
      const bytes = (ev as { bytes?: Uint8Array }).bytes ?? Uint8Array.from(atob(d.data), (ch) => ch.charCodeAt(0));
      if (measure) {
        const k = messClicks.current.find((x) => !x.image);
        if (k) k.image = ta;
      }
      createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }))
        .then((bmp) => {
          if (measure) messFrames.current.push({ ta, n: bytes.length, tc: d.tc, tr: d.tr, tb: d.tb, px: bmp.width, w: d.w });
          if (frameToken.current !== my || !canvasRef.current) { bmp.close(); return; }
          const c = canvasRef.current;
          if (c.width !== bmp.width || c.height !== bmp.height) {
            c.width = bmp.width;
            c.height = bmp.height;
          }
          const ctx = c.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bmp, 0, 0);
          }
          bmp.close();
          frameMeta.current = { w: d.w, h: d.h };
          // Only a CHANGE of the viewport re-renders (the agent changes it, another tab, the emulation takes effect).
          const old = frameGrRef.current;
          if (d.w > 0 && d.h > 0 && (!old || old.w !== d.w || old.h !== d.h)) {
            frameGrRef.current = { w: d.w, h: d.h };
            setFrameGr(frameGrRef.current);
          }
        })
        .catch(() => {});
    });
    es.addEventListener("tabclosed", () => setSelTab(""));
    es.addEventListener("gone", () => {
      // The server ended the stream — close, else EventSource reconnects by itself (in viewer mode browserId stays the same, no
      // effect then cleans up: "gone" every 3 s).
      es.close();
      // And for the same reason clean up the ack timer here: if the cleanup does not run (fixedId, tab already empty), a
      // scheduled ack would send its POST to a viewer that does not exist.
      ackTimerClean();
      // Count first, then clear the id: the ensure effect reads the state in the same render.
      goneRef.current = countGone(goneRef.current, "gone");
      setGone(true);
      setBrowserId(fixedId || "");
      // The chosen tab belonged to this session; the next has other ids. If it stayed, the frame filter above would drop every
      // image of the new session (black surface after the idle stop). As on a restart via the DevTools.
      setSelTab("");
    });
    es.onerror = () => {
      /* EventSource reconnects by itself; 'gone' ends on the server side */
    };
    // The measurement asks once how the SSE stream arrives (compressed? — Cloudflare): the headers of a second request,
    // aborted right away. There is no such thing on the wire (perMessageDeflate is off).
    const probe = measure ? new AbortController() : null;
    if (probe) void fetch(sseUrl, { signal: probe.signal, credentials: "include" }).then((r) => { messEncoding.current = r.headers.get("content-encoding") || "none"; probe.abort(); }).catch(() => {});
    return () => {
      es.close();
      probe?.abort();
      ackTimerClean(); // a scheduled ack after the end of the stream would be a POST into the void
      if (frameToken.current === token) frameToken.current++;
    };
  }, [browserId, selTab, active, base, fixedId, ack, ackTimerClean]);

  // ── Live measurement: a summary every MEASURE_TICK_MS to POST /measurement (the backend appends it, capped) ──
  useEffect(() => {
    if (!measureRef.current || !browserId || !active) return;
    let start = Date.now();
    messFrames.current = [];
    messClicks.current = [];
    const tick = setInterval(() => {
      const now = Date.now();
      const box = wrapRef.current?.getBoundingClientRect();
      const z = messSummary(messFrames.current, messClicks.current.filter((k) => k.image), now - start, {
        transport: esRef.current?.transport || "", encoding: esRef.current?.transport === "ws" ? "ws" : messEncoding.current,
        client: "web", browser: navigator.userAgent.slice(0, 40),
        width_px: Math.round(box?.width || 0), height_px: Math.round(box?.height || 0), dpr: window.devicePixelRatio || 1,
      });
      messFrames.current = [];
      messClicks.current = [];
      start = now;
      void api(`${base}/measurement`, { method: "POST", body: JSON.stringify(z) }).catch(() => {});
    }, MEASURE_TICK_MS);
    return () => clearInterval(tick);
  }, [browserId, active, base]);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * frameMeta.current.w,
      y: ((e.clientY - rect.top) / rect.height) * frameMeta.current.h,
    };
  };
  // A press BELOW the content height of the surface lies on its scroll bar: that drags by itself (no preventDefault), and until
  // release nothing goes to the page — else it would get a click at its lower edge.
  const onScrollbar = (e: React.MouseEvent) => {
    const el = hostRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return false;
    return e.clientY >= el.getBoundingClientRect().top + el.clientHeight;
  };
  const mouse = (type: string) => (e: React.MouseEvent) => {
    if (!idRef.current) return;
    if (type === "mousePressed" && onScrollbar(e)) {
      handleRef.current = true;
      // Bubble phase on the window: after the surface's onMouseUp (React listens at the root), which thus stays silent.
      window.addEventListener("mouseup", () => { handleRef.current = false; }, { once: true });
      return;
    }
    if (handleRef.current) return;
    if (type === "mousePressed") hostRef.current?.focus();
    // Measurement: click → next image; the frame handler sets the image.
    if (type === "mousePressed" && measureRef.current) messClicks.current.push({ from: Date.now(), image: 0 });
    e.preventDefault();
    push({
      t: "mouse", type, ...toPage(e),
      button: type === "mouseMoved" ? "none" : BTN[e.button] || "left",
      buttons: e.buttons, clickCount: type === "mouseMoved" ? 0 : (e.detail || 1), modifiers: MOD(e),
    });
  };
  // The wheel (rule: lib/browser-surface wheelTarget): vertical goes to the page; horizontal (or Shift) scrolls the surface as
  // long as it can in that direction, else to the page. Always preventDefault — the surface scrolls only when the rule says so.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!idRef.current) return;
    e.preventDefault();
    const el = hostRef.current;
    const target = el
      ? wheelTarget({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shift: e.shiftKey, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })
      : null;
    if (el && target?.target === "surface") { el.scrollLeft += target.dx; return; }
    // The DOM sign, unchanged: CDP `mouseWheel` scrolls like a DOM wheel (+deltaY = down), iOS sends it the same way. A
    // `-e.deltaY` here made every page in the streamed browser scroll upside down and the wheel hand-over at the surface edge
    // run backwards.
    push({ t: "mouse", type: "mouseWheel", ...toPage(e), button: "none", buttons: 0, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: MOD(e) });
  };
  useEffect(() => {
    if (!hostEl) return;
    const wheel = (e: WheelEvent) => wheelRef.current(e);
    hostEl.addEventListener("wheel", wheel, { passive: false });
    return () => hostEl.removeEventListener("wheel", wheel);
  }, [hostEl]);
  const key = (type: "keyDown" | "keyUp") => (e: React.KeyboardEvent) => {
    if (!idRef.current) return;
 // ⌘/Ctrl+V: let the paste event through (onPaste delivers the text to the remote page)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    e.stopPropagation();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    push({
      t: "key", type, key: e.key, code: e.code,
      text: type === "keyDown" ? (printable ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined,
      winCode: e.keyCode, modifiers: MOD(e), repeat: e.repeat,
    });
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    e.preventDefault();
    if (text) push({ t: "text", text });
  };

  // ── Pane size → page viewport (user browser only; the agent's viewport stays untouched) ──
  useEffect(() => {
    if (!browserId || kind !== "user" || !active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      const el = wrapRef.current;
      if (!el || !idRef.current) return;
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      void api(`${base}/${idRef.current}/act`, {
        method: "POST",
        body: JSON.stringify({ type: "resize", width: Math.floor(r.width), height: Math.floor(r.height), dpr: Math.min(2, window.devicePixelRatio || 1) }),
      }).catch(() => {});
    };
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(send, 120);
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    send();
    fetchViewportRef.current = send;
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      fetchViewportRef.current = () => {};
    };
  }, [browserId, kind, active, base]);

  // ── Fitting: measure the page view's size, size the image accordingly (lib/browser-surface) ──
  useEffect(() => {
    if (!wrapEl) return;
    const miss = () => {
      const w = wrapEl.clientWidth;
      const h = wrapEl.clientHeight;
      setBox((old) => (old && old.w === w && old.h === h ? old : { w, h }));
    };
    miss();
    const ro = new ResizeObserver(miss);
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);
  const situation = frameGr && box
    ? fitting({ frameW: frameGr.w, frameH: frameGr.h, boxW: box.w, boxH: box.h, mode: variant === "bar" ? "height" : "whole", scrollbar })
    : null;
  // The surface itself measures the scroll bar height as soon as it scrolls (0 for overlay scroll bars, else the track from
  // `cb-scroll-track`) — the image then stands above it instead of being covered by it.
  useLayoutEffect(() => {
    if (!hostEl || !situation?.scrolls) return;
    const lane = hostEl.offsetHeight - hostEl.clientHeight;
    if (lane >= 0 && lane < 40 && lane !== scrollbar) setScrollbar(lane);
  }, [hostEl, situation?.scrolls, situation?.w, situation?.h, scrollbar]);
  // Another tab, another session: the surface starts at the left.
  useEffect(() => {
    if (hostRef.current) hostRef.current.scrollLeft = 0;
  }, [selTab, browserId]);
  // The own browser has ONE viewport. If a second viewer shows it (the extra window), the last measured one holds — when the
  // pointer enters this pane it takes it back (only then, not on press: a click whose release arrived in the new viewport
  // would miss).
  const fetchViewport = () => {
    if (kind === "user" && frameGr && box && !viewportMatches(frameGr, box)) fetchViewportRef.current(); // viewportMatches clamps like the server
  };

  const doAct = useCallback(
    (body: Record<string, unknown>) => {
      if (!idRef.current) return Promise.resolve(null);
      return api<{ ok?: boolean; tab?: string }>(`${base}/${idRef.current}/act`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    },
    [base],
  );

  const activeTab = tabs.find((x) => x.id === selTab) || tabs.find((x) => x.active) || tabs[0];

  // ── Real Chrome DevTools: the frontend served by the remote Chromium itself, in an iframe. ──
  // HTTP + WebSocket run through our /api/browsers/:id/devtools/* proxy (gateway-capable); the ws=/wss= parameter points to the
  // page endpoint of the currently chosen tab.
  const devTab = selTab || activeTab?.id || "";
  const devSrc = (() => {
    if (!devOpen || !browserId || !devTab || typeof window === "undefined") return "";
    let host = window.location.host;
    let secure = window.location.protocol === "https:";
    let prefix = "";
    if (API_BASE) {
      try {
        const u = new URL(API_BASE, window.location.href);
        host = u.host;
        secure = u.protocol === "https:";
        prefix = u.pathname.replace(/\/$/, "");
      } catch { /* relative — the origin applies */ }
    }
    const wsPath = `${host}${prefix}/api/browsers/${browserId}/devtools/page/${devTab}`;
    return `${base}/${browserId}/devtools/inspector.html?${secure ? "wss" : "ws"}=${wsPath}`;
  })();
  const startDevDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDevDrag(true);
    const startY = e.clientY;
    const startH = devH;
    const move = (ev: MouseEvent) => setDevH(Math.max(140, Math.min(window.innerHeight - 260, startH + (startY - ev.clientY))));
    const up = () => {
      setDevDrag(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // The URL row follows the active tab as long as it is not being edited.
  useEffect(() => {
    if (!urlFocused) setUrlInput(activeTab?.url === "about:blank" ? "" : activeTab?.url || "");
  }, [activeTab?.url, urlFocused]);

  const navigate = () => {
    void doAct({ type: "navigate", tab: selTab, url: urlInput });
    hostRef.current?.focus();
  };
  const selectTab = (id: string) => {
    setSelTab(id);
    if (kind === "user") void doAct({ type: "selectTab", tab: id });
  };
  const newTab = async () => {
    const r = await doAct({ type: "newTab" });
    if (r?.tab) setSelTab(r.tab);
  };

  const interactive = kind === "user";

  if (!fixedId && (error || gone) && !starting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        {error
          ? <div className="w-full max-w-[420px]"><Hint tone="warn">{error}</Hint></div>
          : <Placeholder title={t("Browser was closed.")} />}
        <button onClick={() => { goneRef.current = GONE_STATE_START; void ensure(); }} className={ghostSm}>
          {t("Start browser")}
        </button>
      </div>
    );
  }

  // Tabs in the idiom of the page header (level 2, underlined instead of boxed), address row as a tray, below it the page — on
  // the page edge-to-edge under a hairline, in the bar as an inset surface.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-edge px-2 pt-1.5">
        <div className="cb-strip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tb) => {
            const on = (selTab || activeTab?.id) === tb.id;
            return (
            <div
              key={tb.id}
              role="tab"
              aria-selected={on}
              onClick={() => selectTab(tb.id)}
              title={tb.url}
              className={`group relative flex max-w-[200px] min-w-[110px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2 py-1 pb-1.5 text-[12px] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full ${
                on ? "font-semibold text-accent after:bg-accent/70" : "font-medium text-dim after:bg-transparent hover:bg-hover hover:text-fg"
              }`}
            >
              {/* The tab in which the agent works: on the agent browser a dot; on a chat's browser the "Agent" mark — there the
                  person switches over themselves, the view does not jump. */}
              {tb.agent && (interactive
                ? <span data-browser-agent-tab="marker" className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-semibold leading-4 text-accent" title={t("The agent is working in this tab")}>{t("Agent")}</span>
                : <span data-browser-agent-tab className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("in use##controlling")} />)}
              <span className="min-w-0 flex-1 truncate">{tb.title || tb.url || t("New tab")}</span>
              {interactive && tabs.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void doAct({ type: "closeTab", tab: tb.id });
                  }}
                  className="hidden h-4 w-4 shrink-0 place-items-center rounded text-dim hover:bg-edge hover:text-fg group-hover:grid"
                  title={t("Close tab")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                </button>
              )}
            </div>
            );
          })}
          {interactive && (
            <button
              onClick={() => void newTab()}
              className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
              title={t("New tab")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>
          )}
        </div>
        {/* In the bar the header already says whose browser this is — there the badge cost the tab row. */}
        {kind === "agent" && variant !== "bar" && (
          <span className="mb-1 flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[11.5px] text-dim">
            {/* Static: the badge names WHAT this tab is — a permanent state. Dot with word, no capsule. */}
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("Agent browser")}{label ? ` · ${label}` : ""}
          </span>
        )}
      </div>
      {/* Navigation row — on the page with the hairline to the page image below */}
      <div className={`flex items-center gap-1 px-2 py-1.5 ${page ? "border-b border-edge" : ""}`}>
        <button onClick={() => void doAct({ type: "back", tab: selTab })} disabled={!interactive} className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-40" title={t("Back")}>
          <NavIcon d="M15 6l-6 6 6 6" />
        </button>
        <button onClick={() => void doAct({ type: "forward", tab: selTab })} disabled={!interactive} className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-40" title={t("Forward")}>
          <NavIcon d="M9 6l6 6-6 6" />
        </button>
        <button onClick={() => void doAct({ type: "reload", tab: selTab })} disabled={!interactive} className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-40" title={t("Reload")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={(e) => {
            setUrlFocused(true);
            e.target.select();
          }}
          onBlur={() => setUrlFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate();
          }}
          readOnly={!interactive}
          placeholder={interactive ? t("URL or search — e.g. localhost:3000") : ""}
          // Address row as a tray without a frame (Kit `field` idiom, only in monospace and 12 px: a URL is an address, not
          // running text).
          className="ml-1 min-w-0 flex-1 rounded-full bg-bg px-3.5 py-1.5 font-mono text-[12px] outline-none transition-colors placeholder:text-dim focus:bg-panel focus:ring-1 focus:ring-accent/50"
          spellCheck={false}
        />
        {starting && <span className="shrink-0 text-[11px] text-dim">{t("starting …")}</span>}
        <button
          onClick={() => setDevOpen((v) => !v)}
          disabled={!browserId || !devTab}
          aria-pressed={devOpen}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors disabled:opacity-40 ${devOpen ? "bg-edge text-fg" : "text-dim enabled:hover:bg-hover enabled:hover:text-fg"}`}
          title="DevTools"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 9l-4 3 4 3" />
            <path d="M16 9l4 3-4 3" />
            <path d="M13.5 6l-3 12" />
          </svg>
        </button>
      </div>
      {/* Page view: canvas + input layer */}
      <div ref={wrapCb} className={`relative min-h-0 flex-1 overflow-hidden ${page ? "" : "mx-2 mb-2 rounded-xl bg-code"}`}>
        {/* The surface scrolls only sideways (overflow-y hidden) and holds a swipe at its edge (overscroll-x contain — else macOS
            pages the cbase page back). Centered via `mx-auto` instead of justify-center: a centered flex content wider than the
            surface would stick out at the left, where no scroll bar goes. */}
        <div
          ref={hostCb}
          tabIndex={0}
          data-browser-surface={situation ? (situation.scrolls ? "scrolls" : "matches") : "preset"}
          className="cb-scroll-track absolute inset-0 flex items-start overflow-x-auto overflow-y-hidden overscroll-x-contain outline-none"
          onMouseDown={mouse("mousePressed")}
          onMouseUp={mouse("mouseReleased")}
          onMouseMove={mouse("mouseMoved")}
          onMouseEnter={fetchViewport}
          onKeyDown={key("keyDown")}
          onKeyUp={key("keyUp")}
          onPaste={onPaste}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas
            ref={canvasRef}
            className={situation ? "mx-auto shrink-0" : kind === "user" ? "h-full w-full" : "mx-auto max-h-full max-w-full"}
            style={situation ? { width: situation.w, height: situation.h, imageRendering: "auto" } : { imageRendering: "auto" }}
          />
        </div>
        {!tabs.length && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-dim">
            {starting || (!gone && !error && !browserId) ? t("Browser starting …") : t("No tab open.")}
          </div>
        )}
      </div>
      {/* DevTools drawer: docked at the bottom like in Chrome; the page view shrinks with it (the ResizeObserver adapts the
          remote viewport automatically). */}
      {devOpen && devSrc && (
        <>
          {/* The handle: in the bar a ridge, on the page the hairline itself (with a 4 px grab area below). */}
          <div onMouseDown={startDevDrag} className={page
            ? "h-1 shrink-0 cursor-row-resize border-t border-edge transition-colors hover:bg-accent/50"
            : "mx-2 mb-2 h-1 shrink-0 cursor-row-resize rounded-full bg-edge transition-colors hover:bg-accent/50"} />
          <div className={`relative shrink-0 overflow-hidden ${page ? "" : "mx-2 mb-2 rounded-xl"}`} style={{ height: devH }}>
            {devDrag && <div className="absolute inset-0 z-10" />}
            <DevtoolsFrame key={`${browserId}:${devTab}`} src={devSrc} onRestart={interactive ? async () => {
              // Restart a stuck browser: end it (tabs are saved) + ensure again.
              await api(`${base}/${browserId}`, { method: "DELETE" }).catch(() => {});
              setDevOpen(false);
              setBrowserId(fixedId || "");
              setSelTab("");
            } : undefined} />
          </div>
        </>
      )}
    </div>
  );
}

// The DevTools interface of a browser in the project container is served by the backend from its own Chromium — if none
// matches the browser's version, a notice with the marker `meta[name="cbase-devtools"]` (server/backend/electron/server/
// browsers.js noUi) comes instead of inspector.html, shown here in the app's language and form. The frame has the same origin;
// if it is foreign, the page itself stays — it says the same.
type NoUi = { reason: string; instance: string; b: string };
function readNoUi(frame: HTMLIFrameElement | null): NoUi | null {
  try {
    const m = frame?.contentDocument?.querySelector('meta[name="cbase-devtools"]');
    if (!m || m.getAttribute("content") !== "no-ui") return null;
    return { reason: m.getAttribute("data-reason") || "", instance: m.getAttribute("data-instance") || "", b: m.getAttribute("data-b") || "" };
  } catch { return null; } // foreign origin — the page in the frame speaks for itself
}

// DevTools iframe with a load watchdog: if the frontend renders no content after 20 s (e.g. a stuck debug HTTP handler of
// Chromium), offer a notice + restart.
function DevtoolsFrame({ src, onRestart }: { src: string; onRestart?: () => Promise<void> }) {
  const t = useT();
  const [stuck, setStuck] = useState(false);
  const [no, setNo] = useState<NoUi | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    setNo(null);
    const timer = setTimeout(() => {
      try {
        const frame = frameRef.current;
        if (!frame) return; // the "no matching interface" notice already stands in its place
        const doc = frame.contentDocument;
        if (!doc || !doc.body || doc.body.children.length === 0) setStuck(true);
      } catch { /* cross-origin (should not happen) — force nothing */ }
    }, 20_000);
    return () => clearTimeout(timer);
  }, [src]);
  if (no) {
    const reason = no.reason === "version"
      ? t("The browser in the project container is Chromium {instance}; cbase ships the interface of Chromium {b}. It will match again once the project container has been recreated with the current image.", { instance: no.instance, b: no.b })
      : no.reason === "source"
        ? t("cbase could not start its own Chromium, which supplies the interface.")
        : t("The browser in the project container does not report a readable version.");
    return (
      <div data-devtools-no-ui={no.reason} className="flex h-full w-full flex-col items-center justify-center gap-3 bg-code">
        <div className="max-w-[460px] px-4">
          <Hint tone="warn">
            <span className="font-semibold">{t("cbase has no matching DevTools interface for this browser.")}</span>{" "}
            {reason} {t("cbase never loads the interface from the project container, only its data stream.")}
          </Hint>
        </div>
      </div>
    );
  }
  if (stuck) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-code">
        <div className="max-w-[420px] px-4"><Hint tone="warn">{t("DevTools are not responding — the browser needs a restart.")}</Hint></div>
        {onRestart && (
          <button onClick={() => void onRestart()} className={ghostSm}>
            {t("Restart browser")}
          </button>
        )}
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      src={src}
      onLoad={() => { const k = readNoUi(frameRef.current); if (k) setNo(k); }}
      className="h-full w-full border-0 bg-white"
      title="DevTools"
    />
  );
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
