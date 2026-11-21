// Chat stage UI tests: stage, history geometry, run indicator, keyboard.
import XCTest

final class ChatStageUITests: CbaseUITestBase {
    // ── The run indicator neither comes nor goes in the middle of a run ──────
    /// It used to hang on `!streamingText`, and that flag flips constantly in a real run:
    /// text → true (row gone), tool call → false (row there), text → true (row gone).
    /// Every flip inserts or removes a row at the bottom end of the list and thereby shifts
    /// everything above it by its height plus row spacing — the finding "right after sending
    /// there is an extreme amount of space under the user message, and it flickers back and
    /// forth".
    ///
    /// The fixture run goes through exactly this sequence: tool call at 450 ms, text at
    /// 750 ms. A tight check makes sure the row is not missing for a single moment in between.
    ///
    /// The run is the LONG one with an open bash call (`/fixture/open-call`, 60 s instead of
    /// 10 s): the reserve of this test is its number of probes, and that hung on the 10 s run.
    /// Under load the first answer arrives only 4 s after sending and a probe costs 1.0 s
    /// instead of 0.25–0.35 s, so the old window left too few probes (10 are required) and
    /// the test went red although the row was never missing. With a 60 s run the window reaches
    /// to "+25 s" without ever touching the end of the run.
    func testRunIndicatorStaysForTheWholeRun() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        // AFTER launchApp: its /fixture/reset-run resets the one-shot switches.
        XCTAssertNotNil(fixturePost(server + "/fixture/open-call", body: ["open": true]),
                        "The fixture did not accept the switch for the open call")
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 22"].waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("run")
        // The anchor lies BEFORE the tap: after `tap()` XCUITest waits for the app to be idle,
        // and an anchor afterwards would lie LATER than the arrival of the message in the
        // fixture — from which the run's duration counts. Under load it drifted the wrong way:
        // the window moved close to the end of the run. Set before the tap, the anchor costs
        // the tap itself in window width (1–2 probes; the attachment "Run window" carries the
        // tap duration per run) and lies guaranteed before the arrival.
        let sent = Date()
        app.buttons["chat-send"].tap()
        let tapDuration = Date().timeIntervalSince(sent)

