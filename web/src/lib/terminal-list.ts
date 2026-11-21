// The terminals of the bottom panel styled like VS Code — the PURE computation. The panel used to hold EXACTLY one terminal in the
// project folder; but "Open in Integrated Terminal" (VS Code `openInTerminal`) starts a NEW one in the chosen folder without ending the
// running one. So a list:
//
//   fresh      one more terminal with start folder `cwd` (project-relative, "" = the root) — it becomes the active one (VS Code: the new one
//              is in front and has focus).
//   safe       the panel shows TERMINAL and none runs ⇒ one in the root (VS Code creates one on showing, ⌃`); otherwise nothing.
//   end        "Kill Terminal" (trash can): the active one (or the named one) falls; the active one becomes the one at the same position, else the
//              last (VS Code `killInstance` → `setActiveInstanceByIndex`). If none is left, the panel closes
//              (`terminal.integrated.hideOnLastClosed`) — the caller sees an empty list.
//   select     bring another one to the front (the list on the right, once there is more than one — `terminal.integrated.tabs.hideCondition: singleTerminal`).
//
// The title as in VS Code (`terminal.integrated.tabs.title: ${process}`): the shell's name ("zsh") once the server names it at start
// (`POST …/terminal` → `shell`). Until then — and against an old server that does not name it — the start folder's name (the root: the
// project name): otherwise the list on the right would be unreadable. The web does not know the foreground process ("node" during a run).
// Guard: web/test/terminal-list.test.mjs (with counter-proofs).

export type TerminalEntry = { seq: number; cwd: string };
export type TerminalState = { list: readonly TerminalEntry[]; active: number | null; next: number };
export type TerminalAction =
  | { kind: "fresh"; cwd?: string }
  | { kind: "safe" }
  | { kind: "end"; seq?: number }
  | { kind: "select"; seq: number };

export const TERMINAL_EMPTY: TerminalState = { list: [], active: null, next: 1 };

/** A start folder without leading/trailing slashes — "" is the root. */
export const terminalFolderNorm = (cwd: string | undefined): string => String(cwd ?? "").replace(/^\/+|\/+$/g, "");

export function terminalStep(s: TerminalState, a: TerminalAction): TerminalState {
  switch (a.kind) {
    case "fresh": {
      const seq = s.next;
      return { list: [...s.list, { seq, cwd: terminalFolderNorm(a.cwd) }], active: seq, next: seq + 1 };
    }
    case "safe":
      return s.list.length ? s : terminalStep(s, { kind: "fresh" });
    case "select":
      return s.list.some((x) => x.seq === a.seq) && s.active !== a.seq ? { ...s, active: a.seq } : s;
    case "end": {
      const seq = a.seq ?? s.active;
      const i = s.list.findIndex((x) => x.seq === seq);
      if (i < 0) return s;
      const list = s.list.filter((x) => x.seq !== seq);
      if (s.active !== seq) return { ...s, list };
      const front = list[Math.min(i, list.length - 1)];
      return { ...s, list, active: front ? front.seq : null };
    }
  }
}

/** A terminal's title: its shell's name, while that is unknown the name of its start folder (the root: the project name). */
export function terminalTitle(cwd: string, rootName: string, shell?: string | null): string {
  if (shell) return shell;
  const n = terminalFolderNorm(cwd);
  return n ? n.slice(n.lastIndexOf("/") + 1) : rootName;
}
