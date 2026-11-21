"use client";

import type { WorkflowNodeType } from "@/lib/api";

// The badge of a node and the tables it is drawn from — in ONE file, not two: the type table (`TYPE`, `ENTRY`, `HUMAN`)
// exists so the badge knows which shape and color a kind carries, and whoever needs the table (editor, library, node
// dialog) needs the badge in the same breath.
//
// A leaf: imports nothing from editor or dialog (only the type from `lib/api`), because the dialog must not import the
// editor (cycle guard web/test/import-cycles.test.mjs), and both fetch the badge from here. Two guards read the lists BY
// PATH from this file: `web/test/list-binding.test.mjs` (ENTRIES + STEPS == NODE_TYPES of the server) and
// `web/test/geometry-binding.test.mjs` (ENTRIES against the Swift geometry) — whoever renames a declaration moves the
// anchor there.

// Color and short form per node kind. Hex inline so Tailwind does not optimize it away.
export const TYPE: Record<WorkflowNodeType, { color: string; label: string; hint: string }> = {
  trigger: { color: "#fc6d26", label: "GitLab trigger", hint: "Starts the workflow on its own — on new merge requests, work items, comments, pushes or pipelines." },
  start: { color: "#10b981", label: "Start##noun", hint: "Entry for manual runs — the workflow begins here. Without a start it begins at the first step that has no incoming edge." },
  instruction: { color: "#6c6cff", label: "Instruction", hint: "One work step — costs one turn of the agent." },
  condition: { color: "#f59e0b", label: "Condition", hint: "Branch: a small model judges and picks yes or no." },
  loop: { color: "#a855f7", label: "Loop", hint: "Repeats the body for each item of the list." },
  parallel: { color: "#14b8a6", label: "Parallel", hint: "Branches run concurrently in ONE turn (one subagent per branch)." },
  ask: { color: "#0ea5e9", label: "Question##ask", hint: "The run pauses and waits for your answer in the chat." },
  review: { color: "#ec4899", label: "Review", hint: "Review by YOU: in one turn the agent writes what was built and how you should test it — then the run waits. “Approve” continues, “Findings” goes back into fixing." },
  end: { color: "#94a3b8", label: "End", hint: "End of the workflow." },
};
// The library shows the entries (trigger from outside OR a manual start) above the steps — without section headers,
// just a hairline between them.
export const ENTRIES: WorkflowNodeType[] = ["trigger", "start"];
export const STEPS: WorkflowNodeType[] = ["instruction", "condition", "loop", "parallel", "ask", "review", "end"];
export const ADDABLE: WorkflowNodeType[] = [...ENTRIES, ...STEPS];
// Entries have NO input (the run begins here) — the same list, only lookup-able.
export const ENTRY = new Set<WorkflowNodeType>(ENTRIES);
// Here the run waits for a human: the two kinds whose badge is fully filled.
export const HUMAN = new Set<WorkflowNodeType>(["ask", "review"]);

export const icon = (d: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

// Stroke icon per step kind (single color, on `currentColor`) — the emblem in the badge.
const NODE_ICON: Record<WorkflowNodeType, React.ReactNode> = {
  // Lightning in a circle: the emblem for "something from outside triggers" (n8n draws triggers the same way).
  trigger: <><circle cx="12" cy="12" r="9" /><path d="M13 6.5 9 12.8h3l-.6 4.7 4-6.3h-3z" /></>,
  start: <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5.5 3.5-5.5 3.5z" /></>,
  instruction: <><path d="M15 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7z" /><path d="M15 3v4h4M8.5 12.5h7M8.5 16h4" /></>,
  condition: <><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2v4.3a2 2 0 0 0 2 2h7.8M8.2 6H16" /></>,
  loop: <><path d="M4 12a8 8 0 0 1 8-8c2.6 0 4.9 1.2 6.4 3.1" /><path d="M20 12a8 8 0 0 1-8 8c-2.6 0-4.9-1.2-6.4-3.1" /><path d="M19 3.5V7h-3.5M5 20.5V17h3.5" /></>,
  // One strand fanning out into three branches — three strokes alone read like a menu.
  parallel: <><path d="M3 12h4" /><path d="M7 12c4 0 3-6 7-6h2M7 12h9M7 12c4 0 3 6 7 6h2" /><circle cx="18.5" cy="6" r="1.6" /><circle cx="18.5" cy="12" r="1.6" /><circle cx="18.5" cy="18" r="1.6" /></>,
  ask: <><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" /><path d="M10 8.8a2.2 2.2 0 1 1 3 2.05V12" /><path d="M13 14.6h.01" /></>,
  // Person with a check mark: THIS node waits for a human, not for a model.
  review: <><path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="m15.5 11 2.2 2.2L22 8.9" /></>,
  end: <><circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1" /></>,
};

// Icon of the badge for the three kinds whose stroke icon carries a circle: on the badge the shape (hexagon or square) IS
// the frame, a second circle in it would be a ring in a ring.
const BADGE_ICON: Partial<Record<WorkflowNodeType, React.ReactNode>> = {
  trigger: <path d="M13.5 3.5 7.5 13h4.4l-1.4 7.5L16.5 11h-4.4z" />,
  start: <path d="m8.5 5.5 10 6.5-10 6.5z" />,
  end: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
};

// The dimension everything hangs on: on the card the badge is 28 px, there icon (14/15) and corner radius (8) are
// measured. Every other size scales from it — library 22, collapsed strip 26, header of the node dialog 22. The ONE
// statement about the card dimension: the editor imports it for the card instead of declaring the number a second time.
export const BADGE_CARD = 28;

/**
 * Icon badge of a node: SHAPE tells the role, COLOR the kind. Four variants, each with exactly one meaning — hexagon for
 * the entries (the mark of the house: here the run enters cbase), full fill only where the run waits for a HUMAN
 * (question, review), graphite for the end (completion of a matter), otherwise the type color at 16% on `panel`. The icon
 * is mixed a touch toward the text color: amber and emerald would be too pale on their own tint in light mode, and in
 * dark mode the same mix brightens by itself.
 *
 * `title`: omitted = the sentence for the role (entry, waits for you, endpoint) as on the card; `null` = NO own tooltip —
 * in the library the row carries it, and an empty `title=""` on the badge would cut off the row's tooltip (that is how
 * `title` is specified).
 */
export function WorkflowBadge({ type, size, t, title }: {
  type: WorkflowNodeType;
  size: number;
  t: (key: string) => string;
  title?: string | null;
}) {
  const c = TYPE[type];
  const entryPoint = ENTRY.has(type);
  const full = HUMAN.has(type) || type === "end";
  const role = entryPoint ? t("Entry — the run starts here") : HUMAN.has(type) ? t("The run waits for you here") : type === "end" ? t("End — the run stops here") : undefined;
  const mass = (base: number) => Math.round((size * base) / BADGE_CARD);
  return (
    <span
      title={title === undefined ? role : (title ?? undefined)}
      className="grid shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        clipPath: entryPoint ? "polygon(50% 0%, 93.3% 25%, 93.3% 75%, 50% 100%, 6.7% 75%, 6.7% 25%)" : undefined,
        borderRadius: entryPoint ? undefined : mass(8),
        background: type === "end" ? "var(--color-dark)" : full ? c.color : `color-mix(in srgb, ${c.color} 16%, var(--color-panel))`,
        color: full ? "#ffffff" : `color-mix(in srgb, ${c.color} 80%, var(--color-fg))`,
      }}
    >
      {icon(BADGE_ICON[type] ?? NODE_ICON[type], mass(entryPoint ? 14 : 15))}
    </span>
  );
}
