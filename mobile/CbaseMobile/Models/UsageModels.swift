import Foundation

// Providers and usage. The JSON shapes are the lists of the contract `server/backend/electron/server/account/usage-contract.js`;
// `web/test/usage-binding-ios.test.mjs` reads this file as TEXT and pins it to it: the constants in `UsageContract` equal
// the contract's, the `CodingKeys` of every type equal the contract's list, every key is read in the decoder, the required
// keys of the PUT go out with `encode` (never `encodeIfPresent`), one word per role, origin, subpage and window, the
// routes and the jump `usage:<subpage>`. Web counterpart: `web/src/lib/api/usage.ts` (pinned in
// `web/test/usage-binding.test.mjs`).
//
// Reading is tolerant (`DecodeHelpers`) but asserts nothing (empty is not unknown): an amount the server does not know is
// `nil` and shows as "—", never "$ 0"; an access without one of the three switches is a LOAD ERROR — a missing
// `onlyWithoutSaving` read as "off" would go back to the server as "off" on the next save.

/// The contract constants the app needs (only the server knows OpenRouter's base — the app never calls a foreign host).
enum UsageContract {
    /// The ONLY providers, in UI order.
    static let provider = ["claude", "codex", "openrouter"]
    /// Their consumption counts against a quota, not money — the page shows the equivalent value, not cost.
    static let subscriptionProvider = ["claude", "codex"]
    static let openrouterId = "openrouter"
    /// The "Usage" page and its subpages; a jump from outside is `usage:<subpage>` (`AppState.settingsJump`).
    static let usagePage = "usage"
    static let usageSubpages = ["overview", "claude", "codex", "openrouter", "limit"]
    /// The dynamic-workflows page (group "Behaviour"), split out of "Usage".
    static let workflowsPage = "workflows"
    static let subscriptionWindow = ["session", "week", "30d"]
    static let openrouterWindow = ["30d", "total"]
    static let costOrigin = ["reported", "inquired", "estimated"]
    static let onceRoles = [
        "categorization", "extraction", "second_look", "compaction", "title", "target", "workflow_verdict", "adjust",
        "context_categorize", "project_categorize", "project_merge", "project_assign", "context_maintain", "services",
        "retrieval", "outer_loop",
    ]
    /// The required keys of PUT /api/openrouter — both ALWAYS go out (a missing one is 400, not "unchanged").
    static let openrouterPutRequired = ["onlyWithoutSaving", "noDataUsage"]

    /// The windows a provider knows (a foreign one is 400 on the server).
    static func window(for provider: String) -> [String] {
        provider == openrouterId ? openrouterWindow : subscriptionWindow
    }
}

// ── Words ───────────────────────────────────────────────────────────────────
// One `case` for EVERY entry of the contract (the binding test reads the literals). As a literal, not `L(value)`:
// `mobile/tools/loc-audit.sh` only sees literal keys. The same words as on the web.

/// The label of a "Usage" subpage — the providers as proper names, untranslated.
func usageSubpageWord(_ page: String) -> String {
    switch page {
    case "overview": return L("Overview")
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "openrouter": return "OpenRouter"
    case "limit": return L("At the limit")
    default: return page
    }
}

/// The label of a time window. `known == false`: the server does not know the window's start (no snapshot) and
/// computes a sliding one — the label then says exactly that instead of claiming "current".
func usageWindowWord(_ window: String, known: Bool = true) -> String {
    switch window {
    case "session": return known ? L("Current window") : L("Last 5 hrs")
    case "week": return known ? L("Current week") : L("Last 7 days")
    case "30d": return L("30 days")
    case "total": return L("All time")
    default: return window
    }
}

/// Where an OpenRouter amount comes from; `unknown` = without an amount.
func usageOriginWord(_ origin: String) -> String {
    switch origin {
    case "reported": return L("reported")
    case "inquired": return L("queried")
    case "estimated": return L("estimated")
    case "unknown": return L("unknown")
    default: return origin
    }
}

