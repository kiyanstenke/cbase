import SwiftUI

// Projects of a workspace: create, enter, view services, remove.
//
// The quiet form: per project ONE row directly on the page background, separated by hairlines (`CbHairline`): the name, below it
// (only while something is happening with the project) the state as dot plus word (`state`: upload, setup, upload afterwards, layout),
// below that muted port conflicts · services · copies (`shortLine`). Entering switches to Chats at once; in the entered project the
// category "Project" stands in place of the list (`onlyProject`, the page computes `ProjectCategoryPage`).
//  – NO path and no branch in the row: the path is <workspace folder>/<name> and would only repeat the name (it is in the project
//    view), a branch would cost a git call per project on opening (Files → Git).
//  – Tapping opens the project view (`Code/ProjectView.swift`) with the pages "Services" and "Outline" under the title. Entering is
//    NOT the tap: entering goes through the picker on top, this page manages. Long-press: Enter · Services · Outline (same view,
//    segment selected) · Upload · Remove.
//  – The explanation is behind the ⓘ.
struct ProjectsPane: View {
    let client: APIClient
    let workspace: Workspace
    /// In the entered project the category "Project": in place of the list `ProjectView` of this project stands, embedded (no
    /// sheet). nil = the list of all projects.
    var onlyProject: String? = nil
    @EnvironmentObject private var state: AppState

    @State private var conflicts: [String: PortConflictGroup] = [:]
    @State private var creating = false
    @State private var deleting: Project?
    @State private var error = ""
    @State private var detail: Project?
    /// The page of the project view (`ProjectView`): "Services" on tap, "Outline" from the context menu.
    @State private var detailPage: ProjectPage = .services
    /// What should happen after the project sheet closes: close first, then (in `onDismiss`) enter, open the services or ask
    /// back (pattern `AgentsPane.byDetail`).
    @State private var byDetail: ByDetail?
    @State private var infoOpen = false
    /// The services per project (`GET /api/project-services`, same route as the apps page). `nil` = no response yet: then the
    /// services part of the short line is missing instead of claiming "no services recorded" (empty is not unknown). A read
    /// error keeps the last state, like `loadConflicts`.
    @State private var services: [String: [ProjectServiceRow]]?
    /// The copies per project (`GET /api/projects` → `instance.copies`); `nil` = no response yet. A project without an
    /// instance row has no copies.
    @State private var copies: [String: [AppsProject.Copy]]?
    /// Project creation: creation path and rules (`/api/projectCreation/rules` with `mode`), this app's running uploads, the
    /// creation dialog, the re-choice for "Resume upload" and the setup questions.
    @ObservedObject private var creation = ProjectCreationStatus.shared
    @ObservedObject private var uploads = ProjectUploads.shared
    @State private var create: CreationStart?
    @State private var resumeFor: ResumeTarget?
    @State private var resumeSelect = false
    @State private var setupQuestion: SetupQuestion?
    @State private var notice: String?
    /// The clock of the "Upload running" rows (60 s without a piece ⇒ "waiting for upload"); ticks only while a setup is open.
    @State private var now = Date()
    /// Upload afterwards: this app's runs, the question which dialog is choosing, and the confirmation questions (discard,
    /// another archive or folder when resuming).
    @ObservedObject private var retroactive = ProjectRetroactive.shared
    @State private var afterChoice: AfterChoice?
    @State private var afterConfirmation: AfterConfirmation?
    private struct AfterChoice { let projectId: String; let kind: String; let operation: String? }
    private struct AfterConfirmation: Identifiable {
        let id = UUID()
        let text: String
        let button: String
        var destructive = false
        let action: () async -> Void
    }

    private enum CreationStart: String, Identifiable { case empty, folder, zip, clone, withoutOps; var id: String { rawValue } }
    /// "Add access" on a clone row: the host is fixed, after saving "Try again".
    private struct AccessTarget: Identifiable { let projectId: String; let host: String; var id: String { projectId + "|" + host } }
    @State private var accessFor: AccessTarget?
    /// `choice`: which dialog: the remembered choice of the creation, otherwise the kind of the server source.
    private struct ResumeTarget { let projectId: String; let source: ProjectSetup.Source; let choice: String }
    private struct SetupQuestion: Identifiable {
        let project: Project
        let action: SetupAction
        var files: [UploadFile] = []
        var access: [URL] = []
        var notCaptured = 0
        /// ZIP only: the chosen archive is not provably the one that was started; once confirmed, it uploads from the start.
        var archive: SourceUpload? = nil
        var archiveOld = ""
        var id: String { "\(project.id)-\(action.identifier)" }
    }

    private enum ByDetail {
        case enter(Project)
        case services(Project)
        case remove(Project)
        /// A setup action from the sheet: it presents itself (file dialog, question, message), which only works once the sheet
        /// is closed.
        case action(Project, SetupAction)
        /// Upload afterwards from the sheet (files · folder · ZIP) and the actions of open operations: likewise only afterwards.
        case upload(Project, String)
        case afterAction(Project, RetroactiveAction)
        /// An entry of the "Instances" tab (start/open chat, code, terminal): leads out of the sheet.
        case jump(Project, InstanceJump)
    }

    /// Which page stands (Code/ProjectCategoryPage.swift): a project's services (in the entered project only THIS one), the view
    /// of the entered project, "no longer exists" or the list.
    private var page: ProjectCategoryPage {
        .from(selected: state.projectsSelected, enter: onlyProject, projects: workspace.projects.map(\.id))
    }

