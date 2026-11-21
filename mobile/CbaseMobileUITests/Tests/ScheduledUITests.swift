// Coding → Scheduled and the clock in the chat list. Fixture state lives in
// `mobile/test-fixtures/chat-gateway/routes-scheduled.mjs` (`/fixture/scheduled`, cleared by `reset-run` — so the seed
// belongs in the `launchApp` setup closure).
import XCTest

final class ScheduledUITests: CbaseUITestBase {
    /// The seeded jobs and their chats (routes-scheduled.mjs SCHEDULED_*).
    static let scheduledId = "61000000-0000-4000-8000-000000000001"
    static let scheduledChatId = "60000000-0000-4000-8000-000000000001"
    static let scheduledPauseId = "61000000-0000-4000-8000-000000000002"
    static let scheduledPauseChatId = "60000000-0000-4000-8000-000000000002"

    private func seedScheduled(_ server: String) {
        XCTAssertNotNil(fixturePost(server + "/fixture/scheduled", body: ["seed": true]), "The fixture's scheduled seed is missing")
    }

    private func fixtureScheduled(_ server: String) -> [String: Any] {
        fixtureJSON(server + "/fixture/scheduled") ?? [:]
    }

    // ── The clock in the chat list ──────────────────────────────────────────────
    func testJobChatCarriesTheClockInTheChatList() throws {
        let server = try requireFixture()
        let app = launchApp(server: server) { self.seedScheduled(server) }
        normalizeToChatsOverview(app)

        let clock = app.images["chat-job-clock-\(Self.scheduledChatId)"]
        XCTAssertTrue(clock.waitForExistence(timeout: 12), "A job chat carries no clock in the chat list")
        let occurrence = app.staticTexts["chat-job-occurrence-\(Self.scheduledChatId)"]
        XCTAssertTrue(occurrence.waitForExistence(timeout: 4), "The next occurrence is missing beside the clock")
        // The fixture fixes the occurrence at tomorrow 08:00 — the row shows it short, not as a full date.
        XCTAssertEqual(occurrence.label, "tomorrow 08:00", "The next occurrence is not in short form on the row")

        // A paused job names no occurrence, but its status word.
        let pause = app.staticTexts["chat-job-occurrence-\(Self.scheduledPauseChatId)"]
        XCTAssertTrue(pause.waitForExistence(timeout: 4), "The paused job chat carries no clock")
        XCTAssertEqual(pause.label, "Paused")

        // Counter-check: a chat without a job (`job: null`) carries no clock.
        XCTAssertTrue(app.buttons["overview-chat-\(Self.fixtureChatId)"].exists, "The main chat is missing from the list")
        XCTAssertFalse(app.images["chat-job-clock-\(Self.fixtureChatId)"].exists, "A chat without a job carries a clock")
        attach(app, "Chat list with clock")
    }

