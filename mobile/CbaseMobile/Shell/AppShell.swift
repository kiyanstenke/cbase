import SwiftUI
import UIKit

// The mobile shell: a slim header (workspace/project + usage rings), a content area reaching to the bottom edge (no home bar)
// and two drawers:
//  • swipe RIGHT → left drawer (category-specific)
//  • swipe LEFT  → right drawer (places Coding · Apps · Profile on top, below them the categories, at the bottom bell/theme/settings)

enum DrawerSide { case left, right }

/// A self-computed settle spring, deliberately instead of `withAnimation`. Two users: the settling of the drawers (here) and the
/// soft catching up of the chat history on send (`ChatTimelineStage.Coordinator`).
///
/// Reason: a stutter exactly when the thumb lifts. Measured in the simulator (frame-time trace over a `CADisplayLink`): while
/// dragging every frame sits cleanly at 16.7 ms, so writing state per touch move is fine, and chat, drawers and header are NOT
/// recomputed (only the shell's body); in the release frame every second time one frame drops (33 ms), and this loss stayed the
/// same in every comparison variant (no shadow, no mask, no haptics, flags outside the animation transaction, this spring instead
/// of `withAnimation`, without releasing the frozen scroll view), so it is noise in the simulator.
///
/// Why the device still looks different: the simulator runs at a fixed 60 Hz. On a ProMotion iPhone the display runs at 120 Hz
/// while the finger is on the glass and drops to a lower rate on lift-off unless something explicitly asks for more. This
/// spring asks explicitly (see `preferredFrameRateRange`) and settles on the same frame-by-frame path as the drag, so there is
/// neither a change of method nor of frame rate at the seam.
///
/// Critically damped (analytic solution, no overshoot); `omega` is the speed.
///
/// For the chat history a second trait matters that never showed with the drawers: the motion starts at velocity 0 and runs
/// slowly for the first milliseconds. If the first frame is missed (on send the list builds two new cells, measured 59 ms of
/// standstill), that costs almost no distance; an ease-out curve would have covered 40 % in the same time and visibly jumped.
@MainActor
final class SettleSpring {
    /// Natural frequency in rad/s; higher = faster. At 34 the drawer settles after about 0.2 s.
    private let omega: CGFloat
    /// Cap for the time step of ONE frame. It decides how much distance a pause adds afterwards: whoever starts the spring after an
    /// expensive pass (chat history: the list first builds two cells) sets it to one frame and still starts gently instead of
    /// catching up the lost distance in one frame.
    private let maxStep: CFTimeInterval
    /// Target of the running motion, so a late follower does not restart the same ride.
    private(set) var target: CGFloat = 0
    var isRunning: Bool { link != nil }
    /// Current value and velocity: whoever REDIRECTS the motion on the way (a second catch-up while the first still runs) continues
    /// continuously instead of starting over at 0.
    private(set) var value: CGFloat = 0
    private(set) var velocity: CGFloat = 0
    private var link: CADisplayLink?
    private var lastTime: CFTimeInterval = 0
    private var onChange: ((CGFloat) -> Void)?
    private var onFinish: (() -> Void)?

    init(omega: CGFloat = 34, maxStep: CFTimeInterval = 1.0 / 30) {
        self.omega = omega
        self.maxStep = maxStep
    }

    /// `velocity` is the initial velocity in the UNIT OF `from`/`to` per second: for the drawers the progress normalized to their
    /// width, so the motion continues at the finger's speed; for the chat history the own velocity of the still running spring, so a
    /// second push continues continuously.
    ///
    /// A call during a running motion REDIRECTS it: value, target and callback are replaced, the frame clock keeps running.
    func start(
        from: CGFloat,
        to: CGFloat,
        velocity v0: CGFloat,
        onChange: @escaping (CGFloat) -> Void,
        onFinish: (() -> Void)? = nil
    ) {
        value = from
        velocity = v0
        target = to
        self.onChange = onChange
        self.onFinish = onFinish
        lastTime = CACurrentMediaTime()
        onChange(from)
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(step))
        // Explicitly request the full frame rate. While the finger is on the glass a ProMotion screen runs at 120 Hz; without this
        // request it drops to a lower rate on lift-off, and exactly at this seam the stutter was visible. In the simulator (fixed 60 Hz)
        // the difference cannot be measured, which is why all comparison runs stayed flat there.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        // `.common`: otherwise the spring stands still while a scroll view is tracked.
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// EXTEND the still open distance without restarting the motion, for stretches known only on the way. In the chat history that
    /// is the late height report of a just inserted cell: the list first realizes it with the estimated height and corrects frames
    /// later. Without this top-up the difference lands as a jump on screen; with it it becomes part of the same soft ride.
    func bump(by delta: CGFloat) {
        guard isRunning, delta != 0 else { return }
        value += delta
        onChange?(value)
    }

    func stop() {
        link?.invalidate()
        link = nil
        onChange = nil
        onFinish = nil
    }

    @objc private func step(_ link: CADisplayLink) {
        let now = link.timestamp
        // Cap against a jump after a pause (background, long frame).
        let dt = min(max(now - lastTime, 0), maxStep)
        lastTime = now
        let d = value - target
        let decay = exp(-omega * CGFloat(dt))
        let c = velocity + omega * d
        value = target + (d + c * CGFloat(dt)) * decay
        velocity = (velocity - omega * c * CGFloat(dt)) * decay
        if abs(value - target) < 0.001 && abs(velocity) < 0.02 {
            value = target
            velocity = 0
            onChange?(target)
            let finish = onFinish
            stop()
            finish?()
            return
        }
        onChange?(value)
    }
}

