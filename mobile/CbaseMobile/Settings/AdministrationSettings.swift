import SwiftUI

// Settings → "Administration" — the same functions as on the web (`web/src/components/settings/AdministrationSettings.tsx`),
// in HIG form: a list, one user as its own page (push). Admins only (`SettingsView` shows the group only then; the
// gateway checks every route itself). Replaces the separate page `/gw/admin` that the profile used to open in Safari —
// "Administration" now opens THIS page in the app.
//
// At the top the server (RAM allocated against the host, the reserve mark, threads, "overbooked" as a sentence —
// overbooking is allowed). Below it all users with state, short form of the limits and consumption; "differs" when the
// container carries something other than what is saved. A user's page holds the draft (RAM as a stepper in whole GiB,
// priority as segments, cap as a choice) and the manual actions: role, password, locks, start/restart/stop container,
// delete with or without data. What the gateway rejects appears with its sentence on the user's page.
//
// Reloaded every 15 s while either page is showing, and after every manual action. A draft belongs to the human: reloading
// does not touch it. It arises only from an input (`setDraft` — an input back to the saved state dissolves it), and
// saving or discarding delete it: an unchanged draft would otherwise hide newer saved values (web:
// `web/src/lib/administration-procedure.ts`). If a manual action's answer fails to arrive (request deadline or 524 behind
// the tunnel), "still running" is shown, the work flag stays, and the page reloads until the state shows it
// (`AdministrationProcedure`).
//
// Identifiers: `administration-error`, `administration-server`, `administration-create`, `administration-user-<name>`, on a
// user's page `administration-ram`, `administration-prio`, `administration-max`, `administration-save`,
// `administration-role`, `administration-password`, `administration-lock`, `administration-action-<action>`, `administration-delete`,
// `administration-user-error`, `administration-running-still`.

/// The state of the administration — shared by list and user page, handed to both as `@ObservedObject` (READ from an
/// environment object it would not be observing).
@MainActor
final class AdministrationModel: ObservableObject {
    @Published var snapshot: AdministrationStatus?
    @Published var loadError = ""
    /// The gateway's sentence and the running manual action — per user.
    @Published var error: [String: String] = [:]
    @Published var work: [String: String] = [:]
    /// Users whose manual action got no answer and who are reloaded until the state shows it (`AdministrationProcedure`).
    @Published var runningStill: Set<String> = []
    var client: APIClient?
    /// Only the LATEST answer counts: an off-cycle reload that started before a manual action would otherwise arrive after it.
    private var followUp = 0

    func load() async {
        guard let client else { return }
        followUp += 1
        let seq = followUp
        do {
            let fresh = try await client.loadAdministration()
            guard seq == followUp else { return }
            snapshot = fresh
            loadError = ""
        } catch {
            guard seq == followUp else { return }
            loadError = error.localizedDescription
        }
    }

    /// Reload every 15 s while the calling view is showing — `.task` ends the loop on disappearing.
    func tick() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(15))
        }
    }

    func user(_ id: String) -> AdministrationUser? { snapshot?.user.first { $0.id == id } }

    /// A manual action on ONE user: sentence and work flag belong to it; afterwards it reloads (sum, overbooking, consumption).
    /// `target`: the limits sent (save only) — the reload sees from it whether they arrived. Returns: arrived.
    @discardableResult
    func manualAction(_ id: String, _ what: String, target: AdministrationResources? = nil,
                   _ action: @escaping (APIClient) async throws -> AdministrationUser?) async -> Bool {
        guard let client else { return false }
        let prior = user(id)
        work[id] = what
        error[id] = nil
        var ok = true
        do {
            if let fresh = try await action(client), var s = snapshot, let i = s.user.firstIndex(where: { $0.id == fresh.id }) {
                s.user[i] = fresh
                snapshot = s
            }
        } catch let absent where AdministrationProcedure.runningStill(absent) {
            // Deadline or tunnel gave up, the gateway keeps working: no "failed", the flag stays until the state shows it.
            ok = await bringAlong(id, what, prior: prior, target: target)
        } catch {
            self.error[id] = error.localizedDescription
            ok = false
        }
        work[id] = nil
        await load()
        return ok
    }

    /// After a manual action without an answer: reload every `reloadEvery` until the state shows it — at most the grace
    /// period of `what` long. The caller resets the work flag (it stays while waiting here). Returns: arrived.
    func bringAlong(_ id: String, _ what: String, prior: AdministrationUser?, target: AdministrationResources?) async -> Bool {
        runningStill.insert(id)
        defer { runningStill.remove(id) }
        let end = Date().addingTimeInterval(AdministrationProcedure.gracePeriod(what))
        while Date() < end && !Task.isCancelled {
            try? await Task.sleep(for: .seconds(AdministrationProcedure.reloadEvery))
            await load()
            if AdministrationProcedure.arrived(what, prior: prior, now: user(id), target: target) { return true }
        }
        error[id] = L("No answer from the gateway — the user's state shows whether the action went through.")
        return false
    }
}

