import Foundation

// Coding main agents write skills: history per skill with undo, deletion requests from agents, the "Recently deleted" list and
// the per-workspace switch. The shapes are read TOLERANTLY (`Models/DecodeHelpers.swift`): an older server does not send the
// new fields, and a synthesized `Decodable` would require every key. A missing field claims nothing: without `revertible`
// there is no undo button, without `agentsWrite` no switch (unknown is not "off").

/// Who made a change (`who`). Unknown values stay unknown; they do not become the human.
enum SkillActor: String, Hashable, Sendable {
    case human
    case agent
}

/// The most recent history entry of a skill that was not reverted, as the lists carry it (`lastChange`).
struct SkillLastChange: Decodable, Hashable, Sendable {
    let who: SkillActor?
    let chatId: String?
    let chatTitle: String?
    /// Milliseconds since 1970, like every point in time from the server.
    let at: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        who = c.strOpt(.who).flatMap(SkillActor.init(rawValue:))
        chatId = c.strOpt(.chatId)
        chatTitle = c.strOpt(.chatTitle)
        at = c.dblOpt(.at)
    }

    enum CodingKeys: String, CodingKey { case who, chatId, chatTitle, at }
}

/// An open deletion request on a skill, short (`openRequest`); `APIClient.skillRequest` fetches the whole.
struct SkillOpenRequest: Decodable, Hashable, Sendable {
    let id: String
    let chatTitle: String?
    let at: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        chatTitle = c.strOpt(.chatTitle)
        at = c.dblOpt(.at)
    }

    enum CodingKeys: String, CodingKey { case id, chatTitle, at }
}

/// A state of a skill in the history (`prior`/`after`). Arrives as an object, or as a JSON string if the server passes the
/// column through raw; both are read.
struct SkillState: Decodable, Hashable, Sendable {
    let name: String
    let description: String
    let body: String
    let version: String?
    let hasResources: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        description = c.str(.description)
        body = c.str(.body)
        version = c.strOpt(.version)
        hasResources = c.bool(.hasResources)
    }

    enum CodingKeys: String, CodingKey { case name, description, body, version, hasResources }

    /// Object or JSON string; anything else (null, missing) is no state.
    static func read<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> SkillState? {
        if let snapshot = (try? c.decodeIfPresent(SkillState.self, forKey: key)) ?? nil { return snapshot }
        guard let text = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(SkillState.self, from: data)
    }
}

/// An entry in the history. The server computes `revertible`; the client never guesses it.
struct SkillHistoryEntry: Decodable, Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable { case create, change, erase }

    let id: String
    let skillId: String
    let workspaceId: String
    let projectId: String?
    let projectName: String?
    let kind: Kind?
    let who: SkillActor?
    let chatId: String?
    let chatTitle: String?
    let prior: SkillState?
    let after: SkillState?
    let trash: Bool
    let requestId: String?
    let at: Double?
    let revertedAt: Double?
    let revertible: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        skillId = c.str(.skillId)
        workspaceId = c.str(.workspaceId)
        projectId = c.strOpt(.projectId)
        projectName = c.strOpt(.projectName)
        kind = c.strOpt(.kind).flatMap(Kind.init(rawValue:))
        who = c.strOpt(.who).flatMap(SkillActor.init(rawValue:))
        chatId = c.strOpt(.chatId)
        chatTitle = c.strOpt(.chatTitle)
        prior = SkillState.read(c, .prior)
        after = SkillState.read(c, .after)
        trash = c.bool(.trash) || c.int(.trash) == 1
        requestId = c.strOpt(.requestId)
        at = c.dblOpt(.at)
        revertedAt = c.dblOpt(.revertedAt)
        revertible = c.bool(.revertible)
    }

    enum CodingKeys: String, CodingKey {
        case id, skillId, workspaceId, projectId, projectName, kind, who, chatId, chatTitle, prior, after, trash, requestId, at
        case revertedAt, revertible
    }

    /// The name the entry is listed under: the old one after a deletion, otherwise the new one.
    var skillName: String { after?.name ?? prior?.name ?? "" }
}

/// A deletion request. `current` = the skill exists and still has the requested version.
struct SkillRequest: Decodable, Identifiable, Hashable, Sendable {
    enum Status: String, Sendable { case open, approved, rejected, expired }

