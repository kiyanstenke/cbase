import SwiftUI

// The "GitLab" page behind the list of services (`IntegrationsList.swift`); ngrok has its own page next to it
// (`NgrokSettingsView`, `NgrokSettings.swift`).
//
// Settings → Integrations → GitLab: the connected GitLab accounts. They are global, not workspace-bound, and the basis of
// the workflow triggers — the server polls GitLab regularly and starts workflows on new merge requests, work items,
// comments, pushes or pipelines.
//
// Three peculiarities of the server contract determine the whole screen:
//
// 1. The token is stored and used, but NEVER returned — neither in the list nor after creating nor after a PATCH. Only
//    `hasToken` says that one exists. The view must therefore never try to show or prefill it; it can only REPLACE it.
// 2. `POST …/test` answers with HTTP 200 EVEN on failure — `ok` decides, not the status code. Whoever looks only at the
//    status takes an expired token for valid.
// 3. An empty token field on PATCH means "keep", not "delete". The body must therefore not accidentally send the field
//    empty — so only `label` goes out when renaming and only `token` when replacing.

/// A connected GitLab account. Decoded tolerantly: a fixture or an older server without `createdAt`/`updatedAt` must not
/// empty the whole view.
struct GitlabAccount: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var host: String
    var userName: String
    var userId: Int
    /// `true` if a token is stored. The token itself never comes along.
    var hasToken: Bool
    /// "" = last OK, otherwise the last error message (already translated by the server).
    var status: String
    var checkedAt: Double
    var createdAt: Double
    var updatedAt: Double

    /// What stands in the top line: the freely chosen name, otherwise the host.
    var displayName: String { label.isEmpty ? host : label }

    enum CodingKeys: String, CodingKey {
        case id, label, host, userName, userId, hasToken, status, checkedAt, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        label = c.str(.label)
        host = c.str(.host)
        userName = c.str(.userName)
        userId = c.int(.userId)
        hasToken = c.bool(.hasToken)
        status = c.str(.status)
        checkedAt = c.dbl(.checkedAt)
        createdAt = c.dbl(.createdAt)
        updatedAt = c.dbl(.updatedAt)
    }
}

/// GET /api/gitlab/accounts
struct GitlabAccountsResponse: Decodable, Sendable {
    let accounts: [GitlabAccount]

    enum CodingKeys: String, CodingKey { case accounts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = c.list(.accounts, GitlabAccount.self)
    }
}

/// POST /api/gitlab/accounts/:id/test — both branches answer with 200, so `ok` decides. On success `error` is absent, on
/// failure `userName`, `name` and `webUrl` are absent.
struct GitlabTestResult: Decodable, Sendable {
    let ok: Bool
    let userName: String?
    let name: String?
    let webUrl: String?
    let error: String?

    enum CodingKeys: String, CodingKey { case ok, userName, name, webUrl, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok)
        userName = c.strOpt(.userName)
        name = c.strOpt(.name)
        webUrl = c.strOpt(.webUrl)
        error = c.strOpt(.error)
    }
}

/// POST /api/gitlab/accounts — all three fields go out; `token` is required.
private struct GitlabCreateBody: Encodable {
    let label: String
    let host: String
    let token: String
}

/// PATCH /api/gitlab/accounts/:id — here it is EXACTLY RIGHT that a synthesized Encodable omits a nil key: the server
/// considers only what is in the body. An accompanying empty `label` would delete the name, an accompanying empty host
/// would be a 400 — so per action only the one field that is meant goes out.
private struct GitlabPatchBody: Encodable {
    var label: String? = nil
    var host: String? = nil
    var token: String? = nil
}

/// GitLab orange #fc6d26 — the same colour as on the trigger node in the workflow editor (`WorkflowNodeType.tint`). The
/// colour carries the recognition, red carries the warning.
private let gitlabOrange = Color(red: 0.99, green: 0.43, blue: 0.15)

private func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The message of a failed call. `APIClient.validate` has already read the server's `{error}` text and put it into the
/// `APIError` — displaying it is enough.
private func notice(_ error: Error) -> String {
    (error as? APIError)?.message ?? error.localizedDescription
}

