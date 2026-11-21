import SwiftUI

struct ContextBar: View {
    @ObservedObject var model: ChatViewModel

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.18))
                    Capsule()
                        .fill(barColor)
                        .frame(width: max(2, proxy.size.width * model.contextFraction))
                    // The threshold of automatic compaction: a tick on the track where cbase
                    // summarizes after the run. Without a level no tick. The share is the
                    // EFFECTIVE one (cap factored in, see autocompactShare), positioned on the DISPLAYED
                    // denominator (`autocompactMarker`) — the threshold itself stays with the catalog.
                    if model.autocompactShare > 0 {
                        Rectangle()
                            .fill(Color.secondary.opacity(0.8))
                            .frame(width: 1, height: 8)
                            .offset(x: proxy.size.width * model.autocompactMarker - 0.5)
                            .accessibilityIdentifier("autocompact-marker")
                    }
                }
            }
            .frame(height: 4)
            // Denominator, share and the provider of the last answer (`ContextDisplay`, twin of lib/context-display.ts):
            // without the word "Context" (the model button sits next to it): "26k / 1.05M · DeepInfra · 2 %".
            let display = model.contextDisplay
            Text(display.provider.isEmpty
                ? L("{used} / {total} · {pct} %", [
                    "used": ChatViewModel.formatTokens(model.contextTokens),
                    "total": ChatViewModel.formatTokens(display.denominator),
                    "pct": display.percent
                ])
                : L("{used} / {total} · {provider} · {pct} %", [
                    "used": ChatViewModel.formatTokens(model.contextTokens),
                    "total": ChatViewModel.formatTokens(display.denominator),
                    "provider": display.provider,
                    "pct": display.percent
                ]))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize()
                .help(title(display))
            // No compact button here: the handle sat directly above the keyboard and
            // was hit while typing. The function is in the chat menu ("Compact
            // context") and as /compact in the composer.
        }
    }

    private var barColor: Color {
        model.contextFraction > 0.85 ? .red : model.contextFraction > 0.6 ? .orange : .accentColor
    }

    /// The hint (pointer and VoiceOver): whose window the denominator is and what cbase computes with — "" without a provider.
    private func title(_ a: ContextDisplay.Snapshot) -> String {
        let catalog = ChatViewModel.formatTokens(a.catalogWindow)
        switch a.title {
        case .window:
            return L("Window of {provider}, the provider of the last response. cbase calculates with {catalog}.", ["provider": a.provider, "catalog": catalog])
        case .unknown:
            return L("{provider} delivered the last response; its window is unknown. cbase calculates with {catalog}.", ["provider": a.provider, "catalog": catalog])
        case .none:
            return ""
        }
    }
}

/// Autocompact per chat: TWO equal-ranking controls (share of the context window and
/// cap in tokens), each Default · Off · level — the same component for the coding chat.
/// Each control sits in its OWN submenu: twenty cap levels as a flat
/// list next to seven share levels would be a menu one scrolls through.
/// "Default" carries the global value in its label, so one sees what it currently means.
struct AutocompactMenu: View {
    @ObservedObject var model: ChatViewModel
    private let standardTag = -1

    private func set(_ field: ChatViewModel.AutocompactField, _ value: Int?) {
        Task {
            do { try await model.setAutocompact(field, value) }
            catch { model.error = error.localizedDescription }
        }
    }

    /// One control: submenu with the effective value in the label, the choice inside it.
    @ViewBuilder
    private func slider(
        title: String, symbol: String, choice: Int?, now: String, standard: String,
        stages: [Int], text: @escaping (Int) -> String, field: ChatViewModel.AutocompactField
    ) -> some View {
        Menu {
            Picker(title, selection: Binding(
                get: { choice ?? standardTag },
                set: { fresh in set(field, fresh == standardTag ? nil : fresh) }
            )) {
                Text("\(L("Default")) · \(standard)").tag(standardTag)
                Text(L("Off")).tag(0)
                ForEach(stages, id: \.self) { s in Text(text(s)).tag(s) }
            }
            .pickerStyle(.inline)
        } label: {
            Label("\(title) · \(now)", systemImage: symbol)
        }
        .accessibilityIdentifier("autocompact-\(field.rawValue)")
    }

