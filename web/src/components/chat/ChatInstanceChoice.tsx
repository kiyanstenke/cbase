"use client";

// Instance choice of a Coding chat: ONE component for both places on the stage. `hero` sits in the strip under the empty chat's
// field (next to the project choice, picks the default for the next chat); `header` sits at the project label of the header (switches
// the open chat from its next turn). State and computation live in chat/chatInstance.ts; this file is only the form: kit `Menu`
// (sheet `cb-pop` on the body, click catcher via document mousedown), entries as a CHOICE with a check mark. Without options (no
// converted project, field not read yet) there is no button. In every converted project it is shown, with `main` (the main
// instance) alone and selected when there is no ready copy, and under a separator "Create copy …": the way into the project's
// "Instances" tab, where the dialog opens with the chat's instance as base (`onCopyCreate`, chat/chatInstance.ts → lib/project-jump.ts).
import { Menu, MenuEntry, MenuSeparator } from "@/components/CbKit";
import { CaretDown } from "@/components/chat/ChatIcons";
import { instanceTitle } from "@/components/projects/InstanceDialogs";
import type { InstanceOption } from "@/lib/instances-tree";

type Translator = (key: string, params?: Record<string, string | number>) => string;

const InstanceIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 16.5 9 4.5 9-4.5" />
  </svg>
);

/** Two offset boxes with a plus: "Create copy" (the copy tile of the "Instances" tab plus a plus). Local because the kit of the
 *  project pages (projects/ProjectForm.tsx) is being moved. */
const PlusCopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
    <path d="M14 11.5v5M11.5 14h5" />
  </svg>
);

/** State of a selectable instance as a word: only the three of `LIVE_INSTANCE`; "ready" is not shown (the normal case). */
function stateWord(state: string, t: Translator): string {
  if (state === "start") return t("starting");
  if (state === "stopped") return t("stopped");
  return "";
}

export function ChatInstanceChoice({ t, location, options, active, onPick, onCopyCreate, preamble }: {
  t: Translator;
  location: "hero" | "header";
  options: InstanceOption[];
  /** Name of the current instance (`main` or `copy-<name>`). */
  active: string;
  onPick: (name: string) => void;
  /** "Create copy …": into the project's "Instances" tab, with the current instance as base. */
  onCopyCreate: () => void;
  /** In the header without project focus: the project name in front, since there is no other project label there. */
  preamble?: string;
}) {
  if (!options.length) return null;
  const title = instanceTitle(active, t);
  const kind = location === "hero"
    ? "flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-dim transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg"
    : "flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-1 text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg";
  return (
    <Menu
      label={t("Choose instance · {instance}", { instance: title })}
      width={240}
      alignment={location === "header" ? "right" : "left"}
      shrinks={location === "header"}
      button={{
        content: (
          <>
            <span className="shrink-0"><InstanceIcon /></span>
            <span className="min-w-0 truncate">{preamble ? `${preamble} · ${title}` : title}</span>
            <span className="shrink-0"><CaretDown /></span>
          </>
        ),
        className: kind,
        data: { "data-chat-instance": location },
      }}
    >
      {options.map((o) => {
        const word = stateWord(o.state, t);
        return (
          <MenuEntry
            key={o.name}
            label={instanceTitle(o.name, t)}
            selected={o.name === active}
            right={word ? <span className="shrink-0 text-[11px] text-dim">{word}</span> : undefined}
            data={{ "data-chat-instance-choice": o.name }}
            onClick={() => { if (o.name !== active) onPick(o.name); }}
          />
        );
      })}
      <MenuSeparator />
      <MenuEntry
        label={t("Create copy …")}
        right={<span className="shrink-0 text-dim"><PlusCopyIcon /></span>}
        data={{ "data-chat-instance-create": location }}
        onClick={onCopyCreate}
      />
    </Menu>
  );
}
