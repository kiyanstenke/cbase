import SwiftUI

// The "Instances" tab of the project view on iOS, following the HIG rather than the web template.
//
// LIST + PAGE:
//  – The list (`ProjectInstancesPage`): per instance ONE row with what you need without opening it: tile, name, situation (only if
//    not ready), below it branch (`*` = open changes, `+N` = more repos), containers "x/y" (orange if one is down) and the first
//    public link; computed in `InstancesTree.rowOf` (bound to the web). Long press opens the same menu as the page's ⋯
//    (`InstanceManualActions`). Below it "Create copy".
//  – Tapping opens the instance's page (`InstancePage`): PUSHED in the project list's sheet (the sheet's NavigationStack,
//    `navigationDestination(item:)` on `model.opened`), or embedded as the "Project" category (no stack, `PaneScaffold`) in place
//    of the list with a "‹ Instances" row. The page: situation, base, RAM · CPU, "created by"; start chat · code · terminal as three
//    buttons; the ⋯ with all actions (stop/start, branch, restart stack, fetch, "Copy from this instance"); below it real sections
//    containers (what is up first; the running ones in a collapsed group), services, repos, chats and for a copy "Delete copy". If
//    the instance disappears (deleted) the page closes itself.
//  – Locked actions are grey in the menu with their reason as a second line (`actionsOf`; the reason is a key).
//  – The server reads containers and repos for EVERY ready instance, kept up to 30 s (projectbox/instances-tree.js "SUMMARY"); the
//    opened one goes along as `?open=` and is fresh in every fetch. Every part carries its situation (`partSituation`): "loading",
//    an error, "none"; never an empty list for something that was not read.
//  – Services: start/stop in THIS instance (`?instance=`, main without), "Enter start command" in every instance whose service has
//    no command (leads to the project's services), and the preview link of EXACTLY this (instance, service), through the same
//    building blocks as in the pill (`PreviewShareButton`, `PreviewLinkRow`, Shell/PreviewLinks.swift), target `.instance(<name>)`,
//    never the forwarding instance.
//  – Sheets: create copy (Code/CopyCreate.swift), delete copy (Code/CopyDelete.swift; the same sheet opens "Clear away" in the pill),
//    switch branch (Code/BranchSwitch.swift, then "Restart stack"). Stop, start and stack restart ask first and name the instance's
//    chats (running first); the lock itself is held by the server (409 INSTANCE_WORKING). List and page each present sheet and
//    question THEMSELVES (`InstanceSheets`): a list covered by the page does not present reliably.
//  – Freshness: every 5 s while the list is visible (pushed it disappears, then the page asks itself), and at once after
//    `project/instance`, `project/copy` (AppState `instanceEvents`, with `fresh=1`) and `preview/link` (`previewTick`). After every
//    own action `fresh=1`.
//  – Opening (chat, code, terminal) goes through `InstanceJump` and the caller: in the project page's sheet only after it closes.
// What the tree shows is computed in Code/InstancesTree.swift (twin of web/src/lib/instances-tree.ts, bound).
//
// Identifiers: `instances-list`, `instances-create`, `instance-row-<name>` (row), `instance-page-<name>`, `instance-back`,
// `instance-menu-<name>`, `instance-chat-start-<name>`, `instance-code-<name>`, `instance-terminal-<name>`, `instance-repo-<name>-<rel>`,
// `instance-service-<name>-<id>`, `instance-chat-<id>`, `instance-delete-<name>`, `instances-notice`, `instances-error`.

/// Where a tab entry leads, executed by `AppState.instanceJump`.
enum InstanceJump: Equatable {
    /// Create and open a new coding chat with the project and this instance.
    case startChat(instance: String)
    case chatOpen(id: String)
    /// Open the chat and in it an agent (a subagent or workflow agent on a branch, from the git overview,
    /// `AppState.openChat(_:agent:)`).
    case agentOpen(chatId: String, agentId: String)
    /// The code or terminal tab with the instance choice set (identifier `<pid>/<instance>`).
    case code(identifier: String)
    case terminal(identifier: String)
}

/// 409 INSTANCE_WORKING (projectbox/idle.js instanceWorkingError): who is working in the instance, chats with title and reason,
/// plus work without a chat (terminal, service, agent). From the error body (`APIError.body`); any other error is none.
struct InstanceWork: Equatable {
    struct Chat: Equatable, Identifiable {
        let id: String
        let title: String
        let reason: String
    }
    let chats: [Chat]
    let otherwise: [String]

    static func from(_ error: Error) -> InstanceWork? {
        guard let e = error as? APIError, e.code == "INSTANCE_WORKING" else { return nil }
        let chats: [Chat] = (e.body?["chats"]?.arrayValue ?? []).compactMap { c in
            guard let o = c.objectValue, let id = o["id"]?.stringValue, !id.isEmpty else { return nil }
            return Chat(id: id, title: o["title"]?.stringValue ?? "", reason: o["reason"]?.stringValue ?? "")
        }
        let otherwise = (e.body?["open"]?.arrayValue ?? []).compactMap { $0.objectValue?["text"]?.stringValue }.filter { !$0.isEmpty }
        return InstanceWork(chats: chats, otherwise: otherwise)
    }

    /// The rows for a list: per chat its title, then the work without a chat.
    var rows: [String] {
        chats.map { $0.title.isEmpty ? $0.id : $0.title } + otherwise
    }
}

/// The "Instances" page: the tree, every 5 s while visible. An answer read once stays if a later one fails.
@MainActor
final class InstancesPageModel: ObservableObject {
    let projectId: String
    let client: APIClient
    @Published private(set) var tree: InstancesTree.Tree?
    /// The reason for the last failed fetch: without a tree instead of the list, with a tree as a row above it.
    @Published private(set) var error: String?
    /// The opened instance (its page is in front, pushed or in place of the list). It goes along as `?open=` and is thus freshly read
    /// in every fetch; the others come from the server's summary (≤ 30 s).
    @Published var opened: String?
    /// The sentence about the last action, visible until the next.
    @Published var notice: String?
    /// What is being worked on right now (`<action>:<instance>` or `service:<instance>:<id>`).
    @Published private(set) var working: Set<String> = []

    init(client: APIClient, projectId: String) {
        self.client = client
        self.projectId = projectId
    }

