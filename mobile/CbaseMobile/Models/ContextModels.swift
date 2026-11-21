import Foundation

// ── Workspace overview ─────────────────────────────────────────────────────
struct ContextCategory: Codable, Hashable, Identifiable, Sendable {
    var id: String { slug }
    /// Display name (in a project the label of the schema, in a workspace the category name).
    let category: String
    let n: Int
    /// Filter value (in a workspace identical to the display name).
    let slug: String

    enum CodingKeys: String, CodingKey { case category, n }

    init(category: String, n: Int, slug: String? = nil) {
        self.category = category
        self.n = n
        self.slug = slug ?? category
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        category = c.str(.category)
        n = c.int(.n)
        slug = c.str(.category)
    }
}

// ── Workspace context (memory) ──────────────────────────────────────────────
struct WorkspaceContextItem: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var category: String
    var title: String
    var summary: String
    var tags: String
    var body: String
    var source: String
    var createdAt: Double

    enum CodingKeys: String, CodingKey {
        case id, category, title, summary, tags, body, source
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        category = c.str(.category)
        title = c.str(.title)
        summary = c.str(.summary)
        tags = c.str(.tags)
        body = c.str(.body)
        source = c.str(.source)
        createdAt = c.dbl(.createdAt)
    }
}

// ── Project context ─────────────────────────────────────────────────────────
struct ProjectContextSchemaEntry: Codable, Identifiable, Hashable, Sendable {
    var id: String { slug }
    let slug: String
    let label: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = c.str(.slug)
        label = c.str(.label)
    }
}

struct ProjectContextItem: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var projectId: String
    var category: String
    var title: String
    var body: String
    var summary: String
    var tags: String
    var source: String
    var validAsOf: String
    var pinned: Bool
    var createdAt: Double
    var updatedAt: Double
    var origin: String

    var isAdopted: Bool { origin == "workspace" }
    var rowKey: String { "\(origin)-\(id)" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        projectId = c.str(.projectId)
        category = c.str(.category)
        title = c.str(.title)
        body = c.str(.body)
        summary = c.str(.summary)
        tags = c.str(.tags)
        source = c.str(.source)
        validAsOf = c.str(.validAsOf)
        pinned = c.bool(.pinned)
        createdAt = c.dbl(.createdAt)
        updatedAt = c.dbl(.updatedAt)
        origin = c.str(.origin, "project")
    }
}

struct AdoptableContextCategory: Codable, Identifiable, Hashable, Sendable {
    var id: String { category }
    let category: String
    let n: Int
    var adopted: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        category = c.str(.category)
        n = c.int(.n)
        adopted = c.bool(.adopted)
    }
}

struct ContextSuggestion: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var op: String
    var targetId: Int?
    var category: String
    var title: String
    var body: String
    var summary: String
    var reason: String
    var createdAt: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        op = c.str(.op, "create")
        targetId = c.intOpt(.targetId)
        category = c.str(.category)
        title = c.str(.title)
        body = c.str(.body)
        summary = c.str(.summary)
        reason = c.str(.reason)
        createdAt = c.dbl(.createdAt)
    }
}

struct ContextDumpResult: Codable, Sendable {
    var status: String
    var item: ProjectContextItem?
    var mergedTitle: String?
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.str(.status, "error")
        item = (try? c.decodeIfPresent(ProjectContextItem.self, forKey: .item)) ?? nil
        mergedTitle = c.strOpt(.mergedTitle)
        error = c.strOpt(.error)
    }
}

/// Response of the workspace dump. Read-only; `item` is taken over flat.
struct WorkspaceDumpResult: Decodable, Sendable {
    var target: String?
    var status: String?
    var projectName: String?
    var category: String?
    var title: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = c.strOpt(.target)
        status = c.strOpt(.status)
        projectName = c.strOpt(.projectName)
        let item = c.json(.item)
        category = item?["category"]?.stringValue
        title = item?["title"]?.stringValue
    }

    enum CodingKeys: String, CodingKey {
        case target, status, projectName, item
    }
}

// ── Credentials & variables ─────────────────────────────────────────────────
struct WorkspaceVar: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var key: String
    var kind: String
    var value: String
    var description: String
    var mcpAccess: Bool
    var enabled: Bool?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        key = c.str(.key)
        kind = c.str(.kind, "variable")
        value = c.str(.value)
        description = c.str(.description)
        mcpAccess = c.bool(.mcpAccess)
        enabled = c.boolOpt(.enabled)
    }
}

// ── MCP servers ──────────────────────────────────────────────────────────────
struct McpServer: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var transport: String
    var command: String
    var args: [String]
    var env: [String: String]
    var url: String
    var enabled: Bool
    // Coding MCP airlock: headers (names only), the tool cache, the choice (nil = all), markers (map), "subagents inherit".
    // All decoded optionally (an older server does not know them; a synthesized Decodable would require EVERY key).
    // The calculation lives in Code/McpTools.swift.
    var headers: [McpHeader]
    var tools: [CodingMcpTool]
    var toolsAt: Int
    var toolsError: String
    var choice: [String]?
    var markers: [String]
    var subagentsInherit: Bool
    // Only in the project list (`workspaceServers`): whether the server is on workspace-wide; there `enabled` means
    // "not hidden in this project". Without the key (own servers, older server) it counts as on.
    var inWorkspaceActive: Bool

    var summary: String {
        transport == "stdio" ? ([command] + args).joined(separator: " ") : url
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name)
        transport = c.str(.transport, "stdio")
        command = c.str(.command)
        args = c.strings(.args)
        env = c.map(.env)
        url = c.str(.url)
        enabled = c.bool(.enabled, true)
        headers = c.list(.headers, McpHeader.self)
        tools = c.list(.tools, CodingMcpTool.self)
        toolsAt = c.int(.toolsAt)
        toolsError = c.str(.toolsError)
        choice = (try? c.decodeIfPresent([String].self, forKey: .choice)) ?? nil
        markers = c.strings(.markers)
        subagentsInherit = c.bool(.subagentsInherit, true)
        inWorkspaceActive = c.bool(.inWorkspaceActive, true)
    }
}

struct ProjectMcpServers: Codable, Sendable {
    let projectServers: [McpServer]
    let workspaceServers: [McpServer]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectServers = c.list(.projectServers, McpServer.self)
        workspaceServers = c.list(.workspaceServers, McpServer.self)
    }
}

struct McpCatalogEntry: Codable, Identifiable, Hashable, Sendable {
    var id: String { key }
    let key: String
    var label: String
    var description: String
    var transport: String
    var command: String
    var args: [String]
    var env: [String: String]
    var url: String
    var needs: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.str(.key)
        label = c.str(.label)
        description = c.str(.description)
        transport = c.str(.transport, "stdio")
        command = c.str(.command)
        args = c.strings(.args)
        env = c.map(.env)
        url = c.str(.url)
        needs = c.str(.needs)
    }
}
