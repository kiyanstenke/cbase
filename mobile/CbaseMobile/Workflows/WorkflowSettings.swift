import SwiftUI

/// Permissions as on the web: field values, not an enumeration. Effort levels are deliberately not here:
/// they depend on the model and come from `EffortLevels` (Models.swift).
enum PermissionsOptions {
    static let permissions: [(id: String, label: String)] = [
        ("", "As in the chat"), ("bypassPermissions", "Full access"), ("acceptEdits", "Auto-edit"),
        ("plan", "Plan (read-only)"), ("default", "Ask"),
    ]
}

// ── Workflow settings: six categories, each a subpage ────────────────────────────────────────────
// What is an icon rail plus panel on the web is a list of subpages on the phone, like the app's
// settings: per row an icon, a title and a short value saying what currently applies. The categories
// and their order live ONCE in `WorkflowSettingCategory` (Workflows/WorkflowRules.swift) and are bound
// to `WFE_CATEGORIES` on the web (web/test/wfe-ios-binding.test.mjs).
//
// No `@EnvironmentObject` anywhere in this file: the editor is a UIKit fullscreen
// (`WorkflowEditorPresentation`) that passes no environment objects on; a subpage that asks for one
// crashes on open. Everything comes in as a value or binding; the list loads providers and compaction
// stages itself via `client`.
//
// Saving happens with the graph via "Save" in the header bar. Every change here marks the editor
// "unsaved" through `onChange` IN THE EDITOR, not through "Done": otherwise a sheet dismissed by
// swiping would leave "Save" disabled and the change would be lost.
struct WorkflowSettings: View {
    let client: APIClient
    @Binding var name: String
    @Binding var description: String
    @Binding var run: WorkflowRunSettings
    @Binding var lock: WorkflowLock
    let problems: [WorkflowProblem]
    /// Number of steps with their own turn (`WorkflowRules.schritte`).
    let steps: Int
    let limits: WorkflowLimits
    let holding: [WorkflowHolding]
    /// Armed? And the trigger nodes of the EDITED state, with their state from the server.
    let active: Bool
    let triggerNode: [WorkflowNode]
    let triggerState: [WorkflowTriggerView]
    /// Is a save running (arming included)? And its error, shown IN the triggers tab because nobody
    /// sees it behind the sheet.
    let saves: Bool
    let armError: String
    /// Saves the whole state with `active` (the server validates the trigger).
    var arm: (Bool) -> Void
    /// Closes the sheet and opens the node in the editor.
    var openNode: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    // ALL providers, unfiltered, loaded on open like the web editor. Two lists, two questions: only a
    // connected provider is SELECTABLE, but which EFFORT levels a model carries depends on the model,
    // not on the login (see `connected` in the subpages).
    @State private var providers: [Provider] = []
    /// The GLOBALLY active provider (`active`): "Default (global)" in the run resolves against it, not against "".
    @State private var activeProvider = ""
    /// Stages and global values of autocompact (`GET /api/autocompact`).
    @State private var compaction = AutocompactDoc()

