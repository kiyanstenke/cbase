import SwiftUI

// Git view of the current scope (workspace folder or project folder) — the git sheet of the chat header and Coding → Code/Git.
//
// The same view as the desktop's git bar (web/src/components/GitSidebar.tsx), made for mobile: ONE scroll area with three
// collapsible sections one below the other —
//   Repositories — only with more than one repo (as on the desktop): one row per repo with branch, sync button (↓ ↑, or the cloud
//                  for an unpublished branch) and "…". A tap chooses which repo "Changes" shows (a second tap on the only chosen one
//                  returns to "all"), and the graph follows it.
//   Changes      — per shown repo the commit field with the primary button (Commit · Publish Branch · Sync · off, computed in
//                  `GitBar.primaryButton`), beside it Commit & Push / Commit All / Amend, below Merge Changes · Staged Changes ·
//                  Changes; a tap on a file shows its diff. With several repos one head per repo, clean ones start collapsed.
//   Graph        — all branches with tracks, arcs, badges (Code/GitGraphSection.swift).
// Collapsed sections are remembered in UserDefaults (`GitBar.SECTIONS_KEY`, the same key as localStorage on the web), as are the
// graph's extent and per scope its repo. No dragging or reordering of sections (no use on a phone). The computations are twins of
// the web sheets (Code/GitBarComputation.swift, Code/GitGraphComputation.swift), bound in web/test/git-bar-ios-binding.test.mjs.
// There are no button rows "Pull/Push/Fetch" or "Branches/History/Stashes": pull, push, fetch, branch switching and stashes are in
// the "…" of the repo, the graph shows the history.
//
// The chat: the git view of ONE chat (ChatGitButton) attaches `chat=<id>` to EVERY call (`chatQuery`) — the server then works in
// the instance of that chat, its copy, if it has moved in (devtools/routes.js targetInstance). Without the chat, the sheet of a
// copy chat would show main, and commit, discard, stash and checkout would run there. The copy then appears in the title
// ("Git · Copy k1"). Encoding happens in APIClient.makeURL, never here.
@MainActor
final class GitModel: ObservableObject {
    @Published var repos: [GitRepo] = []
    /// The selection in the "Repositories" section (`GitRepo.id`) — `nil` is the default: "Changes" shows all repos.
    @Published private(set) var selection: [String]? = nil
    /// A chosen repo vanished with a layout change — until the next own choice "Changes" shows none (a deleted repo empties the
    /// choice with a notice instead of jumping to the first).
    @Published var deletedRepo: String? = nil
    /// The explicit choice of the graph repo (remembered per scope) — otherwise `GitBar.graphRepo` computes it.
    @Published private(set) var graphChoice: String? = nil
    @Published private(set) var extent: GitGraph.Extent
    /// The collapsed sections (`GitBar.GIT_SECTIONS`).
    @Published private(set) var collapsed: Set<String>
    /// Expanded per repo under "Changes" (only with several): the user's choice, otherwise the default fixed at first sight.
    @Published var repoOpen: [String: Bool] = [:]
    private var defaultOpen: [String: Bool] = [:]
    /// The commit message draft per repo — it survives collapsing and changing the selection.
    @Published var messages: [String: String] = [:]
    @Published var branches: GitBranches?
    @Published var stashes: [GitStashEntry] = []
    @Published var loading = true
    @Published var busy = false
    @Published var error = ""
    /// Messages of the project containers ("Project starting …") — text of the server, without a key of its own.
    @Published var hint = ""
    /// Whether a fetch has ever SUCCEEDED — only then does "no repos" really mean "no repository".
    @Published var loaded = false
    @Published var diff: GitDiffPreview?
    /// The copy the state comes from ("k1") — only for a copy chat; the server names it in the tree (`instance`).
    @Published var copy: String?

    // ── The graph (drawn by Code/GitGraphSection.swift) ──
    @Published private(set) var graphLog: GitBar.GraphLog?
    @Published private(set) var graphError = ""
    @Published private(set) var graphLimit = GitBar.GRAPH_STEP
    /// Counts "Refresh" in the graph head and pull-down — the graph then reloads, even with an unchanged state.
    @Published private(set) var graphNew = 0
    /// Expanded commits (several at once, like VS Code) and their files per hash — a commit never changes.
    @Published private(set) var openCommits: Set<String> = []
    @Published private(set) var commitFiles: [String: CommitFilesStatus] = [:]
    /// What log, limit and expanded state stand for (repo + extent) — if it changes, everything starts over (like the `key` on the web).
    private var graphFor = ""

    enum CommitFilesStatus: Equatable {
        case loading
        case loaded(GitBar.CommitFiles)
        case error(String)
        /// The server does not know `files` yet (old version) — never "no files".
        case unknown
    }

    enum CommitKind { case commit, push, all, amend }

    struct GitDiffPreview: Identifiable {
        let id = UUID()
        let path: String
        let staged: Bool
        let text: String
        /// The server delivered only the beginning (`clipped` on the diff) — the sheet says so above the text.
        var truncated = false
        /// The short hash when the diff comes from a commit of the graph (the badge of the desktop).
        var commit: String? = nil
        /// The diff did not arrive — the sheet shows the reason instead of an empty text.
        var error: String? = nil
    }

    let client: APIClient
    let apiBase: String
    /// The chat whose instance this view shows (only on a project route) — nil on the Code page and in the workspace.
    let chatId: String?
    /// The chosen copy of the Code tab (`instance=<identifier>`, Code/CodeInstance.swift) — nil on the chat bar and in main.
    let instance: String?
    /// `chat=<id>` for every call, empty without a chat — plus `instance=<identifier>` of the Code tab's choice. No pre-encoding:
    /// APIClient.makeURL sets the query itself.
    private var chatQuery: [URLQueryItem] {
        (chatId.map { [URLQueryItem(name: "chat", value: $0)] } ?? []) + CodeInstance.query(instance)
    }
    /// Name of the examined folder (project or workspace) — shown in the empty state so that
    /// "no repository" is understandable and does not look like an error.
    let scopeName: String
    /// Every error of a fetch or an action goes here first (the instance choice of a chat's git view, Chat/ChatGitBar.swift): a 404
    /// `UNKNOWN_INSTANCE` of the chosen copy drops the choice there. The message stays what it was (`error`).
    var onError: ((Error) -> Void)?

    /// The key of the graph choice per scope (like `${GRAPH_REPO_KEY}:${path("")}` on the web: route, chat, instance).
    private var graphChoiceKey: String {
        "\(GitBar.GRAPH_REPO_KEY):\(apiBase)?chat=\(chatId ?? "")&instanz=\(instance ?? "")"
    }

    var keys: [String] { repos.map(\.id) }
    /// The repos "Changes" shows (in the tree's order).
    var shown: [GitRepo] { GitBar.shownRepos(repos, { $0.id }, selection) }
    /// The cleaned-up selection — `nil` if all are shown.
    var choice: [String]? { GitBar.tidySelection(selection, keys) }

    /// The repo of button, subtitle and short list: the first shown one.
    var repo: GitRepo? {
        if deletedRepo != nil { return nil }
        return shown.first
    }

    /// The repo of the graph: the choice in the head, otherwise the first shown one with a remote, otherwise the first shown one.
    var graphRepoObject: GitRepo? {
        let k = GitBar.graphRepo(keys, graphChoice, shown.map(\.id), repos.filter { $0.remote != nil }.map(\.id))
        return repos.first { $0.id == k }
    }

    func isCollapsed(_ section: String) -> Bool { collapsed.contains(section) }

    func toggle(_ section: String) {
        collapsed = GitBar.toggleCollapsed(collapsed, section)
        UserDefaults.standard.set(GitBar.writeCollapsed(collapsed), forKey: GitBar.SECTIONS_KEY)
    }

