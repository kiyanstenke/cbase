// Reconciliation on opening and after returning to the app ("a new message is in the chat, I open it, and either the message is
// missing or the chat is not scrolled all the way down"). A class of its own: `ChatStageUITests` and `ChatRowsUITests` are close to
// the 2,000-line guard. Proves `Chat/ChatViewModel+Reconcile.swift` against the fixture, which imitates the server seam (`connected`
// with `lastId`/`total`, `GET …/log/delta`, event `row`, attachment with `w`/`h`; switches `/fixture/gap`, `/fixture/row`,
// `/fixture/run-stream`, `/fixture/image`, state `/fixture/reconcile` — test-fixtures/chat-gateway/README.md).
//
// Counter-test map (which sabotage turns which test red):
// - the first `connected` never reconciles                           → testMessageFromTheGapStandsAfterTheOpen
// - reloading replaces the open bubble, deltas attach to a new one   → testReturnMidTurnKeepsTheBeginningOfTheResponse
// - no handler for the `row` event                                   → testRowFromTheStreamStandsExactlyOnce
// - the image tile starts at 90 pt and grows to the image height     → testImageAttachmentWithDimensionsGrowsNotAfter
// - no full reconcile when the open bubble does not fit the buffer   → testFollowUpTurnInTheGapDoesNotAttachToTheOldBubble
// - truncated buffer patched without a marker                        → testTruncatedBufferSaysAtPatchThatOneChunkIsMissing
// - stream error line stays after a successful reconnect             → testErrorOfTheStreamDisappearsAfterTheReconnect
// - error line written before `finishAssistant`                      → testRunWithErrorClosesTheResponseBeforeTheErrorLine
// - pause resets on `connected`                                      → testFlappingStreamConnectsWithGrowingPause
// The error-line test must make the fixture answer 503: `URLSession` reports a merely aborted SSE stream as a clean end.
import XCTest

final class ChatReconcileUITests: CbaseUITestBase {
    private static let gapsText = "Message from the gap"
    private static let hintText = "Notice from the stream"

    private func reconcile(_ server: String) -> [String: Any] {
        fixtureJSON(server + "/fixture/reconcile") ?? [:]
    }

