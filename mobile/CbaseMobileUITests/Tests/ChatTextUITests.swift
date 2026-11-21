// Chat text UI tests: text marker (partial selection of a message), markdown rendering, text size in the open chat.
import XCTest

final class ChatTextUITests: CbaseUITestBase {
    // ── Text marker (partial selection of a message) ─────────────────────────
    //
    // A long press ON the message text starts the blue marker instead of the whole-message
    // dialog; on release the small "Reply / Copy" menu appears at the marker. "Reply" puts the
    // selection as a quote in the card above the composer and opens the keyboard.
    func testLongPressOnMessageTextMarksAndAsksAboutSelection() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let paragraph = app.staticTexts["Wichtig: die Warteschlange nicht leeren."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 25), "The paragraph is missing in the history")

        // Fixed point in the FIRST word — the element's centre might lie between two words;
        // the marker must still find a word under the finger.
        paragraph
            .coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(forDuration: 1.0)

        let ask = app.buttons["chat-selection-ask"]
        XCTAssertTrue(
            ask.waitForExistence(timeout: 5),
            "The marker menu did not appear after release"
        )
        // The whole-message dialog (long press on the bubble) must NOT open as well — the
        // marker has taken over the touch.
        XCTAssertFalse(
            app.sheets.firstMatch.exists,
            "The message dialog is on top of the marker menu"
        )

        ask.tap()
        // The selection lies as a quote in the card above the field, not in the field.
        let quote = app.staticTexts["chat-quote-0"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "The quote card is missing")
        let value = quote.label
        XCTAssertTrue(
            !value.isEmpty,
            "The selection must lie as a quote above the composer — instead: \"\(value)\""
        )
        // The anchor must be the word UNDER THE FINGER (press point at 5 % = "Wichtig"), not any
        // other — a twisted point→character mapping or a detection that only catches up on
        // lift-off failed exactly here.
        XCTAssertTrue(
            value.contains("Wichtig"),
            "The marker must start at the pressed word — instead: \"\(value)\""
        )
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "\"Reply\" must open the keyboard"
        )
        attach(app, "Quote above the composer after Reply")
    }

    // Dragging AFTER the long press extends the selection live under the finger — also across
    // block boundaries (intermediate blocks whole, the target block up to the word under the
    // finger; unselectable lines such as tables are skipped).
    func testMarkerDragExtendsSelectionAcrossBlocks() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let start = app.staticTexts["Wichtig: die Warteschlange nicht leeren."]
        XCTAssertTrue(start.waitForExistence(timeout: 25), "The start paragraph is missing in the history")
        let end = app.staticTexts["Alter Weg ist ersetzt, siehe Bericht."]
        XCTAssertTrue(end.waitForExistence(timeout: 10), "The target paragraph is missing in the history")

        start
            .coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(
                // The marker takes over after 0.5 s — the hold time must be clearly above that,
                // otherwise the drag begins before detection and scrolls the chat.
                forDuration: 1.0,
                thenDragTo: end.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)),
                withVelocity: .slow,
                thenHoldForDuration: 0.4
            )

        let ask = app.buttons["chat-selection-ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "The marker menu is missing after the drag")
        ask.tap()
        // The selection lies as a quote in the card above the field, not in the field.
        let quote = app.staticTexts["chat-quote-0"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "The quote card is missing")
        let value = quote.label
        XCTAssertTrue(
            value.hasPrefix("Wichtig"),
            "The selection must start at the anchor word — instead: \"\(value)\""
        )
        XCTAssertTrue(
            value.contains("leeren."),
            "The rest of the start paragraph is missing in the selection: \"\(value)\""
        )
        XCTAssertTrue(
            value.contains("Alter Weg"),
            "The selection does not reach into the target paragraph: \"\(value)\""
        )
        attach(app, "Selection across blocks as a quote in the composer")
    }

    // As soon as the marker owns the touch (0.5 s), SIDEWAYS dragging belongs to it too: it
    // extends the selection within the line — the left drawer must not open any more. (The
    // window pan of the drawer used to take the sideways pull and cancel the selection; see
    // `gestureRecognizerShouldBegin` in `HorizontalPanReader`.)
    func testMarkerSidewaysDragExtendsWithinLineAndKeepsDrawerClosed() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let paragraph = app.staticTexts["Wichtig: die Warteschlange nicht leeren."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 25), "The paragraph is missing in the history")
        // Let the freshly opened chat settle first: if the main thread hangs during the initial
        // build, the marker's 0.5 s timer fires late — then the drawer pan wins the race for the
        // sideways pull.
        Thread.sleep(forTimeInterval: 1.0)

        // Hold clearly beyond the 0.5 s threshold, then drag across the line — exactly the
        // movement that used to open the drawer.
        paragraph
            .coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(
                forDuration: 1.0,
                thenDragTo: paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)),
                withVelocity: .slow,
                thenHoldForDuration: 0.4
            )

        let ask = app.buttons["chat-selection-ask"]
        XCTAssertTrue(
            ask.waitForExistence(timeout: 5),
            "The marker menu is missing after the sideways drag — did the drawer take the gesture?"
        )
        XCTAssertFalse(
            app.buttons["sidebar-overview"].isHittable,
            "Sideways dragging during the selection must not open the left drawer"
        )

        ask.tap()
        // The selection lies as a quote in the card above the field, not in the field.
        let quote = app.staticTexts["chat-quote-0"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "The quote card is missing")
        let value = quote.label
        XCTAssertTrue(
            value.hasPrefix("Wichtig"),
            "The selection must start at the anchor word — instead: \"\(value)\""
        )
        XCTAssertTrue(
            value.contains("Warteschlange"),
            "Sideways dragging must extend the selection within the line: \"\(value)\""
        )
        attach(app, "Sideways extended selection as a quote in the composer")
    }

    // After lift-off the selection and its menu stay — AND the history remains scrollable.
    // A screen-sized backdrop used to lie over the chat, take every tap as "close" and swallow
    // every scroll movement.
    func testSelectionAndMenuSurviveScrolling() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let paragraph = app.staticTexts["Wichtig: die Warteschlange nicht leeren."]
        XCTAssertTrue(paragraph.waitForExistence(timeout: 25), "The paragraph is missing in the history")
        Thread.sleep(forTimeInterval: 1.0)

        paragraph
            .coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(forDuration: 1.0)

        let ask = app.buttons["chat-selection-ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "The marker menu did not appear")

        // Scroll briefly — a pull is not a tap, so the selection must not disappear.
        // Direction: the history sits at the NEWEST end (inverted list), so drag downwards to
        // scroll into the past; upwards would only bounce.
        let timeline = app.collectionViews["chat-timeline"]
        XCTAssertTrue(timeline.exists, "The history list is missing")
        let menuBefore = ask.frame.midY
        let textBefore = paragraph.frame.midY
        timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            .press(
                forDuration: 0.05,
                thenDragTo: timeline.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)),
                withVelocity: .slow,
                thenHoldForDuration: 0.1
            )
        XCTAssertTrue(
            ask.waitForExistence(timeout: 3),
            "Scrolling must not remove the selection and its menu"
        )
        // The menu hangs on the selected text: it must have moved the same distance as the text.
        let textMoved = paragraph.frame.midY - textBefore
        let menuMoved = ask.frame.midY - menuBefore
        XCTAssertTrue(
            abs(textMoved) > 4,
            "The drag did not scroll the history — checking the menu tracking is not possible"
        )
        XCTAssertEqual(
            menuMoved, textMoved, accuracy: 6,
            "The menu must follow the scrolled selection (text \(textMoved) pt, menu \(menuMoved) pt)"
        )

        // And the selection itself survived: "Reply" still puts it down as a quote.
        ask.tap()
        // The selection lies as a quote in the card above the field, not in the field.
        let quote = app.staticTexts["chat-quote-0"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "The quote card is missing")
        let value = quote.label
        XCTAssertTrue(
            value.contains("Wichtig"),
            "The selection must have survived the scrolling — instead: \"\(value)\""
        )
        attach(app, "Selection still in the menu after scrolling")
    }

    // ── Scroll performance: measurement diagnostic (on request only) ─────────
    //
    // Not a guard but a MEASUREMENT: with CBASE_PERF_PROBE set the app writes a runtime table
    // (see `PerfProbe`); this test produces the two movements in question and attaches the
    // table. Two phases, evaluated separately: normal scrolling up/down, and selecting with
    // auto-scroll at the edge. The history deliberately consists of MARKDOWN messages — short
    // "Antwort N" lines say nothing about scroll performance.
    func testChatScrollPerformanceProbe() throws {
        guard let out = ProcessInfo.processInfo.environment["CBASE_PERF_PROBE"] else {
            throw XCTSkip("Hand diagnostics only: set TEST_RUNNER_CBASE_PERF_PROBE to a path.")
        }
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 25, markdown: true),
            "The fixture gateway did not accept the long markdown history"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server, environment: [
            "CBASE_PERF_PROBE": out,
            // The initial build of the chat is the most expensive single moment of the session;
            // without this cut every maximum would be its, not the scrolling's.
            "CBASE_PERF_PROBE_RESET": "6",
        ])
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 30),
            "The chat was not opened"
        )
        // Wait longer than the cut above: measuring only starts after it.
        Thread.sleep(forTimeInterval: 8.0)
        let window = app.windows.element(boundBy: 0)

        // ── Phase 1: normal scrolling, with momentum (inertial scrolling is part of it) ──
        for _ in 0..<7 {
            window.swipeDown(velocity: .fast)   // mirrored: into the past
            Thread.sleep(forTimeInterval: 0.6)
        }
        for _ in 0..<7 {
            window.swipeUp(velocity: .fast)
            Thread.sleep(forTimeInterval: 0.6)
        }
        Thread.sleep(forTimeInterval: 1.5)
        let scrollReport = (try? String(contentsOfFile: out, encoding: .utf8)) ?? "(no File)"
        add(attachment(scrollReport, "Probe after scrolling"))
        print("── PERF after scroll phase ──\n" + scrollReport)

        // ── Phase 2: select and move the finger to the top edge ──
        let paragraph = app.staticTexts
            .matching(NSPredicate(format: "label == %@", "Wichtig: die Warteschlange nicht leeren."))
            .firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 15), "No paragraph found to select")
        paragraph
            .coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(
                forDuration: 1.0,
                // Right up to the top edge: there auto-scroll runs at top speed and the
                // selection keeps growing per frame.
                thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)),
                withVelocity: .slow,
                // Holding means the edge run is working — the load to measure arises here.
                thenHoldForDuration: 4.0
            )
        Thread.sleep(forTimeInterval: 1.5)
        let markerReport = (try? String(contentsOfFile: out, encoding: .utf8)) ?? "(no File)"
        add(attachment(markerReport, "Probe after selection + edge run"))
        print("── PERF after selection/edge-run phase ──\n" + markerReport)
        XCTAssertTrue(
            markerReport.contains("marking active"),
            "The probe saw no selection phase — did the gesture get through?"
        )
    }

    /// Second measurement diagnostic: the MOMENT OF SENDING. There the list builds two new cells
    /// while the spring pushes the history up — if a frame drops, the user sees the push as a
    /// jump (exactly what `testSentMessageRidesIntoTheTimelineInsteadOfPopping` checks). The
    /// window is laid so that the numbers contain almost only this moment.
    func testSendPerformanceProbe() throws {
        guard let out = ProcessInfo.processInfo.environment["CBASE_PERF_PROBE"] else {
            throw XCTSkip("Hand diagnostics only: set TEST_RUNNER_CBASE_PERF_PROBE to a path.")
        }
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server, environment: [
            "CBASE_PERF_PROBE": out,
            "CBASE_PERF_PROBE_RESET": "6",
        ])
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "The chat was not opened")
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 22"].waitForExistence(timeout: 25))
        Thread.sleep(forTimeInterval: 8.0)
        composer.tap()
        composer.typeText("Test drive")
        // Do not measure the keyboard movement before sending.
        Thread.sleep(forTimeInterval: 1.5)
        let prior = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["Test drive"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3.0)
        let after = (try? String(contentsOfFile: out, encoding: .utf8)) ?? "(no File)"
        add(attachment(prior, "Probe shortly before sending"))
        add(attachment(after, "Probe after sending"))
        print("── PERF before sending ──\n" + prior)
        print("── PERF after sending ──\n" + after)
    }

    // ── Marker diagnostic on the REAL device (on request only) ───────────────
    //
    // Runs ONLY with TEST_RUNNER_CBASE_MARKER_DEVICE_DIAG=1 and measures the marker gesture
    // against the REAL chats of the server base stored on the device (no fixture — the local
    // network to the Mac is not reliably reachable from the device). The gesture is read-only:
    // select, let the menu appear, tap nothing. Evaluated via the marker trace
    // (TEST_RUNNER_CBASE_MARKER_TRACE=TMP, fetched with
    // `devicectl device copy from … --domain-type appDataContainer`).
    func testDeviceMarkerDiagnosticOnRealChat() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["CBASE_MARKER_DEVICE_DIAG"] == "1",
            "For device diagnostics only (CBASE_MARKER_DEVICE_DIAG=1)."
        )
        let app = XCUIApplication()
        app.launchArguments = ["-cbase.mobile.boot-splash", "0"]
        if let trace = ProcessInfo.processInfo.environment["CBASE_MARKER_TRACE"] {
            app.launchEnvironment["CBASE_MARKER_TRACE"] = trace
        }
        app.launch()

        // Get into a chat: either one is restored (timeline already there), otherwise via the
        // normalizing helper to the chat overview (also leaves a restored project or another
        // category) and open the first row.
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        if !timeline.waitForExistence(timeout: 8) {
            normalizeToChatsOverview(app)
            let row = app.buttons
                .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
                .firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 20), "Neither chat nor overview visible")
            row.tap()
            XCTAssertTrue(timeline.waitForExistence(timeout: 20), "Chat timeline did not appear")
        }
        // Grab a long text paragraph that lies FULLY in the middle band of the window.
        // `firstMatch` alone can hit a row cut off at the top — its press point then lands in
        // the header and the gesture measures nothing. (`label.length` is forbidden in
        // XCUITest predicates, hence a regex.)
        let candidates = app.staticTexts.matching(
            NSPredicate(format: "label MATCHES %@", "(?s).{60,}")
        )
        XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 15), "No long text paragraph in the history")
        Thread.sleep(forTimeInterval: 2)
        let windowHeight = app.windows.firstMatch.frame.height
        var chosen: XCUIElement?
        for index in 0..<min(candidates.count, 12) {
            let element = candidates.element(boundBy: index)
            let frame = element.frame
            if frame.minY > windowHeight * 0.2,
               frame.maxY < windowHeight * 0.78,
               frame.height < windowHeight * 0.4 {
                chosen = element
                break
            }
        }
        guard let paragraph = chosen else {
            throw XCTSkip("No fully visible long paragraph in the middle band of the chat")
        }
        let clear = app.buttons["chat-clear-marker"]

        // 1) hold STILL (1.5 s, no movement at all): fires .began at +0.5 s, and is the state
        //    above the finger visible (preview chip)?
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).press(forDuration: 1.5)
        attach(app, "Diagnostic 1 — after holding still")
        if clear.waitForExistence(timeout: 3) { clear.tap() }
        Thread.sleep(forTimeInterval: 1)

        // 2) Hold, then drag SLOWLY vertically: dt per move under real data load.
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).press(
            forDuration: 1.0,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.25)),
            withVelocity: .slow,
            thenHoldForDuration: 0.4
        )
        attach(app, "Diagnostic 2 — after vertical drag")
        if clear.waitForExistence(timeout: 3) { clear.tap() }
        Thread.sleep(forTimeInterval: 1)

        // 3) Hold, then drag SIDEWAYS: does the drawer stay closed?
        paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).press(
            forDuration: 1.0,
            thenDragTo: paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)),
            withVelocity: .slow,
            thenHoldForDuration: 0.4
        )
        attach(app, "Diagnostic 3 — after sideways drag")
        XCTAssertFalse(
            app.buttons["sidebar-overview"].isHittable,
            "Sideways dragging during the selection must not open the drawer"
        )
        if clear.waitForExistence(timeout: 3) { clear.tap() }
        app.terminate()
    }

    // ── Chat: a long press does not tip the history over ─────────────────────
    /// A `contextMenu` on a message inherited the mirroring of the scroll view: the chat
    /// appeared rotated by 180° and shrunk to a few pixels. Instead of the system menu a
    /// selection dialog now appears outside the scroll view.
    func testLongPressOnMessageKeepsTimelineUpright() throws {
        // Long history: only then does it fill the window, and only then does the pixel
        // check in the lower quarter say anything.
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 14))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 14"].waitForExistence(timeout: 25))

        let timeline = app.descendants(matching: .any)["chat-timeline"]
        let widthBefore = timeline.frame.width
        let heightBefore = timeline.frame.height
        XCTAssertGreaterThan(widthBefore, 200)

        // ON the text the long press belongs to the 0.5 s marker (it marks the word under the
        // finger); the whole-message dialog opens via the text-free areas of the bubble —
        // here the "›" column left of the text.
        app.staticTexts["Verlauf Frage 14"]
            .coordinate(withNormalizedOffset: CGVector(dx: -0.08, dy: 0.5))
            .press(forDuration: 0.9)
        // Search EXPLICITLY in the dialog: the action bar under every message has a copy button
        // with the same label — without the scope filter the query would hit it and the dialog
        // would stay unchecked.
        let dialogCopy = app.sheets.buttons["Copy message"]
        XCTAssertTrue(
            dialogCopy.waitForExistence(timeout: 6),
            "A long press must offer the copy action"
        )
        attach(app, "Message pressed long")
        // Close via "Copy message" — the system dialog's cancel button is labelled differently
        // depending on the system language.
        dialogCopy.tap()
        _ = dialogCopy.waitForNonExistence(timeout: 5)

        XCTAssertEqual(timeline.frame.width, widthBefore, accuracy: 1, "The history was pulled narrower")
        XCTAssertEqual(timeline.frame.height, heightBefore, accuracy: 1)
        XCTAssertTrue(
            app.staticTexts["Verlauf Antwort 14"].isHittable,
            "The newest message must remain visible"
        )
        XCTAssertGreaterThan(
            timelineTailInk(app),
            0.02,
            "After the long press the history must not be empty or tipped over"
        )
    }

    // ── Chat: full markdown ─────────────────────────────────────────────────
    /// The fixture answer deliberately uses the full range. The message used to go only through
    /// Foundation's INLINE parser: headings, lists, task ticks, quotes, tables and rules
    /// appeared as raw text in the bubble.
    func testAssistantMessageRendersFullMarkdown() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))

        // Every block must arrive as its own, marked-up text.
        let expected = [
            "Zwischenbericht",                          // heading 2
            "Offene Punkte",                            // heading 3
            "Erster Punkt mit Code",                    // list + inline code
            "Verschachtelter Unterpunkt",               // nesting
            "Zuerst pruefen",                           // numbering
            "Migration geschrieben",                    // task list, done
            "Migration ausgefuehrt",                    // task list, open
            "Wichtig: die Warteschlange nicht leeren.", // quote
            "Dienst",                                   // table header
            "Gateway",                                  // table cell
            "42 ms",                                    // right-aligned cell
            "select count(*) from auftraege;",          // code block
        ]
        for text in expected {
            XCTAssertTrue(
                app.staticTexts[text].waitForExistence(timeout: 15),
                "The markdown block is missing in the history: \(text)"
            )
        }

        // And none of it may appear as raw text.
        for marker in ["##", "- [x]", "- [ ]", "| ---", "```", "~~"] {
            let hits = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", marker))
            XCTAssertEqual(hits.count, 0, "Raw markdown is still in the message: \(marker)")
        }
        attach(app, "Markdown probe in the chat")
    }

    // ── Chat: a wide table scrolls sideways without opening the drawer ───────
    /// The drawers' swipe recognizer takes every clear horizontal — so a wider table could not
    /// be scrolled sideways at all. It now hands the movement over to a sideways scrollable
    /// surface under the finger.
    func testWideTableScrollsSidewaysWithoutOpeningDrawer() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 1, markdown: true))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))

        let firstCell = app.staticTexts["Column-01"]
        XCTAssertTrue(firstCell.waitForExistence(timeout: 20), "The wide table is missing in the history")
        let before = firstCell.frame.minX

        // Drag horizontally WITHIN the table row (short press so that no copy dialog
        // opens).
        firstCell.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).press(
            forDuration: 0.02,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: firstCell.frame.midY / app.frame.height)),
            withVelocity: .default,
            thenHoldForDuration: 0.05
        )

        attach(app, "Right after the drag in the table")
        let after = app.staticTexts["Column-01"].frame.minX
        // `exists` is not enough here: the drawer stays mounted and merely lies outside the
        // picture — so reachability is checked.
        XCTAssertFalse(
            app.otherElements["right-drawer"].isHittable,
            "Scrolling the table sideways must not open the category drawer"
        )
        XCTAssertLessThan(
            after, before - 40,
            "The table did not scroll sideways (from \(Int(before)) to \(Int(after)))"
        )
        XCTAssertTrue(
            app.staticTexts["Column-06"].isHittable,
            "After scrolling the rear columns must be visible"
        )
        attach(app, "Wide table scrolled sideways")
    }

    // ── Appearance: the step takes effect in the open chat (whole app) ──
    /// The test next to it measures the preview in the settings — an ordinary SwiftUI view.
    /// That proves nothing about the risky part: the history is an INVERTED UICollectionView
    /// with self-sizing cells. There `Coordinator.setTextSize` must reconfigure every cell,
    /// discard the layout, drive it to rest and pin the reader to their row — four manual
    /// steps nobody else recomputes.
    ///
    /// The text size applies to the whole app (Dynamic Type as a trait on the window): the
    /// composer grows too. What remains: the header bar has a fixed height (its title sits in
    /// the middle of it), and the composer stays anchored at the bottom — it grows UPWARDS,
    /// never over the history.
    ///
    /// Measured in the simulator, Normal → Extra large: history row 21.0 → 26.0 pt, own
    /// message 138.0 → 182.0 pt (it re-wraps from four to five lines — exactly the case a
    /// stale measured value cuts off).
    func testTextSizeAppliesInOpenChat() throws {
        let server = try requireFixture()
        // A MULTI-LINE user text is the honest test body: it wraps differently at every step,
        // and the re-measuring hangs on exactly that (the `key` of a MarkerTextUIView carries
        // the font size, a changed key throws away its `fitCache`). A one-line row would still
        // grow if the cell kept its old height.
        let question = "Please summarise the state of the migration, name this week's open "
            + "points and say which of them still needs a decision."
        let response = "The migration status is ready."
        let entries: [[String: Any]] = [
            ["id": 1, "role": "user", "text": question, "ts": 1, "attachments": [] as [Any]],
            ["id": 2, "role": "assistant", "text": response, "ts": 2, "attachments": [] as [Any]],
        ]
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the raw history rows"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let row = app.staticTexts[response]
        XCTAssertTrue(row.waitForExistence(timeout: 25), "The history did not arrive")
        let bubble = app.descendants(matching: .any)["chat-user-bubble"].firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "The own message is missing in the history")
        // Let self-sizing and the indent recomputation settle — heights measured before would be
        // those of the estimate, not of the rendered cell.
        Thread.sleep(forTimeInterval: 1.2)

        let headerPrior = app.staticTexts["chat-title"].frame
        let composerPrior = app.descendants(matching: .any)["chat-composer"].frame
        let islandPrior = app.descendants(matching: .any)["composer-island"].frame
        let rowNormal = row.frame.height
        let bubbleNormal = bubble.frame.height
        XCTAssertGreaterThan(rowNormal, 0, "The history row has no measurable height")
        XCTAssertGreaterThan(bubbleNormal, 0, "The own message has no measurable height")
        // Both frame edges must be MEASURABLE, otherwise the claim "they do not move" could not
        // be told from "they do not exist at all".
        XCTAssertGreaterThan(headerPrior.height, 0, "The header is not measurable")
        XCTAssertGreaterThan(composerPrior.height, 0, "The composer is not measurable")
        XCTAssertGreaterThan(islandPrior.height, 0, "The composer's island is not measurable")
        // Two cells must never overlap — that is the observable form of "cut-off last lines"
        // (a cell that keeps its old, too small height).
        XCTAssertGreaterThanOrEqual(
            row.frame.minY, bubble.frame.maxY - 1,
            "Already at Normal the rows overlap — then the measurement afterwards says nothing"
        )
        attach(app, "History at text size Normal")

        // ── Switch WITHOUT leaving the chat ──
        // The settings lie in a sheet above the shell; the chat stays mounted below. Exactly the
        // case the spec demands: no chat switch, no restart, and still the history ends up in the
        // new size.
        changeTextSize(app, on: "Extra large")
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 10),
            "After the settings the chat was no longer open"
        )
        XCTAssertTrue(
            waitForFixture(timeout: 10) { row.exists && row.frame.height > rowNormal + 2 },
            "The history does not grow with the step (Normal: \(rowNormal), now: \(row.frame.height))"
        )
        Thread.sleep(forTimeInterval: 0.6)
        let rowLarge = row.frame.height
        let bubbleLarge = bubble.frame.height
        attach(app, "History at text size Extra large")

        // The history grows — text AND cell. If only the text grew it would be cut off; if only
        // the cell grew, the old font would sit in a too large frame.
        XCTAssertGreaterThan(
            rowLarge, rowNormal + 2,
            "The history row did not grow (\(rowNormal) → \(rowLarge))"
        )
        XCTAssertGreaterThan(
            bubbleLarge, bubbleNormal + 8,
            "The own message's cell was not re-measured (\(bubbleNormal) → \(bubbleLarge))"
        )
        XCTAssertGreaterThanOrEqual(
            row.frame.minY, bubble.frame.maxY - 1,
            "The rows overlap — a cell kept its old height"
        )
        XCTAssertTrue(row.isHittable, "After switching the newest row lies outside the picture")
        XCTAssertLessThanOrEqual(
            row.frame.maxY, app.descendants(matching: .any)["chat-composer"].frame.minY + 1,
            "The newest row reaches under the composer"
        )

        // ── And the frame stays anchored ──
        // The title sits in the middle of a bar of fixed height: if its font grows, its middle
        // stays. The composer grows too (whole app), but only upwards — at the bottom it stays
        // put. The bottom is measured at the ISLAND (`composer-island`), not at the field: below
        // the field the island holds the context line (`.caption2`), which grows too — the
        // field moves up by its growth (measured Normal → Extra large: field bottom 745.7 →
        // 741.0, island bottom fixed).
        let headerAfter = app.staticTexts["chat-title"].frame
        let composerAfter = app.descendants(matching: .any)["chat-composer"].frame
        let islandAfter = app.descendants(matching: .any)["composer-island"].frame
        XCTAssertEqual(headerAfter.midY, headerPrior.midY, accuracy: 1,
                       "The header moved")
        XCTAssertEqual(islandAfter.maxY, islandPrior.maxY, accuracy: 1,
                       "The composer left its bottom (island \(islandPrior.maxY) → \(islandAfter.maxY))")
        XCTAssertLessThanOrEqual(composerAfter.maxY, islandAfter.maxY + 1,
                                 "The field reaches under the island (field \(composerAfter.maxY), island \(islandAfter.maxY))")
        XCTAssertGreaterThanOrEqual(islandAfter.height, islandPrior.height - 1,
                                    "The island shrank at the larger font")
        XCTAssertGreaterThanOrEqual(composerAfter.height, composerPrior.height - 1,
                                    "The composer shrank at the larger font")

        // ── Opposite direction: smaller than Normal, in the same open chat ──
        // It is not symmetric to enlarging: `restore(_:)` must clamp UPWARDS when shrinking,
        // otherwise the reader would face an empty surface.
        changeTextSize(app, on: "Compact")
        XCTAssertTrue(
            waitForFixture(timeout: 10) { row.exists && row.frame.height < rowNormal - 1 },
            "Compact does not make the history smaller (Normal: \(rowNormal), now: \(row.frame.height))"
        )
        XCTAssertTrue(row.isHittable, "After shrinking the history is no longer in the picture")
        XCTAssertGreaterThan(
            timelineTailInk(app), 0.02,
            "After shrinking the end of the history is an empty surface"
        )
        attach(app, "History at text size Compact")

        // Back to Normal: the step is persistent, and the next test that measures heights in
        // the history would otherwise start with a foreign size.
        changeTextSize(app, on: "Normal")
    }

    // ── Markdown table: the header keeps its distinction ──────────
    /// Regression: the table header lost its own font at EVERY step except "Normal". Two
    /// modifiers wrote `EnvironmentValues.font` onto the same subtree — the chosen one outside,
    /// the additional one inside. At factor 1 the outer one won (the inner set nothing), from
    /// the first step above the inner one, and the header stood at the size and weight of a data
    /// cell. A test at "Normal" could never see that.
    ///
    /// What XCUITest SEES of it: frames, no font faces. The weight is invisible from outside.
    /// The size is measurable — the header carries its own, SMALLER step (`.callout`, 16 pt)
    /// than the data cell (paragraph size, 17 pt), and both scale with the same factor. If the
    /// header loses its choice, it falls to the cell size and the gap vanishes. Size and weight
    /// come from ONE call (`chatFont(.callout, weight: .semibold)` in `MarkdownCellsFont`) —
    /// whoever measures the size measures that this call ran.
    ///
    /// Measured in the simulator: at Normal header 19.33 pt against cell 20.33 pt, at Extra
    /// large 23.67 against 25.00 — the gap grows with the factor (1.00 → 1.33). The bug would
    /// give the header EXACTLY the data cell's number (25.00), i.e. gap 0: the counter-test
    /// stands next to the measured value in every run.
    func testMarkdownTableHeaderStaysApartAtEveryTextSize() throws {
        let server = try requireFixture()
        // A tiny table as the whole answer: that way it is in the picture without scrolling, and
        // the cells are the only texts its label could be confused with.
        let table = [
            "| Dienst | Antwortzeit |",
            "| --- | --- |",
            "| Gateway | 42 ms |",
        ].joined(separator: "\n")
        let entries: [[String: Any]] = [
            ["id": 1, "role": "user", "text": "Status overview please", "ts": 1, "attachments": [] as [Any]],
            ["id": 2, "role": "assistant", "text": table, "ts": 2, "attachments": [] as [Any]],
        ]
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the table"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        // The step comes via the launch arguments here instead of via the UI: the way through the
        // settings led over a swipe ACROSS the history — and a markdown table scrolls
        // horizontally, the swipe would get stuck in it. That the switch takes effect in the
        // running chat is checked by the test above.
        var app = launchApp(server: server)
        try openFirstChat(app)
        let (headerNormal, cellNormal) = tableCellsHeights(app)
        attach(app, "Markdown table at Normal")

        app = launchApp(server: server, launchArguments: ["-cbase.mobile.textSize", "veryLarge"])
        try openFirstChat(app)
        let (headerLarge, cellLarge) = tableCellsHeights(app)
        attach(app, "Markdown table at Extra large")

        let measurements = "Normal: header \(headerNormal) / cell \(cellNormal) — "
            + "Extra large: header \(headerLarge) / cell \(cellLarge)"
        // The precondition first: the table scales at all. Without it nothing else would say
        // anything.
        XCTAssertGreaterThan(cellLarge, cellNormal + 1, "The data cell does not grow with it. \(measurements)")
        XCTAssertGreaterThan(headerLarge, headerNormal + 1, "The table header does not grow with it. \(measurements)")
        // And then the finding: at BOTH steps the header stands set apart from the data cell.
        let gapNormal = cellNormal - headerNormal
        let gapLarge = cellLarge - headerLarge
        XCTAssertGreaterThan(gapNormal, 0.5,
                             "Already at Normal the header is not set apart — then the test checks nothing. \(measurements)")
        XCTAssertGreaterThanOrEqual(
            gapLarge, gapNormal * 0.7,
            "At \"Extra large\" the table header lost its own font and stands at cell size. \(measurements)"
        )
    }

    // ── Markdown table under a CHOSEN card font ─────────
    /// The test above seeds the table as an ordinary answer — i.e. on the path where NOBODY has
    /// chosen a font above the table. The two places where the repair must also take hold look
    /// different, though: the info row in the history (`ChatComponents.swift`) and the channel
    /// card (`ChannelPane.swift`) explicitly set `.chatFont(.subheadline)` plus
    /// `chatMarkdownBaseSize 15` on their `MarkdownView`. There the data cell inherits the card's
    /// 15 while the header keeps its own 16.
    ///
    /// That reverses the sign: in an answer the header is SMALLER than the cell (16 against 17),
    /// in the card LARGER (16 against 15). Both are right, and both break the same way — if the
    /// header loses its choice, it stands at cell size and the gap is zero.
    ///
    /// The channel card is taken and not the info row, after checking both: an info row arises
    /// exclusively in `ChatViewModel.pushInfo` — from a slash command (`/help`, `/model`,
    /// `/cost`, …) or from the `note` field of a rejected `/compact` answer. The slash commands'
    /// texts are fixed in the source and are no tables, and the fixture gateway has no
    /// `/compact` route at all. A table could only be got in there by an invented detour. The
    /// channel card on the other hand carries free markdown of the channel, which the fixture
    /// can seed (`POST /fixture/channel { text }`). Both render the SAME `MarkdownTable` under
    /// the same pairing of `.chatFont(.subheadline)` and `chatMarkdownBaseSize 15`; what holds
    /// here holds there.
    func testMarkdownTableHeaderStaysAlsoInTheChannelCardSetApart() throws {
        let server = try requireFixture()
        // Different words than in the test above: if both tables stood in one run each,
        // `staticTexts["Dienst"]` would be ambiguous. And short words so that the card stays
        // one-line — a wrapped cell measures the line count, not the font size.
        let table = [
            "| Module | State |",
            "| --- | --- |",
            "| Cashdesk | open |",
        ].joined(separator: "\n")
        // Order: first clear a channel left standing, then seed.
        XCTAssertNotNil(fixturePost(server + "/fixture/channel", body: ["off": true]),
                        "The fixture gateway did not accept the reset")
        XCTAssertNotNil(fixturePost(server + "/fixture/channel", body: ["text": table]),
                        "The fixture gateway did not accept the channel seed")
        defer { _ = fixturePost(server + "/fixture/channel", body: ["off": true]) }

        var app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-channel-card"].firstMatch.waitForExistence(timeout: 25),
            "The channel card is missing in the coding chat's history"
        )
        let (headerNormal, cellNormal) = tableCellsHeights(app, header: "Module", cell: "Cashdesk")
        attach(app, "Channel card with table at Normal")

        // The step via the launch arguments, as in the test above: the way through the settings
        // led over a swipe across the table, and that scrolls itself.
        app = launchApp(server: server, launchArguments: ["-cbase.mobile.textSize", "veryLarge"])
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-channel-card"].firstMatch.waitForExistence(timeout: 25),
            "The channel card is missing after the restart with a larger text size"
        )
        let (headerLarge, cellLarge) = tableCellsHeights(app, header: "Module", cell: "Cashdesk")
        attach(app, "Channel card with table at Extra large")

        let measurements = "Normal: header \(headerNormal) / cell \(cellNormal) — "
            + "Extra large: header \(headerLarge) / cell \(cellLarge)"
        // Precondition: the card scales at all. Without it nothing else would say anything.
        XCTAssertGreaterThan(cellLarge, cellNormal + 1, "The card's data cell does not grow with it. \(measurements)")
        XCTAssertGreaterThan(headerLarge, headerNormal + 1, "The card's table header does not grow with it. \(measurements)")
        // And the finding: at BOTH steps the header stands above the cell size. If it fell back
        // to the card's font, the gap would be zero.
        let gapNormal = headerNormal - cellNormal
        let gapLarge = headerLarge - cellLarge
        XCTAssertGreaterThan(
            gapNormal, 0.5,
            "Already at Normal the header is not set apart — then the test checks nothing. \(measurements)"
        )
        XCTAssertGreaterThanOrEqual(
            gapLarge, gapNormal * 0.7,
            "Under the chosen card font the table header lost its own. \(measurements)"
        )
    }

    // ── Agenda as a tree ─────────
    //
    // Show as little text as possible in the UI — ideally only the headings. The sheet behind
    // the header button shows ONE line per item: a parent folds its whole subtree shut and open
    // again, a fully done one starts folded, and the note appears only AFTER a tap on its
    // symbol (the description never in the flow). Here because the note appears as markdown
    // (`Kit/Markdown`). Fixture: `POST /fixture/agenda { tree: true }` (routes-chat.mjs). The
    // fold memo is pinned to "no deviation" by a launch argument — UserDefaults survive between
    // tests, and a failure in the middle of the test would otherwise leave s3 folded for the
    // next run.
    // COUNTER-TEST: in `Chat/AgendaSheet.swift` `Text(p.text)` → `Text(p.text + " " + p.note)`
    // (the note in the flow) ⇒ red "The note is in the sheet before the tap" (2 instead of 0).
    func testAgendaTreeFoldsAndShowsNoteOnlyOnTap() throws {
        let server = try requireFixture()
        let app = launchApp(
            server: server,
            launchArguments: ["-cbase-agenda-fold:\(Self.fixtureChatId)", "{}"],
            preparation: { _ = self.fixturePost(server + "/fixture/agenda", body: ["tree": true]) }
        )
        normalizeToChatsOverview(app)
        let card = app.buttons.matching(identifier: "overview-chat-\(Self.fixtureChatId)").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The fixture chat is missing in the overview")
        card.tap()

        let button = app.buttons["chat-agenda"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "The header button \"Agenda\" is missing")
        button.tap()
        let title = app.descendants(matching: .any)["chat-agenda-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "The agenda sheet shows no title — the tree agenda did not arrive")

        let point = { (id: String) in app.descendants(matching: .any)["chat-agenda-step-\(id)"] }
        let payment = app.buttons["chat-agenda-step-s3"]
        let blog = app.buttons["chat-agenda-step-s6"]
        XCTAssertTrue(payment.waitForExistence(timeout: 10), "The sub-item \"Zahlung\" (s3) is missing in the sheet")
        // Default: open as long as not done — up to level 2 (s4) everything is there; the done "Blog: Umzug" (s6) stands closed.
        XCTAssertTrue(point("s4").waitForExistence(timeout: 5), "The level-2 item (s4) is missing — s3 is not open")
        XCTAssertEqual(payment.value as? String, "expanded")
        // At half height the list does not build the lower rows (s6 was missing) — a pull in the
        // sheet first pulls it up fully, then it scrolls.
        XCTAssertTrue(roleInSheet(app, blog), "The done parent s6 is missing — also after scrolling in the sheet")
        XCTAssertEqual(blog.value as? String, "collapsed", "A fully done subtree starts folded")
        XCTAssertFalse(point("s7").exists, "A leaf under the folded s6 is in the sheet")
        XCTAssertTrue(roleInSheet(app, point("s9")), "The top-level leaf (s9) is missing")
        // Headings only: neither the note nor the description is in the flow.
        let noteProbe = NSPredicate(format: "label CONTAINS %@", "Agenda-Notiz-Probe")
        let descriptionProbe = NSPredicate(format: "label CONTAINS %@", "Agenda-Beschreibung-Probe")
        XCTAssertEqual(app.descendants(matching: .any).matching(noteProbe).count, 0, "The note is in the sheet before the tap")
        XCTAssertEqual(app.descendants(matching: .any).matching(descriptionProbe).count, 0, "The description is in the flow")

        // Folding takes the whole subtree with it (s4, s5); unfolding brings it back.
        payment.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !point("s4").exists }, "s4 is still there after folding s3")
        XCTAssertFalse(point("s5").exists, "s5 is still there after folding s3")
        XCTAssertEqual(payment.value as? String, "collapsed")
        payment.tap()
        XCTAssertTrue(point("s4").waitForExistence(timeout: 5), "s4 does not come back after unfolding s3")
        XCTAssertEqual(payment.value as? String, "expanded")
        blog.tap()
        XCTAssertTrue(point("s7").waitForExistence(timeout: 5), "The done parent s6 does not unfold")

        // The note only on tap — and only where there is one.
        let noteButton = app.buttons["chat-agenda-note-s4"]
        XCTAssertTrue(noteButton.waitForExistence(timeout: 5), "The note symbol at s4 is missing")
        XCTAssertFalse(app.buttons["chat-agenda-note-s3"].exists, "An item without a note carries a note symbol")
        noteButton.tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(noteProbe).firstMatch.waitForExistence(timeout: 5),
            "The note does not appear after the tap on its symbol"
        )
        XCTAssertEqual(app.descendants(matching: .any)["chat-agenda-note-header"].label, "Stripe anbinden", "The note sheet does not name its item")
        app.buttons["chat-agenda-note-close"].tap()
        XCTAssertTrue(waitUntil(timeout: 5) { app.descendants(matching: .any).matching(noteProbe).count == 0 }, "The note sheet does not close")
    }
}