    /// A tap on a repo row: show exactly this one (a second tap on the only chosen one: all again), the graph follows.
    func select(_ key: String) {
        selection = GitBar.selectRepo(GitBar.tidySelection(selection, keys), key, false)
        setGraphChoice(key)
        deletedRepo = nil
    }

    func allShow() {
        selection = nil
        deletedRepo = nil
    }

    func setGraphChoice(_ key: String?) {
        graphChoice = key
        if let key { UserDefaults.standard.set(key, forKey: graphChoiceKey) } else { UserDefaults.standard.removeObject(forKey: graphChoiceKey) }
    }

    func setExtent(_ u: GitGraph.Extent) {
        extent = u
        UserDefaults.standard.set(u.rawValue, forKey: GitGraph.GRAPH_EXTENT_KEY)
    }

    /// Expanded under "Changes"? The user's choice, otherwise the default from first sight (`hasSomethingToDo`).
    func isOpen(_ r: GitRepo) -> Bool { repoOpen[r.id] ?? defaultOpen[r.id] ?? GitBar.hasSomethingToDo(r.situation) }

    /// After a taken-over layout (event `project/layout`, `kind: "finished"`): chosen repos move along, a deleted one empties the
    /// choice. Only on THIS project's route in main (a copy does not exist while a job is running).
    func afterLayout(_ end: LayoutEnd, prefix: String) {
        guard instance == nil else { return }
        let path = { (k: String) in k == "__root__" ? "" : k }
        let key = { (p: String) in p.isEmpty ? "__root__" : p }
        if let old = selection {
            var fresh: [String] = []
            for k in old {
                if let p = LayoutPaths.newPath(path(k), end, prefix: prefix) { fresh.append(key(p)) } else { deletedRepo = path(k) }
            }
            selection = fresh.isEmpty ? nil : fresh
        }
        if let g = graphChoice {
            setGraphChoice(LayoutPaths.newPath(path(g), end, prefix: prefix).map(key))
        }
        Task { await load(quiet: true) }
    }

    var hasRepo: Bool { !repos.isEmpty }

    init(client: APIClient, apiBase: String, scopeName: String = "", chatId: String? = nil, instance: String? = nil) {
        self.client = client
        self.apiBase = apiBase
        self.scopeName = scopeName
        self.instance = apiBase.hasPrefix("/api/projects/") ? instance.flatMap { $0.isEmpty ? nil : $0 } : nil
        // An instance has only one project route; the workspace never gets a chat (twin of `bindsChat`, lib/chat-instance.ts).
        self.chatId = apiBase.hasPrefix("/api/projects/") ? chatId.flatMap { $0.isEmpty ? nil : $0 } : nil
        let storage = UserDefaults.standard
        collapsed = GitBar.readCollapsed(storage.string(forKey: GitBar.SECTIONS_KEY))
        extent = GitGraph.readExtent(storage.string(forKey: GitGraph.GRAPH_EXTENT_KEY))
        graphChoice = GitBar.readGraphChoice(storage.string(forKey: graphChoiceKey))
    }

    /// `quiet` = background poll: no loading indicator and no assignment if nothing changed. The agent commits and restages files
    /// IN THE MIDDLE of a run; without the poll the view would show the state from opening until a pull-down. An unchanged
    /// assignment, on the other hand, would recompute the whole file list every six seconds.
    func load(quiet: Bool = false) async {
        if !quiet { loading = true }
        defer { if !quiet { loading = false } }
        do {
            let tree: GitTree = try await client.get("\(apiBase)/git", query: chatQuery)
            takeOver(tree)
            let newHint = tree.hints.joined(separator: "\n")
            if hint != newHint { hint = newHint }
            // Here too only on change: every assignment to a `@Published` redraws the whole sheet, even with the same value — and an
            // open menu (extent, graph repo) that the 6 s tick rebuilds mid-tap loses the tap. Measured in the XCUITest
            // (`GitUITests.testGraphShowsBranchesMergeAndBadges`): with unconditional assignments 4 of 5 runs were red (the menu
            // stayed open, `…/git/log` never arrived), without them 4 of 4 green.
            if !error.isEmpty { error = "" }
            if !loaded { loaded = true }
        } catch is CancellationError {
            // A cancellation is no error (see the measurement in Kit/CbRefresh.swift): the task that was loading no longer exists
            // (sheet closed, pull-down aborted). State and message stay as they were; the next poll loads again.
            return
        } catch {
            // KEEP the known state. `repos` used to be emptied — a failed fetch then looked exactly like "this folder has no
            // repository", and in the chat header the git symbol vanished with it. The view now tells the cases apart via
            // `loaded` and `error`.
            self.error = error.localizedDescription
            onError?(error)
        }
    }

    /// Pull-down: the tree and the graph (also with an unchanged state).
    func refresh() async {
        graphNew += 1
        await load()
    }

    private func takeOver(_ tree: GitTree) {
        if repos != tree.repos { repos = tree.repos }
        if copy != tree.copyName { copy = tree.copyName }
        // Fix the "expanded" default per repo at FIRST sight — afterwards only the user decides (as on the desktop).
        for r in tree.repos where defaultOpen[r.id] == nil { defaultOpen[r.id] = GitBar.hasSomethingToDo(r.situation) }
    }

    func loadBranches(_ r: GitRepo) async {
        branches = try? await client.get(
            "\(apiBase)/git/branches",
            query: [URLQueryItem(name: "repo", value: r.relPath)] + chatQuery
        )
    }

    func loadStashes(_ r: GitRepo) async {
        if let response: GitStashList = try? await client.get(
            "\(apiBase)/git/stashes",
            query: [URLQueryItem(name: "repo", value: r.relPath)] + chatQuery
        ) {
            stashes = response.stashes
        }
    }

    /// An action: the server answers with the fresh tree. Returns the error (nil = succeeded); `report` additionally puts it
    /// at the top of the sheet (the commit field shows its own below itself).
    @discardableResult
    private func run<Body: Encodable>(_ path: String, body: Body, report: Bool = true) async -> String? {
        busy = true
        defer { busy = false }
        do {
            let tree: GitTree = try await client.post("\(apiBase)/git/\(path)", query: chatQuery, body: body)
            takeOver(tree)
            error = ""
            return nil
        } catch is CancellationError {
            // Cancelled (the sheet closed), not failed — as in `load()`; the next fetch shows what the server did.
            return nil
        } catch {
            if report { self.error = error.localizedDescription }
            onError?(error)
            return error.localizedDescription
        }
    }

    private struct RepoBody: Encodable { let repo: String }

    func stage(_ r: GitRepo, _ files: [String]?) async {
        struct Body: Encodable { let repo: String; let files: [String]?; let all: Bool }
        await run("stage", body: Body(repo: r.relPath, files: files, all: files == nil))
    }

    func unstage(_ r: GitRepo, _ files: [String]?) async {
        struct Body: Encodable { let repo: String; let files: [String]?; let all: Bool }
        await run("unstage", body: Body(repo: r.relPath, files: files, all: files == nil))
    }

    /// Discard a file — `nil`: all changes of the working tree (untracked files are deleted).
    func discard(_ r: GitRepo, _ change: GitChange?) async {
        struct Body: Encodable { let repo: String; let file: String?; let untracked: Bool?; let all: Bool? }
        await run("discard", body: Body(repo: r.relPath, file: change?.path, untracked: change.map { $0.kind == "untracked" },
                                        all: change == nil ? true : nil))
    }

