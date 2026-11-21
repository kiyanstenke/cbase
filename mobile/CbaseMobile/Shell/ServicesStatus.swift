import Foundation

// The header's services. ONE model, living a level above the drawer (`AppShell`), asks for the scope's live state, and
// the buttons in the `TopBar` show it on EVERY tab (`ServicesButton.swift`) — TWO buttons (ports · performance), each
// with a popover, fed from this ONE model.
//
// The file has two halves:
//   1. `MachineStatus` and `ServicesRules` — PURE calculation, the same as on the web
//      (`web/src/lib/services-status.ts`). The thresholds and the three stage inputs are the same there and here, and a
//      guard holds them against each other. That is why both types sit at top level, their closing brace in column 0,
//      without SwiftUI, without `L(…)`, without `APIClient`: a test rig can cut them out and run them with `xcrun swift`.
//      Touch points to the outside: `ProjectResourceRow` (`projectId`, `containers`, `cpu`, `memBytes`) and
//      `ProjectServiceRow` (`projectId`, `container`); `ProjectInstance` (only as a list element, `groupRows`) and
//      `ProjectResourceRow.instances` (`instanceGroups`). Beside them `CbaseRules` (cbase's share of the server per
//      bar) — equally pure, equally cuttable, bound in web/test/cbase-share-binding.test.mjs.
//   2. `ServicesStatusModel` — the query (every 20 s, immediately when the menu opens), the decoder and what the view
//      derives from it.

// ── 1. Pure calculation ───────────────────────────────────────────────────────────────────────

/// What the machine reports: gateway `GET /gw/host` (the same shape as `host` in
/// `/api/project-resources` — `server/backend/electron/server/host-resources.js`, copy in
/// `server/gateway/containers.js`; the app reads only the gateway version, see `ServicesStatusModel`).
/// The fields are called `available`/`free`: the machine reports the FREE part, but the OCCUPIED part is rated and
/// displayed. `swap` and `disk` can be `null` (no Linux, path not readable) — hence optional, a missing key is no error.
struct MachineStatus: Equatable, Sendable {
    struct Cpu: Equatable, Sendable {
        var count: Int
        var load1: Double
        var load5: Double
        var load15: Double
    }
    struct Storage: Equatable, Sendable {
        var totalBytes: Double
        var availableBytes: Double
    }
    /// Swap and disk: both report total and free; the disk also carries its path.
    struct Stock: Equatable, Sendable {
        var totalBytes: Double
        var freeBytes: Double
        var path: String? = nil
    }
    /// How much of it cbase occupies (only the gateway reports it): the sum over all user containers including the
    /// project containers inside. Every field can be missing (not measured) — `nil` is never 0.
    struct Cbase: Equatable, Sendable {
        var memBytes: Double?
        var cpuCores: Double?
        var swapBytes: Double?
        var diskBytes: Double?
    }
    var at: Double
    var cpu: Cpu
    var mem: Storage
    var swap: Stock?
    var disk: Stock?
    var cbase: Cbase? = nil
}

/// cbase's share of the server, so the user sees how much of the server's resources cbase claims (a bar could be colored
/// differently for cbase's part). The twin of `cbasePart` and `progressBarParts` in `web/src/lib/services-status.ts` — bound
/// in `web/test/cbase-share-binding.test.mjs`, which RUNS both sides on the same calculations (`xcrun swift`). A type of
/// its own beside `ServicesRules`, because it reads the swap: `ServicesRules` is the stage rule, and there the swap does not
/// count (statusBar.test.mjs holds that).
///  · the part is a share OF THE WHOLE: value / total (RAM, swap, disk in bytes; CPU: cbase's cores over the cores),
///    CLAMPED to the occupied part of the bar; the number beside it stays the measured one;
///  · no part (`nil`) without a cbase reading, without a denominator, without an occupied part or with a field `nil` — 0 is a part.
enum CbaseRules {
    enum Kind: String, CaseIterable, Sendable {
        case ram, load, swap, disk
    }

    struct Part: Equatable, Sendable {
        let share: Double
        let value: Double
    }