struct AppShell: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var theme: ThemeStore
    @Environment(\.scenePhase) private var scenePhase
    /// The keyboard as it was ANNOUNCED (`keyboardWillChangeFrame`), the same process-wide truth the stage computes with
    /// (`Chat/ChatStageController.swift`). The shell used to listen to willShow/willHide separately (`KeyboardVisibility`) and, outside a
    /// chat, evade SwiftUI's keyboard region; why both are gone is explained at `keyboardBottom`.
    @ObservedObject private var keyboard = KeyboardAnnouncement.shared
    @State private var usage: UsageStore?
    /// Services, resources and machine of the scope for the button in the header. The model lives HERE and not in the drawer: the
    /// header is on every tab, the right drawer showed its status line only in Coding.
    @State private var services: ServicesStatusModel?
    @State private var dragSide: DrawerSide?
    @State private var dragStartProgress: CGFloat = 0
    @State private var leftDrawerProgress: CGFloat = 0
    @State private var rightDrawerProgress: CGFloat = 0
    @State private var revealedSide: DrawerSide = .left
    @State private var haptics = DrawerEndstopHaptics()
    /// Settling of the drawers: ONE spring per side, see `SettleSpring`. A shared one would be a race: if the flag observer reports
    /// the opposite side shortly after release, it would take over the display link and leave the actual side halfway (measured:
    /// the drawer got stuck half open).
    @State private var leftSpring = SettleSpring()
    @State private var rightSpring = SettleSpring()
    /// The bottom safe-area inset WITHOUT keyboard: the key window's home indicator (`windowBottomInset`). The root ignores EVERYTHING
    /// at the bottom (also outside a chat, see the very bottom), so `geo.safeAreaInsets.bottom` reports nothing usable there; the
    /// strip of the home indicator and the drawers give the inset back from this value. It used to come from the inset itself, locked
    /// by `!keyboard.visible`, but the inset carried the keyboard before the announcement (see `onChange` below).
    @State private var restingBottomInset: CGFloat = 0

    /// How far the ANNOUNCED keyboard reaches into the shell from below (0 without keyboard): its evasion outside a chat. `bottom` is
    /// the bottom edge of the shell in the window.
    ///
    /// Outside a chat the root used to let SwiftUI's keyboard region act. It jams as soon as a keyboard WITH our extension
    /// (`KeyboardGripAccessory`, 100 pt) closes without animation (back, the drawer swipe and a sheet over the chat do that; see
    /// `KeyboardAnnouncement`): UIKit's keyboard guide then stands 100 pt off (guide 774/100 without keyboard, 639/235 with a real
    /// one 539/335) and SwiftUI adopts that value. Measured: the terminal field lay 46 pt INSIDE the next keyboard instead of 54 pt
    /// above it; on a real iPhone the chat overview ended 100 pt above the edge without a keyboard. The announcement, by contrast,
    /// was right on every path driven. An announced keyboard that does not reach the bottom edge (floating) does not count.
    private func keyboardBottom(bottom: CGFloat) -> CGFloat {
        guard let frame = keyboard.frame, frame.maxY >= bottom - 1 else { return 0 }
        return max(0, bottom - frame.minY)
    }

    /// The motion with which the shell evades the keyboard: duration of the announcement, its curve imitated (UIKit's keyboard
    /// curve 7 as a cubic Bézier); without a duration it jumps like the keyboard.
    private var keyboardMovement: Animation? {
        keyboard.duration > 0 ? .timingCurve(0.38, 0.7, 0.125, 1, duration: keyboard.duration) : nil
    }

    /// The bottom safe-area inset of the key window: the home indicator, never the keyboard. `nil` without a window.
    @MainActor static func windowBottomInset() -> CGFloat? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .safeAreaInsets.bottom
    }

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = min(geo.size.width * Metrics.drawerWidthFactor, Metrics.drawerMaxWidth)
            let leftVisible = visible(for: .left, width: drawerWidth)
            let rightVisible = visible(for: .right, width: drawerWidth)
            let dimming = max(leftVisible, rightVisible) / drawerWidth
            let contentOffset = leftVisible - rightVisible
            // Radius and shadow strength JUMP instead of growing with the finger. Both belong to the card's mask or filter: if one of the
            // values changes, the card with its content must be re-rasterized, in every swipe frame; exactly that stuttered. The drawer
            // sits one level DARKER than the card, so a jump to a small radius would flash four dark corners at the first pixel. Hence it
            // jumps to `Metrics.cardsRadius` (44): from iPhone 12 mini on the screen radius is ≥ 44 pt (12/13/14 47.3; from 15 55), so the
            // rounding already lies in the screen's corner. On XS/11 (39–41.5) a stripe of 3–5 pt flashes, on the SE a corner; acceptable at
            // 3 % brightness difference.
            let lifted = dimming > 0.001
            let surfaceCornerRadius: CGFloat = lifted ? Metrics.cardsRadius : 0
            // The edge of the raised card: a hairline in the palette, in both designs; in light mode the shadow adds depth, in dark it is ineffective.
            let edgeLine = CbColor.edge.opacity(lifted ? 1 : 0)
            // The bottom padding of card and drawers: the root frees EVERYTHING at the bottom (see the very bottom), so it comes from here: the
            // home indicator, outside a chat the announced keyboard when it reaches higher. In a chat it stays at the resting value: there the
            // composer itself hangs on the keyboard (`ChatStageController`).
            let keyboardHeight = keyboardBottom(bottom: geo.frame(in: .global).maxY)
            let underPadding = chatManagesKeyboard ? restingBottomInset : max(restingBottomInset, keyboardHeight)

            ZStack(alignment: .topLeading) {
                CbColor.drawer
                    .ignoresSafeArea()

                // The drawers sit fixed UNDER the main view. Only the side in use is active; showing both permanently would make them overlap
                // in the middle of the screen because of their large width. The root frees EVERYTHING at the bottom (see the very bottom), so the
                // drawers lose their home-indicator padding too and their bottom buttons (Settings) would stick to the screen edge. `underPadding`
                // gives it back, outside a chat including the keyboard (the chat list's search in the left drawer).
                //
                // Reveal animation: the content moves in at a third of the card's speed (parallax toward its own edge) and fades in. Both hang on
                // the PROGRESS instead of an open bool: while swiping it sticks to the finger, on release it inherits the same spring as the
                // card. Offset and opacity are pure compositor work; nothing is re-rasterized per frame.
                LeftDrawer()
                    .padding(.bottom, underPadding)
                    .animation(chatManagesKeyboard ? nil : keyboardMovement, value: keyboardHeight)
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: -drawerWidth * 0.35 * (1 - leftDrawerProgress))
                    .opacity(revealedSide == .left ? 0.4 + 0.6 * leftDrawerProgress : 0)
                    // Operability hangs on the OPEN state, not on the intermediate position of the motion: the settling moves the progress frame by
                    // frame (see `SettleSpring`), so an incoming drawer would stay tappable for another fifth of a second. The model jumping to the
                    // target at once while only the display follows is restored here.
                    .allowsHitTesting(revealedSide == .left && state.leftOpen)
                    .accessibilityHidden(revealedSide != .left || !state.leftOpen)
                    .zIndex(0)

                RightDrawer(usage: usage)
                    .padding(.bottom, underPadding)
                    .animation(chatManagesKeyboard ? nil : keyboardMovement, value: keyboardHeight)
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity)
                    .offset(x: geo.size.width - drawerWidth
                        + drawerWidth * 0.35 * (1 - rightDrawerProgress))
                    .opacity(revealedSide == .right ? 0.4 + 0.6 * rightDrawerProgress : 0)
                    .allowsHitTesting(revealedSide == .right && state.rightOpen)
                    .accessibilityHidden(revealedSide != .right || !state.rightOpen)
                    .zIndex(0)

                // Claude-style reveal: the whole app surface moves aside as one connected card and uncovers the drawer beneath.
                VStack(spacing: 0) {
                    // With glass (iOS 26) the TopBar sits over a conversation TRANSPARENT and IN FRONT of it (`zIndex`): the conversation pulls up by
                    // its height and that of the status bar (`headerOverhang`), its history runs under both, and the veil under the whole header zone
                    // is painted by the conversation (`ChatHeaderGlass`). The column itself stays as it is; every other view starts further below the TopBar.
                    TopBar(
                        usage: usage, services: services, topInset: geo.safeAreaInsets.top, edge: !chatHeaderBelow,
                        overContent: chatHeaderBelow && CbGlass.on
                    )
                    .zIndex(1)
                    ZStack {
                        CbColor.ground.ignoresSafeArea(edges: .bottom)
                        // The content fades in when the view changes (choice in a drawer, also the places): the ONE motion instead of the card gliding back
                        // sideways (`AppState.fadeIn`). The own stack is the container that survives the change; nothing played on the branch itself.
                        ZStack { ShellContent() }
                            .environment(\.headerOverhang, chatHeaderBelow && CbGlass.on ? geo.safeAreaInsets.top + Metrics.topBarHeight : 0)
                            .cbFadeIn(at: state.fadeIn)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // The home-indicator strip: the card reaches to the screen edge (`.container` is freed at the bottom, see below), so someone gives
                    // it back inside. It used to be the bottom bar; now only its spacing stays here.
                    //
                    // With a CHAT in front the strip STAYS even when the keyboard is up, and its height comes from the REMEMBERED value
                    // (`restingBottomInset`, from the window): if it vanished or shrank with the safe area, the chat's bottom edge would move in the
                    // middle of the keyboard motion, the composer would sit one frame too high and the list would rebuild during the whole animation.
                    //
                    // Without a chat the strip IS the keyboard evasion: as high as the ANNOUNCED keyboard (`keyboardBottom`), at least the home
                    // indicator, with duration and curve of the announcement. SwiftUI's keyboard region jams after a close without animation by the
                    // 100 pt of the extension (see `keyboardBottom`); `geo.safeAreaInsets.bottom` is unsuitable anyway, since it carried the keyboard
                    // BEFORE its announcement (see `onChange` below).
                    Color.clear
                        .frame(height: underPadding)
                        .accessibilityHidden(true)
                }
                .animation(chatManagesKeyboard ? nil : keyboardMovement, value: keyboardHeight)
                .onChange(of: geo.size, initial: true) {
                    // The resting value comes from the WINDOW, not from `geo.safeAreaInsets.bottom`: SwiftUI counts the keyboard into the inset with
                    // the frame announcement, BEFORE `keyboardWillShow` and `keyboardWillHide`. A guard on `!keyboard.visible` let the keyboard inset
                    // (335 pt) through on open and blocked the way back to 34 on close, so after a keyboard in the chat list every chat opened over
                    // a 383 pt tall home bar and its field took no focus. The window's safe area knows no keyboard.
                    //
                    // The window value also applies in chat mode (the app may start directly in a chat; the composer's spacing above the home
                    // indicator hangs on it). The root now ALWAYS frees the bottom, so the inset is always 0; it is read on every size change
                    // (rotation: 34 portrait, 21 landscape).
                    if let window = Self.windowBottomInset() { restingBottomInset = window }
                }
                .onAppear {
                    // Once more a beat later from the window: on first layout it may not yet be the key window.
                    DispatchQueue.main.async {
                        if let window = Self.windowBottomInset() { restingBottomInset = window }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // CLIP first, THEN put background and shadow on an own simple shape behind it; the order is load-bearing. A `.shadow` on the
                // card itself would have had to rasterize the whole app content into an intermediate surface in every frame; and if the background
                // lay INSIDE the clip, the shadow would be cut away completely (it lies entirely outside the shape).
                .clipShape(RoundedRectangle(cornerRadius: surfaceCornerRadius, style: .continuous))
                .background {
                    RoundedRectangle(cornerRadius: surfaceCornerRadius, style: .continuous)
                        .fill(CbColor.ground)
                        // Two-stage on BOTH edges: a tight contact edge sets the card off from the drawer, a wide gradient gives the depth. Symmetric (no
                        // offset) so both edges look the same.
                        .shadow(color: .black.opacity(lifted ? 0.16 : 0), radius: 3)
                        .shadow(color: .black.opacity(lifted ? 0.20 : 0), radius: 22)
                }
                .overlay {
                    // Hairline on the card edge, the carrier of the 3D impression in dark mode.
                    RoundedRectangle(cornerRadius: surfaceCornerRadius, style: .continuous)
                        .strokeBorder(edgeLine, lineWidth: 1)
                        .allowsHitTesting(false)
                }
                .overlay {
                    // The visible main content closes the open drawer on a tap, but stays transparent and is not artificially darkened.
                    if dimming > 0.01 {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { closeDrawers() }
                            .accessibilityLabel(L("Close"))
                    }
                }
                // The card reaches to the top and bottom SCREEN EDGE; the bars give the safe-area spacing back inside so icons and
                // tabs stay at their height. This release MUST be the outermost visual modifier: clip, background and overlays are
                // sized by the REPORTED frame; if it sat inside, the clip would cut the gained area off again (it happened). Only the
                // container edges; the keyboard is handled by the outer GeometryReader.
                .ignoresSafeArea(.container, edges: .vertical)
                .offset(x: contentOffset)
                    .zIndex(2)
            }
            .background(
                HorizontalPanReader(
                    enabled: !state.showSettings && !state.showNotifications,
                    onChanged: { dx in handleDrag(dx, width: drawerWidth) },
                    onEnded: { dx, velocity in finishDrag(dx, velocity: velocity, width: drawerWidth) }
                )
            )
            // NO tap on the displayed intermediate frames any more: the detent feedback used to knock from the interpolated frames of the
            // spring after release, i.e. only at the end of the animation. It now comes with the finger lifting (see `finishDrag`), so no
            // per-frame feedback is needed.
        }
        // Keyboard safe area: SwiftUI's automatic offset is switched off COMPLETELY at the root, also outside a chat. With a CHAT in front
        // it manages its keyboard padding itself (the composer hangs on the real edge frame by frame); SwiftUI's offset comes in ONE step
        // and would make the chat visibly collapse and rebuild. The release must sit HERE at the root: even the GeometryReader would
        // otherwise shrink with the keyboard, and an ignoresSafeArea further inside comes too late (measured: chat bottom edge jumps
        // 792→491 and then grows back animated).
        //
        // And `.all`, not only `.keyboard`: on open/close the 34 pt of the home indicator move between `.container` and `.keyboard`, and
        // in the transition they carry an assignment that NEITHER the card's `.container` ignore NOR a `.keyboard` ignore here covers: the
        // stage's bottom edge breathed by 34 pt, and the swap back fired mid-motion on slow interactive retraction. With `.all` at the
        // root the swap state does not exist at all: everything at the bottom is permanently released, the geometry stands still.
        //
        // Outside a chat the shell evades the keyboard itself, via `underPadding` from the ANNOUNCED position (`KeyboardAnnouncement`),
        // not via SwiftUI's region, which jams after a close without animation by the 100 pt of the extension (see `keyboardBottom`). The
        // terminal input still evades the keyboard, only via the card's strip.
        .ignoresSafeArea(.all, edges: .bottom)
        .task {
            guard let client = session.client else { return }
            state.attach(client: client)
            if usage == nil {
                let store = UsageStore(client: client)
                usage = store
                store.start()
            }
            // `.task` runs on EVERY appearance of the shell, `onDisappear` below stops it, so the button only asks while the shell is
            // visible. The same scope keeps its values on restart (`ServicesStatusModel.start`).
            let model = services ?? ServicesStatusModel(client: client)
            if services == nil { services = model }
            model.start(workspaceId: state.activeWorkspaceId, projectId: state.enteredProject?.id)
        }
        // Scope changed (workspace or project, from whichever tab): ask again.
        .onChange(of: state.scopeKey) {
            services?.start(workspaceId: state.activeWorkspaceId, projectId: state.enteredProject?.id)
        }
        .onDisappear { services?.stop() }
        .onAppear {
            // The visible position is the only geometry source of the drawers. On first build it adopts an already set app state without an
            // artificial slide-in animation.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                leftDrawerProgress = state.leftOpen ? 1 : 0
                rightDrawerProgress = state.rightOpen ? 1 : 0
                if state.rightOpen { revealedSide = .right }
            }
        }
        // The open state is observed without hanging the shell on it (see `DrawerFlags`).
        .background {
            DrawerFlagWatcher(flags: state.drawers) { side, open in
                if open { revealedSide = side }
                // The mark is consumed on EVERY report, also on open; a leftover one would turn a later close via ✕ into one without travel.
                let withoutTravel = state.drawers.takeWithoutTravel(side) && !open
                settleDrawer(side, open: open, withoutTravel: withoutTravel)
            }
        }
        // Back from the background: refresh lists and usage values. A request that hung in a sleeping socket when switching away would
        // otherwise have stayed at "still loading" until the user changes scope.
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            // First the event stream: its "init" carries the current list of running chats. Without this rebuild the UI would show the run
            // state from before the background and correct it only at some point, visibly.
            state.restartEventStream()
            // The service values wait for nothing: the tick restarts at once and aborts a query hanging on a dead socket (they used to sit
            // behind chat list, workspaces and `/api/usage`).
            services?.newStart()
            Task {
                await state.chatList?.load()
                await state.loadWorkspaces()
                await usage?.refresh()
            }
        }
        .sheet(isPresented: $state.showSettings) {
            SettingsView()
                .environmentObject(state)
                .environmentObject(session)
                .environmentObject(theme)
                .cbSheet(.whole)
        }
        .sheet(isPresented: $state.showNotifications) {
            NotificationsView()
                .environmentObject(state)
                .environmentObject(session)
                .cbSheet(.whole)
        }
    }

    /// An open CONVERSATION manages its keyboard padding itself (the stage hangs the composer by constraint on the
    /// `keyboardLayoutGuide`, see `ChatStageController`); only then do card and drawers NOT evade the keyboard (`underPadding` stays
    /// the resting value).
    private var chatManagesKeyboard: Bool {
        state.tab == .workspaces
            && state.activeWorkspaceId != nil
            && state.category == .chats
            && !state.showingChatOverview
            && !state.showingCodingOverview
    }

    /// Is a conversation's header DIRECTLY under the TopBar? Then both are ONE header zone: the TopBar drops its edge, and the
    /// header draws the one edge under the whole zone (`ChatHeaderGlass`).
    private var chatHeaderBelow: Bool {
        state.tab == .workspaces
            && state.activeWorkspaceId != nil
            && state.category == .chats
            && !state.showingChatOverview
            && !state.showingCodingOverview
    }

    // ── Drawer geometry ──
    private func visible(for side: DrawerSide, width: CGFloat) -> CGFloat {
        progress(for: side) * width
    }

    private func handleDrag(_ dx: CGFloat, width: CGFloat) {
        if dragSide == nil {
            let side: DrawerSide
            // The side comes from the PROGRESS, not from the open state: it is current even when a spring still runs and the state follows
            // only afterwards.
            if leftDrawerProgress > 0 {
                side = .left
            } else if rightDrawerProgress > 0 {
                side = .right
            } else {
                side = dx > 0 ? .left : .right
            }
            // A still running spring belongs to the previous swipe: the finger takes over.
            spring(for: side).stop()
            dragSide = side
            revealedSide = side
            dragStartProgress = progress(for: side)
            haptics.beginGesture(at: side == .left ? dragStartProgress : -dragStartProgress)
            hideKeyboard()
        }

        guard let side = dragSide else { return }
        let directionalDX = side == .left ? dx : -dx
        let next = min(1, max(0, dragStartProgress + directionalDX / width))
        setProgress(next, for: side)
        // At the stop it knocks at once: the thumb is still on the glass but the drawer does not move on.
        haptics.track(side == .left ? next : -next)
    }

    private func finishDrag(_ dx: CGFloat, velocity: CGFloat, width: CGFloat) {
        guard let side = dragSide else { return }
        let directionalDX = side == .left ? dx : -dx
        let directionalVelocity = side == .left ? velocity : -velocity
        let current = min(1, max(0, dragStartProgress + directionalDX / width))
        let projected = current + directionalVelocity / width * 0.16
        // The detent threshold is relative to the STARTING POINT instead of a rigid 40 % of the width. A fixed mark at 0.4 was
        // asymmetric, to the detriment of RETRACTING: to pull open the progress had to exceed 0.4 (≈ 130 pt), to push shut it had to fall
        // below 0.4, i.e. from 1 about 193 pt, so retracting demanded HALF the distance more. Now a quarter of the width (≈ 80 pt)
        // applies in both directions: from closed a quarter out, from open a quarter back.
        let opening = dragStartProgress < 0.5
        let open = projected > (opening ? 0.25 : 0.75)
        let target: CGFloat = open ? 1 : 0

        // Adopt the recognizer's last end point exactly first. `progress` thus stays the same geometry source before, during and after
        // release; there is no switch from finger translation to a separate bool offset any more.
        setProgress(current, for: side)
        // With lift-off the target is fixed, so knock NOW, not only when the spring arrives there. If it springs back to the starting
        // point, it stays silent.
        haptics.endGesture(settlingAt: side == .left ? target : -target)
        // Settling on the SAME frame-by-frame path as the drag (see `SettleSpring`); the finger's velocity continues unchanged.
        spring(for: side).start(from: current, to: target, velocity: directionalVelocity / width) { p in
            setProgress(p, for: side)
        }
        // The opposite side stands at 0 anyway; carried along in case something was still open there.
        if open { setProgress(0, for: side == .left ? .right : .left) }
        if side == .left {
            state.leftOpen = open
            if open { state.rightOpen = false }
        } else {
            state.rightOpen = open
            if open { state.leftOpen = false }
        }
        dragSide = nil
        dragStartProgress = 0
    }

    private func closeDrawers() {
        // A tap on the content closes an open drawer completely, with the same detent feedback as at the end of a swipe, only without a
        // finger on the glass.
        haptics.beginGesture(at: leftDrawerProgress - rightDrawerProgress)
        haptics.endGesture(settlingAt: 0)
        // The same frame-by-frame settling as on release (see `finishDrag`).
        for side in [DrawerSide.left, .right] where progress(for: side) > 0 {
            spring(for: side).start(from: progress(for: side), to: 0, velocity: 0) { p in
                setProgress(p, for: side)
            }
        }
        state.leftOpen = false
        state.rightOpen = false
    }

    private func spring(for side: DrawerSide) -> SettleSpring {
        side == .left ? leftSpring : rightSpring
    }

    private func progress(for side: DrawerSide) -> CGFloat {
        side == .left ? leftDrawerProgress : rightDrawerProgress
    }

    private func setProgress(_ progress: CGFloat, for side: DrawerSide) {
        if side == .left {
            leftDrawerProgress = progress
        } else {
            rightDrawerProgress = progress
        }
    }

    /// Catching up when the open state was set from outside (button, navigation, scope change). The check comes FIRST: on release of a
    /// swipe the observer reports the same state afterwards; the progress is then already at the target, and the running spring with
    /// its detent feedback must not be invalidated.
    ///
    /// Deliberately without detent feedback: that belongs to the direct hand motion, not to every state change in the background.
    /// So a still armed feedback is disarmed.
    ///
    /// `withoutTravel`: the close came from a CHOICE in the drawer (`AppState.closeDrawersAfterChoice`). Then nothing travels; the card
    /// used to glide sideways with the spring while the new content already stood on it; now it stands in place in the same frame and
    /// the content fades in (`AppState.fadeIn`).
    private func settleDrawer(_ side: DrawerSide, open: Bool, withoutTravel: Bool = false) {
        let target: CGFloat = open ? 1 : 0
        // If this side's spring already runs to the same target, do NOT restart: otherwise the settling would lose the finger's speed on
        // release (the observer reports the same state right after). This holds with `withoutTravel` too: a hand motion already running
        // belongs to the hand.
        guard !(spring(for: side).isRunning && spring(for: side).target == target) else { return }
        if withoutTravel {
            // First unregister the frame clock (a still running settle, e.g. still on opening, would otherwise push on in the next frame),
            // then set the progress without any transaction: the report comes in the observer's `onChange` and would otherwise inherit an
            // animation from the caller.
            spring(for: side).stop()
            haptics.cancel()
            var withoutAnimation = Transaction()
            withoutAnimation.disablesAnimations = true
            withTransaction(withoutAnimation) { setProgress(target, for: side) }
            return
        }
        guard progress(for: side) != target else { return }
        haptics.cancel()
        spring(for: side).start(from: progress(for: side), to: target, velocity: 0) { p in
            setProgress(p, for: side)
        }
    }
}

