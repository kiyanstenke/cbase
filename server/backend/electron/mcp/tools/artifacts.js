// MCP tools: artifacts and folder context (cbase_artifacts_*, folder_context_*).
// One contiguous slice of the tool array, in source order: catalog.js spreads the groups back together into TOOLS; the order is
// part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import { api, enc, int, needChat, obj, qs, str } from "../lib.js";

const artifactTools = [
  {
    name: "cbase_artifacts_list",
    description: "List all persistent files of this chat (path, MIME type, size, timestamp, SHA-256). Artifacts are free-form files; the active skill determines meaning and naming scheme. If the chat is in a chat folder, the artifacts of the other chats of this folder are INCLUDED in the list, recognizable by own:false together with chatId/chatTitle. Such foreign artifacts are READ-ONLY (cbase_artifacts_read with chatId). Contents are not loaded into the context automatically.",
    inputSchema: obj({}),
    handler: async () => api("GET", `/api/chats/${enc(needChat())}/artifacts`),
  },
  {
    name: "cbase_artifacts_read",
    description: "Read a persistent file of this chat. Text comes as UTF-8, binary data as Base64. Large files can be loaded piecewise with offset/maxBytes. The returned SHA-256 must be used as expectedSha256 when later overwriting or deleting. With chatId you read an artifact of another chat in the SAME chat folder (from cbase_artifacts_list); that is possible read-only.",
    inputSchema: obj({
      path: str("Relative artifact path, e.g. spec.md or issues/01-login.md"),
      chatId: str("Only for shared artifacts: chatId from cbase_artifacts_list (chat in the same folder). Omit for your own artifacts."),
      offset: int("Byte offset for piecewise reading (optional)"),
      maxBytes: int("Maximum bytes to read, at most 1 MiB (optional)"),
    }, ["path"]),
    handler: async (a) => api("GET", `/api/chats/${enc(needChat())}/artifacts/file${qs({ path: a.path, chatId: a.chatId, offset: a.offset, maxBytes: a.maxBytes })}`),
  },
  {
    name: "cbase_artifacts_write",
    description: "Create or atomically update a free-form persistent file of this chat. Skills determine path and content. If the path already exists, call cbase_artifacts_read first and send its SHA-256 as expectedSha256; that way parallel changes are not overwritten. Writing ALWAYS happens in your own chat: shared artifacts from the chat folder (own:false) are read-only; if you need your own version, read it and write it anew under your own path.",
    inputSchema: obj({
      path: str("Relative artifact path, subfolders are allowed"),
      content: str("File content as UTF-8 or Base64"),
      encoding: str("utf8 (default) | base64"),
      expectedSha256: str("Current SHA-256 for an update; omit for a new file"),
    }, ["path", "content"]),
    handler: async (a) => api("PUT", `/api/chats/${enc(needChat())}/artifacts/file`, {
      path: a.path, content: a.content, encoding: a.encoding, expectedSha256: a.expectedSha256,
    }),
  },
  {
    name: "cbase_artifacts_delete",
    description: "Delete a persistent file of this chat. Read it with cbase_artifacts_read first and send the current SHA-256. Delete only if the user or the active skill really demands it.",
    inputSchema: obj({
      path: str("Relative artifact path"),
      expectedSha256: str("Current SHA-256 from cbase_artifacts_read"),
    }, ["path", "expectedSha256"]),
    handler: async (a) => api("DELETE", `/api/chats/${enc(needChat())}/artifacts/file${qs({ path: a.path, expectedSha256: a.expectedSha256 })}`),
  },
  {
    name: "cbase_folder_context_list",
    description: "List the context files of the chat FOLDER this chat is in (path, MIME type, size, SHA-256). This is material stored by the user that applies to all chats of the folder: briefings, specifications, protocols, sample data. It is NOT the same as project knowledge (cbase_context_list) and not the same as the chat's artifacts (cbase_artifacts_list). If the chat is in no folder, the list is empty. Contents are not loaded automatically.",
    inputSchema: obj({}),
    handler: async () => api("GET", `/api/chats/${enc(needChat())}/folder-context`),
  },
  {
    name: "cbase_folder_context_read",
    description: "Read a context file of the chat folder (text as UTF-8, binary data as Base64; large files piecewise via offset/maxBytes). These files are the basis set by the user: they trump your assumptions. READ-ONLY: your own results belong in your chat's artifacts (cbase_artifacts_write).",
    inputSchema: obj({
      path: str("Path from cbase_folder_context_list"),
      offset: int("Byte offset for piecewise reading (optional)"),
      maxBytes: int("Maximum bytes to read, at most 1 MiB (optional)"),
    }, ["path"]),
    handler: async (a) => api("GET", `/api/chats/${enc(needChat())}/folder-context/file${qs({ path: a.path, offset: a.offset, maxBytes: a.maxBytes })}`),
  },
];

export { artifactTools };
