import Foundation

// The administration: users and resources per user container. The JSON forms are the lists of the contract
// `server/gateway/administration-contract.js`; `web/test/administration-binding.test.mjs` reads this file as TEXT and holds it
// to it: the `CodingKeys` of every type equal the contract's list, every key is read in the decoder or encoded in the body,
// `cpuMax` uses `encodeNil` (a synthesized Encodable would omit `nil`, and the gateway answers a missing key with 400), and
// the constants in `AdministrationContract` equal those of the contract. Web counterpart: `web/src/lib/api/administration.ts`.
//
// Reading is tolerant (`DecodeHelpers`) but makes no claims: an unknown role is `nil` (not "user"), an unknown state is `nil`
// (not "missing"), and `resources` without one of its three keys is `nil`; a missing `cpuMax` would otherwise mean "no limit".

/// The contract constants the app needs (the rest, such as shares per level and the host reserve, only the gateway computes).
enum AdministrationContract {
    /// The CPU priority levels, in the UI's order.
    static let cpuPrio = ["low", "normal", "up"]
    /// The cgroup weight per level, as the container carries it (`actual.cpuWeight`).
    static let cpuPrioWeight: [String: Int] = ["low": 50, "normal": 100, "up": 200]
    /// RAM in whole GiB, not below.
    static let ramMinGiB = 2
    /// Headroom above the measured consumption that a new RAM value must leave; otherwise the gateway answers 409.
    static let ramBufferBytes: Double = 536_870_912
    static let roles = ["user", "admin"]
    static let containerStates = ["running", "stopped", "missing"]
    static let containerActions = ["start", "restart", "stop"]
    /// The key of the page in the settings (web `SECTIONS`, here `SettingsView`).
    static let page = "administration"
}

let administrationGiB: Double = 1024 * 1024 * 1024

/// Bytes as GiB with at most one decimal place, in the device's notation.
func administrationGiBText(_ bytes: Double) -> String {
    "\((bytes / administrationGiB).formatted(.number.precision(.fractionLength(0...1)).locale(Loc.locale))) GiB"
}

/// The word per container state: one for EVERY state of the contract (the binding test reads the `case`s).
func administrationStateWord(_ state: String?) -> String {
    switch state {
    case "running": return L("running")
    case "stopped": return L("stopped")
    case "missing": return L("no container")
    default: return L("state unknown")
    }
}

func administrationRoleWord(_ role: String?) -> String {
    switch role {
    case "admin": return L("Admin##role")
    case "user": return L("User")
    default: return L("role unknown")
    }
}

/// The word per level, as a literal and not `L(prio)`: `mobile/tools/loc-audit.sh` only sees literal keys.
func administrationPrioWord(_ prio: String) -> String {
    switch prio {
    case "low": return L("low")
    case "normal": return L("normal")
    case "up": return L("high")
    default: return prio
    }
}

// ── Responses ───────────────────────────────────────────────────────────────

/// The stored values of a user, also the body of `PUT /gw/admin/users/:id/resources`. `cpuMax == nil` means "no hard limit"
/// and is sent as `null`.
struct AdministrationResources: Codable, Equatable, Sendable {
    var ramGiB: Int
    var cpuPrio: String
    var cpuMax: Int?

    enum CodingKeys: String, CodingKey { case ramGiB, cpuPrio, cpuMax }

    init(ramGiB: Int, cpuPrio: String, cpuMax: Int?) {
        self.ramGiB = ramGiB
        self.cpuPrio = cpuPrio
        self.cpuMax = cpuMax
    }

    /// Throws as soon as one of the three keys is missing or unreadable; the caller then reads `nil` ("not delivered").
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let ram = c.intOpt(.ramGiB), let prio = c.strOpt(.cpuPrio), AdministrationContract.cpuPrio.contains(prio), c.contains(.cpuMax) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "resources incomplete"))
        }
        ramGiB = ram
        cpuPrio = prio
        if try c.decodeNil(forKey: .cpuMax) {
            cpuMax = nil
        } else if let max = c.intOpt(.cpuMax) {
            cpuMax = max
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "cpuMax unlesbar"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ramGiB, forKey: .ramGiB)
        try c.encode(cpuPrio, forKey: .cpuPrio)
        if let cpuMax { try c.encode(cpuMax, forKey: .cpuMax) } else { try c.encodeNil(forKey: .cpuMax) }
    }
}

/// What the container currently carries (docker inspect + cgroup); per field `nil` = not read or (`cpuMax`) no limit.
struct AdministrationActual: Decodable, Sendable {
    var ramBytes: Double?
    var cpuMax: Double?
    var cpuWeight: Int?

    enum CodingKeys: String, CodingKey { case ramBytes, cpuMax, cpuWeight }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ramBytes = c.dblOpt(.ramBytes)
        cpuMax = c.dblOpt(.cpuMax)
        cpuWeight = c.intOpt(.cpuWeight)
    }
}

