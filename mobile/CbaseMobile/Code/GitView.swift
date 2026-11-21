import SwiftUI

// The big git overview: Coding → Projects → Project → Git. Large here; the small "Branches" section in the git sheet is gone.
//
// Structure and poll like the instances page (Code/ProjectInstances.swift): a page that is created on the first switch and then
// stays; its poll (5 s) runs only while it is in front AND the app is active (`scenePhase`); on `project/instance`/`project/copy`
// (AppState `instanceEvents`) it is fresh at once (`fresh=1`). An auto-fetch (`auto: true`) in main and in every read (= ready)
// copy — ONCE per (repo, instance) per mount of the page, afterwards a fresh read happens only if a fetch really ran (not
// `skipped`). The server throttles per (repo, instance) to 5 min and never wakes an instance. The detail of a branch is PUSHED in
// the sheet of the projects list (`navigationDestination(item:)` in the sheet's NavigationStack), embedded as category "Project"
// in place of the bar with ‹ back.
//
// Head: repo `Menu` (only with > 1 repo), window `7 d · 30 d · All` (`CbSegments`, default 30 d), `CbSearch` (debounced to the
// server as `search` — the search runs there BEFORE the cap), a switch per group, per instance "Remote state N min ago" with ⟳
// (`auto: false`). Below the hints (`capped`, unread instances with a reason) and the timeline (Code/GitTimeline.swift).
//
// Read-only throughout: the git actions stay in GitPane. The jumps: subagent and workflow agent into their chat onto the agent
// (`AppState.openChat(_:agent:)`), graph into the child chat, copy into the "Instances" tab, a running chat into the chat. In the
// sheet, chat jumps go through `jump` (InstanceJump) — the projects page closes the sheet first.
//
// Identifiers for the test bench: `gitView` (the page), `git-group-<group>` (head of a group), `git-row-<name>` (name of a row; a
// copy row `git-row-<name>@<copy>`), `git-view-detail` (the detail).

// ── Words (shared with the small view) ──────────────────────────────────────

enum GitViewText {
    /// "↑3 ↓12" — ↓ only if something is missing.
    static func counts(_ z: GitViewCounts) -> String {
        z.back > 0 ? "↑\(z.ahead) ↓\(z.back)" : "↑\(z.ahead)"
    }

    /// To the main branch: "↑3 ↓12" or "merged"; `nil` without a main branch.
    static func toMain(_ z: GitViewRow) -> String? {
        guard let h = z.toMain else { return nil }
        if h.merged == true && h.ahead == 0 { return L("merged") }
        return counts(h)
    }

    /// To the remote: "↑0 origin", "local only" without an upstream; `nil` for a remote row (it IS the remote) and a detached HEAD.
    static func toRemote(_ z: GitViewRow) -> String? {
        guard z.local, z.detached == nil else { return nil }
        guard let r = z.toRemote else { return L("local only") }
        let remote = z.remote.flatMap { $0.split(separator: "/").first.map(String.init) } ?? "origin"
        return "\(counts(r)) \(remote)"
    }

    /// The age of the last commit, short: "now", "10 min", "2 h", "3 d".
    static func age(_ t: Double?, now: Date) -> String? {
        guard let t, t > 0 else { return nil }
        let s = max(0, now.timeIntervalSince1970 - t / 1000)
        if s < 60 { return L("now") }
        if s < 3600 { return L("{n} min", ["n": Int(s / 60)]) }
        if s < 86_400 { return L("{n} h", ["n": Int(s / 3600)]) }
        return L("{n} d", ["n": Int(s / 86_400)])
    }

    /// "3 min ago" — for the remote state.
    static func before(_ t: Double, now: Date) -> String {
        let s = max(0, now.timeIntervalSince1970 - t / 1000)
        if s < 60 { return L("just now") }
        if s < 3600 { return L("{n} min ago", ["n": Int(s / 60)]) }
        if s < 86_400 { return L("{n} h ago", ["n": Int(s / 3600)]) }
        return L("{n} d ago", ["n": Int(s / 86_400)])
    }

    static func remoteState(_ r: GitViewRemoteStatus?, now: Date) -> String {
        guard let at = r?.at else { return L("Remote state unknown") }
        return L("Remote state {when}", ["when": before(at, now: now)])
    }

    static func notBackedUp(_ n: Int) -> String { L("{n} unsaved", ["n": n]) }

    static func chats(_ n: Int) -> String { n == 1 ? L("1 chat running") : L("{n} chats running", ["n": n]) }

    static func group(_ g: String) -> String {
        switch g {
        case "checkedOut": return L("Checked out")
        case "branches": return L("Branches")
        case "cbase": return L("From cbase")
        case "remote": return L("Remote only")
        default: return g
        }
    }

