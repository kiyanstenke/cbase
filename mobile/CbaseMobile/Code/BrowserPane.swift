import SwiftUI
import UIKit

// Streamed browser: server-side Chromium, frames via SSE (JPEG screencast), input
// via POST — identical to the desktop client, just with touch control. Frames are acknowledged
// (flow control), otherwise the server stops after two unacknowledged images.
//
// Built into the page background: ONLY surfaces and colors — the address bar and the canvas sit directly on `CbColor.grund`
// (the bar without a surface of its own, no raised box around the image — SwiftUI's background and `BrowserCanvasHost.backgroundColor`
// take the page ground's color). A `CbHairline` between address bar and image and between image and text bar — as an overlay, so
// the viewport (`resizeViewport`) measures the same size. Address field, buttons and the floating capsules (rotate, zoom) are unchanged.
@MainActor
final class BrowserSessionModel: ObservableObject {
    @Published var browserId = ""
    @Published var kind = "user"
    @Published var label = ""
    @Published var tabs: [BrowserTabInfo] = []
    @Published var selectedTab = ""
    @Published var frame: UIImage?
    @Published var pageSize = CGSize(width: 1280, height: 800)
    @Published var urlText = ""
    @Published var starting = false
    @Published var gone = false
    @Published var error = ""
    /// Viewer mode: an agent's browser. Not "watch only": taps, text, keys and scrolling go into THIS browser
    /// (e.g. to sign in on the agent's behalf). The window size stays the agent's (`resizeViewport` only for
    /// `kind == "user"`): the agent measures its page, and an emulation would break its screencast (backend `browsers.js`).
    @Published var watchingAgent = false
    /// The PROFILE of the agent browser being watched ("chat-<chatId>[-agent-<agentId>]"). The agent starts a new Chromium
    /// in the same profile for every run (turn, workflow step) — new session, new `browserId`. When the session ends,
    /// the model looks for the next one of the same profile (`searchAgentsSession`) instead of silently falling back to
    /// the own browser.
    @Published var watchedProfile = ""
    /// The chosen profile's session is gone, a new one not there yet — the surface says "closed".
    @Published var agentClosed = false
    /// Desktop view: the server renders a desktop window (1280 CSS pixels wide) instead of
    /// the narrow phone pane. The choice survives an app restart.
    @Published var desktopMode = UserDefaults.standard.bool(forKey: BrowserSessionModel.desktopKey)

    static let desktopKey = "cbase.mobile.browser.desktop"
    /// Width of the desktop window in CSS pixels — narrower would no longer be a desktop layout.
    static let desktopWidth: CGFloat = 1280

    private let client: APIClient
    private let apiBase: String
    private var streamTask: Task<Void, Never>?
    private var viewerId = ""
    private var pendingEvents: [JSONValue] = []
    private var flushing = false
    /// Last reported window size (see `resizeViewport`).
    private var lastViewport = CGSize.zero
    /// The tab in which the agent last did something (hello/tabs, field `agentTab`) — the view follows.
    private var agentTab = ""
    private var searchTask: Task<Void, Never>?

    init(client: APIClient, apiBase: String) {
        self.client = client
        self.apiBase = apiBase
    }

    deinit {
        streamTask?.cancel()
        searchTask?.cancel()
    }

    var activeTab: BrowserTabInfo? {
        tabs.first(where: { $0.id == selectedTab }) ?? tabs.first(where: \.active) ?? tabs.first
    }