    /// Commit like the desktop's commit field (GitSidebar.tsx CommitArea): Commit = the staged ones, without staged all (smart commit);
    /// Amend takes ONLY staged ones, without a message the last commit keeps its own. Returns the error.
    func commit(_ r: GitRepo, kind: CommitKind) async -> String? {
        struct Body: Encodable { let repo: String; let message: String; let push: Bool; let all: Bool; let amend: Bool }
        let text = (messages[r.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if kind != .amend && text.isEmpty { return L("Please enter a commit message.") }
        let smartAll = r.staged.isEmpty
        let all = kind == .all || (kind != .amend && smartAll)
        let error = await run("commit", body: Body(repo: r.relPath, message: text, push: kind == .push, all: all, amend: kind == .amend), report: false)
        if error == nil { messages[r.id] = nil }
        return error
    }

    /// Sync like VS Code (`GitBar.syncSteps`): first pull, then push; nothing to do ⇒ fetch; without upstream push.
    func synchronize(_ r: GitRepo, report: Bool = true) async -> String? {
        for step in GitBar.syncSteps(r.situation) {
            if let error = await run(step, body: RepoBody(repo: r.relPath), report: report) { return error }
        }
        return nil
    }

    func pull(_ r: GitRepo) async { await run("pull", body: RepoBody(repo: r.relPath)) }
    func push(_ r: GitRepo) async { await run("push", body: RepoBody(repo: r.relPath)) }
    func fetch(_ r: GitRepo) async { await run("fetch", body: RepoBody(repo: r.relPath)) }
    func mergeAbort(_ r: GitRepo) async { await run("merge-abort", body: RepoBody(repo: r.relPath)) }

    func checkout(_ r: GitRepo, branch: String, create: Bool) async {
        struct Body: Encodable { let repo: String; let branch: String; let create: Bool }
        await run("checkout", body: Body(repo: r.relPath, branch: branch, create: create))
        await loadBranches(r)
    }

    func stash(_ r: GitRepo, includeUntracked: Bool, message: String) async {
        struct Body: Encodable { let repo: String; let includeUntracked: Bool; let message: String }
        await run("stash", body: Body(repo: r.relPath, includeUntracked: includeUntracked, message: message))
        await loadStashes(r)
    }

    func stashOp(_ r: GitRepo, _ op: String, ref: String) async {
        struct Body: Encodable { let repo: String; let op: String; let ref: String }
        await run("stash/op", body: Body(repo: r.relPath, op: op, ref: ref))
        await loadStashes(r)
    }

    func showDiff(_ r: GitRepo, _ change: GitChange, staged: Bool) async {
        struct Body: Encodable { let repo: String; let file: String; let staged: Bool }
        if let response: GitDiffResponse = try? await client.post(
            "\(apiBase)/git/diff",
            query: chatQuery,
            body: Body(repo: r.relPath, file: change.path, staged: staged)
        ) {
            diff = GitDiffPreview(path: change.path, staged: staged, text: response.diff)
        }
    }

    // ── The graph ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

    /// Reloads the graph of repo `r` (the section calls it when it is open and repo, extent, state or "Refresh" change — no poll
    /// of its own). Another repo or another extent starts from scratch.
    func loadGraph(_ r: GitRepo) async {
        let forKey = "\(r.id)\u{0}\(extent.rawValue)"
        if forKey != graphFor {
            graphFor = forKey
            graphLog = nil
            graphError = ""
            graphLimit = GitBar.GRAPH_STEP
            openCommits = []
            commitFiles = [:]
        }
        await fetchGraph(r, forKey: forKey)
    }

    /// "Load more": the same list longer (`GitGraph.loadMore` computes the next limit).
    func loadMore(_ r: GitRepo, limit: Int) async {
        graphLimit = limit
        await fetchGraph(r, forKey: graphFor)
    }

    private func fetchGraph(_ r: GitRepo, forKey: String) async {
        struct Body: Encodable { let repo: String; let limit: Int; let graph: String }
        do {
            let raw: JSONValue = try await client.post(
                "\(apiBase)/git/log",
                query: chatQuery,
                body: Body(repo: r.relPath, limit: graphLimit, graph: extent.rawValue)
            )
            guard forKey == graphFor else { return }
            let log = GitBar.normGitGraphLog(raw)
            if graphLog != log { graphLog = log }
            if !graphError.isEmpty { graphError = "" }
        } catch is CancellationError {
            return
        } catch {
            if forKey == graphFor { graphError = error.localizedDescription }
        }
    }

    /// Expand or collapse a commit; on first expansion (or after an error/"unknown") fetch its files.
    func toggleCommit(_ r: GitRepo, _ c: GitBar.GraphEntry) async {
        if openCommits.contains(c.hash) { openCommits.remove(c.hash); return }
        openCommits.insert(c.hash)
        switch commitFiles[c.hash] {
        case .loaded?, .loading?: return
        default: break
        }
        struct Body: Encodable { let repo: String; let hash: String; let files: Bool }
        let forKey = graphFor
        commitFiles[c.hash] = .loading
        do {
            let raw: JSONValue = try await client.post("\(apiBase)/git/show", query: chatQuery, body: Body(repo: r.relPath, hash: c.hash, files: true))
            guard forKey == graphFor else { return }
            commitFiles[c.hash] = GitBar.normGitCommitFiles(raw).map { .loaded($0) } ?? .unknown
        } catch is CancellationError {
            if forKey == graphFor { commitFiles[c.hash] = nil }
        } catch {
            if forKey == graphFor { commitFiles[c.hash] = .error(error.localizedDescription) }
        }
    }

    /// The whole commit (`/git/show` without options, as before).
    func showCommit(_ r: GitRepo, _ c: GitBar.GraphEntry) async {
        struct Body: Encodable { let repo: String; let hash: String }
        let title = c.subject.isEmpty ? c.hash : c.subject
        do {
            let raw: JSONValue = try await client.post("\(apiBase)/git/show", query: chatQuery, body: Body(repo: r.relPath, hash: c.hash))
            guard case .object(let o) = raw, case .string(let text)? = o["diff"] else {
                diff = GitDiffPreview(path: title, staged: false, text: "", commit: c.short, error: L("The server sent no diff."))
                return
            }
            diff = GitDiffPreview(path: title, staged: false, text: text, commit: c.short)
        } catch is CancellationError {
            return
        } catch {
            diff = GitDiffPreview(path: title, staged: false, text: "", commit: c.short, error: error.localizedDescription)
        }
    }

    /// The diff of ONE file in this commit (against the first parent); the graph's file row computes `file`/`old`
    /// (`GitBar.diffPath`, Code/GitGraphSection.swift `GitCommitFileRow.target`).
    func showCommitFile(_ r: GitRepo, _ c: GitBar.GraphEntry, file: String, old: String?, title: String) async {
        struct Body: Encodable { let repo: String; let hash: String; let file: String; let old: String? }
        do {
            let raw: JSONValue = try await client.post("\(apiBase)/git/show", query: chatQuery,
                                                         body: Body(repo: r.relPath, hash: c.hash, file: file, old: old))
            guard let part = GitBar.normGitCommitFileDiff(raw, file) else {
                diff = GitDiffPreview(path: title, staged: false, text: "", commit: c.short,
                                      error: L("The server does not know the diff of a single file yet (after its next deploy) — \"Show whole commit\" works."))
                return
            }
            diff = GitDiffPreview(path: title, staged: false, text: part.diff, truncated: part.clipped == true, commit: c.short)
        } catch is CancellationError {
            return
        } catch {
            diff = GitDiffPreview(path: title, staged: false, text: "", commit: c.short, error: error.localizedDescription)
        }
    }
}

struct GitStashEntry: Codable, Identifiable, Hashable, Sendable {
    var id: String { ref }
    var ref: String
    var message: String
    var relative: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = c.str(.ref)
        message = c.str(.message)
        relative = c.str(.relative)
    }
}

struct GitStashList: Codable, Sendable {
    var stashes: [GitStashEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stashes = c.list(.stashes, GitStashEntry.self)
    }
}

extension GitRepo {
    /// The narrow shape the bound computations work with (Code/GitBarComputation.swift `RepoSituation`).
    var situation: GitBar.RepoSituation {
        GitBar.RepoSituation(branch: branch, detached: detached, upstream: upstream, ahead: Double(ahead), behind: Double(behind),
                           remote: remote != nil, statusError: statusError, countsTotal: counts.map { Double($0.total) },
                           changes: changes.count)
    }