    var body: some View {
        Group {
            switch page {
            case .details(let id):
                if let project = workspace.projects.first(where: { $0.id == id }) {
                    ProjectDetailPane(client: client, project: project) {
                        state.projectsSelected = nil
                    }
                }
            case .project(let pid):
                projectPage(pid)
            case .gone(let pid):
                gonePage(pid)
            case .list:
                list
            }
        }
        .task { await loadConflicts() }
        .task { await creation.load(client) }
        // A jump to a sub-item (`AppState.projectShow`: instances, from "Create copy …" at a chat's instance choice; git).
        .onChange(of: state.projectWish?.id, initial: true) { _, _ in projectWishApply() }
        .onChange(of: creation.mode) { _, _ in projectWishApply() }
        .task(id: setupOpen) {
            // The "Upload running" rows age without an event: while a setup (or an upload afterwards) is open, recompute
            // every 10 s.
            while setupOpen && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                now = Date()
            }
        }
        .sheet(isPresented: $creating) {
            CreateProjectSheet(client: client, workspaceId: workspace.id) {
                await state.loadWorkspaces()
                await state.reloadOverview()
            }
            .cbSheet(.whole)
        }
        .sheet(item: $create) { start in
            if let rules = creation.rules, start != .withoutOps {
                ProjectCreateSheet(client: client, workspaceId: workspace.id, rules: rules, withFolder: start == .folder, withZip: start == .zip, withClone: start == .clone) { pid, list in
                    await state.loadWorkspaces()
                    await state.reloadOverview()
                    startUploads(pid, list, resume: false)
                }
                .cbSheet(.whole)
            }
        }
        .sheet(item: $accessFor) { z in
            GitAccessSheet(client: client, workspaceId: workspace.id, projectId: z.projectId, host: z.host) {
                await state.loadWorkspaces()
            }
            .cbSheet(.whole)
        }
        // ONE file dialog for "Resume upload" of the creation AND upload afterwards (two `fileImporter`s on the same view
        // interfere): `afterChoice` set means afterwards.
        .fileImporter(
            isPresented: $resumeSelect,
            allowedContentTypes: dialogChoice == "files" ? [.item] : dialogChoice == "zip" ? [.zip] : [.folder],
            allowsMultipleSelection: dialogChoice == "files"
        ) { result in
            let n = afterChoice
            afterChoice = nil
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            if let n { Task { await afterSelected(n, urls) }; return }
            guard let target = resumeFor else { return }
            Task { await resume(target, urls) }
        }
        // The question only without an open sheet: in the sheet the sheet asks itself.
        .modifier(RetroactiveQuestionDialog(retroactive: retroactive, active: detail == nil))
        .confirmationDialog(
            afterConfirmation?.text ?? "",
            isPresented: Binding(get: { afterConfirmation != nil }, set: { if !$0 { afterConfirmation = nil } }),
            titleVisibility: .visible
        ) {
            if let b = afterConfirmation {
                Button(b.button, role: b.destructive ? .destructive : nil) {
                    afterConfirmation = nil
                    Task { await b.action() }
                }
            }
            Button(L("Cancel"), role: .cancel) { afterConfirmation = nil }
        }
        .confirmationDialog(
            setupQuestion.map(questionText) ?? "",
            isPresented: Binding(get: { setupQuestion != nil }, set: { if !$0 { setupQuestion = nil } }),
            titleVisibility: .visible
        ) {
            if let f = setupQuestion {
                Button(questionButton(f), role: f.action == .leaveOut(f.action.seq ?? 0) ? .destructive : nil) {
                    setupQuestion = nil
                    Task { await confirmed(f) }
                }
            }
            Button(L("Cancel"), role: .cancel) { setupQuestion = nil }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button(L("OK"), role: .cancel) { notice = nil }
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { selected in
            view(selected, embedded: false)
                .modifier(RetroactiveQuestionDialog(retroactive: retroactive, active: true))
                .cbSheet(.whole)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            L("Remove project? The folder and its contents will be permanently deleted."),
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Remove"), role: .destructive) {
                if let project = deleting { Task { await remove(project) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    /// The project view: as a sheet of the list or embedded in the entered project. Embedded there is no sheet that would have to
    /// close first: the follow-up steps run at once (`followUp`).
    @ViewBuilder
    private func view(_ selected: Project, embedded: Bool) -> some View {
        // The project fresh from the list: the view stays open while the setup continues.
        let project = workspace.projects.first(where: { $0.id == selected.id }) ?? selected
        let display = SetupDisplay.compute(project.setup, project.detection, now: now)
        ProjectView(
            client: client,
            project: project,
            rules: creation.rules,
            page: $detailPage,
            setup: displayWithoutOwn(project, display),
            upload: uploads.runs[project.id],
            removeLocked: removeLocked(project, display),
            action: { a in
                followUp(.action(project, a), embedded)
            },
            abortUpload: { uploads.abort(project.id) },
            hideUpload: { uploads.hide(project.id) },
            inOps: creation.mode == "container",
            uploadPossible: uploadPossible(project, display),
            retroactive: afterDisplay(project),
            retroactiveRuns: retroactive.runs[project.id] ?? [],
            startUpload: { kind in
                followUp(.upload(project, kind), embedded)
            },
            afterAction: { a in
                followUp(.afterAction(project, a), embedded)
            },
            layout: LayoutDisplay.compute(project.layout),
            layoutPossible: layoutPossible(project),
            abortRetroactiveRun: { id in retroactive.abort(project.id, id) },
            hideRetroactiveRun: { id in retroactive.remove(project.id, id) },
            services: services.map { $0[project.id] ?? [] },
            conflicts: conflicts[project.id]?.items ?? [],
            enter: {
                followUp(.enter(project), embedded)
            },
            administerService: {
                followUp(.services(project), embedded)
            },
            remove: {
                followUp(.remove(project), embedded)
            },
            instanceJump: { jump in
                followUp(.jump(project, jump), embedded)
            },
            embedded: embedded
        )
    }

    /// The jump to a sub-item (`state.projectWish`): the segment to the sub-item (instances, git); in the list also the project's
    /// view as a sheet, in the entered project the embedded one. Only once the creation path is read: before, the segment does not
    /// exist (`ProjectView.instancesPossible`, `gitPossible`) and the choice would fall back to "Services". Without operation or on
    /// a non-converted project neither exists: the wish is dropped. The tab itself picks it up and deletes it.
    private func projectWishApply() {
        guard let w = state.projectWish else { return }
        if w.expired { state.projectWish = nil; return }
        guard let mode = creation.mode else { return }
        guard mode == "container", let project = workspace.projects.first(where: { $0.id == w.projectId }), project.instance?.converted == true else {
            state.projectWish = nil
            return
        }
        if onlyProject == project.id {
            detailPage = w.page
        } else if onlyProject == nil {
            detailPage = w.page
            if detail?.id != project.id { detail = project }
        }
    }

    private func followUp(_ step: ByDetail, _ embedded: Bool) {
        byDetail = step
        if embedded { afterTheDetail() } else { detail = nil }
    }

    /// The category "Project" in the entered project; `page` calls it only if the list carries the project.
    @ViewBuilder
    private func projectPage(_ pid: String) -> some View {
        if let project = workspace.projects.first(where: { $0.id == pid }) {
            view(project, embedded: true)
                .task { await loadOverview() }
        }
    }

    /// The entered project is not in the LOADED list: it is gone (removed on the web, also after a restore from `cbase.mobile.proj:<ws>`).
    /// Instead of an endless spinner the sentence and the way out. The list is reloaded ONCE: if it was only stale (a project entered
    /// from a fresher overview), the page shows it afterwards.
    private func gonePage(_ pid: String) -> some View {
        PaneScaffold(title: L("Project")) {
            CbEmpty(
                symbol: "questionmark.folder",
                text: L("This project no longer exists.") + " " + L("It was removed or is no longer in this workspace."),
                identifier: "project-gone",
                button: L("Leave project"),
                buttonIdentifier: "project-gone-leave"
            ) {
                state.leaveProject()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: pid) { await state.loadWorkspaces() }
    }

    private var list: some View {
        PaneScaffold(title: L("Projects"), trailing: AnyView(headerButtons)) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)
                    if workspace.projects.isEmpty {
                        empty
                    } else {
                        // No grouping: the workspace's order stays. In the form of the instances: above the list the summary, the
                        // rows without hairline, the tile in front.
                        Text(verbatim: summary)
                            .cbFont(13, digitsEqual: true)
                            .foregroundStyle(CbColor.textMuted)
                            .padding(.horizontal, 14)
                            .padding(.top, 4)
                            .padding(.bottom, 6)
                            .accessibilityIdentifier("projects-summary")
                        VStack(spacing: 2) {
                            ForEach(workspace.projects) { project in
                                row(project)
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable {
                await state.loadWorkspaces()
                await loadConflicts()
                await loadOverview()
            }
        }
        // On the LIST, not the group: coming back from a project's services, the short line is new.
        .task { await loadOverview() }
    }

    /// ⓘ and "New" in the header.
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About projects"), identifier: "projects-info") { infoOpen = true }
            if creation.mode == "container" {
                // In server operation a menu: upload an empty project or straight a folder or ZIP, all with its own container.
                Menu {
                    Button { create = .empty } label: { Label(L("Empty project"), systemImage: "folder.badge.plus") }
                        .accessibilityIdentifier("projects-new-empty")
                    Button { create = .folder } label: { Label(L("Upload folder"), systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("projects-new-folder")
                    Button { create = .zip } label: { Label(L("Upload ZIP"), systemImage: "doc.zipper") }
                        .accessibilityIdentifier("projects-new-zip")
                    Button { create = .clone } label: { Label(L("Clone Git repository"), systemImage: "arrow.triangle.branch") }
                        .accessibilityIdentifier("projects-new-clone")
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.symbol(11, weight: .semibold))
                        Text(L("New")).cbFont(13, weight: .medium).lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .foregroundStyle(CbColor.primaryButtonText)
                    .background(Capsule().fill(CbColor.primaryButton))
                }
                .disabled(creation.rules == nil)
                .accessibilityIdentifier("projects-new")
            } else {
                PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                    creating = true
                }
                .accessibilityIdentifier("projects-new")
            }
        }
    }

    /// The empty list: create.
    private var empty: some View {
        CbEmpty(symbol: "folder", text: L("No projects yet.")) { newProject() }
            .frame(maxWidth: .infinity)
    }

    /// One row per project: the name, the state (only while something is happening) as dot plus word, below it the muted short
    /// line. Tapping opens the project view on "Services", long-press Enter · Services · Outline · Remove.
    ///
    /// The conflict marker lies as its own element on the right OVER the row (`overlay`, not in the button): a button merges its
    /// children into ONE label, and the "Port conflicts" marker must stay readable as its own element, for VoiceOver and for
    /// `CodingUITests.testPortConflictsStayAtReadError`, which finds it by its label. The row keeps space free on the right. The
    /// overlay sits BEFORE the context menu so that the preview on long-press takes it along.
    private func row(_ project: Project) -> some View {
        let conflicts = conflicts[project.id]?.items.count ?? 0
        let snapshot = state(project)
        return Button {
            detailPage = .services
            detail = project
        } label: {
            HStack(alignment: .top, spacing: 12) {
            // The tile: the folder in the color of the project container (muted neutral without operation).
            ProjectTile(symbol: "folder", color: project.instance.map { projectStateColor($0.state) } ?? CbColor.textSecondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .tracking(-0.2)
                    .cbFont(16, weight: .medium)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                if let snapshot {
                    HStack(spacing: 7) {
                        Circle().fill(snapshot.color).frame(width: 6, height: 6)
                        Text(snapshot.text)
                            .cbFont(13)
                            .foregroundStyle(CbColor.textSecondary)
                            .lineLimit(2)
                    }
                }
                if let short = shortLine(project) {
                    short
                        .cbFont(13, digitsEqual: true)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
            }
            .frame(minHeight: 34)
            }
            .padding(.leading, 10)
            .padding(.trailing, conflicts > 0 ? 40 : 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .cbRowPress()
        .accessibilityIdentifier("project-\(project.id)")
        .overlay(alignment: .trailing) {
            if conflicts > 0 {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.symbol(13, weight: .semibold))
                    .foregroundStyle(Color.orange)
                    .padding(.trailing, 16)
                    .allowsHitTesting(false)
                    .accessibilityLabel(L("Port conflicts"))
            }
        }
        .contentShape(.contextMenuPreview, CbRowPress.form)
        .contextMenu {
            Button {
                state.enterProject(project)
            } label: {
                Label(L("Enter"), systemImage: "arrow.right.circle")
            }
            Button {
                state.projectsSelected = project.id
            } label: {
                Label(L("Services"), systemImage: "server.rack")
            }
            // The setup actions here too (row AND context menu); "Delete" is the "Remove" entry below.
            let display = displayWithoutOwn(project, SetupDisplay.compute(project.setup, project.detection, now: now))
            // Upload afterwards: gray while the setup is open or the container is not ready.
            if creation.mode == "container" {
                Button {
                    detailPage = .layout
                    detail = project
                } label: { Label(L("Outline"), systemImage: "list.bullet.indent") }
                    .disabled(!layoutPossible(project))
                    .accessibilityIdentifier("project-layout-\(project.id)")
                let possible = uploadPossible(project, display)
                Button { selectForAfter(project, "files", operation: nil) } label: { Label(L("Upload files"), systemImage: "doc.badge.plus") }
                    .disabled(!possible)
                    .accessibilityIdentifier("project-upload-files-\(project.id)")
                Button { selectForAfter(project, "folder", operation: nil) } label: { Label(L("Upload folder"), systemImage: "folder.badge.plus") }
                    .disabled(!possible)
                    .accessibilityIdentifier("project-upload-folder-\(project.id)")
                Button { selectForAfter(project, "zip", operation: nil) } label: { Label(L("Upload ZIP"), systemImage: "doc.zipper") }
                    .disabled(!possible)
                    .accessibilityIdentifier("project-upload-zip-\(project.id)")
                ForEach(Array(afterDisplay(project).rows.flatMap(\.actions).enumerated()), id: \.offset) { _, a in
                    Button(role: a == .dismiss(a.operation) ? .destructive : nil) {
                        Task { await retroactiveAction(project, a) }
                    } label: {
                        Text(a.title)
                    }
                    .disabled(a == .resume(a.operation) && creation.rules == nil)
                }
            }
            ForEach(Array(display.rows.flatMap(\.actions).filter { $0 != .erase }.enumerated()), id: \.offset) { _, a in
                Button(role: a == .leaveOut(a.seq ?? 0) ? .destructive : nil) {
                    Task { await setupAction(project, a) }
                } label: {
                    Text(a.title)
                }
                .disabled(a == .resume(a.seq ?? 0) && creation.rules == nil)
            }
            Button(role: .destructive) {
                deleting = project
            } label: {
                Label(L("Remove"), systemImage: "trash")
            }
            .disabled(removeLocked(project, display))
        }
    }

    /// What is currently happening with the project: ONE thing, in this order: this app's upload, the setup, upload afterwards
    /// (this app's run, then an open operation on the server), the layout. At rest nothing: the row stays quiet.
    private func state(_ project: Project) -> (text: String, color: Color)? {
        if let run = uploads.runs[project.id]?.first(where: { $0.state == .running }) {
            return (uploadText(run), .accentColor)
        } else if let z = displayWithoutOwn(project, SetupDisplay.compute(project.setup, project.detection, now: now)).rows.first {
            return (z.text, z.color)
        } else if let l = retroactive.runs[project.id]?.first(where: { $0.state == .running }) {
            return (L("{title}: uploading", ["title": l.title]), .accentColor)
        } else if let z = afterDisplay(project).rows.first {
            return (z.text, z.color)
        }
        let g = LayoutDisplay.compute(project.layout)
        return g.text.map { ($0, g.color) }
    }

    /// "4 projects · 3 ready · 2 copies", like above the list on the web (`summary` in ProjectsPane.tsx); "ready" and the
    /// copies only in server operation.
    private var summary: String {
        let n = workspace.projects.count
        var parts = [n == 1 ? L("1 project") : L("{n} projects", ["n": n])]
        if creation.mode == "container" {
            parts.append(L("{n} ready", ["n": workspace.projects.filter { $0.instance?.state == "ready" }.count]))
            let copies = workspace.projects.reduce(0) { $0 + ($1.instance?.copies?.count ?? 0) }
            if copies > 0 { parts.append(copies == 1 ? L("1 copy") : L("{n} copies", ["n": copies])) }
        }
        return parts.joined(separator: " · ")
    }

    /// The ONE muted line: port conflicts (orange) · services · copies. The conflicts FIRST: the line is single-line and truncates
    /// at the end, so at a large text size exactly the most important part would drop ("3 services · 2 running · 2 port c…").
    /// A part not yet loaded is missing: "no services recorded" appears only after a response. Without any part no short line. The
    /// state sits above it (`state`), not in front in this line.
    private func shortLine(_ project: Project) -> Text? {
        var parts: [Text] = []
        let k = conflicts[project.id]?.items.count ?? 0
        if k > 0 {
            parts.append(Text(k == 1 ? L("{n} port conflict", ["n": k]) : L("{n} port conflicts", ["n": k])).foregroundStyle(.orange))
        }
        if let services {
            let list = services[project.id] ?? []
            if list.isEmpty {
                parts.append(Text(L("no services recorded")))
            } else {
                var set = list.count == 1 ? L("1 service") : L("{n} services", ["n": list.count])
                // "running" means the same as "Stop" in the services: the port shows it, or the start guard holds it
                // (`ProjectServiceRow.stoppable`).
                let run = list.filter(\.stoppable).count
                if run > 0 { set += " · " + (run == 1 ? L("1 running") : L("{n} running", ["n": run])) }
                parts.append(Text(set))
            }
        }
        if let n = copies?[project.id]?.count, n > 0 {
            parts.append(Text(n == 1 ? L("1 copy") : L("{n} copies", ["n": n])))
        }
        guard var row = parts.first else { return nil }
        for part in parts.dropFirst() { row = row + Text(" · ") + part }
        return row
    }

    /// The page's explanation.
    private var infoSheet: some View {
        CbInfoSheet(
            title: L("Projects"),
            intro: L("The projects of this workspace. Entering switches chats, agents, context and credentials to the project — like the picker at the top."),
            points: [
                CbInfoDot(symbol: "folder", word: L("Folder"), text: L("A project is a folder in the workspace; the server creates it itself.")),
                CbInfoDot(symbol: "exclamationmark.triangle", tone: .orange, word: L("Port conflicts"), text: L("Two services want the same port — details are in the services.")),
            ],
            footnote: L("Tap to open the project with its services and its outline. Press and hold to enter or remove. Removing deletes the folder permanently.")
        )
    }

    private func afterTheDetail() {
        // After the layout, paths and rows are new.
        if detailPage == .layout { Task { await state.loadWorkspaces() } }
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .enter(let project): state.enterProject(project)
        case .services(let project): state.projectsSelected = project.id
        case .remove(let project): deleting = project
        case .action(let project, let a):
            let fresh = workspace.projects.first(where: { $0.id == project.id }) ?? project
            Task { await setupAction(fresh, a) }
        case .upload(let project, let kind):
            selectForAfter(project, kind, operation: nil)
        case .afterAction(let project, let a):
            let fresh = workspace.projects.first(where: { $0.id == project.id }) ?? project
            Task { await retroactiveAction(fresh, a) }
        case .jump(let project, let jump):
            Task {
                if let text = await state.instanceJump(jump, project: project) { notice = text }
            }
        }
    }

    /// A read error is not an empty answer: the last state stays. Otherwise `try? … ?? [:]` would turn a 500 into "no conflicts"
    /// and the marker would vanish on pull to refresh.
    private func loadConflicts() async {
        do {
            conflicts = try await client.get("/api/ports/conflicts")
        } catch {
            // last state stays
        }
    }

    /// Services and copies for the short line: fetched separately like on the apps page: an error of one route does not drag the
    /// other along, and each keeps its last state.
    private func loadOverview() async {
        if let rows: [ProjectServiceRow] = try? await client.get("/api/project-services") {
            services = Dictionary(grouping: rows, by: \.projectId)
        }
        if let projects: [AppsProject] = try? await client.get("/api/projects") {
            copies = Dictionary(projects.map { ($0.id, $0.instance?.copies ?? []) }, uniquingKeysWith: { a, _ in a })
        }
    }

    // ── Project creation ────────────────────────────────────────────────────────────────────────────────────────────

    private var setupOpen: Bool {
        workspace.projects.contains { p in p.setup != nil || (p.uploads ?? []).contains { $0.state == "upload" && $0.interrupted != true } }
    }

    private func newProject() {
        if creation.mode == "container" { if creation.rules != nil { create = .empty } } else { creating = true }
    }

    /// Uploads these sources (after creating or when resuming); afterwards the list is new.
    private func startUploads(_ projectId: String, _ list: [SourceUpload], resume: Bool) {
        uploads.start(client, projectId: projectId, uploads: list, resume: resume) {
            await state.loadWorkspaces()
        }
    }

    /// While THIS app uploads a source, the server row "waiting for upload" drops out for it: otherwise it would show a question
    /// about an upload that is running right now.
    private func displayWithoutOwn(_ project: Project, _ a: SetupDisplay) -> SetupDisplay {
        var b = a
        b.rows = a.rows.filter { z in z.seq.map { !uploads.own(project.id, $0) } ?? true }
        return b
    }

    private func removeLocked(_ project: Project, _ a: SetupDisplay) -> Bool {
        a.deleteLocked || (uploads.runs[project.id]?.contains { $0.state == .running || $0.state == .waiting } ?? false)
            || afterDisplay(project).deleteLocked || retroactive.active(project.id) || LayoutDisplay.compute(project.layout).deleteLocked
    }

    /// The layout needs the project container and no open setup.
    private func layoutPossible(_ p: Project) -> Bool {
        creation.mode == "container" && p.instance?.converted == true && p.setup == nil
    }

    private func uploadText(_ l: ProjectUploads.SourceRun) -> String {
        L("{source}: uploading, {done} / {total} files · {sent} / {size}", [
            "source": l.target.isEmpty ? "/" : l.target, "done": l.progress.files, "total": l.progress.filesTotal,
            "sent": sizeText(l.progress.bytes), "size": sizeText(l.progress.bytesTotal),
        ])
    }

    private func setupAction(_ p: Project, _ a: SetupAction) async {
        switch a {
        case .resume(let seq):
            guard let q = p.setup?.sources.first(where: { $0.seq == seq }), creation.rules != nil else { return }
            afterChoice = nil
            resumeFor = ResumeTarget(projectId: p.id, source: q, choice: ProjectCreationComputation.rememberedChoice(p.id, seq) ?? (q.kind == "files" ? "files" : q.kind == "zip" ? "zip" : "folder"))
            resumeSelect = true
        case .erase:
            deleting = p
        case .takeOver, .leaveOut:
            setupQuestion = SetupQuestion(project: p, action: a)
        case .access(let seq, _):
            if let host = p.setup?.sources.first(where: { $0.seq == seq })?.host, !host.isEmpty {
                accessFor = AccessTarget(projectId: p.id, host: host)
            }
        default:
            await performAction(p, a)
        }
    }

    private func questionText(_ f: SetupQuestion) -> String {
        switch f.action {
        case .takeOver(let seq):
            let source = f.project.setup?.sources.first(where: { $0.seq == seq })
            if source?.kind == "clone" { return L("Take over the repository without the missing submodules or LFS files?") }
            return source?.state == "wait-upload"
                ? L("Take what has been uploaded so far? Whatever is still missing won't be in the project.")
                : L("Take what is already staged? Whatever is missing will not be added to the project.")
        case .leaveOut(let seq):
            return f.project.setup?.sources.first(where: { $0.seq == seq })?.kind == "clone"
                ? L("Continue without this repository? Whatever has already been cloned is discarded.")
                : L("Continue without this source? Whatever was uploaded from it is discarded.")
        case .resume:
            if let a = f.archive {
                let fresh = a.archive?.lastPathComponent ?? ""
                return f.archiveOld.isEmpty
                    ? L("Whether “{fresh}” is the archive that is already partly uploaded cannot be checked. Upload from the start? What the server already holds will be replaced; the layout stays the one chosen at creation.", ["fresh": fresh])
                    : L("“{fresh}” cannot be confirmed to be the archive that is already partly uploaded (“{old}”). Upload from the start? What the server already holds will be replaced; the layout stays the one chosen at creation.", ["fresh": fresh, "old": f.archiveOld])
            }
            return L("{n} files don't belong to this source and are left out. Resume anyway?", ["n": f.notCaptured])
        default: return ""
        }
    }

    private func questionButton(_ f: SetupQuestion) -> String {
        if case .resume = f.action { return f.archive != nil ? L("Upload from the start") : L("Resume") }
        return f.action.title
    }

    private func confirmed(_ f: SetupQuestion) async {
        if case .resume(let seq) = f.action, let a = f.archive, let url = a.archive {
            // From the start: what is remembered now points to the new archive.
            ProjectCreationComputation.remember(f.project.id, seq, kind: "zip", name: url.lastPathComponent, [], size: a.archiveSize,
                                        changed: (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate?.timeIntervalSince1970)
            startUploads(f.project.id, [a], resume: true)
            return
        }
        if case .resume(let seq) = f.action, let q = f.project.setup?.sources.first(where: { $0.seq == seq }) {
            startUploads(f.project.id, [SourceUpload(seq: seq, source: 1, kind: q.kind, target: q.target, files: f.files, access: f.access)], resume: true)
            return
        }
        await performAction(f.project, f.action)
    }

    private func performAction(_ p: Project, _ a: SetupAction) async {
        struct Conflict: Encodable { let mode: String }
        // In `error`/`aborted` the server accepts "Take over as is" only with the explicit flag; in `wait-upload` it does not read
        // the body.
        struct TakeOver: Encodable { let takeOver = true }
        let path = "/api/projects/\(p.id)/setup"
        do {
            switch a {
            case .takeOver(let seq):
                try await client.send("\(path)/sources/\(seq)/finished", body: TakeOver())
                ProjectCreationComputation.forget(p.id, seq)
            case .leaveOut(let seq):
                try await client.send("\(path)/sources/\(seq)/leaveOut")
                ProjectCreationComputation.forget(p.id, seq)
            case .abort(let seq): try await client.send("\(path)/sources/\(seq)/abort")
            case .again: try await client.send("\(path)/again")
            case .overwrite: try await client.send("\(path)/conflict", body: Conflict(mode: "overwrite"))
            case .skip: try await client.send("\(path)/conflict", body: Conflict(mode: "skip"))
            case .abortConflict: try await client.send("\(path)/conflict", body: Conflict(mode: "abort"))
            case .erase: deleting = p
            case .resume, .access: break
            }
        } catch {
            notice = L("Error: {msg}", ["msg": ProjectUploads.text(error)])
        }
        await state.loadWorkspaces()
    }

    /// "Resume upload": the same source chosen again; the server reports on beginning what is already there.
    private func resume(_ target: ResumeTarget, _ urls: [URL]) async {
        guard let rules = creation.rules, let p = workspace.projects.first(where: { $0.id == target.projectId }) else { return }
        if target.choice == "zip" {
            // An archive resumes where the server stands (`begin` names the size), but only the same one: a DIFFERENT one would append
            // foreign bytes to the old start. If it cannot be proven, it starts over after a question.
            guard target.source.kind == "zip" else { notice = L("This source was not a ZIP archive."); return }
            let chosen: SelectedSource
            do { chosen = try await Task.detached(priority: .userInitiated) { try ProjectRead.readZip(urls[0]) }.value }
            catch { notice = error.localizedDescription; return }
            guard let z = chosen.zip else { return }
            var u = SourceUpload(seq: target.source.seq, source: 1, kind: "zip", target: target.source.target, files: [], access: chosen.access, archive: z.file, archiveSize: z.size)
            let remembered = ProjectCreationComputation.remembered(p.id, target.source.seq)
            if !ProjectCreationComputation.sameArchive(z, server: target.source, remembered: remembered) {
                u.fresh = true
                let old = target.source.name ?? (remembered?.kind == "zip" ? remembered?.name ?? "" : "")
                setupQuestion = SetupQuestion(project: p, action: .resume(target.source.seq), access: chosen.access, archive: u, archiveOld: old)
                return
            }
            startUploads(p.id, [u], resume: true)
            return
        }
        let folder = target.choice != "files"
        let chosen: SelectedSource = await Task.detached(priority: .userInitiated) {
            folder ? ProjectRead.readFolder(urls[0], rules) : ProjectRead.readFiles(urls)
        }.value
        let (files, notCaptured) = ProjectCreationComputation.resumption(p.id, source: target.source, selected: chosen, rules: rules)
        if files.isEmpty { notice = L("Nothing in this selection belongs to this source."); return }
        if notCaptured > 0 {
            setupQuestion = SetupQuestion(project: p, action: .resume(target.source.seq), files: files, access: chosen.access, notCaptured: notCaptured)
            return
        }
        startUploads(p.id, [SourceUpload(seq: target.source.seq, source: 1, kind: target.source.kind, target: target.source.target, files: files, access: chosen.access)], resume: true)
    }

    // ── Upload afterwards ─────────────────────────────────────────────────────────────────────────────────────────────

    /// Which dialog chooses: the creation ("Resume upload") or afterwards.
    private var dialogChoice: String? { afterChoice?.kind ?? resumeFor?.choice }

    private func afterDisplay(_ p: Project) -> RetroactiveDisplay {
        RetroactiveDisplay.compute(p.uploads, own: retroactive.own(p.id), ended: retroactive.ended(p.id), now: now)
    }

    private func uploadPossible(_ p: Project, _ a: SetupDisplay) -> Bool {
        creation.mode == "container" && creation.rules != nil && RetroactiveDisplay.uploadPossible(p, a)
            && !LayoutDisplay.compute(p.layout).uploadLocked
    }

    private func selectForAfter(_ p: Project, _ kind: String, operation: String?) {
        resumeFor = nil
        afterChoice = AfterChoice(projectId: p.id, kind: kind, operation: operation)
        resumeSelect = true
    }

    /// The file dialog has chosen: read, compute targets (origin by the layout: folder name + path, skip list), run.
    private func afterSelected(_ n: AfterChoice, _ urls: [URL]) async {
        guard let rules = creation.rules, let p = workspace.projects.first(where: { $0.id == n.projectId }) else { return }
        if n.kind == "zip" {
            let chosen: SelectedSource
            do { chosen = try await Task.detached(priority: .userInitiated) { try ProjectRead.readZip(urls[0]) }.value }
            catch { notice = error.localizedDescription; return }
            guard let z = chosen.zip else { return }
            if let v = n.operation {
                // Resume only with the same archive: a DIFFERENT one would append foreign bytes to the started start; then from the start.
                let u = p.uploads?.first(where: { $0.operation == v })
                let g = RetroactiveRemembered.remembered(p.id, v)
                var check: [Bool] = []
                if let b = u?.bytes { check.append(b == z.size) }
                if let g, g.choice == "zip" {
                    check.append(ProjectLayout.equal(g.name, z.fileName))
                    if let b = g.size { check.append(b == z.size) }
                    if let t = g.changed, let now = z.changed { check.append(abs(t - now) < 0.001) }
                }
                if check.isEmpty || check.contains(false) {
                    afterConfirmation = AfterConfirmation(
                        text: L("“{fresh}” cannot be shown to be the archive that is already partly uploaded. Discard the started upload and upload this archive from scratch?", ["fresh": z.fileName]),
                        button: L("Upload from scratch")
                    ) {
                        await RetroactiveRun.dismiss(client, p.id, v)
                        RetroactiveRemembered.forget(p.id, v)
                        startArchive(p, z, operation: nil)
                    }
                    return
                }
            }
            startArchive(p, z, operation: n.operation)
            return
        }
        let folder = n.kind == "folder"
        let chosen: SelectedSource = await Task.detached(priority: .userInitiated) {
            folder ? ProjectRead.readFolder(urls[0], rules) : ProjectRead.readFiles(urls)
        }.value
        if let v = n.operation, folder, let g = RetroactiveRemembered.remembered(p.id, v), g.choice == "folder", !g.name.isEmpty, !ProjectLayout.equal(g.name, chosen.name) {
            afterConfirmation = AfterConfirmation(
                text: L("“{fresh}” is not the folder “{old}” that is already partly uploaded. Add it to this upload anyway?", ["fresh": chosen.name, "old": g.name]),
                button: L("Resume")
            ) { startFiles(p, chosen, rules, choice: n.kind, operation: v) }
            return
        }
        startFiles(p, chosen, rules, choice: n.kind, operation: n.operation)
    }

    private func startFiles(_ p: Project, _ chosen: SelectedSource, _ rules: LayoutRules, choice: String, operation: String?) {
        let selection = ProjectLayout.treeFromSelection(ProjectRead.selection([(1, chosen)]), rules, ProjectRead.gitFiles([(1, chosen)]))
        let all = (selection.upload["1"] ?? []).compactMap { d in chosen.urls[d.rel].map { UploadFile(target: d.origin, url: $0, size: d.size) } }
        // Targets the server would not accept (control characters, often an invisible "Icon\r") stay out after a question.
        let invalid = all.filter { RetroactiveRun.targetError($0.target, rules) != nil }.map(\.target)
        let files = all.filter { RetroactiveRun.targetError($0.target, rules) == nil }
        if files.isEmpty { notice = L("Nothing in this selection would be uploaded."); return }
        let title = chosen.kind == "folder" ? L("Folder “{name}”", ["name": chosen.name]) : files.count == 1 ? L("1 file") : L("{n} files", ["n": files.count])
        let source = RetroactiveSource.files(files, access: chosen.access, title: title, choice: choice, name: chosen.name)
        if !invalid.isEmpty {
            afterConfirmation = AfterConfirmation(
                text: L("{n} files have names the project does not accept (control characters or similar, often invisible system files such as “Icon” of a folder with a custom icon): {names}. Upload without them?",
                        ["n": invalid.count, "names": invalid.prefix(5).map { $0.debugDescription }.joined(separator: ", ")]),
                button: L("Upload without them")
            ) { runFiles(p, source, operation: operation) }
            return
        }
        runFiles(p, source, operation: operation)
    }

    /// Upload computed files (new, into the operation `operation`, or resumed from the selection in memory).
    private func runFiles(_ p: Project, _ source: RetroactiveSource, operation: String?) {
        guard case .files(let files, let access, let title, let choice, let name) = source else { return }
        let client = client, pid = p.id
        retroactive.run(client, p, title: title, operation: operation, source: source, finished: { await state.loadWorkspaces() }) { question, onOperation, aborted, progress in
            try await RetroactiveRun.files(client, projectId: pid, files: files, access: access, operation: operation, question: question,
                                                onOperation: { v in onOperation(v); RetroactiveRemembered.remember(pid, v, .init(choice: choice, name: name)) },
                                                aborted: aborted, progress: progress)
        }
    }

    private func startArchive(_ p: Project, _ z: ZipSource, operation: String?) {
        let client = client, pid = p.id
        retroactive.run(client, p, title: L("ZIP “{name}”", ["name": z.fileName]), operation: operation, source: .zip(z), finished: { await state.loadWorkspaces() }) { question, onOperation, aborted, progress in
            try await RetroactiveRun.archive(client, projectId: pid, archive: z.file, size: z.size, operation: operation, question: question,
                                               onOperation: { v in onOperation(v); RetroactiveRemembered.remember(pid, v, .init(choice: "zip", name: z.fileName, size: z.size, changed: z.changed)) },
                                               aborted: aborted, progress: progress)
        }
    }

    /// An action on the row of an open operation ("Interrupted operations").
    private func retroactiveAction(_ p: Project, _ a: RetroactiveAction) async {
        guard let u = p.uploads?.first(where: { $0.operation == a.operation }) else { return }
        let v = u.operation
        struct Conflict: Encodable { let conflict: String }
        do {
            switch a {
            case .resume:
                let title = RetroactiveRemembered.remembered(p.id, v).map { $0.choice == "zip" ? L("ZIP “{name}”", ["name": $0.name]) : $0.choice == "folder" ? L("Folder “{name}”", ["name": $0.name]) : L("Upload##noun") } ?? L("Upload##noun")
                if u.state != "upload" {
                    // Placing or unpacking interrupted or failed: `finished` once more (for the archive with its mode). A part is
                    // already in the project; "Discard the rest" in the question discards only what still lies on the server.
                    if try await RetroactiveRun.finished(client, p.id, v, conflict: nil, question: retroactive.questionFn(client, p, title: title, run: nil, partial: true)) == .placed { retroactive.forget(p.id, v) }
                } else if let q = retroactive.source(p.id, v) {
                    // In this session the selection is still in memory: continue without a new choice.
                    if case .zip(let z) = q { startArchive(p, z, operation: v) } else { runFiles(p, q, operation: v) }
                    return
                } else if u.kind == "archive" {
                    // If the archive is already complete (the app left after the last piece), continue without a new choice.
                    if let pr = try await RetroactiveRun.checkIfComplete(client, p.id, v) {
                        if try await RetroactiveRun.unpack(client, p.id, pr, question: retroactive.questionFn(client, p, title: title, run: nil)) == .placed { retroactive.forget(p.id, v) }
                    } else {
                        selectForAfter(p, "zip", operation: v)
                        return
                    }
                } else {
                    let g = RetroactiveRemembered.remembered(p.id, v)
                    let choice = g?.choice == "folder" || g?.choice == "files" ? g!.choice : (u.newFolders?.isEmpty == false ? "folder" : "files")
                    selectForAfter(p, choice, operation: v)
                    return
                }
            case .dismiss:
                // After placing, what is already in the project stays; the text says so.
                afterConfirmation = AfterConfirmation(
                    text: u.state == "upload" ? L("Discard this upload? Whatever of it is already on the server is deleted; nothing in the project changes.")
                        : L("Discard this upload? What is still on the server is deleted; what has already been placed into the project stays there."),
                    button: L("Dismiss"), destructive: true
                ) {
                    do { try await client.send("/api/projects/\(p.id)/upload/\(v)", method: .delete); retroactive.forget(p.id, v) }
                    catch { notice = L("Error: {msg}", ["msg": ProjectUploads.text(error)]) }
                    await state.loadWorkspaces()
                }
                return
            case .abort:
                try await client.send("/api/projects/\(p.id)/upload/\(v)/abort")
            case .overwrite, .skip:
                try await client.send("/api/projects/\(p.id)/upload/\(v)/finished", body: Conflict(conflict: a.kind))
                retroactive.forget(p.id, v)
            }
        } catch is CancellationError {
            // "Later" on the question: the operation stays as it is.
        } catch {
            notice = L("Error: {msg}", ["msg": ProjectUploads.text(error)])
        }
        await state.loadWorkspaces()
    }

    private func remove(_ project: Project) async {
        uploads.abort(project.id)
        retroactive.abortAll(project.id)
        do {
            let _: OKResponse = try await client.delete(
                "/api/workspaces/\(workspace.id)/projects/\(project.id)",
                query: [URLQueryItem(name: "purge", value: "1")]
            )
            if state.projectsSelected == project.id { state.projectsSelected = nil }
            if state.enteredProject?.id == project.id { state.leaveProject() }
            await state.loadWorkspaces()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── Project detail: services (scan, start/stop, logs) ───────────────────────
//
// No cards (language of Kit/CbRows.swift):
//  – ONE row per service: symbol by kind (`serviceSymbol`), marker as dot (green running, accent starting, red stopping),
//    name, short line ":3000 · Next.js · Frontend", below it the start command single-line in monospace (what gets started;
//    otherwise "No start command"). Description, folder and logs are in the service sheet on tap (`ServiceSheet`).
//  – On the right OVER the row the round start/stop button (`startStop`): the most common move stays ONE tap. Long-press:
//    edit start command, agent chat.
//  – The scan's conflicts as ONE orange line instead of a card; the explanation ("Rescan", start command) behind the ⓘ.
struct ProjectDetailPane: View {
    let client: APIClient
    let project: Project
    let onBack: () -> Void
    @EnvironmentObject private var state: AppState

    @State private var services: [ProjectServiceDetail] = []
    @State private var scan: ServiceScanState?
    /// The first response is in. Before it the skeleton shows, after it, and only then, "No services recorded yet." (otherwise
    /// skeleton and empty state would alternate on every poll with an empty list).
    @State private var loaded = false
    @State private var error = ""
    @State private var agentDialogFor: ProjectServiceDetail?
    @State private var commandDraftFor: ProjectServiceDetail?
    /// Running transitions per service: "starting"/"stopping" with start, mode and response; when one ends is decided by
    /// `ServiceTransitionRule` (Shell/AppsPage.swift, twin of web/src/lib/service-transition.ts). Otherwise "starting" would end
    /// only at `running` and hang forever on a held run or a dead process.
    @State private var transitions: [Int: Run] = [:]

    private struct Run: Equatable {
        let kind: String
        var since = Date()
        var mode: String? = nil
        var response: Date? = nil
        /// On a simple start: when the first dead state after the response arrived (`ServiceTransitionRule.deadSinceAfter`).
        var deadSince: Date? = nil
    }
    @State private var poll: Task<Void, Never>?
    /// The open service sheet. It shows the service from `services` (the polling catches up), the state at tap only if it is
    /// missing after a new scan.
    @State private var detail: ServiceTarget?
    /// What should happen after the service sheet closes (the agent chat lies over the app, not over the sheet).
    @State private var byDetail: String?
    /// The service whose removal is asked after the sheet closes, and the open question.
    @State private var removeAfterDetail: ProjectServiceDetail?
    @State private var removeQuestion: ProjectServiceDetail?
    @State private var infoOpen = false

    var body: some View {
        PaneScaffold(
            title: L("Services"),
            subtitle: project.name,
            trailing: AnyView(headerButtons),
            // Back here means: to the project list, not to the tab's overview; the own `leading` displaces the arrow that
            // `CategoryContent` gives all pages.
            leading: AnyView(CbBackButton(action: onBack, identifier: "projects-back"))
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)
                    if let scan, scan.status == "error", let message = scan.error {
                        InlineError(message: L("Scan failed:") + " " + message)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 8)
                    }

                    if let scan, !scan.conflicts.isEmpty {
                        scanConflicts(scan.conflicts)
                            .padding(.bottom, 6)
                    }

                    if !loaded {
                        if error.isEmpty { CbRowSkeleton(rows: 3) }
                    } else if services.isEmpty {
                        let scanRunning = scan?.status == "running"
                        CbEmpty(
                            symbol: "server.rack",
                            text: scanRunning ? L("The agent is reading the project folder…") : L("No services recorded yet."),
                            button: L("Rescan"),
                            create: scanRunning ? nil : { Task { await rescan() } }
                        )
                    } else {
                        VStack(spacing: 2) {
                            ForEach(services) { service in row(service) }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await load() }
        }
        .task {
            await load()
            startPolling()
        }
        .onDisappear { poll?.cancel() }
        .sheet(item: $agentDialogFor) { service in
            AgentStartSheet(serviceName: service.name, initial: service.agentInstructions) { instructions in
                await start(service, mode: "agent", instructions: instructions)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $commandDraftFor) { service in
            StartCommandSheet(serviceName: service.name, initial: service.startCommand) { command in
                await saveCommand(service, command: command)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { target in
            let service = services.first(where: { $0.id == target.id }) ?? target.service
            ServiceSheet(
                client: client,
                projectId: project.id,
                service: service,
                transition: transitions[service.id]?.kind,
                commandSave: { command in await saveCommand(service, command: command) },
                chatOpen: { chatId in
                    byDetail = chatId
                    detail = nil
                },
                remove: removable(service) ? {
                    removeAfterDetail = service
                    detail = nil
                } : nil
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            L("Remove service “{name}” from the list? The next scan adds it again if it finds it.", ["name": removeQuestion?.name ?? ""]),
            isPresented: Binding(get: { removeQuestion != nil }, set: { if !$0 { removeQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Remove"), role: .destructive) {
                if let service = removeQuestion { Task { await remove(service) } }
                removeQuestion = nil
            }
            Button(L("Cancel"), role: .cancel) { removeQuestion = nil }
        }
    }

    /// A rescan removes only what it created itself and what is not running: a hand-registered row, one from before the origin
    /// and a duplicate next to a running service stay, and without this route they could only go through an agent. Only a
    /// stopped service without a transition: the process of a running one would stay without a row and nothing would stop it.
    private func removable(_ service: ProjectServiceDetail) -> Bool {
        transitions[service.id] == nil && !(service.status?.running ?? false) && !(service.status?.holdsStart ?? false)
    }

    /// ⓘ and "Rescan" (during a scan a quiet "Scan running…").
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About services"), identifier: "services-info") { infoOpen = true }
            if scan?.status == "running" {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("Scanning…"))
                        .cbFont(12.5)
                        .foregroundStyle(CbColor.textMuted)
                }
            } else {
                PillButton(title: L("Rescan")) { Task { await rescan() } }
                    .accessibilityIdentifier("services-rescan")
            }
        }
    }

    /// The round button on the right over the row: start (menu: plain or with agent) or stop; the most common move stays ONE tap.
    /// During a transition it spins instead of being tappable.
    @ViewBuilder
    private func startStop(_ service: ProjectServiceDetail) -> some View {
        let running = service.status?.running ?? false
        // The start guard holds a start although the port shows nothing: then "Stop".
        let stoppable = running || (service.status?.holdsStart ?? false)
        // While "Starting" shows, the stop is there as soon as there is something to stop (a held run would otherwise wait for the deadline).
        if let transition = transitions[service.id]?.kind, !(transition == "starting" && stoppable) {
            ProgressView()
                .controlSize(.small)
                .frame(width: 32, height: 32)
                .background(.cbElevated, in: Circle())
                .frame(width: 44, height: 44)
                .accessibilityLabel(transition == "starting" ? L("Starting") : L("Stopping"))
        } else if stoppable {
            Button {
                Task { await stop(service) }
            } label: {
                roundSign("stop.fill", tone: .red)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("Stop"))
            .accessibilityIdentifier("service-stop-\(service.id)")
        } else {
            Menu {
                Button(L("Simple start")) { Task { await start(service, mode: "simple", instructions: nil) } }
                    .disabled(service.startCommand.isEmpty)
                Button(L("Start with agent")) { agentDialogFor = service }
            } label: {
                roundSign("play.fill", tone: .accentColor)
            }
            .accessibilityLabel(L("Start"))
            .accessibilityIdentifier("service-start-\(service.id)")
        }
    }

    /// The symbol in the round button: 32 pt circle like `CbRoundButton`, hit area 44 pt.
    private func roundSign(_ symbol: String, tone: Color) -> some View {
        Image(systemName: symbol)
            .font(.symbol(12, weight: .semibold))
            .foregroundStyle(tone)
            .frame(width: 32, height: 32)
            .background(.cbElevated, in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    /// One row per service; the start/stop button lies OVER it (a button in a button's label would get no touch; pattern `CbToggleRow`).
    private func row(_ service: ProjectServiceDetail) -> some View {
        let command = service.startCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        return ZStack(alignment: .trailing) {
            Button {
                detail = ServiceTarget(id: service.id, service: service)
            } label: {
                CbListRow(
                    character: serviceSign(service, transition: transitions[service.id]?.kind),
                    title: service.name,
                    shortLine: serviceShortLine(service),
                    text: command.isEmpty ? L("No start command") : command,
                    textLines: 1,
                    textMono: !command.isEmpty,
                    right: 44
                )
            }
            .cbRowPress()
            .contextMenu {
                Button {
                    commandDraftFor = service
                } label: {
                    Label(command.isEmpty ? L("Set start command") : L("Edit start command"), systemImage: "terminal")
                }
                if service.status?.mode == "agent", let chatId = service.status?.chatId {
                    Button {
                        openChat(chatId)
                    } label: {
                        Label(L("Open chat"), systemImage: "bubble.left.and.text.bubble.right")
                    }
                }
                if removable(service) {
                    Button(role: .destructive) {
                        removeQuestion = service
                    } label: {
                        Label(L("Remove service"), systemImage: "trash")
                    }
                }
            }
            .accessibilityIdentifier("service-\(service.id)")

            startStop(service)
                .padding(.trailing, 2)
        }
    }

    /// The scan's conflicts: ONE orange line (quiet, no button), per conflict ":port (service) — taken by".
    private func scanConflicts(_ conflicts: [ServiceScanConflict]) -> some View {
        CbListRow(
            character: CbSign(symbol: "exclamationmark.triangle", tone: .orange),
            title: L("Port conflicts"),
            shortLine: Text(L("during registration")),
            text: conflicts.map { ":\($0.port) (\($0.name)) — \($0.owner)" }.joined(separator: "\n"),
            // Without a cap: if a conflict wraps, "as many lines as conflicts" would cut off the last ones.
            textLines: nil
        )
        .accessibilityElement(children: .combine)
    }

    private var infoSheet: some View {
        CbInfoSheet(
            title: L("Services"),
            intro: L("The services of this project, as the scan recorded them in the project folder."),
            points: [
                CbInfoDot(symbol: "play.fill", tone: .accentColor, word: L("Start"), text: L("A simple start runs the start command; with an agent, an agent brings the service up (env, dependencies, port check).")),
                CbInfoDot(symbol: "sparkle.magnifyingglass", word: L("Rescan"), text: L("“Re-scan” has an AI agent inventory the stack in the project folder.")),
                CbInfoDot(symbol: "terminal", word: L("Start command"), text: L("Manual changes survive re-scans. Leave empty so the next scan derives the command again itself.")),
            ],
            footnote: L("Tap to see description, start command and logs. The round button on the right starts or stops.")
        )
    }

    private func afterTheDetail() {
        if let service = removeAfterDetail {
            removeAfterDetail = nil
            removeQuestion = service
        }
        guard let chatId = byDetail else { return }
        byDetail = nil
        openChat(chatId)
    }

    /// The chat that starts a service "with agent" is a coding chat in this project: open it in Coding, the same path as a
    /// notification (`AppState.openCodingChat`). The project belongs to the active workspace.
    private func openChat(_ chatId: String) {
        Task { await state.openCodingChat(chatId, workspaceId: state.activeWorkspaceId ?? "", projectId: project.id) }
    }

    private func load() async {
        let queried = Date()
        do {
            let response: ProjectServicesResponse = try await client.get("/api/projects/\(project.id)/services")
            scan = response.scan
            services = response.services
            loaded = true
            error = ""
            // `now`: when the state arrived; from the first dead one the grace period counts (`deadSince`).
            let now = Date()
            var ended: [String] = []
            for (id, run) in transitions {
                let service = response.services.first { $0.id == id }
                let step = ServiceTransitionRule.step(
                    start: run.kind == "starting", mode: run.mode, since: run.since, response: run.response, deadSince: run.deadSince,
                    running: service.map { $0.status?.running ?? false }, holds: service?.status?.holdsStart ?? false,
                    now: now, queried: queried
                )
                guard let end = step.end else {
                    if step.deadSince != run.deadSince { transitions[id]?.deadSince = step.deadSince }
                    continue
                }
                transitions[id] = nil
                if end == .ended, let service { ended.append(service.name) }
            }
            if !ended.isEmpty { error = ServiceTransitionRule.endedNotice(ended) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func startPolling() {
        poll?.cancel()
        poll = Task {
            while !Task.isCancelled {
                let fast = !transitions.isEmpty || scan?.status == "running"
                try? await Task.sleep(nanoseconds: fast ? 1_200_000_000 : 6_000_000_000)
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    private func rescan() async {
        _ = try? await client.send("/api/projects/\(project.id)/services/scan")
        await load()
    }

    private func start(_ service: ProjectServiceDetail, mode: String, instructions: String?) async {
        struct Body: Encodable { let mode: String; let instructions: String? }
        let run = Run(kind: "starting", mode: mode)
        transitions[service.id] = run
        do {
            let response: ChatIdResponse = try await client.post(
                "/api/projects/\(project.id)/services/\(service.id)/start",
                body: Body(mode: mode, instructions: instructions)
            )
            // The response is in: only a state from after it may end a simple start as "did not keep running".
            if transitions[service.id] == run { transitions[service.id]?.response = Date() }
            if let chatId = response.chatId { openChat(chatId) }
            await load()
        } catch {
            transitions[service.id] = nil
            self.error = L("Start failed: {msg}", ["msg": error.localizedDescription])
        }
    }

    private func stop(_ service: ProjectServiceDetail) async {
        transitions[service.id] = Run(kind: "stopping")
        do {
            let data = try await client.send("/api/projects/\(project.id)/services/\(service.id)/stop")
            // A failed stop (`stopped: false`) names its reason (`error`) instead of staying silent.
            if let notice = ServiceStopResponse.notice(from: data, name: service.name) {
                transitions[service.id] = nil
                self.error = notice
            }
            await load()
        } catch {
            transitions[service.id] = nil
            self.error = L("Stop failed: {msg}", ["msg": error.localizedDescription])
        }
    }

    private func saveCommand(_ service: ProjectServiceDetail, command: String) async {
        struct Body: Encodable { let startCommand: String }
        guard command != service.startCommand else { return }
        _ = try? await client.send("/api/project-services/\(service.id)", method: .patch, body: Body(startCommand: command))
        await load()
    }

    /// `DELETE /api/project-services/:id`: the same route as `cbase_service_delete` and the web button.
    private func remove(_ service: ProjectServiceDetail) async {
        do {
            _ = try await client.send("/api/project-services/\(service.id)", method: .delete)
            await load()
        } catch {
            self.error = L("Removing failed: {msg}", ["msg": error.localizedDescription])
        }
    }
}

// ── A service: symbol, short line, sheet ────────────────────────────────────

/// The target of the service sheet: the identifier, and the state at tap in case the service is missing after a new scan.
private struct ServiceTarget: Identifiable {
    let id: Int
    let service: ProjectServiceDetail
}

/// The symbol of a service by its kind (the scan's kind, `kind`).
private func serviceSymbol(_ kind: String) -> String {
    switch kind {
    case "backend": return "server.rack"
    case "frontend": return "macwindow"
    case "db": return "cylinder.split.1x2"
    case "cache": return "bolt.horizontal"
    case "queue": return "tray.2"
    case "worker": return "gearshape.2"
    case "infra": return "shippingbox"
    default: return "cube"
    }
}

/// The kind as a word (translated through `L` at the call site).
private func serviceKind(_ kind: String) -> String {
    switch kind {
    case "backend": return "Backend"
    case "frontend": return "Frontend"
    case "db": return "Database"
    case "cache": return "Cache"
    case "queue": return "Queue"
    case "worker": return "Worker"
    case "infra": return "Infra"
    default: return "Other"
    }
}

/// The symbol with marker: green running (like "Stop": the port shows it or the start guard holds it), accent starting, red
/// stopping; stopped without marker. As the tile of the project pages, the symbol in the color of the state; the marker stays, it is
/// the label for VoiceOver.
private func serviceSign(_ service: ProjectServiceDetail, transition: String?) -> CbSign {
    let running = (service.status?.running ?? false) || (service.status?.holdsStart ?? false)
    let marker: CbSignMarker?
    let tone: Color
    switch transition {
    case "starting": marker = .point(.accentColor, L("Starting")); tone = .accentColor
    case "stopping": marker = .point(.red, L("Stopping")); tone = .red
    default: marker = running ? .point(.green, L("running")) : nil; tone = running ? .green : CbColor.textMuted
    }
    return CbSign(symbol: serviceSymbol(service.kind), tone: tone, marker: marker, tile: true)
}

/// The ONE muted line: ":3000 · Next.js · Frontend", port in monospace, technology only if the scan knows it.
private func serviceShortLine(_ service: ProjectServiceDetail) -> Text {
    var parts: [Text] = []
    if let port = service.port { parts.append(Text(verbatim: ":\(port)").monospaced()) }
    let tech = service.tech.trimmingCharacters(in: .whitespacesAndNewlines)
    if !tech.isEmpty { parts.append(Text(tech)) }
    parts.append(Text(L(serviceKind(service.kind))))
    var row = parts[0]
    for part in parts.dropFirst() { row = row + Text(" · ") + part }
    return row
}

/// What the row lacks: description, port, technology, folder, the whole start command (editable), the agent chat of a service
/// started with agent, and the logs (the last lines, fetched on open).
private struct ServiceSheet: View {
    let client: APIClient
    let projectId: String
    let service: ProjectServiceDetail
    let transition: String?
    let commandSave: (String) async -> Void
    /// Open the chat that started the service "with agent" (a coding chat).
    let chatOpen: (String) -> Void
    /// "Remove service": `nil` while the service runs or is switching (then the button is missing).
    var remove: (() -> Void)? = nil
    @State private var commandOpen = false
    /// `nil` = not loaded yet.
    @State private var logText: String?

    private var command: String { service.startCommand.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// "Running · Frontend": the state in words and the kind.
    private var state: String {
        let running = (service.status?.running ?? false) || (service.status?.holdsStart ?? false)
        let word: String
        switch transition {
        case "starting": word = L("Starting")
        case "stopping": word = L("Stopping")
        default: word = running ? L("Running") : L("Stopped")
        }
        return word + " · " + L(serviceKind(service.kind))
    }

    var body: some View {
        CbDetailSheet(
            closeIdentifier: "service-detail-close",
            erase: remove.map { CbSheetAction(title: L("Remove service"), identifier: "service-remove-\(service.id)", action: $0) }
        ) {
            CbDetailHeader(character: serviceSign(service, transition: transition), title: service.name) {
                Text(state)
            }
            CbDetailDescription(text: service.description, empty: L("(no description)"))
            if let port = service.port {
                CbDetailField(L("Port")) { mono(":\(port)") }
            }
            if !service.tech.trimmingCharacters(in: .whitespaces).isEmpty {
                CbDetailField(L("Tech")) {
                    Text(service.tech)
                        .cbFont(14)
                        .foregroundStyle(CbColor.text)
                        .textSelection(.enabled)
                }
            }
            if !service.dir.isEmpty {
                CbDetailField(L("Folder")) { mono("/\(service.dir)") }
            }
            CbDetailField(L("Start command")) {
                VStack(alignment: .leading, spacing: 6) {
                    if command.isEmpty {
                        Text(L("No start command"))
                            .cbFont(14)
                            .foregroundStyle(CbColor.textMuted)
                    } else {
                        CbCodeBox(text: command, horizontal: true)
                    }
                    textButton(command.isEmpty ? L("Set start command") : L("Edit start command"), symbol: "pencil") {
                        commandOpen = true
                    }
                    .accessibilityIdentifier("service-command-\(service.id)")
                }
            }
            if service.status?.mode == "agent", let chatId = service.status?.chatId {
                CbDetailField(L("Agent")) {
                    textButton(L("Open chat"), symbol: "bubble.left.and.text.bubble.right") { chatOpen(chatId) }
                }
            }
            if service.status?.hasLog == true {
                CbDetailField(L("Logs")) {
                    VStack(alignment: .leading, spacing: 6) {
                        CbCodeBox(text: logText ?? L("Loading log…"), horizontal: true)
                        textButton(L("Reload"), symbol: "arrow.clockwise") { Task { await loadLog() } }
                    }
                }
            }
        }
        .sheet(isPresented: $commandOpen) {
            StartCommandSheet(serviceName: service.name, initial: service.startCommand) { command in
                await commandSave(command)
            }
            .cbSheet(.whole)
        }
        .task(id: service.status?.hasLog == true) {
            if service.status?.hasLog == true { await loadLog() }
        }
    }

    private func mono(_ text: String) -> some View {
        Text(verbatim: text)
            .cbFont(13.5, design: .monospaced)
            .foregroundStyle(CbColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// A quiet text button in the sheet (form of the "Delete" button of `CbDetailSheet`, in the text color).
    private func textButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .cbFont(14, weight: .medium)
                .foregroundStyle(CbColor.text)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func loadLog() async {
        struct LogResponse: Decodable { let log: String? }
        if let response: LogResponse = try? await client.get("/api/projects/\(projectId)/services/\(service.id)/log") {
            logText = response.log?.isEmpty == false ? response.log! : L("(Log is empty)")
        } else {
            logText = L("Log could not be loaded")
        }
    }
}

// ── Dialogs ─────────────────────────────────────────────────────────────────
struct AgentStartSheet: View {
    @Environment(\.dismiss) private var dismiss
    let serviceName: String
    let initial: String
    let start: (String) async -> Void
    @State private var instructions = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextEditor(text: $instructions)
                        .frame(minHeight: 160)
                        .cbFont(13)
                } header: {
                    Text(L("Instructions for the agent"))
                } footer: {
                    Text(L("An agent brings the service up (env, dependencies, port check)"))
                }
            }
            .navigationTitle(serviceName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Start")) {
                        let text = instructions
                        dismiss()
                        Task { await start(text) }
                    }
                }
            }
            .onAppear { if instructions.isEmpty { instructions = initial } }
        }
    }
}

struct StartCommandSheet: View {
    @Environment(\.dismiss) private var dismiss
    let serviceName: String
    let initial: String
    let save: (String) async -> Void
    @State private var command = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("e.g. task up, docker compose up -d, npm run dev …"), text: $command)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(L("Start command"))
                } footer: {
                    Text(L("Manual changes survive re-scans. Leave empty so the next scan derives the command again itself."))
                }
            }
            .navigationTitle(serviceName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) {
                        let value = command.trimmingCharacters(in: .whitespaces)
                        dismiss()
                        Task { await save(value) }
                    }
                }
            }
            .onAppear { if command.isEmpty { command = initial } }
        }
    }
}

struct CreateProjectSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let onCreated: () async -> Void
    @State private var name = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField("Name", text: $name)
                } header: {
                    Text(L("New project"))
                } footer: {
                    Text(L("The server creates the folder in your environment automatically."))
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(L("New project"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "…" : L("Create")) { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        struct Body: Encodable { let name: String }
        busy = true
        do {
            try await client.send(
                "/api/workspaces/\(workspaceId)/projects",
                body: Body(name: name.trimmingCharacters(in: .whitespaces))
            )
            await onCreated()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}

struct CreateWorkspaceSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var state: AppState
    @State private var name = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField("Name", text: $name)
                } header: {
                    Text(L("New workspace"))
                } footer: {
                    Text(L("The server creates the folder in your environment automatically."))
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(L("New workspace"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "…" : L("Add")) { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        struct Body: Encodable { let path: String; let name: String }
        guard let client = state.client else { return }
        busy = true
        do {
            let workspace: Workspace = try await client.post(
                "/api/workspaces",
                body: Body(path: "", name: name.trimmingCharacters(in: .whitespaces))
            )
            await state.loadWorkspaces()
            await state.enter(workspaceId: workspace.id)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