    let id: String
    let skillId: String
    let skillName: String
    let workspaceId: String
    let projectId: String?
    let version: String
    let chatId: String?
    let chatTitle: String?
    let reason: String?
    /// nil = the server named no known status; then there are no buttons either.
    let status: Status?
    let at: Double?
    let decidedAt: Double?
    let current: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        skillId = c.str(.skillId)
        skillName = c.str(.skillName, "Skill")
        workspaceId = c.str(.workspaceId)
        projectId = c.strOpt(.projectId)
        version = c.str(.version)
        chatId = c.strOpt(.chatId)
        chatTitle = c.strOpt(.chatTitle)
        reason = c.strOpt(.reason)
        status = c.strOpt(.status).flatMap(Status.init(rawValue:))
        at = c.dblOpt(.at)
        decidedAt = c.dblOpt(.decidedAt)
        current = c.bool(.current)
    }

    enum CodingKeys: String, CodingKey {
        case id, skillId, skillName, workspaceId, projectId, version, chatId, chatTitle, reason, status, at, decidedAt, current
    }
}

private struct SkillHistoryList: Decodable {
    let entries: [SkillHistoryEntry]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = c.list(.entries, SkillHistoryEntry.self)
    }
    enum CodingKeys: String, CodingKey { case entries }
}

private struct SkillRequestList: Decodable {
    let requests: [SkillRequest]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requests = c.list(.requests, SkillRequest.self)
    }
    enum CodingKeys: String, CodingKey { case requests }
}

/// `GET/PUT …/skill-settings`: `nil` means the response does not say (older server); the switch stays hidden.
struct SkillSettings: Decodable, Hashable, Sendable {
    let agentsWrite: Bool?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentsWrite = c.boolOpt(.agentsWrite)
    }
    enum CodingKeys: String, CodingKey { case agentsWrite }
}

private struct SkillRulingResponse: Decodable {
    let request: SkillRequest?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        request = (try? c.decodeIfPresent(SkillRequest.self, forKey: .request)) ?? nil
    }
    enum CodingKeys: String, CodingKey { case request }
}

/// The result of `cbase_skill_write` in the tool block, read from the MCP server's result text (the route's JSON, indented;
/// a fence note may follow it; the first complete object is read).
struct SkillWriteResult: Hashable, Sendable {
    enum Kind: Hashable, Sendable { case created, changed, unchanged, requested }

    let kind: Kind
    let skillId: String?
    let name: String
    let historyId: String?
    let requestId: String?
    let merged: Bool

    /// nil = no success (error text, no JSON); the block then shows only its ordinary row.
    static func from(result: String?, action: String?, inputName: String?) -> SkillWriteResult? {
        guard let result, let json = firstObject(result), json["ok"]?.boolValue == true else { return nil }
        let skill = json["skill"]
        let name = skill?["name"]?.stringValue ?? inputName ?? ""
        if json["requested"]?.boolValue == true {
            guard let requestId = json["requestId"]?.stringValue, !requestId.isEmpty else { return nil }
            return SkillWriteResult(
                kind: .requested, skillId: skill?["id"]?.stringValue, name: name, historyId: nil, requestId: requestId,
                merged: json["merged"]?.boolValue == true
            )
        }
        let kind: Kind
        if json["unchanged"]?.boolValue == true { kind = .unchanged }
        else if action == "create" { kind = .created }
        else { kind = .changed }
        return SkillWriteResult(
            kind: kind, skillId: skill?["id"]?.stringValue, name: name, historyId: json["historyId"]?.stringValue, requestId: nil,
            merged: false
        )
    }

    /// The first balanced `{…}` in the text; strings including escapes are skipped.
    private static func firstObject(_ text: String) -> JSONValue? {
        let character = Array(text.utf8)
        guard let start = character.firstIndex(of: UInt8(ascii: "{")) else { return nil }
        var depth = 0
        var inText = false
        var escape = false
        for i in start..<character.count {
            let z = character[i]
            if inText {
                if escape { escape = false } else if z == UInt8(ascii: "\\") { escape = true } else if z == UInt8(ascii: "\"") { inText = false }
                continue
            }
            if z == UInt8(ascii: "\"") { inText = true }
            else if z == UInt8(ascii: "{") { depth += 1 }
            else if z == UInt8(ascii: "}") {
                depth -= 1
                if depth == 0 {
                    return try? JSONDecoder().decode(JSONValue.self, from: Data(character[start...i]))
                }
            }
        }
        return nil
    }
}

/// Is this tool name `cbase_skill_write`, with or without the `mcp__<server>__` prefix (Claude and Codex name it
/// differently)?
func isSkillWrite(_ toolName: String?) -> Bool {
    guard let toolName else { return false }
    return toolName == "cbase_skill_write" || toolName.hasSuffix("__cbase_skill_write")
}

