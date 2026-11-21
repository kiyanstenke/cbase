"use client";

// The instance of a coding chat. Every chat works in an instance of its project; default main (`chats.instance` NULL).
//
//   - It is chosen in the EMPTY chat next to the project choice (`.cb-strip-bottom`, ChatStage) and changed in the chat
//     header (menu at the project label). The choice exists only if the list is not empty: every converted project whose
//     field has been read; without a ready copy, main alone (lib/instances-tree.ts chatInstanceOptions; the copies as in
//     runs/instance-switch.js LIVE_INSTANCE). Below it "Create copy …" (`copyCreate`): the jump to the tab "Instances" of
//     this project (lib/project-jump.ts `showInstances`), where the dialog opens with the CURRENT instance (the chat's, or the
//     preselection without a chat) as base. Never for the child chat of a graph run (`parentChatId`): it does not switch
//     (409 INSTANCE_PINNED); neither the choice nor the entry shows there.
//   - The source is the field `instance` of GET /api/projects, fresh for the project in question (the open chat's, else the
//     next one's preselection), and after the events `project/instance` and `project/copy` of this project. It is only asked
//     if the workspace knows the project as converted; a project without ops marker costs no request.
//   - Without a chat it is the next chat's preselection (`instanceForCreation` goes into POST /api/chats, only for a copy;
//     main is the server's default); it applies to the project it was made for and falls back to main as soon as the list no
//     longer carries it.
//   - With a chat the switch goes out as PATCH /api/chats/:id { instance }; the field is ALWAYS there (lib/api/instances.ts,
//     typed body: a missing field is no statement). It takes effect from the next turn; the separator "now working in …" is
//     written by the server as a message of the role `hint` and the switch is reported in the chat's stream
//     (`harness`/`chat_settings` with `instance`). The message itself does NOT come in the stream: ChatPane reloads the
//     history on the event (immediately without a run, at run end with one) and sets `instance` in the chat list, also for a
//     switch the agent (cbase_switch_instance) or another client caused.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorFields, setChatInstance, subscribeGlobalEvents, type Chat, type Project, type Workspace } from "@/lib/api";
import { MAIN, chatInstanceName, chatInstanceOptions, type InstanceOption, type ProjectInstanceField } from "@/lib/instances-tree";
import { showInstances } from "@/lib/project-jump";

export function useChatInstance({ workspace, projectId, activeChat, setChats, pushInfo }: {
  workspace: Workspace;
  /** The project in question: the open chat's, without a chat the next one's preselection (focus or project choice). */
  projectId: string | null;
  activeChat: Chat | undefined;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  pushInfo: (title: string, body: string) => void;
}): {
  instanceOptions: InstanceOption[];
  activeInstance: string;
  pickInstance: (name: string) => void;
  instanceForCreation: { instance?: string };
  copyCreate: () => void;
  selectInstancePreselection: (name: string) => void;
} {
  const converted = Boolean(projectId && workspace.projects.find((p) => p.id === projectId)?.instance?.converted);
  // `pid` records which project the field was read for; a field of the previous project never applies to the new one.
  const [read, setRead] = useState<{ pid: string; field: ProjectInstanceField } | null>(null);
  useEffect(() => {
    if (!projectId || !converted) return;
    let alive = true;
    const load = () => {
      api<Project[]>("/api/projects")
        .then((list) => { if (alive && Array.isArray(list)) setRead({ pid: projectId, field: list.find((p) => p.id === projectId)?.instance ?? null }); })
        .catch(() => { /* without an answer no choice: "not read" is not a list */ });
    };
    load();
    const off = subscribeGlobalEvents((evt) => {
      if ((evt.type === "project/instance" || evt.type === "project/copy") && String(evt.projectId ?? "") === projectId) load();
    });
    return () => { alive = false; off(); };
  }, [projectId, converted]);
  // The child chat of a graph run (`parentChatId`, GET /api/chats/:id) works fixed in the instance its run began in; the
  // server answers every switch with 409 INSTANCE_PINNED, so the choice is not offered.
  const pinned = Boolean(activeChat?.parentChatId);
  const instanceOptions = useMemo(
    () => (!pinned && converted && read && read.pid === projectId ? chatInstanceOptions(read.field) : []),
    [pinned, converted, read, projectId],
  );

  // The next chat's preselection applies only while its project's list carries it, and that means something only once the
  // list has been READ: "Start chat" on a copy sets project and instance in one go, the new project's options are still
  // empty then, and without `readFor` the preselection would fall back to main at once (empty is not unknown).
  const [preselection, setPreselection] = useState<string>(MAIN);
  const readFor = !converted || pinned || (read !== null && read.pid === projectId);
  useEffect(() => {
    if (readFor && preselection !== MAIN && !instanceOptions.some((o) => o.name === preselection)) setPreselection(MAIN);
  }, [readFor, instanceOptions, preselection]);

  const chatId = activeChat?.id ?? null;
  const pickInstance = useCallback((name: string) => {
    if (!chatId) { setPreselection(name); return; }
    setChatInstance(chatId, name === MAIN ? null : name)
      .then((chat) => setChats((cs) => cs.map((c) => (c.id === chatId ? { ...c, instance: chat?.instance ?? null } : c))))
      .catch((e) => pushInfo("Note", errorFields(e).text));
  }, [chatId, setChats, pushInfo]);

  const activeInstance = activeChat ? chatInstanceName(activeChat.instance) : preselection;
  const instanceForCreation = useMemo(
    () => (!activeChat && preselection !== MAIN && instanceOptions.some((o) => o.name === preselection) ? { instance: preselection } : {}),
    [activeChat, preselection, instanceOptions],
  );
  // "Create copy …": into the project's tab "Instances", the dialog there with the current instance as base; only where the
  // choice shows (without options the entry does not exist, ChatInstanceChoice).
  const workspaceId = workspace.id;
  const copyCreate = useCallback(() => {
    if (!projectId) return;
    showInstances({ workspaceId, projectId, createFrom: activeInstance });
  }, [workspaceId, projectId, activeInstance]);
  // An entry point "New chat" sets the draft's preselection (chat/chatDraft.ts) directly, not via `pickInstance`: in the same
  // step the open chat is only closing, `chatId` still points at it, and `pickInstance` would send the switch to IT.
  return { instanceOptions, activeInstance, pickInstance, instanceForCreation, copyCreate, selectInstancePreselection: setPreselection };
}
