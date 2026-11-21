import Foundation

// Skills live in coding only: per workspace and per project (`Code/SkillsPane.swift`). Every skill belongs to exactly one
// area, and a workspace skill applies in every project until it is hidden there (like credentials).
//
// The shapes follow the contract and are read TOLERANTLY: a synthesized `Decodable` would demand every key, yet the lists
// differ in scope per route (`hiddenIn` only on workspace coding skills, `enabled` only in the project view of workspace
// skills). A missing field must not make the whole list unreadable, but it must not ASSERT anything either: without
// `area` an entry belongs to no list, without `enabled` the state is unknown (not "active"), without `count`/`token`
// the cost line has no number (not "0 skills").

/// The area of a skill: each belongs to exactly one and is never moved. Only coding exists (the server answers 400 to
/// `?area=managing`). A legacy skill from another area is in no server list; if one arrives anyway, `SkillEntry` reads
/// it as `nil` and it drops out of the lists instead of breaking the view.
enum SkillArea: String, Sendable {
    case coding
}

/// A project, short: the "Hidden in: A, B" list on a workspace coding skill.
struct SkillProjectShort: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name)
    }

    enum CodingKeys: String, CodingKey { case id, name }
}

/// A skill in a list: the server's `skillMeta` (`{ id, name, description, hasResources, area }`), plus `hiddenIn` or
/// `enabled` depending on the route. The content comes only with `SkillDetail`.
struct SkillEntry: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let hasResources: Bool
    /// nil = the field is missing or unknown (an older server that ignores `?area=` and returns every skill, or a legacy
    /// skill from another area). The workspace lists discard such entries (`APIClient.skills`) instead of assigning
    /// them to an area from old marks.
    let area: SkillArea?
    /// Only on workspace coding skills: the projects where it is hidden, sorted by name by the server.
    let hiddenIn: [SkillProjectShort]
    /// Only in the project view of workspace skills (`GET /api/projects/:pid/workspace-skills`): `true` = NOT hidden in
    /// this project, `false` = hidden, `nil` = the response does not say. The state is then UNKNOWN and the switch is
    /// locked (`SkillsPane`), never silently "active".
    let enabled: Bool?
    /// The version of the state, the latest change that was not reverted, and an open deletion request
    /// (`Models/SkillHistoryModels.swift`) — each nil on an older server.
    let version: String?
    let lastChange: SkillLastChange?
    let openRequest: SkillOpenRequest?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.strOpt(.version)
        lastChange = (try? c.decodeIfPresent(SkillLastChange.self, forKey: .lastChange)) ?? nil
        openRequest = (try? c.decodeIfPresent(SkillOpenRequest.self, forKey: .openRequest)) ?? nil
        id = c.str(.id)
        name = c.str(.name, "Skill")
        description = c.str(.description)
        hasResources = c.bool(.hasResources)
        area = c.strOpt(.area).flatMap(SkillArea.init(rawValue:))
        hiddenIn = c.list(.hiddenIn, SkillProjectShort.self)
        enabled = c.boolOpt(.enabled)
    }

    enum CodingKeys: String, CodingKey {
        case id, name, description, hasResources, area, hiddenIn, enabled, version, lastChange, openRequest
    }
}

/// What the catalogue costs at THIS place on every request (`GET /api/workspaces/:wid/skill-catalog`). The server
/// computes it with the same function that writes the catalogue into the system prompt (`skillCatalog`); the client
/// estimates nothing. If one of the two numbers is missing (or the request failed — `notReadable`), "Catalogue not
/// readable" is shown, as on the web: an invented 0 would claim an empty catalogue.
struct SkillCatalog: Decodable, Hashable, Sendable {
    let count: Int?
    let token: Int?

    static let notReadable = SkillCatalog(count: nil, token: nil)

    init(count: Int?, token: Int?) {
        self.count = count
        self.token = token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.intOpt(.count)
        token = c.intOpt(.token)
    }

    enum CodingKeys: String, CodingKey { case count, token }
}

/// The token count at reading size: exact below a thousand, above that the order of magnitude.
func skillTokenShort(_ n: Int) -> String {
    if n <= 0 { return "0" }
    if n < 1000 { return String(n) }
    if n >= 999_950 { return ChatViewModel.millionsShort(n) } // otherwise "1000,0k"
    return String(format: "%.1fk", Double(n) / 1000).replacingOccurrences(of: ".", with: ",")
}

