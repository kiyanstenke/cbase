"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

// useLayoutEffect runs BEFORE paint (no flicker) but warns during server prerender (static export). On the server the effect is
// a no-op anyway → use useEffect there.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Replays the switch fade-in on `ref` whenever `token` changes — not on first mount.
 *
 * Duration and curve live ONCE in globals.css (`--cb-switch`, `--cb-switch-fade`); this only picks WHICH of the two.
 * `fadeOnly`: opacity only — for full-height panels with CodeMirror, canvas or terminal (reason in globals.css).
 *
 * Compares against the previous token, not a "first run" flag: in Strict Mode the effect runs twice on mount and the flag
 * would already be spent the second time — the content would then fade in on open.
 *
 * Exported for switchers that need their own shell (`TabFade`, `RouteTransition`).
 */
export function useSwitchFadeIn(ref: RefObject<HTMLElement | null>, token: unknown, fadeOnly = false) {
  const prior = useRef(token);
  useIsoLayoutEffect(() => {
    if (Object.is(prior.current, token)) return;
    prior.current = token;
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Restart the CSS animation reliably via reflow (the canonical replay trick).
    el.style.animation = "none";
    // Force layout so the browser registers the reset.
    void el.offsetWidth;
    el.style.animation = fadeOnly ? "var(--cb-switch-fade)" : "var(--cb-switch)";
    // Drop the inline style afterwards: a CSS rule that suppresses the fade (Coding → Chats, globals.css "no fade without an
    // opaque background") would otherwise re-enable it each time it stops applying — the name flips from `none` back to
    // `fade-in`. Children's own `animationend` is ignored too (it bubbles).
    const end = (e: AnimationEvent) => {
      if (e.target !== el) return;
      el.removeEventListener("animationend", end);
      el.style.animation = "";
    };
    el.addEventListener("animationend", end);
    return () => el.removeEventListener("animationend", end);
    // ref and fadeOnly are fixed per caller; only a token change is a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}

/**
 * Reusable animated view switcher — on every `token` change the content fades in briefly (the same fade-in as every tab
 * switch in the app, `useSwitchFadeIn`).
 *
 * Why this and not a key remount (key={token} + CSS class)?
 * A remount starts a fresh CSS animation, but an immediately following re-render of the child (data effect, useMemo, state)
 * can cut it off or reconcile the element anew — exactly why the nested switchers (credentials filter, dumpster↔memory, …)
 * "jumped" straight to the end state instead of animating.
 *
 * Here the animation is re-triggered via inline `style.animation` (with a forced reflow as restart):
 *  - CSS keyframes are painted reliably.
 *  - React manages only `className`, NOT `style` → a re-render cannot clear the animation (no more "cut off").
 *  - The content is NOT remounted — state below it stays.
 *
 * Only a real change of `token` animates; the first mount deliberately does not.
 */
export function AnimatedSwitch({
  token,
  fadeOnly = false,
  className,
  children,
}: {
  token: string | number | boolean | null;
  // Opacity only instead of opacity + 3 px travel — for full-height panels (terminal, browser, CodeMirror).
  fadeOnly?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSwitchFadeIn(ref, token, fadeOnly);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
