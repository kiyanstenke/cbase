import SwiftUI
import UIKit

// ── Liquid Glass in the chat ─────────────────────────────────────────────────────────────
//
// The chat carries the glass of iOS 26 — the API the Claude app also uses (`glassEffect`, `GlassEffectContainer`):
//  – the composer island with its strip stack (ONE glass body, `Chat/ChatComposer.swift`),
//  – the buttons of the header zone as glass capsules (TopBar `Shell/AppShell.swift`, header `Chat/ChatHeader.swift`),
//  – the "to the end" arrow (`ChatArrowOverlay` in `Chat/ChatView.swift`);
//  – BOTH drawers too: buttons as glass (`cbGlassButton`, `PillButton`), the selected row as a glass shape (`cbSelection`),
//    location bar, search field — NO cards around the lists. The drawer's own surface stays opaque (`Shell/AppShell.swift:RightDrawer`,
//    rationale at its `.background`). Building blocks that also stand outside carry glass only under `drawerGlass`;
// and the history runs under the whole header zone (status bar with Dynamic Island, TopBar and header), under a slightly
// translucent, softly blurred ground instead of an opaque surface (`CbHeaderVeil`, height via `headerOverhang`). The TopBar's
// usage rings carry no glass.
//
// Below iOS 26 (the app's target is 18) every place stays character for character at the opaque look — the `fallback` of each
// call IS the old surface. "Reduce Transparency" in Accessibility makes the system turn glass and material opaque again by itself.
//
// Rules:
//  – Glass never lies on glass: whatever stands one step off INSIDE a glass body (plus circle, chips, panels) takes
//    `CbGlass.inside` instead of `CbColor.elevated` — an opaque surface would sit as a patch in the glass.
//  – Glass that touches or overlaps stands in ONE `CbGlassGroup` — otherwise the upper one samples the lower, and both turn
//    cloudy. In the group they merge into one body (island and stack).
//  – Whether glass runs is decided ONCE here (`CbGlass.on`), not per place through its own version check.

enum CbGlass {
    /// Does Liquid Glass run here (iOS 26)? Below, the opaque `fallback` applies everywhere.
    static var on: Bool {
        if #available(iOS 26, *) { return true }
        return false
    }

    /// One step INSIDE a glass body (plus circle, attachment chip, action and slash panel) — translucent so that the glass below
    /// stays glass; without glass the former step (`CbColor.elevated` on the island).
    static var inside: Color { on ? Color.primary.opacity(0.07) : CbColor.elevated }

    /// The SELECTED thing INSIDE a glass body (cushion of a segment bar on glass, the open category of the right drawer) — one step
    /// stronger than `inside`, otherwise the choice does not stand out in the glass; without glass the former step.
    static var selected: Color { on ? Color.primary.opacity(0.13) : CbColor.marked }
}

extension View {
    /// Glass in `form` (iOS 26); below, `fallback` as background — the opaque surface. `interactive` for a single button: the glass
    /// answers the touch (shimmer, slight spring). A group of several buttons stays calm, otherwise the whole capsule would shimmer
    /// under each one. `tint` colors the glass (the highlighted button of a row, `PillButton(prominent:)` in a drawer).
    @ViewBuilder
    func cbGlass<Form: Shape, Fallback: View>(
        _ form: Form,
        interactive: Bool = false,
        tint: Color? = nil,
        @ViewBuilder fallback: () -> Fallback
    ) -> some View {
        if #available(iOS 26, *) {
            glassEffect(CbGlass.kind(interactive: interactive, tint: tint), in: form)
        } else {
            background { fallback() }
        }
    }

    /// Glass in `form`, without glass nothing — for places that carried no surface of their own (button groups of the header zone).
    func cbGlass<Form: Shape>(_ form: Form, interactive: Bool = false) -> some View {
        cbGlass(form, interactive: interactive) { EmptyView() }
    }

    /// A single button (circle, capsule) on glass, answers the touch; without glass the elevated step. The shape is also the tap area.
    func cbGlassButton<Form: Shape>(_ form: Form) -> some View {
        contentShape(form)
            .cbGlass(form, interactive: true) { form.fill(CbColor.elevated) }
    }

    /// The SELECTED row of a list: in a drawer with glass (`drawerGlass`) a glass shape behind the row — the list itself stands
    /// without a card —, otherwise `CbColor.marked`. Without a choice nothing. The structure stays the same on every change
    /// (`Glass.identity` instead of an `if`), otherwise SwiftUI would rebuild the row.
    func cbSelection<Form: Shape>(_ active: Bool, in form: Form) -> some View {
        modifier(CbSelection(active: active, form: form))
    }
}

