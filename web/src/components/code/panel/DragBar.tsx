"use client";
// The drag bar (sash) like VS Code: 4 px wide over the edge of two parts, the pointer shows the direction, after 300 ms under the pointer
// (VS Code `workbench.sash.hoverDelay`) and while dragging it appears as a line in the focus colour (`sash.hoverBorder`). Dragging reports
// the distance since the press (`onDrag(way, finished)` — `finished` on release: then remember); if the drag ends otherwise (pointer cancelled,
// capture lost), it ends the same way — with the last distance, and nothing stays stuck. A double click restores the preferred size
// (`onBack`). The shape lives ONCE in globals.css (`.cb-sash`). For assistive technology it carries name and value (`aria-valuenow/min/max`
// of the size it drags).
import { useRef } from "react";

export function DragBar({ direction, onDrag, onBack, className = "", style, title, label, value, data }: {
  /** "vertical": a bar between left and right (drags the width), "horizontal": between top and bottom (drags the height). */
  direction: "vertical" | "horizontal";
  onDrag: (distance: number, finished: boolean) => void;
  onBack: () => void;
  /** The position (absolute at the edge of the part it drags). */
  className?: string;
  /** A computed position in px (the lines of the editor groups' grid). */
  style?: React.CSSProperties;
  title?: string;
  /** The name for assistive technology ("Sidebar width", "Panel height"). */
  label: string;
  /** The size it drags, in px. */
  value?: { now: number; min: number; max: number };
  data?: Record<`data-${string}`, string>;
}) {
  const turn = useRef<{ id: number; at: number; distance: number } | null>(null);
  const at = (e: React.PointerEvent) => (direction === "vertical" ? e.clientX : e.clientY);
  const end = (el: HTMLElement, e: React.PointerEvent | null) => {
    const z = turn.current;
    if (!z) return;
    turn.current = null;
    delete el.dataset.dragging;
    onDrag(e ? at(e) - z.at : z.distance, true);
  };
  return (
    <div
      role="separator"
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value ? Math.round(value.now) : undefined}
      aria-valuemin={value ? Math.round(value.min) : undefined}
      aria-valuemax={value ? Math.round(Math.max(value.min, value.max)) : undefined}
      title={title}
      className={`cb-sash ${direction === "vertical" ? "cb-sash-vertical" : "cb-sash-horizontal"} ${className}`}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        turn.current = { id: e.pointerId, at: at(e), distance: 0 };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "";
      }}
      onPointerMove={(e) => { const z = turn.current; if (z && z.id === e.pointerId) { z.distance = at(e) - z.at; onDrag(z.distance, false); } }}
      onPointerUp={(e) => { if (turn.current?.id === e.pointerId) end(e.currentTarget, e); }}
      onPointerCancel={(e) => end(e.currentTarget, null)}
      onLostPointerCapture={(e) => end(e.currentTarget, null)}
      onDoubleClick={(e) => { e.preventDefault(); onBack(); }}
      {...data}
    />
  );
}