    /// Staged (index) — like `stagedOf` of the web bar; a conflict appears only under "Merge Changes".
    var staged: [GitChange] {
        changes.filter { !$0.x.trimmingCharacters(in: .whitespaces).isEmpty && $0.x != "?" && $0.kind != "conflict" }
    }

    /// Changed in the working tree, also untracked — like `unstagedOf`; a file with both sides appears in both groups.
    var notStaged: [GitChange] {
        changes.filter { !$0.y.trimmingCharacters(in: .whitespaces).isEmpty && $0.kind != "conflict" }
    }

    var conflicts: [GitChange] { changes.filter { $0.kind == "conflict" } }

    /// Push has something to do: commits ahead, or a remote without upstream (push sets it).
    var canPush: Bool { ahead > 0 || (remote != nil && (upstream ?? "").isEmpty) }

    var displayName: String { name.isEmpty ? "/" : name }
}

struct GitPane: View {
    @ObservedObject var model: GitModel
    /// The instance choice in the head (only the git sheet of a chat, Chat/ChatGitBar.swift) — if it is there, IT names the
    /// instance, and the title stays "Git" (otherwise "Copy k1" would appear twice in a line). Without it the title as before.
    var headerAddition: AnyView? = nil
    /// A notice of the instance choice above the content (fallback to the chat, copy not ready right now).
    var hintAddition: AnyView? = nil
    /// Before the title — in a chat's git sheet the ✕ (`SheetCloseButton`).
    var headerFront: AnyView? = nil
    @Environment(\.scenePhase) private var scenePhase
    /// The repo whose branches or stashes are currently in the sheet.
    @State private var branchRepo: GitRepo?
    @State private var stashRepo: GitRepo?

    var body: some View {
        PaneScaffold(
            title: headerAddition != nil ? "Git" : model.copy.map { L("Git · Copy {name}", ["name": $0]) } ?? "Git",
            subtitle: model.repo.map { repo in
                repo.detached ? L("(detached)") : repo.branch
            } ?? (!model.error.isEmpty ? L("Unavailable") : model.hint.isEmpty ? L("No Git repository") : nil),
            trailing: headerAddition,
            leading: headerFront
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 8) {
                        if let hintAddition { hintAddition }
                        InlineError(message: model.error)
                        if !model.hint.isEmpty {
                            Text(model.hint).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.bottom, 4)

                    if model.loading && model.repos.isEmpty {
                        ListLoadingSkeleton(rows: 3)
                    } else if !model.hasRepo && !model.error.isEmpty {
                        // A failed fetch is NOT "no repository" — the message
                        // is at the top in the InlineError.
                        EmptyPaneState(
                            title: L("Git status unavailable"),
                            message: L("Pull down to try again."),
                            systemImage: "exclamationmark.triangle"
                        )
                    } else if !model.hasRepo && model.hint.isEmpty {
                        EmptyPaneState(
                            title: L("No Git repository"),
                            message: model.scopeName.isEmpty
                                ? L("There is no repository in this folder.")
                                : L("There is none in “{folder}” — nor in any subfolder.", ["folder": model.scopeName]),
                            systemImage: "arrow.triangle.branch"
                        )
                    } else if model.hasRepo {
                        sections
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
            // Through `cbRefreshable`, not `.refreshable` (Kit/CbRefresh.swift): `load()` sets `loading`, that redraws the
            // view, and SwiftUI cancelled the pull-down task in the middle of the request.
            .cbRefreshable { await model.refresh() }
        }
        .task { await model.load() }
        // Poll as in the desktop client's git sidebar (6 s) — the agent changes the tree in the middle of a run, and there is
        // no server event for it. The task ends with the view, so nothing keeps running in the background.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                if Task.isCancelled { break }
                await model.load(quiet: true)
            }
        }
        // Back from the background: at once instead of at the next poll.
        .onChange(of: scenePhase) {
            if scenePhase == .active { Task { await model.load(quiet: true) } }
        }
        .sheet(item: $model.diff) { preview in
            GitDiffSheet(preview: preview).cbSheet(.whole)
        }
        .sheet(item: $branchRepo) { r in
            GitBranchesSheet(model: model, repo: r).cbSheet(.whole)
        }
        .sheet(item: $stashRepo) { r in
            GitStashSheet(model: model, repo: r).cbSheet(.whole)
        }
    }

    // ── The three sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

    private var actions: GitRepoActions {
        GitRepoActions(model: model, branches: { branchRepo = $0 }, stashes: { stashRepo = $0 })
    }

    @ViewBuilder
    private var sections: some View {
        let several = model.repos.count > 1
        let shown = model.shown
        if several {
            GitSectionHeader(id: "repos", title: L("Repositories"), closed: model.isCollapsed("repos"), toggle: { model.toggle("repos") }) {
                if let choice = model.choice {
                    Text(L("{n} of {m}", ["n": choice.count, "m": model.repos.count]))
                        .cbFont(12).monospacedDigit().foregroundStyle(CbColor.textMuted)
                    Button(L("Show all")) { model.allShow() }
                        .cbFont(13, weight: .medium)
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .accessibilityIdentifier("git-repos-all")
                }
            }
            if !model.isCollapsed("repos") {
                VStack(spacing: 2) {
                    ForEach(model.repos) { r in
                        GitRepoRow(repo: r, selected: model.choice?.contains(r.id) ?? false, actions: actions)
                    }
                }
                .padding(.bottom, 8)
            }
            CbHairline()
        }

        let sole = model.repos[0]
        GitSectionHeader(id: "changes", title: L("Changes"), closed: model.isCollapsed("changes"),
                         count: shown.reduce(0) { $0 + ($1.counts?.total ?? $1.changes.count) },
                         toggle: { model.toggle("changes") }) {
            if !several {
                GitRepoState(repo: sole, actions: actions)
                GitRepoMenu(repo: sole, actions: actions)
            }
        }
        if !model.isCollapsed("changes") {
            VStack(alignment: .leading, spacing: 4) {
                if let deleted = model.deletedRepo {
                    // The chosen repo vanished with the layout change — preselect none, but say what happened.
                    Text(L("The repo “{repo}” was deleted with the outline — please pick another one.", ["repo": deleted]))
                        .cbFont(14).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    if !several {
                        Button(L("Choose a repository")) { model.select(sole.id) }
                            .cbFont(14, weight: .medium)
                            .accessibilityIdentifier("git-repo-choice")
                    }
                } else if several {
                    ForEach(shown) { r in
                        GitRepoChanges(repo: r, actions: actions)
                    }
                } else {
                    GitRepoBody(repo: sole, actions: actions, indented: false)
                }
            }
            .padding(.bottom, 10)
        }
        CbHairline()

        GitGraphSection(model: model)
    }
}

/// What a repo's rows need: the model, and how the branch and stash sheets open (they hang on the GitPane).
struct GitRepoActions {
    let model: GitModel
    let branches: (GitRepo) -> Void
    let stashes: (GitRepo) -> Void
}

// ── Head of a section ──────────────────────────────────────────────────────────────────────────────────────────────────────
/// Chevron and title toggle (identifier `git-section-<id>`, value "expanded"/"collapsed"); collapsed the count behind it; on the
/// right the section's controls — own buttons BESIDE the toggle, never inside it (a tap on them would otherwise collapse too).
struct GitSectionHeader<Right: View>: View {
    let id: String
    let title: String
    let closed: Bool
    var count: Int? = nil
    let toggle: () -> Void
    @ViewBuilder var right: () -> Right

