import Foundation

// The day separator in the history — the PURE computation, twin of `dayMarkers` in web/src/lib/day-separator.ts, bound in
// web/test/day-separator-binding.test.mjs (the file runs there via `xcrun swift` — hence only Foundation, no `L(…)`).
// Drawn in `DaySeparatorRow` (Chat/DaySeparatorRow.swift); inserted in `MobileChatView.timelineRows` as a `.day` row above
// the first row of the day.
//
// The rules (as on the web):
//   • A calendar day is not 24 h: day = year/month/day in `Calendar.current`, "yesterday" = `date(byAdding: .day, -1)`.
//   • A row without a known time (nil/0) NEVER sets a separator and does not change the current day.
//   • The window (`logOlder`): if older rows are still on the server, the first loaded row gets no separator —
//     so a shown separator never disappears again, loading more only pushes rows in front.

struct DayMarker: Hashable, Sendable {
    enum Kind: String, Sendable { case today, yesterday, date }
    /// The calendar day: "2026-11-04".
    let day: String
    let kind: Kind
    /// Only for `.date`: the year is included (not the year of `now`).
    let withYear: Bool
    /// The time of the row that opens the day (ms).
    let ms: Double
}

enum DaySeparator {
    /// Seconds (old servers) become ms, everything ≤ 0 is unknown — like `timeMs` on the web.
    static func timeMs(_ value: Double?) -> Double? {
        guard let w = value, w.isFinite, w > 0 else { return nil }
        return w > 1e12 ? w : w * 1000
    }

    static func dayKey(_ ms: Double, calendar: Calendar = .current) -> String {
        let k = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: ms / 1000))
        return String(format: "%04d-%02d-%02d", k.year ?? 0, k.month ?? 0, k.day ?? 0)
    }

    /// Per row (oldest first, same length): does a day separator stand BEFORE it, and which one?
    static func markers(_ times: [Double?], olderBeforehand: Bool, now: Double, calendar: Calendar = .current) -> [DayMarker?] {
        let nowDate = Date(timeIntervalSince1970: now / 1000)
        let today = dayKey(now, calendar: calendar)
        let yesterdayDate = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: nowDate)) ?? nowDate
        let yesterday = dayKey(yesterdayDate.timeIntervalSince1970 * 1000, calendar: calendar)
        let year = calendar.component(.year, from: nowDate)
        var prior: String?
        return times.map { raw in
            guard let ms = timeMs(raw) else { return nil }
            let day = dayKey(ms, calendar: calendar)
            let fresh = prior == nil ? !olderBeforehand : day != prior
            prior = day
            guard fresh else { return nil }
            let kind: DayMarker.Kind = day == today ? .today : day == yesterday ? .yesterday : .date
            let withYear = kind == .date && calendar.component(.year, from: Date(timeIntervalSince1970: ms / 1000)) != year
            return DayMarker(day: day, kind: kind, withYear: withYear, ms: ms)
        }
    }
}