    /// `fresh`: the server reads ALL instances anew (`fresh=1`) instead of from its summary, after an event of this project and after
    /// every own action.
    func load(fresh: Bool = false) async {
        var query = InstancesTree.openParam(opened.map { [$0] } ?? [], tree).map { [URLQueryItem(name: "open", value: $0)] } ?? []
        if fresh { query.append(URLQueryItem(name: "fresh", value: "1")) }
        do {
            let data = try await client.data("/api/projects/\(projectId)/instances", query: query)
            if let b = InstancesTree.readTree(try? JSONSerialization.jsonObject(with: data)) {
                tree = b
                error = nil
            } else {
                error = L("The server's answer is not an instance tree.")
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func running(_ key: String) -> Bool { working.contains(key) }

    /// An action: POST (or `method`) to `path`, then reload fresh. A 409 INSTANCE_WORKING names the work; every other error its
    /// sentence. → the answer on success.
    @discardableResult
    func handle(_ key: String, _ path: String, query: [URLQueryItem] = [], method: HTTPMethod = .post,
                ok: String? = nil) async -> Data? {
        working.insert(key)
        defer { working.remove(key) }
        var response: Data?
        do {
            response = try await client.send(path, method: method, query: query, body: EmptyBody())
            if let ok { notice = ok }
        } catch {
            notice = Self.errorText(error)
        }
        await load(fresh: true)
        return response
    }

    /// The sentence for an error: for 409 INSTANCE_WORKING with who is working.
    nonisolated static func errorText(_ error: Error) -> String {
        if let a = InstanceWork.from(error) {
            return L("Locked — still working in the instance: {who}", ["who": a.rows.joined(separator: ", ")])
        }
        return (error as? APIError)?.message ?? error.localizedDescription
    }

    private func instancePath(_ i: InstancesTree.Instance, _ action: String) -> String {
        "/api/projects/\(projectId)/instances/\(i.name)/\(action)"
    }

    func stop(_ i: InstancesTree.Instance) async {
        await handle("stop:\(i.name)", instancePath(i, "stop"), ok: L("“{name}” is stopping.", ["name": i.name]))
    }

    func start(_ i: InstancesTree.Instance) async {
        guard let data = await handle("start:\(i.name)", instancePath(i, "start")) else { return }
        let kind = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["kind"]?.stringValue
        notice = kind == "waiting"
            ? L("“{name}” starts as soon as memory is free.", ["name": i.name])
            : L("“{name}” is starting.", ["name": i.name])
    }

    func abortStart(_ i: InstancesTree.Instance) async {
        await handle("start:\(i.name)", instancePath(i, "start-abort"), ok: L("The pending start of “{name}” was cancelled.", ["name": i.name]))
    }

    /// `compose up -d --build` per stack of the instance, asynchronous: 202 at once, state and result are on the instance (tree field
    /// `action`, `actionText`).
    func stackRestart(_ i: InstancesTree.Instance) async {
        await handle("restart:\(i.name)", instancePath(i, "stack-restart"),
                     ok: L("The stack of “{name}” is restarting — the result will show on the instance.", ["name": i.name]))
    }

    /// The sentence for the action on the instance: running · failed · for a stack restart the result per stack. nil for a successful,
    /// finished branch switch or a discard (the repos show their result).
    nonisolated static func actionText(_ a: InstancesTree.Action) -> String? {
        let what: String = switch a.kind {
        case "stack-restart": L("Stack restart")
        case "branch": L("Branch switch")
        case "dismiss": L("Discarding files")
        default: a.kind
        }
        if a.running { return L("{what} running …", ["what": what]) }
        if a.kind == "stack-restart", let stacks = a.stacks {
            if stacks.isEmpty { return L("No Compose stack in this instance.") }
            return stacks.map { s in
                s.ok ? L("{stack}: restarted", ["stack": s.project]) : L("{stack}: failed — {reason}", ["stack": s.project, "reason": s.error])
            }.joined(separator: " · ")
        }
        if a.ok { return nil }
        return L("{what} failed: {reason}", ["what": what, "reason": a.error.isEmpty ? "?" : a.error])
    }

    /// Fetch (a copy only): the copy's commits into main (`POST …/stack-copies/:name/fetch`).
    func fetch(_ i: InstancesTree.Instance) async {
        guard let name = InstancesTree.copyName(i.name) else { return }
        await handle("fetch:\(i.name)", "/api/projects/\(projectId)/stack-copies/\(name)/fetch",
                     ok: L("The commits of “{name}” are in main under copy/{name}/….", ["name": name]))
    }

    /// Start a service in THIS instance (simple start with the start command); main without a parameter.
    func serviceStart(_ d: InstancesTree.Service, in i: InstancesTree.Instance) async {
        struct Body: Encodable { let mode: String }
        let key = "service:\(i.name):\(d.id)"
        working.insert(key)
        defer { working.remove(key) }
        do {
            _ = try await client.send("/api/projects/\(projectId)/services/\(d.id)/start", query: query(i), body: Body(mode: "simple"))
        } catch {
            notice = Self.errorText(error)
        }
        await load(fresh: true)
    }

    func serviceStop(_ d: InstancesTree.Service, in i: InstancesTree.Instance) async {
        let key = "service:\(i.name):\(d.id)"
        working.insert(key)
        defer { working.remove(key) }
        do {
            let data = try await client.send("/api/projects/\(projectId)/services/\(d.id)/stop", query: query(i))
            if let m = ServiceStopResponse.notice(from: data, name: d.name) { notice = m }
        } catch {
            notice = Self.errorText(error)
        }
        await load(fresh: true)
    }

    private func query(_ i: InstancesTree.Instance) -> [URLQueryItem] {
        CodeInstance.query(i.name == InstancesTree.main ? nil : i.identifier)
    }
}

extension ProjectServiceRow {
    /// A tree service as a row for the preview-link building blocks (`PreviewShareButton` reads project, id, name and port). nil if
    /// the id is not a number (then there is no link; never guess).
    init?(tree d: InstancesTree.Service, project: Project) {
        guard let id = Int(d.id) else { return nil }
        self.id = id
        projectId = project.id
        projectName = project.name
        workspaceId = nil
        name = d.name
        kind = "other"
        port = d.port.map { Int($0) }
        container = ""
        tech = ""
        startCommand = ""
        agentInstructions = ""
        running = d.running
        holdsStart = d.holdsStart
        instances = nil
    }
}

/// Which sheet the tab is currently showing.
enum InstanceSheet: Identifiable {
    case create(base: String?)
    case erase(identifier: String)
    case branch(instance: String, repo: String?)

    var id: String {
        switch self {
        case .create(let b): return "create:\(b ?? "")"
        case .erase(let k): return "delete:\(k)"
        case .branch(let i, let r): return "branch:\(i):\(r ?? "")"
        }
    }
}

/// A question before stopping, starting or restarting the stack; it names the instance's chats.
private struct InstanceQuestion: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let button: String
    var destructive = false
    let action: () async -> Void
}

/// The manual actions on an instance: the same menu in the row's context menu and the page's ⋯, the same questions. Sheet and question
/// go to whoever holds the actions (`sheet`, `question`), which presents them itself.
@MainActor
private struct InstanceManualActions {
    let model: InstancesPageModel
    let jump: (InstanceJump) -> Void
    let sheet: (InstanceSheet) -> Void
    let question: (InstanceQuestion) -> Void

    @ViewBuilder
    func menu(_ i: InstancesTree.Instance) -> some View {
        let a = InstancesTree.actionsOf(i)
        let copy = InstancesTree.copyName(i.name) != nil
        Section {
            if a.abortStart.on {
                entry(L("Cancel pending start"), "xmark.circle", a.abortStart) {
                    Task { await model.abortStart(i) }
                }
            }
            if i.state == "stopped" {
                entry(L("Start"), "play", a.start) { questionStart(i) }
            } else {
                entry(L("Stop"), "stop", a.stop) { questionStop(i) }
            }
        }
        Section {
            entry(L("Start chat"), "bubble.left.and.text.bubble.right", a.chat) { jump(.startChat(instance: i.name)) }
            entry(L("Code"), "doc.text", a.code) { jump(.code(identifier: i.identifier)) }
            entry(L("Terminal"), "terminal", a.terminal) { jump(.terminal(identifier: i.identifier)) }
        }
        Section {
            entry(L("Switch branch"), "arrow.triangle.branch", a.branch) { sheet(.branch(instance: i.name, repo: nil)) }
            entry(L("Restart stack"), "arrow.clockwise", a.stop) { questionRestart(i) }
            if copy {
                entry(L("Fetch"), "arrow.down.to.line", a.stop) { Task { await model.fetch(i) } }
            }
            // As on the web (InstancesPage.tsx): the base is preselected; the server accepts a copy as a template.
            entry(L("Copy from this instance"), "plus.square.on.square", a.asBase) { sheet(.create(base: i.name)) }
        }
        if copy {
            Section {
                Button(role: .destructive) {
                    sheet(.erase(identifier: i.identifier))
                } label: {
                    Label(L("Delete copy"), systemImage: "trash")
                    if let g = a.erase.reason { Text(ProjectInstancesPage.reasonText(g)) }
                }
                .disabled(!a.erase.on)
            }
        }
    }

    /// A menu entry: locked grey, with the reason as a second line.
    private func entry(_ title: String, _ symbol: String, _ v: InstancesTree.Available, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
            if let g = v.reason { Text(ProjectInstancesPage.reasonText(g)) }
        }
        .disabled(!v.on)
    }

    // ── Questions (naming the instance's chats) ──

    /// "Working in copy-k1: A (running), B." Running first; without a chat a sentence of its own.
    private func chatSentence(_ i: InstancesTree.Instance) -> String {
        guard !i.chats.isEmpty else { return L("No chat is working in this instance.") }
        let sorted = InstancesTree.workingChats(i) + i.chats.filter { !$0.running }
        let names = sorted.map { c in
            let title = c.title.isEmpty ? c.id : c.title
            return c.running ? L("{title} (running)", ["title": title]) : title
        }
        return L("Working in this instance: {chats}.", ["chats": names.joined(separator: ", ")])
    }

    func questionStop(_ i: InstancesTree.Instance) {
        let main = i.name == InstancesTree.main
        question(InstanceQuestion(
            title: L("Stop “{name}”?", ["name": i.name]),
            message: [
                main ? L("Stopping main freezes every chat of the project that would work there — until it is started.")
                    : L("Containers off, memory free, the data stays."),
                chatSentence(i),
                L("A turn that needs the instance afterwards starts it again."),
            ].joined(separator: "\n\n"),
            button: L("Stop"),
            destructive: true
        ) { await model.stop(i) })
    }

    func questionStart(_ i: InstancesTree.Instance) {
        question(InstanceQuestion(
            title: L("Start “{name}”?", ["name": i.name]),
            message: [L("If memory is full, the start waits until there is room — you can cancel it in the menu."), chatSentence(i)].joined(separator: "\n\n"),
            button: L("Start")
        ) { await model.start(i) })
    }

    func questionRestart(_ i: InstancesTree.Instance) {
        question(InstanceQuestion(
            title: L("Restart the stack of “{name}”?", ["name": i.name]),
            message: [L("Rebuilds and restarts every Compose stack of the instance (compose up -d --build)."), chatSentence(i)].joined(separator: "\n\n"),
            button: L("Restart")
        ) { await model.stackRestart(i) })
    }
}

/// Sheets and question of the tab, each on the list and on an instance's page, with its own state.
private struct InstanceSheets: ViewModifier {
    let client: APIClient
    let projectId: String
    @ObservedObject var model: InstancesPageModel
    @Binding var sheet: InstanceSheet?
    @Binding var question: InstanceQuestion?

