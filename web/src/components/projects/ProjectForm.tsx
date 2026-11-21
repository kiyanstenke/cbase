"use client";

// The form of the project pages: the project list (ProjectsPane), the tabs of the project view, the services
// (ProjectServicesPane, OldContainerRemove) and the layout (LayoutPage, LayoutTakeOver, ProjectLayout `flat`) share one language:
//
// - no surface (`cb-kit-pane`), no hairlines; rows are rounded and light up under the pointer (`hover:bg-hover`), the selected one
//   carries the accent tint `SELECTED` — never `cb-row`: the kit sets `border-radius: 0` there, unlayered;
// - in front a tile with the thing's icon in the color of its state (`Tile`, one step lighter under the pointer via
//   `group-hover:bg-edge`);
// - a section has a small tile with the category icon before the title, the rows indented below it (`Section`);
// - icons with stroke 1.8 and round caps, the same as the Coding rail (app/workspaces/page.tsx `TabIcon`).
//
// The shared parts (`SELECTED`, `ROW`/`ROW_INSIDE`, `LIST_ROW`, `FACTS`/`Fact`, `Tile`, `Section`/`SectionHeader`, `symbol`) live in
// the kit (CbKit.tsx) and are re-exported here under the same names, so the imports under projects/ stay as they are. What stays
// here is project-specific: the color of an instance state and the icons `S`.
import { symbol } from "@/components/CbKit";

export {
  Section, SectionHeader, FACTS, Fact, SELECTED, Tile, LIST_ROW, ROW, ROW_INSIDE, symbol,
} from "@/components/CbKit";

/** The color of an instance state as `bg-*` (dot) — green ready, accent in transition, yellow waiting, red error, muted otherwise.
 *  For a tile `textOf(instanceColor(z))`. */
export function instanceColor(z: string | null | undefined): string {
  if (z === "ready") return "bg-ok";
  if (z === "error") return "bg-danger";
  if (z === "clearAway" || z === "waiting_queue" || z === "waiting_storage") return "bg-warn";
  if (z === "create" || z === "build" || z === "start" || z === "stop" || z === "recreate" || z === "relocation") return "bg-accent";
  return "bg-dim/40";
}
/** `bg-ok` → `text-ok`; the muted `bg-dim/40` becomes `text-dim` (an icon at 40 % would no longer be legible). */
export const textOf = (bg: string) => (bg === "bg-dim/40" ? "text-dim" : bg.replace("bg-", "text-"));

export const S = {
  main: (s?: number) => symbol(<><path d="M3.5 10.5 12 3.5l8.5 7" /><path d="M5.5 9v10a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9" /><path d="M10 20.5v-5h4v5" /></>, s),
  copy: (s?: number) => symbol(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>, s),
  container: (s?: number) => symbol(<><path d="M20.5 7.8 12 3 3.5 7.8v8.4L12 21l8.5-4.8z" /><path d="m3.5 7.8 8.5 4.8 8.5-4.8" /><path d="M12 12.6V21" /></>, s),
  services: (s?: number) => symbol(<><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><path d="M8 7h.01" /><path d="M8 17h.01" /></>, s),
  repos: (s?: number) => symbol(<><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>, s),
  chats: (s?: number) => symbol(<path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />, s),
  code: (s?: number) => symbol(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, s),
  terminal: (s?: number) => symbol(<><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>, s),
  link: (s?: number) => symbol(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18" /></>, s),
  // The project (a folder), the layout (like the tab), old containers (an archive box), the port (a plug), changes and log (lines).
  project: (s?: number) => symbol(<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />, s),
  layout: (s?: number) => symbol(<><path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" /><path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" /></>, s),
  archive: (s?: number) => symbol(<><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M10 13h4" /></>, s),
  port: (s?: number) => symbol(<><path d="M9 3v4" /><path d="M15 3v4" /><path d="M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>, s),
  changes: (s?: number) => symbol(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>, s),
  check: (s?: number) => symbol(<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>, s),
  warn: (s?: number) => symbol(<><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>, s),
};
