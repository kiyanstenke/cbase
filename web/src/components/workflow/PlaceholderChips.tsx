"use client";

// The two small building blocks that node dialog, trigger component and the editor's library share: the placeholder chips
// and the (i) with tooltip — the latter also in the header of the library.
//
// A leaf of its own because the import direction demands it: `WorkflowNodeDialog.tsx` imports `WorkflowTriggerSettings.tsx`
// — an import back would be a cycle (guard web/test/import-cycles.test.mjs). So all of them fetch the building blocks from here.

/**
 * Mono chips below a text field. With `onChoice` they are buttons (a click inserts the token at the insertion mark — the
 * caller knows where it is); without `onChoice` a plain display with tooltip (the trigger has no text field to insert into).
 */
export function PlaceholderChips({ chips, onChoice }: {
  chips: readonly { token: string; title: string }[];
  onChoice?: (token: string) => void;
}) {
  const kind = "rounded-full bg-bg px-2 py-0.5 font-mono text-[11px] text-dim";
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => onChoice ? (
        <button
          key={c.token}
          type="button"
          title={c.title}
          // mousedown without focus change: the text field keeps focus and selection, and the click inserts exactly where
          // the mark was — otherwise the caller would read the mark of a field that has just lost focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChoice(c.token)}
          className={`${kind} transition-colors hover:bg-hover hover:text-fg`}
        >
          {c.token}
        </button>
      ) : (
        <span key={c.token} title={c.title} className={`${kind} cursor-help`}>{c.token}</span>
      ))}
    </div>
  );
}

/**
 * A small (i) next to a label — the tooltip carries the RULE that used to stand as a paragraph below the field. Native
 * `title`, as the kit `Toggle` holds it (the kit has no tooltip component); `aria-label` equal to the text, so a screen
 * reader reads the same.
 */
export function Info({ text }: { text: string }) {
  return (
    <span role="img" title={text} aria-label={text} className="inline-grid h-3 w-3 shrink-0 cursor-help place-items-center text-dim">
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5.5M12 7.5h.01" />
      </svg>
    </span>
  );
}
