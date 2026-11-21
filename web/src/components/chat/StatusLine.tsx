// The form of the status messages in the history. Two forms, no others:
//
//   - `StatusLine`: every event with nothing to decide: target gate, monitor, workflow driver, trigger, usage limit
//     (LimitRow). A muted line at the edge of the reply text, 13 px icon, the header one step brighter than the rest,
//     NO colour and no bold: the state is in the word and the icon, not the tone. The caller passes the identifier
//     (`data-event`, `data-limit-row`) through; it stays in THEIR source, where the guards read it.
//   - the card (`CARD`, `CARDS_HEADER`, `BUTTON_MAIN`, `BUTTON_BESIDE`): everything a person answers or reads: question,
//     approval, workflow approval, channel, agent message. Flat, no accent border, muted icon, the main button in text
//     colour instead of cobalt.
//
// Its sister for boundaries in the history (compaction, clearing, hint, completion notice, workflow marker) is
// SeparatorRow.tsx: same type plus a hairline to the edge.
import type { ReactNode } from "react";

export function StatusLine({ icon, header, rest, wrap = false, ...identifier }: {
  icon: ReactNode;
  header: ReactNode;
  /** The rest behind "·". */
  rest?: ReactNode;
  /** The rest IS the content (question, failure reason) and wraps; otherwise the line stays one line with "…". */
  wrap?: boolean;
} & { [k: `data-${string}`]: string | undefined }) {
  return (
    <div {...identifier} className={`flex gap-2 text-[12.5px] leading-5 text-dim ${wrap ? "items-start" : "items-center"}`}>
      <span className="flex h-5 shrink-0 items-center">{icon}</span>
      <span className={`min-w-0 ${wrap ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        <span className="text-fg/75">{header}</span>
        {rest ? <> · {rest}</> : null}
      </span>
    </div>
  );
}

export const CARD = "cb-kit-pane rounded-2xl p-3";
export const CARDS_HEADER = "mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-dim";
export const BUTTON_MAIN = "rounded-full bg-fg px-4 py-1.5 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-85 disabled:opacity-40";
export const BUTTON_BESIDE = "rounded-full border border-edge px-4 py-1.5 text-[12.5px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent";
