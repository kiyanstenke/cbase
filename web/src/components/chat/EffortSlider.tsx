"use client";

// The composer's effort choice as a SLIDER instead of a list. The steps are exactly the entries the list used to carry
// (`effortEntries` in the composer); the slider changes the form, not the choice. Only the levels are on it: Ultracode
// is its own switch below it (ChatComposer), independent of the level.
// A choice is made on RELEASE (drag), on a click on the track or a label, and with the arrow keys; while dragging the
// handle follows the finger freely and then glides into place. Until the server reports the new level back, the slider
// holds the choice itself (`choice`), otherwise the handle would jump back to the old level for the length of the PATCH.
//
// With Ultracode on (`ultra`), the filled track flows in a cobalt -> violet gradient, the handle carries a softly
// pulsing halo and the word above shimmers (`cb-ultra-*` in globals.css; everything stands still under
// `prefers-reduced-motion`).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { type EffortEntry, type EffortTranslator } from "@/lib/effort";

const SLIDE = "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]";

export function EffortSlider({ entries, active, ultra = false, onChoice, t }: {
  entries: EffortEntry[];
  active: string;
  ultra?: boolean; // the chat's Ultracode switch; only the form (animation), never a step
  onChoice: (id: string) => void;
  t: EffortTranslator;
}) {
  const n = entries.length;
  const activeIdx = Math.max(0, entries.findIndex((e) => e.id === active));
  const [choice, setChoice] = useState<number | null>(null); // chosen locally until `active` catches up
  const [turn, setDrag] = useState<number | null>(null); // fraction 0..1 while dragging
  const key = entries.map((e) => e.id).join("|");
  useEffect(() => { setChoice(null); }, [active, key]);
  const lane = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  useEffect(() => { handle.current?.focus({ preventScroll: true }); }, []);

  const share = (i: number) => (n <= 1 ? 0 : i / (n - 1));
  const next = (p: number) => Math.round(p * (n - 1));
  const idx = choice ?? activeIdx;
  const shows = turn !== null ? next(turn) : idx;
  const pos = turn ?? share(idx);
  const ef = entries[shows];

  function select(i: number) {
    const target = Math.min(n - 1, Math.max(0, i));
    if (target === idx) return;
    setChoice(target);
    onChoice(entries[target].id);
  }
  function shareFrom(clientX: number) {
    const r = lane.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return share(idx);
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    handle.current?.focus({ preventScroll: true });
    setDrag(shareFrom(e.clientX));
  }
  function drag(e: PointerEvent<HTMLDivElement>) {
    if (turn !== null) setDrag(shareFrom(e.clientX));
  }
  function release(e: PointerEvent<HTMLDivElement>) {
    if (turn === null) return;
    const i = next(shareFrom(e.clientX));
    setDrag(null);
    select(i);
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (step) { e.preventDefault(); select(idx + step); }
    else if (e.key === "Home") { e.preventDefault(); select(0); }
    else if (e.key === "End") { e.preventDefault(); select(n - 1); }
  }
  // Short label under the track: the entry's label without its suffix ("Max · runs as X-High" -> "Max"); the full
  // label is shown above. No own level table: the label comes solely from `effortEntries` (effort.test.mjs).
  const short = (e: EffortEntry) => e.label.split(" · ")[0];

  return (
    <div className="select-none" data-effort-slider data-effort-ultra={ultra ? "" : undefined}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-dim">{t("Reasoning effort")}</span>
        <span className="flex-1" />
        {ef && (
          <span key={ef.id} title={ef.marker}
            className={`cb-effort-word truncate text-[13px] font-semibold ${!ef.supported ? "text-warn" : ultra ? "cb-ultra-text" : "text-fg"}`}>{ef.label}</span>
        )}
      </div>

      {/* The track: the full height is the hit area, measured on the inner rail (inset by half the handle so it
          sits fully on the surface at both ends). */}
      <div className="relative h-7 cursor-pointer touch-none px-[9px]" onPointerDown={down} onPointerMove={drag}
        onPointerUp={release} onPointerCancel={() => setDrag(null)}>
        <div ref={lane} className="relative h-full">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fg/10" />
          <div
            className={`absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full ${ultra ? "cb-ultra-flow" : "bg-accent"} ${turn === null ? `transition-[width] ${SLIDE}` : ""}`}
            style={{ width: `${pos * 100}%` }}
          />
          {entries.map((e, i) => (
            <span key={e.id} aria-hidden
              className={`absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${SLIDE} ${
                !e.supported ? "bg-warn" : i <= shows ? "bg-white/75" : "bg-fg/30"}`}
              style={{ left: `${share(i) * 100}%` }} />
          ))}
          <div
            ref={handle}
            role="slider"
            tabIndex={0}
            aria-label={t("Reasoning effort for this chat")}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, n - 1)}
            aria-valuenow={shows}
            aria-valuetext={ef?.label}
            onKeyDown={onKey}
            className={`absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.35),0_0_0_0.5px_rgb(0_0_0/0.08)] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              turn === null ? `transition-[left,transform] ${SLIDE}` : "scale-110 transition-transform duration-150"} ${ultra ? "cb-ultra-puls" : ""}`}
            style={{ left: `${pos * 100}%` }}
          />
        </div>
      </div>

      {/* The labels: flush at the ends, centred under the step in between; they select too. */}
      <div className="relative mx-[9px] mt-1 h-4">
        {entries.map((e, i) => {
          const word = short(e);
          const situation = i === 0 ? "translate-x-0" : i === n - 1 ? "-translate-x-full" : "-translate-x-1/2";
          const on = i === shows;
          return (
            <button key={e.id} type="button" tabIndex={-1} onClick={() => select(i)} title={e.marker ?? e.label}
              className={`absolute top-0 ${situation} whitespace-nowrap text-[10.5px] leading-4 transition-colors ${SLIDE} ${
                !e.supported ? "text-warn" : on ? "font-medium text-fg" : "text-dim hover:text-fg"}`}
              style={{ left: `${share(i) * 100}%` }}>
              {word}
            </button>
          );
        })}
      </div>
    </div>
  );
}
