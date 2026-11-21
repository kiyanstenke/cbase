// The explorer sections as in VS Code — the PURE calculation. Drawn in components/code/explorer/ExplorerSections.tsx.
//
// VS Code stacks sections in the explorer (`ViewPane` in a `PaneView`): the folder (the tree), OUTLINE and TIMELINE — each with its own
// header (22 px, `Pane.headerSize`), collapsible to the header, the open ones share the height, and between two sections sits a drag bar
// (sash). Default: the folder open, outline and timeline closed (that is how VS Code starts). Here:
//
//   sectionHeights   the heights (header + content) from the state and the space: a collapsed section is only its header; the remembered
//                     sizes of the open ones ARE their content heights — if their sum does not fit the space (window changed, a section
//                     was added), they are stretched or squeezed proportionally (VS Code `SplitView` with `proportionalLayout`), and a
//                     section that would fall below MIN_CONTENT (VS Code `minimumBodySize`) gets the minimum, the rest goes
//                     proportionally to the others. With everything closed the headers sit at the top and the rest stays empty (as in
//                     VS Code). The sizes are not weights ABOVE the minimum — otherwise the bar would not follow the mouse (space 566:
//                     +10 px drag → −16 px).
//   pullPair         which two sections a drag bar between section i and i+1 moves: the nearest open one above (≤ i) and the nearest open
//                     one below (> i) — if one is missing, it moves nothing (VS Code: the sash is then off).
//   pull              the new state after `distance` pixels: the sizes of ALL open sections become their measured content heights (so the
//                     ratio stays as it was seen), the two of the pair exchange `distance`, clamped at MIN_CONTENT.
//   toggle            open/closed; the remembered size stays (reopened, the section comes back at its old size).
//   stateFrom          the remembered state (localStorage, per device) — validated: what is missing or does not fit is the default (never
//                     half a state, empty is not unknown).
// Guard: web/test/explorer-sections.test.mjs (with counter-proofs).

export const SECTIONS = ["files", "layout", "timeAxis"] as const;
export type SectionId = (typeof SECTIONS)[number];
/** The header of a section (VS Code `Pane.headerSize`). */
export const HEADER_HEIGHT = 22;
/** The smallest content height of an open section (VS Code `ViewPane` `minimumBodySize`). */
export const MIN_CONTENT = 120;

export type SectionsStatus = { open: Readonly<Record<SectionId, boolean>>; size: Readonly<Record<SectionId, number>> };

export const SECTIONS_DEFAULT: SectionsStatus = {
  open: { files: true, layout: false, timeAxis: false },
  size: { files: 400, layout: 200, timeAxis: 200 },
};

/** Height per section (header + content) at `slot` pixels. The sum is `slot` as soon as one is open and the space carries the headers. */
export function sectionHeights(s: SectionsStatus, slot: number): Record<SectionId, number> {
  const out = { files: HEADER_HEIGHT, layout: HEADER_HEIGHT, timeAxis: HEADER_HEIGHT } as Record<SectionId, number>;
  const open = SECTIONS.filter((id) => s.open[id]);
  if (!open.length) return out;
  const rest = Math.max(0, slot - SECTIONS.length * HEADER_HEIGHT);
  const min = Math.min(MIN_CONTENT, Math.floor(rest / open.length));
  // The remembered sizes fitted to the space (with a matching sum exactly themselves); one that would fall below the minimum gets it, and the
  // rest is redistributed among the others — until none falls below (terminates: the others together always carry ≥ their minimum).
  const content = {} as Record<SectionId, number>;
  let free: SectionId[] = [...open], slotFree = rest;
  for (;;) {
    const sum = free.reduce((a, id) => a + Math.max(1, s.size[id]), 0);
    const share = (id: SectionId) => (slotFree * Math.max(1, s.size[id])) / sum;
    const tooSmall = free.filter((id) => share(id) < min);
    if (!tooSmall.length) { for (const id of free) content[id] = share(id); break; }
    for (const id of tooSmall) { content[id] = min; slotFree -= min; }
    free = free.filter((id) => !tooSmall.includes(id));
  }
  // Whole pixels; the last open one gets the remainder (the sum is exactly the space).
  let allocated = 0;
  open.forEach((id, i) => {
    const h = i === open.length - 1 ? rest - allocated : Math.floor(content[id] + 1e-9);
    allocated += h;
    out[id] = HEADER_HEIGHT + h;
  });
  return out;
}

/** The two open sections between which the drag bar after section `i` (0-based) sits — or null (it moves nothing). */
export function pullPair(s: SectionsStatus, i: number): [SectionId, SectionId] | null {
  let top: SectionId | null = null, bottom: SectionId | null = null;
  for (let k = i; k >= 0; k--) if (s.open[SECTIONS[k]]) { top = SECTIONS[k]; break; }
  for (let k = i + 1; k < SECTIONS.length; k++) if (s.open[SECTIONS[k]]) { bottom = SECTIONS[k]; break; }
  return top && bottom ? [top, bottom] : null;
}

/** The state after dragging the bar after section `i` by `way` pixels (down is positive), measured at the heights `heights`. */
export function pull(s: SectionsStatus, heights: Readonly<Record<SectionId, number>>, i: number, distance: number): SectionsStatus {
  const pair = pullPair(s, i);
  if (!pair) return s;
  const [top, bottom] = pair;
  const content = (id: SectionId) => Math.max(0, heights[id] - HEADER_HEIGHT);
  const size = { ...s.size } as Record<SectionId, number>;
  for (const id of SECTIONS) if (s.open[id]) size[id] = content(id);
  const sum = content(top) + content(bottom);
  const lowerLimit = Math.min(MIN_CONTENT, Math.floor(sum / 2));
  const newTop = Math.max(lowerLimit, Math.min(sum - lowerLimit, content(top) + Math.round(distance)));
  size[top] = newTop;
  size[bottom] = sum - newTop;
  return { open: s.open, size };
}

export function toggle(s: SectionsStatus, id: SectionId): SectionsStatus {
  return { open: { ...s.open, [id]: !s.open[id] }, size: s.size };
}

/** The remembered state — validated; what is missing or does not fit takes the default. */
export function stateFrom(raw: unknown): SectionsStatus {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const openRaw = o.open && typeof o.open === "object" ? (o.open as Record<string, unknown>) : {};
  const sizeRaw = o.size && typeof o.size === "object" ? (o.size as Record<string, unknown>) : {};
  const open = {} as Record<SectionId, boolean>, size = {} as Record<SectionId, number>;
  for (const id of SECTIONS) {
    open[id] = typeof openRaw[id] === "boolean" ? (openRaw[id] as boolean) : SECTIONS_DEFAULT.open[id];
    const g = sizeRaw[id];
    size[id] = typeof g === "number" && Number.isFinite(g) && g > 0 ? g : SECTIONS_DEFAULT.size[id];
  }
  return { open, size };
}