    // ── List, Run now, Pause ────────────────────────────────────────────────
    func testScheduledListNowExecuteAndPause() throws {
        let server = try requireFixture()
        let app = launchApp(server: server) { self.seedScheduled(server) }
        normalizeToChatsOverview(app)
        openCategory(app, "scheduled")

        let row = app.buttons["scheduled-row-\(Self.scheduledId)"]
        XCTAssertTrue(waitUntilHittable(row, timeout: 12), "The active job is missing under \"Upcoming\"")
        XCTAssertFalse(app.buttons["scheduled-row-\(Self.scheduledPauseId)"].exists, "A paused job is listed under \"Upcoming\"")
        row.tap()

        let cadence = app.staticTexts["scheduled-detail-cadence"]
        XCTAssertTrue(cadence.waitForExistence(timeout: 8), "The job sheet does not open")
        // `LabeledContent` merges label and value into ONE element ("Repeat, Werktags um 08:00").
        XCTAssertTrue(cadence.label.hasSuffix("Werktags um 08:00"), "The cadence is not in plain text: \(cadence.label)")

        let now = app.buttons["scheduled-now"]
        XCTAssertTrue(waitUntilHittable(now, timeout: 6))
        now.tap()
        XCTAssertTrue(waitForFixture(timeout: 8) { (self.fixtureScheduled(server)["now"] as? Int) == 1 },
                      "\"Run now\" did not reach the server")
        // The occurrence is now waiting — a second press would be a 409; the button stays inactive, the state says why.
        let state = app.staticTexts["scheduled-detail-state"]
        XCTAssertTrue(state.waitForExistence(timeout: 4))
        XCTAssertTrue(state.label.hasSuffix("Queued"), "The waiting occurrence is not labelled \"Queued\": \(state.label)")
        XCTAssertFalse(now.isEnabled, "\"Run now\" stays usable with a waiting occurrence")

        app.buttons["scheduled-pause"].tap()
        XCTAssertTrue(waitForFixture(timeout: 8) {
            let patches = self.fixtureScheduled(server)["patches"] as? [[String: Any]] ?? []
            return patches.last?["status"] as? String == "paused" && patches.last?.count == 2
        }, "\"Pause\" does not send exactly `status: paused`")
        app.buttons["scheduled-detail-finished"].tap()

        // Now it is under "Paused" — and no longer under "Upcoming".
        XCTAssertTrue(row.waitForNonExistence(timeout: 6), "A paused job stays under \"Upcoming\"")
        let segment = app.buttons["scheduled-seg-paused"]
        XCTAssertTrue(segment.waitForExistence(timeout: 4))
        segment.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["scheduled-row-\(Self.scheduledId)"].waitForExistence(timeout: 6),
                      "The job just paused is missing under \"Paused\"")
        XCTAssertTrue(app.buttons["scheduled-row-\(Self.scheduledPauseId)"].exists)
        attach(app, "Scheduled: paused")
    }

    // ── New job ─────────────────────────────────────────────────────────────
    func testNewJobSendsCadenceModeAndInstructions() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "scheduled")

        // Without a seed: the empty state only after the successful response.
        XCTAssertTrue(app.staticTexts["scheduled-empty"].waitForExistence(timeout: 12), "The empty list says nothing")
        app.buttons["scheduled-new"].tap()

        let field = app.descendants(matching: .any)["scheduled-instructions"]
        XCTAssertTrue(field.waitForExistence(timeout: 8), "The \"New job\" dialog does not open")
        field.tap()
        field.typeText("Test the nightly build")

        let save = app.buttons["scheduled-save"]
        let ready = NSPredicate(format: "isEnabled == true")
        expectation(for: ready, evaluatedWith: save)
        waitForExpectations(timeout: 10)
        save.tap()

        XCTAssertTrue(waitForFixture(timeout: 8) { !((self.fixtureScheduled(server)["attachments"] as? [Any]) ?? []).isEmpty },
                      "The creation did not reach the server")
        let creation = (fixtureScheduled(server)["attachments"] as? [[String: Any]])?.last ?? [:]
        XCTAssertEqual(creation["instructions"] as? String, "Test the nightly build")
        // Preset like a new chat: daily at 08:00, full access, provider and model set.
        XCTAssertEqual(creation["cadence"] as? String, "daily")
        XCTAssertEqual((creation["plan"] as? [String: Any])?["clockTime"] as? String, "08:00")
        XCTAssertEqual(creation["permissionMode"] as? String, "bypassPermissions")
        XCTAssertFalse((creation["provider"] as? String ?? "").isEmpty, "The creation sends no provider")
        XCTAssertFalse((creation["model"] as? String ?? "").isEmpty, "The creation sends no model")
        XCTAssertFalse((creation["timeZone"] as? String ?? "").isEmpty, "The creation sends no time zone")

        // The new job is in the list — its name is the first line of the instructions.
        XCTAssertTrue(app.staticTexts["Test the nightly build"].waitForExistence(timeout: 8), "The new job is missing from the list")
        attach(app, "Scheduled: new job")
    }
}
