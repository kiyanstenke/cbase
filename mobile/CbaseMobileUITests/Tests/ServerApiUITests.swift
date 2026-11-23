// UI tests for the API contract between app and server (Models/ApiContract.swift, Shell/ServerCompatibility.swift): the About
// rows in Settings, the header the app names itself with, and the app's answer to servers of other API levels — the fixture's
// `/gw/info` variants (`POST /fixture/server-api`, routes-settings.mjs): "current", "old" (no version fields), "newer"
// (`oldest: 2`) and "older" (`level: 0`).
import XCTest

final class ServerApiUITests: CbaseUITestBase {
    /// The app's version row, the server row of the current fixture server, and the header of the app's requests — the
    /// version in the header is the one the row shows.
    func testSettingsShowAppAndServerAndRequestsNameTheApp() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        XCTAssertFalse(app.otherElements["older-server-notice"].exists, "A current server must not show the older-server notice")

        let (version, build) = try openAboutRows(app)
        let serverRow = aboutRow(app, "settings-about-server")
        XCTAssertTrue(serverRow.label.contains("0.2.0+3.gabc1234 · API 1"), "Server row: \(serverRow.label)")
        attach(app, "Settings: About with version and server")

        // The fixture records the header of the app's LAST request (the test runner's /fixture/ calls do not count).
        let client = try XCTUnwrap(fixtureJSON(server + "/fixture/client"), "GET /fixture/client did not answer")
        let header = try XCTUnwrap(client["client"] as? String, "The app's last request (\(client["path"] ?? "?")) carried no X-Cbase-Client")
        XCTAssertEqual(header, "ios/\(version) (\(build)); api=1", "X-Cbase-Client outside the contract")
        XCTAssertEqual(client["userAgent"] as? String, "CbaseMobile/\(version)", "User-Agent outside the contract")
    }

    /// A server from before the version contract: no notice, no blocking, and the server row says "unknown".
    func testOldServerWithoutApiFieldsIsLevelOne() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: { self.serverVariant(server, "old") })
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "An old server must open the app as before")
        XCTAssertFalse(app.otherElements["older-server-notice"].waitForExistence(timeout: 3), "An old server counts as level 1 — no notice")
        XCTAssertFalse(app.otherElements["needs-newer-app"].exists)

        _ = try openAboutRows(app)
        let serverRow = aboutRow(app, "settings-about-server")
        XCTAssertTrue(serverRow.label.hasSuffix("unknown"), "Server row of an old server: \(serverRow.label)")
        XCTAssertFalse(serverRow.label.contains("API"), "An old server names no API level: \(serverRow.label)")
    }

    /// A server whose `oldest` is above the app's level blocks before the sign-in: title, text, the App Store button, the way to
    /// another server — and nothing of the shell.
    func testServerNeedingNewerAppBlocks() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: { self.serverVariant(server, "newer") })
        XCTAssertTrue(app.staticTexts["needs-newer-app-title"].waitForExistence(timeout: 25), "The blocking screen did not appear")
        XCTAssertEqual(app.staticTexts["needs-newer-app-title"].label, "This server needs a newer app")
        XCTAssertTrue(app.staticTexts["needs-newer-app-text"].label.contains("App Store"))
        XCTAssertTrue(app.buttons["needs-newer-app-store"].isHittable, "The App Store button is missing")
        XCTAssertFalse(app.buttons["overview-new-chat"].exists, "The shell must not open behind the blocking screen")
        XCTAssertFalse(app.secureTextFields["login-password"].exists, "The sign-in must not open behind the blocking screen")
        attach(app, "Server needs a newer app")

        app.buttons["needs-newer-app-other-server"].tap()
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 8), "The way to another server does not lead to the address")
    }

    /// A server updated WHILE the app runs: started against the current server, the fixture switches to "newer"; the next fresh
    /// `/gw/info` (Settings re-reads it on opening — `SessionStore.refreshGatewayInfo`) must block just like at launch. Before
    /// the check sat in one place for every read, only `connect` judged the range and the app kept working against it.
    func testServerUpdatedWhileRunningBlocksOnTheNextInfo() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        serverVariant(server, "newer")
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8), "The settings entry is missing in the right drawer")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.staticTexts["needs-newer-app-title"].waitForExistence(timeout: 15), "The re-read /gw/info did not block")
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForNonExistence(timeout: 5), "The shell stays open behind the blocking screen")
        attach(app, "Server updated while running: needs a newer app")
    }

    /// A server older than the app: the soft notice, the app keeps working, the notice goes away on ✕ and stays away on the next
    /// start against the same server (remembered per server and build). The build is new on every run: a dismissal stored by an
    /// earlier run must not stand in for this run's memory.
    func testOlderServerShowsSoftNoticeOnce() throws {
        let server = try requireFixture()
        let build = "0.1.5+\(Int(Date().timeIntervalSince1970)).g\(UUID().uuidString.prefix(7).lowercased())"
        var app = launchApp(server: server, preparation: { self.serverVariant(server, "older", build: build) })
        let notice = app.otherElements["older-server-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 25), "The older-server notice did not appear")
        XCTAssertEqual(
            app.staticTexts["older-server-notice-text"].label,
            "This server runs an older cbase; some features may be unavailable."
        )
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 10), "The app must keep working under the notice")
        attach(app, "Older server notice")
        app.buttons["older-server-notice-dismiss"].tap()
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5), "✕ does not dismiss the notice")

        app.terminate()
        app = launchApp(server: server, preparation: { self.serverVariant(server, "older", build: build) })
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        XCTAssertFalse(app.otherElements["older-server-notice"].waitForExistence(timeout: 3), "The dismissed notice came back on the next start")
    }

    // ── Helpers ──

    private func serverVariant(_ server: String, _ variant: String, build: String? = nil) {
        var body: [String: Any] = ["variant": variant]
        if let build { body["build"] = build }
        let answer = fixturePost(server + "/fixture/server-api", body: body)
        XCTAssertEqual(answer?["variant"] as? String, variant, "The fixture did not take the server-api variant \(variant)")
        if let build {
            XCTAssertEqual((answer?["info"] as? [String: Any])?["build"] as? String, build, "The fixture did not take the build \(build)")
        }
    }

    private func aboutRow(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Opens Settings, scrolls to the About rows and returns the version and build the version row names ("App 0.2.0 (2)").
    private func openAboutRows(_ app: XCUIApplication) throws -> (String, String) {
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8), "The settings entry is missing in the right drawer")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 12), "The settings sheet did not open")
        let serverRow = aboutRow(app, "settings-about-server")
        XCTAssertTrue(scrollUntilHittable(app, serverRow, attempts: 14), "The server row is missing in Settings → About")
        let versionRow = aboutRow(app, "settings-about-version")
        XCTAssertTrue(versionRow.exists, "The version row is missing in Settings → About")
        let label = versionRow.label
        let match = try XCTUnwrap(
            label.range(of: #"App (\S+) \((\S+)\)$"#, options: .regularExpression),
            "Version row outside \"App <version> (<build>)\": \(label)"
        )
        let parts = label[match].dropFirst(4).split(separator: " ", maxSplits: 1)
        let version = String(parts[0])
        let build = String(parts[1].dropFirst().dropLast())
        return (version, build)
    }
}