/// The role of a oneshot call (background tasks per role) — the same table as on the web.
func usageRoleWord(_ role: String) -> String {
    switch role {
    case "categorization": return L("Classification")
    case "extraction": return L("Extraction")
    case "second_look": return L("Second look")
    case "compaction": return L("Compaction")
    case "title": return L("Chat title")
    case "target": return L("Goal check")
    case "workflow_verdict": return L("Workflow verdict")
    case "adjust": return L("Adjust")
    case "context_categorize": return L("Classify context")
    case "project_categorize": return L("Classify project")
    case "project_merge": return L("Merge project context")
    case "project_assign": return L("Assign project")
    case "context_maintain": return L("Curate context")
    case "services": return L("Detect services")
    case "retrieval": return L("Summary on request")
    case "outer_loop": return L("Outer loop")
    default: return role
    }
}

/// An amount in US dollars (the currency is fixed): `nil` ⇒ "—" (unknown, never "$ 0"); below one cent "< $0.01" so a
/// small amount does not look like none.
func usageUsdText(_ usd: Double?) -> String {
    guard let usd, usd.isFinite else { return "—" }
    if usd > 0 && usd < 0.005 { return "< $" + usageCount(0.01, places: 2) }
    return "$" + usageCount(usd, places: 2)
}

/// A number with fixed decimals in the notation of the chosen language (`Loc.locale`).
func usageCount(_ value: Double, places: Int) -> String {
    let f = NumberFormatter()
    f.locale = Loc.locale
    f.numberStyle = .decimal
    f.minimumFractionDigits = places
    f.maximumFractionDigits = places
    return f.string(from: NSNumber(value: value)) ?? String(value)
}

// ── Timestamps ──────────────────────────────────────────────────────────────

extension KeyedDecodingContainer {
    /// A timestamp as the routes send it: milliseconds (number) or ISO text; `nil` = not given. Seconds (a number up to
    /// 1e12) are read too — the API mixes both (`locDate(fromServer:)`).
    func moment(_ key: Key) -> Date? {
        if let count = dblOpt(key), count > 0 { return locDate(fromServer: count) }
        if let text = strOpt(key) { return UsageStore.parse(text) }
        return nil
    }
}

// ── GET /api/usage/consumption ──────────────────────────────────────────────

/// The equivalent value split up (`partsUsd`), each part USD or `nil`.
struct UsageParts: Decodable, Sendable {
    var input: Double?
    var output: Double?
    var cacheRead: Double?
    var cacheWrite: Double?

    enum CodingKeys: String, CodingKey { case input, output, cacheRead, cacheWrite }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = c.dblOpt(.input)
        output = c.dblOpt(.output)
        cacheRead = c.dblOpt(.cacheRead)
        cacheWrite = c.dblOpt(.cacheWrite)
    }
}

/// How many OpenRouter rows have their amount from where; `unknown` = without an amount.
struct UsageOriginTally: Decodable, Sendable {
    var reported: Int
    var inquired: Int
    var estimated: Int
    var unknown: Int

    enum CodingKeys: String, CodingKey { case reported, inquired, estimated, unknown }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reported = c.int(.reported)
        inquired = c.int(.inquired)
        estimated = c.int(.estimated)
        unknown = c.int(.unknown)
    }

    /// The count per origin (contract order, then "unknown") — only what occurs.
    var entries: [(origin: String, count: Int)] {
        [("reported", reported), ("inquired", inquired), ("estimated", estimated), ("unknown", unknown)].filter { $0.1 > 0 }
    }
}

/// The sums of a window. `cacheUnsplit` (rows from before the split) is shown only if > 0.
struct UsageSums: Decodable, Sendable {
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var cacheUnsplit: Int
    var runs: Int
    /// API list-price estimate (subscription providers); `nil` for OpenRouter or without a price.
    var equivalentUsd: Double?
    /// `false` as soon as a model has no price or cache is unsplit — the number is then a lower bound.
    var equivalentComplete: Bool
    var partsUsd: UsageParts?
    /// OpenRouter only (otherwise `nil`).
    var costUsd: Double?
    var costOrigin: UsageOriginTally?

