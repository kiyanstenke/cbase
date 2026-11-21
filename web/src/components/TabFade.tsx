"use client";

import { useRef, type ReactNode } from "react";
import { useSwitchFadeIn } from "@/components/AnimatedSwitch";

/**
 * Content area of a tab switch (coding categories, Memory <-> Dumpster): when `token` changes the area fades in
 * briefly, via opacity ONLY (`--cb-switch-fade`, globals.css) — below it sit full-height panels with CodeMirror,
 * canvas and terminal. Nothing is remounted: chats, terminal, browser and code stay mounted but hidden behind another
 * tab, so streams and open editors keep running. The two layers stay on purpose: the outer box is the flex frame in
 * which the pages below are built and measured.
 */
export function TabFade({ token, className, children }: {
  token: string | number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSwitchFadeIn(ref, token, true);
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* min-w-0: the panel content may get narrower than its min-content width, otherwise e.g. a nowrap row
          (truncate) blows the width and overflows on the right. */}
      {/* data-tab-fade: no fade in the Chats tab (globals.css, "No fade without an opaque background"). */}
      <div ref={ref} data-tab-fade className={`min-w-0 ${className ?? ""}`}>
        {children}
      </div>
    </div>
  );
}
