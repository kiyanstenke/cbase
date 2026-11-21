import Foundation

// ── Files / code ──────────────────────────────────────────────────────────
struct FileEntry: Codable, Identifiable, Hashable, Sendable {
    var id: String { path }
    var name: String
    var path: String
    var type: String
    var size: Int
    var symlink: Bool
    var heavy: Bool

    var isDirectory: Bool { type == "dir" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        path = c.str(.path)
        type = c.str(.type, "file")
        size = c.int(.size)
        symlink = c.bool(.symlink)
        heavy = c.bool(.heavy)
    }
}

struct DirListing: Codable, Sendable {
    var path: String
    var entries: [FileEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.str(.path)
        entries = c.list(.entries, FileEntry.self)
    }
}

struct FileContent: Codable, Sendable {
    var path: String
    var content: String?
    var size: Int
    var tooLarge: Bool
    var binary: Bool
    /// Images are binary but shown as a preview instead of being rejected.
    var image: Bool
    var mime: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.str(.path)
        content = c.strOpt(.content)
        size = c.int(.size)
        tooLarge = c.bool(.tooLarge)
        binary = c.bool(.binary)
        image = c.bool(.image)
        mime = c.str(.mime)
    }
}

struct FileSearchMatch: Codable, Hashable, Identifiable, Sendable {
    var id: Int { line }
    var line: Int
    var text: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = c.int(.line)
        text = c.str(.text)
    }
}

struct FileSearchResult: Codable, Hashable, Identifiable, Sendable {
    var id: String { path }
    var path: String
    var matches: [FileSearchMatch]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.str(.path)
        matches = c.list(.matches, FileSearchMatch.self)
    }
}

struct FileGrepResponse: Codable, Sendable {
    var results: [FileSearchResult]
    var count: Int
    var truncated: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = c.list(.results, FileSearchResult.self)
        count = c.int(.count)
        truncated = c.bool(.truncated)
    }
}

// ── Debugger ────────────────────────────────────────────────────────────────
struct DebugFrame: Codable, Identifiable, Hashable, Sendable {
    var id: String { callFrameId }
    var callFrameId: String
    var name: String
    var file: String
    var line: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callFrameId = c.str(.callFrameId)
        name = c.str(.name, L("(anonymous)"))
        file = c.str(.file)
        line = c.int(.line)
    }
}

struct DebugVar: Codable, Identifiable, Hashable, Sendable {
    var id: String { name }
    var name: String
    var value: String
    var type: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        value = c.str(.value)
        type = c.str(.type)
    }
}

struct DebugScope: Codable, Identifiable, Hashable, Sendable {
    var id: String { type + name }
    var type: String
    var name: String
    var vars: [DebugVar]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.str(.type)
        name = c.str(.name)
        vars = c.list(.vars, DebugVar.self)
    }
}

struct DebugPaused: Codable, Sendable {
    var reason: String
    var frames: [DebugFrame]
    var topFile: String?
    var topLine: Int?
    var scopes: [DebugScope]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reason = c.str(.reason)
        frames = c.list(.frames, DebugFrame.self)
        topFile = c.strOpt(.topFile)
        topLine = c.intOpt(.topLine)
        scopes = c.list(.scopes, DebugScope.self)
    }
}

struct DebugLaunchResponse: Codable, Sendable {
    var id: String
    var available: Bool
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        available = c.bool(.available)
        error = c.strOpt(.error)
    }
}

struct DebugEvaluateResponse: Codable, Sendable {
    var value: String?
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = c.strOpt(.value)
        error = c.strOpt(.error)
    }
}

// ── Language-service diagnostics ("Problems") ───────────────────────────────
// `POST <apiBase>/lsp/diagnostics`: `{ diagnostics: [{ range: { start: { line, character } }, severity (1–4), message }] }`.
// Lines are 0-based; `severity` is the LSP number (1 error, 2 warning, 3 info, 4 hint). Without a service the answer is
// `{ supported: false, reason, error? }` with status 200.
struct LspDiagnostic: Codable, Identifiable, Hashable, Sendable {
    var id: String { "\(line)-\(character)-\(message)" }
    /// 1-based for display.
    var line: Int
    var character: Int
    var message: String
    var severity: String

    private enum Keys: String, CodingKey { case range, start, line, character, message, severity }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let start = try? c.nestedContainer(keyedBy: Keys.self, forKey: .range).nestedContainer(keyedBy: Keys.self, forKey: .start)
        line = (start.map { $0.int(.line) } ?? 0) + 1
        character = start.map { $0.int(.character) } ?? 0
        message = c.str(.message)
        switch c.int(.severity, 1) {
        case 1: severity = "error"
        case 2: severity = "warning"
        default: severity = "info"
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(message, forKey: .message)
        try c.encode(severity, forKey: .severity)
    }
}

struct LspDiagnosticsResponse: Codable, Sendable {
    var diagnostics: [LspDiagnostic]
    /// `false` if the file has no language service (`reason`: no_language, no_project, missing, …).
    var supported: Bool
    var reason: String?
    var error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        diagnostics = c.list(.diagnostics, LspDiagnostic.self)
        supported = c.boolOpt(.supported) ?? true
        reason = c.strOpt(.reason)
        error = c.strOpt(.error)
    }
}
