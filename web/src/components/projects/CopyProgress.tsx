"use client";

// The progress of a copy that is waiting or being built, as words and a bar. ONE component for the three places in the web: the
// "Active runs" pill (pills/ActiveRunsPill.tsx), the row and the detail header in the "Instances" tab (projects/InstancesPage.tsx).
// What is shown is computed by `progressDetail` (lib/api/copy-progress.ts, bound to iOS); only the words and the form live here.
//
//   - The phases are named in words (clone1 "Clone", freeze "Freezing", clone2 "Second clone", creation "Container setup", prepare
//     "Preparing", start "Start"); in start with the stage of the compose start.
//   - The bar is thin: DETERMINATE with `share` (estimated from the project's last finished copy), INDETERMINATE without (a moving
//     band — never an invented number), and only the empty track while waiting (nothing is happening). The band runs through the
//     Web Animations API and stands still under `prefers-reduced-motion` (then a calm half fill across the full width) — no rule in globals.css.
//   - "about 4 min left" only when the remaining time is estimated; `overrun` (the running step takes longer than last time) says so
//     in the warning color instead of naming a remaining time.
import { useEffect, useRef, useState } from "react";
import type { ProgressDetail } from "@/lib/api";

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** The build phase as a word; an unknown one shows raw (a newer server this client does not know). */
export function phaseWord(phase: string, t: Translator): string {
  switch (phase) {
    case "clone1": return t("Clone");
    case "freeze": return t("Freezing");
    case "clone2": return t("Second clone");
    case "creation": return t("Container setup");
    case "prepare": return t("Preparing");
    case "start": return t("Start##noun");
    default: return phase;
  }
}

/** "Step 3 of 6 · Second clone" (in start plus "· Stage 2/3") — only for a known step, otherwise null. */
export function stepSet(a: ProgressDetail, t: Translator): string | null {
  if (a.kind !== "step") return null;
  const parts = [t("Step {n} of {m}", { n: a.step, m: a.steps }), phaseWord(a.phase, t)];
  if (a.stage) parts.push(t("Stage {seq}/{from}", { seq: a.stage.seq, from: a.stage.from }));
  return parts.filter(Boolean).join(" · ");
}

/** The state in one sentence: waiting (queue/storage), the step, otherwise "being created". */
export function stateSet(a: ProgressDetail, t: Translator): string {
  if (a.kind === "queue") return t("waiting in line");
  if (a.kind === "storage") return t("waiting for memory");
  return stepSet(a, t) ?? t("being created");
}

/** "about 4 min left" — only with an estimated remaining time (never on `overrun`). */
export function restSet(a: ProgressDetail, t: Translator): string | null {
  return a.restMin !== null ? t("about {n} min left", { n: a.restMin }) : null;
}

/** The hint when the running step takes longer than last time. */
export function OverrunHint({ a, t }: { a: ProgressDetail; t: Translator }) {
  if (!a.overrun) return null;
  return <span className="text-warn" data-copy-overrun>{t("taking longer than last time")}</span>;
}

/** The moving band of the indeterminate bar. */
function Band() {
  const ref = useRef<HTMLSpanElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const el = ref.current;
    let quiet = false;
    try { quiet = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { quiet = false; }
    if (quiet || !el || typeof el.animate !== "function") { setStill(true); return; }
    const run = el.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(300%)" }], { duration: 1600, iterations: Infinity, easing: "ease-in-out" });
    return () => run.cancel();
  }, []);
  return still
    ? <span className="absolute inset-0 rounded-full bg-accent/35" />
    : <span ref={ref} className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/80" />;
}

/** The thin bar: determinate with `share`, indeterminate without, only the track while waiting. */
export function CopyProgressBar({ a, className = "" }: { a: ProgressDetail; className?: string }) {
  const waiting = a.kind === "queue" || a.kind === "storage";
  const kind = waiting ? "waiting" : a.share !== null ? "determinate" : "indeterminate";
  return (
    <span
      className={`relative block h-1 w-full overflow-hidden rounded-full bg-edge ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(a.share !== null && !waiting ? { "aria-valuenow": Math.round(a.share * 100) } : {})}
      data-copy-progress-bar={kind}
    >
      {kind === "determinate" && (
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.round((a.share ?? 0) * 1000) / 10}%` }} />
      )}
      {kind === "indeterminate" && <Band />}
    </span>
  );
}
