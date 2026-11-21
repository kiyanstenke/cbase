import SwiftUI

// Switch the branch in an instance. Opened from an instance's ⋯ menu or at the "Branch" of a repo row
// (Code/ProjectInstances.swift).
//  – The repos and their branches are read by `GET …/instances/:instance/repos` INSIDE the instance (never git in B).
//    `loaded: false` is a reason, not an empty list; a repo with `error` shows it, the rest stays selectable.
//  – Switching is `POST …/branch {repo, branch}`. Open changes block it (409 OPEN_CHANGES with `files`, capped at 50, and
//    `count`): the sheet shows the list and "Discard", after a confirmation, exactly the named files one by one
//    (`POST …/dismiss {repo, files}`), then the same switch once more. Discarding exists ONLY here.
//  – A remote branch (`origin/x`) creates the local one with `--track`; if `x` already exists locally, 409
//    BRANCH_LOCAL_EXISTS names it and the button switches to the local one.
//  – An IGNORED file that the target branch carries (such as `.env`) blocks as well (409 IGNORED_FILES with `files` and
//    `count`), since the switch would overwrite it. It is not "open", discarding does not work here: the sheet shows the list.
//  – Afterwards "Restart stack": `POST …/stack-restart`, `up -d --build` per compose stack; only then does the new code
//    run. Asynchronous (202): the restart continues in the server, its result shows on the instance in the tab.
//
// Identifiers: `branch-sheet`, `branch-repo`, `branch-<name>`, `branch-open`, `branch-dismiss`, `branch-restart`.

/// A repo row of `GET …/instances/:instance/repos` (projectbox/instance-actions.js repoRow). `nil` for `open`, `branches`,
/// `remotes` means "not readable" (then `error` is set), never "none".
struct InstanceRepoRow: Identifiable, Equatable {
    var id: String { rel }
    let rel: String
    let name: String
    let branch: String
    let detached: Bool
    let open: [String]?
    let openCount: Int?
    let branches: [String]?
    let remotes: [String]?
    let error: String

    /// The name for the interface: the path, for the project folder (`rel` empty) the name.
    var title: String { rel.isEmpty ? name : rel }
    /// Remote branches without `<remote>/HEAD` (not a branch, a pointer).
    var removed: [String] { (remotes ?? []).filter { !$0.hasSuffix("/HEAD") } }
}

enum InstanceRepos {
    enum Situation: Equatable {
        case loading
        case error(String)
        case loaded([InstanceRepoRow])
    }

    static func load(client: APIClient, projectId: String, instance: String) async -> Situation {
        do {
            return read(try await client.data("/api/projects/\(projectId)/instances/\(instance)/repos"))
        } catch {
            return .error((error as? APIError)?.message ?? error.localizedDescription)
        }
    }

    static func read(_ data: Data) -> Situation {
        guard let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            return .error(L("The server's answer is not readable."))
        }
        guard raw["loaded"]?.boolValue == true, let list = raw["repos"]?.arrayValue else {
            return .error(CopyDeleteModel.text(raw["error"]) ?? L("The repos are not readable."))
        }
        return .loaded(list.compactMap { $0.objectValue.flatMap(row) })
    }

    static func row(_ o: [String: JSONValue]) -> InstanceRepoRow? {
        guard let rel = CopyDeleteModel.text(o["rel"]) else { return nil }
        func texts(_ k: String) -> [String]? { o[k]?.arrayValue.map { $0.compactMap { CopyDeleteModel.text($0) } } }
        return InstanceRepoRow(
            rel: rel, name: CopyDeleteModel.text(o["name"]) ?? rel, branch: CopyDeleteModel.text(o["branch"]) ?? "",
            detached: o["detached"]?.boolValue == true, open: texts("open"), openCount: o["openCount"]?.intValue,
            branches: texts("branches"), remotes: texts("remotes"), error: CopyDeleteModel.text(o["error"]) ?? ""
        )
    }
}

