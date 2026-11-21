"use client";

// The active scope of the header.
//
// The state pills show on EVERY page, not only in Coding. The TopNav therefore needs an answer to
// "which workspace, which project?" that no page hands it via a portal. The answer is the remembered
// workspace (`cbase-ws`, the same key as Coding and Skills) plus the project that Coding has just
// entered.
//
// Why a store with subscribers and not a peek into localStorage: a workspace switch in the same tab
// must reach the header AT ONCE, and localStorage reports it to nobody — so EVERY write of
// `cbase-ws` goes through this file (guard: `web/test/statusBar.test.mjs`, no
// `localStorage.setItem("cbase-ws"` outside this file).
//
// The scope belongs to the TAB and the page it shows. Two things sit side by side here, and only
// one of them is live:
//  · the LIVE scope (`state`) — what the open page of this tab shows. Only the page itself moves it
//    (`rememberWorkspace`, `useDisplayedWorkspace`, `setScopeProject`).
//  · the remembered START value (`localStorage["cbase-ws"]`) — what the NEXT page build begins with.
//    It is taken over once on first read and never consulted again.
// There is therefore NO `storage` listener. A first version had one: when tab B chose another
// workspace, the pill in tab A jumped along while page A stayed on the old one — right numbers for
// the wrong place, exactly the error `useDisplayedWorkspace` is built against. No page follows the
// event, and a reload in A wrote its own workspace back, whereupon B jumped (ping-pong). For the same
// reason a choice that does NOT mean the page (the agent dock's workspace) writes only the start
// value: `rememberStartWorkspace` notifies nobody.
//
// "Empty is not unknown": `loaded` is true only AFTER localStorage was read. Before that (server
// render, hydration) `workspaceId: null` means "not looked up yet", and the pill renders nothing —
// otherwise "0 services" would flash up, a claim without a measurement.

import { useEffect, useSyncExternalStore } from "react";

export type ActiveScope = { workspaceId: string | null; projectId: string | null; loaded: boolean };

export const WS_KEY = "cbase-ws";

const BEFORE_THE_LOAD: ActiveScope = { workspaceId: null, projectId: null, loaded: false };
let state: ActiveScope = BEFORE_THE_LOAD;
const listeners = new Set<() => void>();

function set(next: ActiveScope) {
  if (next.workspaceId === state.workspaceId && next.projectId === state.projectId && next.loaded === state.loaded) return;
  state = next;
  for (const h of listeners) h();
}

function readRemembered(): string | null {
  try { return localStorage.getItem(WS_KEY) || null; } catch { return null; }
}

// Once on the client: read the remembered workspace. Idempotent — every way in calls it.
function initialize() {
  if (state.loaded || typeof window === "undefined") return;
  state = { workspaceId: readRemembered(), projectId: state.projectId, loaded: true };
}

/**
 * Remember the active workspace: writes `localStorage["cbase-ws"]` AND notifies the header. ONLY for
 * the workspace the open page SHOWS. An empty call changes nothing (a missing value is no
 * statement). Never throws — without storage (private window) the switch still holds for this tab.
 */
export function rememberWorkspace(id: string | null | undefined) {
  if (!id) return;
  rememberStartWorkspace(id);
  initialize();
  set({ workspaceId: id, projectId: id === state.workspaceId ? state.projectId : null, loaded: true });
}

/**
 * Remember only the START value for the next page build — the header learns nothing, and that is the
 * point: for a choice that does not mean the open page (the agent dock's workspace picks what the
 * PANEL shows). Going through `rememberWorkspace` would push the pill to a workspace that the page
 * beside it does not show, and on switching back would discard the entered project.
 * Guard: `web/test/statusBar.test.mjs` ("scope per tab").
 */
export function rememberStartWorkspace(id: string | null | undefined) {
  if (!id) return;
  try { localStorage.setItem(WS_KEY, id); } catch { /* no storage — then just no start value */ }
}

/**
 * Publish the entered project (only Coding knows one). `null` means "whole workspace" — the Coding
 * page sets it on leaving, otherwise the header would keep filtering on other pages by a project
 * nobody sees there.
 */
export function setScopeProject(id: string | null) {
  initialize();
  set({ ...state, projectId: id || null });
}

/**
 * A page SHOWS this workspace — then it also applies to the header.
 *
 * If the workspace comes about in another way than a CHOICE in the rail — deep link
 * (`/todos/?workspaceId=…` and the board address from the bell and the runs list) or the fallback to
 * the first workspace because the remembered one is deleted — the page would show one workspace and
 * the services pill beside it another: right numbers for the wrong place.
 *
 * "Once it is settled" means: the list is loaded AND contains it. An unknown id from the address bar
 * is not remembered (the page does not show it either), and before the load (`list` empty or `null`)
 * nothing is decided — "empty is not unknown". If the id is already the remembered workspace, the
 * call changes nothing (no overwriting a choice by merely opening).
 * Guard: `web/test/statusBar.test.mjs` ("displayed workspace").
 */
export function useDisplayedWorkspace(id: string | null | undefined, list: readonly { id: string }[] | null | undefined) {
  useEffect(() => {
    if (id && list?.some((w) => w.id === id)) rememberWorkspace(id);
  }, [id, list]);
}

/** The current state without a subscription (for handlers). */
export function readActiveScope(): ActiveScope {
  initialize();
  return state;
}

function subscribe(h: () => void) {
  initialize();
  listeners.add(h);
  return () => { listeners.delete(h); };
}

/**
 * The active scope as a hook. The server snapshot is "not loaded yet" (as is the prerendered HTML);
 * after hydration the read value takes over — React re-checks the snapshot after subscribing and
 * then renders with `loaded: true`.
 */
export function useActiveScope(): ActiveScope {
  return useSyncExternalStore(subscribe, () => state, () => BEFORE_THE_LOAD);
}

// Jump from the services pill to the Apps page with a selected project (browser path). The page
// reads `?project=` on build; if it is already open, Next does not necessarily rebuild it for a new
// query — then this event carries the choice over.
export const APPS_PROJECT_EVENT = "cbase-apps-project";
export const appsProjectHref = (projectId: string) => `/apps/?project=${encodeURIComponent(projectId)}`;

/**
 * Hand the jump to an ALREADY OPEN Apps page. `true` means: it took it over (its listener calls
 * `preventDefault()`), and the pill's link must then NOT navigate any more. Measured in a real
 * Chrome against web/out: Next calls the link's `onClick` first and navigates AFTER, in a
 * transition — a `replaceState` with which the open page removed `?project=` from the address in the
 * listener was overwritten by the later push. The address then carried `?project=<id>`, and ⌘R chose
 * that project against the later manual choice. Without an open page nobody listens, the event stays
 * unprevented, and the link navigates as usual (the page then reads `?project=` on build and cleans
 * the address itself).
 */
export function handOverAppsJump(projectId: string): boolean {
  if (typeof window === "undefined" || !projectId) return false;
  return !window.dispatchEvent(new CustomEvent(APPS_PROJECT_EVENT, { detail: projectId, cancelable: true }));
}