    var body: some View {
        HStack(spacing: 8) {
            Button(action: { withAnimation(.easeOut(duration: 0.18)) { toggle() } }) {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.symbol(11, weight: .semibold))
                        .foregroundStyle(CbColor.textMuted)
                        .rotationEffect(.degrees(closed ? 0 : 90))
                    Text(title)
                        .cbFont(15, weight: .semibold)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                    if closed, let count, count > 0 { GitCounter(n: count) }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityValue(closed ? L("collapsed") : L("expanded"))
            .accessibilityIdentifier("git-section-\(id)")
            right()
        }
    }
}

/// The count badge (like the count behind "Changes" in VS Code).
struct GitCounter: View {
    let n: Int

    var body: some View {
        Text(verbatim: "\(n)")
            .cbFont(11, weight: .semibold)
            .monospacedDigit()
            .foregroundStyle(CbColor.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(CbGlass.inside, in: Capsule())
    }
}

/// A small round button with a symbol (head of a section, file row) — glass like the buttons of the chat head zone.
struct GitSymbolButton: View {
    let systemImage: String
    let label: String
    var size: CGFloat = 30
    var destructive = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.symbol(12, weight: .semibold))
                .foregroundStyle(destructive ? Color.red : CbColor.textSecondary)
                .frame(width: size, height: size)
                .cbGlassButton(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .accessibilityLabel(label)
    }
}

/// The label of a menu in the head (round, glass) — the same shape as `GitSymbolButton`.
struct GitMenuButton: View {
    var systemImage = "ellipsis"

    var body: some View {
        Image(systemName: systemImage)
            .font(.symbol(12, weight: .semibold))
            .foregroundStyle(CbColor.textSecondary)
            .frame(width: 30, height: 30)
            .cbGlassButton(Circle())
    }
}

// ── Repositories ───────────────────────────────────────────────────────────────────────────────────────────────────────────
struct GitRepoRow: View {
    let repo: GitRepo
    let selected: Bool
    let actions: GitRepoActions

    var body: some View {
        HStack(spacing: 6) {
            Button { actions.model.select(repo.id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "book.closed")
                        .font(.symbol(13))
                        .foregroundStyle(CbColor.textMuted)
                    Text(repo.displayName)
                        .cbFont(15)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(repo.displayName)
            .accessibilityValue(selected ? L("selected") : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("git-repo-\(repo.id)")
            GitRepoState(repo: repo, actions: actions)
            GitRepoMenu(repo: repo, actions: actions)
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .background {
            if selected { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(CbGlass.selected) }
        }
    }
}

/// Branch (symbol, name, "*" with changes or "!" with a failed status — a tap opens the switcher) and the sync button.
struct GitRepoState: View {
    let repo: GitRepo
    let actions: GitRepoActions
    @State private var syncRunning = false

    var body: some View {
        let local = (repo.upstream ?? "").isEmpty && !repo.detached && !repo.branch.isEmpty
        let marker = repo.statusError != nil ? "!" : GitBar.hasChanges(repo.situation) ? "*" : ""
        HStack(spacing: 4) {
            Button { actions.branches(repo) } label: {
                HStack(spacing: 4) {
                    Image(systemName: local ? "laptopcomputer" : "arrow.triangle.branch")
                        .font(.symbol(11))
                    Text(repo.branch.isEmpty ? "—" : repo.branch)
                        .cbFont(12, design: .monospaced)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !marker.isEmpty {
                        Text(verbatim: marker)
                            .cbFont(12, weight: .bold, design: .monospaced)
                            .foregroundStyle(marker == "!" ? Color.orange : CbColor.textMuted)
                    }
                }
                .foregroundStyle(CbColor.textSecondary)
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(repo.detached ? L("Detached HEAD") : L("Branch {name}", ["name": repo.branch]))
            .accessibilityHint(L("Switch or create a branch"))
            .accessibilityIdentifier("git-branch-\(repo.id)")
            if !GitBar.syncSteps(repo.situation).isEmpty {
                let publish = (repo.upstream ?? "").isEmpty
                Button {
                    syncRunning = true
                    Task { _ = await actions.model.synchronize(repo); syncRunning = false }
                } label: {
                    HStack(spacing: 2) {
                        Image(systemName: publish ? "icloud.and.arrow.up" : "arrow.triangle.2.circlepath")
                            .font(.symbol(12, weight: .semibold))
                            .symbolEffect(.rotate, isActive: syncRunning && !publish)
                        if !publish && repo.behind > 0 { Text(verbatim: "\(repo.behind)↓").cbFont(11).monospacedDigit() }
                        if !publish && repo.ahead > 0 { Text(verbatim: "\(repo.ahead)↑").cbFont(11).monospacedDigit() }
                    }
                    .foregroundStyle(CbColor.textSecondary)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 30)
                    .cbGlassButton(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(syncRunning || actions.model.busy)
                .accessibilityLabel(publish
                    ? L("Publish Branch")
                    : L("Sync Changes ({behind}↓ {ahead}↑)", ["behind": repo.behind, "ahead": repo.ahead]))
                .accessibilityIdentifier("git-sync-\(repo.id)")
            }
        }
    }
}

/// The "…" of a repo: the actions that used to be button rows in the sheet.
struct GitRepoMenu: View {
    let repo: GitRepo
    let actions: GitRepoActions
    @Environment(\.openURL) private var openURL

    var body: some View {
        let m = actions.model
        Menu {
            Button { actions.branches(repo) } label: { Label(L("Switch branch…"), systemImage: "arrow.triangle.branch") }
            Divider()
            Button { Task { await m.pull(repo) } } label: {
                Label(repo.behind > 0 ? L("Pull ({behind} behind)", ["behind": repo.behind]) : L("Pull"), systemImage: "arrow.down")
            }
            .disabled(repo.remote == nil)
            Button { Task { await m.push(repo) } } label: {
                Label(repo.remote != nil && (repo.upstream ?? "").isEmpty ? L("Push (set upstream)") : L("Push"), systemImage: "arrow.up")
            }
            .disabled(!repo.canPush)
            Button { Task { await m.fetch(repo) } } label: { Label(L("Fetch"), systemImage: "icloud.and.arrow.down") }
                .disabled(repo.remote == nil)
            Divider()
            Button { Task { await m.stash(repo, includeUntracked: true, message: "") } } label: {
                Label(L("Stash changes"), systemImage: "tray.and.arrow.down")
            }
            .disabled(!GitBar.hasChanges(repo.situation))
            Button { actions.stashes(repo) } label: { Label(L("Stashes …"), systemImage: "tray.full") }
            if !repo.conflicts.isEmpty {
                Button(role: .destructive) { Task { await m.mergeAbort(repo) } } label: {
                    Label(L("Abort merge"), systemImage: "xmark.circle")
                }
            }
            if let web = repo.remote?.webUrl, let url = URL(string: web), !web.isEmpty {
                Divider()
                Button { openURL(url) } label: { Label(L("Open in browser"), systemImage: "safari") }
            }
        } label: {
            GitMenuButton()
        }
        .accessibilityLabel(L("More actions: {name}", ["name": repo.displayName]))
        .accessibilityIdentifier("git-repo-menu-\(repo.id)")
    }
}

// ── Changes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/// With several repos: one head per repo (expandable, clean ones start closed) and below it its body. The expanded body hangs on
/// a vertical line under the chevron (like VS Code's indent line and `RepoBody` on the desktop) — it says which section belongs
/// to which repo. The chevron's center is measured, not estimated; head and body keep their layout.
struct GitRepoChanges: View {
    let repo: GitRepo
    let actions: GitRepoActions
    @State private var chevronMiddle: CGFloat?

    var body: some View {
        let m = actions.model
        let open = m.isOpen(repo)
        let space = "git-repo-\(repo.id)"
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Button { m.repoOpen[repo.id] = !open } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "chevron.right")
                            .font(.symbol(10, weight: .semibold))
                            .foregroundStyle(CbColor.textMuted)
                            .rotationEffect(.degrees(open ? 90 : 0))
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(space)).midX } action: { chevronMiddle = $0 }
                        Image(systemName: "book.closed")
                            .font(.symbol(12))
                            .foregroundStyle(CbColor.textMuted)
                        Text(repo.displayName)
                            .cbFont(14, weight: .medium)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(1)
                        let n = repo.counts?.total ?? repo.changes.count
                        if !open && n > 0 { GitCounter(n: n) }
                        Spacer(minLength: 4)
                    }
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(repo.displayName)
                .accessibilityValue(open ? L("expanded") : L("collapsed"))
                .accessibilityIdentifier("git-repo-changes-\(repo.id)")
                GitRepoState(repo: repo, actions: actions)
                GitRepoMenu(repo: repo, actions: actions)
            }
            if open {
                GitRepoBody(repo: repo, actions: actions, indented: true)
                    .overlay(alignment: .leading) {
                        if let x = chevronMiddle {
                            Rectangle()
                                .fill(CbColor.edge)
                                .frame(width: 1)
                                .offset(x: x - 0.5)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
            }
        }
        .coordinateSpace(.named(space))
    }
}

/// The body of a repo: commit field, then Merge Changes · Staged Changes · Changes (the titles as in VS Code and on the desktop).
struct GitRepoBody: View {
    let repo: GitRepo
    let actions: GitRepoActions
    let indented: Bool
    @State private var dismiss: GitChange?
    @State private var allDismiss = false

