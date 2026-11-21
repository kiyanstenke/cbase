import SwiftUI

// ── The editor of an outer-loop agent ───────────────────────────────────────────────────────────────────────────────
// ONE sheet for all three origins and the summarizer, as a `CbForm`. What an origin lacks is not shown (description = execution):
// a chat-owned agent has no "default for new chats", so the body leaves it out EXPLICITLY (`OuterLoopBody`); the server answers 400
// otherwise. Only coding chats are observed (the server ignores a scope field). The tool choice (`Code/ToolChoiceSections.swift`)
// carries the excerpt from the server catalog and the mark "not in project chats"; the built-in tools are their own section.
// Approval marks are read-only here, they are set in the outer-loop area (`Code/ApprovalMarks.swift`). An agent only takes effect
// with provider AND model; there is no "default (global)". Web counterpart: components/outerloop/OuterLoopEditor.tsx.
//
// Two fixed agents exist: the summarizer and the agenda keeper. "Built in" (no delete, "Reset to template", note about a newer
// template) hangs on `fixed`; only the keeper has the switch "Mark changes" (the body carries `markUpkeep` only for it, else 400)
// and the tally of its changes (without a tally "Track record unknown", as on the web; the rule lives in `OuterLoopWord.upkeepTally`).
// web/test/outerloop-keeper.test.mjs holds both to the source text.
struct OuterLoopEditor: View {
    @Environment(\.dismiss) private var dismiss
    let client: APIClient
    let workspaceId: String
    let inventory: OuterLoopInventory
    let agent: OuterLoopAgent?
    let fresh: OuterLoopEditorTarget.Fresh?
    let projects: [Project]
    let saved: () -> Void

    @State private var base: OuterLoopAgent?
    @State private var name = ""
    @State private var job = ""
    @State private var on = true
    @State private var quietOn = true
    @State private var quietMinutes = 5
    @State private var intervalOn = false
    @State private var intervalMinutes = 60
    @State private var runEndOn = false
    @State private var clockTimeOn = false
    @State private var clockTimes: [String] = []
    @State private var newClockTime = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var defaultNew = false
    @State private var provider = ""
    @State private var model = ""
    @State private var effort = ""
    @State private var tools: Set<String> = []
    @State private var builtin: Set<String> = []
    @State private var mcp: [String: [String]] = [:]
    @State private var notTakenOver: Set<String> = []
    /// Agenda keeper only: mark its changes in the agenda.
    @State private var markUpkeep = true
    /// "Abort on new message": any agent; off means a trigger during a run is queued.
    @State private var abortingTurn = false
    @State private var providers: [Provider] = []
    @State private var activeProvider = ""
    @State private var busy = false
    @State private var error = ""
    /// The saved agent has been copied into the fields (once per sheet).
    @State private var takenOver = false
    /// Fields copied AND provider list loaded: only then may a provider change clear the model.
    @State private var loaded = false
    @State private var resetQuestion = false
    @State private var deleteQuestion = false

    private var origin: String {
        if let base { return base.origin }
        switch fresh {
        case .chat: return "chat"
        case .project: return "project"
        default: return "workspace"
        }
    }
    private var chatOrigin: Bool { origin == "chat" }
    /// Selectable: the connected providers, plus the saved one even if it is currently signed out.
    private var availableProviders: [Provider] { providers.filter { $0.connected || $0.id == provider } }
    private var selected: Provider? { availableProviders.first { $0.id == provider } }
    private var g: OuterLoopLimits { inventory.limits }

    private var triggerList: [OuterLoopTrigger] {
        var l: [OuterLoopTrigger] = []
        if quietOn { l.append(OuterLoopTrigger(kind: "quiet", minutes: clamp(quietMinutes, g.quiet))) }
        if intervalOn { l.append(OuterLoopTrigger(kind: "interval", minutes: clamp(intervalMinutes, g.interval))) }
        if runEndOn { l.append(OuterLoopTrigger(kind: "run_end")) }
        if clockTimeOn { l.append(OuterLoopTrigger(kind: "clockTime", clockTimes: clockTimes.sorted())) }
        return l
    }

