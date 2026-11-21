import SwiftUI

// A scheduled job: sheet and dialog. `ScheduledDetail` is the sheet behind a row of `ScheduledPane` (`Form`, HIG): cadence, next
// occurrence, state, the actions "Run now" (`POST …/scheduled/:id/run`, 409 while an occurrence is waiting), "Pause"/"Resume"
// (`PATCH {status}`), "Go to chat" (opens the job's chat in Coding → Chats, same path as any chat row, `AppState.openChat`),
// "Notifications" (`NotifyChatSheet` with the kinds of a job chat), "Edit", the latest runs and "Delete job" (the chat stays).
//
// `JobDialog` creates (`POST …/scheduled`: chat AND job in one go) or changes (`PATCH`, only instructions and cadence; a missing
// field means unchanged, and only what differs from when the dialog opened is sent). Fields: instructions, repeat, time of day;
// below "Advanced" with project, permission mode, provider/model and effort level, preset like a new chat (mode `bypassPermissions`,
// provider and model active or default, effort the provider's default). When editing, "Advanced" is absent: the run values live on
// the CHAT and change in its settings. The time zone is the device's; the server keeps it as the workspace's zone. If the zone of an
// existing job differs from the device's, sheet (row "Time zone") and dialog (under the time) name it (`ScheduledZone.foreign`).
//
// Identifiers: `scheduled-detail-cadence`, `scheduled-detail-zone`, `scheduled-detail-occurrence`, `scheduled-detail-state`, `scheduled-now`,
// `scheduled-pause`, `scheduled-to-chat`, `scheduled-notifications`, `scheduled-edit`, `scheduled-delete`, `scheduled-run-<id>`, `scheduled-detail-finished`;
// in the dialog `scheduled-instructions`, `scheduled-cadence`, `scheduled-clock-time`, `scheduled-moment`, `scheduled-day-<0…6>`,
// `scheduled-day-of-month`, `scheduled-zone`, `scheduled-mode`, `scheduled-save`.
struct ScheduledDetail: View {
    let client: APIClient
    let workspaceId: String
    let changed: (ScheduledJob) -> Void
    let deleted: () -> Void
    let toChat: (String) -> Void

    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var job: ScheduledJob
    @State private var runs: [ScheduledRun] = []
    @State private var additional = 0
    @State private var error = ""
    @State private var working = false
    @State private var edit = false
    @State private var notifications = false
    /// The chat's notification choice the sheet opens with: from the chat list or fresh from the server, never an empty state.
    @State private var notifyChoice: [String: String]?
    @State private var deleteQuestion = false

    init(client: APIClient, workspaceId: String, job: ScheduledJob, changed: @escaping (ScheduledJob) -> Void,
         deleted: @escaping () -> Void, toChat: @escaping (String) -> Void) {
        self.client = client
        self.workspaceId = workspaceId
        self.changed = changed
        self.deleted = deleted
        self.toChat = toChat
        _job = State(initialValue: job)
    }

