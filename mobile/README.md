# cbase Mobile

Native SwiftUI app for iPhone and iPad. On first start the API base is entered (as in the desktop client) and stored locally.
The app uses the same gateway login and the same chat/workspace APIs as the desktop client. There is no hard-coded server
address and no credentials in the project.

## Shell

- **Header** — workspace or `Workspace › Project` as a picker (enter and switch projects) and the usage rings for Claude and
  Codex once the server delivers values (`ProviderMark`; the active provider is opaque, the other half transparent).
- **No bottom bar** — the content reaches the bottom edge. The places `Coding`, `Apps` and `Profile` sit at the top of the right drawer
  (`Shell/AppShell.swift`).
- **Swipe left** — right drawer: the places first, then all areas of the workspace (chats, agents, skills, projects, MCP, context, credentials, code,
  terminal, browser). Bell, appearance and settings stick to the bottom edge, the rest scrolls.
- **Swipe right** — left drawer, depending on the area (chat list, file tree, git, context pages, terminals, tabs, projects/ports).
  `App agents` sticks to the bottom.

Answers are drawn as complete Markdown (`Kit/Markdown.swift`); its scope deliberately matches `web/src/components/Markdown.tsx`.
Entering a workspace shows the overview of the latest chats, not an empty chat. A chat loads its history with a loading animation and
starts at the newest message.

The UI is German or English; the English UI string is the dictionary key and `Kit/LocDE*.swift` supplies the German translation
(`L("…")`). `bash tools/loc-audit.sh --all` finds every `L("…")` key used in code without a German entry.

## The chat stage

The chat family lives in `CbaseMobile/Chat/` (read its README before touching it: a second rebuild of the stage repeats every
keyboard bug). The load-bearing decisions:

### The history is built mirrored

The timeline is ONE inverted UIKit collection (`ChatTimelineStage.swift`): collection and cell contents are each flipped once, so
on screen it reads normally, but "the end" is offset 0. Scrolling to a content edge in a normal list needs the total height, which a
lazily built list can only estimate; every correction to the estimated edge builds other rows and produces the next estimate — a
feedback loop that made the history jump when the keyboard opened and sometimes ended behind the content. Offset 0 needs no
estimate. Consequences: the composer sits INSIDE the arrangement (no `safeAreaInset`); short histories are kept at the top
instead of sticking to the composer; the empty-chat hint lies outside the list; the stack order is read upside down.

Copying in a mirrored history: a `contextMenu` on a message inherits the mirror, so the chat view registers a copy action through
the environment (`chatMessageAction`) that appears OUTSIDE the list, and text selection is off there (`chatTextSelectable`).

### The composer sticks to the keyboard edge

The composer is a real hosting controller pinned by ONE constraint, `composer.bottom == keyboardLayoutGuide.top`
(`ChatStageController.attachComposer`): UIKit moves it in the SAME layout transaction as the keyboard — with an animated
open/close inside the same Core Animation animation, with interactive dragging in the same layout pass as the finger. Earlier
designs that read the displayed edge per frame and wrote SwiftUI state were always at least a frame behind.

- The chat follows the keyboard ITSELF; SwiftUI's automatic avoidance is switched off at the root (`chatManagesKeyboard` in
  `Shell/AppShell.swift`) because it arrives in one step and costs the list its built rows. The chat therefore has no
  `ignoresSafeArea(.keyboard)` of its own — a second release below the one at the root detaches the chat from the layout.
- `syncKeyboardOverlap` translates the edge of an invisible follower view (`KeyboardFollowerView`, pinned to the guide) into the
  constant of the composer constraint. With a finger on a drag surface the edge of the keyboard grip accessory is measured
  directly; without a finger the last ANNOUNCED edge (`keyboardWillChangeFrame`) wins, because announced animations run outside
  the process and guide/accessory models freeze meanwhile.
- The announcement is per PROCESS, not per stage (`KeyboardAnnouncement`): opening another chat with an open keyboard closes it
  without animation and leaves the root guide at the grip's height; a fresh stage without its own announcement would lift the
  composer by that much. The shell (outside a chat) follows the announcement as well.
