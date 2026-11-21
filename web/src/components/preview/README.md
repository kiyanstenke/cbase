# `components/preview/` — preview links in the UI

A preview link makes ONE service of an instance publicly reachable through the user's own ngrok account, for showing and
testing with third parties, like an ngrok tunnel. Only a human creates one (no MCP tool).

| File | What |
|---|---|
| `usePreviewLinks.ts` | The state (`PreviewStatus`): ONE fetch when it becomes active, then the SSE event `preview/link` (`withLink`); refetched only on a cause — the window event `NGROK_ACCESS_CHANGED` from settings, or `loadAgain()`. No polling loop. `state === null` = no answer yet |
| `PreviewShare.tsx` | `PreviewButton` (icon in the service row) and `PreviewArea` (below it: the active link with address, remaining time, copy, revoke — or, unfolded, the menu with the visibility sentences and ONE row below: the duration as kit `Segments` "Days 1 · 7 · 30 · ∞" (only the number in the segment, the full word in the title; spelled-out durations overflowed the 340 px pill), 7 preselected, and "Create" on the right; without access a jump to Settings → Integrations; with `instanceStopped` a hollow dot and "Instance stopped", since visitors then see a 502) |

Used by `components/pills/ServicesPill.tsx` (both service lists of the ports menu), `components/projects/InstancesPage.tsx`
(service row per instance) and `components/settings/NgrokSettings.tsx` (ngrok section under Integrations: access, mode as a
sentence, active links, history). The server calls live in `lib/api/preview.ts`; the computations (merging, location, instance of
a row, remaining time, `linkInTree` for the Instances tab: the tree is the source, the state adds to it) in `lib/preview-links.ts`,
bound in `web/test/preview-links.test.mjs`; to the server (`contract.js`) and iOS in `web/test/preview-binding.test.mjs`
(the seam lists) and `web/test/preview-rules-binding.test.mjs` (remaining time, assignment, limit; needs `xcrun swift`, macOS only).

At the plan limit the menu lists the active links (project · service · address) with "Revoke"; creating closes only the OWN menu,
and an error from create/revoke goes up through `onNotice` to the pill, which holds it until the ports menu has shown it — with
the menu closed, a red dot sits on the trigger.

**Three typical questions**

- *Why does the menu unfold in the row instead of floating as its own `cb-pop`?* The ports menu scrolls (`overflow-y-auto`) and
  would clip an absolutely positioned child; a portal on the body would sit outside `[data-status-ports-pop]`, and the pill's
  click catcher would close everything on every click inside it (`PreviewShare.tsx`, header).
- *Which instance does a row send?* In the picker the chosen id, otherwise the main instance from `/api/projects`
  (`lib/preview-links.ts:serviceTargetInstance`). Before the answer it is `undefined` and "Create link" is disabled — a guessed
  `null` would be a 400 for a relocated project.
- *How does the pill learn that a link expired?* From the server's SSE event (expiry tick every minute); the remaining time is
  computed by `remainingTime(runningSinceAt, now)` on every render, "expired" shows until the server ends the link.

**Not here:** the access values (they only go out, `setNgrokAccess`; truth values come back), the ngrok session and the target in
the project container (backend `server/backend/electron/server/preview/`), iOS (`Shell/ServicesButton.swift`,
`Settings/IntegrationsSettings.swift`).
