import Foundation

// ── Providers / account / settings ──────────────────────────────────────────

/// The EFFECTIVE capabilities of a provider, as `/api/providers` reports them (preset plus overrides, run through `normalizeCaps`).
/// Deliberately only the subset the provider card shows as chips — nobody on mobile needs to read the server's other keys
/// (`nativeToolCalling`, `streaming`, `reasoning`, `documents`).
///
/// `vision` belongs to it: the "Images" chip says whether an attached image reaches the model. The server reports the capability —
/// with OpenRouter per model from the catalog.
struct ProviderCaps: Codable, Hashable, Sendable {
    var ownsAgentLoop: Bool
    var permissionPrompt: Bool
    var fork: Bool
    var effort: Bool
    var plan: Bool
    var vision: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ownsAgentLoop = c.bool(.ownsAgentLoop)
        permissionPrompt = c.bool(.permissionPrompt)
        fork = c.bool(.fork)
        effort = c.bool(.effort)
        plan = c.bool(.plan)
        vision = c.bool(.vision)
    }
}

struct ProviderInfo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var models: [ProviderModel]
    var caps: ProviderCaps?
    var connected: Bool
    var authMethod: String
    var defaultModel: String
    /// The provider's default level: chosen, otherwise the catalog level of the default model, otherwise medium. OPTIONAL — an older
    /// server does not send it; then there is no selection (missing is not empty).
    var defaultEffort: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        label = c.str(.label)
        models = c.list(.models, ProviderModel.self)
        caps = (try? c.decodeIfPresent(ProviderCaps.self, forKey: .caps)) ?? nil
        connected = c.bool(.connected)
        authMethod = c.str(.authMethod)
        defaultModel = c.str(.defaultModel)
        defaultEffort = c.strOpt(.defaultEffort)
    }
}

struct ProviderInfoResponse: Codable, Sendable {
    var active: String
    var providers: [ProviderInfo]
    /// The same providers in the form the effort selection computes with (`EffortSelection`, `[Provider]`) — read from the SAME
    /// response, so that the default level in the settings offers the same levels as every other picker. Not encoded: only a second
    /// reading of `providers`.
    var effortCatalog: [Provider] = []

    enum CodingKeys: String, CodingKey { case active, providers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.str(.active)
        providers = c.list(.providers, ProviderInfo.self)
        effortCatalog = c.list(.providers, Provider.self)
    }
}

// Only Claude, Codex and OpenRouter exist as providers, and OpenRouter is built in — access via `GET/PUT/DELETE /api/openrouter`,
// `UsageModels.swift`.

struct AccountStatus: Codable, Sendable {
    var connected: Bool
    var loggedIn: Bool
    var authMethod: String?
    var email: String?
    var orgName: String?
    var subscriptionType: String?
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected)
        loggedIn = c.bool(.loggedIn)
        authMethod = c.strOpt(.authMethod)
        email = c.strOpt(.email)
        orgName = c.strOpt(.orgName)
        subscriptionType = c.strOpt(.subscriptionType)
        error = c.strOpt(.error)
    }
}

struct UsageWindow: Codable, Hashable, Sendable {
    var utilization: Double?
    var resetsAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        utilization = c.dblOpt(.utilization)
        resetsAt = c.strOpt(.resetsAt)
    }
}

/// Window entry of the server (limits.js). `ring` = the SESSION WINDOW (Claude: 5 h across all models) — with a value even when
/// the endpoint leaves the legacy fields empty; without this field the ring vanished exactly at the limit, because a full pot does
/// not necessarily bring a percentage. `blocking` = the window that is currently at its limit (e.g. a model-specific weekly
/// limit); it belongs in accessibility and settings, not in the ring value.
struct UsageRingWindow: Codable, Hashable, Sendable {
    var percent: Double
    var resetsAt: String?
    var group: String // session | weekly | credits | spend
    var scope: String // model name for model-specific limits ("Fable")
    var windowMinutes: Int?
    var reached: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        percent = c.dblOpt(.percent) ?? 0
        resetsAt = c.strOpt(.resetsAt)
        group = c.strOpt(.group) ?? "session"
        scope = c.strOpt(.scope) ?? ""
        windowMinutes = c.intOpt(.windowMinutes)
        reached = c.bool(.reached)
    }
}

/// Credit balance of the Claude account ("extra usage") — what keeps running BEYOND the time windows and costs money. Field for
/// field the output of `limits.creditStatus()`.
///
/// The amounts come ALREADY CONVERTED (`limit`, `consumed`) beside the raw values in cents. Conversion happens only on the server:
/// for JPY, KRW and VND the division by 100 does not apply, and a hard-coded "/100" in the client would be off by a factor of 100
/// there.
///
/// `active == false` means "this account has no credit pot at all" — NOT "credit used up". That mix-up was one of the two
/// unreported errors; this field alone therefore decides whether the row appears at all.
///
/// Every field has a default value. That is no style but the condition for the row being able to drop out without taking the usage
/// view with it: a synthesized `Decodable` demands EVERY key, and a single missing field would make quota bars, wait list and price
/// table unreadable.
struct CreditStatus: Codable, Hashable, Sendable {
    var active = false
    /// ONLY an explicit `monthly_limit: null` means unlimited; a missing field means unknown — and then this is `false` and
    /// `limit` is `nil`.
    var unlimited = false
    /// Amounts in the currency unit, `nil` = the server names none. No invented 0.
    var limit: Double?
    var consumed: Double?
    var currency = "USD"
    /// Utilization in percent (0…100), `nil` = unknown.
    var percent: Double?
    /// Reason why the credit no longer carries — the provider's wording.
    var reason = ""
    /// And whether this reason really blocks. A reason alone is no block.
    var blocked = false

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.bool(.active)
        unlimited = c.bool(.unlimited)
        limit = c.dblOpt(.limit)
        consumed = c.dblOpt(.consumed)
        currency = c.str(.currency, "USD")
        percent = c.dblOpt(.percent)
        reason = c.str(.reason)
        blocked = c.bool(.blocked)
    }

    enum CodingKeys: String, CodingKey {
        case active, unlimited, limit, consumed, currency, percent, reason, blocked
    }
}