    /// "Main" or "Copy k1" — the NAME of the instance (not the identifier `copy-k1`).
    static func instance(_ name: String) -> String {
        name == GitViewContract.main ? L("Main") : L("Copy {name}", ["name": name])
    }

    static func reason(_ g: String?) -> String {
        switch g {
        case "stopped": return L("stopped")
        case "starts": return L("starting")
        case "frozen": return L("frozen")
        case "error": return L("read error")
        case "time": return L("timed out")
        default: return L("not ready")
        }
    }

    static func user(_ b: GitViewUser) -> String {
        switch b.kind {
        case "subagent": return L("Subagent “{name}”", ["name": b.name])
        case "workflow-agent": return L("Workflow agent “{name}”", ["name": b.name])
        case "graph": return L("Graph run “{name}”", ["name": b.name])
        case "copy": return instance(b.instance ?? b.name)
        default: return b.name
        }
    }

    static func state(_ z: String?) -> String? {
        switch z {
        case "running": return L("running")
        case "ended": return L("terminated")
        case "copy-removed": return L("Copy removed")
        case "unknown": return L("Origin unknown")
        default: return nil
        }
    }

    /// "22.10." — day and month in the app's language.
    @MainActor
    static func date(_ t: Double) -> String {
        let locale = Loc.locale
        if dateFormat?.locale != locale {
            let f = DateFormatter()
            f.locale = locale
            f.setLocalizedDateFormatFromTemplate("ddMM")
            dateFormat = f
        }
        return dateFormat?.string(from: Date(timeIntervalSince1970: t / 1000)) ?? ""
    }

    /// Built once per language (a formatter per tick and row would be expensive).
    @MainActor private static var dateFormat: DateFormatter?

    /// The second line in the name column of the timeline: to the main branch, since creation (copy), age, state or running chats.
    static func shortLine(_ z: GitViewRow, now: Date) -> String {
        var parts: [String] = []
        if z.isCopy {
            if let s = z.sinceCreation { parts.append(L("{counts} since creation", ["counts": counts(s)])) } else { parts.append(L("new in {copy}", ["copy": instance(z.instance)])) }
        } else if let h = toMain(z) {
            parts.append(h)
        }
        if let a = age(z.last?.t, now: now) { parts.append(a) }
        let chats = z.runningChats.count
        if chats > 0 { parts.append(Self.chats(chats)) } else if let w = state(z.state) { parts.append(w) }
        return parts.joined(separator: " · ")
    }

    /// The identifier of a row for the test bench: `git-row-<name>`, a copy row with `@<copy>`.
    static func rowIdentifier(_ z: GitViewRow) -> String {
        z.isCopy ? "git-row-\(z.name)@\(z.instance)" : "git-row-\(z.name)"
    }
}

// ── Jumps ───────────────────────────────────────────────────────────────────

/// Where a user or a running chat leads.
enum GitViewJump: Equatable {
    case chat(String)
    case agent(chatId: String, agentId: String)
    /// The "Instances" tab with this copy (name, e.g. "k1").
    case copy(String)

    /// The jump of a user — `nil` if the details are missing (then it stands without ›).
    static func from(_ b: GitViewUser) -> GitViewJump? {
        switch b.kind {
        case "subagent", "workflow-agent":
            guard let c = b.chatId, !c.isEmpty else { return nil }
            if let a = b.agentId, !a.isEmpty { return .agent(chatId: c, agentId: a) }
            return .chat(c)
        case "graph":
            if let k = b.childChatId, !k.isEmpty { return .chat(k) }
            if let c = b.chatId, !c.isEmpty { return .chat(c) }
            return nil
        case "copy":
            guard let i = b.instance ?? (b.name.isEmpty ? nil : b.name) else { return nil }
            return .copy(i)
        default:
            return nil
        }
    }
}

extension AppState {
    /// Execute a jump of the git overview. A copy needs the project (`instancesShow` takes the identifier "copy-<name>").
    func gitViewJump(_ jump: GitViewJump, projectId: String?) {
        switch jump {
        case .chat(let id): openChat(id)
        case .agent(let chatId, let agentId): openChat(chatId, agent: agentId)
        case .copy(let name):
            guard let projectId else { return }
            instancesShow(projectId: projectId, instance: "copy-\(name)")
        }
    }
}

// ── The page model ──────────────────────────────────────────────────────────

/// An open row (the detail): instance and name.
struct GitViewOpen: Hashable, Identifiable {
    var id: String { "\(instance)\u{1F}\(name)" }
    let instance: String
    let name: String
}