struct BranchSwitchSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let projectId: String
    let instance: String
    /// On closing: the sentence about the result (nil = nothing happened).
    let finished: (String?) -> Void

    @State private var situation: InstanceRepos.Situation = .loading
    @State private var repo: String?
    @State private var running = false
    @State private var error: String?
    /// 409 OPEN_CHANGES: the reported files, their number, and which switch hung on it.
    @State private var open: (files: [String], count: Int, branch: String)?
    @State private var dismissQuestion = false
    /// 409 IGNORED_FILES: the ignored files the target branch carries, and their number.
    @State private var ignored: (files: [String], count: Int)?
    /// 409 BRANCH_LOCAL_EXISTS: the local branch to choose.
    @State private var localPresent: String?
    /// After a switch: the sentence for it, and the button "Restart stack".
    @State private var switched: String?
    @State private var restart: String?

    init(client: APIClient, projectId: String, instance: String, repo: String?, finished: @escaping (String?) -> Void) {
        self.client = client
        self.projectId = projectId
        self.instance = instance
        self.finished = finished
        _repo = State(initialValue: repo)
    }

    private var repos: [InstanceRepoRow] {
        if case .loaded(let r) = situation { return r }
        return []
    }

    private var selected: InstanceRepoRow? {
        repos.first(where: { $0.rel == repo }) ?? repos.first
    }

    var body: some View {
        NavigationStack {
            CbForm {
                switch situation {
                case .loading:
                    Section { CbLoading(label: L("Loading…")) }
                case .error(let reason):
                    Section { InlineError(message: reason) }
                case .loaded(let list):
                    if list.isEmpty {
                        Section { Text(L("The instance has no code repos.")).foregroundStyle(CbColor.textMuted) }
                    } else {
                        content(list)
                    }
                }
            }
            // The sheet's identifier as a CONTAINER (`.contain`, like `archive-list`); otherwise it would overwrite the identifiers inside.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("branch-sheet")
            .navigationTitle(L("Switch branch"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: switched == nil ? L("Cancel") : L("Done")) {
                    finished(restart ?? switched)
                    dismiss()
                }
            }
            .confirmationDialog(L("Discard changes?"), isPresented: $dismissQuestion, titleVisibility: .visible) {
                Button(L("Dismiss"), role: .destructive) { Task { await dismiss() } }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("The listed files are lost in “{instance}” — new, untracked ones too. This cannot be undone.", ["instance": instance]))
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func content(_ list: [InstanceRepoRow]) -> some View {
        if list.count > 1 {
            Section {
                Picker(L("Repo"), selection: Binding(get: { selected?.rel ?? "" }, set: { repo = $0; open = nil; localPresent = nil; error = nil })) {
                    ForEach(list) { r in Text(verbatim: r.title).tag(r.rel) }
                }
                // During a request the repo stays fixed; otherwise "Discard and switch" would, after discarding in A, switch the
                // branch in the meanwhile chosen B.
                .disabled(running)
                .accessibilityIdentifier("branch-repo")
            }
        }
        if let r = selected {
            Section {
                HStack {
                    Text(L("Checked out"))
                    Spacer()
                    Text(verbatim: r.branch.isEmpty ? "–" : r.branch).font(.system(.body, design: .monospaced)).foregroundStyle(CbColor.textSecondary)
                }
                if r.detached { Text(L("detached")).cbFont(13).foregroundStyle(.orange) }
                if let n = r.openCount, n > 0 {
                    Text(n == 1 ? L("1 file open") : L("{n} files open", ["n": n])).cbFont(13).foregroundStyle(.orange)
                }
                if !r.error.isEmpty { Text(verbatim: r.error).cbFont(13).foregroundStyle(.orange) }
            } header: {
                Text(verbatim: r.title)
            }
            if let switched {
                Section {
                    Text(verbatim: switched).cbFont(14).foregroundStyle(CbColor.text)
                    Button {
                        Task { await stackRestart() }
                    } label: {
                        HStack {
                            Label(L("Restart stack"), systemImage: "arrow.clockwise")
                            Spacer()
                            if running { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(running)
                    .accessibilityIdentifier("branch-restart")
                    if let restart { Text(verbatim: restart).cbFont(13).foregroundStyle(CbColor.textSecondary) }
                } footer: {
                    Text(L("The new code only runs after the stack restarts (compose up -d --build)."))
                }
            }
            if let o = open {
                Section {
                    ForEach(o.files, id: \.self) { d in
                        Text(verbatim: d).font(.system(.footnote, design: .monospaced)).foregroundStyle(CbColor.text).lineLimit(1).truncationMode(.middle)
                    }
                    if o.count > o.files.count {
                        Text(L("and {n} more", ["n": o.count - o.files.count])).cbFont(13).foregroundStyle(CbColor.textMuted)
                    }
                    Button(L("Discard and switch"), role: .destructive) { dismissQuestion = true }
                        .disabled(running)
                        .accessibilityIdentifier("branch-dismiss")
                } header: {
                    // The identifier on the head text, not on the section: there it would overwrite `branch-dismiss` (identifier on the stack).
                    Text(L("Open changes block the switch")).accessibilityIdentifier("branch-open")
                } footer: {
                    Text(L("Or commit the changes first — in the Code tab or in a chat of this instance."))
                }
            }
            if let ig = ignored {
                Section {
                    ForEach(ig.files, id: \.self) { d in
                        Text(verbatim: d).font(.system(.footnote, design: .monospaced)).foregroundStyle(CbColor.text).lineLimit(1).truncationMode(.middle)
                    }
                    if ig.count > ig.files.count {
                        Text(L("and {n} more", ["n": ig.count - ig.files.count])).cbFont(13).foregroundStyle(CbColor.textMuted)
                    }
                } header: {
                    Text(L("Ignored files block the switch")).accessibilityIdentifier("branch-ignored")
                } footer: {
                    Text(L("The target branch brings these files along — switching would overwrite them. Back them up or move them first, then switch."))
                }
            }
            if let local = localPresent {
                Section {
                    Button(L("Use local branch “{name}”", ["name": local])) { Task { await changeOver(local) } }
                } footer: {
                    Text(L("The branch already exists locally — it is checked out instead of the remote one."))
                }
            }
            if let error { Section { InlineError(message: error) } }
            Section(L("Local branches")) {
                if let local = r.branches {
                    if local.isEmpty { Text(L("none")).foregroundStyle(CbColor.textMuted) }
                    ForEach(local, id: \.self) { b in branchRow(b, current: b == r.branch && !r.detached) }
                } else {
                    Text(L("unreadable")).foregroundStyle(.orange)
                }
            }
            Section(L("Remote branches")) {
                if r.remotes != nil {
                    if r.removed.isEmpty { Text(L("none")).foregroundStyle(CbColor.textMuted) }
                    ForEach(r.removed, id: \.self) { b in branchRow(b, current: false) }
                } else {
                    Text(L("unreadable")).foregroundStyle(.orange)
                }
            }
        }
    }

    private func branchRow(_ b: String, current: Bool) -> some View {
        Button {
            Task { await changeOver(b) }
        } label: {
            HStack {
                Text(verbatim: b).font(.system(.body, design: .monospaced)).foregroundStyle(CbColor.text).lineLimit(1).truncationMode(.middle)
                Spacer()
                if current { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .disabled(current || running)
        .accessibilityIdentifier("branch-\(b)")
    }

    // ── Requests ──────────────────────────────────────────────────────────────

    private var path: String { "/api/projects/\(projectId)/instances/\(instance)" }

    private func load() async {
        situation = await InstanceRepos.load(client: client, projectId: projectId, instance: instance)
    }

    /// `in`: the repo to switch in, by default the selected one. The discard passes ITS repo through.
    private func changeOver(_ branch: String, in repoRow: InstanceRepoRow? = nil) async {
        guard let r = repoRow ?? selected else { return }
        struct Body: Encodable { let repo: String; let branch: String }
        running = true
        defer { running = false }
        error = nil
        open = nil
        ignored = nil
        localPresent = nil
        do {
            _ = try await client.send("\(path)/branch", body: Body(repo: r.rel, branch: branch))
            switched = L("“{repo}” is now on {branch}.", ["repo": r.title, "branch": branch])
            restart = nil
        } catch let e as APIError where e.code == "OPEN_CHANGES" {
            let files = (e.body?["files"]?.arrayValue ?? []).compactMap { CopyDeleteModel.text($0) }
            open = (files, max(e.body?["count"]?.intValue ?? files.count, files.count), branch)
        } catch let e as APIError where e.code == "IGNORED_FILES" {
            let files = (e.body?["files"]?.arrayValue ?? []).compactMap { CopyDeleteModel.text($0) }
            ignored = (files, max(e.body?["count"]?.intValue ?? files.count, files.count))
        } catch let e as APIError where e.code == "BRANCH_LOCAL_EXISTS" {
            localPresent = CopyDeleteModel.text(e.body?["local"]) ?? String(branch.split(separator: "/", maxSplits: 1).last ?? "")
        } catch {
            self.error = InstancesPageModel.errorText(error)
        }
        await load()
    }

    /// Discard exactly the reported files, then the same switch once more, in the SAME repo (`r`), not the meanwhile chosen one.
    private func dismiss() async {
        guard let r = selected, let o = open, !o.files.isEmpty else { return }
        struct Body: Encodable { let repo: String; let files: [String] }
        running = true
        do {
            _ = try await client.send("\(path)/dismiss", body: Body(repo: r.rel, files: o.files))
        } catch {
            running = false
            self.error = InstancesPageModel.errorText(error)
            await load()
            return
        }
        running = false
        await changeOver(o.branch, in: r)
    }

    private func stackRestart() async {
        running = true
        defer { running = false }
        do {
            // 202: the restart continues in the server (up to 30 min), its result shows on the instance.
            _ = try await client.send("\(path)/stack-restart")
            restart = L("The stack is restarting — the result will show on the instance afterwards.")
        } catch {
            restart = InstancesPageModel.errorText(error)
        }
    }
}
