import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest

final class ChatComposerUITests: CbaseUITestBase {
    // ── The composer is a free-standing island ───────────────────────────────
    /// It is meant to lie like a rounded island above the keyboard without touching it:
    /// air on both sides, air below. It used to be a borderless bar that
    /// stuck flush to the keyboard edge.
    func testComposerIsARoundedIslandAboveTheKeyboard() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 8))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))

        let hits = app.descendants(matching: .any).matching(identifier: "composer-island")
        XCTAssertTrue(hits.firstMatch.waitForExistence(timeout: 10), "The composer island is missing")
        let island = hits.allElementsBoundByIndex
            .max(by: { $0.frame.height < $1.frame.height }) ?? hits.firstMatch

        // Air at the sides — the island does not run to the screen edge. The same 9 pt
        // lie below it too; the number here is the exact anchor of the design.
        XCTAssertEqual(island.frame.minX, 9, accuracy: 2, "The air beside the island is missing on the left")
        XCTAssertEqual(
            app.frame.maxX - island.frame.maxX, 9, accuracy: 2,
            "The air beside the island is missing on the right"
        )

        // And with the keyboard open: the island does not touch it.
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        let islandNow = app.descendants(matching: .any).matching(identifier: "composer-island")
            .allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })
        // Caution when reading the number: XCUITest's `keyboards` element starts about
        // 44 pt BELOW the real keyboard edge (measured: the notification reports 539, the
        // element 583). The real distance is thus a good 44 pt smaller than measured here —
        // namely the 9 pt inner air of the island. So all that is checked is: no overlap and
        // no torn-open hole.
        let clearance = app.keyboards.firstMatch.frame.minY - (islandNow?.frame.maxY ?? 0)
        XCTAssertGreaterThan(clearance, 0, "The island lies behind the keyboard (\(clearance) pt)")
        XCTAssertLessThan(clearance, 80, "Too much gap between island and keyboard (\(clearance) pt)")
        attach(app, "Composer as an island above the keyboard")
    }

    // ── Chat: no compact button above the keyboard any more ──────────────────
    func testChatComposerHasNoCompactButton() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20))
        XCTAssertFalse(
            app.buttons["Compact context"].exists,
            "The compact button must no longer sit at the bottom right of the chat"
        )
        XCTAssertTrue(app.buttons["chat-menu"].exists, "The function stays reachable in the chat menu")
    }

    /// The docked composer strips: queued messages, the set
    /// goal and the background chips lie as surfaces of their own ABOVE the input field and pushed a
    /// bit below it. At most two messages stand, the rest behind "+n more";
    /// "Steer" hangs only on the topmost strip, aborts the run and sends everything together.
    func testComposerStripStackItselfOverTheIsland() throws {
        let server = try requireFixture()
        // A long run: only then is there time to queue and check three messages.
        // The switch is set BETWEEN `/fixture/reset-run` and the start:
        // `reset-run` takes the run switches back, and
        // `launchApp` calls it first — set before, it would be gone when sending.
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
        XCTAssertTrue(
            app.buttons["Stop answering"].waitForExistence(timeout: 15),
            "The run must stand, or nothing queues"
        )

        for text in ["Queued one", "Queued two", "Queued three"] {
            composer.tap()
            composer.typeText(text)
            let enqueue = app.buttons["Queue message"]
            XCTAssertTrue(enqueue.waitForExistence(timeout: 5), "While typing, the button must switch to queueing")
            enqueue.tap()
        }

        // ── Cap ─────────────────────────────────────────────────────────────────────────
        let more = app.buttons["composer-strip-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 15), "Of three messages two must stand and one behind '+1 more'")
        XCTAssertEqual(
            app.buttons.matching(identifier: "composer-dismiss").count, 2,
            "At most two message strips are visible"
        )
        XCTAssertTrue(app.staticTexts["Queued one"].exists, "The OLDEST are visible — they are next")
        XCTAssertFalse(app.staticTexts["Queued three"].exists, "The third belongs behind '+1 more'")

        // ── Steer only on the topmost strip, with a count ──────────────────────────────
        let control = app.buttons.matching(identifier: "composer-control")
        XCTAssertEqual(control.count, 1, "'Steer' hangs only on the topmost strip")
        XCTAssertTrue(
            control.firstMatch.label.contains("3"),
            "'Steer' must name how many messages go along — label: \(control.firstMatch.label)"
        )

        // ── Position: above the island, with the last strip pushed below it ────────────
        //
        // MEASURED against the INPUT FIELD, not against `composer-island`. The island carries
        // `.accessibilityElement(children: .contain)`, and XCUITest reports the union
        // for such a container — measured as `island=(9, 332, 384, 198)`,
        // while the island visibly starts only at ~452: the strips above it are included in the
        // number. Checked against that top edge EVERY strip seemingly stands "in" the
        // island, and the check would be an empty claim.
        let island = app.descendants(matching: .any).matching(identifier: "composer-island").firstMatch
        XCTAssertTrue(island.exists, "The composer island is missing")
        // The stack carries an identifier of its own — only so is its SURFACE
        // measurable, and only that pushes under the island. The rows in it stay individually
        // addressable, because the identifier hangs with `children: .contain`.
        let stack = app.descendants(matching: .any).matching(identifier: "composer-strip").firstMatch
        XCTAssertTrue(stack.exists, "The strip stack is missing")
        let situation = "control=\(control.firstMatch.frame) field=\(composer.frame) more=\(more.frame) stack=\(stack.frame)"
        print("CBASE-MASS stapel \(situation)")
        XCTAssertLessThan(
            control.firstMatch.frame.maxY, composer.frame.minY,
            "The message strips stand ABOVE the input field — \(situation)"
        )
        // ── Docked: the SURFACE lies under the island … ────────────────────────────────
        //
        // Measured against the INPUT FIELD, not against `composer-island`: the island carries
        // `.accessibilityElement(children: .contain)`, and XCUITest reported
        // `island=(9, 332, 384, 198)` for it while it visibly starts only at
        // ~452 — the strips above it are in the number. Checked against that top edge
        // EVERY strip would seemingly stand "in" the island.
        //
        // The stack's surface ends `stripDeep` (16 pt) below its last row —
        // measured (iPhone 17): stack bottom edge 466.7, content of the last row
        // 443.7, so 23 (16 plus the row padding of 7). Without the docking the
        // bottom edge would lie right at the content.
        XCTAssertGreaterThan(
            stack.frame.maxY - more.frame.maxY, 18,
            "The stack's surface reaches beyond its content under the island — \(situation)"
        )
        // ── … but the CONTENT does not ─────────────────────────────────────────────────
        //
        // The reported defect: the island edge cut the lowest row horizontally, one
        // read half the height of "Test" and "Steer". The cause was the missing counterpart of
        // `cb-strip-last` on the web — the last row now carries `stripDeep` as
        // bottom padding.
        //
        // The bound is TWO-SIDED, and each side has its own counter-test (measured on
        // iPhone 17: 27.0 pt between the content of the last row and the field):
        //   • without the padding on the last row it is 13 — the lower bound fails,
        //     and exactly this picture was reported;
        //   • without the negative bottom margin on the stack (`-stripDeep`) the island moves
        //     down by 16 pt, so 43 — the upper bound fails, and the stack would stand
        //     beside the island instead of behind it.
        let clearance = composer.frame.minY - more.frame.maxY
        XCTAssertGreaterThan(
            clearance, 20,
            "The CONTENT of the lowest row must stay above the covered zone — \(clearance) pt — \(situation)"
        )
        XCTAssertLessThan(
            clearance, 35,
            "The stack is pushed under the island, not placed beside it — \(clearance) pt — \(situation)"
        )
        // ── Narrower than the island ───────────────────────────────────────────────────
        //
        // "Peeking out from behind the input field" means indented at the sides (web:
        // `--strip-inset`). Equally wide, the stack read as a second card above the
        // composer. The island stands at x=`islandInset` (9), the stack
        // at 9+33=42 (the inset is the island
        // radius, see `ChatComposer.stripInset`); at 9+12=21 it was still narrower. The threshold 15 lies
        // in between. This can NOT be measured against the field: it starts at x=73, behind
        // the attachment button.
        XCTAssertGreaterThan(
            stack.frame.minX, 15,
            "The stack stands behind the island at the sides (x=9), not flush with it — \(situation)"
        )
        // ── ONE base, not four chips ───────────────────────────────────────────────────
        //
        // The stack is ONE surface with hairlines between the rows (`CbStrip` +
        // `CbStripRow` + `CbStripSeparator`). What is measured is the joint between the
        // second message row and "+1 more": twice the row padding (7 pt) plus the
        // hairline — the buttons lie INSIDE the padding, so about 15 pt. With separate chips
        // every strip carried material and border and stood 4 pt from the next: 4 pt air plus
        // two more borders, about 19–21 pt. The threshold 17 lies in between — the counter-test
        // against the old state fails at exactly this line.
        let secondRow = app.staticTexts["Queued two"]
        XCTAssertTrue(secondRow.exists, "The second visible message is missing in the stack")
        let dismiss = app.buttons.matching(identifier: "composer-dismiss")
        let secondBottom = max(secondRow.frame.maxY, dismiss.element(boundBy: 1).frame.maxY)
        let joint = more.frame.minY - secondBottom
        print("CBASE-MASS sockel fuge=\(joint) zweite=\(secondRow.frame) verwerfen1=\(dismiss.element(boundBy: 1).frame) more=\(more.frame)")
        XCTAssertLessThan(
            joint, 17,
            "The rows of the base do not touch — between the second message and '+1 more' lie \(joint) pt (expected ~15: 7 + hairline + 7) — \(situation)"
        )
        attach(app, "Composer strips stacked")

        // ── Unfold ─────────────────────────────────────────────────────────────────────
        //
        // Tapping goes via COORDINATES, not with `.tap()`. The stack pushes its
        // surface under the island — XCUITest therefore took the lowest row for not
        // fully visible, tried "scroll to visible" and hung (the run
        // ends at "Scroll element to visible", the runner shoots the app down after 15 s). Its content now
        // lies above the covered zone, the coordinate tap stays anyway: it costs nothing and does not depend on this
        // geometry.
        more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(
            app.staticTexts["Queued three"].waitForExistence(timeout: 5),
            "'+1 more' must unfold in place"
        )
        XCTAssertEqual(
            app.buttons.matching(identifier: "composer-control").count, 1,
            "Even unfolded only the topmost strip carries 'Steer'"
        )

        // ── Steer: abort the run, send everything together ─────────────────────────────
        control.firstMatch.tap()
        XCTAssertTrue(
            app.buttons["composer-dismiss"].firstMatch.waitForNonExistence(timeout: 15),
            "After 'Steer' no message may remain in the queue"
        )
        XCTAssertFalse(more.exists, "And no '+n more' any more either")
    }

    /// Question with a choice card (cbase_ask): the agent
    /// asks a question with recommendations, the run ends, and ONE tap suffices as the answer — it
    /// goes to the server as an ordinary message. Afterwards the card is answered and inert.
    func testChatAskCardAnswersWithOneTap() throws {
        let server = try requireFixture()
        XCTAssertNotNil(
            fixturePost(server + "/fixture/ask", body: ["open": true]),
            "The fixture did not accept the question switch"
        )
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Discuss the plan")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let card = app.descendants(matching: .any).matching(identifier: "ask-card").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The question card is missing")
        let contains: (String) -> XCUIElement = { text in
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        XCTAssertTrue(contains("Monorepo oder getrennte Repos?").exists, "The question is not in the card")
        // The consequence per option is the real gain compared to a text question.
        XCTAssertTrue(contains("Unabhängige Release-Zyklen.").exists, "The option's rationale is missing")
        attach(app, "Question with clickable answers")

        let second = app.buttons.matching(identifier: "ask-option-0-1").firstMatch
        if !scrollUntilHittable(app, second) {
            // The tree in the attachment shows WHY: an identifier on the card frame overrides the
            // identifiers of all children — exactly what this line failed on when first built.
            let dump = XCTAttachment(string: app.debugDescription)
            dump.name = "Accessibility tree"
            dump.lifetime = .keepAlways
            add(dump)
            XCTFail("The second answer option is not tappable (exists=\(second.exists))")
        }
        second.tap()

        // One tap suffices: no confirming, the choice lies with the server.
        var received: [String: Any]?
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/ask"), state["requestId"] as? String == "fixture-ask-1" {
                received = state
                break
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        guard let answers = received?["answers"] as? [[String: Any]], let first = answers.first else {
            attach(app, "The choice did not arrive at the server")
            return XCTFail("The server received no choice: \(String(describing: received))")
        }
        XCTAssertEqual(first["selected"] as? [String], ["Getrennte Repos"])

        // Afterwards the card shows that it is answered — and offers no choice any more.
        XCTAssertTrue(contains("answered").waitForExistence(timeout: 8), "The card stays unanswered")
        XCTAssertFalse(
            app.buttons.matching(identifier: "ask-option-0-1").firstMatch.isEnabled,
            "The answered card is still tappable"
        )
        attach(app, "Question answered")
    }

    // ── Chat: "Photos" in the attach menu really opens the photo picker ──────
    // What is checked is not the photo picker itself (foreign process) but that it COVERS the
    // composer. Without a picker it stays operable — exactly the reported defect,
    // that a tap on "Photos" does nothing.
    // The action panel slides out WITHOUT the input row moving (the composer's hosting frame
    // used to jump to the final height while SwiftUI animated the positions — the input field "rode along").
    // Measured via the in-app probe (CBASE_COMPOSER_TRACE): XCUITest waits for app idle before every
    // frame query of its own and therefore never sees movement DURING an animation itself —
    // the probe records it frame by frame.
    func testAttachPanelKeepsComposerSteady() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, environment: ["CBASE_COMPOSER_TRACE": "1"])
        try openFirstChat(app)

        let attachButton = app.buttons["chat-attach"]
        XCTAssertTrue(attachButton.waitForExistence(timeout: 8), "The attach button is missing")
        let probe = app.otherElements["composer-trace"]
        XCTAssertTrue(probe.waitForExistence(timeout: 8), "The measuring probe is missing (CBASE_COMPOSER_TRACE)")

        // "field=612.0..612.0 host=…" → span of the field's bottom edge in the 4-s window.
        func fieldSpan(_ value: String) -> Double? {
            guard let range = value.range(of: #"field=([\d.]+)\.\.([\d.]+)"#, options: .regularExpression) else { return nil }
            let parts = value[range].dropFirst("field=".count).components(separatedBy: "..")
            guard parts.count == 2, let lo = Double(parts[0]), let hi = Double(parts[1]) else { return nil }
            return hi - lo
        }
        func probeValue() -> String { probe.value as? String ?? "" }

        // Let the chat entry fall out of the stats window, then prove calm.
        Thread.sleep(forTimeInterval: 4.5)
        let calm = probeValue()
        XCTAssertNotNil(fieldSpan(calm), "The probe delivered no measurement: \(calm)")

        attachButton.tap()
        XCTAssertTrue(app.buttons["chat-action-photos"].waitForExistence(timeout: 4), "The panel did not open")
        Thread.sleep(forTimeInterval: 0.8)
        let opened = probeValue()

        attachButton.tap()
        Thread.sleep(forTimeInterval: 0.8)
        let closed = probeValue()

        for (label, value) in [("Calm", calm), ("Open", opened), ("Close", closed)] {
            print("PROBE \(label): \(value)")
            guard let span = fieldSpan(value) else {
                XCTFail("The probe delivered no measurement at \(label): \(value)")
                continue
            }
            XCTAssertLessThanOrEqual(span, 2, "The input row moved at \(label) by \(span) pt (\(value))")
        }

        // The same with the keyboard OPEN — the composer then hangs on the keyboard edge via the constraint,
        // a different code path than at rest.
        let composer = app.textViews["chat-composer"].exists
            ? app.textViews["chat-composer"]
            : app.textFields["chat-composer"]
        composer.tap()
        guard app.keyboards.element.waitForExistence(timeout: 5) else {
            throw XCTSkip("Without a software keyboard in the simulator the keyboard phase cannot be checked")
        }
        Thread.sleep(forTimeInterval: 4.5) // let the keyboard ride fall out of the stats window

        let calmKeyboard = probeValue()
        attachButton.tap()
        Thread.sleep(forTimeInterval: 0.8)
        let openedKeyboard = probeValue()
        attachButton.tap()
        Thread.sleep(forTimeInterval: 0.8)
        let closedKeyboard = probeValue()

        for (label, value) in [
            ("Calm (keyboard)", calmKeyboard),
            ("Open (keyboard)", openedKeyboard),
            ("Close (keyboard)", closedKeyboard),
        ] {
            print("PROBE \(label): \(value)")
            guard let span = fieldSpan(value) else {
                XCTFail("The probe delivered no measurement at \(label): \(value)")
                continue
            }
            XCTAssertLessThanOrEqual(span, 2, "The input row moved at \(label) by \(span) pt (\(value))")
        }
    }

    // that a tap on "Photos" does nothing.
    func testChatAttachMenuOpensThePhotoPicker() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.textViews["chat-composer"].exists
            ? app.textViews["chat-composer"]
            : app.textFields["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "The composer is missing")
        XCTAssertTrue(composer.isHittable, "The composer is not operable before the attach menu")

        // The attachments sit in ONE button; it raises the panel with the entries.
        let attachButton = app.buttons["chat-attach"]
        XCTAssertTrue(attachButton.waitForExistence(timeout: 8), "The attach button is missing")
        attachButton.tap()

        let photos = app.buttons["chat-action-photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 6), "The panel has no 'Photos' entry")
        photos.tap()

        // The photo picker is modal: it lies over the composer.
        let covered = waitForFixture(timeout: 12) { !composer.isHittable }
        XCTAssertTrue(covered, "After 'Photos' no photo picker opens — the composer stays operable")
        attach(app, "Photo picker over the chat")
    }

    /// A run parked at the usage limit: the strip appears with window name and time,
    /// "Try now" sends the attempt to the server, "Cancel" ends the waiting.
    /// The waiting state comes from the fixture (`/fixture/limit-wait`) — a real limit cannot
    /// be brought about.
    func testChatLimitStripRetriesAndCancels() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25),
            "The composer is missing"
        )

        // Set the waiting state: weekly limit, continuation in an hour — and a RUNNING
        // workflow hangs on it (`workflow: true`): the question before
        // cancelling must then say that it ends as failed.
        XCTAssertNotNil(
            fixturePost(server + "/fixture/limit-wait", body: [
                "group": "weekly", "limitText": "Weekly limit", "reason": "reset", "workflow": true,
                "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
            ]),
            "The fixture did not accept the waiting state"
        )

        let strip = app.descendants(matching: .any)["chat-limit-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 12), "The limit strip is missing")
        XCTAssertTrue(app.staticTexts["Weekly limit"].waitForExistence(timeout: 6), "The window is not named")
        // The row in the history must stand too (it survives a later reload).
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-limit-line-wait"].waitForExistence(timeout: 8),
            "The waiting row is missing in the history"
        )
        attach(app, "Chat parked at the usage limit")

        // "Try now" — the server sees the attempt, the history shows the attempt row:
        // `retry`, NOT `resume`: nothing is reset, and the row
        // must say so — it must not read "Limit has reset" over a window at 100 %,
        // and a `retry` must not fall back to "Usage limit reached" in the app, the opposite.
        app.buttons["chat-limit-retry"].tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                ((fixtureJSON(server + "/api/chats/20000000-0000-4000-8000-000000000001/auto-continue")?["wait"]) as? [String: Any])?["attempts"] as? Int == 1
            },
            "The manual attempt did not reach the server"
        )
        // The row's identifier sits on the stack and is inherited by its children — so do NOT
        // search for the heading under the identifier (several hits) but as a text of its own.
        XCTAssertTrue(app.descendants(matching: .any)["chat-limit-line-retry"].waitForExistence(timeout: 8),
                      "The attempt row (`retry`) is missing in the history")
        XCTAssertTrue(statusHeader(app, "Tried again").waitForExistence(timeout: 4),
                      "The attempt row does not carry its own heading — 'Usage limit reached' or 'Limit has reset' would both be wrong")
        XCTAssertFalse(app.descendants(matching: .any)["chat-limit-line-resume"].exists,
                       "'Try now' stands as a reset limit in the history")
        XCTAssertFalse(statusHeader(app, "Limit has reset").exists,
                       "'Try now' claims a reset limit")

        // "Cancel" — first the question (the button discards the parked job,
        // and that must stand there BEFORE the tap), then the strip disappears and the server has
        // no waiting any more. The dialog button via its LABEL, searched in the sheet — the
        // trigger's identifier does not apply there.
        app.buttons["chat-limit-cancel"].tap()
        let waitEnd = app.sheets.buttons["Stop waiting"]
        XCTAssertTrue(waitEnd.waitForExistence(timeout: 8), "The question before cancelling is missing")
        let question = app.sheets.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The waiting task will be discarded.")).firstMatch
        XCTAssertTrue(question.exists, "The question does not say that the job is lost")
        XCTAssertTrue(
            question.label.contains("workflow") && question.label.contains("failed"),
            "The question conceals that the running workflow ends as failed: \(question.label)"
        )
        waitEnd.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                // CAUTION: JSON `null` arrives as NSNull, not as nil — a comparison with nil
                // would always be false.
                let wait = fixtureJSON(server + "/api/chats/20000000-0000-4000-8000-000000000001/auto-continue")?["wait"]
                return wait == nil || wait is NSNull
            },
            "The cancellation did not reach the server"
        )
        XCTAssertTrue(
            waitForFixture(timeout: 8) { !strip.exists },
            "The strip stayed after cancelling"
        )
        XCTAssertNotNil(fixturePost(server + "/fixture/limit-wait", body: ["clear": true]), "Cleanup failed")
    }

    /// Parked by the CREDIT GATE: nothing has failed here — the blocking
    /// window only stands above the marker, and cbase therefore never started. The
    /// strip must say so and show the button "Start anyway (costs
    /// credit)" instead of "Try now": the same way to the server, but a different promise.
    ///
    /// That the two buttons REPLACE each other is expressly checked as well. Side by side
    /// they would be two ways into the same turn, and one would not say that it costs money.
    func testChatLimitStripCreditGateStartsAnyway() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25),
            "The composer is missing"
        )

        // Parked by the gate: `gate: true` is the server's explicit marker — the client
        // deliberately does NOT compare the text of `reason`.
        XCTAssertNotNil(
            fixturePost(server + "/fixture/limit-wait", body: [
                "gate": true, "reason": "credit", "group": "session", "limitText": "5-hour limit",
                "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
            ]),
            "The fixture did not accept the gate waiting state"
        )

        let strip = app.descendants(matching: .any)["chat-limit-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 12), "The limit strip is missing")
        let anyway = app.buttons["chat-limit-anyway"]
        XCTAssertTrue(anyway.waitForExistence(timeout: 8), "The 'Start anyway' button is missing")
        XCTAssertFalse(app.buttons["chat-limit-retry"].exists,
                       "'Try now' stands beside 'Start anyway' — one of the two conceals what it costs")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Credit gate")).firstMatch.exists,
            "The row does not say WHO parked — parked by the gate means that nothing failed"
        )
        attach(app, "Chat: parked by the credit gate")

        // The button takes the same way as "Try now" — checked at the SERVER, not at
        // the view: a button that only changes its own display would look the same.
        anyway.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                ((fixtureJSON(server + "/api/chats/20000000-0000-4000-8000-000000000001/auto-continue")?["wait"]) as? [String: Any])?["attempts"] as? Int == 1
            },
            "'Start anyway' did not reach the server"
        )
        // In the history the decision stands as `gate-free` — a START,
        // no brake, with a heading of its own. If the kind fell back, it would read
        // "Usage limit reached" with a clock above the turn the human has just launched.
        XCTAssertTrue(app.descendants(matching: .any)["chat-limit-line-gate-free"].waitForExistence(timeout: 8),
                      "The 'Started anyway' row (`gate-free`) is missing in the history")
        XCTAssertTrue(statusHeader(app, "Started anyway").waitForExistence(timeout: 4),
                      "The gate-free row does not carry its own heading")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "steht bei 99 %")).firstMatch.exists,
            "The server's sentence (window and percent) is missing beside the heading"
        )
        XCTAssertFalse(statusHeader(app, "Usage limit reached").exists,
                       "'Start anyway' stands as a limit hit in the history — the opposite of the statement")
        attach(app, "Chat: started anyway — the row in the history")
        XCTAssertNotNil(fixturePost(server + "/fixture/limit-wait", body: ["clear": true]), "Cleanup failed")
    }

    /// The strip comes from the server on OPENING, and the gate button carries the approval in its body.
    ///
    /// The two tests above open the chat first and seed the waiting state AFTER — the
    /// strip there always came from the SSE event, and `GET /api/chats/:id/auto-continue`
    /// as the source on reopening was never entered. Here the seed is set BEFORE the app start
    /// (`preparation`, so after `reset-run` but before any stream is open): if the
    /// strip appears, the fetch on opening brought it, nothing else.
    ///
    /// Second promise: the server bypasses the gate ONLY with `{"anyway": true}` — a button that does not send the
    /// field parks at once again. Whether it was sent cannot be seen in the
    /// view, only at the server (`/fixture/settings` → `lastAttemptAnyway`):
    /// "Start anyway" must leave `true`, "Try now" `false`.
    func testChatLimitStripComesAtOpenFromServerAndSendsTheApproval() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/limit-wait", body: [
                    "gate": true, "reason": "credit", "group": "session", "limitText": "5-hour limit",
                    "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
                ]),
                "The fixture did not accept the gate waiting state"
            )
        })
        // No attempt since the seed yet: JSON `null` arrives as NSNull.
        let prior = (fixtureSettings(server)?["creditGate"] as? [String: Any])?["lastAttemptAnyway"]
        XCTAssertTrue(prior == nil || prior is NSNull, "The seed already carries an attempt: \(String(describing: prior))")

        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25),
            "The composer is missing"
        )
        let strip = app.descendants(matching: .any)["chat-limit-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 12), "The limit strip is missing after opening — the fetch on opening does not bring it")
        let anyway = app.buttons["chat-limit-anyway"]
        XCTAssertTrue(anyway.waitForExistence(timeout: 8), "The 'Start anyway' button is missing")
        XCTAssertTrue(anyway.isHittable, "The 'Start anyway' button is not tappable")
        attach(app, "Chat: gate strip from the fetch on opening")

        // "Start anyway" ⇒ the body carries the approval.
        anyway.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureSettings(server)?["creditGate"] as? [String: Any])?["lastAttemptAnyway"] as? Bool == true
            },
            "'Start anyway' sent no approval (`anyway: true`) — the server parked the turn again at once"
        )

        // Reseed to a REAL limit (no gate): the chat is open now, the event carries the
        // new state. "Try now" ⇒ NO approval in the body.
        XCTAssertNotNil(
            fixturePost(server + "/fixture/limit-wait", body: [
                "group": "weekly", "limitText": "Weekly limit", "reason": "reset",
                "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
            ]),
            "The fixture did not accept the limit waiting state"
        )
        let retry = app.buttons["chat-limit-retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 8), "The 'Try now' button is missing")
        XCTAssertFalse(anyway.exists, "'Start anyway' stands at a real limit — the turn would not get through there anyway")
        XCTAssertTrue(retry.isHittable, "The 'Try now' button is not tappable")
        retry.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureSettings(server)?["creditGate"] as? [String: Any])?["lastAttemptAnyway"] as? Bool == false
            },
            "'Try now' sent an approval along — a button that says nothing about credit must not hand it out"
        )
        XCTAssertNotNil(fixturePost(server + "/fixture/limit-wait", body: ["clear": true]), "Cleanup failed")
    }

    /// A message to a PARKED chat: the server queues it BEHIND the parked continuation and answers `parked: true` — no
    /// turn runs, there is no process. On sending, the app sets `busy` and left it at
    /// `queued`; in the parked case the hexagon thus spun for nothing until the reset came
    /// (on the web `busy` dropped on `parked` of the reply). What is measured is what makes `busy` visible: the
    /// composer's stop button ("Stop answering" exists only with `busy`) and the run indicator —
    /// neither may appear while the message stands in the waiting strip.
    func testChatParkedMessageQueuesInWithoutRunDisplay() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        XCTAssertNotNil(
            fixturePost(server + "/fixture/limit-wait", body: [
                "gate": true, "reason": "credit", "group": "session", "limitText": "5-hour limit",
                "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
            ]),
            "The fixture did not accept the gate waiting state"
        )
        XCTAssertTrue(app.descendants(matching: .any)["chat-limit-strip"].waitForExistence(timeout: 12), "The limit strip is missing")

        composer.tap()
        composer.typeText("Behind the continuation")
        let send = app.buttons["chat-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "The send button is missing")
        send.tap()

        // The message stands in the waiting strip (reply: queued + parked) …
        XCTAssertTrue(app.buttons["composer-dismiss"].firstMatch.waitForExistence(timeout: 15),
                      "The message to the parked chat does not stand in the waiting strip")
        // … and NOTHING runs. The stop button is the measurement for `busy`; the deadline is deliberately
        // a WAITING time — with `busy = true` it would stand there at once.
        XCTAssertFalse(app.buttons["Stop answering"].waitForExistence(timeout: 3),
                       "The composer shows 'Stop answering' — the app takes the parked chat for running")
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "chat-run-indicator").firstMatch.exists,
                       "The run indicator spins for a turn that does not exist")
        // And the server has not begun a run: the waiting state stands unchanged, the
        // message lies in its queue.
        let wait = fixtureJSON(server + "/api/chats/\(Self.fixtureChatId)/auto-continue")?["wait"] as? [String: Any]
        XCTAssertEqual(wait?["attempts"] as? Int, 0, "Sending triggered an attempt at the server — it should only queue")
        attach(app, "Chat parked: message queued, nothing runs")
        XCTAssertNotNil(fixturePost(server + "/fixture/limit-wait", body: ["clear": true]), "Cleanup failed")
    }

    /// The workflow choice in the composer panel is gone (a workflow is started via
    /// `/workflow:<shortname>`, the model starts it). The test pins both: the panel has no
    /// workflow entry any more, and a running workflow — started here directly at the fixture, as the
    /// model's tool would do at the server — stands in the progress strip and can be cancelled there.
    func testChatComposerStartsAndCancelsWorkflow() throws {
        let server = try requireFixture()
        let flowId = "50000000-0000-4000-8000-000000000001"
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        defer { _ = fixturePost(server + "/fixture/workflows", body: [:]) }
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")

        app.buttons["chat-attach"].tap()
        XCTAssertTrue(app.buttons["chat-action-photos"].waitForExistence(timeout: 8), "The composer panel did not open")
        XCTAssertFalse(app.buttons["chat-action-workflow"].exists, "The composer panel still offers a workflow choice")
        app.buttons["chat-attach"].tap()

        XCTAssertNotNil(
            fixturePost(server + "/api/chats/\(Self.fixtureChatId)/workflow", body: ["workflowId": flowId, "input": "please 1.2.0"]),
            "The workflow run could not be started"
        )
        let strip = app.descendants(matching: .any)["chat-workflow-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 15), "The progress strip is missing")
        attach(app, "Chat with a running workflow")

        app.buttons["chat-workflow-cancel"].tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (fixtureJSON(server + "/fixture/workflows")?["run"] as? [String: Any])?["status"] as? String == "cancelled"
            },
            "The cancellation did not reach the server"
        )
    }

    /// During a workflow with its OWN compaction the chat's auto menu carries, at the top,
    /// a hint row "During the workflow: …" — the chat's own choice below it stays. After
    /// the run is cancelled the row is gone (it applies only while the run is open).
    func testChatAutocompactMenuShowsWorkflowHint() throws {
        let server = try requireFixture()
        let flowId = "50000000-0000-4000-8000-000000000001"
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: ["runs": [flowId: ["autocompact": 40]]]), "The fixture did not accept the seed")
        XCTAssertNotNil(fixturePost(server + "/api/chats/\(Self.fixtureChatId)/workflow", body: ["workflowId": flowId, "input": ""]), "The workflow run could not be started")
        defer { _ = fixturePost(server + "/fixture/workflows", body: [:]) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-workflow-strip"].waitForExistence(timeout: 15), "The run did not arrive in the chat")

        let hintShown: () -> Bool = {
            app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Während des Workflows", "During the workflow")).firstMatch.exists
        }
        func openAutoMenu() {
            XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 10), "The chat menu is missing")
            app.buttons["chat-menu"].tap()
            let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Auto-compact", "Auto-compact")).firstMatch
            XCTAssertTrue(menu.waitForExistence(timeout: 6), "The 'Auto-compact' submenu is missing")
            menu.tap()
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Share of the window", "Share of the window")).firstMatch.waitForExistence(timeout: 6), "The chat's sliders are missing — the choice must stay")
        }
        openAutoMenu()
        XCTAssertTrue(waitUntil(timeout: 4) { hintShown() }, "The hint row 'During the workflow' is missing in the auto menu")
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Während des Workflows", "During the workflow")).firstMatch
        XCTAssertTrue(row.label.contains("40"), "The hint row does not name the workflow's value: \(row.label)")
        attach(app, "Auto menu with workflow hint")
        // Close the menu (tap outside), cancel the run — the row is gone.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertNotNil(fixturePost(server + "/api/chats/\(Self.fixtureChatId)/workflow/cancel", body: [:]), "The cancellation did not reach the fixture")
        XCTAssertTrue(waitUntilGone(app.descendants(matching: .any)["chat-workflow-cancel"], timeout: 10), "The run has not ended in the chat")
        openAutoMenu()
        XCTAssertFalse(hintShown(), "The hint row is still there after the run has ended")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    }

    /// Review by the human: the run waits not for a question but for a VERDICT.
    /// On the phone it must arrive in three places — the strip ("waiting for your review"), a row in the
    /// history with the full test instructions (which must NOT be shortened) and the notification that
    /// leads into exactly this chat. The state comes from the fixture, because on the real server
    /// an agent turn is needed to produce it.
    func testChatReviewRequestShowsInstructionsStripAndNotice() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25),
            "The composer is missing"
        )

        XCTAssertNotNil(
            fixturePost(server + "/fixture/review-wait", body: ["round": 2]),
            "The fixture did not accept the review waiting phase"
        )
        defer {
            _ = fixturePost(server + "/fixture/workflows", body: [:])
            _ = fixturePost(server + "/fixture/notice", body: ["clear": true])
        }

        XCTAssertTrue(
            app.descendants(matching: .any)["chat-workflow-strip"].waitForExistence(timeout: 12),
            "The progress strip is missing"
        )
        XCTAssertTrue(
            app.staticTexts["waiting for your review"].waitForExistence(timeout: 8),
            "The strip does not say that a REVIEW is pending (and not just 'an answer')"
        )
        // The row in the history carries the instructions — they are the content, not a teaser.
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-workflow-line-review"].waitForExistence(timeout: 10),
            "The review row is missing in the history"
        )
        XCTAssertTrue(statusHeader(app, "Review requested (round 2)").exists, "The round is missing in the heading")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Your answer decides")).firstMatch.exists,
            "The row does not say what is to be done now"
        )
        // The instructions themselves are deliberately NOT repeated by the row: in operation they stand above it as the
        // agent's message (formatted), here in the fixture there is no run that streams them. So the
        // contract is checked — they are part of the run's question.
        let question = (fixtureJSON(server + "/fixture/workflows")?["run"] as? [String: Any])?["question"] as? String
        XCTAssertTrue(question?.contains("So testen") == true, "The test instructions are missing in the run's question: \(question ?? "-")")
        attach(app, "Chat waits for my review")

        // Notification: it must be in the list and offer the way into THIS chat.
        XCTAssertNotNil(fixturePost(server + "/fixture/notice", body: [:]), "The fixture did not accept the notice")
        normalizeToChatsOverview(app)
        // The bell sits in the RIGHT drawer (sections) — it is not reachable without it.
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.otherElements["right-drawer"].waitForExistence(timeout: 8), "The right drawer did not open")
        let bell = app.buttons["drawer-bell"]
        XCTAssertTrue(bell.waitForExistence(timeout: 10), "The bell is missing")
        bell.tap()
        XCTAssertTrue(
            app.staticTexts["Review angefragt: Kasse umbauen"].waitForExistence(timeout: 10),
            "The review notice is missing in the notifications"
        )
        XCTAssertTrue(app.staticTexts["Answer review →"].exists, "The notice offers no way to answer")
        attach(app, "Notification: review requested")
    }

    // ── Queue during a running run ──────────────────────────────────────────
    func testRunningComposerQueuesFollowUpAgainstFixture() throws {
        let server = try requireFixture()
        guard let initialCreateCount = fixtureCreateCount(server) else {
            XCTFail("The fixture state could not be read")
            return
        }

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        XCTAssertEqual(
            fixtureCreateCount(server),
            initialCreateCount,
            "Merely entering a workspace must not create a chat"
        )

        app.buttons["overview-new-chat"].tap()
        XCTAssertTrue(app.navigationBars["New chat"].waitForExistence(timeout: 10))
        app.buttons["Cancel"].tap()

        // Open a draft via the drawer — that too must not create a chat yet.
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.buttons["sidebar-new-chat"].waitForExistence(timeout: 5))
        app.buttons["sidebar-new-chat"].tap()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        XCTAssertEqual(
            fixtureCreateCount(server),
            initialCreateCount,
            "A draft must not create a server chat before the first message"
        )

        composer.tap()
        composer.typeText("First message")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        XCTAssertTrue(
            app.buttons["Stop answering"].waitForExistence(timeout: 15),
            "The empty composer must show the stop button during the run"
        )
        XCTAssertEqual(
            fixtureCreateCount(server),
            initialCreateCount + 1,
            "Only the first send must create exactly one server chat"
        )
        composer.tap()
        composer.typeText("Second message")
        XCTAssertTrue(
            app.buttons["Queue message"].waitForExistence(timeout: 5),
            "While typing, the stop button must switch to queue sending"
        )
        app.buttons["Queue message"].tap()

        // The queued message is a docked strip with its text,
        // a "Steer" button and a wastebasket.
        let queued = app.buttons["composer-dismiss"].firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 15), "The second message was not shown as a strip")

        let todo = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Fixture arbeitet"))
            .firstMatch
        XCTAssertTrue(todo.waitForExistence(timeout: 15), "TodoWrite is not shown as an active task list")
        XCTAssertTrue(
            app.links["cbase-Link"].waitForExistence(timeout: 15),
            "Markdown links must appear as native, tappable links"
        )

        let secondReply = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Zweite Antwort."))
            .firstMatch
        XCTAssertTrue(
            secondReply.waitForExistence(timeout: 20),
            "The queued message was not taken into the same run"
        )
        XCTAssertFalse(queued.exists, "The strip of the taken-over message must disappear")
        attach(app, "Queue and follow-up reply")
    }

    // ── Slash picker in the composer ─────────────────────────────────────────────────────
    //
    // A "/" right at the start opens, above the input field, a panel of two kinds: the nine
    // slash commands and the skills of this chat. What is checked is what the user GETS of it:
    // that the panel opens, that the description stands in the row (on the phone
    // there is no pointer that could rest over a row), that a tap writes the name into the
    // field and closes the panel — and that an ordinary sentence with a
    // slash in it does NOT open it.
    //
    // Why the skills are checked via the SEARCH and not in the unfiltered list:
    // nine commands stand before them, the scroll area is 216 pt high, and a `LazyVStack` only builds
    // what appears. An `exists` on a row far below the edge would test the scroll mechanics,
    // not the picker.
    func testSlashPickerShowsCommandsAndSkillsAndSetsIn() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        composer.tap()

        // A path is NOT a command. That comes first, because a picker that jumps open at every
        // slash disturbs more in daily use than it helps.
        composer.typeText("see src/lib/api.ts")
        XCTAssertFalse(
            app.buttons["chat-slash-compact"].exists,
            "A slash in the middle of a sentence must not open the picker"
        )
        let existing = (composer.value as? String ?? "").count
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing))

        // The bare slash shows the commands — with the description IN the row.
        composer.typeText("/")
        let command = app.buttons["chat-slash-compact"]
        XCTAssertTrue(command.waitForExistence(timeout: 10), "The command /compact is missing in the picker")
        XCTAssertTrue(
            command.staticTexts["Summarize the context."].exists,
            "The description must stand in the command row — it is the reason for the picker"
        )
        attach(app, "Slash picker open")

        // Typing on brings the skills — the second kind, and the only one whose
        // description is otherwise visible nowhere in the chat.
        composer.typeText("relea")
        let skill = app.buttons["chat-slash-release-notes"]
        XCTAssertTrue(skill.waitForExistence(timeout: 10), "The skill /release-notes is missing in the picker")
        XCTAssertTrue(
            skill.staticTexts["Schreibt die Release-Notes aus den Commits."].exists,
            "The description must stand in the skill row"
        )
        XCTAssertFalse(
            app.buttons["chat-slash-compact"].exists,
            "What does not match must disappear"
        )
        attach(app, "Slash picker filtered to a skill")

        // Tapping inserts and closes.
        skill.tap()
        XCTAssertEqual(
            (composer.value as? String ?? "").trimmingCharacters(in: .whitespaces),
            "/release-notes",
            "The chosen name must stand in the field"
        )
        XCTAssertFalse(
            app.buttons["chat-slash-release-notes"].waitForExistence(timeout: 2),
            "After the choice the panel must close — the space behind it ends the name"
        )
    }

    // A project skill names its project: without the origin, twenty similar names
    // cannot be told apart. And what does not match says so — an empty box would look
    // like a loading error.
    func testSlashPickerNamesOriginAndSaysIfNothingMatches() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        composer.tap()
        composer.typeText("/till")

        let projectSkill = app.buttons["chat-slash-till-receipt"]
        XCTAssertTrue(projectSkill.waitForExistence(timeout: 10), "The project skill is missing in the picker")
        XCTAssertTrue(
            projectSkill.staticTexts["Kasse"].exists,
            "A project skill must name its project"
        )

        composer.typeText("xyznomatch")
        XCTAssertTrue(
            app.staticTexts["No command and no skill matches."].waitForExistence(timeout: 10),
            "With zero hits it must say that a search was made"
        )
        XCTAssertFalse(
            app.buttons["chat-slash-till-receipt"].exists,
            "The previous hit must be gone"
        )
        attach(app, "Slash picker without hits")
    }

    // ── Question with several questions: one per page ────────────────────────
    /// Three questions on one card used to stand one below the other. In the live state the card now shows
    /// ONE question per page (as on the web): "Question n of m" at the top right,
    /// "Previous"/"Next" at the bottom, on the last page "Send answer" with the hint of how
    /// many questions are still open. Still ONE call with all answers is sent.
    /// Counter-test against the old state: `ask-page` is missing and `ask-option-1-0` stands there at once —
    /// red at the first assertion.
    func testChatAskCardPagesThroughQuestions() throws {
        let server = try requireFixture()
        XCTAssertNotNil(
            fixturePost(server + "/fixture/ask", body: ["open": true, "questions": 3]),
            "The fixture did not accept the question switch with three questions"
        )
        let app = launchApp(server: server)
        try openFirstChat(app)

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing")
        composer.tap()
        composer.typeText("Three questions")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()

        let card = app.descendants(matching: .any).matching(identifier: "ask-card").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The question card is missing")
        slideInKeyboard(app)
        let page = app.staticTexts["ask-page"]
        XCTAssertTrue(page.waitForExistence(timeout: 8), "The page count 'Question n of m' is missing — the card does not page")
        XCTAssertEqual(page.label, "Question 1 of 3")
        XCTAssertFalse(app.buttons["ask-option-1-0"].exists, "The second question must not stand on page 1")
        let prior = app.buttons["ask-prev"]
        let next = app.buttons["ask-next"]
        XCTAssertTrue(prior.exists, "'Previous' is missing")
        XCTAssertFalse(prior.isEnabled, "'Previous' must be disabled on page 1")
        XCTAssertTrue(scrollUntilHittable(app, next), "'Next' is not tappable")
        attach(app, "Question page 1 of 3")

        // Page to the end without a choice: sending disabled, three questions open.
        next.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 2 of 3" }, "Page 2 did not come: \(page.label)")
        XCTAssertTrue(scrollUntilHittable(app, app.buttons["ask-option-1-0"]), "The options of the second question are not tappable")
        XCTAssertFalse(app.buttons["ask-option-0-1"].exists, "The first question must no longer stand on page 2")
        XCTAssertTrue(scrollUntilHittable(app, next))
        next.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 3 of 3" }, "Page 3 did not come: \(page.label)")
        XCTAssertFalse(next.exists, "On the last page there is no 'Next'")
        let send = app.buttons["ask-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "'Send answer' is missing on the last page")
        XCTAssertFalse(send.isEnabled, "Nothing may be sent without answers")
        let open = app.staticTexts["ask-open"]
        XCTAssertTrue(open.exists, "The hint about the open questions is missing")
        XCTAssertEqual(open.label, "3 questions still open")
        attach(app, "Question page 3 without answers")

        // Back to page 1 and answer per page. The choice of the multiple-choice question survives
        // paging — proved at the end by what the server receives.
        XCTAssertTrue(scrollUntilHittable(app, prior))
        prior.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 2 of 3" })
        XCTAssertTrue(scrollUntilHittable(app, prior))
        prior.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 1 of 3" })
        let first = app.buttons["ask-option-0-1"]
        XCTAssertTrue(scrollUntilHittable(app, first), "The second option of the first question is not tappable")
        first.tap()
        XCTAssertTrue(scrollUntilHittable(app, next))
        next.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 2 of 3" })
        for identifier in ["ask-option-1-0", "ask-option-1-1"] {
            let option = app.buttons[identifier]
            XCTAssertTrue(scrollUntilHittable(app, option), "\(identifier) is not tappable")
            option.tap()
        }
        XCTAssertTrue(scrollUntilHittable(app, next))
        next.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { page.label == "Question 3 of 3" })
        XCTAssertTrue(waitUntil(timeout: 5) { open.exists && open.label == "1 question still open" },
                      "The hint counts wrong: \(open.exists ? open.label : "missing")")
        XCTAssertFalse(send.isEnabled, "With one open question nothing may be sent")
        let third = app.buttons["ask-option-2-1"]
        XCTAssertTrue(scrollUntilHittable(app, third), "The options of the third question are not tappable")
        third.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { !open.exists }, "The hint stays although everything is answered")
        XCTAssertTrue(waitUntil(timeout: 5) { send.isEnabled }, "'Send answer' stays disabled")
        attach(app, "Question page 3 complete")
        XCTAssertTrue(scrollUntilHittable(app, send))
        send.tap()

        // ONE call with all three answers — the multiple choice survived the paging.
        var received: [String: Any]?
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let state = fixtureJSON(server + "/fixture/ask"), state["requestId"] as? String == "fixture-ask-1" {
                received = state
                break
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        guard let answers = received?["answers"] as? [[String: Any]], answers.count == 3 else {
            attach(app, "The answers did not arrive at the server")
            return XCTFail("The server did not receive three answers: \(String(describing: received))")
        }
        XCTAssertEqual(answers[0]["selected"] as? [String], ["Getrennte Repos"])
        XCTAssertEqual(answers[1]["selected"] as? [String], ["Lint", "Unit-Tests"])
        XCTAssertEqual(answers[2]["selected"] as? [String], ["Nächster Sprint"])

        // Afterwards the card lies answered and STACKED: all three questions at once, no pager.
        let contains: (String) -> XCUIElement = { text in
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        XCTAssertTrue(contains("answered").waitForExistence(timeout: 8), "The card stays unanswered")
        XCTAssertTrue(waitUntil(timeout: 5) { !page.exists }, "The answered card still pages")
        XCTAssertTrue(app.buttons["ask-option-0-1"].exists && app.buttons["ask-option-1-0"].exists && app.buttons["ask-option-2-1"].exists,
                      "Answered, all three questions must be readable at once")
        // "Inert" hangs on `done` (the answers stand on the card, "answered" at the top is
        // the proof), NOT on a `sent` flag of the cell — the POST's error path makes
        // the card tappable again, and no cell state may prevent that.
        XCTAssertFalse(app.buttons["ask-option-2-1"].isEnabled, "The answered card is still tappable")
        attach(app, "Question with three questions answered")
    }

    // ── The draft in the composer survives tab and chat switches ─────────────
    /// Whoever switches the tab mid-sentence finds the sentence again: the text
    /// lies per chat in UserDefaults (`cbase.mobile.draft:<id>`), written at once on leaving
    /// (`flushDraft` in onDisappear), read on opening, discarded on sending.
    /// What is checked is on NEWLY built models (close the chat and reopen it) — only so does the
    /// text go through the store and not just through a still-living view. A text of its own per run,
    /// because the simulator's UserDefaults stay between runs.
    /// Counter-test against the old state: after reopening the field is empty.
    /// As the ONLY test it starts without the draft pins (`keepDraft: true`):
    /// `launchApp` otherwise pins the draft of every fixture chat to empty via the argument domain,
    /// because a lingering draft turned seven other tests red — here it IS
    /// the subject. The test therefore cleans up itself at the end (sending discards the draft).
    func testComposerDraftSurvivesTabSwitch() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 3))
        defer { _ = setFixtureHistory(server, count: 0) }
        let app = launchApp(server: server, keepDraft: true)
        try openFirstChat(app)
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        let marker = "Draft " + String(UUID().uuidString.prefix(6))
        composer.tap()
        composer.typeText(marker)
        XCTAssertTrue(waitUntil(timeout: 5) { (composer.value as? String)?.contains(marker) == true }, "The text did not get into the field")

        // ── Location away and back (via the right drawer) ──
        selectLocation(app, "apps")
        Thread.sleep(forTimeInterval: 0.8)
        selectLocation(app, "workspaces")
        // The tab leads into the coding overview; from there into the chats — and there the chat is
        // either still open or is reopened (then with a fresh model, which is what counts here).
        codingCategoryFromOverview(app, "chats")
        if !composer.waitForExistence(timeout: 5) { try openFirstChat(app) }
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "The composer is missing after the tab switch")
        XCTAssertTrue(
            waitUntil(timeout: 8) { (composer.value as? String)?.contains(marker) == true },
            "The draft does not survive the tab switch: \(String(describing: composer.value))"
        )
        attach(app, "Draft after tab switch")

        // ── Close the chat and reopen it NEW: a new model reads the store ──
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.buttons["sidebar-overview"].waitForExistence(timeout: 6), "The chat drawer did not open")
        app.buttons["sidebar-overview"].tap()
        try openFirstChat(app)
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        XCTAssertTrue(
            waitUntil(timeout: 8) { (composer.value as? String)?.contains(marker) == true },
            "A reopened chat does not read the draft: \(String(describing: composer.value))"
        )

        // ── Sending discards it — and it does not come back on reopening ──
        composer.tap()
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["Stop answering"].waitForExistence(timeout: 15), "The run did not start")
        XCTAssertTrue(
            waitUntil(timeout: 5) { (composer.value as? String)?.contains(marker) != true },
            "After sending the text is still in the field"
        )
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.buttons["sidebar-overview"].waitForExistence(timeout: 6))
        app.buttons["sidebar-overview"].tap()
        try openFirstChat(app)
        XCTAssertTrue(composer.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(
            (composer.value as? String)?.contains(marker) == true,
            "The sent text came back as a draft: \(String(describing: composer.value))"
        )
    }

    // ── Archiving with an open keyboard ──
    /// The bar replaces the input IN the island. If archiving happens with an open keyboard and typed text, the
    /// keyboard closes (it would otherwise stand above a row that no longer exists), the bar stands in the island, and
    /// after restoring the input carries the text from before. The keyboard is measured via its FRAME —
    /// `isHittable` is always false for retracted elements of the island and said nothing here.
    func testArchiveWithOpenKeyboardKeepsTheDraft() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let card = app.buttons["overview-chat-20000000-0000-4000-8000-000000000002"]
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The 'Architektur-Notizen' card is missing")
        card.tap()
        let input = app.textViews["chat-composer"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "The chat did not open")
        let marker = "ArchiveDraft " + String(UUID().uuidString.prefix(6))
        input.tap()
        input.typeText(marker)
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The keyboard did not open")
        XCTAssertTrue(waitUntil(timeout: 5) { (input.value as? String)?.contains(marker) == true }, "The text did not get into the field")

        let menu = app.buttons["chat-menu"]
        XCTAssertTrue(waitUntilHittable(menu, timeout: 8), "The chat's ⋯ is missing")
        menu.tap()
        let point = menuItem(app, "Archive")
        XCTAssertTrue(point.waitForExistence(timeout: 6), "'Archive' is missing in the ⋯")
        point.tap()

        let bar = app.descendants(matching: .any)["archive-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "The bar is missing after archiving")
        XCTAssertTrue(
            waitUntil(timeout: 6) { !keyboard.exists || keyboard.frame.minY >= app.frame.maxY - 1 },
            "The keyboard stands still after archiving (frame \(keyboard.frame))"
        )
        XCTAssertFalse(input.exists, "The input stands beside the bar")
        let island = app.descendants(matching: .any).matching(identifier: "composer-island")
            .allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })
        XCTAssertNotNil(island, "The island is missing — the bar must stand IN it")
        if let island {
            XCTAssertTrue(island.frame.insetBy(dx: -2, dy: -2).contains(bar.frame),
                          "The bar \(bar.frame) does not stand in the island \(island.frame)")
        }
        attach(app, "Archived: bar in the island, keyboard closed")

        app.buttons["archive-bar-restore"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10), "The input is missing after restoring")
        XCTAssertTrue(
            waitUntil(timeout: 5) { (input.value as? String)?.contains(marker) == true },
            "The draft is gone after restoring: \(String(describing: input.value))"
        )
        attach(app, "Restored with draft")
    }

    /// The event `chat_archive` of ANOTHER client. Every other archive test
    /// triggers the archiving in the app itself — and each of these ways also reports itself
    /// (`state.reportArchive`). Reading the event (`AppState.handleGlobalEvent`: `chatIds`, `kind`) thus needed
    /// no test; an `event["chatId"]` instead of `chatIds` stayed green everywhere. Here the fixture sends the event
    /// without any action of the app: archived ⇒ the bar replaces the input; a run fetches it back
    /// (`reason: "work"`, `cause: "channel"` — the way on which `fetchBack` reaches an open iPhone) ⇒ the
    /// input is back.
    func testArchiveEventOfOneOtherClientsTogglesTheBar() throws {
        let server = try requireFixture()
        let chatA = "20000000-0000-4000-8000-000000000002"
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let card = app.buttons["overview-chat-\(chatA)"]
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The 'Architektur-Notizen' card is missing")
        card.tap()
        let input = app.textViews["chat-composer"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "The chat did not open")
        let bar = app.descendants(matching: .any)["archive-bar"]
        XCTAssertFalse(bar.exists, "An active chat shows the archive bar")
        // Only send when the app is listening — otherwise the test would check the race for the stream, not the event path.
        XCTAssertTrue(
            waitForFixture(timeout: 10) { ((self.fixtureJSON(server + "/fixture/archive")?["streams"] as? Int) ?? 0) > 0 },
            "The app has no event stream (/api/events) open"
        )

        // ── Another client archives the open chat ──
        XCTAssertNotNil(fixturePost(server + "/fixture/archive", body: [
            "event": ["chatIds": [chatA], "archived": true, "kind": "normal", "reason": "user"],
        ]))
        XCTAssertTrue(bar.waitForExistence(timeout: 10),
                      "The event `chat_archive` of another client does not reach the open chat — the input stays")
        XCTAssertTrue(waitUntilGone(input, timeout: 6), "The input still stands beside the bar")
        attach(app, "Archived by another client")

        // ── A run fetches it back (channel message to the archived chat) ──
        XCTAssertNotNil(fixturePost(server + "/fixture/archive", body: [
            "event": ["chatIds": [chatA], "archived": false, "kind": "normal", "reason": "work", "cause": "channel"],
        ]))
        XCTAssertTrue(input.waitForExistence(timeout: 10),
                      "The fetch-back by a run (reason 'work') does not reach the open chat")
        XCTAssertTrue(waitUntilGone(bar, timeout: 6), "The bar still stands after the fetch-back")
    }

    /// "Chat settings" in the header's ⋯ menu. The composer island's model button carries the same name as a label
    /// (`chat-model-button`) — a query by label alone has been ambiguous since ("Multiple matching elements").
    private func chatSettingsMenuItem(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Chat settings", "chat-model-button")).element
    }

    /// The effort selection of the chat settings: built on `Kit/EffortSelection.swift`, it shows
    /// "Auto" first, the grades of the CHOSEN model, and a set grade the model does not carry stays marked with its replacement.
    /// The fixture chat stands on GPT-5.6 Sol (all five grades); GPT-5.5 carries no `max`.
    func testEffortSelectionInTheChatSettings() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15), "The chat menu is missing")
        app.buttons["chat-menu"].tap()
        let entry = chatSettingsMenuItem(app)
        XCTAssertTrue(entry.waitForExistence(timeout: 6), "'Chat settings' is missing in the chat menu")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Chat settings"].waitForExistence(timeout: 10), "The 'Chat settings' sheet does not open")
        checkEffortSelection(app, ["Low", "Medium", "High", "X-High", "Max"], choice: "Max", "Chat settings, GPT-5.6 Sol")
        selectInPicker(app, "Model", "GPT-5.5")
        checkEffortSelection(app, ["Low", "Medium", "High", "X-High", "Max · runs as X-High"], choice: "Max · runs as X-High", "Chat settings, GPT-5.5")
        app.buttons["chat-settings-close"].tap()
        XCTAssertTrue(waitUntilGone(app.navigationBars["Chat settings"], timeout: 6), "The sheet does not close")
    }

    /// Ultracode in the chat sheet (a switch of its own below the effort selection, independent of the
    /// grade): switching it on sends `ultracode: true` NEXT TO the standing grade, the reopened sheet shows the switch
    /// on; a grade afterwards leaves it standing (`ultracode: true` together with the new grade). What is checked is the SENT field
    /// (`lastChatPatch` in the fixture), not only the state afterwards.
    func testUltracodeInChatSheet() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        func sheetOn() {
            XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15), "The chat menu is missing")
            app.buttons["chat-menu"].tap()
            let entry = chatSettingsMenuItem(app)
            XCTAssertTrue(entry.waitForExistence(timeout: 6), "'Chat settings' is missing in the chat menu")
            entry.tap()
            XCTAssertTrue(app.navigationBars["Chat settings"].waitForExistence(timeout: 10), "The 'Chat settings' sheet does not open")
        }
        func save() {
            app.buttons["Save"].tap()
            XCTAssertTrue(waitUntilGone(app.navigationBars["Chat settings"], timeout: 8), "The sheet does not close after saving")
        }
        func lastPatch() -> [String: Any]? { fixtureJSON(server + "/fixture/state")?["lastChatPatch"] as? [String: Any] }

        let toggle = { app.switches["ultracode-toggle"] }
        sheetOn()
        XCTAssertTrue(toggle().waitForExistence(timeout: 6), "The ultracode switch is missing in the chat sheet")
        XCTAssertEqual(toggle().value as? String, "0", "Ultracode is not off by default")
        let levelPrior = pickerRow(app, "Effort").label
        toggle().coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 4) { app.switches["ultracode-toggle"].value as? String == "1" }, "The switch does not flip")
        XCTAssertEqual(pickerRow(app, "Effort").label, levelPrior, "The switch changed the effort row")
        save()
        XCTAssertTrue(waitUntil(timeout: 6) { (lastPatch()?["ultracode"] as? Bool) == true },
                      "What was sent is not `ultracode: true`: \(String(describing: lastPatch()))")

        sheetOn()
        XCTAssertTrue(waitUntil(timeout: 6) { app.switches["ultracode-toggle"].value as? String == "1" },
                      "The reopened sheet does not show the switch on")
        attach(app, "Chat settings, ultracode on")
        selectInPicker(app, "Effort", "High")
        save()
        XCTAssertTrue(waitUntil(timeout: 6) { (lastPatch()?["effort"] as? String) == "high" },
                      "The chosen grade did not go along: \(String(describing: lastPatch()))")
        XCTAssertEqual(lastPatch()?["ultracode"] as? Bool, true, "A grade switched ultracode off")
    }

    /// Haiku 4.5 carries NO grades (`efforts: []` in the catalog,
    /// measured on the pinned CLI) — the chat sheet shows no effort selection there. Sonnet 5 (five grades) shows
    /// it; switching back brings it back. The fixture carries both models with their lists (routes-chat.mjs).
    func testEffortSelectionMissingOnHaikuInChatSheet() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15), "The chat menu is missing")
        app.buttons["chat-menu"].tap()
        let entry = chatSettingsMenuItem(app)
        XCTAssertTrue(entry.waitForExistence(timeout: 6), "'Chat settings' is missing in the chat menu")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Chat settings"].waitForExistence(timeout: 10), "The 'Chat settings' sheet does not open")
        selectInPicker(app, "Providers", "Claude Code")
        selectInPicker(app, "Model", "Sonnet 5")
        checkEffortSelection(app, ["Low", "Medium", "High", "X-High", "Max"], choice: "Max", "Chat settings, Sonnet 5")
        selectInPicker(app, "Model", "Haiku 4.5")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists },
                      "An effort selection still stands on Haiku 4.5: \(pickerRow(app, "Effort").label)")
        XCTAssertTrue(app.descendants(matching: .any)["ultracode-toggle"].exists, "the ultracode switch below stays — only the effort selection is missing")
        attach(app, "Chat settings, Haiku 4.5 without effort")
        selectInPicker(app, "Model", "Sonnet 5")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 6), "Back on Sonnet 5 the effort selection is missing")
        app.buttons["chat-settings-close"].tap()
        XCTAssertTrue(waitUntilGone(app.navigationBars["Chat settings"], timeout: 6), "The sheet does not close")
    }

    /// A provider with `caps.effort: false` ("Ohne Denkgrad" in the
    /// fixture) carries no thinking grade — the chat sheet shows no effort selection there, back on Codex it stands.
    func testEffortSelectionMissingOnProviderWithoutThinkingLevelInChatSheet() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15), "The chat menu is missing")
        app.buttons["chat-menu"].tap()
        let entry = chatSettingsMenuItem(app)
        XCTAssertTrue(entry.waitForExistence(timeout: 6), "'Chat settings' is missing in the chat menu")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Chat settings"].waitForExistence(timeout: 10), "The 'Chat settings' sheet does not open")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 6), "The effort selection is missing on Codex")
        selectInPicker(app, "Providers", "Ohne Denkgrad")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists },
                      "On the provider without a thinking grade an effort selection still stands: \(pickerRow(app, "Effort").label)")
        XCTAssertTrue(app.descendants(matching: .any)["ultracode-toggle"].exists, "the ultracode switch below stays — only the effort selection is missing")
        attach(app, "Chat settings, provider without thinking grade")
        selectInPicker(app, "Providers", "OpenAI Codex")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 6), "Back on Codex the effort selection is missing")
        app.buttons["chat-settings-close"].tap()
        XCTAssertTrue(waitUntilGone(app.navigationBars["Chat settings"], timeout: 6), "The sheet does not close")
    }

    // ── Line break in the field: the gap to the keyboard stays ────────────────────────────
    /// On the phone, with one line the island stands above the keyboard with a narrow gap — when the text wraps, "the composer
    /// suddenly moves down a little and touches the edge". What is measured is FRAMES (island bottom edge ↔ keyboard top edge,
    /// freshly queried) at 1, 2 and 3 lines, plus the in-app probe (CBASE_COMPOSER_TRACE), which records the field's bottom edge
    /// frame by frame — XCUITest sees a frame only at rest. The gap must be the same at every line count (±1 pt).
    /// Counter-test: if `ChatInputTextView.sizeThatFits` answers the ideal-size query with a fixed 200 pt, the test turns
    /// red with "At 2 lines … 43.7 instead of 53.0 pt" — the island sagged by 9.3 pt and the probe saw the field's
    /// bottom edge jump 492.7 → 502.3 and stay there. With the ideal answer at the real field width it is 53.0 / 53.0 / 53.0 pt,
    /// probe span 0.0 pt.
    func testIslandGapToKeyboardStaysAtLineBreak() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, environment: ["CBASE_COMPOSER_TRACE": "1"])
        try openFirstChat(app)
        let input = app.textViews["chat-composer"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "The composer is missing")
        let probe = app.otherElements["composer-trace"]
        XCTAssertTrue(probe.waitForExistence(timeout: 8), "The measuring probe is missing (CBASE_COMPOSER_TRACE)")
        input.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 6) else {
            throw XCTSkip("Without a software keyboard in the simulator the gap is not measurable")
        }
        Thread.sleep(forTimeInterval: 1.5)

        struct Situation { let clearance: CGFloat; let field: CGRect; let island: CGRect; let keyboard: CGRect }
        /// Freshly queried (a reused element returns its last resolved snapshot). The
        /// island is the TALLEST element of its identifier — collapsed sheets stand in the tree with frames, the bottom edge
        /// does not hit them.
        func situation() -> Situation {
            let keyboard = app.keyboards.firstMatch.frame
            let island = app.descendants(matching: .any).matching(identifier: "composer-island")
                .allElementsBoundByIndex.max(by: { $0.frame.height < $1.frame.height })?.frame ?? .zero
            let field = app.textViews["chat-composer"].frame
            return Situation(clearance: keyboard.minY - island.maxY, field: field, island: island, keyboard: keyboard)
        }
        func probeValue() -> String { probe.value as? String ?? "" }
        /// "field=612.0..612.0 …" → span of the field's bottom edge in the probe's 4-s window.
        func fieldSpan(_ value: String) -> Double? {
            guard let range = value.range(of: #"field=([\d.]+)\.\.([\d.]+)"#, options: .regularExpression) else { return nil }
            let parts = value[range].dropFirst("field=".count).components(separatedBy: "..")
            guard parts.count == 2, let lo = Double(parts[0]), let hi = Double(parts[1]) else { return nil }
            return hi - lo
        }
        let oneRow = situation()
        XCTAssertGreaterThan(oneRow.clearance, 0, "Already at one line the island lies behind the keyboard: \(oneRow)")

        /// Types word by word until the field has grown by one more line (wrap, NOT a line break via
        /// Return — that is exactly how the finding came).
        func typeUntilRows(_ rows: Int) {
            let lineHeight: CGFloat = 18
            let target = oneRow.field.height + CGFloat(rows - 1) * lineHeight
            for _ in 0..<40 where app.textViews["chat-composer"].frame.height < target {
                input.typeText("Wrap ")
            }
            XCTAssertGreaterThanOrEqual(app.textViews["chat-composer"].frame.height, target,
                                        "The field has not grown to \(rows) lines")
        }

        typeUntilRows(2)
        Thread.sleep(forTimeInterval: 1.0)
        let twoRows = situation()
        let probeTwo = probeValue()
        typeUntilRows(3)
        Thread.sleep(forTimeInterval: 1.0)
        let threeRows = situation()
        let probeThree = probeValue()
        attach(app, "Three lines in the field, island above the keyboard")
        for (name, l) in [("1 line", oneRow), ("2 lines", twoRows), ("3 lines", threeRows)] {
            print("GAP \(name): air=\(l.clearance) island=\(l.island) field=\(l.field) keyboard=\(l.keyboard)")
        }
        print("PROBE 2 lines: \(probeTwo)")
        print("PROBE 3 lines: \(probeThree)")
        XCTAssertEqual(twoRows.clearance, oneRow.clearance, accuracy: 1,
                       "At 2 lines the island stands differently to the keyboard than at one: \(twoRows.clearance) instead of \(oneRow.clearance) pt")
        XCTAssertEqual(threeRows.clearance, oneRow.clearance, accuracy: 1,
                       "At 3 lines the island stands differently to the keyboard than at one: \(threeRows.clearance) instead of \(oneRow.clearance) pt")
        // And not a single frame in between: the field's bottom edge stands still across both wraps (the probe also sees
        // what XCUITest never gets to see as a rest frame).
        for (name, value) in [("2 lines", probeTwo), ("3 lines", probeThree)] {
            guard let span = fieldSpan(value) else {
                XCTFail("The probe delivered no measurement at \(name): \(value)")
                continue
            }
            XCTAssertLessThanOrEqual(span, 1, "The input row moved at the wrap to \(name) by \(span) pt (\(value))")
        }
    }

    // ── Paste an image from the clipboard ─────────────────────────────────────────────────
    /// "normally you hold down in the input field and then 'Paste' comes up as a button and the
    /// image is pasted" — the field offered "Paste" only for TEXT, an image went only via
    /// the photos picker. Three entries on the clipboard (PNG, JPEG and a TIFF that must go out as JPEG —
    /// the server only knows png/jpeg/gif/webp as an image): long press → "Paste" ⇒ three attachment chips, three uploads
    /// with the right signature, the typed text stays, and no confirmation banner.
    /// Counter-test: without `canPerformAction`/`paste(_:)` for images the test turns red with "The edit menu came WITHOUT 'Paste' although an image is on
    /// the clipboard: ["Select", "Select All"]". With them: green,
    /// three uploads (PNG, JPEG, TIFF as JPEG), three chips.
    func testImageFromTheClipboardGetsAttachment() throws {
        let server = try requireFixture()
        let app = launchApp(server: server) // `reset-run` empties the recorded uploads
        try openFirstChat(app)
        let input = app.textViews["chat-composer"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "The composer is missing")
        func uploads() -> [[String: Any]] {
            (fixtureJSON(server + "/fixture/attachments")?["uploads"] as? [[String: Any]]) ?? []
        }
        XCTAssertEqual(uploads().count, 0, "An upload is already in the fixture before pasting")
        let chips = app.descendants(matching: .any).matching(identifier: "chat-attachment-name")
        XCTAssertEqual(chips.count, 0, "An attachment chip already stands before pasting")

        // Text first: that way the edit menu ALWAYS has items (Select …) — "menu did not come" (the gesture, see
        // the XCUITest pitfalls: a long press often arrives as a tap in fresh processes) and "menu came without Paste"
        // (the finding) are then two different messages.
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 6), "The keyboard did not open")
        input.typeText("Image:")

        // The clipboard is shared by the test process with the app (the same simulator).
        let size = CGSize(width: 40, height: 30)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        let png = try XCTUnwrap(image.pngData())
        let jpeg = try XCTUnwrap(image.jpegData(compressionQuality: 0.8))
        let tiff = NSMutableData()
        let target = try XCTUnwrap(CGImageDestinationCreateWithData(tiff, UTType.tiff.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(target, try XCTUnwrap(image.cgImage), nil)
        XCTAssertTrue(CGImageDestinationFinalize(target), "The TIFF could not be built")
        UIPasteboard.general.items = [
            [UTType.png.identifier: png],
            [UTType.jpeg.identifier: jpeg],
            [UTType.tiff.identifier: tiff as Data],
        ]
        defer { UIPasteboard.general.items = [] }

        let place = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label IN %@", ["Einsetzen", "Paste", "Paste"])).firstMatch
        XCTAssertFalse(place.exists, "'Paste' already stands there BEFORE the long press")
        var menuItems: [String] = []
        for _ in 1...8 {
            input.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)).press(forDuration: 1.2)
            if place.waitForExistence(timeout: 2.5) { break }
            menuItems = app.menuItems.allElementsBoundByIndex.map(\.label)
            if !menuItems.isEmpty { break }
        }
        guard place.exists else {
            attach(app, "Edit menu without Paste")
            if menuItems.isEmpty {
                XCTFail("The edit menu did not come in eight attempts (gesture, no product finding)")
            } else {
                XCTFail("The edit menu came WITHOUT 'Paste' although an image is on the clipboard: \(menuItems)")
            }
            return
        }
        attach(app, "Edit menu with Paste")
        place.tap()

        XCTAssertTrue(waitUntil(timeout: 15) { uploads().count >= 3 },
                      "After 'Paste' three uploads did not arrive at the fixture: \(uploads())")
        let uploaded = uploads()
        let names = uploaded.map { $0["name"] as? String ?? "" }
        let headers = uploaded.map { $0["header"] as? String ?? "" }
        XCTAssertEqual(uploaded.count, 3, "Exactly three uploads expected: \(uploaded)")
        if uploaded.count == 3 {
            XCTAssertTrue(names[0].hasPrefix("Bild-") && names[0].hasSuffix(".png"), "First upload is no PNG name: \(names)")
            XCTAssertTrue(headers[0].hasPrefix("89504e470d0a1a0a"), "First upload carries no PNG signature: \(headers)")
            XCTAssertTrue(names[1].hasSuffix(".jpeg") || names[1].hasSuffix(".jpg"), "Second upload is no JPEG name: \(names)")
            XCTAssertTrue(headers[1].hasPrefix("ffd8ff"), "Second upload carries no JPEG signature: \(headers)")
            // The TIFF goes out as JPEG (the server does not know TIFF as an image).
            XCTAssertTrue(names[2].hasSuffix(".jpeg") || names[2].hasSuffix(".jpg"), "The TIFF did not go out as JPEG: \(names)")
            XCTAssertTrue(headers[2].hasPrefix("ffd8ff"), "The TIFF did not go out as JPEG: \(headers)")
        }
        XCTAssertTrue(waitUntil(timeout: 8) { chips.count == 3 }, "Instead of three attachment chips \(chips.count) stand in the island")
        XCTAssertEqual(app.textViews["chat-composer"].value as? String, "Image:", "The typed text changed on pasting")
        // No confirmation banner: the user triggered the pasting.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertFalse(app.alerts.firstMatch.exists || springboard.alerts.firstMatch.exists,
                       "On pasting iOS asked: \(app.alerts.firstMatch.label) \(springboard.alerts.firstMatch.label)")
        attach(app, "Three images pasted as attachments")

    }
}
