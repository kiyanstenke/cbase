import Foundation

// ── Project services (apps) ──────────────────────────────────────────────────
struct ProjectServiceRow: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var projectId: String
    var projectName: String
    var workspaceId: String?
    var name: String
    var kind: String
    var port: Int?
    var container: String
    var tech: String
    var startCommand: String
    var agentInstructions: String
    var running: Bool
    // The server's start guard blocks a start although the port shows nothing (the group is alive but not listening on
    // the port); then "Stop" is offered instead of "Start". Missing on older servers: false.
    var holdsStart: Bool
    /// Per instance of the project (main and copies), whether the service runs there. The server sends the field ONLY from two
    /// instances up; an older server or a project with one instance omits it, so `nil`, not `[]`.
    var instances: [ServiceInstance]?
    /// A run that can be stopped: the port shows it, or the start guard holds it.
    var stoppable: Bool { running || holdsStart }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        projectId = c.str(.projectId)
        projectName = c.str(.projectName)
        workspaceId = c.strOpt(.workspaceId)
        name = c.str(.name)
        kind = c.str(.kind, "other")
        port = c.intOpt(.port)
        container = c.str(.container)
        tech = c.str(.tech)
        startCommand = c.str(.startCommand)
        agentInstructions = c.str(.agentInstructions)
        running = c.bool(.running)
        holdsStart = c.bool(.holdsStart)
        instances = (try? c.decodeIfPresent([ServiceInstance].self, forKey: .instances)) ?? nil
    }
}

/// The service in ONE instance: the identifier "<project>/<instance>", whether it runs there, and whether THIS instance's
/// start guard blocks a start (`holdsStart`: group alive, port closed; then "Stop" is offered, otherwise every start ends in
/// 409 SERVICE_RUNNING; the apps page's instance picker reads it via `ServicesRules.serviceInInstance`).
struct ServiceInstance: Codable, Hashable, Sendable {
    var identifier: String
    var running: Bool
    var holdsStart: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        identifier = c.str(.identifier)
        running = c.bool(.running)
        // Missing field (older server): false. Written with an explicit default on purpose: web/test/service-stoppable.test.mjs
        // counts the assignment without a default in exactly the TWO service models (row and run status).
        holdsStart = c.bool(.holdsStart, false)
    }
}

/// The response of `POST /api/projects/<id>/services/<sid>/stop`: `stopped` and, if the server knows WHY not, `error` (e.g.
/// "Project container … is frozen — service … not stopped, try again", services.js `stopInInstance`). Both views (apps,
/// projects) must show it, otherwise a failed stop says nothing. Counterpart of `stopNotice` in
/// web/src/lib/services-status.ts, bound in web/test/service-stoppable.test.mjs.
struct ServiceStopResponse: Decodable, Sendable {
    /// `nil`: the response does not say, so no message (a missing field is not a statement).
    var stopped: Bool?
    var error: String?

    private enum Keys: String, CodingKey { case stopped, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        stopped = c.boolOpt(.stopped)
        error = c.strOpt(.error)
    }

    /// What the view says after the stop: `nil` for `stopped: true` or when absent; otherwise the server's reason, or the
    /// generic sentence without one.
    func notice(name: String) -> String? {
        guard stopped == false else { return nil }
        if let error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return error }
        return L("{name} could not be safely stopped — something may still be running on the port.", ["name": name])
    }

    /// From the response body; an unreadable response is no statement (`nil`).
    static func notice(from data: Data, name: String) -> String? {
        (try? JSONDecoder().decode(ServiceStopResponse.self, from: data))?.notice(name: name)
    }
}

struct ServiceRunStatus: Codable, Hashable, Sendable {
    var running: Bool
    // Like `ProjectServiceRow.holdsStart`.
    var holdsStart: Bool
    var mode: String?
    var since: Double?
    var chatId: String?
    var hasLog: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = c.bool(.running)
        holdsStart = c.bool(.holdsStart)
        mode = c.strOpt(.mode)
        since = c.dblOpt(.since)
        chatId = c.strOpt(.chatId)
        hasLog = c.bool(.hasLog)
    }
}

struct ProjectServiceDetail: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var name: String
    var kind: String
    var port: Int?
    var tech: String
    var dir: String
    var startCommand: String
    var description: String
    var agentInstructions: String
    var status: ServiceRunStatus?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        name = c.str(.name)
        kind = c.str(.kind, "other")
        port = c.intOpt(.port)
        tech = c.str(.tech)
        dir = c.str(.dir)
        startCommand = c.str(.startCommand)
        description = c.str(.description)
        agentInstructions = c.str(.agentInstructions)
        status = (try? c.decodeIfPresent(ServiceRunStatus.self, forKey: .status)) ?? nil
    }
}

struct ServiceScanConflict: Codable, Hashable, Sendable {
    var port: Int
    var name: String
    var owner: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        port = c.int(.port)
        name = c.str(.name)
        owner = c.str(.owner)
    }
}

