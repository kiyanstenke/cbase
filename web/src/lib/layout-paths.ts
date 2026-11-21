// Paths after an adopted outline. PURE. The final event `project/layout` of the job carries the final mapping of the job: `mapping` =
// `[{ old, fresh }]`, `way` = `[old]` (deleted) — only the topmost affected nodes, a child that lies differently from its parent folder
// stands separately. The longest matching `old` wins (the same rule as `targetOf`).
import { type MappingEntry, targetOf } from "@/lib/project-layout";

export interface LayoutEnd { ways: { old: string; fresh: string }[]; gone: string[] }

/** From the event — foreign shapes drop (empty is not unknown: without a list it means "nothing moved"). */
export function endFromEvent(evt: Record<string, unknown>): LayoutEnd {
  const ways = Array.isArray(evt.mapping)
    ? (evt.mapping as unknown[]).filter((w): w is { old: string; fresh: string } => typeof (w as { old?: unknown })?.old === "string" && typeof (w as { fresh?: unknown })?.fresh === "string")
    : [];
  const gone = Array.isArray(evt.gone) ? (evt.gone as unknown[]).filter((p): p is string => typeof p === "string") : [];
  return { ways, gone };
}

/** Where a path (relative to the project root) has moved: the new path, `null` = deleted, otherwise unchanged. */
export function newPath(path: string, end: LayoutEnd): string | null {
  const mapping: MappingEntry[] = [...end.ways.map((w) => ({ from: w.old, to: w.fresh })), ...end.gone.map((p) => ({ from: p, to: null }))];
  const z = targetOf(mapping, path);
  return z === undefined ? path : z;
}