    enum CodingKeys: String, CodingKey {
        case input, output, cacheRead, cacheWrite, cacheUnsplit, runs
        case equivalentUsd, equivalentComplete, partsUsd, costUsd, costOrigin
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = c.int(.input)
        output = c.int(.output)
        cacheRead = c.int(.cacheRead)
        cacheWrite = c.int(.cacheWrite)
        cacheUnsplit = c.int(.cacheUnsplit)
        runs = c.int(.runs)
        equivalentUsd = c.dblOpt(.equivalentUsd)
        // If the field is missing, completeness is UNKNOWN — read as "not complete", never as a promise.
        equivalentComplete = c.bool(.equivalentComplete)
        partsUsd = (try? c.decodeIfPresent(UsageParts.self, forKey: .partsUsd)) ?? nil
        costUsd = c.dblOpt(.costUsd)
        costOrigin = (try? c.decodeIfPresent(UsageOriginTally.self, forKey: .costOrigin)) ?? nil
    }

    /// Is anything recorded in the window at all?
    var empty: Bool { input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 && cacheUnsplit == 0 && runs == 0 }
}

/// A row in `models` (sorted by equivalent value or cost, then output).
struct UsageModel: Decodable, Identifiable, Sendable {
    var id: String { model }
    var model: String
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var cacheUnsplit: Int
    var runs: Int
    var equivalentUsd: Double?
    var costUsd: Double?
    var priceKnown: Bool

    enum CodingKeys: String, CodingKey {
        case model, input, output, cacheRead, cacheWrite, cacheUnsplit, runs, equivalentUsd, costUsd, priceKnown
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = c.str(.model)
        input = c.int(.input)
        output = c.int(.output)
        cacheRead = c.int(.cacheRead)
        cacheWrite = c.int(.cacheWrite)
        cacheUnsplit = c.int(.cacheUnsplit)
        runs = c.int(.runs)
        equivalentUsd = c.dblOpt(.equivalentUsd)
        costUsd = c.dblOpt(.costUsd)
        priceKnown = c.bool(.priceKnown)
    }
}

/// A row in `chats` (at most 25; `chatsAdditional` says how many are missing).
struct UsageChat: Decodable, Identifiable, Sendable {
    var id: String { chatId }
    var chatId: String
    var title: String
    var deleted: Bool
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var runs: Int
    var equivalentUsd: Double?
    var costUsd: Double?

    enum CodingKeys: String, CodingKey {
        case chatId, title, deleted, input, output, cacheRead, cacheWrite, runs, equivalentUsd, costUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        title = c.str(.title)
        deleted = c.bool(.deleted)
        input = c.int(.input)
        output = c.int(.output)
        cacheRead = c.int(.cacheRead)
        cacheWrite = c.int(.cacheWrite)
        runs = c.int(.runs)
        equivalentUsd = c.dblOpt(.equivalentUsd)
        costUsd = c.dblOpt(.costUsd)
    }
}

/// A row in `background`: one role's oneshot calls (`UsageContract.onceRoles`).
struct UsageBackground: Decodable, Identifiable, Sendable {
    var id: String { role }
    var role: String
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var runs: Int
    var equivalentUsd: Double?
    var costUsd: Double?

    enum CodingKeys: String, CodingKey { case role, input, output, cacheRead, cacheWrite, runs, equivalentUsd, costUsd }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = c.str(.role)
        input = c.int(.input)
        output = c.int(.output)
        cacheRead = c.int(.cacheRead)
        cacheWrite = c.int(.cacheWrite)
        runs = c.int(.runs)
        equivalentUsd = c.dblOpt(.equivalentUsd)
        costUsd = c.dblOpt(.costUsd)
    }
}

