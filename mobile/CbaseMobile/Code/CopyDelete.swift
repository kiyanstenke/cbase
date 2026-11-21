import SwiftUI

// Delete sheet of a copy. ONE component for two places: the ⋯ menu of a copy in the "Instances" tab (Code/ProjectInstances.swift)
// and "Clear away" in the services pill (Shell/ServicesButton.swift).
//  – There is no checkbox: clearing away ALWAYS saves everything as `copy/<name>/…` in the main. Beforehand the sheet shows per repo
//    what lands there (`GET …/stack-copies/:name/state`: branch, commits, open files, new repo) and which chats work in the copy.
//    If the preview fails, its reason is shown — never an empty list that would read as "nothing to save" (empty is not unknown);
//    deleting stays possible anyway (a copy in `error` has no preview and has to go precisely then).
//  – Lock instead of queueing: if a chat, an agent or a workflow works in the copy, the DELETE answers 409
//    INSTANCE_WORKING and names it — the sheet shows the list instead of silently queueing.
//  – Path: `DELETE /api/projects/<project>/stack-copies/<name>` with `name` = `k1` from the identifier `p1/copy-k1`
//    (`ServicesRules.copyTarget`); the main is not a copy and gets no request. Guard: client/test/services-instances-ios.test.mjs
//    (path template executed, confirmation, texts).
//
// Identifiers: `copy-delete-sheet`, `copy-delete-repo-<rel>`, `copy-delete-work`, `copy-delete-button`.

@MainActor
final class CopyDeleteModel: ObservableObject {
    struct RepoState: Identifiable, Equatable {
        var id: String { rel }
        let rel: String
        let name: String
        let branch: String
        let detached: Bool
        let commits: Int?
        let open: [String]
        let openCount: Int
        let fresh: Bool
    }
    struct ChatState: Identifiable, Equatable {
        let id: String
        let title: String
        let running: Bool
    }
    enum Preview: Equatable {
        case loading
        case error(String)
        case loaded(repos: [RepoState], chats: [ChatState])
    }

    let client: APIClient
    let identifier: String
    @Published private(set) var preview: Preview = .loading
    /// 409 INSTANCE_WORKING of the delete: who is still working.
    @Published private(set) var work: InstanceWork?
    @Published private(set) var error: String?
    @Published private(set) var running = false

    init(client: APIClient, identifier: String) {
        self.client = client
        self.identifier = identifier
    }

    /// The copy's name (`k1`) — empty for the main, which is not a copy.
    var name: String { ServicesRules.copyTarget(identifier: identifier)?.name ?? "" }

    func load() async {
        guard let target = ServicesRules.copyTarget(identifier: identifier) else {
            preview = .error(L("The main instance is never removed."))
            return
        }
        do {
            let data = try await client.data("/api/projects/\(target.project)/stack-copies/\(target.name)/state")
            preview = Self.read(data)
        } catch let e as APIError where e.code == "COPY_STATE" {
            let state = Self.text(e.body?["state"]) ?? ""
            preview = .error(L("No preview: the copy is not ready ({state}). Deleting still saves everything.", ["state": state.isEmpty ? "?" : state]))
        } catch {
            preview = .error(error.localizedDescription)
        }
    }

    /// The preview's answer. `loaded: false` (or anything but the expected shape) is an error with a reason, never "nothing".
    nonisolated static func read(_ data: Data) -> Preview {
        guard let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            return .error(L("The server's answer is not readable."))
        }
        guard raw["loaded"]?.boolValue == true, let reposRaw = raw["repos"]?.arrayValue, let chatsRaw = raw["chats"]?.arrayValue else {
            return .error(text(raw["error"]) ?? L("The preview is not readable."))
        }
        let repos: [RepoState] = reposRaw.compactMap { r in
            guard let o = r.objectValue, let rel = text(o["rel"]) else { return nil }
            let open = (o["open"]?.arrayValue ?? []).compactMap { text($0) }
            return RepoState(
                rel: rel, name: text(o["name"]) ?? rel, branch: text(o["branch"]) ?? "",
                detached: o["detached"]?.boolValue == true, commits: o["commits"]?.intValue,
                open: open, openCount: max(o["openCount"]?.intValue ?? open.count, open.count), fresh: o["fresh"]?.boolValue == true
            )
        }
        let chats: [ChatState] = chatsRaw.compactMap { c in
            guard let o = c.objectValue, let id = text(o["id"]), !id.isEmpty else { return nil }
            return ChatState(id: id, title: text(o["title"]) ?? "", running: o["running"]?.boolValue == true)
        }
        return .loaded(repos: repos, chats: chats)
    }

    /// Strings only — `JSONValue.stringValue` turned a number into text.
    nonisolated static func text(_ v: JSONValue?) -> String? {
        if case .string(let s)? = v { return s }
        return nil
    }

    /// Delete. Returns the sentence for the caller on success; nil if it failed (then `work` or `error` is set).
    func erase() async -> String? {
        guard let target = ServicesRules.copyTarget(identifier: identifier) else {
            error = L("The main instance is never removed.")
            return nil
        }
        running = true
        defer { running = false }
        work = nil
        error = nil
        do {
            _ = try await client.send("/api/projects/\(target.project)/stack-copies/\(target.name)", method: .delete)
            return L("Deleting “{name}” is queued — commits and open changes land under copy/{name}/… in main.", ["name": target.name])
        } catch {
            if let a = InstanceWork.from(error) {
                work = a
            } else {
                self.error = L("Removing “{name}” failed: {msg}", ["name": target.name, "msg": (error as? APIError)?.message ?? error.localizedDescription])
            }
            return nil
        }
    }
}

