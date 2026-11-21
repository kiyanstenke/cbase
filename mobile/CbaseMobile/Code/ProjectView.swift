import SwiftUI

// The project view behind a row of the projects page. No cards: fields sit on the page background, separated by white space; the
// rows of a list (services, copies) by hairlines in `CbColor.edge` (`CbHairline`, Kit). Only the form differs; colors, roles and
// accent stay (`CbColor`, system font).
//
// On the phone the "tab menu on the left" is the segment bar under the title (HIG, ONE navigation level per place, like
// `AgentKindBar`):
//  – "Services": upload and setup (while they run), the state of a layout job, the services with the way into the services page,
//    the old containers (`OldContainerField`), port conflicts, upload afterwards, remote hints; "Enter" top right, "Remove" red at
//    the end. The folder sits under the name. The copies live in the third segment, with everything that belongs to them.
//  – "Outline": the page `LayoutExistingPage` embedded, under the same condition as before (`layoutPossible`); where there is none,
//    the segment names the reason. It is created on the first switch and then stays (`layoutOpen`): a switch to "Services" and
//    back would otherwise lose the not yet checked changes and reload the tree. The list's context menu "Outline" opens THE SAME
//    view with the segment selected; there is no separate layout sheet (two places for the same page: delete one).
//  – "Instances": main and the copies with their actions, `ProjectInstancesPage` (Code/ProjectInstances.swift). Only in server
//    operation on a converted project; otherwise the segment is absent (a segment that only says "not available here" would be an
//    empty promise). Like the layout it is created on the first switch and then stays (the opened instance); its 5 s tick runs
//    only while it is in front. A list with a push to an instance's page: in the sheet via the NavigationStack here (`stack`),
//    embedded in place of the list.
//  – "Git": the large git overview, `ProjectGitPage` (Code/GitView.swift, timeline in Code/GitTimeline.swift). Under the same
//    condition as "Instances", plus the flag "at least 1 repo" (`ProjectView.hatGitRepos`, from `repos` of the project list). Like the
//    instances it is created on the first switch and then stays (window, search, opened detail); tick and auto-fetch run only
//    while it is in front.
//  – No context here; it stays under its own category.
//
// Two places: as a sheet of the projects list (close/enter on top) and, in the entered project, embedded as the category
// "Project" (`embedded`): there without sheet bar, in the `PaneScaffold` of the coding pages.
//
// The head: a large tile with the folder in the color of the project container, every field a small tile with its symbol
// (`ProjectField`), the services without hairlines with one tile per service, and no hairline under the head. The name large and
// light with slightly tighter tracking, below it the folder small in monospace; markers small and muted (`CbDetailField`); a state
// as dot plus word, the accent only for selected and running.
//
// The upload, setup and upload-afterwards fields with their actions and identifiers (`uploadField` … `setupField`) and the
// identifiers of Close, Enter, "Manage services" and Remove are shared with the projects page, which asks the confirmation
// questions after the sheet closes.

/// The pages of the project view.
enum ProjectPage: String {
    case services
    case layout
    case instances
    case git
    /// Timeline per project: always there, the server keeps it for every project.
    case timeline
}

// ── Jumping to a sub-item from outside ────────────────────────────────────────

/// A jump to a sub-item of a project; twin of web/src/lib/project-jump.ts: ONE mechanism, the sub-item is `page`. "Instances"
/// (`instancesShow`, from "Create copy …" at a chat's instance choice, Chat/ChatHeader.swift `ChatInstanceChoice`), "Git"
/// (`projectGitShow`, like `showProjectGit` on the web).
struct ProjectWish: Equatable {
    let id = UUID()
    let projectId: String
    /// The sub-item the project view jumps to.
    let page: ProjectPage
    /// "Instances" only: open this instance ("main" or "copy-<name>").
    var instance: String? = nil
    /// "Instances" only: open the "Create copy" dialog with this instance as the preselected base (one that is not a ready
    /// instance is replaced by `CopyCreateSheet` with the first ready one).
    var createFrom: String? = nil
    /// "Git" only: select this repo (path relative to the project, `rel` of the git overview); only the view reads it.
    var repo: String? = nil
    let at = Date()

    /// Not picked up within a minute (the project is not converted, or gone): the wish expires; otherwise it would open a dialog
    /// on the next visit to the tab that nobody asked for any more.
    static let valid: TimeInterval = 60
    var expired: Bool { Date().timeIntervalSince(at) > Self.valid }
}

