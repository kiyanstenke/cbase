import Foundation

// The Git overview: the iOS counterpart of the contract leaf server/backend/electron/server/gitView/contract.js. The server
// computes EVERYTHING (groups, pairing, counts, branch point, dots/bars, user, state, key color); here things are only read.
// Drawing: Code/GitView.swift (large), Code/GitTimeline.swift (timeline).
//
// Every field is tolerant (own `init(from:)` via Models/DecodeHelpers.swift): a missing or unreadable key never makes the whole
// view unreadable, which a synthesized `Decodable` would. And `nil` means "not delivered" (not read, older server), never
// "empty": an empty list arrives as `[]`.
//
// The lists and field names below follow the order of the contract leaf; the binding test (web/test/git-view-binding.test.mjs)
// holds both together. TIMES are milliseconds since 1970, everywhere.

enum GitViewContract {
    /// GROUPS: order = display.
    static let groups = ["checkedOut", "branches", "cbase", "remote"]
    /// STATES: group "cbase" only; `unknown` ≠ `ended`.
    static let states = ["running", "ended", "copy-removed", "unknown"]
    /// USER_KINDS
    static let userKinds = ["subagent", "workflow-agent", "graph", "copy"]
    /// REASONS: why an instance is not read (the large view never wakes one).
    static let reasons = ["stopped", "starts", "frozen", "error", "time"]
    /// POINTS_MAX: above it the row draws a bar with a number (the server then sends `points: null`).
    static let pointsMax = 15
    /// ROWS_MAX: per repo and reading; above it `clipped`.
    static let rowsMax = 400
    /// DETAIL_COMMITS_MAX
    static let detailCommitsMax = 50
    /// COLORS: key colors per copy, index 0..5 (Code/GitTimeline.swift `GitKeyColor`).
    static let colors = 6
    /// WINDOW and WINDOW_DEFAULT
    static let window = ["7d", "30d", "everything"]
    static let windowDefault = "30d"
    /// FETCH_GAP_MS: the server enforces the auto-fetch throttle; listed here for reference only.
    static let fetchGapMs = 300_000
    /// MAIN_BRANCH_SOURCES
    static let mainBranchSources = ["origin/HEAD", "main", "master"]
    /// MR_STATES
    static let mrStates = ["no-access", "none", "no-gitlab", "error"]
    /// The main instance carries this name in every row and instance (a copy carries its own name, "k1").
    static let main = "main"
}

// ── Small parts ────────────────────────────────────────────────────────────

/// `{ahead, back}`: relative to the remote, to the main branch, since a copy was created.
struct GitViewCounts: Codable, Hashable, Sendable {
    var ahead: Int
    var back: Int
    /// Only `toMain`: the branch lies entirely within the main branch.
    var merged: Bool?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ahead = c.int(.ahead)
        back = c.int(.back)
        merged = c.boolOpt(.merged)
    }
}

/// `detached: {sha}`: HEAD without a branch.
struct GitViewSha: Codable, Hashable, Sendable {
    var sha: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sha = c.str(.sha)
    }
}

/// `last: {t, author, subject}`
struct GitViewLast: Codable, Hashable, Sendable {
    var t: Double?
    var author: String
    var subject: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = c.dblOpt(.t)
        author = c.str(.author)
        subject = c.str(.subject)
    }
}

/// A dot of a row: time, and whether the commit lies under a remote ref (otherwise drawn hollow).
struct GitViewPoint: Codable, Hashable, Sendable {
    var t: Double
    var pushed: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = c.dbl(.t)
        pushed = c.bool(.pushed, true)
    }
}

/// `commits: {points, count, notFetched}`: `points == nil` means a bar with `count` (above POINTS_MAX); `count == nil` without a
/// main branch; `notFetched == nil` = nothing known (no upstream or too many), `[]` = everything fetched.
struct GitViewCommits: Codable, Hashable, Sendable {
    var points: [GitViewPoint]?
    var count: Int?
    var notFetched: [Double]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        points = (try? c.decodeIfPresent([GitViewPoint].self, forKey: .points)) ?? nil
        count = c.intOpt(.count)
        notFetched = (try? c.decodeIfPresent([Double].self, forKey: .notFetched)) ?? nil
    }
}