    static func part(_ host: MachineStatus?, _ kind: Kind) -> Part? {
        guard let host, let h = host.cbase else { return nil }
        let occupied: Double?
        let value: Double?
        let total: Double?
        switch kind {
        case .ram: (occupied, value, total) = (ServicesRules.ramShare(host), h.memBytes, host.mem.totalBytes)
        case .load: (occupied, value, total) = (ServicesRules.loadShare(host), h.cpuCores, Double(host.cpu.count))
        case .swap: (occupied, value, total) = (swapShare(host), h.swapBytes, host.swap?.totalBytes)
        case .disk: (occupied, value, total) = (ServicesRules.diskShare(host), h.diskBytes, host.disk?.totalBytes)
        }
        guard let occupied, let value, value.isFinite, value >= 0, let total, total.isFinite, total > 0 else { return nil }
        return Part(share: min(occupied, value / total), value: value)
    }

    /// Swap occupied — like `swapShare` on the web: for display only, it does not count toward the stage.
    static func swapShare(_ host: MachineStatus) -> Double? {
        guard let stock = host.swap, stock.totalBytes > 0, stock.totalBytes.isFinite, stock.freeBytes.isFinite else { return nil }
        return max(0, stock.totalBytes - stock.freeBytes) / stock.totalBytes
    }

    /// The geometry of a bar: `width` = the occupied part in % of the track (capped at 100), within it `cbase` = cbase's part
    /// in % OF THE OCCUPIED PART; `nil` without a cbase part (single-part).
    static func progressBar(share: Double, cbase: Double?) -> (width: Double, cbase: Double?) {
        let a = share.isFinite ? max(0, share) : 0
        let width = min(100, a * 100)
        guard let cbase, cbase.isFinite else { return (width, nil) }
        return (width, a > 0 ? min(100, max(0, cbase) / a * 100) : 0)
    }
}

/// The rules of the services status, the same semantics as on the web.
///
/// **Numbers = the services** (`sum`), **color = the machine** (`machineLevel`). The stage is the HIGHEST of three
/// shares — RAM occupied, load per core, disk occupied. Swap does not count: on a server with a page cache it is happily
/// half full without anything being tight, and an indicator that is always yellow says nothing. On a tie the input named
/// first wins (RAM before load before disk). No computable input ⇒ `nil`: neutral, no claim.
enum ServicesRules {
    /// Over 70 % yellow, over 90 % red — STRICTLY greater: exactly 0.7 is still `ok`, exactly 0.9 still `warn`.
    static let warn = 0.7
    static let danger = 0.9

    enum Stage: String, Sendable {
        case ok, warn, danger
    }

    /// Which input determined the stage — the reason the header and accessibility name.
    enum Kind: String, Sendable {
        case ram, load, disk
    }

    struct MachineVerdict: Equatable, Sendable {
        let stage: Stage
        let kind: Kind
        /// Share 0…1 (the load can be above: more work than cores).
        let share: Double
        /// Occupied and total in bytes — only for RAM and disk; the load has no bytes.
        let occupied: Double?
        let total: Double?
    }

    struct Sum: Equatable, Sendable {
        /// CPU in percent, rounded to one decimal.
        let cpu: Double
        let memBytes: Double
        /// The rows that were counted — the same set `cpu` and `memBytes` run over, like `projects` on the web
        /// (`servicesSum` in services-status.ts). The menu lists exactly these rows, so the sum above and the rows
        /// below cannot mean different sets.
        let projects: [ProjectResourceRow]
    }

    struct Measurement: Equatable, Sendable {
        let measured: Int
        let total: Int
    }

    /// Stage of a single share — also the color of every bar in the menu.
    static func stage(_ share: Double) -> Stage {
        if share > danger { return .danger }
        if share > warn { return .warn }
        return .ok
    }

    /// RAM occupied: (total − available) / total. Without a total no share.
    static func ramShare(_ host: MachineStatus) -> Double? {
        let total = host.mem.totalBytes
        guard total > 0, total.isFinite, host.mem.availableBytes.isFinite else { return nil }
        return max(0, total - host.mem.availableBytes) / total
    }

    /// Load per core: load of the last minute over the number of cores. Without cores no share.
    static func loadShare(_ host: MachineStatus) -> Double? {
        guard host.cpu.count > 0, host.cpu.load1.isFinite else { return nil }
        return max(0, host.cpu.load1) / Double(host.cpu.count)
    }

