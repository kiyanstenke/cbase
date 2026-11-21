import Foundation

// ── Scheduled jobs ───────────────────────────────────────────────────────────
// The shapes of the routes in `server/backend/electron/server/scheduled/routes.js` (`/api/workspaces/:ws/scheduled…`) and of the
// `job` field on every row of `GET /api/chats` (`scheduled/chat-field.js`). A job hangs on EXACTLY one coding chat: name, project,
// instance, provider, model, effort level, permission mode and notification choice live on the CHAT and change via
// `PATCH /api/chats/:id`; the job carries instructions, cadence and status. Web counterpart: `web/src/lib/api/scheduled.ts`.
//
// All decoders are hand-written and tolerant (`c.str`, `c.dblOpt` …): a missing field from an older server does not make the
// list unreadable. The request bodies encode synthesized, so a `nil` is omitted, and for the PATCH a missing field means
// "unchanged"; the POST requires `cadence`, `plan`, `instructions` and `permissionMode` and always gets them.

/// The lists of the contract `server/backend/electron/server/scheduled/contract.js`, verbatim and in the same order. Bound in
/// `web/test/scheduled-binding.test.mjs`: whoever changes a line there updates it here.
enum ScheduledContract {
    static let cadences = ["oneTime", "daily", "workdays", "weekly", "monthly"]
    /// Monthly only on days 1–28.
    static let dayOfMonth = 1...28
    /// Weekdays as in cron: 0 = Sunday … 6 = Saturday.
    static let weekday = 0...6
    static let jobStatus = ["active", "paused", "done"]
    static let runCauses = ["tick", "hand", "caughtUp", "repetition"]
    static let runStatus = ["open", "ok", "error", "aborted", "missed", "failed", "dismissed"]
    /// The derived state (computed, never stored); `nil` means "none of these".
    static let states = ["queued", "running", "parked"]
    static let instructionsMax = 20_000
}

/// The form of the repetition. The old schedule's hourly and cron forms no longer exist.
enum ScheduledCadence: String, CaseIterable, Identifiable, Sendable {
    case oneTime
    case daily
    case workdays
    case weekly
    case monthly

    var id: String { rawValue }

    /// English key for `L`; the same words as the web dialog.
    var displayLabel: String {
        switch self {
        case .oneTime: return "Once"
        case .daily: return "Daily"
        case .workdays: return "Weekdays"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        }
    }
}

/// The plan of a form: `{at}` (ms) for one-time, otherwise `{clockTime}` (HH:MM); weekly adds `days`, monthly `day` (day of month).
struct ScheduledPlan: Codable, Hashable, Sendable {
    var at: Double? = nil
    var clockTime: String? = nil
    var days: [Int]? = nil
    var day: Int? = nil

    init(at: Double? = nil, clockTime: String? = nil, days: [Int]? = nil, day: Int? = nil) {
        self.at = at; self.clockTime = clockTime; self.days = days; self.day = day
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.dblOpt(.at)
        clockTime = c.strOpt(.clockTime)
        days = (try? c.decodeIfPresent([Int].self, forKey: .days)) ?? nil
        day = c.intOpt(.day)
    }
}

/// A run (contract.js RUN_FIELDS). `id` is a number (AUTOINCREMENT), `question` a boolean.
struct ScheduledRun: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let jobId: String
    let workspaceId: String
    let chatId: String
    let cause: String
    let scheduledAt: Double
    let queuedAt: Double
    let startedAt: Double
    let endedAt: Double
    let status: String
    let error: String
    let short: String
    let question: Bool

    enum CodingKeys: String, CodingKey {
        case id, jobId, workspaceId, chatId, cause, scheduledAt, queuedAt, startedAt, endedAt, status, error, short, question
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        jobId = c.str(.jobId)
        workspaceId = c.str(.workspaceId)
        chatId = c.str(.chatId)
        cause = c.str(.cause, "tick")
        scheduledAt = c.dbl(.scheduledAt)
        queuedAt = c.dbl(.queuedAt)
        startedAt = c.dbl(.startedAt)
        endedAt = c.dbl(.endedAt)
        status = c.str(.status, "open")
        error = c.str(.error)
        short = c.str(.short)
        question = c.bool(.question)
    }
}

