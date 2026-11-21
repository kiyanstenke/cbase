import SwiftUI

// Apps page: an overview of the projects and which stacks run under them (main Docker stack and copies). One card per project:
// its stacks (main and copies) with state and load, below them the services compactly with their start command. The port view
// (port list, live scan, next free port) is gone, as on the web (web/src/app/apps/page.tsx). A project is chosen via the left
// drawer.
//
// Instance choice: when a project has a READY copy, its stack rows are the choice. A tap on "Main" or "k1" selects the
// instance, and everything below (dot, counter, stop, start, start/stop all) applies to it.
//   - Computed with the instance choice of the code tab (`CodeInstance.select`, twin of web/src/lib/code-instance.ts): the main
//     and every ready copy are selectable, main is preselected, remembered per project under its OWN key (`AppsModel.rememberKey`).
//   - Main carries no parameter, a copy carries `?instance=<identifier>` on start and stop. There is no agent start in a copy
//     (409 COPY_AGENT): there "Start" has no menu.
//   - The state per service: `ServicesRules.serviceInInstance`; if the entry is missing or the copy is not `ready`, it is UNKNOWN:
//     no button, never "stopped".
//   - A cleared, failed or vanished copy visibly falls back to main ("Services · Main · k1 not ready" / "… k1 gone"), as does a
//     404 `UNKNOWN_INSTANCE` from a service call (`CodeInstance.afterError`); a copy that is only transiently not ready stays
//     chosen. The hint disappears once it is outdated (`fallbackOutdated`); if the human clears the chosen copy themselves, the
//     page switches to main as soon as the server has accepted the delete, and reports no fallback (`clearAwayAssigned`).
//   - Clearing (the cross on a copy) opens the SAME sheet as "Delete copy" in the "Instances" tab and "Clear away" in the
//     services pill (`CopyDeleteSheet`, Code/CopyDelete.swift: preview per repo, chats, lock 409 INSTANCE_WORKING). The DELETE
//     lives ONLY there; this page used to be a third place with its own confirmation and call. Guard:
//     client/test/services-instances-ios.test.mjs.
//   - With only one instance (no ready copy, project not converted) there is no choice and no parameter.

/// When does a "Starting"/"Stopping" transition end? Twin of `transitionStep` in web/src/lib/service-transition.ts: same numbers and
/// same order, bound by text in web/test/service-stoppable.test.mjs. Applies to the apps page and the services of a project
/// (`Code/ProjectsPane.swift`). Without it "Starting" ended only at `running`: a run held by the start guard (`holdsStart`), and
/// a start whose process died at once, hung on "Starting" forever without a button.
///   1. State unknown ⇒ `.unknown`.  2. Stop: nothing stoppable any more ⇒ `.reached`, otherwise after the deadline ⇒ `.deadline`.
///   3. Start: running ⇒ `.reached`.  4. Plain start: the state shows nothing stoppable, and an earlier state that ARRIVED at least
///      `lingerSeconds` before this query began (`deadSince`) showed that too ⇒ `.ended` (the start command did not keep running;
///      the reason is in the log).  5. Otherwise after the deadline ⇒ `.deadline` (an agent start with the longer one).
/// The linger time hangs on the first dead state, not on the response: the server probes 8 s after the END of the start command
/// (services.js `afterTheEnd`), the route answers at once; a `docker compose up -d` that ran 3 s and whose service listened after
/// 10 s would otherwise show "did not keep running" at 8 s. Only states whose query began after the response count; a
/// stoppable one whose query began after `deadSince` takes it back. Details in the head of the web sheet.
enum ServiceTransitionRule {
    static let deadlineSeconds: TimeInterval = 45
    static let deadlineAgentSeconds: TimeInterval = 180
    static let lingerSeconds: TimeInterval = 8

    enum End: Equatable { case unknown, reached, ended, deadline }

    /// A step on the state: the end (`nil`: continues) and `deadSince` afterwards. `running == nil`: state unknown. `now`: when the
    /// state arrived; `queried`: when its query BEGAN.
    static func step(start: Bool, mode: String?, since: Date, response: Date?, deadSince: Date?, running: Bool?, holds: Bool, now: Date, queried: Date) -> (end: End?, deadSince: Date?) {
        guard let running else { return (.unknown, deadSince) }
        let stoppable = running || holds
        let age = now.timeIntervalSince(since)
        if !start { return (!stoppable ? .reached : (age >= deadlineSeconds ? .deadline : nil), deadSince) }
        if running { return (.reached, deadSince) }
        let tot = deadSinceAfter(mode: mode, response: response, soFar: deadSince, stoppable: stoppable, now: now, queried: queried)
        if mode == "simple", !stoppable, let tot, queried.timeIntervalSince(tot) >= lingerSeconds { return (.ended, tot) }
        return (age >= (mode == "agent" ? deadlineAgentSeconds : deadlineSeconds) ? .deadline : nil, tot)
    }

    /// `deadSince` after a state: only for a plain start and only for queries that began after the response.
    static func deadSinceAfter(mode: String?, response: Date?, soFar: Date?, stoppable: Bool, now: Date, queried: Date) -> Date? {
        guard mode == "simple", let response, queried >= response else { return soFar }
        if !stoppable { return soFar.map { min($0, now) } ?? now }
        if let soFar, queried >= soFar { return nil }
        return soFar
    }

    /// The message when a plain start did not keep running.
    static func endedNotice(_ names: [String]) -> String {
        names.map { L("“{name}” did not keep running after the start — the service log has the reason.", ["name": $0]) }.joined(separator: " · ")
    }
}