struct GitlabSettingsView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var accounts: [GitlabAccount] = []
    @State private var loading = true
    @State private var error = ""
    /// "" = free, "add" = currently creating, otherwise the id of the account being worked on.
    @State private var busy = ""
    /// Result of the last "Check" — for this session only, as on the desktop.
    @State private var testResult: [String: String] = [:]
    @State private var connectOpen = false
    @State private var tokenAccount: GitlabAccount?
    @State private var renameAccount: GitlabAccount?
    @State private var deleteAccount: GitlabAccount?

    var body: some View {
        CbList {
            if loading {
                Section { CbLoading(label: L("Loading accounts…")) }
            }
            if !error.isEmpty {
                Section {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("gitlab-error")
                }
            }
            // The page is called "Integrations" and GitLab is a SECTION in it (as on the web) — a second service fits
            // below without rebuilding the page. The explanatory sentence belongs to this group and stands there now —
            // same wording, same key.
            CbSettingGroup(
                title: L("Accounts"),
                hint: L("Connected accounts for workflow triggers: cbase polls GitLab regularly and starts workflows on new merge requests, work items, comments, pushes or pipelines.")
            ) {
                if accounts.isEmpty && !loading {
                    Text(L("No GitLab account connected yet."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("gitlab-empty")
                }
                ForEach(accounts) { account in accountRow(account) }
                // The sentence about the token stands on THIS row — where someone is just fetching and entering a token.
                CbSettingRow(
                    title: L("Connect GitLab"),
                    hint: L("The token stays on this machine (or in your server environment) and is never returned to the interface."),
                    symbol: "plus.circle"
                ) {
                    Button(L("Connect")) { connectOpen = true }
                        .font(.caption)
                        .buttonStyle(.borderless)
                        .disabled(!busy.isEmpty)
                        .accessibilityIdentifier("gitlab-add")
                }
            }
        }
        .navigationTitle(L("GitLab"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $connectOpen) {
            GitlabConnectSheet { label, host, token in
                await connect(label: label, host: host, token: token)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $tokenAccount) { account in
            GitlabTokenSheet(name: account.displayName) { newToken in
                await tokenReplace(account, newToken)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $renameAccount) { account in
            GitlabRenameSheet(name: account.label) { newName in
                await rename(account, newName)
            }
            .cbSheet(.whole)
        }
        .alert(
            L("Remove account?"),
            isPresented: Binding(get: { deleteAccount != nil }, set: { if !$0 { deleteAccount = nil } }),
            presenting: deleteAccount
        ) { account in
            Button(L("Remove"), role: .destructive) { Task { await remove(account) } }
            Button(L("Cancel"), role: .cancel) {}
        } message: { account in
            Text(L("Remove account “{name}”? Triggers using it will stop firing.", ["name": account.displayName]))
        }
    }

    // ── One account row ──────────────────────────────────────────────────────
    // An account is ONE list cell: only so does the swipe gesture act on the whole account and not just one of its rows.
    // The identifiers hang on the texts and buttons, never on the stack — on a container they move to every child and make
    // the buttons inside unfindable.
    @ViewBuilder
    private func accountRow(_ account: GitlabAccount) -> some View {
        // Two different statements that used to be one — and therefore both were only half true: "something is running on
        // THIS account" (then the capsule says "Checking…") and "an operation is running somewhere" (then the whole list is
        // locked). It is locked ALSO while creating: afterwards it reloads, and a button pressed meanwhile may already
        // belong to another row.
        let running = busy == account.id
        let locked = !busy.isEmpty
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.symbol(16))
                    .foregroundStyle(account.status.isEmpty ? gitlabOrange : Color.red)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.displayName)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .accessibilityIdentifier("gitlab-account-\(account.id)")
                    Text(subtitle(account))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            if let (text, isError) = statusLine(account) {
                Text(text)
                    .font(.caption2)
                    .foregroundStyle(isError ? Color.red : Color.secondary)
                    .accessibilityIdentifier("gitlab-status-\(account.id)")
            }
            // Two short rows instead of one long one: four capsules side by side wrap at phone width. "Remove" stands alone
            // on the right — it is the only action that undoes nothing.
            HStack(spacing: 8) {
                PillButton(title: running ? L("Checking…") : L("Check"), disabled: locked) {
                    Task { await check(account) }
                }
                .accessibilityIdentifier("gitlab-test-\(account.id)")
                PillButton(title: L("Replace token"), disabled: locked) {
                    tokenAccount = account
                }
                .accessibilityIdentifier("gitlab-token-\(account.id)")
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                PillButton(title: L("Rename"), disabled: locked) {
                    renameAccount = account
                }
                .accessibilityIdentifier("gitlab-rename-\(account.id)")
                Spacer(minLength: 0)
                PillButton(title: L("Remove"), destructive: true, disabled: locked) {
                    deleteAccount = account
                }
                .accessibilityIdentifier("gitlab-delete-\(account.id)")
            }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deleteAccount = account } label: {
                Label(L("Remove"), systemImage: "trash")
            }
        }
    }

    /// Host · @user · token stored — exactly the parts that are really present.
    private func subtitle(_ account: GitlabAccount) -> String {
        var parts = [account.host]
        if !account.userName.isEmpty { parts.append("@" + account.userName) }
        if account.hasToken { parts.append(L("token stored")) }
        return parts.joined(separator: " · ")
    }

    /// The server's stored error wins over this session's test result: it is the reason why the trigger is not firing
    /// right now.
    private func statusLine(_ account: GitlabAccount) -> (String, Bool)? {
        if !account.status.isEmpty { return (account.status, true) }
        if let result = testResult[account.id], !result.isEmpty { return (result, false) }
        return nil
    }

    // ── Calls ────────────────────────────────────────────────────────────────
    // All HTTP calls live here, not in the sheets: the sheets only collect input and on failure return the message (nil =
    // succeeded). That way they need no EnvironmentObject, and the list is reloaded in ONE place.

    /// Release the lock — but only if it still belongs to THIS operation.
    ///
    /// Two operations can overlap: a sheet sends while a "Check" is still running in the list. A blind `busy = ""` would then
    /// release the other's lock, and its row would stand there operable again in the middle of the call — with buttons that
    /// point to a state the running call is just replacing.
    private func approve(_ mine: String) {
        if busy == mine { busy = "" }
    }

    private func load() async {
        guard let client = session.client else { loading = false; return }
        do {
            let response: GitlabAccountsResponse = try await client.get("/api/gitlab/accounts", timeout: 20)
            accounts = response.accounts
            error = ""
        } catch {
            self.error = notice(error)
        }
        loading = false
    }

    /// Checking answers with 200 on failure too — `ok` decides. Afterwards always reload: the server writes `status`,
    /// `checkedAt` and `userName` along.
    private func check(_ account: GitlabAccount) async {
        guard let client = session.client else { return }
        busy = account.id
        var callError = ""
        do {
            let result: GitlabTestResult = try await client.post("/api/gitlab/accounts/\(account.id)/test")
            if result.ok {
                testResult[account.id] = L("Connection works — @{user}", ["user": result.userName ?? ""])
            } else {
                let text = result.error ?? ""
                testResult[account.id] = text.isEmpty ? L("Error") : text
            }
            error = ""
        } catch {
            callError = notice(error)
        }
        // Reload first, THEN release: `load()` fetches `status`, `checkedAt` and `userName` from the server, and those are
        // the actual result of the check run. Whoever resets the capsule earlier shows "Check" above a row that still
        // carries the old state.
        await load()
        rememberError(callError)
        approve(account.id)
    }

    private func connect(label: String, host: String, token: String) async -> String? {
        guard let client = session.client else { return L("Error") }
        busy = "add"
        defer { approve("add") }
        do {
            let _: GitlabAccount = try await client.post(
                "/api/gitlab/accounts",
                body: GitlabCreateBody(label: label, host: host, token: token)
            )
            await load()
            return nil
        } catch {
            return notice(error)
        }
    }

    /// Only `token` goes out — an accompanying host would carry an accidentally changed value along, and an empty label
    /// would delete the name.
    private func tokenReplace(_ account: GitlabAccount, _ newToken: String) async -> String? {
        guard let client = session.client else { return L("Error") }
        busy = account.id
        defer { approve(account.id) }
        do {
            let _: GitlabAccount = try await client.patch(
                "/api/gitlab/accounts/\(account.id)",
                body: GitlabPatchBody(token: newToken)
            )
            testResult[account.id] = nil
            await load()
            return nil
        } catch {
            return notice(error)
        }
    }

    /// Renaming does not touch the token: without `host` and without `token` the server does not check with GitLab at all,
    /// so the call is fast and cannot fail at GitLab.
    private func rename(_ account: GitlabAccount, _ newName: String) async -> String? {
        guard let client = session.client else { return L("Error") }
        busy = account.id
        defer { approve(account.id) }
        do {
            let _: GitlabAccount = try await client.patch(
                "/api/gitlab/accounts/\(account.id)",
                body: GitlabPatchBody(label: newName)
            )
            await load()
            return nil
        } catch {
            return notice(error)
        }
    }

    private func remove(_ account: GitlabAccount) async {
        guard let client = session.client else { return }
        busy = account.id
        var callError = ""
        do {
            let _: OKResponse = try await client.delete("/api/gitlab/accounts/\(account.id)")
            testResult[account.id] = nil
            error = ""
        } catch {
            callError = notice(error)
        }
        // As with checking: the row vanishes only with the fresh state, so the release belongs after it.
        await load()
        rememberError(callError)
        approve(account.id)
    }

    /// Put the message of a failed call in place AFTER reloading.
    ///
    /// Both calls above reload the list afterwards, and `load()` deletes the error row on success — it knows nothing of the
    /// call that just went wrong. Without this addendum a failed check or delete looked like nothing: the capsule went
    /// back, the list stood unchanged, and nothing was said.
    ///
    /// An own error of the reload stays, by contrast. It is the younger and the weightier message — with it the list itself
    /// is no longer current, and concealing that would be the costlier of the two errors.
    private func rememberError(_ text: String) {
        guard !text.isEmpty, error.isEmpty else { return }
        error = text
    }
}

