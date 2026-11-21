import Foundation

/// The tool choice of a coding MCP server as ONE computation — the Swift twin of `web/src/lib/mcp-tools.ts`.
/// Bound by `web/test/mcp-tools-binding.test.mjs`, which compiles this file with `xcrun swiftc`, feeds both versions the same
/// inputs and demands the same answer. Hence Foundation only: no SwiftUI, no `L(…)` — the labels are keys, translated where
/// they are displayed (`Code/McpPane.swift`).
///
/// The meaning comes from the server (`toolchain/mcp-tools.js` `verdict`): `choice == nil` means "all", a list exactly those,
/// `[]` none; a marker means "card before the call". A name in `choice`/`markers` that is no longer in the cache survives
/// toggling — if the tool comes back, the old decision applies.

/// A tool from the server's cache. Decodable without required keys except `name` (a synthesized Decodable would demand EVERY one).
struct CodingMcpTool: Codable, Hashable, Sendable {
    var name: String
    var description: String
    /// Coding's rule: readOnlyHint false ⇒ true, true ⇒ false, otherwise nil (unresolved).
    var writing: Bool?
    var fresh: Bool

    init(name: String, description: String = "", writing: Bool?, fresh: Bool = false) {
        self.name = name
        self.description = description
        self.writing = writing
        self.fresh = fresh
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        writing = (try? c.decodeIfPresent(Bool.self, forKey: .writing)) ?? nil
        fresh = (try? c.decodeIfPresent(Bool.self, forKey: .fresh)) ?? false
    }
}

/// A stored header: the name only — the value never leaves the server.
struct McpHeader: Codable, Hashable, Sendable {
    var name: String
    var set: Bool

    init(name: String, set: Bool = true) {
        self.name = name
        self.set = set
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        set = (try? c.decodeIfPresent(Bool.self, forKey: .set)) ?? true
    }
}

enum McpToolComputation {
    /// "reads" · "writes" · "unresolved" — the same keys as on the web.
    static func label(_ writing: Bool?) -> String {
        switch writing {
        case .some(true): return "writes"
        case .some(false): return "reads"
        case .none: return "unresolved"
        }
    }

    static func isSelected(_ choice: [String]?, _ name: String) -> Bool {
        guard let choice else { return true }
        return choice.contains(name)
    }

    struct Row: Hashable, Sendable, Identifiable {
        var id: String { name }
        let name: String
        let description: String
        let label: String
        let selected: Bool
        let card: Bool
        let fresh: Bool
    }

    /// The rows in cache order (= the server's tools/list).
    static func rows(_ tools: [CodingMcpTool], choice: [String]?, markers: [String]) -> [Row] {
        tools.map { w in
            Row(name: w.name, description: w.description, label: label(w.writing),
                  selected: isSelected(choice, w.name), card: markers.contains(w.name), fresh: w.fresh)
        }
    }

    struct Counter: Hashable, Sendable {
        /// selected (free or with a card)
        let free: Int
        /// of those, with a card
        let card: Int
        let total: Int
    }

    static func counter(_ tools: [CodingMcpTool], choice: [String]?, markers: [String]) -> Counter {
        let z = rows(tools, choice: choice, markers: markers)
        let selected = z.filter(\.selected)
        return Counter(free: selected.count, card: selected.filter(\.card).count, total: z.count)
    }

    /// The choice after a tap on the checkmark of `name`. From `nil` (all) it becomes the list of all cache names without `name`.
    static func toggleChoice(_ tools: [CodingMcpTool], choice: [String]?, name: String) -> [String] {
        let base = choice ?? tools.map(\.name)
        return base.contains(name) ? base.filter { $0 != name } : base + [name]
    }

    static func toggleMarker(_ markers: [String], name: String) -> [String] {
        markers.contains(name) ? markers.filter { $0 != name } : markers + [name]
    }

    /// State of the cache: "never", "loaded" (`minutes` ago) or "error" (an error does not replace the cache). Times in ms.
    static func status(toolsAt: Int, error: String, now: Int) -> (kind: String, minutes: Int) {
        let minutes = toolsAt > 0 ? max(0, (now - toolsAt) / 60_000) : 0
        if !error.isEmpty { return ("error", minutes) }
        return (toolsAt > 0 ? "loaded" : "never", minutes)
    }
}
