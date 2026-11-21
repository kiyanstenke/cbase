"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, normGitCommitInfo, type GitCommitInfo, type GitGraphEntry } from "@/lib/api";
import { useFlat } from "@/components/CbKit";
import { dateLocale, useT } from "@/lib/i18n";
import { KIND_COLOR } from "@/lib/git-files";
import {
  CARD_GRACE_MS, CARD_COPIED_MS, CARD_DWELL_MS, CARD_WARM_MS, CARD_WAIT_MS, CARD_SWITCH_MS,
  cardsData, cardsSituation, relativeTime, fullDate, countsParts, countsText, type CardsSituation, type CountsTone,
} from "@/lib/git-card";

// The hover card of a commit in the graph of the git bar: author, relative time (with the full date), the whole message, a counts line
// ("1 file changed, 92 insertions(+), 79 deletions(-)") and the short hash with a copy button — like VS Code. Mounted by
// components/git-bar/GitGraph.tsx (`useCommitCard`: the listeners per commit row and the card itself); the enlarged dot of the hovered row is pure
// CSS (app/globals.css `.cb-git-dot`), the card changes nothing about the graph.
//
// CONTENT: person icon and author in accent color, clock and relative time, the full date with time in parentheses (lib/git-card.ts
// `relativeTime`/`fullDate`, in the UI language); the whole message (subject and body, line breaks kept, scrolls from ~40 % of the window
// height); hairline; the counts line, insertions and deletions in the colors of "A" and "D" (lib/git-files.ts KIND_COLOR), a merge says
// "against the first parent"; hairline; commit icon, short hash in accent color and a button that copies the FULL hash ("Copied" briefly).
// DATA: `POST …/git/show` with `info: true` (server git.js) through the bar's path builder, read only via `normGitCommitInfo`. Fetched
// ONCE per hash and kept (a commit never changes; no polling); an error is asked again on the next hover. An old server answers with the
// whole commit — the bar then knows it as "without info" and stops asking: the card shows what the graph knows (author, commit time,
// subject, hash) and no counts line.
//
// WHEN (the clocks in lib/git-card.ts): only after CARD_DWELL_MS of rest on a commit row — only THEN is the server asked; a fast sweep
// over the list asks nothing. If a card is open or just gone, the next row's card comes after CARD_SWITCH_MS. After dwelling, the card
// waits up to CARD_WAIT_MS for its answer (otherwise it would visibly grow), then shows what it has. On leaving it stays CARD_GRACE_MS so
// the mouse can move into it; inside the card it stays. Not during a drag (a pressed button, or the bar's stack reports `locked`: moving
// a section, dragging the splitter), not over the file rows of an expanded commit (the listeners sit on the commit row only). A press on
// the row (expand), Escape, scrolling the list and a new window size close it; after a press or Escape it returns for that row only after
// leaving. Keyboard: with visible focus (`:focus-visible`) on the row it comes after CARD_SWITCH_MS, the row then carries `aria-describedby`.
// POSITION (lib/git-card.ts `cardsSituation`): left of the bar (`[data-git-bar]`) at the height of the row, otherwise below/above, never
// outside the window. Attached to the body (portal — the bar consists of scrolling sections that would clip a card inside), `cb-kit` and
// `cb-pop` on the node.

type InfoState = { kind: "loading" } | { kind: "loaded"; value: GitCommitInfo } | { kind: "error"; text: string } | { kind: "unknown" };
type Target = { c: GitGraphEntry; anchor: HTMLElement; source: "maus" | "focus" };
type Clock = "show" | "hide" | "wait";

/** The listeners of a commit row — stable (the rows are memoized). */
export interface CardsPointer {
  enter: (c: GitGraphEntry, e: React.PointerEvent<HTMLElement>) => void;
  out: (c: GitGraphEntry) => void;
  press: (c: GitGraphEntry) => void;
  focus: (c: GitGraphEntry, e: React.FocusEvent<HTMLElement>) => void;
  focusLost: (c: GitGraphEntry, e: React.FocusEvent<HTMLElement>) => void;
}

