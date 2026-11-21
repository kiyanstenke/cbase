# `CbaseMobileUITests/Tests/` — the XCUITests of the iOS app, one class per place

The base `../CbaseUITestBase.swift` holds all helpers (fixture ids, `launchApp`, `setUpWithError`); each file here is a
`final class <Place>UITests: CbaseUITestBase`, sorted by the place where the user opens the view (the same rule as the
app folders). Test identifiers are `CbaseMobileUITests/<Class>/<test>`.

| Class | Place |
|---|---|
| `AAAWarmupUITests` | no place — warm-up: opens the fixture chat, taps the composer, waits up to 60 s for a software keyboard INSIDE the screen, types nothing, discards a leftover draft. Named AAA… so it runs first alphabetically |
| `ChatStageUITests` | Chat: stage, history geometry, run indicator, keyboard, the island after a chat switch with an open keyboard |
| `ChatTextUITests` | Chat: text markers, markdown, text size in the open chat, performance diagnostics, the agenda as a tree in its sheet |
| `ChatComposerUITests` | Chat: composer island, strip base, limit strip, slash picker, question card, draft, queue, attachment, archive at the island |
| `ChatReconcileUITests` | Chat: reconciling with the server on opening, after a stream gap and after returning from the background |
| `ChatRowsUITests` | Chat: history rows — tool call / thinking / collected rows and their sheets, task list, waiting row, subagent marker and agent sheet, text edge, compaction divider, artefact |
| `ChatCardsUITests` | Chat: cards in the history (approval card and its "Adapt" marker); a class of its own because `ChatRowsUITests` sits at the 2,000-line guard |
| `ShellUITests` | Shell: start, chat overview, drawers and swiping, chat list / search / folders / filters, Coding overview, the three places in the right drawer, apps, usage rings, the services button of the header |
| `CodingUITests` | Coding categories other than chat: code tree and viewer, terminal, browser, git sheet, workflows (step sheet, workflow settings as a category list, dynamic library), credentials, skills, MCP airlock, git overview |
| `ScheduledUITests` | Coding → Scheduled: the clock of a job chat in the chat list, list / run now / pause, creating a job |
| `GitUITests` | The git sheet: pulling down does not show the cancellation as an error, collapsing is remembered, repo selection, graph, commit files and diffs |
| `SettingsUITests` | Settings: all areas, usage, notifications, auto-compact, GitLab accounts, hooks, auto-continue and credit gate, OpenRouter, appearance, model settings |
| `../CbaseMobileUITests` (root) | the live sweep against a REAL gateway (`testFullCategorySweepAgainstLiveGateway`, `CBASE_MOBILE_E2E_SERVER`); it keeps the old class name so the `-skip-testing` path in `mobile/README.md` stays valid |

**Effort selections.** One test per place, all through the helper `checkEffortSelection` in the base (`pickerRow`,
`selectInPicker` beside it). It opens the "Effort" picker and holds the entries VERBATIM (at the chat places no empty
entry — "Auto" is gone —, in the chat sheet "Ultracode" last; at posts "Default · <level>" first, at the workflow run
"As the chat · new: <level>"), their order (y ascending), the absence of any other level word, and the number of entries
with "runs as" — counted WITHOUT the picker row itself, whose label carries the chosen value. Every test picks "Max"
under GPT-5.6 Sol, switches to GPT-5.5 (the only fixture model without `max`) and then expects "Max · runs as X-High" as
the last entry.

**Full run** — plain `xcodebuild` from the repository root against the fixture gateway:

```sh
node mobile/test-fixtures/chat-gateway.mjs 17718 &   # the fixture gateway; port 17718 must be free
X="xcodebuild -project mobile/CbaseMobile.xcodeproj -scheme CbaseMobile -destination id=<simulator-udid> -derivedDataPath /tmp/CbaseMobile-UITests"
$X build-for-testing
$X test-without-building -only-testing:CbaseMobileUITests/AAAWarmupUITests
$X test-without-building -skip-testing:CbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway
```

