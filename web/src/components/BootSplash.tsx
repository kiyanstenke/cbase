"use client";

import { useEffect, useState } from "react";
import { CbaseLens } from "@/components/CbaseLens";

// Boot splash on app start: the lens and "cbase" beside it, centered, nothing else. Runs once per app start (sessionStorage
// survives reloads in the same window, a fresh Electron start begins empty), then the overlay fades out.
//
// Deliberately SHORT (under a second): the splash only masks the connection check, it is not a show. Whoever opens the app
// wants to get in.
const FADE_IN_MS = 300; // duration of the lockup's fade-in
const HOLD_MS = 700;     // from mount: when the overlay starts fading out
const HIDE_MS = 300; // → visible for under a second

export function BootSplash() {
  const [visible, setVisible] = useState(false);
  const [entered, setEntered] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem("cbase-booted")) return;
    sessionStorage.setItem("cbase-booted", "1");
    setVisible(true);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    const fade = setTimeout(() => setFading(true), HOLD_MS);
    const done = setTimeout(() => setVisible(false), HOLD_MS + HIDE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] grid place-items-center bg-bg transition-opacity ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${HIDE_MS}ms` }}
    >
      {/* Overlay is opaque from frame 1 — only the lockup fades in */}
      <div
        className={`flex items-center gap-4 transition-all ease-out ${
          entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-1.5 scale-95 opacity-0"
        }`}
        style={{ transitionDuration: `${FADE_IN_MS}ms` }}
      >
        <CbaseLens className="h-[clamp(52px,7vw,76px)] w-[clamp(52px,7vw,76px)]" />
        {/* Lens and wordmark are ONE glyph and grow with the window (vw), not with the text size: `cb-text-fest` holds the factor
            at 1. The computation is still written out in the value — a size in vw is unknown to the text-scale plugin
            (web/postcss-text-scale.cjs), which only leaves alone what `--cb-text-scale` already carries. */}
        <span className="cb-text-fixed text-[length:calc(clamp(34px,4.6vw,52px)*var(--cb-text-scale,1))] font-bold tracking-tight text-fg">cbase</span>
      </div>
    </div>
  );
}
