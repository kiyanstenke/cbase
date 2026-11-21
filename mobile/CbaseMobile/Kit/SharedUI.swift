import SwiftUI
import UIKit

// Reusable building blocks of the mobile UI. Deliberately kept small and unconnected: cards, headers, toggles, empty states,
// loading animations.

/// The way back to the tab's overview, which a content area hands to its pages (Coding: `CategoryContent`). Every page with
/// `PaneScaffold` thereby gets the arrow before the title without a dozen call sites setting a `leading` — and a page that
/// carries its own `leading` (project detail: back to the list) keeps it.
private struct PaneBackKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var paneBack: (() -> Void)? {
        get { self[PaneBackKey.self] }
        set { self[PaneBackKey.self] = newValue }
    }
}

struct PaneScaffold<Content: View>: View {
    let title: String
    var subtitle: String?
    var trailing: AnyView?
    /// Before the title — in practice the way back (from a category to the overview). Deliberately no `NavigationStack`: these
    /// pages are tab contents, not pushed views, and a system bar above the own header would be a second empty row.
    var leading: AnyView?
    @ViewBuilder var content: () -> Content
    @Environment(\.paneBack) private var paneBack
    /// A sheet INHERITS the environment of its presenting view — without this lock an editor sheet over a Coding page would carry
    /// the same arrow, and it would lead out of the sheet into the overview.
    @Environment(\.isPresented) private var isPresented

    init(
        title: String,
        subtitle: String? = nil,
        trailing: AnyView? = nil,
        leading: AnyView? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
        self.leading = leading
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let leading {
                    leading
                } else if let paneBack, !isPresented {
                    CbBackButton(action: paneBack, identifier: "coding-back")
                }
                VStack(alignment: .leading, spacing: 2) {
                    // Page title in the system font, bold (`cbTitle(.page)`). ONE line that shrinks instead of wrapping — like the drawer
                    // titles (`AppShell`): the bold system font is wider than serif, and at the largest text size "Credentials" otherwise wrapped
                    // mid-word ("Credential" / "s"), beside ⓘ and "New".
                    Text(title)
                        .cbTitle(.page)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .allowsTightening(true)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                if let trailing { trailing }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 10)

            content()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .cbSheetBase()
    }
}

struct PaneCard<Content: View>: View {
    var padding: CGFloat = 14
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.cbSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(CbColor.edge))
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        // Section header like in the Claude app: without capitals, muted.
        Text(text)
            .cbFont(13, weight: .medium)
            .foregroundStyle(CbColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CbToggle: View {
    let isOn: Bool
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? Color.accentColor : Color.secondary.opacity(0.28))
                    .frame(width: 42, height: 26)
                Circle()
                    .fill(.white)
                    .frame(width: 21, height: 21)
                    .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
                    .padding(.horizontal, 2.5)
            }
            .animation(.spring(response: 0.28, dampingFraction: 0.8), value: isOn)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

struct PillButton: View {
    let title: String
    var systemImage: String?
    var prominent = false
    var destructive = false
    var disabled = false
    /// Takes the full available width (for rows in the narrow drawers).
    var fill = false
    let action: () -> Void
    /// In a drawer a glass capsule, the highlighted button tinted — otherwise the surfaces as before.
    @Environment(\.drawerGlass) private var drawerGlass

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.symbol(11, weight: .semibold))
                }
                // Labels stay SINGLE-LINE. In the 322-pt narrow drawer three buttons side by side otherwise wrapped to two lines.
                Text(title)
                    .cbFont(13, weight: .medium)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .padding(.horizontal, fill ? 8 : 12)
            .padding(.vertical, 7)
            .frame(maxWidth: fill ? .infinity : nil)
            // Primary neutral like in the Claude app (light on dark resp. dark on light), secondary a quiet surface instead of an outline —
            // color is carried only by the accent.
            .foregroundStyle(prominent ? CbColor.primaryButtonText : destructive ? Color.red : Color.primary)
            .modifier(PillReason(prominent: prominent, glass: drawerGlass && CbGlass.on))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }
}

/// The ground of a `PillButton`: opaque capsule, in a drawer with glass a glass capsule (the highlighted button tinted in its color).
private struct PillReason: ViewModifier {
    let prominent: Bool
    let glass: Bool

    func body(content: Content) -> some View {
        if glass {
            content
                .contentShape(Capsule())
                .cbGlass(Capsule(), interactive: true, tint: prominent ? CbColor.primaryButton : nil) { EmptyView() }
        } else {
            content.background {
                if prominent {
                    Capsule().fill(CbColor.primaryButton)
                } else {
                    Capsule().fill(.cbElevated)
                }
            }
        }
    }
}

struct ChipButton: View {
    let title: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .cbFont(12, weight: .medium)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .foregroundStyle(active ? CbColor.primaryButtonText : Color.secondary)
                .background {
                    if active {
                        Capsule().fill(CbColor.primaryButton)
                    } else {
                        Capsule().stroke(Color.secondary.opacity(0.25))
                    }
                }
        }
        .buttonStyle(.plain)
    }
}