extension CbGlass {
    @available(iOS 26, *)
    static func kind(interactive: Bool, tint: Color? = nil) -> Glass {
        var glass: Glass = .regular
        if let tint { glass = glass.tint(tint) }
        return interactive ? glass.interactive() : glass
    }
}

private struct CbSelection<Form: Shape>: ViewModifier {
    let active: Bool
    let form: Form
    @Environment(\.drawerGlass) private var drawerGlass

    func body(content: Content) -> some View {
        if #available(iOS 26, *), drawerGlass {
            content.glassEffect(active ? .regular : .identity, in: form)
        } else {
            content.background(active ? CbColor.marked : Color.clear, in: form)
        }
    }
}

private struct DrawerGlassKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Does the view stand in one of the two drawers? Both set it on their body. Building blocks that also stand outside (`PillButton`,
    /// `CbSegments`, `ChatRowStyle`, `ChatFilterBar`, `cbSelection`) carry glass ONLY here — the pages themselves stay as they are.
    var drawerGlass: Bool {
        get { self[DrawerGlassKey.self] }
        set { self[DrawerGlassKey.self] = newValue }
    }
}

/// The container for glass that touches (`GlassEffectContainer`); without glass only the content.
struct CbGlassGroup<Content: View>: View {
    /// From which distance two glass shapes flow into one another.
    var gap: CGFloat = 0
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: gap) { content() }
        } else {
            content()
        }
    }
}

// ── Every bottom sheet in ONE form ───────────────────────────────────────────────────────
//
// Every `.sheet` goes through `.cbSheet(_:)` (guard `web/test/ios-sheets.test.mjs`). Without it only a sheet with no ground of its
// own carried the system glass; every `CbForm`/`CbList`, `CbDetailSheet`, `CbInfoSheet`, `PaneScaffold` and every page with
// `.background(CbColor.ground)` painted the warm ground opaque over it, and fully open the system paints opaque itself.
//  – the height by the sheet's kind (`CbSheetHeight`) — the detents stand nowhere else;
//  – under iOS 26 the ground: glass at every height (`CbSheetGlass`), and the inside paints no opaque ground of its own —
//    `cbGlassSheet` (environment) switches `CbForm`/`CbList` (ground transparent, rows as a step INSIDE glass),
//    `cbSheetBase()` (instead of `.background(CbColor.ground)`) and the kit's steps (`CbStage`: glyph circles, boxes,
//    chips, cards) to translucent;
//  – below (target 18) the opaque ground `CbColor.ground` for every sheet — the same surface most painted themselves; the inside
//    stays character for character at the old look (`cbGlassSheet` is never true there).
// The ✕ at the top left (`SheetClose`, below) belongs to the same form.

/// How high a sheet opens — the detents stand ONLY here.
enum CbSheetHeight {
    /// Half height, can be pulled up: lists, explanations, details, header sheets of the chat (the chat stays visible above).
    case half
    /// Full height: forms and editors with input (the keyboard needs the room), large views.
    case whole
    /// Half height only: a short look (the detail of a tool call in the history).
    case small

    var detents: Set<PresentationDetent> {
        switch self {
        case .half: return [.medium, .large]
        case .whole: return [.large]
        case .small: return [.medium]
        }
    }

    /// The handle at the top: visible where one can drag (half), and for the short look a cue to "swipe down to dismiss".
    var handle: Visibility {
        switch self {
        case .half, .small: return .visible
        case .whole: return .automatic
        }
    }
}

