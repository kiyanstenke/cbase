// UI tests for the Coding categories other than chat: code tree and viewer, terminal, browser, git sheet, workflows, credentials, skills.
import XCTest

final class CodingUITests: CbaseUITestBase {
    // ── Terminal: content starts at the top, no sideways scrolling ──────────
    func testTerminalStartsAtTopAndWrapsInsteadOfScrollingSideways() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "terminal")

        if app.buttons["terminal-open"].waitForExistence(timeout: 8) {
            app.buttons["terminal-open"].tap()
        }
        let output = app.scrollViews["terminal-output"]
        XCTAssertTrue(output.waitForExistence(timeout: 20), "The terminal opens no output")
        let text = output.staticTexts.firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 20), "The terminal output is missing")

        XCTAssertLessThan(
            text.frame.minY - output.frame.minY,
            26,
            "The terminal output must start at the top and not sit in the middle"
        )
        XCTAssertLessThanOrEqual(
            text.frame.width,
            output.frame.width + 2,
            "The terminal output must not be wider than the window (no sideways scrolling)"
        )
        attach(app, "Terminal starts at top")

        // And the other side knows the real column count — otherwise it wraps at 80.
        let grid = fixtureTerminalGrid(server)
        XCTAssertNotNil(grid)
        if let grid {
            XCTAssertTrue(
                grid.cols > 20 && grid.cols < 80,
                "The PTY must get the phone's actual column count (was \(grid.cols))"
            )
            XCTAssertGreaterThan(grid.rows, 6)
        }
    }

    // ── Code drawer: buttons stay single-line ───────────────────────────────
    func testCodeSidebarButtonsStaySingleLine() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "code")

        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 8))
        let drawer = app.otherElements["left-drawer"]
        var checked = 0
        for label in ["New file", "Folder", "Upload"] {
            let button = app.buttons[label]
            guard button.exists else { continue }
            checked += 1
            XCTAssertLessThan(
                button.frame.height,
                36,
                "\(label) wraps onto two lines in the code drawer (height \(button.frame.height))"
            )
            XCTAssertLessThanOrEqual(
                button.frame.maxX,
                drawer.frame.maxX + 1,
                "\(label) sticks out of the drawer"
            )
        }
        XCTAssertGreaterThanOrEqual(checked, 2, "The code drawer buttons were not found")
        attach(app, "Code drawer with single-line buttons")
    }

    // ── Code drawer: upload is available without a project too ──────────────
    // The button used to be tied to projects (only they had an upload route). The
    // fixture stands at workspace level — it must still be there and open the
    // file picker (recognisable by it covering the tree).
    func testCodeSidebarUploadsAlsoWithoutProject() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "code")

        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 8))
        let row = app.buttons["file-readme.md"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The file tree is missing")

        let upload = app.buttons["code-upload"]
        XCTAssertTrue(upload.waitForExistence(timeout: 8), "The upload button is missing in workspace scope")
        upload.tap()
        let covered = waitForFixture(timeout: 12) { !row.isHittable }
        XCTAssertTrue(covered, "After \"Upload\" no file picker opens")
        attach(app, "File picker over the file tree")
        app.terminate() // do not let the modal system picker leak into the next test
    }

    // ── Code tree: long-press downloads a folder as ZIP ─────────────────────
    // The FILE download uses the same path (context menu → model.download → share sheet) and
    // is checked through the image preview's button — without a long press, see openContextMenu.
    func testLongPressOnFolderDownloadsZip() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/download", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "code")

        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 8))
        // If the automation fails to open the menu after eight attempts in eight FRESH processes
        // (state sticks to the process), it is the touch artefact described above and NOT a finding
        // about the app — then SKIP instead of reporting a false red (or, worse, a false green).
        // What the test checks afterwards then stays unchecked and must be verified by hand;
        // a skip in the full run is a finding (Tests/README.md). "Rename" is the proof of
        // an open menu WITHOUT the ZIP item — that would be the regression, not the gesture.
        guard openContextMenu(
            app, row: "file-src", expecting: "Download as ZIP", proof: "Rename",
            restart: { app in
                self.normalizeToChatsOverview(app)
                self.openCategory(app, "code")
                self.swipeRightAcrossScreen(app)
                _ = app.otherElements["left-drawer"].waitForExistence(timeout: 8)
            }
        ) else {
            throw XCTSkip(
                "Context menu could not be opened (the synthetic long press arrived as a tap) — "
                + "ZIP download unconfirmed, see openContextMenu. Visible: "
                + app.buttons.allElementsBoundByIndex.prefix(30)
                    .map { $0.identifier.isEmpty ? $0.label : $0.identifier }.joined(separator: " | ")
            )
        }
        app.buttons["Download as ZIP"].tap()

        XCTAssertTrue(
            waitForFixture(timeout: 15) {
                let state = fixtureJSON(server + "/fixture/download")
                return state?["path"] as? String == "src" && state?["dir"] as? Bool == true
            },
            "The server saw no folder download request"
        )
        XCTAssertTrue(shareSheetAppears(app), "No share sheet opens after the ZIP download")
        attach(app, "Share sheet after folder download")
        dismissShareSheet(app)
        // Terminate the app instead of trusting a clean dismissal: a leftover of the
        // share sheet swallows touches in the NEXT test (measured: the test
        // after a share sheet failed reliably).
        app.terminate()
    }

    // ── Code viewer: images are shown (not as "binary file") and downloadable ──
    func testCodeViewerShowsImagePreviewInsteadOfBinaryNotice() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/download", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "code")

        swipeRightAcrossScreen(app)
        XCTAssertTrue(app.otherElements["left-drawer"].waitForExistence(timeout: 8))
        let image = app.buttons["file-logo.png"]
        XCTAssertTrue(image.waitForExistence(timeout: 10), "The file tree does not show the fixture image")
        image.tap()

        let canvas = app.descendants(matching: .any)["code-image"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 15), "An image is not shown in the code viewer")
        XCTAssertFalse(
            app.staticTexts["Binary file"].exists,
            "An image must not be rejected as a binary file"
        )
        // Dimensions appear under the image — proof that real bytes were decoded.
        XCTAssertTrue(app.staticTexts["48 × 32"].waitForExistence(timeout: 8), "The image dimensions are missing")
        attach(app, "Image preview in the code viewer")

        // And the file download of the same path (model.download → share sheet), here through the
        // preview's button instead of the context menu — deterministic without a long press.
        let download = app.buttons["code-download-open"]
        XCTAssertTrue(download.exists, "The image preview lacks the download button")
        download.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 15) {
                let state = fixtureJSON(server + "/fixture/download")
                return state?["path"] as? String == "logo.png" && state?["dir"] as? Bool == false
            },
            "The server saw no file download request"
        )
        XCTAssertTrue(shareSheetAppears(app), "No share sheet opens after the file download")
        attach(app, "Share sheet after file download")
        dismissShareSheet(app)
        app.terminate() // see testLongPressOnFolderDownloadsZip: no modal leftover for the next test
    }

    // ── Chat: git of the associated project ─────────────────────────────────
    /// Like the git sidebar in the desktop client: if the open chat belongs to a project with a
    /// repository, git is reachable — here as an icon in the header that opens a half-height
    /// sheet. The whole chain is checked: counter on the icon, branch and changes in the
    /// sheet, staging and committing really reach the server.
    func testChatShowsGitOfItsProjectAndCanCommit() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true), "The fixture gateway did not accept the git state")

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))

        let gitButton = app.descendants(matching: .any)["chat-git"]
        XCTAssertTrue(gitButton.waitForExistence(timeout: 20), "The git icon is missing from the header")
        XCTAssertTrue(
            gitButton.label.contains("fn/till"),
            "The git icon must name the branch, was: \(gitButton.label)"
        )
        XCTAssertTrue(
            gitButton.value as? String == "3 changes",
            "The git icon must count the open changes, was: \(String(describing: gitButton.value))"
        )
        attach(app, "Git icon in the chat header")

        gitButton.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["chat-git-sheet"].waitForExistence(timeout: 10),
            "The git sheet did not open"
        )
        XCTAssertTrue(app.staticTexts["fn/till"].waitForExistence(timeout: 10), "The branch is missing from the sheet")
        let unstagedRow = app.descendants(matching: .any)["git-change-src/checkout.ts"]
        XCTAssertTrue(unstagedRow.waitForExistence(timeout: 10), "The changed file is missing from the sheet")
        attach(app, "Git sheet at half height over the chat")

        // Drag at the title to full height — at half height the file rows lie below the edge.
        expandSheet(app)

        // Stage — and ask the server whether it really arrived. The row card carries
        // ONE identifier that SwiftUI passes on to all its children; the buttons therefore do not
        // differ in it, only in the label — both together hit the row.
        let stageButton = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label == %@", "git-change-src/checkout.ts", "Stage")
        ).firstMatch
        XCTAssertTrue(scrollUntilHittable(app, stageButton), "The stage button is not reachable")
        stageButton.tap()
        XCTAssertTrue(
            waitForFixtureGit(server, timeout: 8) { files in
                files.contains { $0["path"] as? String == "src/checkout.ts" && ($0["x"] as? String) == "M" }
            },
            "Staging did not reach the server"
        )

        let message = app.textFields["git-commit-message"].firstMatch
        XCTAssertTrue(scrollUntilHittable(app, message), "The commit field is not reachable")
        message.tap()
        message.typeText("Tidied the till")
        app.descendants(matching: .any)["git-commit"].firstMatch.tap()
        XCTAssertTrue(
            waitForFixtureGit(server, timeout: 8) { _ in
                (fixtureJSON(server + "/fixture/git")?["committed"] as? [String])?.contains("Tidied the till") == true
            },
            "The commit did not reach the server"
        )
        attach(app, "After the commit in the git sheet")
    }

    /// A FAILED fetch is not "no repository". `load()` used to empty the repo list on every
    /// error: the view then claimed "There is no repository in this folder" and the git icon in the header
    /// vanished with it — both indistinguishable from the truth. The known state must stay, with an error message.
    func testFailedGitRefreshKeepsStateInsteadOfClaimingNoRepository() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: true))
        defer { _ = setFixtureGit(server, failing: false) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))

        let gitButton = app.descendants(matching: .any)["chat-git"]
        XCTAssertTrue(gitButton.waitForExistence(timeout: 20), "The git icon is missing from the header")

        // From now on the server answers with an error. Reloading happens after every run —
        // so trigger a run (exactly the everyday case: the agent finished, the fetch fails).
        XCTAssertTrue(setFixtureGit(server, failing: true), "The failure switch had no effect")
        let composer = app.descendants(matching: .any)["chat-composer"]
        composer.tap()
        composer.typeText("Short run")
        XCTAssertTrue(app.buttons["chat-send"].waitForExistence(timeout: 5))
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["Stop answering"].waitForExistence(timeout: 20), "The run did not start")
        XCTAssertTrue(
            app.buttons["Stop answering"].waitForNonExistence(timeout: 90),
            "The fixture run did not end"
        )

        XCTAssertTrue(
            gitButton.waitForExistence(timeout: 10),
            "The git icon must stay even after a failed fetch"
        )
        gitButton.tap()
        XCTAssertTrue(app.staticTexts["Fixture failure"].waitForExistence(timeout: 12), "The error message is missing")
        XCTAssertTrue(
            app.staticTexts["fn/till"].exists,
            "The last known state must stay instead of jumping to \"no repository\""
        )
        XCTAssertFalse(
            app.staticTexts["No Git repository"].exists,
            "A failure must not be reported as \"no repository\""
        )
        attach(app, "Git sheet after a failed fetch")
    }

    /// No repository in the project folder → no git icon. The button must not appear
    /// on suspicion (in the desktop client the sidebar hides itself for the same reason).
    func testChatWithoutRepositoryShowsNoGit() throws {
        let server = try requireFixture()
        XCTAssertTrue(setFixtureGit(server, hasRepo: false))
        defer { _ = setFixtureGit(server, hasRepo: true) }

        let app = launchApp(server: server)
        try openFirstChat(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].waitForExistence(timeout: 25))
        // The chat is loaded (composer there); so the icon could have appeared.
        XCTAssertFalse(
            app.descendants(matching: .any)["chat-git"].waitForExistence(timeout: 6),
            "Without a repository there must be no git icon in the header"
        )
        attach(app, "Chat without repository — no git icon")
    }

    // ── Skills: back in Coding ──
    /// Coding → Skills at workspace level: a category of the Coding bar after the credentials, instead of the
    /// wrapper's own tab. It shows ONLY the workspace's Coding skills — no
    /// project skill, no Managing skill —, per row a read-only "Hidden in: …" and at the top the cost line, which
    /// the SERVER computes. Creation happens at the workspace with `area: "coding"`.
    ///
    /// Reading happens at the fixture: whether the list asked with `area` and which area a new skill carries is visible only
    /// in what arrived. Counter-test: the list without `area` ⇒ the fixture answers 400 and the row is missing; the
    /// project skill "till-receipt" in the list ⇒ the absence promise falls.
    func testSkillsInCodingShowsOnlyWorkspaceSkillsAndCreatesOne() throws {
        let server = try requireFixture()
        let workspaceSkill = "60000000-0000-4000-8000-000000000001" // release-notes, Coding, workspace
        let projectSkill = "60000000-0000-4000-8000-000000000002"   // till-receipt, Coding, fixture project
        let managingSkill = "60000000-0000-4000-8000-000000000004"  // weekly-report, Managing

        // `hidden` hides release-notes in the fixture project — AFTER `reset-run`, before the start; no `defer`,
        // the next `launchApp` resets the seed.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/pages-skills", body: ["hidden": true]),
                            "The fixture gateway did not accept the skill seed")
        })
        normalizeToChatsOverview(app)
        openCodingSkills(app)

        let row = app.buttons["skill-\(workspaceSkill)"]
        XCTAssertTrue(waitUntilHittable(row, timeout: 15), "The workspace skill is missing or not tappable")
        // The project name is data, not translated text — the simulator may speak English.
        XCTAssertTrue(row.label.contains("Fixture-Projekt"), "The row does not say where the skill is hidden: \"\(row.label)\"")
        XCTAssertFalse(app.buttons["skill-\(projectSkill)"].exists, "A project skill appears at workspace level")
        XCTAssertFalse(app.buttons["skill-\(managingSkill)"].exists, "A Managing skill appears under Coding")
        // Workspace level = workspace + all projects: two Coding skills, 85 tokens each in the fixture.
        let catalog = app.staticTexts["skills-catalog"]
        XCTAssertTrue(catalog.waitForExistence(timeout: 10), "The cost line is missing")
        XCTAssertTrue(catalog.label.contains("~170"), "The cost line does not carry the server's number: \"\(catalog.label)\"")
        attach(app, "Coding → Skills, workspace level")

        let calls = fixtureSkillCalls(server)
        let listen = calls.filter {
            $0["method"] as? String == "GET" && $0["path"] as? String == "/api/workspaces/\(Self.fixtureWorkspaceId)/skills"
        }
        XCTAssertFalse(listen.isEmpty, "The list did not come through the workspace route: \(calls)")
        XCTAssertTrue(listen.allSatisfy { ($0["query"] as? [String: Any])?["area"] as? String == "coding" },
                      "The list did not ask with `area=coding`: \(listen)")
        let catalogQuery = calls.last { $0["path"] as? String == "/api/workspaces/\(Self.fixtureWorkspaceId)/skill-catalog" }?["query"] as? [String: Any]
        XCTAssertEqual(catalogQuery?["area"] as? String, "coding", "The cost line did not ask for Coding")
        XCTAssertNil(catalogQuery?["projectId"], "At workspace level the cost line asks for a project")
        XCTAssertFalse(calls.contains { $0["path"] as? String == "/api/skills" }, "The old route /api/skills was called")

        // Create: the editor has name · description · content — no marks, no "Projects" section.
        app.buttons["skills-new"].tap()
        let name = app.textFields["skill-editor-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 8), "The editor did not open")
        XCTAssertFalse(app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@", "skill-project-")).firstMatch.exists,
                       "The editor still carries the \"Projects\" section")
        name.tap()
        name.typeText("new-skill")
        let save = app.buttons["skill-editor-save"]
        XCTAssertTrue(waitUntilHittable(save, timeout: 5), "\"Save\" is not tappable")
        save.tap()
        XCTAssertTrue(waitForFixture(timeout: 10) { self.fixtureSkills(server).contains { $0["name"] as? String == "new-skill" } },
                      "The new skill did not reach the server")
        let fresh = fixtureSkills(server).first { $0["name"] as? String == "new-skill" } ?? [:]
        XCTAssertEqual(fresh["area"] as? String, "coding", "The new skill does not belong to Coding")
        XCTAssertTrue(fresh["projectId"] is NSNull, "The new skill hangs on a project: \(String(describing: fresh["projectId"]))")
        let post = fixtureSkillCalls(server).last { $0["method"] as? String == "POST" }
        XCTAssertEqual(post?["path"] as? String, "/api/workspaces/\(Self.fixtureWorkspaceId)/skills", "It was not created at the workspace")
        XCTAssertEqual((post?["body"] as? [String: Any])?["area"] as? String, "coding", "The body does not carry `area: coding`")
        let newId = (fresh["id"] as? String) ?? "?"
        XCTAssertTrue(app.buttons["skill-\(newId)"].waitForExistence(timeout: 10), "The new skill is not in the list")
        attach(app, "Coding → Skills after creating")
    }

    /// Coding → Skills in the entered project — on the principle of the credentials: "Own" are the project's skills,
    /// "Take over" (left drawer) the workspace's Coding skills with a switch per row. Opt-out:
    /// release-notes is on without anything ever having been taken over; the switch hides it for THIS project, via the
    /// skill ID in the path, and the cost line follows (two skills → one). The second tap shows it again.
    /// Counter-test: the name instead of the ID in the path ⇒ the fixture answers 404, and `hidden` stays empty.
    func testSkillsInProjectOwnAndHide() throws {
        let server = try requireFixture()
        let workspaceSkill = "60000000-0000-4000-8000-000000000001" // release-notes
        let projectSkill = "60000000-0000-4000-8000-000000000002"   // till-receipt
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/pages-skills", body: [:]),
                            "The fixture gateway did not accept the skill seed")
        })
        normalizeToChatsOverview(app)
        entersFixtureProject(app)
        openCodingSkills(app)

        // "Own": the project skill, not the workspace's.
        XCTAssertTrue(app.buttons["skill-\(projectSkill)"].waitForExistence(timeout: 15), "The project skill is missing under \"Own\"")
        XCTAssertFalse(app.buttons["skill-\(workspaceSkill)"].exists, "The workspace skill appears under \"Own\"")
        let catalog = app.staticTexts["skills-catalog"]
        XCTAssertTrue(catalog.waitForExistence(timeout: 10), "The cost line is missing")
        XCTAssertTrue(waitUntil(timeout: 5) { catalog.label.contains("~170") },
                      "In the project both own and workspace skill belong in the catalog: \"\(catalog.label)\"")
        let catalogQuery = fixtureSkillCalls(server)
            .last { $0["path"] as? String == "/api/workspaces/\(Self.fixtureWorkspaceId)/skill-catalog" }?["query"] as? [String: Any]
        XCTAssertEqual(catalogQuery?["projectId"] as? String, Self.fixtureProjectId, "The cost line does not ask for this project")
        attach(app, "Coding → Skills in the project: Own")

        selectTakeOver(app)

        let toggle = app.buttons["skill-adopt-\(workspaceSkill)"]
        XCTAssertTrue(waitUntilHittable(toggle, timeout: 12), "Under \"Take over\" the workspace skill's switch is missing")
        XCTAssertFalse(app.buttons["skill-adopt-\(projectSkill)"].exists, "A project skill appears under \"Take over\"")
        // Opt-out: on without anything ever having been taken over — nothing is hidden at the fixture.
        XCTAssertEqual(fixtureSkillHides(server), [], "The seed already carries a hide")
        attach(app, "Take over: workspace skill on")

        toggle.tap()
        let expected = "\(Self.fixtureProjectId):\(workspaceSkill)"
        XCTAssertTrue(waitForFixture(timeout: 10) { self.fixtureSkillHides(server) == [expected] },
                      "Not exactly this skill is hidden in this project: \(fixtureSkillHides(server))")
        let patch = fixtureSkillCalls(server).last { $0["method"] as? String == "PATCH" }
        XCTAssertEqual(patch?["path"] as? String, "/api/projects/\(Self.fixtureProjectId)/workspace-skills/\(workspaceSkill)/enabled",
                       "The switch did not go through the skill ID")
        XCTAssertEqual((patch?["body"] as? [String: Any])?["enabled"] as? Bool, false, "Hiding did not send `enabled: false`")
        XCTAssertTrue(waitUntil(timeout: 8) { catalog.label.contains("~85") },
                      "The cost line does not follow after hiding: \"\(catalog.label)\"")
        attach(app, "Take over: workspace skill hidden")

        // Show again — only once the switch is free again after saving.
        XCTAssertTrue(waitUntil(timeout: 8) { toggle.isEnabled }, "The switch stays locked after saving")
        toggle.tap()
        XCTAssertTrue(waitForFixture(timeout: 10) { self.fixtureSkillHides(server).isEmpty },
                      "The second tap does not show it again: \(fixtureSkillHides(server))")
        let second = fixtureSkillCalls(server).last { $0["method"] as? String == "PATCH" }
        XCTAssertEqual((second?["body"] as? [String: Any])?["enabled"] as? Bool, true, "Showing did not send `enabled: true`")
        XCTAssertTrue(waitUntil(timeout: 8) { catalog.label.contains("~170") }, "The cost line does not return: \"\(catalog.label)\"")
    }

    /// A switch whose PATCH fails: the server's message is STILL there AFTER the reload,
    /// and the switch shows the server's state (on). Before, the reload emptied the error line —
    /// the switch jumped back for no reason. Fixture switch `patchError: 404`, set before the start (`reset-run`
    /// clears it, no `defer`). Counter-test: `toggle` with `self.error = …` before a plain `await load()` ⇒ the
    /// message is gone as soon as the switch is free again.
    func testSkillsToggleErrorStaysAfterTheReload() throws {
        let server = try requireFixture()
        let workspaceSkill = "60000000-0000-4000-8000-000000000001" // release-notes
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/pages-skills", body: ["patchError": 404]),
                            "The fixture gateway did not accept the error switch")
        })
        normalizeToChatsOverview(app)
        entersFixtureProject(app)
        openCodingSkills(app)
        selectTakeOver(app)

        let toggle = app.buttons["skill-adopt-\(workspaceSkill)"]
        XCTAssertTrue(waitUntilHittable(toggle, timeout: 12), "Under \"Take over\" the workspace skill's switch is missing")
        toggle.tap()
        // First the rejected PATCH, then a reload after it (the cost line is its last request) — and only when
        // the switch is free again has the reload written: exactly there the old version erased the message.
        XCTAssertTrue(waitForFixture(timeout: 10) {
            let calls = self.fixtureSkillCalls(server)
            guard let i = calls.lastIndex(where: { $0["method"] as? String == "PATCH" }) else { return false }
            return calls[(i + 1)...].contains { ($0["path"] as? String)?.hasSuffix("/skill-catalog") == true }
        }, "After toggling no PATCH with reload arrived: \(fixtureSkillCalls(server))")
        XCTAssertTrue(waitUntil(timeout: 8) { toggle.isEnabled }, "The switch stays locked after the reload")
        let notice = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Fixture: Ausblenden abgelehnt")).firstMatch
        XCTAssertTrue(notice.exists, "The server's message is gone after the reload — the switch jumps back for no reason")
        // The value is translated ("an" / "on"); what counts is the server's state: nothing hidden.
        XCTAssertTrue(["an", "on"].contains((toggle.value as? String) ?? ""),
                      "The switch is not at the server's state: \(String(describing: toggle.value))")
        XCTAssertEqual(fixtureSkillHides(server), [], "Despite the rejection something is hidden")
        attach(app, "Take over: rejected switch with message")
    }

    /// Enter the fixture project through the scope picker (the same way `normalizeToChatsOverview` leaves it).
    private func entersFixtureProject(_ app: XCUIApplication) {
        let picker = app.buttons["scope-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8), "The scope picker is missing")
        picker.tap()
        let project = app.buttons["scope-project-\(Self.fixtureProjectId)"]
        XCTAssertTrue(project.waitForExistence(timeout: 6), "The fixture project is missing from the scope picker")
        project.tap()
    }

    /// "Take over" in the left drawer. The identifier sits on the segment bar's stack and thus passes to both buttons —
    /// tapping is by POSITION (the second is "Take over"; the simulator may speak English).
    private func selectTakeOver(_ app: XCUIApplication) {
        swipeRightAcrossScreen(app)
        let bar = app.descendants(matching: .any).matching(identifier: "items-section-switch")
        XCTAssertTrue(bar.firstMatch.waitForExistence(timeout: 8), "The left drawer lacks \"Own · Take over\"")
        let buttons = app.buttons.matching(identifier: "items-section-switch")
        if buttons.count >= 2 {
            buttons.element(boundBy: 1).tap()
        } else {
            bar.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap()
        }
        closeDrawers(app)
    }

    // ── Workflows ───────────────────────────────────────────────────────────
    /// Workflow area: existing workflow listed, new one created, a step added in the canvas
    /// and saved. Checked against the fixture state, not the surface —
    /// a button that only LOOKS as if it had saved would otherwise go unnoticed.
    func testWorkflowsPaneCreatesWorkflowAndAddsStep() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")

        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        attach(app, "Workflow list")

        app.buttons["workflows-new"].tap()
        // The field in the alert does NOT reliably pass the identifier on (measured) — so
        // address it through the alert itself.
        let dialog = app.alerts.firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 8), "The create dialog does not appear")
        let nameField = dialog.textFields.firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 6), "The create dialog has no name field")
        nameField.tap()
        nameField.typeText("Onboarding")
        dialog.buttons["Create"].tap()

        // The editor opens straight away with the new (empty) graph — including the start node.
        // Checked at its toolbar: the canvas itself is a scroll view and
        // therefore does not appear under `otherElements`.
        let addStep = app.buttons["workflow-add"]
        XCTAssertTrue(addStep.waitForExistence(timeout: 12), "The canvas editor does not open")
        addStep.tap()
        let instruction = app.buttons["Instruction"]
        XCTAssertTrue(instruction.waitForExistence(timeout: 6), "The menu knows no instruction")
        instruction.tap()

        // The new step opens its sheet immediately. The start command must be visible there WITHOUT scrolling;
        // otherwise the setting is effectively hidden on an iPhone.
        let title = app.textFields["workflow-node-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 8), "The step sheet is missing")
        replaceText(title, "Create account")
        let startCommand = app.descendants(matching: .any)["workflow-node-command"]
        XCTAssertTrue(startCommand.waitForExistence(timeout: 5), "The start command is missing in the node editor")
        XCTAssertTrue(startCommand.isHittable, "The start command is reachable only by scrolling")
        app.buttons["/compact"].tap()
        app.buttons["workflow-node-done"].tap()
        attach(app, "Workflow canvas with two steps")

        app.buttons["workflow-save"].tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                guard let list = fixtureJSON(server + "/fixture/workflows")?["workflows"] as? [[String: Any]],
                      let flow = list.first(where: { $0["name"] as? String == "Onboarding" }),
                      let graph = flow["graph"] as? [String: Any],
                      let nodes = graph["nodes"] as? [[String: Any]] else { return false }
                return nodes.count == 2 && nodes.contains {
                    $0["title"] as? String == "Create account" && $0["command"] as? String == "/compact"
                }
            },
            "The saved graph does not contain the new step"
        )
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// Run settings in the editor's meta sheet: the check model of the
    /// completion gate is chosen and saved — and the fields set on the DESKTOP
    /// (provider, model, permissions, effort) survive the mobile save. That was exactly the
    /// trap with the graph fields: a save on the iPhone sends everything and silently wipes what
    /// it does not know.
    func testWorkflowMetaSheetSavesDoneModelAndKeepsDesktopRunSettings() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")

        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        // The ROW opens the editor (no "Edit" button in the list any more).
        let row = app.buttons["workflow-50000000-0000-4000-8000-000000000001"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "The row of \"Release vorbereiten\" is missing")
        row.tap()

        let meta = app.buttons["workflow-meta"]
        XCTAssertTrue(meta.waitForExistence(timeout: 12), "The canvas editor does not open")
        meta.tap()
        // A category list: the check model sits under "Caps & checks".
        openSetting(app, "check")
        let donePicker = app.descendants(matching: .any)["workflow-run-done-model"]
        XCTAssertTrue(donePicker.waitForExistence(timeout: 8), "The check model is missing under \"Caps & checks\"")
        // The default shows as a label: the internal task.
        XCTAssertTrue(app.staticTexts["Internal task “Workflow verdicts”"].waitForExistence(timeout: 4), "The default \"Internal task\" is missing")
        donePicker.tap()
        // Menu items are found by their LABEL, not by an identifier.
        let sonnet = app.buttons["Sonnet 5"]
        XCTAssertTrue(sonnet.waitForExistence(timeout: 6), "The model \"Sonnet 5\" is not in the picker")
        sonnet.tap()
        attach(app, "Meta sheet with check model")
        closeSettings(app)
        app.buttons["workflow-save"].tap()

        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                guard let list = fixtureJSON(server + "/fixture/workflows")?["workflows"] as? [[String: Any]],
                      let flow = list.first(where: { $0["name"] as? String == "Release vorbereiten" }),
                      let run = flow["run"] as? [String: Any] else { return false }
                return run["doneModel"] as? String == "claude-sonnet-5" && run["doneProvider"] as? String == "claude"
            },
            "The check model did not reach the server"
        )
        // The desktop values are still there — the mobile save did not wipe them.
        let run = (fixtureJSON(server + "/fixture/workflows")?["workflows"] as? [[String: Any]])?
            .first(where: { $0["name"] as? String == "Release vorbereiten" })?["run"] as? [String: Any]
        XCTAssertEqual(run?["provider"] as? String, "codex", "the provider from the desktop was lost")
        XCTAssertEqual(run?["model"] as? String, "gpt-5.6-sol", "the model from the desktop was lost")
        XCTAssertEqual(run?["permissionMode"] as? String, "plan", "the permissions from the desktop were lost")
        XCTAssertEqual(run?["effort"] as? String, "high", "the effort from the desktop was lost")
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// The step sheet: the round cap appears ONLY on a step in a
    /// cycle, labelled with the cycle's EFFECTIVE value ("20 · from Review sauber?" — inherited,
    /// not the step's own), "At the round cap" beside it; on a chain both are absent (three-valued;
    /// the check cap sits on the chain because the instruction checks by inheritance). And
    /// "/" in the command field opens the composer's picker with the skills, but WITHOUT the
    /// chat's client commands. Measured on two fixture workflows: "Release vorbereiten" is a
    /// chain, "Review-Schleife" loops (a→b→a) — without the second, "only in a cycle" would be a claim.
    func testWorkflowNodeSheetShowsCapOnlyInCycleAndSlashPickerKnowsSkills() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        XCTAssertNotNil(fixturePost(server + "/fixture/skills", body: [:]), "The fixture did not accept the skill seed")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Review-Schleife"].waitForExistence(timeout: 15), "The cycle workflow is missing from the list")

        // Open a workflow's editor — the ROW is the button (identifier `workflow-<id>`);
        // "Edit" is only in the context menu.
        func openEditor(_ id: String) {
            let row = app.buttons["workflow-\(id)"]
            XCTAssertTrue(row.waitForExistence(timeout: 8), "The row of \(id) is missing")
            if !row.isHittable { app.swipeUp() }
            row.tap()
            XCTAssertTrue(app.buttons["workflow-add"].waitForExistence(timeout: 12), "The canvas editor does not open")
        }
        // Open a step's sheet: a tap on the card (no connecting in progress).
        func openSheet(_ nodeId: String, title: String) {
            // The card carries the identifier, and SwiftUI passes it on to its children (measured: an
            // `Image` with hit point {-1, -1} — a tap on it fizzles). So tapping is on
            // the centre of the LARGEST hit, by coordinate: that is the card itself.
            let hits = app.descendants(matching: .any).matching(identifier: "workflow-node-\(nodeId)")
            XCTAssertTrue(hits.firstMatch.waitForExistence(timeout: 8), "The card \"\(title)\" is missing on the canvas")
            let card = hits.allElementsBoundByIndex.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            XCTAssertNotNil(card, "The card \"\(title)\" has no frame")
            card?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let field = app.textFields["workflow-node-title"]
            XCTAssertTrue(field.waitForExistence(timeout: 8), "The step sheet of \"\(title)\" does not open")
            XCTAssertEqual(field.value as? String, title, "The sheet belongs to another step")
        }
        // Close sheet, close editor — "Done" reports the step as changed, closing then asks.
        func closeSheetAndEditor() {
            app.buttons["workflow-node-done"].tap()
            XCTAssertTrue(waitUntilGone(app.textFields["workflow-node-title"], timeout: 6), "The sheet does not close")
            app.buttons["workflow-close"].tap()
            let dismiss = app.buttons["Dismiss"]
            if dismiss.waitForExistence(timeout: 3) { dismiss.tap() }
            XCTAssertTrue(app.staticTexts["Review-Schleife"].waitForExistence(timeout: 10), "The list does not come back after the editor")
        }

        // ── Chain: no cap, no switch ──
        openEditor("50000000-0000-4000-8000-000000000001")
        openSheet("a", title: "Tests laufen lassen")
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "workflow-node-maxvisits").firstMatch.exists, "The round cap appears on a step WITHOUT a cycle — it never takes effect there")
        XCTAssertFalse(app.segmentedControls["workflow-node-loopcap-mode"].exists, "\"At the round cap\" appears on a chain — there is no cycle there")
        XCTAssertTrue(app.segmentedControls["workflow-node-done-mode"].exists, "\"Check for completion\" is missing on the instruction")
        // The instruction checks EFFECTIVELY ("Check all work steps" is on by default,
        // the node stands at "Like workflow") — so the check cap IS there, even on the chain.
        XCTAssertTrue(roleInSheet(app, target: app.segmentedControls["workflow-node-donecap-mode"]), "\"At the check cap\" is missing although the step checks (inherited)")
        attach(app, "Step sheet on a chain")
        closeSheetAndEditor()

        // ── Cycle: cap with the inherited value, switch beside it ──
        openEditor("50000000-0000-4000-8000-000000000003")
        openSheet("a", title: "Nachbessern")
        let cap = app.descendants(matching: .any).matching(identifier: "workflow-node-maxvisits").firstMatch
        XCTAssertTrue(cap.waitForExistence(timeout: 6), "The round cap is missing in the sheet of a step in the cycle")
        // "Nachbessern" carries no value of its own: the stepper shows the donor — the 20 of
        // "Review sauber?", not "5 · Default". Depending on the tree the text is the stepper's label
        // or a row of its own; both count.
        let label = "20 · from Review sauber?"
        XCTAssertTrue(
            waitUntil(timeout: 4) { cap.label.contains(label) || cap.staticTexts[label].exists || app.staticTexts[label].exists },
            "The cap does not name the cycle's effective value (\"\(label)\") — label: \(cap.label)"
        )
        XCTAssertTrue(app.segmentedControls["workflow-node-loopcap-mode"].exists, "\"At the round cap\" is missing in the cycle")
        attach(app, "Step sheet in the cycle")

        // ── Slash picker in the command field: skills yes, client commands no ──
        let command = app.descendants(matching: .any)["workflow-node-command"]
        XCTAssertTrue(command.waitForExistence(timeout: 5), "The command field is missing")
        command.tap()
        command.typeText("/")
        let picker = app.descendants(matching: .any).matching(identifier: "workflow-node-slash-picker").firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 6), "\"/\" does not open the picker at the command field")
        let skill = app.buttons["workflow-node-slash-release-notes"]
        XCTAssertTrue(skill.waitForExistence(timeout: 6), "The workspace skill is missing from the step's picker")
        XCTAssertTrue(app.buttons["workflow-node-slash-compact"].exists, "The harness command /compact is missing from the picker")
        XCTAssertFalse(app.buttons["workflow-node-slash-goal"].exists, "A client command of the chat appears in the step's picker — the CLI ran it on the step itself")
        attach(app, "Slash picker at the command field")
        skill.tap()
        XCTAssertTrue(
            waitUntil(timeout: 4) { ((command.value as? String) ?? "").hasPrefix("/release-notes") },
            "The choice in the picker does not land in the command field — value: \(String(describing: command.value))"
        )
        XCTAssertTrue(waitUntilGone(picker, timeout: 4), "The picker stays open after the choice")
        closeSheetAndEditor()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    // ── Workflow settings ──
    /// Open the editor of a fixture workflow — via the index of its row (the seed has a fixed
    /// order: Release 0, Hotfix 1, Review-Schleife 2, Auf Issue reagieren 3; the identifiers end in
    /// …0001 to …0004). The ROW is the button (`workflow-<id>`); "Edit" is only in the
    /// context menu.
    func openWorkflowEditor(_ app: XCUIApplication, index: Int) {
        let row = app.buttons["workflow-50000000-0000-4000-8000-00000000000\(index + 1)"]
        XCTAssertTrue(row.waitForExistence(timeout: 12), "The row of workflow no. \(index) is missing")
        if !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["workflow-meta"].waitForExistence(timeout: 12), "The canvas editor does not open")
    }

    /// Scroll down in the step sheet until `element` appears: the sheet is a `Form`, and
    /// it builds rows only on appearing — below the scale field "At the check cap" is outside
    /// the picture and until then NOT in the tree (an `exists` without scrolling would mean "missing").
    /// The list that carries the title field is scrolled — not the canvas behind it.
    @discardableResult
    func roleInSheet(_ app: XCUIApplication, target element: XCUIElement, attempts: Int = 5) -> Bool {
        let form = app.collectionViews.containing(.textField, identifier: "workflow-node-title").firstMatch
        for _ in 0..<attempts {
            if element.exists && element.isHittable { return true }
            if form.exists { form.swipeUp(velocity: .slow) } else { app.swipeUp() }
        }
        return element.exists
    }

    /// Close the settings sheet by swiping: one drag from the title bar almost to the
    /// bottom edge — a `swipeDown` on the bar was not enough in the simulator (measured).
    func swipeSettingsWay(_ app: XCUIApplication) {
        let finished = app.buttons["workflow-meta-done"]
        for _ in 0..<3 where finished.exists {
            let window = app.windows.firstMatch.frame
            let top = finished.frame.midY
            let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: window.width / 2, dy: top))
            let target = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: window.width / 2, dy: window.height - 20))
            start.press(forDuration: 0.05, thenDragTo: target, withVelocity: .fast, thenHoldForDuration: 0)
            _ = waitUntilGone(finished, timeout: 2)
        }
    }

    /// In the open settings sheet, open a category (row `workflow-settings-<key>`).
    func openSetting(_ app: XCUIApplication, _ key: String) {
        let row = app.buttons["workflow-settings-\(key)"]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "The category \"\(key)\" is missing in the settings sheet")
        row.tap()
    }

    /// Back to the category list (if on a subpage) and close the sheet with "Done".
    func closeSettings(_ app: XCUIApplication) {
        let finished = app.buttons["workflow-meta-done"]
        if !finished.isHittable { backToList(app) }
        XCTAssertTrue(waitUntilHittable(finished, timeout: 6), "The category list does not come back")
        finished.tap()
        XCTAssertTrue(waitUntilGone(finished, timeout: 6), "The settings sheet does not close")
    }

    /// From a subpage back to the category list: the back button carries the list's title
    /// ("Workflow" — the same in English). NOT `navigationBars.buttons.element(boundBy: 0)`: below
    /// the sheet sits the editor's bar, and its first button is "Done" (close editor).
    func backToList(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons["Workflow"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 6), "The back button to the category list is missing")
        back.tap()
    }

    /// The saved workflow in the fixture (by id) or the raw body of the last PUT.
    func fixtureWorkflow(_ server: String, _ id: String) -> [String: Any]? {
        (fixtureJSON(server + "/fixture/workflows")?["workflows"] as? [[String: Any]])?.first { $0["id"] as? String == id }
    }
    func fixtureLastPut(_ server: String) -> [String: Any]? {
        fixtureJSON(server + "/fixture/workflows")?["lastPut"] as? [String: Any]
    }

    /// The category list carries the six categories in the web's order; "Context" saves
    /// share and cap of the compaction — "Default" as an EXPLICIT `null` in the body (an
    /// omitted key would mean "unchanged", the server never reset). And the
    /// dirty trap: a sheet closed by swiping leaves the editor "unsaved" — "Save"
    /// is selectable afterwards (before, only "Done" in the sheet set the mark).
    func testWorkflowSettingsCategoriesAndContextSavesCompaction() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        XCTAssertFalse(app.buttons["workflow-save"].isEnabled, "Freshly opened, nothing is unsaved")
        app.buttons["workflow-meta"].tap()

        // The six categories, top to bottom in the web's order (WFE_CATEGORIES).
        let key = ["general", "execution", "context", "check", "concurrency", "trigger"]
        let rows = key.map { app.buttons["workflow-settings-\($0)"] }
        XCTAssertTrue(rows[0].waitForExistence(timeout: 8), "The category list is missing")
        for (k, z) in zip(key, rows) { XCTAssertTrue(z.exists, "The category \"\(k)\" is missing") }
        let ys = rows.map(\.frame.minY)
        XCTAssertEqual(ys, ys.sorted(), "The categories are not in the web's order: \(ys)")
        attach(app, "Workflow settings: categories")

        // ── Context: share 50 %, cap stays default ──
        openSetting(app, "context")
        let share = app.buttons["workflow-autocompact-share"]
        XCTAssertTrue(share.waitForExistence(timeout: 8), "The \"Share of the window\" control is missing")
        XCTAssertTrue(app.buttons["workflow-autocompact-cap"].exists, "The \"No later than\" control is missing")
        share.tap()
        let fifty = app.buttons["50 %"]
        XCTAssertTrue(fifty.waitForExistence(timeout: 6), "The 50 % step is missing in the control")
        fifty.tap()
        attach(app, "Context: share 50 %")
        // Back to the list and close the sheet by SWIPING — not via "Done".
        backToList(app)
        XCTAssertTrue(waitUntilHittable(app.buttons["workflow-settings-context"], timeout: 6))
        swipeSettingsWay(app)
        XCTAssertTrue(waitUntilGone(app.buttons["workflow-meta-done"], timeout: 6), "The sheet cannot be swiped away")
        let save = app.buttons["workflow-save"]
        XCTAssertTrue(waitUntil(timeout: 4) { save.isEnabled }, "After a change in the swiped-away sheet \"Save\" is not selectable — the change would be lost")
        save.tap()
        let id = "50000000-0000-4000-8000-000000000001"
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureWorkflow(server, id)?["run"] as? [String: Any])?["autocompact"] as? Int == 50
            },
            "The 50 % share did not reach the server"
        )
        let put = fixtureLastPut(server)?["run"] as? [String: Any]
        XCTAssertTrue(put?.keys.contains("autocompactMax") == true && put?["autocompactMax"] is NSNull,
                      "\"Default\" must appear as an explicit null in the body — body: \(String(describing: put))")
        // The desktop values are still there.
        XCTAssertEqual((fixtureWorkflow(server, id)?["run"] as? [String: Any])?["provider"] as? String, "codex", "the provider from the desktop was lost")

        // ── Back to default: the share goes out as null ──
        app.buttons["workflow-meta"].tap()
        openSetting(app, "context")
        XCTAssertTrue(share.waitForExistence(timeout: 8))
        share.tap()
        let standard = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Default", "Default")).firstMatch
        XCTAssertTrue(standard.waitForExistence(timeout: 6), "\"Default\" is missing in the control")
        standard.tap()
        closeSettings(app)
        save.tap()
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                let run = self.fixtureWorkflow(server, id)?["run"] as? [String: Any]
                return run?.keys.contains("autocompact") == true && run?["autocompact"] is NSNull
            },
            "\"Default\" did not arrive at the server as null"
        )
        XCTAssertTrue((fixtureLastPut(server)?["run"] as? [String: Any])?["autocompact"] is NSNull, "The body did not carry an explicit null")
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// "Caps & checks" saves the four values: "Check all work steps" (on by default),
    /// check rounds, "At the check cap" and "At the round cap" (segments, tapped by position — the
    /// simulator may speak English).
    func testWorkflowSettingsCheckSavesCap() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "check")

        let all = app.switches["workflow-done-all"]
        XCTAssertTrue(all.waitForExistence(timeout: 8), "\"Check all work steps\" is missing")
        XCTAssertEqual(all.value as? String, "1", "\"Check all work steps\" is not on by default")
        all.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 4) { (all.value as? String) == "0" }, "The switch did not flip")

        let rounds = app.steppers["workflow-done-rounds"]
        XCTAssertTrue(rounds.waitForExistence(timeout: 4), "The check rounds are missing")
        rounds.buttons.element(boundBy: 1).tap()   // +1: 3 → 4

        let checkCap = app.segmentedControls["workflow-donecap"]
        XCTAssertTrue(checkCap.waitForExistence(timeout: 4), "\"At the check cap\" is missing")
        checkCap.buttons.element(boundBy: 1).tap()   // Continue
        let roundsCap = app.segmentedControls["workflow-loopcap"]
        if !roundsCap.isHittable { app.swipeUp() }
        XCTAssertTrue(roundsCap.waitForExistence(timeout: 4), "\"At the round cap\" is missing")
        roundsCap.buttons.element(boundBy: 1).tap()   // Continue
        attach(app, "Caps & checks changed")
        closeSettings(app)
        app.buttons["workflow-save"].tap()

        let id = "50000000-0000-4000-8000-000000000001"
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureWorkflow(server, id)?["run"] as? [String: Any])?["doneAll"] as? Bool == false
            },
            "\"Check all work steps: off\" did not reach the server"
        )
        let run = fixtureWorkflow(server, id)?["run"] as? [String: Any]
        XCTAssertEqual(run?["doneRounds"] as? Int, 4, "The check rounds did not arrive")
        XCTAssertEqual(run?["doneCapAuto"] as? Bool, true, "\"At the check cap: Continue\" did not arrive")
        XCTAssertEqual(run?["loopCapAuto"] as? Bool, true, "\"At the round cap: Continue\" did not arrive")
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// "Concurrency" also saves the lock scope — `lock` did not go out from the iPhone at all
    /// before.
    func testWorkflowSettingsConcurrencySavesLock() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "concurrency")
        for scope in ["project", "workflow", "event", "custom", "off"] {
            XCTAssertTrue(app.buttons["workflow-lock-\(scope)"].waitForExistence(timeout: 6), "The lock scope \"\(scope)\" is missing")
        }
        XCTAssertTrue(app.buttons["workflow-lock-project"].isSelected, "The default \"One run per project/repo\" is not selected")
        app.buttons["workflow-lock-workflow"].tap()
        XCTAssertTrue(waitUntil(timeout: 4) { app.buttons["workflow-lock-workflow"].isSelected }, "The choice does not switch")
        attach(app, "Concurrency: one run per workflow")
        closeSettings(app)
        app.buttons["workflow-save"].tap()
        let id = "50000000-0000-4000-8000-000000000001"
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureWorkflow(server, id)?["lock"] as? [String: Any])?["scope"] as? String == "workflow"
            },
            "The lock scope did not reach the server"
        )
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// "Trigger" arms: the PUT carries `active: true` plus the state, afterwards the page shows
    /// "Active" and the trigger's row; on a workflow WITHOUT a trigger there is a sentence instead of a
    /// button.
    func testWorkflowSettingsTriggerSetsActive() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")

        // Without a trigger: no button.
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "trigger")
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 6))
        XCTAssertFalse(app.buttons["workflow-active"].waitForExistence(timeout: 2), "A workflow without a trigger offers \"Arm\"")
        closeSettings(app)
        app.buttons["workflow-close"].tap()
        let dismiss = app.buttons["Dismiss"]
        if dismiss.waitForExistence(timeout: 2) { dismiss.tap() }

        // With a trigger: arm it.
        XCTAssertTrue(app.staticTexts["Auf Issue reagieren"].waitForExistence(timeout: 10), "The trigger workflow is missing from the list")
        openWorkflowEditor(app, index: 3)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "trigger")
        let armButton = app.buttons["workflow-active"]
        XCTAssertTrue(armButton.waitForExistence(timeout: 8), "\"Arm\" is missing on the trigger workflow")
        XCTAssertTrue(app.buttons["workflow-trigger-t"].exists, "The trigger's row is missing")
        armButton.tap()
        let id = "50000000-0000-4000-8000-000000000004"
        XCTAssertTrue(
            waitForFixture(timeout: 12) { self.fixtureWorkflow(server, id)?["active"] as? Bool == true },
            "Arming did not reach the server"
        )
        XCTAssertEqual(fixtureLastPut(server)?["active"] as? Bool, true, "The body did not carry `active: true`")
        XCTAssertNotNil(fixtureLastPut(server)?["graph"], "Arming does not save the state too")
        let status = app.staticTexts["workflow-active-status"]
        XCTAssertTrue(waitUntil(timeout: 6) { status.label == "Active" || status.label == "Active" }, "After arming the status does not show \"Active\": \(status.label)")
        attach(app, "Trigger: armed")
        closeSettings(app)
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// The step sheet is three-valued: "Check for completion" at "Off" takes the scale and
    /// the check cap out of the sheet, and ALL three modes are saved — an explicit "off"
    /// must not pass as "not set" (it would otherwise mean "like workflow" = on).
    func testWorkflowNodeSheetTristateSavesModes() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)

        let hits = app.descendants(matching: .any).matching(identifier: "workflow-node-a")
        XCTAssertTrue(hits.firstMatch.waitForExistence(timeout: 8), "The card \"Tests laufen lassen\" is missing")
        let card = hits.allElementsBoundByIndex.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        card?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.textFields["workflow-node-title"].waitForExistence(timeout: 8), "The step sheet does not open")

        let mode = app.segmentedControls["workflow-node-done-mode"]
        if !mode.isHittable { app.swipeUp() }
        XCTAssertTrue(mode.waitForExistence(timeout: 6), "\"Check for completion\" is missing")
        XCTAssertEqual(mode.buttons.count, 3, "\"Check for completion\" is not three-valued")
        XCTAssertTrue(roleInSheet(app, target: app.segmentedControls["workflow-node-donecap-mode"]), "\"At the check cap\" is missing when checking by inheritance")
        // After scrolling, "Check for completion" may be out of view at the top — scroll back.
        let form = app.collectionViews.containing(.textField, identifier: "workflow-node-title").firstMatch
        for _ in 0..<3 where !mode.isHittable { form.swipeDown(velocity: .slow) }
        mode.buttons.element(boundBy: 2).tap()   // Off
        XCTAssertTrue(waitUntilGone(app.segmentedControls["workflow-node-donecap-mode"], timeout: 4), "\"At the check cap\" stays although the step no longer checks")
        XCTAssertFalse(app.descendants(matching: .any)["workflow-node-donetext"].exists, "The scale stays although the step no longer checks")
        attach(app, "Step sheet: check off")
        app.buttons["workflow-node-done"].tap()
        app.buttons["workflow-save"].tap()

        let id = "50000000-0000-4000-8000-000000000001"
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                let nodes = ((self.fixtureWorkflow(server, id)?["graph"] as? [String: Any])?["nodes"] as? [[String: Any]]) ?? []
                return nodes.first { $0["id"] as? String == "a" }?["doneMode"] as? String == "off"
            },
            "\"Check for completion: Off\" did not reach the server"
        )
        let nodes = ((fixtureWorkflow(server, id)?["graph"] as? [String: Any])?["nodes"] as? [[String: Any]]) ?? []
        let a = nodes.first { $0["id"] as? String == "a" }
        XCTAssertEqual(a?["doneCapMode"] as? String, "inherit", "The check-cap mode is missing in the graph")
        XCTAssertEqual(a?["loopCapMode"] as? String, "inherit", "The round-cap mode is missing in the graph")
        XCTAssertNil(a?["doneCheck"], "The legacy field doneCheck still goes out")
        XCTAssertNil(a?["capAuto"], "The legacy field capAuto still goes out")
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    // ── Browser: desktop view, rotation, zoom ───────────────────────────────
    /// The fixture image carries a green corner at the TOP LEFT. In portrait the
    /// desktop view tilts by 90° — the corner must then be at the top RIGHT. In addition the
    /// test checks that a click in the middle hits the same page coordinate in zoom too.
    func testBrowserDesktopViewRotatesAndClicksSurviveZoom() throws {
        let server = try requireFixture()
        _ = resetFixtureBrowser(server)
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "browser")

        let canvas = app.descendants(matching: .any)["browser-canvas"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 25), "The browser shows no image")
        XCTAssertTrue(
            waitForFixtureViewport(server, timeout: 15) { $0.width > 100 && $0.width < 600 },
            "In phone mode the viewport must match the pane width"
        )
        let box = canvas.frame
        let cornerSize = CGSize(width: box.width * 0.16, height: box.height * 0.10)
        let topLeft = CGRect(origin: CGPoint(x: box.minX + 4, y: box.minY + 4), size: cornerSize)
        let topRight = CGRect(
            origin: CGPoint(x: box.maxX - cornerSize.width - 4, y: box.minY + 4),
            size: cornerSize
        )
        XCTAssertGreaterThan(
            greenShare(app, in: topLeft),
            0.6,
            "In phone mode the green corner of the image must be at the top left"
        )
        attach(app, "Browser in phone mode")

        // Scroll direction in phone mode (untilted): the finger moving DOWN brings earlier content
        // back, as everywhere on the phone — so the wheel must run NEGATIVE. (In the
        // tilted desktop view the scroll axis is rotated onto the cross axis; that is
        // intended, because the user then turns the phone too.)
        _ = resetFixtureBrowser(server)
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).press(
            forDuration: 0.05,
            thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)),
            withVelocity: .default,
            thenHoldForDuration: 0.1
        )
        if let wheel = waitForFixtureWheel(server, timeout: 10) {
            XCTAssertLessThan(wheel, -20, "A downward drag must scroll the page up")
        } else {
            XCTFail("The scroll did not reach the browser")
        }

        // Switch on the desktop view.
        app.buttons["browser-desktop-toggle"].tap()
        XCTAssertTrue(
            waitForFixtureViewport(server, timeout: 20) { $0.width == 1280 },
            "The desktop view must request a window 1280 pixels wide"
        )
        XCTAssertTrue(
            app.staticTexts["Turn the phone for the desktop view"].waitForExistence(timeout: 8),
            "In portrait the hint to turn the phone must appear"
        )
        Thread.sleep(forTimeInterval: 1.5)
        attach(app, "Browser in desktop view (tilted)")
        let rotatedLeft = greenShare(app, in: topLeft)
        let rotatedRight = greenShare(app, in: topRight)
        XCTAssertGreaterThan(
            rotatedRight,
            rotatedLeft + 0.3,
            "The desktop view must be tilted by 90° (green corner at the top right, was left \(rotatedLeft) / right \(rotatedRight))"
        )

        // Click in the middle: page centre, at zoom 1 and zoomed.
        _ = resetFixtureBrowser(server)
        canvas.tap()
        guard let plain = waitForFixtureClick(server, timeout: 10) else {
            return XCTFail("The click did not reach the browser")
        }
        XCTAssertEqual(plain.x, 640, accuracy: 70, "A click in the middle must hit the page centre")

        canvas.pinch(withScale: 3, velocity: 1.2)
        XCTAssertTrue(
            app.buttons["browser-zoom-reset"].waitForExistence(timeout: 8),
            "After the pinch the zoom indicator must appear"
        )
        attach(app, "Browser zoomed")
        _ = resetFixtureBrowser(server)
        canvas.tap()
        guard let zoomed = waitForFixtureClick(server, timeout: 10) else {
            return XCTFail("The click while zoomed did not reach the browser")
        }
        XCTAssertEqual(
            zoomed.x,
            plain.x,
            accuracy: 90,
            "A centred zoom must not shift the hit point in the middle"
        )
        XCTAssertEqual(zoomed.y, plain.y, accuracy: 90)

        app.buttons["browser-zoom-reset"].tap()
        XCTAssertTrue(app.buttons["browser-zoom-reset"].waitForNonExistence(timeout: 6))

        // Back to phone mode so the next test sees a normal viewport.
        app.buttons["browser-desktop-toggle"].tap()
        XCTAssertTrue(waitForFixtureViewport(server, timeout: 15) { $0.width < 600 })
    }

    func testCredentialsHideFreeTextAccessUntilRevealed() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openCategory(app, "vars")

        // A row instead of a card (Code/VarsPane.swift): the row is ONE button whose label carries
        // key and short line, and the eye sits in the entry sheet that a tap on the row opens. Whether the key
        // is reported ADDITIONALLY as a staticText in the button says nothing about the sheet (texts in a SwiftUI button
        // report `exists`, ChatRowsUITests) — so only an identifier that exists solely in the sheet shows that the sheet
        // is open (`var-detail-close`).
        let row = app.buttons["var-902"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The credential is missing from the list")
        XCTAssertTrue(row.label.contains("ORBIT_SQL"), "The row does not name the key: \(row.label)")
        XCTAssertFalse(row.label.contains("s3hr-secret"), "A free-text credential must never appear in the row")
        XCTAssertFalse(app.staticTexts["s3hr-secret"].exists, "A free-text credential must not be open by itself")

        row.tap()
        XCTAssertTrue(app.buttons["var-detail-close"].waitForExistence(timeout: 8), "The entry sheet did not open")
        XCTAssertFalse(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "s3hr-secret")).firstMatch.exists,
            "Even in the sheet the credential is open only after the eye"
        )
        let eye = app.buttons["var-eye-902"]
        XCTAssertTrue(eye.waitForExistence(timeout: 5), "Without the eye the credential could never be reached")
        eye.tap()
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "s3hr-secret")).firstMatch.waitForExistence(timeout: 5),
            "The eye does not reveal the block"
        )
        attach(app, "Credentials: revealed free-text credential")
        app.buttons["var-detail-close"].tap()
        XCTAssertTrue(app.buttons["var-detail-close"].waitForNonExistence(timeout: 5), "The entry sheet stays open")

        // Editor: kind "Free text" (fourth segment — it is named differently in the English simulator,
        // hence by POSITION), then a multi-line block.
        app.buttons["vars-new"].tap()
        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 8), "The editor did not open")
        app.segmentedControls.firstMatch.buttons.element(boundBy: 3).tap()
        app.textFields["e.g. GITLAB_TOKEN"].tap()
        app.typeText("PORTAL_DB")
        let value = app.textViews["var-value"]
        XCTAssertTrue(value.waitForExistence(timeout: 5), "The large text field is missing")
        value.tap()
        app.typeText("Host: db.internal\nUser: app")
        app.buttons["Save"].tap()

        let fresh = app.buttons["var-903"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 10), "The new credential is not in the list")
        XCTAssertTrue(fresh.label.contains("PORTAL_DB"), "The new row does not name the key: \(fresh.label)")
        fresh.tap()
        XCTAssertTrue(app.buttons["var-eye-903"].waitForExistence(timeout: 8), "The entry sheet of the new credential did not open")
        app.buttons["var-eye-903"].tap()
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "db.internal")).firstMatch.waitForExistence(timeout: 5),
            "The saved block is not readable"
        )
    }

    // ── Coding MCP airlock: deselect a tool, set a card, header only "set" ──
    /// The server sheet shows the tools with a tick (choice) and a card;
    /// a tap saves immediately, and the state comes from the fixture's RESPONSE (PATCH with only the one field). The header
    /// shows only name and "set" — a value never arrives. The values (accessibilityValue) per language.
    /// Counter-test: the fixture does not take `choice` in the PATCH ⇒ red (waiting for "deselected" times out).
    func testMcpToolDeselectCardSetHeaderOnlySet() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        XCTAssertTrue(app.buttons["overview-new-chat"].waitForExistence(timeout: 25))
        openCategory(app, "mcp")
        let row = app.buttons["mcp-6d1f0c3a-0000-4000-8000-00000000a11e"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The MCP server is missing from the list")
        row.tap()
        XCTAssertTrue(app.buttons["mcp-detail-close"].waitForExistence(timeout: 8), "The server sheet did not open")

        let header = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Authorization")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5), "The header is missing from the sheet")
        XCTAssertTrue(header.label.contains("set") || header.label.contains("set"), "The header does not say \"set\": \(header.label)")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Bearer")).firstMatch.exists, "A value in the sheet")

        let read = app.buttons["mcp-choice-teams_read"]
        XCTAssertTrue(read.waitForExistence(timeout: 8), "The tools are missing from the sheet")
        var swiper = 0
        while !read.isHittable && swiper < 6 { app.swipeUp(); swiper += 1 }
        XCTAssertTrue(["selected", "selected"].contains(read.value as? String ?? ""), "choice null means all selected: \(String(describing: read.value))")
        read.tap()
        expectation(for: NSPredicate(format: "value IN %@", ["deselected", "deselected"]), evaluatedWith: read)
        waitForExpectations(timeout: 8)

        let card = app.buttons["mcp-card-archive_read"]
        XCTAssertTrue(["off"].contains(card.value as? String ?? ""), "archive_read carries no card by default: \(String(describing: card.value))")
        card.tap()
        expectation(for: NSPredicate(format: "value IN %@", ["an", "on"]), evaluatedWith: card)
        waitForExpectations(timeout: 8)
        attach(app, "MCP: tool deselected, card set, header only set")
    }

    // ── The skill editor scrolls to the end of the instructions ──────────────
    /// Reported for the web ("scrolling to the bottom does not work"); on the phone not measured
    /// until then. The editor is a `Form` with a `TextEditor`
    /// (`minHeight: 240`). A body with 120 paragraphs is seeded (last line
    /// END-OF-THE-FILE); then the field is swiped up. If the form scrolls (the field grows
    /// with it), the section header moves past the top edge; if the field scrolls on its own (240 pt),
    /// its picture changes. One of the two MUST happen — otherwise the editor is stuck.
    func testSkillEditorScrollsToTheEndOfALongBody() throws {
        let server = try requireFixture()
        let skill = "60000000-0000-4000-8000-000000000001"

        // The long seed AFTER `reset-run` (which resets the page seed) and BEFORE the start;
        // no `defer` — see `launchApp(preparation:)`.
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/pages-skills", body: ["lang": true]),
                            "The fixture gateway did not accept the long skill seed")
        })
        // Via Coding → Skills: the row opens the sheet, "Edit" in it the editor.
        normalizeToChatsOverview(app)
        openCodingSkills(app)
        let row = app.buttons["skill-\(skill)"]
        XCTAssertTrue(waitUntilHittable(row, timeout: 20), "The skill's row is not tappable")
        row.tap()
        let edit = app.buttons["skill-detail-edit"]
        XCTAssertTrue(waitUntilHittable(edit, timeout: 10), "\"Edit\" in the sheet is not tappable")
        edit.tap()

        // Via the identifier: the sheet before it shows the content too, and `firstMatch` would hit its box.
        let field = app.textViews["skill-editor-content"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "The editor shows no text field — did the skill come from the server?")
        XCTAssertTrue(
            waitUntil(timeout: 8) { (field.value as? String)?.contains("END-OF-THE-FILE") == true },
            "The field does not carry the long body: \(String(describing: field.value).prefix(120))"
        )
        let header = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "Content (Markdown)")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5), "The section header \"Content (Markdown)\" is missing")
        Thread.sleep(forTimeInterval: 0.8)
        let headerPrior = header.frame.minY
        let fieldPrior = field.frame
        let imagePrior = pixelSignature(app, in: fieldPrior)
        attach(app, "Skill editor before scrolling")

        for _ in 0..<6 {
            field.swipeUp(velocity: .fast)
            Thread.sleep(forTimeInterval: 0.5)
        }
        Thread.sleep(forTimeInterval: 0.8)
        attach(app, "Skill editor after scrolling")
        let headerAfterwards = header.exists ? header.frame.minY : -1
        let imageAfterwards = pixelSignature(app, in: fieldPrior)
        let formScrolled = !header.exists || headerAfterwards < headerPrior - 100
        let fieldScrolled = imageAfterwards.count == imagePrior.count
            && zip(imagePrior, imageAfterwards).filter { $0 != $1 }.count > imagePrior.count / 5
        print("CBASE-MASS skill-editor headerPrior=\(headerPrior) headerAfterwards=\(headerAfterwards) field=\(fieldPrior) fieldNow=\(field.frame) formScrolled=\(formScrolled) fieldScrolled=\(fieldScrolled)")
        XCTAssertTrue(
            formScrolled || fieldScrolled,
            "The editor does not scroll: the section header is at \(headerAfterwards) (prior \(headerPrior)), "
                + "and the field's picture (\(fieldPrior.height) pt tall) did not change"
        )
        app.buttons["Cancel"].tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 6), "The editor does not close")
    }

    /// The effort selection of the workflow settings, category
    /// "Execution": "As the chat · new: Medium" first (the level a fresh run chat thinks with when the run level is empty:
    /// Codex default Medium on the run model; the label says that a
    /// manual start keeps the chat's level), the levels of the run model ("Release vorbereiten"
    /// runs on GPT-5.6 Sol, all five), and after "Max" and the switch to GPT-5.5 (no `max`) the level is
    /// shown marked with its replacement — the same component as in the three other places (`Kit/EffortSelection.swift`).
    func testEffortSelectionInTheWorkflowSettings() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "execution")
        checkEffortSelection(app, ["As the chat · new: Medium", "Low", "Medium", "High", "X-High", "Max"], choice: "Max", "Workflow, GPT-5.6 Sol")
        selectInPicker(app, "Model", "GPT-5.5")
        checkEffortSelection(app, ["As the chat · new: Medium", "Low", "Medium", "High", "X-High", "Max · runs as X-High"], choice: "Max · runs as X-High", "Workflow, GPT-5.5")
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// The run settings of a workflow show no
    /// effort selection at the provider "Ohne Denkgrad" (`caps.effort: false`) and on Haiku 4.5 (`efforts: []`); on
    /// "Default (global)" it shows (Codex is globally active).
    func testEffortSelectionMissingInWorkflowWithoutLevels() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "execution")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 10), "The effort selection is missing on GPT-5.6 Sol")
        selectInPicker(app, "Provider", "Ohne Denkgrad")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists },
                      "An effort selection still shows at the provider without levels: \(pickerRow(app, "Effort").label)")
        selectInPicker(app, "Provider", "Claude Code")
        selectInPicker(app, "Model", "Haiku 4.5")
        XCTAssertTrue(waitUntil(timeout: 6) { !self.pickerRow(app, "Effort").exists }, "An effort selection still shows on Haiku 4.5")
        attach(app, "Workflow, Haiku 4.5 without effort")
        selectInPicker(app, "Provider", "Default (global)")
        XCTAssertTrue(pickerRow(app, "Effort").waitForExistence(timeout: 6), "The effort selection is missing on \"Default (global)\"")
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    /// "Execution" carries the Ultracode switch — off by default,
    /// switched on and saved, `run.ultracode: true` stands in the fixture (the server then sets the mode on
    /// every run at the chat, level xhigh clamped to the model; workflow-run-settings.test.js checks that).
    func testWorkflowSettingsUltracodeSaves() throws {
        let server = try requireFixture()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
        let app = launchApp(server: server)
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The existing workflow is missing from the list")
        openWorkflowEditor(app, index: 0)
        app.buttons["workflow-meta"].tap()
        openSetting(app, "execution")
        let toggle = app.switches["workflow-run-ultracode"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 8), "The Ultracode switch is missing")
        XCTAssertEqual(toggle.value as? String, "0", "Ultracode is not off by default")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 4) { (toggle.value as? String) == "1" }, "The switch did not flip")
        attach(app, "Execution: Ultracode on")
        closeSettings(app)
        app.buttons["workflow-save"].tap()
        let id = "50000000-0000-4000-8000-000000000001"
        XCTAssertTrue(
            waitForFixture(timeout: 12) {
                (self.fixtureWorkflow(server, id)?["run"] as? [String: Any])?["ultracode"] as? Bool == true
            },
            "\"Ultracode: on\" did not reach the server"
        )
        app.buttons["workflow-close"].tap()
        XCTAssertNotNil(fixturePost(server + "/fixture/workflows", body: [:]), "Clean-up failed")
    }

    // ── Dynamic workflows: the library, the kind "Dynamic" under "Workflows" ──────

    /// Choose the kind of the "Workflows" category: the segment `wf-kind-<kind>` under the title. Tapping is at its
    /// POSITION (centre of the frame), not via `isHittable` — right after `openCategory` the right drawer is still
    /// closing, and closed elements stand in the tree with a full frame. So it waits until the frame
    /// lies in the window; afterwards the segment must count as selected.
    func selectWorkflowKind(_ app: XCUIApplication, _ kind: String) {
        let segment = app.buttons["wf-kind-\(kind)"]
        XCTAssertTrue(segment.waitForExistence(timeout: 12), "The segment \(kind) is missing under \"Workflows\"")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(waitUntil(timeout: 6) { !segment.frame.isEmpty && window.contains(segment.frame) }, "The segment \(kind) is not in the window: \(segment.frame)")
        _ = app.otherElements["right-drawer"].waitForNonExistence(timeout: 4)
        segment.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 6) { segment.isSelected }, "The segment \(kind) does not count as selected after the tap")
    }

    /// ONE category "Workflows" with two kinds: "Workflows" is in the right drawer, a
    /// category "Dynamic workflows" no longer exists. The default is "Graph" (the graph list, no library);
    /// "Dynamic" shows the library (and no longer the graph list), the left drawer the library's hint;
    /// back on "Graph" the graph list is there again. Counter-test against the old state: there is no `wf-kind-*`,
    /// and `category-dynworkflows` exists.
    func testWorkflowsShowsGraphAndDynamicUnderOneCategory() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/workflows", body: [:]), "The fixture did not accept the reset")
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-library", body: ["seed": true]), "The fixture did not accept the seed")
        })
        normalizeToChatsOverview(app)
        swipeLeftAcrossScreen(app)
        let category = app.buttons["category-workflows"]
        XCTAssertTrue(category.waitForExistence(timeout: 8), "\"Workflows\" is missing in the right drawer")
        XCTAssertFalse(app.buttons["category-dynworkflows"].exists, "The category \"Dynamic workflows\" is still in the drawer")
        category.tap()
        _ = app.otherElements["right-drawer"].waitForNonExistence(timeout: 4)

        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 15), "The default does not show the graph list")
        XCTAssertTrue(app.buttons["wf-kind-graph"].isSelected, "The default is not \"Graph\"")
        XCTAssertFalse(app.buttons["dynwf-row-daily-report"].exists, "The library shows under \"Graph\"")
        attach(app, "Workflows — Graph")

        selectWorkflowKind(app, "dynamic")
        XCTAssertTrue(app.buttons["dynwf-row-daily-report"].waitForExistence(timeout: 12), "\"Dynamic\" does not show the library")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForNonExistence(timeout: 6), "The graph list still shows under \"Dynamic\"")
        XCTAssertFalse(app.buttons["workflows-new"].exists, "The graph workflows' \"New\" shows under \"Dynamic\"")
        attach(app, "Workflows — Dynamic")
        swipeRightAcrossScreen(app)
        XCTAssertTrue(
            app.staticTexts["Saved by the agent; in a chat the model starts it by name."].waitForExistence(timeout: 8),
            "Under \"Dynamic\" the left drawer does not show the library's hint"
        )
        XCTAssertFalse(app.staticTexts["Start in a chat with /workflow:<short name> — the model starts it."].exists, "Under \"Dynamic\" the left drawer shows the graph workflows' hint")
        closeDrawers(app)

        selectWorkflowKind(app, "graph")
        XCTAssertTrue(app.staticTexts["Release vorbereiten"].waitForExistence(timeout: 12), "Back on \"Graph\" the graph list is missing")
        XCTAssertTrue(app.buttons["dynwf-row-daily-report"].waitForNonExistence(timeout: 6), "Back on \"Graph\" the library still shows")
    }

    /// Named legacy: a stored raw category value "dynworkflows" (its own category before)
    /// leads after the start to "Workflows" + "Dynamic" — not silently to Chats. Counter-test: without the legacy branch in
    /// `AppState.enter` the app starts in the chat, `wf-kind-dynamic` is missing.
    func testOldCategoryDynworkflowsLandsOnDynamic() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, launchArguments: ["-cbase.mobile.cat:\(Self.fixtureWorkspaceId)", "dynworkflows"], preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-library", body: ["seed": true]), "The fixture did not accept the seed")
        })
        XCTAssertTrue(app.buttons["dynwf-row-daily-report"].waitForExistence(timeout: 15), "The old value \"dynworkflows\" does not lead to the library")
        XCTAssertTrue(app.buttons["wf-kind-dynamic"].isSelected, "The old value \"dynworkflows\" does not select the kind \"Dynamic\"")
        attach(app, "Legacy dynworkflows")
    }

    /// The library list with the fixture's seed: four entries, one of them WITHOUT `whenToUse` and WITHOUT
    /// `phases` (the fields are missing entirely) — the list stays readable, it shows like the others. The view shows `meta`
    /// (name, whenToUse, phases) and the script byte-equal including a copy button. Deleting asks back and hits the entry
    /// with special characters in the name (`review.v2-final_x`), not its neighbour `review-v2-final-x`. Counter-test: without the kind
    /// "Dynamic" under "Workflows" the segment is missing, `selectWorkflowKind` is red.
    func testDynWorkflowsLibraryShowsScriptMetaAndDeletes() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-library", body: ["seed": true]), "The fixture did not accept the seed")
        })
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        selectWorkflowKind(app, "dynamic")

        for name in ["daily-report", "review.v2-final_x", "review-v2-final-x", "without-meta"] {
            XCTAssertTrue(app.buttons["dynwf-row-\(name)"].waitForExistence(timeout: 12), "The saved workflow \(name) is missing from the list")
        }
        XCTAssertFalse(app.descendants(matching: .any)["dynwf-empty"].exists, "A filled list shows the empty state")
        XCTAssertTrue(app.staticTexts["Nur Name und Beschreibung."].exists, "The entry without whenToUse and phases does not show its description")
        XCTAssertTrue(app.staticTexts["Lesen → Urteilen"].exists, "The phases are not on the row")
        attach(app, "Library of the dynamic workflows")

        app.buttons["dynwf-row-review.v2-final_x"].tap()
        let script = app.staticTexts["dynwf-script"]
        XCTAssertTrue(script.waitForExistence(timeout: 12), "The view shows no script")
        XCTAssertTrue(script.label.contains("const rounds = 2;"), "The script is not the saved one: \(script.label)")
        XCTAssertTrue(script.label.contains("name: \"review.v2-final_x\""), "The meta literal is missing from the script: \(script.label)")
        XCTAssertEqual(app.staticTexts["dynwf-meta-name"].label, "review.v2-final_x")
        XCTAssertEqual(app.staticTexts["dynwf-meta-when"].label, "Wenn ein Merge Request vor dem Abnehmen steht.")
        XCTAssertEqual(app.staticTexts.matching(identifier: "dynwf-meta-phase").count, 2, "Both phases belong in the view")
        let copy = app.buttons["dynwf-copy"]
        XCTAssertTrue(copy.exists, "The copy button is missing")
        copy.tap()
        XCTAssertTrue(waitUntil(timeout: 5) { copy.label.contains("Copied") }, "Copying does not acknowledge: \(copy.label)")
        let loaded = ((fixtureJSON(server + "/fixture/dyn-library")?["calls"] as? [[String: Any]]) ?? []).first?["path"] as? String
        XCTAssertEqual(loaded, "/api/workspaces/\(Self.fixtureWorkspaceId)/dyn-workflows/61000000-0000-4000-8000-000000000002", "The view loaded the wrong entry")
        attach(app, "View with meta and script")
        app.buttons["dynwf-view-close"].tap()
        XCTAssertTrue(script.waitForNonExistence(timeout: 6), "The view does not close")

        // Delete is at the end of the view (and in the row's context menu), no longer a text button
        // on the row: the view closes, AFTER that the list asks back.
        app.buttons["dynwf-row-review.v2-final_x"].tap()
        let erase = app.buttons["dynwf-view-delete"]
        XCTAssertTrue(erase.waitForExistence(timeout: 12), "\"Delete\" is missing at the end of the view")
        erase.tap()
        XCTAssertTrue(erase.waitForNonExistence(timeout: 6), "The view does not close before the confirmation")
        let confirm = app.sheets.buttons["Delete"]
        if confirm.waitForExistence(timeout: 6) {
            confirm.tap()
        } else {
            // iOS 26 may show the confirmation as a popover at the row instead of a sheet.
            let button = app.buttons.matching(NSPredicate(format: "label == %@", "Delete")).firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 4), "Delete does not ask for confirmation")
            button.tap()
        }
        XCTAssertTrue(app.buttons["dynwf-row-review.v2-final_x"].waitForNonExistence(timeout: 10), "The deleted entry is still in the list")
        XCTAssertTrue(app.buttons["dynwf-row-review-v2-final-x"].exists, "The neighbour with an almost identical name vanished too")
        let names = ((fixtureJSON(server + "/fixture/dyn-library")?["workflows"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
        XCTAssertEqual(names, ["daily-report", "review-v2-final-x", "without-meta"], "Not exactly the chosen entry was deleted")
    }

    /// In the entered project a switch per row toggles the takeover. The name with special characters goes UNENCODED to the
    /// client (which encodes the path itself): at the fixture exactly `…/workspace-dyn-workflows/review.v2-final_x/enabled`
    /// arrives, no `%25…`, and exactly this entry is taken over, not its neighbour. The second tap takes it back.
    func testDynWorkflowsTakeoverInProjectHitsTheCorrectNames() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-library", body: ["seed": true]), "The fixture did not accept the seed")
        })
        normalizeToChatsOverview(app)
        // Enter the project through the scope picker (the same way `normalizeToChatsOverview` leaves it).
        let picker = app.buttons["scope-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8), "The scope picker is missing")
        picker.tap()
        let project = app.buttons["scope-project-\(Self.fixtureProjectId)"]
        XCTAssertTrue(project.waitForExistence(timeout: 6), "The fixture project is missing from the scope picker")
        project.tap()
        openCategory(app, "workflows")
        selectWorkflowKind(app, "dynamic")
        let toggle = app.buttons["dynwf-toggle-review.v2-final_x"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 12), "The takeover switch per row is missing in the project")
        XCTAssertTrue(app.buttons["dynwf-toggle-without-meta"].exists, "The entry without whenToUse and phases has its switch too")
        toggle.tap()
        func takenOver() -> [String] { (fixtureJSON(server + "/fixture/dyn-library")?["takenOver"] as? [String]) ?? [] }
        XCTAssertTrue(waitForFixture(timeout: 10) { takenOver() == ["review.v2-final_x"] }, "Not exactly the chosen entry is taken over: \(takenOver())")
        let patches = ((fixtureJSON(server + "/fixture/dyn-library")?["calls"] as? [[String: Any]]) ?? []).filter { $0["method"] as? String == "PATCH" }
        XCTAssertEqual(patches.first?["path"] as? String, "/api/projects/\(Self.fixtureProjectId)/workspace-dyn-workflows/review.v2-final_x/enabled", "The name did not go unencoded into the path")
        XCTAssertEqual((patches.first?["body"] as? [String: Any])?["enabled"] as? Bool, true)
        XCTAssertTrue(waitUntil(timeout: 6) { (toggle.value as? String) == "on" }, "The switch does not show the takeover: \(String(describing: toggle.value))")
        attach(app, "Takeover in the project")
        toggle.tap()
        XCTAssertTrue(waitForFixture(timeout: 10) { takenOver().isEmpty }, "The second tap does not take the takeover back: \(takenOver())")
    }

    /// "Not loaded yet" never shows "none saved": if the list answers with an error, the error shows —
    /// not the empty state. Counter-test: without the `loaded` flag (empty state on an empty list) the second check is red.
    func testDynWorkflowsNotLoadedIsNotEmpty() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/dyn-library", body: ["error": true]), "The fixture did not accept the error switch")
        })
        normalizeToChatsOverview(app)
        openCategory(app, "workflows")
        selectWorkflowKind(app, "dynamic")
        let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "nicht lesbar")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 12), "The list's error does not show")
        XCTAssertFalse(app.descendants(matching: .any)["dynwf-empty"].exists, "A NOT loaded list shows \"No dynamic workflows saved yet.\"")
        attach(app, "Library not loaded")
    }

    /// A read error of the port conflicts is not an empty answer — after pulling to refresh
    /// against a 500 the "Port conflicts" marker stays on the project card. Counter-test: `ProjectsPane.loadConflicts`
    /// with `(try? …) ?? [:]` (the earlier state) ⇒ the marker is gone after the refresh, red. The fetch is counted at the
    /// fixture — otherwise a marker that stays would only prove that nobody asked again.
    func testPortConflictsStayAtReadError() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/port-conflicts", body: ["on": true]), "The fixture did not accept the conflict switch")
        })
        normalizeToChatsOverview(app)
        openCategory(app, "projects")
        let marker = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label IN %@", ["Port conflicts", "Port conflicts"])).firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 12), "The \"Port conflicts\" marker is missing on the project card")
        func retrievals() -> Int { (fixtureJSON(server + "/fixture/port-conflicts")?["retrievals"] as? Int) ?? -1 }
        let prior = retrievals()
        XCTAssertGreaterThan(prior, 0, "The conflicts were never fetched")
        XCTAssertNotNil(fixturePost(server + "/fixture/port-conflicts", body: ["error": true]), "The fixture did not accept the error switch")
        // Pull to refresh: from above the middle, slowly downward.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(waitForFixture(timeout: 10) { retrievals() > prior }, "Pulling to refresh did not ask for the conflicts again")
        // The answer (500) is processed as soon as the list stands again; the marker must still be there then.
        XCTAssertFalse(waitUntilGone(marker, timeout: 3), "After a read error the \"Port conflicts\" marker is gone — an error was read as \"no conflicts\"")
        attach(app, "Port conflicts after read error")
    }

    // ── Git overview ─────────────────────────────────────────────────────────

    /// The instances the fixture has fetched since the switch, with `auto`.
    private func gitViewFetches(_ server: String) -> [(instance: String, auto: Bool)] {
        let list = fixtureJSON(server + "/fixture/gitView")?["fetches"] as? [[String: Any]] ?? []
        return list.map { (($0["instance"] as? String) ?? "", ($0["auto"] as? Bool) ?? false) }
    }

    /// Projects → project → Git shows the timeline with the seed's groups (Checked out, From cbase), the copy row DIRECTLY
    /// under the main row of the same name, "Ended (1)" collapsed, and on opening fetches automatically in main and in the read copy
    /// k1 — never in the unread k2 (the view never wakes). A tap on the row opens the detail (pushed in the sheet) that the server
    /// delivers ("GitLab not connected" appears only in the detail). Counter-test: without the switch the segment is missing (the hook `repos`, not
    /// switched over) — every other test of the Projects page checks that too.
    func testGitViewShowsTimelineAndOpensDetail() throws {
        let server = try requireFixture()
        let app = launchApp(server: server, preparation: {
            XCTAssertNotNil(self.fixturePost(server + "/fixture/gitView", body: ["on": true]), "The fixture did not accept the git overview switch")
        })
        normalizeToChatsOverview(app)
        openCategory(app, "projects")
        let project = app.buttons["project-\(Self.fixtureProjectId)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15), "The fixture project is missing from the project list")
        project.tap()
        let segment = app.buttons["project-git"]
        XCTAssertTrue(segment.waitForExistence(timeout: 15), "The \"Git\" segment is missing on a switched-over project with a repo")
        segment.tap()

        let view = app.descendants(matching: .any)["gitView"]
        XCTAssertTrue(view.waitForExistence(timeout: 15), "The git overview did not open")
        let checkedOut = app.descendants(matching: .any)["git-group-checkedOut"]
        XCTAssertTrue(checkedOut.waitForExistence(timeout: 15), "The header of the group \"Checked out\" is missing")
        let cbase = app.descendants(matching: .any)["git-group-cbase"]
        XCTAssertTrue(cbase.exists, "The header of the group \"From cbase\" is missing")
        XCTAssertFalse(app.descendants(matching: .any)["git-group-branches"].exists, "An empty group has a header")
        XCTAssertLessThan(checkedOut.frame.minY, cbase.frame.minY, "The groups are not in the order of `groups`")

        let main = app.buttons["git-row-fn/till"]
        let copy = app.buttons["git-row-fn/till@k1"]
        XCTAssertTrue(main.waitForExistence(timeout: 10), "The row of the checked-out branch is missing")
        XCTAssertTrue(copy.exists, "The copy row is missing")
        XCTAssertEqual(copy.frame.minY, main.frame.maxY, accuracy: 2, "The copy row is not directly under the main row")
        XCTAssertTrue(app.buttons["git-row-cbase/agent-3f2a"].exists, "The running subagent is missing in \"From cbase\"")
        XCTAssertTrue(app.buttons["git-ended"].exists, "The \"Ended (n)\" fold is missing")
        XCTAssertFalse(app.buttons["git-row-cbase/agent-91c0"].exists, "An ended branch is open instead of behind the fold")
        XCTAssertTrue(app.descendants(matching: .any)["git-view-unread-k2"].exists, "The unread copy does not name its reason")

        // Auto-fetch on opening: main and k1 with `auto: true`, k2 never.
        XCTAssertTrue(waitForFixture(timeout: 10) {
            let f = self.gitViewFetches(server)
            return f.contains { $0.instance == "main" && $0.auto } && f.contains { $0.instance == "k1" && $0.auto }
        }, "On opening there was no automatic fetch in main and in k1: \(gitViewFetches(server))")
        XCTAssertFalse(gitViewFetches(server).contains { $0.instance == "k2" }, "A fetch happened in the unread copy k2")

        // The fold opens the ended branch; the window switch keeps the rows.
        app.buttons["git-ended"].tap()
        XCTAssertTrue(app.buttons["git-row-cbase/agent-91c0"].waitForExistence(timeout: 5), "The \"Ended\" fold did not open")
        app.buttons["git-view-window-7d"].tap()
        XCTAssertTrue(app.buttons["git-view-window-7d"].isSelected, "The window \"7 d\" is not selected")
        XCTAssertTrue(main.waitForExistence(timeout: 5), "After the window switch the row is missing")
        attach(app, "Git overview: timeline")

        main.tap()
        XCTAssertTrue(app.descendants(matching: .any)["git-view-detail"].waitForExistence(timeout: 10), "The detail did not open")
        let mr = app.staticTexts["GitLab not connected"]
        XCTAssertTrue(mr.waitForExistence(timeout: 10), "The server's detail did not arrive (MR row \"GitLab not connected\" is missing)")
        XCTAssertTrue(app.buttons["git-view-file-src/till.ts"].waitForExistence(timeout: 5), "The changed files are missing from the detail")
        attach(app, "Git overview: detail")
    }
}