// ── Event ───────────────────────────────────────────────────────────
// `{ type: "skills", workspaceId, … }` in the global stream (`AppState.handleGlobalEvent`). A shared counter of its own instead
// of a field on `AppState`: the cards in the chat live in UIHostingConfiguration cells, which do not inherit
// `EnvironmentObject`s (`Chat/ChatEnvironment.swift`); they observe this counter directly, and so does the skill page.
// ONE path for both.
@MainActor
final class SkillEvents: ObservableObject {
    static let shared = SkillEvents()
    /// Per workspace: how often a skill event arrived. Views attach `onChange` to its value.
    @Published private(set) var revisions: [String: Int] = [:]

    func report(workspaceId: String) {
        revisions[workspaceId, default: 0] &+= 1
    }

    func counter(_ workspaceId: String) -> Int { revisions[workspaceId] ?? 0 }
}

// ── Error texts ─────────────────────────────────────────────────────────────

/// The message of a server error plus what the body adds: on 409 `references` the agent definitions that carry the skill,
/// on `existing` the skill that already has the name. Visible in the view, never silent.
func skillErrorText(_ error: Error) -> String {
    guard let api = error as? APIError else { return error.localizedDescription }
    var text = api.message
    if let references = api.body?["references"]?.arrayValue, !references.isEmpty {
        let names = references.compactMap { $0["name"]?.stringValue }.filter { !$0.isEmpty }
        if !names.isEmpty { text += " (" + L("used by: {names}", ["names": names.joined(separator: ", ")]) + ")" }
    }
    if let existing = api.body?["existing"]?["name"]?.stringValue, !existing.isEmpty, !text.contains(existing) {
        text += " (" + L("existing: {name}", ["name": existing]) + ")"
    }
    return text
}

/// "3 min ago": the same keys as the agenda (`Agenda.sinceText`, table `Kit/LocDEAgenda.swift`).
func skillWhen(_ ms: Double?) -> String? {
    guard let s = Agenda.sinceText(ms, now: Date().timeIntervalSince1970 * 1000) else { return nil }
    return L(s.key, ["n": s.n])
}

/// "changed by agent · <chat title> · <time>", only for `who: agent`, otherwise nil.
func skillAgentRow(_ a: SkillLastChange?) -> String? {
    guard let a, a.who == .agent else { return nil }
    let title = (a.chatTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let when = skillWhen(a.at) ?? ""
    switch (title.isEmpty, when.isEmpty) {
    case (false, false): return L("changed by agent · {chat} · {when}", ["chat": title, "when": when])
    case (false, true): return L("changed by agent · {chat}", ["chat": title])
    case (true, false): return L("changed by agent · {when}", ["when": when])
    case (true, true): return L("changed by agent")
    }
}

// ── The paths ─────────────────────────────────────────────────────────
// Identifiers go RAW into the path; `APIClient.makeURL` encodes itself.
extension APIClient {
    func skillHistory(workspaceId: String, skillId: String, limit: Int = 50) async throws -> [SkillHistoryEntry] {
        let response: SkillHistoryList = try await get(
            "/api/workspaces/\(workspaceId)/skill-history",
            query: [URLQueryItem(name: "skillId", value: skillId), URLQueryItem(name: "limit", value: String(limit))]
        )
        return response.entries
    }

    func skillDeleted(workspaceId: String) async throws -> [SkillHistoryEntry] {
        let response: SkillHistoryList = try await get("/api/workspaces/\(workspaceId)/skill-deleted")
        return response.entries
    }

    /// Undo (or "Restore" on a deletion entry). 409 arrives as an `APIError` with a body; see `skillErrorText`.
    func revertSkill(entryId: String) async throws {
        try await send("/api/skill-history/\(entryId)/revert", method: .post, body: [String: String]())
    }

    func skillRequests(workspaceId: String, status: String = "open") async throws -> [SkillRequest] {
        let response: SkillRequestList = try await get(
            "/api/workspaces/\(workspaceId)/skill-requests", query: [URLQueryItem(name: "status", value: status)]
        )
        return response.requests
    }

    func skillRequest(id: String) async throws -> SkillRequest {
        try await get("/api/skill-requests/\(id)")
    }

    /// Approve or reject; the response carries the request after the decision (nil on a server that does not name it).
    func decideSkillRequest(id: String, approve: Bool) async throws -> SkillRequest? {
        struct Body: Encodable { let approve: Bool }
        let response: SkillRulingResponse = try await post("/api/skill-requests/\(id)/decide", body: Body(approve: approve))
        return response.request
    }

    func skillSettings(workspaceId: String) async throws -> SkillSettings {
        try await get("/api/workspaces/\(workspaceId)/skill-settings")
    }

    func setSkillSettings(workspaceId: String, agentsWrite: Bool) async throws -> SkillSettings {
        struct Body: Encodable { let agentsWrite: Bool }
        return try await put("/api/workspaces/\(workspaceId)/skill-settings", body: Body(agentsWrite: agentsWrite))
    }
}