Port 17718 must be free (a busy port means a fixture of another run — stop it, do not kill blindly). Delete the persistent
composer drafts first (in the plist of the app's DATA container — `simctl get_app_container <udid> <bundle> data`; the user domain
`defaults read <bundle>` never contains them). The warm-up test runs alone first, then the run; hold `Executed N tests` against
the expectation from `-enumerate-tests -test-enumeration-style flat` (minus the live sweep): a deviation is a finding even on
SUCCEEDED. A single test (the 5x proofs): `-only-testing:CbaseMobileUITests/<Class>/<test>`, five runs in a row;
`-only-testing:CbaseMobileUITests/<Class>` runs the whole class.

**Run on a quiet machine.** A foreign build or dev server on the same Mac slows the simulator enough to turn timing-sensitive
tests red — repeat a red run once the machine is free before reading it as a finding.

**The baseline is ZERO red.** Whoever sees a red test today has a finding, not a flake: first run the test 5x alone
(`-only-testing:…`, five runs), then read the message — the tests name their geometry, their trace or their switch. The three
gesture tests (below) are the only ones that deliberately roll the dice, and they say so.

**A skipped test is not a green one.** `requireFixture()` throws `XCTSkip` when the fixture does not answer — if it dies
after the start, ALL tests skip themselves and xcodebuild reports "Executed N, N skipped, 0 failures" with
`TEST EXECUTE SUCCEEDED`. In the full run only the **diagnostic skips** are therefore allowed; every other skip is a
finding — read its name and reason. With `-only-testing` NO skip of an explicitly named test counts; a class identifier brings the
diagnostic skips of its class along and runs them as in the full run. Whoever runs a test by hand holds the line
`Executed N tests` AND the skip count against the expectation.

**The complete skip inventory** (`git grep XCTSkip mobile/CbaseMobileUITests/`) — three groups, and only the first is
registered in the tool:

| Group | Where | What a skip there means |
|---|---|---|
| **Diagnostic** (list `DIAGNOSTIC_SKIPS` in `tools/check/lib/uitests.mjs`) | `ChatStageUITests.testKeyboardMotionRecordingProbe` (`CBASE_KEYBOARD_PROBE=1`), `…testKeyboardOpenTraceWhileScrolledUp` (`TEST_RUNNER_CBASE_KEYBOARD_TRACE`), `ChatTextUITests.testChatScrollPerformanceProbe` and `…testSendPerformanceProbe` (both `TEST_RUNNER_CBASE_PERF_PROBE`), `…testDeviceMarkerDiagnosticOnRealChat` | **normal.** They are switched on by an environment variable and meant for manual, video or device diagnosis; the tool lets exactly these through |
| **Keyboard** | `ChatComposerUITests.testAttachPanelKeepsComposerSteady`, `ChatStageUITests.testReleasingTheKeyboardDragDoesNotSnapTheComposerUp` | **environment.** Without a software keyboard in the simulator the drag cannot be checked — exit 1, and the answer is the warm-up test (`open -a Simulator`, ~4 min after boot), not a change to the test |
| **Environment/data** (NOT in the tool) | `CodingUITests.testLongPressOnFolderDownloadsZip` (the context menu did not come after eight attempts — expressly NOT a product finding); `CbaseUITestBase.openFirstChat` ("No chat to open" — with an `XCTFail` before it, so red AND skip) and `…openFirstChatInProject` ("No chat in the project"); and the trace helpers (`entranceTrace`, `entranceNotes`, `entranceScreenSegments`, `entranceScreenSegmentsTimed`, `liftTrace`; "DEBUG build only") | **environment.** A skip from this group is no reason to extend `DIAGNOSTIC_SKIPS`: that list is the list of tests that must NEVER run. Whoever sees a skip of the second or third group restores the environment (keyboard, fixture seed) and runs again |

The live sweep (`../CbaseMobileUITests.swift`) carries three `XCTSkip`s of its own (`CBASE_MOBILE_E2E_SERVER` missing,
gateway not reachable, no credentials) — it does not run in the tool anyway (`-skip-testing`).

**Identifiers.** An `-only-testing` on an identifier that does not exist reports `TEST EXECUTE SUCCEEDED` with ZERO
tests — after every run hold the line `Executed N tests` against the expected number (the tool does that; the number is
no constant, it comes from `-enumerate-tests`: all identifiers minus the live sweep). Look identifiers up instead of
guessing: `xcodebuild … -enumerate-tests -test-enumeration-style flat test-without-building`. The base appears in the run
as an empty suite `CbaseUITestBase` (0 tests) — that is right.

