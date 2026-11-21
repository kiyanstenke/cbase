import SwiftUI

// Create a copy. Opened from the "Instances" tab (Code/ProjectInstances.swift): "Create copy" at the top (base main) or
// "Copy from this instance" in an instance's ⋯ menu (the base is preselected).
//  – Name: optional — empty lets the server pick the next free one (k1, k2, …; stacks/names.js); a taken or invalid one is its
//    400/409 with a sentence.
//  – Base (`baseInstance`, stacks/routes.js BODY_FIELDS): any ready instance (`InstancesTree.baseOptions`, main first), as instance
//    name "main" or "copy-<name>" — ALWAYS sent, main included (the server's default is not a statement of the sheet).
//    The server accepts a ready copy as template (stacks/request.js templateOf); what can fail is spelled out by `errorText`
//    in the sheet's words: 400 BASE_INSTANCE_INVALID, 409 TEMPLATE_UNKNOWN / TEMPLATE_NOT_READY / TEMPLATE_UNREADABLE (the
//    template vanished or left `ready` while the sheet was open).
//  – Branch per repo: from `GET …/instances/<base>/repos` (local and remote) — with a copy as base ITS repos, against which
//    the server also checks the refs (baseInTheTemplate). Unchanged means "as in the base" and is not sent; only changed repos
//    go into `base` (`{ relPath: ref }`, the project folder as "." — stacks/request.js baseError). Without a change `base` is
//    omitted entirely (the synthesized Encodable drops nil) — the same as "as in the base" for the server.
//  – Without `chatId` a human creates: no move-in, no wake-up call — the event `project/copy` refreshes the tab.
//
// Identifiers: `copy-create-sheet`, `copy-create-name`, `copy-create-base`, `copy-create-repo-<rel>`, `copy-create-button`.