    /// Disk occupied: (total − free) / total. Without a disk or without a total no share.
    static func diskShare(_ host: MachineStatus) -> Double? {
        guard let disk = host.disk, disk.totalBytes > 0, disk.totalBytes.isFinite, disk.freeBytes.isFinite else { return nil }
        return max(0, disk.totalBytes - disk.freeBytes) / disk.totalBytes
    }

    /// The machine's stage: the highest of the three inputs (RAM, load, disk), see above.
    static func machineLevel(_ host: MachineStatus?) -> MachineVerdict? {
        guard let host else { return nil }
        let ramOccupied = max(0, host.mem.totalBytes - host.mem.availableBytes)
        let diskOccupied = host.disk.map { max(0, $0.totalBytes - $0.freeBytes) }
        let inlets: [(Kind, Double?, Double?, Double?)] = [
            (.ram, ramShare(host), ramOccupied, host.mem.totalBytes),
            (.load, loadShare(host), nil, nil),
            (.disk, diskShare(host), diskOccupied, host.disk?.totalBytes),
        ]
        var best: MachineVerdict?
        for (kind, share, occupied, total) in inlets {
            guard let share else { continue }
            if let soFar = best, share <= soFar.share { continue }
            best = MachineVerdict(stage: stage(share), kind: kind, share: share, occupied: occupied, total: total)
        }
        return best
    }

    /// Sum over the resource rows that COUNT (`containers > 0`). If there are none: `nil` —
    /// then the button shows no numbers, never "0 % · 0 B".
    static func sum(_ resources: [ProjectResourceRow]) -> Sum? {
        let counting = resources.filter { $0.containers > 0 }
        guard !counting.isEmpty else { return nil }
        let cpu = counting.reduce(0.0) { $0 + $1.cpu }
        let mem = counting.reduce(0.0) { $0 + $1.memBytes }
        return Sum(cpu: (cpu * 10).rounded() / 10, memBytes: mem, projects: counting)
    }

    /// "measured: x of n": `total` = the services passed in — the caller passes the scope's RUNNING ones, as on the web
    /// (`measured` in services-status.ts); a service is measured if it carries a container name (only whitespace counts
    /// as empty, like `trim()` there) AND its project has a counting row.
    static func measured(services: [ProjectServiceRow], resources: [ProjectResourceRow]) -> Measurement {
        let counted = Set(resources.filter { $0.containers > 0 }.map { $0.projectId })
        let measured = services.filter { service in
            service.container.contains { !$0.isWhitespace } && counted.contains(service.projectId)
        }.count
        return Measurement(measured: measured, total: services.count)
    }

    /// Does the line "measured: x of n services" show in the menu? — the counterpart of `measureRow` in
    /// services-status.ts, with the same three conditions: only once the scope's resources query has answered (`loaded`),
    /// only with running services, and only if NOT all are measured — then also as "0 of n". Without checking `loaded`,
    /// "measured: 0 of 3" would show between the services' answer and the resources' answer (in the backend
    /// `docker stats`, without `disk=0` plus a `du`) and after every failed query — a statement about a measurement
    /// nobody has made yet (empty is not unknown).
    static func measureRow(_ sample: Measurement, loaded: Bool) -> Measurement? {
        guard loaded, sample.total > 0, sample.measured < sample.total else { return nil }
        return sample
    }

    /// Does the "Resources" section show in the menu? — the counterpart of `resourcesSection` in services-status.ts:
    /// only with RUNNING services in the scope, and then as soon as there is a sum or a `measureRow`. Services and
    /// resources arrive as two queries; if the resources reported a freshly started container before the services listed
    /// it as running, the section would show with a sum under "No services running.". Without running services
    /// `measureRow` is `nil` anyway; it was only about the sum.
    static func resourcesSection(count: Int, sum: Sum?, measureRow: Measurement?) -> Bool {
        count > 0 && (sum != nil || measureRow != nil)
    }

