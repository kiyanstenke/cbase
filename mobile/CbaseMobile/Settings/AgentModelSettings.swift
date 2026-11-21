import SwiftUI

// ── Models of the internal tasks ────────────────────────────────────────────
//
// No introductory paragraph — the navigation bar carries the page title —, and instead of thirteen uniform pickers one
// below the other FOUR GROUPS BY OCCASION, the same four with the same keys as `GROUPS` in
// `web/src/components/settings/AgentModelSettings.tsx`.
//
// Each agent's explanation (`desc`) is a hint IN its row, clamped to three lines. If it needs more, `CbSettingRow`
// measures that itself and fades in the (i) with the full wording.
struct AgentModelSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var providers: [ProviderInfo] = []
    @State private var agents: [String: AgentModelChoice?] = [:]
    @State private var defaults: [String: String] = [:]
    /// The effort level per internal task — "" = default, in the same settings row as the model.
    @State private var efforts: [String: String] = [:]
    @State private var effective: [String: AgentEffective] = [:]
    /// The UNFILTERED provider list in the form of the effort picker (grades, default grade, `caps.effort`).
    @State private var effortCatalog: [Provider] = []
    @State private var activeProvider = ""
    @State private var loaded = false
    @State private var error = ""
    // Auto compact: the global level sits next to the model that writes the summary ("Compact context" in the first
    // group) — as on the web.
    @State private var autocompact = AutocompactDoc()
    @State private var autocompactLoaded = false

    private static let entries: [(key: String, label: String, desc: String)] = [
        ("title", "Auto title", "Names new chats after the first exchange."),
        ("goal", "Goal check", "Judges after each run with an active /goal whether the goal is achieved (line in the chat)."),
        // The web editor has it too; the catalogue guard is web/test/app-agents-catalog.test.mjs.
        ("workflow", "Workflow verdicts", "Decides conditions in running workflows, produces loop lists, interprets answers at the round cap and checks a step's completion. One short call per verdict; the completion-check model can be overridden per workflow in its run settings."),
        ("compact", "Compact context", "Summarizes the history on /compact. Auto = the respective chat's model."),
        ("curator", "Context curator", "Routes dumpster drops into projects and merges project context."),
        ("classify", "Context classification", "Assigns dropped snippets to a category (title, summary, tags). Auto = the active provider's default model."),
        ("services", "Service scan", "Inventories a project's stack (services, ports) on creation or re-scan."),
        ("channel_status", "Summary on request", "Summarises a chat freshly on request — for any reader that reads it via cbase_agents_list (summarize), not just over channels. One call per request, sandboxed."),
        ("adjust", "Adjust text", "Rephrases selected text according to your instruction (“Adjust” on an approval card) and puts the result on the clipboard. One short call per adjustment, sandboxed — a fast model is enough.")
    ]

    /// The page's order: by the OCCASION on which the task arises — the same four groups with the same keys as on the web.
    ///
    /// It POINTS to the entries above and does not hold them itself. That is not style: the catalogue guard
    /// (`web/test/app-agents-catalog.test.mjs`) cuts `entries` out of this file by regex and holds key, label and
    /// explanation against backend and web. A second list repeating the same labels would be exactly the duplication it
    /// is built against — and the guard would see only one of the two halves.
    ///
    /// CAUTION with a NEW group: its title is translated via a variable, and `mobile/tools/loc-audit.sh` sees only literal
    /// calls. A missing English entry is therefore NOT noticed there — the English version simply shows German. The entry
    /// belongs by hand into `Kit/LocDEMobile.swift`.
    private static let groups: [(title: String, keys: [String])] = [
        (title: "Chat side tasks", keys: ["title", "goal", "compact", "adjust", "channel_status"]),
        (title: "Projects & context", keys: ["curator", "classify", "services"]),
        (title: "Workflows", keys: ["workflow"]),
    ]

    /// The entries of a group, in the group's order. A key that is not (any more) in the catalogue drops out silently
    /// here — `rest` catches the opposite direction.
    private static func entries(_ keys: [String]) -> [(key: String, label: String, desc: String)] {
        keys.compactMap { key in entries.first(where: { $0.key == key }) }
    }

    /// Everything not assigned to a group. Whoever enters an agent above and forgets it here would otherwise make it
    /// invisible on THIS page — exactly the damage the catalogue guard is built against, one level deeper. It therefore
    /// stands at the bottom in a group without a label instead of silently missing.
    private static var rest: [(key: String, label: String, desc: String)] {
        let assigned = Set(groups.flatMap(\.keys))
        return entries.filter { !assigned.contains($0.key) }
    }

    var body: some View {
        CbList {
            if !error.isEmpty {
                Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
            }

            ForEach(Array(Self.groups.enumerated()), id: \.element.title) { index, group in
                // `Group` keeps both sections together: a loop may deliver more than one section, but only as ONE
                // expression.
                Group {
                    CbSettingGroup(title: L(group.title)) {
                        ForEach(Self.entries(group.keys), id: \.key) { entry in
                            row(entry)
                        }
                    }
                    // Auto compact stands AFTER the first group and not at the top of the page: the level belongs next
                    // to the model that writes the summary — "Compact context" is one row above. The same place as on the
                    // web.
                    if index == 0 { compact }
                }
            }

            if !Self.rest.isEmpty {
                CbSettingGroup {
                    ForEach(Self.rest, id: \.key) { entry in row(entry) }
                }
            }

            Section {
                Text(L("Chat answers are unaffected — you pick their model per chat."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(L("Models"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .task { await loadAutocompact() }
    }

    /// An agent row: title, below it its explanation, on the right the picker.
    ///
    /// The picker is clamped to a width because the label of a menu picker grows as wide as its longest value ("Auto
    /// (provider default)" alone is 24 characters) — unchecked it pushed title and hint out of the row.
    private func row(_ entry: (key: String, label: String, desc: String)) -> some View {
        CbSettingRow(title: L(entry.label), hint: L(entry.desc)) {
            let choiceBinding = Binding(
                get: { value(for: entry.key) },
                set: { choice in Task { await pick(entry.key, choice) } }
            )
            // With OpenRouter: the same choice as a searchable sheet (Kit/ModelSelection.swift), value "provider|model".
            ModelChoice(title: L(entry.label), groups: providers.map { ModelGroup($0) }, selection: choiceBinding,
                       value: { g, m in g.id + "|" + m.id }, front: [ModelExtra(title: autoLabel(entry.key), value: "")]) {
                Picker(L(entry.label), selection: choiceBinding) {
                    Text(autoLabel(entry.key)).tag("")
                    ForEach(modelOptions, id: \.tag) { option in
                        Text(option.label).tag(option.tag)
                    }
                }
                .pickerStyle(.menu)
            }
            .labelsHidden()
            .disabled(!loaded)
            .accessibilityIdentifier("agent-model-\(entry.key)")
            .frame(maxWidth: 150, alignment: .trailing)
            // The effort: the same building block as in the four other places. It computes with the model that ACTUALLY runs
            // (the choice, otherwise the effective one from "Auto"), and does not show on a model without grades.
            // Empty = "Default · <grade>" — this empty is sent EXPLICITLY (`pickEffort`).
            // "Like the chat": compaction without its own choice has no single model — the picker then computes with none
            // (the default grades) and names no grade in the empty entry instead of inventing one.
            let choice = agents[entry.key] ?? nil
            let asChat = choice == nil && effective[entry.key]?.asChat == true
            let run: (provider: String, model: String)? = choice.map { ($0.provider, $0.model) } ?? effective[entry.key].map { ($0.provider, $0.model) }
            if loaded, let run {
                let active = asChat ? "" : activeProvider
                EffortSelection(
                    effort: Binding(get: { efforts[entry.key] ?? "" }, set: { fresh in Task { await pickEffort(entry.key, fresh) } }),
                    empty: asChat ? L("Default") : EffortLevels.standardLabel(effortCatalog, provider: run.provider, model: run.model, active: active),
                    providers: effortCatalog, provider: run.provider, model: run.model, active: active
                )
                .pickerStyle(.menu)
                .labelsHidden()
                .accessibilityIdentifier("agent-effort-\(entry.key)")
                .frame(maxWidth: 150, alignment: .trailing)
            }
        }
    }

    /// "Auto compact": the global level and the absolute cap.
    ///
    /// Each sentence sits at its own control; they are the same two dictionary keys, word for word.
    private var compact: some View {
        CbSettingGroup {
            CbSettingRow(
                title: L("Auto-compact"),
                hint: L("Once a chat’s context reaches this mark, cbase summarizes the history after the run and continues with a fresh session — the same for Claude Code, Codex and third-party providers. Overridable per chat in the chat menu.")
            ) {
                Picker(L("Auto-compact"), selection: Binding(
                    get: { autocompact.percent },
                    set: { fresh in Task { await setAutocompact(fresh) } }
                )) {
                    Text(L("Off")).tag(0)
                    ForEach(autocompact.stages, id: \.self) { s in Text("\(s) %").tag(s) }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(!autocompactLoaded)
                .accessibilityIdentifier("autocompact-global")
            }
            // The absolute cap — a share alone hangs on the context window, which is 1,000,000 for almost all Claude
            // models: 60 % would mean 600,000 tokens per request there. Compaction happens at the earlier of the two
            // points.
            CbSettingRow(
                title: L("No later than"),
                hint: L("“No later than” is an absolute cap in tokens, independent of the share above; compaction happens at whichever point comes first. With both set to “Off”, nothing is compacted automatically. Both marks can be overridden per chat.")
            ) {
                Picker(L("No later than"), selection: Binding(
                    get: { autocompact.maxTokens },
                    set: { fresh in Task { await setAutocompactMax(fresh) } }
                )) {
                    Text(L("Off")).tag(0)
                    ForEach(autocompact.maxStages, id: \.self) { s in Text(ChatViewModel.formatTokens(s)).tag(s) }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(!autocompactLoaded)
                .accessibilityIdentifier("autocompact-max")
            }
        }
    }

    private func loadAutocompact() async {
        guard let client = session.client else { return }
        if let doc: AutocompactDoc = try? await client.get("/api/autocompact") { autocompact = doc }
        autocompactLoaded = true
    }

    private func setAutocompact(_ percent: Int) async {
        await saveAutocompact(percent: percent, maxTokens: autocompact.maxTokens)
    }

    private func setAutocompactMax(_ maxTokens: Int) async {
        await saveAutocompact(percent: autocompact.percent, maxTokens: maxTokens)
    }

    /// ONE save path for both controls. The server takes the fields individually; still only the changed one is sent — the
    /// other value is already there, and repeating it would overwrite a change made elsewhere in the meantime.
    private func saveAutocompact(percent: Int, maxTokens: Int) async {
        guard let client = session.client else { return }
        let prior = autocompact
        autocompact = AutocompactDoc(percent: percent, stages: autocompact.stages,
                                     maxTokens: maxTokens, maxStages: autocompact.maxStages) // immediately visible
        // A synthesized Encodable OMITS a nil key — exactly right here.
        struct Body: Encodable { let percent: Int?; let maxTokens: Int? }
        let body = Body(percent: percent == prior.percent ? nil : percent,
                        maxTokens: maxTokens == prior.maxTokens ? nil : maxTokens)
        do { let doc: AutocompactDoc = try await client.put("/api/autocompact", body: body); autocompact = doc }
        catch { autocompact = prior; self.error = error.localizedDescription }
    }

    /// Precomputed choice "provider · model" — keeps the picker fast to type-check.
    private var modelOptions: [(tag: String, label: String)] {
        var options: [(tag: String, label: String)] = []
        for provider in providers {
            for model in provider.models where !model.id.isEmpty {
                options.append((tag: provider.id + "|" + model.id, label: provider.label + " · " + model.label))
            }
        }
        return options
    }

    private func value(for key: String) -> String {
        guard let choice = agents[key] ?? nil else { return "" }
        return choice.provider + "|" + choice.model
    }

    private func autoLabel(_ key: String) -> String {
        let fallback = defaults[key] ?? ""
        if fallback.isEmpty {
            return key == "compact" ? L("Auto (chat model)") : L("Auto (provider default)")
        }
        for provider in providers {
            if let hit = provider.models.first(where: { $0.id == fallback }) {
                return "\(L("Auto")) (\(hit.label))"
            }
        }
        return "\(L("Auto")) (\(fallback))"
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            let response: ProviderInfoResponse = try await client.get("/api/providers")
            providers = response.providers.filter { $0.connected && !$0.models.isEmpty }
            effortCatalog = response.effortCatalog
            activeProvider = response.active
            let models: AgentModelsResponse = try await client.get("/api/agent-models")
            agents = models.agents
            defaults = models.defaults
            efforts = models.efforts
            effective = models.effective
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func pick(_ key: String, _ value: String) async {
        guard let client = session.client else { return }
        struct Body: Encodable { let key: String; let provider: String; let model: String }
        let parts = value.split(separator: "|", maxSplits: 1).map(String.init)
        let provider = parts.count == 2 ? parts[0] : ""
        let model = parts.count == 2 ? parts[1] : ""
        agents[key] = provider.isEmpty ? nil : AgentModelChoice(provider: provider, model: model)
        do {
            let r: AgentModelPutResponse = try await client.put("/api/agent-models", body: Body(key: key, provider: provider, model: model))
            if let w = r.effective { effective[key] = w }
        } catch {
            self.error = error.localizedDescription
            await load()
        }
    }

    /// Save the effort — ONLY `effort`, the model stays as it is. "Default" goes out as "", not as an omitted key: a
    /// synthesized Encodable would omit a `nil`, and the server would read "unchanged".
    private func pickEffort(_ key: String, _ value: String) async {
        guard let client = session.client else { return }
        struct Body: Encodable { let key: String; let effort: String }
        let prior = efforts[key] ?? ""
        efforts[key] = value
        do {
            let r: AgentModelPutResponse = try await client.put("/api/agent-models", body: Body(key: key, effort: value))
            if let e = r.effort { efforts[key] = e }
        } catch {
            efforts[key] = prior
            self.error = error.localizedDescription
        }
    }
}