/// A job in responses (contract.js JOB_FIELDS + JOB_DERIVED).
struct ScheduledJob: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let workspaceId: String
    /// `nil` only in a race (the chat is being deleted); the UI then does not offer "To chat".
    let chatId: String?
    let instructions: String
    let cadence: String
    let plan: ScheduledPlan
    let timeZone: String
    let status: String
    let nextAt: Double
    let retryAt: Double
    let lastRunAt: Double
    let lastStatus: String
    let lastError: String
    let createdAt: Double
    let updatedAt: Double
    let name: String
    let projectId: String?
    /// The cadence in plain text, translated by the server ("Weekdays at 22:00").
    let cadenceText: String
    let state: String?
    let lastRun: ScheduledRun?

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, chatId, instructions, cadence, plan, timeZone, status, nextAt, retryAt, lastRunAt, lastStatus, lastError
        case createdAt, updatedAt, name, projectId, cadenceText, state, lastRun
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        workspaceId = c.str(.workspaceId)
        chatId = c.strOpt(.chatId)
        instructions = c.str(.instructions)
        cadence = c.str(.cadence)
        plan = ((try? c.decodeIfPresent(ScheduledPlan.self, forKey: .plan)) ?? nil) ?? ScheduledPlan()
        timeZone = c.str(.timeZone, "UTC")
        status = c.str(.status, "active")
        nextAt = c.dbl(.nextAt)
        retryAt = c.dbl(.retryAt)
        lastRunAt = c.dbl(.lastRunAt)
        lastStatus = c.str(.lastStatus)
        lastError = c.str(.lastError)
        createdAt = c.dbl(.createdAt)
        updatedAt = c.dbl(.updatedAt)
        name = c.str(.name)
        projectId = c.strOpt(.projectId)
        cadenceText = c.str(.cadenceText)
        state = c.strOpt(.state)
        lastRun = (try? c.decodeIfPresent(ScheduledRun.self, forKey: .lastRun)) ?? nil
    }

    var form: ScheduledCadence? { ScheduledCadence(rawValue: cadence) }
    /// The next moment something happens: a retry after an error takes precedence over the occurrence.
    var nextEventAt: Double { retryAt > 0 && (nextAt <= 0 || retryAt < nextAt) ? retryAt : nextAt }
}

/// The `job` field on a row of `GET /api/chats` (contract.js CHAT_JOB_FIELDS): the clock in the chat list.
struct ChatJob: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let status: String
    let nextAt: Double

    init(id: String, name: String, status: String, nextAt: Double) {
        self.id = id; self.name = name; self.status = status; self.nextAt = nextAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name)
        status = c.str(.status, "active")
        nextAt = c.dbl(.nextAt)
    }
}

/// `GET …/scheduled`: the list and the server's clock (`now`, ms).
struct ScheduledList: Decodable, Sendable {
    let items: [ScheduledJob]
    let now: Double

    enum CodingKeys: String, CodingKey { case items, now }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, ScheduledJob.self)
        now = c.dbl(.now)
    }
}

/// `GET …/scheduled/:id/runs`: newest first; `next` is the id of the last one (0 = no more).
struct ScheduledRuns: Decodable, Sendable {
    let items: [ScheduledRun]
    let next: Int

    enum CodingKeys: String, CodingKey { case items, next }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, ScheduledRun.self)
        next = c.int(.next)
    }
}

/// `POST …/scheduled` answers `{job, chat}`, `POST …/scheduled/:id/run` answers `{run, job}`.
struct ScheduledCreationResponse: Decodable, Sendable {
    let job: ScheduledJob
    let chat: Chat?
}

struct ScheduledRunResponse: Decodable, Sendable {
    let job: ScheduledJob
}

/// The body of `POST …/scheduled`: the job's values and the chat's (normalized like `POST /api/chats`, except that a missing or
/// unknown permission mode is a 400 here). Empty `name` ⇒ the server takes the first line of the instructions.
struct ScheduledCreation: Encodable, Sendable {
    var instructions: String
    var cadence: String
    var plan: ScheduledPlan
    var name: String? = nil
    var timeZone: String? = nil
    var projectId: String? = nil
    var provider: String? = nil
    var model: String? = nil
    var effort: String? = nil
    var ultracode: Bool? = nil
    var permissionMode: String
    var notify: [String: String]? = nil
}

/// The body of `PATCH …/scheduled/:id` (contract.js PATCH_FIELDS): only set fields are sent.
struct ScheduledChange: Encodable, Sendable {
    var instructions: String? = nil
    var cadence: String? = nil
    var plan: ScheduledPlan? = nil
    var timeZone: String? = nil
    var status: String? = nil
}