- With a chat in front, the spacer strip at the bottom (home-indicator height, the value remembered from the window) STAYS while the
  keyboard is up; if it vanished or shrank, the chat's bottom edge would move mid-animation. Outside a chat the same strip is the
  shell's keyboard evasion, as high as the announced keyboard.
- A trap that cost hours: **an assignment made in the middle of SwiftUI's own pass is lost** — the body is evaluated once more with the
  OLD value and never again; a check against the model never notices because the model is right.

Guards: `ChatStageUITests/testComposerGapAboveKeyboardIsScrollIndependentAgainstFixture`,
`testTimelineStaysPutWhenKeyboardOpensAgainstFixture`, `testComposerSitsAfterChatSwitchWithOpenKeyboardBottom`.

### A new row PUSHES the history, it does not shove it

A sent message used to appear in place while the history above jumped by its row height. Now the history is pushed up as ONE block
and the new row emerges from behind the composer island (`regularMaterial`, so the bubble shows as a soft blur on its way).
`Coordinator.pushUp` has two steps whose order is the point:

1. The new rows enter the list at once, without animation, and the scroll offset is carried along by exactly their height (fixed
   point: the row that was lowest before). Nothing moves on screen.
2. Then the offset glides back to rest with the self-timed `SettleSpring` (critically damped, about 0.35 s). It starts at velocity 0
   and computes with the really elapsed time, its step capped at one frame (`maxStep`). An animated diff in a `UIView.animate`
   block does not work: its animation starts in the pass in which the list still BUILDS the new cells (tens of ms without a frame),
   so the first drawn frame already sits mid-curve and ease-out starts at its HIGHEST speed — the history jumped.

Several pushes in quick succession (own row with run indicator, first tool call, answer) re-pin the visible row and add their height
to the open distance of the RUNNING spring (velocity carried over): two jerks become one motion. While the spring runs it owns the
offset, so three places must stay out (they would read it as "the reader scrolled up"): the jump arrow (`updateAway`), the ride to
the end (`scrollToLatest`) and the clamp in `collectionDidLayout`. The finger always wins (`scrollViewWillBeginDragging` cancels).
Preconditions: only rows are added (nothing removed or re-sorted), at most four at once, the reader is at the end (or a push is
running), and the history fills the window; a short history only fades in. A reader scrolled up notices nothing.

**The own message shows at once** (optimistic, `ChatViewModel.echoUserMessage`): bubble and run indicator appear in the same pass,
hence in ONE push. The SSE echo is reconciled, not appended (`claimEcho` over the displayed text, FIFO). No echo while a turn is
already running (the server queues the message; it belongs in the queue strip), none at a workflow start, none if the POST fails
(the text goes back into the composer); a reply of `queued`/`injected` removes the bubble again. A fully loaded history is the
truth: `applyTimeline` drops every pending echo.

Guard: `testSentMessageRidesIntoTheTimelineInsteadOfPopping`, over a frame-by-frame trace of the app (`ChatEntranceTrace`, DEBUG only,
path in `CBASE_ENTRANCE_TRACE`). Measure the SCREEN position (not the cell frame), re-find the tracked row by its identifier each
frame (cells are recycled), and apply the threshold PER push, not over the sum.

### Smaller chat rules

- **The run indicator is a line, not a card:** hexagon that rotates while the run is open (the rotation hangs on a `@State` flipped
  once in `onAppear`, never on a value that changes during the run — it would reset every second), no horizontal inset, vertical
  padding of 10 pt like the user bubble. Without a surface its accessibility frame is the union of its text lines; compare gaps TEXT to
  TEXT.
- **Wait phase:** when a turn ends with background work open the server sends `run_waiting`; reasons in rank order: `monitors`,
  `agents`, `tasks`, `wakeupAt`; followed by "you can keep writing". The indicator hangs on `busy && !streamingText`, so
  `run_waiting` resets `streamingText`.
- **Running agents above the composer** count foreground subagents (tool block without result) AND background agents. The latter
  come from the `background` event (their tool block is acknowledged at once); the wait phase does not count them twice. `connected`
  carries both lists plus `contextTokens`.