extension AppState {
    /// Into a sub-item of a project: in the entered project the category "Project" (another entered project is left and this one
    /// entered, like `instanceJump`), in the workspace the projects list with this project's view as a sheet. The projects page
    /// sets the segment, the rest of the tabs `projectWish`.
    func projectShow(_ wish: ProjectWish) {
        guard let project = activeWorkspace?.projects.first(where: { $0.id == wish.projectId }) else { return }
        if let e = enteredProject, e.id != wish.projectId { enterProject(project) }
        projectsSelected = nil
        projectWish = wish
        openCoding(.projects)
    }

    /// Into the tab "Instances" (open an instance or "Create copy" with a base).
    func instancesShow(projectId: String, instance: String? = nil, createFrom: String? = nil) {
        projectShow(ProjectWish(projectId: projectId, page: .instances, instance: instance, createFrom: createFrom))
    }

    /// Into the sub-item "Git" (the large git overview), optionally with a selected repo.
    func projectGitShow(projectId: String, repo: String? = nil) {
        projectShow(ProjectWish(projectId: projectId, page: .git, repo: repo))
    }
}

struct ProjectView: View {
    let client: APIClient
    let project: Project
    /// The layout rules (`/api/projectCreation/rules`); nil = not loaded yet; the layout page says so itself.
    let rules: LayoutRules?
    /// The selected page, bound so that the projects page knows after closing whether the layout was open (it then reloads the
    /// workspaces, as it did on closing the layout sheet).
    @Binding var page: ProjectPage
    /// Project creation: the setup rows with their actions, this app's upload, and whether Remove is possible right now.
    let setup: SetupDisplay
    let upload: [ProjectUploads.SourceRun]?
    let removeLocked: Bool
    let action: (SetupAction) -> Void
    let abortUpload: () -> Void
    let hideUpload: () -> Void
    /// Upload afterwards: the three entries (gray when not possible right now), the rows of open operations with their actions
    /// and this app's runs.
    let inOps: Bool
    let uploadPossible: Bool
    let retroactive: RetroactiveDisplay
    let retroactiveRuns: [ProjectRetroactive.Run]
    let startUpload: (String) -> Void
    let afterAction: (RetroactiveAction) -> Void
    /// The state of a layout job and whether the "Outline" page is available.
    let layout: LayoutDisplay
    let layoutPossible: Bool
    let abortRetroactiveRun: (UUID) -> Void
    let hideRetroactiveRun: (UUID) -> Void
    /// `nil` = the services are not loaded yet; then only the way into the services page shows.
    let services: [ProjectServiceRow]?
    let conflicts: [PortConflictItem]
    let enter: () -> Void
    let administerService: () -> Void
    let remove: () -> Void
    /// An entry of the "Instances" tab (chat, code, terminal); in the sheet the projects page runs it only after closing.
    let instanceJump: (InstanceJump) -> Void
    /// In the entered project the category "Project" itself: without sheet bar (close, enter).
    var embedded = false

    /// The layout was selected once; from then on its page stays mounted (hidden).
    @State private var layoutOpen = false
    /// The same for the instances (the expanded ones stay, no second load when switching back).
    @State private var instancesOpen = false
    /// The same for "Git".
    @State private var gitOpen = false
    /// The same for "Timeline".
    @State private var timelineOpen = false
    /// The last READ flag "at least 1 repo": an unread one (`repos == nil`) does not show the segment and does not hide an already
    /// shown one again (empty is not unknown).
    @State private var gitRepos = false
    @Environment(\.dismiss) private var dismiss

    /// The "Instances" segment exists only in server operation on a converted project (main then has an instance row).
    private var instancesPossible: Bool { inOps && project.instance?.converted == true }
    /// The "Git" segment under the same condition, plus the flag "at least 1 repo".
    private var gitPossible: Bool { instancesPossible && (Self.hasGitRepos(project) ?? gitRepos) }

    /// The flag "at least 1 repo" for the "Git" segment: `repos > 0` from the project list; `nil` = not read, then the view's last read
    /// state (`gitRepos`) applies, initially "no".
    static func hasGitRepos(_ project: Project) -> Bool? { project.repos.map { $0 > 0 } }