@MainActor
final class GitViewModel: ObservableObject {
    let client: APIClient
    let projectId: String
    /// The last answer read — it stays when a later one fails.
    @Published private(set) var response: GitViewResponse?
    @Published private(set) var error: String?
    /// The chosen repo (`rel`); `nil` = the one the server picks.
    @Published var repo: String? {
        didSet { if repo != oldValue { opened = nil } }
    }
    @Published var window = GitViewContract.windowDefault
    /// The search as it goes to the server (debounced from the page's field).
    @Published private(set) var search = ""
    /// Groups whose switch is off.
    @Published var hidden: Set<String> = []
    @Published var endedOpen = false
    @Published var opened: GitViewOpen?
    /// Instances in which a fetch is running right now.
    @Published private(set) var fetching: Set<String> = []
    /// The sentence for a failed fetch by button.
    @Published var notice: String?
    /// Only the most recently started read counts — an older one (other repo, other search) does not overwrite a newer one.
    private var reading = 0
    /// ONE auto-fetch per (repo, instance) per mount of the page (the model lives as long as the page).
    private var autoFetched: Set<String> = []

    init(client: APIClient, projectId: String) {
        self.client = client
        self.projectId = projectId
    }

    /// The repo in question — the choice, otherwise the server's.
    var currentRepo: String { repo ?? response?.repo?.rel ?? "" }

    func load(fresh: Bool = false) async {
        var query: [URLQueryItem] = []
        if let repo { query.append(URLQueryItem(name: "repo", value: repo)) }
        if !search.isEmpty { query.append(URLQueryItem(name: "search", value: search)) }
        if fresh { query.append(URLQueryItem(name: "fresh", value: "1")) }
        reading += 1
        let my = reading
        do {
            let a: GitViewResponse = try await client.get("/api/projects/\(projectId)/gitView", query: query)
            guard my == reading else { return }
            response = a
            error = nil
        } catch is CancellationError {
            return
        } catch {
            guard my == reading else { return }
            self.error = error.localizedDescription
        }
    }

    func searchSet(_ text: String) async {
        let fresh = text.trimmingCharacters(in: .whitespaces)
        guard fresh != search else { return }
        search = fresh
        await load()
    }

    /// On opening and on every repo change: read, then the new auto-fetches (`autoFetchNew`).
    func autoFetch() async {
        await load()
        await autoFetchNew()
    }

    /// In main and in every read (= ready) copy fetch with `auto: true` — ONCE per (repo, instance) per mount; a fresh read happens
    /// only if a fetch really ran. The server throttles (5 min per repo and instance) and then answers `skipped` — an error
    /// here stays silent, it belongs to the button. Also called after every poll: a copy that becomes ready later fetches once.
    func autoFetchNew() async {
        let repo = currentRepo
        let fresh = (response?.instances ?? []).filter { $0.read == true && !autoFetched.contains(Self.autoKey(repo, $0.name)) }
        guard !fresh.isEmpty else { return }
        for i in fresh { autoFetched.insert(Self.autoKey(repo, i.name)) }
        let ran = await withTaskGroup(of: Bool.self) { group -> Bool in
            for i in fresh {
                group.addTask { await self.fetchWithoutRead(i.name, repo: repo, auto: true) }
            }
            var any = false
            for await l in group where l { any = true }
            return any
        }
        guard !Task.isCancelled, ran else { return }
        await load(fresh: true)
    }

    private static func autoKey(_ repo: String, _ instance: String) -> String { "\(repo)\u{1F}\(instance)" }

    /// The ⟳ button on an instance: fetch without throttle (`auto: false`), then read fresh — only if the fetch ran.
    func fetch(_ instance: String) async {
        if await fetchWithoutRead(instance, repo: currentRepo, auto: false) {
            await load(fresh: true)
        }
    }

    /// `true` = the fetch ran (not `skipped`, no error) — only then is a fresh read worth anything.
    private func fetchWithoutRead(_ instance: String, repo: String, auto: Bool) async -> Bool {
        struct Body: Encodable { let repo: String; let instance: String; let auto: Bool }
        fetching.insert(instance)
        defer { fetching.remove(instance) }
        do {
            let a: GitViewFetchResponse = try await client.post("/api/projects/\(projectId)/gitView/fetch",
                                                                  body: Body(repo: repo, instance: instance, auto: auto))
            if !auto { notice = nil }
            return !a.skipped
        } catch is CancellationError {
            return false
        } catch {
            if !auto { notice = error.localizedDescription }
            return false
        }
    }
}

// ── The page ────────────────────────────────────────────────────────────────

/// In the project sheet's stack: the detail as a pushed page; without a stack nothing (there the detail replaces the bar — a
/// `navigationDestination` outside a NavigationStack would be silently skipped).
private struct GitStackTarget<Target: View>: ViewModifier {
    let active: Bool
    @Binding var open: GitViewOpen?
    let target: (GitViewOpen) -> Target