    var body: some View {
        NavigationStack {
            CbList {
                Section {
                    ForEach(WorkflowSettingCategory.allCases) { k in
                        NavigationLink {
                            page(k)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: k.symbol)
                                    .frame(width: 24)
                                    .foregroundStyle(Color.accentColor)
                                Text(k.title)
                                Spacer(minLength: 8)
                                if k == .general, !problems.isEmpty {
                                    Text(String(problems.count))
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6).padding(.vertical, 1)
                                        .background(Color.orange.opacity(0.18), in: Capsule())
                                        .foregroundStyle(.orange)
                                }
                                if k == .trigger, active {
                                    Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                                }
                                Text(shortValue(k))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .accessibilityIdentifier("workflow-settings-\(k.rawValue)")
                    }
                }
            }
            .navigationTitle(L("Workflow"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "workflow-meta-done", label: L("Done")) { dismiss() } }
            .task {
                let r: ProvidersResponse? = try? await client.get("/api/providers", timeout: 20)
                providers = r?.providers ?? []
                activeProvider = r?.active ?? ""
                if let doc: AutocompactDoc = try? await client.get("/api/autocompact") { compaction = doc }
            }
        }
    }

    @ViewBuilder
    private func page(_ k: WorkflowSettingCategory) -> some View {
        switch k {
        case .general:
            WfeGeneral(name: $name, description: $description, problems: problems, steps: steps)
        case .execution:
            WfeExecution(run: $run, providers: providers, activeProvider: activeProvider)
        case .context:
            WfeContext(run: $run, doc: compaction)
        case .check:
            WfeCheck(run: $run, providers: providers, limits: limits)
        case .concurrency:
            WfeConcurrency(lock: $lock, holding: holding)
        case .trigger:
            WfeTrigger(
                active: active, triggerNode: triggerNode, triggerState: triggerState,
                saves: saves, error: armError, arm: arm, openNode: openNode
            )
        }
    }

    /// The short value on the right of the row: what currently applies in this category.
    private func shortValue(_ k: WorkflowSettingCategory) -> String {
        switch k {
        case .general:
            return L("{n} steps", ["n": String(steps)])
        case .execution:
            if run.provider.isEmpty { return L("Default") }
            let p = providers.first { $0.id == run.provider }
            let model = p?.models.first { $0.id == run.model }?.label ?? run.model
            return [p?.label ?? run.provider, model].filter { !$0.isEmpty }.joined(separator: " · ")
        case .context:
            return WfeContext.short(run)
        case .check:
            return run.doneAll ? L("on, {n} rounds", ["n": String(run.doneRounds)]) : L("off")
        case .concurrency:
            return WfeConcurrency.title(lock.scope)
        case .trigger:
            if triggerNode.isEmpty { return L("none") }
            return active ? L("Active") : L("Inactive")
        }
    }
}

extension WorkflowSettingCategory {
    /// Literal `L` calls only: the loc audit sees nothing else.
    var title: String {
        switch self {
        case .general: return L("General")
        case .execution: return L("Execution")
        case .context: return L("Context")
        case .check: return L("Caps & checks")
        case .concurrency: return L("Concurrency")
        case .trigger: return L("Triggers")
        }
    }

    var symbol: String {
        switch self {
        case .general: return "info.circle"
        case .execution: return "play.circle"
        case .context: return "arrow.triangle.2.circlepath"
        case .check: return "checkmark.seal"
        case .concurrency: return "lock"
        case .trigger: return "bolt"
        }
    }
}

// ── General: name, description, steps, notes ──
private struct WfeGeneral: View {
    @Binding var name: String
    @Binding var description: String
    let problems: [WorkflowProblem]
    let steps: Int

