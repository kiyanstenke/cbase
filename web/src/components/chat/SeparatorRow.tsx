// The separator row in the history: ONE building block for the coding chat (ChatBubbleRow). Several kinds under the
// bubble role `divider`, told apart by `kind`:
//   - no kind: the marker of a compaction, with the caller's icon;
//   - `completionNotice`: the system line of a completion notice, no icon;
//   - `hint`: the server's hint line (`hintSeparator`, lib/hint.ts), no icon (it must not look like a compaction);
//   - `workflow-start` / `workflow-end`: start and end marker of a dynamic workflow (`markerSeparator` in
//     lib/workflow-marker.ts), no icon; identifier `data-workflow-marker` for test benches.
// Set in the type of the status line (StatusLine.tsx): left-aligned at the edge of the reply text, 12.5 px, no caps or
// letter-spacing, a hairline to the edge behind it. Clearing ("Chat cleared up to here") draws this row too.
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { SeparatorKind } from "@/lib/hint";
import { separatorTone, type SeparatorTone } from "@/lib/separator-tone";
import { ic } from "@/components/CbKit";
import { StatusLine } from "@/components/chat/StatusLine";

// (lib/separator-tone.ts): completion notices and workflow markers are status lines with an icon, the same signs as
// their counterpart in ChatBubbleRow (check done, circle failed, bolt event, arrow start).
const TONE_SYMBOL: Record<SeparatorTone, ReactNode> = {
  start: ic(<><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>, 13),
  ok: ic(<path d="M20 6 9 17l-5-5" />, 13),
  error: ic(<circle cx="12" cy="12" r="8" />, 13),
  notice: ic(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8" />, 13),
};

export function SeparatorRow({ b, icon, className = "my-1 flex items-center gap-2 text-[12.5px] leading-5 text-dim" }: {
  b: { kind?: SeparatorKind; label?: string; labelParams?: Record<string, string> };
  /** The icon of a compaction (only without `kind`). */
  icon?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const tone = separatorTone(b.kind, b.label);
  if (tone) {
    return (
      <div className="my-1">
        <StatusLine icon={TONE_SYMBOL[tone]} header={t(b.label ?? "", b.labelParams)}
          data-completion-notice={b.kind === "completionNotice" ? "1" : undefined}
          data-workflow-marker={b.kind === "workflow-start" ? "start" : b.kind === "workflow-end" ? "end" : undefined}
          data-event-tone={tone} />
      </div>
    );
  }
  return (
    <div className={className} data-completion-notice={b.kind === "completionNotice" ? "1" : undefined} data-hint={b.kind === "hint" ? "1" : undefined}
      data-workflow-marker={b.kind === "workflow-start" ? "start" : b.kind === "workflow-end" ? "end" : undefined}>
      {!b.kind && icon}
      <span className="min-w-0 break-words text-fg/75">{t(b.label ?? "Context compacted", b.labelParams)}</span>
      <span className="h-px min-w-6 flex-1 bg-edge" />
    </div>
  );
}