    /// An instance GROUP shows only from TWO instances on. A project with only main shows nothing new. The server omits
    /// the field `instances` below that anyway; the rule applies here regardless, so that a server sending one instance
    /// does not make a group of one row.
    static func group(count: Int) -> Bool {
        count >= 2
    }

    /// The group's rows: the instances if it is a group — otherwise none (also with a missing field).
    static func groupRows(_ raw: [ProjectInstance]?) -> [ProjectInstance] {
        guard let raw, group(count: raw.count) else { return [] }
        return raw
    }

    /// The projects whose instances appear as a group — from ALL resource rows of the scope, in their order, like
    /// `instanceGroups` on the web. Deliberately NOT from `Sum.projects` and not under the resources section: that one
    /// shows only with running services IN MAIN (`running` is main's state), and a service running only in the copy
    /// would otherwise take the group, with its clear-away button, its place.
    static func instanceGroups(_ resources: [ProjectResourceRow]) -> [ProjectResourceRow] {
        resources.filter { !groupRows($0.instances).isEmpty }
    }

    /// Project and name of a COPY from the identifier "<project>/<instance>" (the server splits at the LAST slash). An
    /// instance is called `main` or `copy-<name>` (projectbox/creation.js `copyNameOf`), and the NAME is what the copy's route
    /// looks up (`stack_copies.name`, `DELETE …/stack-copies/<name>`) and what the resources' `name` field carries:
    /// `p1/copy-k1` becomes ("p1", "k1"). Passing the whole instance ("copy-k1") would end every clear-away on iOS in a
    /// 404. Main and anything without the form `copy-<name>` is not a copy: `nil` — there is nothing to clear away (like
    /// `clearable` on the web).
    static func copyTarget(identifier: String) -> (project: String, name: String)? {
        guard let separator = identifier.lastIndex(of: "/") else { return nil }
        let project = String(identifier[..<separator])
        let instance = String(identifier[identifier.index(after: separator)...])
        guard instance.hasPrefix("copy-") else { return nil }
        let name = String(instance.dropFirst("copy-".count))
        guard !project.isEmpty, !name.isEmpty, name != "main" else { return nil }
        return (project, name)
    }

    /// Does the button offer "Clear away" on a COPY? Not while it is already being cleared (state `clearAway`, from step
    /// 0 of stacks/clearAway.js) — if the button stayed, a second tap would get the same question and "request" again
    /// although the clearing is long running. In its place "being cleared away" shows. `error` (a failed clearing needs a
    /// new call), `ready` (also "queued") and an empty state (older server) stay clearable — empty is not "clearAway".
    /// Twin of `clearable` in web/src/lib/services-status.ts; whether it is a copy is told by `copyTarget`.
    static func offerClearAway(state: String) -> Bool {
        state != "clearAway"
    }

    /// What stays and what goes when clearing away — the message under "Clear away copy "k1"?" (the same wording as
    /// `clearAwayQuestion` on the web). Clearing fetches every commit and saves open work under `copy/<name>/…` into
    /// main; only the data in the cloned Docker volumes and the copy's ignored files are lost (the report names them).
    /// `name` is the copy's name.
    static func clearAwayHint(name: String) -> String {
        L("Commits and open changes are kept in the main instance under copy/{name}/…. Lost are the data in the copy's Docker volumes and its ignored files (e.g. .env, build output) — only the report lists them.", ["name": name])
    }

    /// A service's state in ONE instance — the instance choice of the Apps page; twin of `serviceInInstance` in
    /// web/src/lib/services-status.ts. `running == nil` means UNKNOWN, never "stopped" (empty is not unknown): a "Start" on
    /// suspicion would end in 409 SERVICE_RUNNING, a "stopped" would be a claim without a measurement.
    struct ServiceInInstance: Equatable, Sendable {
        let running: Bool?
        /// This instance's start guard holds a start back (group alive, port closed).
        let holds: Bool
        /// A run that can be stopped in this instance.
        var stoppable: Bool { running == true || holds }

        static let unknown = ServiceInInstance(running: nil, holds: false)
    }

