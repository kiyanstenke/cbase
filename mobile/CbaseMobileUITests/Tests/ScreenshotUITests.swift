import XCTest

// App Store screenshots, not a check: walks the app against the fixture gateway in its SHOWCASE mode
// (`CBASE_FIXTURE_SHOWCASE=1 node mobile/test-fixtures/chat-gateway.mjs`, data in `test-fixtures/chat-gateway/showcase.mjs`)
// and hangs one full-screen screenshot per place on the run as a kept attachment, named `01-…` to `06-…`.
//
// Opt-in twice over: the class skips itself unless the runner carries `TEST_RUNNER_CBASE_SCREENSHOTS=1`, and the tool's full
// run leaves the class out entirely (`NOT_IN_FULL_RUN` in `tools/check/lib/uitests.mjs`, passed as `-skip-testing`), so the
// normal run neither slows down nor counts a skip. How to produce and export the set: `mobile/README.md`, "App Store screenshots".
final class ScreenshotUITests: CbaseUITestBase {
    /// One kept attachment with a file-friendly name (`01-chats` → `01-chats.png` after the export).
    func shoot(_ app: XCUIApplication, _ name: String) {
        // Let springs, fades and the first image decode settle — a screenshot is a still, not a measurement.
        Thread.sleep(forTimeInterval: 1.5)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The app asks for notification permission on its first start in a fresh simulator; the system alert would sit on the
    /// first screenshot. Declined here like a user would — the screenshots show the app, not the prompt.
    func dismissSystemAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let decline = springboard.alerts.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Don")).firstMatch
        if decline.waitForExistence(timeout: 4) { decline.tap() }
    }

    /// Launch with the gentle header blur ON: the tests switch it off (a paused animation keeps XCUITest waiting), but without
    /// it the history shows hard under the status bar, which is not what a user sees.
    func launchShowcase(_ server: String) -> XCUIApplication {
        let app = launchApp(server: server, launchArguments: ["-cbase.mobile.header-blur", "1"])
        dismissSystemAlert()
        return app
    }

    func testAppStoreScreenshots() throws {
        guard ProcessInfo.processInfo.environment["CBASE_SCREENSHOTS"] == "1" else {
            throw XCTSkip("Screenshots only on request: TEST_RUNNER_CBASE_SCREENSHOTS=1 and the fixture in showcase mode.")
        }
        let server = try requireFixture()
        let overview = fixtureJSON(server + "/api/workspaces/\(Self.fixtureWorkspaceId)/overview")
        guard (overview?["name"] as? String) == "Demo" else {
            XCTFail("The fixture is not in showcase mode — start it with CBASE_FIXTURE_SHOWCASE=1")
            return
        }

        // (1) The workspace's chat overview.
        var app = launchShowcase(server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "The chat overview did not appear")
        let mainChat = app.buttons["overview-chat-\(Self.fixtureChatId)"]
        XCTAssertTrue(mainChat.waitForExistence(timeout: 10), "The showcase chat is missing from the overview")
        shoot(app, "01-chats")

        // (2) + (3) The agent conversation: it opens at its end (the approval card above the composer), then scrolled up to the plan.
        mainChat.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25), "The chat did not open")
        XCTAssertTrue(app.staticTexts["chat-approval-card"].waitForExistence(timeout: 20), "The approval card is missing")
        shoot(app, "03-approval")
        for _ in 0..<2 {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)),
                withVelocity: .slow,
                thenHoldForDuration: 0.3
            )
        }
        shoot(app, "02-conversation")

        // (4) + (5) The git sheet of the chat: graph across all branches, then a file's diff in the newest commit.
        let gitButton = app.descendants(matching: .any)["chat-git"]
        XCTAssertTrue(gitButton.waitForExistence(timeout: 20), "The git icon is missing from the header")
        gitButton.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-git-sheet"].waitForExistence(timeout: 10), "The git sheet did not open")
        XCTAssertTrue(app.staticTexts["fix/checkout-rounding"].waitForExistence(timeout: 10), "The branch is missing from the sheet")
        expandSheet(app)
        let head = app.buttons["git-commit-4e7a1c9"]
        XCTAssertTrue(head.waitForExistence(timeout: 10), "The graph is missing")
        shoot(app, "05-git-history")
        head.tap()
        let file = app.buttons["git-commit-file-src/cart/total.ts"]
        XCTAssertTrue(file.waitForExistence(timeout: 8), "The commit's files did not unfold")
        file.tap()
        XCTAssertTrue(app.buttons["git-diff-close"].waitForExistence(timeout: 8), "The diff did not open")
        shoot(app, "04-diff")

        // (6) Settings with the account section — from a fresh start, so no sheet of the chat stands in between.
        app.terminate()
        app = launchShowcase(server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "The chat overview did not appear")
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8), "The settings entry is missing in the right drawer")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 12), "The settings sheet did not open")
        shoot(app, "06-settings")
    }
}