struct ClaudeUsage: Codable, Sendable {
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var ring: UsageRingWindow?
    var blocking: UsageRingWindow?
    /// Credit balance — `nil` if the endpoint delivered no `extra_usage` at all. Empty is not unknown: an invented zero balance would
    /// stand in the display like a measurement.
    var credit: CreditStatus?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fiveHour = (try? c.decodeIfPresent(UsageWindow.self, forKey: .fiveHour)) ?? nil
        sevenDay = (try? c.decodeIfPresent(UsageWindow.self, forKey: .sevenDay)) ?? nil
        ring = (try? c.decodeIfPresent(UsageRingWindow.self, forKey: .ring)) ?? nil
        blocking = (try? c.decodeIfPresent(UsageRingWindow.self, forKey: .blocking)) ?? nil
        credit = (try? c.decodeIfPresent(CreditStatus.self, forKey: .credit)) ?? nil
    }
}

struct CodexWindow: Codable, Hashable, Sendable {
    var usedPercent: Double?
    var windowMinutes: Int?
    var resetsAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        usedPercent = c.dblOpt(.usedPercent)
        windowMinutes = c.intOpt(.windowMinutes)
        resetsAt = c.strOpt(.resetsAt)
    }
}

struct CodexUsage: Codable, Sendable {
    var connected: Bool
    var primary: CodexWindow?
    var secondary: CodexWindow?
    var planType: String?
    var reachedType: String? // primary | secondary | credits | spend
    var ring: UsageRingWindow?
    var blocking: UsageRingWindow?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected)
        primary = (try? c.decodeIfPresent(CodexWindow.self, forKey: .primary)) ?? nil
        secondary = (try? c.decodeIfPresent(CodexWindow.self, forKey: .secondary)) ?? nil
        planType = c.strOpt(.planType)
        reachedType = c.strOpt(.reachedType)
        ring = (try? c.decodeIfPresent(UsageRingWindow.self, forKey: .ring)) ?? nil
        blocking = (try? c.decodeIfPresent(UsageRingWindow.self, forKey: .blocking)) ?? nil
    }
}

// Usage is read by `Models/UsageModels.swift`; the prices per provider behind OpenRouter (`ModelPrices`) live there too.

struct AgentHook: Codable, Hashable, Identifiable, Sendable {
    var id = UUID()
    var event: String
    var matcher: String
    var command: String

    enum CodingKeys: String, CodingKey { case event, matcher, command }

    init(event: String, matcher: String, command: String) {
        self.event = event
        self.matcher = matcher
        self.command = command
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = c.str(.event, "PreToolUse")
        matcher = c.str(.matcher, "*")
        command = c.str(.command)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(event, forKey: .event)
        try c.encode(matcher, forKey: .matcher)
        try c.encode(command, forKey: .command)
    }
}

struct AgentHooksResponse: Codable, Sendable {
    var hooks: [AgentHook]
    var events: [String]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hooks = c.list(.hooks, AgentHook.self)
        events = c.strings(.events)
    }
}

struct AgentModelChoice: Codable, Hashable, Sendable {
    var provider: String
    var model: String

    init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        model = c.str(.model)
    }
}

/// What an app agent REALLY runs with (`effective` in `GET/PUT /api/agent-models`). `asChat`: the compaction without a choice of its
/// own runs with the model of the respective CHAT — there is no single model, the server says so (provider and model empty), and
/// the page invents none.
struct AgentEffective: Decodable, Hashable, Sendable {
    var provider: String
    var model: String
    var asChat: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        model = c.str(.model)
        asChat = c.bool(.asChat)
    }

    enum CodingKeys: String, CodingKey { case provider, model, asChat }
}

struct AgentModelsResponse: Decodable, Sendable {
    var agents: [String: AgentModelChoice?]
    var defaults: [String: String]
    /// The level per app agent: "" = default. Read as OPTIONAL — an older server does not send the map, then it is empty (every row
    /// "Default"), and the page stays readable.
    var efforts: [String: String]
    /// The model the oneshot REALLY runs with (also at "Auto") — the level selection and "Default · <level>" hang on it. If it is
    /// missing (older server), there is no level selection at "Auto".
    var effective: [String: AgentEffective]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = ((try? c.decodeIfPresent([String: AgentModelChoice?].self, forKey: .agents)) ?? nil) ?? [:]
        defaults = c.map(.defaults)
        efforts = c.map(.efforts)
        effective = ((try? c.decodeIfPresent([String: AgentEffective].self, forKey: .effective)) ?? nil) ?? [:]
    }

    enum CodingKeys: String, CodingKey { case agents, defaults, efforts, effective }
}

/// The answer to `PUT /api/agent-models` — only what the page needs afterwards; both fields optional.
struct AgentModelPutResponse: Decodable, Sendable {
    var effort: String?
    var effective: AgentEffective?
}