extension View {
    /// The sheet from below (`.sheet`) in the app's ONE form: glass (iOS 26) or the opaque ground, the height by its kind. Belongs on
    /// the content of EVERY `.sheet { … }` — at the place that presents, not in the presented type (the same type sometimes stands
    /// embedded in a page). `chatOperable`: at half height what stands behind stays operable (the chat's git sheet — in the desktop
    /// client both stand side by side).
    func cbSheet(_ height: CbSheetHeight, chatOperable: Bool = false) -> some View {
        modifier(CbSheet(height: height, chatOperable: chatOperable))
    }

    /// The ground of a page (`CbColor.ground`) — nothing in the glass sheet, where the sheet carries the glass. Instead of
    /// `.background(CbColor.ground)` in everything that can appear as a sheet.
    func cbSheetBase() -> some View {
        modifier(CbSheetReason())
    }
}

private struct CbSheet: ViewModifier {
    let height: CbSheetHeight
    let chatOperable: Bool

    private var behind: PresentationBackgroundInteraction {
        chatOperable ? .enabled(upThrough: .medium) : .automatic
    }

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .environment(\.cbGlassSheet, true)
                .presentationDetents(height.detents)
                .presentationDragIndicator(height.handle)
                .presentationBackgroundInteraction(behind)
                .presentationBackground { CbSheetGlass() }
        } else {
            content
                .presentationDetents(height.detents)
                .presentationDragIndicator(height.handle)
                .presentationBackgroundInteraction(behind)
                .presentationBackground(CbColor.ground)
        }
    }
}

/// The glass under a sheet (iOS 26): the same kind as island and drawers (`CbGlass.kind(interactive:tint:)`), over the whole surface. An own ground
/// instead of the system ground, because the system paints glass only at HALF height: fully open its sheet turns into an opaque
/// ground — and exactly the sheets that open fully (forms, settings, artifacts) stood opaque beside the glass ones. With this
/// ground half and full sheets look the same, and text keeps its contrast in both appearances (light a light, dark a dark
/// ground — the glass follows the appearance); without it (system ground) the full ones stayed opaque.
@available(iOS 26, *)
private struct CbSheetGlass: View {
    var body: some View {
        Color.clear
            .glassEffect(CbGlass.kind(interactive: false), in: Rectangle())
            .ignoresSafeArea()
    }
}

private struct CbSheetReason: ViewModifier {
    @Environment(\.cbGlassSheet) private var glassSheet
    func body(content: Content) -> some View {
        content.background(glassSheet ? Color.clear : CbColor.ground)
    }
}

private struct CbGlassSheetKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Does the view stand in a sheet with glass (`cbSheet`, iOS 26 only)? Then it paints no opaque ground and no opaque steps —
    /// `CbForm`/`CbList`, `cbSheetBase()`, `CbStage` read it.
    var cbGlassSheet: Bool {
        get { self[CbGlassSheetKey.self] }
        set { self[CbGlassSheetKey.self] = newValue }
    }
}

/// A step (glyph circle, code box, chip, card) that shows through in the glass sheet: there `CbGlass.inside`, otherwise the palette
/// surface. As a `ShapeStyle` so it stands wherever `CbColor.elevated`/`.surface` stood (`.background(_, in:)`, `.fill(_)`) and
/// follows the environment by itself.
struct CbStage: ShapeStyle {
    let outside: Color
    var inGlass: Color = CbGlass.inside

    func resolve(in environment: EnvironmentValues) -> Color.Resolved {
        (environment.cbGlassSheet ? inGlass : outside).resolve(in: environment)
    }
}

extension ShapeStyle where Self == CbStage {
    /// `CbColor.elevated` — in the glass sheet `CbGlass.inside`.
    static var cbElevated: CbStage { CbStage(outside: CbColor.elevated) }
    /// `CbColor.surface` (cards, boxes) — in the glass sheet `CbGlass.inside`.
    static var cbSurface: CbStage { CbStage(outside: CbColor.surface) }
    /// `CbColor.ground` as a ring or backing (the mark on a glyph) — in the glass sheet nothing.
    static var cbBase: CbStage { CbStage(outside: CbColor.ground, inGlass: .clear) }
}

