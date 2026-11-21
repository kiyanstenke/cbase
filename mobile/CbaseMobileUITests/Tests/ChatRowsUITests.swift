// Chat row UI tests: divider rows, tool-call rows and their sheets, task list, waiting state, subagent marker + agents sheet, workflow markers, artifact editing.
import XCTest

final class ChatRowsUITests: CbaseUITestBase {
    // ── Divider rows are readable in light mode ──────────────────────────────
    /// "Context compacted" & co. used to stand in a derived secondary colour (the HStack set 35 %
    /// grey as the PRIMARY colour, and the font's `.secondary` weakened it once more) and were
    /// practically invisible in light mode. The test checks what XCUITest can see: that the row
    /// exists as text and has an area.
    func testCompactionDividerIsPresentAndVisible() throws {
        let server = try requireFixture()
        defer { _ = setFixtureHistory(server, count: 0) }
        // The history with the invisible turns also carries the `meta` row `compacted` from which
        // the divider arises — no detour via the chat menu needed (its button is disabled without
        // context tokens anyway).
        XCTAssertTrue(setFixtureHistory(server, count: 1, invisible: true))
        // Pin light mode — exactly there the font was invisible.
        let app = launchApp(server: server, launchArguments: ["-cbase.mobile.theme", "light"])
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Sichtbare Antwort 1"].waitForExistence(timeout: 25))
        let divider = app.staticTexts["Context compacted"]
        // The divider lies BEFORE the last turns. Since the action bar under every message the rows
        // below are together about 170 pt taller — so it is no longer in the first window, and what
        // is not realised XCUITest does not see. So drag into the history until it is there: its
        // READABILITY is to be checked, not its position.
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        for _ in 0..<6 where !divider.exists {
            timeline.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertTrue(divider.waitForExistence(timeout: 15), "The divider row is missing in the history")
        XCTAssertGreaterThan(divider.frame.height, 8, "The divider row has no readable height")
        attach(app, "Divider context compacted")

        // And now the actual question: does the font stand out from the background? An element
        // "exists" in XCUITest even if its colour makes it unreadable — hence it is measured here.
        // Secondary grey on a light background yields far more than 60 levels of difference; the
        // derived colour from before was at a handful.
        let contrast = inkContrast(app, in: divider.frame)
        XCTAssertGreaterThan(
            contrast, 60,
            "The divider row barely stands out in light mode (only \(contrast) grey levels)"
        )
    }

    // ── Chat: the native task list ──────────────────────────────────────────
    /// The task list of the real Claude CLI comes via TaskCreate/TaskUpdate — per call ONE task,
    /// the id only in the result. The client must derive the list state from that. It used to wait
    /// for the superseded `TodoWrite` and therefore NEVER showed a list.
    func testChatShowsNativeTaskListFromTaskTools() throws {
        let server = try requireFixture()
        XCTAssertNotNil(
            fixturePost(server + "/fixture/native-tasks", body: ["open": true]),
            "The fixture did not accept the Task* switch"
        )
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let contains: (String) -> XCUIElement = { text in
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        // The running task appears in its progressive form (activeForm) — that proves the
        // TaskUpdate was applied to task #2 and not merely creating calls were rendered.
        XCTAssertTrue(
            contains("Lasse Lint und Tests laufen").waitForExistence(timeout: 20),
            "The running task of the CLI list is missing"
        )
        // The third task is open and carries its title — together that shows the state was
        // collected over several calls.
        XCTAssertTrue(contains("MR aufmachen").waitForExistence(timeout: 5), "The open task is missing")
        // The finished one disappears from the bar and stays only as a counter — so with long
        // lists the actual work stays visible.
        XCTAssertFalse(contains("Zusammenfassung kürzen").exists, "The finished task is still in the bar")
        XCTAssertTrue(contains("1 of 3 done").exists, "The counter of the finished tasks is missing")

        // And it sticks ABOVE the composer instead of moving along in the history — otherwise it
        // jumped to a different place with every tick (that was the flicker). firstMatch: the bar
        // carries the identifier, its accessibility element inherits it — a query without
        // firstMatch finds both and aborts with "Multiple matching elements".
        let bar = app.descendants(matching: .any).matching(identifier: "native-task-bar").firstMatch
        XCTAssertTrue(bar.exists, "The task bar does not exist as a bar of its own")
        XCTAssertTrue(
            bar.frame.maxY <= composer.frame.minY + 1,
            "The task bar does not sit directly above the composer (bar \(bar.frame), composer \(composer.frame))"
        )
        attach(app, "CLI task list above the composer")
    }

    // ── Waiting phase: resting hexagon and the "1 running task" pill, no "Tinkering…" ──────
    //
    // The three tests measure today's place of the waiting phase (`assertWaitingState`): the history
    // carries NO waiting row, there is no agent chip in the dock and none above the input field:
    // the run row stands as a resting hexagon + pill, its sheet names the task with its kind, the
    // subagent additionally carries the dot on the header button — and the composer stays usable.

    /// A background agent keeps the run open: the header button carries its dot, the pill counts
    /// it, its sheet names it as a subagent (`chat-task-agent`).
    func testChatShowsWaitingForBackgroundAgent() throws {
        try assertWaitingState(kind: "agent")
    }

    /// A background command (bash with run_in_background) keeps the run open just the same — as an
    /// item `chat-task-command` of the pill with its description, not wrongly as an agent.
    func testChatShowsWaitingForBackgroundCommand() throws {
        try assertWaitingState(kind: "task")
    }

    /// Fourth reason: the agent set itself a wake-up call (ScheduleWakeup). Then nothing runs, only
    /// something is scheduled — the item `chat-task-wakeup` "Scheduled continuation" in the sheet.
    func testChatShowsScheduledContinuation() throws {
        try assertWaitingState(kind: "wakeup")
    }

    // ── Subagents: marker in the history, sheet at the header ──────────────────
    //
    // A subagent's work is NOT in the history. There a slim MARKER stays ("Subagent <job>");
    // report, steps and numbers lie in the subagent sheet that the button in the chat header
    // opens. The sheet has ONE navigation level: overview as ONE list "Background Tasks"
    // (subagents and workflows mixed, newest on top, no main run), a tap SWAPS it for the agent's
    // page.
    //
    // Identifiers these tests measure at:
    //   chat-agent-row          the marker in the history (button)
    //   chat-agents             the button in the chat header
    //   chat-bg-tasks           the heading "Background Tasks" above the ONE list
    //   chat-agents-word        the state word of a subagent card ("running", "done", …)
    //   chat-agents-empty       "empty means empty"
    //   chat-agents-row         an agent row in the overview
    //   chat-agents-stop        stop from the list (only on the running one)
    //   chat-agents-job         the header of the agent page
    //   chat-agents-report      the report — stands ON TOP
    //   chat-agents-steps       the expandable steps below
    //   chat-agents-back        back to the overview, chat-agents-close closes the sheet
    //   chat-status-agents      the OLD dock chip — it must no longer exist

    /// While a subagent works, the header button carries its dot — and the dock above the input
    /// field carries NO agent chip any more (tasks, commands and alarm clocks remain there). The
    /// old state had "1 agent working" above the composer and no header button — both promises
    /// are dropped.
    func testChatHeaderDotWhileSubagentRuns() throws {
        let server = try requireFixture()
        // The switch is set BETWEEN `/fixture/reset-run` and the start: `reset-run` resets the
        // run switches, and `launchApp` calls it first — set before that, it would be gone on sending.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/subagent", body: ["open": true]),
                "The fixture did not accept the subagent switch"
            )
        })
        try openFirstChat(app)

        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        // It also stands WITHOUT a running subagent: a button that comes and goes shifts the whole bar.
        XCTAssertTrue(button.isHittable, "The button must stand there tappable before the first subagent")

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        // The dot itself is a shape INSIDE the button and not graspable for XCUITest. It becomes
        // measurable via the value of the button it hangs on — for that `HeaderButton` needs a line:
        // `.accessibilityValue(point ? "running" : "")`. Without it "the dot stands" is a claim no
        // test can hold.
        let deadline = Date().addingTimeInterval(30)
        var point = false
        while Date() < deadline {
            if (button.value as? String ?? "") == "running" { point = true; break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(
            point,
            "While a subagent runs, the header button must carry its dot — measurable via "
            + ".accessibilityValue(point ? \"running\" : \"\") on HeaderButton; read: \(button.value as? String ?? "(nothing)")"
        )
        attach(app, "Header button with dot")

        // Marker and sheet say the SAME: the state is computed once per agent, the marker carries it
        // as a value ("running", translated), the row of the same agent in the sheet likewise.
        // Before, both computed it themselves: the marker of a running background agent showed
        // green (done), the sheet "Running".
        let marker = app.buttons["chat-agent-row"].firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10), "The subagent's marker is missing in the history")
        // Read BEFORE opening: behind a sheet the marker is no longer in the tree.
        let markersValue = marker.value as? String ?? "(nothing)"
        XCTAssertEqual(
            markersValue, "running",
            "While the fixture subagent is open the marker carries the value \"running\" — read: \(markersValue)"
        )
        button.tap()
        let sheetRow = app.buttons.matching(identifier: "chat-agents-row")
            .matching(NSPredicate(format: "label CONTAINS %@", "Fixture-Subagent")).firstMatch
        XCTAssertTrue(sheetRow.waitForExistence(timeout: 10), "The row of the fixture subagent is missing in the sheet")
        XCTAssertEqual(
            sheetRow.value as? String ?? "(nothing)", markersValue,
            "Sheet and marker say different things — sheet: \(sheetRow.value as? String ?? "(nothing)"), marker: \(markersValue)"
        )
        attach(app, "Sheet: the same state as the marker")
        let close = app.buttons["chat-agents-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(sheetRow.waitForNonExistence(timeout: 10), "The sheet does not close")

        // The old place is EMPTY: no agent chip above the input field any more.
        XCTAssertFalse(
            app.buttons["chat-status-agents"].exists,
            "The agent chip in the dock is gone — it still stands there"
        )
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "agent working")).firstMatch.exists,
            "No agent display may stand above the input field any more"
        )

        // The header does not scroll along: scrolling up must not push the button away.
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(button.isHittable, "The subagent button must stay in the header")

        // After the end of the run (the fixture keeps the subagent run open for 60 s) the dot goes away.
        let end = Date().addingTimeInterval(90)
        var empty = false
        while Date() < end {
            if (button.value as? String ?? "").isEmpty { empty = true; break }
            Thread.sleep(forTimeInterval: 1.0)
        }
        XCTAssertTrue(empty, "After the end of the run the header button must carry no dot any more")
    }

    /// A subagent quickly uses dozens of tool calls. Indented in the history they buried the
    /// actual answer — on the phone after two calls. Now only the MARKER stands there: dot, the
    /// word "Subagent", the job, a chevron. No counter, no model badge, no child calls, no
    /// disclosure. A tap leads into the sheet, directly onto THIS agent's page. Counter-test
    /// against the old state: there the row carried "2 steps" and the badge "codex::gpt-5.4-mini",
    /// and the tap opened the call sheet — all three promises are dropped.
    func testSubagentMarkerLeadsIntoTheSheet() throws {
        let server = try requireFixture()
        // Seeded histories of a previous test survive in the fixture process — delete first,
        // otherwise this test checks a foreign chat.
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        // The switch is set BETWEEN `/fixture/reset-run` and the start: `reset-run` resets the
        // run switches, and `launchApp` calls it first — set before that, it would be gone on sending.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/subagent", body: ["open": true]),
                "The fixture did not accept the subagent switch"
            )
        })
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let marker = app.buttons["chat-agent-row"].firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 25), "The subagent's marker is missing in the history")
        XCTAssertTrue(marker.isHittable, "The marker must stand in the picture, tappable")
        XCTAssertTrue(
            marker.label.contains("Subagent"),
            "The marker must name the subagent, read: \(marker.label)"
        )
        XCTAssertFalse(
            marker.label.contains("Step"),
            "The marker carries no step counter any more, read: \(marker.label)"
        )
        XCTAssertFalse(
            marker.label.contains("::"),
            "The marker carries no model badge any more, read: \(marker.label)"
        )

        // The subagent's child call is a shell command with unambiguous text in the fixture.
        let kind = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "child-call-in-subagents"))
            .firstMatch
        XCTAssertFalse(kind.exists, "No child call of the subagent may stand in the history")
        attach(app, "Marker in the history")

        // The tap leads DIRECTLY onto this agent's page (not into the overview).
        marker.tap()
        let job = app.staticTexts["chat-agents-job"]
        XCTAssertTrue(job.waitForExistence(timeout: 10), "The tap on the marker must open THIS agent's page")
        XCTAssertTrue(app.buttons["chat-agents-back"].exists, "From the agent page there must be a way back to the overview")

        // Report ON TOP, steps below — and the steps start closed.
        let steps = app.buttons["chat-agents-steps"]
        XCTAssertTrue(steps.waitForExistence(timeout: 5), "The expandable steps are missing on the agent page")
        XCTAssertTrue(steps.isHittable, "The steps disclosure must be tappable")
        // The subagent is still running: instead of a report the sentence that says so stands there.
        XCTAssertTrue(
            app.staticTexts["chat-agents-report-empty"].exists,
            "While the subagent runs, the place of the report must say that it is still to come"
        )
        XCTAssertLessThan(
            app.staticTexts["chat-agents-report-empty"].frame.minY, steps.frame.minY,
            "The report belongs ABOVE the steps — it is what the main agent read"
        )
        XCTAssertFalse(kind.exists, "The steps start CLOSED — closed, no child call may stand")
        steps.tap()
        XCTAssertTrue(
            kind.waitForExistence(timeout: 10),
            "Unfolded, the subagent's steps must stand on its page"
        )
        attach(app, "Agent page with open steps")

        let back = app.buttons["chat-agents-back"]
        XCTAssertTrue(back.isHittable, "\"Background Tasks\" (back) must be tappable")
        back.tap()
        XCTAssertTrue(
            app.staticTexts["chat-bg-tasks"].waitForExistence(timeout: 10),
            "Back must show the overview — the list \"Background Tasks\""
        )
        XCTAssertFalse(app.staticTexts["chat-agents-main-run"].exists, "The main-run card is gone")
        let close = app.buttons["chat-agents-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(
            kind.waitForNonExistence(timeout: 10),
            "Closing must take the sheet including steps away again — marker afterwards: \(marker.label)"
        )
    }

    /// The whole case matrix on the RELOADED history: several subagents in one answer, with
    /// three / one / no child call, one with a failed child, one beside ordinary tools (which may
    /// merge into collective rows — the subagent not). Checked: EVERY marker stands on its own,
    /// none carries counter, model, children or report — and the sheet lists all five, with model
    /// and numbers.
    func testSubagentMatrixInLoadedHistory() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func js(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        // A subagent call including children: `parent` attaches the children to the call.
        func agent(_ id: String, _ description: String, children: [(String, String, Bool)]) {
            add("tool", js(["id": id, "name": "mcp__cbase__cbase_agent", "detail": description,
                            "input": ["description": description, "prompt": "work"]]))
            for (kid, cmd, error) in children {
                add("tool", js(["id": kid, "name": "Bash", "detail": cmd, "parent": id, "input": ["command": cmd]]))
                add("tool_result", js(["id": kid, "result": error ? "Exit code 1" : "ok \(cmd)", "isError": error]))
            }
        // The report carries provider, resolved model and the numbers — the sheet builds its row
        // from it (the marker in the history names none of that any more).
            let report = js(["status": "completed", "provider": "codex", "resolvedModel": "gpt-5.4-mini",
                              "report": "Report \(description)", "totalTokens": 12400,
                              "totalToolUseCount": children.count, "totalDurationMs": 42_000])
            add("tool_result", js(["id": id, "result": report, "isError": false]))
        }
        add("user", "Subagent matrix")
        agent("m-a", "THREE children", children: [("k-a1", "kind-a-one", false), ("k-a2", "kind-a-two", false), ("k-a3", "kind-a-three", false)])
        agent("m-b", "ONE child", children: [("k-b1", "kind-b-one", false)])
        // Interim text of the subagent (role `sub_text`): belongs to its steps in the sheet, not to
        // the main answer.
        add("sub_text", js(["text": "interim-word-of-the-subagents", "parent": "m-b"]))
        agent("m-c", "NO child", children: [])
        agent("m-e", "ERROR in child", children: [("k-e1", "kind-e-broken", true)])
        // Ordinary neighbours: two each merge into "Ran 2 commands".
        for i in 0..<2 {
            add("tool", js(["id": "n-before-\(i)", "name": "Bash", "detail": "neighbor-before-\(i)", "input": ["command": "neighbor-before-\(i)"]]))
            add("tool_result", js(["id": "n-before-\(i)", "result": "ok", "isError": false]))
        }
        agent("m-g", "BETWEEN neighbours", children: [("k-g1", "kind-g-one", false)])
        for i in 0..<2 {
            add("tool", js(["id": "n-after-\(i)", "name": "Bash", "detail": "neighbor-after-\(i)", "input": ["command": "neighbor-after-\(i)"]]))
            add("tool_result", js(["id": "n-after-\(i)", "result": "ok", "isError": false]))
        }
        add("assistant", "Matrix done")
        _ = fixturePost(server + "/fixture/subagent", body: ["open": false])
        XCTAssertNotNil(fixturePost(server + "/fixture/history", body: ["entries": entries]), "The fixture did not accept the history")
        defer { _ = fixturePost(server + "/fixture/history", body: ["count": 0]) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let markers = app.buttons.matching(identifier: "chat-agent-row")
        XCTAssertTrue(markers.firstMatch.waitForExistence(timeout: 25), "No subagent marker in the history")
        XCTAssertEqual(markers.count, 5, "Every subagent needs its OWN marker (no collective row)")
        // No model on the marker any more — it stands in the sheet, where the numbers stand too.
        XCTAssertEqual(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "codex::gpt-5.4-mini")).count, 0,
            "The marker in the history carries no model badge any more"
        )
        let labels = (0..<markers.count).map { markers.element(boundBy: $0).label }
        for label in labels {
            XCTAssertTrue(label.contains("Subagent"), "Every marker says \"Subagent\", read: \(label)")
            XCTAssertFalse(label.contains("Step"), "No marker carries a counter, read: \(label)")
        }
        // Closed: NO child call, no interim text in the history.
        let kindA = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "kind-a-one")).firstMatch
        let kindB = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "kind-b-one")).firstMatch
        XCTAssertFalse(kindA.exists, "No child call may be visible in the history")
        XCTAssertFalse(kindB.exists, "No child call may be visible in the history")
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "interim-word-of-the-subagents")).firstMatch.exists,
            "The subagent's interim text belongs in the sheet, not in the history"
        )
        // The ordinary neighbours keep their collective row — the subagent is not in it.
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Ran 2 commands")).firstMatch.exists,
            "The ordinary neighbours must keep their collective row"
        )
        attach(app, "Five markers in the history")

        // The way via the HEADER leads into the overview: all five, each exactly once.
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "The subagent button is missing in the chat header")
        button.tap()
        let rows = app.buttons.matching(identifier: "chat-agents-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The agent rows are missing in the sheet")
        XCTAssertEqual(rows.count, 5, "The sheet lists all subagents of THIS chat, each exactly once")
        // ONE list "Background Tasks" — without the main-run card.
        XCTAssertTrue(app.staticTexts["chat-bg-tasks"].exists, "The heading \"Background Tasks\" is missing above the list")
        XCTAssertFalse(app.staticTexts["chat-agents-main-run"].exists, "The main-run card stands above the list again")
        // The model stands HERE now — in the figures line of every agent row.
        XCTAssertEqual(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "codex::gpt-5.4-mini")).count, 5,
            "Every agent row in the sheet must name its model"
        )
        // 12,400 tokens from the report. What is read is the LABEL of the token column, and it
        // carries the EXACT number (`tokenReadAloud` in `ChatDetailSheet.swift`: the exact number
        // lets one see every single one) — visibly the 56 pt narrow column abbreviates to "12k".
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "12400 tokens")).firstMatch.exists,
            "The numbers of the report (tokens) must stand on the agent row"
        )
        attach(app, "Sheet with five agents")

        // Only the tapped row opens its page: report on top, steps below and closed.
        let triple = (0..<rows.count).map { rows.element(boundBy: $0) }.first { $0.label.contains("THREE children") }
        XCTAssertNotNil(triple, "The row of the subagent with three children is missing")
        XCTAssertTrue(triple!.isHittable, "The agent row must be tappable")
        triple?.tap()
        // The report is a `children: .contain` container around the markdown view, NOT a text:
        // only that way its children keep their own identifiers. A container is no `staticText`,
        // though — searched for as one, the query would never find it.
        let report = app.descendants(matching: .any)["chat-agents-report"]
        XCTAssertTrue(report.waitForExistence(timeout: 10), "The report is missing on the agent page")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Report THREE children")).firstMatch.exists,
            "The report of the CHOSEN subagent must be there"
        )
        let steps = app.buttons["chat-agents-steps"]
        XCTAssertTrue(steps.waitForExistence(timeout: 5), "The expandable steps are missing on the agent page")
        XCTAssertLessThan(report.frame.minY, steps.frame.minY, "The report belongs ABOVE the steps")
        XCTAssertFalse(kindA.exists, "The steps start CLOSED")
        steps.tap()
        XCTAssertTrue(kindA.waitForExistence(timeout: 10), "Unfolded, the subagent's steps are missing")
        XCTAssertFalse(kindB.exists, "These are the steps of the CHOSEN agent, not of another")

        // Error in the child: visible only in the sheet, marked "Failed"; the marker in the
        // history stays calm (the subagent itself did finish).
        app.buttons["chat-agents-back"].tap()
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "Back must show the overview")
        let errorRow = (0..<rows.count).map { rows.element(boundBy: $0) }.first { $0.label.contains("ERROR in child") }
        XCTAssertNotNil(errorRow, "The row of the subagent with the failed child is missing")
        errorRow?.tap()
        let steps2 = app.buttons["chat-agents-steps"]
        XCTAssertTrue(steps2.waitForExistence(timeout: 5), "After the switch the steps are missing")
        steps2.tap()
        let broken = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "kind-e-broken")).firstMatch
        XCTAssertTrue(broken.waitForExistence(timeout: 10), "The failed child must appear on the agent page")
        XCTAssertTrue(
            app.staticTexts["Failed"].waitForExistence(timeout: 5),
            "The failed step must be marked as such"
        )
        app.buttons["chat-agents-back"].tap()
        let close = app.buttons["chat-agents-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(broken.waitForNonExistence(timeout: 10), "Closing must take the sheet including steps away")
    }

    /// Depth 3: two parallel children with a grandchild each. Every grandchild stands under the
    /// call block of ITS parent agent — in the history only the two markers of the children,
    /// nothing of the grandchild in the main bubble; in the sheet under "Part ONE" exactly the call
    /// "Child of ONE", and its page shows the steps of the grandchild of ONE, not those of TWO. The
    /// rows have the form the server writes (server/backend/test/agent-depth.test.js); the web
    /// checks the same form in web/test/grandchild-nested.test.mjs.
    func testGrandchildStandUnderTheirParentAgents() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func js(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        let agent = "mcp__cbase__cbase_agent"
        add("user", "Two chains")
        add("tool", js(["id": "toolu_one", "name": agent, "detail": "Part ONE", "input": ["description": "Part ONE", "prompt": "a"]]))
        add("tool", js(["id": "toolu_two", "name": agent, "detail": "Part TWO", "input": ["description": "Part TWO", "prompt": "b"]]))
        for (w, main) in [("ONE", "toolu_one"), ("TWO", "toolu_two")] {
            add("tool", js(["id": "toolu_k_\(w)", "name": agent, "detail": "Child of \(w)", "parent": main,
                            "input": ["description": "Child of \(w)", "prompt": "c"]]))
        }
        // The grandchildren write interleaved — each under the block of its own parent agent.
        for w in ["TWO", "ONE"] {
            let command = "grandchild-\(w.lowercased())-command"
            add("sub_text", js(["text": "grandchild-word-\(w.lowercased())", "parent": "toolu_k_\(w)"]))
            add("tool", js(["id": "toolu_r_\(w)", "name": "Bash", "detail": command, "parent": "toolu_k_\(w)", "input": ["command": command]]))
            add("tool_result", js(["id": "toolu_r_\(w)", "result": "ok", "isError": false]))
        }
        for (w, main) in [("ONE", "toolu_one"), ("TWO", "toolu_two")] {
            add("tool_result", js(["id": "toolu_k_\(w)", "result": js(["status": "completed", "report": "Grandchild report \(w)"]), "isError": false]))
            add("tool_result", js(["id": main, "result": js(["status": "completed", "provider": "claude", "report": "Report part \(w)"]), "isError": false]))
        }
        add("assistant", "Chains done")
        _ = fixturePost(server + "/fixture/subagent", body: ["open": false])
        XCTAssertNotNil(fixturePost(server + "/fixture/history", body: ["entries": entries]), "The fixture did not accept the history")
        defer { _ = fixturePost(server + "/fixture/history", body: ["count": 0]) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let markers = app.buttons.matching(identifier: "chat-agent-row")
        XCTAssertTrue(markers.firstMatch.waitForExistence(timeout: 25), "No subagent marker in the history")
        XCTAssertEqual(markers.count, 2, "Only the two children stand in the history — the grandchildren belong under their blocks")
        let contains = { (s: String) in app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }
        for lane in ["grandchild-word-one", "grandchild-word-two", "grandchild-one-command", "grandchild-two-command"] {
            XCTAssertFalse(contains(lane).exists, "\"\(lane)\" stands in the main bubble")
        }

        app.buttons["chat-agents"].tap()
        let rows = app.buttons.matching(identifier: "chat-agents-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The agent rows are missing in the sheet")
        let one = (0..<rows.count).map { rows.element(boundBy: $0) }.first { $0.label.contains("Part ONE") }
        XCTAssertNotNil(one, "The row of Part ONE is missing")
        one?.tap()
        let steps = app.buttons["chat-agents-steps"]
        XCTAssertTrue(steps.waitForExistence(timeout: 10), "The steps are missing on the page of Part ONE")
        steps.tap()
        let entryButtons = app.buttons.matching(identifier: "chat-detail-entry")
        XCTAssertTrue(entryButtons.firstMatch.waitForExistence(timeout: 10), "The steps of Part ONE are empty")
        let labels = (0..<entryButtons.count).map { entryButtons.element(boundBy: $0).label }
        XCTAssertTrue(labels.contains { $0.contains("Child of ONE") }, "The grandchild's call is missing under Part ONE: \(labels)")
        XCTAssertFalse(labels.contains { $0.contains("Child of TWO") }, "Under Part ONE stands the call of TWO: \(labels)")
        let grandchildCall = (0..<entryButtons.count).map { entryButtons.element(boundBy: $0) }.first { $0.label.contains("Child of ONE") }
        grandchildCall?.tap()
        XCTAssertTrue(contains("grandchild-one-command").waitForExistence(timeout: 10), "The page of the grandchild call does not show the steps of the grandchild of ONE")
        XCTAssertFalse(contains("grandchild-two-command").exists, "Under the grandchild of ONE stand the steps of the grandchild of TWO")
        attach(app, "Grandchild of ONE under its parent agent")
    }

    /// A FINISHED subagent comes after an app restart only from its report — the app never saw the
    /// agent in the running stream (the history is seeded, no run, no `background`). The report
    /// carries `tokenKind` (agent-runtime.js); the lower bound must say "at least …" in the sheet.
    /// Plus the two counterparts: a report with a complete count (Claude) and one from the legacy
    /// stock WITHOUT the field — both without marker, the legacy stock because nobody measured a
    /// lower bound (not because "full" was measured). Counter-test against the old state
    /// (`tokenKindSeen` alone): the lower bound carries no marker, the first check is red.
    func testFinishedAgentReadsTokenKindFromTheReport() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func js(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        let agent = "mcp__cbase__cbase_agent"
        // Three token numbers that cannot be confused: the cell reads out the EXACT number.
        let cases: [(id: String, job: String, provider: String, tokens: Int, kind: String?)] = [
            ("toolu_under", "Job lower bound", "codex", 31_415, "only_output"),
            ("toolu_full", "Job full count", "claude", 27_182, "full"),
            ("toolu_old", "Job legacy", "codex", 16_180, nil),
        ]
        add("user", "Three agents")
        for f in cases {
            add("tool", js(["id": f.id, "name": agent, "detail": f.job, "input": ["description": f.job, "prompt": "p"]]))
        }
        for f in cases {
            var report: [String: Any] = [
                "status": "completed", "agentId": "a-\(f.id)", "description": f.job, "provider": f.provider,
                "report": "Report \(f.job)", "totalTokens": f.tokens, "totalToolUseCount": 2, "totalDurationMs": 30_000,
            ]
            if let kind = f.kind { report["tokenKind"] = kind }
            add("tool_result", js(["id": f.id, "result": js(report), "isError": false]))
        }
        add("assistant", "All done")
        _ = fixturePost(server + "/fixture/subagent", body: ["open": false])
        XCTAssertNotNil(fixturePost(server + "/fixture/history", body: ["entries": entries]), "The fixture did not accept the history")
        defer { _ = fixturePost(server + "/fixture/history", body: ["count": 0]) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 25), "The subagent button is missing in the chat header")
        button.tap()
        let rows = app.buttons.matching(identifier: "chat-agents-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The agent rows are missing in the sheet")
        XCTAssertEqual(rows.count, 3, "Exactly the three finished agents stand in the sheet")
        // The token cell per agent, via its read-out EXACT number (the visible column abbreviates to "31k").
        let cell = { (text: String) in
            app.staticTexts.matching(identifier: "chat-agents-tokens").matching(NSPredicate(format: "label == %@", text)).firstMatch
        }
        let under = cell("at least 31415 tokens")
        XCTAssertTrue(under.waitForExistence(timeout: 10), "The report carries `tokenKind: only_output` — the number must stand as a lower bound (\"at least 31415 tokens\")")
        XCTAssertTrue(under.isHittable, "The token cell of the agent with a lower bound is not visible in the sheet")
        let full = cell("27182 tokens")
        XCTAssertTrue(full.waitForExistence(timeout: 5), "Complete count (Claude): the number without marker is missing")
        XCTAssertTrue(full.isHittable, "The token cell of the Claude agent is not visible in the sheet")
        // Unknown is not full — the legacy stock carries the marker like a lower bound.
        let old = cell("at least 16180 tokens")
        XCTAssertTrue(old.waitForExistence(timeout: 5), "Legacy stock without `tokenKind`: unknown carries the marker (\"at least 16180 tokens\")")
        XCTAssertTrue(old.isHittable, "The token cell of the legacy stock is not visible in the sheet")
        XCTAssertFalse(cell("at least 27182 tokens").exists, "A complete count must not carry a lower-bound marker")
        XCTAssertFalse(cell("16180 tokens").exists, "The legacy stock must not stand there like a measured full number")
        attach(app, "Finished agents: tokenKind from the report")
    }

    /// The sheet shows RUNNING and FINISHED subagents of this chat. The fixture seeds both in one
    /// turn: a finished one (its report stands as a tool result in the history) and a running one
    /// (it comes via `background` with model, status, startedAt, tokens, token kind and tool
    /// count). Checked: the two sections, the numbers, the honest "at least …" for a provider that
    /// only reports the output, the stop button on the running one — and that the old dock chip is
    /// gone. Counter-test against the old state: there was neither sheet nor sections, but "2
    /// agents working" above the composer.
    func testAgentsSheetShowsRunningAndFinished() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        // The switch is set BETWEEN `/fixture/reset-run` and the start: `reset-run` resets the
        // run switches, and `launchApp` calls it first — set before that, it would be gone on sending.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/background-agent", body: ["open": true]),
                "The fixture did not accept the background-agent switch"
            )
        })
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        // The old place is empty.
        XCTAssertFalse(
            app.buttons["chat-status-agents"].exists,
            "The agent chip in the dock is gone — it still stands there"
        )

        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        XCTAssertTrue(button.isHittable, "The subagent button must be tappable")
        button.tap()
        XCTAssertTrue(
            app.staticTexts["chat-bg-tasks"].waitForExistence(timeout: 10),
            "The header button must open the agents sheet — with the list \"Background Tasks\""
        )
        XCTAssertFalse(app.staticTexts["chat-agents-main-run"].exists, "The main-run card is gone")

        let contains: (String) -> XCUIElement = { text in
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        // The START VALUE of the token cell is read first — before the model, stop and section
        // checks, which together cost about ten wait periods. Reading it afterwards used to meet
        // the LAST update of the fixture series with 0.2 s distance: the promise "the tokens grow"
        // hung on the clock. A provider that only reports the output must not feign a complete
        // number. VISIBLY "≥" stands for the word in the narrow number column; the label of the
        // cell — and thus what VoiceOver reads out and what this test reads — carries it spelled
        // out. A character only the eye understands would be a gap for the ear.
        XCTAssertTrue(
            contains("at least").waitForExistence(timeout: 10),
            "With `tokenKind: only_output` the number must be shown as a lower bound (\"at least … tokens\")"
        )
        let prior = contains("at least").label
        // The NUMBER from the label ("at least <n> tokens", `tokenReadAloud` in
        // `ChatDetailSheet.swift`): "grow" means GREATER, not "different" — a label that changes
        // without the number rising (rounding, wording, a falling value) would otherwise have
        // counted as growth.
        let tokenCount: (String) -> Int? = { label in
            let digits = label.split(separator: " ").compactMap { Int($0) }
            return digits.first
        }
        guard let priorCount = tokenCount(prior) else {
            return XCTFail("No number can be read from the label of the token cell: \"\(prior)\"")
        }
        // Two cards — every agent exactly once (the running one is reported LIVE AND lies as a
        // block in the history; without reconciling via the call id it would stand twice), each
        // with its state word. In two sections: "Running" (head `chat-bg-tasks`) above "Finished N".
        let words = app.staticTexts.matching(identifier: "chat-agents-word")
        XCTAssertTrue(words.firstMatch.waitForExistence(timeout: 10), "The cards carry no state word")
        XCTAssertEqual(Set(words.allElementsBoundByIndex.map(\.label)), ["running", "done"], "each card its word: the running one \"running\", the finished one \"done\"")
        XCTAssertTrue(contains("Compose-Dienste prüfen").waitForExistence(timeout: 10), "The running subagent is missing")
        XCTAssertTrue(contains("Repos durchsuchen").waitForExistence(timeout: 10), "The finished subagent is missing")
        XCTAssertEqual(
            app.buttons.matching(identifier: "chat-agents-row").count, 2,
            "An agent reported live AND present as a block must appear only ONCE"
        )
        // Every card in the right section, measured by position (head "Running" < running < "Finished" < finished).
        let card = { (a: String) in app.buttons.matching(identifier: "chat-agents-row").matching(NSPredicate(format: "label CONTAINS %@", a)).firstMatch }
        let runningHeader = app.staticTexts["chat-bg-tasks"]
        let endedHeader = app.buttons["chat-bg-ended"]
        XCTAssertTrue(endedHeader.waitForExistence(timeout: 10), "The section \"Finished\" is missing")
        XCTAssertTrue(["running", "running"].contains(runningHeader.label.lowercased()), "The first section is \"Running\": \"\(runningHeader.label)\"")
        XCTAssertTrue(["Beendet, 1", "Finished, 1"].contains { endedHeader.label.hasPrefix($0) },
                      "The \"Finished\" head carries the number of the finished ones: \"\(endedHeader.label)\"")
        let positions = [runningHeader.frame.minY, card("Compose-Dienste prüfen").frame.minY, endedHeader.frame.minY,
                     card("Repos durchsuchen").frame.minY]
        XCTAssertTrue(positions == positions.sorted() && Set(positions).count == 4, "\"Running\" with the running one, below it \"Finished\" with the finished one — y = \(positions)")
        // Models: the running one reports provider and model separately, the display puts them together.
        XCTAssertTrue(contains("codex::gpt-5.4-mini").waitForExistence(timeout: 5), "The model of the running subagent is missing")
        // In the list the provider does NOT stand twice: "claude::claude-haiku-…" becomes
        // "claude::haiku-…". The full name stands on the agent's page (checked below).
        XCTAssertTrue(contains("claude::haiku-4-5-20251001").waitForExistence(timeout: 5), "The model of the finished subagent is missing")
        XCTAssertFalse(
            contains("claude::claude-haiku").exists,
            "In the narrow row the provider must not stand twice"
        )
        // The finished one comes from its report: 48,200 tokens in the token column. What is read
        // is the label, and it carries the EXACT number — visibly "48k" stands in the 56 pt narrow
        // column. What stands there the attachment below shows; here the value counts.
        XCTAssertTrue(contains("48200").waitForExistence(timeout: 5), "The tokens from the finished subagent's report are missing")
        // The tool count is NOT in the row any more — the two columns carry tokens and time there.
        // It belongs on the agent's page.
        XCTAssertFalse(
            contains("7 tools").exists,
            "The tool count no longer belongs in the list row — tokens and time stand in columns there"
        )
        attach(app, "Sheet: Background Tasks, running and finished")

        // The stop button hangs on the RUNNING one — and only on it.
        let stop = app.buttons.matching(identifier: "chat-agents-stop")
        XCTAssertTrue(stop.firstMatch.waitForExistence(timeout: 5), "The stop button is missing on the running subagent")
        XCTAssertEqual(stop.count, 1, "A finished subagent has no stop button")
        XCTAssertTrue(stop.firstMatch.isHittable, "The stop button must be tappable")

        // Tokens and pace grow: the fixture reports a new state every 1.5 s, 20 steps long (30.5 s
        // from the start of the run, seeds.mjs). Without this supply the number would stay at its
        // initial value. Compared with the start value from above, read right after opening the
        // sheet.
        //
        // What is read is the label of the TOKEN cell, and it carries the exact number. A chain in
        // which the runtime ticked along too would make "the tokens grow" indistinguishable from
        // "the clock runs" and stay green even with frozen tokens.
        let deadline = Date().addingTimeInterval(25)
        var nowCount = priorCount
        var last = prior
        while Date() < deadline {
            let now = contains("at least")
            if now.exists {
                last = now.label
                if let count = tokenCount(last), count != priorCount { nowCount = count; break }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertGreaterThan(
            nowCount, priorCount,
            "The tokens of a running subagent must grow — start \"\(prior)\", last \"\(last)\""
        )
        XCTAssertTrue(
            contains("tokens/min").waitForExistence(timeout: 20),
            "After two measuring points the pace must be there — before that it stays EMPTY instead of lying"
        )
        attach(app, "Running subagent with pace")

        // On the agent's PAGE there is room for the whole sentence: the tool count stands there,
        // and "at least" stands spelled out. Without this place the "≥" of the column would stay
        // unexplained. The ROW BUTTON is tapped, not the text in it: a StaticText inside a button
        // reports `exists` but is not `isHittable`.
        let finishedRow = app.buttons.matching(identifier: "chat-agents-row")
            .matching(NSPredicate(format: "label CONTAINS %@", "Repos durchsuchen")).firstMatch
        XCTAssertTrue(finishedRow.waitForExistence(timeout: 5), "The finished subagent is missing in the list")
        XCTAssertTrue(finishedRow.isHittable, "The row of the finished subagent must be tappable")
        finishedRow.tap()
        XCTAssertTrue(
            contains("7 tools").waitForExistence(timeout: 10),
            "On the agent's page the tool count from its report must stand"
        )
        XCTAssertTrue(
            contains("claude::claude-haiku-4-5-20251001").waitForExistence(timeout: 5),
            "The page has room for the full model name — only the list row is abbreviated"
        )
        attach(app, "Page of a finished subagent")
    }

    /// "Stop all background agents" stands in the sheet as long as an agent runs, and after the
    /// confirmation sends `POST /agents/stop` with the originator "human" — without it the server
    /// answers 400 (the fixture too). The body is read at the fixture (`/fixture/agents-stops`), not
    /// guessed at the UI.
    func testAgentsSheetStopsAllBackgroundAgents() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/background-agent", body: ["open": true]),
                "The fixture did not accept the background-agent switch"
            )
        })
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        button.tap()
        let all = app.buttons["chat-agents-stop-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 15), "As long as an agent runs, \"Stop all background agents\" stands in the sheet")
        XCTAssertTrue(all.isHittable, "The button must be tappable")
        all.tap()
        // Menu items via the LABEL, not the identifier. The confirmation stands several times in
        // the tree with the same label (measured: "Multiple matching elements") — hence `firstMatch`;
        // whether the RIGHT one was hit the fixture record below tells (way "all", from "human").
        let confirm = app.buttons["Stop all"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "The confirmation is missing")
        confirm.tap()

        var stops: [[String: Any]] = []
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            stops = (fixtureJSON(server + "/fixture/agents-stops")?["stops"] as? [[String: Any]]) ?? []
            if !stops.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertEqual(stops.count, 1, "Exactly one stop call: \(stops)")
        XCTAssertEqual(stops.first?["way"] as? String, "all", "The button calls \"stop all\", not the stop per agent")
        XCTAssertEqual(stops.first?["from"] as? String, "human", "The button sends the originator \"human\"")
        attach(app, "All background agents stopped")
    }

    /// A background agent survives its turn. After `run_done` its card in the agents sheet carries
    /// "running" with a stop button (not "no result"), parked "waiting until 23:59", and its
    /// completion message appears as a system row, never as a user bubble — in the stream as from
    /// the history. The test triggers the phases itself (`/fixture/agent-after-run`,
    /// routes-run.mjs), no time window. Counter-test (on the code, not run): `run_done` with
    /// `clearWaitState()` again ⇒ the agent drops out of the sheet.
    func testBackgroundAgentAliveAfterRunDone() throws {
        let server = try requireFixture()
        // The history already carries a completion message (role `user`, marker at the start) — built from the history.
        let old = "<task-notification>\n<task-id>a-alt</task-id>\n<status>completed</status>\n<summary>Agent \"Read legacy stock\" completed</summary>\n<result>alt</result>\n</task-notification>"
        _ = fixturePost(server + "/fixture/history", body: ["entries": [
            ["id": 1, "role": "user", "text": "Previous", "ts": 1, "attachments": [] as [Any]],
            ["id": 2, "role": "assistant", "text": "Started.", "ts": 2, "attachments": [] as [Any]],
            ["id": 3, "role": "user", "text": old, "ts": 3, "attachments": [] as [Any]],
        ]])
        let app = launchApp(server: server)
        try openFirstChat(app)
        let contains: (String) -> XCUIElement = { text in
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        XCTAssertTrue(contains("Subagent \"Read legacy stock\" finished").waitForExistence(timeout: 20),
                      "The stored completion message must stand as a system row in the history")
        XCTAssertFalse(contains("task-notification").exists, "The XML of a completion notice must never appear as a user bubble")

        XCTAssertNotNil(fixturePost(server + "/fixture/agent-after-run", body: ["phase": "start"]))
        XCTAssertTrue(contains("Der Subagent läuft im Hintergrund.").waitForExistence(timeout: 15), "The turn is missing")
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "The subagent button is missing in the chat header")
        button.tap()
        XCTAssertTrue(contains("Nachlauf prüfen").waitForExistence(timeout: 10), "The agent is missing in the sheet after run_done")
        let running = app.staticTexts.matching(identifier: "chat-agents-word").matching(NSPredicate(format: "label == %@", "running")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 5), "After run_done its card carries \"running\"")
        XCTAssertFalse(contains("no result").exists, "A living agent is not \"without result\"")
        let stop = app.buttons.matching(identifier: "chat-agents-stop").firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5), "The stop button stands on the living agent — even without a turn")
        XCTAssertTrue(stop.isHittable, "The stop button must be tappable")

        XCTAssertNotNil(fixturePost(server + "/fixture/agent-after-run", body: ["phase": "parking"]))
        XCTAssertTrue(contains("waiting until 23:59").waitForExistence(timeout: 10), "A parked agent says when it continues")
        attach(app, "Background agent after run_done, parked")

        XCTAssertNotNil(fixturePost(server + "/fixture/agent-after-run", body: ["phase": "end"]))
        let gonePredicate = NSPredicate(format: "exists == false")
        expectation(for: gonePredicate, evaluatedWith: app.buttons.matching(identifier: "chat-agents-stop").firstMatch)
        waitForExpectations(timeout: 10)
        // The row stands behind the sheet in the tree — `exists` suffices here (it is about the kind, not the position).
        XCTAssertTrue(contains("Subagent \"Nachlauf prüfen\" finished").waitForExistence(timeout: 10),
                      "The completion message from the stream appears as a system row")
        XCTAssertFalse(contains("task-notification").exists, "…and never as a user bubble")
        attach(app, "Completion notice as a system row")
    }

    /// On the page of a FOREGROUND agent "Move to background" stands and sends without
    /// confirmation `POST /agent/background` with its agentId (without it the server answers 400,
    /// the fixture too). Afterwards the row no longer carries the marker, and the button is gone.
    /// The body is read at the fixture.
    func testAgentsSheetSendsForegroundAgentsInTheBackground() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/background-agent", body: ["open": true, "foreground": true]),
                "The fixture did not accept the foreground-agent switch"
            )
        })
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Go")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        button.tap()
        // The ROW BUTTON is tapped, not the text in it (see above).
        let row = app.buttons.matching(identifier: "chat-agents-row")
            .matching(NSPredicate(format: "label CONTAINS %@", "Compose-Dienste prüfen")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The running foreground agent is missing in the list")
        XCTAssertTrue(row.isHittable, "The row of the running agent must be tappable")
        row.tap()
        let background = app.buttons["chat-agents-background"]
        XCTAssertTrue(background.waitForExistence(timeout: 10), "On the page of a foreground agent \"Move to background\" stands")
        XCTAssertTrue(background.isHittable, "The button must be tappable")
        attach(app, "Foreground agent with button")
        background.tap()

        var calls: [[String: Any]] = []
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            calls = (fixtureJSON(server + "/fixture/agents-background")?["calls"] as? [[String: Any]]) ?? []
            if !calls.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertEqual(calls.count, 1, "Exactly one call \"Move to background\": \(calls)")
        XCTAssertEqual(calls.first?["agentId"] as? String, "fixture-bg-1", "The button sends the agent's agentId")
        // The next tick of the seed (1.5 s) reports the row without marker — then the button is gone.
        XCTAssertTrue(
            background.waitForNonExistence(timeout: 10),
            "After the switch the agent is a background agent — the button disappears"
        )
        XCTAssertTrue(app.buttons["chat-agents-stop-page"].exists, "It keeps running: the stop button stays")
        attach(app, "Agent in the background")
    }

    // ── Tool-call row: the tap opens a sheet, the history stands still ───────────
    // A tool call no longer unfolds IN its row (in the inverted list the most expensive movement
    // there is, including a top-edge pin against it) but opens a sheet from below — with ONE call
    // directly its page with command and result. Both are checked: the output stands ONLY in the
    // sheet, and row and history above stand exactly where they stood before after closing.
    func testToolCallRowOpensSheetAndKeepsHistorySteady() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func json(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        // Enough history that it fills the window — only then could a sheet shift the history at all.
        for index in 0..<10 {
            add("user", "Verlauf Frage \(index)")
            add("assistant", "Verlauf Antwort \(index): "
                + String(repeating: "Text, der die Zeile füllt und mehrfach umbricht. ", count: 3))
        }
        add("user", "Please check the server state")
        add("tool", json(["id": "t-exp", "name": "Bash", "input": ["command": "docker ps"]]))
        // Realistically large (~11 kCharacters): a long result must not burst the page.
        add("tool_result", json([
            "id": "t-exp",
            "result": (0..<150).map { "container-row-\($0) running  " + String(repeating: "log", count: 20) }.joined(separator: "\n"),
            "isError": false,
        ]))
        add("assistant", "All running — this row stands BELOW the call.")
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the history rows"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let row = app.buttons["chat-tool-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 25), "The tool row is missing")
        XCTAssertTrue(
            row.label.contains("Ran 1 command"),
            "The row summarises the call, read: \(row.label)"
        )
        // Let self-sizing and the indent calculation settle.
        Thread.sleep(forTimeInterval: 2.0)

        let witness = app.staticTexts["Please check the server state"]
        XCTAssertTrue(witness.exists, "The user row above the call is missing")
        let rowBefore = row.frame.minY
        let witnessBefore = witness.frame.minY

        // Closed, the output stands nowhere in the history.
        let output = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "container-row-0")).firstMatch
        XCTAssertFalse(output.exists, "The tool output must not stand in the history")

        row.tap()
        XCTAssertTrue(output.waitForExistence(timeout: 6), "The sheet does not show the tool output")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "docker ps")).firstMatch.exists,
            "The sheet does not name the command"
        )
        XCTAssertTrue(
            app.navigationBars["Bash"].waitForExistence(timeout: 5),
            "The call's page does not carry the tool name as its title"
        )
        attach(app, "Sheet of a tool call")

        let close = app.buttons["chat-detail-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(output.waitForNonExistence(timeout: 6), "After closing the output must no longer be visible")
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertEqual(
            row.frame.minY, rowBefore, accuracy: 2,
            "The tool row moved by \(row.frame.minY - rowBefore) pt through the sheet"
        )
        XCTAssertEqual(
            witness.frame.minY, witnessBefore, accuracy: 2,
            "The history above the call moved by \(witness.frame.minY - witnessBefore) pt through the sheet"
        )
    }

    // ── Thinking row and file statistics ─────────────────────────────────────────
    // "Thinking ›" opens the text as a sheet; a group with a write tool counts the file too and
    // carries the line balance ("Ran 2 commands, created one file +4 −0"), and the page of the
    // Write call shows path and diff.
    func testThinkingRowAndFileStatsOpenSheets() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func json(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        add("user", "Create the note")
        add("thinking", "I first consider where the note belongs — thought-process-in-sheet.")
        add("tool", json(["id": "th-1", "name": "Bash", "input": ["command": "ls notes", "description": "Look at folder"]]))
        add("tool_result", json(["id": "th-1", "result": "old.md", "isError": false]))
        add("tool", json(["id": "th-2", "name": "Write",
                          "input": ["file_path": "notes/fresh.md", "content": "# New\n\nline two\nline three"]]))
        add("tool_result", json(["id": "th-2", "result": "File created successfully", "isError": false]))
        add("assistant", "The note is at notes/fresh.md.")
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the history rows"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        // The thinking stands as a calm row, its text NOT in the history.
        let thinking = app.buttons["chat-thinking-row"].firstMatch
        XCTAssertTrue(thinking.waitForExistence(timeout: 25), "The thinking row is missing")
        // Flush at the edge, without a clock before it: the thinking row begins where the text of
        // the answer of the same history begins. The clock used to stand in the icon column, and
        // the button began 17 pt left of the text.
        let responseText = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "The note is at")).firstMatch
        XCTAssertTrue(responseText.waitForExistence(timeout: 10), "The answer text of the history is missing")
        XCTAssertEqual(
            thinking.frame.minX, responseText.frame.minX, accuracy: 1,
            "Thinking row and answer do not begin at the same edge — thinking=\(thinking.frame) answer=\(responseText.frame)"
        )
        let thought = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "thought-process-in-sheet")).firstMatch
        XCTAssertFalse(thought.exists, "The thinking text must not stand in the history")
        thinking.tap()
        XCTAssertTrue(thought.waitForExistence(timeout: 6), "The sheet does not show the thinking")
        XCTAssertTrue(app.navigationBars["Thinking"].exists, "The sheet is not called \"Thinking\"")
        attach(app, "Sheet of the thinking")
        let close = app.buttons["chat-detail-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(thought.waitForNonExistence(timeout: 6), "Closing does not take the thinking away")

        // The group: two commands, one file created, four lines added (the empty line counts).
        let group = app.buttons["chat-tool-row"].firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 5), "The group row is missing")
        XCTAssertTrue(
            group.label.contains("Ran 2 commands, created one file"),
            "The row does not count commands and file, read: \(group.label)"
        )
        XCTAssertTrue(group.label.contains("+4") && group.label.contains("-0"),
                      "The line balance is missing on the row: \(group.label)")
        attach(app, "Rows in the history")
        group.tap()
        let entryButtons = app.buttons.matching(identifier: "chat-detail-entry")
        XCTAssertTrue(entryButtons.firstMatch.waitForExistence(timeout: 6), "The timeline is missing in the sheet")
        XCTAssertEqual(entryButtons.count, 2)
        // The tool's description is the subtitle — not the command.
        XCTAssertTrue(
            app.staticTexts["Look at folder"].exists,
            "The entry must carry the call's description"
        )
        entryButtons.element(boundBy: 1).tap()
        XCTAssertTrue(app.navigationBars["Write"].waitForExistence(timeout: 5), "The page of the Write call is missing")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "notes/fresh.md")).firstMatch.exists,
            "The page does not name the path"
        )
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "line three")).firstMatch.exists,
            "The page does not show the diff"
        )
        attach(app, "Page of the Write call")
        app.buttons["chat-detail-back"].tap()
        XCTAssertTrue(entryButtons.firstMatch.waitForExistence(timeout: 5), "Back does not lead into the timeline")
        close.tap()
        XCTAssertTrue(entryButtons.firstMatch.waitForNonExistence(timeout: 6), "The sheet does not close")
    }

    // ── Tool group: timeline in the sheet, page per call, the history stands still ──
    // Five calls in a row are ONE row ("Ran 5 commands ›"). The tap opens the sheet with the
    // timeline — per call an entry with state and command —, an entry pushes its page (title =
    // tool name, command, result), "‹" leads back, "✕" closes. The history below does not move
    // meanwhile, and the jump arrow must not wake up from the sheet (it used to pop up when
    // unfolding and ate the next tap).
    func testToolGroupRowOpensTimelineSheet() throws {
        let server = try requireFixture()
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func json(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        for index in 0..<10 {
            add("user", "Verlauf Frage \(index)")
            add("assistant", "Verlauf Antwort \(index): "
                + String(repeating: "Text, der die Zeile füllt und mehrfach umbricht. ", count: 3))
        }
        add("user", "Please check the services")
        // 5 consecutive bash calls → ONE row "Ran 5 commands". The third FAILS: the row and the
        // sheet title count it ("(1 failed)"), the "ERROR" label exists only on a single row.
        // Counter-test against the old state: label without counter, "ERROR" beside it.
        for index in 0..<5 {
            add("tool", json(["id": "tg-\(index)", "name": "Bash",
                              "input": ["command": "systemctl status service-\(index)"]]))
            add("tool_result", json([
                "id": "tg-\(index)",
                "result": (0..<12).map { "service-\(index) line \($0)" }.joined(separator: "\n"),
                "isError": index == 2,
            ]))
        }
        add("assistant", "All services running.")
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the history rows"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let header = app.buttons["chat-tool-row"].firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 25), "The group row is missing")
        // The counter stands as a SEPARATE, red text part beside the label. SwiftUI joins the child
        // texts of a button into one label (with a comma), so the CONTAINS checks on both parts
        // still hit; `rowsText` also reads the child texts to be safe, in case a part does not
        // move into the label.
        let row = rowsText(header)
        XCTAssertTrue(
            row.contains("Ran 5 commands"),
            "The group row counts the calls, read: \(row)"
        )
        XCTAssertTrue(
            row.contains("(1 failed)"),
            "The group row does not count the failure, read: \(row)"
        )
        XCTAssertFalse(
            row.contains("ERROR"),
            "The \"ERROR\" label belongs only on a single row — the group carries the counter: \(row)"
        )
        Thread.sleep(forTimeInterval: 2.0)
        let witness = app.staticTexts["Please check the services"]
        XCTAssertTrue(witness.exists, "The user row above the group is missing")
        let headerBefore = header.frame.minY
        let witnessBefore = witness.frame.minY

        header.tap()
        // The sheet: five entries, each with its command as subtitle.
        let entryButtons = app.buttons.matching(identifier: "chat-detail-entry")
        XCTAssertTrue(entryButtons.firstMatch.waitForExistence(timeout: 6), "The timeline is missing in the sheet")
        XCTAssertEqual(entryButtons.count, 5, "Every call needs its entry in the timeline")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "systemctl status service-0")).firstMatch.exists,
            "The entry does not name the command"
        )
        XCTAssertTrue(
            app.navigationBars.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Ran 5 commands")).firstMatch.exists,
            "The sheet does not carry the summary as its title"
        )
        XCTAssertTrue(
            app.navigationBars.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(1 failed)")).firstMatch.exists,
            "The sheet title does not count the failure"
        )
        // The failed entry says so on its row; the four others are done.
        XCTAssertTrue(app.staticTexts["Failed"].exists, "The failed call carries no \"Failed\" in the timeline")
        XCTAssertEqual(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "Done")).count, 4,
            "Four calls are done, one is not"
        )
        attach(app, "Timeline of the group")

        // An entry pushes its page: title "Bash", command and result.
        entryButtons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForExistence(timeout: 5), "The call's page does not carry the tool name")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "service-0 line 0")).firstMatch.waitForExistence(timeout: 5),
            "The page does not show the result"
        )
        attach(app, "Page of a call")
        let back = app.buttons["chat-detail-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "The page has no back button")
        back.tap()
        XCTAssertTrue(entryButtons.firstMatch.waitForExistence(timeout: 5), "Back does not lead into the timeline")

        let close = app.buttons["chat-detail-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "The sheet has no close button")
        close.tap()
        XCTAssertTrue(entryButtons.firstMatch.waitForNonExistence(timeout: 6), "The sheet does not close")
        // The sheet is closed; the timeline settles on its own (the cells re-realise their heights, the
        // arrow's spring fade runs 0.25 s — and under load all of that lags by seconds). The promise is the
        // SETTLED state: a bounded poll until the arrow is gone, no fixed sleep. An arrow that STAYS (the
        // defect this guards against: the sheet pushes the offset off the chat end) still fails after the poll.
        let arrow = app.buttons["jump-to-latest"]
        let settleStart = Date()
        let settleDeadline = settleStart.addingTimeInterval(8)
        var arrowShown = arrow.exists && arrow.isHittable
        while arrowShown, Date() < settleDeadline {
            Thread.sleep(forTimeInterval: 0.25)
            arrowShown = arrow.exists && arrow.isHittable
        }
        XCTAssertFalse(
            arrowShown,
            "The jump arrow appeared because of the sheet and stayed for \(Date().timeIntervalSince(settleStart)) s "
                + "(arrow \(arrow.frame), group row \(header.frame.minY - headerBefore) pt, history \(witness.frame.minY - witnessBefore) pt off)"
        )
        // It also must not come back: a second look after a short rest.
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(arrow.exists && arrow.isHittable, "The jump arrow came back after the sheet")
        XCTAssertEqual(
            header.frame.minY, headerBefore, accuracy: 2,
            "The group row is offset by \(header.frame.minY - headerBefore) pt after the sheet"
        )
        XCTAssertEqual(
            witness.frame.minY, witnessBefore, accuracy: 2,
            "The history above the group is offset by \(witness.frame.minY - witnessBefore) pt after the sheet"
        )
    }

    // ── Edit an artifact: the text IS the input field, saving is by hand ──
    /// The reading view is the editor (no toggle, no second sheet). Typing writes nothing (not
    /// even after four times the old rest time), "Save" writes; afterwards the editor still has
    /// the focus (a rebuild would take it, and `typeText` without a new tap would fail); "Back"
    /// with unsaved text asks, and "Discard changes" writes nothing.
    func testArtifactIsEditedInPlaceAndSavedOnlyByButton() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))

        app.buttons["chat-menu"].tap()
        let artifacts = app.buttons["Artifacts"]
        XCTAssertTrue(artifacts.waitForExistence(timeout: 8), "The chat menu does not list \"Artifacts\"")
        artifacts.tap()
        let folder = app.buttons["artifact-dir-issues"]
        XCTAssertTrue(folder.waitForExistence(timeout: 20), "The artifact tree does not show the folder")
        folder.tap()
        let file = app.buttons["artifact-file-01-login.md"]
        XCTAssertTrue(file.waitForExistence(timeout: 10), "The file is missing in the unfolded folder")
        file.tap()

        // No detour via an edit button: the field stands there at once; "Save" is off without a change.
        let editor = app.textViews["artifact-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 20), "The preview is not an input field")
        XCTAssertFalse(app.buttons["artifact-edit"].exists, "There must be no edit toggle any more")
        let save = app.buttons["artifact-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5), "The preview has no save button")
        XCTAssertFalse(save.isEnabled, "\"Save\" is active without a change")

        let saved = { (self.fixtureJSON(server + "/fixture/artifacts")?["issues/01-login.md"] as? String) ?? "" }
        editor.tap()
        editor.typeText("Addendum: checked.")
        Thread.sleep(forTimeInterval: 2.0)
        XCTAssertFalse(saved().contains("Addendum: checked."), "Saved silently while typing")
        XCTAssertTrue(app.descendants(matching: .any)["artifact-save-state"].exists, "The unsaved state is not visible")
        XCTAssertTrue(save.isEnabled, "\"Save\" stays off despite a change")
        save.tap()

        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline, !saved().contains("Addendum: checked.") { Thread.sleep(forTimeInterval: 0.5) }
        let text = saved()
        XCTAssertTrue(text.contains("Addendum: checked."), "\"Save\" did not write")
        XCTAssertTrue(text.contains("Login-Fehler"), "Typing may only append, not replace the file — what was saved: \(text)")

        // No rebuild on saving: keep typing WITHOUT a new tap.
        editor.typeText(" Second addendum.")
        attach(app, "Artifact edited further after saving")
        let back = app.buttons["artifact-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "With unsaved text the asking Back is missing")
        back.tap()
        let dismiss = app.buttons["Discard changes"]
        XCTAssertTrue(dismiss.waitForExistence(timeout: 5), "\"Back\" does not ask about the unsaved changes")
        dismiss.tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 10), "\"Discard changes\" does not lead back into the tree")
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(saved().contains("Second addendum."), "Saved silently on leaving")
        _ = fixturePost(server + "/fixture/reset-run", body: [:])
    }

    // ── The collective row shimmers only in the RUNNING turn ─────────────────
    /// "Running" used to hang on `!block.done` alone: every group whose call never got a result
    /// (stop, result filed in another row) turned for ever — even after reloading hours later.
    /// Now the cell factory carries `live` (turn runs AND latest answer row) through to the
    /// collective row.
    ///
    /// No spinner turns there: a band of light runs over the sentence (`ChatShimmer`), and
    /// audible — and thus measurable — is only the value of the button: "running".
    ///
    /// Three parts, and the first is the COUNTER-TEST of the measuring instrument: in the running
    /// turn with an open call the row MUST carry the value — otherwise its absence afterwards would
    /// prove nothing. The first of the two calls fails (`error: true`): the running row thus
    /// carries the red counter under the band, and the attachments "Band over the red counter …"
    /// are the picture from which one checks whether it stays readable in red. Then the run ends
    /// (abort), and the row loses the value. Last two histories without a run: a call whose result
    /// lies BEHIND an approval card (the parser assigns backwards and no longer creates an empty
    /// bubble — before, the call stayed open), and an aborted call without a result (not live ⇒
    /// no value).
    func testToolGroupShimmersOnlyInRunningTurn() throws {
        let server = try requireFixture()
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        // AFTER launchApp: its /fixture/reset-run resets the one-shot switches.
        XCTAssertNotNil(fixturePost(server + "/fixture/open-call", body: ["open": true, "error": true]),
                        "The fixture did not accept the switch for the open call")
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        composer.tap()
        composer.typeText("Pending")
        app.buttons["chat-send"].tap()

        // ── Counter-test: in the running turn it runs ──
        // Searched via the LABEL: the first `chat-tool-row` of the run is the task list (TodoWrite,
        // "Update tasks"), the collective row of the bash calls comes after.
        let row = app.buttons.matching(identifier: "chat-tool-row")
            .matching(NSPredicate(format: "label CONTAINS %@", "Ran 2 commands")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "The collective row \"Ran 2 commands\" of the running turn is missing")
        let running = runningToolRow(app)
        if !running.waitForExistence(timeout: 10) {
            let dump = XCTAttachment(string: app.debugDescription)
            dump.name = "Accessibility tree without a running row"
            dump.lifetime = .keepAlways
            self.add(dump)
            XCTFail("In the running turn with an open call no `chat-tool-row` carries the value \"running\" — "
                    + "without this counter-test every absence promise below would be empty")
        }
        XCTAssertTrue(
            running.label.contains("Ran 2 commands"),
            "The collective row of the bash calls must be running, not the finished task list: \(running.label)"
        )
        XCTAssertTrue(
            row.label.contains("failed"),
            "The first call fails — the running row must carry the counter: \(row.label)"
        )
        XCTAssertFalse(
            app.descendants(matching: .any).matching(identifier: "chat-tool-spinner").firstMatch.exists,
            "The spinner is gone — the identifier must no longer exist"
        )
        attach(app, "Collective row running (light band)")
        // The band wanders once over the sentence in 2.2 s: twelve pictures of the ROW over a good
        // two passes — on some it stands over the red counter (does it stay readable in red?).
        for image in 1...12 {
            let capture = XCTAttachment(screenshot: row.screenshot())
            capture.name = "Band over the red counter \(image)"
            capture.lifetime = .keepAlways
            self.add(capture)  // `self.`: the local `add(_:_:)` further below shadows XCTestCase.add
            Thread.sleep(forTimeInterval: 0.25)
        }

        // ── Running → ended: the row loses the value without its text changing ──
        let abort = app.buttons["Stop answering"]
        XCTAssertTrue(abort.waitForExistence(timeout: 5), "The stop button is missing in the running turn")
        abort.tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(identifier: "chat-run-indicator").firstMatch.waitForNonExistence(timeout: 15),
            "The run does not end after aborting"
        )
        XCTAssertTrue(
            waitUntilGone(running, timeout: 10),
            "After the end of the run the row still carries \"running\" — the cell was not reconfigured when `live` changed"
        )
        XCTAssertTrue(row.exists && row.label.contains("Ran 2 commands"),
                      "The collective row must remain after the end of the run: \(row.label)")
        XCTAssertEqual(
            row.value as? String ?? "", "",
            "After the end of the run the collective row carries no value any more, read: \(row.value as? String ?? "(nothing)")"
        )
        attach(app, "Collective row after the end of the run")

        // ── Two histories without a run ──
        var entries: [[String: Any]] = []
        var rowId = 1
        func add(_ role: String, _ text: String) {
            entries.append(["id": rowId, "role": role, "text": text, "ts": rowId, "attachments": [] as [Any]])
            rowId += 1
        }
        func json(_ object: [String: Any]) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
        }
        // Turn 1: call → approval card → ruling → result → figures. The result stands BEHIND the
        // card; the old parser created an empty assistant bubble for it.
        add("user", "Please send the message")
        add("tool", json(["id": "t-fg", "name": "Bash", "input": ["command": "echo approval-afterwards"]]))
        add("approval", json([
            "requestId": "perm-test-1", "toolName": "mcp__teams__teams_send_message", "server": "Teams-Archiv",
            "key": "teams", "tool": "teams_send_message", "description": "Send a message.",
            "writing": true, "input": ["chat": "Anna", "text": "Hallo"], "at": 1_800_000_000_000,
        ]))
        add("approval_ruling", json([
            "requestId": "perm-test-1", "toolName": "mcp__teams__teams_send_message",
            "behavior": "allow", "origin": "user", "at": 1_800_000_060_000,
        ]))
        add("tool_result", json(["id": "t-fg", "result": "approval-afterwards", "isError": false]))
        add("meta", json(["secs": 3, "inTok": 120, "outTok": 20]))
        // Turn 2: call without result, run aborted.
        add("user", "And then wait")
        add("tool", json(["id": "t-ab", "name": "Bash", "input": ["command": "sleep 600"]]))
        add("meta", json(["secs": 1, "inTok": 10, "outTok": 0, "aborted": true]))
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the history rows"
        )
        // Back to the overview and open the chat AGAIN — that way the history goes through the parser.
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.buttons["sidebar-overview"].waitForExistence(timeout: 6), "The chat drawer did not open")
        app.buttons["sidebar-overview"].tap()
        try openFirstChat(app)

        let rows = app.buttons.matching(identifier: "chat-tool-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 25), "The tool rows of the seeded history are missing")
        XCTAssertTrue(app.staticTexts["And then wait"].waitForExistence(timeout: 10), "The second turn is missing")
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertEqual(rows.count, 2, "Two calls, two rows — a third would be the empty bubble of the old parser")
        let values = rows.allElementsBoundByIndex.map { $0.value as? String ?? "" }
        XCTAssertEqual(
            values, ["", ""],
            "Without a running turn no collective row may run — neither the one with a card in between nor the aborted one"
        )
        attach(app, "Collective rows without a run, without light band")

        // The call BEFORE the card is finished: its sheet (ONE call ⇒ directly the page "Bash", no
        // timeline) shows the result "approval-afterwards". With the old parser the result lay in an
        // empty bubble, and the page would stay without a result. The row is the UPPER of the two
        // (the history is inverted, an index says nothing about the position).
        guard let upper = rows.allElementsBoundByIndex.min(by: { $0.frame.minY < $1.frame.minY }) else {
            return XCTFail("No tool row to tap")
        }
        upper.tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForExistence(timeout: 6), "The sheet of the call before the card did not open")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "echo approval-afterwards")).firstMatch.exists,
            "The sheet does not name the command"
        )
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "approval-afterwards")).firstMatch.waitForExistence(timeout: 5),
            "The result behind the approval card was not assigned to the call — the sheet does not show it"
        )
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Running")).firstMatch.exists,
            "The sheet still considers the call running"
        )
        attach(app, "Sheet of the call with a card in between")
        app.buttons["chat-detail-close"].tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForNonExistence(timeout: 6), "The sheet does not close")

        // The aborted call (LOWER row, `sleep 600` without a result): row and sheet must give the
        // same answer. The row says "open" (no light band and no value, because no run); the sheet
        // says "Open" — and does not turn either. Counter-test against the old state: "Running…"
        // with `ProgressView`, for ever.
        guard let lower = rows.allElementsBoundByIndex.max(by: { $0.frame.minY < $1.frame.minY }) else {
            return XCTFail("No tool row of the aborted call to tap")
        }
        lower.tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForExistence(timeout: 6), "The sheet of the aborted call did not open")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "sleep 600")).firstMatch.waitForExistence(timeout: 5),
            "The sheet does not name the aborted command"
        )
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label == %@", "Open")).firstMatch.waitForExistence(timeout: 5),
            "The sheet does not call the call without a result in a finished run \"Open\""
        )
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Running")).firstMatch.exists,
            "The sheet considers the aborted call running — row says open, sheet says \"Running…\""
        )
        XCTAssertEqual(
            app.activityIndicators.count, 0,
            "No spinner may turn in the sheet of a call without a run"
        )
        attach(app, "Sheet of the aborted call: Open, no spinner")
        app.buttons["chat-detail-close"].tap()
        XCTAssertTrue(app.navigationBars["Bash"].waitForNonExistence(timeout: 6), "The sheet of the aborted call does not close")
    }

    // ── One edge: answer, collective row, marker and run hexagon begin alike ──
    /// Text dot, spinner, subagent dot and the hexagons used to stand in a 15 pt icon column, and
    /// the text began 17 pt further in (this test compared the CENTRES of dot and hexagon). Now
    /// the column is gone: the BOX of the run hexagon, the text of the answer, the collective row
    /// and the subagent marker begin at ONE edge — and after aborting the box of the metrics
    /// hexagon too. Measured in the running fixture chat with background agent (run phase, not
    /// waiting phase: there no run indicator stands). Counter-test against the old state: answer,
    /// collective row and marker 17 pt right of the hexagon box.
    func testRunHexagonStandsOnTheTextEdge() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 0))
        // The switch is set BETWEEN `/fixture/reset-run` and the start: `reset-run` resets the
        // run switches, and `launchApp` calls it first — set before that, it would be gone on sending.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/background-agent", body: ["open": true]))
        })
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("Edge")
        app.buttons["chat-send"].tap()

        let response = app.staticTexts["Erste Antwort."]
        XCTAssertTrue(response.waitForExistence(timeout: 20), "The streamed text did not arrive")
        XCTAssertTrue(
            app.descendants(matching: .any).matching(identifier: "chat-run-indicator").firstMatch.waitForExistence(timeout: 20),
            "The run indicator is missing"
        )
        slideInKeyboard(app)

        let hexagon = app.descendants(matching: .any).matching(identifier: "chat-run-hex").firstMatch
        let summaryRow = app.buttons.matching(identifier: "chat-tool-row").firstMatch
        let marker = app.buttons.matching(identifier: "chat-agent-row").firstMatch
        if !hexagon.waitForExistence(timeout: 5) || !summaryRow.waitForExistence(timeout: 5)
            || !marker.waitForExistence(timeout: 5) {
            let dump = XCTAttachment(string: app.debugDescription)
            dump.name = "Accessibility tree without hexagon, collective row or marker"
            dump.lifetime = .keepAlways
            self.add(dump)
            XCTFail("Element not found — hexagon: \(hexagon.exists), collective row: \(summaryRow.exists), marker: \(marker.exists)")
        }
        XCTAssertFalse(
            app.descendants(matching: .any).matching(identifier: "chat-text-dot").firstMatch.exists,
            "No dot stands before the answer any more — the identifier `chat-text-dot` must not exist"
        )
        let situation = "hexagon=\(hexagon.frame) antwort=\(response.frame) sammelzeile=\(summaryRow.frame) marker=\(marker.frame)"
        print("CBASE-MASS text-edge \(situation)")
        add(attachment(situation, "Measures of the edge"))
        // The box, not the rotated picture: its width is the edge length (15 pt at standard font),
        // the envelope of the rotated hexagon would be up to 21 pt wide.
        XCTAssertEqual(hexagon.frame.width, hexagon.frame.height, accuracy: 0.5, "The identifier is not on the square box — \(situation)")
        XCTAssertGreaterThan(hexagon.frame.width, 8, "The hexagon has no frame — \(situation)")
        XCTAssertEqual(response.frame.minX, hexagon.frame.minX, accuracy: 1, "Answer and hexagon box do not begin at the same edge — \(situation)")
        XCTAssertEqual(summaryRow.frame.minX, hexagon.frame.minX, accuracy: 1, "Collective row and hexagon box do not begin at the same edge — \(situation)")
        XCTAssertEqual(marker.frame.minX, hexagon.frame.minX, accuracy: 1, "Subagent marker and hexagon box do not begin at the same edge — \(situation)")
        attach(app, "One edge: answer, rows, hexagon")

        // After aborting: the metrics row ("Aborted after …") stands with its box at the edge too.
        let abort = app.buttons["Stop answering"]
        XCTAssertTrue(abort.waitForExistence(timeout: 5), "The stop button is missing in the running turn")
        abort.tap()
        let metricHex = app.descendants(matching: .any).matching(identifier: "chat-metric-hex").firstMatch
        XCTAssertTrue(metricHex.waitForExistence(timeout: 15), "The metrics row is missing after aborting")
        let situationAfterwards = "metricHex=\(metricHex.frame) antwort=\(response.frame)"
        print("CBASE-MASS text-edge-afterwards \(situationAfterwards)")
        XCTAssertEqual(metricHex.frame.minX, response.frame.minX, accuracy: 1, "The metrics row does not begin at the edge — \(situationAfterwards)")
        attach(app, "Metrics row at the edge")
    }

    /// The server compacts on its own (`auto: true` in the meta row). The divider for it is called
    /// "Context compacted automatically" — the one by hand still "Context compacted"; both stand
    /// in the fixture history with the invisible turns. Counter-test against the old state: both
    /// rows had the same name.
    func testCompactionDividerNamesAutomaticCompaction() throws {
        let server = try requireFixture()
        defer { _ = setFixtureHistory(server, count: 0) }
        XCTAssertTrue(setFixtureHistory(server, count: 1, invisible: true))
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Sichtbare Antwort 1"].waitForExistence(timeout: 25))
        let ofHand = app.staticTexts["Context compacted"]
        let automatic = app.staticTexts["Context compacted automatically"]
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        for _ in 0..<6 where !(ofHand.exists && automatic.exists) {
            timeline.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertTrue(automatic.waitForExistence(timeout: 15), "The divider row of the automatic compaction is missing or named wrongly")
        XCTAssertTrue(ofHand.exists, "The divider row of the manual compaction must remain beside it")
        XCTAssertGreaterThan(automatic.frame.height, 8, "The divider row has no readable height")
        attach(app, "Divider context compacted automatically")
    }

    /// A dynamic workflow leaves EXACTLY two rows of the own role `workflow_marker` in the history —
    /// the start marker and the end marker with the outcome. From the history (fixture `POST
    /// /fixture/workflow-markers {history}`) both stand there as a divider, visible in the window,
    /// with the name from `meta`; no raw JSON as a user bubble. Live (`{live}`) start and end of a
    /// second run come in. Identifier at the TEXT (`chat-workflow-marker-<phase>`), not at the
    /// stack. Counter-test against the old state: the role fell into `default` in the timeline
    /// build — no row, the first check is red.
    func testWorkflowMarkersStandInHistoryAndComeLive() throws {
        let server = try requireFixture()
        // The switch BETWEEN `reset-run` and the app start (`launchApp` clears beforehand, `reset-run` resets it).
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/workflow-markers", body: ["history": true]), "The fixture did not accept the switch")
        })
        try openFirstChat(app)
        let start = app.staticTexts.matching(identifier: "chat-workflow-marker-start")
        let end = app.staticTexts.matching(identifier: "chat-workflow-marker-end")
        XCTAssertTrue(start.firstMatch.waitForExistence(timeout: 25), "The start marker is missing in the history")
        XCTAssertTrue(end.firstMatch.waitForExistence(timeout: 10), "The end marker is missing in the history")
        let window = app.windows.firstMatch.frame
        for (what, marker) in [("Start", start.firstMatch), ("End", end.firstMatch)] {
            XCTAssertTrue(window.intersects(marker.frame) && marker.frame.height > 8, "\(what)-marker is not visible in the window: \(marker.frame)")
            XCTAssertTrue(marker.label.contains("findings-collect"), "\(what)-marker does not name the name: \(marker.label)")
        }
        XCTAssertLessThan(start.firstMatch.frame.minY, end.firstMatch.frame.minY, "The start marker belongs ABOVE the end marker")
        XCTAssertTrue(end.firstMatch.label.contains("failed") || end.firstMatch.label.contains("failed"), "The end marker does not name the outcome: \(end.firstMatch.label)")
        let json = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "\"phase\"")).firstMatch
        XCTAssertFalse(json.exists, "The raw JSON of the marker stands as a bubble in the history")

        // Live: start and end of a second run — one row more each.
        XCTAssertNotNil(fixturePost(server + "/fixture/workflow-markers", body: ["live": "start"]))
        let liveStart = start.matching(NSPredicate(format: "label CONTAINS %@", "live-run")).firstMatch
        XCTAssertTrue(liveStart.waitForExistence(timeout: 15), "The start marker did not arrive live")
        XCTAssertNotNil(fixturePost(server + "/fixture/workflow-markers", body: ["live": "end"]))
        let liveEnd = end.matching(NSPredicate(format: "label CONTAINS %@", "live-run")).firstMatch
        XCTAssertTrue(liveEnd.waitForExistence(timeout: 15), "The end marker did not arrive live")
        XCTAssertEqual(start.count, 2, "exactly one start marker per run")
        XCTAssertEqual(end.count, 2, "exactly one end marker per run")
        attach(app, "Workflow markers from the history and live")
    }

    /// The approval card of a dynamic workflow. From the history (fixture `POST
    /// /fixture/workflow-approval {history}`) two open cards of the own role `workflow_approval`
    /// stand there with name, description and phases from `meta`; accepting on the first and
    /// rejecting on the second each go ONCE to `POST /api/chats/<id>/dyn-workflows/approval`
    /// (path not pre-encoded), and each card shows its ruling afterwards instead of the buttons.
    /// Identifiers at button and text, not at the stack. Counter-test against the old state: the
    /// role fell into `default` in the timeline build — no card, the first check is red.
    func testWorkflowApprovalCardAcceptAndReject() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/workflow-approval", body: ["history": true]), "The fixture did not accept the switch")
        })
        try openFirstChat(app)
        let headers = app.descendants(matching: .any).matching(identifier: "chat-workflow-approval")
        XCTAssertTrue(headers.firstMatch.waitForExistence(timeout: 25), "The approval card is missing in the history")
        XCTAssertEqual(headers.count, 2, "two open cards")
        XCTAssertTrue(app.staticTexts["findings-check"].exists, "the name from meta is missing")
        XCTAssertTrue(app.staticTexts["Zwei Befunde gegenlesen"].exists, "the description from meta is missing")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Urteilen — je Befund")).firstMatch.exists, "the phase including detail is missing")
        let json = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "\"requestId\"")).firstMatch
        XCTAssertFalse(json.exists, "The raw JSON of the card stands as a bubble in the history")

        let accept = app.buttons.matching(identifier: "chat-workflow-approval-accept")
        let reject = app.buttons.matching(identifier: "chat-workflow-approval-reject")
        let decide = app.descendants(matching: .any).matching(identifier: "chat-workflow-approval-ruling")
        XCTAssertEqual(accept.count, 2)
        XCTAssertTrue(waitUntilHittable(accept.element(boundBy: 0), timeout: 10), "Accepting on the first card is not tappable")
        accept.element(boundBy: 0).tap()
        XCTAssertTrue(waitUntil(timeout: 10) { decide.count == 1 && accept.count == 1 }, "After accepting, the first card shows its ruling")
        XCTAssertTrue(waitUntilHittable(reject.element(boundBy: 0), timeout: 10), "Rejecting on the second card is not tappable")
        reject.element(boundBy: 0).tap()
        XCTAssertTrue(waitUntil(timeout: 10) { decide.count == 2 && accept.count == 0 && reject.count == 0 }, "After rejecting, the second card shows its ruling too")
        let labels = (0..<decide.count).map { decide.element(boundBy: $0).label }
        XCTAssertTrue(labels.contains { $0 == "accepted" || $0 == "accepted" } && labels.contains { $0 == "rejected" || $0 == "rejected" }, "Rulings: \(labels)")

        let snapshot = fixtureJSON(server + "/fixture/workflow-approval")
        let requests = (snapshot?["requests"] as? [[String: Any]] ?? []).map { "\($0["requestId"] as? String ?? "")=\($0["decision"] as? String ?? "")" }
        XCTAssertEqual(requests, ["11111111-1111-4111-8111-111111111111=accept", "22222222-2222-4222-8222-222222222222=reject"], "exactly one ruling per card at the server")
        attach(app, "Approval cards accepted and rejected")
    }

    /// The progress tree of the dynamic workflows in the subagent sheet of the coding chat — the
    /// same state as in the web bar (the calculation is bound, web/test/dyn-tree-binding.test.mjs):
    /// header with name, phase, n/m, stop and the latest log() line, per phase a card with n/m
    /// (the running one open, the finished one closed — a tap unfolds it), agent rows with state
    /// word (as a value, from `HistoryState`) and tokens with lower-bound marker. A tap on a
    /// workflow agent opens its transcript as the same timeline as the steps of a subagent, a step
    /// leads to the page of its call. The stop at the header sends EXACTLY the human stop (read
    /// at the fixture), the header afterwards shows the end state from the event `dynwf_tree`. The
    /// chat has no subagent — the empty sentence does not stand there anyway.
    func testDynWorkflowTreeInAgentsSheet() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-tree", body: ["seed": "running"]), "The fixture did not accept the tree switch")
        })
        try openFirstChat(app)
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        button.tap()

        let header = app.buttons["chat-dynwf-header-wf_tree0001"]
        XCTAssertTrue(header.waitForExistence(timeout: 15), "The head of the running workflow is missing in the sheet")
        XCTAssertEqual(header.label, "findings-check")
        XCTAssertEqual(header.value as? String, "1/5", "n/m: only \"done\" counts, m are all agent() calls")
        XCTAssertTrue(app.staticTexts["chat-dynwf-phase-wf_tree0001"].label.contains("Prüfen"), "the current phase is missing")
        let outcome = app.staticTexts["chat-dynwf-outcome-wf_tree0001"]
        XCTAssertTrue(["running", "running"].contains(outcome.label), "Outcome: \(outcome.label)")
        let logs = app.staticTexts.matching(identifier: "chat-dynwf-log")
        // Compact as in the web: the latest log() line.
        XCTAssertEqual(logs.count, 1, "the latest log() line")
        XCTAssertEqual(logs.element(boundBy: 0).label, "Befund B wartet")
        XCTAssertTrue(app.buttons["chat-dynwf-log-more"].exists, "the older log() lines are not announced")
        let bands = app.descendants(matching: .any).matching(identifier: "chat-dynwf-band")
        XCTAssertEqual((0..<bands.count).map { bands.element(boundBy: $0).label }, ["Lesen", "Prüfen"],
                       "phase cards per phase with agents, without the closed second run")
        // The phase from meta.phases in which no agent has run yet stands as a row of its own.
        let empty = app.descendants(matching: .any).matching(identifier: "chat-dynwf-band-empty")
        XCTAssertEqual((0..<empty.count).map { empty.element(boundBy: $0).label }, ["Report"], "the coming phase \"Report\" is missing")
        XCTAssertTrue(["pending", "pending"].contains(empty.element(boundBy: 0).value as? String ?? ""), "\"Report\" is pending")
        XCTAssertEqual((0..<bands.count).map { bands.element(boundBy: $0).value as? String ?? "" }, ["1/2", "0/3"], "n/m per card")
        let row = { (n: Int) in app.buttons["chat-dynwf-agent-wf_tree0001-\(n)"] }
        let value = { (n: Int) in row(n).value as? String ?? "" }
        // The running phase stands open, the finished one closed (`DynTree.bandDefaultOpen`) — a tap unfolds it.
        XCTAssertTrue(row(3).exists, "the running phase \"Prüfen\" stands open")
        XCTAssertFalse(row(1).exists, "the finished phase \"Lesen\" stands closed")
        let read = bands.element(boundBy: 0)
        XCTAssertTrue(scrollUntilHittable(app, read), "the card \"Lesen\" is not tappable")
        read.tap()
        XCTAssertTrue(row(1).waitForExistence(timeout: 5), "a tap does not unfold the finished phase")
        for n in 1...5 { XCTAssertTrue(row(n).exists, "Agent row \(n) is missing") }
        XCTAssertEqual(value(1), "", "done carries no word")
        XCTAssertTrue(["skipped", "skipped"].contains(value(2)), "skipped: \(value(2))")
        XCTAssertTrue(["running", "running"].contains(value(3)), "running: \(value(3))")
        XCTAssertTrue(["waiting", "waiting"].contains(value(4)), "waiting is not \"idle\": \(value(4))")
        XCTAssertTrue(["Error", "Error"].contains(value(5)), "error: \(value(5))")
        let tokens = { (n: Int) in app.staticTexts["chat-dynwf-tokens-wf_tree0001-\(n)"].value as? String ?? "" }
        XCTAssertEqual(tokens(1), "18k")
        XCTAssertEqual(tokens(3), "≥5k", "only the output reported: the number is a lower bound")
        XCTAssertEqual(tokens(4), "–", "without tokens a dash, no zero")
        let finished = app.buttons["chat-dynwf-header-wf_tree0002"]
        XCTAssertTrue(finished.exists, "the finished run is missing")
        XCTAssertEqual(finished.value as? String, "1/1")
        XCTAssertFalse(app.buttons["chat-dynwf-agent-wf_tree0002-1"].exists, "a finished run stands closed")
        XCTAssertFalse(app.buttons["chat-dynwf-stop-wf_tree0002"].exists, "a finished run has no stop")
        XCTAssertFalse(app.staticTexts["chat-agents-empty"].exists, "a chat with a workflow is not \"without subagent\"")
        attach(app, "Progress tree in the agents sheet")

        // A tap on the workflow agent: its page, the transcript as a timeline, a step onto its page.
        XCTAssertTrue(scrollUntilHittable(app, row(1)), "Agent row 1 is not tappable")
        row(1).tap()
        let title = app.staticTexts["chat-dynwf-agent-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the page of the workflow agent is missing")
        XCTAssertEqual(title.label, "Quellen lesen")
        XCTAssertTrue(app.staticTexts["chat-dynwf-job"].waitForExistence(timeout: 10), "the job is missing")
        let steps = app.buttons.matching(identifier: "chat-detail-entry")
        XCTAssertTrue(waitUntil(timeout: 10) { steps.count == 3 }, "thinking, tool and text as steps: \(steps.count)")
        let tool = steps.element(boundBy: 1)
        XCTAssertTrue(scrollUntilHittable(app, tool), "the tool step is not tappable")
        tool.tap()
        let back = app.buttons["chat-detail-back"]
        XCTAssertTrue(back.waitForExistence(timeout: 10), "the step does not open the page of its call")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "src/app.ts")).firstMatch.exists, "the call page does not show the file")
        back.tap()
        let all = app.buttons["chat-agents-back"]
        XCTAssertTrue(waitUntilHittable(all, timeout: 10), "back to the overview is missing")
        all.tap()

        // The human stop at the header.
        let stop = app.buttons["chat-dynwf-stop-wf_tree0001"]
        XCTAssertTrue(waitUntilHittable(stop, timeout: 10), "Stop at the head is not tappable")
        stop.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label IN %@", ["Stop workflow", "Stop workflow"])).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the confirmation is missing")
        confirm.tap()
        var stops: [[String: Any]] = []
        XCTAssertTrue(waitUntil(timeout: 10) {
            stops = (self.fixtureJSON(server + "/fixture/dyn-tree")?["stops"] as? [[String: Any]]) ?? []
            return !stops.isEmpty
        }, "the fixture saw no stop request")
        XCTAssertEqual(stops.count, 1, "exactly one stop request: \(stops)")
        XCTAssertEqual(stops.first?["runId"] as? String, "wf_tree0001")
        XCTAssertEqual(stops.first?["from"] as? String, "human", "the stop at the head is the human one")
        XCTAssertTrue(waitUntil(timeout: 10) { outcome.label.contains("by you") || outcome.label.contains("by you") }, "end state at the head: \(outcome.label)")
        XCTAssertTrue(waitUntilGone(stop, timeout: 10), "after the stop no stop button stands any more")
        XCTAssertTrue(["stopped", "stopped"].contains(value(3)), "the running agent is stopped: \(value(3))")
        XCTAssertEqual(header.value as? String, "1/5", "Stopped ones do not count as done")
        attach(app, "Workflow stopped")
    }

    /// The two actions per workflow agent in the rows of the sheet — Restart and Skip, OWN buttons
    /// (identifier at the button). Only the running agent with a process carries them; the waiting
    /// one without a process, the finished ones and the closed second run do not, and a "stop per
    /// agent" stands nowhere. Both requests stand at the fixture (run id, n, kind), the new state
    /// comes with `dynwf_tree`: first "restarted 1×", then "skipped" without buttons.
    func testDynWorkflowAgentSkipAndRestart() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-tree", body: ["seed": "running"]), "The fixture did not accept the tree switch")
        })
        try openFirstChat(app)
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        button.tap()
        XCTAssertTrue(app.buttons["chat-dynwf-header-wf_tree0001"].waitForExistence(timeout: 15), "The head of the running workflow is missing in the sheet")
        let restart = { (n: Int) in app.buttons["chat-dynwf-restart-wf_tree0001-\(n)"] }
        let jump = { (n: Int) in app.buttons["chat-dynwf-skip-wf_tree0001-\(n)"] }
        let row3 = app.buttons["chat-dynwf-agent-wf_tree0001-3"]
        XCTAssertTrue(restart(3).waitForExistence(timeout: 10), "\"Restart\" is missing on the running agent")
        XCTAssertTrue(jump(3).exists, "\"Skip\" is missing on the running agent")
        for n in [1, 2, 4, 5] { XCTAssertFalse(restart(n).exists || jump(n).exists, "Agent \(n) carries an action") }
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier CONTAINS %@", "wf_tree0002")).allElementsBoundByIndex
            .contains { $0.identifier.contains("restart") || $0.identifier.contains("skip") }, "the finished run carries actions")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-dynwf-agent-stop")).firstMatch.exists,
                       "no third word \"stop per agent\"")
        let interventions = { (self.fixtureJSON(server + "/fixture/dyn-tree")?["interventions"] as? [[String: Any]]) ?? [] }

        XCTAssertTrue(scrollUntilHittable(app, restart(3)), "\"Restart\" is not tappable")
        restart(3).tap()
        XCTAssertTrue(waitUntil(timeout: 10) { interventions().count == 1 }, "the fixture saw no restart request")
        XCTAssertEqual(interventions().first?["runId"] as? String, "wf_tree0001")
        XCTAssertEqual(interventions().first?["n"] as? Int, 3)
        XCTAssertEqual(interventions().first?["kind"] as? String, "restart")
        let newlyStarted = { () -> [String] in [row3.label] + app.staticTexts.allElementsBoundByIndex.map(\.label) }
        XCTAssertTrue(waitUntil(timeout: 10) { newlyStarted().contains { $0.contains("neu gestartet") || $0.contains("restarted") } },
                      "the row does not say \"restarted 1×\": \(row3.label)")
        XCTAssertTrue(["running", "running"].contains(row3.value as? String ?? ""), "after the restart the agent keeps running")
        attach(app, "Workflow agent restarted")

        XCTAssertTrue(waitUntil(timeout: 10) { jump(3).isEnabled }, "\"Skip\" is still disabled after the restart")
        XCTAssertTrue(scrollUntilHittable(app, jump(3)), "\"Skip\" is not tappable")
        jump(3).tap()
        XCTAssertTrue(waitUntil(timeout: 10) { interventions().count == 2 }, "the fixture saw no skip request")
        XCTAssertEqual(interventions().last?["n"] as? Int, 3)
        XCTAssertEqual(interventions().last?["kind"] as? String, "skip")
        XCTAssertTrue(waitUntil(timeout: 10) { ["skipped", "skipped"].contains(row3.value as? String ?? "") }, "the row does not say \"skipped\"")
        XCTAssertTrue(waitUntilGone(jump(3), timeout: 10), "a skipped agent carries no action any more")
        XCTAssertFalse(restart(3).exists, "a skipped agent does not restart")
        XCTAssertTrue(app.buttons["chat-dynwf-stop-wf_tree0001"].exists, "the stop of the whole workflow stays at the head")
        attach(app, "Workflow agent skipped")
    }

    /// A view ONLY from the required fields (run id, agent list — without log() lines, phases,
    /// tokens, model, label) does not make the sheet unreadable: a synthesised `Decodable` would
    /// have discarded the whole tree.
    func testDynWorkflowTreeWithoutOptionalFields() throws {
        let server = try requireFixture()
        _ = fixturePost(server + "/fixture/history", body: ["count": 0])
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-tree", body: ["seed": "karg"]), "The fixture did not accept the tree switch")
        })
        try openFirstChat(app)
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The subagent button is missing in the chat header")
        button.tap()
        let header = app.buttons["chat-dynwf-header-wf_tree0003"]
        XCTAssertTrue(header.waitForExistence(timeout: 15), "the sparse run is missing in the sheet")
        XCTAssertEqual(header.value as? String, "0/2")
        XCTAssertTrue(["no phase yet", "no phase yet"].contains(app.staticTexts["chat-dynwf-phase-wf_tree0003"].label))
        XCTAssertEqual(app.staticTexts.matching(identifier: "chat-dynwf-log").count, 0)
        let first = app.buttons["chat-dynwf-agent-wf_tree0003-1"]
        XCTAssertTrue(waitUntilHittable(first, timeout: 10), "the agent row is not tappable")
        XCTAssertTrue(app.buttons["chat-dynwf-agent-wf_tree0003-2"].exists, "an agent without a label is missing")
        XCTAssertEqual(app.staticTexts["chat-dynwf-tokens-wf_tree0003-1"].value as? String, "–")
        XCTAssertFalse(app.staticTexts["chat-agents-empty"].exists, "a chat with a workflow is not \"without subagent\"")
        first.tap()
        XCTAssertTrue(app.staticTexts["chat-dynwf-transcript-empty"].waitForExistence(timeout: 10), "an empty transcript says so")
        attach(app, "Sparse tree")
    }

    /// ONE list, newest on top, subagents and workflows MIXED. Three finished subagents (without
    /// start time — the place in the history orders them) and two runs (start 1 h and 60 s ago,
    /// `dynTreeSeed` "running") alternately in the history, the start markers in between.
    /// Counter-test (on the code, not run): in the old state the workflows stand under "Dynamic
    /// Workflows" ABOVE all subagents — the order below is red.
    func testBackgroundTasksNewestTopMixed() throws {
        let server = try requireFixture()
        func js(_ o: [String: Any]) -> String { String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)! }
        var entries: [[String: Any]] = []
        func add(_ role: String, _ text: String) { entries.append(["id": entries.count + 1, "role": role, "text": text, "ts": entries.count + 1, "attachments": [] as [Any]]) }
        func agent(_ id: String, _ job: String) {
            add("tool", js(["id": id, "name": "mcp__cbase__cbase_agent", "detail": job, "input": ["description": job, "prompt": "p"]]))
            add("tool_result", js(["id": id, "result": js(["status": "completed", "agentId": "a-\(id)", "description": job, "provider": "claude",
                                                           "report": "Report \(job)", "totalTokens": 1200, "totalDurationMs": 9000, "tokenKind": "full"]), "isError": false]))
        }
        func start(_ runId: String, _ name: String) { add("workflow_marker", js(["phase": "start", "runId": runId, "taskId": "t-\(runId)", "name": name, "at": 1])) }
        add("user", "Mix background tasks")
        agent("toolu_bg_old", "Job old")
        start("wf_tree0002", "daily-report")
        agent("toolu_bg_middle", "Job middle")
        start("wf_tree0001", "findings-check")
        agent("toolu_bg_new", "Job new")
        add("assistant", "All started")
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/history", body: ["entries": entries]), "The fixture did not accept the history")
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-tree", body: ["seed": "running"]), "The fixture did not accept the tree switch")
        })
        defer { _ = fixturePost(server + "/fixture/history", body: ["count": 0]) }
        try openFirstChat(app)
        let button = app.buttons["chat-agents"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The agents button is missing in the chat header")
        button.tap()
        XCTAssertTrue(app.buttons["chat-dynwf-header-wf_tree0001"].waitForExistence(timeout: 15), "The running workflow is missing in the list")
        XCTAssertTrue(app.staticTexts["chat-bg-tasks"].exists, "The heading \"Background Tasks\" is missing")
        XCTAssertFalse(app.staticTexts["chat-agents-main-run"].exists, "The main-run card is gone")
        let row = { (job: String) in
            app.buttons.matching(identifier: "chat-agents-row").matching(NSPredicate(format: "label CONTAINS %@", job)).firstMatch
        }
        // Two sections: the running run stands under "Running" on top, the rest under "Finished".
        let followUp: [(String, XCUIElement)] = [
            ("wf_tree0001", app.buttons["chat-dynwf-header-wf_tree0001"]), ("Job new", row("Job new")),
            ("Job middle", row("Job middle")), ("wf_tree0002", app.buttons["chat-dynwf-header-wf_tree0002"]),
            ("Job old", row("Job old")),
        ]
        for (name, e) in followUp { XCTAssertTrue(e.waitForExistence(timeout: 5), "\(name) is missing in the list") }
        let ys = followUp.map { $0.1.frame.minY }
        XCTAssertEqual(ys, ys.sorted(), "Running before finished, within that newest on top, mixed — expected \(followUp.map(\.0)), read y = \(ys)")
        XCTAssertEqual(Set(app.staticTexts.matching(identifier: "chat-agents-word").allElementsBoundByIndex.map(\.label)), ["done"])
        // For the picture: fold the running run shut and drag the sheet fully up by its title row — all five cards.
        app.buttons["chat-dynwf-header-wf_tree0001"].tap()
        let heading = app.staticTexts["chat-bg-tasks"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        heading.withOffset(CGVector(dx: 0, dy: -52)).press(forDuration: 0.2, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)))
        XCTAssertTrue(row("Job old").waitForExistence(timeout: 5), "After dragging up the oldest card is missing")
        attach(app, "Background Tasks: newest on top, mixed")
    }
}