struct CopyDeleteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: CopyDeleteModel
    @State private var question = false
    /// After ordering: the sentence for the place that opened the sheet.
    let finished: (String) -> Void

    init(client: APIClient, identifier: String, finished: @escaping (String) -> Void) {
        _model = StateObject(wrappedValue: CopyDeleteModel(client: client, identifier: identifier))
        self.finished = finished
    }

    private var runningChats: [CopyDeleteModel.ChatState] {
        if case .loaded(_, let chats) = model.preview { return chats.filter(\.running) }
        return []
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    Text(verbatim: ServicesRules.clearAwayHint(name: model.name))
                        .cbFont(14)
                        .foregroundStyle(CbColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                previewSections
                if let a = model.work {
                    Section {
                        ForEach(a.rows, id: \.self) { z in
                            Text(verbatim: z).cbFont(14).foregroundStyle(CbColor.text)
                        }
                    } header: {
                        // The identifier on the header text, not on the section (a container would hand it to every row inside).
                        Text(L("Still working")).accessibilityIdentifier("copy-delete-work")
                    } footer: {
                        Text(L("Finish (or stop) this work first, then delete."))
                    }
                }
                if let f = model.error {
                    Section { InlineError(message: f) }
                }
                Section {
                    Button(role: .destructive) {
                        question = true
                    } label: {
                        HStack {
                            Text(L("Delete copy")).cbFont(16, weight: .medium)
                            Spacer()
                            if model.running { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(model.running || model.name.isEmpty || !runningChats.isEmpty)
                    .accessibilityIdentifier("copy-delete-button")
                } footer: {
                    if !runningChats.isEmpty {
                        Text(L("Locked while a chat runs in the copy."))
                    }
                }
            }
            // The sheet's identifier as a CONTAINER (`.contain`, like `archive-list`) — otherwise it would override the identifiers inside.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("copy-delete-sheet")
            .navigationTitle(L("Delete copy “{name}”", ["name": model.name]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
            }
            .confirmationDialog(L("Delete copy “{name}”", ["name": model.name]), isPresented: $question, titleVisibility: .visible) {
                Button(L("Delete copy"), role: .destructive) {
                    Task {
                        if let text = await model.erase() {
                            finished(text)
                            dismiss()
                        }
                    }
                }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("This cannot be undone. What is listed above is saved."))
            }
            .task { await model.load() }
        }
    }

    @ViewBuilder
    private var previewSections: some View {
        switch model.preview {
        case .loading:
            Section { CbLoading(label: L("Loading…")) }
        case .error(let reason):
            Section(L("What lands in main")) {
                Text(verbatim: reason).cbFont(13.5).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        case .loaded(let repos, let chats):
            Section {
                if repos.isEmpty {
                    Text(L("The copy has no code repos.")).cbFont(14).foregroundStyle(CbColor.textMuted)
                }
                ForEach(repos) { r in repoRow(r) }
            } header: {
                Text(L("What lands in main"))
            }
            Section {
                if chats.isEmpty {
                    Text(L("No chat works in this instance.")).cbFont(14).foregroundStyle(CbColor.textMuted)
                }
                ForEach(chats) { c in
                    HStack {
                        Text(verbatim: c.title.isEmpty ? c.id : c.title).cbFont(14).foregroundStyle(CbColor.text).lineLimit(1)
                        Spacer(minLength: 6)
                        if c.running { Text(L("running")).cbFont(12.5).foregroundStyle(.orange) }
                    }
                }
            } header: {
                Text(L("Chats"))
            } footer: {
                if !chats.isEmpty { Text(L("These chats continue in main after deleting.")) }
            }
        }
    }

    private func repoRow(_ r: CopyDeleteModel.RepoState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(verbatim: r.rel.isEmpty || r.rel == "." ? r.name : r.rel).cbFont(14.5, weight: .medium).foregroundStyle(CbColor.text)
                if r.fresh { Text(L("new repo")).cbFont(12).foregroundStyle(Color.accentColor) }
            }
            Text(verbatim: "copy/\(model.name)/\(r.branch.isEmpty ? "…" : r.branch)")
                .cbFont(12.5, design: .monospaced)
                .foregroundStyle(CbColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(verbatim: counts(r))
                .cbFont(12.5, digitsEqual: true)
                .foregroundStyle(CbColor.textMuted)
            ForEach(r.open, id: \.self) { path in
                Text(verbatim: path).cbFont(12, design: .monospaced).foregroundStyle(CbColor.textMuted).lineLimit(1).truncationMode(.middle)
            }
            if r.openCount > r.open.count {
                Text(L("and {n} more", ["n": r.openCount - r.open.count])).cbFont(12).foregroundStyle(CbColor.textMuted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("copy-delete-repo-\(r.rel.isEmpty ? "." : r.rel)")
    }

    private func counts(_ r: CopyDeleteModel.RepoState) -> String {
        var parts: [String] = []
        if let c = r.commits { parts.append(c == 1 ? L("1 commit") : L("{n} commits", ["n": c])) }
        parts.append(r.openCount == 1 ? L("1 file open") : L("{n} files open", ["n": r.openCount]))
        if r.detached { parts.append(L("detached")) }
        return parts.joined(separator: " · ")
    }
}