// ── The close button of a sheet ──────────────────────────────────────────────────────────
//
// Every sheet of the chat header carries ONE ✕ at the top left:
//  – `SheetCloseButton`: a glass sphere (44 pt) with a neutral ✕, slightly brightened — the bar's glass alone vanished on the
//    ground of the system sheets (same gray as the glass, measured in the simulator), and `Button(role: .close)` took the accent
//    (an orange ✕);
//  – with a navigation bar it stands via `SheetClose` in the `toolbar`, the bar's own glass capsule is switched off there
//    (`sharedBackgroundVisibility(.hidden)` — otherwise glass on glass);
//  – without a bar (the git sheet is a `PaneScaffold`) it stands before the title.
// A sheet with "Save" keeps it on the right; the ✕ then discards. The identifier stays the per-sheet one (`chat-agents-close`,
// `chat-tasks-close`, …) — the test rig finds the sheet by it.

/// The ✕ at the top left of a sheet's navigation bar. `label` is what VoiceOver says (and what a test rig finds it by): "Close";
/// the ✕ replaces the words "Done", "Cancel" and "Close" in EVERY sheet (`cbSheet`).
struct SheetClose: ToolbarContent {
    var identifier: String? = nil
    var label: String = L("Close")
    /// Locked while the sheet is submitting something.
    var locked = false
    let action: () -> Void

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { button }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { button }
        }
    }

    private var button: some View {
        SheetCloseButton(identifier: identifier, label: label, action: action).disabled(locked)
    }
}

/// The ✕ itself — in the bar (`SheetClose`) and before the title of a page without a bar (`PaneScaffold(leading:)`).
/// Without glass a ✕ on the elevated step.
struct SheetCloseButton: View {
    var identifier: String? = nil
    var label: String = L("Close")
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.symbol(CbGlass.on ? 17 : 13, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: CbGlass.on ? 44 : 30, height: CbGlass.on ? 44 : 30)
                .contentShape(Circle())
                .cbGlass(Circle(), interactive: true, tint: Color.primary.opacity(0.1)) { Circle().fill(CbColor.elevated) }
        }
        .buttonStyle(.plain)
        // Next to the page title: the center of the sphere on the center of the capital letters (like `CbBackButton`).
        .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 8 }
        .accessibilityLabel(label)
        .cbIdentifier(identifier)
    }
}

/// The ground of the header zone (from the top screen edge with Dynamic Island to below the notices), under which the history
/// runs through: EVENLY slightly translucent — a SOFT blur and above it the card's ground at `coverage`; at the bottom NO edge but a
/// soft rim (`spring` below the zone) in which blur and ground fade out together. The built-in edge of iOS 26
/// (`scrollEdgeEffectStyle`, `UIScrollEdgeEffect`) does not apply here: the history is a MIRRORED UIKit list, its visible top edge
/// is the bottom one for UIKit.
///
/// Measured in the simulator: a full `UIBlurEffect` (also `.systemUltraThinMaterial`) smears text of this size into an even
/// surface — even at 50 % ground NOTHING of the history was visible, the bar looked opaque. Without blur it stood sharp behind it
/// and visibly crossed the title from 70 % ground. Hence a partly pulled-on blur (`GentleBlur`) under a thinner ground: the
/// history shimmers through as a soft shadow. (A SwiftUI material would be wrong anyway: under `.mask` it sampled nothing and
/// painted opaque.)
struct CbHeaderVeil: View {
    /// How dense the ground lies over the history.
    static let coverage: Double = 0.55
    /// How far the blur is pulled on (0 = none, 1 = the full material).
    static let blur: CGFloat = 0.2
    /// The soft rim: the veil reaches this far BELOW the zone and fades out. It lies over the history but does not push it in
    /// (the stage computes with the zone's height, `topInset`).
    static let spring: CGFloat = 16

    var body: some View {
        ZStack {
            GentleBlur(strength: Self.blur, spring: Self.spring)
            CbColor.ground.opacity(Self.coverage)
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: Self.spring)
                    }
                }
        }
        .padding(.bottom, -Self.spring)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A blur with a chosen radius. UIKit knows only the full materials; the public way to a weaker step is a PAUSED
