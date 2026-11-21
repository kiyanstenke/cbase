import SwiftUI

// Settings → Integrations, second group "ngrok", as on the web (`web/src/components/settings/NgrokSettings.tsx`). Access for
// preview links: authtoken (required, mode `dev`, free plan) and an optional API key (mode `names`, one reserved random name
// per link). Shows the mode as a sentence, plus the links and their history.
//
// The contract that shapes the screen:
//  1. **Values never come back.** `GET /api/integrations/ngrok` only says WHETHER an authtoken / API key is stored, so the
//     fields always start empty and can only REPLACE (same as the GitLab token).
//  2. **`PUT` requires BOTH keys**: a string sets, `null` keeps, `""` deletes. An empty field in the sheet means "keep" and
//     goes out as `null` (`NgrokAccessBody` encodes `nil` explicitly; a synthesized Encodable would drop the key, giving 400).
//     Saving happens only after the check passed; if it fails (400 CHECK), the sheet stays open with the input.
//  3. Deleting while links are active gives 409; the server's sentence names the count and shows in the sheet or group.
//  4. A server without the routes (404) hides the group: there is nothing to enter.
//
// Never take the values from the chat: the human enters them here. Nothing goes to the log.
//
// Identifiers: `ngrok-group`, `ngrok-mode`, `ngrok-error`, `ngrok-enter`, `ngrok-apikey-remove`, `ngrok-remove`,
// in the sheet `ngrok-authtoken-field`, `ngrok-apikey-field`, `ngrok-save`, `ngrok-sheet-error`.

