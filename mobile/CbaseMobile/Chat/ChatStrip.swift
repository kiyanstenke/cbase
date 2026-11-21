import SwiftUI

// ── Docked strip stack above the composer island ────────────────────────────
// Counterpart of `ComposerBase` on the web. No house glass variables here, but HIG material and
// shapes — on mobile that is the equivalent, not the web look.
//
// The stack is ONE element: a surface with one border, the rows (chips · goal · queued messages
// · "+n more") separated inside by hairlines — the house pattern "one surface per list"
// (`CbPane`/`CbSeparator`). The task list (`NativeTaskBar`) still sits ABOVE it.

/// The stack: a neutral surface peeking out from under the island. Neutral and not
/// accent blue, because four blue bars visible at once above the input field devalue the color
/// that otherwise says "running right now" for exactly one thing. The chips INSIDE stay blue.
/// The content is `CbStripRow`s; the separators in between are set by the caller, since only
/// it knows which row is the first.
struct CbStrip<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // With glass (iOS 26): glass like the island — both sit in ONE `CbGlassGroup`
        // (`ChatComposer.body`) and flow into each other there. Otherwise one step above the island
        // (`CbColor.elevated` against its `surface`, opaque rather than material): two
        // equal surfaces on top of each other, and the stack's edge would blur exactly where it
        // should tell the docking.
        .cbGlass(RoundedRectangle(cornerRadius: 15, style: .continuous)) {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(CbColor.elevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .strokeBorder(CbColor.edge, lineWidth: 1)
                )
        }
        .cbSurfaceFrame()
    }
}

/// The dimensions of the stack rows — ONCE, so all rows (compact, goal, project choice, graph start, queued
/// messages, "+n more") carry the same font and the same symbol column.
enum CbStripMass {
    /// Font of every row (as in ChatGPT, where the strips sit 1 pt below the input field,
    /// 14 to 15). The field (`ChatInputTextView`) sets `.body` (17 at category L), so here `.callout` (16) — both on
    /// the Dynamic Type curve, the 1 pt gap stays at every text size.
    static let font: Font = .callout
    /// Fixed size of the symbols in the rows (like the symbols of the TopBar: they do not grow with the text size).
    static let symbol: CGFloat = 15
    /// Width of the symbol column at the front — the texts of stacked rows line up.
    static let symbolColumn: CGFloat = 20
    /// Visible frame of a row's symbol button = center distance of two buttons (28 pt, like the web). Each button used
    /// to stand in the layout with its full 44 pt hit area — three of them took ~117 pt on the iPhone (393 pt),
    /// leaving ~10 pt for the goal text.
    static let button: CGFloat = 28
    /// Height of a symbol button's hit area (HIG: 44 pt).
    static let hits: CGFloat = 44
    /// How far the hit area is taken out of the layout at top and bottom: it reaches into the row padding instead of
    /// inflating the row to 44 pt (20 pt remain — about the row height of the font).
    static let hitOverhang: CGFloat = 12
    /// How far the hit area of the OUTER button of a group reaches sideways beyond its frame (at the front into the padding
    /// before the group, at the back into the row padding). Between two neighbors nothing reaches: there the middle divides (28 pt each) — a
    /// 44 pt wide area per button would overlap the neighbor's by 16 pt at 28 pt center distance, and the upper button would take taps
    /// from the lower one on its own symbol (the trash can deletes without confirmation).
    static let hitMargin: CGFloat = 8
}

/// A row in the stack: only the padding — surface and border belong to the stack. The row sets the font itself
/// (`CbStripMass.font`); the content only names weight and color.
struct CbStripRow<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .font(CbStripMass.font)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CbStripSeparator.inset)
            .padding(.vertical, 7)
    }
}

/// A symbol button in a stack row (delete goal, pause, expand): dimmed, `button` wide in the layout (28 pt —
/// the center distance of the group) and 20 pt high; the hit area is 44 pt high and reaches into the row padding
/// (`hitOverhang`), sideways only at the edge of the group (`vorn`/`hinten`, see `hitMargin`). The area is laid over a
/// frame WITH padding and the padding is then taken out of the layout again (negative padding on the button) — so it counts
/// for the hit, not for the width. The identifier sits on the button, not on the row.
struct CbStripSymbolButton: View {
    let systemImage: String
    let label: String
    let identifier: String
    /// Overhang of the hit area to the front or back — only on the outer button of a group, otherwise 0.
    var front: CGFloat = 0
    var rear: CGFloat = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.symbol(CbStripMass.symbol))
                .foregroundStyle(CbColor.textMuted)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: CbStripMass.button, height: CbStripMass.hits)
                .padding(.leading, front)
                .padding(.trailing, rear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -CbStripMass.hitOverhang)
        .padding(.leading, -front)
        .padding(.trailing, -rear)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// The pulsing dot of the compact row — in the accent, no pulse with "Reduce Motion". The pulse runs via
/// `phaseAnimator` and affects only size and opacity of the dot: a `repeatForever` animation over a
/// state would otherwise run into the row's enter/exit transition.
struct CbStripPulseDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let point = Circle()
            .fill(Color.accentColor)
            .frame(width: 7, height: 7)
        if reduceMotion {
            point
        } else {
            point.phaseAnimator([false, true]) { content, light in
                content
                    .scaleEffect(light ? 1 : 0.6)
                    .opacity(light ? 1 : 0.4)
            } animation: { _ in
                .easeInOut(duration: 0.8)
            }
        }
    }
}

