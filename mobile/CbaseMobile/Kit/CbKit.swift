import SwiftUI

// Small shared building blocks of all pages — the counterpart of web/src/components/CbKit.tsx, as far as a phone needs them.

// ── Back to the overview ────────────────────────────────────────────────────
/// The way out of a category back to the overview. Stands as `leading` in the `PaneScaffold`, so BEFORE the title — where the
/// hand looks for it.
///
/// The baseline is set by hand: the header aligns its row to the first text baseline, and a symbol in a fixed frame has none —
/// without the setting the arrow would sit on the top edge of the title.
struct CbBackButton: View {
    let action: () -> Void
    /// Test-rig identifier — the coding pages `coding-back` (via `PaneScaffold`), the project detail `projects-back`. Without a
    /// setting: the old one (`manager-back`).
    var identifier: String

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.symbol(17, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
        .accessibilityLabel(L("Back to overview"))
        .accessibilityIdentifier(identifier)
    }
}

// ── The form of the pages ───────────────────────────────────────────────────
//
// The phone translation of the desktop's glass design: ONE surface per list (not a card per row), rows separated by hairlines, the
// mark INSIDE the box, filters as a segment bar instead of a cloud of capsules, rare actions behind a menu. The accent stays a
// signal (running, selected, primary action) — not a surface.
//
// No accessibility identifier on these containers: an identifier on the stack travels to every child and overrides its own
// (measured at the "To archive" button).

/// The surface. Optionally carries a mark (overline) and a count in the header; the content brings its rows and padding along
/// itself (`cbRow()`) so that the hairlines sit flush.
struct CbPane<Content: View>: View {
    var marker: String? = nil
    var count: Int? = nil
    /// Tinted for "running right now" — the one surface that may announce itself.
    var accent = false
    /// Dashed for "something new arises here" (drop-in, create).
    var dashed = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let marker {
                HStack(spacing: 6) {
                    CbOverline(marker)
                    if let count, count > 0 {
                        Text("\(count)")
                            .cbFont(10.5, weight: .semibold)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.top, 11)
                .padding(.bottom, 2)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            accent ? AnyShapeStyle(Color.accentColor.opacity(0.09)) : AnyShapeStyle(.cbSurface),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay {
            if dashed {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(accent ? Color.accentColor.opacity(0.35) : CbColor.edge)
            }
        }
    }
}

/// The mark of a surface or section: small, muted, without capitals and tracking, like the section headers of the Claude app.
struct CbOverline: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .cbFont(11.5, weight: .medium)
            .foregroundStyle(CbColor.textMuted)
    }
}

/// The hairline between two rows — indented like the text above.
struct CbSeparator: View {
    var inset: CGFloat = 14
    var body: some View { Divider().padding(.leading, inset) }
}

/// The hairline between two rows of a list WITHOUT a surface (the quiet form: projects, project view, workflows, subagents): one
/// device pixel in `CbColor.edge` across the container's full width — the caller does the indenting. Unlike `CbSeparator` (the
/// `Divider` INSIDE a `CbPane`) it lies directly on the page ground.
struct CbHairline: View {
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle()
            .fill(CbColor.edge)
            .frame(height: 1 / max(scale, 1))
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}

extension View {
    /// The padding of a row in a `CbPane`, with a tap area across the full width.
    func cbRow(vertical: CGFloat = 10) -> some View {
        self
            .padding(.horizontal, 14)
            .padding(.vertical, vertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }
}

// ── Segment bar ─────────────────────────────────────────────────────────────
/// A segment: value, label, test-rig identifier, optional count, color dot and warning dot.
struct CbSegment<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    let id: String
    var count: Int? = nil
    var point: Color? = nil
    var warning = false
}

/// ONE value from a fixed list — as a bar with a cushion, not as a row of equal-looking capsules: nine capsules side by side read
/// like nine actions. With `fills` the segments share the width; without they scroll at natural width — and with it too, as soon
/// as a label no longer fits fully (large text size).
///
/// The cushion does NOT glide: a `matchedGeometryEffect` used to carry it sideways to the new segment, and the choice ran in a
/// spring (0.28 s) that took EVERY follow-up change of the page along — the content below faded and shifted with it. Now the choice
/// stands without a transaction, the cushion cross-fades in 0.12 s, and the caller fades the content below in with
/// `.cbFadeIn(at:)` (pattern there).
struct CbSegments<Value: Hashable>: View {
    let options: [CbSegment<Value>]
    @Binding var selection: Value
    var fills = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// In a drawer (`drawerGlass`) on Liquid Glass: the bar is a glass capsule, the cushion a step INSIDE it (`CbGlass.selected`,
    /// no glass on glass). Otherwise and below iOS 26 the opaque bar.
    @Environment(\.drawerGlass) private var drawerGlass

    private var onGlass: Bool { drawerGlass && CbGlass.on }