    var body: some View {
        let m = actions.model
        let staged = repo.staged
        let unstaged = repo.notStaged
        let conflicts = repo.conflicts
        let clean = staged.isEmpty && unstaged.isEmpty && conflicts.isEmpty
        VStack(alignment: .leading, spacing: 2) {
            GitCommitField(model: m, repo: repo, sole: m.repos.count == 1)
                .padding(.bottom, 6)

            if !conflicts.isEmpty {
                GitGroupsHeader(title: "Merge Changes", count: conflicts.count) {
                    GitSymbolButton(systemImage: "checkmark", label: L("Mark all as resolved (stage)"), size: 28) {
                        Task { await m.stage(repo, conflicts.map(\.path)) }
                    }
                }
                ForEach(conflicts) { c in
                    GitFileRow(change: c, diff: { Task { await m.showDiff(repo, c, staged: false) } }) {
                        GitSymbolButton(systemImage: "checkmark", label: L("Mark as resolved (stage)"), size: 28) {
                            Task { await m.stage(repo, [c.path]) }
                        }
                    }
                }
                Button(role: .destructive) { Task { await m.mergeAbort(repo) } } label: {
                    Text(L("Abort merge")).cbFont(14, weight: .medium).frame(maxWidth: .infinity, minHeight: 36)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
                .accessibilityIdentifier("git-merge-abort")
            }

            if !staged.isEmpty {
                GitGroupsHeader(title: "Staged Changes", count: staged.count) {
                    GitSymbolButton(systemImage: "minus", label: L("Unstage all"), size: 28) { Task { await m.unstage(repo, nil) } }
                        .accessibilityIdentifier("git-all-back")
                }
                ForEach(staged) { c in
                    GitFileRow(change: c, diff: { Task { await m.showDiff(repo, c, staged: true) } }) {
                        GitSymbolButton(systemImage: "minus", label: L("Undo"), size: 28) { Task { await m.unstage(repo, [c.path]) } }
                    }
                }
            }

            // "Changes" also carries the untracked files; empty only if EVERYTHING is clean — then as an empty row.
            if !unstaged.isEmpty || clean {
                GitGroupsHeader(title: "Changes", count: unstaged.isEmpty ? nil : unstaged.count) {
                    if !unstaged.isEmpty {
                        GitSymbolButton(systemImage: "arrow.uturn.backward", label: L("Discard all changes"), size: 28, destructive: true) {
                            allDismiss = true
                        }
                        GitSymbolButton(systemImage: "plus", label: L("Stage all"), size: 28) { Task { await m.stage(repo, nil) } }
                            .accessibilityIdentifier("git-all-stage")
                    }
                }
                if unstaged.isEmpty {
                    // A failed status is unknown, not "no changes" (text from the server, translated).
                    Text(repo.statusError ?? L("Working tree clean"))
                        .cbFont(13)
                        .foregroundStyle(repo.statusError != nil ? Color.orange : CbColor.textMuted)
                        .padding(.leading, 18)
                        .frame(minHeight: 32)
                        .accessibilityIdentifier("git-clean")
                }
                ForEach(unstaged) { c in
                    GitFileRow(change: c, diff: { Task { await m.showDiff(repo, c, staged: false) } }) {
                        GitSymbolButton(systemImage: "arrow.uturn.backward", label: L("Dismiss"), size: 28, destructive: true) { dismiss = c }
                        GitSymbolButton(systemImage: "plus", label: L("Stage"), size: 28) { Task { await m.stage(repo, [c.path]) } }
                    }
                }
            }
        }
        .padding(.leading, indented ? 16 : 0)
        .padding(.bottom, indented ? 8 : 0)
        .confirmationDialog(
            dismiss.map { L("Discard “{name}”? This cannot be undone.", ["name": GitBar.partsPath($0.path).name]) } ?? "",
            isPresented: Binding(get: { dismiss != nil }, set: { if !$0 { dismiss = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Dismiss"), role: .destructive) {
                if let c = dismiss { Task { await m.discard(repo, c) } }
                dismiss = nil
            }
        }
        .confirmationDialog(
            L("Discard all {n} changes? Untracked files will be deleted. This cannot be undone.", ["n": unstaged.count]),
            isPresented: $allDismiss,
            titleVisibility: .visible
        ) {
            Button(L("Discard all changes"), role: .destructive) { Task { await m.discard(repo, nil) } }
        }
    }
}

/// The head of a group ("Staged Changes", "Changes"): title, count, on the right the actions for all files of the group.
struct GitGroupsHeader<Actions: View>: View {
    let title: String
    var count: Int? = nil
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: 6) {
            Text(L(title))
                .cbFont(13, weight: .semibold)
                .foregroundStyle(CbColor.textSecondary)
            if let count { GitCounter(n: count) }
            Spacer(minLength: 4)
            actions()
        }
        .frame(minHeight: 36)
        .padding(.top, 4)
        .accessibilityElement(children: .contain)
    }
}

/// A file row: name (mono), folder muted, the actions, on the right the status letter in the color of its kind. A tap shows the
/// diff. The identifier `git-change-<path>` sits on the whole row and goes to every child — the buttons differ by their
/// label ("Stage", "Discard", "Unstage").
struct GitFileRow<Actions: View>: View {
    let change: GitChange
    let diff: () -> Void
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        let (name, folder) = GitBar.partsPath(change.path)
        HStack(spacing: 6) {
            Button(action: diff) {
                HStack(spacing: 6) {
                    Text(name)
                        .cbFont(13, design: .monospaced)
                        .strikethrough(change.kind == "deleted")
                        .foregroundStyle(change.kind == "deleted" ? CbColor.textMuted : CbColor.text)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Text(folder)
                        .cbFont(12)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 2)
                }
                .frame(minHeight: 38)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("{label}: {path} — tap for diff", ["label": L(change.label), "path": change.path]))
            actions()
            Text(verbatim: GitBar.KIND_LETTER[change.kind] ?? change.code)
                .cbFont(12, weight: .bold, design: .monospaced)
                .foregroundStyle(GitKindColor.color(change.kind))
                .frame(width: 14)
        }
        .padding(.leading, 18)
        .accessibilityIdentifier("git-change-\(change.path)")
    }
}

/// The color of a kind (web `KIND_COLOR`): modified warning, new ok, deleted and conflict danger, renamed accent.
enum GitKindColor {
    static func color(_ kind: String?) -> Color {
        switch kind {
        case "modified": return .orange
        case "added", "untracked": return .green
        case "deleted", "conflict": return .red
        case "renamed": return .accentColor
        default: return CbColor.textMuted
        }
    }
}