    var body: some View {
        CbForm {
            Section(L("Name")) {
                TextField(L("Name"), text: $name)
                    .accessibilityIdentifier("workflow-meta-name")
            }
            Section(L("Description")) {
                TextField(L("What is this workflow for?"), text: $description, axis: .vertical)
                    .lineLimit(2...6)
                    .accessibilityIdentifier("workflow-meta-description")
            }
            Section {
                Text(L("{n} steps", ["n": String(steps)]))
                    .foregroundStyle(.secondary)
            }
            if !problems.isEmpty {
                Section(L("Notes##hints")) {
                    ForEach(problems) { problem in
                        HStack(alignment: .top, spacing: 7) {
                            Image(systemName: problem.level == "error" ? "exclamationmark.triangle.fill" : "info.circle")
                                .foregroundStyle(problem.level == "error" ? .red : .orange)
                            Text(problem.text).font(.caption)
                        }
                    }
                    Text(L("Notes are re-checked when you save."))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(L("General"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// ── Execution: provider, model, permissions, effort, ultracode ──
// A triggered run has no composer in which to set model or permissions, so they belong to the workflow.
private struct WfeExecution: View {
    @Binding var run: WorkflowRunSettings
    let providers: [Provider]
    let activeProvider: String
    // The filter sits at the CHOICE, not at loading: only a connected provider is selectable, while the
    // effort levels query the whole list (web/test/effort-ios.test.mjs).
    private var connected: [Provider] { providers.filter(\.connected) }

    var body: some View {
        CbForm {
            Section {
                Picker(L("Provider"), selection: $run.provider) {
                    Text(L("Default (global)")).tag("")
                    ForEach(connected) { p in Text(p.label).tag(p.id) }
                }
                .onChange(of: run.provider) { _, _ in run.model = "" }
                // With OpenRouter: the same choice as a searchable sheet (Kit/ModelSelection.swift).
                ModelChoice(title: L("Model"), groups: connected.filter { $0.id == run.provider }.map { ModelGroup($0) },
                           selection: $run.model, front: [ModelExtra(title: L("Provider's default"), value: "")]) {
                    Picker(L("Model"), selection: $run.model) {
                        Text(L("Provider's default")).tag("")
                        ForEach(connected.first { $0.id == run.provider }?.models ?? []) { m in
                            Text(m.label).tag(m.id)
                        }
                    }
                }
                .disabled(run.provider.isEmpty)
                Picker(L("Permissions"), selection: $run.permissionMode) {
                    ForEach(PermissionsOptions.permissions, id: \.id) { Text(L($0.label)).tag($0.id) }
                }
                // The levels query the WHOLE list: they depend on the model, not on the login. The entries come
                // from the building block shared by the four pickers (Kit/EffortSelection.swift); it hides itself,
                // and "Default (global)" resolves against the globally active provider.
                // Empty transfers NOTHING: a manual start keeps the chat's level ("As the chat · new: <level>").
                EffortSelection(effort: $run.effort, empty: EffortLevels.standardLabel(providers, provider: run.provider, model: run.model, active: activeProvider, asChat: true), providers: providers, provider: run.provider, model: run.model, active: activeProvider)
                // Ultracode: the chat's switch for EVERY step, independent of the level above.
                Toggle(isOn: $run.ultracode) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "Ultracode")
                        Text(L("Every step runs with Ultracode: multi-agent orchestration without asking — the effort above applies unchanged."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("workflow-run-ultracode")
            } footer: {
                Text(L("Apply to EVERY run of this workflow — including triggered ones, which have no user. Empty means “as usual”."))
            }
        }
        .navigationTitle(L("Execution"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// ── Context: autocompact, two controls as on the chat ──
// "Default" means the chat's setting, otherwise the global one, and is stored as an explicit `null`
// (see `WorkflowRunSettings.encode`). "Off" is the override (0).
private struct WfeContext: View {
    @Binding var run: WorkflowRunSettings
    let doc: AutocompactDoc
    /// Sentinel value for "Default" in the picker: an `Int?` tag would be a trap (SwiftUI compares the
    /// tag type exactly). Same pattern as `AutocompactMenu` in the chat.
    private static let standardTag = -1

    /// The short value of the list row.
    static func short(_ run: WorkflowRunSettings) -> String {
        if run.autocompact == nil && run.autocompactMax == nil { return L("Default") }
        if run.autocompact == 0 && run.autocompactMax == 0 { return L("off") }
        var parts: [String] = []
        if let p = run.autocompact { parts.append(p > 0 ? "\(p) %" : L("off")) }
        if let m = run.autocompactMax { parts.append(m > 0 ? ChatViewModel.formatTokens(m) : L("off")) }
        return parts.joined(separator: " · ")
    }

    private func choice(_ value: Binding<Int?>) -> Binding<Int> {
        Binding(get: { value.wrappedValue ?? Self.standardTag }, set: { value.wrappedValue = $0 == Self.standardTag ? nil : $0 })
    }

    var body: some View {
        CbForm {
            Section {
                Picker(L("Share of the window"), selection: choice($run.autocompact)) {
                    Text("\(L("Default")) · \(doc.percent > 0 ? "\(doc.percent) %" : L("off"))").tag(Self.standardTag)
                    Text(L("Off")).tag(0)
                    ForEach(doc.stages, id: \.self) { s in Text("\(s) %").tag(s) }
                }
                .accessibilityIdentifier("workflow-autocompact-share")
                Picker(L("No later than"), selection: choice($run.autocompactMax)) {
                    Text("\(L("Default")) · \(doc.maxTokens > 0 ? ChatViewModel.formatTokens(doc.maxTokens) : L("off"))").tag(Self.standardTag)
                    Text(L("Off")).tag(0)
                    ForEach(doc.maxStages, id: \.self) { s in Text(ChatViewModel.formatTokens(s)).tag(s) }
                }
                .accessibilityIdentifier("workflow-autocompact-cap")
            } header: {
                Text(L("Auto-compact"))
            } footer: {
                Text(L("Default means: the chat's setting, otherwise the global one. Compaction only happens between two steps."))
            }
        }
        .navigationTitle(L("Context"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// ── Caps & checks: "Check for completion" and "Cycles" ──
private struct WfeCheck: View {
    @Binding var run: WorkflowRunSettings
    let providers: [Provider]
    let limits: WorkflowLimits
    private var connected: [Provider] { providers.filter(\.connected) }

    var body: some View {
        CbForm {
            Section {
                Toggle(L("Check every work step"), isOn: $run.doneAll)
                    .accessibilityIdentifier("workflow-done-all")
                // The judge model of the completion gate: its own oneshot with its own model. ONE picker
                // across all providers; the model determines its provider (as on the web).
                ModelChoice(title: L("Completion judged by"), groups: connected.map { ModelGroup($0) }, selection: $run.doneModel,
                           front: [ModelExtra(title: L("Internal task “Workflow verdicts”"), value: "")]) {
                    Picker(L("Completion judged by"), selection: $run.doneModel) {
                        Text(L("Internal task “Workflow verdicts”")).tag("")
                        ForEach(connected) { p in
                            Section(p.label) {
                                ForEach(p.models) { m in Text(m.label).tag(m.id) }
                            }
                        }
                    }
                }
                .accessibilityIdentifier("workflow-run-done-model")
                .onChange(of: run.doneModel) { _, fresh in
                    run.doneProvider = connected.first { $0.models.contains { $0.id == fresh } }?.id ?? ""
                }
                Stepper(value: $run.doneRounds, in: 1...max(1, limits.doneRoundsMax)) {
                    HStack {
                        Text(L("Check rounds"))
                        Spacer()
                        Text(String(run.doneRounds)).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("workflow-done-rounds")
                LabeledContent(L("At the check cap")) {
                    capChoice($run.doneCapAuto)
                        .accessibilityIdentifier("workflow-donecap")
                }
            } header: {
                Text(L("Check for completion"))
            } footer: {
                Text(L("After the turn a model judges whether the step is done; \"not done\" lets the same step keep working. A step can opt out in its step sheet."))
            }
            Section {
                LabeledContent(L("At the round cap")) {
                    capChoice($run.loopCapAuto)
                        .accessibilityIdentifier("workflow-loopcap")
                }
            } header: {
                Text(L("Cycles"))
            } footer: {
                Text(L("A step on a cycle runs at most as many rounds as its cap; after that the run asks or continues."))
            }
        }
        .navigationTitle(L("Caps & checks"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// "Question · Continue": `false` = question, `true` = continue without asking.
    private func capChoice(_ value: Binding<Bool>) -> some View {
        Picker(L("At the cap"), selection: value) {
            Text(L("Question##ask")).tag(false)
            Text(L("Continue")).tag(true)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

// ── Concurrency: which key excludes two runs? ──
private struct WfeConcurrency: View {
    @Binding var lock: WorkflowLock
    let holding: [WorkflowHolding]

    /// Label per scope, as literal `L` calls (loc audit). Order and scopes come from
    /// `WorkflowRules.lockRanges` (bound to server and web).
    static func title(_ scope: String) -> String {
        switch scope {
        case "project": return L("One run per project/repo")
        case "workflow": return L("One run per workflow")
        case "event": return L("One run per issue/MR")
        case "custom": return L("Custom key")
        case "off": return L("No lock")
        default: return scope
        }
    }

    static func hint(_ scope: String) -> String {
        switch scope {
        case "project": return L("Recommended: within the same repo the second run waits, different repos still run in parallel.")
        case "workflow": return L("This workflow only ever runs once at a time — no matter which repo is affected.")
        case "event": return L("Never the same subject twice. Different issues will then run at the same time in the same folder, though.")
        case "custom": return L("A template with the same placeholders as a step's text.")
        case "off": return L("Everything may run at once — only sensible if the runs don't touch anything shared.")
        default: return ""
        }
    }

    var body: some View {
        CbForm {
            Section {
                ForEach(WorkflowRules.lockRanges, id: \.self) { scope in
                    Button {
                        lock.scope = scope
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: lock.scope == scope ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(lock.scope == scope ? Color.accentColor : .secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Self.title(scope)).foregroundStyle(.primary)
                                // The explanation only on the SELECTED option, as on the web.
                                if lock.scope == scope {
                                    Text(Self.hint(scope)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .accessibilityIdentifier("workflow-lock-\(scope)")
                    .accessibilityAddTraits(lock.scope == scope ? .isSelected : [])
                }
                if lock.scope == "custom" {
                    TextField("{{project}}-{{branch}}", text: $lock.template)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("workflow-lock-template")
                }
            } footer: {
                Text(L("Every run holds a lock. Whoever doesn't get it waits until the holder is done: triggered events queue up by themselves, a manual start is rejected."))
            }
            if !holding.isEmpty {
                Section {
                    Text(L("Currently locked: {keys}", ["keys": holding.map(\.key).joined(separator: ", ")]))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .navigationTitle(L("Concurrency"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// ── Triggers: status, arming, the trigger list ──
// A trigger's CONFIGURATION (account, project, events) stays on the desktop; here are the status,
// arming/disarming and the list. A tap opens the node in the editor.
private struct WfeTrigger: View {
    let active: Bool
    let triggerNode: [WorkflowNode]
    let triggerState: [WorkflowTriggerView]
    let saves: Bool
    let error: String
    var arm: (Bool) -> Void
    var openNode: (String) -> Void

    var body: some View {
        CbForm {
            if triggerNode.isEmpty {
                Section {
                    Text(L("This workflow has no trigger. A GitLab trigger is set up on the desktop (step \"GitLab trigger\") — after that it can be armed here."))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    HStack {
                        Text(L("Status"))
                        Spacer()
                        Text(active ? L("Active") : L("Inactive"))
                            .foregroundStyle(active ? Color.accentColor : .secondary)
                            .accessibilityIdentifier("workflow-active-status")
                    }
                    Button(active ? L("Turn off") : L("Arm")) { arm(!active) }
                        .disabled(saves)
                        .accessibilityIdentifier("workflow-active")
                    if !error.isEmpty {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("workflow-active-error")
                    }
                } footer: {
                    Text(L("Arming saves the current state as well. The clock starts now — older events trigger nothing."))
                }
                Section(L("Trigger")) {
                    ForEach(triggerNode) { n in
                        let st = triggerState.first { $0.nodeId == n.id }
                        Button {
                            openNode(n.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(n.title.isEmpty ? L("GitLab trigger") : n.title).foregroundStyle(.primary)
                                Text(n.triggerSummary).font(.caption).foregroundStyle(.secondary)
                                if let st {
                                    Text(st.lastFireAt > 0
                                         ? "\(L("triggered {n}×", ["n": String(st.fires)])) · \(L("last {when}", ["when": Date(timeIntervalSince1970: st.lastFireAt / 1000).formatted(date: .abbreviated, time: .shortened)]))"
                                         : L("triggered {n}×", ["n": String(st.fires)]))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    if !st.lastError.isEmpty {
                                        Text(st.lastError).font(.caption2).foregroundStyle(.orange)
                                    }
                                }
                            }
                        }
                        .accessibilityIdentifier("workflow-trigger-\(n.id)")
                    }
                }
            }
        }
        .navigationTitle(L("Triggers"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