// ── Sheets ──────────────────────────────────────────────────────────────────

/// Connect a new account. On failure the sheet stays open and the token stays — the user has just pasted it and should not
/// have to fetch it again.
private struct GitlabConnectSheet: View {
    /// Returns the message on failure, nil on success.
    let connect: (String, String, String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    /// By far the most common host, and the server would take it as the default anyway.
    @State private var host = "https://gitlab.com"
    @State private var token = ""
    @State private var running = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Name (free-form)")) {
                    TextField(L("e.g. company GitLab"), text: $label)
                        .accessibilityIdentifier("gitlab-add-label")
                }
                Section(L("Host")) {
                    TextField("https://gitlab.com", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityIdentifier("gitlab-add-host")
                }
                Section {
                    SecureField("glpat-…", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("gitlab-add-token")
                } header: {
                    Text(L("Personal access token"))
                } footer: {
                    Text(L("Create one in GitLab under Profile → Access Tokens. read_api is enough for listening; use api if the agent should also write (comments, MRs)."))
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("gitlab-add-error")
                    }
                }
            }
            .navigationTitle(L("Connect GitLab"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(running ? L("Checking…") : L("Connect")) { Task { await send() } }
                        .disabled(running || trimmed(token).isEmpty)
                        .accessibilityIdentifier("gitlab-add-submit")
                }
            }
        }
    }

    private func send() async {
        running = true
        error = ""
        let result = await connect(trimmed(label), trimmed(host), trimmed(token))
        running = false
        if let result { error = result } else { dismiss() }
    }
}