**Order.** XCTest runs alphabetically: classes, within them methods. The fixture state (`/fixture/history`, git, browser,
channel, approval card …) survives between tests — `launchApp` resets only run, queue, one-shot switches and seed via
`POST /fixture/reset-run`, NOT the seeded history. A test that opens the chat without seeding itself sees the history of
its predecessor.

**State isolation: what `launchApp` pins — and why the composer draft belongs to it.** Not only the fixture state
survives, the simulator's `UserDefaults` do too. The composer draft is persistent: `ChatViewModel` reads
`cbase.mobile.draft:<chatId>` on opening (for a chat without a server id `…:new:<ws>:<proj|ws>:<folder>`) and puts the
text into the field. A test that types without sending leaves it behind, and the NEXT test's `typeText` appends to it.
Isolation lies on three levels:

- `launchApp` pins every key the fixture can produce to empty via the **argument domain** (`Self.fixtureDraftKey`: the
  fixed chat ids plus the `new:` forms). The argument domain covers every READ; writing continues into persistent storage.
- The tool deletes the persistent keys before each run from the plist of the app's **data container**.
- The warm-up test leaves no draft.

Opt-out is `launchApp(… keepDraft: true)`: exactly one test needs it, the persistence test
(`ChatComposerUITests.testComposerDraftSurvivesTabSwitch`), which checks the persistence ITSELF and cleans up its draft
at the end. **The keys exist twice in the tree:** if `draftKey` in `mobile/CbaseMobile/Chat/ChatViewModel+Draft.swift`
changes (prefix or the form `neu:<ws>:<proj|ws>:<folder>`), `fixtureDraftKey` here must follow — otherwise the argument
domain hits nothing and the same tests turn red from their predecessor's draft without a type error reporting it.

**`assertWaitingState(kind:)` and the four sticky counter-test switches** (`CbaseUITestBase.swift`). The helper checks
the waiting phase of a chat for `task` · `wakeup` · `agent`: no chips (`chat-status-*` must not exist), but the run row
as a RESTING run mark plus the pill `chat-tasks-pill` "1 running task" (visibility via frame/window/keyboard edge,
`chipObscured` — NOT `isHittable`, see below), WITHOUT "Tinkering…"; for the agent additionally the header button
`chat-agents` with `accessibilityValue == "running"`. The pill's sheet (tap the pill by coordinate, close via
`chat-tasks-close`) carries EXACTLY one entry of the expected kind (`chat-task-command` · `chat-task-wakeup` ·
`chat-task-agent`) and none of the others; for the task the description, for the wake-up "Scheduled to continue".

Its counter-tests run through `POST /fixture/waiting-agent-counter-probe` — **four switches, and they STICK**
(`reset-run` deliberately does not clear them): `empty: true`, `event: "background"`, `descriptionEmpty: true`,
`mixed: true`. The helper therefore reads the state beforehand via `GET` and fails with the **switch name** instead of at
the chip; only a runner with `TEST_RUNNER_CBASE_COUNTER_PROBE=1` drives past it. Whoever extends the route by a switch
extends the list in `assertWaitingState`. A switch is taken back with `curl -X POST … -d '{}'` or by restarting the
fixture; before a proof run a `GET` on the route is worth it.

**Two tests roll the dice with the gesture graph — and say so.** With a resting synthetic touch the context menu of a row
comes only in about every second PROCESS (a first press arrives as a tap in about half of the processes; press type and
duration have no influence; the state sticks to the process — a second press in the same process does not roll again).
`SettingsUITests.testNotificationSettingsAndPerChatOverride` (chat row) and `CodingUITests.testLongPressOnFolderDownloadsZip`
(folder row in the code tree, via `openContextMenu(… expecting:proof:restart:)`) therefore run up to eight attempts, EACH
in a fresh process, and tell "menu did not come" (gesture) from "menu came without the item" (regression, proven
differentially by a second menu item that must not be in the tree before the press). A run takes 28 to 93 s. The ZIP test
keeps its `XCTSkip` after the eighth attempt (skip inventory, third group): the tool reports it as exit 1.

**What a test may measure — rules from red runs:**

