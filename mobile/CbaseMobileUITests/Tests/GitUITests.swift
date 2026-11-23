import XCTest

// The git sheet of the chat header (= Coding → Code/Git, the same view as `Code/GitPane.swift`).
//
// Repositories · Changes · Graph, mirroring the desktop git sidebar: collapsing is remembered (across a restart, without the
// `gitPins` clamp), a tap on a repo selects it and the graph follows, the graph shows lanes, merge and badges including the
// "Current Branch" choice, a commit unfolds with its files, and a file shows its diff IN that commit. The fixture is read as
// well (`GET /fixture/git`: `logRequests`, `showRequests`) — what the app asked the server, not only what it draws. The
// computation itself (lanes, badges, selection) is bound against the web in web/test/git-bar-ios-binding.test.mjs; this file
// covers the surface.
//
// Pull down: SwiftUI cancelled the `.refreshable` task as soon as `GitModel.load()` set `loading = true` and the sheet
// redrew; the running request ended as a `CancellationError` and showed up as a message in the sheet. Measurement and fix in
// `Kit/CbRefresh.swift`. The fixture delays the fetch (`/fixture/git {slow}`) so the cancellation reliably hits the request.
// Counter-test: without `cbRefreshable` it is red — "Round 0: pulling down reports the cancellation as an error: The
// operation couldn't be completed. (Swift.CancellationError error 1.)".
final class GitUITests: CbaseUITestBase {
    /// Opens the git sheet of the fixture chat and pulls it to full height.
    func openGitSheet(_ app: XCUIApplication) throws {
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))
        let gitButton = app.descendants(matching: .any)["chat-git"]
        XCTAssertTrue(gitButton.waitForExistence(timeout: 20), "The git icon is missing from the header")
        gitButton.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-git-sheet"].waitForExistence(timeout: 10), "The git sheet did not open")
        XCTAssertTrue(app.staticTexts["fn/till"].waitForExistence(timeout: 10), "The branch is missing from the sheet")
        expandSheet(app)
    }

    /// The header of a section (`repos`, `changes`, `graph`) — its value says "expanded" or "collapsed".
    func section(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.buttons["git-section-\(id)"]
    }

    func isCollapsed(_ header: XCUIElement) -> Bool { (header.value as? String) == "collapsed" }

    /// Waits until the header carries the expected state.
    func waitForState(_ header: XCUIElement, collapsed: Bool, timeout: TimeInterval = 5) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if header.exists, isCollapsed(header) == collapsed { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// The graph's requests recorded by the fixture (`logRequests` or `showRequests`).
    func graphRequests(_ server: String, _ kind: String) -> [[String: Any]] {
        (fixtureJSON(server + "/fixture/git")?[kind] as? [[String: Any]]) ?? []
    }

    func waitForRequest(_ server: String, _ kind: String, timeout: TimeInterval = 8, _ matches: ([String: Any]) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if graphRequests(server, kind).contains(where: matches) { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// Collapses "Changes" so the graph sits at the top of the sheet (the `gitPins` clamp reopens it on the next start).
    func changesTo(_ app: XCUIApplication) {
        let header = section(app, "changes")
        XCTAssertTrue(header.waitForExistence(timeout: 10), "The \"Changes\" header is missing")
        if !isCollapsed(header) { header.tap() }
        XCTAssertTrue(waitForState(header, collapsed: true), "\"Changes\" did not collapse")
    }

    func commitRow(_ app: XCUIApplication, _ short: String) -> XCUIElement {
        app.buttons["git-commit-\(short)"]
    }

    /// Pulls down in the sheet's content (started at the top, slow, with a hold — only then does the refresh kick in).
    func pullDown(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(
            forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)),
            withVelocity: .slow,
            thenHoldForDuration: 0.4
        )
    }

    func testPullDownInGitSheetShowsTheAbortNotAsError() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")
        let app = launchApp(server: server)
        try openGitSheet(app)
        Thread.sleep(forTimeInterval: 1)
        XCTAssertNotNil(fixturePost(server + "/fixture/git", body: ["slow": 1500]), "The fixture did not accept the delay")

        let abort = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "operation couldn")).firstMatch
        for round in 0..<2 {
            pullDown(app)
            XCTAssertFalse(abort.waitForExistence(timeout: 2.5),
                           "Round \(round): pulling down reports the cancellation as an error: \(abort.exists ? abort.label : "")")
            Thread.sleep(forTimeInterval: 1.5)
        }
        attach(app, "After pulling down")

        // A REAL error still shows.
        XCTAssertNotNil(fixturePost(server + "/fixture/git", body: ["fail": true]), "The failure switch had no effect")
        pullDown(app)
        XCTAssertTrue(app.staticTexts["Fixture failure"].waitForExistence(timeout: 6), "A real error while pulling down does not show")
        XCTAssertFalse(abort.exists, "The cancellation shows next to the real error")
        attach(app, "Real error after pulling down")
    }

    /// Collapsing toggles per section and is remembered across a restart (UserDefaults `cbase-git-sections-closed`, the same key as
    /// localStorage on the web). Runs without the `gitPins` clamp — the test cleans up after itself (everything open).
    func testSectionsCollapseAndStayRemembered() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")
        var app = launchApp(server: server, gitPins: false)
        try openGitSheet(app)
        let changes = section(app, "changes"), graph = section(app, "graph")
        XCTAssertTrue(changes.waitForExistence(timeout: 10) && graph.waitForExistence(timeout: 10), "The section headers are missing")
        XCTAssertTrue(section(app, "repos").waitForExistence(timeout: 5), "\"Repositories\" is missing with ONE repo (it shows always, like on the desktop)")
        // An earlier run that failed before cleaning up may have left something collapsed — open everything first.
        for header in [changes, graph] where isCollapsed(header) {
            header.tap()
            XCTAssertTrue(waitForState(header, collapsed: false), "A collapsed section did not open")
        }
        XCTAssertTrue(app.descendants(matching: .any)["git-change-src/checkout.ts"].waitForExistence(timeout: 5), "Open, the files are missing")
        XCTAssertTrue(commitRow(app, "3f9a2b7").waitForExistence(timeout: 10), "Open, the graph is missing")
        attach(app, "Git sheet: all sections open")

        graph.tap()
        XCTAssertTrue(waitForState(graph, collapsed: true), "The graph did not collapse")
        XCTAssertTrue(waitUntilGone(commitRow(app, "3f9a2b7"), timeout: 5), "Collapsed, the graph is still there")
        changes.tap()
        XCTAssertTrue(waitForState(changes, collapsed: true), "\"Changes\" did not collapse")
        XCTAssertTrue(waitUntilGone(app.descendants(matching: .any)["git-change-src/checkout.ts"], timeout: 5),
                      "Collapsed, the files are still there")
        XCTAssertEqual(changes.label, "Changes", "The header is not called \"Changes\"")
        attach(app, "Git sheet: Changes and graph collapsed")

        // Restart: the state comes back from UserDefaults.
        app.terminate()
        app = launchApp(server: server, gitPins: false)
        try openGitSheet(app)
        XCTAssertTrue(section(app, "graph").waitForExistence(timeout: 10))
        XCTAssertTrue(isCollapsed(section(app, "graph")), "After the restart the graph is open again — the collapsing was not remembered")
        XCTAssertTrue(isCollapsed(section(app, "changes")), "After the restart \"Changes\" is open again")
        XCTAssertFalse(commitRow(app, "3f9a2b7").exists, "After the restart the collapsed graph shows")

        // Clean-up: everything open again (otherwise the next run of this test would start collapsed — the other tests clamp it).
        section(app, "changes").tap()
        XCTAssertTrue(waitForState(section(app, "changes"), collapsed: false), "The clean-up did not open \"Changes\"")
        section(app, "graph").tap()
        XCTAssertTrue(waitForState(section(app, "graph"), collapsed: false), "The clean-up did not open the graph")
    }

    /// Several repos: "Repositories" appears, a tap shows exactly that repo under "Changes", and the graph follows it — only
    /// "Show all" takes the selection back, the graph's choice stays. Counter-check at the fixture: the graph asked for the chosen repo.
    func testRepoTapSelectsAndTheGraphFollows() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/git", body: ["second": true]), "The fixture did not accept the second repo")
        })
        try openGitSheet(app)
        XCTAssertTrue(section(app, "repos").waitForExistence(timeout: 10), "With two repos \"Repositories\" is missing")
        let main = app.buttons["git-repo-__root__"], frontend = app.buttons["git-repo-frontend"]
        XCTAssertTrue(main.exists && frontend.exists, "The repo rows are missing")
        // Default: both under "Changes" (frontend is clean and starts collapsed).
        XCTAssertTrue(app.buttons["git-repo-changes-__root__"].waitForExistence(timeout: 5), "The fixture project is missing under \"Changes\"")
        XCTAssertTrue(app.buttons["git-repo-changes-frontend"].exists, "frontend is missing under \"Changes\"")
        XCTAssertEqual(app.buttons["git-repo-changes-frontend"].value as? String, "collapsed", "A clean repo does not start collapsed")
        attach(app, "Git sheet: two repos")

        // A graph remembered from an earlier run does not matter: choose the fixture project first, then frontend.
        main.tap()
        XCTAssertTrue(waitUntilGone(app.buttons["git-repo-changes-frontend"], timeout: 5), "After the tap frontend is still under \"Changes\"")
        frontend.tap()
        XCTAssertTrue(app.buttons["git-repo-changes-frontend"].waitForExistence(timeout: 5), "frontend is not under \"Changes\"")
        XCTAssertFalse(app.buttons["git-repo-changes-__root__"].exists, "The unselected repo is still under \"Changes\"")
        XCTAssertEqual(frontend.value as? String, "selected", "The row does not carry the selection")
        XCTAssertTrue(app.staticTexts["1 of 2"].exists, "The header does not count the selection (\"1 of 2\")")
        XCTAssertTrue(scrollUntilHittable(app, commitRow(app, "a9c3e5b")), "The graph does not follow the selection (frontend: \"Startseite: Kacheln\")")
        XCTAssertTrue(app.buttons["git-graph-repo"].label.contains("frontend"),
                      "The graph header does not name the selected repo: \(app.buttons["git-graph-repo"].label)")
        XCTAssertFalse(commitRow(app, "3f9a2b7").exists, "The graph still shows the commits of the other repo")
        XCTAssertTrue(waitForRequest(server, "logRequests") { ($0["repo"] as? String) == "frontend" && ($0["graph"] as? String) == "all" },
                      "The graph did not ask for frontend (with graph: all)")
        XCTAssertTrue(graphRequests(server, "logRequests").allSatisfy { !(($0["chat"] as? String) ?? "").isEmpty },
                      "A graph request does not carry the chat (?chat=)")
        attach(app, "Git sheet: frontend selected, graph follows")

        // "Show all": both under "Changes" again, the graph stays with the choice.
        app.swipeDown()
        let all = app.buttons["git-repos-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 5), "\"Show all\" is missing")
        all.tap()
        XCTAssertTrue(app.buttons["git-repo-changes-__root__"].waitForExistence(timeout: 5), "After \"Show all\" the fixture project is missing")
        XCTAssertTrue(app.buttons["git-graph-repo"].label.contains("frontend"), "\"Show all\" reset the graph")

        // Clean-up: the graph back at the fixture project (the choice is remembered per scope).
        main.tap()
        XCTAssertTrue(scrollUntilHittable(app, commitRow(app, "3f9a2b7")), "The graph did not return to the fixture project")
    }

    /// The graph across all branches: HEAD with its branch, the merge commit, badges for local + remote on the same commit
    /// ("main · origin/main") and tags, the side branch `experiment/layout` — and "Current Branch" leaves it out (`graph: current`).
    func testGraphShowsBranchesMergeAndBadges() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")
        let app = launchApp(server: server)
        try openGitSheet(app)
        changesTo(app)
        let list = app.descendants(matching: .any)["git-graph-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), "The graph is missing")
        XCTAssertEqual(list.value as? String, "8", "The graph does not show all eight commits")

        let header = commitRow(app, "3f9a2b7")
        XCTAssertTrue(header.label.contains("Kasse: Rabatt runden") && header.label.contains("fn/till") && header.label.contains("HEAD"),
                      "The HEAD commit does not name subject, branch or HEAD: \(header.label)")
        let merge = commitRow(app, "9b4c6d2")
        XCTAssertTrue(merge.label.contains("Merge commit (2 parents)"), "The merge commit is not recognised as a merge: \(merge.label)")
        let main = commitRow(app, "c2a8e4f")
        XCTAssertTrue(main.label.contains("main · origin/main"), "local and remote on the same commit are not one badge: \(main.label)")
        XCTAssertTrue(main.label.contains("v1.2"), "The tag is missing: \(main.label)")
        XCTAssertTrue(commitRow(app, "7c1e5a9").label.contains("origin/fn/till"), "The upstream commit does not name its remote branch")
        XCTAssertTrue(commitRow(app, "51d7e3f").exists, "The side branch experiment/layout is missing under \"All\"")
        XCTAssertTrue(waitForRequest(server, "logRequests") { ($0["graph"] as? String) == "all" && ($0["limit"] as? Int) == 50 },
                      "The graph did not ask with graph: all and limit 50")
        attach(app, "Graph: all branches")

        let extent = app.buttons["git-graph-extent"]
        XCTAssertTrue(extent.label.contains("All"), "The extent does not say \"All\": \(extent.label)")
        extent.tap()
        let current = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Current Branch")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 5), "\"Current Branch\" is missing from the menu")
        current.tap()
        XCTAssertTrue(waitUntilGone(commitRow(app, "51d7e3f"), timeout: 8), "Under \"Current Branch\" the side branch is still there")
        XCTAssertEqual(app.descendants(matching: .any)["git-graph-list"].value as? String, "7", "Under \"Current Branch\" not seven commits")
        XCTAssertTrue(waitForRequest(server, "logRequests") { ($0["graph"] as? String) == "current" }, "The graph did not ask with graph: current")
        XCTAssertTrue(app.buttons["git-graph-extent"].label.contains("Current Branch"), "The extent does not name the choice")
        attach(app, "Graph: current branch")
    }

    /// A commit unfolds with its files (`…/git/show` with `files: true`), a file shows its diff IN that commit (`file`), a rename
    /// sends both paths (`old`), a merge says what it is compared against, and "Show whole commit" shows the whole one.
    /// Collapsing removes the files.
    func testCommitFoldsWithFilesOnAndShowsTheDiff() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")
        let app = launchApp(server: server)
        try openGitSheet(app)
        changesTo(app)
        let header = commitRow(app, "3f9a2b7")
        XCTAssertTrue(header.waitForExistence(timeout: 10), "The HEAD commit is missing from the graph")
        header.tap()
        XCTAssertTrue(app.descendants(matching: .any)["git-commit-files-3f9a2b7"].waitForExistence(timeout: 8), "The files did not unfold")
        let discount = app.buttons["git-commit-file-src/till/discount.ts"]
        XCTAssertTrue(discount.waitForExistence(timeout: 8), "The changed file is missing")
        XCTAssertTrue(app.buttons["git-commit-file-src/till/discount.test.ts"].exists, "The new file is missing")
        XCTAssertTrue(app.buttons["git-commit-file-docs/alt-discount.md"].label.hasPrefix("deleted"), "The deleted file is not labelled deleted")
        XCTAssertEqual(header.value as? String, "expanded", "The row does not say it is open")
        XCTAssertTrue(waitForRequest(server, "showRequests") { ($0["hash"] as? String)?.hasPrefix("3f9a2b7") == true && ($0["files"] as? Bool) == true },
                      "The files were not fetched with files: true")
        attach(app, "Graph: commit unfolded")

        discount.tap()
        let close = app.buttons["git-diff-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 8), "The file diff did not open")
        XCTAssertTrue(app.descendants(matching: .any)["git-diff-commit"].label.contains("3f9a2b7"), "The diff sheet does not name the commit")
        XCTAssertTrue(app.staticTexts["+neu in 3f9a2b7"].waitForExistence(timeout: 5), "The diff of this file in this commit is missing")
        XCTAssertTrue(waitForRequest(server, "showRequests") { ($0["file"] as? String) == "src/till/discount.ts" },
                      "The diff was not fetched with file")
        attach(app, "Graph: diff of a file in the commit")
        close.tap()
        XCTAssertTrue(waitUntilGone(close, timeout: 5), "The diff sheet did not close")

        let whole = app.buttons["git-commit-whole-3f9a2b7"]
        XCTAssertTrue(scrollUntilHittable(app, whole), "\"Show whole commit\" is missing under the files")
        whole.tap()
        XCTAssertTrue(app.buttons["git-diff-close"].waitForExistence(timeout: 8), "The whole commit did not open")
        XCTAssertTrue(waitForRequest(server, "showRequests") {
            ($0["hash"] as? String)?.hasPrefix("3f9a2b7") == true && $0["files"] is NSNull && $0["file"] is NSNull
        }, "The whole commit was not fetched without options")
        app.buttons["git-diff-close"].tap()
        XCTAssertTrue(waitUntilGone(app.buttons["git-diff-close"], timeout: 5), "The diff sheet did not close")

        // Collapsing removes the files; the merge says what it is compared against.
        XCTAssertTrue(scrollUntilHittable(app, header), "The HEAD commit is not reachable")
        header.tap()
        XCTAssertTrue(waitUntilGone(discount, timeout: 5), "Collapsed, the files are still there")
        let merge = commitRow(app, "9b4c6d2")
        XCTAssertTrue(scrollUntilHittable(app, merge), "The merge commit is not reachable")
        merge.tap()
        let against = app.descendants(matching: .any)["git-commit-against"]
        XCTAssertTrue(against.waitForExistence(timeout: 8), "The merge does not say what it is compared against")
        XCTAssertTrue(against.label.contains("e6b2d8f4"), "The merge does not name its first parent: \(against.label)")
        merge.tap()

        // A rename sends both paths.
        let main = commitRow(app, "c2a8e4f")
        XCTAssertTrue(scrollUntilHittable(app, main), "The commit on main is not reachable")
        main.tap()
        let renamed = app.buttons["git-commit-file-src/api/prices.ts"]
        XCTAssertTrue(renamed.waitForExistence(timeout: 8) && scrollUntilHittable(app, renamed), "The renamed file is missing")
        renamed.tap()
        XCTAssertTrue(app.buttons["git-diff-close"].waitForExistence(timeout: 8), "The diff of the renamed file did not open")
        XCTAssertTrue(waitForRequest(server, "showRequests") { ($0["file"] as? String) == "src/api/prices.ts" && ($0["old"] as? String) == "src/prices-api.ts" },
                      "The rename did not send both paths (alt)")
        XCTAssertTrue(app.staticTexts["src/prices-api.ts → src/api/prices.ts"].exists, "The title does not name old → new")
        attach(app, "Graph: diff of a renamed file")
        app.buttons["git-diff-close"].tap()
    }
}
