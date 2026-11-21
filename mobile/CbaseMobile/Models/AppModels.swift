import Foundation

// ── Server environment (gateway) ───────────────────────────────────────────────
struct GatewayEnvInfo: Codable, Sendable {
    var state: String
    var startedAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = c.str(.state)
        startedAt = c.strOpt(.startedAt)
    }
}

struct GatewayStorageInfo: Codable, Sendable {
    var usedBytes: Double
    var quotaBytes: Double?
    var hostFreeBytes: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        usedBytes = c.dbl(.usedBytes)
        quotaBytes = c.dblOpt(.quotaBytes)
        hostFreeBytes = c.dblOpt(.hostFreeBytes)
    }
}

// ── Notifications ──────────────────────────────────────────────────────────────
struct ServiceEvent: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var at: Double
    var kind: String
    var title: String
    var body: String
    /// Regular chat (workflow trigger, requested review); tapping the notification opens it.
    var chatId: String?
    /// Question/review: the card is closed (answered, answered via a channel, or dismissed).
    /// The entry stays but no longer prompts for action.
    var resolved: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        at = c.dbl(.at)
        kind = c.str(.kind)
        title = c.str(.title)
        body = c.str(.body)
        chatId = c.strOpt(.chatId)
        resolved = c.bool(.resolved)
    }
}

struct ServiceEventsResponse: Codable, Sendable {
    var events: [ServiceEvent]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = c.list(.events, ServiceEvent.self)
    }
}

// ── Port conflicts ──────────────────────────────────────────────────────────
struct PortConflictItem: Codable, Hashable, Sendable {
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

/// The conflicts of ONE project from GET /api/ports/conflicts, display only. An older server that still sends a
/// `chatId` is harmless (the decoder ignores unknown keys).
struct PortConflictGroup: Codable, Hashable, Sendable {
    var items: [PortConflictItem]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, PortConflictItem.self)
    }
}

// ── Terminal / browser ──────────────────────────────────────────────────────
struct TerminalSessionResponse: Codable, Sendable {
    var id: String
    var available: Bool
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        available = c.bool(.available, true)
        error = c.strOpt(.error)
    }
}

struct TerminalExistsResponse: Codable, Sendable { let exists: Bool }

struct BrowserEnsureResponse: Codable, Sendable {
    var id: String?
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.strOpt(.id)
        error = c.strOpt(.error)
    }
}

struct BrowserTabInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var url: String
    var active: Bool
    /// The tab where the agent last did something; only ever true on an agent browser.
    var agent: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        title = c.str(.title)
        url = c.str(.url)
        active = c.bool(.active)
        agent = c.bool(.agent)
    }
}

struct BrowserActResponse: Codable, Sendable {
    var ok: Bool
    var tab: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok, true)
        tab = c.strOpt(.tab)
    }
}

/// A running browser from `GET /api/browsers`. An agent browser keeps its identity beyond the Chromium process:
/// `profile` is the profile folder ("chat-<chatId>" or "chat-<chatId>-agent-<agentId>"). The `id` belongs to a SESSION
/// and changes with every run of the agent, so a viewer remembers the profile (`BrowserSessionModel.watchedProfile`).
/// `activeAt` (ms since 1970, 0 = never) is the agent's last activity: a new tab or a new address.
struct AgentBrowserInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var kind: String
    var label: String
    var tabs: Int
    var profile: String
    var chatId: String
    var agentId: String
    var activeAt: Double

    /// How long after the last activity an agent browser counts as "currently controlling"; same as `ACTIVE_MS` on the web.
    static let activeMs: Double = 30_000

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        kind = c.str(.kind, "agent")
        label = c.str(.label)
        tabs = c.int(.tabs)
        profile = c.str(.profile)
        chatId = c.str(.chatId)
        agentId = c.str(.agentId)
        activeAt = c.dbl(.activeAt)
    }

    /// Is the agent currently controlling this browser? `now` in ms since 1970, supplied by the caller so the rule stays testable.
    func controlsCurrently(now: Double) -> Bool {
        activeAt > 0 && now - activeAt >= 0 && now - activeAt < Self.activeMs
    }
}

struct AgentBrowsersResponse: Codable, Sendable {
    var browsers: [AgentBrowserInfo]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        browsers = c.list(.browsers, AgentBrowserInfo.self)
    }
}