/// `UIViewPropertyAnimator` that pulls the effect on only up to `strength`. Measured:
///  – Freezing (`finishAnimation(at: .current)`) does NOT keep the intermediate step — afterwards there is no blur at all; an
///    effect drawn scaled blurs more instead of less. So the animator stays.
///  – SwiftUI inserts the view without animation, and an animator created there sets the effect FULLY at once — hence it pulls
///    on one beat later (`pullOnSoon`), likewise after light/dark and on return to the foreground (the paused animation does not
///    reliably survive the background).
///  – XCUITest waits before every step until no animation runs, and a paused one never ends — a test in the chat stood ten
///    minutes. The UI tests therefore switch it off (`-cbase.mobile.header-blur 0`, `CbaseUITestBase`); then only the ground is there.
/// Before it is released it is paused: a paused animator that gets released crashes the app.
/// `spring`: the bottom-most points fade out through a mask (a mask of the effect itself — under a SwiftUI `.mask` it would have
/// sampled nothing, see above).
private struct GentleBlur: UIViewRepresentable {
    let strength: CGFloat
    let spring: CGFloat

    func makeUIView(context: Context) -> GentleBlurView { GentleBlurView(strength: strength, spring: spring) }
    func updateUIView(_ view: GentleBlurView, context: Context) { view.strength = strength }
}

private final class GentleBlurView: UIVisualEffectView {
    var strength: CGFloat {
        didSet { if strength != oldValue { pullOnSoon() } }
    }
    private let spring: CGFloat
    private let margin = CAGradientLayer()
    private let fadeMask = UIView()
    private var animator: UIViewPropertyAnimator?
    private var foreground: NSObjectProtocol?
    /// Off only in the UI tests (see above).
    private static let on = UserDefaults.standard.object(forKey: "cbase.mobile.header-blur") == nil
        || UserDefaults.standard.bool(forKey: "cbase.mobile.header-blur")

    init(strength: CGFloat, spring: CGFloat) {
        self.strength = strength
        self.spring = spring
        super.init(effect: nil)
        isUserInteractionEnabled = false
        margin.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        fadeMask.layer.addSublayer(margin)
        mask = fadeMask
        guard Self.on else { return }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GentleBlurView, _: UITraitCollection) in
            view.pullOnSoon()
        }
        foreground = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.pullOnSoon() }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        animator?.stopAnimation(true)
        if let foreground { NotificationCenter.default.removeObserver(foreground) }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { pullOnSoon() } else { bringToHalt() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        fadeMask.frame = bounds
        margin.frame = bounds
        let height = max(bounds.height, 1)
        margin.locations = [0, NSNumber(value: Double(max(0, (height - spring) / height))), 1]
    }

    private func pullOnSoon() {
        guard Self.on else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil else { return }
            self.pullOn()
        }
    }

    private func pullOn() {
        bringToHalt()
        effect = nil
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
            self?.effect = UIBlurEffect(style: .regular)
        }
        animator.fractionComplete = strength
        self.animator = animator
    }

    private func bringToHalt() {
        animator?.stopAnimation(true)
        animator = nil
    }
}

private struct HeaderOverhangKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    /// How far TopBar and status bar of the shell lie over a conversation, under which it runs through — the shell sets it only
    /// with glass and only while a conversation stands directly under the TopBar (`AppShell.chatHeaderBelow`). The conversation
    /// pulls up by that much and moves its own header down again by the same amount. 0 means: the conversation starts under the
    /// TopBar as before.
    ///
    /// The status bar is part of it. For that the list reports NO safe area at the TOP (`ChatTimelineCollectionView.safeAreaInsets`) —
    /// otherwise every cell rolling into the strip would get a new safe-area inset, its SwiftUI content would be re-measured and the
    /// list would re-query all heights (measured, PerfProbe with 30 rounds of status lines: layout 3.3 s instead of 0.6 s, peaks 257 ms).
    var headerOverhang: CGFloat {
        get { self[HeaderOverhangKey.self] }
        set { self[HeaderOverhangKey.self] = newValue }
    }
}