// ── Detent feedback ──
/// Knocks exactly once per COMPLETE hand motion: fully closed → fully open or fully open → fully closed. The anchor is the end
/// point where the gesture began; only reaching the OTHER end point knocks. A short flick with a spring back stays silent: the
/// anchor is NOT cleared on leaving a stop, otherwise even the return to the starting point would knock. Motions without a hand
/// (button, navigation) pass by via `cancel`.
///
/// WHEN it knocks depends on who is leading the drawer:
///  • The finger is on the glass → at the stop itself (`track`): the drawer does not move on although the thumb still pulls.
///  • The finger leaves → IMMEDIATELY on release (`endGesture(settlingAt:)`), as soon as the spring's target is fixed. Not only when
///    the spring arrives: the decision "open" / "closed" falls with the lift-off, and the feedback belongs to that moment.
///
/// The progress is signed: +1 left drawer open, −1 right open, 0 closed.
final class DrawerEndstopHaptics {
    private let generator = UIImpactFeedbackGenerator(style: .rigid)
    /// The end point where the motion began or last latched.
    private var latched: CGFloat = 0
    /// Knocks only between gesture start and the next latch.
    private var armed = false
    private var fingerDown = false

    func beginGesture(at progress: CGFloat) {
        // If the gesture begins mid-motion (drawer caught in flight), the old anchor stays: it is still the same transaction "closed →
        // open" or "open → closed". When SETTING the anchor, round generously: a drawer at 0.98 is long open to the hand.
        if let hit = edge(progress, tolerance: 0.03) { latched = hit }
        armed = true
        fingerDown = true
        generator.prepare()
    }

