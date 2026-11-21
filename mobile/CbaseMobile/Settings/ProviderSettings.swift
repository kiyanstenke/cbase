import SwiftUI
import UIKit

// ── Providers ──
//
// Exactly THREE cards in a fixed order (by contract: Claude, Codex, OpenRouter). The editor for free-form providers
// (presets, base URL, model catalog, extra fields, capability overrides) and "Add provider" are gone. OpenRouter is a fixed
// card: set or remove the key, the two privacy toggles, the default model from the whole catalog WITH SEARCH (`ModelChoice`)
// and the default effort level.
//
// The explanatory paragraph above the page sits as an (i) on the "Active" mark, and each card shows at top right what is left
// of the provider: Claude and Codex the RING with their remaining quota (same calculation as the header rings and the usage
// overview: `subscriptionQuota` in UsageSettings.swift), OpenRouter its CREDIT (`/api/usage/openrouter-credit`; unknown shows
// nothing, never "$0").
struct ProviderSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var data: ProviderInfoResponse?
    @State private var account: AccountStatus?
    @State private var loading = true
    @State private var error = ""
    @State private var switching: String?
    @State private var connecting: String?
    @State private var busy: String?
    @State private var claudeUsage: ClaudeUsage?
    @State private var codexUsage: CodexUsage?
    /// Access to OpenRouter; `nil` = not loaded (or the fetch failed). Then NO toggles are shown: a toggle at OFF from a failed
    /// fetch would go to the server as "off" with the next save (empty is not unknown).
    @State private var openrouter: OpenRouterAccess?
    @State private var openrouterError = ""
    @State private var credit: OpenRouterCredit?
    /// A freshly typed key; goes out only with "Save key", never with a toggle.
    @State private var key = ""
    /// For WHICH set of connected providers the quotas were last fetched.
    ///
    /// The numbers deliberately do NOT follow the 2.5-second sign-in poll: they change by the minute, and extra fetches every
    /// 2.5 seconds would be a poll on foreign endpoints nobody asked for. They are re-measured when the set changes, i.e. after a
    /// sign-in and after a disconnect. `nil` means "never measured" and is not the same as "nobody connected" (the empty string).
    @State private var measuredFor: String?

    private let planLabels = ["team": "Team", "pro": "Pro", "max": "Max", "enterprise": "Enterprise", "free": "Free"]

    var body: some View {
        CbList {
            if loading && data == nil {
                Section { CbLoading(label: L("Loading providers…")) }
            }
            ForEach(subscriptionProvider) { provider in
                Section {
                    providerHeader(provider)
                    HStack(spacing: 8) {
                        Circle()
                            .fill(provider.connected ? Color.green : Color.secondary.opacity(0.35))
                            .frame(width: 8, height: 8)
                        Text(provider.connected ? L("Connected") : L("Not connected"))
                            .font(.subheadline)
                        Spacer()
                        if provider.connected {
                            PillButton(title: busy == provider.id ? "…" : L("Disconnect"), destructive: true) {
                                Task { await logout(provider.id) }
                            }
                        } else if connecting != provider.id {
                            PillButton(
                                title: provider.id == "claude" ? L("Connect with Claude") : L("Connect with ChatGPT"),
                                prominent: true
                            ) {
                                connecting = provider.id
                            }
                            .accessibilityIdentifier("provider-connect-\(provider.id)")
                        }
                    }
                    if provider.id == "claude", provider.connected, let account {
                        if let email = account.email { metaRow(L("Email"), email) }
                        if let org = account.orgName { metaRow(L("Organization"), org) }
                        if let plan = account.subscriptionType {
                            metaRow(L("Plan##subscription"), planLabels[plan] ?? plan)
                        }
                    }
                    if connecting == provider.id {
                        AuthLoginConsoleView(
                            connectPath: provider.id == "claude" ? "/api/account/connect" : "/api/account/codex/connect",
                            title: provider.id == "claude" ? L("Claude sign-in") : L("Codex sign-in")
                        ) {
                            connecting = nil
                            Task { await load() }
                        }
                        PillButton(title: L("Cancel")) { connecting = nil }
                    }
                    capsRow(provider)
                    defaultModel(provider)
                }
            }

            openRouterCard

            if !error.isEmpty {
                Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
            }
        }
        .navigationTitle(L("Providers"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: connecting) { _, value in
            guard value != nil else { return }
            Task {
                // While logging in, check regularly whether the connection is up.
                while connecting != nil {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    await load()
                    if data?.providers.first(where: { $0.id == connecting })?.connected == true {
                        connecting = nil
                    }
                }
            }
        }
    }

    /// Claude and Codex, in the order of the contract. Anything else the server reports is not shown; there is no fourth provider.
    /// An older server may still report free-form ones.
    private var subscriptionProvider: [ProviderInfo] {
        UsageContract.subscriptionProvider.compactMap { id in data?.providers.first(where: { $0.id == id }) }
    }

    private var openRouterInfo: ProviderInfo? {
        data?.providers.first(where: { $0.id == UsageContract.openrouterId })
    }

    // ── OpenRouter: the fixed card ──

    @ViewBuilder
    private var openRouterCard: some View {
        if data != nil {
            Section {
                openRouterHeader
                HStack(spacing: 8) {
                    Circle()
                        .fill(openrouter?.keySet == true ? Color.green : Color.secondary.opacity(0.35))
                        .frame(width: 8, height: 8)
                    Text(openrouter.map { $0.keySet ? L("Key stored") : L("No key") } ?? "—")
                        .font(.subheadline)
                        .accessibilityIdentifier("openrouter-status")
                    Spacer()
                    if openrouter?.keySet == true {
                        PillButton(title: busy == UsageContract.openrouterId ? "…" : L("Remove key"), destructive: true) {
                            Task { await removeKey() }
                        }
                        .accessibilityIdentifier("openrouter-key-remove")
                    }
                }
                if let access = openrouter {
                    HStack(spacing: 8) {
                        SecureField(access.keySet ? L("Enter a new key") : L("API key (sk-or-…)"), text: $key)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .cbFont(13, design: .monospaced)
                            .accessibilityIdentifier("openrouter-key")
                        PillButton(title: busy == "openrouter-save" ? "…" : L("Save"), prominent: true) {
                            Task { await save(access, withKey: true) }
                        }
                        .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("openrouter-key-save")
                    }
                    CbSettingRow(
                        title: L("Only providers without data retention"),
                        hint: L("OpenRouter only routes to providers that do not store requests (zero data retention).")
                    ) {
                        Toggle("", isOn: Binding(
                            get: { access.onlyWithoutSaving },
                            set: { fresh in
                                var snapshot = access
                                snapshot.onlyWithoutSaving = fresh
                                openrouter = snapshot       // synchronous, otherwise the toggle snaps back
                                Task { await save(snapshot, withKey: false) }
                            }
                        ))
                        .labelsHidden()
                        .accessibilityLabel(L("Only providers without data retention"))
                        .accessibilityIdentifier("openrouter-zdr")
                    }
                    CbSettingRow(
                        title: L("No data use by providers"),
                        hint: L("Providers that use requests for training or otherwise are skipped.")
                    ) {
                        Toggle("", isOn: Binding(
                            get: { access.noDataUsage },
                            set: { fresh in
                                var snapshot = access
                                snapshot.noDataUsage = fresh
                                openrouter = snapshot
                                Task { await save(snapshot, withKey: false) }
                            }
                        ))
                        .labelsHidden()
                        .accessibilityLabel(L("No data use by providers"))
                        .accessibilityIdentifier("openrouter-data-usage")
                    }
                }
                if !openrouterError.isEmpty {
                    Label(openrouterError, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("openrouter-error")
                }
                if let provider = openRouterInfo {
                    capsRow(provider)
                    defaultModel(provider)
                }
            }
        }
    }

    private var openRouterHeader: some View {
        HStack(alignment: .top, spacing: 9) {
            marker(UsageContract.openrouterId)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(openRouterInfo?.label ?? "OpenRouter").font(.headline)
                    if data?.active == UsageContract.openrouterId { activeMarker }
                }
                if data?.active != UsageContract.openrouterId, openRouterInfo?.connected == true {
                    PillButton(title: switching == UsageContract.openrouterId ? L("Switching…") : L("Activate")) {
                        Task { await setActive(UsageContract.openrouterId) }
                    }
                    .accessibilityIdentifier("provider-activate-\(UsageContract.openrouterId)")
                }
            }
            Spacer(minLength: 8)
            // The credit instead of a ring: OpenRouter has no quota with a reset, but a pot. Unknown shows nothing.
            if let g = credit, g.known {
                VStack(alignment: .trailing, spacing: 2) {
                    CbOverline(L("Credits"))
                    Text(usageUsdText(g.restUsd))
                        .cbFont(14, weight: .semibold)
                        .monospacedDigit()
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("openrouter-credit")
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func providerHeader(_ provider: ProviderInfo) -> some View {
        HStack(alignment: .top, spacing: 9) {
            marker(provider.id)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(provider.label).font(.headline)
                    if data?.active == provider.id { activeMarker }
                }
                if data?.active != provider.id && provider.connected {
                    PillButton(title: switching == provider.id ? L("Switching…") : L("Activate")) {
                        Task { await setActive(provider.id) }
                    }
                    .accessibilityIdentifier("provider-activate-\(provider.id)")
                }
            }
            Spacer(minLength: 8)
            if provider.connected, let k = subscriptionQuota(provider.id, claude: claudeUsage, codex: codexUsage) {
                subscriptionRing(k)
            }
        }
        .padding(.vertical, 2)
    }

    /// The provider's mark. `ProviderMark` knows exactly two marks and draws the Claude mark for EVERYTHING that is not Codex,
    /// which would give OpenRouter the wrong mark. Hence its own symbol there.
    @ViewBuilder
    private func marker(_ id: String) -> some View {
        if id == "claude" || id == "codex" {
            ProviderMark(providerId: id, size: 18)
                .frame(width: 20, height: 20)
        } else {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.symbol(15))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
        }
    }

    /// The "Active" mark with its explanation; it explains exactly THIS mark, so it sits on it.
    private var activeMarker: some View {
        HStack(spacing: 0) {
            Text(L("Active"))
                .cbFont(9.5, weight: .bold)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.16), in: Capsule())
                .foregroundStyle(.tint)
            CbInfoButton(text: L("The active provider handles new chats and all AI side tasks (titles, context curation). Sign in here and switch between providers anytime."))
        }
    }

    /// The default model, only when there is anything to choose. For OpenRouter the whole catalog: the row opens the searchable
    /// sheet (`ModelChoice`, Kit/ModelSelection.swift) instead of a menu with hundreds of rows.
    @ViewBuilder
    private func defaultModel(_ provider: ProviderInfo) -> some View {
        if !provider.models.isEmpty {
            let binding = Binding(
                get: { provider.defaultModel },
                set: { model in Task { await setDefaultModel(provider.id, model) } }
            )
            CbSettingRow(title: L("Default model")) {
                ModelChoice(title: L("Default model"), groups: [ModelGroup(provider)], selection: binding) {
                    Picker(L("Default model"), selection: binding) {
                        ForEach(provider.models) { model in
                            Text(model.label).tag(model.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
                .labelsHidden()
                // Capped: a menu picker's label grows as wide as its longest model name and would push the title out of the row.
                .frame(maxWidth: 170, alignment: .trailing)
                .accessibilityIdentifier("default-model-\(provider.id)")
            }
            defaultLevel(provider)
        }
    }

    /// The default effort level next to the default model: the effort level of every chat of this provider without its own,
    /// clamped to that model at run time. The levels of the default model come from the SAME building block as every effort
    /// picker, without an empty entry (the default IS a level). No row if the provider has no effort level, the default model
    /// has no levels, or the server sends no default.
    @ViewBuilder
    private func defaultLevel(_ provider: ProviderInfo) -> some View {
        let catalog = data?.effortCatalog ?? []
        if let level = provider.defaultEffort, !level.isEmpty,
           EffortSelection.shows(catalog, provider: provider.id, model: provider.defaultModel) {
            CbSettingRow(title: L("Default effort")) {
                Picker(L("Default effort"), selection: Binding(
                    get: { level },
                    set: { fresh in Task { await setDefaultEffort(provider.id, fresh) } }
                )) {
                    ForEach(EffortSelection.entries(catalog, provider: provider.id, model: provider.defaultModel, current: level, empty: "").filter { !$0.id.isEmpty }) {
                        Text($0.label).tag($0.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(maxWidth: 170, alignment: .trailing)
                .accessibilityIdentifier("default-level-\(provider.id)")
            }
        }
    }

    @ViewBuilder
    private func capsRow(_ provider: ProviderInfo) -> some View {
        if let caps = provider.caps {
            // The same five chips in the same order as `CAPS` on the web client.
            let entries: [(String, Bool)] = [
                (L("Permission prompts"), caps.permissionPrompt),
                (L("Plan mode"), caps.plan),
                (L("Fork"), caps.fork),
                (L("Reasoning effort"), caps.effort),
                (L("Images"), caps.vision)
            ]
            // Horizontally scrollable: capability names must not break mid-word.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(entries, id: \.0) { entry in
                        HStack(spacing: 3) {
                            Image(systemName: entry.1 ? "checkmark" : "minus")
                                .font(.symbol(8, weight: .bold))
                            Text(entry.0)
                                .cbFont(10, weight: .medium)
                                .fixedSize()
                        }
                        .padding(.horizontal, 7)
                        .padding(.vertical, 4)
                        .background(
                            entry.1 ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.1),
                            in: Capsule()
                        )
                        .foregroundStyle(entry.1 ? Color.accentColor : Color.secondary)
                    }
                }
                .padding(.vertical, 1)
            }
        }
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.medium)).lineLimit(1)
        }
    }

    // ── Loading and saving ──

    private func load() async {
        guard let client = session.client else { return }
        loading = true
        defer { loading = false }
        do {
            data = try await client.get("/api/providers")
            account = try? await client.get("/api/account")
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        await loadOpenRouter()
        await loadQuotas()
    }

    /// Access to OpenRouter. A failure leaves the last state in place (or `nil`, then no toggles) and announces itself.
    private func loadOpenRouter() async {
        guard let client = session.client else { return }
        do {
            openrouter = try await client.loadOpenRouterAccess()
            openrouterError = ""
        } catch {
            openrouterError = error.localizedDescription
        }
    }

    /// The usage routes, but only when the set of connected providers has changed since last time (see `measuredFor`).
    /// A failure deletes nothing: the last measured value stays, as with the header rings.
    private func loadQuotas() async {
        guard let client = session.client else { return }
        let connected = (data?.providers ?? []).filter(\.connected).map(\.id).sorted().joined(separator: ",")
        guard measuredFor != connected else { return }
        measuredFor = connected
        if let usage: ClaudeUsage = try? await client.get("/api/usage") { claudeUsage = usage }
        if let usage: CodexUsage = try? await client.get("/api/usage/codex") { codexUsage = usage }
        if openRouterInfo?.connected == true || openrouter?.keySet == true {
            if let g = try? await client.loadOpenRouterCredit() { credit = g }
        } else {
            credit = nil
        }
    }

    /// Saves the access: BOTH toggles always (required by the contract), the key only on "Save". Afterwards the route re-reads
    /// the state, so the toggles show what the server holds, not what was typed.
    private func save(_ snapshot: OpenRouterAccess, withKey: Bool) async {
        guard let client = session.client else { return }
        busy = withKey ? "openrouter-save" : nil
        defer { busy = nil }
        let body = OpenRouterAccessBody(
            onlyWithoutSaving: snapshot.onlyWithoutSaving,
            noDataUsage: snapshot.noDataUsage,
            apiKey: withKey ? key : nil
        )
        do {
            openrouter = try await client.setOpenRouterAccess(body)
            openrouterError = ""
            if withKey { key = "" }
            measuredFor = nil
            await load()
        } catch {
            openrouterError = error.localizedDescription
            await loadOpenRouter()
        }
    }

    private func removeKey() async {
        guard let client = session.client else { return }
        busy = UsageContract.openrouterId
        defer { busy = nil }
        do {
            openrouter = try await client.removeOpenRouterKey()
            openrouterError = ""
            measuredFor = nil
            await load()
        } catch {
            openrouterError = error.localizedDescription
        }
    }

    private func setActive(_ id: String) async {
        guard let client = session.client else { return }
        struct Body: Encodable { let provider: String }
        switching = id
        defer { switching = nil }
        _ = try? await client.send("/api/provider", body: Body(provider: id))
        await load()
    }

    private func setDefaultModel(_ provider: String, _ model: String) async {
        guard let client = session.client else { return }
        struct Body: Encodable { let provider: String; let model: String }
        _ = try? await client.send("/api/default-model", method: .put, body: Body(provider: provider, model: model))
        await load()
    }

    private func setDefaultEffort(_ provider: String, _ effort: String) async {
        guard let client = session.client else { return }
        struct Body: Encodable { let provider: String; let effort: String }
        _ = try? await client.send("/api/default-effort", method: .put, body: Body(provider: provider, effort: effort))
        await load()
    }

    private func logout(_ id: String) async {
        guard let client = session.client else { return }
        busy = id
        defer { busy = nil }
        _ = try? await client.send(id == "claude" ? "/api/account/logout" : "/api/account/codex/logout")
        await load()
    }
}

