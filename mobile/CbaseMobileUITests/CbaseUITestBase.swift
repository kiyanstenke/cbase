import XCTest

// UI tests of the mobile shell. Two modes:
//  • fixture gateway (mobile/test-fixtures/chat-gateway) — deterministic chat/queue tests
//  • real local gateway (server/gateway) — walkthrough of all categories and pages
//
// Credentials come exclusively from test environment variables, never from the repo.
class CbaseUITestBase: XCTestCase {
    /// Fixed workspace id of the fixture gateway.
    static let fixtureWorkspaceId = "10000000-0000-4000-8000-000000000001"
    /// Fixed chat id of the fixture gateway.
    static let fixtureChatId = "20000000-0000-4000-8000-000000000001"
    /// Fixed project of the fixture workspace.
    static let fixtureProjectId = "30000000-0000-4000-8000-000000000001"
    /// The seeded GitLab account and the id the fixture gives the second one.
    static let fixtureGitlabAccountId = "a0000000-0000-4000-8000-000000000001"
    static let fixtureGitlabAccountId2 = "a0000000-0000-4000-8000-000000000002"
    /// The chats with a composer that the fixture serves under a FIXED id (state.mjs): the main chat (every
    /// `POST /api/chats` answers with IT) and the two older coding chats. `launchApp` pins the composer draft of each
    /// to empty — see there.
    static let fixtureComposerChatIds = [
        fixtureChatId,
        "20000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000003",
    ]
    /// All draft keys a test against the fixture can create — the forms are in
    /// `ChatViewModel+Draft.swift` (`draftKey`): per chat id and per "new chat"
    /// (workspace, project or "ws", folder — "" without a folder).
    static var fixtureDraftKey: [String] {
        fixtureComposerChatIds.map { "cbase.mobile.draft:\($0)" } + [
            "cbase.mobile.draft:new:\(fixtureWorkspaceId):ws:",
            "cbase.mobile.draft:new:\(fixtureWorkspaceId):\(fixtureProjectId):",
            "cbase.mobile.draft:new:\(fixtureWorkspaceId2):ws:",
        ]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func checkSlideInWithoutFlash(transactionDepth: CGFloat, holdDuration: TimeInterval = 0.2) throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        // To look at it by hand: set CBASE_DIAG_TRACE to a path, then the trace stays.
        // Without the variable the test writes to a file of its own and cleans up.
        let keep = ProcessInfo.processInfo.environment["CBASE_DIAG_TRACE"]
        let trace = keep ?? "/tmp/cbase-dismiss-\(Int(transactionDepth))-\(UUID().uuidString).csv"
        defer { if keep == nil { try? FileManager.default.removeItem(atPath: trace) } }
        let app = launchApp(server: server, environment: ["CBASE_KEYBOARD_TRACE": trace])
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.0)
        let top = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        top.withOffset(CGVector(dx: 0, dy: -260)).press(
            forDuration: 0.1,
            thenDragTo: top.withOffset(CGVector(dx: 0, dy: transactionDepth)),
            withVelocity: .slow,
            thenHoldForDuration: holdDuration
        )
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "The drag must close the keyboard")
        // Run-out, so the last frames of the slide-in animation are in the trace too.
        Thread.sleep(forTimeInterval: 2.0)

        let heights = try liftTrace(trace)
        XCTAssertGreaterThan(heights.count, 30, "The motion trace is too short (\(heights.count) samples)")
        guard let up = heights.max(), up > 100 else {
            return XCTFail("The keyboard was never up in the trace (maximum \(heights.max() ?? -1))")
        }
        guard let tip = heights.firstIndex(of: up) else {
            return XCTFail("The lift never reached 0 after opening")
        }
        XCTAssertTrue(heights[tip...].contains { $0 <= 2 }, "The lift never reached 0 after opening")
        // From the opening maximum the lift may only FALL. Looking only from the first zero
        // value on would be blind to the case where the deflection lies MIDWAY through the slide-in
        // (0 → 212 → 0, two frames before standstill, triggered by a second close notification).
        // The drag in this test goes down throughout, so a renewed rise is always a defect;
        // 20 pt of tolerance covers the settling.
        var deepest = up
        var deflection: String?
        for (offset, value) in heights[tip...].enumerated() where deflection == nil {
            if value > deepest + 20 {
                deflection = "Sample \(tip + offset): \(value) pt, although the lift was already at \(deepest) pt"
            }
            deepest = min(deepest, value)
        }
        XCTAssertNil(deflection, "The composer flashes up again while sliding in — \(deflection ?? "")")
    }

    /// Bottom edge of the action bar (copy/read aloud) of the message whose text ends at `y` — the REALLY lowest
    /// edge of that message's content.
    ///
    /// Every message carries this bar below its text. The spacing checks below therefore measure from it and not
    /// from the text; their expected values (bubble margin, row spacing, base padding of the list) stay unchanged.
    ///
    /// If no bar is found, `y` itself comes back: the check then fires as before — rightly so, a missing bar is a
    /// finding in itself.
    ///
    /// The USER bubble carries no bar — below its text only a bar that begins DIRECTLY below counts (`nearBar`; below an
    /// answer it begins ≈ 6 pt under the text); otherwise the search would pick the bar of the next answer further down.
    /// Without a bar `y` itself is right: below the user bubble's text lies the padding that used to lie below its bar.
    func actionBarBottom(_ app: XCUIApplication, below y: CGFloat) -> CGFloat {
        let nearBar: CGFloat = 20
        let buttons = app.buttons.matching(identifier: "chat-message-copy")
        var best: CGFloat?
        for index in 0..<buttons.count {
            let frame = buttons.element(boundBy: index).frame
            guard frame.height > 0, frame.minY >= y - 1, frame.minY <= y + nearBar else { continue }
            if best == nil || frame.maxY < best! { best = frame.maxY }
        }
        return best ?? y
    }

    func attachment(_ text: String, _ name: String) -> XCTAttachment {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        return attachment
    }

    /// Is an element above the composer VISIBLE — in the window and above the keyboard? Nil means yes, otherwise the reason.
    /// Deliberately not `isHittable`: the composer island keeps its collapsed sheets (slash picker, actions panel) in the
    /// accessibility tree with full frames, so `isHittable` is always false there. It measures the pill of the run row
    /// that stands directly above the island.
    func chipObscured(_ app: XCUIApplication, _ chip: XCUIElement) -> String? {
        let frame = chip.frame
        guard frame.width > 0, frame.height > 0 else { return "its frame is empty (\(frame))" }
        let window = app.windows.firstMatch.frame
        guard window.contains(frame) else { return "it lies outside the window (\(frame) in \(window))" }
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists, frame.maxY > keyboard.frame.minY + 1 {
            return "the keyboard covers it (element \(frame), keyboard from \(keyboard.frame.minY))"
        }
        return nil
    }

    /// The WAITING PHASE of a run (`run_waiting`): the turn is over, something still runs in the background — a
    /// background command, a subagent or an alarm set by the agent.
    ///
    /// Where this shows: the PILL of the run row (`chat-tasks-pill`, "1 running task"): in the waiting phase the row
    /// stands as a resting hexagon + pill, WITHOUT "Tinkering…". The pill counts all three kinds — the subagent
    /// too —, its sheet (`chat-tasks-close`) names it by kind (`chat-task-command` · `chat-task-wakeup` ·
    /// `chat-task-agent`).
    ///
    /// Common to all three kinds: the pill says "1 running task", no chip stands, the sheet carries EXACTLY the one entry
    /// of the expected kind, no "Tinkering…" in the history, and the composer stays usable — a tap opens the keyboard
    /// ("you can keep writing", measured rather than read). Per kind: task ⇒ the sheet names the DESCRIPTION ("Wait for the
    /// E2E run"), which stands nowhere before opening; wakeup ⇒ "Scheduled to continue"; agent ⇒ additionally the dot on the
    /// header button. For task/wakeup the button carries none.
    ///
    /// Counter-tests run through the fixture (`POST /fixture/waiting-agent-counter-probe`, from outside via
    /// curl, sticky): `empty: true` (no pill ⇒ red), `event: "background"` (the turn keeps running,
    /// "Tinkering…" stays ⇒ red), `descriptionEmpty: true` (the sheet says "No description" ⇒ red), `mixed: true`
    /// (a subagent as well: "2 running tasks" and the dot ⇒ red). Because the switches STICK, the helper reads them
    /// beforehand; only `CBASE_COUNTER_PROBE=1` drives past a set switch into the checks.
    func assertWaitingState(kind: String) throws {
        let server = try requireFixture()
        // Read the sticky counter-test switches BEFORE the start: a manual run against a fixture in which a counter-test
        // stands would otherwise turn the three waiting tests red without naming the switch. `GET` returns the state;
        // `{}` via POST takes it back.
        let toggle = fixtureJSON(server + "/fixture/waiting-agent-counter-probe")
        // ALL FOUR switches the route knows: a missing `mixed` would turn the background-command and scheduled-continuation
        // tests red with the PRODUCT notice ("… must not set the subagent dot") — exactly the confusion this manual run is
        // built against. Whoever extends the route by a switch extends this list; `GET` returns each of them.
        let set = [
            (toggle?["empty"] as? Bool) == true ? "empty" : nil,
            (toggle?["event"] as? String) == "background" ? "event=background" : nil,
            (toggle?["descriptionEmpty"] as? Bool) == true ? "descriptionEmpty" : nil,
            (toggle?["mixed"] as? Bool) == true ? "mixed" : nil,
        ].compactMap { $0 }
        if !set.isEmpty {
            let counterProbe = ProcessInfo.processInfo.environment["CBASE_COUNTER_PROBE"] == "1"
            add(attachment(
                "Counter-test switch /fixture/waiting-agent-counter-probe: \(set.joined(separator: ", "))"
                    + (counterProbe ? " — counter-test (CBASE_COUNTER_PROBE=1), checks run" : ""),
                "Waiting phase: switch"
            ))
            if !counterProbe {
                XCTFail(
                    "Counter-test switch /fixture/waiting-agent-counter-probe is still set: "
                        + "\(set.joined(separator: ", ")) — reset with `curl -X POST … -d '{}'` "
                        + "or restart the fixture (no test sets it; it sticks across `reset-run`)"
                )
                return
            }
        }
        // The switch is set BETWEEN `/fixture/reset-run` and the start:
        // `reset-run` takes the run switches back, and `launchApp` calls it first —
        // set before, it would be gone when sending.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/waiting-agent", body: ["open": true, "kind": kind]),
                "The fixture did not accept the waiting-phase switch"
            )
        })
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        // First the evidence of the waiting phase (comes 900 ms after the start in the fixture), THEN the
        // checks — before that, "Tinkering…" would rightly stand.
        let pill = app.buttons["chat-tasks-pill"]
        let agentsButton = app.buttons["chat-agents"]
        let buttonValue: () -> String = { agentsButton.value as? String ?? "" }
        XCTAssertTrue(pill.waitForExistence(timeout: 20), "The run row's pill (chat-tasks-pill) is missing in the waiting phase")
        XCTAssertNil(chipObscured(app, pill), "The pill stands, but \(chipObscured(app, pill) ?? "")")
        XCTAssertEqual(pill.label, "1 running task", "The pill does not count exactly the one task")
        for old in ["chat-status-tasks", "chat-status-wakeup", "chat-status-agents"] {
            XCTAssertFalse(app.buttons[old].exists, "The chip \(old) still stands above the input field — the pill says it now")
        }
        XCTAssertTrue(agentsButton.waitForExistence(timeout: 5), "The subagent button is missing in the chat header")
        let expected = kind == "task" ? "command" : kind == "wakeup" ? "wakeup" : "agent"
        // The dot stands for EVERY running piece of background work — agent, command, monitor, alarm
        // (`ChatViewModel.backgroundRunning`, web `bgRunningCount`).
        let work = expected == "agent" ? "a background agent" : expected == "command" ? "a background command" : "an alarm"
        XCTAssertTrue(waitUntil(timeout: 20) { buttonValue() == "running" },
                      "While \(work) runs, the header button must carry its dot — read: '\(buttonValue())'")
        // Manual run BEFORE the tap: if the description already stood somewhere, the line below would prove nothing about the sheet.
        let description = app.staticTexts["Auf den E2E-Run warten"]
        if expected == "command" {
            XCTAssertFalse(description.exists, "The command's description is already in the tree BEFORE the sheet is opened")
        }
        // The coordinate is tapped (`isHittable` is always false above the island).
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let close = app.buttons["chat-tasks-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "A tap on the pill does not open its sheet (no chat-tasks-close)")
        let entry = { (kind: String) in app.descendants(matching: .any).matching(identifier: "chat-task-\(kind)") }
        XCTAssertTrue(entry(expected).firstMatch.waitForExistence(timeout: 5), "The sheet carries no entry of kind \(expected)")
        XCTAssertEqual(entry(expected).count, 1, "The sheet does not carry kind \(expected) exactly once")
        for kind in ["agent", "workflow", "command", "monitor", "wakeup"] where kind != expected {
            XCTAssertFalse(entry(kind).firstMatch.exists, "The sheet wrongly names an entry of kind \(kind)")
        }
        switch expected {
        case "command":
            XCTAssertTrue(
                description.waitForExistence(timeout: 5),
                "The sheet does not name what is waited for ('Auf den E2E-Run warten') — it shows "
                    + (app.staticTexts["No description"].exists ? "the fallback 'No description'" : "neither the description nor the fallback")
            )
            // … and INSIDE the sheet: the close button sits in its bar, the text below it.
            XCTAssertGreaterThanOrEqual(description.frame.minY, close.frame.minY,
                                        "The description stands ABOVE the sheet's bar (\(description.frame) vs. \(close.frame))")
        case "wakeup":
            XCTAssertTrue(app.staticTexts["Scheduled to continue"].waitForExistence(timeout: 5), "The sheet does not name the alarm ('Scheduled to continue')")
        default:
            break
        }
        attach(app, "Waiting phase: running-tasks sheet (\(kind))")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5), "The running-tasks sheet does not close")

        // No running WORK in the history: the turn is over, "Tinkering…" would be a false statement. The row
        // itself stands (resting hexagon + pill) — it carries the pill.
        XCTAssertTrue(app.staticTexts["Tinkering…"].waitForNonExistence(timeout: 5), "'Tinkering…' still stands in the history during the waiting phase")

        // The composer stays usable: a tap opens the keyboard. If it still stands from sending,
        // it is first retracted via the drag zone — otherwise the tap would prove nothing.
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        if app.keyboards.firstMatch.exists, handle.exists {
            let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(
                forDuration: 0.1,
                thenDragTo: start.withOffset(CGVector(dx: 0, dy: 330)),
                withVelocity: .slow,
                thenHoldForDuration: 0.2
            )
            _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
        }
        XCTAssertTrue(composer.isHittable, "The composer cannot be tapped in the waiting phase")
        composer.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 10),
            "A tap into the composer opens no keyboard in the waiting phase — 'you can keep writing' does not hold"
        )
        attach(app, "Waiting phase: \(kind)")
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    // Read from the FIXTURE (`/fixture/pages-skills`), not from the surface: whether a switch is on cannot be seen from outside on a
    // `CbToggle`, and which department a created skill carries stands only in the body that arrived.

    /// The skills as the fixture holds them (`id`, `name`, `area`, `projectId`, …).
    func fixtureSkills(_ server: String) -> [[String: Any]] {
        (fixtureJSON(server + "/fixture/pages-skills")?["skills"] as? [[String: Any]]) ?? []
    }

    /// The hides as "<projectId>:<skillId>".
    func fixtureSkillHides(_ server: String) -> [String] {
        (fixtureJSON(server + "/fixture/pages-skills")?["hidden"] as? [String]) ?? []
    }

    /// Every skills request of the app (`method`, `path`, `query`, `body`), in order.
    func fixtureSkillCalls(_ server: String) -> [[String: Any]] {
        (fixtureJSON(server + "/fixture/pages-skills")?["calls"] as? [[String: Any]]) ?? []
    }

    /// Coding → Skills as a row of the coding categories — via the right drawer, like the user. The create button is the sign that the page stands.
    func openCodingSkills(_ app: XCUIApplication) {
        openCategory(app, "skills")
        XCTAssertTrue(app.buttons["skills-new"].waitForExistence(timeout: 20), "Coding → Skills did not open")
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    func launchApp(
        server: String,
        pinChatFilters: Bool = true,
        pinTextSize: Bool = true,
        /// `true` lets the persistent composer draft through — ONLY for the test that checks the
        /// persistence itself (`testComposerDraftSurvivesTabSwitch`); see the pins below.
        keepDraft: Bool = false,
        /// `false` lets the remembered sections and the graph scope in the git sheet through — ONLY for the test that checks the remembering
        /// itself (`GitUITests.testSectionsCollapseAndStayRemembered`); see the pins below.
        gitPins: Bool = true,
        environment: [String: String] = [:],
        launchArguments: [String] = [],
        preparation: (() -> Void)? = nil
    ) -> XCUIApplication {
        // A run with a waiting phase or subagent stays open in the fixture for 60 s. If the previous
        // test ended earlier, THIS test's send would still fall into that run and only be queued.
        // So clean up before every start; on the real gateway the request goes
        // nowhere (404) and is ignored.
        _ = fixturePost(server + "/fixture/reset-run", body: [:])
        // Fixture state the app already reads at LAUNCH (second workspace, long
        // skill seed) belongs HERE: after the reset, before the start. Set before `launchApp`,
        // `reset-run` would just clean it up again; taken back via `defer`, it would stay
        // after a failure — `continueAfterFailure = false` aborts by exception
        // and skips every `defer`, and the next test would inherit the state.
        preparation?()
        let app = XCUIApplication()
        // Launch arguments land in the argument domain of UserDefaults and take
        // precedence over the stored state — so every test starts in the same tab,
        // wherever a previous test left the app.
        app.launchArguments = [
            "-cbase.mobile.server", server,
            "-cbase.mobile.lang", "en",
            "-cbase.mobile.tab", "workspaces",
            // The coding tab starts at its overview (stored like the tab). The tests stand on the
            // last open category — the path overview → category is checked by
            // `testCodingTabStartsAtOverviewAndLeadsIntoCategories`.
            "-cbase.mobile.codingOverview", "0",
            // The boot splash (3.4 s overlay) would swallow the first taps of every test.
            "-cbase.mobile.boot-splash", "0",
            // Pin the CATEGORY too. The app restores it per workspace;
            // a test that last stood in the code tab let the next one start in a
            // view without a chats overview (and the rescue swipe does not work in the
            // editor). The key contains the workspace id — for the fixture gateway it is fixed.
            "-cbase.mobile.cat:\(Self.fixtureWorkspaceId)", "chats",
            // Pin the WORKSPACE too (`restorePersisted` reads `cbase.mobile.ws`): the fixture knows
            // a second one, and a test that failed after switching would let every following one start there — without chats, every
            // route except `/overview` answers 404, and the failures would have nothing to do with
            // the subject of the test.
            "-cbase.mobile.ws", Self.fixtureWorkspaceId,
            // The workflow editor opens in landscape on its own. The tests
            // measure the portrait rules (the start command visible in the node sheet without roles)
            // and therefore stay upright — pinned like tab and category.
            "-cbase.mobile.workflow.landscape", "0",
            // The kind of the "Workflows" category (graph · dynamic) is remembered per workspace — a dyn test would
            // otherwise let the next graph test start in the library.
            "-cbase.mobile.wfart:\(Self.fixtureWorkspaceId)", "graph",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            // The WHOLE app follows Dynamic Type (Kit/TextSize.swift): every font
            // grows with the simulator's text size. Without this clamp 205 tests would measure different heights depending on the
            // simulator setting — so pin to L (the iPhone default).
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL",
            // The gentle blur of the chat header zone is a PAUSED animation (Kit/CbGlass.swift, `GentleBlur`).
            // XCUITest waits before every step until no animation runs — with it a test stood ten minutes in the chat.
            "-cbase.mobile.header-blur", "0"
        ]
        // The text size of the app is a PERSISTENT device preference (settings →
        // appearance). A test that raised it would let every following test measure other heights — so pin it like
        // tab and chat filters. Only the test that checks the persistence itself runs
        // without the clamp.
        if pinTextSize {
            app.launchArguments += ["-cbase.mobile.textSize", "normal"]
        }
        // Chat sort order and the entered project are PERSISTENT (intended). For isolation
        // they are pinned like tab and category — otherwise the next test would start in
        // the order or project of the previous one and not find "its" chat. The test
        // that checks the restart in the remembered project starts without this default
        // (pinChatFilters: false).
        if pinChatFilters {
            app.launchArguments += [
                "-cbase.mobile.chats.sort", "newest",
                // And NO restored project: a test that last stood in a project let the next one
                // start there — but the project lacks the category "Projects" on purpose. An empty value is not a list, so
                // `stringArray(forKey:)` finds nothing and the app starts in the whole workspace.
                "-cbase.mobile.proj:\(Self.fixtureWorkspaceId)", "",
                // The browser's desktop view is persistent too — a test that failed
                // in the middle of desktop mode would let the next one start there.
                "-cbase.mobile.browser.desktop", "0",
            ]
        }
        // The COMPOSER DRAFT is persistent: on opening, `ChatViewModel` reads
        // `cbase.mobile.draft:<chatId>` (or `…:new:<ws>:<proj|ws>:<folder>` for a chat without a
        // server id) from `UserDefaults.standard` and puts the text into the field
        // (`ChatViewModel+Draft.swift`, `ChatViewModel.swift` init). A test that types without
        // sending (the keyboard-follows-drag test types a word, the slash-picker test
        // "/release-notes") leaves it behind — and `typeText` of the NEXT test appends to it:
        // the marker tests read "/…release-notes …" instead of "> Important …"
        // (green alone, red in the full run).
        // So pin every key the fixture can create to EMPTY via the argument domain:
        // the argument domain covers every READ, the field starts empty.
        // WRITING still goes to the persistent store — the plist in the app's
        // DATA CONTAINER (`simctl get_app_container … data`), not the user domain
        // of the simulator; delete that before every full run (mobile/README.md, "Testing").
        // Only the persistence test runs without the clamp (`keepDraft: true`); it cleans up
        // its own draft.
        if !keepDraft {
            for key in Self.fixtureDraftKey {
                app.launchArguments += ["-\(key)", ""]
            }
        }
        // The git sheet remembers collapsed sections and the graph scope in UserDefaults —
        // a test that collapsed the graph or set it to "Current branch" would let the next one start without it. Empty means "all
        // open", "all" is the default. Only the test that checks the remembering runs without the clamp (`gitPins: false`).
        if gitPins {
            app.launchArguments += ["-cbase-git-sections-closed", "", "-cbase-git-graph-extent", "all"]
        }
        // Diagnostic pass-through: if the frame trace is set on the runner
        // (TEST_RUNNER_CBASE_KEYBOARD_TRACE), the app writes it in EVERY test
        // — so even a regular keyboard test can be re-measured numerically
        // without rebuilding it. Without a path everything stays off (and release builds
        // do not contain the trace at all).
        if let trace = ProcessInfo.processInfo.environment["CBASE_KEYBOARD_TRACE"] {
            app.launchEnvironment["CBASE_KEYBOARD_TRACE"] = app.launchEnvironment["CBASE_KEYBOARD_TRACE"] ?? trace
        }
        // The same pass-through for the marker trace (TEST_RUNNER_CBASE_MARKER_TRACE on the
        // runner). A value without a leading "/" (e.g. TMP) writes into the app's container tmp
        // — the only way to re-measure the gesture states on a REAL device.
        if let trace = ProcessInfo.processInfo.environment["CBASE_MARKER_TRACE"] {
            app.launchEnvironment["CBASE_MARKER_TRACE"] = app.launchEnvironment["CBASE_MARKER_TRACE"] ?? trace
        }
        // The test's additional settings last — they are meant to beat the defaults above.
        app.launchArguments += launchArguments
        app.launchEnvironment.merge(environment) { _, fresh in fresh }
        app.launch()
        // On a REAL device iOS asks once at the APP's first local-network access (fixture
        // via the Mac's LAN IP) — the dialog lies above everything and would make
        // every following wait run into its timeout. Check only on the device: in the simulator there is
        // no dialog, and 3 s per test start would be pure waiting time there.
        if ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] == nil {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let allow = springboard.alerts.buttons.matching(
                NSPredicate(format: "label IN %@", ["Allow", "Allow", "OK"])
            ).firstMatch
            if allow.waitForExistence(timeout: 3) { allow.tap() }
        }
        return app
    }

    func fixtureAutocompact(_ server: String) -> Int {
        (fixtureJSON(server + "/api/autocompact")?["percent"] as? Int) ?? -1
    }

    /// nil (default) arrives as JSON null — the value -1 stands here for "no entry".
    func fixtureChatAutocompact(_ server: String) -> Int {
        guard let chat = fixtureJSON(server + "/api/chats/\(Self.fixtureChatId)") else { return -2 }
        return (chat["autocompact"] as? Int) ?? -1
    }

    func fixtureAutocompactMax(_ server: String) -> Int {
        (fixtureJSON(server + "/api/autocompact")?["maxTokens"] as? Int) ?? -1
    }

    func fixtureChatAutocompactMax(_ server: String) -> Int {
        guard let chat = fixtureJSON(server + "/api/chats/\(Self.fixtureChatId)") else { return -2 }
        return (chat["autocompactMax"] as? Int) ?? -1
    }

    func fixtureNotifyGlobal(_ server: String) -> [String: Bool] {
        guard let url = URL(string: server + "/api/notify") else { return [:] }
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var out: [String: Bool] = [:]
        URLSession.shared.dataTask(with: url) { data, _, _ in
            defer { finished.signal() }
            guard let data,
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let kinds = raw["kinds"] as? [[String: Any]] else { return }
            lock.lock()
            for a in kinds { if let k = a["key"] as? String { out[k] = (a["value"] as? Bool) ?? false } }
            lock.unlock()
        }.resume()
        guard finished.wait(timeout: .now() + 4) == .success else { return [:] }
        lock.lock()
        defer { lock.unlock() }
        return out
    }

    func requireFixture() throws -> String {
        let server = ProcessInfo.processInfo.environment["CBASE_MOBILE_FIXTURE_SERVER"]
            ?? "http://127.0.0.1:17718"
        if reachable(server) { return server }
        // On the DEVICE the "Local Network" permission blocks the test runner's
        // first access (request fails at once, iOS shows the dialog).
        // Confirm the dialog and try once more.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(
            NSPredicate(format: "label IN %@", ["Allow", "Allow", "OK"])
        ).firstMatch
        if allow.waitForExistence(timeout: 5) {
            allow.tap()
            Thread.sleep(forTimeInterval: 1)
            if reachable(server) { return server }
        }
        throw XCTSkip("Local fixture gateway is not running at \(server).")
    }

    /// The fixture gateway ALWAYS delivers a chat — if the overview stays empty, that is
    /// a failure and no reason to skip. A `XCTSkip` here used to hide
    /// that the app restores its last category and therefore showed no overview at all:
    /// two tests silently did not run for months.
    func openFirstChat(_ app: XCUIApplication) throws {
        normalizeToChatsOverview(app)
        let chat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        guard chat.waitForExistence(timeout: 25) else {
            attach(app, "Overview without chats")
            XCTFail("The chats overview lists no chat to open")
            throw XCTSkip("No chat to open")
        }
        chat.tap()
    }

    /// Back from any restored state to the workspace's chats overview —
    /// tab "Workspaces", category "Chats", no open chat.
    func normalizeToChatsOverview(_ app: XCUIApplication) {
        // The location "Coding" leads into the coding overview — the row "Chats" leads from there into the
        // category. It stands at the top of the right drawer (the bottom bar is gone); the helper
        // only taps it if it is there — `required: false` keeps that lookup.
        selectLocation(app, "workspaces", required: false)
        codingCategoryFromOverview(app, "chats")
        // First leave a possibly restored project — via the scope picker,
        // not via a swipe. An entered project shows ONLY its own chats in the overview;
        // if it is empty, it looked like "no chats present".
        if app.buttons["scope-picker"].exists {
            app.buttons["scope-picker"].tap()
            let whole = app.buttons["scope-whole-workspace"]
            if whole.waitForExistence(timeout: 6) {
                whole.tap()
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
            }
        }
        // Check for VISIBLE, not for "exists": chats, terminal and browser stay
        // mounted on purpose, so a mere existence test would also hit a covered
        // overview.
        if !waitUntilHittable(app.buttons["overview-new-chat"], timeout: 10) {
            swipeLeftAcrossScreen(app)
            if app.buttons["category-chats"].waitForExistence(timeout: 6) {
                app.buttons["category-chats"].tap()
            }
            closeDrawers(app)
        }
        if !waitUntilHittable(app.buttons["overview-new-chat"], timeout: 10) {
                // A chat was still open — back to the overview via the chat list.
            swipeRightAcrossScreen(app)
            if app.buttons["sidebar-overview"].waitForExistence(timeout: 6) {
                app.buttons["sidebar-overview"].tap()
                // The button closes the drawer itself. Do NOT call `closeDrawers` here:
                // its tap beside the drawer lands in the overview during the closing animation
                // — on a chat row, which then opens a chat again.
                _ = app.otherElements["left-drawer"].waitForNonExistence(timeout: 5)
            } else {
                closeDrawers(app)
            }
        }
    }

    /// If the coding overview stands (after a tap on the tab), open the category from it;
    /// if not, nothing happens — the overview only lies in front after a tap on
    /// the tab, at launch `launchApp` pins it away.
    func codingCategoryFromOverview(_ app: XCUIApplication, _ category: String) {
        let row = app.buttons["coding-overview-\(category)"]
        if row.waitForExistence(timeout: 4) {
            row.tap()
            _ = row.waitForNonExistence(timeout: 4)
        }
    }

    /// Tap the arrow back into the coding overview — the OPERABLE one. The chat list
    /// stays mounted behind every category and carries the same arrow in its header; a
    /// query by identifier alone finds two and taps none ("Multiple matching
    /// elements"). Same rule as for `overview-new-chat`: visible is what `isHittable` is.
    @discardableResult
    func tapCodingBack(_ app: XCUIApplication) -> Bool {
        let query = app.buttons.matching(identifier: "coding-back")
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if let button = query.allElementsBoundByIndex.first(where: { $0.isHittable }) {
                button.tap()
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        // On iOS 26.5 the two coincident arrows (the page's and the one of the chat list behind it) can both stay "not hittable"
        // for more than ten seconds on the MCP page although the arrow stands visible and free (measured on screenshots: the
        // reference app fails identically). The accessibility hit test then names neither. A user taps the picture, so tap the front
        // arrow by its coordinates — the callers check afterwards that the overview really opened.
        if let front = query.allElementsBoundByIndex.last(where: { $0.exists && $0.frame.width > 0 && app.windows.firstMatch.frame.contains($0.frame) }) {
            front.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            return true
        }
        return false
    }

    /// Choose one of the three locations — `location` is the rawValue of `HomeTab` (`workspaces` = Coding, `apps`, `profile`). The
    /// segmented bar at the top of the RIGHT drawer (identifiers `home-tab-<location>`). The choice closes the drawer; waiting is on
    /// the FRAME (`drawerOut`), because the closed drawer stays in the tree — a `waitForNonExistence` would run into its timeout every time.
    func selectLocation(_ app: XCUIApplication, _ location: String, required: Bool = true) {
        swipeLeftAcrossScreen(app)
        let button = app.buttons["home-tab-\(location)"]
        guard waitUntilHittable(button, timeout: 8) else {
            if required {
                attach(app, "Location \(location) not reachable")
                XCTFail("The location \(location) is not reachable in the right drawer")
            }
            closeDrawers(app)
            return
        }
        button.tap()
        _ = waitUntil(timeout: 4) { self.drawerOut(app, links: false) < 0.05 }
    }

    /// Switch category via the right drawer (the only way in the shell).
    func openCategory(_ app: XCUIApplication, _ category: String) {
        swipeLeftAcrossScreen(app)
        let button = app.buttons["category-\(category)"]
        XCTAssertTrue(button.waitForExistence(timeout: 8), "Category \(category) not reachable")
        button.tap()
        // The closed drawer stays in the tree (see `selectLocation`), so a `waitForNonExistence` always ran into
        // its whole timeout and still returned while the drawer slid — wait on its frame instead.
        _ = waitUntil(timeout: 4) { self.drawerOut(app, links: false) < 0.05 }
    }

    /// Choose the sort order in the menu of the filter bar. A `Picker` in the `Menu` appears directly or behind a
    /// submenu depending on the system — both ways are served.
    func selectChatSort(_ app: XCUIApplication, _ label: String) {
        selectSort(app, control: "chats-sort", label: label)
    }

    /// Height of a HEADER and a DATA cell of the same markdown table in the history.
    ///
    /// The two words are parameters because two tables can stand in the same history at once:
    /// one as an ordinary answer, one in a channel card. Identical labels would then be
    /// ambiguous, and `staticTexts[…]` would take any of them.
    func tableCellsHeights(
        _ app: XCUIApplication,
        header headerWord: String = "Dienst",
        cell cellWord: String = "Gateway"
    ) -> (CGFloat, CGFloat) {
        let header = app.staticTexts[headerWord]
        let cell = app.staticTexts[cellWord]
        XCTAssertTrue(header.waitForExistence(timeout: 25), "The table's header cell is missing")
        XCTAssertTrue(cell.waitForExistence(timeout: 10), "The table's data cell is missing")
        // The cell is estimated first and only afterwards asked for its real height —
        // whoever measures in between measures the estimate.
        Thread.sleep(forTimeInterval: 1.2)
        return (header.frame.height, cell.frame.height)
    }

    /// Change the text size without leaving the open chat: right drawer →
    /// settings → appearance → step → back and close the sheet.
    ///
    /// The swipe goes over the history, on purpose: the shell's pan recognizer hangs on the
    /// WINDOW, not on a surface below. A detour via the chats overview would be more
    /// convenient and would have reopened the chat — and the check "takes effect at once in the open
    /// conversation" would then no longer have checked exactly that.
    func changeTextSize(_ app: XCUIApplication, on stage: String) {
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 10),
                       "The right drawer did not open from the open chat")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 12),
                       "The settings sheet did not open")
        let row = settingsRow(app, "Appearance")
        XCTAssertTrue(row.isHittable, "The Appearance section is missing in the settings")
        row.tap()
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 15),
                       "The Appearance page was not opened")
        selectTextSize(app, stage)
        app.navigationBars["Appearance"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10),
                       "The way back did not lead into the settings")
        app.buttons["Done"].tap()
        _ = app.navigationBars["Settings"].waitForNonExistence(timeout: 8)
        swipeRightAcrossScreen(app)
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// The steps of the text-size control in their order (`TextSize.allCases`).
    static let textSizeStages = ["Compact", "Small", "Normal", "Large", "Extra large"]

    /// Choose a step on the text-size bar: one step per tap on A+ / A−, until the line
    /// below names the wanted one (the language is pinned to English in the test).
    ///
    /// The bar is tapped, not dragged: dragging a `Slider` across several detents in ONE move
    /// landed one step short in the simulator or triggered the iOS 26 back gesture. Taps on the
    /// two buttons are deterministic, and the bar stands at the same point on every step.
    func selectTextSize(_ app: XCUIApplication, _ stage: String) {
        guard let target = Self.textSizeStages.firstIndex(of: stage) else {
            return XCTFail("Unknown step \(stage)")
        }
        let slider = app.sliders["settings-text-size"]
        XCTAssertTrue(roleInSheet(app, slider), "The text-size bar is missing")
        let value = app.staticTexts["settings-text-size-value"]
        let larger = app.buttons["settings-text-size-larger"]
        let small = app.buttons["settings-text-size-smaller"]
        for _ in 0..<Self.textSizeStages.count {
            guard value.exists, let now = Self.textSizeStages.firstIndex(of: value.label), now != target else { break }
            let step = now < target ? 1 : -1
            (step > 0 ? larger : small).tap()
            let next = Self.textSizeStages[now + step]
            _ = waitForFixture(timeout: 4) { value.exists && value.label == next }
        }
        XCTAssertTrue(
            waitForFixture(timeout: 6) { value.exists && value.label == stage },
            "The text size is not at \(stage) (display: \(value.exists ? value.label : "–"))"
        )
        // The whole page reflows after a step — measure only afterwards.
        Thread.sleep(forTimeInterval: 0.35)
    }

    /// The height of the preview on the appearance page. The identifier sits on a block
    /// without an accessibility element of its own and therefore moves onto every child — so what is measured
    /// is the enclosing frame of ALL hits, not of the first.
    func previewHeight(_ app: XCUIApplication) -> CGFloat {
        let hits = app.descendants(matching: .any)
            .matching(identifier: "settings-text-size-preview")
            .allElementsBoundByIndex
            .filter { $0.exists }
        guard !hits.isEmpty else { return 0 }
        let frame = hits.map { $0.frame }
        let top = frame.map { $0.minY }.min() ?? 0
        let bottom = frame.map { $0.maxY }.max() ?? 0
        return bottom - top
    }

    // ── Helpers for the settings tests ──────────────────────────────────────
    /// The routine every settings test starts with: right drawer, "Settings",
    /// then the subpage via its TITLE. Since the section carries ten rows, scrolling is needed —
    /// `exists` would only mean "cell built" in a `List`.
    func openSettings(_ app: XCUIApplication, page: String) {
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8),
                       "The settings entry is missing in the right drawer")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 12),
                       "The settings sheet did not open")
        let row = settingsRow(app, page)
        XCTAssertTrue(row.isHittable, "The \(page) section is missing in the settings")
        row.tap()
        XCTAssertTrue(app.navigationBars[page].waitForExistence(timeout: 20),
                       "The \(page) page was not opened")
    }

    /// Scrolls in a settings list until the element is really operable.
    ///
    /// `scrollUntilHittable` starts its drag at dy 0.75 — and as soon as a text field has focus,
    /// the KEYBOARD lies there: the list did not move a single point, and the field below stayed unreachable for six
    /// attempts. If the keyboard stands, the drag therefore starts further up; the list has enough inset below it to
    /// push even the last row above it.
    ///
    /// "Operable" includes `isEnabled`, and that is not cosmetics:
    /// the three blocks of the hooks page lock their fields and buttons until they have READ their state
    /// from the server (`.disabled(!loaded)` in HooksExtras.swift) — otherwise a save
    /// would overwrite the state with the view's initial state. A locked SwiftUI control stays `isHittable`: the tap arrives, does
    /// nothing, and the test fails later at a completely different place. Against a local
    /// fixture that is milliseconds, so a flake instead of a break — and a flake in
    /// a helper hits every caller.
    func roleInSheet(_ app: XCUIApplication, _ element: XCUIElement, attempts: Int = 8) -> Bool {
        for _ in 0..<attempts {
            if element.exists, element.isHittable { return getsOperable(element) }
            let start = app.keyboards.count > 0 ? 0.5 : 0.75
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start - 0.25)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return element.exists && element.isHittable && getsOperable(element)
    }

    /// Waits IN PLACE until a visible control is also operable.
    ///
    /// Deliberately without scrolling: an element that is already in view does not become operable through another
    /// drag — it would only push it out again. The lock hangs on loading, and
    /// that needs time, not movement.
    func getsOperable(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if element.isEnabled { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return element.isEnabled
    }

    /// Like `roleInSheet`, only in the opposite direction.
    ///
    /// Needed where what is sought lies ABOVE the current position: a pushed view
    /// returns the list where its caller stood, and a button above that point is
    /// unreachable forever by scrolling down. The drag starts in the middle of the screen and
    /// stays short — a long drag downward would, in a sheet, pull not the list but the
    /// sheet itself.
    func scrollUp(_ app: XCUIApplication, _ element: XCUIElement, attempts: Int = 5) -> Bool {
        for _ in 0..<attempts {
            if element.exists, element.isHittable { return getsOperable(element) }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return element.exists && element.isHittable && getsOperable(element)
    }

    /// Flips a SwiftUI `Toggle` in a settings list whose label carries several
    /// paragraphs — and taps the INNER switch for that, not the row.
    ///
    /// The accessibility element with the identifier is the WHOLE row (label plus switch);
    /// the credit gate's is 293 pt high. A tap in its middle hits the paragraph, not the switch — and the old
    /// fallback "tap again right in the middle" landed after scrolling at y = 43, behind the header bar,
    /// although `isHittable` on the row said yes. The inner switch is 63×28 pt: ITS
    /// centre is the button. Scrolling goes in both directions — the row can lie above as
    /// below the screen, depending on what the test searched for before.
    ///
    /// And `isHittable` alone does not suffice at the button either: below the glass header bar of the
    /// settings sheet (y 78–132) it says yes, but the tap hits the bar — measured
    /// at y = 70. The button must therefore stand in a SAFE BAND: below the header bar,
    /// above the home bar.
    @discardableResult
    func flipToggle(_ app: XCUIApplication, _ toggle: XCUIElement) -> Bool {
        let button = toggle.switches.firstMatch
        let top = app.frame.minY + 150
        let bottom = app.frame.maxY - 60
        let inBand: () -> Bool = {
            button.exists && button.frame.midY >= top && button.frame.midY <= bottom && button.isHittable
        }
        for _ in 0..<12 {
            if inBand() { break }
            // If the button lies above the band (or under the bar), a drag downward pulls it
            // down; if it lies below or the row is not built at all yet, a drag
            // upward pulls the list further. Short drags from the middle of the screen — a long drag downward
            // would, in a sheet, pull not the list but the sheet itself.
            let downward = button.exists && button.frame.midY < top
            let start = downward ? 0.45 : 0.7
            let target = downward ? 0.67 : 0.48
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: target)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        guard inBand(), getsOperable(button) else { return false }
        button.tap()
        return true
    }

    /// A row of the settings root list, reliably hit.
    ///
    /// Two things stand in the way: behind the sheet lies the right drawer, whose
    /// categories are partly named the same ("Browser") — an ambiguous query is answered usefully by neither
    /// `exists` nor `isHittable`. And since the list carries ten rows, the
    /// lower ones lie outside the screen depending on the device height. The OPERABLE
    /// hit is therefore taken, after a scroll if need be.
    /// On top of a SecureField iOS occasionally offers "Use Strong Password?" unasked. The
    /// sheet covers the lower half of the screen, and every button below it is then neither
    /// reachable nor `isHittable` — measured exactly like this twice (screenshot in the xcresult),
    /// in the following run it stayed away. It comes unreliably, and a test that does not clear it
    /// becomes unreliable with it. If no sheet stands, the function does nothing.
    func closePasswordSuggestion(_ app: XCUIApplication) {
        let sheet = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'Strong Password' OR label CONTAINS[c] 'starkes Passwort'")
        ).firstMatch
        guard sheet.waitForExistence(timeout: 1.5) else { return }
        // The close button carries the language of the SYSTEM, not of the app (the sheet came in
        // English over the German interface). If it is not found, the X at the top right is tapped
        // via its position relative to the big button — measured about 210 pt above it.
        let close = app.buttons.matching(
            NSPredicate(format: "identifier == 'Close' OR label IN {'Close', 'Schließen', 'Abbrechen', 'Cancel'}")
        ).allElementsBoundByIndex.first { $0.exists && $0.isHittable }
        if let close {
            close.tap()
        } else {
            let frame = sheet.frame
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: frame.maxX - 12, dy: frame.minY - 210))
                .tap()
        }
        _ = sheet.waitForNonExistence(timeout: 5)
    }

    func settingsRow(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        let query = app.staticTexts.matching(NSPredicate(format: "label == %@", title))
        for attempt in 0..<7 {
            if let hits = query.allElementsBoundByIndex.first(where: { $0.isHittable }) {
                return hits
            }
            if attempt == 0 {
                // The first time only wait: the list may still be building, and scrolling
                // would push the sought row out of view all the more.
                Thread.sleep(forTimeInterval: 0.6)
                continue
            }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return query.allElementsBoundByIndex.first(where: { $0.isHittable }) ?? query.firstMatch
    }

    /// The sections of the settings root list in the order in which a user gets to see them when
    /// scrolling down. **Expects the list at the top at the start** — so the caller
    /// calls it right after opening the sheet, before anything has scrolled.
    ///
    /// Read section by section, for a reason no single query gets around:
    /// the list is lazy and longer than any phone — what is not in view
    /// does not exist in the tree at all. So what is visible NOW is taken (sorted by
    /// position), then the list scrolls and what newly appeared is appended at the end.
    ///
    /// Scrolling goes exclusively DOWN. Rolling back up first for safety
    /// pulled the SHEET down until it closed; the right drawer behind it was read
    /// afterwards, which carries a category "Browser". A drag downward on a list that already stands at the top
    /// is no scrolling in a sheet but a closing.
    ///
    /// Only OPERABLE hits below the navigation bar count — that is how the covered
    /// drawer drops out. If the bar disappears, the sheet is gone and every further measurement
    /// would be invented: the function then aborts and says so.
    func settingsOrder(_ app: XCUIApplication, _ expected: [String]) -> [String] {
        var followUp: [String] = []
        for _ in 0..<12 {
            let bar = app.navigationBars["Settings"]
            guard bar.exists else {
                XCTFail("The settings sheet closed while reading (so far: \(followUp))")
                return followUp
            }
            let headerEdge = bar.frame.maxY
            var visible: [(String, CGFloat)] = []
            var searched = Set<String>()
            for title in expected where !searched.contains(title) {
                searched.insert(title)
                // A wording may be expected MORE THAN ONCE (group "Administration" and its page
                // "Administration"). What is still missing is counted per wording — namely the LOWEST hits: the list
                // scrolls from top to bottom, newly scrolled-in rows stand at the bottom, already counted ones above.
                let still = expected.filter { $0 == title }.count - followUp.filter { $0 == title }.count
                guard still > 0 else { continue }
                let hits = app.staticTexts
                    .matching(NSPredicate(format: "label == %@", title))
                    .allElementsBoundByIndex
                    .filter { $0.isHittable && $0.frame.minY > headerEdge - 1 }
                    .map(\.frame.minY)
                    .sorted()
                for y in hits.suffix(still) { visible.append((title, y)) }
            }
            followUp += visible.sorted { $0.1 < $1.1 }.map(\.0)
            if followUp.count == expected.count { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.4)
        }
        return followUp
    }

    /// The GitLab part of the check state. An empty dictionary means "not reachable" — the
    /// wait conditions then fail by themselves instead of asserting a wrong value.
    func fixtureGitlab(_ server: String) -> [String: Any] {
        (fixtureSettings(server)?["gitlab"] as? [String: Any]) ?? [:]
    }

    /// What the fixture gateway REALLY stored of the new settings. The value in
    /// the view is set optimistically and does not prove delivery.
    func fixtureSettings(_ server: String) -> [String: Any]? {
        fixtureJSON(server + "/fixture/settings")
    }

    /// Open the sort menu of a section and choose an entry. Depending on the situation the `Picker` in the `Menu` comes as a
    /// submenu "Sorting" — then go in there first.
    func selectSort(_ app: XCUIApplication, control: String, label: String) {
        app.buttons[control].tap()
        if !app.buttons[label].waitForExistence(timeout: 3), app.buttons["Sorting"].exists {
            app.buttons["Sorting"].tap()
        }
        XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "Sort order \(label) is missing")
        app.buttons[label].tap()
        // Wait until the menu is really closed — a fixed wait was too tight
        // once the picker had four entries (the tap then landed in the closing menu).
        _ = app.buttons[label].waitForNonExistence(timeout: 6)
        Thread.sleep(forTimeInterval: 0.35)
    }

    /// Open the first chat of the current list without changing the scope.
    func openFirstChatInProject(_ app: XCUIApplication) throws {
        let chat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        guard chat.waitForExistence(timeout: 15) else {
            attach(app, "Project overview without chats")
            throw XCTSkip("No chat in the project")
        }
        chat.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20))
    }

    func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isHittable { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// Waits until a condition becomes true — for states that are not an element appearing
    /// (a label that changes its text, a value on the button).
    func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// Counterpart of `waitForExistence`: waits until an element has DISAPPEARED.
    /// `XCTAssertFalse(waitForExistence(...))` does not do for that — it returns at once
    /// as long as the element still stands, and would fail on every animation.
    func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// After signing in iOS offers "Save Password?" — the system dialog lies
    /// above the app and must go before the walkthrough continues.
    func dismissSystemPasswordPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Not Now", "Later", "Nicht jetzt"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 5) {
                button.tap()
                return
            }
        }
    }

    /// Fetch an input field. Depending on state, `TextField(axis: .vertical)` arrives in the shell as a
    /// text field OR as a text view — accept both, or the test fails on the type.
    func textEntry(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        let field = app.textFields[identifier]
        if field.waitForExistence(timeout: 6) { return field }
        return app.textViews[identifier]
    }

    /// REPLACE a prefilled field. Three measured traps compared to `clearAndType`:
    ///  • `TextField(axis: .vertical)` does not report its `value` reliably — the number of
    ///    delete keys would then be 0. So a fixed, generous number.
    ///  • A tap in the MIDDLE put the insertion point at the start of the text, the new title then stood
    ///    BEFORE the old one ("Rebuild checkoutOld title"). So tap at the right edge.
    ///  • The typed text then stood in the field as a composition not yet committed: the
    ///    view showed it, SwiftUI's binding did not have it — "Save" did not enable and nothing
    ///    went to the server. A trailing space ends the composition; the app
    ///    trims whitespace on saving anyway.
    func replaceText(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 60))
        field.typeText(text + " ")
    }

    /// Clear the field and fill it anew — prefills must not distort the value.
    func clearAndType(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let existing = (field.value as? String) ?? ""
        if !existing.isEmpty, existing != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        field.typeText(text)
    }

    func swipeRightAcrossScreen(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5))
        start.press(forDuration: 0.02, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.05)
    }

    func swipeLeftAcrossScreen(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5))
        start.press(forDuration: 0.02, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.05)
    }

    /// A short, SLOW drag over about a third of the width. Deliberately `.slow` and with a hold
    /// at the end: that makes the release velocity roughly zero, so the DISTANCE alone
    /// decides. Exactly that is what the rest-position tests check — no flick as a way out.
    func dragSlowly(_ app: XCUIApplication, fromX: CGFloat, toX: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: 0.5))
        start.press(forDuration: 0.08, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.35)
    }

    /// How far a drawer is out (0 closed, 1 open), measured on the FRAME. `exists` does not do for that: both
    /// drawers stay mounted and stand closed with a full frame in the tree, offset by 35 % of their width towards their own
    /// edge (`AppShell`: `.offset(x: -drawerWidth * 0.35 * (1 - leftDrawerProgress))`, mirrored on the right).
    func drawerOut(_ app: XCUIApplication, links: Bool) -> CGFloat {
        let drawer = app.otherElements[links ? "left-drawer" : "right-drawer"].firstMatch
        guard drawer.exists else { return 0 }
        let frame = drawer.frame, window = app.windows.firstMatch.frame
        guard frame.width > 0 else { return 0 }
        let offset = links ? window.minX - frame.minX : frame.maxX - window.maxX
        return min(1, max(0, 1 - offset / (frame.width * 0.35)))
    }

    /// Close an open drawer: tap outside (the dimming catches the tap).
    /// Wait briefly until a running movement is finished — tapping in the middle of
    /// the closing animation puts the tap on the content behind it (in the chats overview
    /// on a chat row, which then opens a chat). Tapping happens ONLY beside an open
    /// drawer: the helper used to ask `exists`, which is always true for both —
    /// after closing the left one the second tap landed at 0.04 in the content (in the library
    /// of the dynamic workflows on a row whose sheet swallowed the next tap), when
    /// closing the right one the first at 0.96 in the drawer itself.
    func closeDrawers(_ app: XCUIApplication) {
        Thread.sleep(forTimeInterval: 0.45)
        if drawerOut(app, links: true) > 0.5 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.5)).tap()
        }
        if drawerOut(app, links: false) > 0.5 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5)).tap()
        }
        _ = waitUntil(timeout: 3) {
            drawerOut(app, links: true) < 0.02 && drawerOut(app, links: false) < 0.02
        }
    }

    /// Share of the pixels in `rect` that do NOT match the most frequent grey value.
    /// An empty area is single-coloured — the value is then close to 0. This is the only
    /// check for "the history is black/empty" that works without knowing the messages,
    /// so also against real chats on the live gateway.
    func inkRatio(_ app: XCUIApplication, in rect: CGRect) -> Double {
        guard let full = app.screenshot().image.cgImage, app.frame.width > 0 else { return 0 }
        let scale = CGFloat(full.width) / app.frame.width
        let area = CGRect(
            x: (rect.minX * scale).rounded(),
            y: (rect.minY * scale).rounded(),
            width: (rect.width * scale).rounded(),
            height: (rect.height * scale).rounded()
        )
        guard let crop = full.cropping(to: area), crop.width > 0, crop.height > 0 else { return 0 }
        let width = crop.width, height = crop.height
        var gray = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &gray,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        var histogram = [Int](repeating: 0, count: 256)
        for value in gray { histogram[Int(value)] += 1 }
        return 1 - Double(histogram.max() ?? 0) / Double(gray.count)
    }

    /// Share of clearly green pixels in `rect`. The fixture browser image carries a green
    /// corner — the rotation of the desktop view can be read from it in the screenshot.
    func greenShare(_ app: XCUIApplication, in rect: CGRect) -> Double {
        guard let full = app.screenshot().image.cgImage, app.frame.width > 0 else { return 0 }
        let scale = CGFloat(full.width) / app.frame.width
        let area = CGRect(
            x: (rect.minX * scale).rounded(),
            y: (rect.minY * scale).rounded(),
            width: max(1, (rect.width * scale).rounded()),
            height: max(1, (rect.height * scale).rounded())
        )
        guard let crop = full.cropping(to: area), crop.width > 0, crop.height > 0 else { return 0 }
        let width = crop.width, height = crop.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return 0 }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        var green = 0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let red = Int(pixels[index]), grn = Int(pixels[index + 1]), blue = Int(pixels[index + 2])
            if grn > red + 40 && grn > blue + 40 { green += 1 }
        }
        return Double(green) / Double(width * height)
    }

    /// Lower quarter of the history — the newest message MUST stand there.
    /// How clearly the DARKEST pixel in `rect` stands out from the background (0…255). The
    /// background is the most frequent grey value of the area. That lets one check whether a
    /// font is visible at all — elements "exist" in XCUITest even when their
    /// colour makes them unreadable.
    func inkContrast(_ app: XCUIApplication, in rect: CGRect) -> Int {
        guard let full = app.screenshot().image.cgImage, app.frame.width > 0 else { return 0 }
        let scale = CGFloat(full.width) / app.frame.width
        let area = CGRect(
            x: (rect.minX * scale).rounded(),
            y: (rect.minY * scale).rounded(),
            width: max(1, (rect.width * scale).rounded()),
            height: max(1, (rect.height * scale).rounded())
        )
        guard let crop = full.cropping(to: area), crop.width > 0, crop.height > 0 else { return 0 }
        let width = crop.width, height = crop.height
        var gray = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &gray,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        var histogram = [Int](repeating: 0, count: 256)
        for value in gray { histogram[Int(value)] += 1 }
        let background = histogram.firstIndex(of: histogram.max() ?? 0) ?? 255
        let darkest = gray.map(Int.init).min() ?? background
        return abs(background - darkest)
    }

    func timelineTailInk(_ app: XCUIApplication) -> Double {
        let frame = app.descendants(matching: .any)["chat-timeline"].frame
        let tail = CGRect(
            x: frame.minX,
            y: frame.maxY - frame.height * 0.25,
            width: frame.width,
            height: frame.height * 0.25
        )
        return inkRatio(app, in: tail)
    }

    /// The lift column of the frame-by-frame trace (`KeyboardTrace`, DEBUG only). Rows with "S"
    /// are samples, rows with "E" mere event notes.
    /// The three measurement series of the entrance trace (`ChatEntranceTrace`): opacity and position of the
    /// new row and the position of the row directly above it, per frame.
    func entranceTrace(_ path: String) throws -> ([Double], [Double], [Double]) {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("The entrance trace was not written (\(path)) — DEBUG build only.")
        }
        var opacity: [Double] = []
        var enterY: [Double] = []
        var aboveY: [Double] = []
        for line in text.split(separator: "\n") {
            let columns = line.split(separator: ",", omittingEmptySubsequences: false)
            guard columns.count > 4, columns[0] == "S" else { continue }
            guard let o = Double(columns[2]), let e = Double(columns[3]), let a = Double(columns[4])
            else { continue }
            opacity.append(o)
            enterY.append(e)
            aboveY.append(a)
        }
        return (opacity, enterY, aboveY)
    }

    /// The NOTES of the entrance trace (row kind "E") in their order: one per push,
    /// and their first word names the PATH `Coordinator.apply` took — "shifted"
    /// (`pushUp`, the history fills the window) or "fade only" (short history, nothing
    /// moves up). The first push whose note contains the filter `CBASE_ENTRANCE_TRACE_KIND` is
    /// followed (that is, measured in the S rows) — so this list is the only
    /// place where a test can check WHICH of the two paths it is measuring.
    func entranceNotes(_ path: String) throws -> [String] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("The entrance trace was not written (\(path)) — DEBUG build only.")
        }
        return text.split(separator: "\n").compactMap { line in
            let columns = line.split(separator: ",", omittingEmptySubsequences: false)
            guard columns.count > 5, columns[0] == "E" else { return nil }
            return columns[5...].joined(separator: ",").trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
    }

    /// The SCREEN POSITION of the followed history row per frame (column `screenY`) — the
    /// distance of its top edge from the window's bottom edge. Only this quantity shows what the
    /// user sees: the position in content space already moves on insertion, the scroll offset
    /// moves on catching up, and only their difference is the movement on screen.
    ///
    /// ONE array PER PUSH comes back (the "E" rows of the trace separate them): one send
    /// pushes several times in quick succession — own row with run indicator, then the
    /// first tool call, then the answer. Measured over all pushes together, the
    /// path would be the SUM, and a jump of a third of a single push would no longer
    /// stand out in it.
    func entranceScreenSegments(_ path: String) throws -> [[Double]] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("The entrance trace was not written (\(path)) — DEBUG build only.")
        }
        var segments: [[Double]] = []
        for line in text.split(separator: "\n") {
            let columns = line.split(separator: ",", omittingEmptySubsequences: false)
            guard let kind = columns.first else { continue }
            if kind == "E" {
                segments.append([])
                continue
            }
            guard kind == "S", columns.count > 6, let y = Double(columns[6]) else { continue }
            if segments.isEmpty { segments.append([]) }
            segments[segments.count - 1].append(y)
        }
        return segments
    }

    /// The same pushes as `entranceScreenSegments`, but WITH the timestamp per sample
    /// (column `t`, seconds since the start of the trace). It is needed wherever
    /// a bound "per FRAME" applies: the trace is a `CADisplayLink`, and under load it
    /// drops — two consecutive samples then lie three frames apart, and the
    /// difference between them is the movement of THREE frames. Without the time "one step
    /// of the trace" is not "one frame", and a jump bound measures the machine instead of the
    /// animation.
    func entranceScreenSegmentsTimed(_ path: String) throws -> [[(t: Double, y: Double)]] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("The entrance trace was not written (\(path)) — DEBUG build only.")
        }
        var segments: [[(t: Double, y: Double)]] = []
        for line in text.split(separator: "\n") {
            let columns = line.split(separator: ",", omittingEmptySubsequences: false)
            guard let kind = columns.first else { continue }
            if kind == "E" {
                segments.append([])
                continue
            }
            guard kind == "S", columns.count > 6, let t = Double(columns[1]), let y = Double(columns[6])
            else { continue }
            if segments.isEmpty { segments.append([]) }
            segments[segments.count - 1].append((t: t, y: y))
        }
        return segments
    }

    func liftTrace(_ path: String) throws -> [Double] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("The motion trace was not written (\(path)) — DEBUG build only.")
        }
        return text.split(separator: "\n").compactMap { line in
            let columns = line.split(separator: ",", omittingEmptySubsequences: false)
            guard columns.count > 2, columns[0] == "S" else { return nil }
            return Double(columns[2])
        }
    }

    func attach(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "cbase Mobile – \(name)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func reachable(_ server: String) -> Bool {
        guard let url = URL(string: server + "/api/health") else { return false }
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var reachable = false
        URLSession.shared.dataTask(with: url) { _, response, _ in
            lock.lock()
            reachable = (response as? HTTPURLResponse)?.statusCode == 200
            lock.unlock()
            finished.signal()
        }.resume()
        guard finished.wait(timeout: .now() + 4) == .success else { return false }
        lock.lock()
        defer { lock.unlock() }
        return reachable
    }

    /// Small GET helper for the check states of the fixture (`/fixture/...`).
    func fixtureJSON(_ url: String, method: String = "GET") -> [String: Any]? {
        guard let target = URL(string: url) else { return nil }
        var request = URLRequest(url: target)
        request.httpMethod = method
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { finished.signal() }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            lock.lock()
            result = object
            lock.unlock()
        }.resume()
        guard finished.wait(timeout: .now() + 4) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    /// Like `fixtureJSON`, only with a JSON body — for the fixture's control endpoints.
    func fixturePost(_ url: String, body: [String: Any]) -> [String: Any]? {
        guard let target = URL(string: url),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { finished.signal() }
            // EVERY 2xx counts: create routes answer with 201, and that is no failure.
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(code), let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            lock.lock()
            result = object
            lock.unlock()
        }.resume()
        guard finished.wait(timeout: .now() + 4) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    func fixtureTerminalGrid(_ server: String) -> (cols: Int, rows: Int)? {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/terminal"),
               let cols = state["cols"] as? Int, let rows = state["rows"] as? Int, cols > 0 {
                return (cols, rows)
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return nil
    }

    @discardableResult
    func resetFixtureBrowser(_ server: String) -> Bool {
        fixtureJSON(server + "/fixture/browser", method: "DELETE") != nil
    }

    /// Pull a half-height sheet to full height at its title (the title lies outside the
    /// scroll view — the resize takes effect there, inside only the content would scroll).
    func expandSheet(_ app: XCUIApplication) {
        app.staticTexts["Git"].firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(
            forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)),
            withVelocity: .default,
            thenHoldForDuration: 0.1
        )
        Thread.sleep(forTimeInterval: 0.5)
    }

    /// Scrolls down until the element is reachable. `exists` does not suffice: a
    /// scroll view builds its rows ahead of time, so they exist outside the screen too.
    func scrollUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, attempts: Int = 6) -> Bool {
        for _ in 0..<attempts {
            if element.exists, element.isHittable { return true }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return element.exists && element.isHittable
    }

    // ── Effort selection ──
    // The four effort pickers of the app (chat settings, new chat, change a step, workflow settings)
    // are ONE building block (`Kit/EffortSelection.swift`). The tests of the four places hold what each one shows —
    // entries, order, the word of the empty entry, the marker of a grade that is not carried.

    /// The row of a form picker via the start of its label ("Effort", "Model" …): the row is a
    /// button whose label carries the chosen value.
    func pickerRow(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    /// Choose a value in a form picker — the menu item via its LABEL (SwiftUI does not pass identifiers
    /// down to the UIKit action of a menu).
    func selectInPicker(_ app: XCUIApplication, _ title: String, _ choice: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = pickerRow(app, title)
        XCTAssertTrue(scrollUntilHittable(app, row), "The row '\(title)' is not reachable", file: file, line: line)
        row.tap()
        let point = app.buttons[choice]
        XCTAssertTrue(point.waitForExistence(timeout: 6), "'\(choice)' is missing in the menu '\(title)'", file: file, line: line)
        point.tap()
        XCTAssertTrue(waitUntil(timeout: 6) { self.pickerRow(app, title).label.contains(choice) },
                      "The choice '\(choice)' did not arrive in the row '\(title)': \(pickerRow(app, title).label)", file: file, line: line)
    }

    /// Opens the effort picker and holds its menu items against `expected`: each one there, from top to bottom in this
    /// order, no further effort word beside them and exactly as many "runs as" markers as expected. Closes
    /// the menu with a tap on `choice`.
    func checkEffortSelection(_ app: XCUIApplication, _ expected: [String], choice: String, _ place: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let row = pickerRow(app, "Effort")
        XCTAssertTrue(scrollUntilHittable(app, row), "\(place): the effort row is not reachable", file: file, line: line)
        row.tap()
        let points = expected.map { app.buttons[$0] }
        XCTAssertTrue(points[0].waitForExistence(timeout: 6), "\(place): the effort menu does not open or does not begin with '\(expected[0])'", file: file, line: line)
        for (word, point) in zip(expected, points) {
            XCTAssertTrue(point.exists, "\(place): '\(word)' is missing in the effort menu", file: file, line: line)
        }
        let ys = points.map(\.frame.minY)
        XCTAssertEqual(ys, ys.sorted(), "\(place): the entries are not in the order \(expected): \(ys)", file: file, line: line)
        for word in ["Auto", "Automatic", "Low", "Medium", "High", "X-High", "Max"] where !expected.contains(word) {
            XCTAssertFalse(app.buttons[word].exists, "\(place): '\(word)' stands in the effort menu, it was not expected", file: file, line: line)
        }
        // The picker row itself carries the chosen value in its label ("Effort, Max · runs as X-High") —
        // only the menu items are counted.
        let markers = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH %@)", "runs as", "Effort")).count
        XCTAssertEqual(markers, expected.filter { $0.contains("runs as") }.count, "\(place): the number of marked entries", file: file, line: line)
        attach(app, "Effort selection: \(place)")
        app.buttons[choice].tap()
        XCTAssertTrue(waitUntilGone(points[0], timeout: 6), "\(place): the effort menu does not close", file: file, line: line)
    }

    /// Does the fixture project have a repository? Also resets the state to the start.
    func setFixtureGit(_ server: String, hasRepo: Bool) -> Bool {
        fixturePost(server + "/fixture/git", body: ["repo": hasRepo]) != nil
    }

    /// Makes the fixture's git fetch fail (HTTP 500) — without losing the file state,
    /// so "it worked before" and "now it does not" can be checked in the same test.
    func setFixtureGit(_ server: String, failing: Bool) -> Bool {
        fixturePost(server + "/fixture/git", body: ["fail": failing]) != nil
    }

    /// Waits for a condition at the fixture (the app writes asynchronously).
    /// The share sheet (UIActivityViewController) carries different names depending on the iOS version —
    /// so check several traits instead of guessing one.
    func shareSheetAppears(_ app: XCUIApplication, timeout: TimeInterval = 12) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.otherElements["ActivityListView"].exists { return true }
            if app.buttons["Copy"].exists || app.buttons["Copy"].exists { return true }
            if app.cells["In \"Dateien\" speichern"].exists || app.cells["Save to Files"].exists { return true }
            if app.buttons["In \"Dateien\" speichern"].exists || app.buttons["Save to Files"].exists { return true }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return false
    }

    /// Close the share sheet. "Cancel" does not exist on every device, then
    /// swiping it down remains. Waits until it is really gone — a sheet that is still open
    /// swallows the next touch.
    func dismissShareSheet(_ app: XCUIApplication) {
        let gone = { !app.otherElements["ActivityListView"].exists && !app.buttons["Copy"].exists && !app.buttons["Copy"].exists }
        for label in ["Cancel", "Cancel", "Close", "Close"] {
            let button = app.buttons[label]
            if button.exists, button.isHittable { button.tap(); break }
        }
        for _ in 0..<3 {
            if gone() { break }
            app.swipeDown(velocity: .fast)
            Thread.sleep(forTimeInterval: 0.7)
        }
        _ = waitForFixture(timeout: 5, until: gone)
    }

    /// Pull the code drawer open again. `exists` does not suffice: it stays mounted and
    /// lies closed only outside the screen — so touchability is checked.
    func ensureCodeDrawerOpen(_ app: XCUIApplication, row: String) {
        let row = app.buttons.matching(identifier: row).firstMatch
        for _ in 0..<4 {
            if row.exists, row.isHittable { return }
            swipeRightAcrossScreen(app)
            Thread.sleep(forTimeInterval: 0.7)
        }
    }

    /// Open the context menu of a row — with retries, EACH in a fresh process.
    ///
    /// `press(forDuration:)` does not arrive reliably as a long press in this shell: in
    /// about every second PROCESS the app treats the touch as a TAP (measurable by a
    /// folder then unfolding instead of showing a menu) — no menu item is then visible,
    /// not even the old "Rename"/"Delete". So it is no problem of this entry
    /// but of the synthetic touch; with a finger the menu appears. MEASURED on the
    /// chat row of the same family (about 140 presses): the first press went through as a tap in 24 of 46 fresh
    /// processes, press kind and duration without influence — and the state STICKS to the
    /// process (after a tap, again a tap in 6 of 10). Six attempts in the SAME process
    /// were therefore almost worthless; what rolls anew is a
    /// restart — `restart` then brings the app back to the row (category, drawer).
    ///
    /// `proof` is ANOTHER item of the same menu: if it stands there after the press and did not stand
    /// there before, the menu is open and `item` is missing in it — then that is the regression,
    /// not the gesture, and the helper reports it red at once instead of hiding it behind eight restarts.
    /// It is measured differentially, because an unbound label also hits
    /// collapsed things in the tree.
    /// The heading of a status row of the history. A status row's
    /// heading and sentence stand in ONE text ("Heading · sentence") — a text that carries ONLY the heading exists only
    /// if the sentence is empty. The query `staticTexts["Heading"]` therefore never hit (red when positive, empty when negative).
    func statusHeader(_ app: XCUIApplication, _ header: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", header, header + " · ")).firstMatch
    }

    /// A menu item via its label — without the archive button in the list header: the button
    /// ("Archive", the archive; identifier `…-archive`) and the menu item "Archive" (to archive) are named
    /// the same. Without the exclusion the context menu would count as open before it is there.
    func menuItem(_ app: XCUIApplication, _ item: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "(label == %@ OR identifier == %@) AND NOT (identifier ENDSWITH %@)", item, item, "-archive"
        )).element
    }

    func openContextMenu(
        _ app: XCUIApplication, row: String, expecting item: String,
        proof: String? = nil, restart: ((XCUIApplication) -> Void)? = nil
    ) -> Bool {
        // `firstMatch`: a folder row of the overview carries its identifier on TWO buttons (unfold and
        // "Open folder" — the identifier on the stack applies to both), and a press on an ambiguous query aborts
        // with "Multiple matching elements". The context menu hangs on the whole row.
        let target = app.buttons.matching(identifier: row).firstMatch
        guard target.waitForExistence(timeout: 10) else { return false }
        let other = proof.map { app.buttons.matching(NSPredicate(format: "label == %@", $0)).firstMatch }
        // Without `restart` it stays with the old picture (six attempts in one process) — then
        // the caller bears the dice quota itself.
        let attempts = restart == nil ? 6 : 8
        for attempt in 0..<attempts {
            if attempt > 0, let restart {
                app.terminate()
                app.launch()
                restart(app)
                guard target.waitForExistence(timeout: 25) else { return false }
            }
            ensureCodeDrawerOpen(app, row: row)
            let otherPrior = other?.exists ?? false
            // Both press kinds alternately. Measured: pressed on the ELEMENT, the file case goes
            // through, on the COORDINATE the folder case — and not the other way round. The reason is
            // two different failures of the same artifact: if a folder unfolds through the
            // mistaken tap, SwiftUI rebuilds all rows and an element press fizzles; if
            // a file opens, the drawer closes and a fixed coordinate points into the void.
            if attempt.isMultiple(of: 2) {
                target.press(forDuration: 1.2)
            } else {
                target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2)
            }
            if menuItem(app, item).waitForExistence(timeout: 4) { return true }
            if let other, other.exists, !otherPrior {
                attach(app, "Context menu without '\(item)'")
                XCTFail(
                    "The row \(row)'s context menu is there (item '\(proof ?? "")' present), but '\(item)' is missing in it"
                )
                return false
            }
            print("Context menu \(row) attempt \(attempt + 1): no menu (\(attempt.isMultiple(of: 2) ? "element" : "coordinate"))")
            // A half-open menu would swallow the next press: tap away. The tap
            // goes into the status bar — if the menu is not open, it hits nothing operable.
            if attempt < attempts - 1, restart == nil {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01)).tap()
                Thread.sleep(forTimeInterval: 0.9)
            }
        }
        return false
    }

    func waitForFixture(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return condition()
    }

    /// Waits until the fixture's git state meets the condition (the app writes asynchronously).
    func waitForFixtureGit(
        _ server: String,
        timeout: TimeInterval,
        matching predicate: ([[String: Any]]) -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let files = (fixtureJSON(server + "/fixture/git")?["files"] as? [[String: Any]]) ?? []
            if predicate(files) { return true }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return false
    }

    func waitForFixtureViewport(
        _ server: String,
        timeout: TimeInterval,
        matching predicate: (CGSize) -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/browser"),
               let viewport = state["viewport"] as? [String: Any],
               let width = viewport["width"] as? Double ?? (viewport["width"] as? Int).map(Double.init),
               let height = viewport["height"] as? Double ?? (viewport["height"] as? Int).map(Double.init),
               predicate(CGSize(width: width, height: height)) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return false
    }

    /// Waits for the next logged mouse click and returns its page coordinate.
    func waitForFixtureClick(_ server: String, timeout: TimeInterval) -> CGPoint? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/browser"),
               let inputs = state["inputs"] as? [[String: Any]] {
                let press = inputs.first { ($0["type"] as? String) == "mousePressed" }
                if let press,
                   let x = press["x"] as? Double ?? (press["x"] as? Int).map(Double.init),
                   let y = press["y"] as? Double ?? (press["y"] as? Int).map(Double.init) {
                    return CGPoint(x: x, y: y)
                }
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return nil
    }

    /// Sum of the reported wheel movement (deltaY) — the sign shows the scroll direction.
    func waitForFixtureWheel(_ server: String, timeout: TimeInterval) -> Double? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/browser"),
               let inputs = state["inputs"] as? [[String: Any]] {
                let deltas = inputs
                    .filter { ($0["type"] as? String) == "mouseWheel" }
                    .compactMap { $0["deltaY"] as? Double ?? ($0["deltaY"] as? Int).map(Double.init) }
                if !deltas.isEmpty { return deltas.reduce(0, +) }
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return nil
    }

    func fixtureCreateCount(_ server: String) -> Int? {
        guard let url = URL(string: server + "/fixture/state") else { return nil }
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var count: Int?
        URLSession.shared.dataTask(with: url) { data, response, _ in
            defer { finished.signal() }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let value = object["chatCreateCount"] as? Int else { return }
            lock.lock()
            count = value
            lock.unlock()
        }.resume()
        guard finished.wait(timeout: .now() + 3) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func setFixtureHistory(
        _ server: String,
        count: Int,
        stress: Bool = false,
        delayMs: Int = 0,
        markdown: Bool = false,
        invisible: Bool = false
    ) -> Bool {
        guard let url = URL(string: server + "/fixture/history"),
              let data = try? JSONSerialization.data(withJSONObject: [
                "count": count,
                "stress": stress,
                "delayMs": delayMs,
                "markdown": markdown,
                "invisible": invisible,
              ]) else {
            return false
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var succeeded = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            lock.lock()
            succeeded = (response as? HTTPURLResponse)?.statusCode == 200
            lock.unlock()
            finished.signal()
        }.resume()
        guard finished.wait(timeout: .now() + 5) == .success else { return false }
        lock.lock()
        defer { lock.unlock() }
        return succeeded
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Further helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /// The fixture's second workspace — only behind the switch `secondWorkspace`.
    static let fixtureWorkspaceId2 = "10000000-0000-4000-8000-000000000002"

    /// Retract the keyboard via the drag zone if it is open — so the card or the
    /// history below it is reachable again (same pattern as in the run-indicator tests).
    func slideInKeyboard(_ app: XCUIApplication) {
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        guard app.keyboards.firstMatch.exists, handle.exists else { return }
        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: start.withOffset(CGVector(dx: 0, dy: 330)),
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// The RUNNING collection row — a `chat-tool-row` whose value is "running". A light band runs
    /// across the sentence, and the only measurable sign of that is the button's value (translated; the tests
    /// run with `-AppleLanguages (en)`). XCUITest does not see the band itself.
    func runningToolRow(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "chat-tool-row")
            .matching(NSPredicate(format: "value == %@", "running")).firstMatch
    }

    /// Everything readable of a row: the button's composed label plus the labels of its
    /// child texts. A button made of several `Text` parts usually carries them comma-separated in the
    /// label; the child texts are the fallback if a part does not arrive there.
    func rowsText(_ element: XCUIElement) -> String {
        let children = element.staticTexts.allElementsBoundByIndex.map(\.label)
        return ([element.label] + children).joined(separator: " | ")
    }

    /// Grey values of the pixels in `rect`, sampled coarsely (every 4th pixel per axis). Two
    /// captures of the same area differ if its content has scrolled.

    func pixelSignature(_ app: XCUIApplication, in rect: CGRect) -> [UInt8] {
        guard let full = app.screenshot().image.cgImage, app.frame.width > 0 else { return [] }
        let scale = CGFloat(full.width) / app.frame.width
        let area = CGRect(
            x: (rect.minX * scale).rounded(), y: (rect.minY * scale).rounded(),
            width: (rect.width * scale).rounded(), height: (rect.height * scale).rounded()
        )
        guard let crop = full.cropping(to: area), crop.width > 0, crop.height > 0,
              let data = crop.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return [] }
        let bytesPerPixel = max(1, crop.bitsPerPixel / 8)
        var out: [UInt8] = []
        out.reserveCapacity((crop.width / 4 + 1) * (crop.height / 4 + 1))
        for y in stride(from: 0, to: crop.height, by: 4) {
            for x in stride(from: 0, to: crop.width, by: 4) {
                let offset = y * crop.bytesPerRow + x * bytesPerPixel
                let r = Int(bytes[offset]), g = Int(bytes[offset + 1]), b = Int(bytes[offset + 2])
                out.append(UInt8((r + g + b) / 3))
            }
        }
        return out
    }
}