/// Segmented switch (replacement for the desktop's SlideTabBar).
struct SegmentedPills<Value: Hashable>: View {
    let options: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) {
                        selection = option.value
                    }
                } label: {
                    Text(option.label)
                        .cbFont(12.5, weight: .medium)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .foregroundStyle(selection == option.value ? Color.primary : Color.secondary)
                        .background {
                            if selection == option.value {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(CbColor.selection)
                                    .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(.cbElevated, in: RoundedRectangle(cornerRadius: 11))
    }
}

struct EmptyPaneState: View {
    let title: String
    var message: String?
    var systemImage: String = "tray"

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: systemImage)
                .font(.symbol(30, weight: .light))
                .foregroundStyle(CbColor.textMuted)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
        .padding(.horizontal, 24)
    }
}

struct InlineError: View {
    let message: String

    var body: some View {
        if !message.isEmpty {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 11))
        }
    }
}

// ── Loading animations ──────────────────────────────────────────────────────

/// Soft shimmer gradient that runs over placeholders.
struct ShimmerEffect: ViewModifier {
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geo in
                    LinearGradient(
                        colors: [
                            .clear,
                            Color.white.opacity(0.35),
                            .clear
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: geo.size.width * 0.7)
                    .offset(x: phase * geo.size.width * 1.4)
                    .blendMode(.plusLighter)
                }
                .allowsHitTesting(false)
            }
            .mask(content)
            .onAppear {
                withAnimation(.linear(duration: 1.35).repeatForever(autoreverses: false)) {
                    phase = 1.2
                }
            }
    }
}

extension View {
    func shimmering() -> some View { modifier(ShimmerEffect()) }
}

/// Skeleton of the chat history while the server log is still loading.
struct ChatLoadingSkeleton: View {
    private let widths: [CGFloat] = [0.62, 0.88, 0.74, 0.45, 0.8, 0.58]
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(widths.enumerated()), id: \.offset) { index, width in
                let mine = index % 3 == 0
                HStack {
                    if mine { Spacer(minLength: 50) }
                    VStack(alignment: .leading, spacing: 7) {
                        RoundedRectangle(cornerRadius: 7)
                            .fill(Color.secondary.opacity(0.16))
                            .frame(height: 13)
                            .frame(maxWidth: .infinity)
                        RoundedRectangle(cornerRadius: 7)
                            .fill(Color.secondary.opacity(0.13))
                            .frame(height: 13)
                            .frame(maxWidth: 150, alignment: .leading)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        Color.secondary.opacity(mine ? 0.10 : 0.055),
                        in: RoundedRectangle(cornerRadius: 15)
                    )
                    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                    .scaleEffect(x: width, anchor: mine ? .trailing : .leading)
                    if !mine { Spacer(minLength: 50) }
                }
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 12)
                .animation(
                    .easeOut(duration: 0.45).delay(Double(index) * 0.07),
                    value: appeared
                )
            }
        }
        .shimmering()
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .onAppear { appeared = true }
        .accessibilityIdentifier("chat-loading-skeleton")
        .accessibilityLabel(L("Loading history…"))
    }
}

/// Centered loading state with a rotating hexagon (app signature).
struct CbLoading: View {
    var label: String?
    var compact = false

    var body: some View {
        VStack(spacing: 11) {
            HexagonMark()
                .frame(width: compact ? 20 : 30, height: compact ? 20 : 30)
                .foregroundStyle(.tint)
                .symbolEffect(.rotate, options: .repeat(.continuous))
            if let label {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, compact ? 14 : 30)
    }
}

/// Short list of placeholder rows for list panes.
struct ListLoadingSkeleton: View {
    var rows = 5
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 9) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 11) {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(Color.secondary.opacity(0.14))
                        .frame(width: 34, height: 34)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(Color.secondary.opacity(0.16))
                            .frame(height: 11)
                            .frame(maxWidth: .infinity)
                        RoundedRectangle(cornerRadius: 5)
                            .fill(Color.secondary.opacity(0.11))
                            .frame(height: 9)
                            .frame(maxWidth: 120, alignment: .leading)
                    }
                }
                .padding(11)
                .background(.cbSurface, in: RoundedRectangle(cornerRadius: 14))
                .opacity(appeared ? 1 : 0)
                .animation(.easeOut(duration: 0.35).delay(Double(index) * 0.06), value: appeared)
            }
        }
        .shimmering()
        .onAppear { appeared = true }
    }
}

/// The system share sheet — the way a download from the app travels to "Files", iCloud or another app. iOS apps cannot simply
/// write into a download folder; until then the file lies in the temporary directory.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// ── Small helpers ───────────────────────────────────────────────────────────

func formatBytes(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "–" }
    let gb = 1024.0 * 1024 * 1024
    if value >= gb { return String(format: value >= 10 * gb ? "%.0f GB" : "%.1f GB", value / gb) }
    if value >= 1024 * 1024 { return "\(Int((value / (1024 * 1024)).rounded())) MB" }
    return "\(max(1, Int((value / 1024).rounded()))) kB"
}

func hideKeyboard() {
    UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
    )
}
