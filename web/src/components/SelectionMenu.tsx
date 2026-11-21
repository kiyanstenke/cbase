"use client";

// "Reply / Copy" for selected text in the chat: the same small menu that the iOS app shows at
// the text marker, now on the desktop too (where the selection is made with mouse or trackpad).
// "Reply" puts the selection as a quote above the input field (lib/quotes.ts).
//
// PORTAL-REQUIRED as with the image viewer: chat rows carry content-visibility and transforms;
// inside such ancestors `position: fixed` anchors to the block instead of the window, and the
// menu would stick in the wrong place. So it is attached to document.body and works with
// window coordinates from `getBoundingClientRect`.
//
// The width is MEASURED, not set: with a fixed width a longer label would wrap onto two lines.
// Each button carries icon and word on ONE line (`whitespace-nowrap`), the bar is as wide as its
// content, and the placement computes with the measured width (with an estimate until the first
// measurement).
//
// In the form of the menu row (CbKit `menuRow`), horizontal: the pill keeps 4 px inner padding,
// each button is itself a pill, 2 px of air to the divider; the highlight does not touch the
// edges and is slightly rounded.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { useFlat } from "@/components/CbKit";

export function SelectionMenu({
  rect,
  onAsk,
  onCopy,
  copied,
}: {
  /** Bounding rectangle of the selection in window coordinates. */
  rect: { top: number; bottom: number; left: number; right: number };
  /** "Reply". Absent in an archived chat (read-only): then only "Copy" is shown. */
  onAsk?: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const t = useT();
  const flat = useFlat();
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(onAsk ? 200 : 110);
  // Re-measure after every render (the word changes with "Copied"): only a DIFFERENT width sets the state.
  useLayoutEffect(() => {
    const w = bar.current?.offsetWidth;
    if (w && w !== width) setWidth(w);
  });
  const height = 36;
  const margin = 10;
  // Preferably above the selection; if it does not fit there, below. Horizontally centred, but
  // fully inside the window.
  const above = rect.top - height - margin;
  const top = above >= margin ? above : Math.min(rect.bottom + margin, window.innerHeight - height - margin);
  const centre = (rect.left + rect.right) / 2;
  const left = Math.min(Math.max(centre - width / 2, margin), Math.max(margin, window.innerWidth - width - margin));
  const buttonEl = "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-[13px] font-medium text-fg transition-colors hover:bg-hover";

  return createPortal(
    <div
      ref={bar}
      style={{ position: "fixed", top, left, height, zIndex: 60 }}
      className={`cb-pop cb-pop-in-fast flex items-stretch gap-0.5 overflow-hidden whitespace-nowrap rounded-full p-1 text-fg${flat}`}
      // A click in the bar must not clear the selection (otherwise it would be gone by the
      // time the action fires).
      onMouseDown={(e) => e.preventDefault()}
    >
      {onAsk && (
        <>
          <button type="button" onClick={onAsk} className={`${buttonEl} pl-3 pr-2.5`}>
            <ReplyIcon />
            {t("Reply")}
          </button>
          <span className="my-1.5 w-px shrink-0 bg-edge" aria-hidden />
        </>
      )}
      <button type="button" onClick={onCopy} className={`${buttonEl} ${onAsk ? "pl-2.5 pr-3" : "px-3"}`}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? t("Copied") : t("Copy")}
      </button>
    </div>,
    document.body,
  );
}

const ReplyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15" />
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