/// Working set and CPU threads in the last measurement window; per field `nil` = not measured.
struct AdministrationConsumption: Decodable, Sendable {
    var ramBytes: Double?
    var cpuThreads: Double?

    enum CodingKeys: String, CodingKey { case ramBytes, cpuThreads }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ramBytes = c.dblOpt(.ramBytes)
        cpuThreads = c.dblOpt(.cpuThreads)
    }
}

/// `state == nil`: the gateway named no known one; never silently "missing". `since`: ISO or nil.
struct AdministrationContainer: Decodable, Sendable {
    var state: String?
    var since: String?

    enum CodingKeys: String, CodingKey { case state, since }

    init(state: String?, since: String?) {
        self.state = state
        self.since = since
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = c.strOpt(.state).flatMap { AdministrationContract.containerStates.contains($0) ? $0 : nil }
        since = c.strOpt(.since).flatMap { $0.isEmpty ? nil : $0 }
    }
}

struct AdministrationServer: Decodable, Sendable {
    var threads: Int?
    var ramTotalBytes: Double?
    /// Sum of all users' RAM limits.
    var ramAllocatedBytes: Double?
    /// What the host keeps for itself; the marker in the bar.
    var reserveBytes: Double?
    /// Sum of the limits above total minus reserve: allowed, but stated.
    var overcommitted: Bool

    enum CodingKeys: String, CodingKey { case threads, ramTotalBytes, ramAllocatedBytes, reserveBytes, overcommitted }

    init() {
        overcommitted = false
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = c.intOpt(.threads)
        ramTotalBytes = c.dblOpt(.ramTotalBytes)
        ramAllocatedBytes = c.dblOpt(.ramAllocatedBytes)
        reserveBytes = c.dblOpt(.reserveBytes)
        overcommitted = c.bool(.overcommitted)
    }
}

/// A user of the administration; also the response of `PUT …/resources`, `PATCH` and the container actions.
struct AdministrationUser: Decodable, Identifiable, Sendable {
    let id: String
    var username: String
    /// `nil` = no known role reported.
    var role: String?
    var locked: Bool
    /// Milliseconds since 1970, `nil` = not named.
    var createdAt: Double?
    /// The requesting admin themself; locking or deleting oneself is 400.
    var itself: Bool
    var container: AdministrationContainer
    /// `nil` = not (completely) delivered; then there is nothing to edit.
    var resources: AdministrationResources?
    /// `nil` without a container.
    var actual: AdministrationActual?
    /// `nil` without a running container.
    var consumption: AdministrationConsumption?
    /// Does the container carry something other than what is stored?
    var deviating: Bool

    enum CodingKeys: String, CodingKey { case id, username, role, locked, createdAt, itself, container, resources, actual, consumption, deviating }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        username = c.str(.username)
        role = c.strOpt(.role).flatMap { AdministrationContract.roles.contains($0) ? $0 : nil }
        locked = c.bool(.locked)
        createdAt = c.dblOpt(.createdAt)
        itself = c.bool(.itself)
        container = ((try? c.decodeIfPresent(AdministrationContainer.self, forKey: .container)) ?? nil)
            ?? AdministrationContainer(state: nil, since: nil)
        resources = (try? c.decodeIfPresent(AdministrationResources.self, forKey: .resources)) ?? nil
        actual = (try? c.decodeIfPresent(AdministrationActual.self, forKey: .actual)) ?? nil
        consumption = (try? c.decodeIfPresent(AdministrationConsumption.self, forKey: .consumption)) ?? nil
        deviating = c.bool(.deviating)
    }
}

/// `GET /gw/admin/administration`.
struct AdministrationStatus: Decodable, Sendable {
    var server: AdministrationServer
    var user: [AdministrationUser]

    enum CodingKeys: String, CodingKey { case server, user }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        server = ((try? c.decodeIfPresent(AdministrationServer.self, forKey: .server)) ?? nil) ?? AdministrationServer()
        // An entry without an id is nobody one could manage; it is dropped instead of emptying the list.
        user = c.list(.user, AdministrationUser.self).filter { !$0.id.isEmpty }
    }
}

/// The own limits from `GET /gw/env` (settings → environment, read-only). State and start are read by `GatewayEnvInfo`.
struct AdministrationOwn: Decodable, Sendable {
    var resources: AdministrationResources?
    var actual: AdministrationActual?
    var consumption: AdministrationConsumption?

    enum CodingKeys: String, CodingKey { case resources, actual, consumption }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resources = (try? c.decodeIfPresent(AdministrationResources.self, forKey: .resources)) ?? nil
        actual = (try? c.decodeIfPresent(AdministrationActual.self, forKey: .actual)) ?? nil
        consumption = (try? c.decodeIfPresent(AdministrationConsumption.self, forKey: .consumption)) ?? nil
    }
}

// ── Request bodies ──────────────────────────────────────────────────────────────────
// Encoded by hand like `AdministrationResources`: every key is in the body. PATCH carries EXACTLY one of the two keys (role OR
// lock); two or none would be 400, hence two bodies instead of one with two optionals.