    /// The finger is gone and the spring's target is fixed: knock NOW. If the spring leads back to the starting point (short flick),
    /// it stays silent. Afterwards the motion is ticked off: the spring's intermediate frames no longer knock afterwards.
    func endGesture(settlingAt target: CGFloat) {
        fingerDown = false
        guard armed else { return }
        armed = false
        guard target != latched else { return }
        latched = target
        generator.impactOccurred(intensity: target == 0 ? 0.7 : 0.9)
        generator.prepare()
    }

    /// A motion not coming from the hand takes over the drawer silently.
    func cancel() {
        armed = false
        fingerDown = false
    }

    /// Every intermediate value UNDER THE FINGER runs through here. After release `endGesture(settlingAt:)` has already knocked and
    /// disarmed; the spring's intermediate frames find nothing to do here.
    func track(_ progress: CGFloat) {
        // Under the finger the check is TIGHT: only where the drawer really cannot go further does the knock belong.
        guard armed, fingerDown, let hit = edge(progress, tolerance: 0.001) else { return }
        guard hit != latched else { return }
        latched = hit
        generator.impactOccurred(intensity: hit == 0 ? 0.7 : 0.9)
        generator.prepare()
    }

    private func edge(_ progress: CGFloat, tolerance: CGFloat) -> CGFloat? {
        if progress >= 1 - tolerance { return 1 }
        if progress <= tolerance - 1 { return -1 }
        if abs(progress) <= tolerance { return 0 }
        return nil
    }
}

