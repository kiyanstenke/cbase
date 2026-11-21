"use client";

import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PaletteEntry } from "@/lib/slash";
import { menuHeader, menuRowGuided } from "@/components/CbKit";

/**
 * The slash picker in the composer.
 *
 * When someone types a slash at the START of the input, a list of two kinds opens above the field: the chat's
 * client-side slash commands and the skills that apply to exactly this chat. To the right is the description of the
 * highlighted entry — the real reason for the picker: a column of names does not say what a skill does, and for
 * skills the description is the only text there is.
 *
 * Why the description is a COLUMN and not a floating tooltip: the same view is 1,400 px wide alone and 940 next to the
 * chat list — a box sticking out of the menu on the right would sit now free, now half outside the window. The column
 * cannot overflow. Below the container threshold (`@lg/composer`) it moves under the list; dropping it entirely would
 * remove exactly the information the picker exists for on a narrow window.
 *
 * The picker only SELECTS, it executes nothing: it writes "/name " into the field and returns the focus. What happens
 * next is decided by sending alone. A known command runs client-side (runSlash) and never goes out. A skill goes out as
 * text, and every provider does something different with it:
 *
 *   Claude CLI (`-p`)  expands the slash itself; an UNKNOWN name ends with "Unknown command: /x" and swallows the
 *                      rest of the message.
 *   Codex (`exec`)     has no expansion: the model reads the SKILL.md from CODEX_HOME and follows it — same result,
 *                      different route.
 *   Loop engine        sees plain text but has a `Skill` tool with exactly these names as an enum
 *                      (providers/engine.js) — the model reaches for it.
 *
 * A neighbouring namespace stays invisible: `--setting-sources user` leaves the account's personal plugins and skills
 * in place. They work but are in no cbase directory, so the picker cannot offer them.
 */

function GroupsTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className={menuHeader}>{children}</div>
  );
}

export function SlashPalette({
  entries,
  idx,
  onIdx,
  onChoice,
  titleCommands,
  titleSkills,
  titleWorkflows = "",
  emptyText,
  identifier,
}: {
  entries: PaletteEntry[];
  idx: number;
  onIdx: (i: number) => void;
  onChoice: (e: PaletteEntry) => void;
  titleCommands: string;
  titleSkills: string;
  /** The third kind: graph workflows as `workflow:<shortname>` — only the coding chat supplies such entries. */
  titleWorkflows?: string;
  /** Shown when the search matches nothing — otherwise the picker would vanish on a typo. */
  emptyText: string;
  identifier: string;
}) {
  const selected = entries[Math.min(idx, entries.length - 1)];

  // Does the list continue below? Then it FADES OUT instead of ending at a hard edge — otherwise a filled board looks
  // like a complete one, and whoever sees nine commands takes them for everything there is. Measured, not guessed: an
  // always-visible gradient would also fade the LAST row and claim there is more.
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  }, []);
  // After every layout: the list changes while typing, and the highlighted entry scrolls itself — both shift the rest
  // without a scroll event.
  useLayoutEffect(measure, [measure, entries, idx]);
  // A heading appears where the kind changes. Read from the LIST, not from two separate loops: otherwise keyboard
  // navigation would have to compute over two index spaces.
  const titleBefore = (i: number) =>
    i === 0 || entries[i - 1].group !== entries[i].group
      ? entries[i].group === "command" ? titleCommands : entries[i].group === "workflow" ? titleWorkflows : titleSkills
      : null;

  const description = selected && (
    <>
      <div className="font-mono text-[12px] font-semibold text-fg">
        /{selected.name}
        {selected.arg && <span className="font-normal text-dim"> {selected.arg}</span>}
      </div>
      {selected.origin && (
        <div className="mt-0.5 text-[11px] text-dim">{selected.origin}</div>
      )}
      {/* Clamped: a skill's description is length-limited nowhere (neither in the schema nor in the routes). A
          900-character frontmatter paragraph would otherwise fill half the window — and the picker should support the
          choice, not show the file. */}
      <div className="mt-1.5 line-clamp-6 text-[12px] leading-relaxed text-dim">{selected.description}</div>
    </>
  );

  return (
    <div
      data-slash-pop={identifier}
      className="cb-pop-in-fast cb-pop absolute bottom-full left-0 right-0 z-40 mb-1.5 origin-bottom overflow-hidden rounded-2xl"
    >
      <div className="flex min-h-0">
        {/* The list. `overscroll-contain` so the wheel at the end does not scroll the history behind it — the list lies directly above it. */}
        <div
          ref={listRef}
          onScroll={measure}
          style={more ? { maskImage: "linear-gradient(to bottom, #000 calc(100% - 2.25rem), transparent 100%)" } : undefined}
          className="max-h-[266px] min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {entries.length === 0 && (
            <div className="px-2.5 py-3 text-[12px] text-dim">{emptyText}</div>
          )}
          {entries.map((e, i) => {
            const title = titleBefore(i);
            // A fragment instead of a wrapper per row: the rows are siblings, and `.cb-menu-row + .cb-menu-row`
            // (globals.css) keeps the spacing between them.
            return (
              <Fragment key={`${e.group}:${e.name}`}>
                {title && <GroupsTitle>{title}</GroupsTitle>}
                <button
                  type="button"
                  ref={i === idx ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  // mousedown instead of click: otherwise the field loses focus first, and the composer's onBlur
                  // removes the picker before the click arrives.
                  onMouseDown={(ev) => { ev.preventDefault(); onChoice(e); }}
                  onMouseEnter={() => onIdx(i)}
                  data-slash-entry={e.name}
                  data-slash-group={e.group}
                  aria-selected={i === idx}
                  // Guided row (CbKit `menuRowGuided`): the highlight follows `idx` (arrow keys, onMouseEnter) — no
                  // second surface under the resting pointer, no cross-fade.
                  className={`${menuRowGuided} items-baseline! font-mono text-[12px] ${
                    i === idx ? "bg-accent text-white" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">/{e.name}</span>
                  {e.origin && (
                    <span className={`shrink-0 truncate font-sans text-[10.5px] ${i === idx ? "text-white/75" : "text-dim"}`}>
                      {e.origin}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
        {/* Description column — from `@lg/composer` (32 rem) to the right of the list. */}
        {selected && (
          <div className="hidden w-[13.5rem] shrink-0 overflow-y-auto border-l border-edge/60 p-3 @lg/composer:block">
            {description}
          </div>
        )}
      </div>
      {/* … and below it while the composer is narrower. */}
      {selected && (
        <div className="border-t border-edge/60 px-3 py-2 [&_.line-clamp-6]:line-clamp-3 @lg/composer:hidden">{description}</div>
      )}
    </div>
  );
}
