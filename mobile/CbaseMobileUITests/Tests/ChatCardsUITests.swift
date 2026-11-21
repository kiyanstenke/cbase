// Chat-card UI tests: the approval card (adjust at the marker, approve, reject) and the channels sheet.
// A class of its own so that `ChatRowsUITests` stays under the 2,000-line guard.
import XCTest

final class ChatCardsUITests: CbaseUITestBase {
    // ── Adjust: marker on the approval card → "Adjust" → sheet → clipboard ──
    // Against the fixture: the card's text value carries the text marker, the marker menu offers
    // "Adjust", the sheet shows the marked text, a new instruction runs (toast at the bottom
    // "finished"), the new text lands on the clipboard, the instruction is remembered and runs
    // the second time via "Adjust with this". The only iOS test for adjusting; the decision on the
    // card is covered by the two tests below. `reset-run` clears the remembered instructions.
    func testAdjustAtMarkerOnTheApprovalCard() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/approval", body: [:]), "The fixture did not seed an approval")
        defer { _ = fixturePost(server + "/fixture/approval", body: ["off": true]) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["chat-approval-card"].waitForExistence(timeout: 20), "The approval card is missing in the coding chat")
        let value = app.staticTexts["Testsystem steht — bitte morgen abnehmen."]
        XCTAssertTrue(value.waitForExistence(timeout: 10), "The card's text value is missing")

