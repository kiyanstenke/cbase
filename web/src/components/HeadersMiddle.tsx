"use client";

import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

// ── The page frame in the middle of the header ──────────────────────────────────────────────────
//
// The page frame ("workspace > project" or a workspace name) sits in the centered slot of the header
// (`cbase-topnav-center`, TopNav.tsx): centered in the measured free band between the department tabs and the controls.
// If the band is narrower than the content at its minimum widths (measured: client mode with usage rings at
// 1024-1150 px) or the window is narrower than `lg`, it moves to its own header row, never over other controls
// (TopNav.tsx, `protrudesOut`). The caller sets the minimum widths (`shrink-0` on icons, `min-w-[...]` on names): they
// are the limit at which the header wraps.
//
// DRAG REGION: the slot lies INSIDE the header, which is a drag region (`<nav style={drag}>`). Since Electron 44 every
// DOM child inherits `app-region: drag`, including a portal into this slot, and web/test/drag-region.test.mjs does NOT
// see portals into a slot (it reads the nav's JSX tree). So the content ALWAYS carries `no-drag`, menus inside it
// included. There is deliberately no switch a caller could forget: with a prop, a missing flag made the header swallow
// every click in the app. Even a plain name is not a window handle. It is as wide as its text (`truncate` at the
// caller), not as wide as the slot, so the gaps beside it stay draggable. The content always takes pointer events (the
// slot itself is `pointer-events-none`), so a truncated name shows its `title` in the app too.
//
// `no-drag` on the content only works because the slot comes AFTER the tab strip in the DOM (TopNav.tsx): Electron
// resolves regions in DOM order, and the strip (`flex-1`, inherits `drag`) extends under the whole band. With the slot
// before it, the strip's rectangle overrode `no-drag` and the frame was unclickable.
//
// A menu in here fades in via opacity only (`popClassHeader`, CbKit): a transform animation is invisible to Electron's
// region computation, so the `no-drag` area would stay at the start position (TopNav.tsx).
//
// Rule for the header: `no-drag` belongs on the control, not on a wide container.

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function HeadersMiddle({
  children, data,
}: {
  children: React.ReactNode;
  /** Data attributes on the content (e.g. `data-kit-pop` for a click catcher via `closest`). */
  data?: Record<string, string>;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setSlot(document.getElementById("cbase-topnav-center")); }, []);
  if (!slot) return null;
  return createPortal(
    <div
      {...data}
      style={noDrag}
      className="pointer-events-auto relative flex min-w-0 max-w-full items-center gap-1.5 text-[13px] font-semibold tracking-tight"
    >
      {children}
    </div>,
    slot,
  );
}