    var body: some View {
        Group {
            if fills {
                // Filled only while every label fits FULLY — otherwise the bar scrolls as with `fills: false`. With the app-wide text
                // size, the filled form truncated three of four tabs at "Very large" on system L ("Inpu… 1 | Raw… | Extra… |
                // Inpu…"); a truncated tab no longer says where it leads.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 2) {
                        ForEach(options) { segment($0).frame(maxWidth: .infinity) }
                    }
                    scrolling
                }
            } else {
                scrolling
            }
        }
        .modifier(SegmentReason(onGlass: onGlass))
    }

    /// The scrolling form: labels at full width, the chosen tab is rolled in.
    private var scrolling: some View {
        ScrollViewReader { reader in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) { ForEach(options) { segment($0).id($0.value) } }
            }
            .onAppear { reader.scrollTo(selection) }
            .onChange(of: selection) { _, fresh in
                // Scrolls only when the segment sits half hidden at the edge; with "Reduce Motion" without travel.
                if reduceMotion { reader.scrollTo(fresh) } else { withAnimation(.easeOut(duration: 0.2)) { reader.scrollTo(fresh) } }
            }
        }
    }

    private func segment(_ o: CbSegment<Value>) -> some View {
        let active = o.value == selection
        return Button {
            // WITHOUT a transaction: a spring here would also animate everything the page makes of the choice (see header).
            selection = o.value
        } label: {
            HStack(spacing: 5) {
                if let p = o.point { Circle().fill(p).frame(width: 6, height: 6) }
                Text(o.label).lineLimit(1)
                if let n = o.count, n > 0 {
                    Text("\(n)")
                        .monospacedDigit()
                        .foregroundStyle(active ? Color.secondary : Color.secondary.opacity(0.75))
                }
                if o.warning { Circle().fill(Color.orange).frame(width: 5, height: 5) }
            }
            .cbFont(12.5, weight: active ? .semibold : .medium)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(active ? Color.primary : Color.secondary)
            .background {
                // The cushion per segment, without shared geometry: the old one fades out, the new one in — in place.
                // The animation hangs ONLY on this background (`value: active`), not on the choice.
                ZStack {
                    if active && onGlass {
                        Capsule()
                            .fill(CbGlass.selected)
                            .transition(.opacity)
                    } else if active {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(CbColor.selection)
                            .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
                            .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: CbFade.cushion), value: active)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(o.id)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// The ground of a `CbSegments`: opaque with rounded corners, on glass a glass capsule with a 4 pt rim instead of 3 (the cushion
/// stands as a smaller capsule concentric inside it).
private struct SegmentReason: ViewModifier {
    let onGlass: Bool

    func body(content: Content) -> some View {
        if onGlass {
            content
                .padding(4)
                .cbGlass(Capsule())
        } else {
            content
                .padding(3)
                .background(.cbElevated, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
    }
}

// ── Fade in instead of glide ────────────────────────────────────────────────
/// The timings of the ONE motion when a view changes.
enum CbFade {
    /// The new content fades in — a choice in a drawer (also of the places Coding · Apps · Profile), a bar's segment.
    static let content: Double = 0.15
    /// The cushion of a `CbSegments` cross-fades.
    static let cushion: Double = 0.12
}

/// The new content fades in at `CbFade.content` (easeOut, opacity only) — instead of gliding sideways or switching in a spring.
///
/// Two triggers:
///  • `at`: the value changes (segment, shell counter). Via `keyframeAnimator`, not via a state plus `withAnimation`: "first 0 without
///    animation, then 1 with" lands in the same pass and shows nothing — an animation starts at the last DRAWN value, and that was
///    1. The jump to 0 is a `MoveKeyframe` in the same frame as the change. So the modifier must hang on a container that SURVIVES
///    the change (ScrollView, Stack) — on an `if` branch it would be new with the new branch and play nothing.
///  • `atAppear`: for a page that swaps a segment as a WHOLE (the kinds of agents and workflows with their own `.id`) — there the
///    container itself is new. Once per identity; a reappearance (sheet closed, stack popped back) does not fade again.
///
/// With "Reduce Motion" the content stands at once.
struct CbFadeIn<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    let atAppear: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    func body(content: Content) -> some View {
        let quiet = reduceMotion
        content
            .opacity(!atAppear || appeared || quiet ? 1 : 0)
            .keyframeAnimator(initialValue: 1.0, trigger: trigger) { content, opacity in
                content.opacity(opacity)
            } keyframes: { _ in
                KeyframeTrack(\.self) {
                    MoveKeyframe(quiet ? 1.0 : 0.0)
                    LinearKeyframe(1.0, duration: CbFade.content, timingCurve: .easeOut)
                }
            }
            .onAppear {
                guard atAppear, !appeared else { return }
                if quiet {
                    appeared = true
                } else {
                    withAnimation(.easeOut(duration: CbFade.content)) { appeared = true }
                }
            }
    }
}

extension View {
    /// Fades the content in briefly when `value` changes (and with `atAppear` on first appearance) — see `CbFadeIn`.
    func cbFadeIn<Value: Equatable>(at value: Value, atAppear: Bool = false) -> some View {
        modifier(CbFadeIn(trigger: value, atAppear: atAppear))
    }
}

// ── Small controls ──────────────────────────────────────────────────────────
/// The label of a `Menu`: a quiet capsule with an up/down arrow — for "one of many" where a segment bar would be too wide
/// (projects, kinds, areas, the cadence).
struct CbMenuLabel: View {
    let title: String
    var systemImage: String? = nil
    var active = false

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage).font(.symbol(11, weight: .semibold))
            }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.symbol(9, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .cbFont(12.5, weight: .medium)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .background(.cbElevated, in: Capsule())
        .fixedSize()
    }
}

/// A quiet action as text — for "Edit", "Reject", "Cancel" next to the one filled button. Two filled buttons side by side claim
/// two main paths.
struct CbTextButton: View {
    let title: String
    var destructive = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .cbFont(13, weight: .medium)
                .foregroundStyle(destructive ? Color.red : Color.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

/// Round symbol button for the header (like "Create folder" in the coding overview).
struct CbRoundButton: View {
    let systemImage: String
    var accent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.symbol(13, weight: .semibold))
                .foregroundStyle(accent ? CbColor.primaryButtonText : Color.primary)
                .frame(width: 32, height: 32)
                // `accent` means "the main path" — neutral like the primary button of the Claude app.
                .background(accent ? AnyShapeStyle(CbColor.primaryButton) : AnyShapeStyle(.cbElevated), in: Circle())
        }
        .buttonStyle(.plain)
    }
}

/// The search field of the pages: a capsule with a magnifier, a clear button as soon as something is typed. ONE version for chats,
/// facts, material, raw data and files.
struct CbSearch: View {
    let placeholder: String
    @Binding var text: String
    var identifier: String
    var onSubmit: () -> Void = {}

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.symbol(12, weight: .semibold))
                .foregroundStyle(.secondary)
            TextField(placeholder, text: $text)
                .cbFont(13)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier(identifier)
                .onSubmit(onSubmit)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.symbol(13))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Clear search"))
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(.cbSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(CbColor.edge))
    }
}

