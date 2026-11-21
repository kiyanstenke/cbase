"use client";

// ── Memory brake for very long histories ───────────────────────────────────────
//
// A single chat can have a scroll height of several hundred thousand pixels. Without a
// countermeasure the compositor creates ONE layer over the full height for it — measured in the client:
// 2232 × 673,552 px, together with the other layers 1530 megapixels
// (~6 GB of layer area) for one chat. It keeps growing with every message.
//
// Why `content-visibility` and not windowing (react-window & co.)?
//   • The heights are variable (markdown, code blocks, collapsible tool lists). Windowing
//     with estimated heights yields a WRONG total height — the scroll bar and every
//     saved scroll position would be broken. That is exactly where the mobile app failed
//     with LazyVStack, before it switched to UICollectionView.
//   • All nodes stay in the DOM. So Cmd+F, "select all", the
//     ResizeObserver on the reading column and sticking to the bottom edge keep working unchanged.
//   • No rebuild of the render tree, hence no risk for the scroll mechanics that were hard to get right
//     in ChatPane (pendingRestoreRef, stickRef, scrollPosRef).
//
// The core is the trap a blanket `contain-intrinsic-size: auto 400px` falls into:
// blocks never drawn then get the 400 px instead of their real height, and the scroll height
// collapses (measured: 74,040 → 5,024 px). So this module works in TWO
// steps:
//
//   1. The block is first drawn and measured normally.
//   2. Only with the MEASURED height does it get `content-visibility: auto` and
//      `contain-intrinsic-size: auto <measured>px`.
//
// So the placeholder height of a skipped block is exactly its real height — the
// total height stays identical to the pixel. `auto` in the value additionally makes the
// browser prefer its own last drawn size once it has one.
//
// The memory (key → height) survives switching chats. When jumping back into an
// already seen chat the lock applies from the FIRST frame, without the short
// full-draw moment of step 1.

import { createContext, useContext, useEffect, useRef } from "react";
import { listenTextSize } from "@/lib/appearance";
import { operable } from "@/lib/bubbles-key";

// Can be switched off for counter-measuring: `localStorage["cbase-contain"] = "off"` and reload draws
// everything again. Without this switch the effect cannot be quantified cleanly — if the styles are removed at
// run time, the ResizeObserver puts them back in the next frame.
const OFF = () => {
  try { return localStorage.getItem("cbase-contain") === "off"; } catch { return false; }
};

/** Height memory: key → height (px) last measured in the drawn state. */
export class HeightMemory {
  private heights = new Map<string, number>();
  private keys = new WeakMap<Element, string>();
  /** The blocks currently attached. `keys` is a WeakMap and cannot be enumerated —
   *  but the re-measure after a text size change has no root in hand (it applies to every view). */
  private appended = new Set<HTMLElement>();
  private ro: ResizeObserver | null = null;
  private dirty = new Set<HTMLElement>();
  private frame = 0;
  /** Blocks applying while a re-measure after a size change is running. */
  private paused = false;

  private observer(): ResizeObserver {
    if (!this.ro) {
      this.ro = new ResizeObserver((entries) => {
        for (const e of entries) this.dirty.add(e.target as HTMLElement);
        this.schedule();
      });
    }
    return this.ro;
  }