- **Parked at a usage limit:** `ChatLimitStrip` above the workflow strip (window name, resume time, live countdown, "Try now",
  "Cancel"); state from `GET /api/chats/:id/auto-continue`, updated by `limit_wait`, accepted only FORWARD (`updatedAt`); payloads
  arrive nested (`line`). Log rows `chat-limit-line-<kind>`: `resume`, `retry`, `gate-free`. A message to a PARKED chat answers
  `queued` + `parked: true` — no turn runs, so the app takes `busy` back.
- **Ask card (`cbase_ask`):** options plus a free field; a single choice needs no confirm. State comes from the history
  (`role='ask'`/`'ask_answer'`); a card is tappable only while unanswered AND no user message followed (the server computes the same
  rule).
- **Agent task list:** the Claude CLI keeps its list through `TaskCreate`/`TaskUpdate`; `nativeTaskList` derives the state from the
  sequence of ALL calls. It is shown in a fixed bar above the composer (`NativeTaskBar`), open items only, done as a count.
  `NativeTask.id` must be the CLI's id, not a fresh `UUID()` (SwiftUI would replace every row on ticking).
- **Workflows:** start through `/workflow:<short name>` in the slash picker; a running one shows `ChatWorkflowStrip` ("step x/y",
  skip, cancel) and every driver decision as its own history row. `WorkflowsPane` opens the editor full screen; interaction differs
  from desktop on purpose: press and hold, then drag to move (picking up disables scrolling); tap the output dot, then the target
  step to connect; plain scrolling moves the canvas (a `ScrollView` with BOTH axes, wider than the screen, so the drawer's swipe
  recognizer leaves it alone); pinch or buttons zoom; edges are deleted in a step's sheet.
- **Git in the chat:** a branch icon with the open-change count in the chat header opens the git view as a half-height sheet when the
  chat's project has a repository. A view that renders NOTHING gets no lifecycle calls from SwiftUI, so an empty surface stands
  there. A failed fetch is not "no repository" (`loaded` / `error` / really none are kept apart).
- **Chat list:** overview and left drawer show the same list and state (`AppState.chatSearch/chatSort`, `ChatFilterBar`); pinned
  chats stay on top; sorting persists, search does not. In an entered project ONLY its chats and folders show
  (`AppState.visibleChats`/`visibleFolders`, depends on `enteredProject` alone). Chat folders only group — nothing is created on
  disk; a folder belongs to a workspace and optionally ONE project; chats of ONE folder read each other's artifacts
  (`cbase_artifacts_list` / `_read`), write and delete only their own.
- **Artifacts:** the three-dot menu of a chat opens its persistent files (text and images natively, all types via the share sheet).

### Gestures

- **Swiping triggers no buttons:** tap-like recognizers must wait until the swipe recognizer failed (`shouldBeRequiredToFailBy`),
  and competing recognizers under the finger are briefly disabled on takeover. `cancelsTouchesInView` does not affect gesture
  recognizers; the wait rule must not include drag, PINCH or rotate (browser zoom).
- **Sideways scrolling beats the drawer** (wide Markdown table, long code block, zoomed browser); at the edge of the surface the
  drawer may take over. **A sheet beats the drawer:** with a sheet presented (`rootViewController.presentedViewController`) the
  recognizer stays still; full-screen overlays switch it off through `enabled`.
- **Swiping and scrolling exclude each other:** at touch-down the recognizer remembers the innermost scroll view with its offset and
  freezes it once it takes the swipe.

### Terminal, code, browser

- **Terminal:** the output scrolls only vertically and starts at the top; the character grid is computed from the real window size
  and reported to the PTY (`resize`), remembered only once the PTY exists.
- **Code tab:** press and hold on a tree row offers download (file) or ZIP (folder). The file goes to a temporary directory, then to
  the system share sheet; the name comes from `Content-Disposition` (`filename*`). Downloads use `URLSession.download` with a
  600 s limit (the server walks the whole tree before the first byte). Upload goes into the chosen folder (context menu) or the root
  (button above the tree), also without a project; photos arrive as bytes in ~3 MB chunks. Images preview (fit only downward, pinch up
  to 8×, double tap resets, checkerboard shows transparency); SVG stays text.