/// The subagents' share. The contract names only the field's NAME, not its shape — so the two obvious ones are read: a
/// number (share 0…1, above 1 as a percentage) or an object with `share`/`percent` and/or `output` (the subagents'
/// output tokens). Anything matching neither is `nil` — the row is then absent instead of claiming "0 %".
struct UsageSubagentsShare: Decodable, Sendable {
    /// Share of the output, 0…1.
    var share: Double?
    /// Output tokens of the subagents.
    var output: Int?

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        if let count = try? decoder.singleValueContainer().decode(Double.self) {
            share = UsageSubagentsShare.clamp(count)
            return
        }
        let c = try decoder.container(keyedBy: Key.self)
        let read = { (name: String) -> Double? in (try? c.decodeIfPresent(Double.self, forKey: Key(stringValue: name))) ?? nil }
        share = (read("share") ?? read("percent")).flatMap(UsageSubagentsShare.clamp)
        output = read("output").map { Int($0) }
        if share == nil && output == nil {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "subagentsShare without a readable form"))
        }
    }

    private static func clamp(_ count: Double) -> Double? {
        guard count.isFinite, count >= 0 else { return nil }
        return count > 1 ? min(1, count / 100) : count
    }
}

/// `GET /api/usage/consumption?provider=&window=`. `from`/`until` set ⇒ the page says "since …".
struct UsageConsumption: Decodable, Sendable {
    var provider: String
    var window: String
    var from: Date?
    var until: Date?
    /// `false`: no snapshot — the window slides (label "Last 5 hrs"/"Last 7 days").
    var windowKnown: Bool
    var sums: UsageSums?
    var models: [UsageModel]
    var chats: [UsageChat]
    /// How many chats the list does NOT show — never truncate silently.
    var chatsAdditional: Int
    var background: [UsageBackground]
    var subagentsShare: UsageSubagentsShare?

    enum CodingKeys: String, CodingKey {
        case provider, window, from, until, windowKnown, sums, models, chats, chatsAdditional, background, subagentsShare
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        window = c.str(.window)
        from = c.moment(.from)
        until = c.moment(.until)
        // If the field is missing, the window counts as NOT known — "current" would be a claim.
        windowKnown = c.bool(.windowKnown)
        sums = (try? c.decodeIfPresent(UsageSums.self, forKey: .sums)) ?? nil
        models = c.list(.models, UsageModel.self)
        chats = c.list(.chats, UsageChat.self)
        chatsAdditional = c.int(.chatsAdditional)
        background = c.list(.background, UsageBackground.self)
        subagentsShare = (try? c.decodeIfPresent(UsageSubagentsShare.self, forKey: .subagentsShare)) ?? nil
    }

    /// The subagents' share of the output (0…1) — from the share itself or from their output against the sum.
    var subagentsQuote: Double? {
        if let a = subagentsShare?.share { return a }
        if let sub = subagentsShare?.output, let total = sums?.output, total > 0 { return min(1, Double(sub) / Double(total)) }
        return nil
    }
}

// ── GET /api/usage/history ──────────────────────────────────────────────────

/// A day (calendar day in the device's time zone), `day` as "YYYY-MM-DD".
struct UsagePoint: Decodable, Identifiable, Sendable {
    var id: String { day }
    var day: String
    var input: Int
    var output: Int
    var cacheRead: Int
    var cacheWrite: Int
    var equivalentUsd: Double?
    var costUsd: Double?

    enum CodingKeys: String, CodingKey { case day, input, output, cacheRead, cacheWrite, equivalentUsd, costUsd }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = c.str(.day)
        input = c.int(.input)
        output = c.int(.output)
        cacheRead = c.int(.cacheRead)
        cacheWrite = c.int(.cacheWrite)
        equivalentUsd = c.dblOpt(.equivalentUsd)
        costUsd = c.dblOpt(.costUsd)
    }
}

/// `GET /api/usage/history?provider=&days=&offsetMin=` — gapless, oldest day first.
struct UsageHistory: Decodable, Sendable {
    var provider: String
    var days: Int
    var offsetMin: Int
    var points: [UsagePoint]