@MainActor
final class AppsModel: ObservableObject {
    @Published var services: [ProjectServiceRow] = []
    @Published var workspaces: [Workspace] = []
    // Port conflicts per project: the server's ONE calculation (GET /api/ports/conflicts, store.projectPortConflicts): a CONVERTED
    // project has none (own network namespace), and only the server knows that. This page used to count the projects per port
    // itself and kept showing the converted one as a conflict. A route error keeps the last state (empty is not unknown). Guard:
    // web/test/apps-conflicts.test.mjs (also reads this file).
    @Published var conflicts: [String: PortConflictGroup] = [:]
    /// The projects with instance and copies (`GET /api/projects`); `nil` = no answer yet, until then the projects that have
    /// services show without stacks.
    @Published var projects: [AppsProject]?
    /// The project list did not arrive on the first fetch: a remembered copy then counts as "unchecked" (main) instead of waiting forever.
    @Published private(set) var projectsError = false
    /// The load per project and instance (`GET /api/project-resources?disk=0`); `nil` = no measurement yet.
    @Published var resources: [ProjectResourceRow]?
    @Published var loading = true
    @Published var error = ""
    @Published var info = ""
    /// Running transitions (Starting/Stopping) per service AND instance (`transitionKey`, like `uidOf` on the web): switching the choice
    /// never shows the "Starting" of another instance, and a start in main right followed by one in k1 do not overwrite each other.
    @Published var transitions: [String: Transition] = [:]
    /// The "start/stop all" stacks currently running, per project AND instance (`ProjectGroup.stackKey`): a stack in k1 does not
    /// lock the buttons of main. With the KIND: start and stop shared one flag, and "Start all" said "starting…" during a stop too.
    @Published var stackBusy: [String: StackKind] = [:]
    enum StackKind { case start, stop }
    /// Copies whose clearing the server has accepted while the project list still lists them as ready: with a queued clearing the
    /// row deliberately stays `ready`, and the cross would otherwise reappear.
    @Published private(set) var clearAwayAccepted: Set<String> = []
    /// A visible fallback to main per project (the remembered copy is gone, cleared, failed or reported unknown by the server). It
    /// stands until the human chooses again or it is outdated (`fallbacksBringAlong`). The choice itself reports it only at the
    /// moment it falls back.
    @Published private(set) var fallback: [String: CodeInstance.Hint] = [:]

    struct Transition: Equatable {
        enum Kind { case starts, stops }
        let kind: Kind
        /// The service whose state measures the end of the transition.
        let service: Int
        /// The `instance` parameter of the call; `nil` is main.
        let instance: String?
        /// Start (the deadline counts from here), for a start the mode ("simple"/"agent") and when the response came (`ServiceTransitionRule`).
        var since = Date()
        var mode: String? = nil
        var response: Date? = nil
        /// For a plain start: when the first dead state after the response arrived (`ServiceTransitionRule.deadSinceAfter`).
        var deadSince: Date? = nil

        /// A step on the state of ITS instance; advances `deadSince`; `nil`: the transition continues.
        mutating func step(_ status: ServicesRules.ServiceInInstance?, now: Date, queried: Date) -> ServiceTransitionRule.End? {
            let r = ServiceTransitionRule.step(start: kind == .starts, mode: mode, since: since, response: response, deadSince: deadSince,
                                                 running: status?.running, holds: status?.holds ?? false, now: now, queried: queried)
            deadSince = r.deadSince
            return r.end
        }
    }

    /// The response to a start has arrived, but only if the SAME transition still stands under the key.
    private func responseArrived(_ key: String, _ u: Transition) {
        guard transitions[key] == u else { return }
        transitions[key]?.response = Date()
    }

    /// The key of a transition in `transitions`: service id and instance ("7@p1/copy-k1", main "7@main").
    static func transitionKey(_ service: Int, _ instance: String?) -> String { "\(service)@\(instance ?? CodeInstance.main)" }

    struct ProjectGroup: Identifiable {
        let id: String
        let name: String
        let workspaceId: String?
        /// The services IN THE CHOSEN INSTANCE: `running`/`holdsStart` carry its state (`AppsInstanceView.status`: for main the fields of
        /// the row, for a copy its entry in `instances`). Dot, counter, "Stop" and "Start/stop all" read it; an unknown state shows
        /// here as `running: false` AND in `unknown`.
        var services: [ProjectServiceRow]
        /// The services whose state in this instance is unknown: without a button and in no stack.
        var unknown: Set<Int>
        var stacks: [AppsStack]
        var view: AppsInstanceView

        /// What "Start all" starts: with a start command, neither running nor held, state known.
        var startable: [ProjectServiceRow] {
            services.filter { !$0.startCommand.isEmpty && !$0.stoppable && !unknown.contains($0.id) }
        }

        var stackKey: String { "\(id)@\(view.param ?? CodeInstance.main)" }
    }

    let client: APIClient
    private var poll: Task<Void, Never>?
    private var tick = 0

    init(client: APIClient) {
        self.client = client
    }

    deinit { poll?.cancel() }

