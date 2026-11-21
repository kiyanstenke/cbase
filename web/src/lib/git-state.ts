"use client";

// The git state of a scope (project or workspace), polled ONCE — no matter how many views read it (right chat bar). Reason: the activity
// bar shows the number of changes as a badge on the git icon, the git panel beside it shows the files — both need `GET <apiBase>/git`,
// and `git status` is expensive on large trees. Two pollers at 6 s each would have doubled the load without anyone seeing anything
// faster.
//
// Hence one inventory per apiBase in a module registry: the first reader starts the clock, the last ends it; every reader gets the same
// tree. The clock does not run in the background (`document.hidden`) and not twice (a fetch that is still running blocks the next
// tick). Whoever runs an action (commit, stage, …) and gets a fresh tree back passes it via `setTree` to ALL readers — otherwise the
// badge would show the old number for six seconds.
//
// The fingerprint (`print`) compares the tree as a string before passing it on: the clock mostly reports NOTHING new, and a new object
// would still re-render every file row. This holds at TWO places: `fetch` reports only a changed state, and the reader takes over only
// a different tree (React bails out on the same state identity). One place alone is not enough — a `setStatus({…})` per tick rendered
// the whole bar including the terminal every 6 s.
//
// The state carries the CHAT of the bar (`useGitState(apiBase, chatId)`): on a project route `?chat=<id>` goes along (lib/chat-instance.ts
// `chatPath`), the server then reads the instance of THIS chat — its copy, once it has moved in (devtools/routes.js targetInstance) —, and
// the inventory is one per chat (key `chatPath(apiBase, "", chatId)`): two chats of the same project in different instances do not share
// a tree. Without a chat (code page, workspace) everything stays as it was. A failed fetch whose response carries `error` (the 409 of a
// locked copy) stands as a situation in the tree (`gitErrorTree`) — otherwise it would look like "no repository".
//
// Besides the tree the state carries what the server SAID last (`read`): a silent failure (network, 502/504 on a restart of B) shows
// the empty tree in the panel as before, but does not change `read`. The right chat bar reads the chat's own instance only from it — from
// the silent error tree, "no answer" there would have meant "the main one".
// The calculation of a fetch lives purely in lib/chat-instance.ts `afterRetrieval` (tested executed there); `fetch` only calls it.

import { useCallback, useEffect, useState } from "react";
import { api, type GitTree } from "@/lib/api";
import { chatPath, afterRetrieval, type RetrievalResult } from "@/lib/chat-instance";
import { instancePath } from "@/lib/code-instance";

export const GIT_STATUS_TICK_MS = 6_000;

type Reader = (tree: GitTree | null, loaded: boolean, read: GitTree | null) => void;
type Inventory = {
  url: string; // `<apiBase>/git`, with the chat if it determines an instance
  tree: GitTree | null;
  loaded: boolean;
  print: string;
  read: GitTree | null; // what the server SAID last (lib/chat-instance.ts afterRetrieval) — a silent failure does not change it
  reader: Set<Reader>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  off: (() => void) | null;
};

const register = new Map<string, Inventory>();
type State = { key: string | null; tree: GitTree | null; loaded: boolean; read: GitTree | null };

function report(b: Inventory) {
  for (const l of b.reader) l(b.tree, b.loaded, b.read);
}

async function fetch(b: Inventory) {
  if (b.running) return;
  b.running = true;
  // Only what has changed is reported: the first fetch (loaded flips), a different fingerprint, or the switch into the error
  // state. A repeated error stays silent.
  let fresh = !b.loaded;
  try {
    let result: RetrievalResult;
    try { result = { kind: "response", tree: await api<GitTree>(b.url) }; } catch (e) { result = { kind: "error", error: e }; }
    // An error with `error` (locked copy) has its own fingerprint — if it changes, it reports; an error without stays silent ("")
    // and leaves `read` alone (lib/chat-instance.ts afterRetrieval).
    const r = afterRetrieval(b, result);
    if (r.fresh) { b.tree = r.tree; b.print = r.print; b.read = r.read; fresh = true; }
  } finally {
    b.loaded = true;
    b.running = false;
    if (fresh) report(b);
  }
}

function inventory(key: string, url: string): Inventory {
  let b = register.get(key);
  if (b) return b;
  b = { url, tree: null, loaded: false, print: "", read: null, reader: new Set(), timer: null, running: false, off: null };
  register.set(key, b);
  return b;
}