    var body: some View {
        let doc = model.autocompactGlobal ?? AutocompactDoc()
        let share = model.autocompactEffective
        let cap = model.autocompactCap
        let own = model.chat.autocompact != nil || model.chat.autocompactMax != nil
        Menu {
            // During a workflow with its own compaction: a TEXT ROW at the top — not
            // a button, and not with "Autocompact" at the start (the UI test grabs the menu
            // via that start). The chat's choice below stays changeable and applies after the run.
            if let hint = model.autocompactWorkflowHint {
                Text(hint)
                    .accessibilityIdentifier("autocompact-workflow-hint")
                Divider()
            }
            slider(
                title: L("Share of the window"), symbol: "percent",
                choice: model.chat.autocompact,
                now: share > 0 ? "\(share) %" : L("off"),
                standard: doc.percent > 0 ? "\(doc.percent) %" : L("off"),
                stages: doc.stages, text: { "\($0) %" }, field: .share,
            )
            slider(
                title: L("No later than"), symbol: "gauge.with.dots.needle.33percent",
                choice: model.chat.autocompactMax,
                now: cap > 0 ? ChatViewModel.formatTokens(cap) : L("off"),
                standard: doc.maxTokens > 0 ? ChatViewModel.formatTokens(doc.maxTokens) : L("off"),
                stages: doc.maxStages, text: { ChatViewModel.formatTokens($0) }, field: .cap,
            )
            Divider()
            // Two controls mean two handles for "not at all" and "like everywhere else" — the
            // two cases one really wants with one tap.
            Button(L("Off for this chat")) { set(.share, 0); set(.cap, 0) }
                .disabled(model.chat.autocompact == 0 && model.chat.autocompactMax == 0)
            Button(L("Reset to standard")) { set(.share, nil); set(.cap, nil) }
                .disabled(!own)
        } label: {
            Label("\(L("Auto-compact")) · \(model.autocompactText(share, cap: cap))",
                  systemImage: "arrow.triangle.2.circlepath")
        }
        .accessibilityIdentifier("autocompact-menu")
    }
}

