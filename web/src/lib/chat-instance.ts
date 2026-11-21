// Binding the chat-bound views to the INSTANCE of their chat.
//
// A chat that moved into its copy k1 works there: turn, terminal (tag `chat:<id>`), files, git. The right chat bar used to call git and
// browser WITHOUT the chat, so the server (devtools/routes.js `targetInstance`) took the main one: the git panel showed the main
// one's state as the chat's, and commit, discard, stash and checkout from this chat changed the MAIN's repo; the bar's browser was the
// main one's. The server could already do it (`gitOptions`, `/browser/ensure?chat=`).
//
// This is the one computation for that: which route carries the chat (only a project route; the workspace has no instance), how it
// gets onto the address (also behind `?repo=`), what the copy is called that the server names, and which tree stands in the panel
// after a failed fetch. Which instance applies is ALWAYS decided by the server (`instanceForChat`: the chat's copy, child pin, else the
// main one; a copy of another project rests): the client only attaches the chat and shows what comes back.
//
// A leaf module: no import except types, so the test (web/test/chat-bar.test.mjs, (e)) checks it under Node without React. Also here:
// the computation of a git-state fetch (`afterRetrieval`): what the panel shows and what the server SAID last (`read`); the bar reads
// the chat's own instance only from the latter.
import type { GitTree } from "./api/git.js";

/** Does this apiBase carry an instance? Only the project route `/api/projects/<id>` (no query, no subpath). */
export function bindsChat(apiBase: string): boolean {
  return /^\/api\/projects\/[^/?#]+$/.test(String(apiBase || ""));
}

/**
 * `${apiBase}${rest}` with the chat as query `chat=<id>`, only on a project route and only with a chat; otherwise today's address.
 * `rest` may already carry a query (`/git/stashes?repo=…`), then the chat follows with `&`. With `rest = ""` it is the key of a
 * per-chat stock (lib/git-state.ts).
 */
export function chatPath(apiBase: string, rest: string, chatId: string | null | undefined): string {
  const url = `${apiBase}${rest}`;
  if (!chatId || !bindsChat(apiBase)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chatId)}`;
}

/** The name of a copy from the instance the server names: “copy-k1” → “k1”. The main one, empty and anything else → null. */
export function copyName(instance: string | null | undefined): string | null {
  const m = /^copy-(.+)$/.exec(String(instance || ""));
  return m ? m[1] : null;
}

/**
 * The tree the git view shows after a FAILED fetch. If the error carries `error` (the 409 of a locked copy, devtools/routes.js: never
 * the main one's repos), that is a situation the panel names (`gitHints`), together with the copy; an error without `error` (network,
 * old server) stays what it was: an empty tree (empty is not unknown only holds for what the server says explicitly).
 */
export function gitErrorTree(e: unknown): GitTree {
  const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
  const error = typeof o.error === "string" ? o.error : "";
  if (!error) return { repos: [] };
  // Errors of an instance choice (`?instance=`, code tab and chat bar) carry `code` and the chosen `identifier`: the choice falls back
  // VISIBLY on them (lib/bar-instance.ts), instead of leaving the error text standing until the next event.
  const choice = (o.code === "UNKNOWN_INSTANCE" || o.code === "INSTANCE_INVALID")
    ? { code: o.code, ...(typeof o.identifier === "string" && o.identifier ? { identifier: o.identifier } : {}) } : {};
  return { repos: [], error, ...(typeof o.instance === "string" && o.instance ? { instance: o.instance } : {}), ...choice };
}

/** The part of a git stock (lib/git-state.ts) that a fetch changes. */
export type RetrievalStatus = {
  /** What the panel shows: the tree, the situation of an error with `error`, or after a silent failure the empty tree. */
  tree: GitTree | null;
  /** The fingerprint of `tree`: `""` for the silent error tree (and before the first fetch). */
  print: string;
  /** What the server SAID last: the tree of a response or the situation of an error with `error`; `null` while none came. */
  read: GitTree | null;
};
export type RetrievalResult = { kind: "response"; tree: GitTree } | { kind: "error"; error: unknown };

/**
 * What a fetch makes of the stock: the computation of `fetch` in lib/git-state.ts, here pure so the test RUNS it.
 *   - Success: the tree, and it is also `read`.
 *   - Failure WITH `error` (the 409 of a locked copy, the 404 of a chosen one): the situation as a tree (`gitErrorTree`); the server
 *     has spoken, `read` is it (together with the copy it names).
 *   - Failure WITHOUT `error` (network, 502/504 on a restart of B, old server): the panel shows the empty tree as before, but `read`
 *     stays what it was. Empty is not unknown: the right chat bar used to read the chat's own instance from the silent error tree;
 *     without `instance`, “no answer” meant “the main one” there, a copy's menu showed “Main · this chat”, and a choice froze this
 *     false main one as the own instance (iOS sets `GitModel.copy` only on success).
 * `fresh`: the fingerprint changed, so readers get the new state; a repeated error stays silent.
 */
export function afterRetrieval(prior: RetrievalStatus, result: RetrievalResult): RetrievalStatus & { fresh: boolean } {
  if (result.kind === "response") {
    const print = JSON.stringify(result.tree);
    if (print === prior.print) return { ...prior, fresh: false };
    return { tree: result.tree, print, read: result.tree, fresh: true };
  }
  // An error with `error` (locked copy) has its own fingerprint: if it changes, it reports; an error without one stays silent ("").
  const t = gitErrorTree(result.error);
  const print = t.error ? `error:${JSON.stringify(t)}` : "";
  if (prior.tree !== null && prior.print === print) return { ...prior, fresh: false };
  return { tree: t, print, read: t.error ? t : prior.read, fresh: true };
}

/**
 * The own copy of a chat as the server NAMED it last (from `read` of a chat-bound stock): its name, `null` for the main one,
 * `undefined` while the server has said nothing; then the bar has no choice (lib/bar-instance.ts `ownFromServer`), instead of a silent
 * failure counting as “the main one”.
 */
export function ownCopySaid(read: GitTree | null | undefined): string | null | undefined {
  return read ? copyName(read.instance) : undefined;
}
