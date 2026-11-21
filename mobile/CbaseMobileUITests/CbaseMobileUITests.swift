// Live walkthrough against a real gateway; stays under the legacy class name (the skip path names it).
import XCTest

final class CbaseMobileUITests: CbaseUITestBase {
    // ── Full walkthrough against a real gateway ─────────────────────────────
    // Server/credentials come from the test environment; skipped without them.
    func testFullCategorySweepAgainstLiveGateway() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["CBASE_MOBILE_E2E_SERVER"], !server.isEmpty else {
            throw XCTSkip("CBASE_MOBILE_E2E_SERVER not set.")
        }
        guard reachable(server) else {
            throw XCTSkip("Gateway at \(server) not reachable.")
        }

        let app = launchApp(server: server)
        if app.textFields["login-username"].waitForExistence(timeout: 20) {
            guard let username = environment["CBASE_MOBILE_E2E_USERNAME"],
                  let password = environment["CBASE_MOBILE_E2E_PASSWORD"],
                  !username.isEmpty, !password.isEmpty else {
                throw XCTSkip("Gateway credentials missing in the test environment.")
            }
            // The login field is prefilled with the last user name — clear it before
            // typing, or the name ends up concatenated.
            clearAndType(app.textFields["login-username"], username)
            clearAndType(app.secureTextFields["login-password"], password)
            XCTAssertTrue(app.buttons["login-submit"].isEnabled, "The login button stayed disabled")
            app.buttons["login-submit"].tap()
            dismissSystemPasswordPrompt()
        }

        if !app.otherElements["top-bar"].waitForExistence(timeout: 120) {
            attach(app, "Live: login stuck")
            print("CBASE-E2E-TREE-BEGIN\n\(app.debugDescription)\nCBASE-E2E-TREE-END")
            XCTFail("The shell was not reached after login")
            return
        }
        // The app restores the last state (tab, category, project).
        // For a reproducible walkthrough, first switch to the chats overview.
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 60))
        attach(app, "Live: chats overview")

        // Open a REAL chat. The messages are unknown here, so the check is visual:
        // the end of the history must not be an empty area, and it must sit still —
        // both were the reported defect.
        let liveChat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        // No silent skip: the account has chats at workspace level.
        XCTAssertTrue(liveChat.waitForExistence(timeout: 30), "The live overview lists no chat")
        if liveChat.exists {
            liveChat.tap()
            XCTAssertTrue(
                app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 60),
                "The real chat was not opened"
            )
            XCTAssertTrue(app.descendants(matching: .any)["chat-timeline"].waitForExistence(timeout: 30))
            Thread.sleep(forTimeInterval: 4)
            let tail = timelineTailInk(app)
            attach(app, "Live: real chat at the end")
            XCTAssertGreaterThan(
                tail,
                0.02,
                "The real history ends in an empty area (share \(tail))"
            )
            let before = timelineTailInk(app)
            Thread.sleep(forTimeInterval: 1.5)
            XCTAssertEqual(
                timelineTailInk(app),
                before,
                accuracy: 0.02,
                "The history must not keep drifting after opening"
            )
            normalizeToChatsOverview(app)
        }

        // Enter a project (top-bar dropdown).
        app.buttons["scope-picker"].tap()
        let project = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "scope-project-"))
            .firstMatch
        // Entering itself stays the promise: the scope picker leads into the project and its
        // chats overview loads. All remaining categories are the same on both levels, so no
        // `enteredProject` branching is needed.
        if project.waitForExistence(timeout: 8) {
            project.tap()
            XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 30))
            closeDrawers(app)
            attach(app, "Live: project entered")
        } else {
            closeDrawers(app)
            print("CBASE-E2E: No project in the workspace — the project level is skipped.")
        }

        // Open every category and check for visible content.
        let categories = ["agents", "mcp", "context", "vars", "code", "terminal", "browser"]
        for category in categories {
            swipeLeftAcrossScreen(app)
            let button = app.buttons["category-\(category)"]
            guard button.waitForExistence(timeout: 8) else {
                XCTFail("Category \(category) missing")
                continue
            }
            button.tap()
            XCTAssertTrue(
                app.otherElements["top-bar"].waitForExistence(timeout: 10),
                "After switching to \(category) the header is missing"
            )
            attach(app, "Live: category \(category)")
            // The category's left drawer must open.
            swipeRightAcrossScreen(app)
            XCTAssertTrue(
                app.otherElements["left-drawer"].waitForExistence(timeout: 6),
                "Category \(category) has no left drawer"
            )
            attach(app, "Live: left drawer \(category)")
            closeDrawers(app)

            // On the REAL browser: toggle desktop view on and off again. The screenshot must
            // show a rendered page afterwards (not an empty area) — the content itself is
            // unknown here.
            if category == "browser", app.buttons["browser-desktop-toggle"].exists {
                let canvas = app.descendants(matching: .any)["browser-canvas"]
                if canvas.waitForExistence(timeout: 40) {
                    app.buttons["browser-desktop-toggle"].tap()
                    Thread.sleep(forTimeInterval: 6)
                    attach(app, "Live: browser as desktop (flipped)")
                    // Threshold deliberately low: the test does not know which page is open — it
                    // may be an almost white page (measured 0.046 for Chromium's
                    // "This site can't be reached"). Only "rendered" is to be told apart
                    // from "single-colour area" (where the share is 0).
                    let ink = inkRatio(app, in: canvas.frame)
                    XCTAssertGreaterThan(
                        ink,
                        0.008,
                        "The desktop view shows no rendered page (share \(ink))"
                    )
                    app.buttons["browser-desktop-toggle"].tap()
                    Thread.sleep(forTimeInterval: 4)
                    attach(app, "Live: browser back in phone mode")
                } else {
                    print("CBASE-E2E: No browser image — desktop view skipped.")
                }
            }
        }

        // Apps page including the left drawer.
        selectLocation(app, "apps")
        XCTAssertTrue(app.staticTexts["Projects & Stacks"].waitForExistence(timeout: 30))
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.descendants(matching: .any)["apps-sidebar-all"].waitForExistence(timeout: 8))
        closeDrawers(app)
        attach(app, "Live: apps")

        // Profile page.
        selectLocation(app, "profile")
        // The account is the only page.
        XCTAssertTrue(app.staticTexts["Account"].waitForExistence(timeout: 30))
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.buttons["profile-sub-account"].waitForExistence(timeout: 8))
        app.buttons["profile-sub-account"].tap()
        attach(app, "Live: account")

        // Click through the settings.
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8))
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        for section in ["Providers", "Models", "Hooks", "Usage", "Browser",
                        "Integrations", "Appearance", "Language", "Environment"] {
            // There are ten rows — the lower ones lie below the screen depending on the device
            // height, and `exists` would only mean "cell built" there.
            XCTAssertTrue(scrollUntilHittable(app, app.staticTexts[section]), "\(section) missing")
            app.staticTexts[section].tap()
            XCTAssertTrue(
                app.navigationBars[section].waitForExistence(timeout: 25),
                "Settings page \(section) was not opened"
            )
            attach(app, "Live: settings \(section)")

            app.navigationBars[section].buttons.element(boundBy: 0).tap()
        }
        app.buttons["Done"].tap()
    }
}
