import Foundation

// The agenda of ONE coding chat as shape and pure computation — the iOS counterpart of `web/src/lib/api/agenda.ts` (shape,
// `normAgenda`) and `web/src/lib/agenda.ts` (visible rows, folding, progress, empty, which version wins, "… ago"). Foundation
// only, no SwiftUI, no `L(…)`: the words from `sinceText` are keys that the sheet (`Chat/AgendaSheet.swift`) translates; they are
// listed by hand in `Kit/LocDEAgenda.swift` because `loc-audit.sh` only sees literal calls. Bound to the web in
// `web/test/agenda-binding.test.mjs` (both versions translated and run on the same cases).
//
// The chat's main agent maintains the agenda (MCP `cbase_agenda_write`, server `server/backend/electron/server/agenda/`);
// the app only READS: `GET /api/chats/:id/agenda` (`{ agenda, keepsAgenda }`) and the event
// `{ type: "harness", subtype: "agenda", chatId, agenda }` in the chat stream.
//
// Decoding is LENIENT like `GraphRuns`/`DynTree`: a synthesized `Decodable` demands every key, and one missing field would
// make the whole agenda unreadable. A step without an id is dropped; an unknown status reads as "open" like on the server
// (better one open step too many than one silently vanished).
//
// The agenda is a TREE: `steps` stays flat in PRE-ORDER, each item additionally carries `parent`, `depth`, `subitems`,
// `done`/`total` (leaves in the subtree) and `project` (optional — an older server does not send it, a deleted project
// arrives as `null`). The server COMPUTES the status of an item with subitems; the app shows it. `visibleRows` (twin of
// `web/src/lib/agenda.ts`) says which rows of the tree show at which stage, `toggleFold`/`readDeviations` keep the fold memo
// (UserDefaults, same key as `localStorage` on the web).
//
// An item optionally carries `upkeep`: the mark of the agenda keeper, a fixed outer-loop agent that catches up on what the
// main agent forgot. The sheet shows it as a quiet ring around the status symbol and explains it in the item's sheet. The ring
// STAYS when the main agent touches the item afterwards; `afterwards` says what happened since (`upkeepAfterwards`, the words
// `upkeepAfterwardsWord` — keys, translated in the sheet).
struct Agenda: Decodable, Equatable {
    /// The sub-kind of the event in the chat stream (harness).
    static let event = "agenda"
    /// The three statuses in the server's order (`store/agenda.js AGENDA_STATUS`).
    static let status = ["open", "in_work", "done"]
    /// What happened after the agenda keeper's mark — the server's values (`AGENDA_UPKEEP_AFTERWARDS`, bound in
    /// `server/backend/test/agenda.test.js`): open (nobody, or only the server), confirmed (edited by the main agent),
    /// corrected (taken back), outdated (it set the stage itself).
    static let upkeepAfterwards: [String] = ["open", "confirmed", "corrected", "outdated"]
    /// The word for it as a key (`open` says nothing) — same as `UPKEEP_AFTERWARDS_WORD` on the web (agenda-binding.test.mjs).
    static let upkeepAfterwardsWord: [String: String] = [
        "confirmed": "edited by the main agent afterwards",
        "corrected": "taken back by the main agent afterwards",
        "outdated": "taken over by the main agent afterwards",
    ]

    /// The project of a top-level item, resolved on the server at read time. Without an id it is none (decoding throws, `Step`
    /// then reads it as `nil`).
    struct Project: Decodable, Equatable {
        let id: String
        let name: String