struct AdministrationSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var model = AdministrationModel()
    @State private var createOpen = false

    var body: some View {
        CbList {
            if !model.loadError.isEmpty {
                Section {
                    Label(model.loadError, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("administration-error")
                }
            }
            if model.snapshot == nil && model.loadError.isEmpty {
                Section { CbLoading(label: L("Loading…"), compact: true) }
            }
            if let snapshot = model.snapshot {
                AdministrationServerGroup(server: snapshot.server)
                CbSettingGroup(
                    title: L("Users"),
                    hint: L("Every change applies to the container right away and also holds when the gateway recreates it.")
                ) {
                    Button {
                        createOpen = true
                    } label: {
                        Label(L("Create user"), systemImage: "person.badge.plus")
                    }
                    .accessibilityIdentifier("administration-create")
                    ForEach(snapshot.user) { n in
                        NavigationLink {
                            AdministrationUserView(id: n.id, model: model)
                        } label: {
                            AdministrationUserRow(n: n)
                        }
                        .accessibilityIdentifier("administration-user-\(n.username)")
                    }
                }
            }
        }
        .navigationTitle(L("Admin"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.client = session.client
            await model.tick()
        }
        .cbRefreshable { await model.load() }
        .sheet(isPresented: $createOpen) {
            AdministrationCreateSheet(model: model)
            .cbSheet(.whole)
        }
    }
}

// ── Server ──────────────────────────────────────────────────────────────────

private struct AdministrationServerGroup: View {
    let server: AdministrationServer

    private var percent: Double {
        guard let g = server.ramTotalBytes, g > 0, let v = server.ramAllocatedBytes else { return 0 }
        return v / g * 100
    }

    /// Where the host's reserve begins, in percent of the width — `nil` if one of the numbers is missing.
    private var marker: Double? {
        guard let g = server.ramTotalBytes, g > 0, let r = server.reserveBytes else { return nil }
        return max(0, min(100, (g - r) / g * 100))
    }

    var body: some View {
        CbSettingGroup(title: L("Server")) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text(L("RAM allocated")).font(.subheadline.weight(.medium))
                    Spacer()
                    if let v = server.ramAllocatedBytes, let g = server.ramTotalBytes {
                        Text(L("{v} of {g}", ["v": administrationGiBText(v), "g": administrationGiBText(g)]))
                            .cbFont(12, weight: .medium, design: .monospaced)
                    } else {
                        Text(verbatim: "–").foregroundStyle(.secondary)
                    }
                }
                // Coloured deliberately: here the reserve mark counts, not the 70/90 thresholds of the usage ring.
                CbProgressBar(percent: percent, tone: server.overcommitted ? Color.orange : Color.accentColor, height: 8)
                    .overlay(alignment: .leading) {
                        if let marker {
                            GeometryReader { g in
                                Capsule()
                                    .fill(Color.primary.opacity(0.7))
                                    .frame(width: 2, height: 14)
                                    .offset(x: g.size.width * marker / 100 - 1, y: -3)
                            }
                        }
                    }
                if let r = server.reserveBytes {
                    Text(L("The mark shows where the host's reserve ({r}) begins.", ["r": administrationGiBText(r)]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .accessibilityIdentifier("administration-server")
            CbSettingRow(title: L("Threads")) {
                Text(verbatim: server.threads.map { String($0) } ?? "–")
                    .cbFont(12, weight: .medium, design: .monospaced)
            }
            if server.overcommitted {
                Label(
                    L("Overcommitted: the RAM limits together exceed what the host has after its reserve. That is allowed — limits are caps, not reservations."),
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        }
    }
}

// ── List row ────────────────────────────────────────────────────────────────

/// Short form of the limits — the same order as on the web: RAM · priority · cap.
func administrationShortForm(_ r: AdministrationResources) -> String {
    let max = r.cpuMax.map { L("at most {n} threads", ["n": $0]) } ?? L("no CPU limit")
    return "\(r.ramGiB) GiB · \(L("priority {p}", ["p": administrationPrioWord(r.cpuPrio)])) · \(max)"
}

private struct AdministrationUserRow: View {
    let n: AdministrationUser

    private var point: Color {
        switch n.container.state {
        case "running": return .green
        case "stopped": return Color.secondary.opacity(0.5)
        default: return Color.secondary.opacity(0.25)
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(point).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(n.username).font(.subheadline.weight(.medium)).lineLimit(1)
                    if n.itself { Text(L("you")).font(.caption).foregroundStyle(.secondary) }
                    Text(administrationRoleWord(n.role)).font(.caption).foregroundStyle(.secondary)
                    if n.locked { Text(L("locked")).font(.caption.weight(.medium)).foregroundStyle(.red) }
                    if n.deviating { Text(L("differs")).font(.caption.weight(.medium)).foregroundStyle(.orange) }
                }
                Text(subline)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 1)
    }

    private var subline: String {
        var parts = [administrationStateWord(n.container.state)]
        if let r = n.resources { parts.append(administrationShortForm(r)) }
        if let ram = n.consumption?.ramBytes { parts.append(L("{v} in use", ["v": administrationGiBText(ram)])) }
        return parts.joined(separator: " · ")
    }
}

// ── A user's page ───────────────────────────────────────────────────────────

struct AdministrationUserView: View {
    let id: String
    @ObservedObject var model: AdministrationModel
    @Environment(\.dismiss) private var dismiss
    /// The draft — `nil` as long as no input differs from the saved state (the page then shows the CURRENT saved state);
    /// arises only in `setDraft`, dropped on saving and discarding.
    @State private var draft: AdministrationResources?
    @State private var passwordOpen = false
    @State private var deleteQuestion = false

    var body: some View {
        Group {
            if let n = model.user(id) {
                page(n)
            } else {
                // Deleted (also from another device) or not loaded yet.
                CbList { Section { CbLoading(label: L("Loading…"), compact: true) } }
            }
        }
        .navigationTitle(model.user(id)?.username ?? L("Admin"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.tick() }
        .sheet(isPresented: $passwordOpen) {
            if let n = model.user(id) { AdministrationPasswordSheet(n: n, model: model).cbSheet(.whole) }
        }
        .confirmationDialog(
            L("Delete “{name}”?", ["name": model.user(id)?.username ?? ""]),
            isPresented: $deleteQuestion,
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) { Task { await erase(withData: false) } }
            Button(L("Delete with data"), role: .destructive) { Task { await erase(withData: true) } }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Workspaces, chats and provider logins (the volumes) — cannot be undone. Without it they stay on the server."))
        }
    }

    private func page(_ n: AdministrationUser) -> some View {
        let busy = model.work[n.id] != nil
        return CbList {
            if let set = model.error[n.id] {
                Section {
                    Label(set, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("administration-user-error")
                }
            }
            if model.runningStill.contains(n.id) {
                Section {
                    Label(L("Still running — the gateway did not answer in time and keeps working. The page reloads until the state shows it."),
                          systemImage: "hourglass")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("administration-running-still")
                }
            }
            statusGroup(n)
            if let e = draft ?? n.resources {
                resourcesGroup(n, e, busy: busy)
            } else {
                Section {
                    Text(L("The gateway reported no stored limits for this user."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            accountGroup(n, busy: busy)
            containerGroup(n, busy: busy)
            Section {
                Button(role: .destructive) {
                    deleteQuestion = true
                } label: {
                    Label(L("Delete user…"), systemImage: "trash")
                }
                .disabled(busy || n.itself)
                .accessibilityIdentifier("administration-delete")
            } footer: {
                if n.itself { Text(L("Your own account cannot be deleted.")) }
            }
        }
    }

    @ViewBuilder
    private func statusGroup(_ n: AdministrationUser) -> some View {
        CbSettingGroup(title: L("State")) {
            CbSettingRow(title: administrationStateWord(n.container.state)) {
                if let since = n.container.since, let date = UsageStore.parse(since) {
                    Text(L("since {time}", ["time": locDateTime(date)])).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let v = n.consumption {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(L("Usage")).font(.subheadline.weight(.medium))
                        Spacer()
                        Text(consumptionText(n, v)).cbFont(12, design: .monospaced)
                    }
                    if let ram = v.ramBytes, let r = n.resources {
                        CbProgressBar(percent: ram / (Double(r.ramGiB) * administrationGiB) * 100, height: 7)
                    }
                }
                .padding(.vertical, 2)
            }
            if n.deviating, let actual = n.actual {
                Label(L("The container currently carries: {actual}", ["actual": isText(actual)]), systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let created = n.createdAt {
                CbSettingRow(title: L("created {date}", ["date": locDateTime(locDate(fromServer: created))]))
            }
        }
    }

    private func consumptionText(_ n: AdministrationUser, _ v: AdministrationConsumption) -> String {
        let ram = v.ramBytes.map(administrationGiBText) ?? "–"
        let limit = n.resources.map { " / \($0.ramGiB) GiB" } ?? ""
        let cpu = v.cpuThreads.map { L("{n} threads", ["n": $0.formatted(.number.precision(.fractionLength(0...1)).locale(Loc.locale))]) } ?? "–"
        return "\(ram)\(limit) · \(cpu)"
    }

    private func isText(_ actual: AdministrationActual) -> String {
        let ram = actual.ramBytes.map(administrationGiBText) ?? L("RAM without limit")
        let stage = AdministrationContract.cpuPrio.first { AdministrationContract.cpuPrioWeight[$0] == actual.cpuWeight }
        let prio = stage.map { L("priority {p}", ["p": administrationPrioWord($0)]) }
            ?? actual.cpuWeight.map { L("Weight {n}", ["n": $0]) } ?? "–"
        let max = actual.cpuMax.map { L("at most {n} threads", ["n": $0.formatted(.number.precision(.fractionLength(0...2)).locale(Loc.locale))]) }
            ?? L("no CPU limit")
        return "\(ram) · \(prio) · \(max)"
    }

    /// The ONE way a draft arises: an input. If it arrives back at the saved state, there is none.
    private func setDraft(_ fresh: AdministrationResources, _ n: AdministrationUser) {
        draft = fresh == n.resources ? nil : fresh
    }

    @ViewBuilder
    private func resourcesGroup(_ n: AdministrationUser, _ e: AdministrationResources, busy: Bool) -> some View {
        let ramMax = model.snapshot?.server.ramTotalBytes.map { max(AdministrationContract.ramMinGiB, Int($0 / administrationGiB)) } ?? 1024
        let threads = max(model.snapshot?.server.threads ?? 0, e.cpuMax ?? 0)
        let changed = e != n.resources
        let toTight = n.consumption?.ramBytes.map { Double(e.ramGiB) * administrationGiB < $0 + AdministrationContract.ramBufferBytes } ?? false
        CbSettingGroup(title: L("Resources")) {
            CbSettingRow(title: L("RAM")) {
                Stepper(value: Binding(get: { e.ramGiB }, set: { fresh in setDraft(AdministrationResources(ramGiB: fresh, cpuPrio: e.cpuPrio, cpuMax: e.cpuMax), n) }),
                        in: AdministrationContract.ramMinGiB...max(AdministrationContract.ramMinGiB, ramMax, e.ramGiB)) {
                    Text(verbatim: "\(e.ramGiB) GiB").monospacedDigit()
                }
                .fixedSize()
                .accessibilityIdentifier("administration-ram")
            }
            if toTight, let v = n.consumption?.ramBytes {
                Text(L("Less than the usage ({v}) plus {clearance} headroom — the gateway rejects that.",
                       ["v": administrationGiBText(v), "clearance": "\(Int(AdministrationContract.ramBufferBytes / 1024 / 1024)) MiB"]))
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(L("CPU priority")).font(.subheadline.weight(.medium))
                CbSegments(
                    options: AdministrationContract.cpuPrio.map { CbSegment(value: $0, label: administrationPrioWord($0), id: $0) },
                    selection: Binding(get: { e.cpuPrio }, set: { fresh in setDraft(AdministrationResources(ramGiB: e.ramGiB, cpuPrio: fresh, cpuMax: e.cpuMax), n) })
                )
                .accessibilityIdentifier("administration-prio")
            }
            .padding(.vertical, 2)
            CbSettingRow(title: L("CPU limit")) {
                // `0` stands for "none" — a picker needs a value, SwiftUI has no `nil` there.
                Picker(L("CPU limit"), selection: Binding(get: { e.cpuMax ?? 0 }, set: { fresh in setDraft(AdministrationResources(ramGiB: e.ramGiB, cpuPrio: e.cpuPrio, cpuMax: fresh == 0 ? nil : fresh), n) })) {
                    Text(L("none")).tag(0)
                    ForEach(Array(1...max(1, threads)), id: \.self) { i in
                        Text(verbatim: "\(i)").tag(i)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .accessibilityIdentifier("administration-max")
            }
            HStack {
                if changed {
                    Button(L("Discard changes##draft")) { draft = nil }
                        .buttonStyle(.borderless)
                        .disabled(busy)
                }
                Spacer()
                Button(model.work[n.id] == "save" ? L("Saving…") : L("Save")) {
                    Task {
                        let ok = await model.manualAction(n.id, "save", target: e) { client in try await client.setResources(n.id, e) }
                        // Saved: the draft drops, the page shows the state from the response — an input WHILE saving is a
                        // new draft and stays.
                        if ok && draft == e { draft = nil }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!changed || busy)
                .accessibilityIdentifier("administration-save")
            }
        }
    }

    @ViewBuilder
    private func accountGroup(_ n: AdministrationUser, busy: Bool) -> some View {
        CbSettingGroup(title: L("Account")) {
            CbSettingRow(title: L("Role")) {
                Picker(L("Role"), selection: Binding(
                    get: { n.role ?? "" },
                    set: { fresh in
                        guard fresh != n.role, !fresh.isEmpty else { return }
                        Task { await model.manualAction(n.id, "role") { client in try await client.setRole(n.id, fresh) } }
                    }
                )) {
                    if n.role == nil { Text(L("role unknown")).tag("") }
                    ForEach(AdministrationContract.roles, id: \.self) { r in
                        Text(administrationRoleWord(r)).tag(r)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(busy)
                .accessibilityIdentifier("administration-role")
            }
            Button {
                passwordOpen = true
            } label: {
                Label(L("Set password"), systemImage: "key")
            }
            .disabled(busy)
            .accessibilityIdentifier("administration-password")
            Button(role: n.locked ? nil : ButtonRole.destructive) {
                Task { await model.manualAction(n.id, "lock") { client in try await client.setLocked(n.id, !n.locked) } }
            } label: {
                Label(n.locked ? L("Unlock") : L("Lock"), systemImage: n.locked ? "lock.open" : "lock")
            }
            .disabled(busy || (n.itself && !n.locked))
            .accessibilityIdentifier("administration-lock")
            if n.itself && !n.locked {
                Text(L("Your own account cannot be locked.")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func containerGroup(_ n: AdministrationUser, busy: Bool) -> some View {
        CbSettingGroup(title: L("User container")) {
            if n.container.state == "running" {
                actionButton(n, "restart", L("Restart"), "arrow.clockwise", busy: busy)
                actionButton(n, "stop", L("Stop"), "stop.circle", busy: busy)
            } else {
                actionButton(n, "start", L("Start"), "play.circle", busy: busy)
            }
        }
    }

    private func actionButton(_ n: AdministrationUser, _ action: String, _ word: String, _ symbol: String, busy: Bool) -> some View {
        Button {
            Task { await model.manualAction(n.id, action) { client in try await client.containerAction(n.id, action) } }
        } label: {
            HStack {
                Label(word, systemImage: symbol)
                if model.work[n.id] == action {
                    Spacer()
                    ProgressView()
                }
            }
        }
        .disabled(busy)
        .accessibilityIdentifier("administration-action-\(action)")
    }

    private func erase(withData: Bool) async {
        guard let client = model.client else { return }
        let prior = model.user(id)
        model.work[id] = "erase"
        model.error[id] = nil
        do {
            try await client.deleteUser(id, withData: withData)
            model.work[id] = nil
            await model.load()
            dismiss()
        } catch let absent where AdministrationProcedure.runningStill(absent) {
            // Without an answer: the gateway keeps tearing down — the flag stays until the user drops out of the list.
            let erased = await model.bringAlong(id, "erase", prior: prior, target: nil)
            model.work[id] = nil
            if erased { dismiss() }
        } catch {
            model.error[id] = error.localizedDescription
            model.work[id] = nil
            await model.load()
        }
    }
}

// ── Sheets ──────────────────────────────────────────────────────────────────

private struct AdministrationCreateSheet: View {
    @ObservedObject var model: AdministrationModel
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var role = "user"
    @State private var running = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("Username"), text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("administration-create-name")
                    SecureField(L("Password"), text: $password)
                        .textContentType(.newPassword)
                        .accessibilityIdentifier("administration-create-password")
                    Picker(L("Role"), selection: $role) {
                        ForEach(AdministrationContract.roles, id: \.self) { r in Text(administrationRoleWord(r)).tag(r) }
                    }
                } footer: {
                    Text(L("The new user gets the template limits; you can change them afterwards in their row."))
                }
                if !error.isEmpty {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(L("Create user"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(running ? L("Creating…") : L("Create")) { Task { await create() } }
                        .disabled(running || username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                        .accessibilityIdentifier("administration-create-go")
                }
            }
        }
    }

    private func create() async {
        guard let client = model.client else { return }
        running = true
        error = ""
        do {
            try await client.setUpUser(AdministrationCreateBody(
                username: username.trimmingCharacters(in: .whitespaces), password: password, role: role
            ))
            await model.load()
            dismiss()
        } catch {
            self.error = error.localizedDescription
            running = false
        }
    }
}

private struct AdministrationPasswordSheet: View {
    let n: AdministrationUser
    @ObservedObject var model: AdministrationModel
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var running = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    SecureField(L("New password"), text: $password)
                        .textContentType(.newPassword)
                        .accessibilityIdentifier("administration-password-field")
                }
                if !error.isEmpty {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(L("Set password for “{name}”", ["name": n.username]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(running ? L("Saving…") : L("Save")) { Task { await save() } }
                        .disabled(running || password.isEmpty)
                }
            }
        }
    }

    private func save() async {
        guard let client = model.client else { return }
        running = true
        error = ""
        do {
            try await client.setPassword(n.id, password)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            running = false
        }
    }
}