    func ensure() async {
        guard !starting else { return }
        starting = true
        error = ""
        defer { starting = false }
        do {
            let response: BrowserEnsureResponse = try await client.post("\(apiBase)/browser/ensure")
            if let id = response.id, !id.isEmpty {
                gone = false
                watchingAgent = false
                watchedProfile = ""
                agentClosed = false
                searchTask?.cancel()
                browserId = id
                connect()
            } else {
                error = response.error ?? L("Error")
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Switch to an agent browser — its profile is remembered (see `watchedProfile`).
    func watch(agent browser: AgentBrowserInfo) {
        streamTask?.cancel()
        streamTask = nil
        searchTask?.cancel()
        watchingAgent = true
        watchedProfile = browser.profile
        agentClosed = false
        gone = false
        browserId = browser.id
        tabs = []
        selectedTab = ""
        agentTab = ""
        frame = nil
        connect()
    }

    func stopWatching() {
        streamTask?.cancel()
        streamTask = nil
        searchTask?.cancel()
        watchingAgent = false
        watchedProfile = ""
        agentClosed = false
        browserId = ""
        tabs = []
        frame = nil
        Task { await ensure() }
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        searchTask?.cancel()
        searchTask = nil
    }

    /// The chosen agent profile's session is gone — or only its stream (45 s of silence without heartbeat, app in the
    /// background, network change): find the newest session of the same profile and attach to it. Only while the surface
    /// is meant to be connected — `disconnect` aborts, a new `connect` keeps searching. The list is the same as in
    /// the drawer (`GET /api/browsers`).
    ///
    /// `except`: an id that is certainly dead (the server sent `gone`). A stream end without `gone` does NOT mean the
    /// session is gone — otherwise a living agent browser would show as "closed" permanently after every drop, precisely while
    /// signing in on the agent's behalf. The surface shows "closed" only when a list answer no longer carries the profile
    /// (a failed request is not an empty list).
    private func searchAgentsSession(except totId: String?) {
        guard watchingAgent, !watchedProfile.isEmpty else { return }
        if totId != nil {
            agentClosed = true
            gone = true
            frame = nil
        }
        searchTask?.cancel()
        let profile = watchedProfile
        let oldId = browserId
        searchTask = Task { [weak self] in
            // A stream end without gone: wait briefly, so a stream that fails again at once does not reconnect in a loop.
            if totId == nil { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            while !Task.isCancelled {
                guard let self else { return }
                let response: AgentBrowsersResponse? = try? await self.client.get("/api/browsers")
                if Task.isCancelled || !self.watchingAgent || self.watchedProfile != profile { return }
                // The list is in discovery order: the LAST session of the profile is the newest.
                if let fresh = response?.browsers.last(where: { $0.kind == "agent" && $0.profile == profile && $0.id != totId }) {
                    if fresh.id != oldId {
                        self.selectedTab = ""
                        self.agentTab = ""
                        self.tabs = []
                    }
                    self.browserId = fresh.id
                    self.gone = false
                    self.agentClosed = false
                    self.connect()
                    return
                }
                if response != nil, !self.agentClosed {
                    self.agentClosed = true
                    self.gone = true
                    self.frame = nil
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func connect() {
        guard !browserId.isEmpty else { return }
        if agentClosed {
            searchAgentsSession(except: nil)
            return
        }
        streamTask?.cancel()
        let id = browserId
        let tab = selectedTab
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let query = tab.isEmpty ? [] : [URLQueryItem(name: "tab", value: tab)]
                for try await (event, payload) in client.namedStream("/api/browsers/\(id)/stream", query: query) {
                    switch event {
                    case "hello":
                        self.kind = payload["kind"]?.stringValue ?? "user"
                        self.label = payload["label"]?.stringValue ?? ""
                        self.tabs = Self.decodeTabs(payload["tabs"])
                        self.viewerId = payload["vid"]?.stringValue ?? ""
                        self.gone = false
                        if self.watchingAgent { self.agentTab = payload["agentTab"]?.stringValue ?? "" }
                        if self.selectedTab.isEmpty, let first = payload["tab"]?.stringValue {
                            self.selectedTab = first
                        }
                        self.syncUrlField()
                    case "tabs":
                        self.tabs = Self.decodeTabs(payload["tabs"])
                        self.syncUrlField()
                        // If the agent opens a tab or changes the address there, the view follows — as on the web
                        // (BrowserPane.tsx). A user's choice stays until the agent next does something.
                        let fresh = payload["agentTab"]?.stringValue ?? ""
                        if self.watchingAgent, !fresh.isEmpty, fresh != self.agentTab {
                            self.agentTab = fresh
                            if fresh != self.selectedTab {
                                self.selectedTab = fresh
                                self.connect()
                                return
                            }
                        }
                    case "frame":
                        self.handleFrame(payload)
                    case "tabclosed":
                        // Resubscribe like the web: the server sends frames and tab lists only to
                        // the viewers of LIVE tabs — whoever hangs on the dead one never sees the replacement tab
                        // and at the same time keeps the browser from the idle stop.
                        self.selectedTab = ""
                        self.connect()
                    case "gone":
                        if self.watchingAgent, !self.watchedProfile.isEmpty {
                            self.searchAgentsSession(except: id)
                            return
                        }
                        self.gone = true
                        self.frame = nil
                    default:
                        break
                    }
                }
            } catch {
                // EventSource equivalent: reconnecting is the caller's job.
            }
            // If an agent browser's stream ends without gone (404 after a restart, dropped line, app in the
            // background), the list decides: if the same session is still there, the surface reattaches —
            // not cancelled by us (Task.isCancelled) and not already switched over.
            if !Task.isCancelled, self.watchingAgent, !self.watchedProfile.isEmpty, self.browserId == id {
                self.searchAgentsSession(except: nil)
            }
        }
    }

    private static func decodeTabs(_ value: JSONValue?) -> [BrowserTabInfo] {
        guard let value, let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([BrowserTabInfo].self, from: data)) ?? []
    }

    private func syncUrlField() {
        let url = activeTab?.url ?? ""
        urlText = url == "about:blank" ? "" : url
    }

    private func handleFrame(_ payload: JSONValue) {
        if let seq = payload["seq"]?.intValue, !viewerId.isEmpty {
            push(.object([
                "t": .string("ack"),
                "v": .string(viewerId),
                "seq": .number(Double(seq))
            ]))
        }
        if !selectedTab.isEmpty, let tab = payload["tab"]?.stringValue, tab != selectedTab { return }
        guard let base64 = payload["data"]?.stringValue,
              let data = Data(base64Encoded: base64),
              let image = UIImage(data: data) else { return }
        frame = image
        if let width = payload["w"]?.doubleValue, let height = payload["h"]?.doubleValue, width > 0, height > 0 {
            pageSize = CGSize(width: width, height: height)
        }
    }

    // ── Send inputs strictly serialized (guarantee order) ──
    func push(_ event: JSONValue) {
        pendingEvents.append(event)
        flush()
    }

    private func flush() {
        guard !flushing, !pendingEvents.isEmpty, !browserId.isEmpty else { return }
        let events = pendingEvents
        pendingEvents = []
        flushing = true
        struct Body: Encodable { let tab: String; let events: [JSONValue] }
        Task {
            _ = try? await client.send(
                "/api/browsers/\(browserId)/input",
                body: Body(tab: selectedTab, events: events)
            )
            flushing = false
            if !pendingEvents.isEmpty { flush() }
        }
    }

    func tap(at point: CGPoint) {
        for type in ["mousePressed", "mouseReleased"] {
            push(.object([
                "t": .string("mouse"),
                "type": .string(type),
                "x": .number(point.x),
                "y": .number(point.y),
                "button": .string("left"),
                "buttons": .number(type == "mousePressed" ? 1 : 0),
                "clickCount": .number(1),
                "modifiers": .number(0)
            ]))
        }
    }

    func scroll(at point: CGPoint, deltaX: CGFloat, deltaY: CGFloat) {
        push(.object([
            "t": .string("mouse"),
            "type": .string("mouseWheel"),
            "x": .number(point.x),
            "y": .number(point.y),
            "button": .string("none"),
            "buttons": .number(0),
            "deltaX": .number(deltaX),
            "deltaY": .number(deltaY),
            "modifiers": .number(0)
        ]))
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        push(.object(["t": .string("text"), "text": .string(text)]))
    }

    func sendKey(_ key: String, code: String, text: String?, winCode: Int) {
        for type in ["keyDown", "keyUp"] {
            var payload: [String: JSONValue] = [
                "t": .string("key"),
                "type": .string(type),
                "key": .string(key),
                "code": .string(code),
                "winCode": .number(Double(winCode)),
                "modifiers": .number(0),
                "repeat": .bool(false)
            ]
            if type == "keyDown", let text { payload["text"] = .string(text) }
            push(.object(payload))
        }
    }

    func act(_ body: [String: JSONValue]) async -> BrowserActResponse? {
        guard !browserId.isEmpty else { return nil }
        var payload = body
        if payload["tab"] == nil { payload["tab"] = .string(selectedTab) }
        return try? await client.post("/api/browsers/\(browserId)/act", body: JSONValue.object(payload))
    }

    func navigate() async {
        _ = await act(["type": .string("navigate"), "url": .string(urlText)])
    }

    func selectTab(_ id: String) {
        selectedTab = id
        if kind == "user" {
            Task { _ = await act(["type": .string("selectTab"), "tab": .string(id)]) }
        }
        connect()
    }

    func newTab() async {
        if let response = await act(["type": .string("newTab")]), let tab = response.tab {
            selectedTab = tab
            connect()
        }
    }

    func closeTab(_ id: String) async {
        _ = await act(["type": .string("closeTab"), "tab": .string(id)])
    }

    /// Report the viewport: in phone mode the real pane size, in desktop mode a window of
    /// 1280 CSS pixels width in the aspect ratio of the ROTATED screen — shown rotated it
    /// then fills the surface without bars.
    func resizeViewport(_ box: CGSize) async {
        guard kind == "user", box.width > 50, box.height > 50 else { return }
        let size = desktopMode ? Self.desktopViewport(for: box) : box
        // Do not report equal dimensions again: every `resize` restarts the screencast on the server. In desktop
        // mode the target does not change anyway with small pane changes (keyboard).
        let rounded = CGSize(width: size.width.rounded(), height: size.height.rounded())
        guard rounded != lastViewport else { return }
        lastViewport = rounded
        _ = await act([
            "type": .string("resize"),
            "width": .number(Double(Int(size.width))),
            "height": .number(Double(Int(size.height))),
            "dpr": .number(min(2, Double(UIScreen.main.scale)))
        ])
    }

    static func desktopViewport(for box: CGSize) -> CGSize {
        let long = max(box.width, box.height)
        let short = min(box.width, box.height)
        guard long > 0 else { return CGSize(width: desktopWidth, height: 800) }
        let height = (desktopWidth * short / long).rounded()
        return CGSize(width: desktopWidth, height: min(1100, max(620, height)))
    }

    func setDesktopMode(_ on: Bool, box: CGSize) {
        guard on != desktopMode else { return }
        desktopMode = on
        UserDefaults.standard.set(on, forKey: Self.desktopKey)
        Task { await resizeViewport(box) }
    }

    func restart() async {
        guard !browserId.isEmpty else { return }
        _ = try? await client.send("/api/browsers/\(browserId)", method: .delete)
        disconnect()
        browserId = ""
        selectedTab = ""
        frame = nil
        await ensure()
    }
}

// ── Zoomable, rotatable canvas ─────────────────────────────────────────────
//
// Deliberately UIKit: pinch zoom, panning while zoomed and converting a tap into
// page coordinates have to fit together. In a `UIScrollView`, image and touch
// share the SAME coordinate space — however strongly zoomed and whether the view was rotated
// by 90° for the desktop view. A tap is therefore always measured in the image and
// only divided by the fit factor; the rotation drops out by itself.
//
// Controls: one finger scrolls the PAGE while not zoomed; when zoomed it moves
// the visible area. Two fingers always scroll the page (hence the scroll view itself takes
// only one finger). Tapping clicks.
struct BrowserCanvas: UIViewRepresentable {
    let image: UIImage?
    let pageSize: CGSize
    let rotated: Bool
    let interactive: Bool
    let onTap: (CGPoint) -> Void
    let onWheel: (CGPoint, CGFloat, CGFloat) -> Void
    let onZoom: (CGFloat) -> Void
    /// Counter: when it changes, the zoom returns to "fitted".
    let resetToken: Int

    func makeUIView(context: Context) -> BrowserCanvasHost {
        let host = BrowserCanvasHost()
        host.onTap = onTap
        host.onWheel = onWheel
        host.onZoom = onZoom
        return host
    }

    func updateUIView(_ host: BrowserCanvasHost, context: Context) {
        host.onTap = onTap
        host.onWheel = onWheel
        host.onZoom = onZoom
        host.interactive = interactive
        host.apply(image: image, pageSize: pageSize, rotated: rotated)
        host.applyResetToken(resetToken)
    }
}

final class BrowserCanvasHost: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    var onTap: ((CGPoint) -> Void)?
    var onWheel: ((CGPoint, CGFloat, CGFloat) -> Void)?
    var onZoom: ((CGFloat) -> Void)?
    var interactive = true

    private let scroll = UIScrollView()
    private let imageView = UIImageView()
    private var pageSize = CGSize(width: 1280, height: 800)
    private var rotated = false
    private var fitScale: CGFloat = 1
    private var lastLayoutKey = ""
    private var seenResetToken = 0
    private var lastWheelPoint = CGPoint.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        // The page ground's color — the canvas is not a box in front of the page.
        backgroundColor = CbColor.ui(.ground)
        clipsToBounds = true
        // So the canvas can be found in the accessibility structure (and thus by tests)
        // — touches pass through the scroll view regardless.
        isAccessibilityElement = true
        accessibilityIdentifier = "browser-canvas"
        accessibilityLabel = L("Browser view")

        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.bouncesZoom = true
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        // Only ONE finger scrolls the zoomed area — two fingers belong to page scrolling.
        scroll.panGestureRecognizer.maximumNumberOfTouches = 1
        addSubview(scroll)

        imageView.contentMode = .scaleToFill
        imageView.isUserInteractionEnabled = true
        scroll.addSubview(imageView)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        imageView.addGestureRecognizer(tap)

        let onePan = UIPanGestureRecognizer(target: self, action: #selector(handleWheelPan))
        onePan.maximumNumberOfTouches = 1
        onePan.delegate = self
        scroll.addGestureRecognizer(onePan)

        let twoPan = UIPanGestureRecognizer(target: self, action: #selector(handleWheelPan))
        twoPan.minimumNumberOfTouches = 2
        twoPan.maximumNumberOfTouches = 2
        twoPan.delegate = self
        scroll.addGestureRecognizer(twoPan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func apply(image: UIImage?, pageSize: CGSize, rotated: Bool) {
        imageView.image = image
        let page = pageSize.width > 1 && pageSize.height > 1 ? pageSize : CGSize(width: 1280, height: 800)
        guard page != self.pageSize || rotated != self.rotated else { return }
        self.pageSize = page
        self.rotated = rotated
        setNeedsLayout()
    }

    func applyResetToken(_ token: Int) {
        guard token != seenResetToken else { return }
        seenResetToken = token
        scroll.setZoomScale(1, animated: true)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let box = bounds.size
        guard box.width > 1, box.height > 1 else { return }
        // Rotated: the scroll view is as large as the ROTATED window (sides swapped)
        // and is then tilted by 90°.
        let viewport = rotated ? CGSize(width: box.height, height: box.width) : box
        let key = "\(box)|\(viewport)|\(pageSize)|\(rotated)"
        guard key != lastLayoutKey else { return }
        lastLayoutKey = key

        let zoom = scroll.zoomScale
        scroll.transform = .identity
        scroll.frame = CGRect(origin: .zero, size: viewport)
        scroll.transform = rotated ? CGAffineTransform(rotationAngle: .pi / 2) : .identity
        scroll.center = CGPoint(x: box.width / 2, y: box.height / 2)

        fitScale = min(viewport.width / pageSize.width, viewport.height / pageSize.height)
        let drawn = CGSize(width: pageSize.width * fitScale, height: pageSize.height * fitScale)
        scroll.zoomScale = 1
        imageView.frame = CGRect(origin: .zero, size: drawn)
        scroll.contentSize = drawn
        scroll.zoomScale = min(scroll.maximumZoomScale, max(1, zoom))
        centerContent()
    }

    private func centerContent() {
        let viewport = scroll.bounds.size
        let content = imageView.frame.size
        scroll.contentInset = UIEdgeInsets(
            top: max(0, (viewport.height - content.height) / 2),
            left: max(0, (viewport.width - content.width) / 2),
            bottom: 0,
            right: 0
        )
    }

    /// Image point → page coordinate. The zoom sits in the image view's transform,
    /// its own coordinates stay untouched — only the fit factor counts.
    private func pagePoint(_ point: CGPoint) -> CGPoint {
        guard fitScale > 0 else { return .zero }
        return CGPoint(
            x: max(0, min(pageSize.width, point.x / fitScale)),
            y: max(0, min(pageSize.height, point.y / fitScale))
        )
    }

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard interactive else { return }
        onTap?(pagePoint(recognizer.location(in: imageView)))
    }

    @objc private func handleWheelPan(_ recognizer: UIPanGestureRecognizer) {
        let twoFinger = recognizer.minimumNumberOfTouches == 2
        // One finger scrolls the page only while not zoomed — when zoomed it belongs to
        // moving the visible area.
        guard twoFinger || scroll.zoomScale <= 1.01 else { return }
        switch recognizer.state {
        case .began:
            lastWheelPoint = recognizer.location(in: imageView)
        case .changed:
            let translation = recognizer.translation(in: scroll)
            recognizer.setTranslation(.zero, in: scroll)
            // Screen points → page pixels, with the sign reversed: the content follows
            // the finger (pulling down brings earlier content back), as everywhere on the phone.
            let factor = max(0.2, fitScale * scroll.zoomScale)
            onWheel?(
                pagePoint(lastWheelPoint),
                -translation.x / factor,
                -translation.y / factor
            )
        default:
            break
        }
    }

    // ── UIScrollViewDelegate ──
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerContent()
        onZoom?(scrollView.zoomScale)
    }

    // Own pans run alongside the scroll view's recognizers.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

struct BrowserPane: View {
    @ObservedObject var model: BrowserSessionModel
    let active: Bool
    @State private var keyboardText = ""
    @State private var showKeyboard = false
    @State private var lastSize = CGSize.zero
    @State private var zoom: CGFloat = 1
    @State private var zoomResetToken = 0

    var body: some View {
        VStack(spacing: 0) {
            navigationRow

            if model.agentClosed {
                // The agent's session is gone, the next one of the same profile comes with its next run — the
                // model then attaches by itself. No "Start browser": that belonged to the own browser, and
                // "Own browser" at the top leads back there.
                Text(L("The agent's browser is closed."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("browser-agent-closed")
            } else if !model.error.isEmpty || model.gone {
                VStack(spacing: 12) {
                    Text(model.error.isEmpty ? L("Browser was closed.") : model.error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    PillButton(title: L("Start browser"), prominent: true) {
                        Task { await model.ensure() }
                    }
                    .accessibilityIdentifier("browser-start")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                GeometryReader { geo in
                    // In portrait the desktop view is tilted — the phone is turned along with it. If the user
                    // turns it, the window itself becomes landscape and the tilt
                    // drops out: the page is then upright on its own.
                    let rotated = model.desktopMode && geo.size.height > geo.size.width
                    ZStack {
                        CbColor.ground
                        if model.frame != nil {
                            BrowserCanvas(
                                image: model.frame,
                                pageSize: model.pageSize,
                                rotated: rotated,
                                // Also in the agent browser: the user intervenes (signing in for the agent).
                                interactive: true,
                                onTap: { point in model.tap(at: point) },
                                onWheel: { point, deltaX, deltaY in
                                    model.scroll(at: point, deltaX: deltaX, deltaY: deltaY)
                                },
                                onZoom: { zoom = $0 },
                                resetToken: zoomResetToken
                            )
                            .accessibilityIdentifier("browser-canvas")
                        } else if active {
                            // Animate only in the visible tab — a permanent animation in
                            // a hidden pane never lets the app come to rest.
                            CbLoading(label: model.starting ? L("Browser starting …") : L("No tab open."))
                        }

                        if rotated {
                            VStack {
                                Spacer()
                                Label(L("Turn the phone for the desktop view"), systemImage: "rotate.right")
                                    .font(.caption2.weight(.medium))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(CbColor.surface, in: Capsule())
                                    .padding(.bottom, 8)
                            }
                            .allowsHitTesting(false)
                        }

                        if zoom > 1.02 {
                            VStack {
                                HStack {
                                    Spacer()
                                    Button {
                                        zoomResetToken += 1
                                        zoom = 1
                                    } label: {
                                        Text(verbatim: "\(Int((zoom * 100).rounded())) %")
                                            .cbFont(11, weight: .semibold)
                                            .monospacedDigit()
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 5)
                                            .background(CbColor.surface, in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("browser-zoom-reset")
                                    .accessibilityLabel(L("Reset zoom"))
                                }
                                Spacer()
                            }
                            .padding(8)
                        }
                    }
                    .onChange(of: geo.size) { _, size in
                        guard active, size != lastSize else { return }
                        lastSize = size
                        Task { await model.resizeViewport(size) }
                    }
                    .onChange(of: model.desktopMode) {
                        lastSize = geo.size
                        Task { await model.resizeViewport(geo.size) }
                    }
                }
            }

            if showKeyboard {
                HStack(spacing: 8) {
                    TextField(L("Send text to the page"), text: $keyboardText)
                        .cbFont(13)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .onSubmit { sendText() }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 9)
                        .background(CbColor.ground, in: RoundedRectangle(cornerRadius: 12))
                        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.22)) }
                        .accessibilityIdentifier("browser-keyboard-field")
                    Button { sendText() } label: {
                        Image(systemName: "paperplane.fill")
                            .font(.symbol(13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.accentColor))
                    }
                    .buttonStyle(.plain)
                    Button {
                        model.sendKey("Enter", code: "Enter", text: "\r", winCode: 13)
                    } label: {
                        Image(systemName: "return")
                            .font(.symbol(13, weight: .bold))
                            .frame(width: 36, height: 36)
                            .background(Color.secondary.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(CbColor.ground)
                // Only a hairline to the image above.
                .overlay(alignment: .top) { CbHairline() }
            }
        }
        .background(CbColor.ground)
        .task {
            if active && model.browserId.isEmpty { await model.ensure() }
        }
        .onChange(of: active) { _, isActive in
            if isActive {
                if model.browserId.isEmpty {
                    Task { await model.ensure() }
                } else {
                    model.connect()
                }
            } else {
                model.disconnect()
            }
        }
    }

    private var navigationRow: some View {
        VStack(spacing: 6) {
            if model.watchingAgent || model.kind == "agent" {
                HStack(spacing: 6) {
                    Circle().fill(Color.accentColor).frame(width: 6, height: 6)
                    Text(L("Agent browser") + (model.label.isEmpty ? "" : " · \(model.label)"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    PillButton(title: L("Own browser")) { model.stopWatching() }
                }
                .padding(.horizontal, 12)
            }
            HStack(spacing: 5) {
                Button { Task { _ = await model.act(["type": .string("back")]) } } label: {
                    Image(systemName: "chevron.left").font(.symbol(13, weight: .semibold)).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(model.kind != "user")
                .accessibilityLabel(L("Back"))
                Button { Task { _ = await model.act(["type": .string("forward")]) } } label: {
                    Image(systemName: "chevron.right").font(.symbol(13, weight: .semibold)).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(model.kind != "user")
                .accessibilityLabel(L("Forward"))
                Button { Task { _ = await model.act(["type": .string("reload")]) } } label: {
                    Image(systemName: "arrow.clockwise").font(.symbol(12, weight: .semibold)).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(model.kind != "user")
                .accessibilityLabel(L("Reload"))

                TextField(L("URL or search"), text: $model.urlText)
                    .cbFont(12, design: .monospaced)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { Task { await model.navigate() } }
                    .disabled(model.kind != "user")
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(CbColor.surface, in: Capsule())
                    .accessibilityIdentifier("browser-url")

                Button {
                    model.setDesktopMode(!model.desktopMode, box: lastSize)
                } label: {
                    Image(systemName: model.desktopMode ? "desktopcomputer" : "iphone")
                        .font(.symbol(13))
                        .foregroundStyle(model.desktopMode ? Color.accentColor : Color.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(model.kind != "user")
                .accessibilityIdentifier("browser-desktop-toggle")
                .accessibilityLabel(model.desktopMode ? L("Phone view") : L("Desktop view"))

                Button { showKeyboard.toggle() } label: {
                    Image(systemName: "keyboard")
                        .font(.symbol(13))
                        .foregroundStyle(showKeyboard ? Color.accentColor : Color.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("browser-keyboard-toggle")
                .accessibilityLabel(L("Keyboard"))
            }
            .padding(.horizontal, 10)
        }
        .padding(.vertical, 7)
        // On the page ground, only a hairline to the image below — no surface of its own.
        .overlay(alignment: .bottom) { CbHairline() }
    }

    private func sendText() {
        let text = keyboardText
        keyboardText = ""
        model.sendText(text)
    }
}

// ── Left drawer: tabs + agent browser ─────────────────────────────────
struct BrowserSidebar: View {
    @ObservedObject var model: BrowserSessionModel
    @EnvironmentObject private var state: AppState
    @State private var agentBrowsers: [AgentBrowserInfo] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    SectionLabel(text: L("Tabs"))
                    Spacer()
                    PillButton(title: L("New tab"), systemImage: "plus") {
                        Task { await model.newTab() }
                    }
                    .accessibilityIdentifier("browser-new-tab")
                }
                if model.tabs.isEmpty {
                    Text(L("No tab open.")).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(model.tabs) { tab in
                    HStack(spacing: 6) {
                        Button {
                            model.selectTab(tab.id)
                            state.closeDrawersAfterChoice()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    // The tab in which the agent last did something (like the dot on the web).
                                    if model.watchingAgent && tab.agent {
                                        Circle().fill(Color.accentColor).frame(width: 5, height: 5)
                                            .accessibilityLabel(L("in use##controlling"))
                                    }
                                    Text(tab.title.isEmpty ? (tab.url.isEmpty ? L("New tab") : tab.url) : tab.title)
                                        .cbFont(12.5, weight: model.selectedTab == tab.id ? .semibold : .regular)
                                        .lineLimit(1)
                                }
                                if !tab.url.isEmpty {
                                    Text(tab.url)
                                        .cbFont(10, design: .monospaced)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Button {
                            Task { await model.closeTab(tab.id) }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.symbol(10, weight: .bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("Close tab"))
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    // Selected neutrally like every drawer row (`LeftDrawerBody.row`).
                    .cbSelection(model.selectedTab == tab.id, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                Divider().padding(.vertical, 6)

                HStack {
                    SectionLabel(text: L("Agent browser"))
                    Spacer()
                    PillButton(title: L("Refresh")) { Task { await loadAgents() } }
                }
                // Empty is not unknown: "no agent browser" only once the list has answered.
                if loaded && agentBrowsers.isEmpty {
                    Text(L("No agent browser active.")).font(.caption).foregroundStyle(.secondary)
                }
                // One name per row, on the right the tab count and a dot while the agent is currently steering the browser —
                // no sentence on it (a description on every row, and a dot on every row even for an idle one, was far too long).
                ForEach(agentBrowsers) { browser in
                    let selected = model.watchingAgent && !browser.profile.isEmpty && model.watchedProfile == browser.profile
                    Button {
                        model.watch(agent: browser)
                        state.closeDrawersAfterChoice()
                    } label: {
                        HStack(spacing: 7) {
                            Text(Self.name(browser))
                                .cbFont(12.5, weight: selected ? .semibold : .regular)
                                .lineLimit(1)
                            Spacer(minLength: 6)
                            if browser.controlsCurrently(now: now) {
                                Circle().fill(Color.accentColor).frame(width: 6, height: 6)
                                    .accessibilityLabel(L("in use##controlling"))
                            }
                            Text(verbatim: "\(browser.tabs)")
                                .font(.caption2)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .cbSelection(selected, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("browser-agent-row")
                }

                Divider().padding(.vertical, 6)
                PillButton(title: L("Restart browser")) { Task { await model.restart() } }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
        // Poll on a clock while the drawer is open: which agents are browsing (and which one steers) changes
        // with each of their runs. Also at once when the surface has switched to a new session.
        .task {
            while !Task.isCancelled {
                await loadAgents()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        .onChange(of: model.browserId) { Task { await loadAgents() } }
    }

    /// Loaded means: the list has answered once for THIS workspace.
    private var loaded: Bool { loadedFor != nil && loadedFor == state.activeWorkspaceId }
    @State private var loadedFor: String?
    @State private var now: Double = Date().timeIntervalSince1970 * 1000

    /// The short name: the server names the chat or the subagent; its folder name is not a name.
    static func name(_ browser: AgentBrowserInfo) -> String {
        browser.label.isEmpty || browser.label == browser.profile ? L("Agent browser") : browser.label
    }

    private func loadAgents() async {
        guard let client = state.client, let workspaceId = state.activeWorkspaceId else { return }
        // A failure is not an empty list: only an answer sets list and flag.
        guard let response: AgentBrowsersResponse = try? await client.get(
            "/api/browsers",
            query: [URLQueryItem(name: "workspaceId", value: workspaceId)]
        ) else { return }
        guard workspaceId == state.activeWorkspaceId else { return }
        agentBrowsers = response.browsers.filter { $0.kind == "agent" }
        now = Date().timeIntervalSince1970 * 1000
        loadedFor = workspaceId
    }
}
