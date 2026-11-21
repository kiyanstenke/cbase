import Foundation

// The timeline per project — wire and loading.
//
//   GET  /api/projects/:pid/timeline?until=&untilId=&limit=&kind=&chat=&word=   → { active, events, further, continueId }
//   PUT  /api/projects/:pid/timeline            { active }                          the project switch
//   POST /api/projects/:pid/timeline/:eid/dismiss { justification }                 a human dismisses; a reason is required
//   POST /api/projects/:pid/timeline/:eid/revision { title?, text?, justification? }   new revision (no new event)
//   GET  /api/projects/:pid/timeline/proofs?chat=<id>                              the proofs of one chat's agenda
//
// `links` and `references` (title/text in chunks with links — the SERVER recognises the ids and builds the addresses,
// as on the web), `revisions` and `agendaItem` come along.
//
// Decoded tolerantly (DecodeHelpers): a missing field never empties the view. The UI lives in Code/ProjectTimeline.swift
// (Projects → project → Timeline) and Chat/ProjectTimelineSheet.swift (sheet from the chat header). Reloaded on the
// SSE event `timeline` `{ projectId }` (`AppState.timelineTick`).
//
// Not to be confused with `ChatTimelineStage`/`TimelineItem`: that is the history of ONE chat.

/// The fixed set of kinds — word and SF Symbol live ONCE here.
enum ProjectTimelineKind: String, CaseIterable, Identifiable {
    case code, git, test, communication, ops, other

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .git: return "arrow.triangle.branch"
        case .test: return "checkmark.seal"
        case .communication: return "bubble.left.and.bubble.right"
        case .ops: return "server.rack"
        case .other: return "circle.dashed"
        }
    }

    var word: String {
        switch self {
        case .code: return L("Code")
        case .git: return L("Git")
        case .test: return L("Test")
        case .communication: return L("Communication")
        case .ops: return L("Operations")
        case .other: return L("Other")
        }
    }

    /// An unknown kind (a newer server) shows as "Other" instead of losing the row.
    static func from(_ s: String) -> ProjectTimelineKind { ProjectTimelineKind(rawValue: s) ?? .other }
}

struct ProjectTimelineCitation: Decodable, Equatable {
    /// `tool` | `message`
    let kind: String
    /// Message id (as text).
    let ref: String
    /// `""` = main chat, `subagent:<agentId>` = subagent.
    let from: String
    let chatId: String?
    let chatTitle: String?
    let tool: String?

    enum CodingKeys: String, CodingKey { case kind, ref, from, chatId, chatTitle, tool }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.str(.kind)
        ref = c.strOpt(.ref) ?? c.intOpt(.ref).map(String.init) ?? ""
        from = c.str(.from)
        chatId = c.strOpt(.chatId).flatMap { $0.isEmpty ? nil : $0 }
        chatTitle = c.strOpt(.chatTitle)
        tool = c.strOpt(.tool)
    }

    /// The id of the subagent, if the citation lies with one.
    var subagentId: String? {
        guard from.hasPrefix("subagent:") else { return nil }
        let id = String(from.dropFirst("subagent:".count))
        return id.isEmpty ? nil : id
    }
}

struct ProjectTimelineAnchor: Decodable, Equatable {
    let branch: String?
    let sha: String?
    let mrIid: Int?

