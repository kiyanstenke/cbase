"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

// Send button as a slightly rounded hexagon — and in stop mode as a real stop sign: both outlines are ONE <path> with the same
// point count (the hexagon doubles its top and bottom vertex), the change runs as a CSS transition of the `d` property
// (.cb-send-shape in globals.css). fill+stroke in the same color with strokeLinejoin="round" round the corners (clip-path
// cannot). Browsers without `d` in CSS (Safari) jump hard to the target set by attribute — so the path is ALWAYS in the
// attribute too, the style wins only where the engine understands it.
const HEX = "M18 4 L18 4 L32 12 L32 28 L18 36 L18 36 L4 28 L4 12 Z";
const OCT =
  "M12.3 6.1 L23.7 6.1 L31.9 14.3 L31.9 25.7 L23.7 33.9 L12.3 33.9 L4.1 25.7 L4.1 14.3 Z";

// The round form (`round`, the Coding chat's composer): a filled circle in the accent color with the same three symbols on it
// (arrow, square, dots). It does NOT rotate — a circle rotates invisibly, and the run indicator stands in the history (working
// row) and in the header; echo and sparks stay, as a circle. The hexagon path below only applies to the old form. The color is
// the accent color in all three states — what the button is doing is told by the symbol.
const CIRCLE = "M18 2 A16 16 0 1 1 17.99 2 Z";

// Springy curve for everything that should "snap in" (icon change, enable pop).
const SPRING = "cubic-bezier(0.34,1.45,0.64,1)";

// Revolution time of the stop sign's rotation (must match the angle readout below).
const SPIN_MS = 3200;