struct ChatSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: ChatViewModel
    @State private var provider = ""
    @State private var selectedModel = ""
    @State private var permission = "bypassPermissions"
    @State private var effort = ""
    /// Ultracode (its own toggle, independent of the level) — `save` sends it as its own field.
    @State private var ultracode = false
    /// Has the human chosen a level in THIS sheet? Set only through the binding of the selection (`levelChoice`),
    /// never through the reconciliation on opening — `save` then sends `effortChoice: true`.
    @State private var levelSelected = false
    @State private var busy = false
    @State private var error = ""
    @State private var confirmingProviderSwitch = false

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Model")) {
                    // The same latecomer as for the model below, one level higher: the
                    // list shows only CONNECTED providers, but the chat carries its own regardless
                    // of login. A `Picker` whose `selection` appears in no `tag` shows
                    // an EMPTY row in SwiftUI — one could not see which provider the
                    // chat is on, and every tap was already a switch. `/api/providers` can wait up to 15 s
                    // on `codex login status` for a provider with `connected:false` — the window is not short anyway.
                    Picker(L("Providers"), selection: $provider) {
                        ForEach(model.connectedProviders) { item in
                            Text(item.label).tag(item.id)
                        }
                        if providerMissing {
                            Text("\(selectedProvider?.label ?? provider) · \(L("not connected"))").tag(provider)
                        }
                    }
                    // The set value is appended at the end when the list does not carry it: `/api/providers`
                    // omits the models the signed-in account cannot run (gpt-5.4 and gpt-5.4-mini need an
                    // API key). A chat on one of them would otherwise show an EMPTY
                    // model row. The client does not know why it is missing — so the marker says
                    // only THAT it is missing; the reason is given by the server on saving.
                    // With OpenRouter: the same choice as a searchable sheet (Kit/ModelSelection.swift).
                    ModelChoice(title: L("Model"), groups: selectedProvider.map { [ModelGroup($0)] } ?? [],
                               selection: $selectedModel,
                               rear: modelMissing ? [ModelExtra(title: "\(selectedModel) · \(L("unavailable"))", value: selectedModel)] : []) {
                        Picker(L("Model"), selection: $selectedModel) {
                            ForEach(selectedProvider?.models ?? []) { item in
                                Text(item.label).tag(item.id)
                            }
                            if modelMissing {
                                Text("\(selectedModel) · \(L("unavailable"))").tag(selectedModel)
                            }
                        }
                    }
                }
                Section(L("Chat")) {
                    Picker(L("Permissions"), selection: $permission) {
                        Text(L("Full access")).tag("bypassPermissions")
                        Text(L("Auto-edit")).tag("acceptEdits")
                        Text(L("Plan")).tag("plan")
                        Text(L("Ask")).tag("default")
                    }
                    // The levels of the CHOSEN model (not of the saved one): whoever switches the model
                    // above should immediately see below what it supports. The entries are
                    // built by the building block of the four pickers (Kit/EffortSelection.swift).
                    // If the chosen model carries NO levels (Haiku 4.5) or the provider has
                    // `caps.effort` off, there is no selection — the building block decides that itself.
                    // A legacy chat without provider computes with the globally active one (`aktiv`).
                    // Ultracode is its own toggle below — independent of the level, also on a
                    // model without levels; `save` sends both fields separately.
                    EffortSelection(effort: levelChoice, empty: nil, providers: model.providers, provider: provider, model: selectedModel, active: model.activeProvider)
                    UltracodeToggle(on: $ultracode)
                }
                // The chat info of the outer loop: which background agents observe this chat,
                // their toggles for THIS chat, chat-own agents and the notes — its own page (`OuterLoopChatPage`).
                Section {
                    NavigationLink {
                        OuterLoopChatPage(client: model.client, chatId: model.chat.id, workspaceId: model.chat.workspaceId)
                    } label: {
                        Label(L("Outer loop"), systemImage: "arrow.triangle.2.circlepath")
                    }
                    .accessibilityIdentifier("chat-outerloop")
                } footer: {
                    Text(L("Background agents watching this chat, and their notes."))
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                }
            }
            .navigationTitle(L("Chat settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "chat-settings-close") { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) {
                        if provider != model.chat.provider
                            && model.timeline.contains(where: { $0.role == .user || $0.role == .assistant }) {
                            confirmingProviderSwitch = true
                        } else {
                            Task { await save(preserve: false) }
                        }
                    }
                    .disabled(busy || model.busy || provider.isEmpty || selectedModel.isEmpty)
                }
            }
            .confirmationDialog(L("Switch provider?"), isPresented: $confirmingProviderSwitch, titleVisibility: .visible) {
                Button(L("Preserve context and switch")) {
                    Task { await save(preserve: true) }
                }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("Provider sessions are not compatible. cbase compresses the history so far before switching to the new provider."))
            }
            .onAppear { syncSelections() }
            // A provider switch converts the model — but the FIRST reconciliation does not. `provider`
            // goes from "" to the chat's on opening, and because a hidden model (see
            // `modelMissing`) fails the membership check, merely expanding the
            // sheet would silently swap it for the default — a model the user never chose would then
            // be saved. As long as HIS provider stands, his model stands too.
            .onChange(of: provider) {
                if provider == model.chat.provider && !model.chat.model.isEmpty {
                    selectedModel = model.chat.model
                } else if !(selectedProvider?.models.contains(where: { $0.id == selectedModel }) ?? false) {
                    selectedModel = selectedProvider?.defaultModel ?? selectedProvider?.models.first?.id ?? ""
                }
            }
            .onChange(of: model.providers) { syncSelections() }
            // A model switch from a model without levels (Haiku) to one with: the picker has no empty entry any more.
            .onChange(of: selectedModel) { if effort.isEmpty { effort = defaultLevel } }
        }
    }

    /// The binding of the effort selection: writes the level AND notes that it was chosen. The reconciliation on opening and the
    /// default level after a model switch write `effort` directly and thus do not count as a choice.
    private var levelChoice: Binding<String> {
        Binding(get: { effort }, set: { fresh in
            effort = fresh
            levelSelected = true
        })
    }

    private var defaultLevel: String {
        EffortLevels.standard(model.providers, provider: EffortLevels.effectiveProvider(provider, active: model.activeProvider), model: selectedModel)
    }

    private var selectedProvider: Provider? {
        model.providers.first(where: { $0.id == provider })
    }

    /// Does the choice stand on a provider that is currently not connected? Unlike with the model,
    /// the client knows the reason here: `connected` comes with each provider,
    /// `/api/providers` filters nothing out. As long as the list is still empty there is nothing to
    /// report — an unloaded list does not mean "not connected" (empty is not unknown).
    private var providerMissing: Bool {
        guard !provider.isEmpty, !model.providers.isEmpty else { return false }
        return !model.connectedProviders.contains { $0.id == provider }
    }

    /// Does the choice stand on a model the provider no longer offers? Two causes,
    /// both external: the account may not run it (the server filters it from the list), or
    /// the catalog no longer knows it. As long as the provider list is still empty there is nothing
    /// to report here — an unloaded list does not mean "does not exist".
    private var modelMissing: Bool {
        guard !selectedModel.isEmpty, let provider = selectedProvider else { return false }
        return !provider.models.contains { $0.id == selectedModel }
    }

    private func syncSelections() {
        if provider.isEmpty {
            provider = model.chat.provider
        }
        let available = model.providers.first(where: { $0.id == provider })
        if selectedModel.isEmpty {
            selectedModel = model.chat.model.isEmpty
                ? (available?.defaultModel ?? available?.models.first?.id ?? "")
                : model.chat.model
        }
        permission = model.chat.permissionMode.isEmpty ? "bypassPermissions" : model.chat.permissionMode
        effort = model.chat.effort
        ultracode = model.chat.ultracode
        // Without a saved level the sheet shows the level that is RUNNING — the provider's default level,
        // clamped to the model, like the server (`effortRunning`) and the web (`useModelChoice`).
        if effort.isEmpty { effort = defaultLevel }
        // The reconciliation resets the level to the chat's state — a choice before it no longer counts.
        levelSelected = false
    }

    private func save(preserve: Bool) async {
        busy = true
        error = ""
        do {
            try await model.updateSettings(
                provider: provider,
                model: selectedModel,
                permissionMode: permission,
                effort: effort,
                // No browser picker any more: the browser always runs in the background
                // (toolchain/playwright.js), the column has no effect — the saved value goes back unchanged.
                browserMode: model.chat.browserMode,
                preserveContextOnProviderSwitch: preserve,
                // The toggle is its own field, independent of the level.
                ultracode: ultracode,
                // Only whoever touched the selection chooses a level — a model switch in the same sheet is not a level choice.
                effortChoice: levelSelected
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}

struct GoalSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var goal: String
    /// Archived chat: the goal is to be READ, not changed — no saving, no removing.
    /// The server rejected both with 409 anyway; a button that only leads to an error message does not belong
    /// on a chat where nothing is written.
    var onlyRead = false
    /// The set goal is paused: the sheet says so — otherwise the pause was only visible on the goal row of the
    /// composer, and "Save" with changed text silently resumes it.
    var paused = false
    let save: () async throws -> Void
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    if onlyRead {
                        Text(goal)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, minHeight: 60, alignment: .topLeading)
                            .accessibilityIdentifier("goal-only-read")
                    } else {
                        TextEditor(text: $goal)
                            .frame(minHeight: 140)
                    }
                } header: {
                    Text(L("Parent goal"))
                } footer: {
                    if onlyRead {
                        Text(L("The chat is archived — the goal can be changed after restoring it."))
                    } else if paused {
                        Text(L("The goal is paused: the harness does not check it until you resume it from the goal row above the input field. Saving a changed text resumes it as well."))
                            .accessibilityIdentifier("goal-paused-hint")
                    } else {
                        Text(L("After every run the harness checks whether this goal is met and can continue automatically up to the defined limit."))
                    }
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                }
                if !goal.isEmpty && !onlyRead {
                    Button(L("Remove goal"), role: .destructive) {
                        goal = ""
                        Task { await persist() }
                    }
                }
            }
            .navigationTitle(L("Goal"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The same ✕ for reading and writing.
                SheetClose(identifier: "goal-close") { dismiss() }
                if !onlyRead {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? L("Saving…") : L("Save")) {
                            Task { await persist() }
                        }
                        .disabled(busy)
                    }
                }
            }
        }
    }

    private func persist() async {
        busy = true
        do {
            try await save()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