    var body: some View {
        if embedded {
            // The name stands in the page title next to "Project", the folder small below it: no second, large head.
            PaneScaffold(title: L("Project") + " · " + project.name,
                         subtitle: project.path.isEmpty ? nil : project.path) { content }
        } else {
            NavigationStack {
                content
                    // Empty, and OUTSIDE: the embedded layout sets "Outline" inside; the name stands large in the head.
                    .navigationTitle("")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        SheetClose(identifier: "project-sheet-close") { dismiss() }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(L("Enter"), action: enter)
                                .accessibilityIdentifier("project-enter-\(project.id)")
                        }
                    }
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ZStack(alignment: .top) {
                servicePage
                    .opacity(page == .services ? 1 : 0)
                    .allowsHitTesting(page == .services)
                    .accessibilityHidden(page != .services)
                if layoutOpen || page == .layout {
                    layoutPage
                        .opacity(page == .layout ? 1 : 0)
                        .allowsHitTesting(page == .layout)
                        .accessibilityHidden(page != .layout)
                }
                if instancesPossible && (instancesOpen || page == .instances) {
                    // In the sheet (NavigationStack) an instance is pushed, embedded it replaces the list.
                    ProjectInstancesPage(client: client, project: project, visible: page == .instances, stack: !embedded,
                                          jump: instanceJump, startCommand: administerService)
                        .opacity(page == .instances ? 1 : 0)
                        .allowsHitTesting(page == .instances)
                        .accessibilityHidden(page != .instances)
                }
                if gitPossible && (gitOpen || page == .git) {
                    ProjectGitPage(client: client, project: project, visible: page == .git, stack: !embedded, jump: instanceJump)
                        .opacity(page == .git ? 1 : 0)
                        .allowsHitTesting(page == .git)
                        .accessibilityHidden(page != .git)
                }
                if timelineOpen || page == .timeline {
                    ProjectTimelinePage(client: client, project: project, visible: page == .timeline, jump: instanceJump)
                        .opacity(page == .timeline ? 1 : 0)
                        .allowsHitTesting(page == .timeline)
                        .accessibilityHidden(page != .timeline)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The selected page fades in instead of cross-fading in the bar's spring (`CbFadeIn`).
            .cbFadeIn(at: page)
        }
        .cbSheetBase()
        .onChange(of: page, initial: true) { _, fresh in
            if fresh == .layout { layoutOpen = true }
            if fresh == .instances { instancesOpen = true }
            if fresh == .git { gitOpen = true }
            if fresh == .timeline { timelineOpen = true }
        }
        .onChange(of: Self.hasGitRepos(project), initial: true) { _, fresh in
            if let fresh { gitRepos = fresh }
        }
        // A project that is not (yet) converted has no "Instances" segment; a remembered choice falls back to "Services".
        .onChange(of: instancesPossible, initial: true) { _, possible in
            if !possible && page == .instances { page = .services }
        }
        // The same for "Git".
        .onChange(of: gitPossible, initial: true) { _, possible in
            if !possible && page == .git { page = .services }
        }
    }

    // ── Head ────────────────────────────────────────────────────────────────

    /// In the sheet: the large tile (the folder in the project container's color), next to it the name large and light and below it
    /// the folder; below that the pages. Embedded only the pages: name and folder are carried by the page title (`body`).
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !embedded {
                HStack(alignment: .center, spacing: 14) {
                    ProjectTile(symbol: "folder", color: project.instance.map { projectStateColor($0.state) } ?? CbColor.textSecondary, size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(project.name)
                            .tracking(-0.6)
                            .cbFont(26, weight: .regular)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(2)
                            .accessibilityAddTraits(.isHeader)
                        if !project.path.isEmpty {
                            Text(project.path)
                                .cbFont(12.5, design: .monospaced)
                                .foregroundStyle(CbColor.textMuted)
                                .lineLimit(2)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            // No number on the tab (stock does not count, cause does): a dot only while a layout job is open.
            CbSegments(
                options: [
                    CbSegment(value: ProjectPage.services, label: L("Services"), id: "project-services"),
                    CbSegment(value: ProjectPage.layout, label: L("Outline"), id: "project-layout",
                               point: layout.text != nil ? layout.color : nil),
                ] + (instancesPossible ? [CbSegment(value: ProjectPage.instances, label: L("Instances"), id: "project-instances")] : [])
                  + (gitPossible ? [CbSegment(value: ProjectPage.git, label: L("Git"), id: "project-git")] : [])
                  + [CbSegment(value: ProjectPage.timeline, label: L("Timeline"), id: "project-timeline")],
                selection: $page
            )
            .padding(.top, embedded ? 0 : 14)
        }
        .padding(.horizontal, embedded ? 16 : 20)
        .padding(.top, 4)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── Page "Services" ────────────────────────────────────────────────────

    private var servicePage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                if let upload, !upload.isEmpty {
                    ProjectField(L("Upload##noun"), symbol: "arrow.up.circle") { uploadField(upload) }
                }
                if !setup.rows.isEmpty {
                    ProjectField(L("Setup"), symbol: "gearshape") { setupField }
                }
                if let text = layout.text {
                    ProjectField(L("Outline"), symbol: "list.bullet.indent") { layoutStatus(text) }
                }
                ProjectField(L("Services"), symbol: "server.rack", right: serviceCount) { serviceList }
                // Stopped containers of renamed stacks: the field decides itself whether it shows.
                OldContainerField(project: project)
                if !conflicts.isEmpty {
                    ProjectField(L("Port conflicts"), symbol: "exclamationmark.triangle", symbolColor: .orange) {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(conflicts.enumerated()), id: \.offset) { _, conflict in
                                Text(verbatim: ":\(conflict.port) (\(conflict.name)) — \(conflict.owner)")
                                    .cbFont(13.5)
                                    .monospacedDigit()
                                    .foregroundStyle(.orange)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                if inOps {
                    ProjectField(L("Upload"), symbol: "square.and.arrow.up") { uploadField }
                }
                if let hints = project.remoteHints, !hints.isEmpty {
                    // Remote hint: names only, the access itself is in no response; cbase rewrites nothing.
                    ProjectField(L("Remotes"), symbol: "link", symbolColor: .orange) {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(hints, id: \.self) { h in
                                Text(L("Remote “{remote}” in {repo} contains credentials in its URL", ["remote": h.remote, "repo": h.repo.isEmpty ? "/" : h.repo]))
                                    .cbFont(14)
                                    .foregroundStyle(.orange)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Text(L("Every agent in the project can read this address. Better store the credentials as a Git access and set the address without them."))
                                .cbFont(12.5)
                                .foregroundStyle(CbColor.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityIdentifier("project-remote-hints")
                    }
                }
                removePart
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// "2 of 3 running" on the right of the field header; only with a response.
    private var serviceCount: String? {
        guard let services, !services.isEmpty else { return nil }
        return L("{run} of {total} running", ["run": services.filter(\.stoppable).count, "total": services.count])
    }

    /// The services briefly, without hairlines, below them the way into the services page (start, stop, scan, logs).
    private var serviceList: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let services {
                if services.isEmpty {
                    Text(L("no services recorded"))
                        .cbFont(14)
                        .foregroundStyle(CbColor.textMuted)
                        .padding(.vertical, 10)
                } else {
                    ForEach(services) { service in
                        serviceRow(service)
                    }
                }
            }
            Button(action: administerService) {
                HStack(spacing: 8) {
                    Text(L("Manage services"))
                        .cbFont(14.5, weight: .medium)
                        .foregroundStyle(CbColor.text)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.symbol(12, weight: .semibold))
                        .foregroundStyle(CbColor.textMuted)
                }
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("project-detail-\(project.id)")
        }
    }

    /// A service: tile (green = running, like "Stop" in the services), name, word, port in monospace.
    private func serviceRow(_ service: ProjectServiceRow) -> some View {
        HStack(spacing: 10) {
            ProjectTile(symbol: "server.rack", color: service.stoppable ? .green : CbColor.textMuted, size: 28)
            Text(service.name)
                .cbFont(15)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
            Spacer(minLength: 8)
            if service.stoppable {
                Text(L("running"))
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textSecondary)
            }
            if let port = service.port {
                Text(verbatim: ":\(port)")
                    .cbFont(13, design: .monospaced)
                    .foregroundStyle(CbColor.textMuted)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    /// An open layout job: dot and sentence, below it the way to the "Outline" page.
    private func layoutStatus(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(layout.color).frame(width: 7, height: 7)
                Text(text).cbFont(14).foregroundStyle(CbColor.text).fixedSize(horizontal: false, vertical: true)
            }
            if layoutPossible {
                Button(L("View outline")) { page = .layout }
                    .cbFont(13.5, weight: .medium)
                    .foregroundStyle(Color.accentColor)
                    .buttonStyle(.plain)
                    .padding(.leading, 15)
                    .accessibilityIdentifier("project-layout-view")
            }
        }
    }

    /// "Remove" red at the end; while a setup step (or an upload, a layout job) runs, in its place the sentence saying when it works
    /// again. The projects page asks the confirmation question after the sheet closes.
    @ViewBuilder
    private var removePart: some View {
        if removeLocked {
            Text(L("Removing is possible again once this setup step is done."))
                .cbFont(12.5)
                .foregroundStyle(CbColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Button(role: .destructive, action: remove) {
                Label(L("Remove"), systemImage: "trash")
                    .cbFont(14, weight: .medium)
                    .foregroundStyle(Color.red)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("project-remove-\(project.id)")
        }
    }

    // ── Page "Outline" ─────────────────────────────────────────────────────

    @ViewBuilder
    private var layoutPage: some View {
        if layoutPossible {
            LayoutExistingPage(client: client, project: project, rules: rules)
        } else {
            CbEmpty(symbol: "list.bullet.indent", text: layoutReason, identifier: "project-layout-reason")
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Why there is no layout here: the same condition as `ProjectsPane.layoutPossible`, part by part.
    private var layoutReason: String {
        if !inOps { return L("The outline is only available in server mode, with the project's own container.") }
        if project.setup != nil { return L("The project is still being set up — the outline only works afterwards.") }
        return L("The project container is not ready yet — the outline only works afterwards.")
    }

    // ── Upload, upload afterwards, setup ────────────────────────────────────

    /// Per source of this app: target, progress, state; "Cancel" while one runs, "Dismiss" afterwards.
    private func uploadField(_ list: [ProjectUploads.SourceRun]) -> some View {
        let running = list.contains { $0.state == .running || $0.state == .waiting }
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(list) { l in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(l.target.isEmpty ? "/" : l.target).cbFont(14, weight: .medium).foregroundStyle(CbColor.text).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(uploadState(l)).cbFont(12.5).foregroundStyle(uploadColor(l))
                    }
                    if l.progress.bytesTotal > 0 {
                        ProgressView(value: Double(l.progress.bytes), total: Double(max(l.progress.bytesTotal, 1)))
                    }
                    Text(L("{done} / {total} files · {sent} / {size}", [
                        "done": l.progress.files, "total": l.progress.filesTotal,
                        "sent": sizeText(l.progress.bytes), "size": sizeText(l.progress.bytesTotal),
                    ]))
                    .cbFont(12)
                    .monospacedDigit()
                    .foregroundStyle(CbColor.textMuted)
                    if case .error(let text) = l.state {
                        Text(text).cbFont(12.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if running {
                Text(L("Please keep the app in the foreground until the upload is done."))
                    .cbFont(12)
                    .foregroundStyle(CbColor.textMuted)
            }
            Button(running ? L("Cancel") : L("Dismiss##hide"), action: running ? abortUpload : hideUpload)
                .cbFont(14, weight: .medium)
                .accessibilityIdentifier("project-upload-\(running ? "abort" : "hide")")
        }
    }

    private func uploadState(_ l: ProjectUploads.SourceRun) -> String {
        switch l.state {
        case .waiting: return L("waiting")
        case .running: return L("uploading")
        case .finished: return L("done")
        case .aborted: return L("cancelled")
        case .error: return L("Error")
        }
    }

    private func uploadColor(_ l: ProjectUploads.SourceRun) -> Color {
        switch l.state {
        case .running: return .accentColor
        case .finished: return .green
        case .error, .aborted: return .red
        case .waiting: return CbColor.textSecondary
        }
    }

    /// Upload afterwards: the three ways, below them this app's runs and the open operations on the server.
    private var uploadField: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                ForEach([("files", L("Files")), ("folder", L("Folder")), ("zip", L("ZIP"))], id: \.0) { kind, title in
                    Button(title) { startUpload(kind) }
                        .cbFont(13.5, weight: .medium)
                        .foregroundStyle(uploadPossible ? Color.accentColor : Color.secondary)
                        .buttonStyle(.plain)
                        .disabled(!uploadPossible)
                        .accessibilityIdentifier("project-upload-\(kind)")
                }
            }
            if !uploadPossible {
                Text(project.setup != nil ? L("The project is still being set up — uploading into it only works afterwards.")
                     : layout.uploadLocked ? L("An outline is pending — uploading into the project only works afterwards.")
                     : L("The project container is not ready right now — uploading into it only works afterwards."))
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(retroactiveRuns) { l in afterRunRow(l) }
            ForEach(retroactive.rows, id: \.operation) { z in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(z.color).frame(width: 7, height: 7)
                        Text(z.text).cbFont(14).foregroundStyle(CbColor.text).fixedSize(horizontal: false, vertical: true)
                    }
                    if !z.examples.isEmpty {
                        Text(z.examples.joined(separator: "\n"))
                            .cbFont(12.5, design: .monospaced)
                            .foregroundStyle(CbColor.textSecondary)
                            .padding(.leading, 15)
                    }
                    HStack(spacing: 14) {
                        ForEach(z.actions, id: \.self) { a in
                            Button(a.title) { afterAction(a) }
                                .cbFont(13.5, weight: .medium)
                                .foregroundStyle(a == .dismiss(a.operation) ? Color.red : Color.accentColor)
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("project-upload-\(a.kind)")
                        }
                    }
                    .padding(.leading, 15)
                }
            }
        }
    }

    /// An upload of this app: title, progress, "Cancel" (stops; the server's row then offers Resume · Discard) while it runs, after
    /// an error the message and "Dismiss".
    private func afterRunRow(_ l: ProjectRetroactive.Run) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(l.title).cbFont(14, weight: .medium).foregroundStyle(CbColor.text).lineLimit(1)
                Spacer(minLength: 8)
                switch l.state {
                case .running: Text(L("uploading")).cbFont(12.5).foregroundStyle(Color.accentColor)
                case .error: Text(L("Error")).cbFont(12.5).foregroundStyle(.red)
                }
            }
            if l.progress.bytesTotal > 0 {
                ProgressView(value: Double(l.progress.bytes), total: Double(max(l.progress.bytesTotal, 1)))
                Text(L("{done} / {total} files · {sent} / {size}", [
                    "done": l.progress.files, "total": l.progress.filesTotal,
                    "sent": sizeText(l.progress.bytes), "size": sizeText(l.progress.bytesTotal),
                ]))
                .cbFont(12)
                .monospacedDigit()
                .foregroundStyle(CbColor.textMuted)
            }
            if case .error(let text) = l.state {
                Text(text).cbFont(12.5).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            if l.state == .running {
                Text(L("Please keep the app in the foreground until the upload is done."))
                    .cbFont(12)
                    .foregroundStyle(CbColor.textMuted)
            }
            Button(l.state == .running ? L("Cancel") : L("Dismiss##hide")) {
                if l.state == .running { abortRetroactiveRun(l.id) } else { hideRetroactiveRun(l.id) }
            }
            .cbFont(14, weight: .medium)
            .accessibilityIdentifier("project-retroactive-\(l.state == .running ? "abort" : "hide")")
        }
    }

    /// The setup rows, per row its actions as buttons below.
    private var setupField: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(setup.rows.enumerated()), id: \.offset) { _, z in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(z.color).frame(width: 7, height: 7)
                        Text(z.text).cbFont(14).foregroundStyle(CbColor.text).fixedSize(horizontal: false, vertical: true)
                    }
                    // A clone: address and branch below the row (the row itself names only the target).
                    if let seq = z.seq, let q = project.setup?.sources.first(where: { $0.seq == seq }), q.kind == "clone", let url = q.url {
                        Text(q.branch.map { "\(url) (\($0))" } ?? url)
                            .cbFont(12.5, design: .monospaced)
                            .foregroundStyle(CbColor.textSecondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .padding(.leading, 15)
                    }
                    if !z.actions.isEmpty {
                        HStack(spacing: 14) {
                            ForEach(z.actions, id: \.self) { a in
                                // "Delete" is locked like "Remove" (upload running, server step running).
                                let locked = a == .erase && removeLocked
                                Button(a.title) { action(a) }
                                    .cbFont(13.5, weight: .medium)
                                    .foregroundStyle(locked ? Color.secondary : a == .erase || a == .leaveOut(a.seq ?? 0) ? Color.red : Color.accentColor)
                                    .buttonStyle(.plain)
                                    .disabled(locked)
                                    .accessibilityIdentifier("project-setup-\(a.identifier)")
                            }
                        }
                        .padding(.leading, 15)
                    }
                }
            }
        }
    }
}