    enum CodingKeys: String, CodingKey { case provider, days, offsetMin, points }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        days = c.int(.days)
        offsetMin = c.int(.offsetMin)
        points = c.list(.points, UsagePoint.self)
    }
}

// ── GET /api/usage/claude-limits ────────────────────────────────────────────

/// A window of the latest Claude snapshot: `id` as in limits.js (session, weekly_all, weekly_opus, …), `group`
/// (session · weekly · credits · spend), `area` = model name or "" for all.
struct ClaudeLimitWindow: Decodable, Identifiable, Sendable {
    var id: String
    var group: String
    var area: String
    /// Used up in percent; `nil` = the snapshot gives no value.
    var percent: Double?
    var resetsAt: Date?

    enum CodingKeys: String, CodingKey { case id, group, area, percent, resetsAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        group = c.str(.group)
        area = c.str(.area)
        percent = c.dblOpt(.percent)
        resetsAt = c.moment(.resetsAt)
    }

    /// The label — the same mapping as the rings: credits and spend limit have no time window, a model-specific limit
    /// carries its model name.
    var title: String {
        if group == "credits" { return L("Credits") }
        if group == "spend" { return L("Spend limit") }
        if !area.isEmpty { return L("{name} limit", ["name": area]) }
        return group == "weekly" ? L("7-day limit") : L("5-hour limit")
    }
}

/// All windows of the LATEST snapshot — read from the server's store, no call to the provider.
struct ClaudeLimits: Decodable, Sendable {
    /// When measured; `nil` = never.
    var measuredAt: Date?
    var window: [ClaudeLimitWindow]

    enum CodingKeys: String, CodingKey { case measuredAt, window }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        measuredAt = c.moment(.measuredAt)
        window = c.list(.window, ClaudeLimitWindow.self)
    }
}

// ── GET /api/usage/openrouter-credit ──────────────────────────────────────

/// Live from OpenRouter (cached for 60 s). `known == false` ⇒ all numbers `nil` (never 0).
struct OpenRouterCredit: Decodable, Sendable {
    var known: Bool
    var totalUsd: Double?
    var consumedUsd: Double?
    var restUsd: Double?
    var keyLimitUsd: Double?
    var keyRestUsd: Double?
    var at: Date?

    enum CodingKeys: String, CodingKey { case known, totalUsd, consumedUsd, restUsd, keyLimitUsd, keyRestUsd, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        known = c.bool(.known)
        // Unknown means unknown: a number sent along does not count either.
        totalUsd = known ? c.dblOpt(.totalUsd) : nil
        consumedUsd = known ? c.dblOpt(.consumedUsd) : nil
        restUsd = known ? c.dblOpt(.restUsd) : nil
        keyLimitUsd = known ? c.dblOpt(.keyLimitUsd) : nil
        keyRestUsd = known ? c.dblOpt(.keyRestUsd) : nil
        at = c.moment(.at)
    }
}

// ── GET/PUT/DELETE /api/openrouter ──────────────────────────────────────────

/// The access to OpenRouter as the server shows it — the key itself never leaves the server. Throws as soon as one of the
/// three keys is missing: a missing switch read as "off" would go out as "off" on the next save.
struct OpenRouterAccess: Decodable, Equatable, Sendable {
    var keySet: Bool
    var onlyWithoutSaving: Bool
    var noDataUsage: Bool

    enum CodingKeys: String, CodingKey { case keySet, onlyWithoutSaving, noDataUsage }

    init(keySet: Bool, onlyWithoutSaving: Bool, noDataUsage: Bool) {
        self.keySet = keySet
        self.onlyWithoutSaving = onlyWithoutSaving
        self.noDataUsage = noDataUsage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keySet = try c.decode(Bool.self, forKey: .keySet)
        onlyWithoutSaving = try c.decode(Bool.self, forKey: .onlyWithoutSaving)
        noDataUsage = try c.decode(Bool.self, forKey: .noDataUsage)
    }
}