function start(b: Inventory) {
  if (b.timer) return;
  const tick = () => { if (!document.hidden) void fetch(b); };
  b.timer = setInterval(tick, GIT_STATUS_TICK_MS);
  const onFocus = () => { void fetch(b); };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", tick);
  b.off = () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", tick); };
  void fetch(b);
}

function stop(b: Inventory) {
  if (b.timer) clearInterval(b.timer);
  b.timer = null;
  b.off?.();
  b.off = null;
  // The inventory stays in the registry: whoever reopens the scope right away sees the last tree immediately instead of waiting for
  // the next fetch. That costs one object per scope.
}

/** Number of changes across all repos — the number on the git icon (VS Code: `scm.countBadge`). */
export function gitChanges(tree: GitTree | null): number {
  return (tree?.repos ?? []).reduce((n, r) => n + (r.counts?.total ?? 0), 0);
}

/**
 * The shared git state of a scope. `apiBase` null ⇒ no scope (no project), tree null.
 * `chatId`: the chat of the bar — on a project route it determines the instance (its copy), and the inventory is one per chat.
 * `instance`: the chosen copy of the code tab (`instance=<id>`, lib/code-instance.ts) — the inventory is one per instance;
 * without it key and address as before.
 * Returns `refresh` (fetch now) and `setTree` (take over a fresh tree from an action for all readers).
 */
export function useGitState(apiBase: string | null, chatId?: string | null, instance?: string | null): {
  tree: GitTree | null;
  loaded: boolean;
  /** What the server SAID last (tree or situation with `error`) — `null` until the first answer; a silent failure does not change it.
   *  Whoever concludes something about the instance from it (the right chat bar) reads here, never `tree`. */
  read: GitTree | null;
  changes: number;
  refresh: () => Promise<void>;
  setTree: (tree: GitTree) => void;
} {
  const key = apiBase ? instancePath(chatPath(apiBase, "", chatId), instance) : null;
  const url = apiBase ? instancePath(chatPath(apiBase, "/git", chatId), instance) : null;
  // The state carries its key: if the target changes (other chat, other instance), the tree of the old target would otherwise run under
  // the new one for ONE render — the bar would read the chat's copy (`instance`) wrongly, and its own browser would briefly hang on the
  // wrong instance. Until the effect subscribes to the new inventory, what the registry already knows for the new key (or nothing) holds.
  const fromRegister = (s: string | null): State => {
    const b = s ? register.get(s) : null;
    return b ? { key: s, tree: b.tree, loaded: b.loaded, read: b.read } : { key: s, tree: null, loaded: false, read: null };
  };
  const [raw, setStatus] = useState<State>(() => fromRegister(key));
  const state = raw.key === key ? raw : fromRegister(key);

  useEffect(() => {
    if (!key || !url) { setStatus({ key, tree: null, loaded: false, read: null }); return; }
    const b = inventory(key, url);
    // Same tree, same state ⇒ return the same object, and React does not render.
    const reader: Reader = (tree, loaded, read) => setStatus((prev) => (prev.key === key && prev.read === read && prev.tree === tree && prev.loaded === loaded ? prev : { key, tree, loaded, read }));
    b.reader.add(reader);
    reader(b.tree, b.loaded, b.read);
    start(b);
    return () => {
      b.reader.delete(reader);
      if (b.reader.size === 0) stop(b);
    };
  }, [key, url]);

  const refresh = useCallback(async () => {
    if (!key || !url) return;
    await fetch(inventory(key, url));
  }, [key, url]);

  const setTree = useCallback((tree: GitTree) => {
    if (!key || !url) return;
    set(inventory(key, url), tree);
  }, [key, url]);

  return { tree: state.tree, loaded: state.loaded, read: state.read, changes: gitChanges(state.tree), refresh, setTree };
}

function set(b: Inventory, tree: GitTree) {
  b.tree = tree;
  b.print = JSON.stringify(tree);
  b.read = tree; // the response of an action is a server response (devtools/code-route.js: the same tree including `instance`)
  b.loaded = true;
  report(b);
}

/** Take over a fresh tree from an action WITHOUT a reader of its own (the diff tab, components/code/DiffTab.tsx: stage, revert,
 *  discard a hunk — `POST …/git/apply` answers with the tree) — only into an inventory that already exists: no clock starts here and no
 *  inventory arises; if nobody currently reads this scope, the next reader fetches it fresh anyway. Key as in `useGitState`. */
export function takeOverGitTree(apiBase: string, chatId: string | null | undefined, instance: string | null | undefined, tree: GitTree) {
  const b = register.get(instancePath(chatPath(apiBase, "", chatId), instance));
  if (b && Array.isArray(tree?.repos)) set(b, tree);
}
