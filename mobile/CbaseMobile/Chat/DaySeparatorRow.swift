import SwiftUI

// The row of the day separator: wavy hairline · "Today" / "Yesterday" / "Wednesday, 4 November" ·
// wavy hairline, centered — twin of web/src/components/chat/DaySeparator.tsx. The computation (which row, which day)
// lives in `DaySeparator.markers` (Chat/DaySeparator.swift), inserted as a `.day` row in `MobileChatView.timelineRows`.
// The wave is a `Shape` (no `Canvas`, which this app avoids), colors from the system via `CbColor`.

/// The visible text of a marker.
func dayText(_ m: DayMarker) -> String {
    switch m.kind {
    case .today: return L("Today")
    case .yesterday: return L("Yesterday")
    case .date:
        let f = DateFormatter()
        f.locale = Loc.locale
        f.setLocalizedDateFormatFromTemplate(m.withYear ? "EEEEdMMMMy" : "EEEEdMMMM")
        return f.string(from: Date(timeIntervalSince1970: m.ms / 1000))
    }
}

/// A sine wave across the full width, period `period` pt, amplitude `height / 2`.
struct WaveLine: Shape {
    var period: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let middle = rect.midY
        let a = rect.height / 2
        let half = period / 2
        var x = rect.minX
        p.move(to: CGPoint(x: x, y: middle))
        var top = true
        while x < rect.maxX {
            let target = min(x + half, rect.maxX)
            let share = (target - x) / half
            p.addQuadCurve(to: CGPoint(x: target, y: middle),
                           control: CGPoint(x: x + half / 2 * share, y: middle + (top ? -a : a) * 2 * share))
            x = target
            top.toggle()
        }
        return p
    }
}

struct DaySeparatorRow: View {
    let marker: DayMarker

    private var wave: some View {
        WaveLine()
            .stroke(CbColor.textMuted.opacity(0.7), lineWidth: 1)
            .frame(minWidth: 24, maxWidth: .infinity)
            .frame(height: 5)
            .accessibilityHidden(true)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            wave
            Text(dayText(marker))
                .chatFont(.caption)
                .foregroundStyle(CbColor.textSecondary)
                .lineLimit(1)
                .fixedSize()
                .layoutPriority(1)
            wave
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-day-separator")
    }
}