    private var lockReason: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return L("A name is missing.") }
        if triggerList.isEmpty { return L("At least one trigger.") }
        if clockTimeOn && clockTimes.isEmpty { return L("Fixed times: at least one time.") }
        return nil
    }

    private var title: String {
        if let base { return base.summarizer ? L("Summarizer") : base.agendaKeeper ? L("Agenda keeper") : base.timeline ? L("Timeline") : base.name }
        switch fresh {
        case .chat: return L("New outer-loop agent for this chat")
        case .project: return L("New project agent")
        default: return L("New outer-loop agent")
        }
    }

    var body: some View {
        NavigationStack {
            CbForm {
                headerSection
                if let base, base.agendaKeeper { upkeepSection(base) }
                jobSection
                triggerSection
                modelSection
                if !chatOrigin { observedSection }
                ToolCatalogSections(
                    areas: inventory.catalog.toolAreas, catalog: inventory.catalog.groups,
                    cbaseApproval: inventory.catalog.cbaseApproval, fenceDropped: inventory.catalog.fenceDropped,
                    tools: $tools, identifier: "outerloop"
                )
                Section {
                    Text(L("Every run has the analysis tool for the watched chat. Tools with an approval mark are missing in the run — nobody is there to approve. Without chosen tools it runs isolated in an empty folder, never in the project container."))
                        .cbFont(12)
                        .foregroundStyle(.secondary)
                    if base?.agendaKeeper == true {
                        Text(L("In addition, the agenda keeper has cbase_agenda and cbase_agenda_maintain in every run — fixed, not selectable."))
                            .cbFont(12)
                            .foregroundStyle(.secondary)
                    }
                }
                builtinSection
                McpChoiceSections(server: inventory.catalog.mcpServer, mcp: $mcp,
                                mcpFootnote: L("Tools from external systems through an MCP server. Creating it and its token live under Coding → MCP; which of its tools THIS outer loop agent gets, you choose here."),
                                identifier: "outerloop")
                if base != nil && origin == "workspace" && !projects.isEmpty { takeoverSection }
                actionsSection
                InlineError(message: error)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await save() } }
                        .disabled(busy || lockReason != nil)
                        .accessibilityIdentifier("outerloop-save")
                }
            }
            .confirmationDialog(L("Reset to template?"), isPresented: $resetQuestion, titleVisibility: .visible) {
                Button(L("Reset")) { Task { await reset() } }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("Name, task, triggers and tools come from the cbase template; provider, model, effort and “on” stay."))
            }
            .confirmationDialog(L("Delete outer-loop agent “{name}”?", ["name": base?.name ?? ""]), isPresented: $deleteQuestion, titleVisibility: .visible) {
                Button(L("Delete"), role: .destructive) { Task { await erase() } }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("Its notes and runs go with it."))
            }
            // Only a REAL change by the user clears a model the new provider does not know. Copying the saved agent on open sets
            // `provider` from "" to the saved value; if `loaded` were already true while the provider list was still empty, the saved
            // model would silently vanish and saving without changes would make the agent "without-model". Hence `loaded` only after
            // the list, and the old value must not be empty.
            .onChange(of: provider) { old, _ in
                guard loaded, !old.isEmpty, !providers.isEmpty else { return }
                if !(selected?.models.contains { $0.id == model } ?? false) { model = "" }
            }
            .task { await load() }
        }
    }

    // ── Sections ──
    private var headerSection: some View {
        Section {
            TextField(L("e.g. reviewer, test watcher, minutes"), text: $name)
                .accessibilityIdentifier("outerloop-name")
            Toggle(L("On"), isOn: $on)
                .accessibilityIdentifier("outerloop-on")
        } header: {
            Text(L("Name"))
        } footer: {
            if base?.summarizer == true {
                Text(L("The summarizer is the one built-in outer-loop agent of this workspace: only its notes show up for other agents. It is yours — change it, switch it off, reset it to the template; it cannot be deleted."))
            } else if base?.agendaKeeper == true {
                Text(L("The agenda keeper is built in: it keeps a watched chat's agenda up to date when the main agent forgets — new items and status only forward, never while the chat is working. It is yours — change it, switch it off, reset it to the template; it cannot be deleted."))
            } else if chatOrigin {
                Text(L("A chat-owned agent watches only this chat — alongside the summarizer. It follows the chat: deleted with it, resting in the archive, not copied when forking."))
            } else if !on {
                Text(L("Switched off, it runs on no chat."))
            }
        }
    }

    /// Agenda keeper only: the switch "Mark changes" and the tally of its changes.
    private func upkeepSection(_ a: OuterLoopAgent) -> some View {
        Section {
            Toggle(L("Mark changes"), isOn: $markUpkeep)
                .accessibilityIdentifier("outerloop-upkeep-mark")
            HStack {
                Text(L("Track record"))
                Spacer()
                Text(OuterLoopWord.upkeepTally(a.upkeepTally))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("outerloop-upkeep-tally")
        } header: {
            Text(L("Agenda"))
        } footer: {
            Text(L("Marks every item it adds or moves forward with a small ring in the agenda — it stays even if the main agent changes the item afterwards. Switching off keeps existing marks. “Standing” means: the main agent did not take the change back."))
        }
    }

    private var jobSection: some View {
        Section {
            TextEditor(text: $job)
                .cbFont(13.5)
                .frame(minHeight: 160)
                .accessibilityIdentifier("outerloop-job")
        } header: {
            Text(L("Brief"))
        } footer: {
            Text(L("What it should do in each run. It also gets what happened in the chat since its last finished run and its last note; its final answer is the new note."))
        }
    }

    private var triggerSection: some View {
        Section {
            Toggle(L("After quiet"), isOn: $quietOn)
            if quietOn { minutesRow(L("Minutes of quiet"), value: $quietMinutes, span: g.quiet) }
            Toggle(L("Interval"), isOn: $intervalOn)
            if intervalOn { minutesRow(L("Interval minutes"), value: $intervalMinutes, span: g.interval) }
            Toggle(L("After every run end"), isOn: $runEndOn)
            Toggle(L("Fixed times"), isOn: $clockTimeOn)
            if clockTimeOn {
                ForEach(clockTimes.sorted(), id: \.self) { z in
                    Text(z).cbFont(14, design: .monospaced)
                }
                .onDelete { idx in
                    let sorted = clockTimes.sorted()
                    let doomed = Set(idx.map { sorted[$0] })
                    clockTimes.removeAll { doomed.contains($0) }
                }
                HStack {
                    DatePicker(L("Time"), selection: $newClockTime, displayedComponents: .hourAndMinute)
                    Button(L("Add")) { clockTimeAlongside() }
                        .buttonStyle(.borderless)
                        .disabled(clockTimes.count >= g.clockTimes.max)
                }
            }
            Toggle(L("Cancel on new message"), isOn: $abortingTurn)
                .accessibilityIdentifier("outerloop-aborting-turn")
        } header: {
            Text(L("Triggers"))
        } footer: {
            Text(L("At least one. Interval and fixed times only run on chats with something new since its last run.")
                 + (clockTimeOn ? " " + L("In the workspace's time zone. If the container sleeps at that time, it runs once on the next tick.") : "")
                 + " " + (abortingTurn
                    ? L("When a new turn starts in the observed chat, it cancels its running run there; the next trigger reads the stretch again.")
                    : L("Its run keeps going even while the chat keeps working. A trigger in the meantime is queued and runs afterwards.")))
        }
    }

    private func minutesRow(_ label: String, value: Binding<Int>, span: OuterLoopSpan) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            TextField("", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text(L("min")).foregroundStyle(.secondary)
        }
        .cbFont(14)
    }

    private var modelSection: some View {
        Section {
            Picker(L("Providers"), selection: $provider) {
                Text(L("No provider — does not run")).tag("")
                ForEach(availableProviders) { p in Text(p.connected ? p.label : "\(p.label) (\(L("signed out")))").tag(p.id) }
            }
            .accessibilityIdentifier("outerloop-provider")
            // With OpenRouter: the same choice as a searchable sheet (Kit/ModelSelection.swift).
            ModelChoice(title: L("Model"), groups: selected.map { [ModelGroup($0)] } ?? [], selection: $model,
                       front: [ModelExtra(title: L("No model — does not run"), value: "")],
                       rear: !model.isEmpty && !(selected?.models.contains { $0.id == model } ?? false) ? [ModelExtra(title: model, value: model)] : []) {
                Picker(L("Model"), selection: $model) {
                    Text(L("No model — does not run")).tag("")
                    ForEach(selected?.models ?? []) { m in Text(m.label).tag(m.id) }
                    if !model.isEmpty && !(selected?.models.contains { $0.id == model } ?? false) {
                        Text(model).tag(model)
                    }
                }
            }
            .disabled(provider.isEmpty)
            .accessibilityIdentifier("outerloop-model")
            if !provider.isEmpty && !model.isEmpty {
                EffortSelection(
                    effort: $effort,
                    empty: EffortLevels.standardLabel(providers, provider: provider, model: model, active: activeProvider),
                    providers: providers, provider: provider, model: model, active: activeProvider
                )
            }
        } header: {
            Text(L("Model"))
        } footer: {
            Text(L("Without provider and model it does not run — the summarizer too is off until a model is chosen. Codex can be chosen. Costs are booked per run, without a cap."))
        }
    }

    private var observedSection: some View {
        Section {
            Toggle(L("Default for new chats"), isOn: $defaultNew)
                .accessibilityIdentifier("outerloop-standard")
        } header: {
            Text(L("Where it watches"))
        } footer: {
            Text(defaultNew
                 ? L("Active on every coding chat created after it took effect — turn it on for older chats one by one in their chat info.")
                 : L("It only runs on chats where you switch it on in the chat info."))
        }
    }

    private var builtinSection: some View {
        Section {
            ForEach(inventory.catalog.builtin) { w in
                Toggle(isOn: Binding(
                    get: { builtin.contains(w.name) },
                    set: { if $0 { builtin.insert(w.name) } else { builtin.remove(w.name) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(w.name).cbFont(12.5, design: .monospaced)
                        if !w.description.isEmpty {
                            Text(w.description).cbFont(11.5).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            HStack(spacing: 14) {
                Button(L("All")) { builtin = Set(inventory.catalog.builtin.map(\.name)) }
                    .disabled(inventory.catalog.builtin.isEmpty)
                Button(L("None")) { builtin = [] }
                    .disabled(builtin.isEmpty)
            }
            .cbFont(13)
            .buttonStyle(.borderless)
        } header: {
            Text(L("Built-in tools") + " · " + L("{n} selected", ["n": "\(builtin.count)"]))
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text(L("The CLI's own tools — including Bash, Edit, Write and web. Chosen ones run without asking; a permission request is denied without a card."))
                // Codex has no allowlist of built-ins (server outerloop/input.js builtinRow); the run's frame says the same, including
                // image viewing (view_image) and MCP resources, like this note.
                if provider == "codex" {
                    Text(L("Codex has no individual built-in tools: with a selection the run gets its shell, apply_patch, image viewing and the MCP servers’ resources (writing once Write, Edit, MultiEdit, NotebookEdit or Bash is selected) — the shell reads every file the process may read. Without a selection it has no shell.")).foregroundStyle(.orange)
                }
            }
        }
    }

    private var takeoverSection: some View {
        Section {
            ForEach(projects) { p in
                Toggle(p.name, isOn: Binding(
                    get: { !notTakenOver.contains(p.id) },
                    set: { fresh in Task { await takeover(p.id, fresh) } }
                ))
            }
        } header: {
            Text(L("In projects"))
        } footer: {
            Text(L("A workspace agent counts as adopted in every project — switch it off for single projects here."))
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        if let base {
            Section {
                if base.fixed {
                    Button(L("Reset to template")) { resetQuestion = true }
                        .disabled(busy)
                        .accessibilityIdentifier("outerloop-reset")
                } else {
                    Button(L("Delete"), role: .destructive) { deleteQuestion = true }
                        .disabled(busy)
                        .accessibilityIdentifier("outerloop-delete")
                }
            } footer: {
                if base.fixed {
                    // The keeper has its own template; `inventory.templateRevision` is the summarizer's.
                    if base.templateNew {
                        Text(L("There is a newer cbase template. “Reset to template” takes it over — provider, model, effort and “on” stay."))
                    } else if let n = base.agendaKeeper ? base.templateRevision : Optional(inventory.templateRevision) {
                        Text(L("Template {n}", ["n": "\(n)"]))
                    }
                }
            }
        }
        if let lockReason {
            Section { Text(lockReason).cbFont(12).foregroundStyle(.secondary) }
        }
    }

    // ── Loading and saving ──
    private func takeOver(_ a: OuterLoopAgent) {
        base = a
        name = a.name
        job = a.job
        on = a.on
        quietOn = false; intervalOn = false; runEndOn = false; clockTimeOn = false
        for x in a.trigger {
            switch x.kind {
            case "quiet": quietOn = true; quietMinutes = x.minutes
            case "interval": intervalOn = true; intervalMinutes = x.minutes
            case "run_end": runEndOn = true
            case "clockTime": clockTimeOn = true; clockTimes = x.clockTimes
            default: break
            }
        }
        defaultNew = a.defaultNew
        provider = a.provider
        model = a.model
        effort = a.effort
        tools = Set(a.tools)
        builtin = Set(a.builtin)
        mcp = a.mcp
        notTakenOver = Set(a.notTakenOverIn)
        markUpkeep = a.markUpkeep
        abortingTurn = a.abortingTurn
    }

    private func load() async {
        if !takenOver {
            if let agent { takeOver(agent) }
            takenOver = true
        }
        let r: ProvidersResponse? = try? await client.get("/api/providers", timeout: 20)
        providers = r?.providers ?? []
        activeProvider = r?.active ?? ""
        loaded = true
    }

    /// The tool list in CATALOG order (the server computes the set the same way; a click order would cost the prompt cache),
    /// unknown ones sorted after it.
    private var toolsOrdered: [String] {
        let catalog = inventory.catalog.groups.flatMap(\.tools)
        var seen = Set<String>()
        let known = catalog.filter { tools.contains($0) && seen.insert($0).inserted }
        return known + tools.subtracting(Set(catalog)).sorted()
    }

    private func requestBody() -> OuterLoopBody {
        let queue = inventory.catalog.builtin.map(\.name)
        let builtinOrdered = queue.filter { builtin.contains($0) } + builtin.subtracting(Set(queue)).sorted()
        var r = OuterLoopBody(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines), job: job, trigger: triggerList,
            provider: provider, model: model, effort: effort,
            defaultNew: chatOrigin ? nil : defaultNew, tools: toolsOrdered, builtin: builtinOrdered,
            mcp: mcp.filter { !$0.value.isEmpty }, on: on, projectId: nil, abortingTurn: abortingTurn
        )
        if base == nil, case .project(let pid) = fresh { r.projectId = pid }
        if base?.agendaKeeper == true { r.markUpkeep = markUpkeep }
        return r
    }

    private func save() async {
        guard lockReason == nil else { return }
        busy = true
        defer { busy = false }
        do {
            if let base {
                _ = try await OuterLoopAPI.change(client, workspaceId: workspaceId, agentId: base.id, body: requestBody())
            } else if case .chat(let chatId) = fresh {
                _ = try await OuterLoopAPI.chatCreate(client, chatId: chatId, body: requestBody())
            } else {
                _ = try await OuterLoopAPI.create(client, workspaceId: workspaceId, body: requestBody())
            }
            error = ""
            saved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reset() async {
        guard let base else { return }
        busy = true
        defer { busy = false }
        do {
            let a = try await OuterLoopAPI.reset(client, workspaceId: workspaceId, agentId: base.id)
            takeOver(a)
            error = ""
            saved()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func erase() async {
        guard let base else { return }
        busy = true
        defer { busy = false }
        do {
            try await OuterLoopAPI.erase(client, workspaceId: workspaceId, agentId: base.id)
            saved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func takeover(_ projectId: String, _ takenOver: Bool) async {
        guard let base else { return }
        do {
            try await OuterLoopAPI.takeover(client, projectId: projectId, agentId: base.id, takenOver: takenOver)
            if takenOver { notTakenOver.remove(projectId) } else { notTakenOver.insert(projectId) }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func clockTimeAlongside() {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        let z = f.string(from: newClockTime)
        guard !clockTimes.contains(z), clockTimes.count < g.clockTimes.max else { return }
        clockTimes.append(z)
    }

    private func clamp(_ n: Int, _ s: OuterLoopSpan) -> Int { Swift.min(s.max, Swift.max(s.min, n)) }
}