/// A field/value pair of an item card or a detail: label on the left at a fixed width, value on the right — instead of two rows
/// per field, which make a card with four fields eight rows tall.
struct CbField: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .cbFont(11.5, weight: .medium)
                .foregroundStyle(.secondary)
                .frame(width: 88, alignment: .leading)
            Text(value)
                .cbFont(13)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// ── Origin of an entry in the project ───────────────────────────────────────
//
// ONE component for agents, MCP, credentials and workflows — the twin of `web/src/components/Origin.tsx`: the folder for the
// project in the accent, the stacked layers for the workspace neutral. What is its own carries the accent, what is inherited one step quieter.

enum OriginKind {
    case project, workspace

    var symbol: String { self == .project ? "folder" : "square.stack.3d.up" }
    var word: String { self == .project ? L("Project") : L("Workspace") }
    var tone: Color { self == .project ? .accentColor : .secondary }
    var surface: Color { self == .project ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.14) }
}

/// The small mark on a row: glyph and word in a capsule.
struct OriginMarker: View {
    let kind: OriginKind

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: kind.symbol)
                .font(.symbol(8.5, weight: .semibold))
            Text(kind.word)
                .cbFont(10.5, weight: .semibold)
        }
        .foregroundStyle(kind.tone)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(kind.surface, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// The header of a section: the glyph in a tinted tile, "Project · Name" resp. "Workspace · Name", with an optional sentence below.
/// If the name is missing, only the word stands.
struct OriginHeader: View {
    let kind: OriginKind
    var name: String? = nil
    var hint: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: kind.symbol)
                .font(.symbol(12, weight: .semibold))
                .foregroundStyle(kind.tone)
                .frame(width: 26, height: 26)
                .background(kind.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(kind.word)
                        .cbFont(14, weight: .semibold)
                    if let name, !name.isEmpty {
                        Text("· \(name)")
                            .cbFont(14)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if let hint, !hint.isEmpty {
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
    }
}

// ── Surface for the accessibility container ─────────────────────────────────
extension View {
    /// Makes an accessibility container (`.accessibilityElement(children: .contain)`) report the frame of its VISIBLE surface.
    /// Since iOS 26.5 such a container reports only the union of its children — the padding between children and surface edge
    /// (island air at the sides, the docked bottom of the strip stack) dropped out of the reported frame, and the UI tests,
    /// which measure these anchors, saw a surface 10 pt narrower and as high as its content. An empty, label-less element
    /// behind the view gives the union back the surface bounds. It carries no label and no traits, so VoiceOver skips it.
    func cbSurfaceFrame() -> some View {
        background {
            Color.clear
                .accessibilityElement()
                .accessibilityHidden(false)
        }
    }
}
