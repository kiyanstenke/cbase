"use client";

import { useEffect, useState } from "react";
import { BrowserPane } from "@/components/BrowserPane";
import { api, subscribeGlobalEvents, type BrowserInfo } from "@/lib/api";
import { windowTarget, resolveProfile, type WindowTarget } from "@/lib/browser-choice";
import { useT } from "@/lib/i18n";

// Extra window for a browser, opened via window.open from the "Browser active" pill in the header and from the "Open in own
// window" button in the browser section of the right chat rail (both through `openBrowserWindow`, lib/browser-choice.ts).
// Sits as a full-screen overlay OVER the normal app chrome (TopNav etc. stay unused underneath); the page runs in the same
// Next export, so gateway session, theme and language carry over automatically.
//
// Three addresses (`windowTarget`):
//   ?profile=<folder>  an agent browser, chosen by PROFILE: the page reads the browser list like the rail (GET /api/browsers +
//                     "browsers" event) and shows the live session of that profile. If the agent starts a new Chromium in
//                     the next run, "closed" shows briefly, then the window attaches to the new session (on the old id it
//                     would stay at "gone").
//   ?scope=proj:<id> | ws:<id>   the scope's own browser: BrowserPane with apiBase; `/browser/ensure` returns the running
//                     session (never a second one) and starts a new one after the idle stop. On a project with `&chat=<id>`
//                     from the rail: the browser of that chat's instance (copy).
//   ?id=<session>     legacy address (an old caller).
//
// The pane has no glass surface here either (BrowserPane, form `page`); the two placeholders of this page follow it, else the
// window would switch from a card to the flat pane while loading.
export default function BrowserViewerPage() {
  const t = useT();
  const [target, setTarget] = useState<WindowTarget | null>(null);

  useEffect(() => {
    // Read from the query (static export: no useSearchParams/Suspense needed).
    setTarget(windowTarget(window.location.search));
  }, []);
  useEffect(() => {
    document.title = t("Browser — viewer");
  }, [t]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col gap-2 bg-bg p-3">
      {!target ? null : target.kind === "missing" ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-dim">
          {t("No browser specified.")}
        </div>
      ) : target.kind === "profile" ? (
        <AgentAfterProfile profile={target.profile} />
      ) : target.kind === "scope" ? (
        // With the rail's chat (`&chat=`, projects only): the window of a copy chat shows the copy, not the main one.
        <BrowserPane apiBase={target.apiBase} chatId={target.chat} active />
      ) : (
        <BrowserPane browserId={target.id} active />
      )}
    </div>
  );
}

function AgentAfterProfile({ profile }: { profile: string }) {
  const t = useT();
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const set = (list: BrowserInfo[]) => { setBrowsers(list); setLoaded(true); };
    void api<{ browsers: BrowserInfo[] }>("/api/browsers")
      .then((r) => { if (alive) set(r.browsers || []); })
      .catch(() => {});
    const off = subscribeGlobalEvents((d) => {
      if (d.type === "browsers") set((d.list as BrowserInfo[]) || []);
      else if (d.type === "init" && Array.isArray(d.browsers)) set(d.browsers as BrowserInfo[]);
    });
    return () => { alive = false; off(); };
  }, []);
  const state = resolveProfile(profile, browsers, loaded);
  if (state.kind === "agent") return <BrowserPane key={`agent:${state.browser.id}`} browserId={state.browser.id} active />;
  if (state.kind === "closed") {
    return (
      <div data-browser-closed className="flex flex-1 items-center justify-center text-[13px] text-dim">
        {t("The agent's browser is closed.")}
      </div>
    );
  }
  // Not loaded is not empty: until the list is here, neither claim "closed" nor start anything.
  return <div className="flex-1" />;
}
