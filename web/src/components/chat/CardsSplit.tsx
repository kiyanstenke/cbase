"use client";

import type React from "react";

// The gap between two cards of the coding chat. The 3 px gutters between chat list and conversation (ChatListPane.tsx)
// and between conversation and right sidebar (ChatRightSidebar.tsx) are this element — no border on a card any more.
//
// - Draggable (`draggable`): three dots in the middle, cursor col-resize, an invisible grab zone 4 px beyond both card
//   edges (3 px alone is hard to hit), keyboard via `onKeyDown`, double click = default. Not draggable (collapsed list,
//   closed panel): just the gap, without dots — the dots say "movable".
// - While dragging (`drag`) EXACTLY this gap lights up in the accent colour and the dots recede; the other gap stays as
//   it is (each side keeps its own drag state). On hover only the dots get brighter.
// - The gap is `relative z-20`: its grab zone lies ABOVE the edges of the neighbouring cards (which are not positioned).
// Pointer capture, body cursor and the width calculation stay with the owner of the width — the gap draws and forwards.
export function CardsSplit({
  draggable, drag, label, title, value, min, max, data, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onKeyDown,
}: {
  draggable: boolean;
  drag: boolean;
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  data?: Record<string, string>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  if (!draggable) return <div aria-hidden className="w-[3px] shrink-0" {...data} />;
  return (
    <div
      {...data}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      title={title}
      tabIndex={0}
      data-drag={drag ? "1" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className="group relative z-20 w-[3px] shrink-0 cursor-col-resize outline-none"
    >
      <span aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-full transition-colors duration-150 ${drag ? "bg-accent" : "group-focus-visible:bg-accent/60"}`}
      />
      <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-[2px] w-[2px] rounded-full transition-colors duration-150 ${drag ? "bg-transparent" : "bg-fg/35 group-hover:bg-fg/75"}`}
          />
        ))}
      </span>
    </div>
  );
}