- **`PhotosPicker` does not belong in a `Menu` or `contextMenu`** (SwiftUI does not present it there): the entry sets a flag and the
  sheet hangs on the view below via `.photosPicker(isPresented:)`.
- **Browser desktop view:** a toggle asks the server for a desktop window (1280 CSS px wide); in portrait the image is tipped 90°.
  The canvas is a `UIScrollView` (pinch to 6×); a tap is measured IN the image and divided only by the fit factor, so zoom and
  rotation drop out.

### Accessibility identifiers

An identifier on a container makes it ONE accessibility element and replaces the identifiers of its child buttons: put the
identifier on the text or the button, or add `.accessibilityElement(children: .contain)`. A SwiftUI canvas inside a `ScrollView` is
not an `otherElements` hit — tests check the editor through its toolbar.

## Scope

Gateway login and session restore, server switch, administration for admins; workspaces, projects, chat list (create, rename, pin,
move, fork, delete); Claude, Codex and configured third-party providers with model/profile/permission/effort/browser settings; the live
SSE stream with reasoning, tool calls, diffs, monitors, subagents, permission prompts, goals and context compaction; queueing messages
during a run; attachments and `@` file references; workflows (canvas, start, progress); the code tab (editor, search, git, TypeScript
problems, Node debugger, upload/download); terminals and the streamed browser including watching agent browsers; context dumpster,
memory, credentials, MCP servers and catalog; settings as on the desktop.

Deliberately not taken over: the desktop's folder picker (`/api/pick-folder`; the server creates the workspace folder itself), the
desktop's port forwarding, TypeScript IntelliSense and the DevTools drawer of the code tab.

## Open and build

All commands from `mobile/`:

```sh
open CbaseMobile.xcodeproj

xcodebuild -project CbaseMobile.xcodeproj -scheme CbaseMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

New Swift files need NO registration: `CbaseMobile/` and `CbaseMobileUITests/` are synchronized root groups
(`PBXFileSystemSynchronizedRootGroup`), so every file in them and their subfolders is a target member. `Info.plist` is listed per
folder as an exception (`membershipExceptions`) — otherwise the build fails with "Multiple commands produce …/Info.plist" — and
the `README.md` of each subfolder MUST also be a `membershipExceptions` line, or it lands in the app as a resource.

The seven folders follow the place where the user OPENS a view; each has a `README.md` with a file table and the most common questions:

| Folder | Place in the app | What lives there |
|---|---|---|
| `Shell/` | the shell | `CbaseMobileApp`, `RootView`, `AppShell` (stays ONE file), drawers, `CategoryContent`, the Apps/Profile tabs, push |
| `Chat/` | Coding → Chats | the whole chat family: `ChatView`, the stage, composer, markers, cards, `ChatViewModel` + its `+<Topic>` extensions, channels, approval card |
| `Workflows/` | Coding → Workflows | `WorkflowsPane`, `WorkflowCanvasEditor`, `WorkflowSurface`, `WorkflowGeometry`, the dynamic-workflow library |
| `Code/` | Coding, other categories | code, git, debug, terminal, browser, projects, MCP, context, credentials, agents, scheduled, overview |
| `Settings/` | settings | `SettingsView` (the list) + one file per page |
| `Models/` | data layer | models per topic, `AppState`, `APIClient`, `SessionStore`, `UsageStore`, `JSONValue`, `DecodeHelpers` |
| `Kit/` | building blocks | `Localization` + `LocDE*`, `CbKit`, `SharedUI`, `Markdown`, `Theme`, `ChatFont`, `EffortSelection`, … |

## Distribution

- **Daily device build:** `CBASE_DEVICE_UDID=<udid> CBASE_DEVELOPMENT_TEAM=<team> ./refresh-on-iphone.command` (list devices with
  `xcrun devicectl list devices`; the script aborts without the UDID) — Xcode signs, installs over the existing app and starts it without erasing
  local app data (the stored API base stays).
- **TestFlight:** create an app with bundle ID `dev.cbase.mobile` in App Store Connect once, then `./deploy-testflight.command`
  (release archive, App Store Connect manages the build number, upload). Needs the paid team visible in Xcode and the agreements
  accepted.
- **Physical iPhone from Xcode:** connect, unlock, trust the Mac, enable Developer Mode, select the team under Signing &
  Capabilities, run. Without a signed-in Apple account a device build cannot be signed or get APNs.
- **Signing team:** the project file carries no team (it names your Apple account). The scripts take it from
  `CBASE_DEVELOPMENT_TEAM`; `node tools/deploy/deploy.mjs mobile` sets it from `deploy.local.json` →
  `"mobile": {"team": "<team id>"}`. The id is the `OU` of your "Apple Development" certificate.
- **Sideloading (SideStore & co.):** `bash make-ipa.command` → `~/Desktop/cbase.ipa` (Release, arm64; `CBASE_IPA_CONFIG=Debug` for
  Debug). Release on purpose: a Debug build puts the code in `cbase.debug.dylib` next to a tiny start binary that the sideloader
  would have to carry along. The script checks `Payload/` at the root, the binary, `arm64` and no debug dylib. Delete the app installed
  by Xcode first (iOS refuses another signing profile over it; the stored server address is gone too). "Refresh" in SideStore renews
  only the certificate, not the code: build a new IPA after every code change. A free Apple account allows seven days and three
  sideloaded apps.

### Native notifications (APNs)

The target carries the push capability. After gateway login the app asks for permission, registers its current APNs token with the
gateway and removes the installation on logout or server switch; a tap leads to the reported chat by workspace/project/chat in the
payload. APNs is configured only in the gateway (`GW_APNS_TEAM_ID`, `GW_APNS_TOPIC=dev.cbase.mobile`, `GW_APNS_KEY_ID`,
`GW_APNS_KEY_PATH`; sandbox/production overrides in `server/README.md`); the private key never goes into a user container or the
repository.

## Testing

`CbaseMobileUITests/CbaseUITestBase.swift` carries the helpers, fixture ids, `launchApp` and `setUpWithError`;
`CbaseMobileUITests/Tests/<Place>UITests.swift` is one class per place (map in `CbaseMobileUITests/Tests/README.md`); only the live
sweep stays in the class `CbaseMobileUITests`. **Identifiers are `CbaseMobileUITests/<Class>/<test>`** — an `-only-testing` on an old
path reports SUCCEEDED with zero tests; look up with `-enumerate-tests -test-enumeration-style flat`.

**The full run** is plain `xcodebuild` against the fixture gateway (from the repository root; `-destination` takes any
booted iOS simulator):

```sh
node mobile/test-fixtures/chat-gateway.mjs 17718 &   # the fixture gateway; port 17718 must be free
X="xcodebuild -project mobile/CbaseMobile.xcodeproj -scheme CbaseMobile -destination id=<simulator-udid> -derivedDataPath /tmp/CbaseMobile-UITests"
$X build-for-testing
$X test-without-building -only-testing:CbaseMobileUITests/AAAWarmupUITests
$X test-without-building -skip-testing:CbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway
```

Before the run delete the persistent composer drafts (see below), and run the warm-up test (`AAAWarmupUITests`, software keyboard)
alone first. Afterwards hold `Executed N tests` against the expectation from `$X -enumerate-tests -test-enumeration-style flat` minus
the live sweep — a deviation is a finding even on SUCCEEDED. A single test: `$X test-without-building
-only-testing:CbaseMobileUITests/<Class>/<test>` (repeat it five times for a proof). Stop the fixture at the end.

- **Skipped tests do not count as green.** `requireFixture()` throws `XCTSkip`; if the fixture dies after the start every test skips
  and xcodebuild still says SUCCEEDED. Only the diagnostic skips of the baseline are allowed; with `-only-testing`, no skip of an
  EXPLICITLY named test counts. The expectation is no constant: `-enumerate-tests` minus the live sweep.
- **Drafts live in the app's data container**, not in the simulator's user domain: `xcrun simctl get_app_container <udid>
  dev.cbase.mobile data`, then `Library/Preferences/dev.cbase.mobile.plist`; `defaults delete dev.cbase.mobile` hits another file.
  The path changes with every reinstall.
- **Run on a quiet machine.** A foreign build or dev server on the same Mac slows the simulator enough to turn timing-sensitive
  tests red; repeat a red run once the machine is free before reading it as a finding.
- The baseline of a full run is ZERO red. A red test is a finding: run it alone five times, read the message, run the counter-test.

**Fixture tests by hand** (deterministic, no real server). Start the fixture gateway first or the tests skip — and check
`lsof -iTCP:17718`, `uptime` and `open -a Simulator` beforehand, which is exactly what the tool does not leave out:

```sh
node test-fixtures/chat-gateway.mjs &      # listens on 127.0.0.1:17718; state, seed and routers live in test-fixtures/chat-gateway/