- **A step of the trace is not a frame.** The entrance trace (`ChatEntranceTrace`) hangs on a `CADisplayLink`, which
  drops out under load: a bound "per FRAME" then measures the machine instead of the animation. `entranceScreenSegmentsTimed`
  delivers the time per sample; the frame duration is the median of the gaps, and every step is normalised to it
  (`testSentMessageRidesIntoTheTimelineInsteadOfPopping`). A real jump has dt == median and stays red — the counter-test
  shows it. The same principle for opacity: "below 0.5 in at least one sample" is wrong under load because the early
  samples are missing — the promise is "it GROWS" (start, ramp without a drop, final value of the whole trace, an
  intermediate sample).
- **Measure a zone, do not estimate it.** "Above the keyboard" is not "above the key edge":
  `app.keyboards.firstMatch.frame` starts well below the region top that matters for interactive dismissal (the reported
  `willChangeFrame endMinY`), and the island's drag zone (`composer-keyboard-grip`) lies in between. Where a test derives
  a zone from a read frame, a guard belongs with it: if the derived point lies outside the expected range the test must
  turn RED — otherwise the gesture runs into nothing on a broken frame and the test is silently green.
- **An unbound element query proves nothing.** `app.staticTexts["…"]` and `app.buttons` by label also find collapsed
  sheets and closed drawers (the bell button `drawer-bell` carries the label "Notifications" and stands in the tree while
  closed). Two cheap guards suffice: the searched text must NOT exist BEFORE the action (otherwise the check afterwards
  is a tautology), and a proof element counts only if it was missing before and is there afterwards. A SwiftUI `.sheet`
  is, by the way, **no** `sheet` element for XCUITest (`app.sheets` means the action dialog) — whether a text comes from
  a sheet is measured by its position against an element of the sheet.
- **A promise that hangs on a SAMPLE COUNT belongs on a long run.** An existence query over
  `app.descendants(matching: .any)` costs 0.25–0.35 s at load < 3 and ~1 s at load 28; with a 10 s run too few samples
  remain, with `/fixture/open-call` (60 s) and a window up to t0 + 25 s there are plenty. And an anchor `Date()` belongs
  BEFORE the `tap()`, not after — XCUITest waits for idle there.
- **The app's frame trace attaches to EVERY test** without rebuilding it: `TEST_RUNNER_CBASE_KEYBOARD_TRACE=<path>` on
  `xcodebuild`, `launchApp` passes it through. It also carries the decision itself (`settle … decision=endEditing|settleBack|off`).
  For keyboard findings this is the first resort, not the video: if `willChangeFrame … dur=0.00` comes AFTER the settle
  row, the APP closed (`endEditing`); before it with a real duration it was iOS. The same for the marker gesture via
  `TEST_RUNNER_CBASE_MARKER_TRACE`.
- **"Grow" means GREATER, not "different".** Parse the number from a label like "min. 1,240 tokens" and require `>`;
  `label != before` was also true when the number fell or only the rounding changed. And the run row's pill
  (`chat-tasks-pill`) and the sheet behind it (`chat-tasks-close`) are operated via
  `coordinate(withNormalizedOffset:).tap()`, never via `tap()` on the element — `isHittable` is ALWAYS false there, and
  a `tap()` on the element aborts with "not hittable" instead of tapping.

**The three most common questions:**

- *Where do I start the app for a test, and what does that clean up?* — `CbaseUITestBase.swift:launchApp`: launch
  arguments pin tab, category, workspace, filter and sorting, preceded by `fixturePost(reset-run)`; `requireFixture`
  returns the fixture address or throws `XCTSkip` — a dead fixture process turns the whole run "green with N skipped".
  Check `lsof -iTCP:17718` first.
- *How do I seed a history?* — `setFixtureHistory` for chat histories (length, stress, markdown, invisible turns),
  `fixturePost` for every `/fixture/*` switch, `waitForFixture` waits for a fixture state.
- *Where does the screenshot hang on a failure?* — `attach` hangs it with a name on the test; a test that takes a
  fixture switch back via `defer` does NOT do that on failure (`continueAfterFailure = false` in `setUpWithError` skips
  every `defer`) — set state before `launchApp`, do not roll it back afterwards.

**Not here:** the app itself (`../../CbaseMobile/`), the fixture gateway (`../../test-fixtures/chat-gateway/`, port
17718), the web DOM probes (run by hand in a real browser, not part of this repository). This README is listed as a `membershipExceptions` entry in the pbxproj
(`Tests/README.md`) — otherwise it ends up as a resource in the `.xctest`; every new `.swift` here is a member without an
entry (synchronized root group).