        // A long press on the text value sets the marker; the menu offers "Adjust".
        value.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).press(forDuration: 1.0)
        let adjust = app.buttons["chat-selection-adjust"]
        XCTAssertTrue(adjust.waitForExistence(timeout: 5), "The marker menu does not offer 'Adjust'")
        attach(app, "Marker menu on the approval card")
        adjust.tap()

        let field = app.textViews["adjust-instruction"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The 'Instructions for adjusting' sheet did not open")
        // Which word the marker starts under the finger is the marker test's business — here it
        // matters that the sheet shows EXACTLY the selection and the run works with it.
        let shown = app.staticTexts["adjust-text"].label.trimmingCharacters(in: .whitespacesAndNewlines)
        let cardValue = "Testsystem steht — bitte morgen abnehmen."
        XCTAssertTrue(!shown.isEmpty && cardValue.contains(shown), "The sheet does not show the marked text: '\(shown)'")
        // The fixture answers "jo, " + lower case without a final full stop.
        var expected = "jo, " + shown.lowercased()
        if expected.hasSuffix(".") { expected.removeLast() }
        field.tap()
        field.typeText("Casual, like Maintainer")
        let goButton = app.buttons["adjust-go"]
        XCTAssertTrue(scrollUntilHittable(app, goButton), "'Adjust' is not reachable in the sheet")
        goButton.tap()

        XCTAssertTrue(app.staticTexts["adjust-toast-finished"].waitForExistence(timeout: 15), "The bar at the bottom does not report 'finished'")
        attach(app, "Toast after adjusting")
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                let l = fixtureJSON(server + "/fixture/adjust")?["last"] as? [String: Any]
                return (l?["prompt"] as? String) == "Casual, like Maintainer" && ((l?["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == shown && (l?["n"] as? Int) == 1
            },
            "The call did not reach the server the way the sheet showed it"
        )
        // The test runner cannot read the clipboard itself (iOS: "Operation not authorized",
        // and every attempt costs seconds). What is measured is the text the toast shows —
        // the same value the app puts on the clipboard.
        let fresh = app.staticTexts["adjust-toast-new"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 5), "The toast does not show the new text")
        XCTAssertEqual(fresh.label, expected, "The toast does not show the adjusted text")

        // Second pass: the remembered instruction is in the sheet and runs via "Adjust with this".
        XCTAssertTrue(value.waitForExistence(timeout: 10), "The card's text value is gone after the sheet")
        value.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).press(forDuration: 1.0)
        XCTAssertTrue(adjust.waitForExistence(timeout: 5), "The marker menu did not appear the second time")
        adjust.tap()
        let title = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'adjust-entry-title-'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "The remembered instruction is missing in the sheet")
        XCTAssertEqual(title.label, "Casual, like Maintainer", "The default title is the instruction itself")
        let withIt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'adjust-with-it-'")).firstMatch
        XCTAssertTrue(scrollUntilHittable(app, withIt), "'Adjust with this' is not reachable")
        withIt.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 15) {
                let l = fixtureJSON(server + "/fixture/adjust")?["last"] as? [String: Any]
                return (l?["n"] as? Int) == 2 && (l?["prompt"] as? String) == "Casual, like Maintainer"
            },
            "The second call did not run with the remembered instruction"
        )
        XCTAssertEqual((fixtureJSON(server + "/fixture/adjust")?["prompts"] as? [[String: Any]])?.count, 1, "The same instruction is still ONE entry")
        XCTAssertTrue(app.staticTexts["adjust-toast-finished"].waitForExistence(timeout: 15), "The second pass does not report 'finished'")
    }

    // ── Decision on the approval card ──
    // A tool with an approval marker waits: "Approve" sends `behavior: allow` to `/permission-decision`, afterwards the card
    // shows the result and no buttons. What arrived is read by `GET /fixture/approval`.
    func testApprovalCardApprove() throws {
        let server = try requireFixture()
        let app = try openApprovalCard(server)
        let approve = app.buttons["chat-approval-approve"]
        XCTAssertTrue(scrollUntilHittable(app, approve), "'Approve' is not reachable on the card")
        attach(app, "Approval card in the coding chat")
        approve.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { approvalDecision(server)?["behavior"] as? String == "allow" },
            "The decision did not reach the server: \(String(describing: approvalDecision(server)))"
        )
        let result = app.descendants(matching: .any)["chat-approval-result"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10), "The card does not show the decision")
        XCTAssertTrue(["Approved", "Approved"].contains(where: { result.label.contains($0) }), "The result does not say 'Approved': \(result.label)")
        XCTAssertFalse(app.buttons["chat-approval-approve"].exists, "'Approve' is still there after the decision")
        XCTAssertFalse(app.buttons["chat-approval-reject"].exists, "'Reject' is still there after the decision")
        attach(app, "Approval card after approving")
    }

    // "Reject" first opens the field for the reason; submitting sends `behavior: deny` with the reason (it goes to the
    // model); the card names it in the result.
    func testApprovalCardReject() throws {
        let server = try requireFixture()
        let app = try openApprovalCard(server)
        let reject = app.buttons["chat-approval-reject"]
        XCTAssertTrue(scrollUntilHittable(app, reject), "'Reject' is not reachable on the card")
        reject.tap()
        let reason = app.textFields["chat-approval-reason"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5), "'Reject' did not open a field for the reason")
        XCTAssertNil(approvalDecision(server), "The first tap on 'Reject' already sent a decision")
        reason.tap()
        reason.typeText("Only after acceptance\n")
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                let e = approvalDecision(server)
                return e?["behavior"] as? String == "deny" && e?["reason"] as? String == "Only after acceptance"
            },
            "The rejection did not reach the server this way: \(String(describing: approvalDecision(server)))"
        )
        let result = app.descendants(matching: .any)["chat-approval-result"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10), "The card does not show the decision")
        XCTAssertTrue(result.label.contains("Only after acceptance"), "The result does not name the reason: \(result.label)")
        XCTAssertFalse(app.buttons["chat-approval-approve"].exists, "'Approve' is still there after the rejection")
        attach(app, "Approval card after rejecting")
    }

    /// Seeds the approval, starts the app in the main chat and waits for the open card with its parameters. Cleaned up
    /// via `addTeardownBlock` (unlike `defer`, it also runs after a failure with `continueAfterFailure = false`).
    private func openApprovalCard(_ server: String) throws -> XCUIApplication {
        XCTAssertNotNil(fixturePost(server + "/fixture/approval", body: [:]), "The fixture did not seed an approval")
        addTeardownBlock { [self] in _ = fixturePost(server + "/fixture/approval", body: ["off": true]) }
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.staticTexts["chat-approval-card"].waitForExistence(timeout: 20), "The approval card is missing in the coding chat")
        XCTAssertTrue(app.staticTexts["Test Contact A"].waitForExistence(timeout: 5), "The call's parameters are not on the card")
        return app
    }

    private func approvalDecision(_ server: String) -> [String: Any]? {
        fixtureJSON(server + "/fixture/approval")?["decision"] as? [String: Any]
    }

    /// Channels: the sheet in the coding chat lists the channel, the log shows both messages including the file, and
    /// pausing takes effect at once (state and system line). Both participants are coding chats: the other one's row
    /// offers "To the chat", and the jump lands in the other coding chat.
    func testChannelsSheetShowsLogAndControl() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/channel", body: [:]))
        defer { _ = fixturePost(server + "/fixture/channel", body: ["off": true]) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-channel-card"].firstMatch.waitForExistence(timeout: 20),
            "The channel card is missing in the coding chat's history"
        )

        // The channels live in the ⋯ menu (their place in the header belongs to the timeline); the ⋯ counts the unread
        // messages.
        XCTAssertFalse(app.buttons["chat-channels"].exists, "The channels are no longer a button in the header")
        XCTAssertTrue(app.buttons["chat-timeline-button"].waitForExistence(timeout: 10) && app.buttons["chat-timeline-button"].isHittable,
                      "The chat has a project — the timeline button is missing in the header")
        let menu = app.buttons["chat-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "The chat menu is missing")
        let counted = NSPredicate { _, _ in ["2 ungelesen", "2 unread"].contains(menu.value as? String ?? "") }
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: counted, evaluatedWith: menu)], timeout: 20), .completed,
                       "The ⋯ counts the unread channel messages, was: \(String(describing: menu.value))")
        menu.tap()
        let button = app.buttons["chat-channels"]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "The ⋯ menu lacks the 'Channels' entry")
        button.tap()
        XCTAssertTrue(app.buttons["channels-close"].waitForExistence(timeout: 10), "The channels sheet did not open")
        let row = app.buttons["channel-row-90000000-0000-4000-8000-000000000001"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The list does not show the channel")
        XCTAssertTrue(row.label.contains("Kasse-Umbau"), "The row does not name the channel: \(row.label)")
        attach(app, "Channels sheet: list")
        row.tap()

        let status = app.staticTexts["channel-log-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10), "The log did not open")
        XCTAssertTrue(["Open"].contains(status.label), "The channel is open, was: \(status.label)")
        XCTAssertTrue(
            app.staticTexts["Bitte zuerst den Zahlungsfluss prüfen — die Belege liegen in der Ablage."].waitForExistence(timeout: 10),
            "The first message is missing in the log"
        )
        XCTAssertTrue(app.staticTexts["plan.md"].waitForExistence(timeout: 5), "The second message's file is missing in the log")
        // The other participant is a coding chat — its row offers the jump (a card without a channel
        // does not jump).
        XCTAssertTrue(
            app.buttons["channel-jump-20000000-0000-4000-8000-000000000003"].waitForExistence(timeout: 5),
            "The participant row of the other coding chat offers no jump"
        )
        attach(app, "Channels sheet: log")

        // Pause via the ⋯ menu — a menu item carries no identifier (SwiftUI does not pass it
        // down to the UIKit action), so go by the label in both languages.
        app.buttons["channel-menu"].tap()
        let pause = app.buttons.matching(NSPredicate(format: "label IN %@", ["Pause", "Pause"])).firstMatch
        XCTAssertTrue(pause.waitForExistence(timeout: 5), "The menu does not offer 'Pause'")
        pause.tap()
        XCTAssertTrue(
            waitUntil(timeout: 10) { ["Paused", "Paused"].contains(app.staticTexts["channel-log-status"].label) },
            "The state did not switch to 'Paused', was: \(app.staticTexts["channel-log-status"].label)"
        )
        XCTAssertTrue(
            app.staticTexts["Der Nutzer hat den Kanal pausiert."].waitForExistence(timeout: 10),
            "The system line for pausing is missing in the log"
        )
        attach(app, "Channels sheet: paused")

        // The jump: "To the chat" closes the sheet and opens the other coding chat.
        let jump = app.buttons["channel-jump-20000000-0000-4000-8000-000000000003"]
        XCTAssertTrue(scrollUntilHittable(app, jump), "'To the chat' is not reachable in the log")
        jump.tap()
        XCTAssertTrue(
            waitUntil(timeout: 20) { app.staticTexts["chat-title"].exists && app.staticTexts["chat-title"].label == "Zahlungs-Bug im Checkout" },
            "The jump did not land in the chat 'Zahlungs-Bug im Checkout', header: \(app.staticTexts["chat-title"].exists ? app.staticTexts["chat-title"].label : "—")"
        )
        XCTAssertFalse(app.buttons["channels-close"].exists, "The channels sheet is still open after the jump")
        attach(app, "After the jump: the other coding chat")

    }
}