struct CopyCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let projectId: String
    let finished: (String) -> Void
    private let options: [InstancesTree.Option]

    @State private var name = ""
    @State private var base: String
    @State private var repos: InstanceRepos.Situation = .loading
    /// The chosen ref per repo (`rel`) — changed ones only; a missing repo means "as in the base".
    @State private var refs: [String: String] = [:]
    @State private var running = false
    @State private var error: String?

    init(client: APIClient, projectId: String, tree: InstancesTree.Tree?, base: String?, finished: @escaping (String) -> Void) {
        self.client = client
        self.projectId = projectId
        self.finished = finished
        let options = InstancesTree.baseOptions(tree)
        self.options = options
        let start = base.flatMap { b in options.first(where: { $0.name == b })?.name } ?? options.first?.name ?? InstancesTree.main
        _base = State(initialValue: start)
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("automatic (k1, k2, …)"), text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .accessibilityIdentifier("copy-create-name")
                } header: {
                    Text(L("Name"))
                } footer: {
                    Text(L("Lowercase letters, digits and hyphens. Empty lets the server pick the next free name."))
                }
                Section {
                    Picker(L("Base"), selection: Binding(get: { base }, set: { fresh in
                        guard fresh != base else { return }
                        base = fresh
                        refs = [:]
                        Task { await loadRepos() }
                    })) {
                        ForEach(options) { o in Text(verbatim: o.name).tag(o.name) }
                    }
                    .accessibilityIdentifier("copy-create-base")
                } footer: {
                    if let template = InstancesTree.copyName(base) {
                        Text(L("The copy takes over the state of “{name}” including uncommitted changes and volumes; “{name}” pauses briefly for this.", ["name": template]))
                    }
                }
                reposSection
                if let error { Section { InlineError(message: error) } }
                Section {
                    Button {
                        Task { await create() }
                    } label: {
                        HStack {
                            Text(L("Create copy")).cbFont(16, weight: .medium)
                            Spacer()
                            if running { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(running || options.isEmpty)
                    .accessibilityIdentifier("copy-create-button")
                } footer: {
                    Text(L("The copy gets its own containers, volumes and ports. It belongs to no chat."))
                }
            }
            // The sheet's identifier as a CONTAINER (`.contain`, like `archive-list`): without it, it would override those of the
            // fields and buttons inside (an identifier on the STACK overrides its children's).
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("copy-create-sheet")
            .navigationTitle(L("Create copy"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
            }
            .task { await loadRepos() }
        }
    }

    @ViewBuilder
    private var reposSection: some View {
        switch repos {
        case .loading:
            Section(L("Branch per repo")) { CbLoading(label: L("Loading…")) }
        case .error(let reason):
            Section {
                Text(verbatim: reason).cbFont(13.5).foregroundStyle(.orange)
            } header: {
                Text(L("Branch per repo"))
            } footer: {
                Text(L("Without a list the copy is created from the base's current state."))
            }
        case .loaded(let list):
            Section {
                if list.isEmpty {
                    Text(L("The instance has no code repos.")).foregroundStyle(CbColor.textMuted)
                }
                ForEach(list) { r in
                    Picker(selection: Binding(get: { refs[r.rel] ?? "" }, set: { refs[r.rel] = $0.isEmpty ? nil : $0 })) {
                        Text(L("as in the base ({branch})", ["branch": r.branch.isEmpty ? "–" : r.branch])).tag("")
                        ForEach((r.branches ?? []).filter { $0 != r.branch }, id: \.self) { b in
                            Text(verbatim: b).tag(b)
                        }
                        ForEach(r.removed, id: \.self) { b in
                            Text(verbatim: b).tag(b)
                        }
                    } label: {
                        Text(verbatim: r.title)
                    }
                    .accessibilityIdentifier("copy-create-repo-\(r.rel.isEmpty ? "." : r.rel)")
                }
            } header: {
                Text(L("Branch per repo"))
            }
        }
    }

    private func loadRepos() async {
        repos = .loading
        let selected = base
        let situation = await InstanceRepos.load(client: client, projectId: projectId, instance: selected)
        if selected == base { repos = situation }
    }

    private func create() async {
        struct Body: Encodable {
            let name: String?
            let base: [String: String]?
            /// The template as instance name — always set (stacks/routes.js reads a missing value as "main"; the sheet says it itself).
            let baseInstance: String
        }
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // The project folder is "." in `base` (`rel` = "" in the repo row).
        var b: [String: String] = [:]
        for (rel, ref) in refs where !ref.isEmpty { b[rel.isEmpty ? "." : rel] = ref }
        let selected = base
        let body = Body(name: n.isEmpty ? nil : n, base: b.isEmpty ? nil : b, baseInstance: selected)
        running = true
        defer { running = false }
        error = nil
        do {
            let data = try await client.send("/api/projects/\(projectId)/stack-copies", body: body)
            let copy = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["copy"]?.objectValue
            let created = CopyDeleteModel.text(copy?["name"]) ?? n
            finished(created.isEmpty ? L("The copy is being created.") : L("Copy “{name}” is being created.", ["name": created]))
            dismiss()
        } catch {
            self.error = Self.errorText(error, base: selected)
        }
    }

    /// The sentence for a rejected create. The TEMPLATE cases (stacks/request.js templateOf and the snapshot) in the sheet's
    /// words — the server's sentence names project id and decision numbers; for TEMPLATE_UNREADABLE it follows as the reason
    /// (there it is the diagnosis). Any other error (NAME_TAKEN, COPY_BASE, REFS_UNREADABLE, …) with the server's sentence,
    /// which already says what to do.
    nonisolated static func errorText(_ error: Error, base: String) -> String {
        guard let e = error as? APIError, let code = e.code else { return InstancesPageModel.errorText(error) }
        let name = InstancesTree.copyName(base) ?? base
        switch code {
        case "BASE_INSTANCE_INVALID":
            return L("“{base}” is not an instance of this project — main and every ready copy can be the base.", ["base": base])
        case "TEMPLATE_UNKNOWN":
            return L("The copy “{name}” no longer exists — choose another base.", ["name": name])
        case "TEMPLATE_NOT_READY":
            return L("“{name}” is not ready right now — a copy from it is only possible once it is ready again. If it is stopped, start it first.", ["name": name])
        case "MAIN_STOPPED":
            // Without a running main its refs are unreadable — also for a copy from a copy.
            return L("Main is stopped — without a running main no copy can be made (not even from another copy). Start main first.")
        case "TEMPLATE_UNREADABLE":
            return L("The state of “{name}” is not readable — without it the list of its repos is not certain; nothing was created. Reason: {reason}",
                     ["name": name, "reason": e.message])
        default:
            return InstancesPageModel.errorText(error)
        }
    }
}