struct ServiceScanState: Codable, Hashable, Sendable {
    var status: String
    var startedAt: Double
    var finishedAt: Double?
    var count: Int?
    var error: String?
    var conflicts: [ServiceScanConflict]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.str(.status, "done")
        startedAt = c.dbl(.startedAt)
        finishedAt = c.dblOpt(.finishedAt)
        count = c.intOpt(.count)
        error = c.strOpt(.error)
        conflicts = c.list(.conflicts, ServiceScanConflict.self)
    }
}

struct ProjectServicesResponse: Codable, Sendable {
    var scan: ServiceScanState?
    var services: [ProjectServiceDetail]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scan = (try? c.decodeIfPresent(ServiceScanState.self, forKey: .scan)) ?? nil
        services = c.list(.services, ProjectServiceDetail.self)
    }
}

struct PortClaim: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var port: Int
    var name: String
    var projectId: String
    var projectName: String
    var workspaceId: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        port = c.int(.port)
        name = c.str(.name)
        projectId = c.str(.projectId)
        projectName = c.str(.projectName)
        workspaceId = c.strOpt(.workspaceId)
    }
}

struct FreePortResponse: Codable, Sendable { let port: Int }
struct ChatIdResponse: Codable, Sendable {
    let chatId: String?
    let mode: String?
}

// ── Resources of running services (Docker) ───────────────────────────────────
struct ProjectResourceRow: Codable, Identifiable, Hashable, Sendable {
    var id: String { projectId }
    var projectId: String
    var name: String
    var dockerUp: Bool
    var containers: Int
    var cpu: Double
    var memBytes: Double
    var memLimitBytes: Double
    var memLimitShared: Bool
    var diskBytes: Double?
    /// The project's instances (main and copies) with chat and load. The server sends the field ONLY from two instances up;
    /// otherwise it is missing, so `nil`. Whether a group is shown is decided by `ServicesRules.groupRows`.
    var instances: [ProjectInstance]?

    /// Old backends added the same shared RAM limit once per container; corrected here.
    var memCapacity: Double {
        guard memLimitBytes > 0 else { return 0 }
        if memLimitShared || containers <= 1 { return memLimitBytes }
        return memLimitBytes / Double(containers)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = c.str(.projectId)
        name = c.str(.name)
        dockerUp = c.bool(.dockerUp)
        containers = c.int(.containers)
        cpu = c.dbl(.cpu)
        memBytes = c.dbl(.memBytes)
        memLimitBytes = c.dbl(.memLimitBytes)
        memLimitShared = c.bool(.memLimitShared)
        diskBytes = c.dblOpt(.diskBytes)
        instances = (try? c.decodeIfPresent([ProjectInstance].self, forKey: .instances)) ?? nil
    }
}

/// An instance of a project in `/api/project-resources`: `identifier` "<project>/<instance>", `name` of the container,
/// `dnsName` in the project network, the chat the copy belongs to (the main instance has none), its state and load. Every
/// field except the identifier may be missing.
struct ProjectInstance: Codable, Identifiable, Hashable, Sendable {
    var id: String { identifier }
    var identifier: String
    var name: String
    var dnsName: String
    var chatId: String?
    var chatTitle: String?
    var state: String
    var cpu: Double
    var memBytes: Double
    /// The instance's running containers (outside the contract); the apps page reads "running" from it; missing: `nil`.
    var containers: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        identifier = c.str(.identifier)
        name = c.str(.name)
        dnsName = c.str(.dnsName)
        chatId = c.strOpt(.chatId)
        chatTitle = c.strOpt(.chatTitle)
        state = c.str(.state)
        cpu = c.dbl(.cpu)
        memBytes = c.dbl(.memBytes)
        containers = c.intOpt(.containers)
    }
}

struct ProjectResourcesResponse: Codable, Sendable {
    var resources: [ProjectResourceRow]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resources = c.list(.resources, ProjectResourceRow.self)
    }
}

// ── Preview links ───────────────────────────────────────────────────────────
// A public ngrok link to a registered service on an instance. The shapes follow the server contract, each with its own
// `init(from:)` and a default per field: a synthesized Decodable requires EVERY key and would make the whole services view
// unreadable as soon as the server omits one. Access values (auth token, API key) NEVER come back: the responses only say
// WHETHER one is stored. Web counterpart: `web/src/lib/api/preview.ts`.

/// The mode of the ngrok connection: `dev` = auth token only (free plan, the one dev address, one link at a time), `names` =
/// auth token and API key (a reserved random name per link, up to three). `off` = no auth token stored.
enum PreviewMode: String, Sendable {
    case off, dev, names
}