/// Login console for `claude auth login` / `codex login`, the same PTY bridge as on the desktop.
struct AuthLoginConsoleView: View {
    @EnvironmentObject private var session: SessionStore
    let connectPath: String
    let title: String
    let onExit: () -> Void

    @State private var terminal: TerminalSession?
    @State private var input = ""
    @State private var error = ""
    @State private var scrollPosition = ScrollPosition(edge: .bottom)

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title.uppercased())
                    .cbFont(10, weight: .semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(L("Paste")) {
                    if let text = UIPasteboard.general.string { terminal?.send(text) }
                }
                .font(.caption)
            }
            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let terminal {
                AuthConsoleOutput(session: terminal, scrollPosition: $scrollPosition)
                HStack(spacing: 7) {
                    TextField(L("Input"), text: $input)
                        .cbFont(12, design: .monospaced)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .onSubmit { submit() }
                    Button(L("Send")) { submit() }
                        .font(.caption)
                }
            } else {
                CbLoading(compact: true)
            }
        }
        .task { await connect() }
        .onDisappear { terminal?.kill() }
    }

    private func submit() {
        let text = input
        input = ""
        terminal?.send(text + "\r")
    }

    private func connect() async {
        guard let client = session.client, terminal == nil else { return }
        do {
            let response: TerminalSessionResponse = try await client.post(connectPath)
            guard response.available else {
                error = response.error ?? L("Login not available")
                return
            }
            let created = TerminalSession(
                id: UUID().uuidString,
                title: title,
                termId: response.id,
                client: client,
                apiBase: ""
            )
            terminal = created
            await created.start()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct AuthConsoleOutput: View {
    @ObservedObject var session: TerminalSession
    @Binding var scrollPosition: ScrollPosition

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Text(session.output.isEmpty ? " " : session.output)
                .cbFont(10.5, design: .monospaced)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(height: 220)
        .scrollPosition($scrollPosition)
        .background(.cbElevated, in: RoundedRectangle(cornerRadius: 10))
        .onChange(of: session.output) { scrollPosition.scrollTo(edge: .bottom) }
        .accessibilityIdentifier("auth-console")
    }
}