export function CbSendButton({
  disabled,
  title,
  className = "h-10 w-9",
  iconSize = 17,
  stop = false,
  stopping = false,
  queue = false,
  round = false,
  onStop,
}: {
  disabled: boolean;
  title?: string;
  className?: string;
  iconSize?: number;
  stop?: boolean;        // in stop mode: abort button instead of send
  stopping?: boolean;    // abort already running → pulsing dots instead of the square
  queue?: boolean;       // run active but content typed → the message is QUEUED
  round?: boolean;        // round accent button instead of hexagon (composer) — see CIRCLE above
  onStop?: () => void;
}) {
  // Counter instead of flag: a quick double send remounts echo and sparks (key) and restarts the animations instead of letting
  // them run on.
  const [burst, setBurst] = useState(0);
  // "Wake": fires exactly on the transition disabled → ready to send (first character).
  const [wake, setWake] = useState(0);
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (wasDisabled.current && !disabled && !stop) setWake((w) => w + 1);
    wasDisabled.current = disabled;
  }, [disabled, stop]);

  const shapePath = stop ? OCT : HEX;

  // Continuous rotation of the stop sign while the answer runs — the rotation IS the run indicator (as in the mobile app), there
  // is no ring of its own. Via the Web Animations API instead of a CSS class so the END is soft: a removed infinite animation
  // snapped back to 0°; here the current angle is read out and turned to the next 60° step with a small settle bounce (the
  // hexagon coincides with its rest position there). Transform-only, one layer — in the idle send state nothing animates (see
  // the orb note in globals.css).
  const shapeRef = useRef<SVGSVGElement | null>(null);
  const spinAnim = useRef<Animation | null>(null);
  useEffect(() => {
    const el = shapeRef.current;
    if (!el || typeof el.animate !== "function") return;
    if (stop) {
      if (spinAnim.current) return; // already running (e.g. stopping switch)
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.getAnimations().forEach((a) => a.cancel());
      spinAnim.current = el.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: SPIN_MS, iterations: Infinity, easing: "linear" }
      );
    } else if (spinAnim.current) {
      const angle = ((Number(spinAnim.current.currentTime ?? 0) % SPIN_MS) / SPIN_MS) * 360;
      spinAnim.current.cancel();
      spinAnim.current = null;
      const target = Math.round(angle / 60) * 60;
      el.animate(
        [
          { transform: `rotate(${angle}deg) scale(1)` },
          { transform: `rotate(${(angle + target) / 2}deg) scale(1.08)`, offset: 0.55 },
          { transform: `rotate(${target}deg) scale(1)` },
        ],
        { duration: 500, easing: "cubic-bezier(0.3,1.2,0.5,1)" }
      );
    }
  }, [stop]);

  // Hover in stop mode: the rotation slows down markedly — "click here to stop". updatePlaybackRate switches seamlessly,
  // without an angle jump.
  const setSpinRate = (rate: number) => {
    const anim = spinAnim.current;
    if (!anim) return;
    try {
      anim.updatePlaybackRate(rate);
    } catch {
      anim.playbackRate = rate;
    }
  };

  // Outline of echo and spark origin: hexagon (viewBox 36×40) or circle (36×36).
  const echoPath = round ? CIRCLE : HEX;
  const box = round ? "0 0 36 36" : "0 0 36 40";
  const middle = round ? 18 : 20;

  return (
    <button
      type={stop ? "button" : "submit"}
      disabled={stop ? false : disabled}
      onClick={stop ? onStop : () => setBurst((b) => b + 1)}
      onMouseEnter={() => setSpinRate(0.3)}
      onMouseLeave={() => setSpinRate(1)}
      title={title}
      data-cb-send={round ? "round" : "hex"}
      // Round: the surface is the button itself (bg-accent, rounded-full) — dimmed when disabled, not gone.
      className={`group relative grid shrink-0 place-items-center text-white transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.45,0.64,1)] hover:scale-[1.07] active:scale-90 active:duration-75 disabled:pointer-events-none ${
        round ? "rounded-full bg-accent disabled:opacity-40" : "disabled:scale-90 disabled:opacity-35"
      } ${className}`}
    >
      {/* Base shape: morphs to the stop sign in stop mode and then rotates slowly around itself (effect above). The icons lie
          above as layers of their own and do NOT rotate. Three color states: dark (send), accent (queue during a run), red
          (stop) — all via the fill/stroke transition. */}
      {!round && (
      <svg
        ref={shapeRef}
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 36 40"
        aria-hidden
      >
        <path
          d={shapePath}
          style={{ d: `path("${shapePath}")` } as CSSProperties}
          strokeWidth="6"
          strokeLinejoin="round"
          className={`cb-send-shape ${
            stop
              ? "fill-danger stroke-danger group-hover:opacity-90"
              : queue
                ? "fill-accent stroke-accent group-hover:opacity-90"
                : "fill-dark stroke-dark group-hover:fill-accent group-hover:stroke-accent"
          }`}
        />
      </svg>
      )}
      {/* Wake echo: on the transition from disabled to ready to send (first typed character) a soft accent outline pulses
          outward once. */}
      {wake > 0 && (
        <svg
          key={`wake-${wake}`}
          onAnimationEnd={() => setWake(0)}
          className="cb-send-wake pointer-events-none absolute inset-0 h-full w-full"
          viewBox={box}
          fill="none"
          aria-hidden
        >
          <path d={echoPath} strokeWidth="2" strokeLinejoin="round" className="stroke-accent" />
        </svg>
      )}
      {/* Moment of sending: the hexagon echo expands outward, and six sparks fly off along the corner directions. Both keep
          running when the button morphs into stop mode right afterwards — that is exactly the take-off. */}
      {burst > 0 && (
        <>
          <svg
            key={`ripple-${burst}`}
            onAnimationEnd={() => setBurst(0)}
            className="cb-send-ripple pointer-events-none absolute inset-0 h-full w-full"
            viewBox={box}
            fill="none"
            aria-hidden
          >
            <path d={echoPath} strokeWidth="2.5" strokeLinejoin="round" className="stroke-accent" />
          </svg>
          <svg
            key={`sparks-${burst}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={box}
            aria-hidden
          >
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <circle
                key={angle}
                cx="18"
                cy={middle}
                r="1.5"
                className="cb-send-spark fill-accent"
                style={
                  {
                    "--spark-a": `${angle}deg`,
                    transformOrigin: `18px ${middle}px`,
                  } as CSSProperties
                }
              />
            ))}
          </svg>
        </>
      )}
      {/* All three symbols stay mounted and cross-fade via transitions: arrow (send/queue) ↔ square (stop) ↔ dots (abort
          running). The square grows slightly on hover — an invitation to stop. */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
        style={{ transitionTimingFunction: SPRING }}
        className={`absolute transition-[opacity,transform] duration-[380ms] ${
          stop && !stopping
            ? "rotate-0 scale-100 opacity-100 group-hover:scale-110"
            : "-rotate-[120deg] scale-[0.3] opacity-0"
        }`}
      >
        <rect x="7" y="7" width="10" height="10" rx="1.5" />
      </svg>
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
        className={`absolute transition-opacity duration-300 ${
          stop && stopping ? "opacity-100" : "opacity-0"
        }`}
      >
        {[5, 12, 19].map((cx, i) => (
          <circle
            key={cx}
            cx={cx}
            cy="12"
            r="2.2"
            className={stop && stopping ? "cb-send-dot" : ""}
            style={{ animationDelay: `${i * 140}ms` }}
          />
        ))}
      </svg>
      {/* The arrow flies out upward on the change to stop mode — the take-off of the message just sent — and sinks back in on
          morphing back (typing during a run). The hop on waking sits on a <g> layer of its own so it does not meddle with the
          take-off transition's transform. */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ transitionTimingFunction: SPRING }}
        className={`absolute transition-[opacity,transform] duration-[380ms] ${
          stop
            ? "-translate-y-[9px] scale-50 opacity-0"
            : "translate-y-0 scale-100 opacity-100 group-hover:-translate-y-[1.5px]"
        }`}
      >
        <g key={`hop-${wake}`} className={wake > 0 ? "cb-send-hop" : ""}>
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </g>
      </svg>
    </button>
  );
}
