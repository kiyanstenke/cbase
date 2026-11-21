"use client";

// Fullscreen viewer for chat images (capture cards, user attachments): wheel/trackpad zooms
// at the cursor (1x-8x), dragging pans, double-click toggles 1x <-> 2.5x, Escape/backdrop/
// close button dismiss. The wrapper fills the viewport and is transformed with origin (0,0),
// so cursor coordinates feed straight into the zoom without layout math.
//
// PORTAL-REQUIRED: the overlay is attached to document.body via createPortal. Chat rows carry
// content-visibility/transforms (render optimisations); inside such ancestors `position: fixed`
// anchors to the CONTAINER instead of the window, and the viewer would stay trapped in the
// message block instead of filling the app.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const t = useT();
  const [tf, setTf] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; moved: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setTf(({ s, x, y }) => {
      const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
      if (ns === s) return { s, x, y };
      // The point under the cursor stays put: p = t + s·q  ⇒  t' = c − (s'/s)·(c − t).
      const k = ns / s;
      return ns <= MIN_SCALE + 1e-6
        ? { s: 1, x: 0, y: 0 }
        : { s: ns, x: cx - k * (cx - x), y: cy - k * (cy - y) };
    });
  }, []);

  // Wheel NOT as a React prop: that would be a passive listener, and preventDefault (the page
  // would scroll behind the overlay) needs an active one.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0018)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 overflow-hidden bg-black/85"
      onPointerDown={(e) => {
        drag.current = { px: e.clientX, py: e.clientY, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.buttons === 0) return;
        const dx = e.clientX - d.px, dy = e.clientY - d.py;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        d.px = e.clientX; d.py = e.clientY;
        if (tf.s > 1) setTf((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      }}
      onPointerUp={(e) => {
        const wasDrag = drag.current?.moved;
        drag.current = null;
        // A click (without dragging) on the backdrop closes; on the image it does not.
        if (!wasDrag && e.target === e.currentTarget) onClose();
      }}
      onDoubleClick={(e) => {
        if (tf.s > 1.01) setTf({ s: 1, x: 0, y: 0 });
        else zoomAt(e.clientX, e.clientY, 2.5);
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center p-8"
        style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`, transformOrigin: "0 0" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-auto max-h-full max-w-full select-none rounded object-contain shadow-2xl"
          style={{ cursor: tf.s > 1 ? "grab" : "zoom-in" }}
        />
      </div>
      <button
        type="button"
        onClick={onClose}
        title={t("Close")}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/30"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      {tf.s > 1.01 && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-[11.5px] font-medium text-white">
          {Math.round(tf.s * 100)} %
        </div>
      )}
    </div>,
    document.body,
  );
}

// Full-app player for capture videos: same portal construction as the image viewer, native
// controls, Escape/backdrop/close button dismiss.
export function VideoLightbox({ src, poster, onClose }: { src: string; poster?: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
    >
      <video
        controls
        autoPlay
        playsInline
        poster={poster}
        src={src}
        className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
      />
      <button
        type="button"
        onClick={onClose}
        title={t("Close")}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/30"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>,
    document.body,
  );
}