        let display = app.descendants(matching: .any).matching(identifier: "chat-run-indicator").firstMatch
        XCTAssertTrue(display.waitForExistence(timeout: 20), "The run indicator does not appear")
        // The tool call is there, the text follows right after — exactly in this window the
        // row used to vanish.
        XCTAssertTrue(
            app.staticTexts["Erste Antwort."].waitForExistence(timeout: 20),
            "The streamed text did not arrive"
        )
        // Checked in the WINDOW [first answer visible, 25 s after sending]: the fixture run with
        // the open call only ends 60 s after the message arrives (`runMs` in seeds.mjs), and
        // after the end of the run the row MAY be missing — the window keeps 35 s distance from
        // it. Counting 20 probes without a pause and without a clock used to break under load:
        // the last probes ran past the end of the run and counted as "vanished" — the 1–2
        // missing probes were the LAST ones, never one in the middle: in every probe within the
        // run the row was there. The clock instead of the count turns the flake into a promise
        // only real flicker breaks.
        var probes: [(Double, Bool)] = []
        let windowEnd = sent.addingTimeInterval(25)
        while Date() < windowEnd {
            probes.append((Date().timeIntervalSince(sent), display.exists))
            Thread.sleep(forTimeInterval: 0.1)
        }
        let missing = probes.filter { !$0.1 }.map { String(format: "%.1f s", $0.0) }
        // Also into the log, not only the attachment: the reserve of this test IS the number of
        // probes (≥ 10 required), and whether it shrinks under load must be readable from the log
        // of a full run without opening the xcresult.
        print(String(format: "Run window: tap %.2f s, %d probes (%.2f–%.2f s), missing %d",
                     tapDuration, probes.count, probes.first?.0 ?? -1, probes.last?.0 ?? -1, missing.count))
        add(attachment(
            String(format: "Tap %.2f s; %d probes from %.2f s to %.2f s after the anchor (before the tap); missing: %@",
                   tapDuration, probes.count, probes.first?.0 ?? -1, probes.last?.0 ?? -1,
                   missing.isEmpty ? "no" : missing.joined(separator: ", ")),
            "Run window"
        ))
        XCTAssertGreaterThanOrEqual(
            probes.count, 10,
            "Only \(probes.count) probes in the run window — the queries were too slow to see flicker"
        )
        XCTAssertTrue(
            missing.isEmpty,
            "The run indicator vanished in \(missing.count) of \(probes.count) probes in the middle of the run "
                + "(\(missing.joined(separator: ", ")) after sending) — "
                + "every coming and going shifts the history by its row height"
        )
        attach(app, "Run indicator stays")
    }

    // ── The run indicator is a row of its own, not part of the message ───────
    /// Without a reason of its own it merged with the row above — and because the fresh tool
    /// call stands there, the call read as part of the work indicator. So the gap above its text
    /// is measured: it must equal the gap above the text of a message (the vertical padding of
    /// the row is deliberately that of the user bubble, `RunIndicator` in `ChatRunStatus.swift`).
    ///
    /// Measured in the RUN phase ("Tinkering…" with runtime and token counter). The waiting-phase
    /// form (label + detail + "you can keep writing", two lines) is NOT measured here: in the
    /// waiting phase no row stands in the history at all — its place is the chips above the
    /// input field and the header dot (`assertWaitingState`). That the row STANDS the whole run
    /// is checked by `testRunIndicatorStaysForTheWholeRun`; here only the form counts.
    ///
    /// The run must be LONG for that: retracting the keyboard and querying the frames of
    /// indicator, bubble and predecessor takes 12–16 s after sending in the simulator, the
    /// 10 s default run was already over and the row gone. Hence the 60 s run with an open bash
    /// call (`/fixture/open-call`) — the run phase, only longer; the collective row of the
    /// commands stands ABOVE the streamed text, the reference stays the link.
    func testRunIndicatorIsItsOwnRowWithMessageSpacing() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 8))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        // AFTER launchApp: its /fixture/reset-run resets the one-shot switches.
        XCTAssertNotNil(fixturePost(server + "/fixture/open-call", body: ["open": true]),
                        "The fixture did not accept the switch for the open call")
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 8"].waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("Display")
        app.buttons["chat-send"].tap()

        let hits = app.descendants(matching: .any).matching(identifier: "chat-run-indicator")
        XCTAssertTrue(hits.firstMatch.waitForExistence(timeout: 25), "The run indicator is missing")
        // The answer DIRECTLY above the indicator: the streamed text of the running turn (750 ms
        // after the start), its last piece is the link.
        let above = app.staticTexts["cbase-Link"]
        XCTAssertTrue(above.waitForExistence(timeout: 20), "The streamed text did not arrive")
        // Retract the keyboard again (via the drag zone) — otherwise no history message fits
        // beside the running turn in the window, and we need one as a reference.
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
            Thread.sleep(forTimeInterval: 1.0)
        }
        // The identifier is also inherited by the enclosing accessibility element — the whole
        // frame is meant, so the largest hit.
        let display = hits.allElementsBoundByIndex
            .max(by: { $0.frame.height < $1.frame.height }) ?? hits.firstMatch
        let label = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Tinkering")).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 15), "The label \"Tinkering…\" of the run indicator is missing")
        // ONE line: label and runtime stand side by side, nothing wraps. The indicator carries NO
        // surface, so its accessibility frame is exactly the union of its text lines — the
        // vertical padding lies OUTSIDE.
        XCTAssertLessThan(
            label.frame.height, 26,
            "The indicator's label wraps (\(label.frame.height) pt)"
        )
        XCTAssertLessThan(
            display.frame.height, 26,
            "The indicator is taller than one line (\(display.frame.height) pt) — something wraps"
        )
        // Threshold 5, not 3: the indicator's frame is the union with the ROTATING hexagon,
        // whose envelope is 17.1…20.1 pt tall depending on the angle — the top edge thus wanders
        // up to 2.55 pt above the label's top edge, and 3 left 0.45 pt of air. A second line
        // would lie ≥ 14 pt above (the label's line height); 5 tells the two apart. The hexagon
        // stands centred on the first line and the label is 18 pt tall (15 pt font): measured
        // offset 0.0…0.92 pt (frame 18.0…20.2 pt tall).
        XCTAssertLessThan(
            abs(display.frame.minY - label.frame.minY), 5,
            "The label is not in the first line of the indicator (indicator \(display.frame), label \(label.frame))"
        )

        // And the gap upwards. Compared with the USER BUBBLE — TEXT to TEXT on both sides: the
        // bubble sets its text 10 pt from its top edge, and the indicator without a surface
        // carries exactly this padding too. Above the bubble stands a FINISHED answer, and it
        // carries its action bar (copy/read aloud) under the text — so measuring starts at its
        // bottom edge (`actionBarBottom`); the running answer above the indicator has no bar yet
        // ("a moving target").
        //
        // Measured (8 runs, equal to 0.1 pt): label 24.0 pt, bubble text 21.0 pt. The label's top
        // edge IS the unrotated top edge of the hexagon (hexagon centre − 7.5) — the 3 pt
        // difference comes from the row ABOVE: the frame of the link text ends above the bottom
        // edge of its row, the bubble text has its reference at the action bar. A stable
        // constant, no wobble. The FRAME of the indicator is no good as an anchor: the hexagon
        // rotates and its envelope wanders with the rotation by up to 2.4 pt.
        //
        // The limits are ONE-SIDED (symmetric ± 5 would leave a padding of 2–3 pt — the row
        // "sticks" — green at 16–17 pt against 21 pt): downwards only the measuring rounding
        // (beforeBubble − 1), upwards the 3 pt constant plus air (beforeBubble + 5). The
        // regressions at stake — padding gone (14.0 pt) or merged with the row above (−11 pt
        // line spacing) — lie below the lower limit.
        guard let bubble = app.descendants(matching: .any).matching(identifier: "chat-user-bubble")
            .allElementsBoundByIndex.max(by: { $0.frame.minY < $1.frame.minY })
        else { return XCTFail("The user bubble as the reference case is missing") }
        guard let bubblesText = app.staticTexts.allElementsBoundByIndex
            .filter({ bubble.frame.contains($0.frame) })
            .min(by: { $0.frame.minY < $1.frame.minY })
        else { return XCTFail("No text found in the user bubble") }
        // The answer DIRECTLY above this bubble — which one that is depends on how much history
        // fits into the window; hence searched rather than pinned down.
        guard let overPrevious = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Verlauf Antwort "))
            .allElementsBoundByIndex
            .filter({ $0.frame.maxY <= bubble.frame.minY })
            .max(by: { $0.frame.maxY < $1.frame.maxY })
        else { return XCTFail("No history answer visible above the user bubble") }
        let beforeBubble = bubblesText.frame.minY - actionBarBottom(app, below: overPrevious.frame.maxY)
        let beforeDisplay = label.frame.minY - above.frame.maxY
        add(attachment(
            "beforeDisplay \(beforeDisplay) pt, beforeBubble \(beforeBubble) pt; indicator \(display.frame), label \(label.frame), "
                + "above \(above.frame), bubble text \(bubblesText.frame), predecessor \(overPrevious.frame)",
            "Run indicator measures"
        ))
        XCTAssertGreaterThanOrEqual(
            beforeDisplay, beforeBubble - 1,
            "The gap above the text of the run indicator (\(beforeDisplay) pt) is smaller than the gap "
                + "above the text of a message bubble (\(beforeBubble) pt) — the row sticks to the row above"
        )
        XCTAssertLessThanOrEqual(
            beforeDisplay, beforeBubble + 5,
            "The gap above the text of the run indicator (\(beforeDisplay) pt) is larger than the gap "
                + "above the text of a message bubble (\(beforeBubble) pt) plus the 3 pt of the row above"
        )
        attach(app, "Run indicator as a row of its own")

        // The run indicator and the metrics row after it stand at the SAME step, that of the tool
        // rows (`.subheadline`, 15 pt). Two `staticTexts` are compared ("Tinkering…" in the run,
        // the sentence of the metrics row after aborting); the collective row is a button whose
        // height contains padding and chevron, and is no good as a measure. Both must be taller
        // than a `.caption` row (12 pt ⇒ line height about 14.3) — otherwise they would be
        // equal, but small.
        let tinkerHeight = label.frame.height
        let abort = app.buttons["Stop answering"]
        XCTAssertTrue(abort.waitForExistence(timeout: 5), "The stop button is missing in the running turn")
        abort.tap()
        let metricRows = app.descendants(matching: .any).matching(identifier: "chat-metric-row")
        XCTAssertTrue(metricRows.firstMatch.waitForExistence(timeout: 15), "The metrics row is missing after aborting")
        let abortSet = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Aborted after")).firstMatch
        XCTAssertTrue(abortSet.waitForExistence(timeout: 10), "The metrics row does not name the abort")
        let rowsFrame = metricRows.allElementsBoundByIndex.map(\.frame)
        XCTAssertTrue(
            rowsFrame.contains { $0.insetBy(dx: -0.5, dy: -0.5).contains(abortSet.frame) },
            "The sentence \"Aborted after …\" (\(abortSet.frame)) does not stand in a `chat-metric-row` — rows: \(rowsFrame)"
        )
        add(attachment("Tinkering \(tinkerHeight) pt, metrics \(abortSet.frame.height) pt (\(abortSet.frame))", "Step of the run rows"))
        XCTAssertEqual(
            abortSet.frame.height, tinkerHeight, accuracy: 1,
            "Run indicator (\(tinkerHeight) pt) and metrics row (\(abortSet.frame.height) pt) do not stand at the same step"
        )
        XCTAssertGreaterThan(tinkerHeight, 15.5, "\"Tinkering…\" does not stand above the `.caption` step (\(tinkerHeight) pt)")
        XCTAssertGreaterThan(abortSet.frame.height, 15.5, "The metrics row does not stand above the `.caption` step (\(abortSet.frame.height) pt)")
        attach(app, "Metrics row after aborting")
    }

    // ── The own message PUSHES the history, it does not bump it ──────────────
    /// A sent message appeared finished in its place, and the history above jumped up by its
    /// row height. Now the history is PUSHED upwards as one block while the new row emerges from
    /// behind the composer island (see `Coordinator.pushUp`).
    ///
    /// Checked on the app's frame-by-frame trace (DEBUG only, path via CBASE_ENTRANCE_TRACE,
    /// row-kind selection via CBASE_ENTRANCE_TRACE_KIND). A visual check is NOT enough here,
    /// and XCUITest alone cannot see it: the accessibility position comes from the MODEL, where
    /// the row stands finished in its place from the first moment — whether the history was
    /// pushed or jumped is only in the presentation layer (`layer.presentation()`).
    func testSentMessageRidesIntoTheTimelineInsteadOfPopping() throws {
        let server = try requireFixture()
        // 22 history rows: the chat FILLS the window with them. Only then does a new row move the
        // history up at all (in a short chat it grows into the free space and nothing moves —
        // see `lastFill`).
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let keep = ProcessInfo.processInfo.environment["CBASE_DIAG_TRACE"]
        let trace = keep ?? "/tmp/cbase-entrance-\(UUID().uuidString).csv"
        defer { if keep == nil { try? FileManager.default.removeItem(atPath: trace) } }
        let app = launchApp(server: server, environment: [
            "CBASE_ENTRANCE_TRACE": trace,
            // Follow only the USER ROW: a send triggers several entrances in quick succession
            // (run indicator, user row, answer row).
            "CBASE_ENTRANCE_TRACE_KIND": "user",
        ])
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 22"].waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("Slide in")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(
            app.staticTexts["Slide in"].waitForExistence(timeout: 20),
            "The sent message does not appear in the history"
        )
        // Settling: the trace only writes its file when the recording ends. In this time the SSE
        // echo of the own message arrives too.
        Thread.sleep(forTimeInterval: 2.5)
        // The own bubble has stood OPTIMISTICALLY in the history since sending; the server
        // mirrors every user row back to all clients. If this echo is not reconciled, the
        // message stands there twice.
        let hits = app.staticTexts.matching(NSPredicate(format: "label == %@", "Slide in")).count
        XCTAssertEqual(hits, 1, "The own message stands \(hits)× in the history")

        let (opacity, _, _) = try entranceTrace(trace)
        XCTAssertGreaterThan(
            opacity.count, 6,
            "The trace of the user row is too short (\(opacity.count) probes) — was it followed?"
        )
        // 1. It fades in: transparent at the start, opaque at the end, and real intermediate
        //    values in between. A flash would stand at 1.0 throughout. The very FIRST probe does
        //    not count: it arises in the same pass as the update, and there the animation is not
        //    yet attached to the layer — so it reads the end value.
        //
        //    The promise is a GROWTH, not an absolute threshold — the same calculation as in
        //    `testFirstMessageInAShortChatStillFadesIn`. Under load the early probes are missing:
        //    cell building costs 59–79 ms per frame, the 0.26 s fade-in is then already half
        //    through. Four statements tell it from a flash: the ramp begins below 0.98, its first
        //    probe is more transparent than its last, no probe falls by more than 0.05, at the end
        //    of the WHOLE trace the row is opaque — and at least one probe lies strictly in
        //    between, as long as there is room for it at all.
        guard let attempt = opacity.firstIndex(where: { $0 < 0.98 }) else {
            return XCTFail(
                "The new row is transparent in no probe (minimum \(opacity.min() ?? -1)) — "
                    + "it stands there at once instead of fading in"
            )
        }
        let fadeIn = Array(opacity[attempt...])
        let opaqueFrom = fadeIn.firstIndex(where: { $0 >= 0.98 }) ?? (fadeIn.count - 1)
        let ramp = Array(fadeIn[...opaqueFrom])
        let first = ramp.first ?? 1
        let last = ramp.last ?? 0
        // The end value belongs to the WHOLE trace, not the ramp: `ramp.last` is by construction
        // the first probe ≥ 0.98 — there "≥ 0.98" would be a tautology, and a row that fades in
        // and then disappears again would stay green.
        let finalValue = fadeIn.last ?? 0
        XCTAssertLessThan(
            first, last,
            "The new row's opacity does not grow (first probe \(first), last \(last))"
        )
        let dips = zip(ramp, ramp.dropFirst()).filter { $0.0 - $0.1 > 0.05 }
        XCTAssertTrue(
            dips.isEmpty,
            "The opacity falls \(dips.count)× between two frames of the fade-in "
                + "(\(dips.map { "\($0.0) → \($0.1)" }.joined(separator: ", "))) — "
                + "a fade-in only goes upwards"
        )
        XCTAssertGreaterThanOrEqual(
            finalValue, 0.98,
            "The new row is not opaque at the end of the trace (end value \(finalValue), ramp ended at \(last))"
        )
        let window = last - first - 0.10
        if window > 0.1 {
            let between = ramp.filter { $0 > first + 0.05 && $0 < last - 0.05 }
            XCTAssertFalse(
                between.isEmpty,
                "The opacity jumps from \(first) to \(last) without a probe in between "
                    + "(ramp \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · "))) — "
                    + "the row flashes instead of fading"
            )
        } else {
            add(attachment(
                "Ramp \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · ")) — "
                    + "window only \(String(format: "%.2f", window)) wide, the intermediate probe "
                    + "was not required (the first visible probe came too late)",
                "Fade-in: no window"
            ))
        }
        print("Long history ramp: \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · ")) "
            + "| end value \(finalValue) | probes total \(opacity.count)")
        // 2. The history is PUSHED: the row above the new one covers on screen the height of the
        //    growth (own bubble plus run indicator, about 95 pt). Measured at the screen position,
        //    not at the content frame — that wanders through the insertion itself.
        let bursts = try entranceScreenSegments(trace)
        guard let firstBurst = bursts.first, firstBurst.count > 10 else {
            return XCTFail("The screen trace of the first push is too short (\(bursts.first?.count ?? 0) probes)")
        }
        let distance = (firstBurst.max() ?? 0) - (firstBurst.min() ?? 0)
        XCTAssertGreaterThan(
            distance, 60,
            "The history does not move up (\(distance) pt) — the new row does not push it"
        )
        // 3. And WITHOUT A JUMP — checked per push. The criterion is the largest step of ONE
        //    frame: it may only be a quarter of the way of this push. The collection's
        //    rearrangement used to run with ease-out, whose initial velocity is the highest of
        //    the whole curve; because the animation starts in the same pass in which the list
        //    first BUILDS the new cells (59–79 ms standstill), the first drawn frame was already a
        //    third of the way: 33 of 97 pt in ONE frame. The spring starts at velocity 0 — 4 pt in
        //    the first frame, 11.7 pt in the fastest.
        //
        // 4. And only upwards: a backward step means two places fight over the offset (the
        //    indent clamp against the spring) — on screen a twitch downwards in the middle of the
        //    movement.
        //    "ONE frame" is not "one step of the trace": the trace hangs on a `CADisplayLink`,
        //    and under load that drops out — then two consecutive probes lie three frames apart,
        //    and their difference is the movement of THREE frames. So every step is normalised to
        //    the FRAME DURATION; the frame duration is the median of the intervals of this push
        //    (self-calibrating, 60 Hz in the simulator). A real jump has dt == median and stays
        //    red afterwards — that is the counter-test.
        let burstsWithTime = try entranceScreenSegmentsTimed(trace)
        for (number, burst) in burstsWithTime.enumerated() {
            let ys = burst.map(\.y)
            let track = (ys.max() ?? 0) - (ys.min() ?? 0)
            // Skip small pushes: not every "E" row moves the history (a row at the end of the chat
            // may also only change its content), and at 5 pt of way every limit would be noise.
            guard track > 40, burst.count > 2 else { continue }
            let steps = zip(burst, burst.dropFirst()).map { (dy: $1.y - $0.y, dt: max($1.t - $0.t, 0.0001)) }
            let imageDuration = steps.map(\.dt).sorted()[steps.count / 2]
            // Per step: how much of the way falls on ONE frame? A step over the normal frame
            // duration counts fully, a step over three frame durations a third.
            let perImage = steps.map { abs($0.dy) * imageDuration / max($0.dt, imageDuration) }
            let largest = perImage.max() ?? 0
            let rawLargest = steps.map { abs($0.dy) }.max() ?? 0
            let outages = steps.filter { $0.dt > imageDuration * 1.5 }.count
            print("Push \(number): way \(String(format: "%.1f", track)) pt, frame duration "
                + "\(String(format: "%.1f", imageDuration * 1000)) ms, largest step raw "
                + "\(String(format: "%.1f", rawLargest)) pt / per frame \(String(format: "%.1f", largest)) pt, "
                + "\(outages) of \(steps.count) intervals over 1.5 frame durations")
            XCTAssertLessThan(
                largest, track / 4,
                "Push \(number): the history covers \(largest) pt of \(track) pt in ONE frame — "
                    + "that is a jump (largest raw step "
                    + "\(rawLargest) pt at frame duration \(imageDuration * 1000) ms, "
                    + "\(outages) dropped frames in \(steps.count) intervals)"
            )
            // A backward step is an error regardless of the frame duration — no normalising
            // here.
            let back = steps.map(\.dy).min() ?? 0
            XCTAssertGreaterThan(
                back, -1.5,
                "Push \(number): the history jerks back by \(back) pt instead of "
                    + "gliding smoothly upwards"
            )
        }
        attach(app, "Message after sliding in")
    }

    /// The SHORT history is the second path (`Coordinator.apply`, "fade only"): nothing moves up
    /// there, because the new row grows into the free space under the history — an animated
    /// rearrangement would have nothing to do here and would only fight the fill indent. So
    /// only the fade-in is checked. Without this test exactly the case everyone sees first
    /// would be uncovered: the first message in a fresh chat.
    ///
    /// ONE history round. With TWO rounds the history already filled the window (`fill=0.00`),
    /// and the update went via `pushUp` — the test measured the push path with its short 0.16 s
    /// fade and bore the other one's name. The push path is not uncovered as a result:
    /// `testSentMessageRidesIntoTheTimelineInsteadOfPopping` drives it with 22 rounds and
    /// measures fade AND way there. So this test additionally checks which path the trace
    /// names — otherwise the test would silently wander back at the next layout change.
    func testFirstMessageInAShortChatStillFadesIn() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 1))
        defer { _ = setFixtureHistory(server, count: 0) }
        let keep = ProcessInfo.processInfo.environment["CBASE_DIAG_TRACE"]
        let trace = keep ?? "/tmp/cbase-entrance-short-\(UUID().uuidString).csv"
        defer { if keep == nil { try? FileManager.default.removeItem(atPath: trace) } }
        let app = launchApp(server: server, environment: [
            "CBASE_ENTRANCE_TRACE": trace,
            "CBASE_ENTRANCE_TRACE_KIND": "user",
        ])
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 1"].waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("Short")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(
            app.staticTexts["Short"].waitForExistence(timeout: 20),
            "The sent message does not appear in the history"
        )
        Thread.sleep(forTimeInterval: 2.5)
        let hits = app.staticTexts.matching(NSPredicate(format: "label == %@", "Short")).count
        XCTAssertEqual(hits, 1, "The own message stands \(hits)× in the history")

        let (opacity, _, _) = try entranceTrace(trace)
        XCTAssertGreaterThan(
            opacity.count, 6,
            "The trace of the user row is too short (\(opacity.count) probes)"
        )
        // Which path was measured is in the annotation of the FOLLOWED push — the first one whose
        // annotation carries the filter "user" (`ChatEntranceTrace.run`: the first matching one
        // starts the recording, later ones only write their E row). Without this line the test
        // would measure either of the two paths and claim the short one.
        let annotations = try entranceNotes(trace)
        print("Short history annotations: \(annotations.joined(separator: " | "))")
        guard let tracked = annotations.first(where: { $0.contains("user") }) else {
            return XCTFail("No followed push in the trace (annotations: \(annotations))")
        }
        XCTAssertTrue(
            tracked.contains("fade only"),
            "This test measures the SHORT history (\"fade only\"), but the trace took the path "
                + "\"\(tracked)\" — with one history round the history must not fill the window "
                + "(fill > 0.5), otherwise `pushUp` pushes and this is the same case as "
                + "testSentMessageRidesIntoTheTimelineInsteadOfPopping"
        )
        // The trace begins BEFORE the frame in which the fade-in starts: `run()` takes its first
        // probe synchronously in the call, and until CoreAnimation commits the transaction
        // `presentation()` reads the model layer — opacity 1.0. Measured: the first two probes
        // 1.000, then 0.26–0.36 and up to 1.0 within 0.15 s. So the fade-in begins with the first
        // probe below 0.98; what stands before is no frame the user sees.
        guard let attempt = opacity.firstIndex(where: { $0 < 0.98 }) else {
            XCTFail(
                "The new row is transparent in no probe (minimum \(opacity.min() ?? -1)) — "
                    + "it stands there at once instead of fading in"
            )
            return
        }
        let fadeIn = Array(opacity[attempt...])
        // The RAMP ends with the first probe that is opaque again (≥ 0.98) — only it is the
        // fade-in. What comes after (the trace runs 2.4 s longer) belongs to the resting row: a
        // later, legitimate dip there (e.g. dimming the row when others move up) would otherwise
        // turn the test red although the fade-in is right. If no opaque probe exists, the whole
        // trace is the ramp, and the end value below fails.
        let opaqueFrom = fadeIn.firstIndex(where: { $0 >= 0.98 }) ?? (fadeIn.count - 1)
        let ramp = Array(fadeIn[...opaqueFrom])
        // The promise is a GROWTH, not an absolute threshold: a test demanding a minimum below
        // 0.5 and three intermediate steps fails under load — the early probes are missing (cell
        // building costs 59–79 ms per frame, the 0.26 s fade-in is then already half through),
        // and a fade-in whose first visible probe is at 0.6 is a fade-in all the same. FOUR
        // statements tell it from a flash: the first probe is more transparent than the last, no
        // probe of the ramp falls against the previous one (by more than 0.05 — one frame of
        // rounding), at the end of the WHOLE trace the row is opaque — and at least ONE probe
        // lies strictly between the start and end of the ramp ("the row FADES, it does not
        // flash" — a trace 1.0 · 1.0 · 0.0 · 1.0 would keep the other three and be a one-frame
        // jump. At 0.26 s of fade-in that is ≥ 5 probes even at 30 fps; a jump has none).
        // The first of the four only carries the case in which the ramp never becomes opaque —
        // otherwise it follows from the cut (`first` < 0.98 ≤ `last`). The weight lies on the
        // other three; it stands for the readability of the failure message.
        let first = ramp.first ?? 1
        let last = ramp.last ?? 0
        // The END VALUE belongs to the whole trace, not the ramp: `ramp.last` is by construction
        // the first probe ≥ 0.98 as soon as there is one — "end value ≥ 0.98" would be a
        // tautology there, and a row that fades in and then disappears again would stay green.
        // The trace runs 2.4 s; its last value is the picture the user keeps.
        let finalValue = fadeIn.last ?? 0
        XCTAssertLessThan(
            first, last,
            "The new row's opacity does not grow (first probe \(first), last \(last))"
        )
        let dips = zip(ramp, ramp.dropFirst()).filter { $0.0 - $0.1 > 0.05 }
        XCTAssertTrue(
            dips.isEmpty,
            "The opacity falls \(dips.count)× between two frames of the fade-in "
                + "(\(dips.map { "\($0.0) → \($0.1)" }.joined(separator: ", "))) — "
                + "a fade-in only goes upwards"
        )
        XCTAssertGreaterThanOrEqual(
            finalValue, 0.98,
            "The new row is not opaque at the end of the trace (end value \(finalValue), ramp ended at \(last))"
        )
        // Only require the intermediate probe if there is room for it between the start and end
        // of the ramp at all. The window is strict (first + 0.05 … last − 0.05), i.e.
        // `last − first − 0.10` wide; if the ramp begins late it is empty, and the test would be
        // load-sensitive instead of meaningful (measured on three real traces: first probe
        // 0.26–0.36, 6/4/5 hits — plenty, but a delayed first probe at 0.9 would have none). The
        // promise loses nothing: a real flash shows either no transparent probe at all (then the
        // manual check above trips) or exactly one near 0 before the 1.0 — and then the window
        // is 0.9 wide.
        let window = last - first - 0.10
        if window > 0.1 {
            let between = ramp.filter { $0 > first + 0.05 && $0 < last - 0.05 }
            XCTAssertFalse(
                between.isEmpty,
                "The opacity jumps from \(first) to \(last) without a probe in between "
                    + "(ramp \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · "))) — "
                    + "the row flashes instead of fading"
            )
        } else {
            add(attachment(
                "Ramp \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · ")) — "
                    + "window only \(String(format: "%.2f", window)) wide, the intermediate probe "
                    + "was not required (the first visible probe came too late)",
                "Fade-in: no window"
            ))
            print("Short history: intermediate probe skipped, window \(window)")
        }
        print("Short history ramp: \(ramp.map { String(format: "%.2f", $0) }.joined(separator: " · ")) "
            + "| end value \(finalValue) | probes total \(opacity.count)")
    }

    // ── Sliding in without a flash ───────────────────────────────────────────
    /// When a swipe gesture is released, UIKit docks the keyboard layout guide BACK to full
    /// height for a few frames and only then moves it away. The own probe for the announced
    /// movement animated from 0 to 0 in this case, so it had no animation at all —
    /// `presentation()` returned nothing, and the step fell back to that very docked guide.
    /// Measured, the lift jumped 0 → 219 → 0 (about 80 ms): the composer flashed once at full
    /// keyboard height and was then gone.
    ///
    /// Checked on the app's frame-by-frame trace (DEBUG only, path via CBASE_KEYBOARD_TRACE):
    /// once the lift has been at 0 when sliding in, it must not shoot up again.
    func testDismissingKeyboardNeverFlashesFullHeight() throws {
        try checkSlideInWithoutFlash(transactionDepth: 250)
    }

    /// The same, but the finger lets go HALFWAY — and RESTS beforehand. That is a trigger of its
    /// own and not just a variant: on release UIKit docks the keyboard layout guide BACK to
    /// full height for a few frames, and only afterwards does the close notification come. In
    /// this gap the measurement is the only source — it read exactly this jump back, and the
    /// composer shot to 100 % before sliding in. The deep pull above does not cover it: there
    /// the lift is already at 0 on release, and the gap goes unnoticed.
    ///
    /// The rest phase (0.7 s instead of 0.2 s) belongs to the trigger: if the measured value
    /// has stood still for 0.12 s and the trailing period has elapsed, the frame-by-frame
    /// tracking ends WITH THE FINGER STILL DOWN (`stopMotion`) — exactly this path had deleted
    /// the hold marker and was unreachable with the test's short rest, while every real thumb
    /// hit it.
    func testReleasingKeyboardDragHalfwayNeverFlashesFullHeight() throws {
        try checkSlideInWithoutFlash(transactionDepth: 110, holdDuration: 0.7)
    }

    // ── Drag zone above the input field ──────────────────────────────────────
    /// A few pixels above the input field the thumb retracts the keyboard without scrolling the
    /// history. Both are checked: the keyboard is gone AND the message that was visible before
    /// still stands in the same place.
    func testGripAboveComposerDismissesKeyboardWithoutScrolling() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 22"].waitForExistence(timeout: 25))
        // First drag into the history — only someone who is NOT at the end of the chat can see
        // at all whether the history scrolls along when retracting. This must happen before the
        // keyboard opens: a swipe down in the history would retract it itself.
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        timeline.swipeDown(velocity: .fast)
        timeline.swipeDown(velocity: .fast)
        Thread.sleep(forTimeInterval: 0.8)

        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.0)

        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        XCTAssertTrue(
            handle.frame.maxY <= composer.frame.minY + 1,
            "The drag zone does not lie above the input field (zone \(handle.frame), field \(composer.frame))"
        )
        // Thumb-sized — a narrow strip is not hit when swiping.
        XCTAssertGreaterThanOrEqual(
            handle.frame.height, 24,
            "The drag zone is too narrow for the thumb (\(handle.frame.height) pt)"
        )
        // Someone reading in the history stands STILL when the keyboard moves, by design (the
        // overlap moves into the list's indent, not its position). The window position of a
        // visible message is therefore the exact yardstick: it must not change when retracting
        // via the drag zone.
        let reference = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Verlauf ")).firstMatch
        XCTAssertTrue(reference.exists, "No history message visible")
        let marker = reference.label
        let prior = reference.frame.minY

        // From the zone, drag deep into the keyboard.
        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: start.withOffset(CGVector(dx: 0, dy: 330)),
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        XCTAssertTrue(
            keyboard.waitForNonExistence(timeout: 5),
            "The pull on the zone above the input field did not retract the keyboard"
        )
        Thread.sleep(forTimeInterval: 1.0)
        let after = app.staticTexts[marker].frame.minY
        XCTAssertEqual(
            after, prior, accuracy: 8,
            "The history scrolled along when retracting (\"\(marker)" + "\" \(prior) → \(after))"
        )
        attach(app, "Drag zone retracted the keyboard")
    }

    // ── The jump arrow stays tappable with the keyboard open ──────────────────
    /// The arrow lives in a mini hosting of its own directly above the drag zone (see
    /// `ChatStageController.arrowHost`) — it must stay tappable when the keyboard is open, too.
    func testJumpArrowStaysTappableInFrontOfGripExtension() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        let newest = app.staticTexts["Verlauf Antwort 22"]
        XCTAssertTrue(newest.waitForExistence(timeout: 25))
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        let arrow = app.buttons["jump-to-latest"]
        for _ in 0..<6 where !arrow.isHittable {
            timeline.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(arrow.waitForExistence(timeout: 5), "The arrow to the end of the chat does not appear")

        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.0)

        arrow.tap()
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertTrue(newest.waitForExistence(timeout: 5), "The newest message does not come into view")
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(
            newest.frame.maxY <= handle.frame.minY + 1,
            "The arrow tap did not bring the chat to the end — the extension swallows it"
        )
        attach(app, "Arrow in front of the drag zone")
    }

    /// The keyboard lifts the composer in a freshly created chat. The way there is the "New chat"
    /// sheet: it calls `openDraft` BEFORE `dismiss()` ("Start" opens a draft, the chat is only
    /// created on sending), so the chat stage enters the window WHILE the sheet is still
    /// presented. The test produces exactly this order — a chat opened via the list (all other
    /// keyboard tests) does not go through it.
    func testKeyboardLiftsComposerInAFreshlyCreatedChat() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 0))
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let fresh = app.buttons["overview-new-chat"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "The \"New chat\" button is missing")
        fresh.tap()
        let create = app.buttons["Start"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The \"New chat\" sheet does not appear")
        // Providers and profiles come from two fetches — only afterwards is "Start" active.
        let deadline = Date().addingTimeInterval(15)
        while !create.isEnabled, Date() < deadline { Thread.sleep(forTimeInterval: 0.3) }
        create.tap()

        let composer = textEntry(app, "chat-composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The new chat's composer is missing")
        // The chat is empty — exactly the case of the finding. There the greeting stands instead
        // of the hint text (modelled on the ChatGPT start page); the island stays at the bottom.
        XCTAssertTrue(
            app.staticTexts["chat-empty-greeting"].waitForExistence(timeout: 15),
            "The new chat is not empty"
        )
        // Let the sheet slide out fully before measuring.
        Thread.sleep(forTimeInterval: 1.2)
        func island() -> XCUIElement? {
            app.descendants(matching: .any).matching(identifier: "composer-island")
                .allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })
        }
        guard let quietEdge = island()?.frame.maxY else {
            return XCTFail("The composer island is missing")
        }

        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "The keyboard does not open")
        Thread.sleep(forTimeInterval: 1.5)
        guard let now = island()?.frame.maxY else {
            return XCTFail("The composer island vanished with the keyboard")
        }
        attach(app, "New chat with open keyboard")
        XCTAssertGreaterThan(
            quietEdge - now, 200,
            "The composer stayed put when the keyboard opened (lifted only \(quietEdge - now) pt)"
        )
        // As in every other chat: island above the keyboard, no hole in between. The
        // `keyboards` element begins about 44 pt BELOW the real edge (see
        // `testComposerIsARoundedIslandAboveTheKeyboard`).
        let clearance = keyboard.frame.minY - now
        XCTAssertGreaterThan(clearance, 0, "The island lies behind the keyboard (\(clearance) pt)")
        XCTAssertLessThan(clearance, 80, "Too much gap between island and keyboard (\(clearance) pt)")
    }

    // ── After a chat switch with the keyboard open the island sits at the bottom ─────
    /// Reported on iPhone, iOS 26: the input composer sometimes is not at its place at the bottom
    /// when the chat is opened, but higher up. Measured 66 pt too high (= extension 100 − home
    /// indicator 34), on two paths, both with the keyboard OPEN in the previous chat: pull the
    /// left drawer open and choose another chat there, or go ‹ back and open it from the
    /// overview. The keyboard closes without animation, the root's `keyboardLayoutGuide` stays
    /// at the height of the extension, and the new stage fell back on it for lack of an
    /// announcement of its own (trace: `guide e=774 sb=840 a=nan o=66`; see
    /// `KeyboardAnnouncement`).
    ///
    /// Each path runs in a FRESH process — the jammed guide survives in the process, a second
    /// path in the same run would prove nothing of its own. Measured at the input field (a sheet
    /// element, not the island container) against its resting position in the first chat; both
    /// paths are collected first, then judged, so that a red run names both.
    func testComposerSitsAfterChatSwitchWithOpenKeyboardBottom() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 8))
        defer { _ = setFixtureHistory(server, count: 0) }
        let second = "20000000-0000-4000-8000-000000000002"
        var findings: [String] = []

        func changeOver(_ route: String, openOtherChat: (XCUIApplication) -> Void) throws {
            let app = launchApp(server: server)
            try openFirstChat(app)
            // The field is a `UITextView` (`Chat/ChatInput.swift`) — `textEntry` would only see a text field after 6 s.
            let field = app.textViews["chat-composer"]
            XCTAssertTrue(field.waitForExistence(timeout: 25), "The input field is missing")
            XCTAssertNotEqual(app.staticTexts["chat-title"].label, "Architektur-Notizen", "\(route): even the first chat is the second")
            // Wait for the resting position: it stands when two queries in a row report the same position.
            var quiet = field.frame.maxY
            _ = waitUntil(timeout: 5) {
                let now = field.frame.maxY
                defer { quiet = now }
                return abs(now - quiet) < 0.5 && now > 0
            }
            // Manual check: the resting position is the one above the home indicator (field bottom edge 80.3 pt above the screen edge on
            // the iPhone 17 — home indicator 34, island padding 9, context bar and field padding), not an already lifted one.
            XCTAssertLessThan(app.frame.maxY - quiet, 110, "\(route): the field already stands too high in the first chat (\(quiet))")
            field.tap()
            let keyboard = app.keyboards.firstMatch
            XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "\(route): the keyboard does not open")
            _ = waitUntil(timeout: 3) { field.frame.maxY < quiet - 200 }
            openOtherChat(app)
            // Without these two manual checks a high field would be no finding: the keyboard must be closed, and ANOTHER chat
            // must be open.
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "\(route): the keyboard stayed open")
            let title = app.staticTexts["chat-title"]
            XCTAssertTrue(
                waitUntil(timeout: 15) { title.exists && title.label == "Architektur-Notizen" },
                "\(route): the second chat is not open (title \"\(title.exists ? title.label : "–")\")"
            )
            let fresh = app.textViews["chat-composer"]
            XCTAssertTrue(fresh.waitForExistence(timeout: 15), "\(route): the other chat's input field is missing")
            if !waitUntil(timeout: 6, { abs(fresh.frame.maxY - quiet) <= 2 }) {
                findings.append("\(route): field at \(fresh.frame.maxY) instead of \(quiet) (\(quiet - fresh.frame.maxY) pt too high)")
                attach(app, "Composer too high after \(route)")
            }
            app.terminate()
        }

        try changeOver("Drawer") { app in
            swipeRightAcrossScreen(app)
            let row = app.buttons["sidebar-chat-\(second)"]
            XCTAssertTrue(waitUntilHittable(row, timeout: 8), "Drawer: the second chat is not in the drawer")
            row.tap()
            _ = waitUntil(timeout: 4) { self.drawerOut(app, links: true) < 0.05 }
        }
        try changeOver("Back") { app in
            app.buttons["chat-back"].firstMatch.tap()
            let row = app.buttons["overview-chat-\(second)"]
            XCTAssertTrue(waitUntilHittable(row, timeout: 10), "Back: the second chat is not in the overview")
            row.tap()
        }
        XCTAssertTrue(findings.isEmpty, "The island stands too high after the chat switch — " + findings.joined(separator: "; "))
    }

    // ── The arrow lands right at the bottom ──────────────────────────────────
    /// `setContentOffset(animated:)` freezes its target at the start. If the top indent changes
    /// on the way (fill remainder in a short history, keyboard, newly arriving rows), the ride
    /// ends beside it — "sometimes it does not scroll down 100 %". The resting position is
    /// checked: the newest message stands with the base padding (12 pt) plus the own air of a
    /// text block (3 pt) above the TOP EDGE OF THE COMPOSER ISLAND. Since the composer floats
    /// above the history, the list by construction reaches under it — its bottom edge no longer
    /// serves as a reference (measured there it would be composer area + 15 pt).
    func testJumpToLatestLandsExactlyAtTheEnd() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 22))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        let newest = app.staticTexts["Verlauf Antwort 22"]
        XCTAssertTrue(newest.waitForExistence(timeout: 25))

        // Drag into the history until the arrow appears.
        let arrow = app.buttons["jump-to-latest"]
        for _ in 0..<6 where !arrow.isHittable {
            timeline.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(arrow.waitForExistence(timeout: 5), "The arrow to the end of the chat does not appear")
        arrow.tap()
        Thread.sleep(forTimeInterval: 1.2)

        // The reference edge is the drag zone: it is the topmost element of the composer —
        // exactly the edge at which the history visibly ends.
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        let bottomEdge = actionBarBottom(app, below: newest.frame.maxY)
        let clearance = handle.frame.minY - bottomEdge
        XCTAssertEqual(
            clearance, 15, accuracy: 5,
            "After the jump the newest message does not stand at the end (\(clearance) pt of air below it)"
        )
        // A second jump, when everything already stands at the end, must not move anything.
        arrow.tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(
            handle.frame.minY - actionBarBottom(app, below: newest.frame.maxY), clearance, accuracy: 2,
            "A jump at the end of the chat moves the history anyway"
        )
        attach(app, "Jump to the end of the chat")
    }

    // ── Rows without content do not inflate the gap ──────────────────────────
    /// An assistant turn that only contains `TaskCreate`/`TaskUpdate` draws nothing — the calls
    /// stand in the task bar above the composer. It still got a cell, and a cell without height
    /// costs the row spacing on BOTH sides: measured 22 pt of gap instead of 11 pt ("abnormal
    /// amount of padding under the user message") and at the end of the chat correspondingly
    /// too much air above the composer ("the last message has a lot of padding").
    ///
    /// The fixture provides both positions for this: an invisible turn IN THE MIDDLE of the
    /// history and one as the LAST row.
    func testInvisibleTurnsAddNoExtraGap() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, invisible: true),
            "The fixture gateway did not accept the history with invisible turns"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let lastQuestion = app.staticTexts["Letzte sichtbare Frage"]
        XCTAssertTrue(lastQuestion.waitForExistence(timeout: 25))

        // Two user bubbles with the invisible turn in between. The normal gap is expected:
        // 10 pt bubble edge + 11 pt row spacing + 10 pt bubble edge = 31 pt. With the empty cell
        // it measured 42 pt — the row spacing arises twice, once towards it and once away from it.
        let overInvisible = app.staticTexts["Sichtbare Frage 2"].frame.minY
            - actionBarBottom(app, below: app.staticTexts["Unsichtbarer Turn folgt"].frame.maxY)
        XCTAssertEqual(
            overInvisible, 31, accuracy: 4,
            "The invisible turn tears open an additional gap: \(overInvisible) pt instead of 31"
        )

        // And the same case as the LAST row. The reference edge is the DRAG ZONE (topmost element
        // of the composer): since the composer floats above the history, the list by
        // construction reaches under it — its bottom edge no longer serves as a measure (there it
        // would be composer area + 22 pt). The drag zone lies ABOVE the task bar that this history
        // fills via TaskCreate — so the measure stays independent of the bar. Expected are 10 pt
        // bubble edge + 12 pt base padding of the list = 22 pt; with the empty cell the row
        // spacing (11 pt) came on top.
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        let clearanceUnderLast = handle.frame.minY
            - actionBarBottom(app, below: lastQuestion.frame.maxY)
        XCTAssertEqual(
            clearanceUnderLast, 22, accuracy: 5,
            "Too much air under the last message (\(clearanceUnderLast) pt instead of 22) — "
                + "the invisible last row pushes along"
        )
    }

    // ── A collapsing collective row leaves no phantom height ─────────────────
    /// At the end of the run `live` flips, and the collective row of the tool calls collapses —
    /// the content of the assistant cell shrinks by the long shell results. If the cell keeps
    /// its old (large) height, the SwiftUI content centres vertically in it: a huge gap ABOVE the
    /// answer (to the user bubble) and BELOW it (to the end of the chat) — exactly the finding
    /// "huge padding between the last LLM message and my message" or "extremely much space
    /// between the last message and the end of the chat".
    ///
    /// The fixture provides the run with two bash calls in a row (collective row, results long
    /// enough that collapsing changes the cell height noticeably) and `fast: true` (end of the
    /// run after 3.5 s instead of 10 s).
    func testCollapsingToolGroupLeavesNoPhantomHeight() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 8))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        // AFTER launchApp: its /fixture/reset-run resets the group-tools toggle.
        XCTAssertNotNil(fixturePost(server + "/fixture/group-tools", body: ["open": true, "fast": true]))
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        composer.tap()
        composer.typeText("Groups")
        app.buttons["chat-send"].tap()

        // The run: the collective row appears open, then the turn ends and it collapses.
        let group = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "commands")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 20), "The collective row of the tool calls is missing")
        let display = app.descendants(matching: .any)
            .matching(identifier: "chat-run-indicator").firstMatch
        XCTAssertTrue(display.waitForExistence(timeout: 20), "The run indicator does not appear")
        XCTAssertTrue(display.waitForNonExistence(timeout: 25), "The run does not end")

        // Retract the keyboard (via the drag zone) so that user bubble AND answer are in the
        // window; then let things settle briefly.
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        if app.keyboards.firstMatch.exists {
            let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(
                forDuration: 0.1,
                thenDragTo: start.withOffset(CGVector(dx: 0, dy: 330)),
                withVelocity: .slow,
                thenHoldForDuration: 0.2
            )
            _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
        }
        Thread.sleep(forTimeInterval: 1.2)
        attach(app, "After collapsing the collective row")

        // The bottom edge of the cell is the summary row ("Done after …"), which steps under the
        // text at the end of the run.
        let response = app.staticTexts["Erste Antwort."]
        XCTAssertTrue(response.waitForExistence(timeout: 10), "The streamed answer is missing")
        let summary = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Done after")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 10), "The summary row is missing")

        // Only the base padding of the list (12 pt) — as with the jump to the end.
        let clearanceBottom = handle.frame.minY - actionBarBottom(app, below: summary.frame.maxY)
        XCTAssertEqual(
            clearanceBottom, 12, accuracy: 6,
            "Phantom air under the last answer (\(clearanceBottom) pt instead of 12) — "
                + "the cell kept its old height after collapsing"
        )

        // Top edge of the answer cell against the own user bubble. The reference element is the
        // running todo row ("Fixture arbeitet") of the TodoWrite list: above it lie the header
        // row + box edge (together with the row spacing normally 47 pt, measured twice).
        // Clearly more would be phantom height of the cell.
        let bubbles = app.descendants(matching: .any)
            .matching(identifier: "chat-user-bubble").allElementsBoundByIndex
            .filter { $0.frame.height > 0 }
        guard let bubble = bubbles.max(by: { $0.frame.maxY < $1.frame.maxY }) else {
            return XCTFail("No user bubble in the window")
        }
        let todoRow = app.staticTexts["Fixture arbeitet"]
        let topEdge = [todoRow, group, response]
            .filter { $0.exists }
            .map { $0.frame.minY }
            .min() ?? response.frame.minY
        let clearanceTop = topEdge - bubble.frame.maxY
        XCTAssertEqual(
            clearanceTop, 47, accuracy: 8,
            "Phantom air between user bubble and answer (\(clearanceTop) pt instead of 47)"
        )
    }

    // ── Huge collapsed history: the end of the chat stays tight ──────────────
    /// Reconstruction of the finding "extremely much space between the last LLM message and the
    /// end of the chat" in a real working chat: turns with 18 bash calls and long results
    /// (collapsed a collective row, the cell ESTIMATE of 80 pt is far off). Freshly opened, the
    /// last answer must still stand directly above the composer with the base padding.
    func testHugeCollapsedHistoryKeepsTightEndGap() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 3, stress: true))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        let completion = app.staticTexts["Infrastruktur Abschluss 3"]
        XCTAssertTrue(completion.waitForExistence(timeout: 25), "The last answer is missing")
        // Let self-sizing and the indent recomputation settle.
        Thread.sleep(forTimeInterval: 1.5)
        attach(app, "End of the chat after a fresh open")

        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        let clearance = handle.frame.minY - actionBarBottom(app, below: completion.frame.maxY)
        XCTAssertEqual(
            clearance, 15, accuracy: 6,
            "Too much air between the last answer and the end of the chat (\(clearance) pt instead of 15)"
        )
    }

    // ── Open error boxes: cell frame = rendered height ───────────────────────
    /// The real finding ("extremely much space between the last LLM message and the end of the
    /// chat", likewise an empty band to the own message above): a horizontal ScrollView in a
    /// history row (result box of an ERROR call, code block, table, diff) reports a DIFFERENT
    /// height to the cell's self-sizing than it renders — the cell keeps the too large frame.
    /// On a real history replayed 1:1 ("New issue in Sample Frontend") it was 175 pt of empty
    /// band, on this reconstruction without `fixedSize(horizontal: false, vertical: true)`
    /// 114 pt. The recipe needs all ingredients together: wide multi-line ERROR results
    /// (rendering expanded), wrapping running texts in between, a long markdown text at the
    /// end — individually the measurement does not tip.
    func testWideErrorResultsKeepCellFrameTight() throws {
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
        add("user", "Wide-Error-Repro")
        let wide = String(repeating: "very-width-monospace-output ", count: 18)
        for group in 0..<8 {
            for call in 0..<3 {
                let id = "t-\(group)-\(call)"
                add("tool", json(["id": id, "name": "Bash", "input": ["command": "echo \(group)-\(call)"]]))
                let error = group % 2 == 1 && call == 1
                add("tool_result", json([
                    "id": id,
                    "result": error
                        ? "Exit code 1\n\(wide)\nTraceback (most recent call last):\n  ModuleNotFoundError: No module named PIL\n\(wide)"
                        : "ok \(group)-\(call)",
                    "isError": error,
                ]))
            }
            add("assistant", "Zwischenstand \(group): "
                + String(repeating: "Text, der die Zeile füllt und mehrfach umbricht. ", count: 4))
        }
        add("assistant", [
            "Ursache gefunden und behoben. Kurz zum Stand:",
            "**Root Cause:** Das Modul lädt seine Vorlagen als Paket erst zur Laufzeit nach. "
                + "Wir haben `renderPages` ohne `rootUrl` aufgerufen, also scheitert die "
                + "Auflösung — der Pfad eingebetteter Bilder. Der Bericht wird gezeichnet, "
                + "nur ohne Bilder, und im Bildband *sind* die Bilder der Inhalt.",
            "**Fix:** `src/lib/templates.js` ist jetzt die einzige Stelle, die Ordner und "
                + "Auslieferungsadresse festhält.",
            // The postscript "Drei Läufe, derselbe Befund." makes both paragraphs long enough to
            // need three lines in the text column; without it they fit into TWO lines and the
            // test would no longer reach the case it guards. Lengthened instead of lowering the limit.
            "**Verifiziert:** mit einem Dokument über denselben `rootUrl`-Pfad. Suite: 947 Tests grün. Drei Läufe, derselbe Befund.",
            "**Gegenprobe:** mit einem Dokument über denselben rootUrl-Path. Suite: 947 Tests bunt. Drei Läufe, derselbe Befund.",
            "**!4** → https://git.example.com/sample/frontend/-/merge_requests/4 "
                + "(`fix/report-asset-paths` → `develop`)",
        ].joined(separator: "\n\n"))
        add("meta", json(["secs": 99, "inTok": 5, "outTok": 7]))
        XCTAssertNotNil(
            fixturePost(server + "/fixture/history", body: ["entries": entries]),
            "The fixture gateway did not accept the raw history rows"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let summary = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Done after")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 30), "The summary row is missing")
        // Let self-sizing and the indent recomputation settle.
        Thread.sleep(forTimeInterval: 2.0)
        attach(app, "End of the chat with open error boxes")

        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        let clearance = handle.frame.minY - actionBarBottom(app, below: summary.frame.maxY)
        XCTAssertEqual(
            clearance, 12, accuracy: 6,
            "Phantom air under the last message (\(clearance) pt instead of 12) — "
                + "a cell claims more height to the self-sizing than it renders"
        )

        // And paragraphs lose no line to a too tight height. The counter paragraph (without a
        // code span) needs three lines at this width (> 60 pt) and must get them. The verified
        // paragraph carries a code span (`wasmUrl`) and is in the KNOWN EDGE CASE: SwiftUI's
        // Text measures the wrap there more optimistically by one word boundary than it draws
        // it — the third line drops out as "…" (42 instead of 64 pt; not curable via an
        // attribute, see `Text.init(markdown:)`). Frozen at "not worse": it must never fall
        // below two lines. (The edge case hangs on the exact word boundary.)
        let withSpan = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "947 Tests grün")).firstMatch
        let withoutSpan = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "947 Tests bunt")).firstMatch
        XCTAssertTrue(withSpan.exists, "The verified paragraph is missing")
        XCTAssertTrue(withoutSpan.exists, "The counter paragraph is missing")
        XCTAssertGreaterThan(
            withoutSpan.frame.height, 60,
            "The counter paragraph is trimmed (\(withoutSpan.frame.height) pt tall)"
        )
        XCTAssertGreaterThan(
            withSpan.frame.height, 40,
            "The verified paragraph is cut off more than the known "
                + "code-span edge case (\(withSpan.frame.height) pt tall)"
        )
    }

    // ── The history does not stand upside down ───────────────────────────────
    /// The cells of the inverted list carry the SECOND mirroring (the first sits on the
    /// collection). It got lost because `contentConfiguration` REPLACES the `contentView`: on
    /// the first configuration of a cell it is swapped, on every further one only updated.
    /// Freshly built cells therefore stood upside down, recycled ones did not — the finding
    /// "some messages stand upside down".
    ///
    /// Measured at the blocks of ONE message (the markdown probe is a single row): if its cell
    /// stands upside down, the heading lies BELOW the code block. The position comes from
    /// accessibility and goes through all transformations — a mirrored row is thus noticed
    /// without reading pixels.
    func testTimelineRowsRenderUpright() throws {
        let server = try requireFixture()
        XCTAssertTrue(
            setFixtureHistory(server, count: 1, markdown: true),
            "The fixture gateway did not accept the markdown probe"
        )
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        // Order in the message's source, from top to bottom.
        let blocks = [
            "Zwischenbericht",
            "Offene Punkte",
            "Wichtig: die Warteschlange nicht leeren.",
            "select count(*) from auftraege;",
        ]
        for text in blocks {
            XCTAssertTrue(
                app.staticTexts[text].waitForExistence(timeout: 25),
                "The markdown block is missing in the history: \(text)"
            )
        }
        var previousBlock = ""
        var previousY = -CGFloat.greatestFiniteMagnitude
        for text in blocks {
            let y = app.staticTexts[text].frame.minY
            XCTAssertGreaterThan(
                y, previousY,
                "Block \(text) must stand BELOW \(previousBlock) — the row is mirrored"
            )
            previousBlock = text
            previousY = y
        }
        attach(app, "History stands the right way round")
    }

    // ── Releasing a drag at the keyboard: the island does not jump up ───────
    /// Reported: "when you swipe the input field down with the thumb and let go, it shoots up
    /// once briefly to 100 % extended and then retracts together with the keyboard."
    ///
    /// The jump lies in the window between lifting the finger and the close notification: there
    /// the last ANNOUNCED edge applied, and that was the one of the open keyboard. Measured via
    /// the probe (CBASE_COMPOSER_TRACE): XCUITest waits for app idle before every query of its
    /// own and NEVER sees a single intermediate frame. `onMax` is the largest upward step
    /// between two frames — for the jump the whole remaining distance at once, for a real
    /// keyboard ride (0.25 s) at most a good 20 pt.
    ///
    /// HONESTLY: the reported jump is not reproducible in the SIMULATOR (with and without the
    /// repair `onMax=0.0`). That fits what already stands at `settleKeyboardAfterRelease`: the
    /// completion after release only runs ON THE DEVICE outside the process, in the simulator
    /// the frames continue in-process and the window between lift-off and the close
    /// notification practically does not exist. The test holds the promise anyway — it would
    /// report a jump as soon as one ever occurs here.
    func testReleasingTheKeyboardDragDoesNotSnapTheComposerUp() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, environment: ["CBASE_COMPOSER_TRACE": "1"])
        try openFirstChat(app)

        let composer = app.textViews["chat-composer"].exists
            ? app.textViews["chat-composer"]
            : app.textFields["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The input field is missing")
        let probe = app.otherElements["composer-trace"]
        XCTAssertTrue(probe.waitForExistence(timeout: 8), "The measuring probe is missing (CBASE_COMPOSER_TRACE)")
        composer.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 5) else {
            throw XCTSkip("Without a software keyboard in the simulator the drag cannot be checked")
        }
        // The keyboard's ride up is itself a large movement upwards — it must be out of the
        // probe's 4 s window before measuring.
        Thread.sleep(forTimeInterval: 4.5)

        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(handle.exists, "The drag zone above the composer is missing")
        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Far enough in that the keyboard finishes on release (the stage sends it away from 20 pt
        // below the session maximum) — and slowly, so that the distance decides and not a flick.
        start.press(
            forDuration: 0.1,
            thenDragTo: start.withOffset(CGVector(dx: 0, dy: 150)),
            withVelocity: .slow,
            thenHoldForDuration: 0.1
        )
        Thread.sleep(forTimeInterval: 1.5)

        let value = probe.value as? String ?? ""
        print("PROBE release: \(value)")
        guard let range = value.range(of: #"onMax=([\d.]+)"#, options: .regularExpression),
              let on = Double(value[range].dropFirst("onMax=".count)) else {
            XCTFail("The probe delivered no jump value: \(value)")
            return
        }
        XCTAssertLessThanOrEqual(
            on, 24,
            "The island jumped up by \(on) pt on release instead of retracting with the keyboard (\(value))"
        )
        // And the second metric: an ANIMATED ride upwards (retreat, 0.25 s) covers only about
        // 13 pt per frame and would stay below any jump threshold. After releasing a downward
        // drag no upward movement belongs at all.
        guard let totalRange = value.range(of: #"onTotal=([\d.]+)"#, options: .regularExpression),
              let total = Double(value[totalRange].dropFirst("onTotal=".count)) else {
            XCTFail("The probe delivered no total value: \(value)")
            return
        }
        XCTAssertLessThanOrEqual(
            total, 24,
            "After release the island moved \(total) pt upwards in total (\(value))"
        )
    }

    // ── Keyboard behaviour (regressions) ────────────────────────────────────
    /// Interactive retraction (`scrollDismissesKeyboard(.interactively)`): the keyboard follows
    /// the finger instead of collapsing completely at its top edge at once (as the former own
    /// swipe recognizer did). XCUITest can check the two ends: scrolling ABOVE never closes, a
    /// pull INTO the keyboard closes after release (iOS' rule is direction-based — even a flat
    /// dip with downward history closes; snapping back would only exist when pulling up, and
    /// XCUITest cannot do polyline gestures). Riding along under the finger is verified by
    /// video: record testKeyboardMotionRecordingProbe and look at the frames of the drag
    /// phase (keyboard parks at finger height, composer sticks to the edge).
    func testKeyboardFollowsDragAndDismissesOnlyWhenDraggedDeepAgainstFixture() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        composer.tap()
        composer.typeText("Edge test")

        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        // Anchor all points to the KEYBOARD — the coordinates of the app element are shifted
        // against the screen, whereas distances measured at the keyboard hit exactly.
        let keyboardTopCenter = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))

        // "Above the keyboard" is NOT "above the key edge". The invisible `KeyboardGripAccessory`
        // (100 pt) extends the keyboard upwards up to the island; from THIS edge the interactive
        // retraction attaches to the finger. Measured (iPhone 17 simulator): `keyboard.frame`
        // begins at y 583, the region top edge reported by the system (`willChangeFrame endMinY`
        // in the app's frame trace) at y 439 — 144 pt higher —, and the island's drag zone
        // (`composer-keyboard-grip`) lies at y 420…451. The former drag end "key edge − 100"
        // (y 483) thus lay 44 pt INSIDE the region; the keyboard followed the finger there
        // 35–41 pt, and the 20 pt rule rightly closed it — the test did not check what it
        // claims. So the edge is now READ instead of estimated: drag end 20 pt above the top
        // edge of the drag zone (measured y 400, corresponding to key edge − 183).
        let handle = app.descendants(matching: .any)["composer-keyboard-grip"]
        XCTAssertTrue(
            handle.waitForExistence(timeout: 3),
            "The island's drag zone is the anchor for \"above the keyboard\" — it is missing"
        )
        let history = app.descendants(matching: .any)["chat-timeline"]
        XCTAssertTrue(history.exists)
        let endY = handle.frame.minY - 20
        print("Edge test geometry: keyboard=\(keyboard.frame) grip=\(handle.frame) "
            + "history=\(history.frame) dragEnd=\(endY)")
        // Manual check against a tautology: if the drag end lay outside the history or (through a
        // broken frame) under the island, the gesture would run into nothing and the test would
        // stay green without ever having checked anything.
        XCTAssertTrue(
            endY > history.frame.minY + 40 && endY < handle.frame.minY,
            "The drag end must lie IN the history and above the island — measured: "
                + "history \(history.frame), drag zone \(handle.frame), drag end y \(endY)"
        )
        let normalEnd = keyboardTopCenter.withOffset(
            CGVector(dx: 0, dy: endY - keyboard.frame.minY)
        )
        let normalStart = normalEnd.withOffset(CGVector(dx: 0, dy: -50))
        normalStart.press(forDuration: 0.05, thenDragTo: normalEnd)
        XCTAssertTrue(
            keyboard.waitForExistence(timeout: 2),
            "Scrolling above the keyboard must not close it"
        )

        // Pull into the keyboard: it rides along under the finger and closes after release.
        // Start at -260: clearly above the composer, so safely in the history — only its scroll
        // view carries the interactive pull-along. Stay vertical so that the drawer swipe does
        // not collide.
        let deepStart = keyboardTopCenter.withOffset(CGVector(dx: 0, dy: -260))
        let deep = keyboardTopCenter.withOffset(CGVector(dx: 0, dy: 250))
        deepStart.press(
            forDuration: 0.1,
            thenDragTo: deep,
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        XCTAssertTrue(
            keyboard.waitForNonExistence(timeout: 3),
            "The deep pull into the keyboard must close it"
        )
    }

    func testOpeningKeyboardKeepsExistingChatVisibleAgainstFixture() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 4, stress: true, delayMs: 900))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))

        let timeline = app.descendants(matching: .any)["chat-timeline"]
        XCTAssertTrue(timeline.exists)
        // Deliberately searched IN the history, not in the whole app: a drag that rests on message
        // text counts as a long press after 0.5 s (text marker), and the selection dialog carries
        // the message text as a subtitle. An app-wide search then found TWO hits and failed.
        let finalAnswer = timeline.staticTexts["Infrastruktur Abschluss 4"]
        XCTAssertTrue(
            finalAnswer.waitForExistence(timeout: 25),
            "The large, lazily loaded infrastructure history was not displayed"
        )
        XCTAssertTrue(
            finalAnswer.isHittable && finalAnswer.frame.minY < keyboard.frame.minY,
            "At the end of the chat the keyboard must push the history up instead of making it vanish"
        )

        let originalX = finalAnswer.frame.minX
        print("W4 geometry before: history=\(timeline.frame) keyboard=\(keyboard.frame) answer=\(finalAnswer.frame)")
        // The promise concerns the HISTORY: if its scroll view gets a drag with a sideways
        // component, it must not shift sideways (a too wide cell or horizontally scrollable
        // content would do exactly that). A HORIZONTAL drag no longer reaches the scroll view,
        // though: the drawer takes every clearly sideways path, even a slow one
        // (`HorizontalPanReader`: way |dx| ≥ 6 and |dx| > 1.2·|dy|, or speed |vx| > 1.5·|vy| and
        // > 25 pt/s) — and then pushes the whole stage including the history to the left and
        // closes the keyboard. So drag DIAGONALLY, vertically dominant (1 : 2, below both
        // thresholds), and UPWARDS: at the end of the chat the history only springs, and the
        // keyboard does not ride along interactively. Slowly, so that the movement safely stays
        // > 10 pt in 0.5 s and the marker does not kick in. The touch-down is at the NEWEST ROW
        // (right next to its action bar, 30 pt below the text centre) — not relative to the
        // keyboard: 150 pt above its edge already lies the drag zone `composer-keyboard-grip`
        // (420–451 pt), and a drag there does not reach the history at all.
        let start = finalAnswer
            .coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            .withOffset(CGVector(dx: 0, dy: 30))
        let end = start.withOffset(CGVector(dx: -50, dy: -100))
        print("W4 drag: start=\(start.screenPoint) end=\(end.screenPoint)")
        start.press(
            forDuration: 0.05,
            thenDragTo: end,
            withVelocity: XCUIGestureVelocity(rawValue: 40),
            thenHoldForDuration: 0.1
        )
        let after = finalAnswer.frame
        print("W4 geometry after: answer=\(after) history=\(timeline.frame)")
        XCTAssertEqual(
            after.minX,
            originalX,
            accuracy: 1,
            "The history must not move on the X axis (before \(originalX), after \(after.minX))"
        )
        attach(app, "Large chat stays visible on keyboard resize")
    }

    /// Regression for "the chat is black when opening, only scrolling brings it back": a long
    /// history must stand IMMEDIATELY at its newest message when opened. It used to be scrolled
    /// by hand to an estimated content edge — with too large an estimate the view ended up
    /// behind the content.
    func testOpeningLongChatStartsAtNewestMessage() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 40, stress: true))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)

        let newest = app.staticTexts["Infrastruktur Abschluss 40"]
        XCTAssertTrue(
            newest.waitForExistence(timeout: 20),
            "A long history must begin at its newest message when opened"
        )
        XCTAssertTrue(newest.isHittable, "The newest message must not lie outside the picture")
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.exists)
        XCTAssertLessThan(
            composer.frame.minY - newest.frame.maxY,
            120,
            "The newest message must stand directly above the composer"
        )
        // Additionally checked on the picture: the lower quarter must not be an empty surface.
        XCTAssertGreaterThan(
            timelineTailInk(app),
            0.02,
            "The end of the history is an empty surface"
        )
        attach(app, "Long history begins at the newest message")
    }

    /// Regression for "when opening the keyboard it looks as if the chat rebuilds itself": the
    /// history must not jump back and forth during the keyboard movement. It used to be pulled
    /// after a wandering height estimate 25× (measured jumps ±530 pt).
    func testOpeningKeyboardDoesNotShuffleTheTimeline() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 40, stress: true))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let newest = app.staticTexts["Infrastruktur Abschluss 40"]
        XCTAssertTrue(newest.waitForExistence(timeout: 20))

        let composer = app.descendants(matching: .any)["chat-composer"]
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        // Measure repeatedly right after the keyboard appears: pulling after against the estimate
        // was active for seconds and would have wandered here.
        var positions: [CGFloat] = []
        for _ in 0..<4 {
            XCTAssertTrue(newest.exists, "The newest message must not vanish")
            positions.append(newest.frame.minY)
            Thread.sleep(forTimeInterval: 0.4)
        }
        let spread = (positions.max() ?? 0) - (positions.min() ?? 0)
        XCTAssertLessThan(
            spread,
            2,
            "The history must stand still after the keyboard opens (drift: \(positions))"
        )
        XCTAssertTrue(newest.isHittable, "The newest message must stay visible above the keyboard")
        attach(app, "History stands still with the keyboard open")
    }

    /// The gap composer→keyboard must be independent of the scroll position: the user's finding
    /// was that the input field partly lay BEHIND the keyboard when one stood further up in the
    /// history and then opened the keyboard. Measured self-calibrating — first at the end of the
    /// chat, then in several rounds scrolled ever further up; every gap must equal the first.
    ///
    /// SEVERAL rounds with a LONG history are intentional: the error was a race and hit about
    /// every fifth opening. It arose when the rebuild of the scroll view reported the chat's new
    /// bottom edge (home bar gone) only AFTER the keyboard — the more history stands above the
    /// window, the more expensive this rebuild is.
    func testComposerGapAboveKeyboardIsScrollIndependentAgainstFixture() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 100, stress: true))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)

        let composer = app.descendants(matching: .any)["chat-composer"]
        let keyboard = app.keyboards.firstMatch

        /// Open the keyboard, measure the gap, close the keyboard again.
        var lastGeometry = ""
        func gapWithKeyboardOpen() -> CGFloat {
            composer.tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
            Thread.sleep(forTimeInterval: 1.5)
            // Queried afresh: a reused `XCUIElement` returns its last resolved snapshot, and that
            // stems here from the moment the keyboard had just appeared — i.e. BEFORE the
            // finished layout.
            let kb = app.keyboards.firstMatch.frame
            let field = app.descendants(matching: .any)["chat-composer"].frame
            let gap = kb.minY - field.maxY
            lastGeometry = "keyboard=\(kb) field=\(field) history=\(app.descendants(matching: .any)["chat-timeline"].frame)"
            attach(app, "Composer above keyboard (\(Int(gap)) pt)")
            // Close the keyboard via a deep pull (see the edge test).
            let keyboardTopCenter = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            keyboardTopCenter.withOffset(CGVector(dx: 0, dy: -260)).press(
                forDuration: 0.1,
                thenDragTo: keyboardTopCenter.withOffset(CGVector(dx: 0, dy: 250)),
                withVelocity: .slow,
                thenHoldForDuration: 0.2
            )
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
            Thread.sleep(forTimeInterval: 0.8)
            return gap
        }

        // Reference at the end of the chat.
        let gapAtBottom = gapWithKeyboardOpen()
        XCTAssertGreaterThanOrEqual(gapAtBottom, -1, "Already at the end of the chat the field lies behind the keyboard")

        let referenceGeometry = lastGeometry
        for round in 1...4 {
            for _ in 0..<round { timeline.swipeDown(velocity: .fast) }
            let gap = gapWithKeyboardOpen()
            XCTAssertEqual(
                gap,
                gapAtBottom,
                accuracy: 2,
                """
                Round \(round): scrolled up, the input field sits differently to the keyboard than at the end of the chat
                now:       \(lastGeometry)
                Reference: \(referenceGeometry)
                """
            )
        }
    }

    /// Diagnostic, not a regression test: replays "scrolled up → open keyboard" and has the app
    /// (DEBUG build + CBASE_KEYBOARD_TRACE) write every movement of the history frame by frame
    /// as CSV. The file is evaluated outside; skipped without a set path
    /// (TEST_RUNNER_CBASE_KEYBOARD_TRACE passed to xcodebuild).
    func testKeyboardOpenTraceWhileScrolledUp() throws {
        guard let tracePath = ProcessInfo.processInfo.environment["CBASE_KEYBOARD_TRACE"] else {
            throw XCTSkip("Hand diagnostics only: set TEST_RUNNER_CBASE_KEYBOARD_TRACE.")
        }
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 100))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server, environment: ["CBASE_KEYBOARD_TRACE": tracePath])
        try openFirstChat(app)
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 100"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 2)

        // Scroll into the history — the reader does NOT stand at the end of the chat.
        timeline.swipeDown(velocity: .fast)
        timeline.swipeDown(velocity: .fast)
        Thread.sleep(forTimeInterval: 1.5)

        app.descendants(matching: .any)["chat-composer"].tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        // Let the recording die down (notification + trailing period).
        Thread.sleep(forTimeInterval: 2.5)

        // Retract the keyboard again via a deep pull — the CLOSE lands in the trace too. The drag
        // phase scrolls the history along (finger on the scroll view); for the evaluation the
        // segment from the release on counts (willChangeFrame of the closing).
        let keyboardTopCenter = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        keyboardTopCenter.withOffset(CGVector(dx: 0, dy: -260)).press(
            forDuration: 0.1,
            thenDragTo: keyboardTopCenter.withOffset(CGVector(dx: 0, dy: 250)),
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: tracePath),
            "No trace file created — is a release build without DEBUG running?"
        )
    }

    /// When the keyboard extends, the history should STAY PUT — one keeps reading where one was.
    /// Only at the end of the chat does it move up along, otherwise the newest message would lie
    /// behind the keyboard. Both are measured here on the same message.
    func testTimelineStaysPutWhenKeyboardOpensAgainstFixture() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 100))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let timeline = app.descendants(matching: .any)["chat-timeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 20))
        let newest = app.staticTexts["Verlauf Antwort 100"]
        XCTAssertTrue(newest.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 2)

        // ── At the end of the chat: the newest message keeps its distance to the COMPOSER, so
        // it moves up along. Measured at the input field itself: the frame of the UIKit list is
        // fixed by construction (the keyboard moves into its upper indent) — its bottom edge no
        // longer serves as an approximation of the composer's top edge.
        let composerField = app.descendants(matching: .any)["chat-composer"]
        let composerMarginPrior = composerField.frame.minY
        let gapPrior = composerMarginPrior - app.staticTexts["Verlauf Antwort 100"].frame.maxY
        composerField.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        // Query afresh: a reused element returns its old snapshot.
        let composerMarginAfter = app.descendants(matching: .any)["chat-composer"].frame.minY
        XCTAssertLessThan(
            composerMarginAfter,
            composerMarginPrior - 100,
            "The composer must have moved above the keyboard"
        )
        let gapAfter = composerMarginAfter - app.staticTexts["Verlauf Antwort 100"].frame.maxY
        XCTAssertEqual(
            gapAfter,
            gapPrior,
            accuracy: 3,
            "At the end of the chat the newest message must move up with the composer"
        )

        // Close the keyboard and scroll into the history.
        let keyboardTopCenter = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        keyboardTopCenter.withOffset(CGVector(dx: 0, dy: -260)).press(
            forDuration: 0.1,
            thenDragTo: keyboardTopCenter.withOffset(CGVector(dx: 0, dy: 250)),
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))
        timeline.swipeDown(velocity: .fast)
        timeline.swipeDown(velocity: .fast)
        Thread.sleep(forTimeInterval: 1.5)

        // ── Scrolled up: a message in the UPPER part of the window (it stays visible even with
        // the keyboard) must not move.
        let visible = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Verlauf Antwort"))
            .allElementsBoundByIndex
            .filter { $0.isHittable && $0.frame.midY < timeline.frame.midY }
        guard let anchor = visible.first else {
            XCTFail("No message found in the upper part of the history")
            return
        }
        let anchorText = anchor.label
        let anchorPrior = anchor.frame.minY
        app.descendants(matching: .any)["chat-composer"].tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        let anchorAfter = app.staticTexts[anchorText].frame.minY
        attach(app, "History stands still when the keyboard extends")
        XCTAssertEqual(
            anchorAfter,
            anchorPrior,
            accuracy: 4,
            "\"\(anchorText)\" moved when the keyboard extended (\(anchorPrior) → \(anchorAfter))"
        )
        // Earlier bug: the keyboard pulled a scrolled-up chat back to the end.
        XCTAssertFalse(
            app.staticTexts["Verlauf Antwort 100"].isHittable,
            "The keyboard must not pull a chat read further up to the end"
        )
    }

    /// Diagnostic run for video recordings (no regression test): open the keyboard, wait briefly,
    /// then slowly drag into the keyboard and hold. The pauses separate the phases in the
    /// recording. Runs only with CBASE_KEYBOARD_PROBE=1.
    func testKeyboardMotionRecordingProbe() throws {
        guard ProcessInfo.processInfo.environment["CBASE_KEYBOARD_PROBE"] == "1" else {
            throw XCTSkip("For video diagnostics only (CBASE_KEYBOARD_PROBE=1).")
        }
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 40, stress: true))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let newest = app.staticTexts["Infrastruktur Abschluss 40"]
        XCTAssertTrue(newest.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 2)

        // Phase 1: open the keyboard (the recording shows whether the chat rides along or jumps).
        let composer = app.descendants(matching: .any)["chat-composer"]
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 2.5)

        // Phase 2: slowly drag from the history into the keyboard and hold there — shows whether
        // the keyboard follows the finger or retracts fully at once.
        let keyboardTopCenter = keyboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
        let start = keyboardTopCenter.withOffset(CGVector(dx: 0, dy: -170))
        let mid = keyboardTopCenter.withOffset(CGVector(dx: 0, dy: 130))
        start.press(forDuration: 0.1, thenDragTo: mid, withVelocity: .slow, thenHoldForDuration: 1.5)
        Thread.sleep(forTimeInterval: 2.5)
    }
}
