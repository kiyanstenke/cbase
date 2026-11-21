import AVKit
import SwiftUI
import UIKit

// ── Message actions (copy) ──────────────────────────────────────────────────
//
// No `contextMenu` may hang on a message in the MIRRORED history: the system menu preview
// inherits the role view's mirroring (the chat shows up rotated by 180° and shrunk to a few
// points on long-press). The mirrored history therefore registers an action through the
// environment and presents it OUTSIDE the role view (chat view: selection dialog).
// Without a registered action the usual system menu stays.
struct ChatMessageActionKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    var chatMessageAction: ((String) -> Void)? {
        get { self[ChatMessageActionKey.self] }
        set { self[ChatMessageActionKey.self] = newValue }
    }
}

// Tapping an image opens a full-screen pinch-zoom viewer. Same construction as chatMessageAction:
// the UIHostingConfiguration cells of the inverted list neither inherit the environment nor can
// they present reliably — the action is reported and the chat root shows the viewer OUTSIDE the
// role view. Without a registered action (plain SwiftUI hierarchy) the view presents locally.
struct ChatImageViewerKey: EnvironmentKey {
    static let defaultValue: ((UIImage) -> Void)? = nil
}

extension EnvironmentValues {
    var chatImageViewer: ((UIImage) -> Void)? {
        get { self[ChatImageViewerKey.self] }
        set { self[ChatImageViewerKey.self] = newValue }
    }
}

// Tapping a video opens a full-screen player presented by the chat root. NO inline player in
// the cells: the inverted list reconfigures cells on every stream update, so the same AVPlayer
// briefly hangs on TWO layers and AVKit then shows the prohibition symbol permanently on the
// visible instance.
struct ChatVideoViewerKey: EnvironmentKey {
    static let defaultValue: ((URL) -> Void)? = nil
}

extension EnvironmentValues {
    var chatVideoViewer: ((URL) -> Void)? {
        get { self[ChatVideoViewerKey.self] }
        set { self[ChatVideoViewerKey.self] = newValue }
    }
}

// Load a tool result truncated in the window without truncation (`resolveTruncation`): the
// sheet's tool page reports the row id, the model inserts the full result at the block and the
// sheet follows the live state. Without a registered action (sheet without model) there is no button.
struct ChatRowFullKey: EnvironmentKey {
    static let defaultValue: ((Int) async -> Void)? = nil
}

extension EnvironmentValues {
    var chatRowFull: ((Int) async -> Void)? {
        get { self[ChatRowFullKey.self] }
        set { self[ChatRowFullKey.self] = newValue }
    }
}

private struct MessageActionsModifier: ViewModifier {
    let text: String
    @Environment(\.chatMessageAction) private var action

    func body(content: Content) -> some View {
        if text.isEmpty {
            content
        } else if let action {
            content
                .onLongPressGesture(minimumDuration: 0.58) {
                    // If the text marker already took the touch (long press ON the text, see
                    // `MarkerTextUIView`), it owns it — the whole-message dialog stays away.
                    if MarkerTextUIView.markerSessionActive { return }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    action(text)
                }
                .accessibilityAction(named: L("Copy message")) { action(text) }
        } else {
            content.contextMenu {
                Button(L("Copy message"), systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = text
                }
            }
        }
    }
}

extension View {
    func chatMessageActions(text: String) -> some View {
        modifier(MessageActionsModifier(text: text))
    }

    /// Selectable text in the chat — except in the mirrored history (see below).
    func chatSelectable() -> some View {
        ChatSelectableText(content: self)
    }
}

// Switch text selection off in the MIRRORED history. Two reasons: it steals the long press
// (the copy menu never appeared), and its loupe and handles are drawn flipped in the mirrored
// coordinate space. Copying works there via long press.
//
// A custom view is needed because with `.textSelection` the INNERMOST declaration wins — an
// outer `.disabled` would not beat an inner `.enabled`.
struct ChatTextSelectionKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var chatTextSelectable: Bool {
        get { self[ChatTextSelectionKey.self] }
        set { self[ChatTextSelectionKey.self] = newValue }
    }
}

// ── Expanding in the inverted history ───────────────────────────────────────
//
// In the inverted list the cell's BOTTOM edge is the layout fixpoint: a growing row grows
// visually UPWARD — an expanded tool call pushed the whole history away instead of unfolding
// its output downward. Whoever changes its own height by tap therefore announces it BEFORE
// toggling through this environment value; the history then anchors the row's visual TOP edge
// over the following layout passes (see `pinExpandingRow` in the timeline coordinator) and
// newer content moves down. Outside the history the value stays nil — the call is a no-op.
struct ChatRowExpansionKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var chatRowExpansionWillChange: (() -> Void)? {
        get { self[ChatRowExpansionKey.self] }
        set { self[ChatRowExpansionKey.self] = newValue }
    }
}

private struct ChatSelectableText<Content: View>: View {
    @Environment(\.chatTextSelectable) private var enabled
    let content: Content

    var body: some View {
        if enabled {
            content.textSelection(.enabled)
        } else {
            content.textSelection(.disabled)
        }
    }
}
