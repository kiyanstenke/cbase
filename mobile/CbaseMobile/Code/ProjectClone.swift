import SwiftUI

// A git repository as the source of project creation: counterpart of `web/src/lib/project-clone.ts` (validation) and
// `web/src/components/projects/CloneForm.tsx` / `GitAccessForm.tsx` (form, access). Everything is cloned, including
// submodules and LFS; the server fetches those in the container, so only address, branch and the host's access live here.
//
// https only. Access applies per host for the workspace (`GET/PUT /api/workspaces/:id/git/creds`, the same store as the web git bar);
// lookup by lowercase `hostname`, without port. The server validates the address again (400 before creation).

extension ProjectClone {
    static func errorText(_ f: CheckError) -> String {
        switch f {
        case .empty: return L("Please enter the repository's https address.")
        case .onlyHttps: return L("https addresses only. cbase does not handle SSH addresses — please use the https address.")
        case .withUser: return L("The address contains a user or a password — please enter it without either. cbase then keeps the access here per host.")
        case .withQuery: return L("The address contains a query (“?…”) — please remove it.")
        case .withFragment: return L("The address contains a “#” — please remove it.")
        case .character: return L("The address contains characters that are not allowed in a URL (for example spaces).")
        case .hostUnclear: return L("The host of the address is ambiguous (only letters, digits, “.” and “-”, plus a port up to 65535) — please check the address.")
        case .branch: return L("The branch name is invalid (letters, digits, “.”, “_”, “/” and “-”, not starting with “-”).")
        case .invalid: return L("This is not a valid repository address.")
        }
    }
}

/// A workspace's stored accesses: host and user only, the token never leaves the server.
enum GitAccesses {
    struct Entry: Decodable, Hashable { let host: String; let username: String }
    private struct List: Decodable { let creds: [Entry] }
    private struct Body: Encodable { let host: String; let username: String; let secret: String }

    /// `nil`: not loadable. Empty is not unknown: a network error would otherwise read as "no access", and a newly created one
    /// would silently replace the existing one.
    static func list(_ client: APIClient, _ workspaceId: String) async -> [Entry]? {
        (try? await client.get("/api/workspaces/\(workspaceId)/git/creds") as List)?.creds
    }
    static func save(_ client: APIClient, _ workspaceId: String, host: String, username: String, secret: String) async throws {
        try await client.send("/api/workspaces/\(workspaceId)/git/creds", method: .put,
                              body: Body(host: host.lowercased(), username: username.trimmingCharacters(in: .whitespaces), secret: secret))
    }
}

/// User and token for ONE host, as form sections: in the clone sheet and in the "Add access" sheet of a failed row.
struct GitAccessSection: View {
    let host: String
    let button: String
    let save: (_ username: String, _ secret: String) async throws -> Void
    @State private var username = ""
    @State private var secret = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        Section {
            TextField(L("Username"), text: $username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
                .accessibilityIdentifier("git-access-user")
            SecureField(L("Token / password"), text: $secret)
                .textContentType(.password)
                .accessibilityIdentifier("git-access-token")
            Button {
                Task {
                    busy = true
                    error = ""
                    do { try await save(username, secret) } catch { self.error = error.localizedDescription }
                    busy = false
                }
            } label: {
                Text(busy ? L("Saving…") : button)
            }
            .disabled(busy || username.trimmingCharacters(in: .whitespaces).isEmpty || secret.isEmpty)
            .accessibilityIdentifier("git-access-save")
            if !error.isEmpty { InlineError(message: error) }
        } header: {
            Text(L("Access for {host}", ["host": host]))
        } footer: {
            Text(L("Applies to the whole workspace and all Git actions on {host}. A personal access token with read permission works as the password.", ["host": host]))
        }
    }
}