xcodebuild -project CbaseMobile.xcodeproj -scheme CbaseMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -skip-testing:CbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway \
  test
```

The fixture gateway also plays terminal (`/fixture/terminal` reports the announced columns and rows), browser (SSE with self-built PNG
frames; `/fixture/browser` reports window size, clicks and wheel moves), the code tab (`/files/tree|read|download`, `/upload`;
`GET /fixture/download` and `/fixture/upload` report the last request, `POST` resets), and switches that consume themselves on the
NEXT run: `POST /fixture/subagent {open:true}`, `/fixture/waiting-agent {open:true, kind:"agent"|"task"|"wakeup"}`,
`/fixture/background-agent {open:true}`, `/fixture/ask {open:true}` (`GET` reveals the received choice), `/fixture/native-tasks
{open:true}`, `/fixture/limit-wait {…}` / `{clear:true}`. `POST /fixture/reset-run` aborts a still-running fixture run — `launchApp`
calls it before EVERY test. Control endpoints set state at the START, not via `defer` (the suite runs with
`continueAfterFailure = false`, which skips `defer` blocks).

Launch arguments pin everything persistent that could confuse the next test (`-cbase.mobile.tab`, `-cbase.mobile.cat:<Workspace>`,
`-cbase.mobile.chats.sort`, `-cbase.mobile.proj:<Workspace>` with an empty value, `-cbase.mobile.browser.desktop`,
`-cbase.mobile.wfart:<Workspace>`). For views that stay mounted on purpose (chats, terminal, browser) helpers check `isHittable`, not `exists`.

**Live sweep** against a real gateway (`testFullCategorySweepAgainstLiveGateway`): walks all areas, both drawers, Apps, Profile and
all settings pages and opens a real chat; since its messages are unknown it checks the picture (the lower quarter of the history must
not be a flat colour and must stand still, `inkRatio`). Server, user name and password come ONLY from test environment variables
(`CBASE_MOBILE_E2E_{SERVER,USERNAME,PASSWORD}`) through a temporary copy of the `.xctestrun` file that a `trap` removes even after a
failure: `build-for-testing`, fill the copy's `EnvironmentVariables`, `test-without-building -xctestrun <copy>`. Production values
belong in no Swift file, scheme or git.

Automation traps:

- **Long press is unreliable:** `press(forDuration:)` arrives as a long press only about every second time; otherwise the touch is a
  TAP. `openContextMenu` presses up to six times, alternating between ELEMENT and COORDINATE. Paths that avoid the long press are
  the better place to check what lies behind the menu.
- **Replacing prefilled fields:** `TextField(axis: .vertical)` does not report its `value` reliably (use a fixed generous number of
  delete keys); a tap on the middle sets the insertion point at the start (tap the right edge); typed text can stay an uncommitted
  composition — a trailing space ends it.
- **A `Form`/`List` is a collection view:** what is not drawn does not EXIST; scroll first. A label-only lookup can hit the surrounding
  accessibility element; give such buttons an identifier.