/// A link (in lists, as the response of POST/DELETE and in the SSE `preview/link`). `instance` `nil` means the target is the
/// backend itself (project not converted). A `nil` expiry means unlimited; `url` is empty until the link is `online`.
struct PreviewLink: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var projectId: String
    var projectName: String
    var instance: String?
    var serviceId: Int
    var serviceName: String
    var port: Int
    /// The mode at creation (`dev` · `names`), kept raw so an unknown value does not silently become a known one.
    var mode: String
    var url: String
    /// `start` · `online` · `fehler` · `beendet`
    var state: String
    var error: String
    var createdAt: Double
    var runningSinceAt: Double?
    var endedAt: Double?
    var endedReason: String?

    enum CodingKeys: String, CodingKey {
        case id, projectId, projectName, instance, serviceId, serviceName, port, mode, url, state, error
        case createdAt, runningSinceAt, endedAt, endedReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        projectId = c.str(.projectId)
        projectName = c.str(.projectName)
        instance = c.strOpt(.instance)
        serviceId = c.int(.serviceId)
        serviceName = c.str(.serviceName)
        port = c.int(.port)
        mode = c.str(.mode)
        url = c.str(.url)
        state = c.str(.state)
        error = c.str(.error)
        createdAt = c.dbl(.createdAt)
        runningSinceAt = c.dblOpt(.runningSinceAt)
        endedAt = c.dblOpt(.endedAt)
        endedReason = c.strOpt(.endedReason)
    }
}

/// `GET /api/preview-links` → `{ active, history, mode, limit, sdk }`. `history` holds the last 20 ended links, newest first.
struct PreviewLinksStatus: Decodable, Sendable {
    var active: [PreviewLink]
    var history: [PreviewLink]
    /// `nil` if the server names a mode this app does not know; it then offers nothing (never guess).
    var mode: PreviewMode?
    var limit: Int
    /// The ngrok SDK is loaded in the server. If the field is missing it counts as NOT loaded: an offer that ends in 501 is
    /// worse than none.
    var sdk: Bool

    enum CodingKeys: String, CodingKey { case active, history, mode, limit, sdk }

    init(active: [PreviewLink] = [], history: [PreviewLink] = [], mode: PreviewMode? = .off, limit: Int = 0, sdk: Bool = false) {
        self.active = active
        self.history = history
        self.mode = mode
        self.limit = limit
        self.sdk = sdk
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.list(.active, PreviewLink.self)
        history = c.list(.history, PreviewLink.self)
        mode = c.strOpt(.mode).flatMap(PreviewMode.init(rawValue:))
        limit = c.int(.limit)
        sdk = c.bool(.sdk)
    }
}

/// `GET`/`PUT /api/integrations/ngrok` → `{ authtoken, apiKey, mode, limit, active, checkedAt, error, sdk }`. `authtoken` and
/// `apiKey` are booleans ("stored"), never the values.
struct NgrokAccess: Decodable, Sendable {
    var authtoken: Bool
    var apiKey: Bool
    var mode: PreviewMode?
    var limit: Int
    /// Number of active links.
    var active: Int
    var checkedAt: Double?
    var error: String
    var sdk: Bool

    enum CodingKeys: String, CodingKey { case authtoken, apiKey, mode, limit, active, checkedAt, error, sdk }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        authtoken = c.bool(.authtoken)
        apiKey = c.bool(.apiKey)
        mode = c.strOpt(.mode).flatMap(PreviewMode.init(rawValue:))
        limit = c.int(.limit)
        active = c.int(.active)
        checkedAt = c.dblOpt(.checkedAt)
        error = c.str(.error)
        sdk = c.bool(.sdk)
    }
}

/// `POST /api/preview-links`: ALL four keys are sent, also with `null` (`instance: null` = the backend itself, `validDays: null` =
/// unlimited). A synthesized Encodable would OMIT a `nil` key and the server would answer 400 (a missing field is not a
/// statement), hence `encodeNil` by hand.
struct PreviewLinkCreation: Encodable, Sendable {
    let projectId: String
    let instance: String?
    let serviceId: Int
    let validDays: Int?

    enum CodingKeys: String, CodingKey { case projectId, instance, serviceId, validDays }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(projectId, forKey: .projectId)
        if let instance { try c.encode(instance, forKey: .instance) } else { try c.encodeNil(forKey: .instance) }
        try c.encode(serviceId, forKey: .serviceId)
        if let validDays { try c.encode(validDays, forKey: .validDays) } else { try c.encodeNil(forKey: .validDays) }
    }
}

/// `PUT /api/integrations/ngrok`: BOTH keys are sent; a string sets, `null` leaves unchanged, `""` deletes.
/// Encoded by hand like above: without `encodeNil` the key would be missing and the server would answer 400.
struct NgrokAccessBody: Encodable, Sendable {
    let authtoken: String?
    let apiKey: String?

    enum CodingKeys: String, CodingKey { case authtoken, apiKey }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let authtoken { try c.encode(authtoken, forKey: .authtoken) } else { try c.encodeNil(forKey: .authtoken) }
        if let apiKey { try c.encode(apiKey, forKey: .apiKey) } else { try c.encodeNil(forKey: .apiKey) }
    }
}
