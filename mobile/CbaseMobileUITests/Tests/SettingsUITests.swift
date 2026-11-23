// UI tests for Settings: all areas, deleting the own account (Profile → Account), usage, notifications, auto-compact, GitLab accounts, hooks, auto-continue and credit gate, OpenRouter, appearance, model settings.
import XCTest

final class SettingsUITests: CbaseUITestBase {
    // ── Settings: all areas in the groups of the desktop client ─────────────
    func testSettingsMirrorsAllDesktopSections() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 5))
        app.buttons["drawer-settings"].tap()

        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        // The order is the desktop client's — and it is READ there (through the fixture, see `desktopSettingsGroups`),
        // not copied here: `SETTINGS_GROUPS` (groups and keys) and `SECTIONS` (label per key) in
        // `web/src/components/settings/SettingsModal.tsx`, the same source against which
        // `web/test/settings-form.test.mjs` binds the SOURCE TEXT of `SettingsView.swift`.
        // This test binds what is SHOWN to it. A copy in a third place is exactly the double
        // truth the web guard is meant to prevent.
        let groups = try desktopSettingsGroups(server)
        // The group headings count too: only they prove that "Environment" sits under "Account & connections" and not just
        // somewhere between "Integrations" and "Models" — the flat sequence of pages would be the same if the headings
        // were missing or stood one row too early.
        let expected = groups.flatMap { [$0.title] + $0.pages }
        attach(app, "Settings with all areas")
        // ONE pass from top to bottom yields both: which areas exist and in which order. A presence loop alone
        // would pass just as green if someone pushed "Integrations" to the end, although the sentence above
        // promises the desktop client's order. And that is no cosmetics: on mobile one should look in the same place as on desktop.
        let seen = settingsOrder(app, expected)
        // Presence first, because it names the MISSING row — the order comparison would show only two lists that differ somewhere.
        for label in expected {
            XCTAssertTrue(
                seen.contains(label),
                "Settings area or group \(label) is missing in the mobile app"
            )
        }
        XCTAssertEqual(
            seen, expected,
            "The areas are in a different order than in the desktop client (SETTINGS_GROUPS)"
        )
        settingsRow(app, "Language").tap()
        XCTAssertTrue(app.buttons["language-de"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["language-en"].exists)
    }

    /// Groups and pages of the settings as the desktop client orders them — from
    /// `SETTINGS_GROUPS` and `SECTIONS` in `web/src/components/settings/SettingsModal.tsx`, with the same
    /// anchors as `web/test/settings-form.test.mjs` (`webGroups`).
    ///
    /// The FIXTURE reads the file (`GET /fixture/settings-ordering`, routes-devtools.mjs), fresh on every request from the
    /// working tree. Reading it here in the test runner via `#filePath` is no option — the runner runs in the simulator, and
    /// its `open()` on a file under ~/Documents hung for 13 minutes in `__open`. The fixture runs from the shell and reads
    /// the tree without asking.
    /// The label IS the dictionary key in the web (`t()` when rendering); on mobile the same string is in `L(…)` — so
    /// the English wording that the app shows is compared. An anchor that grasps nothing is a 500 with plain text at
    /// the fixture, and that text is in the message here: the silent death of a source measurement would be an empty expectation.
    private func desktopSettingsGroups(_ server: String) throws -> [(title: String, pages: [String])] {
        let (code, response) = fixtureResponse(server + "/fixture/settings-ordering")
        let raw = try XCTUnwrap(
            code == 200 ? response?["groups"] as? [[String: Any]] : nil,
            "The fixture did not deliver the settings order (HTTP \(code)): "
                + "\((response?["error"] as? String) ?? "no response") — is `/fixture/settings-ordering` "
                + "in the running fixture? An old process on port 17718 does not know the route."
        )
        let groups = raw.compactMap { g -> (title: String, pages: [String])? in
            guard let title = g["title"] as? String, let pages = g["pages"] as? [String] else { return nil }
            return (title: title, pages: pages)
        }
        XCTAssertEqual(groups.count, raw.count, "A group of the fixture response could not be read: \(raw)")
        // Without groups or without pages the comparison would be an equation of two empty lists.
        XCTAssertFalse(groups.isEmpty, "SETTINGS_GROUPS yielded not a single group")
        XCTAssertFalse(groups.contains { $0.pages.isEmpty }, "A group without a page: \(groups)")
        return groups
    }

    /// Status code AND body of a fixture request — `fixtureJSON` discards every response but 200,
    /// and with it the plain text the fixture sends when an anchor is torn.
    private func fixtureResponse(_ url: String) -> (code: Int, json: [String: Any]?) {
        guard let target = URL(string: url) else { return (0, nil) }
        let finished = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: (code: Int, json: [String: Any]?) = (0, nil)
        URLSession.shared.dataTask(with: target) { data, response, _ in
            defer { finished.signal() }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            lock.lock()
            result = (code, object)
            lock.unlock()
        }.resume()
        guard finished.wait(timeout: .now() + 4) == .success else { return (0, nil) }
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    /// Moves an element into the SAFE band — below the glass header bar of the settings sheet,
    /// above the keyboard or the home bar — before it is tapped.
    /// `isHittable` says yes below the header bar, but the tap hits the bar (the same measurement
    /// as in `flipToggle`: bar y 78–132, hence the top edge 150). With a keyboard the bottom edge is its top edge.
    /// Scrolling goes in both directions with short drags INSIDE the band: a long drag downward would
    /// pull the sheet, not the list.
    private func intoTheSafeBand(_ app: XCUIApplication, _ element: XCUIElement, attempts: Int = 8) -> Bool {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let inBand = { self.inSafeBand(app, element) }
        for _ in 0..<attempts {
            if inBand() { return true }
            guard element.exists else { return false }
            // Below: a drag upward lifts the list; above: a drag downward lowers it.
            let (top, bottom) = safeBand(app)
            let up = element.frame.midY > bottom
            let from = up ? bottom - 20 : top + 20
            let target = up ? from - 110 : from + 110
            origin.withOffset(CGVector(dx: app.frame.midX, dy: from)).press(
                forDuration: 0.02,
                thenDragTo: origin.withOffset(CGVector(dx: app.frame.midX, dy: target)),
                withVelocity: .slow,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return inBand()
    }

    /// The safe band of the settings sheet: below the glass header bar (bar y 78–132, hence 150), above the
    /// keyboard or the home bar.
    private func safeBand(_ app: XCUIApplication) -> (top: CGFloat, bottom: CGFloat) {
        let keyboard = app.keyboards.firstMatch
        let floorY = keyboard.exists && keyboard.frame.height > 0 ? keyboard.frame.minY : app.frame.maxY - 60
        return (app.frame.minY + 150, floorY - 8)
    }

    /// Is `element` in the safe band AND hittable? `isHittable` alone says yes below the header bar.
    private func inSafeBand(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let (top, bottom) = safeBand(app)
        let middle = element.frame.midY
        return middle >= top && middle <= bottom && element.isHittable
    }

    /// Scrolls in a settings list until `element` is in view and can be hit —
    /// like `roleInSheet`, but WITHOUT its waiting for `isEnabled`. Needed for a control
    /// that is deliberately disabled and that is exactly what is to be proven: `roleInSheet` would return `false`
    /// there only after its deadline, and the message would speak of a missing button.
    ///
    /// `isHittable` is asked last, after scrolling — a `List` builds its rows only on appearing, `exists` alone
    /// would mean only "cell built".
    private func roleUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, attempts: Int = 8) -> Bool {
        for _ in 0..<attempts {
            if element.exists, element.isHittable { return true }
            let start = app.keyboards.count > 0 ? 0.5 : 0.75
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start)).press(
                forDuration: 0.02,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start - 0.25)),
                withVelocity: .default,
                thenHoldForDuration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.35)
        }
        return element.exists && element.isHittable
    }

    // ── Usage: where the quota goes ─────────────────────────────────────────
    // The rings say HOW MUCH of the plan is gone, not WHAT FOR. The answer is on the provider's subpage: the equivalent as the main number, the
    // subagents' share, the chats — and how many the list does NOT show. The "Usage" page itself is a list of the five subpages of the contract, in its order.
    func testUsageShowsWhereTheQuotaGoes() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")

        // The five subpages in the order of the contract (USAGE_SUBPAGES).
        let pages = ["overview", "claude", "codex", "openrouter", "limit"]
        var top: CGFloat = -1
        for page in pages {
            let row = app.buttons["usage-page-\(page)"]
            XCTAssertTrue(row.waitForExistence(timeout: 8), "The subpage \(page) is missing from the list")
            XCTAssertGreaterThan(row.frame.minY, top, "The subpage \(page) is not in the order of the contract")
            top = row.frame.minY
        }
        attach(app, "Usage: the five subpages")

        openUsage(app, "claude", title: "Claude")
        XCTAssertTrue(app.staticTexts["usage-equivalent"].waitForExistence(timeout: 10), "The equivalent is missing as the main number")
        // The fixture names a model without a price — the number is then a lower bound and says so.
        XCTAssertTrue(app.staticTexts["usage-equivalent-lower-limit"].exists, "The equivalent hides that a price is missing")

        let share = app.staticTexts["usage-subagent-share"]
        XCTAssertTrue(roleInSheet(app, share, attempts: 10), "the subagent share is missing")
        // Fixture: 30k of 86k output come from subagents → 35 %.
        XCTAssertEqual(share.label, "35 % of output", "the share is computed wrongly")
        let chat = app.staticTexts["usage-chat-chat-1"]
        XCTAssertTrue(roleInSheet(app, chat, attempts: 10), "the chat breakdown is missing")
        // At most 25 rows — and the rest stands as a number below, never silently cut.
        let additional = app.staticTexts["usage-chats-additional"]
        XCTAssertTrue(roleInSheet(app, additional, attempts: 6), "The number of remaining chats is missing")
        XCTAssertTrue(additional.label.contains("3"), "The number of remaining chats is wrong: \(additional.label)")
        attach(app, "Usage → Claude: where the quota goes")

        // The week has no snapshot in the fixture: the bar then says "Last 7 days", not "Current week" — as soon as
        // the window is loaded. The switch reloads and must not empty the breakdown.
        let week = app.buttons["usage-window-week"]
        XCTAssertTrue(scrollUp(app, week) || roleInSheet(app, week), "The window bar is missing")
        week.tap()
        XCTAssertTrue(waitUntil(timeout: 8) { app.buttons["usage-window-week"].label == "Last 7 days" },
                      "Without a snapshot the bar claims a current window: \(app.buttons["usage-window-week"].label)")
        XCTAssertTrue(app.staticTexts["usage-window-sliding"].waitForExistence(timeout: 5), "The sentence on the sliding window is missing")
        XCTAssertTrue(roleInSheet(app, app.staticTexts["usage-subagent-share"], attempts: 10),
                      "after the window switch the section is missing")
    }

    /// A window switch aborts the running fetch — that is no error. `URLSession` throws `URLError(.cancelled)`
    /// there, not `CancellationError`; before the mapping in `APIClient.abortAsCancellation` that slipped past
    /// `catch is CancellationError`, and the week (without state yet) showed a red "aborted" instead of loading. The fixture
    /// holds every response back for 4 s; the switch comes while the first is still pending.
    // Counter-test: red without the mapping — "The aborted fetch shows as an error".
    func testWindowSwitchShowsTheAbortNotAsError() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertEqual(self.fixturePost(server + "/fixture/usage", body: ["delayMs": 4_000])?["delayMs"] as? Int,
                           4_000, "The fixture did not accept the delay")
        })
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")
        openUsage(app, "claude", title: "Claude")
        let week = app.buttons["usage-window-week"]
        XCTAssertTrue(week.waitForExistence(timeout: 5), "The window bar is missing")
        XCTAssertFalse(app.staticTexts["usage-equivalent"].exists, "The first response came before the switch — the delay is not enough")
        week.tap()
        // `firstMatch`: the label carries the identifier on image and text — `.label` on the query itself failed on two matches.
        let error = app.descendants(matching: .any).matching(identifier: "usage-error").firstMatch
        let appeared = error.waitForExistence(timeout: 3)
        attach(app, "After the window switch")
        XCTAssertFalse(appeared, "The aborted fetch shows as an error: \(appeared ? error.label : "")")
        XCTAssertTrue(app.staticTexts["usage-equivalent"].waitForExistence(timeout: 10), "The week did not arrive")
    }

    /// "null ≠ 0": for a day WITH runs but without a price the server sends `equivalentUsd: null`, for a day
    /// without runs 0. If all days with usage carry `null` (Codex with a model without a catalog price), the history shows the
    /// output and says on how many days the amount is missing. Before, "in money as soon as any day has an amount" held — the 0
    /// of the empty days sufficed, all bars were 0, and the page reported "Nothing was recorded on these days."
    // Counter-test: red without it — "The history is missing — unknown amounts showed as 0".
    func testHistoryWithoutAmountsShowsTheOutput() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertEqual(self.fixturePost(server + "/fixture/usage", body: ["historyUnknown": true])?["historyUnknown"] as? Bool,
                           true, "The fixture did not accept the switch")
        })
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")
        openUsage(app, "claude", title: "Claude")
        XCTAssertTrue(app.staticTexts["usage-equivalent"].waitForExistence(timeout: 10), "The subpage did not load")
        let history = app.descendants(matching: .any)["usage-history"]
        let found = roleInSheet(app, history, attempts: 12)
        attach(app, "History without amounts")
        XCTAssertTrue(found, "The history is missing — unknown amounts showed as 0 (\"Nothing was recorded on these days.\")")
        XCTAssertFalse(app.staticTexts["Nothing was recorded on these days."].exists, "The page reports \"nothing recorded\"")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "the amount is missing")).firstMatch.exists,
                      "The hint hides that amounts are missing")
    }

    /// On the "Usage" page opens a subpage (`usage-page-<subpage>`) and waits for its title.
    private func openUsage(_ app: XCUIApplication, _ subpage: String, title: String) {
        let row = app.buttons["usage-page-\(subpage)"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "The subpage \(subpage) is missing from the usage list")
        row.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "The subpage \(title) did not open")
    }

    // ── Header → Usage: a ring opens its subpage ────────────────────────────
    /// A tap on the ring opens the settings straight on Usage → provider (`AppState.settingsJump`
    /// "usage:codex"). Back leads to the usage list — the jump pushes the pages, it does not replace them.
    func testRingTheHeaderOpensTheSubpage() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        let ring = app.buttons["usage-ring-codex"]
        XCTAssertTrue(ring.waitForExistence(timeout: 25), "The Codex ring is missing from the header — or it is no button")
        ring.tap()
        XCTAssertTrue(app.navigationBars["Codex"].waitForExistence(timeout: 12), "The ring did not open the Codex subpage")
        XCTAssertTrue(app.staticTexts["usage-equivalent"].waitForExistence(timeout: 10), "The Codex subpage shows no equivalent")
        attach(app, "Ring → Usage → Codex")
        app.navigationBars["Codex"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Usage"].waitForExistence(timeout: 8), "Back does not lead to the usage list")
        // Opening the settings a second time starts at the list again — the jump applies ONCE.
        app.navigationBars["Usage"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 8), "The settings root is missing")
    }

    // ── Notifications ───────────────────────────────────────────────────────
    // Two levels that must be kept apart: the global default per KIND (settings)
    // and the three-valued override per CHAT. Both are checked plus the device list —
    // without it a silent push cannot be told from a switched-off one.
    func testNotificationSettingsAndPerChatOverride() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        // ── The global default per kind ──
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 5))
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        // Scrolled until the row is hittable: "Workflows" stands in the group "Behaviour", and
        // "Notifications" slipped below the edge (a bare `staticTexts[…].tap()` no longer found it).
        settingsRow(app, "Notifications").tap()

        // TEN kinds — "approval" came with the approval cards (notify.js), "manager" is gone.
        // They do not fit on one screen, and a `List` builds its rows only on appearing: the three without a chat lie below the edge and are checked
        // further down, where the test scrolls anyway. NOT scrolling here is intentional —
        // the two value checks and the tap right below need the top rows.
        for kind in ["question", "approval", "review", "finished", "workflow", "trigger"] {
            XCTAssertTrue(
                app.switches["notify-kind-\(kind)"].waitForExistence(timeout: 10),
                "The switch for the kind \(kind) is missing"
            )
        }
        // The defaults are in the server's vocabulary, not the app's: "question" on, "finished" ("Answer finished")
        // off.
        XCTAssertEqual(app.switches["notify-kind-question"].value as? String, "1", "Questions must go out by default")
        XCTAssertEqual(app.switches["notify-kind-finished"].value as? String, "0", "\"Answer finished\" must NOT push by default")

        attach(app, "Settings: notifications per kind")
        // A `Toggle` is a `switch`, not a `button` — and the cell is row-wide: a tap on its
        // MIDDLE hits the label, not the switch (the same pattern as the pin switch in the project knowledge).
        let finished = app.switches["notify-kind-finished"]
        finished.tap()
        if (finished.value as? String) != "1" {
            finished.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        XCTAssertEqual(finished.value as? String, "1", "The switch could not be flipped")
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureNotifyGlobal(server)["finished"] == true },
            "The global switch does not reach the server"
        )

        // The device list answers "does anything arrive at my phone at all?" — it stands below
        // ten switches, so scroll first: a `List` builds its rows only on appearing.
        app.swipeUp()

        // And here the kinds below the edge are finally in the tree (see above): the three without a
        // chat — and "limit", the seventh WITH a chat. It stands here and not in the loop above, because as the seventh row without scrolling it would lie below the edge and
        // the check would report "missing" where it was merely not scrolled.
        for kind in ["limit", "schedule", "service", "info"] {
            XCTAssertTrue(
                app.switches["notify-kind-\(kind)"].waitForExistence(timeout: 10),
                "The switch for the kind \(kind) is missing"
            )
        }

        // The button is at the END of the device group, and that lies deep: at the top the preview card, and every kind
        // carries its hint as a row under the title. After the one swipe above, "iPhone · sandbox" stood at the bottom edge and the
        // button below it — not built, `waitForExistence` ran eight seconds into nothing. So scroll until it is OPERABLE;
        // `exists` would mean only "cell built".
        XCTAssertTrue(
            roleInSheet(app, app.buttons["notify-test"]),
            "Without a test notification the line cannot be checked"
        )
        // The environment stands language-independent on the row ("iPhone · sandbox") — the
        // status line beside it is translated, and the simulator may speak English.
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "sandbox")).firstMatch.exists,
            "The signed-in device is missing from the list"
        )

        // ── And the override per chat ──
        app.navigationBars["Notifications"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 8))
        app.buttons["Done"].tap()
        // The right drawer is still open — the way into the settings leads through it.
        // Closed by swiping, not tapped beside it: a tap landed on an entry of the drawer.
        swipeRightAcrossScreen(app)
        XCTAssertTrue(
            waitForFixture(timeout: 5) { app.buttons.matching(identifier: "overview-chat-\(Self.fixtureChatId)").firstMatch.isHittable },
            "The drawer did not close"
        )

        let row = app.buttons.matching(identifier: "overview-chat-\(Self.fixtureChatId)").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The chat row is missing")
        // A `contextMenu` item carries NO set identifier — SwiftUI does not pass it to the UIKit action,
        // the tree holds the name of its symbol ("bell"); the search goes by LABEL. The same label is carried by the bell button
        // of the right drawer (`drawer-bell`), which also stays in the tree while closed — excluded via its identifier.
        let point = app.buttons.matching(
            NSPredicate(format: "label == %@ AND identifier != %@", "Notifications", "drawer-bell")
        ).firstMatch
        // Pressed via the COORDINATE of a leaf element of the row (the metadata text,
        // the only child with its own identifier; an element press on the text itself fails with "not hittable",
        // the row button covers its children). The slow press itself is a dice roll in this app — MEASURED:
        // the FIRST press in a fresh process was counted as a TAP in about half of the processes and opened the chat, and the
        // state STICKS to the process — where the menu came once, it came every further time; after a press counted as a tap (chat open,
        // back) it stayed a tap in most cases. Only a restart rolls anew. The cause is the
        // gesture graph that `ChatTextMarker.swift` describes for its own long press: the window pan of the drawers
        // (`HorizontalPanReader.shouldBeRequiredToFailBy`) makes every foreign long press wait for its failure, and with a
        // resting synthetic touch it fails only on lift — by then the button already has the tap. A finger never rests completely.
        // Hence: up to eight attempts, EACH in a fresh process. The proof is the menu; if it stays away eight times, the test says whether the chat opened.
        var open = false
        for attempt in 0..<8 where !open {
            if attempt > 0 {
                app.terminate()
                app.launch()
                XCTAssertTrue(row.waitForExistence(timeout: 25), "The chat overview did not come back after the restart")
                XCTAssertTrue(waitForFixture(timeout: 5) { row.isHittable }, "The chat row is not operable after the restart")
            }
            let sheet = row.staticTexts["chat-metadata-\(Self.fixtureChatId)"]
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "The chat's metadata row is missing")
            // Both menu items are measured DIFFERENTIALLY: what already stands in the tree BEFORE the press
            // can prove nothing afterwards. That is what the bell button of the right drawer hung on ("Notifications", also in the tree while
            // closed); for "Delete" there is no identifier to exclude, but the same question. If either stands beforehand, the proof
            // below is worthless — the test says so instead of turning silently green or red with the wrong message.
            let other = app.buttons.matching(NSPredicate(format: "label == %@", "Delete")).firstMatch
            let otherPrior = other.exists
            XCTAssertFalse(
                point.exists,
                "\"Notifications\" is already in the tree BEFORE the press — then the proof below proves "
                    + "no context menu (the same family as the bell button `drawer-bell`)"
            )
            sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.5)
            open = point.waitForExistence(timeout: 4)
            if !open {
                // "Menu did not come" is NOT "menu came without Notifications": the latter is
                // the product regression (the item in `ChatsOverviewPane.swift` is missing), and the
                // eight attempts would hide it behind a gesture message. If ANOTHER item of the same menu ("Delete", last entry, same file) is there NOW
                // and was not before the press, the menu is open — then red at once with its own message, no restart.
                if other.exists, !otherPrior {
                    attach(app, "Context menu without \"Notifications\"")
                    XCTFail(
                        "The context menu of the chat row is open (item \"Delete\" there), but \"Notifications\" is missing in it — "
                            + "the item in `ChatsOverviewPane.swift` (`Button(L(\"Notifications\"), systemImage: \"bell\")`) is gone"
                    )
                    return
                }
                let whereTo = row.exists ? "the row is still there, the menu did not come" : "the long press opened the chat"
                add(attachment(
                    "Attempt \(attempt + 1): \(whereTo)"
                        + (otherPrior ? " (Warning: \"Delete\" was in the tree before the press)" : ""),
                    "Context menu"
                ))
                print("Context menu attempt \(attempt + 1): \(whereTo); DeletePrior=\(otherPrior)")
            }
        }
        XCTAssertTrue(
            open,
            "\"Notifications\" is missing from the chat row's context menu — in eight fresh processes no menu came ("
                + (row.exists ? "the row is still there" : "the long press opened the chat") + ")"
        )
        point.tap()

        XCTAssertTrue(app.segmentedControls.firstMatch.waitForExistence(timeout: 10), "The sheet shows no switches")
        // An ordinary chat carries the SIX kinds from CHAT_KINDS; "question" comes first.
        // The identifier sits on the `Picker`, but XCUITest does not reliably attach it to the
        // `segmentedControl` — hence by POSITION, as everywhere in this file.
        XCTAssertEqual(app.segmentedControls.count, 6, "Six kinds hang on a chat")
        let picker = app.segmentedControls.element(boundBy: 0)
        // Three positions: Default · On · Off — also by position, the simulator may speak English.
        XCTAssertEqual(picker.buttons.count, 3, "A two-valued tick cannot express \"Default\"")
        picker.buttons.element(boundBy: 2).tap()
        // "Reset to default" is a section of its own BELOW the six kinds and only appears
        // with a deviation — with six pickers it lies below the edge. The same `List` trap as above, third place in this test: it scrolls
        // only when it is missing, otherwise the normal case scrolls for no reason.
        let reset = app.buttons["notify-chat-reset"]
        if !reset.waitForExistence(timeout: 3) { app.swipeUp() }
        XCTAssertTrue(
            reset.waitForExistence(timeout: 8),
            "A deviation must be revertible to default"
        )
        attach(app, "Chat: three-valued notification choice")
        app.buttons["Done"].tap()

        // The marker sits on the row — and only because this chat deviates from the default.
        XCTAssertTrue(
            app.images["chat-notify-marker-\(Self.fixtureChatId)"].waitForExistence(timeout: 10),
            "A muted chat carries no marker — \"why did nothing arrive here?\" would stay unanswered"
        )
    }

    /// The global defaults as the fixture gateway REALLY stored them. The switch
    /// value in the view is set optimistically — it does not prove delivery.
    // The level per app agent: in Settings → Models, beside
    // the model, stands the effort selection — on the row's EFFECTIVE model (compact context: "Auto" ⇒ Sol), with
    // the empty entry "Default · <level>", and NONE on a model without levels (auto title: Haiku 4.5). Checked at the
    // fixture: a chosen level arrives, and "Default" arrives as "" — not as an omitted key.
    func testAppAgentLevelAndDefaultInTheModelSettings() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 5))
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        app.staticTexts["Models"].tap()

        let level = app.buttons["agent-effort-compact"]
        XCTAssertTrue(level.waitForExistence(timeout: 10), "The level selection for \"Compact context\" is missing")
        XCTAssertTrue(app.buttons["agent-model-title"].waitForExistence(timeout: 5), "The \"Auto title\" row is missing")
        XCTAssertFalse(app.buttons["agent-effort-title"].exists, "Haiku 4.5 carries no levels — no selection must stand there")
        XCTAssertEqual(fixtureAgentLevel(server, "compact"), "", "Default: Standard")

        level.tap()
        let xhigh = app.buttons["X-High"]
        XCTAssertTrue(xhigh.waitForExistence(timeout: 6), "X-High is missing from the menu")
        xhigh.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureAgentLevel(server, "compact") == "xhigh" },
            "The chosen level does not arrive at the server"
        )
        attach(app, "Settings → Models: level per app agent")

        level.tap()
        let standard = app.buttons["Default · Medium"]
        XCTAssertTrue(standard.waitForExistence(timeout: 6), "The empty entry is not called \"Default · <level>\" (Sol: Medium)")
        standard.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureAgentLevel(server, "compact") == "" && self.fixtureAgentPutLevel(server, "compact") == "" },
            "\"Default\" does not arrive at the server explicitly as an empty level"
        )
    }

    /// The saved level of an app agent at the fixture ("" = default).
    private func fixtureAgentLevel(_ server: String, _ key: String) -> String? {
        (fixtureJSON(server + "/api/agent-models")?["efforts"] as? [String: Any])?[key] as? String
    }

    /// The field `effort` of the LAST PUT body of this key — nil if the key was missing.
    private func fixtureAgentPutLevel(_ server: String, _ key: String) -> String? {
        ((fixtureJSON(server + "/api/agent-models")?["lastPut"] as? [String: Any])?[key] as? [String: Any])?["effort"] as? String
    }

    // Auto-compact: the global level in Settings → Models and the
    // three-valued choice per chat (Default · Off · level) in the chat menu. The mechanism sits in the
    // server — here it is only checked that both ways store their value there.
    func testAutocompactSettingAndPerChatOverride() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        // ── The global level ──
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 5))
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        app.staticTexts["Models"].tap()
        let global = app.buttons["autocompact-global"]
        XCTAssertTrue(global.waitForExistence(timeout: 10), "The picker for the global level is missing")
        // Default off — the house's behaviour changes only when someone sets it.
        XCTAssertEqual(fixtureAutocompact(server), 0)
        global.tap()
        // A menu picker: the levels appear as buttons with their label.
        let sixty = app.buttons["60 %"]
        XCTAssertTrue(sixty.waitForExistence(timeout: 6), "The 60 % level is missing from the menu")
        sixty.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureAutocompact(server) == 60 },
            "The global level does not arrive at the server"
        )
        // The absolute cap stands beside it and is also a menu picker.
        let cap = app.buttons["autocompact-max"]
        XCTAssertTrue(cap.waitForExistence(timeout: 6), "The picker for the cap is missing")
        cap.tap()
        let threeHundred = app.buttons["300k"]
        XCTAssertTrue(threeHundred.waitForExistence(timeout: 6), "The cap level 300k is missing from the menu")
        threeHundred.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureAutocompactMax(server) == 300_000 },
            "The global cap does not arrive at the server"
        )
        attach(app, "Settings: auto-compact")

        // ── And the choice per chat ──
        app.navigationBars["Models"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 8))
        app.buttons["Done"].tap()
        swipeRightAcrossScreen(app)
        let row = app.buttons.matching(identifier: "overview-chat-\(Self.fixtureChatId)").firstMatch
        XCTAssertTrue(
            waitForFixture(timeout: 5) { row.isHittable },
            "The drawer did not close"
        )
        row.tap()
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15), "The chat menu is missing")
        // The threshold stands as a tick on the context track — it follows the default (60 %).
        XCTAssertTrue(app.otherElements["autocompact-marker"].waitForExistence(timeout: 8) || app.images["autocompact-marker"].exists,
                      "Without a marker one cannot see where cbase will compact")
        app.buttons["chat-menu"].tap()
        let submenu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Auto-compact")).firstMatch
        XCTAssertTrue(submenu.waitForExistence(timeout: 6), "The submenu \"Auto-compact\" is missing from the chat menu")
        // The label carries the effective level — here the default.
        XCTAssertTrue(submenu.label.contains("60"), "The label does not name the effective level: \(submenu.label)")
        // Since iOS 26.5 the first tap on a submenu row of a menu only marks it; the submenu opens with the next one
        // (the reference app fails the same way). So tap until the row inside appears.
        let shareProbe = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Share of the window")).firstMatch
        for _ in 0..<3 where !shareProbe.exists {
            submenu.tap()
            _ = shareProbe.waitForExistence(timeout: 2)
        }
        // The levels sit in ONE submenu per control — twenty cap levels next to seven share levels
        // would be a menu one scrolls through.
        let shareMenu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Share of the window")).firstMatch
        XCTAssertTrue(shareMenu.waitForExistence(timeout: 6), "The \"Share of the window\" control is missing")
        XCTAssertTrue(shareMenu.label.contains("60"), "The label does not name the effective share: \(shareMenu.label)")
        shareMenu.tap()
        let offButton = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Off", "Off")).firstMatch
        XCTAssertTrue(offButton.waitForExistence(timeout: 6), "The \"Off\" position is missing")
        offButton.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureChatAutocompact(server) == 0 },
            "The choice per chat does not arrive at the server (expected 0 = off)"
        )
        // The share is off — the global CAP (300k) still holds, so the marker still stands.
        // That was exactly the measured bug: one control switched the other off.
        XCTAssertTrue(app.otherElements["autocompact-marker"].waitForExistence(timeout: 6) || app.images["autocompact-marker"].exists,
                      "The cap must keep applying when only the share is off")
        attach(app, "Chat: share off, cap holds")

        // The chat is fully off only with BOTH controls — that is what the one tap is for.
        app.buttons["chat-menu"].tap()
        let menu2 = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Auto-compact")).firstMatch
        XCTAssertTrue(menu2.waitForExistence(timeout: 6))
        menu2.tap()
        let fullyOff = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Off for this chat", "Off for this chat")).firstMatch
        XCTAssertTrue(fullyOff.waitForExistence(timeout: 6), "\"Off for this chat\" is missing")
        fullyOff.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 5) { self.fixtureChatAutocompactMax(server) == 0 },
            "The cap per chat does not arrive at the server"
        )
        XCTAssertTrue(
            waitForFixture(timeout: 5) { !app.otherElements["autocompact-marker"].exists && !app.images["autocompact-marker"].exists },
            "With both controls on \"Off\" no threshold may remain on the track"
        )
        attach(app, "Chat: auto-compact fully off")
    }

    // ── Integrations: the GitLab accounts ───────────────────────────────────
    /// The accounts that the workflow triggers hang on are now central on mobile — with
    /// checking, token replacement and deletion. The token never leaves the server: the row says only
    /// THAT one is stored, and this test checks exactly that too.
    ///
    /// The check run goes through BOTH outcomes here — success, revoked token, success.
    /// It is the only route of this page that also answers with HTTP 200 on failure;
    /// which part of that the row really proves is noted below at the spot.
    func testIntegrationsGitlabAccounts() throws {
        let server = try requireFixture()
        // Set the state at the START, do not take it back via `defer`: the suite runs with
        // `continueAfterFailure = false`, a failure aborts by exception and would skip
        // every `defer`.
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Integrations")
        // Integrations is a list of services; GitLab has its own page behind it.
        let gitlab = app.buttons["integration-gitlab"]
        XCTAssertTrue(gitlab.waitForExistence(timeout: 15), "The integrations list does not name GitLab")
        gitlab.tap()
        XCTAssertTrue(app.navigationBars["GitLab"].waitForExistence(timeout: 15), "The GitLab page was not opened")

        // ── The seeded account is there, with a mark instead of a token ──
        let account = app.staticTexts["gitlab-account-\(Self.fixtureGitlabAccountId)"]
        XCTAssertTrue(account.waitForExistence(timeout: 15), "The connected GitLab account is missing")
        XCTAssertEqual(account.label, "Examplecorp", "The row does not carry the account's name")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "token stored")).firstMatch.exists,
            "Without the mark an account without a token cannot be told from one with"
        )
        XCTAssertFalse(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "glpat-")).firstMatch.exists,
            "The token must appear nowhere in the view"
        )
        attach(app, "Integrations: connected GitLab accounts")

        // ── "Check" arrives at the server ──
        // The text on the row does not prove delivery; the fixture's counter does.
        let check = app.buttons["gitlab-test-\(Self.fixtureGitlabAccountId)"]
        XCTAssertTrue(roleInSheet(app, check), "The check button is not reachable")
        check.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { self.fixtureGitlab(server)["tests"] as? Int == 1 },
            "The check run did not reach the server"
        )
        // And WORD FOR WORD: the success sentence arises from the view's `ok` branch and
        // carries the user name from the RESPONSE. Checking only its presence would have let
        // an error message pass too.
        let statusLine = app.staticTexts["gitlab-status-\(Self.fixtureGitlabAccountId)"]
        XCTAssertTrue(statusLine.waitForExistence(timeout: 8),
                      "The result of the check run is not on the row")
        XCTAssertEqual(statusLine.label, "Connection works — @maintainer",
                       "The success case does not name the user from the response")

        // ── The error branch: HTTP 200 with `ok: false` ──
        // Through the app no bad token gets into the stock — creating checks it beforehand.
        // The case arises for real when a valid token is revoked LATER,
        // and exactly that is what `POST /fixture/gitlab { valid: false }` produces.
        //
        // What this round proves, and what NOT: the message that then stands red on the row
        // comes from the account's `status` field that the server writes on the check run — so it proves that the app RELOADS after checking (without the
        // reload it would not exist) and that a failed run becomes visible as an error. It does NOT prove that the view decides via `ok` and not via the status code:
        // `statusLine(_:)` lets the stored server error win against the session result, so a blind "HTTP 200 = works" would stand behind
        // the same red line. The distinction is observable only in the SUCCESS case —
        // there the sentence above carries the user name from the response, which does not exist in the error case.
        XCTAssertNotNil(
            fixturePost(server + "/fixture/gitlab",
                        body: ["id": Self.fixtureGitlabAccountId, "valid": false]),
            "The fixture did not accept the revocation of the token"
        )
        XCTAssertTrue(roleInSheet(app, check), "The check button stayed disabled after the first run")
        check.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { statusLine.label == "Token ungültig oder abgelaufen (401)." },
            "A rejected token must stand red on the account row, was: \(statusLine.label)"
        )
        attach(app, "Integrations: account with revoked token")

        // ── And back again ──
        // The counter-check to the line before: if the error still stood after a successful run,
        // the view would have remembered it instead of fetching it from the server.
        XCTAssertNotNil(
            fixturePost(server + "/fixture/gitlab",
                        body: ["id": Self.fixtureGitlabAccountId, "valid": true]),
            "The fixture did not accept the undoing of the revocation"
        )
        XCTAssertTrue(roleInSheet(app, check), "The check button stayed disabled after the failed run")
        check.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { statusLine.label == "Connection works — @maintainer" },
            "After a successful check run the old error must disappear, was: \(statusLine.label)"
        )
        XCTAssertEqual(fixtureGitlab(server)["tests"] as? Int, 3,
                       "Exactly three check runs should have arrived at the server")

        // ── Connect a second account — the error path first ──
        let add = app.buttons["gitlab-add"]
        XCTAssertTrue(roleInSheet(app, add), "\"Connect GitLab\" is missing")
        add.tap()
        XCTAssertTrue(app.navigationBars["Connect GitLab"].waitForExistence(timeout: 8),
                      "The connect sheet did not open")
        // Token field first, then the name: the name field stands ABOVE and so stays
        // visible when the keyboard comes up. The other way round the token would lie behind it.
        let token = app.secureTextFields["gitlab-add-token"]
        XCTAssertTrue(token.waitForExistence(timeout: 8), "The token field is missing")
        token.tap()
        app.typeText("wrong")
        closePasswordSuggestion(app)
        let name = app.textFields["gitlab-add-label"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "The name field is missing")
        name.tap()
        app.typeText("Fixture-GitLab")
        app.buttons["gitlab-add-submit"].tap()
        XCTAssertTrue(
            app.staticTexts["gitlab-add-error"].waitForExistence(timeout: 10),
            "A rejected token must show as an error in the sheet, not vanish silently"
        )
        attach(app, "Integrations: rejected token")

        // ── And now properly ──
        // Replace a prefilled field: tap at the RIGHT edge (the middle puts the caret at the
        // start), delete generously — a SecureField does not report its content, so the count
        // may guess.
        token.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30))
        app.typeText("glpat-fixture")
        app.buttons["gitlab-add-submit"].tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureGitlab(server)["accounts"] as? [[String: Any]])?.count == 2
            },
            "The new account did not arrive at the server"
        )
        let second = app.staticTexts["gitlab-account-\(Self.fixtureGitlabAccountId2)"]
        XCTAssertTrue(second.waitForExistence(timeout: 10), "The new account is not in the list")
        XCTAssertEqual(second.label, "Fixture-GitLab", "The typed name did not come along")
        attach(app, "Integrations: second account created")
    }

    // ── Hooks: key and permanent approvals ──────────────────────────────────
    /// Reading aloud, web search and the permanent tool approvals are under
    /// "Hooks" on mobile as on the web. Two promises are checked here: a key never leaves the server (the
    /// page shows only THAT one is stored, and "Load voices" exists only then), and
    /// the approval list can be extended and cleared again — down to the empty state, which
    /// says what applies then.
    func testHooksKeyAndPermanentApprovals() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Hooks")

        // ── Permanent approvals: the seed carries exactly one rule ──
        let first = app.staticTexts["permrule-0"]
        XCTAssertTrue(roleInSheet(app, first), "The existing approval is missing")
        XCTAssertEqual(first.label, "Bash(git status:*)", "The rule is not there word for word")

        let field = app.textFields["permrule-input"]
        XCTAssertTrue(roleInSheet(app, field), "The input field for a new approval is missing")

        // Two birds, one claim: without input no empty rule may be submittable —
        // and a disabled button must be visible from outside AS disabled. The button is visible and hittable
        // beside the field; `isEnabled` alone distinguishes it from one that works. That is exactly what `roleInSheet`
        // waits for, so that a tap does not go nowhere while a block is still loading. If SwiftUI did not report a `.disabled`
        // as `isEnabled == false`, this wait condition would be a claim without a measurement — and this line would fail instead of hiding it.
        //
        // The BUTTON is searched, not only the field: above the approvals stands the hooks page's event chain, and after a swipe the input row lay
        // measured at the bottom edge (the row "Bash(git status:*)" at y ≈ 830 of 874). The field counted as `isHittable` there, the
        // button in the same row did not (why XCUITest judges the two differently is not measured). So it scrolls until the button, without
        // waiting for `isEnabled` (`roleInSheet` would, and would run into its deadline at this deliberately disabled button); the claim stays the old one and stands at the end.
        let create = app.buttons["permrule-add"]
        XCTAssertTrue(roleUntilHittable(app, create), "\"Add\" does not stand beside the field")
        XCTAssertTrue(field.isHittable, "After scrolling to the button the field beside it is no longer operable")
        XCTAssertFalse(create.isEnabled, "Without input no empty approval may be submittable")

        field.tap()
        app.typeText("Read(src/**)")
        // THE PROMISE: after typing, "Add" is reachable — in the safe band between the glass header bar and the keyboard —
        // WITHOUT the test scrolling. On the FIRST appearance of the keyboard in a run, the list's keyboard avoidance pushed the row, measured
        // five times in twelve, BEHIND the header bar (bar y 78–132, button y 80–101) — there the button reported
        // `isHittable` and the tap hit the bar. The product now fixes it (`HooksApprovalsSection` scrolls the input row
        // to the middle after the keyboard appears), and this line holds it. The band is measured (`inSafeBand`), not `isHittable` alone; the position is logged as a measurement line.
        let reachable = waitForFixture(timeout: 5) { self.inSafeBand(app, create) }
        let band = safeBand(app)
        print("[Hooks] \"Add\" after typing: y \(Int(create.frame.minY))–\(Int(create.frame.maxY)), "
              + "Band \(Int(band.top))–\(Int(band.bottom)), im Band: \(reachable)")
        XCTAssertTrue(reachable, "\"Add\" is not in the band between header bar and keyboard after typing "
                      + "(Button y \(Int(create.frame.minY))–\(Int(create.frame.maxY)), Band \(Int(band.top))–\(Int(band.bottom)))")
        XCTAssertTrue(getsOperable(create, timeout: 5), "With input \"Add\" must be enabled")
        create.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["permissionRules"] as? [String])
                    == ["Bash(git status:*)", "Read(src/**)"]
            },
            "The new approval did not arrive at the server"
        )
        attach(app, "Hooks: permanent approvals")

        // ── And clear again — both, down to the empty state ──
        for pass in 0..<2 {
            let removeButton = app.buttons["permrule-remove-0"]
            XCTAssertTrue(roleInSheet(app, removeButton), "The remove button is missing (pass \(pass))")
            // The same keyboard is still up (the field keeps focus) — so the same band.
            XCTAssertTrue(intoTheSafeBand(app, removeButton), "\"Remove\" lies behind the header bar or keyboard (pass \(pass))")
            removeButton.tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["permissionRules"] as? [String])?.isEmpty == true
            },
            "Removing did not reach the server"
        )
        XCTAssertTrue(
            app.staticTexts["permrule-empty"].waitForExistence(timeout: 8),
            "An empty list must say that every sensitive call is now asked about"
        )

        // ── Web search: the provider decides which fields belong ──
        // DuckDuckGo needs no key; a field that stood there anyway would invite entering a key
        // that nobody uses.
        let provider = app.buttons["websearch-provider"]
        XCTAssertTrue(roleInSheet(app, provider), "The web search provider is missing")
        XCTAssertFalse(app.secureTextFields["websearch-key"].exists,
                       "No key field must stand for DuckDuckGo")
        provider.tap()
        let brave = app.buttons["Brave Search API"]
        XCTAssertTrue(brave.waitForExistence(timeout: 8), "Brave is missing from the provider list")
        brave.tap()
        _ = brave.waitForNonExistence(timeout: 6)
        XCTAssertTrue(app.secureTextFields["websearch-key"].waitForExistence(timeout: 8),
                      "Brave comes with a key field")
        // Nothing is typed into the key field HERE ON PURPOSE: iOS puts its "Use Strong Password?" sheet over
        // a SecureField in a form — it covers half the screen and swallows the next tap. What is checked
        // is what the provider decides: that the field appears and that the choice arrives at the server.
        // A key goes out via the read-aloud block.
        let searchSave = app.buttons["websearch-save"]
        XCTAssertTrue(scrollUp(app, searchSave) || roleInSheet(app, searchSave),
                      "\"Save\" of the web search is not reachable")
        searchSave.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["webSearch"] as? [String: Any])?["provider"] as? String == "brave"
            },
            "The web search setting did not arrive at the server"
        )
        attach(app, "Hooks: web search via Brave")

        // ── Read aloud: without a key there is no voice list ──
        // The server answers 409 there — a button that triggers that would be an invitation
        // to an error message for no reason.
        let key = app.secureTextFields["tts-key"]
        XCTAssertTrue(roleInSheet(app, key), "The ElevenLabs key field is missing")
        XCTAssertFalse(app.buttons["tts-load-voices"].exists,
                       "Without a key \"Load voices\" must not be offered")
        XCTAssertFalse(app.staticTexts["tts-has-key"].exists,
                       "Without a key the \"Key stored\" mark must not stand")
        key.tap()
        app.typeText("sk-fixture")
        closePasswordSuggestion(app)
        let save = app.buttons["tts-save"]
        XCTAssertTrue(roleInSheet(app, save), "\"Save\" of read-aloud is not reachable")
        save.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["tts"] as? [String: Any])?["hasKey"] as? Bool == true
            },
            "The ElevenLabs key did not arrive at the server"
        )
        XCTAssertTrue(app.staticTexts["tts-has-key"].waitForExistence(timeout: 8),
                      "After saving the \"Key stored\" mark must stand")

        // ── Now the page carries the button — and the voices come ──
        let load = app.buttons["tts-load-voices"]
        XCTAssertTrue(roleInSheet(app, load), "\"Load voices\" is missing despite a key")
        load.tap()
        // Only with a loaded list does the text field become a picker — success is readable
        // from that, without listening to a status line.
        let voice = app.buttons["tts-voice"]
        XCTAssertTrue(voice.waitForExistence(timeout: 12), "The loaded voices do not turn the field into a picker")
        voice.tap()
        let bella = app.buttons["Bella"]
        XCTAssertTrue(bella.waitForExistence(timeout: 8), "The loaded voices are not in the picker")
        bella.tap()
        // Only when the menu is really closed does the next move land in the list and not in the
        // closing menu.
        _ = bella.waitForNonExistence(timeout: 6)
        // "Save" sits ABOVE "Load voices" — after the way here it lies above
        // the picture, and scrolling down would never find it.
        XCTAssertTrue(scrollUp(app, save) || roleInSheet(app, save),
                      "\"Save\" is not reachable after the voice choice")
        save.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["tts"] as? [String: Any])?["voiceId"] as? String == "EXAVITQu4vr4xnSDxMaL"
            },
            "The chosen voice did not arrive at the server"
        )
        attach(app, "Hooks: read-aloud with loaded voices")
    }

    // ── Hooks: the event list comes from the server ─────────────────────────
    /// `HooksSettingsView` carries three events hard-wired (`PreToolUse`, `PostToolUse`,
    /// `UserPromptSubmit`) and replaces them with the list from `GET /api/agent-hooks` as soon as
    /// one arrives. The real server knows NINE (`HOOK_EVENTS` in server.js) — a hook on
    /// `SessionStart` or `PreCompact` can be created on mobile only if the response is really
    /// read.
    ///
    /// The fallback itself is right and stays: an older server without the route would otherwise
    /// leave the page with an empty choice. But it is also the reason an error would be
    /// silent here — the view would look the same, only with six events fewer. So it is checked by two names
    /// that do NOT occur in the fallback.
    func testHooksEventsComeFromServer() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Hooks")

        // A hook comes into being only on a button press — without it there is no event picker.
        // Nothing is saved: the stock stays empty, and the next test finds it so.
        let create = app.buttons["hook-add"]
        XCTAssertTrue(roleInSheet(app, create), "\"+ Hook\" is missing on the hooks page")
        create.tap()

        // The picker carries no identifier; it is searched by its label. A menu picker
        // in a list shows label AND chosen value on the same row, so the label
        // begins with "Event" but ends differently depending on the iOS revision.
        let picker = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Event"))
            .firstMatch
        XCTAssertTrue(roleInSheet(app, picker), "The new hook carries no event picker")
        picker.tap()

        // Two names from the second half of the server list. They are expressly NOT in the view's
        // hard-coded fallback — only with the response read are they here.
        for event in ["SessionStart", "PreCompact"] {
            XCTAssertTrue(
                app.buttons[event].waitForExistence(timeout: 8),
                "The event \(event) is missing from the picker — the view uses its fallback instead of the server list"
            )
        }
        attach(app, "Hooks: the server's event list")

        // Close the menu again, otherwise it lies over the list when the app ends.
        let sessionStart = app.buttons["SessionStart"]
        sessionStart.tap()
        _ = sessionStart.waitForNonExistence(timeout: 6)
        XCTAssertTrue(
            waitUntil(timeout: 5) { picker.exists && (picker.label + ((picker.value as? String) ?? "")).contains("SessionStart") },
            "The choice did not arrive at the picker: \(picker.label) / \(String(describing: picker.value))"
        )
    }

    // ── Usage → At the limit: continue automatically ────────────────────────
    /// The global switch is in "Usage" on mobile, as on the web — on its subpage "At the limit". Off switches off only the WAITING — waiting runs
    /// are released, and exactly that the wait list must show.
    ///
    /// EXCEPT those parked by the credit gate: they belong to the switch
    /// below and stay. That is why a SECOND chat waits at the gate here — the list
    /// must still lead it after switching off, while the time-limit row disappears. Before,
    /// the view emptied the list by hand and would have swallowed it too.
    func testAutoContinueToggleAndWaitlist() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")

        let gateChatId = "82000000-0000-4000-8000-000000000001"
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/limit-wait", body: [
                    "chatId": gateChatId, "gate": true, "reason": "credit", "group": "session",
                    "limitText": "5-hour limit", "dueAt": (Date().timeIntervalSince1970 + 3600) * 1000,
                ]),
                "The fixture did not accept the gate waiting state"
            )
        })
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")
        openUsage(app, "limit", title: "At the limit")

        // Default ON — the seed carries a waiting run.
        //
        // The two limit switches are at the top of the subpage. Scrolling happens anyway: a `List` builds its rows only on appearing, and only the appearing
        // of the row loads its state (`.task` on the row) — until then the switch is disabled, and `roleInSheet` waits
        // for exactly that.
        let toggle = app.switches["usage-auto-continue-toggle"]
        XCTAssertTrue(roleInSheet(app, toggle, attempts: 14), "The auto-continue switch is missing")
        XCTAssertTrue(
            waitForFixture(timeout: 8) { (toggle.value as? String) == "1" },
            "By default the app waits at the limit"
        )
        // The wait list stands BELOW the two switches, and their hint is long (cut to three lines) — the
        // list thus lies below the screen edge. A `List` builds its rows only on appearing:
        // without scrolling one would check the absence of a row that is merely not built yet.
        let waiting = app.buttons["usage-limit-wait-\(Self.fixtureChatId)"]
        XCTAssertTrue(roleInSheet(app, waiting), "The waiting run is missing from the list")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "5-hour limit")).firstMatch.exists,
            "Without the limit in plain text the row does not say what is being waited for"
        )
        let atGate = app.buttons["usage-limit-wait-\(gateChatId)"]
        XCTAssertTrue(roleInSheet(app, atGate), "The chat parked by the gate is missing from the list")
        // Depending on the build the text hangs on the button or stands as an element of its own below —
        // so both places are searched.
        XCTAssertTrue(
            atGate.label.contains("Credit gate")
                || app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Credit gate")).firstMatch.exists,
            "The gate row does not say WHO parked: \(atGate.label)"
        )
        attach(app, "Usage: continue automatically at the limit")

        // ── Switch off ──
        // The INNER switch is tapped, not the row (see `flipToggle`).
        XCTAssertTrue(flipToggle(app, toggle), "The auto-continue switch is not tappable")
        XCTAssertTrue(
            waitForFixture(timeout: 4) { (toggle.value as? String) == "0" },
            "The switch could not be flipped"
        )
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["autoContinue"] as? [String: Any])?["enabled"] as? Bool == false
            },
            "The switch does not arrive at the server"
        )
        // Off means: the time-limit row is gone — the gate row is NOT. The
        // list comes from the server after flipping, not from the view's hand.
        XCTAssertTrue(
            waitForFixture(timeout: 8) { !waiting.exists },
            "With waiting switched off the time-limit row must not stand"
        )
        XCTAssertTrue(
            roleInSheet(app, atGate),
            "The row parked by the gate vanished with the auto-continue switch — it belongs to the gate, not to it"
        )
        attach(app, "Usage: waiting switched off, gate row stays")
        XCTAssertNotNil(fixturePost(server + "/fixture/limit-wait", body: ["clear": true]), "Clean-up failed")
    }

    // ── Usage → At the limit: a wait row leads into its chat ────────────────
    /// The wait list is tappable in BOTH clients: a tap closes the settings
    /// and opens the waiting chat by the same way as a notification (`AutoContinueSection.chatOpen` →
    /// `openPushPayload`). Measured by the effect: the settings sheet is gone, the chat's composer is there.
    func testAtLimitWaitRowOpensTheChat() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")
        openUsage(app, "limit", title: "At the limit")

        let waiting = app.buttons["usage-limit-wait-\(Self.fixtureChatId)"]
        XCTAssertTrue(roleInSheet(app, waiting, attempts: 12), "The waiting run is missing from the list")
        attach(app, "At the limit: wait list before the tap")
        waiting.tap()
        XCTAssertTrue(waitUntilGone(app.navigationBars["At the limit"], timeout: 10), "The tap on the wait row left the settings open")
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20),
                      "The tap on the wait row did not open the waiting chat")
        XCTAssertFalse(app.navigationBars["Settings"].exists, "The settings sheet still stands over the chat")
        attach(app, "At the limit: the waiting chat is open")
    }

    // ── Usage: the credit gate and the credit balance ───────────────────────
    /// Two things that belong together: the switch "from N % start no new turn" and the row that says how much
    /// credit there is at all. Without the number beside it the setting is a bet.
    ///
    /// On two subpages of Usage: the credit balance belongs
    /// to Claude (group "Limits", beside all windows of the last snapshot), the switch to "At the limit". Checked
    /// in this order — first Claude, back, then At the limit.
    ///
    /// The percent mark deliberately is NOT a literal in the app: it comes with the route
    /// (`threshold`), so there are not two places where 99 is maintained. Exactly that
    /// the label checks here.
    func testCreditGateToggleAndCreditStatus() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Usage")
        openUsage(app, "claude", title: "Claude")

        // ── The credit balance — on the Claude subpage, group "Limits" ──
        // `active: true` in the seed is the condition for the row to appear at all:
        // `active: false` would mean "this account has no credit pot at all" — and not "credit
        // used up". The identifier sits on a stack and thus moves onto its texts —
        // hence `firstMatch`, otherwise `isHittable` would be ambiguous. The group is at the end of the page: scrolling happens until
        // the row is hittable (a `List` builds it only on appearing).
        let credit = app.descendants(matching: .any).matching(identifier: "usage-credit").firstMatch
        XCTAssertTrue(roleUntilHittable(app, credit, attempts: 14), "The credit balance is missing on the Claude subpage")
        // Searched ONLY in the credit row: the limits' session window is also at 12 % in the fixture, and a
        // search over the whole page would find its row.
        let inState = { (text: String) in
            app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "usage-credit", text)).firstMatch.exists
        }
        XCTAssertTrue(inState("12 %"), "The credit's utilisation is not there")
        XCTAssertTrue(inState("spent"),
                      "Amount spent and cap are missing — without them the percentage does not say what it talks about")
        attach(app, "Usage → Claude: credit balance among the limits")
        app.navigationBars["Claude"].buttons.element(boundBy: 0).tap()
        openUsage(app, "limit", title: "At the limit")

        // ── The switch on "At the limit" ──
        // Default OFF — and the reverse of the switch above. A gate nobody has set must slow
        // nothing. Scrolling happens until it is OPERABLE: the row loads its state
        // only on appearing, and until then a "—" stands instead of the switch.
        let gate = app.switches["usage-credit-gate-toggle"]
        XCTAssertTrue(roleInSheet(app, gate, attempts: 14), "The credit gate switch is missing")
        XCTAssertTrue(
            waitForFixture(timeout: 8) { (gate.value as? String) == "0" },
            "The gate's default is OFF"
        )
        // The mark comes from the server: 99 is in the label without the app knowing it.
        // The label of the SWITCH is read, not a text of its own beside it: the title stands
        // beside the switch (`labelsHidden`), and the accessibility label carries it expressly (`accessibilityLabel(gateTitle)`).
        XCTAssertTrue(
            waitUntil(timeout: 8) { gate.label.contains("99") },
            "The server's percent mark is not in the label: \(gate.label)"
        )
        attach(app, "Usage: credit gate")

        // ── Switch on ──
        // The INNER switch is tapped, in the safe band between header bar and home bar
        // (see `flipToggle`): `isHittable` on a row says yes even behind the glass header bar.
        XCTAssertTrue(flipToggle(app, gate), "The gate switch is not reachable after scrolling")
        XCTAssertTrue(
            waitForFixture(timeout: 4) { (gate.value as? String) == "1" },
            "The gate switch could not be flipped"
        )
        // Checked at the SERVER, not at the view: the switch value is set optimistically
        // and does not prove delivery.
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["creditGate"] as? [String: Any])?["enabled"] as? Bool == true
            },
            "The enabled gate does not arrive at the server"
        )
        // And the switch beside it stays as it was — two settings, not one.
        XCTAssertEqual(app.switches["usage-auto-continue-toggle"].value as? String, "1",
                       "The gate also flipped the auto-continue switch")

        // Back to the default: `/fixture/reset-run` restores it at the next start anyway,
        // but a test should not rely on its successor cleaning up.
        _ = flipToggle(app, gate)
        _ = waitForFixture(timeout: 4) { (gate.value as? String) == "0" }
    }

    // ── Providers: the fixed OpenRouter card ────────────────────────────────
    /// The card for the fixed OpenRouter provider (the editor for free providers is gone: only
    /// openrouter/claude/codex work), on the way a user goes: store a key,
    /// flip a privacy switch, SEARCH the default model in the catalog (the searchable sheet,
    /// Kit/ModelSelection.swift), remove the key again. Every effect measured at the SERVER (`/fixture/settings` →
    /// `openrouter`, `defaultModel`): a switch value in the view is optimistic and does not prove delivery.
    ///
    /// The contract of the PUT (OPENROUTER_PUT_REQUIRED) says: BOTH switches in every body, `apiKey` only with a new key
    /// — the fixture rejects a body without a switch with 400, and `lastPut.apiKey` says whether one came along.
    func testOpenRouterCardKeyToggleAndModel() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")
        let access = { (self.fixtureSettings(server)?["openrouter"] as? [String: Any]) ?? [:] }
        XCTAssertEqual(access()["keySet"] as? Bool, false, "Precondition: no key by default")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Providers")

        // No way to add a provider any more.
        XCTAssertFalse(app.buttons["provider-add"].exists, "\"Add provider\" is back")
        let status = app.staticTexts["openrouter-status"]
        XCTAssertTrue(roleUntilHittable(app, status, attempts: 14), "The OpenRouter card is missing")
        XCTAssertEqual(status.label, "No key", "Without a key the card says so")

        // ── Store a key ──
        let field = app.secureTextFields["openrouter-key"]
        XCTAssertTrue(roleUntilHittable(app, field), "The key field is missing")
        field.tap()
        app.typeText("sk-or-uitest-fixture")
        let save = app.buttons["openrouter-key-save"]
        XCTAssertTrue(roleUntilHittable(app, save), "\"Save\" at the key field is missing")
        save.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                let z = access()
                let put = z["lastPut"] as? [String: Any]
                return z["keySet"] as? Bool == true && put?["apiKey"] as? Bool == true
                    && put?["onlyWithoutSaving"] as? Bool == true && put?["noDataUsage"] as? Bool == true
            },
            "The key did not arrive at the server with both switches: \(access())"
        )
        XCTAssertTrue(waitUntil(timeout: 8) { app.staticTexts["openrouter-status"].label == "Key stored" },
                      "After saving the card does not say that a key is stored")
        attach(app, "Providers: OpenRouter with key")

        // ── One switch: the body carries BOTH, and NO key ──
        let zdr = app.switches["openrouter-zdr"]
        XCTAssertTrue(roleInSheet(app, zdr), "The switch \"Only providers without data retention\" is missing")
        XCTAssertEqual(zdr.value as? String, "1", "The fixture's default: on")
        XCTAssertTrue(flipToggle(app, zdr), "The switch is not tappable")
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                let z = access()
                let put = z["lastPut"] as? [String: Any]
                return z["onlyWithoutSaving"] as? Bool == false && z["noDataUsage"] as? Bool == true
                    && put?["apiKey"] as? Bool == false && z["keySet"] as? Bool == true
            },
            "The switch did not arrive at the server (or with a key, or without the second switch): \(access())"
        )

        // ── The default model from the whole catalog: with search ──
        let model = app.buttons["default-model-openrouter"]
        XCTAssertTrue(roleInSheet(app, model, attempts: 10), "OpenRouter's \"Default model\" row is missing")
        model.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 8), "OpenRouter's model choice has no search")
        search.tap()
        app.typeText("kimi")
        let hits = app.buttons["model-choice-moonshotai/kimi-k3"]
        XCTAssertTrue(hits.waitForExistence(timeout: 6), "The search does not find \"Kimi K3\"")
        XCTAssertFalse(app.buttons["model-choice-z-ai/glm-5.3-flash"].exists, "The search does not filter — GLM is still there")
        attach(app, "Providers: OpenRouter model searched")
        hits.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) {
                (self.fixtureSettings(server)?["defaultModel"] as? [String: Any])?["openrouter"] as? String == "moonshotai/kimi-k3"
            },
            "The chosen default model did not arrive at the server"
        )

        // ── Remove the key: the card stays ──
        let remove = app.buttons["openrouter-key-remove"]
        XCTAssertTrue(scrollUp(app, remove) || roleInSheet(app, remove), "\"Remove key\" is missing")
        remove.tap()
        XCTAssertTrue(waitForFixture(timeout: 10) { access()["keySet"] as? Bool == false },
                      "The key was not removed at the server")
        XCTAssertTrue(waitUntil(timeout: 8) { app.staticTexts["openrouter-status"].label == "No key" },
                      "The card vanished with the key or does not say it")
        attach(app, "Providers: OpenRouter without key")
    }

    // ── Providers: the default level beside the default model ───────────────
    /// Every provider carries a default level beside the default model — preset with the catalog level of the
    /// default model (Codex/Sol: Medium). The choice goes to the server via `PUT /api/default-effort`, and
    /// `/api/providers` returns it afterwards: measured at the fixture (`/fixture/default-level`), not at the row.
    func testDefaultLevelInTheProviderSettings() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        XCTAssertEqual(fixtureJSON(server + "/fixture/default-level")?["codex"] as? String, "medium",
                       "Precondition: Codex is at the preset (catalog level of Sol)")
        openSettings(app, page: "Providers")

        let row = app.buttons["default-level-codex"]
        XCTAssertTrue(scrollUntilHittable(app, row), "Codex's default level is not reachable")
        XCTAssertTrue(row.label.contains("Medium") || (row.value as? String ?? "").contains("Medium"),
                      "The preset does not show \"Medium\": \(row.label)")
        row.tap()
        let up = app.buttons["High"]
        XCTAssertTrue(up.waitForExistence(timeout: 6), "\"High\" is missing from the default level menu")
        XCTAssertTrue(app.buttons["Max"].exists, "Sol carries Max — it is missing from the menu")
        XCTAssertFalse(app.buttons["Auto"].exists, "The default level is a level — \"Auto\" does not belong in the menu")
        attach(app, "Providers: default level, menu")
        up.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                let snapshot = self.fixtureJSON(server + "/fixture/default-level")
                return (snapshot?["set"] as? [String: Any])?["codex"] as? String == "high" && snapshot?["codex"] as? String == "high"
            },
            "The default level did not arrive at the server"
        )
        XCTAssertTrue(waitUntil(timeout: 8) {
            let z = app.buttons["default-level-codex"]
            return z.label.contains("High") || (z.value as? String ?? "").contains("High")
        },
                      "After reloading the row does not show \"High\": \(app.buttons["default-level-codex"].label)")
        attach(app, "Providers: default level set")
    }

    // ── Appearance: the text size (for the whole app) ───────────────────────
    /// Colour scheme and text size are device preferences: no server call, immediate effect,
    /// and they survive the restart. So the PREVIEW is measured — it uses
    /// the same building blocks as the history, a replica with its own computation could grow here
    /// without anything happening over there.
    ///
    /// `pinTextSize: false`: otherwise the level is pinned like tab and chat filter —
    /// and a pinned value does not survive a restart, it is set anew at every start. Exactly this
    /// test may run without the clamp this once.
    func testAppearanceTextSizeSurvivesTheRestart() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, pinTextSize: false)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Appearance")

        // The colour scheme was moved here from the root list with this page — its
        // identifier is what the sweep and future checks hang on.
        // Since the font choice (group above), the group is under the first picture, and a
        // `List` builds it only on appearing — so scroll until it is there, and back up for the control.
        // The identifier moves from the inline picker onto its rows, hence `firstMatch`.
        let theme = app.descendants(matching: .any).matching(identifier: "settings-theme").firstMatch
        XCTAssertTrue(
            roleInSheet(app, theme),
            "The colour scheme picker is missing on the Appearance page"
        )

        // The last run of this test may have left another level — so first set a
        // known starting point, then measure.
        let stage = app.sliders["settings-text-size"]
        XCTAssertTrue(scrollUp(app, stage, attempts: 8), "The text size control is missing")
        selectTextSize(app, "Normal")
        let atNormal = previewHeight(app)
        XCTAssertGreaterThan(atNormal, 0, "The text size preview is missing")
        attach(app, "Appearance: text size Normal")

        selectTextSize(app, "Extra large")
        XCTAssertTrue(
            waitForFixture(timeout: 6) { self.previewHeight(app) > atNormal + 2 },
            "The preview does not grow with the chosen level (Normal: \(atNormal), now: \(previewHeight(app)))"
        )
        let atVeryLarge = previewHeight(app)
        attach(app, "Appearance: text size Very large")

        // ── Restart: the choice lives in UserDefaults, not at the server ──
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Appearance")
        XCTAssertTrue(roleInSheet(app, app.sliders["settings-text-size"]),
                      "After the restart the control is missing")
        XCTAssertTrue(
            waitForFixture(timeout: 8) { self.previewHeight(app) > atNormal + 2 },
            "After the restart the preview is at the small level again (expected ~\(atVeryLarge))"
        )
        attach(app, "Appearance: choice after the restart")

        // Back to Normal: the level is persistent and would otherwise act in every test after it
        // that measures heights in the history.
        selectTextSize(app, "Normal")
        XCTAssertTrue(
            waitForFixture(timeout: 6) { self.previewHeight(app) <= atNormal + 2 },
            "The level could not be reset"
        )
    }

    /// The size guideline — a menu picker in the group "Dynamic workflows", on the page of its own "Workflows" (group "Behaviour").
    /// Default medium; the chosen level is checked at the SERVER (fixture route), not at the view.
    func testDynamicWorkflowsSizeGuideline() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/settings", body: [:]),
                        "The fixture gateway did not accept the settings seed")
        let size = { self.fixtureJSON(server + "/api/dyn-workflow-size")?["size"] as? String }
        XCTAssertEqual(size(), "medium", "Default medium")

        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openSettings(app, page: "Workflows")
        // The row loads its state on appearing — until then a "—" stands instead of the picker.
        let picker = app.buttons["usage-dynwf-size"]
        XCTAssertTrue(roleInSheet(app, picker, attempts: 16), "The size guideline picker is missing")
        picker.tap()
        // Menu items by LABEL (the simulator may speak English).
        let large = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Large", "Large")).firstMatch
        XCTAssertTrue(large.waitForExistence(timeout: 6), "The \"Large\" level is missing from the menu")
        large.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { size() == "large" },
            "The chosen level does not arrive at the server"
        )
        attach(app, "Workflows: size guideline of the dynamic workflows")
    }

    // ── Profile → Account: deleting the own account (App Store guideline 5.1.1(v)) ─────────────
    // The fixture answers POST /gw/account/delete with the mode set by `/fixture/account-delete` (202 · 403 · 409) and records every
    // body. Counter-tests: without `phase = .needsLogin` in SessionStore.deleteAccount the happy path stays in the shell (red); without
    // the inline error the 403/409 tests find no `account-delete-error` (red). The error is the app's own sentence per `code` (the
    // tests run in English, so the exact English source string), never the gateway's `error`: `error.localizedDescription` instead of
    // `accountDeleteErrorText(error)` in DeleteAccountSheet turns both red (the fixture's sentence is the gateway's, worded differently).

    /// Opens Profile → Account → "Delete account…", types the password and confirms. Returns the app for the follow-up checks.
    private func deleteOwnAccount(_ server: String, mode: String, password: String = "account-password") -> XCUIApplication {
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/account-delete", body: ["mode": mode]), "The fixture switch did not answer")
        })
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))
        selectLocation(app, "profile")
        let row = app.buttons["account-delete"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The row \"Delete account…\" is missing on the account page")
        XCTAssertTrue(scrollUntilHittable(app, row), "The row \"Delete account…\" cannot be reached")
        row.tap()
        let field = app.secureTextFields["account-delete-password"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The delete sheet with the password field did not open")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "cannot be undone")).firstMatch.exists,
                      "The sheet does not say that the deletion cannot be undone")
        let confirm = app.buttons["account-delete-confirm"]
        XCTAssertFalse(confirm.isEnabled, "Delete is possible without a password")
        field.tap()
        field.typeText(password)
        XCTAssertTrue(waitUntil(timeout: 5) { confirm.isEnabled }, "Delete stays disabled with a password")
        attach(app, "Delete account: sheet filled (\(mode))")
        confirm.tap()
        return app
    }

    /// Settings → Account: the same sheet as Profile → Account (DeleteAccountSheet), reached where people and App Review look for it.
    /// Counter-test: without the two rows in SettingsView (or with a second, private sheet that does not post) this turns red.
    func testSettingsAccountDeletesThroughTheSameSheet() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/account-delete", body: ["mode": "202"]), "The fixture switch did not answer")
        })
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(app.buttons["drawer-settings"].waitForExistence(timeout: 8), "The settings entry is missing in the right drawer")
        app.buttons["drawer-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 12), "The settings sheet did not open")
        let logout = app.buttons["settings-account-logout"]
        XCTAssertTrue(scrollUntilHittable(app, logout), "Settings has no \"Sign out\" row")
        let row = app.buttons["settings-account-delete"]
        XCTAssertTrue(scrollUntilHittable(app, row), "Settings has no \"Delete account…\" row")
        attach(app, "Settings: account section")
        row.tap()
        let field = app.secureTextFields["account-delete-password"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The delete sheet did not open from Settings")
        field.tap()
        field.typeText("account-password")
        let confirm = app.buttons["account-delete-confirm"]
        XCTAssertTrue(waitUntil(timeout: 5) { confirm.isEnabled }, "Delete stays disabled with a password")
        confirm.tap()
        XCTAssertTrue(app.textFields["login-username"].waitForExistence(timeout: 15), "After the deletion from Settings the app is not on the login screen")
        XCTAssertEqual(accountDeleteBodies(server).count, 1, "The deletion from Settings did not reach the server exactly once")
    }

    private func accountDeleteBodies(_ server: String) -> [[String: Any]] {
        (fixtureJSON(server + "/fixture/account-delete")?["bodies"] as? [[String: Any]]) ?? []
    }

    func testDeleteAccountEndsOnTheLoginScreen() throws {
        let server = try requireFixture()
        let app = deleteOwnAccount(server, mode: "202")
        XCTAssertTrue(app.textFields["login-username"].waitForExistence(timeout: 15), "After the deletion the app is not on the login screen")
        XCTAssertFalse(app.otherElements["top-bar"].exists, "The shell is still there after the deletion")
        let bodies = accountDeleteBodies(server)
        XCTAssertEqual(bodies.count, 1, "The deletion did not reach the server exactly once: \(bodies)")
        XCTAssertEqual(bodies.first?.keys.sorted(), ["password"], "The body is not exactly {password}")
        XCTAssertEqual(bodies.first?["password"] as? String, "account-password")
        attach(app, "Delete account: login screen")
    }

    func testDeleteAccountAsLastAdminShowsTheMessage() throws {
        let server = try requireFixture()
        let app = deleteOwnAccount(server, mode: "409")
        let error = app.descendants(matching: .any)["account-delete-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 10), "The 409 shows no error in the sheet")
        XCTAssertEqual(error.label, "You are the last active admin. Make someone else an admin first, then delete your account.",
                       "Not the app's own sentence for LAST_ADMIN")
        XCTAssertTrue(app.secureTextFields["account-delete-password"].exists, "The sheet closed on 409")
        XCTAssertFalse(app.textFields["login-username"].exists, "The app left the shell on 409")
        attach(app, "Delete account: last admin")
    }

    func testDeleteAccountWithAWrongPasswordKeepsTheSheetOpen() throws {
        let server = try requireFixture()
        let app = deleteOwnAccount(server, mode: "403", password: "wrong-password")
        let error = app.descendants(matching: .any)["account-delete-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 10), "The 403 shows no error in the sheet")
        XCTAssertEqual(error.label, "Wrong password.", "Not the app's own sentence for PASSWORD")
        XCTAssertTrue(app.buttons["account-delete-confirm"].exists, "The sheet closed on 403")
        XCTAssertTrue(app.buttons["account-delete-confirm"].isEnabled, "After a 403 a second attempt is not possible")
        XCTAssertFalse(app.textFields["login-username"].exists, "The app left the shell on 403")
        XCTAssertEqual(accountDeleteBodies(server).count, 1)
        attach(app, "Delete account: wrong password")
    }
}