/// Replace the token. The old one stays until the new one is verified — the server stores only after a successful
/// `GET /api/v4/user`.
private struct GitlabTokenSheet: View {
    let name: String
    let save: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var running = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    SecureField("glpat-…", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("gitlab-token-field")
                } header: {
                    Text(L("New access token for {name}:", ["name": name]))
                } footer: {
                    Text(L("The old token stays in place until the new one has been verified."))
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("gitlab-token-error")
                    }
                }
            }
            .navigationTitle(L("Replace token"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(running ? L("Checking…") : L("Save")) { Task { await send() } }
                        .disabled(running || trimmed(token).isEmpty)
                        .accessibilityIdentifier("gitlab-token-save")
                }
            }
        }
    }

    private func send() async {
        running = true
        error = ""
        let result = await save(trimmed(token))
        running = false
        if let result { error = result } else { dismiss() }
    }
}

/// Rename. An empty name is allowed and deletes the label — the host then stands in the row again, just like on an account
/// that never got a name.
private struct GitlabRenameSheet: View {
    let name: String
    let save: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var running = false
    @State private var error = ""
    @State private var prefilled = false

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Name (free-form)")) {
                    TextField(L("e.g. company GitLab"), text: $draft)
                        .accessibilityIdentifier("gitlab-rename-field")
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("gitlab-rename-error")
                    }
                }
            }
            .navigationTitle(L("Rename"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) { Task { await send() } }
                        .disabled(running)
                        .accessibilityIdentifier("gitlab-rename-save")
                }
            }
            .onAppear {
                // Prefill only ONCE: a second pass would overwrite the user's input as soon as SwiftUI rebuilds the view.
                if !prefilled { draft = name; prefilled = true }
            }
        }
    }

    private func send() async {
        running = true
        error = ""
        let result = await save(trimmed(draft))
        running = false
        if let result { error = result } else { dismiss() }
    }
}
