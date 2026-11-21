"use client";

// The chats in the rail of the collapsed list: one button per chat with its shortcut (lib/chat-shortcut.ts), in list order (same
// sections, no folders). Hover shows the SAME tooltip card as a list row, from the same store (the button carries
// `data-tooltip-row`, the card sits to its right). Click opens, right-click opens the row menu. The open chat is filled (`edge`,
// like the row); a working chat shows the spinning hexagon, an unread one the glowing one, as a mark at the button's bottom right.
import type { Chat } from "@/lib/api";
import { chatShortcut } from "@/lib/chat-shortcut";
import { CbIcon } from "@/components/chat/ChatIcons";
import type { TooltipHandles } from "@/components/chat/ChatTooltip";

export function RailChats({ chats, activeId, working, unread, handles, onOpen, onMenu, visible }: {
  chats: readonly Chat[];
  activeId: string | null;
  working: (id: string) => boolean;
  unread: (id: string) => boolean;
  handles: (id: string) => TooltipHandles;
  onOpen: (id: string) => void;
  onMenu: (chat: Chat, x: number, y: number) => void;
  /** Is the rail showing (list collapsed)? Otherwise the buttons are not tab stops. */
  visible: boolean;
}) {
  if (!chats.length) return null;
  return (
    <div data-rail-chats className="mt-1.5 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto border-t border-edge pb-2 pt-2 [scrollbar-width:none]">
      {chats.map((c) => {
        const g = handles(c.id);
        const on = c.id === activeId;
        const running = working(c.id);
        const fresh = !running && unread(c.id);
        return (
          <button
            key={c.id}
            type="button"
            data-tooltip-row={c.id}
            aria-label={c.title}
            aria-current={on ? "page" : undefined}
            tabIndex={visible ? 0 : -1}
            onClick={() => onOpen(c.id)}
            onPointerEnter={g.onPointerEnter}
            onPointerLeave={g.onPointerLeave}
            onMouseDown={g.onMouseDown}
            onContextMenu={(e) => { e.preventDefault(); g.onContextMenu(); onMenu(c, e.clientX, e.clientY); }}
            className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold tracking-wide transition-colors ${
              on ? "bg-edge text-fg" : "text-dim hover:bg-hover hover:text-fg"
            }`}
          >
            {chatShortcut(c.title)}
            {(running || fresh) && (
              <span className="absolute -bottom-0.5 -right-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full bg-bg text-accent">
                {running ? (
                  <span className="inline-flex animate-[spin_2.6s_linear_infinite]" data-row-running><CbIcon size={9} /></span>
                ) : (
                  <span className="inline-flex drop-shadow-[0_0_4px_currentColor]"><CbIcon size={9} filled /></span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