  // NEVER write styles directly in the ResizeObserver callback — that triggers another layout in the same pass
  // ("ResizeObserver loop completed with undelivered notifications").
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const todo = [...this.dirty];
      this.dirty.clear();
      this.settle(todo);
    });
  }

  /**
   * Measures ALL due blocks first, then locks all. The order is not cosmetic:
   * the locks are nested (bubble outside, its blocks inside). If the outer lock were set
   * in the middle of the pass, everything below would sit in a skipped subtree — and
   * a skipped subtree is not laid out at all, so it measures as 0 px. Exactly
   * these 0 must never enter the memory, otherwise the history collapses.
   */
  private settle(todo: HTMLElement[]) {
    const measured: Array<[HTMLElement, number]> = [];
    for (const el of todo) {
      const key = this.keys.get(el);
      if (!key || !el.isConnected) continue;
      const h = Math.round(el.getBoundingClientRect().height);
      // 0 px means: not in layout — either just skipped or the chat is being
      // switched. Then the remembered value stays; it is still the right one.
      if (h <= 0) continue;
      this.heights.set(key, h);
      measured.push([el, h]);
    }
    if (this.paused) return;
    for (const [el, h] of measured) this.apply(el, h);
  }

  private apply(el: HTMLElement, h: number) {
    if (OFF()) return;
    const want = `auto ${h}px`;
    if (el.style.containIntrinsicSize !== want) el.style.containIntrinsicSize = want;
    if (el.style.contentVisibility !== "auto") el.style.contentVisibility = "auto";
  }

  private release(el: HTMLElement) {
    el.style.contentVisibility = "";
    el.style.containIntrinsicSize = "";
  }

  attach(el: HTMLElement, key: string) {
    this.keys.set(el, key);
    this.appended.add(el);
    // Apply a known height immediately: when jumping back into an already seen chat the scroll height
    // then stands from the first frame, and pendingRestoreRef hits the right place.
    // Never for a live-created bubble (lib/bubbles-key.ts): its content is not the one whose height is stored here.
    const known = this.heights.get(key);
    if (known != null && !this.paused && operable(key)) this.apply(el, known);
    this.observer().observe(el);
  }

  detach(el: HTMLElement) {
    this.ro?.unobserve(el);
    this.keys.delete(el);
    this.appended.delete(el);
  }

  /**
   * After a width change the remembered heights no longer hold — text wraps differently.
   * So release everything once (one frame is drawn in full again), re-measure and
   * lock again afterwards. The caller debounces it, so this does not happen at every pixel of a
   * drag.
   */
  remeasure(root: HTMLElement | null) {
    if (!root) return;
    this.newMeasure([...root.querySelectorAll<HTMLElement>("[data-contain]")]);
  }

  /**
   * The same for ALL attached blocks, without a root — after a text size change
   * (Settings → Appearance, ⌘+ in the client). Text then wraps differently in every view,
   * not only in the two chats: if only some brakes listened to the event, the others
   * (subagent view, facts, episodes, inbox, project context) would stay with stale heights.
   */
  remeasureAll() {
    this.newMeasure([...this.appended].filter((el) => el.isConnected));
  }

  private newMeasure(nodes: HTMLElement[]) {
    this.paused = true;
    this.heights.clear();
    for (const el of nodes) this.release(el);
    // Wait two frames: one for the layout without lock, then measure and lock again.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.paused = false;
        for (const el of nodes) {
          this.dirty.add(el);
          const key = this.keys.get(el);
          if (key) this.heights.delete(key);
        }
        this.schedule();
      });
    });
  }

  dispose() {
    this.ro?.disconnect();
    this.ro = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

/** One memory per view, stable across all redraws. */
export function useHeightMemory(): HeightMemory {
  const ref = useRef<HeightMemory | null>(null);
  if (!ref.current) ref.current = new HeightMemory();
  useEffect(() => {
    const m = ref.current!;
    // EVERY brake listens to the text size itself, once here — not every user on its own (some did it,
    // others did not). Debounced over a frame: ⌘+ twice quickly is one re-measure, not two.
    let image = 0;
    const off = listenTextSize(() => {
      if (image) cancelAnimationFrame(image);
      image = requestAnimationFrame(() => {
        image = 0;
        m.remeasureAll();
      });
    });
    return () => {
      off();
      if (image) cancelAnimationFrame(image);
      m.dispose();
    };
  }, []);
  return ref.current;
}

// The memory is passed down through context — otherwise every intermediate component (BubbleRow,
// AssistantBlocks, the recursive subagent levels) would have to pass it on as a prop, risking
// its memoization. The value is stable over the lifetime of the view, so it triggers no
// redraw.
const Ctx = createContext<HeightMemory | null>(null);

export function ContainScope({ memory, children }: { memory: HeightMemory; children: React.ReactNode }) {
  return <Ctx.Provider value={memory}>{children}</Ctx.Provider>;
}

/**
 * Wraps a history block and keeps it out of drawing while outside the viewport.
 * `ck` must name the block UNIQUELY and STABLY across streaming updates
 * (in the chat by content: `lib/bubbles-key.ts`); otherwise a block inherits the height of another. Without a surrounding
 * `ContainScope` it stays an ordinary wrapper — callers outside the chat (subagent
 * view) need to know nothing.
 */
export function Contained({
  ck,
  className,
  row,
  children,
}: {
  ck: string;
  className?: string;
  /** The first log row of the bubble (lib/bubbles-key.ts `rowOfTheBubble`) as `data-row` — the target of the row jump
   *  (lib/rows-jump.ts, timeline). Without it (created live, outside the chat) the attribute is missing. */
  row?: number;
  children: React.ReactNode;
}) {
  const memory = useContext(Ctx);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !memory) return;
    memory.attach(el, ck);
    return () => memory.detach(el);
  }, [memory, ck]);
  // `cb-contain-bleed` belongs to the lock, not to the caller: the paint containment of
  // `content-visibility` clips at the padding box. Four pixels of air on both sides
  // make the cut edge the VISIBLE edge again — explanation in globals.css. The reason
  // (the 15-px hexagon in the 7-px column) is gone; with the history without dots
  // there is no symbol column before the rows at all. The air stays as a reserve for glyphs and
  // elements that overhang the edge.
  return (
    <div ref={ref} data-contain="" data-row={row} className={className ? `cb-contain-bleed ${className}` : "cb-contain-bleed"}>
      {children}
    </div>
  );
}