    func body(content: Content) -> some View {
        if active {
            content.navigationDestination(item: $open) { o in target(o) }
        } else {
            content
        }
    }
}

struct ProjectGitPage: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.scenePhase) private var scenePhase
    let client: APIClient
    let project: Project
    /// The page is in front — only then do poll and auto-fetch run.
    let visible: Bool
    /// In the project sheet's NavigationStack: the detail is pushed. Without (embedded) it replaces the bar.
    let stack: Bool
    /// A chat jump from the sheet — the projects page closes it first (`InstanceJump`).
    let jump: (InstanceJump) -> Void

    @StateObject private var model: GitViewModel
    @State private var searchField = ""

    init(client: APIClient, project: Project, visible: Bool, stack: Bool, jump: @escaping (InstanceJump) -> Void) {
        self.client = client
        self.project = project
        self.visible = visible
        self.stack = stack
        self.jump = jump
        _model = StateObject(wrappedValue: GitViewModel(client: client, projectId: project.id))
    }

    var body: some View {
        frame
            // As a container of its own: an identifier on a stack would override that of every child.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("gitView")
            // The poll: every 5 s while the page is in front and the app is active (in the background it pauses — the first read is
            // done by the auto-fetch below, the return reads at once).
            .task(id: "\(visible)|\(scenePhase == .active)") {
                guard visible, scenePhase == .active else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    if Task.isCancelled { break }
                    await model.load()
                    await model.autoFetchNew()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if visible && phase == .active { Task { await model.load() } }
            }
            // On opening and on every repo change: read and — per (repo, instance) once per mount — fetch.
            .task(id: "\(visible)|\(model.repo ?? "")") {
                guard visible else { return }
                await model.autoFetch()
            }
            // The search debounced (350 ms) to the server.
            .task(id: searchField) {
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { return }
                await model.searchSet(searchField)
            }
            .onChange(of: state.instanceEvents[project.id] ?? 0) {
                if visible { Task { await model.load(fresh: true) } }
            }
            // A jump from outside: picked up only when the page is IN FRONT (like the instances).
            .onChange(of: state.projectWish?.id, initial: true) { _, _ in pickUpWish() }
            .onChange(of: visible) { _, _ in pickUpWish() }
            .modifier(GitStackTarget(active: stack, open: $model.opened) { o in detail(o, pushed: true) })
    }

    private func pickUpWish() {
        guard visible, let w = state.projectWish, w.page == .git, w.projectId == project.id else { return }
        state.projectWish = nil
        guard !w.expired else { return }
        if let r = w.repo { model.repo = r }
    }

    @ViewBuilder
    private var frame: some View {
        if !stack, let o = model.opened {
            detail(o, pushed: false)
        } else if let a = model.response {
            content(a)
        } else if let f = model.error {
            CbEmpty(symbol: "exclamationmark.triangle", text: f, identifier: "git-view-error", button: L("Reload")) {
                Task { await model.load(fresh: true) }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            CbLoading(label: L("Loading…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func detail(_ o: GitViewOpen, pushed: Bool) -> some View {
        GitViewDetailPage(model: model, open: o, pushed: pushed, jump: jump)
    }

    /// A jump: copy in the same project (the projects page sets the segment), chat and agent through the sheet.
    private func jump(_ s: GitViewJump) {
        switch s {
        case .copy: state.gitViewJump(s, projectId: project.id)
        case .chat(let id): jump(.chatOpen(id: id))
        case .agent(let chatId, let agentId): jump(.agentOpen(chatId: chatId, agentId: agentId))
        }
    }

    // ── Content ──────────────────────────────────────────────────────────────

    private func content(_ a: GitViewResponse) -> some View {
        let now = Date()
        let axis = GitTimeAxis.compute(window: model.window, response: a, now: now.timeIntervalSince1970 * 1000)
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                header(a, now: now)
                    .padding(.horizontal, 16)
                hints(a)
                    .padding(.horizontal, 16)
                // If no instance is read, the server's empty list means "not read" (the reasons are in the hints above).
                if let rows = a.readRows {
                    if rows.isEmpty {
                        CbEmpty(symbol: "arrow.triangle.branch",
                                text: model.search.isEmpty ? L("No branches in this repository.") : L("No branch matches the search."),
                                identifier: "git-view-empty")
                    } else {
                        GitTimeline(response: a, axis: axis, hidden: model.hidden, endedOpen: $model.endedOpen) { z in
                            model.opened = GitViewOpen(instance: z.instance, name: z.name)
                        }
                        .id(model.window)
                    }
                } else {
                    CbEmpty(symbol: "questionmark.circle", text: L("The branches have not been read."), identifier: "git-view-unread")
                }
            }
            .padding(.top, 6)
            .padding(.bottom, 28)
        }
        .cbRefreshable { await model.load(fresh: true) }
    }

    @ViewBuilder
    private func header(_ a: GitViewResponse, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if let repos = a.repos, repos.count > 1 {
                    Menu {
                        ForEach(repos) { r in
                            Button {
                                model.repo = r.rel
                            } label: {
                                if r.rel == model.currentRepo { Label(Self.repoName(r), systemImage: "checkmark") } else { Text(Self.repoName(r)) }
                            }
                        }
                    } label: {
                        CbMenuLabel(title: a.repo.map(Self.repoName) ?? L("Repository"), systemImage: "shippingbox")
                    }
                    .accessibilityIdentifier("git-view-repo")
                }
                Spacer(minLength: 0)
                CbSegments(
                    options: [
                        CbSegment(value: "7d", label: L("7 d"), id: "git-view-window-7d"),
                        CbSegment(value: "30d", label: L("30 d"), id: "git-view-window-30d"),
                        CbSegment(value: "everything", label: L("All##everything"), id: "git-view-window-everything"),
                    ],
                    selection: $model.window,
                    fills: false
                )
                .fixedSize()
            }
            CbSearch(placeholder: L("Search branches"), text: $searchField, identifier: "git-view-search")
            groupsToggle(a.readRows)
            remoteStatuses(a, now: now)
        }
    }

    /// A switch per group, with its count — off hides the group. Without read rows (`nil`) no count: never 0 for "not read".
    private func groupsToggle(_ rows: [GitViewRow]?) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(GitViewContract.groups, id: \.self) { g in
                    let on = !model.hidden.contains(g)
                    Button {
                        if on { model.hidden.insert(g) } else { model.hidden.remove(g) }
                    } label: {
                        HStack(spacing: 5) {
                            Text(GitViewText.group(g))
                            if let rows {
                                Text(verbatim: "\(rows.filter { $0.group == g }.count)")
                                    .monospacedDigit()
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .cbFont(12.5, weight: .medium)
                        .foregroundStyle(on ? CbColor.text : CbColor.textMuted)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .background(on ? CbColor.elevated : Color.clear, in: Capsule())
                        .overlay(Capsule().strokeBorder(on ? Color.clear : CbColor.edge))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("git-view-toggle-\(g)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    /// Per read instance: "Main · Remote state 3 min ago ⟳".
    @ViewBuilder
    private func remoteStatuses(_ a: GitViewResponse, now: Date) -> some View {
        let read = (a.instances ?? []).filter { $0.read == true }
        if !read.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(read) { i in
                    HStack(spacing: 6) {
                        if let f = GitKeyColor.color(i.color), !i.isMain {
                            Circle().fill(f).frame(width: 7, height: 7)
                        }
                        Text(verbatim: GitViewText.instance(i.name) + " · " + GitViewText.remoteState(i.remoteState, now: now))
                            .cbFont(12)
                            .foregroundStyle(CbColor.textMuted)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if model.fetching.contains(i.name) {
                            ProgressView().controlSize(.mini)
                        } else {
                            Button {
                                Task { await model.fetch(i.name) }
                            } label: {
                                Image(systemName: "arrow.clockwise")
                                    .font(.symbol(12, weight: .semibold))
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 30, height: 26)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("Fetch remote state: {instance}", ["instance": GitViewText.instance(i.name)]))
                            .accessibilityIdentifier("git-view-fetch-\(i.name)")
                        }
                    }
                }
                if let m = model.notice {
                    Text(m)
                        .cbFont(12)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// The cap and every unread instance with its reason — empty is not unknown.
    @ViewBuilder
    private func hints(_ a: GitViewResponse) -> some View {
        let unread = (a.instances ?? []).filter { $0.read == false }
        if a.clipped != nil || !unread.isEmpty || model.error != nil {
            VStack(alignment: .leading, spacing: 6) {
                if let g = a.clipped {
                    Label(L("{shown} of {total} — search narrows it down",
                            ["shown": locFormattedInt(g.shown), "total": locFormattedInt(g.total)]),
                          systemImage: "line.3.horizontal.decrease")
                        .accessibilityIdentifier("git-view-clipped")
                }
                ForEach(unread) { i in
                    Label(L("{instance} not read — {reason}", ["instance": GitViewText.instance(i.name), "reason": GitViewText.reason(i.reason)]),
                          systemImage: "exclamationmark.triangle")
                        .accessibilityIdentifier("git-view-unread-\(i.name)")
                }
                // A later read failed: the state above is the last one read.
                if let f = model.error {
                    Label(L("Not updated: {reason}", ["reason": f]), systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .cbFont(12.5)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func repoName(_ r: GitViewRepo) -> String {
        r.name.isEmpty ? (r.rel.isEmpty ? "/" : r.rel) : r.name
    }
}

// ── The detail of a branch ──────────────────────────────────────────────────

@MainActor
final class GitViewDetailModel: ObservableObject {
    @Published private(set) var detail: GitViewDetail?
    @Published private(set) var error: String?
    @Published var diff: GitModel.GitDiffPreview?
    /// The file whose diff is being fetched.
    @Published private(set) var diffLoading: String?

    func load(_ model: GitViewModel, _ o: GitViewOpen) async {
        let query = [URLQueryItem(name: "repo", value: model.currentRepo), URLQueryItem(name: "instance", value: o.instance),
                     URLQueryItem(name: "name", value: o.name)]
        do {
            detail = try await model.client.get("/api/projects/\(model.projectId)/gitView/branch", query: query)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The diff of a file against the main branch (`<main>...<branch>`): as `{diff}` or as text.
    func diffShow(_ model: GitViewModel, _ o: GitViewOpen, file: String) async {
        let query = [URLQueryItem(name: "repo", value: model.currentRepo), URLQueryItem(name: "instance", value: o.instance),
                     URLQueryItem(name: "name", value: o.name), URLQueryItem(name: "file", value: file)]
        diffLoading = file
        defer { diffLoading = nil }
        do {
            let data = try await model.client.data("/api/projects/\(model.projectId)/gitView/diff", query: query)
            let text: String
            var truncated = false
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let d = obj["diff"] as? String {
                text = d
                // The server caps the diff (`clipped: true`) — the sheet says so.
                truncated = obj["clipped"] as? Bool == true
            } else {
                text = String(data: data, encoding: .utf8) ?? ""
            }
            diff = GitModel.GitDiffPreview(path: file, staged: false, text: text.isEmpty ? L("No difference.") : text, truncated: truncated)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct GitViewDetailPage: View {
    @ObservedObject var model: GitViewModel
    let open: GitViewOpen
    let pushed: Bool
    let jump: (GitViewJump) -> Void
    @StateObject private var d = GitViewDetailModel()

    /// The row: from the detail, otherwise from the timeline (there at once, before the detail arrives).
    private var row: GitViewRow? {
        d.detail?.row ?? model.response?.rows?.first { $0.instance == open.instance && $0.name == open.name }
    }

    var body: some View {
        frame
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("git-view-detail")
            .task(id: open) { await d.load(model, open) }
            .sheet(item: $d.diff) { preview in GitDiffSheet(preview: preview).cbSheet(.whole) }
    }

    @ViewBuilder
    private var frame: some View {
        if pushed {
            list
                .navigationTitle(row?.shownName ?? open.name)
                .navigationBarTitleDisplayMode(.inline)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Button { model.opened = nil } label: {
                        Image(systemName: "chevron.left")
                            .font(.symbol(17, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Git"))
                    .accessibilityIdentifier("git-view-back")
                    Text(verbatim: row?.shownName ?? open.name)
                        .cbFont(17, weight: .semibold)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                list
            }
        }
    }

    private var mainName: String { model.response?.mainBranch?.name ?? L("Main branch") }

    private var list: some View {
        CbList {
            if let f = d.error {
                Section { Text(f).foregroundStyle(.orange).cbFont(13) }
            }
            if let z = row {
                statusSection(z)
            }
            commitsSection
            filesSection
            mrSection
            originSection(row)
        }
        .cbRefreshable { await d.load(model, open) }
    }

    // ── State ────────────────────────────────────────────────────────────────

    private func statusSection(_ z: GitViewRow) -> some View {
        let now = Date()
        return Section(L("State")) {
            if z.isCopy || open.instance != GitViewContract.main {
                HStack(spacing: 6) {
                    if let f = GitKeyColor.color(model.response?.instance(z.instance)?.color) {
                        Circle().fill(f).frame(width: 8, height: 8)
                    }
                    field(L("Instance"), GitViewText.instance(z.instance))
                }
            }
            if let h = z.toMain {
                field(L("To {main}", ["main": mainName]), h.merged == true && h.ahead == 0 ? L("merged") : GitViewText.counts(h))
            } else if model.response?.mainBranchSupplied == true && model.response?.mainBranch == nil {
                field(L("Main branch"), L("no main branch detected"))
            }
            if z.local, z.detached == nil {
                // With upstream: the numbers and its name ("↑1 · origin/x"), without: "local only".
                if let r = z.toRemote, let name = z.remote {
                    field(L("To remote"), "\(GitViewText.counts(r)) · \(name)")
                } else {
                    field(L("To remote"), GitViewText.toRemote(z) ?? L("local only"))
                }
            } else if !z.local, let r = z.remote {
                field(L("Remote"), r)
            }
            if let s = z.sinceCreation {
                field(L("Since creation"), GitViewText.counts(s))
            }
            if let t = z.branchPoint {
                field(L("Branched off"), GitViewText.date(t))
            }
            if let l = z.last, !l.subject.isEmpty || l.t != nil {
                VStack(alignment: .leading, spacing: 2) {
                    Text(l.subject.isEmpty ? L("Last commit") : l.subject)
                        .cbFont(14)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(2)
                    Text(verbatim: [l.author, GitViewText.age(l.t, now: now) ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .cbFont(12)
                        .foregroundStyle(CbColor.textMuted)
                }
            }
            if let n = z.commits?.notFetched, !n.isEmpty {
                field(L("Not fetched"), "\(n.count)")
            }
        }
    }

    private func field(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name)
                .cbFont(14)
                .foregroundStyle(CbColor.textSecondary)
            Spacer(minLength: 12)
            Text(verbatim: value)
                .cbFont(14, weight: .medium)
                .monospacedDigit()
                .foregroundStyle(CbColor.text)
                .multilineTextAlignment(.trailing)
        }
    }

    // ── Commits ahead ────────────────────────────────────────────────────

    @ViewBuilder
    private var commitsSection: some View {
        if let commits = d.detail?.commits {
            let total = d.detail?.clipped?.total ?? commits.count
            Section {
                if commits.isEmpty {
                    Text(L("No commits ahead.")).foregroundStyle(CbColor.textMuted).cbFont(13.5)
                }
                ForEach(commits) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.subject.isEmpty ? c.short : c.subject)
                            .cbFont(14)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(2)
                        Text(verbatim: [c.short, c.author, GitViewText.age(c.t, now: Date()) ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                            .cbFont(12, design: .monospaced)
                            .foregroundStyle(CbColor.textMuted)
                            .lineLimit(1)
                    }
                }
            } header: {
                Text(L("Commits ahead ({n})", ["n": total]))
            } footer: {
                if let g = d.detail?.clipped {
                    Text(L("The {shown} most recent of {total}.", ["shown": g.shown, "total": locFormattedInt(g.total)]))
                } else if d.detail?.clippedWithoutCount == true {
                    Text(L("Only the {n} most recent.", ["n": GitViewContract.detailCommitsMax]))
                }
            }
        } else if let reason = d.detail?.failedCommits {
            Section(L("Commits ahead")) {
                Text(L("Not readable: {reason}", ["reason": reason])).foregroundStyle(.orange).cbFont(13)
                    .accessibilityIdentifier("git-view-failed-commits")
            }
        } else if d.detail == nil && d.error == nil {
            Section { HStack { ProgressView().controlSize(.small); Text(L("Loading…")).foregroundStyle(CbColor.textMuted) } }
        }
    }

    // ── Files ────────────────────────────────────────────────────────────────

    @ViewBuilder
    private var filesSection: some View {
        if let files = d.detail?.files {
            let plus = files.compactMap(\.plus).reduce(0, +)
            let minus = files.compactMap(\.minus).reduce(0, +)
            Section {
                if files.isEmpty {
                    Text(L("No changed files.")).foregroundStyle(CbColor.textMuted).cbFont(13.5)
                }
                ForEach(files) { file in
                    Button {
                        Task { await d.diffShow(model, open, file: file.path) }
                    } label: {
                        HStack(spacing: 8) {
                            Text(verbatim: file.path)
                                .cbFont(12.5, design: .monospaced)
                                .foregroundStyle(CbColor.text)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 6)
                            if d.diffLoading == file.path {
                                ProgressView().controlSize(.mini)
                            } else if let p = file.plus, let m = file.minus {
                                Text(verbatim: "+\(p) −\(m)")
                                    .cbFont(12, design: .monospaced)
                                    .foregroundStyle(CbColor.textMuted)
                            } else {
                                Text(L("binary")).cbFont(12).foregroundStyle(CbColor.textMuted)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("git-view-file-\(file.path)")
                }
            } header: {
                Text(verbatim: L("Files") + " (+\(plus) −\(minus))")
            } footer: {
                // The files list's cap says that it is one (the sum above counts only the ones shown).
                if let g = d.detail?.clippedFiles {
                    Text(L("{shown} of {total} files.", ["shown": locFormattedInt(g.shown), "total": locFormattedInt(g.total)]))
                        .accessibilityIdentifier("git-view-files-clipped")
                }
            }
        } else if let reason = d.detail?.failedFiles {
            Section(L("Files")) {
                Text(L("Not readable: {reason}", ["reason": reason])).foregroundStyle(.orange).cbFont(13)
                    .accessibilityIdentifier("git-view-failed-files")
            }
        }
    }

    // ── MR ───────────────────────────────────────────────────────────────────

    /// No row at `no-gitlab`; "GitLab not connected" at `no-access`, "No open MR" at `none`,
    /// "GitLab unreachable" at `error`.
    @ViewBuilder
    private var mrSection: some View {
        if let mr = d.detail?.mr, mr.state != "no-gitlab" {
            Section(L("Merge request")) {
                switch mr.state {
                case "no-access":
                    Text(L("GitLab not connected")).foregroundStyle(CbColor.textMuted).cbFont(14)
                case "none":
                    Text(L("No open MR")).foregroundStyle(CbColor.textMuted).cbFont(14)
                case "error":
                    // The providing service could not be read — neither "no access" nor "none" (MR_STATES).
                    Text(L("GitLab unreachable")).foregroundStyle(CbColor.textMuted).cbFont(14)
                default:
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: (mr.iid.map { "!\($0) " } ?? "") + mr.title)
                            .cbFont(14, weight: .medium)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(2)
                        Text(verbatim: [mr.target.isEmpty ? nil : "→ " + mr.target, mr.pipeline.map { L("Pipeline: {state}", ["state": Self.pipeline($0)]) }]
                            .compactMap { $0 }.joined(separator: " · "))
                            .cbFont(12)
                            .foregroundStyle(CbColor.textMuted)
                    }
                    if let s = mr.url, let url = URL(string: s) {
                        Link(destination: url) {
                            Label(L("Open in GitLab"), systemImage: "arrow.up.right.square")
                                .cbFont(14)
                        }
                    }
                }
            }
        }
    }

    static func pipeline(_ s: String) -> String {
        switch s {
        case "success": return "✓"
        case "failed": return "✗"
        case "running", "pending", "created": return L("running")
        default: return s
        }
    }

    // ── Origin and users ─────────────────────────────────────────────────────

    @ViewBuilder
    private func originSection(_ z: GitViewRow?) -> some View {
        let h = d.detail?.origin
        if h != nil || z?.user != nil || !(z?.checkedOut.isEmpty ?? true) || z?.state != nil {
            Section(L("Origin")) {
                if let h {
                    if h.unknown {
                        Text(L("Origin unknown")).foregroundStyle(CbColor.textMuted).cbFont(14)
                    } else if let at = h.at {
                        Text(h.origin.map { L("created {date} from {from}", ["date": GitViewText.date(at), "from": $0]) }
                             ?? L("created {date}", ["date": GitViewText.date(at)]))
                            .cbFont(14)
                    } else if let origin = h.origin {
                        Text(L("created from {from}", ["from": origin])).cbFont(14)
                    } else if let t = h.text {
                        Text(verbatim: t).cbFont(14)
                    }
                }
                if let b = z?.user {
                    userRow(b, state: z?.state)
                } else if let w = GitViewText.state(z?.state) {
                    field(L("State"), w)
                }
                ForEach(Array((z?.checkedOut ?? []).enumerated()), id: \.offset) { _, a in
                    checkedOut(a)
                }
            }
        }
    }

    private func userRow(_ b: GitViewUser, state: String?) -> some View {
        let text = [GitViewText.user(b), GitViewText.state(state)].compactMap { $0 }.joined(separator: " · ")
        return Group {
            if let s = GitViewJump.from(b) {
                Button { jump(s) } label: {
                    HStack {
                        Text(verbatim: text).cbFont(14).foregroundStyle(CbColor.text)
                        Spacer(minLength: 6)
                        Image(systemName: "chevron.right")
                            .font(.symbol(12, weight: .semibold))
                            .foregroundStyle(CbColor.textMuted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("git-view-user")
            } else {
                Text(verbatim: text).cbFont(14).foregroundStyle(CbColor.text)
            }
        }
    }

    /// Where the branch is checked out — instance, worktree, unsaved — and the running chats there.
    @ViewBuilder
    private func checkedOut(_ a: GitViewCheckedOut) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: [L("Checked out in {instance}", ["instance": GitViewText.instance(a.instance)]),
                            a.notBackedUp.flatMap { $0 > 0 ? GitViewText.notBackedUp($0) : nil }]
                .compactMap { $0 }.joined(separator: " · "))
                .cbFont(14)
                .foregroundStyle(CbColor.text)
            if let w = a.worktree {
                Text(verbatim: w)
                    .cbFont(11.5, design: .monospaced)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        ForEach(a.chats ?? []) { c in
            Button { jump(.chat(c.chatId)) } label: {
                HStack {
                    Label(c.title.isEmpty ? L("Chat") : c.title, systemImage: "bubble.left")
                        .cbFont(14)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(L("running")).cbFont(12).foregroundStyle(Color.accentColor)
                    Image(systemName: "chevron.right")
                        .font(.symbol(12, weight: .semibold))
                        .foregroundStyle(CbColor.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("git-view-chat-\(c.chatId)")
        }
    }
}