/// A running chat on a checked-out branch.
struct GitViewChat: Codable, Hashable, Sendable, Identifiable {
    var id: String { chatId }
    var chatId: String
    var title: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        title = c.str(.title)
    }
}

/// An entry in `row.checkedOut` (CHECKED_OUT_FIELDS): where the branch is checked out. `worktree == nil` = the instance's own
/// folder; `notBackedUp == nil` = not readable; `chats == nil` for worktrees (no assignment there), `[]` = none running.
struct GitViewCheckedOut: Codable, Hashable, Sendable {
    var instance: String
    var worktree: String?
    var notBackedUp: Int?
    var chats: [GitViewChat]?

    enum CodingKeys: String, CodingKey { case instance, worktree, notBackedUp, chats }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        instance = c.str(.instance, GitViewContract.main)
        worktree = c.strOpt(.worktree)
        notBackedUp = c.intOpt(.notBackedUp)
        chats = (try? c.decodeIfPresent([GitViewChat].self, forKey: .chats)) ?? nil
    }
}

/// `row.user` (USER_FIELDS): who works on the branch.
struct GitViewUser: Codable, Hashable, Sendable {
    var kind: String
    var name: String
    var chatId: String?
    var agentId: String?
    var childChatId: String?
    var instance: String?

    enum CodingKeys: String, CodingKey { case kind, name, chatId, agentId, childChatId, instance }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.str(.kind)
        name = c.str(.name)
        chatId = c.strOpt(.chatId)
        agentId = c.strOpt(.agentId)
        childChatId = c.strOpt(.childChatId)
        instance = c.strOpt(.instance)
    }
}

// ── The row ───────────────────────────────────────────────────────────────

/// A row (one branch, ROW_FIELDS): the same shape in the large view (`rows`) and in `branchesRunning` of the small one.
struct GitViewRow: Codable, Hashable, Sendable, Identifiable {
    /// A branch can appear in main AND as a copy row, so the name alone is not unique.
    var id: String { "\(instance)\u{1F}\(name)" }

    var group: String
    var name: String
    var local: Bool
    var remote: String?
    var detached: GitViewSha?
    var instance: String
    /// `nil` = local only (no upstream).
    var toRemote: GitViewCounts?
    /// `nil` = no main branch detected.
    var toMain: GitViewCounts?
    /// Copy rows only: relative to the snapshot ref (`nil` = new in the copy).
    var sinceCreation: GitViewCounts?
    var branchPoint: Double?
    var last: GitViewLast?
    var commits: GitViewCommits?
    var checkedOut: [GitViewCheckedOut]
    var user: GitViewUser?
    /// Group "cbase" only (STATES); `nil` otherwise, and as long as the server does not compute it.
    var state: String?

    enum CodingKeys: String, CodingKey {
        case group, name, local, remote, detached, instance, toRemote, toMain, sinceCreation
        case branchPoint, last, commits, checkedOut, user, state
    }

    /// The name for display: a detached HEAD arrives as "detached @ <sha>" (the wire name, which the detail route reads back).
    var shownName: String {
        guard detached != nil, let at = name.range(of: "@ ", options: .backwards) else { return name }
        return L("detached @ {sha}", ["sha": String(name[at.upperBound...])])
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        group = c.str(.group)
        name = c.str(.name)
        local = c.bool(.local, true)
        remote = c.strOpt(.remote)
        detached = (try? c.decodeIfPresent(GitViewSha.self, forKey: .detached)) ?? nil
        instance = c.str(.instance, GitViewContract.main)
        toRemote = (try? c.decodeIfPresent(GitViewCounts.self, forKey: .toRemote)) ?? nil
        toMain = (try? c.decodeIfPresent(GitViewCounts.self, forKey: .toMain)) ?? nil
        sinceCreation = (try? c.decodeIfPresent(GitViewCounts.self, forKey: .sinceCreation)) ?? nil
        branchPoint = c.dblOpt(.branchPoint)
        last = (try? c.decodeIfPresent(GitViewLast.self, forKey: .last)) ?? nil
        commits = (try? c.decodeIfPresent(GitViewCommits.self, forKey: .commits)) ?? nil
        checkedOut = c.list(.checkedOut, GitViewCheckedOut.self)
        user = (try? c.decodeIfPresent(GitViewUser.self, forKey: .user)) ?? nil
        state = c.strOpt(.state)
    }