    enum CodingKeys: String, CodingKey { case branch, sha, mrIid }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = c.strOpt(.branch).flatMap { $0.isEmpty ? nil : $0 }
        sha = c.strOpt(.sha).flatMap { $0.isEmpty ? nil : $0 }
        mrIid = c.intOpt(.mrIid)
    }

    /// Short: "main · 1a2b3c4d" or "!42"; empty ⇒ nil.
    var short: String? {
        let parts = [branch, sha.map { String($0.prefix(8)) }, mrIid.map { "!\($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// A chunk of a title/text: text, optionally with a link (http/https only).
struct ProjectTimelineChunk: Decodable, Equatable {
    let t: String
    let url: URL?

    enum CodingKeys: String, CodingKey { case t, url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = c.str(.t)
        url = ProjectTimelineLinks.address(c.strOpt(.url))
    }

    /// The chunks as an AttributedString with links — nil without chunks (then the text itself applies).
    static func text(_ chunks: [ProjectTimelineChunk]?) -> AttributedString? {
        guard let chunks, !chunks.isEmpty else { return nil }
        var out = AttributedString()
        for s in chunks {
            var part = AttributedString(s.t)
            if let url = s.url {
                part.link = url
                part.underlineStyle = .single
            }
            out += part
        }
        return out
    }
}

/// The links of the git anchor (each nil if not unambiguously resolvable) — built by the server (timeline/references.js).
struct ProjectTimelineLinks: Decodable, Equatable {
    let repoName: String?
    let provider: String?
    let mr: URL?
    let commit: URL?
    let branch: URL?

    enum CodingKeys: String, CodingKey { case repo, mr, commit, branch }
    enum RepoKeys: String, CodingKey { case name, provider }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let r = try? c.nestedContainer(keyedBy: RepoKeys.self, forKey: .repo)
        repoName = r?.strOpt(.name)
        provider = r?.strOpt(.provider)
        mr = Self.address(c.strOpt(.mr))
        commit = Self.address(c.strOpt(.commit))
        branch = Self.address(c.strOpt(.branch))
    }

    var empty: Bool { mr == nil && commit == nil && branch == nil }

    /// Only http(s) becomes a link — never another scheme (javascript:, file:).
    static func address(_ s: String?) -> URL? {
        guard let s, let u = URL(string: s), let schema = u.scheme?.lowercased(), schema == "https" || schema == "http" else { return nil }
        return u
    }
}

/// The agenda point the event refers to; `text` nil = no longer in the chat's agenda.
struct ProjectTimelineAgendaPoint: Decodable, Equatable {
    let id: String
    let chatId: String?
    let text: String?

    enum CodingKeys: String, CodingKey { case id, chatId, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        chatId = c.strOpt(.chatId).flatMap { $0.isEmpty ? nil : $0 }
        text = c.strOpt(.text)
    }
}

/// A revision of title and text — the first is the entry's own (always `agent`).
struct ProjectTimelineRevision: Decodable, Equatable {
    let title: String
    let text: String
    /// `agent` | `human`
    let from: String
    let justification: String
    let at: Double

    enum CodingKeys: String, CodingKey { case title, text, from, justification, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.str(.title)
        text = c.str(.text)
        from = c.str(.from, "agent")
        justification = c.str(.justification)
        at = c.dbl(.at)
    }

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

struct ProjectTimelineDismissed: Decodable, Equatable {
    /// `agent` | `user`
    let from: String
    let justification: String
    let at: Double

    enum CodingKeys: String, CodingKey { case from, justification, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = c.str(.from)
        justification = c.str(.justification)
        at = c.dbl(.at)
    }
}

/// An event. `parts` only on the top-level event (one level).
struct ProjectTimelineEvent: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let text: String
    /// ms since 1970 — when it happened.
    let at: Double
    let citation: ProjectTimelineCitation?
    let anchor: ProjectTimelineAnchor?
    let agendaItemId: String?
    let tags: [String]
    let dismissed: ProjectTimelineDismissed?
    let parts: [ProjectTimelineEvent]
    /// All revisions, oldest first; empty = never revised.
    let revisions: [ProjectTimelineRevision]
    let links: ProjectTimelineLinks?
    let titleChunks: [ProjectTimelineChunk]?
    let textChunks: [ProjectTimelineChunk]?
    let agendaItem: ProjectTimelineAgendaPoint?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, text, at, citation, anchor, agendaItemId, tags, dismissed, parts, revisions, links, references, agendaItem
    }
    enum ReferenceKeys: String, CodingKey { case title, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        kind = c.str(.kind, "other")
        title = c.str(.title)
        text = c.str(.text)
        at = c.dbl(.at)
        citation = (try? c.decodeIfPresent(ProjectTimelineCitation.self, forKey: .citation)) ?? nil
        anchor = (try? c.decodeIfPresent(ProjectTimelineAnchor.self, forKey: .anchor)) ?? nil
        agendaItemId = c.strOpt(.agendaItemId)
        tags = c.strings(.tags)
        dismissed = (try? c.decodeIfPresent(ProjectTimelineDismissed.self, forKey: .dismissed)) ?? nil
        parts = c.list(.parts, ProjectTimelineEvent.self)
        revisions = c.list(.revisions, ProjectTimelineRevision.self)
        links = (try? c.decodeIfPresent(ProjectTimelineLinks.self, forKey: .links)) ?? nil
        let v = try? c.nestedContainer(keyedBy: ReferenceKeys.self, forKey: .references)
        titleChunks = (try? v?.decodeIfPresent([ProjectTimelineChunk].self, forKey: .title)) ?? nil
        textChunks = (try? v?.decodeIfPresent([ProjectTimelineChunk].self, forKey: .text)) ?? nil
        agendaItem = (try? c.decodeIfPresent(ProjectTimelineAgendaPoint.self, forKey: .agendaItem)) ?? nil
    }

    var kindValue: ProjectTimelineKind { ProjectTimelineKind.from(kind) }
    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

struct ProjectTimelineResponse: Decodable {
    /// nil = the server said nothing (empty is not unknown) — the last read switch then stays.
    let active: Bool?
    let events: [ProjectTimelineEvent]
    /// The `until` of the next page; nil = nothing more.
    let further: Double?
    /// The `untilId` of the next page (id of the last event) — with `further` the cursor that does not lose equal
    /// timestamps at the page boundary; nil on an older server (then `further` alone pages).
    let continueId: String?

    enum CodingKeys: String, CodingKey { case active, events, further, continueId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.boolOpt(.active)
        events = c.list(.events, ProjectTimelineEvent.self)
        further = c.dblOpt(.further)
        continueId = c.strOpt(.continueId)
    }
}

/// The wording of the view — ONCE, for the project page and the chat sheet.
enum ProjectTimelineText {
    /// "executed git_push" / "reported".
    static func citation(_ f: ProjectTimelineCitation) -> String {
        switch f.kind {
        case "tool":
            if let w = f.tool, !w.isEmpty { return L("executed {tool}", ["tool": w]) }
            return L("executed")
        case "message": return L("reported")
        default: return f.kind
        }
    }

    static func dismissed(_ v: ProjectTimelineDismissed) -> String {
        v.from == "user"
            ? L("Discarded by you: {reason}", ["reason": v.justification])
            : L("Discarded by the agent: {reason}", ["reason": v.justification])
    }

    static func clockTime(_ d: Date) -> String {
        d.formatted(date: .omitted, time: .shortened)
    }

    /// The day separator: "Today", "Yesterday", otherwise the date (device time zone).
    static func day(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return L("Today") }
        if cal.isDateInYesterday(d) { return L("Yesterday") }
        return d.formatted(.dateTime.weekday(.wide).day().month(.wide).year())
    }
}

/// The timeline of ONE project: pages, filters, switch, dismiss. Project page and chat sheet each hold their own.
@MainActor
final class ProjectTimelineModel: ObservableObject {
    let client: APIClient
    let projectId: String

    @Published private(set) var events: [ProjectTimelineEvent] = []
    @Published private(set) var further: Double?
    private var continueId: String?
    /// nil = never read.
    @Published private(set) var active: Bool?
    @Published private(set) var loaded = false
    @Published private(set) var loadingMore = false
    @Published var error: String?

    @Published var filterKind: ProjectTimelineKind? { didSet { if filterKind != oldValue { loadAgain() } } }
    @Published var filterChat: String? { didSet { if filterChat != oldValue { loadAgain() } } }
    @Published var filterWord: String? { didSet { if filterWord != oldValue { loadAgain() } } }

    /// The chats and tags that ever appeared in a read page — the choice for the filters (no route of its own).
    @Published private(set) var knownChats: [String: String] = [:]
    @Published private(set) var knownWords: Set<String> = []

    /// Only the most recently started read counts (a filter change overtakes an older one).
    private var reading = 0
    static let page = 50

    init(client: APIClient, projectId: String) {
        self.client = client
        self.projectId = projectId
    }

    private var path: String {
        "/api/projects/\(projectId)/timeline"
    }

    private func query(until: Double?, untilId: String? = nil, limit: Int) -> [URLQueryItem] {
        var q = [URLQueryItem(name: "limit", value: String(limit))]
        if let until { q.append(URLQueryItem(name: "until", value: String(Int64(until)))) }
        if until != nil, let untilId, !untilId.isEmpty { q.append(URLQueryItem(name: "untilId", value: untilId)) }
        if let filterKind { q.append(URLQueryItem(name: "kind", value: filterKind.rawValue)) }
        if let filterChat { q.append(URLQueryItem(name: "chat", value: filterChat)) }
        if let filterWord { q.append(URLQueryItem(name: "word", value: filterWord)) }
        return q
    }

    private func loadAgain() {
        events = []
        further = nil
        continueId = nil
        loaded = false
        Task { await load() }
    }

    /// Re-read the first page — as many as were already there (an SSE reload does not collapse paged pages), at most 200.
    func load() async {
        reading += 1
        let my = reading
        let limit = min(200, max(Self.page, events.count))
        do {
            let s: ProjectTimelineResponse = try await client.get(path, query: query(until: nil, limit: limit))
            guard my == reading else { return }
            events = s.events
            further = s.further
            continueId = s.continueId
            if let a = s.active { active = a }
            remember(s.events)
            error = nil
            loaded = true
        } catch is CancellationError {
            return
        } catch {
            guard my == reading else { return }
            self.error = error.localizedDescription
            loaded = true
        }
    }

    func loadMore() async {
        guard let until = further, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let my = reading
        do {
            let s: ProjectTimelineResponse = try await client.get(path, query: query(until: until, untilId: continueId, limit: Self.page))
            guard my == reading else { return }
            let present = Set(events.map(\.id))
            events += s.events.filter { !present.contains($0.id) }
            further = s.further
            continueId = s.continueId
            remember(s.events)
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remember(_ list: [ProjectTimelineEvent]) {
        for e in list + list.flatMap(\.parts) {
            if let f = e.citation, let cid = f.chatId {
                let t = f.chatTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if knownChats[cid] == nil || !t.isEmpty { knownChats[cid] = t.isEmpty ? cid : t }
            }
            knownWords.formUnion(e.tags)
        }
    }

    private struct ActiveBody: Encodable { let active: Bool }
    private struct ActiveResponse: Decodable { let active: Bool? }
    private struct JustificationBody: Encodable { let justification: String }

    func activeSet(_ fresh: Bool) async {
        let prior = active
        active = fresh
        do {
            let a: ActiveResponse = try await client.put(path, body: ActiveBody(active: fresh))
            if let w = a.active { active = w }
        } catch {
            active = prior
            self.error = error.localizedDescription
        }
    }

    /// Dismiss with a required reason. Throws so the sheet shows the error and stays open.
    func dismiss(_ id: String, justification: String) async throws {
        let reason = justification.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty else { throw ProjectTimelineError.justificationMissing }
        // The id goes raw into the path — encoding happens in `makeURL`, never before.
        try await client.send("\(path)/\(id)/dismiss", body: JustificationBody(justification: reason))
        await load()
    }
}

extension ProjectTimelineModel {
    /// A new revision: only changed fields go along; no new event. Throws so the sheet shows the error.
    func revise(_ e: ProjectTimelineEvent, title: String, text: String, justification: String) async throws {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let x = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = justification.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { throw ProjectTimelineError.titleMissing }
        try await client.send("/api/projects/\(projectId)/timeline/\(e.id)/revision",
                              body: ProjectTimelineRevisionBody(title: t == e.title ? nil : t, text: x == e.text ? nil : x, justification: b.isEmpty ? nil : b))
        await load()
    }
}

/// The body of a new revision — nil fields are absent from the JSON (a field not sent stays as it is on the server).
struct ProjectTimelineRevisionBody: Encodable {
    let title: String?
    let text: String?
    let justification: String?
}

/// The proofs of ONE chat's agenda: the events with an agenda point whose citation lies in this chat — per point.
struct ProjectTimelineProofsResponse: Decodable {
    let proofs: [ProjectTimelineEvent]

    enum CodingKeys: String, CodingKey { case proofs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proofs = c.list(.proofs, ProjectTimelineEvent.self)
    }

    /// Point id → events (newest first, as the server sends them).
    var perItem: [String: [ProjectTimelineEvent]] {
        var out: [String: [ProjectTimelineEvent]] = [:]
        for e in proofs { if let p = e.agendaItemId, !p.isEmpty { out[p, default: []].append(e) } }
        return out
    }
}

enum ProjectTimelineError: LocalizedError {
    case justificationMissing
    case titleMissing
    var errorDescription: String? {
        switch self {
        case .justificationMissing: return L("A reason is required.")
        case .titleMissing: return L("The title must not be empty.")
        }
    }
}
