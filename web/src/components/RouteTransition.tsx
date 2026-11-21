"use client";

import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { useSwitchFadeIn } from "@/components/AnimatedSwitch";

// Page switch in the top-level navigation (Coding / Apps / Profile): the new page fades in over 150 ms,
// via opacity only (`--cb-switch-fade`, globals.css). Coding carries full-height panels with CodeMirror, canvas
// and terminal, and a transform on the page frame would shift them against their measured position for the duration.
//
// There are two layers (frame + `cbase-route-content`): on the inner one a DOM probe in a real browser checks
// that no clone is created and the content sits without offset.
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const innerRef = useRef<HTMLDivElement>(null);
  useSwitchFadeIn(innerRef, pathname, true);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div id="cbase-route-content" ref={innerRef} className="flex min-h-0 min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}