    /// A row of a copy (in its key color, under the main row of the same name).
    var isCopy: Bool { instance != GitViewContract.main }
    /// All chats currently running on this branch (across all instances where it is checked out), without duplicates.
    var runningChats: [GitViewChat] {
        var seen = Set<String>()
        return checkedOut.flatMap { $0.chats ?? [] }.filter { !$0.chatId.isEmpty && seen.insert($0.chatId).inserted }
    }
    /// Unsaved changes across all places where it is checked out; `nil` if none was readable.
    var notBackedUp: Int? {
        let values = checkedOut.compactMap(\.notBackedUp)
        return values.isEmpty ? nil : values.reduce(0, +)
    }
    /// "Ended (n)": state ≠ `running`. Without a state (not computed) the row does not count as ended: unknown is not finished.
    var ended: Bool { state != nil && state != "running" }
}

// ── The response of GET /api/projects/:pid/gitView ───────────────────────

/// `{rel, name}`: a repo of the project; `rel == ""` is the project folder.
struct GitViewRepo: Codable, Hashable, Sendable, Identifiable {
    var id: String { rel }
    var rel: String
    var name: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rel = c.str(.rel)
        name = c.str(.name)
    }
}

/// The detected main branch (`origin/HEAD` → `main` → `master`).
struct GitViewMainBranch: Codable, Hashable, Sendable {
    var name: String
    var source: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        source = c.strOpt(.source)
    }
}

/// `remoteState: {at, source}` per instance: `at == nil` (source "unknown") means no `FETCH_HEAD`, never fetched.
struct GitViewRemoteStatus: Codable, Hashable, Sendable {
    var at: Double?
    var source: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.dblOpt(.at)
        source = c.str(.source, "unknown")
    }
}

/// An instance of the response (INSTANCE_FIELDS).
struct GitViewInstance: Codable, Hashable, Sendable, Identifiable {
    var id: String { name }
    var name: String
    /// Key color 0..5; the main instance has none.
    var color: Int?
    /// `nil` = not stated (treated as unread, without a reason).
    var read: Bool?
    var reason: String?
    var remoteState: GitViewRemoteStatus?

    enum CodingKeys: String, CodingKey { case name, color, read, reason, remoteState }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name, GitViewContract.main)
        color = c.intOpt(.color)
        read = c.boolOpt(.read)
        reason = c.strOpt(.reason)
        remoteState = (try? c.decodeIfPresent(GitViewRemoteStatus.self, forKey: .remoteState)) ?? nil
    }

    var isMain: Bool { name == GitViewContract.main }
}

/// The main line on top: commit times of the first parents (ascending); `commits == nil` without a main branch or when unread.
struct GitViewLine: Codable, Hashable, Sendable {
    var commits: [Double]?
    var count: Int
    var from: Double?
    var until: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commits = (try? c.decodeIfPresent([Double].self, forKey: .commits)) ?? nil
        count = c.int(.count)
        from = c.dblOpt(.from)
        until = c.dblOpt(.until)
    }
}

/// `clipped: {shown, total}`: the cap says that it is one.
struct GitViewClipped: Codable, Hashable, Sendable {
    var shown: Int
    var total: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shown = c.int(.shown)
        total = c.int(.total)
    }
}

/// The response (RESPONSE_FIELDS). Every list `nil` = not delivered.
struct GitViewResponse: Decodable, Sendable {
    var repo: GitViewRepo?
    var repos: [GitViewRepo]?
    /// `nil` = no main branch detected, only if `mainBranchSupplied`; otherwise the server says nothing about it.
    var mainBranch: GitViewMainBranch?
    var mainBranchSupplied: Bool
    var instances: [GitViewInstance]?
    var line: GitViewLine?
    var rows: [GitViewRow]?
    var clipped: GitViewClipped?