    /// All projects (also without services: a stack can run without a registered service), by name; before the first answer
    /// from `/api/projects` those that have services.
    var groups: [ProjectGroup] {
        var byProject: [String: [ProjectServiceRow]] = [:]
        for service in services { byProject[service.projectId, default: []].append(service) }
        let last = Dictionary((resources ?? []).map { ($0.projectId, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [ProjectGroup]
        if let projects {
            out = projects.map { p in
                let d = byProject[p.id] ?? []
                return group(id: p.id, name: p.name, workspaceId: p.workspaceId, services: d,
                              stacks: AppsStack.from(project: p, last: last[p.id], services: d))
            }
        } else {
            out = byProject.map { id, d in
                group(id: id, name: d[0].projectName, workspaceId: d[0].workspaceId, services: d, stacks: [])
            }
        }
        return out.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    /// A project group in its chosen instance. The stacks count from the RAW rows (each instance on its own), the services show in
    /// the state of the choice.
    private func group(id: String, name: String, workspaceId: String?, services d: [ProjectServiceRow], stacks: [AppsStack]) -> ProjectGroup {
        let view = view(id)
        var unknown = Set<Int>()
        let inInstance = d.map { row -> ProjectServiceRow in
            let status = view.status(row)
            if status.running == nil { unknown.insert(row.id) }
            var r = row
            r.running = status.running ?? false
            r.holdsStart = status.holds
            return r
        }
        return ProjectGroup(id: id, name: name, workspaceId: workspaceId, services: inInstance, unknown: unknown, stacks: stacks, view: view)
    }

    // ── Instance choice ──

    /// Own key: the choice in the code tab (`CodeInstance.rememberKey`) is a different one.
    static func rememberKey(_ projectId: String) -> String { "cbase-apps-instance:\(projectId)" }

    /// The remembered copy of a project (main is never remembered; it is the preselection).
    func remembered(_ projectId: String) -> String? {
        UserDefaults.standard.string(forKey: Self.rememberKey(projectId))
    }

    private func remember(_ projectId: String, _ identifier: String?) {
        guard remembered(projectId) != identifier else { return }
        objectWillChange.send()
        let key = Self.rememberKey(projectId)
        if let identifier { UserDefaults.standard.set(identifier, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// Empty is not unknown: as long as the project list never came, a remembered copy waits (`loading`) or counts as unchecked (`error`).
    private var situation: CodeInstance.ListSituation { projects != nil ? .loaded : (projectsError ? .error : .loading) }

    /// What the page shows and controls for a project.
    func view(_ projectId: String) -> AppsInstanceView {
        let instance = projects?.first(where: { $0.id == projectId })?.instance
        let field = instance.map { i in
            CodeInstance.Field(identifier: i.identifier, converted: i.converted,
                             copies: i.copies.map { CodeInstance.CopyRow(identifier: $0.identifier, state: $0.state) })
        }
        let choice = CodeInstance.select(projectId: projectId, field: field, remembered: remembered(projectId), situation: situation)
        let copyState = choice.param.flatMap { p in instance?.copies.first(where: { $0.identifier == p })?.state }
        return AppsInstanceView(choice: choice, fallback: fallback[projectId], copyState: copyState)
    }

    /// The human chooses an instance (tap on a stack row), only one of those offered.
    func select(_ projectId: String, _ identifier: String) {
        guard let target = view(projectId).choice.options.first(where: { $0.identifier == identifier }) else { return }
        fallback[projectId] = nil
        remember(projectId, target.kind == "copy" ? target.identifier : nil)
    }

    /// After every new project list: a remembered copy that is gone, cleared or failed visibly falls back to main and is forgotten;
    /// one that is only transiently not ready stays remembered (same rule as in the code tab).
    private func choicesBringAlong() {
        guard let projects else { return }
        for p in projects {
            guard let old = remembered(p.id) else { continue }
            let choice = view(p.id).choice
            guard !choice.waiting, choice.remember != old else { continue }
            if choice.remember == nil, let hint = choice.hint { fallback[p.id] = hint }
            remember(p.id, choice.remember)
        }
    }

    /// After every new project list, AFTER `choicesBringAlong`: a held fallback is outdated as soon as a copy counts again, the named
    /// copy is selectable again, or it is gone and no choice is offered any more (`fallbackOutdated`, same rule as on the web). It
    /// used to fall only in the choice's `select`; if no copy remained afterwards, "k1 gone" stood until the app restarted, and
    /// could not be dismissed (there was nothing left to choose).
    private func fallbacksBringAlong() {
        guard let projects else { return }
        for p in projects {
            guard let h = fallback[p.id] else { continue }
            if Self.fallbackOutdated(h, choice: view(p.id).choice, copies: p.instance?.copies.map(\.identifier) ?? []) { fallback[p.id] = nil }
        }
    }

    /// Does the fallback `h` still refer to anything? No, if a copy counts and the named one is among the `options` again (only for
    /// "not ready": a "gone" also comes from a server 404 while the list still shows the copy as ready for one more tick), or it is
    /// no longer among the project's copies AND there is no choice any more. If it is still there (error, cleared by someone else),
    /// it stays: it says why the page shows main. Twin: `fallbackOutdated` in web/src/app/apps/page.tsx.
    static func fallbackOutdated(_ h: CodeInstance.Hint, choice: CodeInstance.Choice, copies: [String]) -> Bool {
        let name = hintName(h)
        if choice.param != nil { return true }
        var gone = false
        if case .gone = h { gone = true }
        if !gone, choice.options.contains(where: { $0.kind == "copy" && $0.name == name }) { return true }
        let stands = copies.contains { CodeInstance.copyNameOf($0) == name }
        return !stands && choice.options.isEmpty
    }

    /// The name of the copy a hint mentions ("k1").
    static func hintName(_ h: CodeInstance.Hint) -> String {
        switch h {
        case .gone(let n), .notReady(let n, _), .transient(let n, _), .unchecked(let n), .held(let n, _): return n
        }
    }

    /// A rejected service call: if the server reports the CHOSEN copy unknown (404 `UNKNOWN_INSTANCE` with its identifier, the same
    /// vocabulary as in the code tab), the page visibly falls back to main (`true`). Any other error leaves the choice unchanged.
    private func fallbackAfter(_ error: Error, projectId: String) -> Bool {
        let choice = view(projectId).choice
        guard let e = error as? APIError,
              let r = CodeInstance.afterError(choice, code: e.code, identifier: e.identifier) else { return false }
        fallback[projectId] = r.hint
        remember(projectId, nil)
        // The action itself did NOT happen; the error line says so. The suffix on "Services" disappears as soon as the list no longer lists
        // the copy and there is no choice any more (`fallbackOutdated`); without this line the tap would then stay without an answer.
        if let name = choice.copy { self.error = L("The copy {name} no longer exists — the page shows the main instance again.", ["name": name]) }
        return true
    }

    /// The transition of a service in the shown instance (`nil`: none, or it runs in another).
    func transition(_ service: ProjectServiceRow, in view: AppsInstanceView) -> Transition.Kind? {
        transitions[Self.transitionKey(service.id, view.param)]?.kind
    }

    // The ports the server reports as a conflict: not computed, only collected.
    var conflictPorts: Set<Int> {
        Set(conflicts.values.flatMap { $0.items.map(\.port) })
    }

    // A service is in conflict when ITS project holds the port there, not because some project holds it.
    func inConflict(_ service: ProjectServiceRow) -> Bool {
        guard let port = service.port else { return false }
        return conflicts[service.projectId]?.items.contains { $0.port == port } ?? false
    }

    func workspaceName(_ id: String?) -> String? {
        guard let id else { return nil }
        return workspaces.first(where: { $0.id == id })?.name
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            workspaces = try await client.get("/api/workspaces")
            await refreshServices(strict: true)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        await refreshResources()
    }

    /// Services, projects and conflicts, fetched separately: an error of the conflict or project route does not take the services
    /// with it and keeps the last state.
    func refreshServices(strict: Bool = false) async {
        if let k: [String: PortConflictGroup] = try? await client.get("/api/ports/conflicts") { conflicts = k }
        if let p: [AppsProject] = try? await client.get("/api/projects") {
            projects = p
            projectsError = false
            choicesBringAlong()
            fallbacksBringAlong()
            clearAwayAccepted = clearAwayAccepted.filter { k in p.contains { $0.instance?.copies.contains { $0.identifier == k && $0.state == "ready" } ?? false } }
        } else if projects == nil {
            projectsError = true
        }
        let queried = Date()
        if let rows: [ProjectServiceRow] = try? await client.get("/api/project-services") {
            services = rows
            // A transition ends at the state of ITS instance per `ServiceTransitionRule`: at the target, unknown (the copy is gone), for a
            // plain start when the command did not keep running, and at the latest after the deadline. `now`: when the state arrived; the
            // linger time counts from the first dead one (`deadSince`); a transition that continues keeps it.
            let now = Date()
            var ended: [String] = []
            for (key, u) in transitions {
                let row = rows.first(where: { $0.id == u.service })
                let status = row.map { ServicesRules.serviceInInstance($0, identifier: u.instance, isMain: u.instance == nil) }
                var further = u
                guard let end = further.step(status, now: now, queried: queried) else {
                    if further != u { transitions[key] = further }
                    continue
                }
                transitions[key] = nil
                if end == .ended, let row { ended.append(row.name) }
            }
            if !ended.isEmpty { self.error = ServiceTransitionRule.endedNotice(ended) }
        } else if strict {
            self.error = L("Services could not be loaded.")
        }
    }

    /// The load asks `docker stats` per container, less often than the service status, and without folder size (`disk=0`).
    func refreshResources() async {
        if let response: ProjectResourcesResponse = try? await client.get("/api/project-resources", query: [URLQueryItem(name: "disk", value: "0")]) {
            resources = response.resources
        }
    }

    func startPolling() {
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                let fast = !(self?.transitions.isEmpty ?? true)
                try? await Task.sleep(nanoseconds: fast ? 900_000_000 : 6_000_000_000)
                guard !Task.isCancelled else { return }
                await self?.refreshServices()
                // The load about every 18 s (every third slow tick).
                if let self, !fast {
                    self.tick += 1
                    if self.tick % 3 == 0 { await self.refreshResources() }
                }
            }
        }
    }

    func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    /// Start in the CHOSEN instance of the project (main without a parameter, a copy with `?instance=`; the page offers an agent
    /// start only in main).
    func start(_ service: ProjectServiceRow, mode: String, instructions: String?) async -> String? {
        struct Body: Encodable { let mode: String; let instructions: String? }
        let view = view(service.projectId)
        guard view.controllable else { return nil }
        let key = Self.transitionKey(service.id, view.param)
        let u = Transition(kind: .starts, service: service.id, instance: view.param, mode: mode)
        transitions[key] = u
        do {
            let response: ChatIdResponse = try await client.post(
                "/api/projects/\(service.projectId)/services/\(service.id)/start",
                query: CodeInstance.query(view.param),
                body: Body(mode: mode, instructions: instructions)
            )
            responseArrived(key, u)
            await refreshServices()
            return response.chatId
        } catch {
            transitions[key] = nil
            if fallbackAfter(error, projectId: service.projectId) {
                await refreshServices()
            } else {
                self.error = L("Action failed: {msg}", ["msg": error.localizedDescription])
            }
            return nil
        }
    }

    /// Stop in the CHOSEN instance of the project.
    func stop(_ service: ProjectServiceRow) async {
        let view = view(service.projectId)
        guard view.controllable else { return }
        let key = Self.transitionKey(service.id, view.param)
        transitions[key] = Transition(kind: .stops, service: service.id, instance: view.param)
        do {
            let data = try await client.send("/api/projects/\(service.projectId)/services/\(service.id)/stop", query: CodeInstance.query(view.param))
            // A failed stop (`stopped: false`) names its reason (`error`) instead of staying silent.
            if let notice = ServiceStopResponse.notice(from: data, name: service.name) {
                transitions[key] = nil
                self.error = notice
            }
            await refreshServices()
        } catch {
            transitions[key] = nil
            if fallbackAfter(error, projectId: service.projectId) {
                await refreshServices()
            } else {
                self.error = L("Action failed: {msg}", ["msg": error.localizedDescription])
            }
        }
    }

    /// "Start all" in the CHOSEN instance (`group.services` is already in its state). A rejected start names its reason (`try?` used
    /// to swallow it; in a copy you would otherwise see nothing).
    func startStack(_ group: ProjectGroup) async {
        let candidates = group.startable
        guard !candidates.isEmpty, group.view.controllable else { return }
        let key = group.stackKey
        let param = group.view.param
        stackBusy[key] = .start
        defer { stackBusy[key] = nil }
        struct Body: Encodable { let mode: String }
        var notices: [String] = []
        for service in candidates {
            let u = Self.transitionKey(service.id, param)
            let run = Transition(kind: .starts, service: service.id, instance: param, mode: "simple")
            transitions[u] = run
            do {
                _ = try await client.send(
                    "/api/projects/\(service.projectId)/services/\(service.id)/start",
                    query: CodeInstance.query(param),
                    body: Body(mode: "simple")
                )
                responseArrived(u, run)
            } catch {
                transitions[u] = nil
                // The copy is gone; the rest of the stack would go to the same identifier.
                if fallbackAfter(error, projectId: group.id) { break }
                notices.append(L("{name}: {msg}", ["name": service.name, "msg": error.localizedDescription]))
            }
        }
        if !notices.isEmpty { self.error = notices.joined(separator: " · ") }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        await refreshServices()
    }

    func stopStack(_ group: ProjectGroup) async {
        // Also runs that the start guard holds (group alive, port closed), in the CHOSEN instance.
        let candidates = group.services.filter(\.stoppable)
        guard !candidates.isEmpty, group.view.controllable else { return }
        let key = group.stackKey
        let param = group.view.param
        stackBusy[key] = .stop
        defer { stackBusy[key] = nil }
        // Every failed stop names its reason; since the instance choice, a rejected call too.
        var notices: [String] = []
        for service in candidates {
            let u = Self.transitionKey(service.id, param)
            transitions[u] = Transition(kind: .stops, service: service.id, instance: param)
            do {
                let data = try await client.send("/api/projects/\(service.projectId)/services/\(service.id)/stop", query: CodeInstance.query(param))
                if let notice = ServiceStopResponse.notice(from: data, name: service.name) {
                    transitions[u] = nil
                    notices.append(notice)
                }
            } catch {
                transitions[u] = nil
                if fallbackAfter(error, projectId: group.id) { break }
                notices.append(L("{name}: {msg}", ["name": service.name, "msg": error.localizedDescription]))
            }
        }
        if !notices.isEmpty { self.error = notices.joined(separator: " · ") }
        await refreshServices()
    }

    /// The delete sheet (`CopyDeleteSheet`) has ordered the copy `identifier` to be cleared: the server accepted the DELETE (202).
    /// Only what THIS page makes of it; the request itself lives solely in `CopyDeleteModel.erase`. If it fails (409 INSTANCE_WORKING,
    /// …), the sheet stays open and says so; then nothing changes here, not even the choice.
    /// Synchronous except for the reload: between acceptance and the choice change there is no tick that would report the human's own action as a fallback.
    func clearAwayAssigned(_ identifier: String, set: String) {
        guard let target = ServicesRules.copyTarget(identifier: identifier) else { return }
        // If the human clears the CHOSEN copy themselves, the page switches to main: otherwise it would report the consequence of their own
        // action as a fallback ("Services · Main · k1 gone") while the row still said "being cleared". A fallback naming this copy falls
        // with it. Only after the sheet's acceptance (earlier it happened before the DELETE; a rejected clearing then took the choice away).
        if remembered(target.project) == identifier { remember(target.project, nil) }
        if let h = fallback[target.project], Self.hintName(h) == AppsStack.copyName(identifier) { fallback[target.project] = nil }
        clearAwayAccepted.insert(identifier)
        error = ""
        info = set
        Task {
            await refreshServices()
            await refreshResources()
        }
    }

    func saveCommand(_ service: ProjectServiceRow, command: String) async {
        struct Body: Encodable { let startCommand: String }
        guard command != service.startCommand else { return }
        _ = try? await client.send("/api/project-services/\(service.id)", method: .patch, body: Body(startCommand: command))
        await refreshServices()
    }
}

/// A project from `GET /api/projects`; `instance` only for a project with an instance row (projectbox/names.js
/// projectInstanceField), with its copies in creation order.
struct AppsProject: Codable, Identifiable, Sendable {
    let id: String
    var name: String
    var workspaceId: String?
    var instance: Instance?

    struct Instance: Codable, Sendable {
        var identifier: String
        var state: String
        /// Is the project converted (`converted_at`)? Without that there is no instance choice (`CodeInstance.options`); missing: nil.
        var converted: Bool?
        var name: String
        var copies: [Copy]

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            identifier = c.str(.identifier)
            state = c.str(.state)
            converted = c.boolOpt(.converted)
            name = c.str(.name)
            copies = c.list(.copies, Copy.self)
        }
    }

    struct Copy: Codable, Sendable {
        var identifier: String
        var name: String
        var chatId: String?
        var state: String

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            identifier = c.str(.identifier)
            name = c.str(.name)
            chatId = c.strOpt(.chatId)
            state = c.str(.state)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Project")
        workspaceId = c.strOpt(.workspaceId)
        instance = (try? c.decodeIfPresent(Instance.self, forKey: .instance)) ?? nil
    }
}

/// A stack of a project: the main (the project container with its compose stack) or a copy. The same calculation as
/// `stacksOf` on the web (web/src/app/apps/page.tsx).
struct AppsStack: Identifiable, Sendable {
    var id: String { identifier ?? "local" }
    let identifier: String? // nil: a project without its own container
    let name: String
    let main: Bool
    let state: String?
    let running: Bool? // does the container run; nil: no measurement
    let cpu: Double?
    let memBytes: Double?
    let services: Int
    let dns: String
    let chatTitle: String

    static func copyName(_ identifier: String) -> String {
        if let r = identifier.range(of: "/copy-", options: .backwards) { return String(identifier[r.upperBound...]) }
        return String(identifier.split(separator: "/").last ?? "")
    }

    static func from(project p: AppsProject, last r: ProjectResourceRow?, services: [ProjectServiceRow]) -> [AppsStack] {
        let instances = r?.instances ?? []
        let main = instances.first { $0.identifier == p.instance?.identifier }
        let mainRunning: Bool? = main.map { ($0.containers ?? 0) > 0 } ?? r.map { $0.containers > 0 }
        var out = [AppsStack(
            identifier: p.instance?.identifier,
            name: "main",
            main: true,
            state: p.instance?.state,
            running: p.instance != nil ? mainRunning : (mainRunning == true ? true : nil),
            cpu: main?.cpu ?? r?.cpu,
            memBytes: main?.memBytes ?? r?.memBytes,
            services: services.filter(\.running).count,
            dns: p.instance?.name ?? "",
            chatTitle: ""
        )]
        var copies = p.instance?.copies.map { (identifier: $0.identifier, state: $0.state, dns: $0.name) } ?? []
        // A copy that only the resources know, only WITH a state: an empty one means its instance row was already gone when the
        // measurement enriched it, otherwise a just removed copy would show as "stopped" with a clear-away cross.
        for i in instances where i.name != "main" && !i.name.isEmpty && !i.state.isEmpty && !copies.contains(where: { $0.identifier == i.identifier }) {
            copies.append((identifier: i.identifier, state: i.state, dns: i.dnsName))
        }
        for k in copies {
            let l = instances.first { $0.identifier == k.identifier }
            out.append(AppsStack(
                identifier: k.identifier,
                name: copyName(k.identifier),
                main: false,
                state: !k.state.isEmpty ? k.state : (l?.state.isEmpty == false ? l?.state : nil),
                running: l.map { ($0.containers ?? 0) > 0 },
                cpu: l?.cpu,
                memBytes: l?.memBytes,
                services: services.filter { ServicesRules.serviceInInstance($0, identifier: k.identifier, isMain: false).running == true }.count,
                dns: k.dns.isEmpty ? (l?.dnsName ?? "") : k.dns,
                chatTitle: l?.chatTitle ?? ""
            ))
        }
        return out
    }

    enum Tone { case ok, work, removing, error, off }

    /// Word and color of an operation on the instance (`state` from /api/projects); `nil` if none runs. Also the suffix after
    /// "Services · k1" while the chosen copy is only transiently not ready.
    static func operation(_ state: String?) -> (word: String, tone: Tone)? {
        switch state {
        case "create": return (L("being created"), .work)
        case "start": return (L("starting"), .work)
        case "recreate": return (L("being recreated"), .work)
        case "relocation": return (L("migrating"), .work)
        case "clearAway": return (L("being removed"), .removing)
        case "error": return (L("Error"), .error)
        default: return nil
        }
    }

    /// Word and color: first the operation on the instance, then whether its container runs.
    var status: (word: String, tone: Tone) {
        if let operation = Self.operation(state) { return operation }
        if running == true || (identifier == nil && services > 0) { return (L("running"), .ok) }
        if running == false || identifier == nil { return (L("stopped"), .off) }
        return (L("unknown"), .off)
    }

    var title: String { main ? (identifier == nil ? L("Local") : L("Main")) : name }

    /// "2.1 % · 812 MB": only with a measurement of a running container.
    var lastText: String? {
        guard running == true, let cpu, let memBytes else { return nil }
        return "\(String(format: "%.1f", cpu)) % · \(formatBytes(memBytes))"
    }
}

/// The instance the apps page shows and controls for a project: the choice of the code tab (`CodeInstance.select`) and what only
/// this page needs.
struct AppsInstanceView {
    let choice: CodeInstance.Choice
    /// A held fallback (`AppsModel.fallback`).
    let fallback: CodeInstance.Hint?
    /// The state of the chosen copy in /api/projects; `nil` for main.
    let copyState: String?

    /// `instance=<identifier>`: only a copy; main carries no parameter.
    var param: String? { choice.param }
    var isMain: Bool { choice.param == nil }
    /// A choice exists only with a ready copy (`CodeInstance.options`); otherwise everything stays as it was.
    var withChoice: Bool { !choice.options.isEmpty }

    /// Is the stack row of this identifier selectable or selected? Only with a choice: a copy being built, cleared or with an error
    /// shows with its state word; you cannot choose it (the server does not know its services yet).
    func selectable(_ identifier: String?) -> Bool { withChoice && choice.options.contains { $0.identifier == identifier } }
    func selected(_ identifier: String?) -> Bool { selectable(identifier) && choice.identifier == identifier }

    /// Does a state count, and are there buttons? Main always; a copy only `ready`: after every restart of B it stands briefly on
    /// `start` (the choice stays, `transient`), and a frozen one (clearing, fetching) would leave start and stop hanging.
    /// While the project list loads and a copy is remembered (`waiting`), nothing is known: no brief main under a false name.
    var controllable: Bool { !choice.waiting && (isMain || copyState == "ready") }

    func status(_ service: ProjectServiceRow) -> ServicesRules.ServiceInInstance {
        guard controllable else { return .unknown }
        return ServicesRules.serviceInInstance(service, identifier: param, isMain: isMain)
    }

    /// The name of the shown copy (also the remembered one the page is waiting for); `nil` is main.
    var copyName: String? { choice.copy ?? (choice.waiting ? CodeInstance.copyNameOf(choice.remember) : nil) }

    /// The short suffix after "Services · …": why the page no longer shows the chosen copy or why it stands still.
    var addition: String? {
        if choice.waiting { return L("loading") }
        switch fallback ?? choice.hint {
        case .gone(let name)?: return L("{name} gone", ["name": name])
        // Failed or being cleared, the copy is still there (its row stands above): "not ready" as on the web, not "gone".
        case .notReady(let name, _)?: return L("{name} not ready", ["name": name])
        case .transient(_, let state)?: return AppsStack.operation(state)?.word ?? state
        case .unchecked(let name)?: return L("{name} unchecked", ["name": name])
        case .held?, nil: return nil
        }
    }

    /// "Services · k1 · starting" / "Services · Main · k1 gone": from two instances on and at every fallback as long as it is not outdated
    /// (`AppsModel.fallbacksBringAlong`); otherwise nothing.
    var heading: String? {
        guard withChoice || addition != nil else { return nil }
        return ([L("Services · {name}", ["name": copyName ?? L("Main")])] + [addition].compactMap { $0 }).joined(separator: " · ")
    }
}

struct AppsPage: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: SessionStore
    @State private var model: AppsModel?

    var body: some View {
        Group {
            if let model {
                AppsPageContent(model: model)
            } else {
                CbLoading(label: L("Loading…"))
            }
        }
        .task {
            if model == nil, let client = session.client {
                let created = AppsModel(client: client)
                model = created
                await created.load()
                created.startPolling()
            }
        }
        .onDisappear { model?.stopPolling() }
    }
}

private struct AppsPageContent: View {
    @ObservedObject var model: AppsModel
    @EnvironmentObject private var state: AppState
    @State private var agentDialogFor: ProjectServiceRow?
    @State private var commandFor: ProjectServiceRow?
    /// The copy whose delete sheet is currently open (`CopyDeleteSheet`); `nil` without a sheet.
    @State private var toClearAway: ClearAway?

    private struct ClearAway: Identifiable {
        let identifier: String
        var id: String { identifier }
    }

    var body: some View {
        PaneScaffold(
            title: L("Projects & Stacks"),
            subtitle: metrics
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    InlineError(message: model.error)
                    if !model.info.isEmpty {
                        Text(model.info)
                            .font(.caption)
                            .foregroundStyle(.green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    projectsSection
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
            .cbRefreshable {
                await model.load()
            }
        }
        .sheet(item: $agentDialogFor) { service in
            AgentStartSheet(serviceName: service.name, initial: service.agentInstructions) { instructions in
                // A coding chat in the project of the service (an app agent in the drawer before): opens in Coding.
                if let chatId = await model.start(service, mode: "agent", instructions: instructions) {
                    await state.openCodingChat(chatId, workspaceId: service.workspaceId ?? "", projectId: service.projectId)
                }
            }
            .cbSheet(.whole)
        }
        .sheet(item: $commandFor) { service in
            StartCommandSheet(serviceName: service.name, initial: service.startCommand) { command in
                await model.saveCommand(service, command: command)
            }
            .cbSheet(.whole)
        }
        // Clearing opens the SAME sheet as "Delete copy" in the "Instances" tab and "Clear away" in the services pill: what stays and
        // what goes (`ServicesRules.clearAwayHint`), per repo what lands in main as copy/<name>/…, the copy's chats and the lock with
        // list (409 INSTANCE_WORKING). Two places for the same action: delete one.
        .sheet(item: $toClearAway) { target in
            CopyDeleteSheet(client: model.client, identifier: target.identifier) { set in
                model.clearAwayAssigned(target.identifier, set: set)
            }
            .cbSheet(.half)
        }
    }

    /// The key figures as a half sentence under the title (instead of the four tiles).
    private var metrics: String {
        let groups = model.groups
        var parts = [groups.count == 1 ? L("1 project") : L("{n} projects", ["n": groups.count])]
        if model.projects != nil {
            let stacks = groups.flatMap(\.stacks)
            let running = stacks.filter { $0.status.tone == .ok }.count
            parts.append(running == 1 ? L("1 stack running") : L("{n} stacks running", ["n": running]))
            let copies = stacks.filter { !$0.main }.count
            if copies > 0 { parts.append(copies == 1 ? L("1 copy") : L("{n} copies", ["n": copies])) }
        }
        // Counted per project in the chosen instance: the same as the cards show, and the same rule as on the web. A service with an
        // unknown state (copy starting, list loading) is missing from counter AND total; none known means no number (empty is not unknown).
        let known = groups.flatMap { g in g.services.filter { !g.unknown.contains($0.id) } }
        if !known.isEmpty {
            parts.append(L("{running} of {total} services running", ["running": known.filter(\.running).count, "total": known.count]))
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var projectsSection: some View {
        if model.loading && model.groups.isEmpty {
            ListLoadingSkeleton(rows: 3)
        }
        if model.groups.isEmpty && !model.loading {
            EmptyPaneState(
                title: L("No projects yet."),
                message: L("Open a project and start the service scan."),
                systemImage: "server.rack"
            )
        }
        ForEach(workspaceGroups) { group in
            SectionLabel(text: group.name)
                .padding(.top, 4)
            ForEach(group.projects) { group in
                projectCard(group)
            }
        }
    }

    private struct WorkspaceGroup: Identifiable {
        let id: String
        let name: String
        let projects: [AppsModel.ProjectGroup]
    }

    /// One section per workspace, in the order of the workspace list; projects without a (known) workspace last.
    private var workspaceGroups: [WorkspaceGroup] {
        let visible = visibleGroups
        var out: [WorkspaceGroup] = []
        for w in model.workspaces {
            let p = visible.filter { $0.workspaceId == w.id }
            if !p.isEmpty { out.append(WorkspaceGroup(id: w.id, name: w.name, projects: p)) }
        }
        let rest = visible.filter { g in !model.workspaces.contains { $0.id == g.workspaceId } }
        if !rest.isEmpty { out.append(WorkspaceGroup(id: "", name: L("No workspace"), projects: rest)) }
        return out
    }

    private var visibleGroups: [AppsModel.ProjectGroup] {
        guard let selected = state.appsSelectedProject else { return model.groups }
        return model.groups.filter { $0.id == selected }
    }

    private func projectCard(_ group: AppsModel.ProjectGroup) -> some View {
        PaneCard(padding: 12) {
            HStack(spacing: 8) {
                Text(group.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                // Counted in the CHOSEN instance; if no state is known there (copy starting, list loading), "?" shows instead of a 0.
                let running = group.services.filter(\.running).count
                if !group.services.isEmpty {
                    Text(verbatim: group.view.controllable ? "\(running)/\(group.services.count)" : "?/\(group.services.count)")
                        .cbFont(11, weight: .bold)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            running > 0 ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12),
                            in: Capsule()
                        )
                        .foregroundStyle(running > 0 ? Color.accentColor : Color.secondary)
                }
            }

            let stacks = group.stacks.filter { $0.identifier != nil || $0.status.tone == .ok }
            if !stacks.isEmpty {
                // The rows carry 6 pt of inner margin for the selection mark; the negative margin keeps the text flush with the card.
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(stacks) { stack in
                        stackRow(stack, in: group)
                    }
                }
                .padding(.horizontal, -6)
            }

            // "Start/stop all" applies to the CHOSEN instance (the group's services are already in its state) and NAMES it as soon as there is
            // a choice ("Stop all · k1"): under two stack rows the pair would otherwise read as "stop both". Another instance is controlled by
            // choosing its row above; without a choice it reads as before.
            let startable = group.startable.count
            let runningCount = group.services.filter(\.stoppable).count
            let stackKind = model.stackBusy[group.stackKey]
            let busy = stackKind != nil
            let instanceName: String? = group.view.withChoice ? (group.view.copyName ?? L("Main")) : nil
            if startable > 0 || runningCount > 0 {
                HStack(spacing: 6) {
                    if startable > 0 {
                        PillButton(
                            title: [stackKind == .start ? L("starting…") : L("Start all"), instanceName].compactMap { $0 }.joined(separator: " · "),
                            systemImage: "play.fill",
                            prominent: true,
                            disabled: busy
                        ) {
                            Task { await model.startStack(group) }
                        }
                        .accessibilityIdentifier("apps-start-stack-\(group.id)")
                    }
                    if runningCount > 0 {
                        PillButton(title: [stackKind == .stop ? L("stopping…") : L("Stop all"), instanceName].compactMap { $0 }.joined(separator: " · "), destructive: true, disabled: busy) {
                            Task { await model.stopStack(group) }
                        }
                    }
                    Spacer()
                }
            }

            if !group.services.isEmpty {
                Divider()
                if let heading = group.view.heading {
                    Text(heading)
                        .cbFont(11.5, weight: .semibold)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                        .padding(.top, 2)
                        .accessibilityIdentifier("apps-services-instance-\(group.id)")
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(sorted(group.services).enumerated()), id: \.element.id) { index, service in
                        if index > 0 { Divider().padding(.leading, 14) }
                        serviceRow(service, in: group)
                    }
                }
            }
        }
        .accessibilityIdentifier("apps-project-\(group.id)")
    }

    private func sorted(_ services: [ProjectServiceRow]) -> [ProjectServiceRow] {
        services.sorted { a, b in
            switch (a.port, b.port) {
            case let (x?, y?): return x < y
            case (nil, nil): return a.name.localizedCompare(b.name) == .orderedAscending
            case (nil, _): return false
            case (_, nil): return true
            }
        }
    }

    private func color(_ tone: AppsStack.Tone) -> Color {
        switch tone {
        case .ok: return .green
        case .work: return .accentColor
        case .removing, .error: return .red
        case .off: return Color.secondary.opacity(0.35)
        }
    }

    /// How a stack row takes part in the choice.
    private enum StackChoice { case no, selectable, selected }

    /// A stack row. From two instances on it is the CHOICE: a tap selects the instance. The chosen one carries THREE marks like a
    /// drawer row, and more: `CbColor.marked` as background, the title `.semibold` (the other selectable ones `.regular`) and a
    /// checkmark on the right; the background alone had ≈ 1.1 : 1 against the card in dark mode. `marked` stays the level (not
    /// `selection`): on `selection` `textMuted` does not reach 4.5 : 1 in dark mode, and the row carries muted text. Selectable rows are
    /// at least 44 pt high (HIG). The clear-away cross sits NEXT TO the choice button, never inside (no button in a button).
    private func stackRow(_ stack: AppsStack, in group: AppsModel.ProjectGroup) -> some View {
        let view = group.view
        let selected = view.selected(stack.identifier)
        return HStack(spacing: 4) {
            if view.selectable(stack.identifier), let identifier = stack.identifier {
                Button {
                    model.select(group.id, identifier)
                } label: {
                    stackContent(stack, choice: selected ? .selected : .selectable)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityHint(L("Shows and controls the services of this instance"))
                .accessibilityIdentifier("apps-stack-select-\(stack.id)")
            } else {
                stackContent(stack, choice: .no)
            }
            if !stack.main, let state = stack.state, !state.isEmpty, state != "clearAway",
               !(state == "ready" && stack.identifier.map { model.clearAwayAccepted.contains($0) } == true) {
                Button {
                    if let identifier = stack.identifier { toClearAway = ClearAway(identifier: identifier) }
                } label: {
                    Image(systemName: "xmark.circle")
                        .font(.symbol(14))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: view.withChoice ? 44 : 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Remove##clear"))
                .accessibilityIdentifier("apps-copy-clear-away-\(stack.id)")
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .cbSelection(selected, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("apps-stack-\(stack.id)")
    }

    private func stackContent(_ stack: AppsStack, choice: StackChoice) -> some View {
        let status = stack.status
        return HStack(spacing: 7) {
            Circle().fill(color(status.tone)).frame(width: 7, height: 7)
            Text(stack.title)
                .cbFont(12.5, weight: choice == .selectable ? .regular : .semibold)
                .lineLimit(1)
            if !stack.main && !stack.chatTitle.isEmpty {
                Text(stack.chatTitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(status.tone == .ok ? (stack.lastText ?? status.word) : status.word)
                .font(.caption.monospacedDigit())
                .foregroundStyle(status.tone == .error ? Color.red : Color.secondary)
                .lineLimit(1)
            if choice != .no {
                // The checkmark of the choice; invisible with the same width in the other selectable rows so the column on the right lines up.
                Image(systemName: "checkmark")
                    .font(.symbol(12, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 16)
                    .opacity(choice == .selected ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
    }

    /// Dot and word of a service in the shown instance. Unknown is a HOLLOW dot, never the grey of "stopped".
    private func point(_ transition: AppsModel.Transition.Kind?, known: Bool, _ service: ProjectServiceRow) -> (color: Color, word: String, hollow: Bool) {
        switch transition {
        case .starts?: return (Color.accentColor, L("Starting"), false)
        case .stops?: return (Color.red, L("Stopping"), false)
        case nil: break
        }
        if !known { return (Color.secondary.opacity(0.6), L("unknown"), true) }
        if service.running { return (Color.green, L("running"), false) }
        // The start guard holds a run whose port shows nothing: it runs but is not reachable.
        if service.holdsStart { return (Color.orange, L("running, not reachable"), false) }
        return (Color.secondary.opacity(0.35), L("stopped"), false)
    }

    /// A service row in the chosen instance (`service` is already in its state): main with the Simple/Agent menu, a copy with a plain
    /// "Start" (there is no agent start there, 409 COPY_AGENT), an unknown state without a button.
    @ViewBuilder
    private func serviceRow(_ service: ProjectServiceRow, in group: AppsModel.ProjectGroup) -> some View {
        let transition = model.transition(service, in: group.view)
        let known = !group.unknown.contains(service.id)
        let p = point(transition, known: known, service)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                Group {
                    if p.hollow {
                        Circle().strokeBorder(p.color, lineWidth: 1.2)
                    } else {
                        Circle().fill(p.color)
                    }
                }
                .frame(width: 7, height: 7)
                .accessibilityLabel(p.word)
                Text(service.name).cbFont(13, weight: .medium).lineLimit(1)
                if let port = service.port {
                    Text(verbatim: ":\(port)")
                        .cbFont(11.5, weight: .semibold, design: .monospaced)
                        .foregroundStyle(.secondary)
                }
                if model.inConflict(service) {
                    Text(L("conflict"))
                        .cbFont(9, weight: .bold)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Color.orange.opacity(0.16), in: Capsule())
                        .foregroundStyle(.orange)
                }
                Spacer(minLength: 4)
                // While "Starting" shows, the stop sits beside it as soon as there is something to stop: a run held by the start guard would
                // otherwise wait until the deadline without a way out.
                if let transition, !(transition == .starts && known && service.stoppable) {
                    Text(transition == .starts ? L("Starting") : L("Stopping"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else if !known {
                    Text(L("unknown"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else if service.stoppable {
                    if transition == .starts {
                        Text(L("Starting"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Button(L("Stop")) { Task { await model.stop(service) } }
                        .cbFont(12, weight: .medium)
                        .foregroundStyle(.red)
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("apps-stop-\(service.id)")
                } else if !group.view.isMain {
                    Button {
                        Task { _ = await model.start(service, mode: "simple", instructions: nil) }
                    } label: {
                        startLabel
                    }
                    .buttonStyle(.plain)
                    .disabled(service.startCommand.isEmpty)
                    .opacity(service.startCommand.isEmpty ? 0.45 : 1)
                    .accessibilityHint(service.startCommand.isEmpty ? L("No start command set") : "")
                    .accessibilityIdentifier("apps-start-\(service.id)")
                } else {
                    Menu {
                        Button(L("Simple start")) {
                            Task { _ = await model.start(service, mode: "simple", instructions: nil) }
                        }
                        .disabled(service.startCommand.isEmpty)
                        Button(L("Start with agent")) { agentDialogFor = service }
                    } label: {
                        startLabel
                    }
                    .accessibilityIdentifier("apps-start-\(service.id)")
                }
            }
            // The start command in ONE line: a tap edits it (the description stays in the service, not in the list).
            Button {
                commandFor = service
            } label: {
                Text(service.startCommand.isEmpty ? "+ " + L("Set start command") : service.startCommand)
                    .cbFont(11, design: service.startCommand.isEmpty ? .default : .monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            .padding(.leading, 14)
            .accessibilityLabel(L("Edit start command"))
        }
        .padding(.vertical, 7)
    }

    /// The "Start" capsule: in main the menu's label, in a copy the button itself.
    private var startLabel: some View {
        Text(L("Start"))
            .cbFont(12, weight: .medium)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(.white)
            .background(Capsule().fill(Color.accentColor))
    }
}

// ── Left drawer: projects ──
struct AppsSidebar: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: SessionStore
    @State private var projects: [(id: String, name: String)] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("Projects"))
                Button {
                    state.appsSelectedProject = nil
                    state.closeDrawersAfterChoice()
                } label: {
                    HStack {
                        Text(L("All projects"))
                            .cbFont(13.5, weight: state.appsSelectedProject == nil ? .semibold : .regular)
                        Spacer()
                    }
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    // Chosen neutral like every drawer row (`LeftDrawerBody.row`).
                    .cbSelection(state.appsSelectedProject == nil, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("apps-sidebar-all")
                ForEach(projects, id: \.id) { project in
                    Button {
                        state.appsSelectedProject = project.id
                        state.closeDrawersAfterChoice()
                    } label: {
                        HStack {
                            Text(project.name)
                                .cbFont(13.5, weight: state.appsSelectedProject == project.id ? .semibold : .regular)
                                .lineLimit(1)
                            Spacer()
                        }
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .cbSelection(state.appsSelectedProject == project.id, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("apps-sidebar-project-\(project.id)")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .task { await load() }
    }

    /// All projects (`/api/projects`); if the route does not answer, those with services, like the page itself.
    private func load() async {
        guard let client = session.client else { return }
        if let all: [AppsProject] = try? await client.get("/api/projects") {
            projects = all.map { (id: $0.id, name: $0.name) }
                .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            return
        }
        let rows: [ProjectServiceRow] = (try? await client.get("/api/project-services")) ?? []
        var seen: [String: String] = [:]
        for row in rows { seen[row.projectId] = row.projectName }
        projects = seen.map { (id: $0.key, name: $0.value) }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }
}