/// A job's time zone versus the device's: the cadence ("Daily at 08:00") applies in the job's zone, the next occurrence is shown
/// in the device's. If they differ, the sheet and dialog name it (web: `lib/scheduled.ts:foreignZone`). A new job gets the
/// device's zone (`ScheduledCreation.timeZone`).
enum ScheduledZone {
    static func foreign(_ zone: String, own: String = TimeZone.current.identifier) -> String? {
        let z = zone.trimmingCharacters(in: .whitespaces)
        return z.isEmpty || z == own ? nil : z
    }
}

/// The words for states and causes: ONE place for list, detail and runs.
enum ScheduledWord {
    static func status(_ s: String) -> String {
        switch s {
        case "active": return L("Active")
        case "paused": return L("Paused")
        case "done": return L("Done")
        default: return s
        }
    }

    static func state(_ z: String?) -> String? {
        switch z {
        case "queued": return L("Queued")
        case "running": return L("Running")
        case "parked": return L("Parked at the limit")
        default: return nil
        }
    }

    static func runStatus(_ s: String) -> String {
        switch s {
        case "open": return L("Open##state")
        case "ok": return L("Succeeded")
        case "error": return L("Error")
        case "aborted": return L("Canceled")
        case "missed": return L("Missed")
        case "failed": return L("Skipped")
        case "dismissed": return L("Discarded")
        default: return s
        }
    }

    static func cause(_ a: String) -> String {
        switch a {
        case "tick": return L("Date")
        case "hand": return L("By hand")
        case "caughtUp": return L("Caught up")
        case "repetition": return L("retry")
        default: return a
        }
    }

    /// An occurrence in short form, as in the chat list: today only the time, tomorrow "tomorrow 08:00", within the next six days
    /// the weekday, otherwise the date. 0 = no occurrence.
    static func occurrence(_ ms: Double, now: Date = Date()) -> String {
        guard ms > 0 else { return L("no date") }
        let date = locDate(fromServer: ms)
        let calendar = Calendar.current
        let clock = DateFormatter()
        clock.locale = Loc.locale
        clock.setLocalizedDateFormatFromTemplate("HH:mm")
        let time = clock.string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return L("tomorrow {time}", ["time": time])
        }
        let format = DateFormatter()
        format.locale = Loc.locale
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 99
        format.setLocalizedDateFormatFromTemplate(days > 0 && days < 7 ? "EEE HH:mm" : "d MMM HH:mm")
        return format.string(from: date)
    }

    /// The clock on the chat row: the next occurrence; paused or done as a word.
    static func clock(_ a: ChatJob) -> String {
        switch a.status {
        case "paused": return L("Paused")
        case "done": return L("Done")
        default: return occurrence(a.nextAt)
        }
    }
}

/// The paths of the routes in `scheduled/routes.js`. Ids UNENCODED; `APIClient.makeURL` encodes the path itself.
extension APIClient {
    private func scheduledPath(_ workspaceId: String, _ rest: String = "") -> String { "/api/workspaces/\(workspaceId)/scheduled\(rest)" }

    func scheduledJobs(workspaceId: String, projectId: String?) async throws -> ScheduledList {
        try await get(scheduledPath(workspaceId), query: projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? [])
    }

    func createScheduled(workspaceId: String, _ body: ScheduledCreation) async throws -> ScheduledCreationResponse {
        try await post(scheduledPath(workspaceId), body: body)
    }

    func changeScheduled(workspaceId: String, id: String, _ body: ScheduledChange) async throws -> ScheduledJob {
        try await patch(scheduledPath(workspaceId, "/\(id)"), body: body)
    }

    func deleteScheduled(workspaceId: String, id: String) async throws {
        let _: OKResponse = try await delete(scheduledPath(workspaceId, "/\(id)"))
    }

    func scheduledNow(workspaceId: String, id: String) async throws -> ScheduledJob {
        let response: ScheduledRunResponse = try await post(scheduledPath(workspaceId, "/\(id)/run"))
        return response.job
    }

    func scheduledRuns(workspaceId: String, id: String, before: Int = 0) async throws -> ScheduledRuns {
        var query = [URLQueryItem(name: "limit", value: "20")]
        if before > 0 { query.append(URLQueryItem(name: "before", value: String(before))) }
        return try await get(scheduledPath(workspaceId, "/\(id)/runs"), query: query)
    }
}