/// The hairline between two rows of the stack (pattern `CbSeparator`): inset by the
/// row's horizontal padding so the line starts where the content starts.
struct CbStripSeparator: View {
    static let inset: CGFloat = 12
    var body: some View { Divider().padding(.leading, Self.inset) }
}

// ── Hints under the header and in the history ───────────────────────────────
// Meant are the rows under the chat header (limit, workflow, tasks) and the messages in the
// history. They share ONE form, fitting the header zone above: a
// slim, rounded row in `CbColor.elevated`, a small SF symbol, text in primary or
// muted type. Color is carried ONLY by the symbol, and only for a state (`CbHintTone`) —
// never the surface, no glass.

enum CbHintMass {
    /// Radius of the row — one step smaller than the strip stack's (15), because the row
    /// is lower.
    static let radius: CGFloat = 12
    /// Side inset in the header zone: the row stands free, not edge to edge.
    static let inset: CGFloat = 10
    /// Space below every row — between two hints and to the edge of the header zone.
    static let gap: CGFloat = 6
    /// Width of the symbol column so the texts of stacked hints line up.
    static let symbolColumn: CGFloat = 16
}

/// The state of a hint — the only place where it carries color.
enum CbHintTone {
    /// No state, just information.
    case quiet
    /// It is running (accent, like the running hexagon).
    case running
    /// It is waiting — orange, muted.
    case waiting
    /// Fehlgeschlagen.
    case error

    var color: Color {
        switch self {
        case .quiet: return CbColor.textMuted
        case .running: return Color.accentColor
        case .waiting: return Color.orange.opacity(0.85)
        case .error: return Color.red
        }
    }
}

/// The symbol at the front of a hint: small, fixed (like the symbols of the TopBar), in the color of its
/// state.
struct CbHintSymbol: View {
    let systemImage: String
    var tone: CbHintTone = .quiet

    var body: some View {
        Image(systemName: systemImage)
            .font(.symbol(12, weight: .medium))
            .foregroundStyle(tone.color)
            .frame(width: CbHintMass.symbolColumn)
            .accessibilityHidden(true)
    }
}

/// The surface of a hint: `elevated`, rounded, no edge. `indented` (default): with
/// the side inset and the space below, as under the header; in the history the rows already stand
/// in the text column — there without.
struct CbHintSurface: ViewModifier {
    var indented = true

    func body(content: Content) -> some View {
        content
            .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: CbHintMass.radius, style: .continuous))
            .padding(.horizontal, indented ? CbHintMass.inset : 0)
            .padding(.bottom, indented ? CbHintMass.gap : 0)
    }
}

extension View {
    /// Surface of a hint (see `CbHintSurface`).
    func cbHintSurface(indented: Bool = true) -> some View {
        modifier(CbHintSurface(indented: indented))
    }
}

/// An error in the history of a conversation — the form of the hints: red symbol, text in
/// primary type on `elevated`. The kit building block `InlineError` (red text on a red-tinted surface)
/// stays for the other pages.
struct ChatErrorRow: View {
    let message: String

    var body: some View {
        if !message.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                CbHintSymbol(systemImage: "exclamationmark.triangle", tone: .error)
                Text(message)
                    .chatFont(.caption)
                    .foregroundStyle(CbColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                    // On the text, not on the stack (an identifier on the stack would overwrite those of the children) — ChatReconcileUITests.
                    .accessibilityIdentifier("chat-error")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .cbHintSurface(indented: false)
        }
    }
}

/// A queued message. "Steer" is carried only by the TOPMOST strip: the button applies to the
/// whole queue, on every row it would stand three times for the same action.
struct StripMessage: View {
    let text: String
    /// Label of the steer button, or nil — then this strip carries none.
    let controlTitle: String?
    let controlLocked: Bool
    let onControl: () -> Void
    /// nil: a system message (the completion notice of a subagent) — no trash can, otherwise the main agent
    /// would never get the report.
    let onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: onDismiss == nil ? "person.2" : "clock")
                .font(.symbol(CbStripMass.symbol, weight: .medium))
                .foregroundStyle(CbColor.textMuted)
                .frame(width: CbStripMass.symbolColumn)
            Text(text)
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(onDismiss == nil ? CbColor.textMuted : CbColor.text)
                .accessibilityIdentifier(onDismiss == nil ? "composer-system-notice" : "composer-message")
            Spacer(minLength: 4)
            if let title = controlTitle {
                Button(action: onControl) {
                    Label(title, systemImage: "arrow.turn.down.right")
                        .labelStyle(.titleAndIcon)
                        .fontWeight(.medium)
                }
                .buttonStyle(.plain)
                .foregroundStyle(CbColor.textMuted)
                .disabled(controlLocked)
                .opacity(controlLocked ? 0.5 : 1)
                .accessibilityIdentifier("composer-control")
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "trash")
                        .font(.symbol(CbStripMass.symbol))
                }
                .buttonStyle(.plain)
                .foregroundStyle(CbColor.textMuted)
                .accessibilityLabel(L("Dismiss"))
                .accessibilityIdentifier("composer-dismiss")
            }
        }
        // No own font: the row (`CbStripRow`) sets `CbStripMass.font` the same for all rows.
    }
}
