import Foundation

// ── Git ─────────────────────────────────────────────────────────────────────
struct GitChange: Codable, Identifiable, Hashable, Sendable {
    var id: String { "\(x)\(y)-\(path)" }
    var x: String
    var y: String
    var path: String
    var code: String
    var label: String
    var kind: String

    var staged: Bool { !x.trimmingCharacters(in: .whitespaces).isEmpty && x != "?" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        x = c.str(.x)
        y = c.str(.y)
        path = c.str(.path)
        code = c.str(.code)
        label = c.str(.label)
        kind = c.str(.kind, "modified")
    }
}

struct GitCounts: Codable, Hashable, Sendable {
    var staged: Int
    var unstaged: Int
    var untracked: Int
    var total: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        staged = c.int(.staged)
        unstaged = c.int(.unstaged)
        untracked = c.int(.untracked)
        total = c.int(.total)
    }
}

struct GitCommitInfo: Codable, Hashable, Sendable {
    var hash: String
    var subject: String
    var author: String
    var relative: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = c.str(.hash)
        subject = c.str(.subject)
        author = c.str(.author)
        relative = c.str(.relative)
    }
}

struct GitRemote: Codable, Hashable, Sendable {
    var url: String
    var host: String
    var projectPath: String
    var webUrl: String
    var isGitlab: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.str(.url)
        host = c.str(.host)
        projectPath = c.str(.projectPath)
        webUrl = c.str(.webUrl)
        isGitlab = c.bool(.isGitlab)
    }
}

struct GitRepo: Codable, Identifiable, Hashable, Sendable {
    var id: String { relPath.isEmpty ? "__root__" : relPath }
    var name: String
    var relPath: String
    var branch: String
    var detached: Bool
    var upstream: String?
    var ahead: Int
    var behind: Int
    var changes: [GitChange]
    var counts: GitCounts?
    var clean: Bool
    /// `git status` failed; the reason, translated by the server. Then `changes` is empty but unknown, not "no changes".
    /// Twin of `statusError` in web/src/lib/api/git.ts.
    var statusError: String?
    var lastCommit: GitCommitInfo?
    var remote: GitRemote?
    /// The small git overview (GIT_REPO_FIELDS): the running branches of this instance (the checked-out one with its running
    /// chats, worktrees, live cbase branches) in the row form of the big view, and the number of branches per group.
    /// `nil` = the server does not send the field (older server): the "Branches" section is then missing.
    var branchesRunning: [GitViewRow]?
    var counter: [String: Int]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        relPath = c.str(.relPath)
        branch = c.str(.branch)
        detached = c.bool(.detached)
        upstream = c.strOpt(.upstream)
        ahead = c.int(.ahead)
        behind = c.int(.behind)
        changes = c.list(.changes, GitChange.self)
        counts = (try? c.decodeIfPresent(GitCounts.self, forKey: .counts)) ?? nil
        clean = c.bool(.clean)
        statusError = c.strOpt(.statusError)
        lastCommit = (try? c.decodeIfPresent(GitCommitInfo.self, forKey: .lastCommit)) ?? nil
        remote = (try? c.decodeIfPresent(GitRemote.self, forKey: .remote)) ?? nil
        branchesRunning = (try? c.decodeIfPresent([GitViewRow].self, forKey: .branchesRunning)) ?? nil
        counter = (try? c.decodeIfPresent([String: Int].self, forKey: .counter)) ?? nil
    }
}

struct GitTree: Codable, Sendable {
    var repos: [GitRepo]
    /// Project container: if the container of a converted project is not ready, the server says so here instead of
    /// silently returning an empty list. Project level on top, workspace level per project under `projects`.
    var notice: String?
    var error: String?
    var projects: [GitProjectSituation]?
    /// If git ran in a COPY (`?chat=` of a copy chat), the project level names it here ("copy-k1", devtools/code-route.js
    /// gitResponse); the main instance never carries the field.
    var instance: String?

    struct GitProjectSituation: Codable, Sendable, Equatable {
        var projectId: String?
        var notice: String?
        var error: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repos = c.list(.repos, GitRepo.self)
        notice = try? c.decodeIfPresent(String.self, forKey: .notice)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        projects = try? c.decodeIfPresent([GitProjectSituation].self, forKey: .projects)
        instance = try? c.decodeIfPresent(String.self, forKey: .instance)
    }

    /// The copy's name: "copy-k1" → "k1"; nil for the main instance and when absent. Twin of `copyName` in web/src/lib/chat-instance.ts.
    var copyName: String? {
        guard let instance, instance.hasPrefix("copy-"), instance.count > 5 else { return nil }
        return String(instance.dropFirst(5))
    }

    /// The messages of the project containers (empty = nothing to say). Twin of `gitHints` in web/src/lib/api/git.ts.
    var hints: [String] {
        let top = notice ?? error ?? ""
        return ([top] + (projects ?? []).map { $0.notice ?? $0.error ?? "" }).filter { !$0.isEmpty }
    }
}

struct GitBranches: Codable, Sendable {
    var current: String
    var locals: [String]
    var remotes: [String]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = c.str(.current)
        locals = c.strings(.locals)
        remotes = c.strings(.remotes)
    }
}

struct GitDiffResponse: Codable, Sendable {
    var path: String
    var staged: Bool
    var diff: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.str(.path)
        staged = c.bool(.staged)
        diff = c.str(.diff)
    }
}

struct GitLogEntry: Codable, Identifiable, Hashable, Sendable {
    var id: String { hash }
    var hash: String
    var short: String
    var subject: String
    var author: String
    var relative: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = c.str(.hash)
        short = c.str(.short)
        subject = c.str(.subject)
        author = c.str(.author)
        relative = c.str(.relative)
    }
}

struct GitLogResponse: Codable, Sendable {
    var commits: [GitLogEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commits = c.list(.commits, GitLogEntry.self)
    }
}
