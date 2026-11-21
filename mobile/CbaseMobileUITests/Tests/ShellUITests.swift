// UI tests of the app shell: launch, overview, drawers, chat list, header, services menu, archive, effort selection in the new-chat sheet.
import XCTest

final class ShellUITests: CbaseUITestBase {
    // ── The "New chat" sheet ─────────────────
    /// The "New chat" sheet has NO persona choice — agent instructions per workspace/project took its place (Coding → Agents →
    /// Instructions). The test checks both: the picker is missing, and the creation sends no `profile` field (the server no longer
    /// reads `chats.profile`). Counter-test: bringing back the picker `new-chat-profile` or `profile: ""` in the body turns it red.
    func testNewChatWithoutPersonaChoice() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)

        let prior = fixtureCreateCount(server)
        XCTAssertNotNil(prior, "The fixture state is not readable")
        let fresh = app.buttons["overview-new-chat"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "The \"New chat\" button is missing")
        fresh.tap()
        let create = app.buttons["Start"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The \"New chat\" sheet does not appear")
        // "Start" is active only once the provider list has arrived.
        XCTAssertTrue(waitUntil(timeout: 15) { create.isEnabled }, "The provider list did not arrive")
        XCTAssertFalse(app.descendants(matching: .any)["new-chat-profile"].exists, "The persona picker is still in the sheet")
        attach(app, "New chat without persona choice")

        create.tap()
        firstMessageInDraft(app, server: server, prior: prior)
        XCTAssertTrue(
            waitForFixture(timeout: 15) {
                (fixtureJSON(server + "/fixture/state")?["lastChatCreate"] as? [String: Any]) != nil
            },
            "The creation did not reach the server"
        )
        let body = fixtureJSON(server + "/fixture/state")?["lastChatCreate"] as? [String: Any]
        XCTAssertNil(body?["profile"], "The creation still sends a profile field: \(String(describing: body?["profile"]))")
    }

    // ── Launch / connection ───────────────────────────────────────────────────
    func testFirstLaunchOffersFreeServerEntry() {
        let app = launchApp(server: "")
        XCTAssertTrue(
            app.navigationBars["Connect cbase"].waitForExistence(timeout: 15),
            "Without a stored API base the free server entry must appear"
        )
        XCTAssertTrue(app.textFields["https://server.example"].exists)
        XCTAssertTrue(app.buttons["Connect"].exists)
    }

    // ── Overview instead of an empty chat ──────────────────────────────────────────
    func testWorkspaceOpensChatOverviewInsteadOfEmptyChat() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)

        XCTAssertTrue(
            app.buttons["overview-new-chat"].waitForExistence(timeout: 25),
            "Entering a workspace must show the overview of recent chats"
        )
        XCTAssertTrue(app.staticTexts["Recent chats"].exists)
        XCTAssertFalse(
            app.descendants(matching: .any)["chat-composer"].exists,
            "The overview must not show an open chat composer"
        )
        XCTAssertTrue(app.otherElements["top-bar"].exists, "The slim top bar is missing")
        // No bottom bar any more: the three places stand at the top of the right drawer. Skills are no place of the shell
        // (Coding → Skills), and there is no manager tab.
        XCTAssertFalse(app.otherElements["home-bar"].exists, "The bottom bar is still there")
        swipeLeftAcrossScreen(app)
        for location in ["workspaces", "apps", "profile"] {
            XCTAssertTrue(waitUntilHittable(app.buttons["home-tab-\(location)"], timeout: 6), "The place \(location) is missing in the right drawer")
        }
        XCTAssertFalse(app.buttons["home-tab-skills"].exists, "The skills tab is still among the places")
        XCTAssertFalse(app.buttons["home-tab-todos"].exists, "The manager tab is still among the places")
        attach(app, "Places at the top of the right drawer")
        closeDrawers(app)

        let chat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "The overview lists no chats")
        attach(app, "Chat overview on entering the workspace")
    }

    /// Whoever last stood on the "Skills" tab has `skills` stored under `cbase.mobile.tab`. The tab no longer exists — the app
    /// starts on the default tab (Coding), not in an empty shell. The same holds for a remembered `todos` — the manager tab is
    /// gone, `HomeTab(rawValue:)` falls back to the default. The launch argument overrides the pin from `launchApp` (later
    /// arguments beat earlier ones, as with `-cbase.mobile.cat:` in `CodingUITests`).
    func testRememberedSkillsTabFallsOnTheDefault() throws {
        let server = try requireFixture()
        for remembered in ["skills", "todos"] {
            let app = launchApp(server: server, launchArguments: ["-cbase.mobile.tab", remembered])
            XCTAssertTrue(waitUntilHittable(app.buttons["overview-new-chat"], timeout: 25),
                          "With a remembered \"\(remembered)\" the app does not start on the Coding tab")
            attach(app, "Launch with remembered tab \"\(remembered)\"")
            // The places stand at the top of the right drawer.
            swipeLeftAcrossScreen(app)
            XCTAssertTrue(waitUntilHittable(app.buttons["home-tab-workspaces"], timeout: 6), "The places are missing in the right drawer (remembered: \(remembered))")
            XCTAssertFalse(app.buttons["home-tab-\(remembered)"].exists, "The tab \"\(remembered)\" is still among the places")
            app.terminate()
        }
    }

    // ── Loading animation when opening a chat ────────────────────────────────
    func testOpeningChatShowsLoadingAnimation() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 6, stress: false, delayMs: 1400))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        let chat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 25))
        chat.tap()

        let skeleton = app.descendants(matching: .any)["chat-loading-skeleton"]
        XCTAssertTrue(
            skeleton.waitForExistence(timeout: 3),
            "While the history loads, a loading animation must appear instead of an empty screen"
        )
        attach(app, "Loading animation when opening a chat")
        XCTAssertTrue(
            app.staticTexts["Verlauf Antwort 6"].waitForExistence(timeout: 25),
            "After loading the history must appear"
        )
        XCTAssertFalse(skeleton.exists, "After loading the loading animation must disappear")
    }

    // ── Swiping right opens the chat list ─────────────────────────────
    func testSwipeRightInChatOpensChatSidebar() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)

        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20))
        swipeRightAcrossScreen(app)

        XCTAssertTrue(
            app.otherElements["left-drawer"].waitForExistence(timeout: 5),
            "Swiping right must open the chat drawer instead of navigating back"
        )
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "sidebar-chat-")).firstMatch.exists,
            "All chats must be listed in the drawer"
        )
        // The "App agents" button at the bottom edge is gone together with the app agents.
        XCTAssertFalse(app.buttons["left-drawer-app-agents"].exists, "\"App agents\" is back at the bottom edge")
        attach(app, "Chat list after swiping right")
    }

    /// A short, slow drag must suffice — and equally far in BOTH directions.
    ///
    /// The shell takes over the swipe regardless of its horizontal speed (UIKit asks `shouldBegin` only once per touch, so a
    /// later flick would not help), and the snap threshold is a fixed fraction of the drawer width, the same for opening and
    /// closing. The drag here is a good 100 pt long (0.28 of the screen width) and is held at the end, so it carries no
    /// momentum rescue. Counter-test: a speed floor for the swipe or different thresholds for opening and closing turns it
    /// red in BOTH directions.
    func testShortSlowDragOpensAndClosesTheChatSidebar() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20))

        // What is checked is the REACHABILITY of a button in the drawer, not its existence:
        // the drawer view stays in the tree even when retracted (it only lies behind the
        // content card) — the same pattern as in `testSidebarButtonOpensAndTapAsideClosesTheDrawer`.
        dragSlowly(app, fromX: 0.30, toX: 0.58)
        XCTAssertTrue(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 6),
            "A short, slow drag to the right must extend the drawer"
        )
        attach(app, "Drawer after a short slow drag")

        // Back on the visible content card to the right of the drawer — the same short
        // distance, only in the other direction.
        dragSlowly(app, fromX: 0.90, toX: 0.62)
        XCTAssertFalse(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 5),
            "The same short drag back must retract the drawer — retracting must not need more distance than extending"
        )
    }

    /// At the left of the chat header stands ONLY the way back (no ☰ button `chat-sidebar-button` next to it). The chat list is
    /// opened by the swipe to the right — and a tap on the narrow rest of the app beside it closes it again.
    func testChatHeaderOnlyBackAndTapBesideTheDrawerCloses() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["chat-back"].exists, "The back button in the chat header is missing")
        XCTAssertFalse(app.buttons["chat-sidebar-button"].exists, "The ☰ button is back in the chat header")

        swipeRightAcrossScreen(app)
        XCTAssertTrue(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 6),
            "The swipe to the right must extend the chat drawer in the chat"
        )
        attach(app, "Chat drawer via the swipe")

        // The narrow rest of the app to the right of the drawer closes it on a tap.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.5)).tap()
        XCTAssertFalse(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 4),
            "A tap beside the drawer must retract it"
        )
        XCTAssertTrue(
            waitUntilHittable(app.descendants(matching: .any)["chat-composer"], timeout: 6),
            "After retracting the chat must be operable again"
        )
    }

    // ── Swiping left opens the categories ─────────────────────────────
    func testSwipeLeftOpensCategoryDrawerWithAllSections() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        swipeLeftAcrossScreen(app)
        XCTAssertTrue(
            app.otherElements["right-drawer"].waitForExistence(timeout: 5),
            "Swiping left must open the section drawer"
        )
        for category in ["chats", "agents", "workflows", "projects", "mcp", "context", "vars", "code", "terminal", "browser"] {
            XCTAssertTrue(
                app.buttons["category-\(category)"].exists,
                "Category \(category) is missing in the right drawer"
            )
        }
        // The library is the kind "Dynamic" under "Workflows", not a category of its own.
        XCTAssertFalse(app.buttons["category-dynworkflows"].exists, "The category \"Dynamic workflows\" is still in the drawer")
        XCTAssertTrue(app.buttons["drawer-bell"].exists, "Bell is missing")
        XCTAssertTrue(app.buttons["drawer-theme"].exists, "Theme switch is missing")
        XCTAssertTrue(app.buttons["drawer-settings"].exists, "Settings are missing")
        attach(app, "Section drawer with all categories")
    }

    /// The section drawer is the ONLY way between the categories. Panes with their own
    /// drag gestures (code editor, terminal, browser screencast) must not swallow the
    /// swipe — otherwise you get stuck in a section.
    func testCategoryDrawerReachableFromEveryPane() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        for category in ["code", "terminal", "browser", "chats"] {
            swipeLeftAcrossScreen(app)
            let button = app.buttons["category-\(category)"]
            XCTAssertTrue(
                button.waitForExistence(timeout: 8),
                "The drawer could not be opened from the previously opened section (\(category) unreachable)"
            )
            button.tap()
            XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 10))
            _ = app.otherElements["right-drawer"].waitForNonExistence(timeout: 3)
        }
    }

    /// On a scope switch the app rebuilds its scope-bound models. The chat overview is
    /// permanently mounted, so its `.task` does NOT fire again — without a nudge from
    /// `rebuildScopeModels` the loading skeleton stayed forever.
    func testLeavingProjectReloadsTheChatList() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        app.buttons["scope-picker"].tap()
        let project = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "scope-project-"))
            .firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 8))
        project.tap()
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 20))

        app.buttons["scope-picker"].tap()
        XCTAssertTrue(app.buttons["scope-whole-workspace"].waitForExistence(timeout: 8))
        app.buttons["scope-whole-workspace"].tap()

        let chat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        XCTAssertTrue(
            chat.waitForExistence(timeout: 15),
            "After leaving the project the chat list must reload instead of staying in the loading skeleton"
        )
    }

    // ── Chat list: search and sorting ─────────────────────────────────────
    func testChatSearchAndSortingFilterTheOverview() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        XCTAssertTrue(
            app.staticTexts["Zahlungs-Bug im Checkout"].waitForExistence(timeout: 15),
            "The overview must list all chats of the fixture"
        )

        // Search: only the matching chat remains.
        let search = app.textFields["chats-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), "The chat search is missing in the overview")
        search.tap()
        search.typeText("zahlungs")
        XCTAssertTrue(app.staticTexts["Zahlungs-Bug im Checkout"].waitForExistence(timeout: 5))
        XCTAssertFalse(
            app.staticTexts["Queue-Test"].exists,
            "The search must hide chats without a match"
        )
        attach(app, "Chat search")
        app.buttons["chats-search-clear"].tap()
        XCTAssertTrue(app.staticTexts["Queue-Test"].waitForExistence(timeout: 5))

        // Sorting: "Oldest first" puts the oldest chat in first place.
        let firstChat = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        XCTAssertEqual(
            firstChat.identifier,
            "overview-chat-20000000-0000-4000-8000-000000000001",
            "Default is \"Newest first\""
        )
        selectChatSort(app, "Oldest first")
        XCTAssertEqual(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-")).firstMatch.identifier,
            "overview-chat-20000000-0000-4000-8000-000000000003",
            "Oldest first must reverse the order"
        )
        attach(app, "Chats sorted by age")
        // Grouped by project: workspace chats (without a project) first, the newest on top within.
        selectChatSort(app, "By project")
        XCTAssertEqual(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-")).firstMatch.identifier,
            "overview-chat-20000000-0000-4000-8000-000000000002",
            "By project must list the workspace chats first (newest first)"
        )
        attach(app, "Chats sorted by project")

        selectChatSort(app, "Newest first")
        XCTAssertEqual(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-")).firstMatch.identifier,
            "overview-chat-20000000-0000-4000-8000-000000000001"
        )
    }

    // ── Chat folders ─────────────────────────────────────────────────────────
    /// Folders are pure grouping of the chat list (nothing is created on the file system). The whole operating path is
    /// checked: create a folder → start a chat IN it → the chat hangs on the folder and disappears with it when it
    /// collapses. Collapsing is the actual proof — the mere existence of the chat row said nothing about where it hangs.
    ///
    /// Deliberately WITHOUT a long press (context menu): it arrives only about every second time in this shell, and a
    /// mis-tap on a chat row OPENS the chat — the test would then stand somewhere else. Assigning existing chats is covered
    /// by the server test (server/backend/test/chat-folders.test.js).
    func testChatFolderGroupsAndCollapsesItsChats() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        app.buttons["overview-new-folder"].tap()
        // The field in the alert does not reliably carry its identifier (measured, see
        // testWorkflowsPaneCreatesWorkflowAndAddsStep) — so address it through the alert.
        let dialog = app.alerts.firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 8), "The folder dialog does not appear")
        let nameField = dialog.textFields.firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 6), "The folder dialog has no name field")
        nameField.tap()
        nameField.typeText("Research")
        dialog.buttons["Create"].tap()

        let folderRow = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-folder-"))
            .firstMatch
        XCTAssertTrue(folderRow.waitForExistence(timeout: 10), "The new folder must be in the chat list")
        attach(app, "New chat folder")

        // Start a chat IN the folder — via the folder picker of the "New chat" sheet.
        app.buttons["overview-new-chat"].tap()
        let folderPicker = app.descendants(matching: .any)["new-chat-folder"]
        XCTAssertTrue(folderPicker.waitForExistence(timeout: 10), "The sheet must show a folder picker")
        folderPicker.tap()
        let option = app.buttons["Research"]
        XCTAssertTrue(option.waitForExistence(timeout: 6), "The created folder must be selectable")
        option.tap()
        let prior = fixtureCreateCount(server)
        app.buttons["Start"].tap()
        // A draft: only the first message creates the chat, and only then does the list carry it.
        firstMessageInDraft(app, server: server, prior: prior)

        // The new chat is opened — back to the overview, where it stands in the folder.
        normalizeToChatsOverview(app)
        let chatId = "overview-chat-\(Self.fixtureChatId)"
        XCTAssertTrue(
            app.buttons[chatId].waitForExistence(timeout: 15),
            "The chat started in the folder must be in the list"
        )
        attach(app, "Chat in the folder")

        // Collapsing hides exactly this chat — the proof that it hangs on the folder.
        XCTAssertTrue(waitUntilHittable(folderRow, timeout: 8))
        folderRow.tap()
        XCTAssertTrue(
            waitUntilGone(app.buttons[chatId], timeout: 6),
            "A collapsed folder must hide its chats"
        )
        // The other chats stay untouched — only the folder content disappears.
        XCTAssertTrue(app.buttons["overview-chat-20000000-0000-4000-8000-000000000002"].exists)

        folderRow.tap()
        XCTAssertTrue(
            app.buttons[chatId].waitForExistence(timeout: 6),
            "Tapping again must expand the folder again"
        )
    }

    /// An entered project shows ONLY its own chats — in the overview AND in the left drawer, pinned or not; workspace chats
    /// without a project do not appear either (as on the web). The seed `/fixture/foreign-pinned` pins "Zahlungs-Bug im
    /// Checkout" and attaches it to ANOTHER project; "Architektur-Notizen" is a workspace chat without a project. Counted via
    /// the row identifiers: the project shows exactly ONE (Queue-Test), the workspace three — a list in the loading skeleton
    /// (zero rows) proves nothing. Then a restart in the remembered project (the path via `enter(workspaceId:restore:)`, not
    /// `enterProject`): the same rule. Folders are covered too (three empty ones from the same seed: one in the project, one in
    /// the second project, one without a project — exactly one in the project), and so is the archive sheet (an archived
    /// workspace chat stands in the workspace's archive, not in the project's). Counter-test: `visibleChats`/`visibleFolders`
    /// behind a project-only switch again ⇒ the project shows three rows, the first count in the project is red.
    func testEnteredProjectShowsOnlyItsChatsInBothPlaces() throws {
        let server = try requireFixture()
        let foreignPinned = "20000000-0000-4000-8000-000000000003" // "Zahlungs-Bug im Checkout", pinned, second project
        let workspaceChat = "20000000-0000-4000-8000-000000000002"   // "Architektur-Notizen", without a project
        let projectFolder = "70000000-0000-4000-8000-0000000000f1"   // the seed's three folders: in the project, …
        let foreignFolder = "70000000-0000-4000-8000-0000000000f2"   // … in the second project, …
        let workspaceFolder = "70000000-0000-4000-8000-0000000000f3" // … without a project
        let seed = {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/foreign-pinned", body: ["on": true]),
                            "The fixture gateway did not accept the seed of the pinned foreign chat")
        }
        var app = launchApp(server: server, preparation: seed)
        // The rows of the list via their identifier — after the restart via the NEW `app` (the function captures the variable).
        func rows(_ prefix: String) -> XCUIElementQuery {
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
        }
        // Folders via their IDENTIFIERS: the folder row's identifier also stands on its buttons (expand, open) — two hits
        // per folder, measured 6 instead of 3.
        func folder(_ prefix: String) -> Set<String> {
            let q = rows(prefix)
            return Set((0..<q.count).map { q.element(boundBy: $0).identifier })
        }
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        // Without a project: all three chats of the workspace, the pinned foreign one on top — the proof that the seed works.
        XCTAssertTrue(waitUntil(timeout: 15) { rows("overview-chat-").count == 3 },
                      "Not all three chats are in the whole workspace: \(rows("overview-chat-").count)")
        XCTAssertEqual(rows("overview-chat-").firstMatch.identifier, "overview-chat-\(foreignPinned)",
                       "The pinned chat of the other project is not on top in the workspace — is it pinned?")
        XCTAssertTrue(waitUntil(timeout: 10) { folder("overview-folder-").count == 3 },
                      "Not all three folders are in the whole workspace: \(folder("overview-folder-").sorted())")
        attach(app, "Workspace: all chats, the foreign one pinned on top")

        // Into the project — there is no switch any more, the restriction applies at once.
        app.buttons["scope-picker"].tap()
        let project = app.buttons["scope-project-\(Self.fixtureProjectId)"]
        XCTAssertTrue(project.waitForExistence(timeout: 8), "The fixture project is missing in the scope picker")
        project.tap()
        XCTAssertTrue(waitUntil(timeout: 20) { rows("overview-chat-").count == 1 },
                      "The project shows \(rows("overview-chat-").count) chats instead of just its one")
        XCTAssertTrue(app.buttons["overview-chat-\(Self.fixtureChatId)"].exists, "The project chat \"Queue-Test\" is missing in the overview")
        XCTAssertFalse(app.buttons["overview-chat-\(foreignPinned)"].exists,
                       "The pinned chat of ANOTHER project is in the project's overview")
        XCTAssertFalse(app.buttons["overview-chat-\(workspaceChat)"].exists,
                       "A workspace chat without a project is in the project's overview")
        XCTAssertFalse(app.buttons["chats-only-project"].exists, "The \"Only this project\" switch is back")
        XCTAssertEqual(folder("overview-folder-"), ["overview-folder-\(projectFolder)"], "The project shows folders of other projects or of the workspace")
        XCTAssertTrue(app.buttons["overview-folder-\(projectFolder)"].exists, "The project's folder is missing in the overview")
        attach(app, "Project: only its chats")

        // The same rule in the left drawer.
        try openFirstChatInProject(app)
        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 6))
        XCTAssertTrue(waitUntilHittable(app.buttons["sidebar-chat-\(Self.fixtureChatId)"], timeout: 8),
                      "The project chat \"Queue-Test\" is missing in the drawer")
        XCTAssertEqual(rows("sidebar-chat-").count, 1, "The project's drawer shows foreign chats")
        XCTAssertFalse(app.buttons["sidebar-chat-\(foreignPinned)"].exists,
                       "The pinned chat of ANOTHER project is in the project's drawer")
        XCTAssertFalse(app.buttons["sidebar-chat-\(workspaceChat)"].exists,
                       "A workspace chat without a project is in the project's drawer")
        XCTAssertFalse(app.buttons["sidebar-chats-only-project"].exists, "The \"Only this project\" switch is back in the drawer")
        XCTAssertEqual(folder("sidebar-folder-"), ["sidebar-folder-\(projectFolder)"], "The project's drawer shows foreign folders")
        XCTAssertTrue(app.buttons["sidebar-folder-\(projectFolder)"].exists, "The project's folder is missing in the drawer")
        attach(app, "Drawer in the project: only its chats")
        app.terminate()

        // Restart WITHOUT a pinned scope: the app returns to the remembered project — the same rule. `reset-run` cleared
        // the seed, it comes back in the preparation.
        app = launchApp(server: server, pinChatFilters: false, preparation: seed)
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))
        XCTAssertTrue(waitUntil(timeout: 25) { rows("overview-chat-").count == 1 },
                      "After the restart in the remembered project \(rows("overview-chat-").count) chats are shown instead of just its one")
        XCTAssertTrue(app.buttons["overview-chat-\(Self.fixtureChatId)"].exists, "After the restart the project chat is missing")
        XCTAssertFalse(app.buttons["overview-chat-\(foreignPinned)"].exists,
                       "After the restart the pinned chat of another project is in the project")
        attach(app, "After restart in the remembered project")

        // Leave the project: the whole workspace — all three are back.
        let picker = app.buttons["scope-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8), "The scope picker is missing")
        picker.tap()
        let whole = app.buttons["scope-whole-workspace"]
        XCTAssertTrue(whole.waitForExistence(timeout: 8))
        whole.tap()
        XCTAssertTrue(waitUntil(timeout: 20) { rows("overview-chat-").count == 3 },
                      "Without a project \(rows("overview-chat-").count) chats are shown instead of all three of the workspace")
        XCTAssertTrue(app.buttons["overview-chat-\(foreignPinned)"].exists, "Without a project the pinned chat is missing")
        XCTAssertTrue(app.buttons["overview-chat-\(workspaceChat)"].exists, "Without a project the workspace chat is missing")
        for folder in [projectFolder, foreignFolder, workspaceFolder] {
            XCTAssertTrue(app.buttons["overview-folder-\(folder)"].exists, "Without a project the folder \(folder) is missing")
        }
        attach(app, "Workspace after leaving the project")

        // The archive sheet: the archived workspace chat stands in the workspace's archive (proof that the sheet loads) — not in
        // the project's archive. The sheet loads fresh on every opening, the seed needs no restart.
        XCTAssertNotNil(fixturePost(server + "/fixture/archive", body: ["archive": [workspaceChat]]), "The archive seed failed")
        let archive = app.buttons["chats-archive"]
        XCTAssertTrue(waitUntilHittable(archive, timeout: 8), "The archive button in the list header is missing")
        archive.tap()
        XCTAssertTrue(app.buttons["archive-row-\(workspaceChat)"].waitForExistence(timeout: 10),
                      "The workspace's archive does not show the archived workspace chat")
        app.buttons["archive-finished"].tap()
        XCTAssertTrue(waitUntilGone(app.descendants(matching: .any)["archive-list"], timeout: 6), "The archive sheet does not close")
        picker.tap()
        XCTAssertTrue(projectButton(app).waitForExistence(timeout: 8))
        projectButton(app).tap()
        XCTAssertTrue(waitUntil(timeout: 20) { rows("overview-chat-").count == 1 }, "The project was not entered again")
        XCTAssertTrue(waitUntilHittable(archive, timeout: 8), "The archive button is missing in the project")
        archive.tap()
        XCTAssertTrue(app.descendants(matching: .any)["archive-empty"].waitForExistence(timeout: 10),
                      "The project's archive is not empty — it shows chats outside the project")
        XCTAssertFalse(app.buttons["archive-row-\(workspaceChat)"].exists, "The project's archive shows a workspace chat")
        attach(app, "Archive in the project: empty")
    }

    private func projectButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons["scope-project-\(Self.fixtureProjectId)"]
    }

    // ── Swiping must not scroll the chat along ────────────────────────────────
    /// The swipe recognizer deliberately lets touches through (tapping must keep working) — which made the history scroll
    /// along by the vertical share of the swipe motion. It must freeze the scroll view when it takes over.
    func testOpeningDrawerBySwipeDoesNotScrollTheChat() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureHistory(server, count: 14))
        defer { _ = setFixtureHistory(server, count: 0) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        let anchor = app.staticTexts["Verlauf Antwort 14"]
        XCTAssertTrue(anchor.waitForExistence(timeout: 25))
        let before = anchor.frame.minY

        // Diagonal swipe: to the right AND clearly downward (downward scrolls into the
        // past — that shift would remain and be visible).
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.10, dy: 0.42))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.58))
        start.press(forDuration: 0.02, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.05)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 6))
        closeDrawers(app)

        XCTAssertTrue(anchor.waitForExistence(timeout: 5))
        XCTAssertEqual(
            anchor.frame.minY,
            before,
            accuracy: 4,
            "Swiping to open the drawer scrolled the history along"
        )
        attach(app, "History after a diagonal swipe")
    }

    /// Swiping must not trigger a button — in NO direction. The drawer moves along under the finger, so the button
    /// barely moves relative to the finger: without a countermeasure the release counts as a tap (on the content when
    /// extending, in the drawer when retracting).
    func testSwipingOverAButtonDoesNotTriggerIt() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))

        // ── Extending: the finger starts on a chat row of the overview ──
        let row = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-chat-"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        // Drag HORIZONTALLY — at the height of the row itself. A diagonal drag is deliberately
        // no drawer swipe (the recognizer demands a clear horizontal; a diagonal drag with
        // vx=306 against vy=266 was measured and rightly rejected).
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).press(
            forDuration: 0.05,
            thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)),
            withVelocity: .default,
            thenHoldForDuration: 0.05
        )
        // Check the CONTENT: `left-drawer` always exists (permanently mounted), its controls
        // are removed from the structure only in the closed state.
        XCTAssertTrue(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 6),
            "The swipe over the chat row must open the drawer"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["chat-composer"].isHittable,
            "The swipe over a chat row opened the chat — it must not count as a tap"
        )
        attach(app, "Extending over a chat row")

        // ── Retracting: the finger starts on a chat row IN the drawer ──
        let drawerRow = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "sidebar-chat-"))
            .firstMatch
        XCTAssertTrue(drawerRow.waitForExistence(timeout: 8))
        drawerRow.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).press(
            forDuration: 0.05,
            thenDragTo: drawerRow.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)),
            withVelocity: .default,
            thenHoldForDuration: 0.05
        )
        XCTAssertFalse(
            waitUntilHittable(app.buttons["sidebar-new-chat"], timeout: 3),
            "The swipe to the left must close the drawer"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["chat-composer"].isHittable,
            "Retracting over a chat row opened the chat — it must not count as a tap"
        )
        XCTAssertTrue(
            waitUntilHittable(app.buttons["overview-new-chat"], timeout: 8),
            "After retracting the overview must be visible unchanged"
        )
        attach(app, "Retracting over a chat row")
    }

    // ── Header: usage rings ────────────────────────────────────────────
    func testHeaderShowsUsageRings() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))
        XCTAssertTrue(
            app.descendants(matching: .any)["usage-ring-claude"].waitForExistence(timeout: 25),
            "The Claude usage ring is missing in the header"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["usage-ring-codex"].exists,
            "The Codex usage ring is missing in the header"
        )

        // Instead of the lettering the rings carry the company marks.
        XCTAssertFalse(app.staticTexts["CLAUDE"].exists, "The ring still shows the Claude lettering instead of the company mark")
        XCTAssertFalse(app.staticTexts["CODEX"].exists, "The ring still shows the Codex lettering instead of the company mark")

        // And the mark is really there: the strip at the left of the ring must not be empty.
        // A wrongly named asset draws nothing — the test would fail here.
        for provider in ["claude", "codex"] {
            let box = app.descendants(matching: .any)["usage-ring-\(provider)"].frame
            let markArea = CGRect(x: box.minX, y: box.minY, width: min(15, box.width), height: box.height)
            XCTAssertGreaterThan(
                inkRatio(app, in: markArea), 0.05,
                "The company mark in the \(provider) ring is missing (area is empty)"
            )
        }
        attach(app, "Usage rings in the header")
    }

    /// AT THE LIMIT "100 %" must be shown — the rings used to vanish exactly then. The cause was the data situation: an
    /// exhausted window often brings NO percentage (Codex writes the windows as null, Anthropic lists model-specific limits
    /// only in `limits[]`), and the app checked "is there a percentage?". The fixture delivers exactly this shape.
    func testHeaderShowsHundredPercentAtLimit() throws {
        let server = try requireFixture()
        XCTAssertNotNil(
            fixturePost(server + "/fixture/usage-limit", body: [:]),
            "The fixture gateway did not accept the limit state"
        )
        // The state is global in the fixture — leaving it would taint the following tests.
        defer { _ = fixturePost(server + "/fixture/usage-limit", body: ["clear": true]) }
        let app = launchApp(server: server)
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))
        for provider in ["claude", "codex"] {
            let ring = app.descendants(matching: .any)["usage-ring-\(provider)"]
            XCTAssertTrue(
                ring.waitForExistence(timeout: 25),
                "The \(provider) ring is missing at the limit — it must not vanish but show 100 %"
            )
            XCTAssertTrue(
                (ring.label).contains("100"),
                "The \(provider) ring does not say 100 % at the limit: \(ring.label)"
            )
        }
        attach(app, "Usage rings at the limit (100 %)")
    }

    // ── Header: ports and performance button ─────────────────────────────
    /// The folder size is requested only when somebody looks: "Project files" costs the backend a `du` over every project
    /// folder of the scope and appears ONLY in the performance popover. Checked against the fixture's record
    /// (`GET /fixture/services` → `query`, `reset-run` clears it) and the display:
    ///  • while closed, EVERY request to `/api/project-resources` carries `disk=0`;
    ///  • the PORTS popover shows no folder size and asks nothing — proven, without waiting for silence, by the count below:
    ///    a request from it would be counted there;
    ///  • opening the PERFORMANCE popover triggers EXACTLY ONE new request, and it does not carry `disk=0` — the fixture
    ///    project's row then names its project files (250 MB; with `disk=0` the fixture, like the real server, returns
    ///    `diskBytes: null`, shown as "–");
    ///  • after closing, the next request carries `disk=0` again. It is triggered by returning from the background
    ///    (`scenePhase` → `services?.newStart()` in the shell).
    /// Without a clock: the launch argument `-cbase.mobile.services.tick 3600` (DEBUG only, see
    /// `ServicesStatusModel.tickNanoseconds`) makes the tick an hour long. A request after opening can therefore ONLY come
    /// from the opening, one after closing only from the foreground — the deadlines below are upper bounds, not a measurement.
    /// Counter-tests: the old state (never `disk=0`) ⇒ red at "closed"; `tick()` removed on open ⇒ red at "Opening triggers
    /// no request … "; opening asks twice (`tick()` plus `Task { await self.refresh() }`) ⇒ red at "EXACTLY ONE"
    /// ("ohne disk, ohne disk"); no `onDisappear` on the menu ⇒ red at "after closing".
    func testServicesButtonAsksFolderSizeOnlyAtOpenMenu() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, launchArguments: ["-cbase.mobile.services.tick", "3600"], preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/services", body: ["on": true]), "The fixture did not accept the services switch")
        })
        let query: () -> [[String: Any]] = {
            (self.fixtureJSON(server + "/fixture/services")?["query"] as? [[String: Any]]) ?? []
        }
        let withoutFolder: ([String: Any]) -> Bool = { ($0["disk"] as? String) == "0" }
        let describe: ([[String: Any]]) -> String = { list in
            list.isEmpty ? "no" : list.map { ($0["disk"] as? String).map { "disk=\($0)" } ?? "without disk" }.joined(separator: ", ")
        }

        let button = app.buttons["status-services"]
        let value: () -> String = { button.value as? String ?? "" }
        XCTAssertTrue(button.waitForExistence(timeout: 25), "The ports button (status-services) is missing in the header")
        XCTAssertTrue(waitForFixture(timeout: 10) { value() == "3" }, "The button shows \"\(value())\" instead of \"3\"")
        XCTAssertTrue(waitForFixture(timeout: 10) { !query().isEmpty }, "The buttons never asked for the resources")
        let closed = query()
        XCTAssertTrue(
            closed.allSatisfy(withoutFolder),
            "With the menu closed the header asks for the resources WITH folder size (a `du` per tick) — `disk=0` is expected: \(describe(closed))"
        )

        // The ports popover: open and closed again. It must ask nothing — a request from it would stand
        // in `sinceTheOpen` below and turn "EXACTLY ONE" red.
        button.tap()
        let portsMenu = app.descendants(matching: .any)["status-services-menu"]
        XCTAssertTrue(portsMenu.waitForExistence(timeout: 8), "The ports menu (status-services-menu) does not open")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(portsMenu.waitForNonExistence(timeout: 5), "The ports menu does not close")

        let performance = app.buttons["status-performance"]
        XCTAssertTrue(performance.waitForExistence(timeout: 5), "The performance button (status-performance) is missing in the header")
        performance.tap()
        let menu = app.descendants(matching: .any)["status-performance-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "The performance menu (status-performance-menu) does not open")
        let sinceTheOpen: () -> [[String: Any]] = { Array(query().dropFirst(closed.count)) }
        // The deadline is an upper bound: the tick is an hour long, a request comes only from the opening.
        XCTAssertTrue(
            waitForFixture(timeout: 6) { sinceTheOpen().contains { !withoutFolder($0) } },
            "Opening triggers no request with folder size (without `disk=0`) — since opening: \(describe(sinceTheOpen()))"
        )
        let row = app.descendants(matching: .any)["status-services-resource-\(Self.fixtureProjectId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "The fixture project's resource row is missing in the performance menu")
        XCTAssertTrue(
            waitForFixture(timeout: 6) { row.label.contains("250 MB") },
            "The open menu does not name the fixture project's project files (250 MB): \"\(row.label)\""
        )
        // Read AFTER the answer stands in the menu: a second request from the same opening (a
        // double restart) — or a late one from the ports popover — would already be recorded.
        let open = sinceTheOpen()
        XCTAssertTrue(
            open.count == 1 && open.allSatisfy { !withoutFolder($0) },
            "Ports popover and performance popover together must trigger EXACTLY ONE request, with folder size (without `disk=0`) — since opening: \(describe(open))"
        )
        attach(app, "Performance menu with project files")

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(menu.waitForNonExistence(timeout: 5), "The performance menu does not close")
        let upTo = query().count
        // The next request is triggered by returning from the background (`scenePhase` in the shell) —
        // the tick would be due again only in an hour.
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(button.waitForExistence(timeout: 15), "After returning from the background the ports button is missing")
        XCTAssertTrue(
            waitForFixture(timeout: 20) { query().count > upTo },
            "After returning from the background the header did not ask for the resources again (scenePhase → services?.refresh())"
        )
        let afterwards = Array(query().dropFirst(upTo))
        XCTAssertTrue(
            afterwards.allSatisfy(withoutFolder),
            "After closing the header keeps asking WITH folder size — `disk=0` is expected again: \(describe(afterwards))"
        )
    }

    /// Ports and performance: two buttons, each with its own popover. The whole path is checked:
    ///  • without running services the ports button stands muted with the value "0", and without a machine value the
    ///    performance button's label claims no reason; its popover says "No measurements." instead of an empty area;
    ///  • the scope counts: 2 services in the project, 3 in the whole workspace — and a scope switch asks again at once
    ///    (otherwise the old number would stand until the next 20 s tick);
    ///  • the colour comes from the machine, and the PERFORMANCE button's label names the reason (RAM 92 %, although swap
    ///    stands higher — swap does not count); the button shows the CPU of the measured services (12.3 %), the ports
    ///    button's label names no machine;
    ///  • the PORTS popover lists the running services (not the stopped one) and carries the agent browser as a section —
    ///    and NO resources, no machine;
    ///  • the PERFORMANCE popover says "measured: 2 of 3", shows the numbers and below them exactly the counted resource
    ///    rows (from `Sum.projects` — the project without containers is not below), names the machine "Server" — and lists
    ///    NO services;
    ///  • both stand on Coding, Apps and Profile;
    ///  • the right drawer carries NO status row any more — counter-test: with the old state and this fixture
    ///    `status-services` and `status-agent-browsers` would stand there;
    ///  • a tap on a service opens Apps with ITS project selected.
    /// The switch `/fixture/services` is set only AFTER the launch (the zero state is measured first); `reset-run` in the
    /// next `launchApp` undoes it — no `defer` needed.
    func testServicesButtonStandsOnEveryTabAndOpensItsMenu() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "The chat overview did not open")

        let button = app.buttons["status-services"]
        let performance = app.buttons["status-performance"]
        let value: () -> String = { button.value as? String ?? "" }
        XCTAssertTrue(button.waitForExistence(timeout: 25), "The ports button (status-services) is missing in the header")
        XCTAssertTrue(performance.waitForExistence(timeout: 5), "The performance button (status-performance) is missing in the header")
        XCTAssertTrue(
            waitForFixture(timeout: 10) { value() == "0" },
            "Without running services the ports button must carry the value \"0\" — it carries \"\(value())\""
        )
        XCTAssertTrue(button.label.hasPrefix("No services running"), "Label in the zero state: \"\(button.label)\"")
        XCTAssertFalse(performance.label.contains("RAM"), "Without a machine value the label must claim no reason: \"\(performance.label)\"")
        // The empty performance popover says so openly — no empty area.
        performance.tap()
        let perfMenu = app.descendants(matching: .any)["status-performance-menu"]
        XCTAssertTrue(perfMenu.waitForExistence(timeout: 8), "The performance menu (status-performance-menu) does not open")
        XCTAssertTrue(app.staticTexts["No measurements."].waitForExistence(timeout: 5), "Without a machine and without running services the performance menu does not say \"No measurements.\"")
        attach(app, "Ports muted (0), performance: no measurements")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(perfMenu.waitForNonExistence(timeout: 5), "The performance menu does not close")

        XCTAssertNotNil(fixturePost(server + "/fixture/services", body: ["on": true]), "The fixture did not accept the services switch")

        // Scope switch into the project: only its two running services (the third belongs to the second
        // project, the fourth is stopped). The switch itself must ask again.
        app.buttons["scope-picker"].tap()
        let project = app.buttons["scope-project-\(Self.fixtureProjectId)"]
        XCTAssertTrue(project.waitForExistence(timeout: 8), "The fixture project is missing in the scope picker")
        project.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { value() == "2" },
            "Two services run in the project — the button shows \"\(value())\" (does the scope switch not ask again?)"
        )

        // Back to the whole workspace: three.
        app.buttons["scope-picker"].tap()
        let whole = app.buttons["scope-whole-workspace"]
        XCTAssertTrue(whole.waitForExistence(timeout: 8))
        whole.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { value() == "3" },
            "Three services run in the whole workspace — the button shows \"\(value())\""
        )
        XCTAssertTrue(button.label.hasPrefix("3 services running"), "Label: \"\(button.label)\"")
        XCTAssertFalse(button.label.contains("RAM"), "The ports button's label names the machine — that is the performance button's statement: \"\(button.label)\"")
        XCTAssertTrue(
            waitForFixture(timeout: 10) { performance.label.contains("Server: RAM 92 %") },
            "The performance button's label does not name the reason for the colour (RAM 92 % on the server; swap stands higher but does not count): \"\(performance.label)\""
        )
        XCTAssertTrue(
            waitForFixture(timeout: 10) { (performance.value as? String) == "12.3 %" },
            "The performance button does not show the CPU of the measured services (12.3 %): \"\(performance.value as? String ?? "")\""
        )
        attach(app, "Ports and performance button with three running services")
        headerWithoutWrap(app, "Coding")

        // The ports popover: the applications and their ports — and ONLY them.
        button.tap()
        let menu = app.descendants(matching: .any)["status-services-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "The ports menu (status-services-menu) does not open")
        for id in [501, 502, 503] {
            XCTAssertTrue(app.buttons["status-services-row-\(id)"].waitForExistence(timeout: 5), "The running service \(id) is missing in the ports menu")
        }
        XCTAssertFalse(app.buttons["status-services-row-504"].exists, "The stopped service 504 is in the menu of the RUNNING ones")
        XCTAssertTrue(app.buttons["status-agent-browsers"].exists, "The agent browser section is missing in the ports menu")
        for foreign in ["status-services-machine", "status-services-sum", "status-services-resource-\(Self.fixtureProjectId)"] {
            XCTAssertFalse(app.descendants(matching: .any)[foreign].exists, "The ports menu contains \(foreign) — that belongs in the performance menu (not two in one)")
        }
        attach(app, "Ports menu")
        // Close: tap beside the popover (bottom left, away from button and menu).
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(menu.waitForNonExistence(timeout: 5), "The ports menu does not close")

        // The performance popover: the metrics — and NO services.
        performance.tap()
        XCTAssertTrue(perfMenu.waitForExistence(timeout: 8), "The performance menu (status-performance-menu) does not open")
        XCTAssertTrue(app.staticTexts["measured: 2 of 3 services"].waitForExistence(timeout: 5),
                      "The performance menu does not say that only two of the three services are measured")
        // The numbers and below them EXACTLY the counted rows (`Sum.projects`): the fixture project with two
        // containers, NOT the second project (0 containers) — sum and rows are the same set, the rule
        // stands once in `ServicesRules.sum`.
        XCTAssertTrue(app.descendants(matching: .any)["status-services-sum"].exists, "The resource numbers are missing in the performance menu")
        XCTAssertTrue(
            app.descendants(matching: .any)["status-services-resource-\(Self.fixtureProjectId)"].exists,
            "The fixture project's resource row (2 containers) is missing in the performance menu"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["status-services-resource-30000000-0000-4000-8000-000000000002"].exists,
            "The second project (0 containers) is among the resources — it does not count and is not in the sum"
        )
        let calculator = app.descendants(matching: .any)["status-services-machine"]
        XCTAssertTrue(calculator.exists, "The machine section is missing in the performance menu")
        // The heading is an overline (capital letters) — compared without case.
        XCTAssertEqual(calculator.label.lowercased(), "server", "With `/gw/host` the machine is called \"Server\" — the heading says \"\(calculator.label)\"")
        for id in [501, 502, 503] {
            XCTAssertFalse(app.buttons["status-services-row-\(id)"].exists, "The performance menu contains the service \(id) — that belongs in the ports menu (not two in one)")
        }
        XCTAssertFalse(app.buttons["status-agent-browsers"].exists, "The performance menu contains the agent browser — it belongs in the ports menu")
        attach(app, "Performance menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(perfMenu.waitForNonExistence(timeout: 5), "The performance menu does not close")

        // On every tab — and the same number everywhere, because it is ONE model.
        for tab in ["apps", "profile", "workspaces"] {
            selectLocation(app, tab)
            XCTAssertTrue(button.waitForExistence(timeout: 10), "On the tab \(tab) the ports button is missing")
            XCTAssertTrue(performance.exists, "On the tab \(tab) the performance button is missing")
            XCTAssertTrue(waitForFixture(timeout: 5) { value() == "3" }, "On the tab \(tab) the button shows \"\(value())\" instead of \"3\"")
            headerWithoutWrap(app, tab)
        }
        codingCategoryFromOverview(app, "chats")

        // The right drawer carries no status row any more.
        swipeLeftAcrossScreen(app)
        XCTAssertTrue(waitUntilHittable(app.buttons["drawer-settings"], timeout: 6), "The right drawer did not open")
        // Searched IN the drawer: the header's services button itself carries the identifier `status-services` — it stays
        // in the tree while the drawer is open. That the query sees the drawer's buttons at all is proven by
        // `drawer-settings` in it.
        let rightDrawer = app.otherElements["right-drawer"]
        XCTAssertTrue(rightDrawer.buttons["drawer-settings"].exists, "The right drawer's buttons are not under `right-drawer`")
        XCTAssertFalse(rightDrawer.buttons["status-services"].exists, "The old services row (status-services) is still in the right drawer")
        XCTAssertFalse(app.descendants(matching: .any)["status-resources"].exists, "The old resources row is still in the right drawer")
        XCTAssertFalse(app.buttons["status-agent-browsers"].exists, "The agent browser is still in the right drawer instead of the ports menu")
        attach(app, "Right drawer without status row")
        closeDrawers(app)

        // A tap on a service opens Apps with ITS project selected.
        button.tap()
        let row = app.buttons["status-services-row-501"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "The ports menu does not open a second time")
        row.tap()
        XCTAssertTrue(app.staticTexts["Projects & Stacks"].waitForExistence(timeout: 15), "The tap on the service did not open the apps page")
        XCTAssertTrue(
            app.descendants(matching: .any)["apps-project-\(Self.fixtureProjectId)"].waitForExistence(timeout: 15),
            "The project of the tapped service is missing on the apps page"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["apps-project-30000000-0000-4000-8000-000000000002"].exists,
            "The apps page also shows the second project — the service's project is not selected"
        )
        attach(app, "Apps with the service's project")
    }

    /// Two buttons need more room than `● n`. With "12.3 %" on the performance button the percentages of BOTH rings
    /// wrapped onto two lines ("12" above "%") and the workspace name was truncated. Only the number on the performance
    /// button (`ViewThatFits`) and then the name give way. Checked: every ring on one line (a wrapped one is a good 25 pt
    /// high, a single-line one 15), and name · ports · performance · rings stand in this order without overlap inside the
    /// window. Counter-test: `.fixedSize()` removed from the rings and `ViewThatFits` removed from the performance button ⇒
    /// red at "Ring … two lines".
    private func headerWithoutWrap(_ app: XCUIApplication, _ place: String) {
        let frame: (String) -> CGRect = { app.descendants(matching: .any)[$0].frame }
        let followUp = ["scope-picker", "status-services", "status-performance", "usage-ring-claude", "usage-ring-codex"]
        let r = followUp.map(frame)
        for (name, f) in zip(followUp, r) {
            XCTAssertFalse(f.isEmpty, "\(place): \(name) is missing in the header")
        }
        for (name, f) in zip(followUp.suffix(2), r.suffix(2)) {
            XCTAssertLessThan(f.height, 21, "\(place): ring \(name) on two lines (height \(f.height) pt) — the header is too narrow for its content")
        }
        for i in 1..<r.count {
            XCTAssertLessThanOrEqual(r[i - 1].maxX, r[i].minX + 0.5, "\(place): \(followUp[i - 1]) (until \(r[i - 1].maxX)) overlaps \(followUp[i]) (from \(r[i].minX))")
        }
        XCTAssertLessThanOrEqual(r[r.count - 1].maxX, app.frame.maxX, "\(place): the last ring sticks out of the window (\(r[r.count - 1].maxX) > \(app.frame.maxX))")
    }

    /// Without `/gw/host` NO machine, and services without any measurement are stated openly:
    ///  • the app is ALWAYS in gateway mode (`SessionStore.connect` demands `/gw/info` with `gateway: true`), and in gateway
    ///    mode the web shows only what `/gw/host` reports — the `host` field of the resources answer there is the quota of
    ///    the own container (Sysbox virtualizes `/proc/meminfo`). If `/gw/host` does not answer, no machine section
    ///    stands there, and the label names no reason. (iOS used to fall back to the container — "Your container: disk
    ///    40 %" — and colour accordingly, while the web stayed neutral);
    ///  • services run, but NONE is measured (no project reports containers): the resources section stands anyway and says
    ///    "measured: 0 of 3 services" — without numbers (never "0 % · 0 B") and without rows; the performance button then
    ///    shows no number.
    /// The statement "no machine" holds only once the round has passed `/gw/host`: the model asks the agent browsers LAST,
    /// after `/gw/host` — only when their section stands in the ports menu is the performance menu checked (otherwise a test
    /// that looks too early would take the absence for a pass). Opening the performance menu asks again at once; the round
    /// ends without a machine just the same. The switch stands in `preparation` (after `reset-run`, before the launch),
    /// `reset-run` in the next `launchApp` undoes it.
    /// Counter-tests: the section only `if model.sum != nil` ⇒ red at "measured: 0 of 3 services"; the old state with a
    /// fallback to the resources' `host` ⇒ red at the machine section. In `testServicesButtonStandsOnEveryTabAndOpensItsMenu`:
    /// the menu over `model.resources` instead of `sum.projects` ⇒ red at "The second project (0 containers) is among the
    /// resources".
    func testServicesMenuWithoutGwHostShowsNoMachineAndSaysUnmeasuredOpen() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/services", body: ["on": true, "calculator": "backend", "measurement": "no"]),
                "The fixture did not accept the services switch (without /gw/host, without measurement)"
            )
        })
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "The chat overview did not open")

        let button = app.buttons["status-services"]
        let performance = app.buttons["status-performance"]
        let value: () -> String = { button.value as? String ?? "" }
        XCTAssertTrue(button.waitForExistence(timeout: 25), "The ports button (status-services) is missing in the header")
        XCTAssertTrue(
            waitForFixture(timeout: 10) { value() == "3" },
            "Even without measurement three services run — the button shows \"\(value())\""
        )

        // The round is behind us: the agent browser section stands in the ports menu.
        button.tap()
        let portsMenu = app.descendants(matching: .any)["status-services-menu"]
        XCTAssertTrue(portsMenu.waitForExistence(timeout: 8), "The ports menu (status-services-menu) does not open")
        XCTAssertTrue(
            app.buttons["status-agent-browsers"].waitForExistence(timeout: 10),
            "The agent browser section is missing — without it it is not proven that the round has passed `/gw/host`"
        )
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(portsMenu.waitForNonExistence(timeout: 5), "The ports menu does not close")

        XCTAssertTrue(performance.waitForExistence(timeout: 5), "The performance button (status-performance) is missing in the header")
        XCTAssertEqual(performance.value as? String ?? "", "", "Without any measurement a number stands on the performance button: \"\(performance.value as? String ?? "")\"")
        performance.tap()
        let menu = app.descendants(matching: .any)["status-performance-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "The performance menu (status-performance-menu) does not open")
        XCTAssertTrue(
            app.staticTexts["measured: 0 of 3 services"].waitForExistence(timeout: 5),
            "Three services run, none is measured — the menu must say so (\"measured: 0 of 3 services\")"
        )
        let calculator = app.descendants(matching: .any)["status-services-machine"]
        XCTAssertFalse(
            calculator.exists,
            "Without `/gw/host` a machine stands in the menu (\"\(calculator.exists ? calculator.label : "")\") — that is the own container's quota from the resources answer; in gateway mode the web shows NO machine then"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["status-services-sum"].exists,
            "Without any measurement numbers stand under resources — never \"0 % · 0 B\""
        )
        for project in [Self.fixtureProjectId, "30000000-0000-4000-8000-000000000002"] {
            XCTAssertFalse(
                app.descendants(matching: .any)["status-services-resource-\(project)"].exists,
                "The resource row of \(project) stands in the menu although the project reports no containers"
            )
        }
        attach(app, "Performance menu: no /gw/host, no measurement")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(menu.waitForNonExistence(timeout: 5), "The performance menu does not close")
        // Without a machine the labels name no reason for the colour — neither "Server" nor the
        // container (RAM 25 %, load 20 % per core, disk 40 % — the reason would be the disk).
        for foreign in ["Server", "Disk", "container"] {
            XCTAssertFalse(performance.label.contains(foreign), "Without `/gw/host` the label names a machine (\"\(foreign)\"): \"\(performance.label)\"")
            XCTAssertFalse(button.label.contains(foreign), "The ports button's label names a machine (\"\(foreign)\"): \"\(button.label)\"")
        }
    }

    /// No statement about a measurement before one was taken (empty is not unknown): the services have answered (the button
    /// shows "3"), the resources have NOT (`resources: "error"` — the fixture answers 500, like a backend whose `docker
    /// stats` hangs). Then the performance menu must show NO "measured" row — it used to say "measured: 0 of 3 services"
    /// although two of the three are measured; the web says nothing in the same state (`measureRow(measurement, resources
    /// !== null)`). The same window exists in every operation between the services' answer and the resources', just shorter.
    /// The counterpart belongs to it, otherwise the absence would prove nothing: once the resources answer, the row
    /// ("measured: 2 of 3 services") stands there together with the numbers.
    /// Counter-tests: the old state (section tied to "services running", row without `loaded`) ⇒ red at the "measured" row;
    /// `ServicesRules.measureRow(measurement, loaded: true)` in the model ⇒ the same.
    func testServicesMenuSaysBeforeTheFirstMeasurementNothingOverMeasured() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(
                self.fixturePost(server + "/fixture/services", body: ["on": true, "resources": "error"]),
                "The fixture did not accept the services switch (resources fail)"
            )
        })
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25), "The chat overview did not open")

        let button = app.buttons["status-services"]
        let performance = app.buttons["status-performance"]
        let value: () -> String = { button.value as? String ?? "" }
        XCTAssertTrue(button.waitForExistence(timeout: 25), "The ports button (status-services) is missing in the header")
        XCTAssertTrue(
            waitForFixture(timeout: 10) { value() == "3" },
            "The services answer — the button must show \"3\", it shows \"\(value())\""
        )

        // The round has passed the resources: the model asks the agent browsers after them (their
        // section stands in the ports menu), and the fixture recorded the (failed) request.
        button.tap()
        let portsMenu = app.descendants(matching: .any)["status-services-menu"]
        XCTAssertTrue(portsMenu.waitForExistence(timeout: 8), "The ports menu (status-services-menu) does not open")
        XCTAssertTrue(
            app.buttons["status-agent-browsers"].waitForExistence(timeout: 10),
            "The agent browser section is missing — without it it is not proven that the resources were already asked"
        )
        XCTAssertFalse(
            ((fixtureJSON(server + "/fixture/services")?["query"] as? [[String: Any]]) ?? []).isEmpty,
            "The fixture saw no request to /api/project-resources — then the test checked nothing"
        )
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(portsMenu.waitForNonExistence(timeout: 5), "The ports menu does not close")

        XCTAssertTrue(performance.waitForExistence(timeout: 5), "The performance button (status-performance) is missing in the header")
        performance.tap()
        let menu = app.descendants(matching: .any)["status-performance-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "The performance menu (status-performance-menu) does not open")
        // The machine stands (the round ran through `/gw/host`) — so the menu is built, not empty.
        XCTAssertTrue(app.descendants(matching: .any)["status-services-machine"].waitForExistence(timeout: 5), "The machine section is missing in the performance menu")
        let measured = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "measured"))
        XCTAssertEqual(
            measured.count, 0,
            "The resources never answered, and the menu still says something about a measurement: \(measured.allElementsBoundByIndex.map(\.label))"
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["status-services-sum"].exists,
            "Without an answer of the resources numbers stand in the menu"
        )
        attach(app, "Performance menu: resources without an answer")

        // The counterpart: the resources answer. Close and reopen the menu — opening asks again
        // at once; the deadline also covers the 20 s tick if need be.
        XCTAssertNotNil(fixturePost(server + "/fixture/services", body: ["on": true]), "The fixture did not accept the services switch")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.82)).tap()
        XCTAssertTrue(menu.waitForNonExistence(timeout: 5), "The performance menu does not close")
        performance.tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "The performance menu does not open a second time")
        XCTAssertTrue(
            app.staticTexts["measured: 2 of 3 services"].waitForExistence(timeout: 25),
            "The resources answer now — the menu must say \"measured: 2 of 3 services\": \(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "measured")).allElementsBoundByIndex.map(\.label))"
        )
        XCTAssertTrue(app.descendants(matching: .any)["status-services-sum"].exists, "The resource numbers are missing although they answered")
        attach(app, "Performance menu: resources answered")
    }

    /// The Coding tab starts at its overview: a tap on "Coding" (in the right drawer) shows the eleven categories in two
    /// areas, a row leads into its category, the arrow in front of the title leads back.
    func testCodingTabStartsAtOverviewAndLeadsIntoCategories() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 20), "The chat overview did not open")

        // A tap on the (already active) place leads into the overview — in the right drawer.
        selectLocation(app, "workspaces")
        for category in ["chats", "agents", "workflows", "projects", "mcp", "context", "vars", "skills", "code", "terminal", "browser"] {
            XCTAssertTrue(app.buttons["coding-overview-\(category)"].waitForExistence(timeout: 10),
                          "The category \(category) is missing in the Coding overview")
        }
        XCTAssertFalse(app.buttons["coding-overview-dynworkflows"].exists, "The Coding overview still shows \"Dynamic workflows\" as a category of its own")
        XCTAssertFalse(app.buttons["overview-new-chat"].isHittable,
                       "The overview is not in front of the chat list")
        // The overview itself has no arrow back — it is the place it leads to.
        // (The hidden chat list still carries its own, so check for OPERABLE.)
        XCTAssertNil(app.buttons.matching(identifier: "coding-back").allElementsBoundByIndex.first(where: { $0.isHittable }),
                     "The overview carries a back arrow that leads nowhere")
        attach(app, "Overview of the Coding tab")

        // A row leads into its category …
        app.buttons["coding-overview-agents"].tap()
        XCTAssertTrue(app.buttons["agents-new"].waitForExistence(timeout: 20),
                      "The row \"Agents\" did not land on the subagents page")
        // … and the arrow in front of the title back into the overview.
        XCTAssertTrue(tapCodingBack(app), "The way back is missing in the category")
        XCTAssertTrue(app.buttons["coding-overview-mcp"].waitForExistence(timeout: 10),
                      "The back arrow did not lead into the overview")

        // "Skills" is a Coding category; the list above checks its row too.

        // The right drawer shortens the way and leaves the overview too.
        openCategory(app, "mcp")
        XCTAssertTrue(app.buttons["mcp-new"].waitForExistence(timeout: 20),
                      "The drawer did not lead from the overview into the MCP servers")
        XCTAssertFalse(app.buttons["coding-overview-chats"].exists, "The overview still stands in front of the category")

        // Back to the chats: the row opens the chat list, which stayed mounted behind it.
        XCTAssertTrue(tapCodingBack(app), "The way back is missing in the MCP servers")
        XCTAssertTrue(app.buttons["coding-overview-chats"].waitForExistence(timeout: 10))
        app.buttons["coding-overview-chats"].tap()
        XCTAssertTrue(waitUntilHittable(app.buttons["overview-new-chat"], timeout: 10),
                      "The row \"Chats\" did not show the chat overview")
    }

    // ── Places: Apps and Profile (at the top of the right drawer) ──
    func testRightDrawerSwitchesBetweenCodingAppsAndProfile() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.otherElements["top-bar"].waitForExistence(timeout: 25))

        selectLocation(app, "apps")
        XCTAssertTrue(
            app.staticTexts["Projects & Stacks"].waitForExistence(timeout: 15),
            "The apps page was not opened"
        )
        attach(app, "Apps page")

        selectLocation(app, "profile")
        XCTAssertTrue(
            app.staticTexts["Account"].waitForExistence(timeout: 15),
            "The profile page was not opened"
        )
        attach(app, "Profile page")

        selectLocation(app, "workspaces")
        codingCategoryFromOverview(app, "chats")
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 15))
    }

    // ── Archive ─────────────
    private static let archiveChatA = "20000000-0000-4000-8000-000000000002"   // "Architektur-Notizen"
    private static let archiveChatB = "20000000-0000-4000-8000-000000000003"   // "Zahlungs-Bug im Checkout"

    /// The fixture's archive state: archived chats, archived folders, permanently deleted ones, dismissed cards.
    private func archiveStatus(_ server: String) -> (chats: [String], folder: [String], deleted: [String], dismissed: Int) {
        let j = fixtureJSON(server + "/fixture/archive") ?? [:]
        return ((j["chats"] as? [String]) ?? [], (j["folder"] as? [String]) ?? [],
                (j["deleted"] as? [String]) ?? [], (j["dismissed"] as? Int) ?? -1)
    }

    /// Context menu of a card/folder row of the overview — with a restart per attempt (the long press arrives as a tap in
    /// about every second process, see `openContextMenu`). If the menu stays away in eight fresh processes, that is the
    /// gesture, not a finding about the app: then skip, do not lie red or green.
    private func overviewMenu(_ app: XCUIApplication, _ row: String, _ point: String, proof: String) throws {
        guard openContextMenu(app, row: row, expecting: point, proof: proof,
                              restart: { app in self.normalizeToChatsOverview(app) }) else {
            throw XCTSkip("Context menu of \(row) could not be opened (the long press arrived as a tap) — \"\(point)\" unconfirmed")
        }
    }

    /// Context menu "Archive" ⇒ the card is gone; the archive button in the list header shows the chat; a tap opens it —
    /// although it is in no list any more (`SelectedChatHost` fetches it by id) — with the bar in place of the input;
    /// "Restore" brings input and card back.
    func testArchiveFromTheOverviewAndRestore() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let card = app.buttons["overview-chat-\(Self.archiveChatA)"]
        XCTAssertTrue(card.waitForExistence(timeout: 25), "The card \"Architektur-Notizen\" is missing")

        try overviewMenu(app, "overview-chat-\(Self.archiveChatA)", "Archive", proof: "Pin")
        menuItem(app, "Archive").tap()
        XCTAssertTrue(waitUntilGone(card, timeout: 10), "After \"Archive\" the card is still in the list")
        XCTAssertEqual(archiveStatus(server).chats, [Self.archiveChatA], "The server saw no archiving")
        attach(app, "Overview after archiving")

        let button = app.buttons["chats-archive"]
        XCTAssertTrue(waitUntilHittable(button, timeout: 8), "The archive button in the list header is missing")
        button.tap()
        let row = app.buttons["archive-row-\(Self.archiveChatA)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The archive does not show the archived chat")
        attach(app, "Archive list")
        row.tap()

        let bar = app.descendants(matching: .any)["archive-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 15), "The archived chat does not open with the archive bar")
        XCTAssertFalse(app.staticTexts["Chat not found"].exists, "The archived chat counts as \"not found\"")
        XCTAssertFalse(app.textViews["chat-composer"].exists, "An archived chat shows the input")
        attach(app, "Archived chat with bar")

        app.buttons["archive-bar-restore"].tap()
        XCTAssertTrue(app.textViews["chat-composer"].waitForExistence(timeout: 10), "After restoring the input is missing")
        XCTAssertTrue(waitUntilGone(bar, timeout: 6), "After restoring the bar is still there")
        XCTAssertEqual(archiveStatus(server).chats, [], "The server saw no restoring")
        normalizeToChatsOverview(app)
        XCTAssertTrue(card.waitForExistence(timeout: 10), "The card did not come back after restoring")
    }

    /// Open work ⇒ the hint names the reasons as server text, and nothing is archived. If the open question is the ONLY
    /// reason, "Discard the question and archive" stands next to it; with an open shell, a prompt that it will be ended
    /// comes first. Via the ⋯ of the open chat (a tap, no long press — this test is meant to measure the pre-check, not
    /// the gesture).
    func testArchiveWithOpenWorkNamesTheReason() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            _ = self.fixturePost(server + "/fixture/archive", body: ["open": "open"])
        })
        normalizeToChatsOverview(app)
        let card = app.buttons["overview-chat-\(Self.archiveChatA)"]
        XCTAssertTrue(card.waitForExistence(timeout: 25))
        card.tap()
        let input = app.textViews["chat-composer"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "The chat did not open")

        func archiveOverMenu() {
            let menu = app.buttons["chat-menu"]
            XCTAssertTrue(waitUntilHittable(menu, timeout: 8), "The ⋯ of the chat is missing")
            menu.tap()
            let point = menuItem(app, "Archive")
            XCTAssertTrue(point.waitForExistence(timeout: 6), "\"Archive\" is missing in the ⋯")
            point.tap()
        }

        // ── Run + queue: blocked, both reasons verbatim, no discard button ──
        archiveOverMenu()
        let hint = app.alerts["Work is still open in this chat — not archived"]
        XCTAssertTrue(hint.waitForExistence(timeout: 10), "No hint about the open work")
        let text = hint.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
        XCTAssertTrue(text.contains("Ein Lauf ist aktiv"), "The hint does not name the run: \(text)")
        XCTAssertTrue(text.contains("1 Nachricht wartet in der Warteschlange"), "The hint does not name the queue: \(text)")
        XCTAssertFalse(hint.buttons["Discard the question and archive"].exists,
                       "The discard option is offered although more than the question is open")
        attach(app, "Hint: work open")
        hint.buttons["OK"].tap()
        XCTAssertTrue(waitUntilGone(hint, timeout: 5))
        XCTAssertEqual(archiveStatus(server).chats, [], "Archived despite open work")
        XCTAssertTrue(input.exists, "The input vanished although nothing was archived")

        // ── Only the question, plus a shell: discard ⇒ shell prompt ⇒ archived ──
        XCTAssertNotNil(fixturePost(server + "/fixture/archive", body: ["open": "question", "shells": 1]))
        archiveOverMenu()
        let onlyQuestion = app.alerts["Work is still open in this chat — not archived"]
        XCTAssertTrue(onlyQuestion.waitForExistence(timeout: 10))
        let f13 = onlyQuestion.buttons["Discard the question and archive"]
        XCTAssertTrue(f13.exists, "With only an open question \"Discard the question and archive\" is missing")
        attach(app, "Hint: only question")
        f13.tap()
        let shells = app.alerts["Archive? 1 open shell will be ended."]
        XCTAssertTrue(shells.waitForExistence(timeout: 10), "The open shell is not announced")
        XCTAssertEqual(archiveStatus(server).chats, [], "Archived before the shell prompt was answered")
        shells.buttons["Archive"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["archive-bar"].waitForExistence(timeout: 10),
                      "After discarding there is no archive bar in the open chat")
        let snapshot = archiveStatus(server)
        XCTAssertEqual(snapshot.chats, [Self.archiveChatA])
        XCTAssertEqual(snapshot.dismissed, 1, "The PUT carried no `dismissQuestion`")
    }

    /// The folder goes into the archive with its chats; ONE chat back out of it ⇒ the folder is back, with exactly this
    /// chat — the other stays in the archive.
    func testFolderArchiveAndIndividualRestore() throws {
        let server = try requireFixture()
        var folderId = ""
        let app = launchApp(server: server, preparation: {
            let response = self.fixturePost(server + "/fixture/archive", body: [
                "createFolder": ["name": "Research", "chatIds": [Self.archiveChatA, Self.archiveChatB]],
            ])
            folderId = response?["folderId"] as? String ?? ""
        })
        XCTAssertFalse(folderId.isEmpty, "The fixture did not create a folder")
        normalizeToChatsOverview(app)
        let folder = app.buttons.matching(identifier: "overview-folder-\(folderId)").firstMatch
        XCTAssertTrue(folder.waitForExistence(timeout: 25), "The seeded folder is missing in the overview")

        try overviewMenu(app, "overview-folder-\(folderId)", "Archive", proof: "Rename")
        menuItem(app, "Archive").tap()
        XCTAssertTrue(waitUntilGone(folder, timeout: 10), "The archived folder is still in the list")
        XCTAssertFalse(app.buttons["overview-chat-\(Self.archiveChatA)"].exists)
        XCTAssertFalse(app.buttons["overview-chat-\(Self.archiveChatB)"].exists)
        var snapshot = archiveStatus(server)
        XCTAssertEqual(snapshot.folder, [folderId])
        XCTAssertEqual(Set(snapshot.chats), [Self.archiveChatA, Self.archiveChatB])

        app.buttons["chats-archive"].tap()
        XCTAssertTrue(app.buttons["archive-folder-\(folderId)"].waitForExistence(timeout: 10), "The archive does not show the folder")
        XCTAssertTrue(app.buttons["archive-row-\(Self.archiveChatA)"].exists)
        XCTAssertTrue(app.buttons["archive-row-\(Self.archiveChatB)"].exists)
        attach(app, "Archived folder")
        app.buttons["archive-menu-\(Self.archiveChatA)"].tap()
        let back = app.buttons["Restore"]
        XCTAssertTrue(back.waitForExistence(timeout: 6), "\"Restore\" is missing in the ⋯ of the archive row")
        back.tap()
        XCTAssertTrue(waitUntilGone(app.buttons["archive-row-\(Self.archiveChatA)"], timeout: 10),
                      "The restored chat is still in the archive")
        XCTAssertTrue(app.buttons["archive-row-\(Self.archiveChatB)"].exists, "The other chat left the archive too")
        snapshot = archiveStatus(server)
        XCTAssertEqual(snapshot.folder, [], "The folder did not come back with its chat")
        XCTAssertEqual(snapshot.chats, [Self.archiveChatB])
        app.buttons["archive-finished"].tap()

        XCTAssertTrue(folder.waitForExistence(timeout: 10), "The folder is not in the list after restoring")
        let chatA = app.buttons["overview-chat-\(Self.archiveChatA)"]
        if !chatA.waitForExistence(timeout: 3) { folder.tap() }
        XCTAssertTrue(chatA.waitForExistence(timeout: 6), "The restored chat is not in the folder")
        XCTAssertFalse(app.buttons["overview-chat-\(Self.archiveChatB)"].exists, "The archived chat is in the folder again")
        attach(app, "Folder with the one restored chat")
    }

    /// "Delete" on the card asks for confirmation (a tap must not delete at once), and a 409 from the server leaves the
    /// card in place and shows its message (the card must not vanish although the chat stays).
    func testDeleteAsksAfterAndStaysAt409() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            _ = self.fixturePost(server + "/fixture/archive", body: ["delete409": true])
        })
        normalizeToChatsOverview(app)
        let card = app.buttons["overview-chat-\(Self.archiveChatA)"]
        XCTAssertTrue(card.waitForExistence(timeout: 25))

        try overviewMenu(app, "overview-chat-\(Self.archiveChatA)", "Delete", proof: "Pin")
        app.buttons["Delete"].tap()
        let confirm = app.buttons["Delete permanently"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 8), "\"Delete\" does not ask for confirmation")
        XCTAssertTrue(card.exists, "The card vanished before the confirmation")
        attach(app, "Delete confirmation")
        confirm.tap()

        let error = app.alerts["Delete failed"]
        XCTAssertTrue(error.waitForExistence(timeout: 10), "The server's 409 is not reported")
        let text = error.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
        XCTAssertTrue(text.contains("Chat is running"), "The hint does not name the server message: \(text)")
        error.buttons["OK"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 4), "After the 409 the card is missing")
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertTrue(card.exists, "After the 409 the card vanished")
        XCTAssertEqual(archiveStatus(server).deleted, [], "The fixture deleted despite the 409")
    }

    /// The delete prompt of a folder names the context files that go with it.
    func testFolderDeleteNamesContextFiles() throws {
        let server = try requireFixture()
        var folderId = ""
        let app = launchApp(server: server, preparation: {
            let response = self.fixturePost(server + "/fixture/archive", body: [
                "createFolder": ["name": "Research", "chatIds": [Self.archiveChatA]],
            ])
            folderId = response?["folderId"] as? String ?? ""
            _ = self.fixturePost(server + "/fixture/archive", body: ["contextFiles": [folderId: 2]])
        })
        XCTAssertFalse(folderId.isEmpty, "The fixture did not create a folder")
        normalizeToChatsOverview(app)
        let folder = app.buttons.matching(identifier: "overview-folder-\(folderId)").firstMatch
        XCTAssertTrue(folder.waitForExistence(timeout: 25))

        try overviewMenu(app, "overview-folder-\(folderId)", "Delete folder", proof: "Rename")
        app.buttons["Delete folder"].tap()
        let set = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "The folder's 2 context files will be deleted.")).firstMatch
        XCTAssertTrue(set.waitForExistence(timeout: 10), "The delete prompt does not name the context files")
        attach(app, "Folder delete prompt with context files")
        // Tap away instead of "Cancel": since iOS 26 the action sheet on the iPhone shows no cancel button
        // any more (measured: the button with the role `.cancel` is not in the tree).
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(waitUntilGone(set, timeout: 6), "The delete prompt did not go away")
        XCTAssertTrue(folder.waitForExistence(timeout: 6), "Tapping away deleted the folder")
    }

    /// The prompt before PERMANENTLY deleting an archived folder names the SERVER's numbers — even when the search has cut
    /// the group down to one chat. It must not count the filtered group: search "bug" ⇒ "1 chat will be lost", both were
    /// deleted. Checked are the sentence AND afterwards what the fixture really deleted — the number must match the
    /// deletion, not only itself.
    func testFolderPermanentlyDeleteNamesTheNumbersOfTheServers() throws {
        let server = try requireFixture()
        var folderId = ""
        let app = launchApp(server: server, preparation: {
            let response = self.fixturePost(server + "/fixture/archive", body: [
                "createFolder": ["name": "Research", "chatIds": [Self.archiveChatA, Self.archiveChatB]],
            ])
            folderId = response?["folderId"] as? String ?? ""
            _ = self.fixturePost(server + "/fixture/archive", body: [
                "archiveFolder": [folderId], "contextFiles": [folderId: 2],
            ])
        })
        XCTAssertFalse(folderId.isEmpty, "The fixture did not create a folder")
        XCTAssertEqual(Set(archiveStatus(server).chats), [Self.archiveChatA, Self.archiveChatB], "The seed did not archive the folder along")
        normalizeToChatsOverview(app)
        let button = app.buttons["chats-archive"]
        XCTAssertTrue(waitUntilHittable(button, timeout: 25), "The archive button in the list header is missing")
        button.tap()
        XCTAssertTrue(app.buttons["archive-folder-\(folderId)"].waitForExistence(timeout: 10), "The archive does not show the folder")
        XCTAssertTrue(app.buttons["archive-row-\(Self.archiveChatA)"].waitForExistence(timeout: 5))

        // The search cuts the group down to "Zahlungs-Bug im Checkout" — exactly the state in which the old number lied.
        let search = app.textFields["archive-search"]
        XCTAssertTrue(waitUntilHittable(search, timeout: 6), "The archive search is missing")
        search.tap()
        search.typeText("bug")
        XCTAssertTrue(waitUntilGone(app.buttons["archive-row-\(Self.archiveChatA)"], timeout: 6),
                      "The search does not cut the group — the test would then not check the case at hand")
        XCTAssertTrue(app.buttons["archive-row-\(Self.archiveChatB)"].exists, "The search hit is missing")
        attach(app, "Archive with search \"bug\"")

        let menu = app.buttons["archive-menu-\(folderId)"]
        XCTAssertTrue(waitUntilHittable(menu, timeout: 6), "The ⋯ of the archived folder is missing")
        menu.tap()
        let point = app.buttons["Delete permanently"]
        XCTAssertTrue(point.waitForExistence(timeout: 6), "\"Delete permanently\" is missing in the folder's ⋯")
        point.tap()

        let expected = "Delete folder \"Research\" permanently? 2 chats and 2 context files will be lost."
        let question = app.staticTexts.matching(NSPredicate(format: "label == %@", expected)).firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 10),
                      "The prompt does not name the server's numbers (2 chats, 2 context files): "
                      + app.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0.contains("permanently?") }.joined(separator: " | "))
        attach(app, "Prompt with the server's numbers")
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Delete permanently")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "The prompt has no button \"Delete permanently\"")
        confirm.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 10) { Set(self.archiveStatus(server).deleted) == [Self.archiveChatA, Self.archiveChatB] },
            "What was deleted is not what the prompt named: \(archiveStatus(server).deleted)"
        )
    }

    /// The goal of an ARCHIVED chat can be read but not changed. The header button stays (reading is allowed), the sheet
    /// has no "Save" and no "Remove goal" — both would lead into the write lock's 409 ("The chat is archived — read only").
    func testArchivedChatShowsTheGoalReadOnly() throws {
        let server = try requireFixture()
        let target = "Prepare release 1.0"
        let app = launchApp(server: server, preparation: {
            _ = self.fixturePost(server + "/fixture/archive", body: [
                "target": ["chatId": Self.archiveChatA, "text": target], "archive": [Self.archiveChatA],
            ])
        })
        normalizeToChatsOverview(app)
        let button = app.buttons["chats-archive"]
        XCTAssertTrue(waitUntilHittable(button, timeout: 25), "The archive button in the list header is missing")
        button.tap()
        let row = app.buttons["archive-row-\(Self.archiveChatA)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The archive does not show the archived chat")
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["archive-bar"].waitForExistence(timeout: 15),
                      "The archived chat does not open with the archive bar")

        let targetButton = app.buttons["chat-goal"]
        XCTAssertTrue(waitUntilHittable(targetButton, timeout: 8), "The header's goal button is missing — the goal may be read in the archive too")
        targetButton.tap()
        let text = app.staticTexts["goal-only-read"]
        XCTAssertTrue(text.waitForExistence(timeout: 8), "The sheet does not show the goal read-only (an input field instead of text?)")
        XCTAssertEqual(text.label, target, "The sheet shows a different goal")
        XCTAssertFalse(app.buttons["Save"].exists, "In the archive the goal sheet offers \"Save\" (ends in the 409)")
        XCTAssertFalse(app.buttons["Remove goal"].exists, "In the archive the goal sheet offers \"Remove goal\"")
        attach(app, "Goal of an archived chat, read only")
        app.buttons["goal-close"].tap()
        XCTAssertTrue(waitUntilGone(text, timeout: 6), "The goal sheet did not close")
    }

    /// The effort selection in the "New chat" sheet: the levels of the chosen model (default: the active provider Codex
    /// with GPT-5.6 Sol, all five), and after switching to GPT-5.5 (no `max`) the chosen level stands marked with its
    /// substitute — the same building block as in the three other places (`Kit/EffortSelection.swift`).
    func testEffortSelectionInNewChat() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let fresh = app.buttons["overview-new-chat"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "The \"New chat\" button is missing")
        fresh.tap()
        let create = app.buttons["Start"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The \"New chat\" sheet does not appear")
        // "Start" is active only once the provider list has arrived (and the levels are loaded).
        XCTAssertTrue(waitUntil(timeout: 15) { create.isEnabled }, "The provider list did not arrive")
        // Ultracode stands below as a switch of its own (`testUltracodeInNewChat`), not in the selection.
        checkEffortSelection(app, ["Low", "Medium", "High", "X-High", "Max"], choice: "Max", "New chat, GPT-5.6 Sol")
        selectInPicker(app, "Model", "GPT-5.5")
        checkEffortSelection(app, ["Low", "Medium", "High", "X-High", "Max · runs as X-High"], choice: "Max · runs as X-High", "New chat, GPT-5.5")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(waitUntilGone(create, timeout: 6), "The sheet does not close")
    }

    /// In the "New chat" sheet the building block hides the effort selection where there is no level — on the provider
    /// "Ohne Denkgrad" (`caps.effort: false` in the fixture) and on Haiku 4.5 (`efforts: []`). Back on Codex it is there again.
    func testEffortSelectionMissingInNewChatWithoutLevels() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let fresh = app.buttons["overview-new-chat"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "The \"New chat\" button is missing")
        fresh.tap()
        let create = app.buttons["Start"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The \"New chat\" sheet does not appear")
        XCTAssertTrue(waitUntil(timeout: 15) { create.isEnabled }, "The provider list did not arrive")
        XCTAssertTrue(pickerRow(app, "Effort").exists, "On Codex the effort selection is missing")
        selectInPicker(app, "Providers", "Ohne Denkgrad")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists },
                      "On the provider without an effort level an effort selection is still there: \(pickerRow(app, "Effort").label)")
        XCTAssertTrue(app.descendants(matching: .any)["ultracode-toggle"].exists, "The Ultracode switch below stays — only the effort selection is missing")
        selectInPicker(app, "Providers", "Claude Code")
        selectInPicker(app, "Model", "Haiku 4.5")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists }, "On Haiku 4.5 an effort selection is still there")
        attach(app, "New chat, Haiku 4.5 without effort")
        selectInPicker(app, "Providers", "OpenAI Codex")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 6), "Back on Codex the effort selection is missing")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(waitUntilGone(create, timeout: 6), "The sheet does not close")
    }

    /// Ultracode in the "New chat" sheet (a switch of its own below the effort selection): it also stands on a model without
    /// levels (Haiku 4.5) and stays across model switches — and the creation sends, like the web, `ultracode: true` NEXT TO a
    /// level, never "ultracode" as the level (the server answered 400 to that). Measured on the body that was sent.
    func testUltracodeInNewChat() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        let prior = fixtureCreateCount(server)
        XCTAssertNotNil(prior, "The fixture state is not readable")
        let fresh = app.buttons["overview-new-chat"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 20), "The \"New chat\" button is missing")
        fresh.tap()
        let create = app.buttons["Start"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "The \"New chat\" sheet does not appear")
        XCTAssertTrue(waitUntil(timeout: 15) { create.isEnabled }, "The provider list did not arrive")

        let toggle = app.switches["ultracode-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 6), "The Ultracode switch is missing in the new chat")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 4) { toggle.value as? String == "1" }, "The switch does not flip")

        // Haiku 4.5 carries no levels — no effort selection, the switch stands anyway and stays on.
        selectInPicker(app, "Providers", "Claude Code")
        selectInPicker(app, "Model", "Haiku 4.5")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists }, "On Haiku 4.5 an effort selection is there")
        XCTAssertEqual(toggle.value as? String, "1", "On Haiku 4.5 the switch is gone or off")
        selectInPicker(app, "Providers", "OpenAI Codex")
        XCTAssertEqual(toggle.value as? String, "1", "Back on Codex the Ultracode preselection is gone")

        create.tap()
        // The draft carries the choice until the first message — only it creates the chat.
        firstMessageInDraft(app, server: server, prior: prior)
        XCTAssertTrue(
            waitForFixture(timeout: 15) {
                (fixtureJSON(server + "/fixture/state")?["lastChatCreate"] as? [String: Any])?["ultracode"] as? Bool == true
            },
            "The creation sent no `ultracode: true`: \(String(describing: fixtureJSON(server + "/fixture/state")?["lastChatCreate"]))"
        )
        let body = fixtureJSON(server + "/fixture/state")?["lastChatCreate"] as? [String: Any] ?? [:]
        let levels = ["low", "medium", "high", "xhigh", "max"]
        XCTAssertTrue(levels.contains(body["effort"] as? String ?? ""),
                      "A level goes out next to the mode (like `effortForCreation` on the web), never \"ultracode\": \(String(describing: body["effort"]))")
        XCTAssertEqual(body["provider"] as? String, "codex", "The creation went to the wrong provider")
        XCTAssertEqual(body["model"] as? String, "gpt-5.6-sol", "The creation went with the wrong model")
        XCTAssertEqual(fixtureCreateCount(server), prior.map { $0 + 1 }, "The sheet did not create EXACTLY one chat")
    }

    // ── The shell follows the ANNOUNCED keyboard, not SwiftUI's region ────
    /// Symptom: the overview card ended 100 pt above the edge. The way there: a keyboard in the chat goes away WITHOUT an
    /// animation (‹ back, `willChangeFrame endMinY=874 dur=0`) while the 100 pt high `KeyboardGripAccessory` hangs. Afterwards
    /// UIKit's keyboard tracking stands jammed (guide 774/100 without keyboard), and the NEXT keyboard outside a chat reads it
    /// 100 pt too short (announcement 539/335, guide and SwiftUI's region 235). The shell followed this region: the terminal's
    /// input field then lay 46 pt INSIDE the keyboard, fresh 54 pt above it. The shell now follows the announcement
    /// (`KeyboardAnnouncement.frame`, `AppShell`). Compared with the fresh gap in the SAME run, not with a fixed number; the
    /// field's resting position must stay the same too (the picture from the finding — region without keyboard — would show there).
    func testTerminalInputStandsAfterKeyboardInChatOverTheKeyboard() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)

        let fresh = terminalInputSituation(app, "Terminal fresh")
        XCTAssertGreaterThan(fresh.gap, 0, "Even fresh the terminal input lies inside the keyboard: \(fresh)")

        // The way: keyboard in the chat, then ‹ back — it goes without an animation.
        try openFirstChat(app)
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The chat's input field is missing")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8), "The keyboard does not open in the chat")
        _ = quietValue(timeout: 5) { app.keyboards.firstMatch.frame.minY }
        let back = app.buttons["chat-back"].firstMatch
        XCTAssertTrue(waitUntilHittable(back, timeout: 8), "The ‹ button is missing")
        back.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 6), "The keyboard does not go away with ‹")
        XCTAssertTrue(waitUntilHittable(app.buttons["overview-new-chat"], timeout: 10), "‹ does not lead into the overview")

        let afterwards = terminalInputSituation(app, "Terminal after the keyboard in the chat")
        XCTAssertEqual(afterwards.quiet, fresh.quiet, accuracy: 2,
                       "Without a keyboard the terminal input stands elsewhere after the chat than fresh (fresh \(fresh), afterwards \(afterwards))")
        XCTAssertGreaterThan(afterwards.gap, 0,
                             "The terminal input lies INSIDE the keyboard — the shell follows the jammed region (fresh \(fresh), afterwards \(afterwards))")
        XCTAssertEqual(afterwards.gap, fresh.gap, accuracy: 2,
                       "The terminal input stands differently above the keyboard than fresh (fresh \(fresh), afterwards \(afterwards))")
    }

    /// Open the terminal, take the input's resting position, tap it and measure its gap to the top edge of the keyboard
    /// (positive = above); finally close the keyboard via the swipe to the drawer, as a user would carry on.
    private func terminalInputSituation(_ app: XCUIApplication, _ name: String) -> (quiet: CGFloat, gap: CGFloat) {
        openCategory(app, "terminal")
        let open = app.buttons["terminal-open"]
        if open.waitForExistence(timeout: 6) { open.tap() }
        let field = app.textFields["terminal-input"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "The terminal input is missing")
        let quiet = quietValue(timeout: 6) { field.frame.maxY }
        field.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 8), "The terminal keyboard does not open")
        _ = quietValue(timeout: 6) { keyboard.frame.minY }
        let bottomEdge = quietValue(timeout: 6) { field.frame.maxY }
        let gap = keyboard.frame.minY - bottomEdge
        attach(app, "\(name): gap \(String(format: "%.1f", gap)) pt")
        normalizeToChatsOverview(app)
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 6), "The terminal keyboard does not go away")
        return (quiet, gap)
    }

    /// Reads a value until two readings 0.3 s apart are equal (a movement is over).
    private func quietValue(timeout: TimeInterval, _ read: () -> CGFloat) -> CGFloat {
        var value = read()
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            Thread.sleep(forTimeInterval: 0.3)
            let fresh = read()
            if abs(fresh - value) < 0.5 { return fresh }
            value = fresh
        } while Date() < deadline
        return value
    }

    /// "Start" in the "New chat" sheet opens a DRAFT — the chat is created only with the first message, with the chosen
    /// values. Proves both: while the draft's composer stands, no chat is created yet; then the first message goes out.
    private func firstMessageInDraft(_ app: XCUIApplication, server: String, prior: Int?, _ text: String = "First message") {
        let composer = textEntry(app, "chat-composer")
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The draft's composer is missing")
        XCTAssertEqual(fixtureCreateCount(server), prior, "\"Start\" already created a chat — it is created only on sending")
        // Without a keyboard the island stands at the bottom, above the home-indicator strip: after a keyboard in the chat list
        // (folder name in the alert) the shell's resting value stayed at the keyboard height — the draft lay above a 383 pt
        // padding, and its field took no focus (AppShell `windowBottomInset`). Island bottom edge ≈ 43 pt above the window
        // edge (34 home indicator + 9 padding).
        let island = app.descendants(matching: .any)["composer-island"]
        XCTAssertTrue(island.waitForExistence(timeout: 10), "The island is missing")
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThan(island.frame.maxY, window.maxY - 90,
                             "The island does not stand at the bottom (island \(island.frame), window \(window))")
        XCTAssertLessThan(island.frame.maxY, window.maxY - 20,
                          "The island reaches into the home-indicator strip (island \(island.frame), window \(window))")
        composer.tap()
        composer.typeText(text)
        let send = app.buttons["chat-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "The send button is missing")
        send.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 15) { self.fixtureCreateCount(server) == prior.map { $0 + 1 } },
            "The first message did not create the chat"
        )
    }
}