/// The body of `PUT /api/openrouter`: BOTH switches always (`encode`, never `encodeIfPresent` — a missing one is 400),
/// `apiKey` only if a new one was typed (if absent, the stored one stays; an empty string would be 400 and therefore
/// never goes out).
struct OpenRouterAccessBody: Encodable, Sendable {
    let onlyWithoutSaving: Bool
    let noDataUsage: Bool
    let apiKey: String?

    enum CodingKeys: String, CodingKey { case onlyWithoutSaving, noDataUsage, apiKey }

    init(onlyWithoutSaving: Bool, noDataUsage: Bool, apiKey: String? = nil) {
        self.onlyWithoutSaving = onlyWithoutSaving
        self.noDataUsage = noDataUsage
        let key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.apiKey = key.isEmpty ? nil : key
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(onlyWithoutSaving, forKey: .onlyWithoutSaving)
        try c.encode(noDataUsage, forKey: .noDataUsage)
        try c.encodeIfPresent(apiKey, forKey: .apiKey)
    }
}

// ── Prices per provider behind OpenRouter (GET /api/usage/openrouter-prices) ──
// Display ONLY: per model the span per 1M tokens (USD) across the active providers and the price of the provider of the
// latest response. `known == false` means "not retrievable" — unknown, never 0.
struct PriceSpan: Codable, Hashable, Sendable {
    var inMin: Double
    var inMax: Double
    var outMin: Double
    var outMax: Double
}

struct ModelPrices: Codable, Hashable, Sendable {
    var provider: String
    var model: String
    var upstream: String
    var known: Bool
    var span: PriceSpan?
    var last: PriceSpan?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        model = c.str(.model)
        upstream = c.str(.upstream)
        known = c.bool(.known)
        span = (try? c.decodeIfPresent(PriceSpan.self, forKey: .span)) ?? nil
        last = (try? c.decodeIfPresent(PriceSpan.self, forKey: .last)) ?? nil
    }
}

struct OpenRouterPrices: Codable, Sendable {
    var models: [ModelPrices]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        models = c.list(.models, ModelPrices.self)
    }
}

// ── Routes ──────────────────────────────────────────────────────────────────
// Paths unencoded, the values as query: `makeURL` encodes itself.

extension APIClient {
    func loadConsumption(provider: String, window: String) async throws -> UsageConsumption {
        try await get("/api/usage/consumption", query: [
            URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "window", value: window),
        ], timeout: 20)
    }

    /// `offsetMin` = minutes east of UTC (the days are calendar days in the device's time zone).
    func loadHistory(provider: String, days: Int = 30) async throws -> UsageHistory {
        let offsetMin = TimeZone.current.secondsFromGMT() / 60
        return try await get("/api/usage/history", query: [
            URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "days", value: String(days)),
            URLQueryItem(name: "offsetMin", value: String(offsetMin)),
        ], timeout: 20)
    }

    func loadClaudeLimits() async throws -> ClaudeLimits {
        try await get("/api/usage/claude-limits", timeout: 20)
    }

    func loadOpenRouterCredit() async throws -> OpenRouterCredit {
        try await get("/api/usage/openrouter-credit", timeout: 20)
    }

    func loadOpenRouterAccess() async throws -> OpenRouterAccess {
        try await get("/api/openrouter", timeout: 20)
    }

    /// Saves and then re-reads the state — the PUT's response is not fixed by the contract, the GET is.
    func setOpenRouterAccess(_ body: OpenRouterAccessBody) async throws -> OpenRouterAccess {
        try await send("/api/openrouter", method: .put, body: body)
        return try await loadOpenRouterAccess()
    }

    /// Removes the key (the card stays, the provider is then "not connected").
    func removeOpenRouterKey() async throws -> OpenRouterAccess {
        try await send("/api/openrouter", method: .delete)
        return try await loadOpenRouterAccess()
    }

    func loadOpenRouterPrices() async throws -> OpenRouterPrices {
        try await get("/api/usage/openrouter-prices", timeout: 20)
    }
}