    private var chat: Chat? { job.chatId.flatMap { id in state.chatList?.chats.first { $0.id == id } } }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    LabeledContent(L("retry")) {
                        Text(job.cadenceText).accessibilityIdentifier("scheduled-detail-cadence")
                    }
                    // The cadence applies in the job's zone, the next occurrence is shown in the device's; if they differ, the zone is shown.
                    if let zone = ScheduledZone.foreign(job.timeZone) {
                        LabeledContent(L("Time zone")) {
                            Text(verbatim: zone).accessibilityIdentifier("scheduled-detail-zone")
                        }
                    }
                    if job.status == "active" {
                        LabeledContent(L("Next date")) {
                            Text(ScheduledWord.occurrence(job.nextEventAt)).accessibilityIdentifier("scheduled-detail-occurrence")
                        }
                    }
                    LabeledContent(L("Status")) {
                        Text(ScheduledWord.state(job.state) ?? ScheduledWord.status(job.status))
                            .accessibilityIdentifier("scheduled-detail-state")
                    }
                    if !job.lastError.isEmpty && job.lastStatus == "error" {
                        Label(job.lastError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await now() }
                    } label: {
                        Label(L("Run now"), systemImage: "play")
                    }
                    .disabled(working || job.state != nil)
                    .accessibilityIdentifier("scheduled-now")
                    if job.status != "done" {
                        Button {
                            Task { await status(job.status == "paused" ? "active" : "paused") }
                        } label: {
                            Label(job.status == "paused" ? L("Resume") : L("Pause"),
                                  systemImage: job.status == "paused" ? "play.circle" : "pause.circle")
                        }
                        .disabled(working)
                        .accessibilityIdentifier("scheduled-pause")
                    }
                    if let chatId = job.chatId {
                        Button {
                            toChat(chatId)
                        } label: {
                            Label(L("Back to chat"), systemImage: "bubble.left.and.bubble.right")
                        }
                        .accessibilityIdentifier("scheduled-to-chat")
                        Button {
                            Task { await openNotifications(chatId) }
                        } label: {
                            Label(L("Notifications"), systemImage: "bell")
                        }
                        .accessibilityIdentifier("scheduled-notifications")
                    }
                    Button {
                        edit = true
                    } label: {
                        Label(L("Edit"), systemImage: "pencil")
                    }
                    .accessibilityIdentifier("scheduled-edit")
                }

                Section(L("Instructions")) {
                    Text(job.instructions)
                        .font(.callout)
                        .textSelection(.enabled)
                }

                Section(L("runs")) {
                    if runs.isEmpty {
                        Text(L("No run yet.")).foregroundStyle(.secondary)
                    }
                    ForEach(runs) { run in
                        runRow(run)
                    }
                    if additional > 0 {
                        Button(L("Load older")) { Task { await loadRuns(before: additional) } }
                    }
                }

                if !error.isEmpty {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                }

                Section {
                    Button(role: .destructive) {
                        deleteQuestion = true
                    } label: {
                        Label(L("Delete task"), systemImage: "trash")
                    }
                    .accessibilityIdentifier("scheduled-delete")
                } footer: {
                    Text(L("The chat stays, with its history."))
                }
            }
            .navigationTitle(job.name.isEmpty ? L("Scheduled task") : job.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(identifier: "scheduled-detail-finished", label: L("Done")) { dismiss() } }
        }
        .task { await loadRuns() }
        .onChange(of: state.scheduledTick) { Task { await loadAgain() } }
        .sheet(isPresented: $edit) {
            JobDialog(client: client, workspaceId: workspaceId, projectId: job.projectId, job: job) { fresh in
                takeOver(fresh)
            }
            .cbSheet(.whole)
        }
        .sheet(isPresented: $notifications) {
            if let chatId = job.chatId, let notifyChoice {
                NotifyChatSheet(chatId: chatId, title: job.name, job: true, choice: notifyChoice) { _ in
                    Task { await state.chatList?.load() }
                }
                .cbSheet(.whole)
            }
        }
        .confirmationDialog(
            L("Delete task “{name}”?", ["name": job.name]),
            isPresented: $deleteQuestion,
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) { Task { await erase() } }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("There will be no further dates. The chat stays, with its history."))
        }
    }

    private func runRow(_ run: ScheduledRun) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(ScheduledWord.runStatus(run.status)).font(.subheadline.weight(.medium))
                Text(verbatim: "· \(ScheduledWord.cause(run.cause))").font(.subheadline).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(locDateTime(locDate(fromServer: run.startedAt > 0 ? run.startedAt : run.scheduledAt)))
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if !run.short.isEmpty {
                Text(run.short).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            if !run.error.isEmpty {
                Text(run.error).font(.caption).foregroundStyle(.red).lineLimit(3)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("scheduled-run-\(run.id)")
    }

    private func takeOver(_ fresh: ScheduledJob) {
        job = fresh
        changed(fresh)
    }

    private func now() async {
        working = true
        defer { working = false }
        do {
            takeOver(try await client.scheduledNow(workspaceId: workspaceId, id: job.id))
            error = ""
            await loadRuns()
        } catch { self.error = error.localizedDescription }
    }

    private func status(_ fresh: String) async {
        working = true
        defer { working = false }
        do {
            takeOver(try await client.changeScheduled(workspaceId: workspaceId, id: job.id, ScheduledChange(status: fresh)))
            error = ""
            // The clock in the chat row changes too (paused ⇔ next occurrence).
            await state.chatList?.load()
        } catch { self.error = error.localizedDescription }
    }

    /// The sheet writes the WHOLE set on every toggle (`NotifyChatSheet.save`). If the chat is missing from `state.chatList`
    /// (archived by hand, list not loaded yet), it would open with `[:]` and the first toggle would erase the chat's other choices;
    /// so then fetch fresh from the server, and without an answer it does not open.
    private func openNotifications(_ chatId: String) async {
        if let chat {
            notifyChoice = chat.notify
        } else {
            do {
                let fresh: Chat = try await client.get("/api/chats/\(chatId)")
                notifyChoice = fresh.notify
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
        notifications = true
    }

    private func erase() async {
        do {
            try await client.deleteScheduled(workspaceId: workspaceId, id: job.id)
            await state.chatList?.load()
            deleted()
        } catch { self.error = error.localizedDescription }
    }

    /// After the `scheduled` event: job and runs fresh (an occurrence started or ended).
    private func loadAgain() async {
        if let list = try? await client.scheduledJobs(workspaceId: workspaceId, projectId: nil),
           let fresh = list.items.first(where: { $0.id == job.id }) {
            takeOver(fresh)
        }
        await loadRuns()
    }

    private func loadRuns(before: Int = 0) async {
        do {
            let page = try await client.scheduledRuns(workspaceId: workspaceId, id: job.id, before: before)
            runs = before > 0 ? runs + page.items : page.items
            // A full page (20) may have more; a shorter one is the last.
            additional = page.items.count >= 20 ? page.next : 0
        } catch { self.error = error.localizedDescription }
    }
}

// ── Create and change ──────────────────────────────────────────────────────────────────────────────────────────────
struct JobDialog: View {
    let client: APIClient
    let workspaceId: String
    /// The entered project (create): the new job chat works there; empty = workspace.
    let projectId: String?
    /// `nil` = create, otherwise change.
    let job: ScheduledJob?
    let finished: (ScheduledJob) -> Void

    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""
    @State private var cadence: ScheduledCadence = .daily
    @State private var clockTime = ScheduledClock.preset
    @State private var moment = Date().addingTimeInterval(3600)
    @State private var days: Set<Int> = [1]
    @State private var dayOfMonth = 1
    @State private var draft = NewChatDraft()
    @State private var providers: [Provider] = []
    @State private var error = ""
    @State private var sends = false
    /// Cadence and plan when opened (change); `save` compares against them to see whether the repeat was touched.
    @State private var outcome: (cadence: ScheduledCadence, plan: ScheduledPlan)?

    private var fresh: Bool { job == nil }
    private var selectedProvider: Provider? { providers.first { $0.id == draft.provider } }
    private var instructionsEmpty: Bool { instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var valid: Bool {
        !instructionsEmpty && instructions.count <= ScheduledContract.instructionsMax && (cadence != .weekly || !days.isEmpty)
            && (!fresh || (!draft.provider.isEmpty && !draft.model.isEmpty))
    }

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("What should the agent do at every run?"), text: $instructions, axis: .vertical)
                        .lineLimit(4...12)
                        .accessibilityIdentifier("scheduled-instructions")
                } header: {
                    Text(L("Instructions"))
                } footer: {
                    if fresh { Text(L("The first line becomes the chat’s name — rename it like any chat.")) }
                }

                Section {
                    Picker(L("retry"), selection: $cadence) {
                        ForEach(ScheduledCadence.allCases) { Text(L($0.displayLabel)).tag($0) }
                    }
                    .accessibilityIdentifier("scheduled-cadence")
                    if cadence == .oneTime {
                        DatePicker(L("Date and time"), selection: $moment, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                            .accessibilityIdentifier("scheduled-moment")
                    } else {
                        DatePicker(L("Time"), selection: $clockTime, displayedComponents: .hourAndMinute)
                            .accessibilityIdentifier("scheduled-clock-time")
                    }
                    if cadence == .weekly {
                        weekdays
                    }
                    if cadence == .monthly {
                        Picker(L("Day of the month"), selection: $dayOfMonth) {
                            ForEach(Array(ScheduledContract.dayOfMonth), id: \.self) { Text(verbatim: "\($0).").tag($0) }
                        }
                        .accessibilityIdentifier("scheduled-day-of-month")
                    }
                } header: {
                    Text(L("retry"))
                } footer: {
            // The plan's time of day applies in the job's zone; a new job gets the device's.
                    if cadence != .oneTime, let zone = job.flatMap({ ScheduledZone.foreign($0.timeZone) }) {
                        Text(L("The time applies in the task's time zone {zone}.", ["zone": zone]))
                            .accessibilityIdentifier("scheduled-zone")
                    }
                }

                if fresh {
                    expanded
                }

                if !error.isEmpty {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                }
            }
            .navigationTitle(fresh ? L("New task") : L("Edit task"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(fresh ? L("Create") : L("Save")) { Task { await save() } }
                        .disabled(!valid || sends)
                        .accessibilityIdentifier("scheduled-save")
                }
            }
            .task { await prefill() }
            .onChange(of: draft.provider) {
                if !(selectedProvider?.models.contains(where: { $0.id == draft.model }) ?? false) {
                    draft.model = selectedProvider?.defaultModel ?? selectedProvider?.models.first?.id ?? ""
                }
            }
            .onChange(of: draft.model) {
                if draft.effort.isEmpty { draft.effort = EffortLevels.standard(providers, provider: draft.provider, model: draft.model) }
            }
        }
    }

    /// Mon–Sun as buttons (cron days: 1 = Monday … 0 = Sunday); at least one must be selected.
    private var weekdays: some View {
        let queue = [1, 2, 3, 4, 5, 6, 0]
        // Short names in the app's language (index 0 = Sunday, like cron); no word list of our own.
        let format = DateFormatter()
        format.locale = Loc.locale
        let short = format.shortStandaloneWeekdaySymbols ?? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return HStack(spacing: 6) {
            ForEach(queue, id: \.self) { weekday in
                let on = days.contains(weekday)
                Button {
                    if on { days.remove(weekday) } else { days.insert(weekday) }
                } label: {
                    Text(verbatim: short[weekday])
                        .font(.subheadline.weight(on ? .semibold : .regular))
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .background(on ? Color.accentColor : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("scheduled-day-\(weekday)")
            }
        }
    }

    /// Project, permission mode, provider/model, effort level: only when creating; afterwards on the chat.
    private var expanded: some View {
        Section(L("Advanced")) {
            if let projectId, let project = state.activeWorkspace?.projects.first(where: { $0.id == projectId }) {
                LabeledContent(L("Project"), value: project.name)
            } else {
                Picker(L("Project"), selection: $draft.projectId) {
                    Text(L("Workspace")).tag("")
                    ForEach(state.activeWorkspace?.projects ?? []) { Text($0.name).tag($0.id) }
                }
            }
            Picker(L("Permissions"), selection: $draft.permissionMode) {
                Text(L("Full access")).tag("bypassPermissions")
                Text(L("Auto-edit")).tag("acceptEdits")
                Text(L("Plan")).tag("plan")
                Text(L("Ask")).tag("default")
            }
            .accessibilityIdentifier("scheduled-mode")
            Picker(L("Providers"), selection: $draft.provider) {
                ForEach(providers.filter(\.connected)) { Text($0.label).tag($0.id) }
            }
            ModelChoice(title: L("Model"), groups: selectedProvider.map { [ModelGroup($0)] } ?? [], selection: $draft.model) {
                Picker(L("Model"), selection: $draft.model) {
                    ForEach(selectedProvider?.models ?? []) { Text($0.label).tag($0.id) }
                }
            }
            // As in the new chat (`NewChatSheet`): the effort levels, below them the ultracode switch: two axes.
            EffortSelection(effort: $draft.effort, empty: nil, providers: providers, provider: draft.provider, model: draft.model)
            UltracodeToggle(on: $draft.ultracode)
        }
    }

    private func prefill() async {
        if let a = job {
            instructions = a.instructions
            cadence = a.form ?? .daily
            if let u = a.plan.clockTime, let d = ScheduledClock.date(u) { clockTime = d }
            if let at = a.plan.at, at > 0 { moment = locDate(fromServer: at) }
            if let t = a.plan.days, !t.isEmpty { days = Set(t) }
            if let t = a.plan.day { dayOfMonth = t }
            outcome = (cadence, plan)
            return
        }
        if let projectId { draft.projectId = projectId }
        do {
            let response: ProvidersResponse = try await client.get("/api/providers")
            providers = response.providers
            let active = providers.first { $0.id == response.active && $0.connected } ?? providers.first(where: \.connected)
            draft.provider = active?.id ?? ""
            draft.model = active?.defaultModel ?? active?.models.first?.id ?? ""
            if draft.effort.isEmpty { draft.effort = EffortLevels.standard(providers, provider: draft.provider, model: draft.model) }
        } catch { self.error = error.localizedDescription }
    }

    private var plan: ScheduledPlan {
        switch cadence {
        case .oneTime: return ScheduledPlan(at: (moment.timeIntervalSince1970 * 1000).rounded())
        case .daily, .workdays: return ScheduledPlan(clockTime: ScheduledClock.text(clockTime))
        case .weekly: return ScheduledPlan(clockTime: ScheduledClock.text(clockTime), days: days.sorted())
        case .monthly: return ScheduledPlan(clockTime: ScheduledClock.text(clockTime), day: dayOfMonth)
        }
    }

    private func save() async {
        sends = true
        defer { sends = false }
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let result: ScheduledJob
            if let a = job {
                // Only changes go out: an unchanged plan of a finished one-time job (occurrence past) would be a 400 on the
                // server, and the instructions could then no longer be changed.
                var change = ScheduledChange()
                if text != a.instructions { change.instructions = text }
                if let outcome, outcome.cadence == cadence, outcome.plan == plan {} else {
                    change.cadence = cadence.rawValue
                    change.plan = plan
                }
                guard change.instructions != nil || change.cadence != nil else { dismiss(); return }
                result = try await client.changeScheduled(workspaceId: workspaceId, id: a.id, change)
            } else {
                result = try await client.createScheduled(workspaceId: workspaceId, ScheduledCreation(
                    instructions: text, cadence: cadence.rawValue, plan: plan,
                    timeZone: TimeZone.current.identifier,
                    projectId: draft.projectId.isEmpty ? nil : draft.projectId,
                    provider: draft.provider, model: draft.model, effort: draft.effort.isEmpty ? nil : draft.effort,
                    ultracode: draft.ultracode ? true : nil,
                    permissionMode: draft.permissionMode
                )).job
            }
            finished(result)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

/// The time of a plan ("HH:MM" in the job's zone) ↔ a `Date` for the picker (today at that wall time).
enum ScheduledClock {
    static var preset: Date { date("08:00") ?? Date() }

    static func date(_ text: String) -> Date? {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date())
    }

    static func text(_ date: Date) -> String {
        let k = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", k.hour ?? 0, k.minute ?? 0)
    }
}