export function useCommitCard({ path, rel, locked }: { path: (rest: string) => string; rel: string; locked: boolean }): {
  pointer: CardsPointer; active: string | null; id: string; card: React.ReactNode;
} {
  const id = `git-commit-card-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [shown, setShown] = useState<Target | null>(null);
  const [waiting, setWaiting] = useState<Target | null>(null);
  const [infos, setInfos] = useState<ReadonlyMap<string, InfoState>>(() => new Map());
  // Mirror for the listeners (stable, without the states in their dependencies).
  const situation = useRef({ shown, waiting, locked });
  situation.current = { shown, waiting, locked };
  const infosNow = useRef(new Map<string, InfoState>());
  const clocks = useRef<Record<Clock, number | null>>({ show: null, hide: null, wait: null });
  const showFor = useRef<string | null>(null);
  const quietFor = useRef<string | null>(null); // after press or Escape: this row shows again only after leaving
  const goneSince = useRef(0);
  const withoutInfo = useRef(false); // an old server: it does not know `info` — stop asking
  const alive = useRef(true);
  const cardEl = useRef<HTMLDivElement>(null);

  const stop = useCallback((...which: Clock[]) => {
    for (const k of which) { const u = clocks.current[k]; if (u !== null) { window.clearTimeout(u); clocks.current[k] = null; } }
  }, []);
  const set = useCallback((hash: string, s: InfoState) => {
    infosNow.current.set(hash, s);
    setInfos(new Map(infosNow.current));
  }, []);
  const hide = useCallback(() => {
    stop("show", "hide", "wait");
    showFor.current = null;
    if (situation.current.shown || situation.current.waiting) goneSince.current = Date.now();
    setShown(null);
    setWaiting(null);
  }, [stop]);
  // The answer for a hash is here (or its error): if its card is waiting, it comes now.
  const arrived = useCallback((hash: string) => {
    const w = situation.current.waiting;
    if (!w || w.c.hash !== hash) return;
    stop("wait", "hide");
    setWaiting(null);
    setShown(w);
  }, [stop]);
  const load = useCallback((hash: string) => {
    const present = infosNow.current.get(hash);
    if (present && present.kind !== "error") return;
    if (withoutInfo.current) { set(hash, { kind: "unknown" }); return; }
    set(hash, { kind: "loading" });
    api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: rel, hash, info: true }) })
      .then((raw) => {
        if (!alive.current) return;
        const w = normGitCommitInfo(raw, hash);
        if (!w) withoutInfo.current = true;
        set(hash, w ? { kind: "loaded", value: w } : { kind: "unknown" });
        arrived(hash);
      })
      .catch((e) => {
        if (!alive.current) return;
        set(hash, { kind: "error", text: String((e as Error).message) });
        arrived(hash);
      });
  }, [path, rel, set, arrived]);
  // After dwelling: ask (if not yet), then show — at once if the answer is already there, otherwise when it arrives, at the latest
  // after CARD_WAIT_MS with what the graph knows. An open card of another row stays until then (no flicker).
  const show = useCallback((z: Target) => {
    stop("show", "wait");
    showFor.current = null;
    load(z.c.hash);
    const st = infosNow.current.get(z.c.hash);
    if (st && st.kind !== "loading") { stop("hide"); setWaiting(null); setShown(z); return; }
    stop("hide");
    setWaiting(z);
    clocks.current.wait = window.setTimeout(() => { clocks.current.wait = null; setWaiting(null); setShown(z); }, CARD_WAIT_MS);
  }, [load, stop]);
  const plane = useCallback((z: Target, ms: number) => {
    stop("show");
    showFor.current = z.c.hash;
    clocks.current.show = window.setTimeout(() => { clocks.current.show = null; show(z); }, ms);
  }, [stop, show]);
  const laterGone = useCallback(() => {
    if (clocks.current.hide === null && (situation.current.shown || situation.current.waiting)) {
      clocks.current.hide = window.setTimeout(() => { clocks.current.hide = null; hide(); }, CARD_GRACE_MS);
    }
  }, [hide]);

  // The row listeners are STABLE (the rows are memoized) and always call the version of the last render through this mirror
  // (a new path builder — instance switch — applies at once).
  const impl = useRef({ plane, hide, laterGone });
  impl.current = { plane, hide, laterGone };
  const pointer = useRef<CardsPointer | null>(null);
  if (!pointer.current) {
    pointer.current = {
      // pointerenter AND pointermove: whoever came in with a pressed button (a drag) gets the card only after releasing and moving;
      // a wait already running for THIS row is not restarted.
      enter: (c, e) => {
        const { shown: g, waiting: w, locked: turn } = situation.current;
        if (turn || e.buttons !== 0 || quietFor.current === c.hash) return;
        if (g?.c.hash === c.hash) { stop("hide"); return; }
        if (w?.c.hash === c.hash || showFor.current === c.hash) return;
        const warm = g !== null || w !== null || Date.now() - goneSince.current < CARD_WARM_MS;
        impl.current.plane({ c, anchor: e.currentTarget, source: "maus" }, warm ? CARD_SWITCH_MS : CARD_DWELL_MS);
      },
      out: (c) => {
        if (showFor.current === c.hash) { stop("show"); showFor.current = null; }
        if (quietFor.current === c.hash) quietFor.current = null;
        // If this row was still waiting for its answer, its card no longer comes (the answer still lands in the per-hash store).
        if (situation.current.waiting?.c.hash === c.hash) { stop("wait"); setWaiting(null); }
        impl.current.laterGone();
      },
      press: (c) => { quietFor.current = c.hash; impl.current.hide(); },
      focus: (c, e) => {
        const target = e.target as HTMLElement;
        if (situation.current.locked || !target.matches?.(":focus-visible") || situation.current.shown?.c.hash === c.hash) return;
        impl.current.plane({ c, anchor: e.currentTarget, source: "focus" }, CARD_SWITCH_MS);
      },
      focusLost: (c, e) => {
        const next = e.relatedTarget as Node | null;
        if (next && (e.currentTarget.contains(next) || cardEl.current?.contains(next))) return;
        if (showFor.current === c.hash) { stop("show"); showFor.current = null; }
        const g = situation.current.shown ?? situation.current.waiting;
        if (g?.c.hash === c.hash && g.source === "focus") impl.current.hide();
      },
    };
  }

  // A drag begins (moving a section, dragging the splitter): drop the card, and nothing scheduled comes.
  useEffect(() => { if (locked) hide(); }, [locked, hide]);
  useEffect(() => () => { alive.current = false; stop("show", "hide", "wait"); }, [stop]);
  // Escape (swallowed only when a card is showing), scrolling the list (the row moves away under the card — scrolling INSIDE the
  // card does not count), new window size.
  const open = shown ?? waiting;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      quietFor.current = open.c.hash;
      hide();
    };
    const scrolled = (e: Event) => {
      const el = e.target instanceof Node ? e.target : null;
      if (el && cardEl.current?.contains(el)) return;
      if (!el || el === document || (el instanceof Element && el.contains(open.anchor))) hide();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  const card = shown && typeof document !== "undefined"
    ? createPortal(
      <Card key={shown.c.hash} id={id} target={shown} state={infos.get(shown.c.hash)} cardEl={cardEl}
        onEnter={() => stop("hide")} onOut={laterGone} />,
      document.body,
    )
    : null;
  return { pointer: pointer.current, active: shown?.c.hash ?? null, id, card };
}

function Card({ id, target, state, cardEl, onEnter, onOut }: {
  id: string; target: Target; state: InfoState | undefined; cardEl: React.RefObject<HTMLDivElement | null>; onEnter: () => void; onOut: () => void;
}) {
  const t = useT(); // tied to the language — a switch re-renders the card, dateLocale() then reads the new one
  const flat = useFlat();
  const d = cardsData(target.c, state?.kind === "loaded" ? state.value : null);
  const [situation, setSituation] = useState<CardsSituation | null>(null);
  // Measured after EVERY render (the content grows with the answer, a narrow width rewraps the lines) — set only on change.
  useLayoutEffect(() => {
    const el = cardEl.current;
    if (!el) return;
    const z = target.anchor.getBoundingClientRect();
    const l = (target.anchor.closest("[data-git-bar]") ?? target.anchor).getBoundingClientRect();
    const n = cardsSituation(z, l, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    setSituation((v) => (v && v.left === n.left && v.top === n.top && v.width === n.width && v.maxHeight === n.maxHeight && v.page === n.page ? v : n));
  });
  const now = Date.now();
  const locale = dateLocale();
  let counts: React.ReactNode = null;
  if (state?.kind === "loading") counts = <span className="text-dim">{t("Loading…##inline")}</span>;
  else if (state?.kind === "error") counts = <span className="block truncate text-danger" title={state.text}>{state.text}</span>;
  else if (d.countsClipped) counts = <span className="text-dim">{t("Too many changes to count.")}</span>;
  else if (d.counts) {
    const parts = countsParts(d.counts);
    const emptyMerge = d.merge && d.counts.files === 0;
    counts = (
      <span title={countsText(parts, t)} data-git-commit-card-counts={`${d.counts.files}/${d.counts.plus}/${d.counts.minus}/${d.counts.binary}`}>
        {emptyMerge ? t("No changes against the first parent.") : parts.map((x) => (
          <span key={x.tone}>{x.before}<span className={`whitespace-nowrap ${TONE[x.tone]}`}>{t(x.key, { n: x.n })}</span></span>
        ))}
        {/* Wraps as a whole, never mid-sentence (a "first / parent" split seen in the visual check). */}
        {d.merge && !emptyMerge && <span className="text-dim"> <span className="whitespace-nowrap">· {t("against the first parent")}</span></span>}
      </span>
    );
  }
  return (
    <div ref={cardEl} id={id} role="tooltip" data-git-commit-card={d.short} data-git-commit-card-page={situation?.page ?? ""}
      data-git-commit-card-status={state?.kind ?? "without"} onPointerEnter={onEnter} onPointerLeave={onOut}
      style={situation ? { left: situation.left, top: situation.top, maxWidth: Math.min(420, situation.width), maxHeight: situation.maxHeight } : { left: 0, top: 0, visibility: "hidden" }}
      className={`cb-pop cb-fade-in-fast cb-kit fixed z-50 flex w-max min-w-[min(340px,calc(100vw-16px))] max-w-[420px] flex-col overflow-hidden rounded-xl text-[12.5px] leading-snug text-fg${flat}`}>
      <div className="flex min-h-0 flex-col gap-2 px-3 pb-2.5 pt-2.5">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[12px]">
          <span className="shrink-0 text-dim"><PersonIcon /></span>
          {/* The comma sticks to the name (like VS Code "Lea Berg, 🕐 …") — as its own flex child it would get the gap before it. */}
          <span className="min-w-0">
            <span className="font-semibold text-accent" title={d.email ?? undefined} data-git-commit-card-author>{d.author || t("unknown")}</span>
            {d.time !== null && <span className="text-dim">,</span>}
          </span>
          {d.time !== null && (
            <>
              <span className="ml-0.5 shrink-0 text-dim"><ClockIcon /></span>
              <span data-git-commit-card-time={d.time}>{relativeTime(d.time, now, locale)}</span>
              <span className="text-dim">({fullDate(d.time, locale)})</span>
            </>
          )}
        </div>
        <div className="cb-scroll min-h-0 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]" style={{ maxHeight: "min(40vh, 320px)" }}
          data-git-commit-card-message>{d.message || "—"}</div>
        {d.messageClipped && <div className="text-[11.5px] text-dim">{t("The message is longer — shortened here.")}</div>}
      </div>
      {counts && <div className="border-t border-edge px-3 py-2 text-[12px]">{counts}</div>}
      <div className="flex items-center gap-1.5 border-t border-edge py-1.5 pl-3 pr-1.5">
        <span className="shrink-0 text-dim"><CommitIcon /></span>
        <span className="font-mono text-[12px] text-accent" title={d.hash} data-git-commit-card-hash={d.hash}>{d.short}</span>
        <CopyButton hash={d.hash} />
      </div>
    </div>
  );
}

// Insertions like "A", deletions like "D" (the same color roles, lib/git-files.ts) — the files themselves without color.
const TONE: Record<CountsTone, string> = { files: "", binary: "text-dim", plus: KIND_COLOR.added, minus: KIND_COLOR.deleted };

// Copy the FULL hash (like VS Code "Copy Commit ID"), "Copied" briefly on the button. Without the clipboard API (insecure origin)
// via an invisible text field; if both fail, the button says "Not copied".
function CopyButton({ hash }: { hash: string }) {
  const t = useT();
  const [status, setStatus] = useState<"yes" | "no" | null>(null);
  const clock = useRef<number | null>(null);
  useEffect(() => () => { if (clock.current !== null) window.clearTimeout(clock.current); }, []);
  const copy = async () => {
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(hash); ok = true; } } catch { /* the second way is below */ }
    if (!ok) {
      const field = document.createElement("textarea");
      field.value = hash;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      field.remove();
    }
    setStatus(ok ? "yes" : "no");
    if (clock.current !== null) window.clearTimeout(clock.current);
    clock.current = window.setTimeout(() => { clock.current = null; setStatus(null); }, CARD_COPIED_MS);
  };
  const label = status === "yes" ? t("Copied") : status === "no" ? t("Not copied") : t("Copy hash");
  return (
    <button type="button" onClick={copy} title={label} aria-label={label} data-git-commit-card-copy={status ?? ""}
      className={`flex h-6 min-w-6 items-center justify-center gap-1 rounded-md px-1 text-[11.5px] transition-colors hover:bg-hover ${status === "yes" ? "text-ok" : status === "no" ? "text-danger" : "text-dim hover:text-fg"}`}>
      {status === "yes" ? <CheckMarkIcon /> : <CopyIcon />}
      {status && <span aria-live="polite">{label}</span>}
    </button>
  );
}

// ── Icons (24 viewBox, stroke 1.9 — like GitGraph.tsx) ──────────────────────────────────────────────────────────────────────────
const svg = (children: React.ReactNode, size = 13) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>);
const PersonIcon = () => svg(<><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.9-3.6 3.7-5.6 7-5.6s6.1 2 7 5.6" /></>);
const ClockIcon = () => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
// The commit like the codicon "git-commit": a ring on a horizontal line.
const CommitIcon = () => svg(<><circle cx="12" cy="12" r="3.6" /><path d="M2.5 12h5.9M15.6 12h5.9" /></>);
const CopyIcon = () => svg(<><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>);
const CheckMarkIcon = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);