/// The "Preview links" group, shown alone on the `NgrokSettingsView` page (IntegrationsList.swift).
struct NgrokSettings: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState

    /// `nil` until the access has answered once.
    @State private var access: NgrokAccess?
    /// `false` after a 404: the server does not know the routes, so the group is dropped.
    @State private var available = true
    @State private var error = ""
    @State private var running = false
    @State private var sheetOpen = false
    @State private var question: Question?
    @StateObject private var links = PreviewLinksModel()

    private enum Question: Identifiable {
        case removeApiKey, removeEverything
        var id: Int { self == .removeApiKey ? 0 : 1 }
    }

    var body: some View {
        Group {
            if available {
                group
            }
        }
        .task {
            links.client = session.client
            await load()
        }
        .onChange(of: state.previewTick) {
            Task { await load() }
        }
        .sheet(isPresented: $sheetOpen) {
            NgrokAccessSheet(authtokenStored: access?.authtoken == true, apiKeyStored: access?.apiKey == true) { authtoken, apiKey in
                await save(NgrokAccessBody(authtoken: authtoken, apiKey: apiKey))
            }
            .cbSheet(.whole)
        }
        .confirmationDialog(
            question == .removeApiKey ? L("Remove API key?") : L("Remove ngrok access?"),
            isPresented: Binding(get: { question != nil }, set: { if !$0 { question = nil } }),
            titleVisibility: .visible,
            presenting: question
        ) { which in
            Button(L("Remove"), role: .destructive) {
                Task {
                    switch which {
                    case .removeApiKey:
                        if let notice = await save(NgrokAccessBody(authtoken: nil, apiKey: "")) { error = notice }
                    case .removeEverything:
                        await removeEverything()
                    }
                }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: { which in
            Text(which == .removeApiKey
                 ? L("Without an API key the free plan applies again: one address, one link at a time.")
                 : L("Without an authtoken no more preview links can be created."))
        }
    }

    @ViewBuilder
    private var group: some View {
        CbSettingGroup(
            title: L("Preview links"),
            hint: L("Preview links to running services of your projects, through your own ngrok account. Anyone with a link sees the app without signing in to cbase.")
        ) {
            if let access {
                Text(modeSet(access))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ngrok-mode")
                // cbase cannot see the ngrok PLAN, only whether an API key is stored, so upgrading to Hobbyist changed nothing.
                // The way forward is shown here, as on the web.
                if access.mode == .dev {
                    Text(L("cbase can't see your ngrok plan. On Hobbyist or higher, create a key in the ngrok dashboard under “API Keys” and enter it here — then every new link gets a name of its own, up to three at a time."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityIdentifier("ngrok-plan-hint")
                }
                if !access.sdk {
                    Label(L("The ngrok SDK is not loaded on this server — links cannot be created."), systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if !access.error.isEmpty {
                    Label(access.error, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                accessRows(access)
            } else if error.isEmpty {
                CbLoading(label: L("Loading ngrok access…"))
            }
            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("ngrok-error")
            }
            linkRows
        }
        .accessibilityIdentifier("ngrok-group")
    }

    // ── Access ──
    @ViewBuilder
    private func accessRows(_ access: NgrokAccess) -> some View {
        CbSettingRow(
            title: L("Authtoken"),
            hint: access.authtoken ? L("stored") : L("not stored — without it there are no links"),
            symbol: "key"
        )
        CbSettingRow(
            title: L("API key (optional)"),
            hint: access.apiKey ? L("stored") : L("not stored — with it every link gets a name of its own"),
            symbol: "key.horizontal"
        )
        HStack(spacing: 8) {
            PillButton(title: access.authtoken ? L("Replace") : L("Enter##fill"), disabled: running) {
                error = ""
                sheetOpen = true
            }
            .accessibilityIdentifier("ngrok-enter")
            if access.apiKey {
                PillButton(title: L("Remove API key"), disabled: running) { question = .removeApiKey }
                    .accessibilityIdentifier("ngrok-apikey-remove")
            }
            Spacer(minLength: 0)
            if access.authtoken || access.apiKey {
                PillButton(title: L("Remove"), destructive: true, disabled: running) { question = .removeEverything }
                    .accessibilityIdentifier("ngrok-remove")
            }
        }
    }

    /// The mode as a sentence: off, free plan, own names.
    private func modeSet(_ access: NgrokAccess) -> String {
        switch access.mode {
        case .off: return L("No authtoken stored — preview links are off.")
        case .dev: return L("Authtoken only: always the same dev address, one link at a time.")
        case .names: return L("With API key: a random name of its own per link, up to {n} at a time.", ["n": access.limit])
        case .none: return L("Unknown mode — this server is newer than the app.")
        }
    }

    // ── Links ──
    @ViewBuilder
    private var linkRows: some View {
        if let snapshot = links.snapshot {
            if let notice = links.notice {
                Text(verbatim: notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if snapshot.active.isEmpty {
                Text(L("No preview link active. You create one at the service (ports in the header)."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(snapshot.active) { link in
                PreviewLinkRow(model: links, link: link, withService: true)
            }
            if !snapshot.history.isEmpty {
                DisclosureGroup(L("History ({n})", ["n": snapshot.history.count])) {
                    ForEach(snapshot.history) { link in
                        PreviewLinkRow(model: links, link: link, withService: true)
                    }
                }
                .font(.caption)
            }
        }
    }

    // ── Calls ──

    private func load() async {
        guard let client = session.client else { return }
        do {
            let response: NgrokAccess = try await client.get("/api/integrations/ngrok", timeout: 20)
            access = response
            available = true
            error = ""
        } catch let e as APIError where e.status == 404 {
            available = false
            return
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        await links.load()
    }

    /// `PUT` with both keys. On failure returns the server's sentence (400 CHECK, 409), otherwise `nil`.
    private func save(_ body: NgrokAccessBody) async -> String? {
        guard let client = session.client else { return L("Error") }
        running = true
        defer { running = false }
        do {
            let response: NgrokAccess = try await client.put("/api/integrations/ngrok", body: body)
            access = response
            error = ""
            await links.load()
            return nil
        } catch {
            return (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    private func removeEverything() async {
        guard let client = session.client else { return }
        running = true
        defer { running = false }
        do {
            let _: OKResponse = try await client.delete("/api/integrations/ngrok")
            error = ""
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        let notice = error
        await load()
        if !notice.isEmpty { error = notice }
    }
}

/// Enter or replace the access. Both fields are empty (the values never come back); an empty field stays UNCHANGED.
/// On failure the sheet stays open with the input: the user has just pasted the value.
private struct NgrokAccessSheet: View {
    let authtokenStored: Bool
    let apiKeyStored: Bool
    /// `(authtoken, apiKey)`, each `nil` = unchanged. Returns the message on failure, `nil` on success.
    let save: (String?, String?) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var authtoken = ""
    @State private var apiKey = ""
    @State private var running = false
    @State private var error = ""

    private func value(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    SecureField(authtokenStored ? L("stored — leave empty to keep") : L("Authtoken"), text: $authtoken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("ngrok-authtoken-field")
                } header: {
                    Text(L("Authtoken"))
                } footer: {
                    Text(L("In the ngrok dashboard under “Your Authtoken”. Enough for the free plan: one fixed address, one link at a time."))
                }
                Section {
                    SecureField(apiKeyStored ? L("stored — leave empty to keep") : L("API key (optional)"), text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("ngrok-apikey-field")
                } header: {
                    Text(L("API key (optional)"))
                } footer: {
                    Text(L("In the ngrok dashboard under “API Keys” (Hobbyist and up). Then every link gets a random name of its own, released again when it ends."))
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("ngrok-sheet-error")
                    }
                }
            }
            .navigationTitle(L("ngrok access"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel"), locked: running) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(running ? L("Checking…") : L("Save")) { Task { await send() } }
                        .disabled(running || (value(authtoken) == nil && value(apiKey) == nil))
                        .accessibilityIdentifier("ngrok-save")
                }
            }
        }
    }

    private func send() async {
        running = true
        error = ""
        let result = await save(value(authtoken), value(apiKey))
        running = false
        if let result { error = result } else { dismiss() }
    }
}
