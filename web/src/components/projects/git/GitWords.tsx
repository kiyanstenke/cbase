"use client";

// Words and jumps of the git overview — ONE version for both renderers' vocabulary: how a user, a state, a reason and a group
// are named, and where › jumps to.
//
// JUMPS: a subagent or workflow agent → `openAgent(chatId, agentId)` (lib/agent-jump.ts: the chat opens, the bar shows "Agents"
// with this agent or its run's progress tree); a graph run → its child chat via `cbase-open-chat`; a copy → the "Instances" tab
// with this copy (`showInstances`, where it is called `copy-<name>` — in the git overview's seam only `<name>`). Running chats on
// a checked-out branch: one ⇒ the jump, several ⇒ a small list (kit `Menu`: `cb-pop` on the body, click catcher via document
// mousedown). Without a way (no ids, no project) the text stands without ›.
import { Menu, MenuEntry } from "@/components/CbKit";
import type { GitViewRow, GitUser, GitGroup, GitRunningChat, GitCounts, GitState } from "@/lib/api";
import { openAgent } from "@/lib/agent-jump";
import { shortAge } from "@/lib/git-view-time";
import { showInstances } from "@/lib/project-jump";
import type { useT } from "@/lib/i18n";

export type Translator = ReturnType<typeof useT>;
/** Where the view stands — without a project (workspace level) there is no jump into the instances. */
export type GitLocation = { workspaceId: string | null; projectId: string | null };

export const openChat = (id: string) => window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: id }));

export function groupWord(g: GitGroup, t: Translator): string {
  switch (g) {
    case "checkedOut": return t("Checked out");
    case "branches": return t("Branches");
    case "cbase": return t("From cbase");
    case "remote": return t("Remote only");
  }
}

export function stateWord(z: GitState, t: Translator): string {
  switch (z) {
    case "running": return t("running");
    case "ended": return t("terminated");
    case "copy-removed": return t("Copy removed");
    // "unknown" ≠ "ended": without a row it cannot be said whether the agent finished or its chat was deleted.
    case "unknown": return t("Origin unknown");
  }
}

/** Why an instance is not read — an unknown word of the server is shown as it came (never silently "no reason"). */
export function reasonWord(g: string | null, t: Translator): string {
  switch (g) {
    case "stopped": return t("stopped");
    case "starts": return t("starting");
    case "frozen": return t("frozen");
    case "error": return t("Error");
    case "time": return t("timed out");
    case null: return t("no reason given");
    default: return g;
  }
}

/** `main` is called "Main", a copy "Copy k1". */
/** The name of a row for display: a detached HEAD arrives as "detached @ <sha>" (the wire name, which the detail route reads back). */
export function rowName(z: Pick<GitViewRow, "name" | "detached">, t: Translator): string {
  return z.detached ? t("detached @ {sha}", { sha: z.name.slice(z.name.lastIndexOf("@ ") + 2) }) : z.name;
}
export const instanceWord = (name: string, t: Translator) => (name === "main" ? t("Main") : t("Copy {name}", { name }));

export function userWord(b: GitUser, t: Translator): string {
  const name = b.name ? ` „${b.name}“` : "";
  switch (b.kind) {
    case "subagent": return `${t("Subagent")}${name}`;
    case "workflow-agent": return `${t("Workflow agent")}${name}`;
    case "graph": return `${t("Graph run")}${name}`;
    case "copy": return b.instance ? t("Copy {name}", { name: b.instance }) : t("Copy##noun");
  }
}

/** "↑3 ↓12" — ahead in front, behind at the back. */
export const arrows = (z: GitCounts) => `↑${z.ahead} ↓${z.back}`;

export function oldWord(ms: number | null, now: number, t: Translator): string | null {
  const a = shortAge(ms, now);
  return a ? t(a.key, { n: a.n }) : null;
}

/** "3 min ago" — under a minute "just now" (never "ago just now"); `null` without a time. */
export function beforeWord(ms: number | null, now: number, t: Translator): string | null {
  const a = shortAge(ms, now);
  if (!a) return null;
  return a.key === "just now" ? t("just now") : t("{age} ago", { age: t(a.key, { n: a.n }) });
}

/** The running chats of a row across all instances in which it is checked out (each chat once). */
export function runningChats(z: GitViewRow): GitRunningChat[] {
  const seen = new Set<string>();
  const out: GitRunningChat[] = [];
  for (const a of z.checkedOut ?? []) for (const c of a.chats ?? []) if (!seen.has(c.chatId)) { seen.add(c.chatId); out.push(c); }
  return out;
}

/** The unsaved changes of a row across all places where it is checked out — `null` if no place carries a number. */
export function notBackedUpOf(z: GitViewRow): number | null {
  const counts = (z.checkedOut ?? []).map((a) => a.notBackedUp).filter((n): n is number => n !== null);
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
}

/** Where a user jumps to — `null` if there is no way (missing ids; a copy without a project). */
export function userJump(b: GitUser, location: GitLocation): (() => void) | null {
  switch (b.kind) {
    case "subagent":
    case "workflow-agent": {
      const { chatId, agentId } = b;
      return chatId && agentId ? () => openAgent(chatId, agentId) : null;
    }
    case "graph": {
      const id = b.childChatId ?? b.chatId;
      return id ? () => openChat(id) : null;
    }
    case "copy": {
      const { workspaceId, projectId } = location;
      const copy = b.instance;
      return workspaceId && projectId && copy ? () => showInstances({ workspaceId, projectId, instance: `copy-${copy}` }) : null;
    }
  }
}

const JUMP_CLASS = "inline-flex min-w-0 items-center gap-0.5 rounded px-0.5 text-left text-fg/80 transition-colors hover:bg-hover hover:text-fg";

/** User (and, in the group "From cbase", its state) with › — without a way only the text. */
export function UserJump({ b, state, location, t }: { b: GitUser; state: GitState | null; location: GitLocation; t: Translator }) {
  const text = `${userWord(b, t)}${state ? ` · ${stateWord(state, t)}` : ""}`;
  const jump = userJump(b, location);
  if (!jump) return <span className="min-w-0 truncate">{text}</span>;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); jump(); }} title={text} className={JUMP_CLASS} data-git-user={b.kind}>
      <span className="min-w-0 truncate">{text}</span><span aria-hidden>›</span>
    </button>
  );
}

/** "2 chats running ›": one ⇒ into the chat, several ⇒ the small list. `front` stands before it ("Main · "). */
export function ChatsJump({ chats, t, front = "" }: { chats: GitRunningChat[]; t: Translator; front?: string }) {
  if (chats.length === 0) return null;
  const text = `${front}${chats.length === 1 ? t("1 chat running") : t("{n} chats running", { n: chats.length })}`;
  if (chats.length === 1) {
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); openChat(chats[0].chatId); }} title={chats[0].title || t("New chat")} className={JUMP_CLASS} data-git-chats="1">
        <span className="min-w-0 truncate">{text}</span><span aria-hidden>›</span>
      </button>
    );
  }
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0">
      <Menu
        label={text}
        width={240}
        alignment="left"
        shrinks
        button={{ content: <><span className="min-w-0 truncate">{text}</span><span aria-hidden>›</span></>, className: JUMP_CLASS, data: { "data-git-chats": String(chats.length) } }}
      >
        {chats.map((c) => <MenuEntry key={c.chatId} label={c.title || t("New chat")} onClick={() => openChat(c.chatId)} />)}
      </Menu>
    </span>
  );
}