        private enum CodingKeys: String, CodingKey { case id, name }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let id = c.str(.id)
            guard !id.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "Project without id")
            }
            self.id = id
            name = c.str(.name)
        }
    }

    /// The agenda keeper's mark on an item: who, in which run, when and what — `fresh` created or `status` set, for `status`
    /// with the status before. Display only; it stays after other writers, `afterwards` says what happened since. An unknown kind
    /// reads as no mark (decoding throws, `Step` then reads `nil`) — better a missing one than a wrongly explained one.
    struct Upkeep: Decodable, Equatable {
        let agentId: String
        let runId: String
        /// Milliseconds; 0 = unknown.
        let at: Double
        /// `fresh` · `status`.
        let kind: String
        /// The status before the change — only for `status` and only a known one, else `nil`.
        let prior: String?
        /// What happened afterwards (`Agenda.upkeepAfterwards`) — `nil` = unknown (older server, no log line, an unknown
        /// value); the mark then stays, just without the addendum.
        let afterwards: String?

        private enum CodingKeys: String, CodingKey { case agentId, runId, at, kind, prior, afterwards }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let kind = c.str(.kind)
            guard kind == "fresh" || kind == "status" else {
                throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Upkeep without known kind")
            }
            self.kind = kind
            agentId = c.str(.agentId)
            runId = c.str(.runId)
            let at = c.dbl(.at)
            self.at = at.isFinite && at > 0 ? at : 0
            let prior = c.str(.prior)
            self.prior = kind == "status" && Agenda.status.contains(prior) ? prior : nil
            let afterwards = c.str(.afterwards)
            self.afterwards = Agenda.upkeepAfterwards.contains(afterwards) ? afterwards : nil
        }
    }

    struct Step: Decodable, Equatable, Identifiable {
        let id: String
        /// Id of the parent item; `nil` = top level.
        let parent: String?
        /// 0 = top level.
        let depth: Int
        /// Heading — ONE line in the app.
        let text: String
        /// Markdown; only visible behind the note icon.
        let note: String
        /// `open` · `in_work` · `done` — an unknown value becomes `open`. With subitems: computed on the server.
        let status: String
        /// Number of DIRECT children — only an item with subitems can be folded.
        let subitems: Int
        /// Done leaves and all leaves in the subtree (without subitems 0/0).
        let done: Int
        let total: Int
        /// Only on top-level items; `nil` = none, deleted or an older server.
        let project: Project?
        let createdAt: Double
        let changedAt: Double
        /// Only for `done`, else `nil`.
        let doneAt: Double?
        /// Created or set by the agenda keeper — `nil` = not marked, an older server or unreadable.
        let upkeep: Upkeep?

        private enum CodingKeys: String, CodingKey {
            case id, parent, depth, text, note, status, subitems, done, total, project, createdAt, changedAt, doneAt, upkeep
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let id = c.str(.id)
            guard !id.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "Step without id")
            }
            self.id = id
            let parent = c.str(.parent)
            self.parent = parent.isEmpty ? nil : parent
            depth = Self.whole(c, .depth)
            text = c.str(.text)
            note = c.str(.note)
            let raw = c.str(.status)
            status = Agenda.status.contains(raw) ? raw : "open"
            subitems = Self.whole(c, .subitems)
            done = Self.whole(c, .done)
            total = Self.whole(c, .total)
            project = (try? c.decodeIfPresent(Project.self, forKey: .project)) ?? nil
            createdAt = c.dbl(.createdAt)
            let changed = c.dbl(.changedAt)
            changedAt = changed > 0 ? changed : createdAt
            let doneMs = c.dbl(.doneAt)
            doneAt = status == "done" && doneMs > 0 ? doneMs : nil
            upkeep = (try? c.decodeIfPresent(Upkeep.self, forKey: .upkeep)) ?? nil
        }

        /// A count or depth: whole number ≥ 0, truncated — anything else 0 (like `ganz` in `web/src/lib/api/agenda.ts`).
        private static func whole(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int {
            guard let d = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil, d.isFinite, d > 0 else { return 0 }
            return d >= 1e15 ? Int(1e15) : Int(d.rounded(.down))
        }
    }

    /// A step that cannot be read (no id) becomes `nil` — and is dropped instead of tearing down the agenda.
    private struct MaybeStep: Decodable {
        let step: Step?
        init(from decoder: Decoder) throws { step = try? Step(from: decoder) }
    }

    let chatId: String
    let title: String
    let description: String
    let steps: [Step]
    /// 0 = never written; every change counts one up — the app only accepts a NEWER version.
    let version: Int
    /// Milliseconds; `nil` = never written (not "0 ms ago").
    let changedAt: Double?

    private enum CodingKeys: String, CodingKey { case chatId, title, description, steps, version, changedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        title = c.str(.title)
        description = c.str(.description)
        steps = c.list(.steps, MaybeStep.self).compactMap(\.step)
        version = c.int(.version)
        let changed = c.dbl(.changedAt)
        changedAt = changed > 0 ? changed : nil
    }

    /// The state in the chat's model: "not loaded" until the route has answered — "no agenda yet" only shows AFTER loading
    /// (empty is not unknown). An error leaves an already shown state in place.
    struct Snapshot: Equatable {
        var agenda: Agenda?
        var loaded = false
        /// `false`: the chat keeps no agenda (not a coding chat) — the sheet says so instead of showing "none yet".
        var keepsAgenda = true
        var error = ""
    }

    /// The route's response (`GET /api/chats/:id/agenda`).
    struct Response: Decodable {
        let agenda: Agenda?
        let keepsAgenda: Bool
        private enum CodingKeys: String, CodingKey { case agenda, keepsAgenda }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            agenda = (try? c.decodeIfPresent(Agenda.self, forKey: .agenda)) ?? nil
            // A missing field (older server) counts as "yes" — like on the web.
            keepsAgenda = c.bool(.keepsAgenda, true)
        }
    }

    /// The event from the stream: `chatId` and `agenda` — an event of another chat never applies.
    private struct Event: Decodable {
        let chatId: String
        let agenda: Agenda?
        private enum CodingKeys: String, CodingKey { case chatId, agenda }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            chatId = c.str(.chatId)
            agenda = (try? c.decodeIfPresent(Agenda.self, forKey: .agenda)) ?? nil
        }
    }

    // MARK: Computation (counterpart of web/src/lib/agenda.ts)

    /// The sheet indents no deeper: level 4 and deeper sit on stage 3.
    static let stages = 3

    /// Under this key (UserDefaults; on the web `localStorage`, same wording) lie a chat's deviations.
    static func foldKey(_ chatId: String) -> String { "cbase-agenda-fold:\(chatId)" }

    /// A visible row of the tree: the item, its indent `min(depth, stages)` and whether it is expanded — only an item with
    /// subitems can be; a leaf is never "open".
    struct Row: Identifiable, Equatable {
        let point: Step
        let stage: Int
        let open: Bool
        var id: String { point.id }
    }

    /// The fold default: an item with subitems is open as long as its (computed) status is not "done".
    static func foldDefault(_ p: Step) -> Bool { p.status != "done" }

    /// The visible rows in agenda order (pre-order). An item is invisible if its parent is folded or itself invisible — the
    /// whole subtree of a folded item is missing. Read via `parent`, not via depth: an unknown parent hides nothing. A
    /// deviation beats the default; on a leaf nothing.
    static func visibleRows(_ steps: [Step], deviations: [String: Bool]) -> [Row] {
        var hidden = Set<String>()
        var rows: [Row] = []
        for p in steps {
            if let parent = p.parent, hidden.contains(parent) {
                hidden.insert(p.id)
                continue
            }
            let open = p.subitems > 0 && (deviations[p.id] ?? foldDefault(p))
            if p.subitems > 0 && !open { hidden.insert(p.id) }
            rows.append(Row(point: p, stage: min(p.depth, stages), open: open))
        }
        return rows
    }

    /// The memo after a tap on a foldable row: only what deviates from the default is kept; entries of items that no longer
    /// exist drop out. On a leaf nothing changes.
    static func toggleFold(_ deviations: [String: Bool], row: Row, steps: [Step]) -> [String: Bool] {
        guard row.point.subitems > 0 else { return deviations }
        let present = Set(steps.map(\.id))
        var fresh = deviations.filter { $0.key != row.point.id && present.contains($0.key) }
        let open = !row.open
        if open != foldDefault(row.point) { fresh[row.point.id] = open }
        return fresh
    }

    /// The memo from storage: only a JSON object with boolean values counts; anything else is the default — a read error
    /// must not fold the agenda shut.
    static func readDeviations(_ raw: String?) -> [String: Bool] {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8) else { return [:] }
        return (try? JSONDecoder().decode(Memo.self, from: data))?.values ?? [:]
    }

    /// The memo for storage — `nil` if nothing deviates (the key is then removed).
    static func deviationsText(_ deviations: [String: Bool]) -> String? {
        guard !deviations.isEmpty else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(deviations)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// A JSON object of which only the boolean values are taken (`JSONDecoder` does NOT read a number as Bool).
    private struct Memo: Decodable {
        let values: [String: Bool]
        private struct Key: CodingKey {
            let stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            var values: [String: Bool] = [:]
            for k in c.allKeys where !k.stringValue.isEmpty && k.stringValue != "__proto__" {
                if let open = try? c.decode(Bool.self, forKey: k) { values[k.stringValue] = open }
            }
            self.values = values
        }
    }

    /// Progress of the whole agenda: only leaves count (like `agendaCounter` on the server).
    static func progress(_ a: Agenda?) -> (done: Int, total: Int) {
        var done = 0, total = 0
        for s in a?.steps ?? [] where s.subitems == 0 {
            total += 1
            if s.status == "done" { done += 1 }
        }
        return (done, total)
    }

    /// Empty: no title, no description, no step (whitespace alone does not count).
    static func empty(_ a: Agenda?) -> Bool {
        guard let a else { return true }
        return a.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && a.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && a.steps.isEmpty
    }

    /// Is a LEAF in work? Then the header button carries its item. A top-level item is already "in work" once one of its
    /// leaves is done — it would otherwise say "work is going on" where it is only half done.
    static func inWork(_ a: Agenda?) -> Bool {
        a?.steps.contains { $0.subitems == 0 && $0.status == "in_work" } ?? false
    }

    /// Which version wins: the one with the higher version. Load response and event cross — a load that started BEFORE a
    /// change arrives after its event and would bring the old state back. Same version: the existing one stays. A version of
    /// ANOTHER chat never applies.
    static func effective(old: Agenda?, fresh: Agenda?, chatId: String) -> Agenda? {
        let oldApplies = old.flatMap { $0.chatId == chatId ? $0 : nil }
        guard let fresh, fresh.chatId == chatId else { return oldApplies }
        guard let oldApplies else { return fresh }
        return fresh.version > oldApplies.version ? fresh : oldApplies
    }

    /// The state after the load response. Without `chatId` in the response the requested chat applies (like `normAgenda` on the web).
    static func loaded(_ snapshot: Snapshot, response: Response, chatId: String) -> Snapshot {
        var s = snapshot
        s.agenda = effective(old: snapshot.agenda, fresh: response.agenda.map { $0.withChat(chatId) }, chatId: chatId)
        s.loaded = true
        s.keepsAgenda = response.keepsAgenda
        s.error = ""
        return s
    }

    /// The state after a `harness/agenda` event (as JSON) — of another chat or unreadable: unchanged.
    static func afterEvent(_ snapshot: Snapshot, event data: Data?, chatId: String) -> Snapshot {
        guard let data, let e = try? JSONDecoder().decode(Event.self, from: data), e.chatId == chatId, let fresh = e.agenda else {
            return snapshot
        }
        var s = snapshot
        s.agenda = effective(old: snapshot.agenda, fresh: fresh.withChat(chatId), chatId: chatId)
        s.loaded = true
        s.error = ""
        return s
    }

    /// "updated … ago" — a key for `L(…)` plus the number (`ms`/`now` in milliseconds). Under a minute "just now"; a clock
    /// running slow is also "just now" and never "−3 min ago".
    static func sinceText(_ ms: Double?, now: Double) -> (key: String, n: Int)? {
        guard let ms, ms > 0 else { return nil }
        let min = Int((max(0, now - ms) / 60_000).rounded(.down))
        if min < 1 { return ("just now", 0) }
        if min < 60 { return ("{n} min ago", min) }
        let std = min / 60
        if std < 24 { return ("{n} h ago", std) }
        let days = std / 24
        return (days == 1 ? "1 day ago" : "{n} days ago", days)
    }

    /// The same agenda with the requested chat, if the response names none.
    private func withChat(_ id: String) -> Agenda {
        guard chatId.isEmpty else { return self }
        return Agenda(chatId: id, title: title, description: description, steps: steps, version: version, changedAt: changedAt)
    }

    private init(chatId: String, title: String, description: String, steps: [Step], version: Int, changedAt: Double?) {
        self.chatId = chatId
        self.title = title
        self.description = description
        self.steps = steps
        self.version = version
        self.changedAt = changedAt
    }
}