// ── Watching the open state ──
/// Listens to the two drawer switches without the shell itself hanging on `AppState` (see `DrawerFlags`). Only this empty surface
/// is re-evaluated on a change.
private struct DrawerFlagWatcher: View {
    @ObservedObject var flags: DrawerFlags
    let onChange: (DrawerSide, Bool) -> Void

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .onChange(of: flags.left) { _, open in onChange(.left, open) }
            .onChange(of: flags.right) { _, open in onChange(.right, open) }
    }
}

// ── Content area ──
private struct ShellContent: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        switch state.tab {
        case .workspaces:
            if state.activeWorkspaceId == nil {
                WorkspacePickerPage()
            } else {
                CategoryContent()
            }
        case .apps:
            AppsPage()
        case .profile:
            ProfilePage()
        }
    }
}

/// Without a chosen workspace: selection page (also creatable).
struct WorkspacePickerPage: View {
    @EnvironmentObject private var state: AppState
    @State private var creating = false

    var body: some View {
        PaneScaffold(
            title: L("Workspaces"),
            subtitle: L("Pick a workspace or create a new one."),
            trailing: AnyView(PillButton(title: L("+ Workspace"), prominent: true) { creating = true })
        ) {
            ScrollView {
                VStack(spacing: 9) {
                    if state.loadingWorkspaces && state.workspaces.isEmpty {
                        ListLoadingSkeleton()
                    } else if state.workspaces.isEmpty {
                        EmptyPaneState(
                            title: L("No workspaces yet"),
                            message: L("Create a workspace — it will also appear in the desktop client."),
                            systemImage: "square.stack.3d.up"
                        )
                    }
                    ForEach(state.workspaces) { workspace in
                        Button {
                            Task { await state.enter(workspaceId: workspace.id) }
                        } label: {
                            HStack(spacing: 12) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 11)
                                        .fill(Color.accentColor.opacity(0.13))
                                    Image(systemName: "square.stack.3d.up.fill")
                                        .foregroundStyle(.tint)
                                }
                                .frame(width: 38, height: 38)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(workspace.name)
                                        .font(.subheadline.weight(.semibold))
                                        .lineLimit(1)
                                    Text(L("{n} projects", ["n": workspace.projects.count]))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(12)
                            .background(CbColor.surface, in: RoundedRectangle(cornerRadius: 15))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("workspace-\(workspace.id)")
                    }
                    InlineError(message: state.workspaceError)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 20)
            }
            .cbRefreshable { await state.loadWorkspaces() }
        }
        .sheet(isPresented: $creating) {
            CreateWorkspaceSheet()
                .environmentObject(state)
                .cbSheet(.whole)
        }
    }
}