    func body(content: Content) -> some View {
        content
            .sheet(item: $sheet) { b in
                switch b {
                case .create(let base):
                    CopyCreateSheet(client: client, projectId: projectId, tree: model.tree, base: base) { text in
                        model.notice = text
                        Task { await model.load(fresh: true) }
                    }
                    .cbSheet(.whole)
                case .erase(let identifier):
                    CopyDeleteSheet(client: client, identifier: identifier) { text in
                        model.notice = text
                        Task { await model.load(fresh: true) }
                    }
                    .cbSheet(.half)
                case .branch(let instance, let repo):
                    BranchSwitchSheet(client: client, projectId: projectId, instance: instance, repo: repo) { text in
                        if let text { model.notice = text }
                        Task { await model.load(fresh: true) }
                    }
                    .cbSheet(.whole)
                }
            }
            .confirmationDialog(
                question?.title ?? "",
                isPresented: Binding(get: { question != nil }, set: { if !$0 { question = nil } }),
                titleVisibility: .visible
            ) {
                if let f = question {
                    Button(f.button, role: f.destructive ? .destructive : nil) {
                        question = nil
                        Task { await f.action() }
                    }
                }
                Button(L("Cancel"), role: .cancel) { question = nil }
            } message: {
                Text(verbatim: question?.message ?? "")
            }
    }
}

/// In the project sheet's stack: the opened instance as a pushed page. Without a stack (embedded) nothing: there the page replaces the
/// list (a `navigationDestination` outside a NavigationStack would be silently ignored).
private struct StackTarget<Target: View>: ViewModifier {
    let active: Bool
    @Binding var opened: String?
    let target: (String) -> Target

    func body(content: Content) -> some View {
        if active {
            content.navigationDestination(item: $opened) { name in target(name) }
        } else {
            content
        }
    }
}

struct ProjectInstancesPage: View {
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let project: Project
    /// The page is in front; only then does the 5 s tick run.
    let visible: Bool
    /// In the project sheet's NavigationStack: an instance is pushed. Without one (embedded) it replaces the list.
    let stack: Bool
    let jump: (InstanceJump) -> Void
    /// "Enter start command": into the project's services (where the command is edited).
    let startCommand: () -> Void