    /// Main (and every project with only one instance): the row's fields, `running` and `holdsStart`. A copy: its entry in
    /// `instances` (GET /api/project-services, from two instances on `{identifier, running, holdsStart}`). If the field or
    /// the entry is missing (an older server, a copy that has only just become ready), the state is unknown.
    static func serviceInInstance(_ service: ProjectServiceRow, identifier: String?, isMain: Bool) -> ServiceInInstance {
        if isMain { return ServiceInInstance(running: service.running, holds: service.holdsStart) }
        guard let identifier, let entry = service.instances?.first(where: { $0.identifier == identifier }) else { return .unknown }
        return ServiceInInstance(running: entry.running, holds: !entry.running && entry.holdsStart)
    }
}

// ── Decoder ─────────────────────────────────────────────────────────────────────────────────
// Outside the pure calculation: it needs the tolerant helpers from `Models/DecodeHelpers.swift`.
// A missing field becomes 0 — and 0 means "not computable" in the rules, not "0 % occupied".

extension MachineStatus: Decodable {
    private enum Keys: String, CodingKey { case at, cpu, mem, swap, disk, cbase }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        at = c.dbl(.at)
        let cpuValue = (try? c.decodeIfPresent(Cpu.self, forKey: .cpu)) ?? nil
        cpu = cpuValue ?? Cpu(count: 0, load1: 0, load5: 0, load15: 0)
        let memValue = (try? c.decodeIfPresent(Storage.self, forKey: .mem)) ?? nil
        mem = memValue ?? Storage(totalBytes: 0, availableBytes: 0)
        swap = (try? c.decodeIfPresent(Stock.self, forKey: .swap)) ?? nil
        disk = (try? c.decodeIfPresent(Stock.self, forKey: .disk)) ?? nil
        // Optional: an older gateway and every machine without a gateway do not know the field — then single-part bars.
        cbase = (try? c.decodeIfPresent(Cbase.self, forKey: .cbase)) ?? nil
    }
}

extension MachineStatus.Cbase: Decodable {
    private enum Keys: String, CodingKey { case memBytes, cpuCores, swapBytes, diskBytes }

    /// Every field optional on its own (`null` means "not measured" — the first answer has no CPU, the disk comes later).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(memBytes: c.dblOpt(.memBytes), cpuCores: c.dblOpt(.cpuCores), swapBytes: c.dblOpt(.swapBytes), diskBytes: c.dblOpt(.diskBytes))
    }
}

extension MachineStatus.Cpu: Decodable {
    private enum Keys: String, CodingKey { case count, load1, load5, load15 }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(count: c.int(.count), load1: c.dbl(.load1), load5: c.dbl(.load5), load15: c.dbl(.load15))
    }
}

extension MachineStatus.Storage: Decodable {
    private enum Keys: String, CodingKey { case totalBytes, availableBytes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(totalBytes: c.dbl(.totalBytes), availableBytes: c.dbl(.availableBytes))
    }
}

extension MachineStatus.Stock: Decodable {
    private enum Keys: String, CodingKey { case totalBytes, freeBytes, path }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(totalBytes: c.dbl(.totalBytes), freeBytes: c.dbl(.freeBytes), path: c.strOpt(.path))
    }
}

// ── 2. The query ──────────────────────────────────────────────────────────────────────────

/// Live state of the current scope for the button in the header: running services, the containers' resources, the machine
/// and the agent browsers.
///
/// The scope is `state.activeWorkspaceId` + `state.enteredProject` — like the header itself, which shows
/// Workspace › Project on every tab. `AppShell` restarts the model as soon as `state.scopeKey` changes, and stops it when
/// the shell disappears.
///
/// **Empty is not unknown:** until the scope's services have loaded once, `loaded` is `false` and the button renders
/// NOTHING — a "0" before the first answer would be a claim. The same holds one level deeper for the resources
/// (`resourcesLoaded`): until they have answered, the menu says nothing about a measurement. A query that fails later
/// keeps the last values (like `UsageStore`).
@MainActor
final class ServicesStatusModel: ObservableObject {
    /// All services of the scope — running and stopped; `running` filters.
    @Published private(set) var services: [ProjectServiceRow] = []
    @Published private(set) var resources: [ProjectResourceRow] = []
    /// `true` as soon as `/api/project-resources` has answered once for THIS scope — set ONLY in the query's success
    /// branch, reset when `start` changes the scope. The counterpart of the web button's `resources !== null`. Without this
    /// flag the empty `resources` before the first answer (and after every failed one) could not be told apart from
    /// "answered, nothing measured", and the menu said "measured: 0 of 3".
    @Published private(set) var resourcesLoaded = false
    /// The host behind the gateway (`/gw/host`) — and ONLY that. The app always talks to a gateway (see `refresh`), and in
    /// gateway operation the web button also discards the resources answer's `host` field: in the user container that is
    /// only its own quota (Sysbox virtualizes `/proc/meminfo`). If `/gw/host` never answers, the value stays `nil` — no
    /// machine section, the dot neutral, no claim.
    @Published private(set) var calculator: MachineStatus?
    @Published private(set) var agentBrowsers: [AgentBrowserInfo] = []
    @Published private(set) var loaded = false