    enum CodingKeys: String, CodingKey { case repo, repos, mainBranch, instances, line, rows, clipped }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repo = (try? c.decodeIfPresent(GitViewRepo.self, forKey: .repo)) ?? nil
        repos = (try? c.decodeIfPresent([GitViewRepo].self, forKey: .repos)) ?? nil
        mainBranch = (try? c.decodeIfPresent(GitViewMainBranch.self, forKey: .mainBranch)) ?? nil
        mainBranchSupplied = c.contains(.mainBranch)
        instances = (try? c.decodeIfPresent([GitViewInstance].self, forKey: .instances)) ?? nil
        line = (try? c.decodeIfPresent(GitViewLine.self, forKey: .line)) ?? nil
        rows = (try? c.decodeIfPresent([GitViewRow].self, forKey: .rows)) ?? nil
        clipped = (try? c.decodeIfPresent(GitViewClipped.self, forKey: .clipped)) ?? nil
    }

    func instance(_ name: String) -> GitViewInstance? { instances?.first { $0.name == name } }

    /// No instance read (all stopped, starting, errors): the server then sends `rows: []`, which means "not read", never
    /// "no branches". Without a list (`instances == nil`) the response says nothing about it.
    var noInstanceRead: Bool { instances.map { !$0.contains { $0.read == true } } ?? false }

    /// The rows as the UI may read them: `nil` = not read (also when no instance is read), `[]` = no branches.
    var readRows: [GitViewRow]? { noInstanceRead ? nil : rows }
}

// ── The detail: GET /api/projects/:pid/gitView/branch ────────────────────

/// A commit ahead. The keys are the server's (`sha`, `t`, `author`, `subject`); the app computes `short` itself if it is missing.
struct GitViewDetailCommit: Decodable, Hashable, Sendable, Identifiable {
    var id: String { sha.isEmpty ? "\(t ?? 0)-\(subject)" : sha }
    var sha: String
    var short: String
    var t: Double?
    var author: String
    var subject: String

    enum CodingKeys: String, CodingKey { case sha, short, t, author, subject }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sha = c.str(.sha)
        let k = c.str(.short)
        short = k.isEmpty ? String(sha.prefix(7)) : k
        t = c.dblOpt(.t)
        author = c.str(.author)
        subject = c.str(.subject)
    }
}

/// A changed file (numstat against `<main>...<branch>`): the server sends `{file, plus, minus, binary}` (gitView/detail.js);
/// `plus`/`minus` are `nil` for binary files. In the app the path is called `path`.
struct GitViewFile: Decodable, Hashable, Sendable, Identifiable {
    var id: String { path }
    var path: String
    var plus: Int?
    var minus: Int?
    var binary: Bool

    enum CodingKeys: String, CodingKey { case file, plus, minus, binary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.str(.file)
        plus = c.intOpt(.plus)
        minus = c.intOpt(.minus)
        binary = c.boolOpt(.binary) == true
    }
}

/// `mr`: `{state}` (MR_STATES) without an MR, otherwise `{iid, title, target, pipeline, url}`. `pipeline` as a word or as `{status}`.
struct GitViewMR: Decodable, Hashable, Sendable {
    var state: String?
    var iid: Int?
    var title: String
    var target: String
    var pipeline: String?
    var url: String?

    enum CodingKeys: String, CodingKey { case state, iid, title, target, pipeline, url }
    private enum PipelineKeys: String, CodingKey { case status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = c.strOpt(.state)
        iid = c.intOpt(.iid)
        title = c.str(.title)
        target = c.str(.target)
        if let word = c.strOpt(.pipeline) {
            pipeline = word
        } else if let p = try? c.nestedContainer(keyedBy: PipelineKeys.self, forKey: .pipeline) {
            pipeline = p.strOpt(.status)
        } else {
            pipeline = nil
        }
        url = c.strOpt(.url)
    }
}

/// `origin` (gitView/detail.js): `{source: "cbase", user, state}` for a cbase branch with a row ·
/// `{source: "reflog", from, at}` from the oldest reflog line "branch: Created from <from>" · `{source: "unknown"}`.
/// `origin` = where it came from (reflog), `text` = the user of a cbase branch, `at` in ms.
struct GitViewOrigin: Decodable, Hashable, Sendable {
    var unknown: Bool
    var origin: String?
    var at: Double?
    var text: String?