    private func textsWith(_ app: XCUIApplication, _ part: String) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", part))
    }

    private func textsWith(_ app: XCUIApplication, _ part: String, and second: String) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", part, second))
    }

    private func labels(_ app: XCUIApplication, _ part: String) -> [String] {
        textsWith(app, part).allElementsBoundByIndex.map(\.label)
    }

    /// Starts the app with three history rows and the stream run `run` (`/fixture/run-stream`), opens the chat and sends
    /// "Stream please".
    private func openWithStreamRun(_ server: String, _ run: [String: Any]) throws -> XCUIApplication {
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
            XCTAssertEqual(self.fixturePost(server + "/fixture/run-stream", body: run)?["on"] as? Bool, true,
                           "The fixture did not accept the stream run")
        })
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 3"].waitForExistence(timeout: 25), "The history did not arrive")
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "The composer is missing")
        composer.tap()
        composer.typeText("Stream please")
        app.buttons["chat-send"].tap()
        return app
    }

    /// The stream dies without the app noticing (`/fixture/stream-silent`) until `condition` holds at the fixture; then it is ended
    /// cleanly and the app reconnects (`connected` ⇒ `reconcileHistory`).
    private func streamGap(_ server: String, until: String, _ condition: @escaping () -> Bool) {
        let silent = fixturePost(server + "/fixture/stream-silent", body: ["on": true])?["silent"] as? Int ?? 0
        XCTAssertGreaterThanOrEqual(silent, 1, "No open stream to silence")
        XCTAssertTrue(waitForFixture(timeout: 25, until: condition), "The fixture did not get there in the gap: \(until)")
        XCTAssertNotNil(fixturePost(server + "/fixture/stream-silent", body: ["close": true]))
    }

    private func streamConnected(_ app: XCUIApplication, _ server: String) {
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 3"].waitForExistence(timeout: 25), "The history did not arrive")
        XCTAssertTrue(waitForFixture(timeout: 10) { (self.reconcile(server)["streams"] as? Int ?? 0) >= 1 },
                      "The app is not listening to the chat's stream")
    }

    /// A message stored between loading the history and the first `connected` stands there after opening —
    /// exactly once. The app must connect the stream BEFORE the history load completes, or the first `connected` never reconciles
    /// and the message is missing until the next opening. The fixture stores the row RIGHT AFTER the first `GET …/log` of the main
    /// chat and sends its event only to streams that are already open then — so it must arrive via the stream (open before the
    /// history) or via `lastId`/`total` (open after), depending on the order.
    func testMessageFromTheGapStandsAfterTheOpen() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
        })
        // AFTER the start: the overview loads no history — the first `GET …/log` of the main chat is the one on opening.
        XCTAssertEqual(fixturePost(server + "/fixture/gap", body: ["text": Self.gapsText])?["on"] as? Bool, true,
                       "The fixture did not accept the gap")
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 3"].waitForExistence(timeout: 25), "The history did not arrive")
        XCTAssertTrue(waitForFixture(timeout: 10) { (self.reconcile(server)["addenda"] as? Int) == 1 },
                      "The fixture did not store the gap's row — the history was never loaded")
        let message = app.staticTexts[Self.gapsText]
        XCTAssertTrue(message.waitForExistence(timeout: 15),
                      "The message from the gap is missing after opening — the first `connected` did not reconcile")
        XCTAssertTrue(waitForFixture(timeout: 3) { self.textsWith(app, Self.gapsText).count == 1 },
                      "The message from the gap appears \(textsWith(app, Self.gapsText).count) times")
        attach(app, "Message from the gap")
    }

    /// A `hint` row written outside the turn arrives as event `row` and stands in the open chat at once — exactly once:
    /// a second event for the same row (id not above the own state) is ignored, and after returning from the background the
    /// reconcile brings it from the history, not once more.
    func testRowFromTheStreamStandsExactlyOnce() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
        })
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 3"].waitForExistence(timeout: 25), "The history did not arrive")
        XCTAssertTrue(waitForFixture(timeout: 10) { (self.reconcile(server)["streams"] as? Int ?? 0) >= 1 },
                      "The app is not listening to the chat's stream")
        XCTAssertNotNil(fixturePost(server + "/fixture/row", body: ["text": Self.hintText]),
                        "The fixture did not accept the row")
        XCTAssertTrue(app.staticTexts[Self.hintText].waitForExistence(timeout: 10),
                      "The notice from the stream does not appear in the open chat")
        attach(app, "Notice from the stream")

        // The same row once more — its id is no longer above the own state.
        XCTAssertNotNil(fixturePost(server + "/fixture/row", body: ["retry": true]))
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(textsWith(app, Self.hintText).count, 1, "A repeated event attached the notice a second time")

        // Return from the background: the new stream reconciles (the notice lies above the loaded history ⇒ delta) — afterwards
        // it stands there from the database, still once.
        let deltaPrior = reconcile(server)["deltaRetrievals"] as? Int ?? 0
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        XCTAssertTrue(waitForFixture(timeout: 15) { (self.reconcile(server)["deltaRetrievals"] as? Int ?? 0) > deltaPrior },
                      "After the return the new stream did not reconcile (no `GET …/log/delta`)")
        XCTAssertTrue(app.staticTexts[Self.hintText].waitForExistence(timeout: 10), "The notice is missing after the reconcile")
        XCTAssertTrue(waitForFixture(timeout: 3) { self.textsWith(app, Self.hintText).count == 1 },
                      "After the reconcile the notice appears \(textsWith(app, Self.hintText).count) times")
    }

    /// Back from the background while a turn streams — the open response keeps its beginning, keeps growing in the SAME bubble
    /// and stands there exactly once and complete at the end of the run. Returning to `.active` must not reload and replace the
    /// open bubble (its text is not stored yet), or the following deltas open a new one without a beginning; and because the chat
    /// was opened BEFORE the run, the end of the run does not reload anything either.
    func testReturnMidTurnKeepsTheBeginningOfTheResponse() throws {
        let server = try requireFixture()
        let parts = (1...20).map { String(format: "Stream-part-%02d ", $0) }
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
            XCTAssertEqual(self.fixturePost(server + "/fixture/run-stream", body: ["parts": parts, "gapMs": 800])?["on"] as? Bool,
                           true, "The fixture did not accept the stream run")
        })
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["Verlauf Antwort 3"].waitForExistence(timeout: 25), "The history did not arrive")
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "The composer is missing")
        composer.tap()
        composer.typeText("Stream please")
        app.buttons["chat-send"].tap()

        let response = textsWith(app, "Stream-part-01").firstMatch
        XCTAssertTrue(response.waitForExistence(timeout: 15), "The stream run did not arrive")
        XCTAssertTrue(waitForFixture(timeout: 10) { response.exists && response.label.contains("Stream-part-03") },
                      "The response did not grow before switching away")
        attach(app, "Before switching away")

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()

        // Beginning AND a later piece in ONE text: the bubble stayed, and the deltas attach to it.
        let resumed = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@", "Stream-part-01", "Stream-part-14"
        )).firstMatch
        XCTAssertTrue(resumed.waitForExistence(timeout: 20),
                      "After the return the beginning of the running response is missing: \(textsWith(app, "Stream-part").allElementsBoundByIndex.map(\.label))")
        attach(app, "After the return")

        XCTAssertTrue(waitForFixture(timeout: 30) { (self.reconcile(server)["running"] as? Bool) == false }, "The stream run did not end")
        let complete = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@", "Stream-part-01", "Stream-part-20"
        )).firstMatch
        XCTAssertTrue(complete.waitForExistence(timeout: 15),
                      "At the end of the run the response is not complete: \(textsWith(app, "Stream-part").allElementsBoundByIndex.map(\.label))")
        XCTAssertTrue(waitForFixture(timeout: 5) { self.textsWith(app, "Stream-part-01").count == 1 },
                      "The beginning of the response appears \(textsWith(app, "Stream-part-01").count) times")
        attach(app, "At the end of the run")
    }

    /// A turn ends in the stream gap and a follow-up turn runs (graph workflow, goal, queue). At `connected` the bubble of the FIRST
    /// is still open while the server buffer carries the text of the SECOND. Deltas of the follow-up turn must not attach to the
    /// old bubble ("Old-part-02 New-part-03 …") and its user row and the end of the first must not be missing until its run ends:
    /// the reconcile is full — history up to `lastId`, the buffer below it.
    func testFollowUpTurnInTheGapDoesNotAttachToTheOldBubble() throws {
        let server = try requireFixture()
        let followUpText = "Follow-up message from the gap"
        let old = (1...8).map { String(format: "Old-part-%02d ", $0) }
        let fresh = (1...20).map { String(format: "New-part-%02d ", $0) }
        let app = try openWithStreamRun(server, ["parts": old, "gapMs": 600, "followUp": ["text": followUpText, "parts": fresh]])
        XCTAssertTrue(textsWith(app, "Old-part-02").firstMatch.waitForExistence(timeout: 15), "The first turn did not arrive")
        streamGap(server, until: "the follow-up turn streams") {
            (self.reconcile(server)["streamText"] as? String ?? "").contains("New-part-02")
        }

        XCTAssertTrue(app.staticTexts[followUpText].waitForExistence(timeout: 10),
                      "The follow-up turn's user row is missing after the reconnect (no reconcile with an open bubble)")
        XCTAssertTrue(textsWith(app, "Old-part-01", and: "Old-part-08").firstMatch.waitForExistence(timeout: 10),
                      "The first turn's response is not complete: \(labels(app, "part-"))")
        XCTAssertTrue(textsWith(app, "New-part-01", and: "New-part-05").firstMatch.waitForExistence(timeout: 10),
                      "The follow-up turn does not grow in a bubble of its own: \(labels(app, "part-"))")
        XCTAssertEqual(textsWith(app, "Old-part", and: "New-part").count, 0,
                       "The follow-up turn's deltas attach to the first one's bubble: \(labels(app, "part-"))")
        // Otherwise the end of the run (`joinedMidRun` loads the history) would have hidden the defect — the test would prove nothing.
        XCTAssertEqual(reconcile(server)["running"] as? Bool, true, "The follow-up turn had already ended — the check came too late")
        attach(app, "Follow-up turn after the gap")
    }

    /// The server buffer is truncated (`streamTextTruncated`, stopped at 200,000 characters) and the open bubble is patched — then
    /// what was written beyond the cap is missing between it and the next delta. The marker must say so (as when opening mid-run);
    /// the deltas must not continue silently. The fixture caps at 75 characters (five parts of 15), the gap reaches to the eighth.
    func testTruncatedBufferSaysAtPatchThatOneChunkIsMissing() throws {
        let server = try requireFixture()
        let parts = (1...20).map { String(format: "Cap-part-%02d ", $0) }
        let app = try openWithStreamRun(server, ["parts": parts, "gapMs": 600, "cap": 75])
        XCTAssertTrue(textsWith(app, "Cap-part-02").firstMatch.waitForExistence(timeout: 15), "The run did not arrive")
        streamGap(server, until: "part 8 is written beyond the cap") {
            (self.reconcile(server)["streamTextFull"] as? String ?? "").contains("Cap-part-08")
        }

        XCTAssertTrue(textsWith(app, "Cap-part-01", and: "Cap-part-05").firstMatch.waitForExistence(timeout: 10),
                      "The bubble was not patched up to the cap: \(labels(app, "Cap-part"))")
        XCTAssertTrue(textsWith(app, "a piece is missing here").firstMatch.waitForExistence(timeout: 5),
                      "The marker is missing behind the truncated buffer — the deltas continue silently: \(labels(app, "Cap-part"))")
        XCTAssertEqual(reconcile(server)["running"] as? Bool, true, "The run had already ended — the check came too late")
        attach(app, "Truncated buffer patched")
    }

    /// When the stream fails (here: the gateway answers 503 while it replaces the container), the error line stands — and after a
    /// successful reconnect (the reconcile fetches everything) it must go away again. Only `loadHistory` used to clear the error,
    /// and it does not run on a reconnect: the red line stayed until one left the chat. (A merely aborted stream sets no error —
    /// `URLSession` reports it as a clean end — so the test must provoke the 503.)
    func testErrorOfTheStreamDisappearsAfterTheReconnect() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
        })
        try openFirstChat(app)
        streamConnected(app, server)
        let prior = reconcile(server)["connections"] as? Int ?? 0
        let abort = fixturePost(server + "/fixture/stream-abort", body: ["failedAttempts": 1])
        XCTAssertGreaterThanOrEqual(abort?["ended"] as? Int ?? 0, 1, "The fixture ended no stream")
        XCTAssertTrue(waitForFixture(timeout: 15) { (self.reconcile(server)["failedResponses"] as? Int ?? 0) >= 1 },
                      "The app did not reconnect after the end — the 503 never came")
        XCTAssertTrue(waitForFixture(timeout: 15) { (self.reconcile(server)["connections"] as? Int ?? 0) > prior },
                      "The app did not reconnect after the 503")
        let error = app.staticTexts.matching(identifier: "chat-error").firstMatch
        XCTAssertTrue(waitUntilGone(error, timeout: 6),
                      "The stream's error line is still there after the successful reconnect: \(error.exists ? error.label : "")")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertFalse(error.exists, "The error line came back")
        attach(app, "After the reconnect")
    }

    /// A run aborts mid response text with `run_error`; the chat was connected from the start. The response is then DONE —
    /// with the bar (copy) below it, which only a no-longer-running response carries. The response must close BEFORE the error
    /// line is written: `finishAssistant` would otherwise see the error line as the last row and leave the response `streaming`.
    func testRunWithErrorClosesTheResponseBeforeTheErrorLine() throws {
        let server = try requireFixture()
        let parts = (1...4).map { String(format: "Error-part-%02d ", $0) }
        let app = try openWithStreamRun(server, ["parts": parts, "gapMs": 500, "error": "Abort in the fixture"])
        let errorRow = textsWith(app, "Abort in the fixture").firstMatch
        XCTAssertTrue(errorRow.waitForExistence(timeout: 15), "The run's error line is missing")
        let response = textsWith(app, "Error-part-01", and: "Error-part-04").firstMatch
        XCTAssertTrue(response.waitForExistence(timeout: 5), "The response is not complete")
        let barInBetween = waitForFixture(timeout: 5) {
            app.buttons.matching(identifier: "chat-message-copy").allElementsBoundByIndex.contains { button in
                button.frame.minY >= response.frame.maxY - 2 && button.frame.maxY <= errorRow.frame.minY + 2
            }
        }
        attach(app, "Run with error")
        XCTAssertTrue(barInBetween, "The bar (copy) is missing between response and error line — the response stayed `streaming`")
    }

    /// A stream that is accepted and breaks off again at once (gateway replaces the container, backend dies while writing)
    /// reconnects with a GROWING pause (0.5 · 1 · 2 · 4 s …). The pause must not fall back at `connected`: that would mean a new
    /// connection with reconcile and five fetches every 0.5 s, and after a clean end no pause at all. The fixture ends every
    /// connection at once — alternating 50 ms after `connected` and as a 503 (error path).
    func testFlappingStreamConnectsWithGrowingPause() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
        })
        try openFirstChat(app)
        streamConnected(app, server)
        XCTAssertEqual(fixturePost(server + "/fixture/stream-flapping", body: ["on": true])?["on"] as? Bool, true)
        // The open stream still holds — end it so that every further connection goes through the flapping path.
        _ = fixturePost(server + "/fixture/stream-abort", body: [:])
        let times: () -> [Double] = {
            (self.reconcile(server)["flapTimes"] as? [NSNumber])?.map(\.doubleValue) ?? []
        }
        // Four connections: with a growing pause ≈ 1 + 2 + 4 s apart, with a fixed one ≈ 0.1 + 0.6 + 0.1 s.
        XCTAssertTrue(waitForFixture(timeout: 30) { times().count >= 4 }, "The app did not reconnect: \(times())")
        let t = times()
        let gaps = zip(t.dropFirst(), t).map { $0 - $1 }
        _ = fixturePost(server + "/fixture/stream-flapping", body: ["on": false])
        attach(app, "Flapping stream")
        XCTAssertGreaterThanOrEqual(gaps[2], 2_000,
                                    "The pause does not grow (\(gaps) ms) — a stream that breaks off at once reconnects endlessly")
        XCTAssertGreaterThan(gaps[2], gaps[0] * 1.5, "The pause does not grow: \(gaps) ms")
    }

    /// An image attachment with `w`/`h` has its height BEFORE it is loaded — the last row does not grow when the image arrives.
    /// Measured at the row ABOVE: the list is inverted, the newest row stands fixed at the bottom, and when it grows it pushes
    /// everything above it up by exactly its growth. (The tile used to stand at 90 pt until loaded and then took the image height.)
    func testImageAttachmentWithDimensionsGrowsNotAfter() throws {
        let server = try requireFixture()
        let imageText = "Here is the screenshot"
        let app = launchApp(server: server, preparation: {
            XCTAssertTrue(self.setFixtureHistory(server, count: 3), "The fixture did not accept the history")
            // 640 × 960 (2:3) — the tile is thus clearly higher than the old 90 pt, and the image only arrives after 5 s.
            XCTAssertEqual(self.fixturePost(server + "/fixture/image", body: [
                "w": 640, "h": 960, "delayMs": 5_000, "text": imageText,
            ])?["on"] as? Bool, true, "The fixture did not accept the image")
        })
        try openFirstChat(app)
        let above = app.staticTexts["Verlauf Antwort 3"]
        let row = app.staticTexts[imageText]
        XCTAssertTrue(above.waitForExistence(timeout: 25), "The history did not arrive")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The image row is missing")
        XCTAssertTrue(waitForFixture(timeout: 10) { (self.fixtureJSON(server + "/fixture/image")?["retrieved"] as? Int ?? 0) >= 1 },
                      "The app never loaded the image")
        // The position while the placeholder stands — measure only once it rests (the history slides in on opening).
        var prior = above.frame.minY
        _ = waitForFixture(timeout: 3) {
            let now = above.frame.minY
            defer { prior = now }
            return abs(now - prior) < 0.5
        }
        XCTAssertEqual(fixtureJSON(server + "/fixture/image")?["supplied"] as? Int, 0,
                       "The image arrived before the position with placeholder was measured — the delay is not enough")
        attach(app, "Placeholder")

        XCTAssertTrue(waitForFixture(timeout: 15) { (self.fixtureJSON(server + "/fixture/image")?["supplied"] as? Int ?? 0) >= 1 },
                      "The fixture did not deliver the image")
        Thread.sleep(forTimeInterval: 2)
        let after = above.frame.minY
        attach(app, "Image loaded")
        XCTAssertEqual(after, prior, accuracy: 2,
                       "The row above the image jumped by \(Int(prior - after)) pt when the image arrived — the tile grew afterwards")

    }
}