    /// 20 s. `docker stats` in the backend is not exactly cheap, and the button should show a state, not real time.
    ///
    /// Only in the DEBUG build and only for the UI tests: the launch argument `-cbase.mobile.services.tick <seconds>`
    /// replaces the 20 s. The menu test (`ShellUITests.testServicesButtonAsksFolderSizeOnlyAtOpenMenu`) sets one hour —
    /// then a request after opening comes ONLY from the opening and none from the tick, and it can count "exactly one"
    /// instead of guessing against the clock.
    static let tickNanoseconds: UInt64 = {
        #if DEBUG
        let seconds = UserDefaults.standard.double(forKey: "cbase.mobile.services.tick")
        if seconds > 0 { return UInt64(seconds * 1_000_000_000) }
        #endif
        return 20_000_000_000
    }()

    private let client: APIClient
    private var task: Task<Void, Never>?
    /// Counts every start and every stop. An answer that arrives after a scope change belongs
    /// to the old scope — it is recognized by the counter and discarded.
    private var run = 0
    private var workspaceId: String?
    private var projectId: String?
    /// Is the performance popover open? Reported by `ServicesButton` (`menu(open:)`) — only by that one, because only
    /// there the folder size is shown; the ports popover reports nothing. Closed, the model asks the resources with
    /// `disk=0` — see `refresh`.
    private(set) var menuOpen = false

    init(client: APIClient) {
        self.client = client
    }

    deinit { task?.cancel() }

    var running: [ProjectServiceRow] { services.filter(\.running) }
    var sum: ServicesRules.Sum? { ServicesRules.sum(resources) }
    var measurement: ServicesRules.Measurement { ServicesRules.measured(services: running, resources: resources) }
    /// The line "measured: x of n" — `nil` as long as the resources have not answered, no
    /// services run or all are measured (`ServicesRules.measureRow`, like `measureRow` on the web).
    var measureRow: ServicesRules.Measurement? { ServicesRules.measureRow(measurement, loaded: resourcesLoaded) }
    var verdict: ServicesRules.MachineVerdict? { ServicesRules.machineLevel(calculator) }

    /// (Re)start for a scope. The same scope keeps its values (re-entry of the shell, no flicker);
    /// another one starts empty and unloaded. Without a workspace nothing is asked.
    func start(workspaceId: String?, projectId: String?) {
        let sameScope = workspaceId == self.workspaceId && projectId == self.projectId
        task?.cancel()
        task = nil
        run += 1
        self.workspaceId = workspaceId
        self.projectId = projectId
        if !sameScope {
            services = []
            resources = []
            resourcesLoaded = false
            agentBrowsers = []
            loaded = false
        }
        guard workspaceId != nil else {
            loaded = false
            resourcesLoaded = false
            return
        }
        tick()
    }

    func stop() {
        task?.cancel()
        task = nil
        run += 1
    }

    /// The performance popover opens or closes. On OPENING the model asks again immediately — this time with folder size,
    /// because "Project files" appears only there (the web's performance menu also asks immediately on opening). The query
    /// that may be under way with `disk=0` thereby belongs to an old run and is discarded — otherwise its answer would
    /// overwrite the folder sizes with "–" again. On closing `disk=0` applies again from the next tick.
    func menu(open: Bool) {
        guard open != menuOpen else { return }
        menuOpen = open
        if open, task != nil { tick() }
    }