/// "Add access" on a failed clone row: stores the access and retries the setup.
struct GitAccessSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let projectId: String
    let host: String
    let finished: () async -> Void

    var body: some View {
        NavigationStack {
            CbForm {
                GitAccessSection(host: host, button: L("Save & retry")) { u, s in
                    try await GitAccesses.save(client, workspaceId, host: host, username: u, secret: s)
                    try await client.send("/api/projects/\(projectId)/setup/again")
                    await finished()
                    dismiss()
                }
            }
            .navigationTitle(L("Git access for {host}", ["host": host]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(label: L("Cancel")) { dismiss() } }
        }
    }
}

/// The "Git repository" sheet of project creation: address, branch, the host's access state, "Add".
struct CloneSourceSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let onAdd: (ProjectClone.Detail) -> Void
    @State private var url = ""
    @State private var branch = ""
    private enum Load { case loading, error, list([GitAccesses.Entry]) }
    @State private var accesses: Load = .loading
    @State private var accessOpen = false

    private func load() async { accesses = await GitAccesses.list(client, workspaceId).map { .list($0) } ?? .error }

    var body: some View {
        let check = ProjectClone.check(url, branch)
        let detail: ProjectClone.Detail? = { if case .success(let a) = check { return a }; return nil }()
        let host = detail?.host ?? ""
        let loaded: [GitAccesses.Entry]? = { if case .list(let l) = accesses { return l }; return nil }()
        let access = loaded?.first(where: { $0.host == host })
        // An open access section would lose its input on Add: save or close it first.
        let addReady = detail != nil && !accessOpen
        NavigationStack {
            CbForm {
                Section {
                    TextField("https://gitlab.com/group/repo.git", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("project-clone-url")
                    TextField(L("Branch (empty = repository default)"), text: $branch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("project-clone-branch")
                } header: {
                    Text(L("Git repository"))
                } footer: {
                    if case .failure(let f) = check, !url.trimmingCharacters(in: .whitespaces).isEmpty || f == .branch {
                        Text(ProjectClone.errorText(f)).foregroundStyle(.red)
                    } else {
                        Text(L("Cloning happens in the project's container, including submodules and LFS files — the app does not need to stay in the foreground."))
                    }
                }
                if !host.isEmpty {
                    Section {
                        if case .loading = accesses {
                            Text(L("Checking access for {host}…", ["host": host])).foregroundStyle(CbColor.textSecondary)
                        } else if case .error = accesses {
                            Text(L("The stored access entries could not be loaded.")).foregroundStyle(.red)
                            Button(L("Reload")) { Task { accesses = .loading; await load() } }
                                .accessibilityIdentifier("project-clone-new-load")
                        } else if let z = access {
                            Text(L("Access for {host}: {user}", ["host": host, "user": z.username]))
                        } else {
                            Text(L("No access stored for {host} — a public repository needs none.", ["host": host]))
                                .foregroundStyle(CbColor.textSecondary)
                        }
                        if loaded != nil && !accessOpen {
                            Button(access == nil ? L("Add access") : L("Change access")) { accessOpen = true }
                                .accessibilityIdentifier("project-clone-access")
                        }
                    }
                    if accessOpen {
                        GitAccessSection(host: host, button: L("Save access")) { u, s in
                            try await GitAccesses.save(client, workspaceId, host: host, username: u, secret: s)
                            await load()
                            accessOpen = false
                        }
                        .id(host)
                        if detail != nil {
                            Section {
                                Text(L("Save or close the access first.")).foregroundStyle(CbColor.textSecondary)
                                Button(L("Close")) { accessOpen = false }
                                    .accessibilityIdentifier("project-clone-access-close")
                            }
                        }
                    }
                }
            }
            .navigationTitle(L("Git repository"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Add")) {
                        guard addReady, let a = detail else { return }
                        onAdd(a)
                        dismiss()
                    }
                    .disabled(!addReady)
                    .accessibilityIdentifier("project-clone-add")
                }
            }
            .task { await load() }
        }
    }
}