struct AdministrationRoleBody: Encodable, Sendable {
    let role: String
    enum CodingKeys: String, CodingKey { case role }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role)
    }
}

struct AdministrationLockBody: Encodable, Sendable {
    let locked: Bool
    enum CodingKeys: String, CodingKey { case locked }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(locked, forKey: .locked)
    }
}

struct AdministrationCreateBody: Encodable, Sendable {
    let username: String
    let password: String
    let role: String
    enum CodingKeys: String, CodingKey { case username, password, role }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(username, forKey: .username)
        try c.encode(password, forKey: .password)
        try c.encode(role, forKey: .role)
    }
}

struct AdministrationPasswordBody: Encodable, Sendable {
    let password: String
    enum CodingKeys: String, CodingKey { case password }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(password, forKey: .password)
    }
}

// ── An action without a response ───────────────────────────────────────────────────────────────────────────────────────────────
// Restart, start, stop, limits and delete take longer than the session's 45 s (`APIClient`): the restart waits until the backend
// is healthy, the delete tears down containers and volumes. Treating 45 s as "failed" would drop the busy marker and a second tap
// on "Restart" would restart the container again. So the actions have their own deadlines (`deadlineManualAction`,
// `deadlineDelete`), and if one expires (`URLError.timedOut`) or the tunnel gives up (HTTP 524, after ~100 s) the state is
// "still running": the marker stays and the page reloads every `reloadEvery` until the loaded state shows the action
// (`arrived`), at most as long as the deadline itself. Same calculation on the web: `web/src/lib/administration-procedure.ts`
// (bound in `web/test/administration-proofread.test.mjs`).

enum AdministrationProcedure {
    /// Container actions and limits (see above).
    static let deadlineManualAction: TimeInterval = 180
    /// Deleting a user including teardown.
    static let deadlineDelete: TimeInterval = 300
    /// How often to reload while "still running" is shown.
    static let reloadEvery: TimeInterval = 5

    static func gracePeriod(_ what: String) -> TimeInterval { what == "erase" ? deadlineDelete : deadlineManualAction }

    /// Might the action still be in progress? The request's deadline expired, or the tunnel gave up (524).
    static func runningStill(_ error: Error) -> Bool {
        if let error = error as? URLError, error.code == .timedOut { return true }
        if let error = error as? APIError, error.status == 524 { return true }
        return false
    }

    /// Does the loaded state show that the action has arrived? `now == nil`: the user is no longer in the list.
    /// `prior`: the state at the tap (for the restart: a new start time); `target`: the sent limits (only "save").
    static func arrived(_ what: String, prior: AdministrationUser?, now: AdministrationUser?, target: AdministrationResources?) -> Bool {
        switch what {
        case "erase": return now == nil
        case "start": return now?.container.state == "running"
        case "restart": return now?.container.state == "running" && now?.container.since != prior?.container.since
        case "stop": return now != nil && now?.container.state != nil && now?.container.state != "running"
        case "save": return now != nil && target != nil && now?.resources == target && now?.deviating == false
        default: return true
        }
    }
}

// ── Paths ────────────────────────────────────────────────────────────────────
// Paths unencoded: `makeURL` encodes itself (the ids are UUIDs).

extension APIClient {
    func loadAdministration() async throws -> AdministrationStatus {
        try await get("/gw/admin/administration", timeout: 20)
    }

    /// Below the measured consumption plus buffer it is 409; the gateway's sentence names the number (`APIError.message`).
    func setResources(_ id: String, _ resources: AdministrationResources) async throws -> AdministrationUser {
        try await put("/gw/admin/users/\(id)/resources", body: resources, timeout: AdministrationProcedure.deadlineManualAction)
    }

    func setRole(_ id: String, _ role: String) async throws -> AdministrationUser {
        try await patch("/gw/admin/users/\(id)", body: AdministrationRoleBody(role: role))
    }

    func setLocked(_ id: String, _ locked: Bool) async throws -> AdministrationUser {
        try await patch("/gw/admin/users/\(id)", body: AdministrationLockBody(locked: locked))
    }

    /// `action` from `AdministrationContract.containerActions`.
    func containerAction(_ id: String, _ action: String) async throws -> AdministrationUser {
        try await post("/gw/admin/users/\(id)/\(action)", timeout: AdministrationProcedure.deadlineManualAction)
    }

    func setUpUser(_ body: AdministrationCreateBody) async throws {
        try await send("/gw/admin/users", body: body)
    }

    func setPassword(_ id: String, _ password: String) async throws {
        try await send("/gw/admin/users/\(id)/password", body: AdministrationPasswordBody(password: password))
    }

    /// `withData` also deletes the volumes (`purge=1`). If the teardown fails, the user stays locked (500 with a sentence).
    func deleteUser(_ id: String, withData: Bool) async throws {
        try await send("/gw/admin/users/\(id)", method: .delete, query: [URLQueryItem(name: "purge", value: withData ? "1" : "0")],
                       timeout: AdministrationProcedure.deadlineDelete)
    }
}