// ── Header ──
struct TopBar: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject private var noUsage = NoopObservable.shared
    let usage: UsageStore?
    /// Services of the scope: two buttons before the rings, Ports and Performance.
    /// Nil until the shell has created its model.
    var services: ServicesStatusModel? = nil
    /// Height of the status bar: the card reaches to the screen edge, the bar's content stays below it, and its opaque background
    /// fills the strip behind.
    var topInset: CGFloat = 0
    /// The hairline at the bottom: absent while a conversation's header sits directly below it; then both are ONE header zone, and
    /// the conversation draws the edge under the whole zone.
    var edge = true
    /// Does the bar lie over a conversation with glass? Then without its own background: the history runs under it, the conversation
    /// paints the veil (`ChatHeaderGlass`).
    var overContent = false
    @State private var scopePickerOpen = false

    var body: some View {
        HStack(spacing: 8) {
            // The mark (20 pt lens) no longer sits before the workspace button; splash, sign-in and the greeting in the empty chat carry it.
            Button {
                scopePickerOpen = true
            } label: {
                HStack(spacing: 4) {
                    // The title line stays FIXED (text size): it sits in a 42 pt bar next to rings and service buttons that are fixed too, like
                    // Apple's own bars, which do not grow with Dynamic Type. Exception in ios-font.test.mjs.
                    Text(state.activeWorkspace?.name ?? L("Choose workspace"))
                        .font(.system(size: 14, weight: state.enteredProject == nil ? .bold : .medium))
                        .foregroundStyle(state.enteredProject == nil ? Color.primary : Color.secondary)
                        .lineLimit(1)
                    if let project = state.enteredProject {
                        Image(systemName: "chevron.right")
                            .font(.symbol(9, weight: .bold))
                            .foregroundStyle(.secondary)
                        Text(project.name)
                            .font(.system(size: 14, weight: .bold))
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.down")
                        .font(.symbol(9, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, CbGlass.on ? 11 : 9)
                // 30 pt high on glass instead of 24: a flat glass capsule reads as a stroke, not as a button.
                .padding(.vertical, CbGlass.on ? 7 : 4)
                .overlay {
                    if !CbGlass.on { Capsule().stroke(CbColor.edge) }
                }
                .cbGlass(Capsule(), interactive: true)
            }
            .buttonStyle(.plain)
            // Who yields when the header is too narrow: first the number on the Performance button (`ViewThatFits`), only then the name. Rings
            // and Ports button never yield (`fixedSize`); without it "12 %" of the rings broke into two lines (measured on an iPhone 17).
            .layoutPriority(1)
            .accessibilityIdentifier("scope-picker")
            .popover(isPresented: $scopePickerOpen) {
                ScopePicker()
                    .environmentObject(state)
                    .frame(minWidth: 280, idealWidth: 300)
                    .presentationCompactAdaptation(.popover)
            }

            Spacer(minLength: 4)

            // Services and rings stand free in the bar, also with glass (they used to share one glass capsule).
            if services != nil || usage != nil {
                HStack(spacing: 8) {
                    if let services {
                        ServicesButton(model: services)
                    }

                    if let usage {
                        UsageRingsBar(store: usage)
                            .fixedSize()
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: Metrics.topBarHeight)
        .padding(.top, topInset)
        // Opaque in the card's background, except with glass over a conversation. The shape then catches taps on the bar's empty surface,
        // otherwise they would go to the history below.
        .background(overContent ? Color.clear : CbColor.ground)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(CbColor.edge)
                .frame(height: 0.5)
                .opacity(edge ? 1 : 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("top-bar")
    }
}

/// Trick so `TopBar` has a stable ObservedObject even without a UsageStore.
@MainActor
final class NoopObservable: ObservableObject {
    static let shared = NoopObservable()
}

/// The header rings are tappable: a tap opens Settings → Usage → the provider's subpage (jump "usage:<provider>", `AppState.settingsJump`).
private struct UsageRingsBar: View {
    @ObservedObject var store: UsageStore
    @EnvironmentObject private var state: AppState

    var body: some View {
        HStack(spacing: 8) {
            ForEach(store.rings) { ring in
                UsageRingView(ring: ring) {
                    state.openSettings("\(UsageContract.usagePage):\(ring.id)")
                }
            }
        }
    }
}

/// Workspace/project switcher (like the dropdown of the desktop header).
private struct ScopePicker: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel(text: L("Workspaces"))
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
                    .padding(.bottom, 5)
                ForEach(state.workspaces) { workspace in
                    Button {
                        dismiss()
                        Task { await state.enter(workspaceId: workspace.id) }
                    } label: {
                        HStack(spacing: 8) {
                            Text(workspace.name)
                                .cbFont(14, weight: workspace.id == state.activeWorkspaceId ? .semibold : .regular)
                                .lineLimit(1)
                            Spacer()
                            if workspace.id == state.activeWorkspaceId {
                                Image(systemName: "checkmark")
                                    .font(.caption.bold())
                                    .foregroundStyle(.tint)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("scope-workspace-\(workspace.id)")
                }

                if let workspace = state.activeWorkspace {
                    Divider().padding(.vertical, 6)
                    SectionLabel(text: L("Enter project"))
                        .padding(.horizontal, 14)
                        .padding(.bottom, 5)
                    Button {
                        dismiss()
                        state.leaveProject()
                    } label: {
                        HStack {
                            Text(L("Entire workspace"))
                                .cbFont(14, weight: state.enteredProject == nil ? .semibold : .regular)
                            Spacer()
                            if state.enteredProject == nil {
                                Image(systemName: "checkmark")
                                    .font(.caption.bold())
                                    .foregroundStyle(.tint)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("scope-whole-workspace")

                    ForEach(workspace.projects) { project in
                        Button {
                            dismiss()
                            state.enterProject(project)
                        } label: {
                            HStack {
                                Text(project.name)
                                    .cbFont(14, weight: state.enteredProject?.id == project.id ? .semibold : .regular)
                                    .lineLimit(1)
                                Spacer()
                                if state.enteredProject?.id == project.id {
                                    Image(systemName: "checkmark")
                                        .font(.caption.bold())
                                        .foregroundStyle(.tint)
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("scope-project-\(project.id)")
                    }

                    if workspace.projects.isEmpty {
                        Text(L("No projects yet."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                    }
                }
            }
            .padding(.bottom, 12)
        }
        .frame(maxHeight: 420)
    }
}

// ── Right drawer: categories ──
struct RightDrawer: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var theme: ThemeStore
    let usage: UsageStore?

    /// What the right drawer shows when it has NO sections. A tab without subpages has none; the sentence must say so and point to
    /// the place of the only choice instead of asking for one that changes nothing.
    private var areaHint: String {
        switch state.tab {
        case .apps: return L("The apps view uses the left drawer for projects and ports.")
        // The profile has no sections here; its two pages are chosen by the LEFT drawer (`ProfileSidebar`). It used to fall into the
        // sentence "Choose a workspace above …", even with a workspace chosen.
        case .profile: return L("The profile view shows the account in the left drawer; it has no sections.")
        // Only Coding without a chosen workspace remains.
        default: return L("Pick a workspace above to see the sections.")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    // Title in the system font, bold (`cbTitle(.drawer)`).
                    Text(L("Sections"))
                        .cbTitle(.drawer)
                        .foregroundStyle(CbColor.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(state.scopeName)
                        .font(.caption)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    // No own transaction: the drawer's motion animates `settleDrawer`. Writing the flag inside an animation cost a long frame (see
                    // finishDrag).
                    state.rightOpen = false
                } label: {
                    // 34 instead of 30 pt on glass: a small glass circle reads as a blob, not as a button.
                    Image(systemName: "xmark")
                        .font(.symbol(12, weight: .semibold))
                        .frame(width: CbGlass.on ? 34 : 30, height: CbGlass.on ? 34 : 30)
                        .contentShape(Circle())
                        .cbGlass(Circle(), interactive: true) { Circle().fill(CbColor.elevated) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Close"))
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // The three places of the app, as a segment bar under the title: it chooses the PLACE, the rows below the category within it. The
            // choice closes the drawer like every choice here; a tap on the already chosen place leads home like the tab used to (Coding →
            // overview, `select(tab:)`). The identifiers `home-tab-<tab>` stayed (test rig).
            CbSegments(
                options: HomeTab.allCases.map {
                    CbSegment(value: $0, label: L($0.displayLabel), id: "home-tab-\($0.rawValue)")
                },
                selection: Binding(
                    get: { state.tab },
                    set: { location in
                        state.select(tab: location)
                        state.closeDrawersAfterChoice()
                    }
                )
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 12)

            Divider()

            // The scope's status line (`ScopeStatusRow`: services, resources, agent browser) moved into the header button (`ServicesButton`),
            // which sits on EVERY tab; two places for the same list would be one too many.

            ScrollView {
                VStack(spacing: 3) {
                    if state.tab == .workspaces && state.activeWorkspaceId != nil {
                        // A list WITHOUT a card; on glass only the open category carries a glass shape (`cbSelection`).
                        ForEach(state.categories) { category in
                            if category.isTool, category == .code {
                                Divider().padding(.vertical, 6)
                            }
                            categoryRow(category)
                        }
                    } else {
                        Text(areaHint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 14)
                    }

                    // Coding · Apps · Profile sit as a segment bar ABOVE this list, not as rows here, otherwise the places would read like three more
                    // categories.
                }
                .padding(.vertical, 8)
            }

            if !CbGlass.on { Divider() }

            // Sticky at the bottom: bell, theme, settings; on glass three glass buttons in one group.
            CbGlassGroup {
            HStack(spacing: 10) {
                Button {
                    state.showNotifications = true
                } label: {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: "bell")
                            .font(.symbol(15))
                            .frame(width: 38, height: 38)
                            .contentShape(Circle())
                            .cbGlass(Circle(), interactive: true) { Circle().fill(CbColor.elevated) }
                        if state.unreadNotifications > 0 {
                            Text(state.unreadNotifications > 9 ? "9+" : "\(state.unreadNotifications)")
                                .cbFont(9, weight: .bold)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1.5)
                                .background(Color.red, in: Capsule())
                                .offset(x: 3, y: -2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("drawer-bell")
                .accessibilityLabel(L("Notifications"))

                Button {
                    theme.cycle()
                } label: {
                    Image(systemName: theme.preference.symbol)
                        .font(.symbol(15))
                        .frame(width: 38, height: 38)
                        .contentShape(Circle())
                        .cbGlass(Circle(), interactive: true) { Circle().fill(CbColor.elevated) }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("drawer-theme")
                .accessibilityLabel(L("Appearance"))

                Button {
                    state.showSettings = true
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "gearshape")
                            .font(.symbol(14))
                        Text(L("Settings"))
                            .cbFont(13.5, weight: .medium)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .contentShape(Capsule())
                    .cbGlass(Capsule(), interactive: true) { Capsule().fill(CbColor.elevated) }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("drawer-settings")
            }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 12)
        }
        .frame(maxHeight: .infinity)
        // NO material: a blur samples the background. While the drawer travels and the dimming behind it rises, that image changes in
        // every frame; the blur does not follow and flickers. An opaque surface looks the same in every frame (and is much cheaper). One
        // level darker than the card above it.
        .background(CbColor.drawer)
        // Buttons, place bar and the chosen row on glass (`Kit/CbGlass.swift`).
        .environment(\.drawerGlass, true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("right-drawer")
    }

    @ViewBuilder
    private func categoryRow(_ category: WorkspaceCategory) -> some View {
        let active = state.category == category && state.tab == .workspaces && !state.showingCodingOverview
        Button {
            // Without the spring: the drawer closes without travel, the new content fades in (`closeDrawersAfterChoice`).
            state.openCoding(category)
            state.closeDrawersAfterChoice()
        } label: {
            HStack(spacing: 11) {
                Image(systemName: state.categorySymbol(category))
                    .font(.symbol(14))
                    .frame(width: 20)
                Text(L(state.categoryTitle(category)))
                    .cbFont(14.5, weight: active ? .semibold : .regular)
                // Without a number: the Coding categories counted stocks, and a stock shows on its target page anyway.
                Spacer()
            }
            // The chosen row marked neutrally, not in the accent color.
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 9)
            .cbSelection(active, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("category-\(category.rawValue)")
    }
}

// ── Left drawer: category-specific ──
struct LeftDrawer: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    // The brand heads every left drawer (lens + wordmark, like the app name atop the Claude app's sidebar) instead of
                    // the section's name — the section shows in the drawer itself. The wordmark in the drawer title's type (`cbTitle(.drawer)`).
                    HStack(spacing: 8) {
                        CbaseLogo(size: 21)
                        Text(verbatim: "cbase")
                            .cbTitle(.drawer)
                            .foregroundStyle(CbColor.text)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: "cbase"))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("left-drawer-brand")
                    Text(state.scopeName)
                        .font(.caption)
                        .foregroundStyle(CbColor.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    // No own transaction: the drawer's motion animates `settleDrawer`. Writing the flag inside an animation cost a long frame (see
                    // finishDrag).
                    state.leftOpen = false
                } label: {
                    // As on the right: a 34 pt glass circle on glass.
                    Image(systemName: "xmark")
                        .font(.symbol(12, weight: .semibold))
                        .frame(width: CbGlass.on ? 34 : 30, height: CbGlass.on ? 34 : 30)
                        .cbGlassButton(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Close"))
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            LeftDrawerBody()

        }
        .frame(maxHeight: .infinity)
        // See the right drawer: opaque surface instead of material, one level below the card.
        .background(CbColor.drawer)
        // Buttons, search field, segments and the chosen row on glass (`Kit/CbGlass.swift`).
        .environment(\.drawerGlass, true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("left-drawer")
    }
}

// ── Swipe recognition ──
/// Horizontal pan over the whole window. Begins only on clearly horizontal motion so vertical scrolling stays untouched;
/// `cancelsTouchesInView` stays off so tapping keeps working.
///
/// Because the touches keep running, the scroll view below gets them too: a swipe is never exactly horizontal, so the chat
/// scrolled a bit when the drawer was pulled out. Hence the recognizer remembers the innermost scroll view with its offset on
/// TOUCH-DOWN and freezes it as soon as it takes over the swipe (see `lockScrolling`).
struct HorizontalPanReader: UIViewRepresentable {
    let enabled: Bool
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> AttachView {
        let view = AttachView()
        view.isUserInteractionEnabled = false
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ uiView: AttachView, context: Context) {
        context.coordinator.enabled = enabled
        context.coordinator.onChanged = onChanged
        context.coordinator.onEnded = onEnded
        context.coordinator.attach(to: uiView.window)
    }

    static func dismantleUIView(_ uiView: AttachView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class AttachView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            coordinator?.attach(to: window)
        }
    }

    /// A pan that reports already when the finger lands, before any motion, so before a scroll view below could react.
    final class TouchDownPan: UIPanGestureRecognizer {
        var onTouchDown: ((CGPoint) -> Void)?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesBegan(touches, with: event)
            if let view, let point = touches.first?.location(in: view) { onTouchDown?(point) }
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var enabled = true
        var onChanged: (CGFloat) -> Void = { _ in }
        var onEnded: (CGFloat, CGFloat) -> Void = { _, _ in }
        private weak var attachedWindow: UIWindow?
        private var recognizer: UIPanGestureRecognizer?
        /// Innermost scroll view under the touch-down point with its offset BEFORE the motion.
        private weak var candidateScrollView: UIScrollView?
        /// Innermost view under the finger that can scroll HORIZONTALLY (wide table, zoomed browser). We must not take such surfaces over;
        /// see `gestureRecognizerShouldBegin`.
        private weak var candidateHorizontalScroll: UIScrollView?
        /// View under the touch-down point; from there upward the competing recognizers are cancelled on takeover (see
        /// `cancelCompetingRecognizers`).
        private weak var candidateHitView: UIView?
        private var candidateOffset = CGPoint.zero
        private weak var lockedScrollView: UIScrollView?
        /// Take over once per swipe. It used to hang on `lockedScrollView`, which is set only with a scroll view under the finger; with
        /// none there (form, cards, toolbar), `cancelCompetingRecognizers` walked up the hierarchy in EVERY frame and switched every
        /// recognizer found off and on again. That cost frames.
        private var didTakeOver = false

        func attach(to window: UIWindow?) {
            guard let window, attachedWindow !== window else { return }
            detach()
            let pan = TouchDownPan(target: self, action: #selector(handle))
            pan.cancelsTouchesInView = false
            pan.delaysTouchesBegan = false
            pan.delegate = self
            pan.onTouchDown = { [weak self] point in self?.noteTouchDown(at: point) }
            window.addGestureRecognizer(pan)
            attachedWindow = window
            recognizer = pan
        }

        func detach() {
            unlockScrolling()
            if let recognizer { attachedWindow?.removeGestureRecognizer(recognizer) }
            recognizer = nil
            attachedWindow = nil
        }

        /// On touch-down: remember the innermost scrollable view under the finger and its offset.
        private func noteTouchDown(at point: CGPoint) {
            candidateScrollView = nil
            candidateHorizontalScroll = nil
            candidateHitView = nil
            guard let window = attachedWindow else { return }
            var view = window.hitTest(point, with: nil)
            candidateHitView = view
            // Walk up to the window: the innermost scroll view decides the freezing, a horizontally scrollable one below or above it
            // decides whether we swipe at all.
            while let current = view {
                if let scroll = current as? UIScrollView, scroll.isScrollEnabled {
                    if candidateScrollView == nil {
                        candidateScrollView = scroll
                        candidateOffset = scroll.contentOffset
                    }
                    if candidateHorizontalScroll == nil, scrollsSideways(scroll) {
                        candidateHorizontalScroll = scroll
                    }
                }
                view = current.superview
            }
        }

        private func scrollsSideways(_ scroll: UIScrollView) -> Bool {
            scroll.contentSize.width > scroll.bounds.width + 1
        }

        /// Can the surface consume the motion itself? At the edge the drawer may take over again, the same as with nested scroll views
        /// in iOS.
        private func consumesSwipe(_ scroll: UIScrollView, velocityX: CGFloat) -> Bool {
            let inset = scroll.adjustedContentInset
            let minOffset = -inset.left
            let maxOffset = scroll.contentSize.width + inset.right - scroll.bounds.width
            guard maxOffset - minOffset > 1 else { return false }
            let offset = scroll.contentOffset.x
            return velocityX > 0 ? offset > minOffset + 1 : offset < maxOffset - 1
        }

        /// Taking over the swipe: stop the scroll view and reset it to the offset from before the motion. Without it the history
        /// scrolled along by the vertical part of the swipe.
        private func lockScrolling() {
            guard !didTakeOver else { return }
            didTakeOver = true
            cancelCompetingRecognizers()
            guard let scroll = candidateScrollView else { return }
            lockedScrollView = scroll
            scroll.panGestureRecognizer.isEnabled = false
            scroll.setContentOffset(candidateOffset, animated: false)
        }

        private func unlockScrolling() {
            didTakeOver = false
            lockedScrollView?.panGestureRecognizer.isEnabled = true
            lockedScrollView = nil
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }

        /// Tap-like recognizers (those of the SwiftUI buttons) may fire only when our swipe has FAILED. Needed because the drawer moves
        /// under the finger: the button barely moves relative to the finger, so the release counted as a tap.
        ///
        /// A pure tap loses nothing by this (our recognizer demands clear horizontal velocity and fails at once; buttons fire on release
        /// on iOS anyway). EXCEPTED are drag, PINCH and rotation: if the zoom had to wait for our failure, it would drop out (measured in
        /// the browser).
        ///
        /// EXCEPTED too is the long press of the text marker. Its session start now runs on raw touches plus an own 0.5 s trigger
        /// (`MarkerTextUIView.pressTimer`), because a recognizer hung transitively on this pan via SwiftUI delegates and UIKit-internal
        /// `_UIRelationshipGestureRecognizer`, and its `.began` came only on motion or lift-off depending on the graph. The recognizer
        /// remains the second event source of the session: if a foreign recognizer cuts the view's touches, only it carries the
        /// marking. If it had to wait for this pan to fail, it would come too late for that.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy other: UIGestureRecognizer
        ) -> Bool {
            let required = !(other is UIPanGestureRecognizer
              || other is UIPinchGestureRecognizer
              || other is UIRotationGestureRecognizer
              || (other is UILongPressGestureRecognizer && other.view is MarkerTextUIView))
            MarkerTextUIView.trace("panRequiredToFailBy other=\(type(of: other)) view=\(other.view.map { String(describing: type(of: $0)) } ?? "nil") -> \(required)")
            return required
        }

        /// Second half of the same measure (see `shouldBeRequiredToFailBy`): on TAKING OVER the swipe, cancel the competing recognizers
        /// under the finger. The waiting rule alone covers only recognizers that UIKit asks; everything already running is ended here:
        /// switch off briefly (UIKit aborts the running recognition) and switch on again at once so the next touch works normally.
        ///
        /// Drag recognizers stay untouched; scroll views are locked deliberately via `lockScrolling` so their offset is preserved.
        private func cancelCompetingRecognizers() {
            var node = candidateHitView
            while let current = node {
                for gesture in current.gestureRecognizers ?? [] {
                    guard gesture !== recognizer, !(gesture is UIPanGestureRecognizer), gesture.isEnabled else { continue }
                    gesture.isEnabled = false
                    gesture.isEnabled = true
                }
                node = current.superview
            }
        }

        /// Does a sheet (or another modal structure) lie over the shell? The recognizer hangs on the WINDOW and would otherwise act there
        /// too: the drawer moved out invisibly behind the sheet and stood open after swiping away. Concerns every sheet (git in chat,
        /// chat settings, diff …); the shell's full-screen overlays are handled by `enabled`.
        private var sheetIsUp: Bool {
            attachedWindow?.rootViewController?.presentedViewController != nil
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard enabled, !sheetIsUp, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            // If the text marker owns the touch (long press on message text, session running), sideways dragging belongs to it too: it
            // extends the marking within the line instead of opening the drawer. UIKit asks `shouldBegin` only once per touch; the no holds
            // until lift-off.
            if MarkerTextUIView.markerSessionActive {
                MarkerTextUIView.trace("panShouldBegin -> false (Marker-Sitzung)")
                return false
            }
            let velocity = pan.velocity(in: pan.view)
            MarkerTextUIView.trace("panShouldBegin velocity=\(velocity) travel=\(pan.translation(in: pan.view))")
            // A sideways scrollable surface under the finger (wide Markdown table, code block, zoomed browser): the motion belongs to it,
            // not to the drawer. Otherwise a table could not be scrolled sideways at all, every drag would open the drawer.
            if let scroll = candidateHorizontalScroll, consumesSwipe(scroll, velocityX: velocity.x) {
                pan.cancelsTouchesInView = false
                return false
            }
            // Take over as soon as the motion clearly goes sideways, in two ways:
            //
            // 1. DISTANCE: the path so far points sideways (slow, deliberate drag).
            // 2. SPEED: a horizontal flick (short distance, high speed).
            //
            // Speed alone used to decide (>60 pt/s). Whoever pulled the drawer slowly was never taken over, and since UIKit asks `shouldBegin`
            // only ONCE per touch, a later flick did not help either: the recognizer had long failed. That felt like "you have to swipe hard".
            let travel = pan.translation(in: pan.view)
            let pathIsSideways = abs(travel.x) >= 6 && abs(travel.x) > abs(travel.y) * 1.2
            let flickIsSideways = abs(velocity.x) > abs(velocity.y) * 1.5 && abs(velocity.x) > 25
            let takeOver = pathIsSideways || flickIsSideways
            // On taking over, the touches under the finger are CANCELLED. Otherwise the release counts as a tap: the drawer moves along under
            // the finger, so the button barely moves relative to the finger; on pulling out, the button under the start point fired, on
            // pushing in the button in the drawer. Setting it belongs HERE (before recognition); afterwards it would be too late.
            pan.cancelsTouchesInView = takeOver
            return takeOver
        }

        @objc private func handle(_ pan: UIPanGestureRecognizer) {
            guard let window = attachedWindow else { return }
            let translation = pan.translation(in: window).x
            switch pan.state {
            case .began:
                guard enabled else { return }
                lockScrolling()
            case .changed:
                guard enabled else { return }
                // Lock here too: `.began` may be skipped with the drawer already open when the recognizer fires only later.
                lockScrolling()
                onChanged(translation)
            case .ended, .cancelled, .failed:
                // Release ALWAYS, also when the recognizer was switched off mid-motion (opening a sheet/settings). Otherwise the scroll view
                // would stay locked forever and the chat could no longer be moved.
                unlockScrolling()
                // Back to "let touches through" so an ordinary tap reaches the button again (the recognizer itself never fires then).
                pan.cancelsTouchesInView = false
                guard enabled else { return }
                onEnded(translation, pan.velocity(in: window).x)
            default:
                break
            }
        }
    }
}