/// The cost line above every skills view: "In the catalogue here: 3 skills · ~255 tokens per request" — or "Catalogue
/// not readable" if one of the two numbers is missing.
func skillCatalogSet(_ k: SkillCatalog) -> String {
    guard let count = k.count, let token = k.token else { return L("Catalogue not readable") }
    return count == 1
        ? L("In the catalogue here: 1 skill · ~{token} tokens per request", ["token": skillTokenShort(token)])
        : L("In the catalogue here: {n} skills · ~{token} tokens per request", ["n": count, "token": skillTokenShort(token)])
}

/// Who owns a skill — and therefore its route. A workspace skill carries its area (list and create require it); a
/// project skill is always coding.
enum SkillLocation: Hashable, Sendable {
    case workspace(String, SkillArea)
    case project(String)

    var base: String {
        switch self {
        case .workspace(let wid, _): return "/api/workspaces/\(wid)/skills"
        case .project(let pid): return "/api/projects/\(pid)/skills"
        }
    }

    var area: SkillArea {
        switch self {
        case .workspace(_, let a): return a
        case .project: return .coding
        }
    }
}

// ── The routes ──────────────────────────────────────────────────────────────
// ONE place for the paths of both sides. The ids go RAW into the path: `APIClient.makeURL` sets it via
// `components.path` and encodes itself — pre-encoded, "%25…" would arrive.
extension APIClient {
    /// The list of one place. At workspace level with `area` — without it the server answers 400. Anything with another
    /// or no area drops out: a server that ignores the parameter would otherwise return the skills of the other area.
    func skills(_ location: SkillLocation) async throws -> [SkillEntry] {
        switch location {
        case .workspace(_, let area):
            let all: [SkillEntry] = try await get(location.base, query: [URLQueryItem(name: "area", value: area.rawValue)])
            return all.filter { $0.area == area }
        case .project:
            return try await get(location.base)
        }
    }

    /// One skill with its content — via ITS owner (a project skill belongs to the project).
    func skill(_ location: SkillLocation, id: String) async throws -> SkillDetail {
        try await get("\(location.base)/\(id)")
    }

    /// Create. The area always goes along explicitly — also in a project, where "coding" could be omitted.
    func skillCreate(_ location: SkillLocation, name: String, description: String, content: String) async throws {
        struct Body: Encodable { let name: String; let description: String; let body: String; let area: String }
        try await send(location.base, method: .post, body: Body(name: name, description: description, body: content, area: location.area.rawValue))
    }

    /// Change: only description and content — no name, no area (no moving; a missing area means "unchanged" to the
    /// server).
    func changeSkill(_ location: SkillLocation, id: String, description: String, content: String) async throws {
        struct Body: Encodable { let description: String; let body: String }
        try await send("\(location.base)/\(id)", method: .put, body: Body(description: description, body: content))
    }

    func skillDelete(_ location: SkillLocation, id: String) async throws {
        let _: OKResponse = try await delete("\(location.base)/\(id)")
    }

    /// The workspace's coding skills as seen by ONE project, each with `enabled` (= not hidden). Same rule as above:
    /// only what is explicitly coding.
    func workspaceSkillsInProject(_ projectId: String) async throws -> [SkillEntry] {
        let all: [SkillEntry] = try await get("/api/projects/\(projectId)/workspace-skills")
        return all.filter { $0.area == .coding }
    }

    /// Hide or show again — via the skill id, not the name.
    func setSkillInProject(projectId: String, skillId: String, on: Bool) async throws {
        struct Body: Encodable { let enabled: Bool }
        try await send("/api/projects/\(projectId)/workspace-skills/\(skillId)/enabled", method: .patch, body: Body(enabled: on))
    }

    /// Count and cost of the catalogue, computed for exactly this level. `projectId` only for coding.
    func skillCatalog(workspaceId: String, area: SkillArea, projectId: String?) async throws -> SkillCatalog {
        var query = [URLQueryItem(name: "area", value: area.rawValue)]
        if area == .coding, let projectId { query.append(URLQueryItem(name: "projectId", value: projectId)) }
        return try await get("/api/workspaces/\(workspaceId)/skill-catalog", query: query)
    }
}