    @StateObject private var model: InstancesPageModel
    @StateObject private var preview = PreviewLinksModel()
    @State private var sheet: InstanceSheet?
    @State private var question: InstanceQuestion?
    /// A jump from outside (`AppState.projectWish` with `page == .instances`, Code/ProjectView.swift), picked up but not fully executed
    /// yet: the "Create copy" dialog waits for the first tree (before that it knows neither ready bases nor taken names).
    @State private var wish: ProjectWish?

    init(client: APIClient, project: Project, visible: Bool, stack: Bool, jump: @escaping (InstanceJump) -> Void,
         startCommand: @escaping () -> Void) {
        self.client = client
        self.project = project
        self.visible = visible
        self.stack = stack
        self.jump = jump
        self.startCommand = startCommand
        _model = StateObject(wrappedValue: InstancesPageModel(client: client, projectId: project.id))
    }

    private var manualActions: InstanceManualActions {
        InstanceManualActions(model: model, jump: jump, sheet: { sheet = $0 }, question: { question = $0 })
    }

    var body: some View {
        frame
            .task(id: visible) {
                guard visible else { return }
                preview.client = client
                await preview.load()
                while !Task.isCancelled {
                    await model.load()
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            }
            .onChange(of: state.instanceEvents[project.id] ?? 0) {
                if visible { Task { await model.load(fresh: true) } }
            }
            .onChange(of: state.previewTick) {
                guard visible else { return }
                Task {
                    await preview.load()
                    await model.load()
                }
            }
            // The instance just opened immediately with its details (`?open=`).
            .onChange(of: model.opened) { _, fresh in
                if fresh != nil { Task { await model.load() } }
            }
            // A jump from outside: picked up only once the tab is IN FRONT; a page standing covered (the instances were open before) would
            // pick it up before the projects page has switched the segment, and the jump would stay on "Services".
            .onChange(of: state.projectWish?.id, initial: true) { _, _ in pickUpWish() }
            .onChange(of: visible) { _, _ in pickUpWish() }
            .onChange(of: model.tree != nil) { _, _ in wishExecute() }
            .modifier(InstanceSheets(client: client, projectId: project.id, model: model, sheet: $sheet, question: $question))
            .modifier(StackTarget(active: stack, opened: $model.opened) { name in page(name, pushed: true) })
    }

    private func pickUpWish() {
        guard visible, let w = state.projectWish, w.page == .instances, w.projectId == project.id else { return }
        state.projectWish = nil
        guard !w.expired else { return }
        wish = w
        wishExecute()
    }

    /// Open the instance or the "Create copy" dialog: the latter only with a read tree, above the LIST (an open page closes for it), and
    /// in the project list's sheet only after it has slid in (a sheet presented during a running presentation does not appear).
    private func wishExecute() {
        guard let w = wish else { return }
        if w.createFrom != nil, model.tree == nil { return }
        wish = nil
        if let name = w.instance { model.opened = name }
        if let base = w.createFrom {
            if w.instance == nil { model.opened = nil }
            let wait = stack
            Task {
                if wait { try? await Task.sleep(nanoseconds: 450_000_000) }
                sheet = .create(base: base)
            }
        }
    }

    @ViewBuilder
    private var frame: some View {
        if !stack, let name = model.opened {
            page(name, pushed: false)
        } else if let tree = model.tree {
            list(tree)
        } else if let error = model.error {
            CbEmpty(symbol: "exclamationmark.triangle", text: error, identifier: "instances-error", button: L("Reload")) {
                Task { await model.load() }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            CbLoading(label: L("Loading…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func page(_ name: String, pushed: Bool) -> some View {
        InstancePage(client: client, project: project, name: name, model: model, preview: preview, jump: jump,
                     startCommand: startCommand, pushed: pushed)
    }

    // ── The list ──

    private func list(_ tree: InstancesTree.Tree) -> some View {
        let bases = InstancesTree.baseOptions(tree)
        return CbList {
            if model.notice != nil || model.error != nil {
                Section {
                    NoticeRows(model: model)
                }
            }
            Section {
                ForEach(tree.instances) { i in
                    row(i)
                        .contextMenu { manualActions.menu(i) }
                }
                Button {
                    sheet = .create(base: nil)
                } label: {
                    Label(L("Create copy"), systemImage: "plus.square.on.square")
                        .cbFont(15, weight: .medium)
                }
                .disabled(bases.isEmpty)
                .accessibilityIdentifier("instances-create")
            } header: {
                Text(verbatim: Self.summary(tree))
                    .textCase(nil)
                    .accessibilityIdentifier("instances-summary")
            } footer: {
                if bases.isEmpty {
                    Text(L("A copy needs a ready instance as its template."))
                }
            }
        }
        .accessibilityIdentifier("instances-list")
        .cbRefreshable { await model.load(fresh: true) }
    }

    /// An instance as a row: tile (`InstanceTile`), name, situation (only if not ready), below it the summary from `rowOf`.
    private func row(_ i: InstancesTree.Instance) -> some View {
        let situation = InstancesTree.situationOf(i)
        return Button {
            model.opened = i.name
        } label: {
            HStack(spacing: 12) {
                InstanceTile(i: i)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: Self.title(i.name))
                            .cbFont(16, weight: .medium)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(1)
                        if situation != .ready {
                            Text(Self.situationText(i))
                                .cbFont(13)
                                .foregroundStyle(Self.wordColor(situation))
                                .lineLimit(1)
                        }
                    }
                    // A copy being created: the step with remaining time above the facts, below it the thin bar and, when overrun, the note
                    // (Code/CopyProgressDisplay.swift). The waiting is already said by the situation word.
                    if let a = Self.progress(i) {
                        CopyStepRow(a: a)
                    }
                    InstanceFacts(i: i)
                    if let a = Self.progress(i) {
                        CopyProgressBar(a: a)
                            .frame(maxWidth: 240)
                            .padding(.top, 4)
                        CopyOverrunHint(a: a)
                    }
                }
                Spacer(minLength: 4)
                if model.working.contains(where: { $0.hasSuffix(":\(i.name)") }) {
                    ProgressView().controlSize(.small)
                }
                Image(systemName: "chevron.right")
                    .font(.symbol(13, weight: .semibold))
                    .foregroundStyle(CbColor.textMuted.opacity(0.6))
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier("instance-row-\(i.name)")
    }

    /// The progress of a copy that is waiting or being created (`InstancesTree.progressDetail`); nil for main and every finished instance.
    static func progress(_ i: InstancesTree.Instance) -> InstancesTree.ProgressDetail? {
        i.name == InstancesTree.main ? nil : InstancesTree.progressDetail(i.progress, state: i.state)
    }

    /// "3 instances · 2 ready · 1 public link", as above the list on the web.
    static func summary(_ tree: InstancesTree.Tree) -> String {
        let n = tree.instances.count
        let ready = tree.instances.filter { InstancesTree.situationOf($0) == .ready }.count
        let links = tree.instances.reduce(0) { $0 + InstancesTree.rowOf($1).links.count }
        var parts = [n == 1 ? L("1 instance") : L("{n} instances", ["n": n]), L("{n} ready", ["n": ready])]
        if links > 0 { parts.append(links == 1 ? L("1 public link") : L("{n} public links", ["n": links])) }
        return parts.joined(separator: " · ")
    }

    // ── Words ──

    /// "Main" or "Copy k1", as on the web (`instanceTitle`).
    static func title(_ name: String) -> String {
        InstancesTree.copyName(name).map { L("Copy {name}", ["name": $0]) } ?? L("Main")
    }

    static func color(_ situation: InstancesTree.Situation) -> Color {
        switch situation {
        case .ready: return .green
        case .starts, .stops, .waiting, .build, .clearAway: return .orange
        case .error: return .red
        case .stopped, .unknown: return CbColor.textMuted
        }
    }

    /// The colour of the situation word: the same language as the dot, only an operation (starts, stops, …) stays muted; orange means
    /// "waiting" or "going away", red "broken".
    static func wordColor(_ situation: InstancesTree.Situation) -> Color {
        switch situation {
        case .error: return .red
        case .waiting, .clearAway: return .orange
        default: return CbColor.textMuted
        }
    }

    static func situationText(_ i: InstancesTree.Instance) -> String {
        switch InstancesTree.situationOf(i) {
        case .ready: return L("ready")
        case .starts: return L("starting")
        case .stops: return L("stopping")
        case .stopped: return L("stopped")
        case .waiting: return i.waiting?.reason == "queue" || i.state == "waiting_queue" ? L("waiting in line") : L("waiting for memory")
        case .build: return L("being created")
        case .clearAway: return L("being deleted")
        case .error: return L("Error")
        case .unknown: return i.state.isEmpty ? L("unknown") : i.state
        }
    }

    static func reasonText(_ g: InstancesTree.Reason) -> String {
        switch g {
        case .notReady: return L("The instance is not ready.")
        case .notStopped: return L("The instance is not stopped.")
        case .startWaiting: return L("The start is already waiting for memory.")
        case .noWaitingStart: return L("No start is waiting.")
        case .main: return L("Main cannot be deleted.")
        case .getsClearedAway: return L("The copy is being deleted.")
        case .noRepos: return L("The instance has no code repos.")
        case .reposTo: return L("The repos have not been loaded yet.")
        }
    }
}

/// The second line of an instance in the list (`rowOf`): branch, containers "x/y", the first public link; without read parts a copy's
/// base. What was not read is not shown; never "0/0".
private struct InstanceFacts: View {
    let i: InstancesTree.Instance

    var body: some View {
        let z = InstancesTree.rowOf(i)
        HStack(spacing: 10) {
            if let b = z.branch {
                HStack(spacing: 0) {
                    Image(systemName: "arrow.triangle.branch").font(.symbol(10.5)).padding(.trailing, 3)
                    Text(verbatim: b.detached ? "@\(b.name)" : (b.name.isEmpty ? "–" : b.name))
                        .cbFont(12.5, design: .monospaced)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if b.changed {
                        Text(verbatim: "*").cbFont(12.5, design: .monospaced).foregroundStyle(.orange)
                    }
                    if b.additional > 0 {
                        Text(verbatim: " +\(b.additional)").cbFont(12.5).fixedSize()
                    }
                }
                .accessibilityLabel(b.changed ? L("{branch}, uncommitted changes", ["branch": b.name]) : b.name)
            }
            if let s = z.stack {
                HStack(spacing: 3) {
                    Image(systemName: "shippingbox").font(.symbol(10.5))
                    Text(verbatim: s.total == 0 ? L("no containers") : "\(s.run)/\(s.total)")
                        .cbFont(12.5, digitsEqual: true)
                }
                .foregroundStyle(s.run < s.total ? Color.orange : CbColor.textMuted)
                .lineLimit(1)
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(s.total == 0 ? L("no containers") : L("{run} of {total} running", ["run": s.run, "total": s.total]))
            }
            if let l = z.links.first {
                HStack(spacing: 3) {
                    Image(systemName: "globe").font(.symbol(10.5))
                    Text(verbatim: l.service + (z.links.count > 1 ? " +\(z.links.count - 1)" : ""))
                        .cbFont(12.5)
                        .strikethrough(l.stopped)
                }
                    .foregroundStyle(l.stopped ? CbColor.textMuted : Color.accentColor)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(l.stopped ? L("Public link to {service} — instance stopped", ["service": l.service])
                                                   : L("Public link to {service}", ["service": l.service]))
            }
            if z.branch == nil, z.stack == nil, let base = i.base, i.name != InstancesTree.main {
                Text(L("from {base}", ["base": ProjectInstancesPage.title(base)]))
                    .cbFont(12.5)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(CbColor.textMuted)
    }
}

/// An instance's tile (as `InstanceTile` on the web): house (main) or two offset boxes (copy), the symbol in the colour of the
/// situation (`color`: green ready, orange in transition or waiting, red error, muted stopped). Background `CbColor.elevated` like
/// `CbSign`, never a system surface (`Kit/CbColor.swift`: it would show as a cold patch in the warm look).
private struct InstanceTile: View {
    let i: InstancesTree.Instance
    var large = false

    var body: some View {
        // The shared tile of the project pages (ProjectForm.swift).
        ProjectTile(symbol: i.name == InstancesTree.main ? "house" : "square.on.square",
                      color: ProjectInstancesPage.color(InstancesTree.situationOf(i)),
                      size: large ? 36 : 34)
    }
}

/// The header of a page section: the category's symbol before the title, a figure on the right; for containers a bar (one stroke per
/// container).
private struct InstanceSectionHeader: View {
    let symbol: String
    let title: String
    var right: String? = nil
    var warning = false
    var bar: (Int, Int)? = nil

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.symbol(12, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 18)
            Text(title)
            Spacer(minLength: 6)
            if let l = bar {
                InstanceStackBar(run: l.0, total: l.1)
            }
            if let right {
                Text(right)
                    .textCase(nil)
                    .foregroundStyle(warning ? Color.orange : CbColor.textMuted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The containers as a bar: green runs, muted stands; from 16 on a "+N".
private struct InstanceStackBar: View {
    let run: Int
    let total: Int

    var body: some View {
        let show = min(total, 16)
        HStack(spacing: 2.5) {
            ForEach(0..<show, id: \.self) { n in
                Capsule()
                    .fill(n < min(run, show) ? Color.green : CbColor.textMuted.opacity(0.35))
                    .frame(width: 4, height: 10)
            }
            if total > show {
                Text(verbatim: "+\(total - show)").textCase(nil)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The sentence about the last action and the error of the last fetch, at the top of list and page.
private struct NoticeRows: View {
    @ObservedObject var model: InstancesPageModel

    var body: some View {
        if let notice = model.notice {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: notice)
                    .cbFont(13.5)
                    .foregroundStyle(CbColor.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("instances-notice")
                Spacer(minLength: 4)
                Button { model.notice = nil } label: {
                    Image(systemName: "xmark").font(.symbol(11, weight: .semibold)).foregroundStyle(CbColor.textMuted)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(L("Dismiss##hide"))
            }
        }
        if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle")
                .cbFont(13)
                .foregroundStyle(.orange)
        }
    }
}

/// An instance's page: pushed in the project sheet (with title and ⋯ in the bar) or in place of the list (with "‹ Instances").
private struct InstancePage: View {
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let project: Project
    let name: String
    @ObservedObject var model: InstancesPageModel
    @ObservedObject var preview: PreviewLinksModel
    let jump: (InstanceJump) -> Void
    let startCommand: () -> Void
    /// Pushed: the list below has disappeared and with it its tick; the page then asks itself every 5 s.
    let pushed: Bool

    @State private var sheet: InstanceSheet?
    @State private var question: InstanceQuestion?
    /// The running containers, collapsed; what is down is always shown.
    @State private var runningOpen = false

    private var manualActions: InstanceManualActions {
        InstanceManualActions(model: model, jump: jump, sheet: { sheet = $0 }, question: { question = $0 })
    }

    private var instance: InstancesTree.Instance? { model.tree?.instances.first { $0.name == name } }

    var body: some View {
        frame
            .task(id: pushed) {
                guard pushed else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    if Task.isCancelled { break }
                    await model.load()
                }
            }
            // Deleted (or otherwise gone): the page has nothing left to show and closes itself.
            .onChange(of: instance == nil) { _, gone in
                if gone, model.tree != nil, model.opened == name { model.opened = nil }
            }
            .modifier(InstanceSheets(client: client, projectId: project.id, model: model, sheet: $sheet, question: $question))
    }

    @ViewBuilder
    private var frame: some View {
        if pushed {
            content
                .navigationTitle(ProjectInstancesPage.title(name))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let i = instance {
                        ToolbarItem(placement: .primaryAction) { menuButton(i) }
                    }
                }
        } else {
            VStack(spacing: 0) {
                bar
                content
            }
        }
    }

    /// Without a stack: back to the list, the name, the ⋯.
    private var bar: some View {
        HStack(spacing: 10) {
            Button { model.opened = nil } label: {
                Image(systemName: "chevron.left")
                    .font(.symbol(17, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 28, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("Instances"))
            .accessibilityIdentifier("instance-back")
            Text(verbatim: ProjectInstancesPage.title(name))
                .cbFont(17, weight: .semibold)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if let i = instance { menuButton(i) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var content: some View {
        if let i = instance {
            list(i)
        } else if model.tree != nil {
            CbEmpty(symbol: "square.dashed", text: L("This instance no longer exists."), identifier: "instance-gone",
                    button: L("Back to list")) { model.opened = nil }
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            CbLoading(label: L("Loading…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func menuButton(_ i: InstancesTree.Instance) -> some View {
        Menu {
            manualActions.menu(i)
        } label: {
            Group {
                if model.working.contains(where: { $0.hasSuffix(":\(i.name)") }) {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "ellipsis.circle")
                        .font(.symbol(17))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(minWidth: 36, minHeight: 36)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(L("Actions for {name}", ["name": i.name]))
        .accessibilityIdentifier("instance-menu-\(i.name)")
    }

    // ── The page ──

    private func list(_ i: InstancesTree.Instance) -> some View {
        let a = InstancesTree.actionsOf(i)
        return CbList {
            Section {
                header(i)
                HStack(spacing: 8) {
                    tile(L("Start chat"), "plus.bubble", a.chat, "instance-chat-start-\(i.name)") { jump(.startChat(instance: i.name)) }
                    tile(L("Code"), "doc.text", a.code, "instance-code-\(i.name)") { jump(.code(identifier: i.identifier)) }
                    tile(L("Terminal"), "terminal", a.terminal, "instance-terminal-\(i.name)") { jump(.terminal(identifier: i.identifier)) }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 12))
                NoticeRows(model: model)
                state(i)
            }
            containerSection(i)
            Section {
                if i.services.isEmpty {
                    Text(L("no services recorded")).cbFont(14).foregroundStyle(CbColor.textMuted)
                }
                ForEach(i.services) { d in
                    serviceRow(d, in: i)
                }
            } header: {
                InstanceSectionHeader(symbol: "server.rack", title: L("Services"),
                              right: i.services.isEmpty ? nil : L("{run} of {total} running", ["run": i.services.filter(\.running).count, "total": i.services.count]))
            }
            Section {
                part(i.repos, empty: L("no code repos")) { r in
                    repoRow(r, in: i)
                }
            } header: {
                InstanceSectionHeader(symbol: "arrow.triangle.branch", title: L("Repos"))
            }
            Section {
                if i.chats.isEmpty {
                    Text(L("No chat works in this instance.")).cbFont(14).foregroundStyle(CbColor.textMuted)
                }
                ForEach(i.chats) { c in
                    Button { jump(.chatOpen(id: c.id)) } label: {
                        HStack(spacing: 9) {
                            Text(verbatim: c.title.isEmpty ? c.id : c.title).cbFont(15).foregroundStyle(CbColor.text).lineLimit(1)
                            Spacer(minLength: 6)
                            if c.running {
                                Text(L("running")).cbFont(13).foregroundStyle(CbColor.textSecondary)
                            }
                            Image(systemName: "chevron.right")
                                .font(.symbol(12, weight: .semibold))
                                .foregroundStyle(CbColor.textMuted.opacity(0.6))
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("instance-chat-\(c.id)")
                }
            } header: {
                InstanceSectionHeader(symbol: "bubble.left.and.bubble.right", title: L("Chats"))
            }
            if InstancesTree.copyName(i.name) != nil {
                Section {
                    Button(role: .destructive) {
                        sheet = .erase(identifier: i.identifier)
                    } label: {
                        Text(L("Delete copy")).cbFont(15)
                    }
                    .disabled(!a.erase.on)
                    .accessibilityIdentifier("instance-delete-\(i.name)")
                } footer: {
                    if let g = a.erase.reason {
                        Text(ProjectInstancesPage.reasonText(g))
                    } else {
                        Text(L("Everything is saved in main under copy/{name}/….", ["name": InstancesTree.copyName(i.name) ?? ""]))
                    }
                }
            }
        }
        .accessibilityIdentifier("instance-page-\(i.name)")
        .cbRefreshable { await model.load(fresh: true) }
    }

    /// Situation large with a dot, below it base · RAM · CPU · created by.
    private func header(_ i: InstancesTree.Instance) -> some View {
        let situation = InstancesTree.situationOf(i)
        var meta: [String] = []
        if let base = i.base, i.name != InstancesTree.main { meta.append(L("from {base}", ["base": ProjectInstancesPage.title(base)])) }
        if let mem = i.memBytes { meta.append(formatBytes(mem)) }
        if let cpu = i.cpu { meta.append(servicesCpuText(cpu)) }
        if let from = i.createdOf {
            meta.append(L("created by “{chat}”", ["chat": from.title ?? L("deleted chat")]))
        }
        // A copy being created: the step in words instead of the raw phase, below it bar, remaining time and the overrun note
        // (Code/CopyProgressDisplay.swift; the same words as on the web).
        let detail = ProjectInstancesPage.progress(i)
        let step = detail.flatMap { CopyProgressText.stepSet($0) }
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 10) {
                InstanceTile(i: i, large: true)
                Text(ProjectInstancesPage.situationText(i))
                    .cbFont(17, weight: .semibold)
                    .foregroundStyle(situation == .ready ? CbColor.text : ProjectInstancesPage.wordColor(situation))
                if let step {
                    Text(verbatim: step).cbFont(14, digitsEqual: true).foregroundStyle(CbColor.textMuted).lineLimit(1)
                } else if detail == nil, !i.phase.isEmpty, situation != .ready, situation != .stopped {
                    Text(verbatim: i.phase).cbFont(14).foregroundStyle(CbColor.textMuted).lineLimit(1)
                }
            }
            if let a = detail {
                VStack(alignment: .leading, spacing: 4) {
                    CopyProgressBar(a: a)
                        .frame(maxWidth: 320)
                    if let rest = CopyProgressText.restSet(a) {
                        Text(verbatim: rest).cbFont(13, digitsEqual: true).foregroundStyle(CbColor.textMuted)
                    }
                    CopyOverrunHint(a: a)
                }
                .padding(.vertical, 2)
                .accessibilityIdentifier("instance-progress-\(i.name)")
            }
            if !meta.isEmpty {
                Text(verbatim: meta.joined(separator: " · "))
                    .cbFont(13, digitsEqual: true)
                    .foregroundStyle(CbColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("instance-header-\(i.name)")
    }

    /// A button of the row start chat · code · terminal: symbol above word, equal width (like a contact card's buttons).
    private func tile(_ title: String, _ symbol: String, _ v: InstancesTree.Available, _ identifier: String,
                        _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.symbol(17))
                Text(title).cbFont(12.5, weight: .medium).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
        .buttonStyle(.bordered)
        .disabled(!v.on)
        .accessibilityHint(v.reason.map { ProjectInstancesPage.reasonText($0) } ?? "")
        .accessibilityIdentifier(identifier)
    }

    /// The instance's error, its running or failed action, a waiting start.
    @ViewBuilder
    private func state(_ i: InstancesTree.Instance) -> some View {
        if !i.error.isEmpty {
            Text(verbatim: i.error)
                .cbFont(13)
                .foregroundStyle(.red)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        // The user's running or last failed action (a stack restart keeps running on the server).
        if let a = i.action, let set = InstancesPageModel.actionText(a) {
            HStack(spacing: 8) {
                if a.running { ProgressView().controlSize(.small) }
                Text(verbatim: set)
                    .cbFont(13.5)
                    .foregroundStyle(a.running ? CbColor.textSecondary : (a.ok ? CbColor.textSecondary : Color.red))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityIdentifier("instance-action")
        }
        if let w = i.waiting {
            HStack {
                Text(w.reason == "storage" ? L("Waiting for free memory.") : L("Waiting in the copy queue."))
                    .cbFont(13.5)
                    .foregroundStyle(.orange)
                Spacer(minLength: 6)
                if InstancesTree.actionsOf(i).abortStart.on {
                    Button(L("Cancel")) { Task { await model.abortStart(i) } }
                        .buttonStyle(.borderless)
                        .cbFont(13.5, weight: .medium)
                }
            }
        }
    }

    // ── Containers ──

    private func containerSection(_ i: InstancesTree.Instance) -> some View {
        let z = InstancesTree.rowOf(i)
        return Section {
            if InstancesTree.partSituation(i.container) == .list {
                let stopped = i.container.list.filter { !$0.running }
                let run = i.container.list.filter(\.running)
                ForEach(stopped, id: \.self) { c in containerRow(c) }
                if !run.isEmpty {
                    DisclosureGroup(isExpanded: $runningOpen) {
                        ForEach(run, id: \.self) { c in containerRow(c) }
                    } label: {
                        HStack(spacing: 9) {
                            Circle().fill(Color.green).frame(width: 7, height: 7)
                            Text(stopped.isEmpty ? L("All {n} running", ["n": run.count]) : L("{n} running", ["n": run.count]))
                                .cbFont(15)
                                .foregroundStyle(CbColor.text)
                        }
                    }
                    .accessibilityIdentifier("instance-container-run-\(i.name)")
                }
                if !i.container.error.isEmpty {
                    Text(verbatim: i.container.error).cbFont(12).foregroundStyle(.orange)
                }
            } else {
                part(i.container, empty: L("no containers")) { (_: InstancesTree.Container) in EmptyView() }
            }
        } header: {
            InstanceSectionHeader(symbol: "shippingbox", title: L("container"),
                          right: z.stack.flatMap { s in s.total > 0 ? L("{run} of {total} running", ["run": s.run, "total": s.total]) : nil },
                          warning: (z.stack.map { $0.run < $0.total }) ?? false,
                          bar: z.stack.flatMap { s in s.total > 0 ? (s.run, s.total) : nil })
        }
    }

    private func containerRow(_ c: InstancesTree.Container) -> some View {
        HStack(spacing: 9) {
            Circle().fill(c.running ? Color.green : CbColor.textMuted.opacity(0.5)).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: c.service.isEmpty ? c.name : c.service).cbFont(15).foregroundStyle(CbColor.text).lineLimit(1)
                Text(verbatim: [c.service.isEmpty ? "" : c.name, c.status].filter { !$0.isEmpty }.joined(separator: " · "))
                    .cbFont(12)
                    .foregroundStyle(c.running ? CbColor.textMuted : CbColor.textSecondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// A part with its situation: never an empty list for something that was not read.
    @ViewBuilder
    private func part<T: Hashable & Sendable, Row: View>(_ t: InstancesTree.Part<T>, empty: String, @ViewBuilder row: @escaping (T) -> Row) -> some View {
        switch InstancesTree.partSituation(t) {
        case .closed, .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("Loading…")).cbFont(14).foregroundStyle(CbColor.textMuted)
            }
        case .error:
            Text(verbatim: t.error.isEmpty ? L("unreadable") : t.error)
                .cbFont(13)
                .foregroundStyle(.orange)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .empty:
            Text(empty).cbFont(14).foregroundStyle(CbColor.textMuted)
        case .list:
            ForEach(t.list, id: \.self) { x in row(x) }
            if !t.error.isEmpty {
                Text(verbatim: t.error).cbFont(12).foregroundStyle(.orange)
            }
        }
    }

    // ── Repos, services ──

    private func repoRow(_ r: InstancesTree.Repo, in i: InstancesTree.Instance) -> some View {
        let a = InstancesTree.actionsOf(i)
        return HStack(spacing: 9) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: r.rel.isEmpty ? L("Project folder") : r.rel).cbFont(15).foregroundStyle(CbColor.text).lineLimit(1)
                HStack(spacing: 6) {
                    Text(verbatim: r.branch.isEmpty ? "–" : r.branch)
                        .cbFont(12.5, design: .monospaced)
                        .foregroundStyle(CbColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if r.detached {
                        Text(L("detached")).cbFont(12).foregroundStyle(.orange)
                    }
                    if r.open > 0 {
                        let n = Int(r.open)
                        Text(n == 1 ? L("1 file open") : L("{n} files open", ["n": n]))
                            .cbFont(12)
                            .foregroundStyle(.orange)
                    }
                }
                if !r.error.isEmpty {
                    Text(verbatim: r.error).cbFont(12).foregroundStyle(.orange).lineLimit(2)
                }
            }
            Spacer(minLength: 6)
            Button(L("Branch")) { sheet = .branch(instance: i.name, repo: r.rel) }
                .buttonStyle(.borderless)
                .cbFont(14, weight: .medium)
                .disabled(!a.branch.on)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("instance-repo-\(i.name)-\(r.rel.isEmpty ? "." : r.rel)")
    }

    @ViewBuilder
    private func serviceRow(_ d: InstancesTree.Service, in i: InstancesTree.Instance) -> some View {
        let action = InstancesTree.serviceAction(d, i)
        let running = model.running("service:\(i.name):\(d.id)")
        let row = ProjectServiceRow(tree: d, project: project)
        let activeLink = d.link.flatMap { l in preview.snapshot?.active.first(where: { $0.id == l.id }) }
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 9) {
                Circle().fill(d.running ? Color.green : d.holdsStart ? Color.orange : CbColor.textMuted.opacity(0.5)).frame(width: 7, height: 7)
                Text(verbatim: d.name).cbFont(15).foregroundStyle(CbColor.text).lineLimit(1)
                if let port = d.port {
                    Text(verbatim: ":\(Int(port))").cbFont(12.5, design: .monospaced).foregroundStyle(CbColor.textMuted)
                }
                Spacer(minLength: 6)
                if running {
                    ProgressView().controlSize(.small)
                } else {
                    switch action {
                    case .stop:
                        Button(L("Stop")) { Task { await model.serviceStop(d, in: i) } }
                            .buttonStyle(.borderless)
                            .cbFont(14, weight: .medium)
                            .foregroundStyle(.red)
                    case .start:
                        Button(L("Start")) { Task { await model.serviceStart(d, in: i) } }
                            .buttonStyle(.borderless)
                            .cbFont(14, weight: .medium)
                    case .startCommand:
                        Button(L("Add start command"), action: startCommand)
                            .buttonStyle(.borderless)
                            .cbFont(13, weight: .medium)
                    case .no:
                        EmptyView()
                    }
                }
                // The link of this (instance, service): only without an existing one, only in a ready instance.
                if d.link == nil, let row, InstancesTree.situationOf(i) == .ready {
                    PreviewShareButton(model: preview, service: row, target: .instance(i.name)) {
                        state.showSettings = true
                    }
                    .buttonStyle(.borderless)
                }
            }
            if let link = activeLink {
                PreviewLinkRow(model: preview, link: link)
                    .padding(.leading, 16)
            } else if let l = d.link {
                // The tree knows the link, the list of links does not (yet): the address anyway, without actions.
                Text(verbatim: l.url.isEmpty ? L("Link is opening …") : l.url)
                    .cbFont(12, design: .monospaced)
                    .foregroundStyle(CbColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .padding(.leading, 16)
            }
            // The link stays but the instance is down: visitors see 502 "Instance stopped". Without this row the link read as reachable.
            // The same rule as on the web (`InstancesTree.linkStopped`, bound).
            if (activeLink != nil || d.link != nil), InstancesTree.linkStopped(i) {
                Label(L("Instance stopped"), systemImage: "pause.circle")
                    .cbFont(12)
                    .foregroundStyle(CbColor.textMuted)
                    .padding(.leading, 16)
                    .accessibilityIdentifier("instance-link-stopped-\(i.name)-\(d.id)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("instance-service-\(i.name)-\(d.id)")
    }
}

// ── Opening: chat, code, terminal ───────────────────────────────────────────────

extension AppState {
    /// Execute an entry of the "Instances" tab. → a sentence if it did not work (the page shows it), otherwise nil. Code and terminal
    /// follow the code tab's instance choice (Code/CodeInstanceChoice.swift, remembered per project): in the entered project the
    /// choice switches (not with an unsaved file; the code tab asks itself), otherwise the project is entered with the remembered
    /// choice.
    func instanceJump(_ jump: InstanceJump, project: Project) async -> String? {
        switch jump {
        case .chatOpen(let id):
            if let e = enteredProject, e.id != project.id { enterProject(project) }
            select(tab: .workspaces)
            openChat(id)
            return nil
        case .agentOpen(let chatId, let agentId):
            if let e = enteredProject, e.id != project.id { enterProject(project) }
            select(tab: .workspaces)
            openChat(chatId, agent: agentId)
            return nil
        case .startChat(let instance):
            guard client != nil, activeWorkspaceId != nil else { return L("No server connection") }
            // The draft with project and instance: the chat is created on first send (`ensureServerChat` sends the copy along; main is
            // the server's default). A copy that is cleared away by then falls back to main like any composer choice (`holdDraftInstance`).
            if let e = enteredProject, e.id != project.id { enterProject(project) }
            select(tab: .workspaces)
            var preset = NewChatDraft()
            preset.projectId = project.id
            preset.instance = ChatInstanceRules.binding(instance)
            openDraft(preset)
            return nil
        case .code(let identifier), .terminal(let identifier):
            let category: WorkspaceCategory = { if case .code = jump { return .code } else { return .terminal } }()
            let copy = CodeInstance.copyNameOf(identifier) != nil
            if enteredProject?.id == project.id, let choice = codeInstance {
                if choice.shown.param != (copy ? identifier : nil) {
                    if codeModel?.dirty == true {
                        openCoding(category)
                        return L("A file in the Code tab is not saved — switch the instance there yourself.")
                    }
                    choice.select(identifier)
                }
            } else {
                let key = CodeInstance.rememberKey(project.id)
                if copy { UserDefaults.standard.set(identifier, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
                enterProject(project)
            }
            openCoding(category)
            return nil
        }
    }
}
