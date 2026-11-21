// Open a Coding chat by id from any page: if this tab shows Coding in the chat's workspace, the event `cbase-open-chat` opens it
// (ChatPane `openTarget`; the page switches to the “Chats” tab, the same way as bell and channel bar); otherwise the address
// `/workspaces/?ws=…&chat=…` leads there (ChatPane reads `?chat=`). “The same workspace” means the one THIS tab shows (live scope),
// not the remembered start value.
// Callers: the dumpster (sorting files), “start service with agent” (project services and apps page), the waiting rows of usage
// (settings).

import { readActiveScope, rememberWorkspace } from "@/lib/active-scope";

export function openCodingChat(chatId: string, workspaceId: string, { prior }: { prior?: () => void } = {}): void {
  if (!chatId || !workspaceId) return;
  const here = window.location.pathname.startsWith("/workspaces");
  if (here && readActiveScope().workspaceId === workspaceId) {
    prior?.();
    window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: chatId }));
    return;
  }
  rememberWorkspace(workspaceId);
  window.location.href = `/workspaces/?ws=${encodeURIComponent(workspaceId)}&chat=${encodeURIComponent(chatId)}`;
}