    // The DELETE for clearing away a copy lives ONCE in `CopyDeleteModel.erase` (Code/CopyDelete.swift); the sheet is
    // opened by the button and the tab.

    /// Refresh out of turn (after clearing away a copy) — for the current scope.
    func refresh() async {
        await refresh(run: run)
    }

    /// Back from the background (`AppShell`, `scenePhase == .active`): restart the tick if it is running. That also aborts a
    /// query that has hung on a dead socket since switching away (otherwise until the client's deadline, 45 s), and asks
    /// immediately — without waiting behind the chat list, workspaces and usage (`/api/usage`).
    func newStart() {
        if task != nil { tick() }
    }

    /// The loop: ask immediately, then every 20 s. A new tick ends the old one and makes
    /// its answers worthless via the counter.
    private func tick() {
        task?.cancel()
        run += 1
        let ownRun = run
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh(run: ownRun)
                try? await Task.sleep(nanoseconds: ServicesStatusModel.tickNanoseconds)
            }
        }
    }

    /// One round. Services, machine and browser run ALONGSIDE the resources query (`async let`), and each writes as soon as it
    /// arrives: asked one after another, the server block with the symbol's color (`/gw/host`, ≈ 0.2 s) would wait behind
    /// the resources — which cost the backend ≈ 22 s (one `docker stats` per project container, sequentially) — and every
    /// opening of the popover would start the chain anew. Cancelling the tick cancels the children too. Guard
    /// `web/test/statusBar.test.mjs` (f6).
    private func refresh(run ownRun: Int) async {
        guard let workspaceId else { return }
        let projectId = self.projectId

        async let serviceStatus: Void = fetchServices(run: ownRun, workspaceId: workspaceId, projectId: projectId)
        async let machineStatus: Void = fetchMachine(run: ownRun)
        async let browserState: Void = fetchBrowser(run: ownRun, workspaceId: workspaceId)

        var query = [URLQueryItem(name: "workspaceId", value: workspaceId)]
        if let projectId { query.append(URLQueryItem(name: "projectId", value: projectId)) }
        // The folder size per project ("Project files") costs the backend a `du` over every project folder of the scope
        // (services.js `dirSize`, cached 60 s) and shows ONLY in the menu. Since the button sits on every tab, the `du`
        // would otherwise run every minute while the app is open. So as on the web button: closed `disk=0` (if the parameter
        // is missing, the backend computes it), open without.
        if !menuOpen { query.append(URLQueryItem(name: "disk", value: "0")) }
        if let response: ProjectResourcesResponse = try? await client.get("/api/project-resources", query: query) {
            guard ownRun == run else { return }
            resources = response.resources
            resourcesLoaded = true
        }
        await serviceStatus
        await machineStatus
        await browserState
    }

    private func fetchServices(run ownRun: Int, workspaceId: String, projectId: String?) async {
        if let rows: [ProjectServiceRow] = try? await client.get("/api/project-services") {
            guard ownRun == run else { return }
            services = rows.filter { row in
                guard row.workspaceId == workspaceId else { return false }
                guard let projectId else { return true }
                return row.projectId == projectId
            }
            loaded = true
        }
    }

    private func fetchMachine(run ownRun: Int) async {
        // The machine comes ONLY from the gateway. The app ALWAYS talks to one: `SessionStore.connect` requires `/gw/info`
        // with `gateway: true` and sets the client only then, and the shell (and with it this model) exists only in phase
        // `.ready`. The same flag switches gateway operation on the web (`GatewayGate`, `useGateway()`), and there the rule
        // is: `/gw/host`, nothing else. If the route fails, the last value stays; if there was none, the button shows no
        // machine.
        if let host: MachineStatus = try? await client.get("/gw/host") {
            guard ownRun == run else { return }
            calculator = host
        }
    }

    private func fetchBrowser(run ownRun: Int, workspaceId: String) async {
        if let response: AgentBrowsersResponse = try? await client.get(
            "/api/browsers",
            query: [URLQueryItem(name: "workspaceId", value: workspaceId)]
        ) {
            guard ownRun == run else { return }
            agentBrowsers = response.browsers.filter { $0.kind == "agent" }
        }
    }
}