    enum CodingKeys: String, CodingKey { case source, from, at, user }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let source = c.strOpt(.source)
        origin = source == "reflog" ? c.strOpt(.from) : nil
        at = source == "reflog" ? c.dblOpt(.at) : nil
        text = source == "cbase" ? ((try? c.decodeIfPresent(GitViewUser.self, forKey: .user)) ?? nil)?.name : nil
        unknown = source == "unknown" || (origin == nil && at == nil && text == nil)
    }
}

/// The detail (DETAIL_FIELDS). `nil` per field = not delivered.
struct GitViewDetail: Decodable, Sendable {
    var row: GitViewRow?
    var commits: [GitViewDetailCommit]?
    var files: [GitViewFile]?
    var mr: GitViewMR?
    var origin: GitViewOrigin?
    /// More than DETAIL_COMMITS_MAX commits ahead: `{shown, total}`. The server caps per part
    /// (`clipped: {commits: {shown, total} | null, files: … | null}`); this holds the `commits` part.
    var clipped: GitViewClipped?
    /// The `files` part of the same cap: more changed files than the list carries; the page says "x of y files".
    var clippedFiles: GitViewClipped?
    var clippedWithoutCount: Bool
    /// `failed: {commits, files}`: per part the reason why it is `nil` although there is a main branch (git failed);
    /// `nil` without a reason here still means "no main branch".
    var failedCommits: String?
    var failedFiles: String?

    enum CodingKeys: String, CodingKey { case row, commits, files, mr, origin, clipped, failed }
    private enum ClippedParts: String, CodingKey { case commits, files }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        row = (try? c.decodeIfPresent(GitViewRow.self, forKey: .row)) ?? nil
        commits = (try? c.decodeIfPresent([GitViewDetailCommit].self, forKey: .commits)) ?? nil
        files = (try? c.decodeIfPresent([GitViewFile].self, forKey: .files)) ?? nil
        mr = (try? c.decodeIfPresent(GitViewMR.self, forKey: .mr)) ?? nil
        origin = (try? c.decodeIfPresent(GitViewOrigin.self, forKey: .origin)) ?? nil
        // Read the shape per part first; a GitViewClipped straight from `clipped` would read missing numbers as 0 ("0 of 0").
        if let parts = try? c.nestedContainer(keyedBy: ClippedParts.self, forKey: .clipped), parts.contains(.commits) || parts.contains(.files) {
            clipped = (try? parts.decodeIfPresent(GitViewClipped.self, forKey: .commits)) ?? nil
            clippedFiles = (try? parts.decodeIfPresent(GitViewClipped.self, forKey: .files)) ?? nil
        } else {
            clipped = (try? c.decodeIfPresent(GitViewClipped.self, forKey: .clipped)) ?? nil
            clippedFiles = nil
        }
        clippedWithoutCount = clipped == nil && c.boolOpt(.clipped) == true
        let reason = try? c.nestedContainer(keyedBy: ClippedParts.self, forKey: .failed)
        failedCommits = ((try? reason?.decodeIfPresent(String.self, forKey: .commits)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
        failedFiles = ((try? reason?.decodeIfPresent(String.self, forKey: .files)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// The response of POST …/gitView/fetch: `skipped` within the throttle, `remoteState` of the instance.
struct GitViewFetchResponse: Decodable, Sendable {
    var skipped: Bool
    var remoteState: GitViewRemoteStatus?

    enum CodingKeys: String, CodingKey { case skipped, remoteState }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        skipped = c.bool(.skipped)
        remoteState = (try? c.decodeIfPresent(GitViewRemoteStatus.self, forKey: .remoteState)) ?? nil
    }
}

// ── The small view: extra fields per repo in GET …/git ───────────────────

/// GIT_REPO_FIELDS: `branchesRunning` (rows as above) and `counter` per group. Read in `GitRepo` (Models/GitModels.swift).
enum GitRepoFields {
    static let fields = ["branchesRunning", "counter"]
}