/// The commit field: growing field, wide primary button (`GitBar.primaryButton`), on the right set apart the menu with Commit & Push,
/// Commit All, Amend — it stays reachable in every kind (Amend changes the message even without changes).
struct GitCommitField: View {
    @ObservedObject var model: GitModel
    let repo: GitRepo
    /// The only repo: the identifiers stay `git-commit-message`/`git-commit`, otherwise with the repo.
    let sole: Bool
    @State private var running = false
    @State private var error = ""

    private var identifier: String { sole ? "" : "-\(repo.id)" }

    var body: some View {
        let p = GitBar.primaryButton(repo.situation)
        let text = (model.messages[repo.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let smartAll = repo.staged.isEmpty
        let active = p != .nothing
        let comesNothing: Bool = { if case .commit = p { return false } else { return true } }()
        let amendEmpty = smartAll && text.isEmpty
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                repo.branch.isEmpty || repo.detached
                    ? L("Message")
                    : L("Message (commit on “{branch}”)", ["branch": repo.branch]),
                text: Binding(get: { model.messages[repo.id] ?? "" }, set: { model.messages[repo.id] = $0.isEmpty ? nil : $0; error = "" }),
                axis: .vertical
            )
            .lineLimit(1...5)
            .cbFont(14)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .cbGlass(RoundedRectangle(cornerRadius: 16, style: .continuous)) {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(CbColor.elevated)
            }
            .accessibilityIdentifier("git-commit-message\(identifier)")

            CbGlassGroup(gap: 4) {
                HStack(spacing: 4) {
                    Button { primary(p) } label: {
                        HStack(spacing: 6) {
                            if running {
                                ProgressView().controlSize(.small)
                            } else {
                                switch p {
                                case .publish:
                                    Image(systemName: "icloud.and.arrow.up").font(.symbol(13, weight: .semibold))
                                    Text(L("Publish Branch")).lineLimit(1)
                                case .synchronize(let ahead, let behind):
                                    Image(systemName: "arrow.triangle.2.circlepath").font(.symbol(13, weight: .semibold))
                                    Text(L("Sync Changes")).lineLimit(1)
                                    if behind > 0 { Text(verbatim: "\(behind)↓").monospacedDigit().opacity(0.85) }
                                    if ahead > 0 { Text(verbatim: "\(ahead)↑").monospacedDigit().opacity(0.85) }
                                default:
                                    Image(systemName: "checkmark").font(.symbol(13, weight: .semibold))
                                    Text(L("Commit"))
                                }
                            }
                        }
                        .cbFont(14, weight: .semibold)
                        .foregroundStyle(active ? CbColor.primaryButtonText : CbColor.textMuted)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .contentShape(Capsule())
                        .cbGlass(Capsule(), interactive: true, tint: active ? CbColor.primaryButton : nil) {
                            Capsule().fill(active ? CbColor.primaryButton : CbColor.elevated)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!active || running || model.busy)
                    .accessibilityLabel(title(p, smartAll: smartAll))
                    .accessibilityIdentifier("git-commit\(identifier)")

                    Menu {
                        Button(L("Commit & Push")) { commit(.push) }
                            .disabled(text.isEmpty || running || comesNothing)
                        Button(L("Commit All")) { commit(.all) }
                            .disabled(text.isEmpty || running || comesNothing)
                        Button(L("Amend")) { commit(.amend) }
                            .disabled(running || amendEmpty)
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.symbol(12, weight: .semibold))
                            .foregroundStyle(active ? CbColor.primaryButtonText : CbColor.textSecondary)
                            .frame(width: 44, height: 40)
                            .contentShape(Capsule())
                            .cbGlass(Capsule(), interactive: true, tint: active ? CbColor.primaryButton : nil) {
                                Capsule().fill(active ? CbColor.primaryButton : CbColor.elevated)
                            }
                    }
                    .accessibilityLabel(L("More commit actions"))
                    .accessibilityIdentifier("git-commit-menu\(identifier)")
                }
            }

            if !error.isEmpty {
                Text(error)
                    .cbFont(12)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("git-commit-error\(identifier)")
            }
        }
    }

    private func title(_ p: GitBar.Primary, smartAll: Bool) -> String {
        switch p {
        case .publish: return L("Publish Branch")
        case .synchronize(let ahead, let behind): return L("Sync Changes ({behind}↓ {ahead}↑)", ["behind": behind, "ahead": ahead])
        case .nothing: return L("Nothing to commit")
        case .commit: return smartAll ? L("Commit (nothing staged — commits all changes)") : L("Commit")
        }
    }

    private func primary(_ p: GitBar.Primary) {
        switch p {
        case .publish, .synchronize:
            running = true
            Task {
                let f = await model.synchronize(repo, report: false)
                error = f ?? ""
                running = false
            }
        case .commit:
            commit(.commit)
        case .nothing:
            error = L("Nothing to commit.")
        }
    }

    private func commit(_ kind: GitModel.CommitKind) {
        guard !running else { return }
        running = true
        error = ""
        Task {
            let f = await model.commit(repo, kind: kind)
            error = f ?? ""
            running = false
        }
    }
}

// ── Git in the chat ─────────────────────────────────────────────────────────
// In the desktop client a git sidebar sits next to a chat that belongs to a project with a repository. A phone has no room beside
// it, so git sits as a symbol in the chat header (the target symbol also appears conditionally there) and opens a half-height
// sheet: the chat stays visible behind it, swiping away leads back — the mobile counterpart of "beside". The count on the symbol
// shows the open changes without opening it.
//
// Visible by the same rules as in the desktop client: in the entered project, or when the open chat is assigned to a project (also
// from the workspace view). Without a repository in the folder nothing shows — checked against the actual state, not guessed.
//
// With instance choice (Chat/ChatGitBar.swift): in the head of the sheet one chooses main or a copy of the project; without a
// choice the chat's instance as before. The model belongs to the choice (`bar.git`) and is replaced with it; button and count read
// the same.
struct ChatGitButton: View {
    @StateObject private var bar: ChatGitBar
    @State private var showing = false
    @Environment(\.scenePhase) private var scenePhase
    /// Counts finished runs: the agent changes files, so reload afterwards.
    let runsFinished: Int
    /// Counts the events `project/instance` and `project/copy` of this project (AppState `instanceEvents`) — the choice rereads the project list.
    let instanceEvent: Int
    /// The chat's binding (`chat.instance`) — a change drops a remembered choice and rereads the chat-bound tree
    /// (`ChatGitBar.bindingChanged`).
    let binding: String?

    /// `chatId`: the chat whose git state the sheet shows — in a copy chat that of its copy.
    init(client: APIClient, projectId: String, projectName: String, chatId: String?, binding: String?, runsFinished: Int, instanceEvent: Int = 0) {
        _bar = StateObject(wrappedValue: ChatGitBar(
            client: client,
            projectId: projectId,
            projectName: projectName,
            chatId: chatId,
            binding: binding
        ))
        self.binding = binding
        self.runsFinished = runsFinished
        self.instanceEvent = instanceEvent
    }

    var body: some View {
        let s = bar.snapshot
        ChatGitButtonFace(model: bar.git, withChoice: bar.choice != nil,
                     foreignInstance: s.foreign ? ChatGitBar.label(s.shownName) : nil) { showing = true }
            .task { await bar.git.load() }
            .task { await bar.load() }
            // A finished run may have touched files — catch up the state.
            .onChange(of: runsFinished) { Task { await bar.git.load() } }
            .onChange(of: instanceEvent) { Task { await bar.load() } }
            .onChange(of: binding) { bar.bindingChanged(binding) }
            .onChange(of: scenePhase) {
                if scenePhase == .active { Task { await bar.load() } }
            }
            .sheet(isPresented: $showing) {
                // Opened half-height: the chat stays visible above it (in the desktop client both sit side by side), pulling up
                // on the title makes it the full view.
                ChatGitSheet(bar: bar)
                    .cbSheet(.half, chatOperable: true)
            }
    }
}

