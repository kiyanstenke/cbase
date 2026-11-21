import AVKit
import SwiftUI
import UIKit

// ── Question card (cbase_ask) ─────────────────────────────────────────────────
// The agent asks a question and attaches its recommendations; the user answers with a
// tap. For a single single-choice question the tap sends the answer IMMEDIATELY — the interview
// rhythm lives on that. For multiple choice or several questions the button comes first.
struct AskCardView: View {
    let ask: AskCardState
    let submit: ([AskAnswer]) -> Void

    @State private var picked: [[String]]
    @State private var free: [String]
    @State private var writing: [Bool]
    @State private var sent = false

    init(ask: AskCardState, submit: @escaping ([AskAnswer]) -> Void) {
        self.ask = ask
        self.submit = submit
        // One field per question — a card's questions are fixed (they hang on its requestId).
        _picked = State(initialValue: ask.questions.map { _ in [] })
        _free = State(initialValue: ask.questions.map { _ in "" })
        _writing = State(initialValue: ask.questions.map { _ in false })
    }

    /// Page of the pager (index in `ask.questions`). Clamped on reading, never on writing:
    /// a card's questions are fixed, but an index from user data should be clamped anyway.
    @State private var index = 0

    private var done: Bool { ask.answers?.isEmpty == false }
    private var live: Bool { ask.answerable && !done && !sent }
    /// One question, single choice → the tap IS the answer.
    private var instant: Bool { ask.questions.count == 1 && ask.questions[0].multiSelect == false }
    /// In the live state several questions are asked ONE per page (as on the web); answered or
    /// skipped they all lie stacked — one reads there, nobody pages.
    private var pager: Bool { live && ask.questions.count > 1 }
    private var page: Int { min(max(index, 0), max(ask.questions.count - 1, 0)) }
    /// Questions without a choice and without free text — the hint next to "Send answer".
    private var open: Int {
        ask.questions.indices.filter { selection($0).isEmpty && trimmedFree($0).isEmpty }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            // Card shape of the timeline (Chat/StatusForm.swift): no accent, "answered"
            // muted instead of green.
            // The identifier sits ONLY on the title, not on the frame: `accessibilityIdentifier` on a
            // container overrides the identifiers of ALL children — the answer buttons would then
            // no longer be individually addressable (measured in the UI test).
            CardsHeader(symbol: "bubble.left.and.text.bubble.right", title: L("Question##ask"), identifier: "ask-card") {
                if done {
                    Label(L("answered"), systemImage: "checkmark")
                        .labelStyle(.titleAndIcon)
                } else if !ask.answerable {
                    Text(L("skipped"))
                }
                if pager {
                    Spacer(minLength: 0)
                    Text(L("Question {n} of {m}", ["n": page + 1, "m": ask.questions.count]))
                        .accessibilityIdentifier("ask-page")
                }
            }

            if pager {
                // `id` on the question: otherwise the next page inherits the previous one's subtree (focus in the
                // free-text field, keyboard) — the answers themselves lie in the fields above anyway.
                questionBlock(index: page, question: ask.questions[page])
                    .id(ask.questions[page].id)
            } else {
                ForEach(Array(ask.questions.enumerated()), id: \.element.id) { index, question in
                    questionBlock(index: index, question: question)
                }
            }

            if pager {
                // "Next" is ALWAYS allowed — only sending checks completeness; whoever wants to skip a
                // question should first see all of them and then page back.
                HStack(spacing: 8) {
                    Button(L("Previous")) { index = page - 1 }
                        .buttonStyle(CardsButtonStyle())
                        .disabled(page == 0)
                        .accessibilityIdentifier("ask-prev")
                    Spacer(minLength: 0)
                    if page < ask.questions.count - 1 {
                        Button(L("Next")) { index = page + 1 }
                            .buttonStyle(CardsButtonStyle())
                            .accessibilityIdentifier("ask-next")
                    } else {
                        if open > 0 {
                            Text(open == 1 ? L("1 question still open") : L("{k} questions still open", ["k": open]))
                                .chatFont(.caption)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("ask-open")
                        }
                        Button(L("Send answer")) { send() }
                            .buttonStyle(CardsButtonStyle(main: true))
                            .disabled(!complete)
                            .accessibilityIdentifier("ask-send")
                    }
                }
            } else if live && !instant {
                Button(L("Send answer")) { send() }
                    .buttonStyle(CardsButtonStyle(main: true))
                    .disabled(!complete)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityIdentifier("ask-send")
            }
        }
        .cbCard()
    }

    /// A question with its options and free text. `index` is the position in `ask.questions` — in the pager
    /// the page, stacked the running number; the identifiers `ask-option-<index>-<pos>` thus stay the
    /// same in both cases.
    private func questionBlock(index: Int, question: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            // Without the header pill (`question.header`) before the question. The header still travels with the answer
            // (`AskAnswer.header`), it is just not shown.
            Text(question.question)
                .chatFont(.subheadline, weight: .medium)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(question.options.enumerated()), id: \.element.id) { position, option in
                optionRow(question: question, option: option, index: index, position: position)
            }
            freeAnswer(index: index)
        }
    }

    private func optionRow(question: AskQuestion, option: AskOption, index: Int, position: Int) -> some View {
        let chosen = selection(index).contains(option.label)
        return Button {
            tap(question: question, option: option, index: index)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: symbol(multi: question.multiSelect, on: chosen))
                    .foregroundStyle(chosen ? CbColor.text : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .chatFont(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    if !option.description.isEmpty {
                        Text(option.description)
                            .chatFont(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(9)
            .background(chosen ? Color.primary.opacity(0.08) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 11))
            .overlay {
                RoundedRectangle(cornerRadius: 11)
                    .stroke(chosen ? Color.primary.opacity(0.35) : Color.secondary.opacity(0.18))
            }
        }
        .buttonStyle(.plain)
        .disabled(!live)
        .foregroundStyle(.primary)
        .accessibilityIdentifier("ask-option-\(index)-\(position)")
    }

    @ViewBuilder
    private func freeAnswer(index: Int) -> some View {
        if done || !ask.answerable {
            let text = ask.answers?.indices.contains(index) == true ? ask.answers![index].text : ""
            if !text.isEmpty {
                Label(text, systemImage: "pencil")
                    .chatFont(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if writing.indices.contains(index), writing[index] {
            HStack(spacing: 7) {
                TextField(L("Own answer …"), text: Binding(
                    get: { free.indices.contains(index) ? free[index] : "" },
                    set: { value in if free.indices.contains(index) { free[index] = value } }
                ))
                .textFieldStyle(.roundedBorder)
                .submitLabel(instant ? .send : .done)
                .onSubmit { if instant { sendFree(index) } }
                if instant {
                    Button(L("Send")) { sendFree(index) }
                        .buttonStyle(CardsButtonStyle(main: true))
                        .disabled(trimmedFree(index).isEmpty)
                }
            }
        } else {
            Button {
                if writing.indices.contains(index) { writing[index] = true }
            } label: {
                Label(L("Own answer"), systemImage: "pencil")
                    .chatFont(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(!live)
        }
    }

    private func symbol(multi: Bool, on: Bool) -> String {
        if multi { return on ? "checkmark.square.fill" : "square" }
        return on ? "largecircle.fill.circle" : "circle"
    }

    private func selection(_ index: Int) -> [String] {
        if done, let answers = ask.answers, answers.indices.contains(index) { return answers[index].selected }
        return picked.indices.contains(index) ? picked[index] : []
    }

    private func trimmedFree(_ index: Int) -> String {
        (free.indices.contains(index) ? free[index] : "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func tap(question: AskQuestion, option: AskOption, index: Int) {
        guard live else { return }
        if instant {
            sent = true
            submit([AskAnswer(header: question.header, question: question.question, selected: [option.label], text: trimmedFree(index))])
            return
        }
        guard picked.indices.contains(index) else { return }
        if question.multiSelect {
            if let at = picked[index].firstIndex(of: option.label) { picked[index].remove(at: at) }
            else { picked[index].append(option.label) }
        } else {
            picked[index] = picked[index] == [option.label] ? [] : [option.label]
        }
    }

    private func sendFree(_ index: Int) {
        guard live, instant, !trimmedFree(index).isEmpty else { return }
        sent = true
        submit(build())
    }

    /// The "Send answer" button: ALL answers in one call (wire format unchanged). NO
    /// `sent` here: `markAskAnswered` sets `answers` synchronously, the card is thus `done`; if
    /// the POST fails, the model takes that back (`answers = nil`, `answerable = true`) and the card is
    /// usable again, the choice stays in @State. A `sent` would survive the error and leave the
    /// card grey and without a button.
    private func send() {
        guard live, complete else { return }
        submit(build())
    }

    private var complete: Bool {
        ask.questions.indices.allSatisfy { !selection($0).isEmpty || !trimmedFree($0).isEmpty }
    }

    private func build() -> [AskAnswer] {
        ask.questions.enumerated().map { index, question in
            AskAnswer(
                header: question.header,
                question: question.question,
                selected: picked.indices.contains(index) ? picked[index] : [],
                text: trimmedFree(index)
            )
        }
    }
}

// ── Capture card (shown at the end of the turn) ───────────────────────────────
// An agent of the chat took a screenshot or a screen video of its chat browser; the server
// shows them at the end of the turn by itself. Above the cap per
// turn the card is collapsed (`collapsed`, as on the web in CaptureCard.tsx) — only the header, a tap opens it.
// AVPlayer plays videos straight from the capture URL (the server serves Range; the session cookies come
// from HTTPCookieStorage.shared — see APIClient).
struct CaptureCardView: View {
    let capture: CaptureState
    var loadFile: ((String, String) async throws -> Data)? = nil
    var fileURL: ((String, String) -> URL?)? = nil
    var playVideo: ((URL) -> Void)? = nil
    @State private var poster: UIImage?
    /// Locally downloaded video — ready to play as soon as set (play button turns strong).
    @State private var localVideoURL: URL?
    /// Concrete load/playback error — visible on the card instead of a silent symbol.
    @State private var loadError: String?
    @State private var localViewer: ViewerImage?
    @State private var localVideoViewer: ViewerVideo?
    /// Collapsed (above the cap per turn): `nil` = as the server says, else the human's choice.
    @State private var expanded: Bool?
    @Environment(\.chatImageViewer) private var viewImage
    @Environment(\.chatVideoViewer) private var viewVideo

    private var isVideo: Bool { capture.kind == "recording" && capture.video != nil }
    private var isClosed: Bool { capture.collapsed && expanded != true }

    private var durationText: String {
        let secs = max(1, Int((capture.durationMs / 1000).rounded()))
        return secs >= 60 ? "\(secs / 60):" + String(format: "%02d", secs % 60) + " min" : "\(secs) s"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            CardsHeader(symbol: isVideo ? "video" : "camera.viewfinder", title: L(isVideo ? "Screen recording" : "Screenshot")) {
                if isVideo, capture.durationMs > 0 {
                    Text(durationText)
                }
                if !capture.title.isEmpty {
                    Text("· " + capture.title)
                        .lineLimit(1)
                }
                if capture.collapsed {
                    Spacer(minLength: 4)
                    Button(L(isClosed ? "Expand" : "Collapse")) { expanded = isClosed }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("capture-flap")
                }
            }
            if isClosed {
                EmptyView()
            } else if let loadError {
                Label(loadError, systemImage: "exclamationmark.triangle")
                    .chatFont(.caption)
                    .foregroundStyle(.secondary)
            } else if isVideo {
                // Poster + play button instead of an inline player: a tap opens the full-screen player
                // (outside the recycled cells — exactly ONE player instance, see ChatVideoViewerKey).
                ZStack {
                    if let poster {
                        Image(uiImage: poster)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
                    } else {
                        placeholder
                    }
                    if localVideoURL != nil {
                        Image(systemName: "play.circle.fill")
                            .font(.symbol(52))
                            .foregroundStyle(.white, .black.opacity(0.45))
                            .shadow(radius: 6)
                    } else {
                        ProgressView()
                            .tint(.white)
                            .padding(10)
                            .background(.black.opacity(0.35), in: Circle())
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard let url = localVideoURL else { return }
                    if let present = viewVideo ?? playVideo { present(url) } else { localVideoViewer = ViewerVideo(url: url) }
                }
            } else if let poster {
                Image(uiImage: poster)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let viewImage { viewImage(poster) } else { localViewer = ViewerImage(image: poster) }
                    }
            } else {
                placeholder
            }
            if !capture.caption.isEmpty && !isClosed {
                Text(capture.caption)
                    .chatFont(.subheadline)
            }
        }
        .cbCard()
        .task(id: capture.captureId) {
            if isVideo {
                // Poster first — the card has an image at once, the download runs behind it.
                if poster == nil, let data = try? await loadFile?(capture.captureId, "poster.jpg") {
                    poster = UIImage(data: data)
                }
                // Do NOT stream from the URL: AVPlayer's media daemon does not use our
                // authenticated URLSession. Download via the existing session
                // (captures are capped small) and play the local file full screen.
                guard localVideoURL == nil else { return }
                do {
                    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cbase-captures", isDirectory: true)
                    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    let file = dir.appendingPathComponent(capture.captureId + ".mp4")
                    // Self-healing: do not keep using a previously cached, unusable file
                    // (e.g. an error response saved as MP4).
                    if FileManager.default.fileExists(atPath: file.path), !Self.looksLikeMp4(file) {
                        try? FileManager.default.removeItem(at: file)
                    }
                    if !FileManager.default.fileExists(atPath: file.path) {
                        guard let loadFile else { loadError = L("No load function available (internal error)."); return }
                        let data = try await loadFile(capture.captureId, "video.mp4")
                        guard data.count > 16, data.subdata(in: 4..<8) == Data("ftyp".utf8) else {
                            let head = String(data: data.prefix(48), encoding: .utf8) ?? data.prefix(12).map { String(format: "%02x", $0) }.joined()
                            loadError = L("Server returned no MP4 ({count} bytes, starting with: {head})", ["count": data.count, "head": head])
                            return
                        }
                        try data.write(to: file, options: .atomic)
                    }
                    localVideoURL = file
                } catch {
                    loadError = error.localizedDescription
                }
            } else {
                guard poster == nil else { return }
                if let data = try? await loadFile?(capture.captureId, "poster.jpg"), let image = UIImage(data: data) {
                    poster = image
                } else {
                    loadError = L("Could not load capture")
                }
            }
        }
        .fullScreenCover(item: $localViewer) { item in
            ImageViewerScreen(image: item.image) { localViewer = nil }
        }
        .fullScreenCover(item: $localVideoViewer) { item in
            VideoViewerScreen(url: item.url) { localVideoViewer = nil }
        }
    }

    private static func looksLikeMp4(_ url: URL) -> Bool {
        guard let head = try? FileHandle(forReadingFrom: url).read(upToCount: 12), head.count >= 8 else { return false }
        return head.subdata(in: 4..<8) == Data("ftyp".utf8)
    }

    /// The capture knows its dimensions (`capture.w`/`h`) — the placeholder then already has the image's height
    /// (`scaledToFit` at full width), and the timeline does not grow when the poster arrives. Without dimensions it stays at
    /// 150 pt (a tall screenshot would otherwise push the timeline up by a multiple).
    @ViewBuilder
    private var placeholder: some View {
        let content = ZStack {
            RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.07))
            ProgressView()
        }
        if capture.w > 0, capture.h > 0 {
            content
                .aspectRatio(CGFloat(capture.w) / CGFloat(capture.h), contentMode: .fit)
                .frame(maxWidth: .infinity)
        } else {
            content
                .frame(height: 150)
        }
    }
}

/// Approval card. As on the desktop: deny WITH a reason (the text goes to the model)
/// and "Always allow" (writes a permanent rule in Claude Code's notation).
struct PermissionCard: View {
    let request: PermissionRequest
    /// (allow, reason on denial, rule to remember)
    let decide: (Bool, String, String) -> Void
    @State private var details = false
    @State private var reason = ""
    @State private var showReason = false
    @Environment(\.chatRowExpansionWillChange) private var rowWillExpand

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Card shape of the timeline (Chat/StatusForm.swift): no orange, the main button neutral.
            CardsHeader(symbol: "hand.raised", title: L("Approval required"))
            Text(request.toolName)
                .chatFont(.subheadline, weight: .medium)
            DisclosureGroup("Details", isExpanded: Binding(
                get: { details },
                set: { value in
                    rowWillExpand?()
                    // Without animation — see ThinkingView: height snap + offset pin
                    // belong in ONE transaction.
                    var snap = Transaction()
                    snap.disablesAnimations = true
                    withTransaction(snap) { details = value }
                }
            )) {
                Text(request.input.prettyPrinted)
                    .chatFont(.caption2, design: .monospaced)
                    .chatSelectable()
                    .padding(.top, 5)
            }
            if showReason {
                TextField(L("Why not? (sent to the model)"), text: $reason)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { decide(false, reason, "") }
            }
            HStack {
                Button("Deny", role: .destructive) {
                    if showReason { decide(false, reason, "") } else { showReason = true }
                }
                .buttonStyle(CardsButtonStyle())
                Spacer()
                if !request.suggestedRule.isEmpty {
                    Button(L("Always")) { decide(true, "", request.suggestedRule) }
                        .buttonStyle(CardsButtonStyle())
                }
                Button("Allow") { decide(true, "", "") }
                    .buttonStyle(CardsButtonStyle(main: true))
            }
            if showReason {
                Text(L("Tap Deny again to send the reason."))
                    .chatFont(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .cbCard()
    }
}
