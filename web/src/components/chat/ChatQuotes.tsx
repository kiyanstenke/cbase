"use client";

// The composer's quotes ("reply" on selected text), modelled on ChatGPT's input field after a reply to a selection:
//   - IN the field the mark "1 comment" (speech bubble, count, one round × for all); it opens and closes the card;
//   - ABOVE the field the card: per quote "1.", dimmed "Selected text:", below it the quote in text colour (three lines at
//     most), on the right a pencil (edit in place) and a trash can.
// ChatPane owns the quotes themselves (they go out with `send`, lib/quotes.ts); this file holds only what the display alone
// needs: whether the card is open and which quote is being edited.
//
// A separate file instead of markup in the composer: the composer's form contract (web/test/composer-form.test.mjs) counts
// EXACTLY one text field in its <form> — a quote's edit field would be a second.
//
// The card is a sheet above the field like the @ list (`cb-pop`, `absolute bottom-full` on the <form>): it opens as soon as a
// quote is added, closes with a click elsewhere (document `mousedown` + `closest("[data-quote-pop]")`, no click catcher over
// the page) and opens again via the mark. While the slash or @ list is open, it steps back.
import { useEffect, useRef, useState } from "react";
import { PencilIcon, TrashIcon, XIcon } from "@/components/chat/ChatIcons";

export function QuoteAnnotations({
  t,
  quotes,
  setQuotes,
  obscured,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  quotes: string[];
  setQuotes: React.Dispatch<React.SetStateAction<string[]>>;
  /** The slash or @ list sits in the same place above the field, so the card stays closed. */
  obscured: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [edit, setEdit] = useState<number | null>(null);
  const prior = useRef(""); // text before editing: Escape restores it
  const editRef = useRef<number | null>(null);
  editRef.current = edit;

  // A NEW quote (the list grows) opens the card, even if it was collapsed.
  const count = useRef(quotes.length);
  useEffect(() => {
    if (quotes.length > count.current) setOpen(true);
    count.current = quotes.length;
  }, [quotes.length]);

  // End editing: a quote that became empty is dropped (an empty quote would otherwise go out as "> ").
  function finished() {
    if (editRef.current === null) return;
    setEdit(null);
    setQuotes((cur) => cur.filter((z) => z.trim()));
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-quote-pop]")) return;
      finished();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // `finished` only reads refs and setters: the dependency on `open` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Pencil: the same quote again ends editing, another one switches to it. If the quote edited so far became empty, it is
  // dropped, and the target moves up by one if it was behind it.
  function editQuote(i: number) {
    const b = editRef.current;
    if (b === i) { finished(); return; }
    prior.current = quotes[i] ?? "";
    if (b !== null && !quotes[b]?.trim()) {
      setQuotes((cur) => cur.filter((_, j) => j !== b));
      setEdit(b < i ? i - 1 : i);
      return;
    }
    setEdit(i);
  }

  function remove(i: number) {
    setQuotes((cur) => cur.filter((_, j) => j !== i));
    setEdit((b) => (b === null || b === i ? null : b > i ? b - 1 : b));
  }

  const n = quotes.length;
  return (
    <>
      {open && !obscured && (
        <div
          data-quote-pop
          data-quote-card
          className="cb-pop-in-fast cb-pop absolute bottom-full left-0 right-0 z-40 mb-1.5 max-h-[min(340px,45vh)] origin-bottom overflow-y-auto rounded-2xl px-1.5 py-1"
        >
          <ol>
            {quotes.map((z, i) => (
              <li key={i} className={`flex items-start gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-edge" : ""}`}>
                <span className="w-4 shrink-0 text-[13.5px] leading-snug tabular-nums text-dim">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] leading-snug text-dim">{t("Selected text:")}</div>
                  {edit === i ? (
                    <textarea
                      autoFocus
                      value={z}
                      rows={1}
                      aria-label={t("Edit annotation")}
                      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                      onChange={(e) => { const v = e.target.value; setQuotes((cur) => cur.map((old, j) => (j === i ? v : old))); }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          const old = prior.current;
                          setQuotes((cur) => cur.map((x, j) => (j === i ? old : x)));
                          setEdit(null);
                        } else if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          finished();
                        }
                      }}
                      onBlur={finished}
                      className="mt-1 max-h-40 w-full resize-none field-sizing-content rounded-lg bg-bg px-2 py-1 text-[13.5px] leading-snug text-fg outline-none ring-1 ring-edge focus:ring-accent/60"
                    />
                  ) : (
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[13.5px] leading-snug text-fg" title={z}>{z}</p>
                  )}
                </div>
                <div className="-mr-1 flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    title={t("Edit annotation")}
                    aria-label={t("Edit annotation")}
                    // No focus change on press: otherwise the blur of the edit field would end editing before the click
                    // arrives, and the same pencil would start again right away.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editQuote(i)}
                    className={`grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-hover hover:text-fg ${edit === i ? "text-fg" : "text-dim"}`}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    title={t("Remove annotation")}
                    aria-label={t("Remove annotation")}
                    // Likewise no blur: otherwise `finished` would clean up first, and the index would shift under the click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => remove(i)}
                    className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {/* The mark IN the field, above the text field: like the waiting attachments, a line of its own. */}
      <div className="flex px-1.5 pt-1.5">
        <span data-quote-pop data-quote-marker className="inline-flex h-8 items-center gap-0.5 rounded-full bg-fg/[0.08] pr-1 text-[13px] text-fg">
          <button
            type="button"
            aria-expanded={open && !obscured}
            onClick={() => { if (open) finished(); setOpen((v) => !v); }}
            className="flex h-8 items-center gap-1.5 rounded-full pl-2.5 pr-1.5 font-medium"
          >
            <SpeechBubblesIcon />
            {n === 1 ? t("1 annotation") : t("{n} annotations", { n })}
          </button>
          <button
            type="button"
            title={t("Remove all annotations")}
            aria-label={t("Remove all annotations")}
            onClick={() => { setEdit(null); setQuotes([]); }}
            className="grid h-5 w-5 place-items-center rounded-full bg-fg/[0.12] text-dim transition-colors hover:bg-fg/20 hover:text-fg"
          >
            <XIcon />
          </button>
        </span>
      </div>
    </>
  );
}

const SpeechBubblesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" />
  </svg>
);