/// The button in the chat's header — observes the model of the current target (count on the symbol).
private struct ChatGitButtonFace: View {
    @ObservedObject var model: GitModel
    /// A choice is set: the button stays even if the chosen instance (yet) names no repository — otherwise one could not get back.
    let withChoice: Bool
    /// The shown one is NOT this chat's instance: its name ("Main", "Copy k2") — the count on the symbol then counts the changes THERE;
    /// it is in the warning color, and the button's name names the instance. nil: the chat's instance.
    let foreignInstance: String?
    let open: () -> Void

    /// The button's name, with a foreign choice with the instance (the same shape as the rail of the web bar).
    private func name(_ title: String) -> String {
        guard let foreignInstance else { return title }
        return L("{title} · {instance} (not this chat)", ["title": title, "instance": foreignInstance])
    }

    var body: some View { content }

    // Without a repository an empty surface stands here instead of NOTHING: SwiftUI attaches no lifecycle calls to an empty view —
    // `task` would never run, the state would never load and the button could not appear even with a repository.
    @ViewBuilder
    private var content: some View {
        if let repo = model.repo {
            Button {
                open()
            } label: {
                // Neutral like every handle of the header (`HeaderSymbol`); the count carries the state.
                HeaderSymbol(systemImage: "arrow.triangle.branch")
                    .overlay(alignment: .topTrailing) {
                        if !repo.changes.isEmpty { HeaderCount(n: repo.changes.count, foreign: foreignInstance != nil) }
                    }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-git")
            .accessibilityLabel(name(L("Git: {branch}", ["branch": repo.branch.isEmpty ? L("(no branch)") : repo.branch])))
            .accessibilityValue(repo.changes.isEmpty
                                ? (repo.statusError ?? L("No changes"))
                                : L("{n} changes", ["n": repo.changes.count]))
        } else if withChoice {
            Button {
                open()
            } label: {
                HeaderSymbol(systemImage: "arrow.triangle.branch")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-git")
            .accessibilityLabel(name(L("Git")))
        } else {
            Color.clear.frame(width: 0, height: 0)
        }
    }
}

/// Short version for the left drawer.
struct GitSidebarList: View {
    @ObservedObject var model: GitModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let repo = model.repo {
                    SectionLabel(text: L("Branch"))
                    Text(repo.branch.isEmpty ? L("(no branch)") : repo.branch)
                        .cbFont(13, weight: .semibold)
                    if let counts = repo.counts {
                        Text(L("{staged} staged · {unstaged} changed · {untracked} new", [
                            "staged": counts.staged,
                            "unstaged": counts.unstaged,
                            "untracked": counts.untracked
                        ]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    Divider().padding(.vertical, 4)
                    SectionLabel(text: L("Files"))
                    ForEach(repo.changes) { change in
                        Button {
                            Task { await model.showDiff(repo, change, staged: change.staged) }
                        } label: {
                            HStack(spacing: 7) {
                                Text(change.code)
                                    .cbFont(10, weight: .bold, design: .monospaced)
                                    .frame(width: 14)
                                Text(change.path)
                                    .cbFont(11.5, design: .monospaced)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if repo.changes.isEmpty {
                        Text(repo.statusError ?? L("No changes")).font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text(L("No Git repository")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
        .task { await model.load() }
    }
}

/// The diff sheet — also for the file diff in the detail of the git overview (Code/GitView.swift) and for the files of a commit in
/// the graph (then with the short hash above the text).
struct GitDiffSheet: View {
    @Environment(\.dismiss) private var dismiss
    let preview: GitModel.GitDiffPreview

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    if let commit = preview.commit {
                        Label(L("In commit {short}", ["short": commit]), systemImage: "smallcircle.filled.circle")
                            .cbFont(12, design: .monospaced)
                            .foregroundStyle(CbColor.textMuted)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 6)
                            .accessibilityIdentifier("git-diff-commit")
                    }
                    if let error = preview.error {
                        Text(error)
                            .cbFont(13)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 8)
                            .accessibilityIdentifier("git-diff-error")
                    }
                    if preview.truncated {
                        Text(L("Truncated — the diff is longer than shown."))
                            .cbFont(12)
                            .foregroundStyle(CbColor.textMuted)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 6)
                            .accessibilityIdentifier("git-diff-truncated")
                    }
                    if preview.error == nil && preview.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(L("No text differences."))
                            .cbFont(13)
                            .foregroundStyle(CbColor.textMuted)
                            .padding(.horizontal, 8)
                    }
                    ForEach(Array(preview.text.components(separatedBy: "\n").prefix(1500).enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : line)
                            .cbFont(11, design: .monospaced)
                            .foregroundStyle(color(for: line))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 0.5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(background(for: line))
                    }
                }
                .padding(.vertical, 8)
            }
            // A short diff (one file of a commit) would otherwise sit in the middle of the sheet: a scroll view in BOTH directions centers
            // content that is smaller than it (screenshot). Top left, like any text.
            .defaultScrollAnchor(.topLeading)
            .navigationTitle(preview.path)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "git-diff-close") { dismiss() }
            }
        }
    }

    private func color(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .red }
        if line.hasPrefix("@@") { return .accentColor }
        return .primary
    }

    private func background(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.09) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.09) }
        return .clear
    }
}

private struct GitBranchesSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: GitModel
    let repo: GitRepo
    @State private var newBranch = ""

    var body: some View {
        NavigationStack {
            CbList {
                Section(L("New branch")) {
                    HStack {
                        TextField("feature/…", text: $newBranch)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button(L("Create")) {
                            let name = newBranch.trimmingCharacters(in: .whitespaces)
                            newBranch = ""
                            Task { await model.checkout(repo, branch: name, create: true) }
                        }
                        .disabled(newBranch.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section(L("Local")) {
                    ForEach(model.branches?.locals ?? [], id: \.self) { branch in
                        Button {
                            Task { await model.checkout(repo, branch: branch, create: false) }
                        } label: {
                            HStack {
                                Text(branch).cbFont(13, design: .monospaced)
                                Spacer()
                                if branch == model.branches?.current {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                Section(L("Remote")) {
                    ForEach(model.branches?.remotes ?? [], id: \.self) { branch in
                        Button {
                            Task { await model.checkout(repo, branch: branch, create: false) }
                        } label: {
                            Text(branch).cbFont(13, design: .monospaced)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle(L("Branches"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "git-branches-close") { dismiss() }
            }
            .task { await model.loadBranches(repo) }
        }
    }
}

private struct GitStashSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: GitModel
    let repo: GitRepo
    @State private var message = ""
    @State private var includeUntracked = true

    var body: some View {
        NavigationStack {
            CbList {
                Section(L("New stash")) {
                    TextField(L("Message (optional)"), text: $message)
                    Toggle(L("Include untracked files"), isOn: $includeUntracked)
                    Button(L("Stash")) {
                        let text = message
                        message = ""
                        Task { await model.stash(repo, includeUntracked: includeUntracked, message: text) }
                    }
                }
                Section(L("Existing stashes")) {
                    if model.stashes.isEmpty {
                        Text(L("No stashes")).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(model.stashes) { stash in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(stash.message).font(.subheadline)
                            Text("\(stash.ref) · \(stash.relative)").font(.caption).foregroundStyle(.secondary)
                            HStack(spacing: 7) {
                                PillButton(title: L("Apply")) { Task { await model.stashOp(repo, "apply", ref: stash.ref) } }
                                PillButton(title: L("Pop")) { Task { await model.stashOp(repo, "pop", ref: stash.ref) } }
                                PillButton(title: L("Delete"), destructive: true) {
                                    Task { await model.stashOp(repo, "drop", ref: stash.ref) }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(L("Stashes"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "git-stashes-close") { dismiss() }
            }
            .task { await model.loadStashes(repo) }
        }
    }
}
