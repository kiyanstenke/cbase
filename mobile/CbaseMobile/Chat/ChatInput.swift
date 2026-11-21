import SwiftUI
import UIKit

/// The invisible upward extension of the keyboard. As `inputAccessoryView` of the
/// input field it belongs to the KEYBOARD region — and UIKit's interactive dismissal
/// attaches the keyboard to the finger as soon as it touches the TOP EDGE of this region.
/// Without it the attach line would lie at the real keyboard edge, one island height too
/// low ("only goes down once the thumb touches the keyboard"). The height covers
/// island + drag zone generously; `isUserInteractionEnabled = false` lets all
/// touches fall through to the app (island buttons, drag zone, history).
///
/// The island itself sits on the REAL keyboard edge — so on the BOTTOM edge
/// of this extension. `syncKeyboardOverlap` measures it directly (screen
/// coordinate space) as long as the extension is in the window.
final class KeyboardGripAccessory: UIView {
    static let height: CGFloat = 100
    static let shared = KeyboardGripAccessory(
        frame: CGRect(x: 0, y: 0, width: 0, height: KeyboardGripAccessory.height)
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        autoresizingMask = [.flexibleWidth]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// The input field as a UITextView: SwiftUI's `TextField` cannot carry an
/// `inputAccessoryView` — and only through it (see `KeyboardGripAccessory`)
/// does the interactive dismissal start at the island's top edge instead of
/// the keyboard edge. Grows with the text up to seven lines, after that the
/// content scrolls internally. Padding, background and border sit outside as
/// SwiftUI modifiers; the field itself hugs its content (`textContainerInset
/// = .zero`).
/// Input field that intercepts large pastes: `onLargePaste` receives the text and reports
/// back whether it took it — then it does NOT go into the field (see `PastedText`).
final class PasteInterceptingTextView: UITextView {
    var onLargePaste: ((String) -> Bool)?
    /// Where VoiceOver and XCUITest "tap" the field: in the CENTER. With the island's glass the point UIKit
    /// reports for the empty field lay at the marker — left on the top edge, 10⁻¹³ pt ABOVE the field (735.33…326
    /// against 735.33…337). The tap hit the island behind it, the field got no focus, and every keyboard test failed;
    /// a finger in the middle still hit the field.
    override var accessibilityActivationPoint: CGPoint {
        get {
            let frame = UIAccessibility.convertToScreenCoordinates(bounds, in: self)
            return CGPoint(x: frame.midX, y: frame.midY)
        }
        set { super.accessibilityActivationPoint = newValue }
    }

    /// Images from the pasteboard: receives the IMAGE entries and takes them over as attachments (see
    /// `ClipboardImages`). Without a taker the field keeps the old behavior (text only).
    var onImagePaste: (([NSItemProvider]) -> Void)?

    /// Offer "Paste" for an image too: a `UITextView` without `allowsEditingTextAttributes` says no to it on its
    /// own — the long-press menu would then show the item only when TEXT was on the pasteboard.
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onImagePaste != nil, ClipboardImages.carriesImage() { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        // Reading the pasteboard here triggers NO prompt banner: the paste
        // was triggered by the user himself (menu item "Paste" or ⌘V), and iOS
        // counts exactly that as consent.
        let deposit = UIPasteboard.general
        if let onImagePaste, ClipboardImages.carriesImage(deposit) {
            let entries = deposit.itemProviders
            let images = entries.filter(ClipboardImages.isImage)
            if !images.isEmpty {
                onImagePaste(images)
                // Text ALONGSIDE (further entries without an image) goes into the field as before — large as an attachment, otherwise at the marker.
                let texts = entries.filter { !ClipboardImages.isImage($0) }
                guard !texts.isEmpty else { return }
                Task { @MainActor [weak self] in
                    var parts: [String] = []
                    for provider in texts {
                        if let text = await ClipboardImages.loadText(provider), !text.isEmpty { parts.append(text) }
                    }
                    guard let self, !parts.isEmpty else { return }
                    let text = parts.joined(separator: "\n")
                    if self.onLargePaste?(text) == true { return }
                    self.insertText(text)
                }
                return
            }
        }
        if let pasted = deposit.string, onLargePaste?(pasted) == true { return }
        super.paste(sender)
    }
}

struct ChatInputTextView: UIViewRepresentable {
    @Binding var text: String
    /// Identifier for the test bench — it comes from outside.
    var identifier: String = "chat-composer"
    /// Text in the empty field. It changes during a run (queued/direct), so it is updated on
    /// EVERY update — not only on building.
    var placeholder: String = L("Message to cbase")
    /// Asked on every paste; `true` means "taken over as attachment, do not insert".
    var onLargePaste: (String) -> Bool = { _ in false }
    /// Images from the pasteboard: the image entries of a "Paste" — `nil` means "accept no images",
    /// then "Paste" stays off for an image.
    var onImagePaste: (([NSItemProvider]) -> Void)? = nil
    /// The chat's typeface (Settings → Appearance, Kit/ChatTypeface.swift): the field writes in
    /// the same type in which the message then stands in the history.
    @ObservedObject private var typeface = ChatTypefaceStore.shared

    /// The font of the field and its placeholder: body on Apple's curve, `adjustsFontForContentSizeCategory`
    /// follows the text size. "Default" is the system font.
    static func inputFont(_ kind: ChatTypeface) -> UIFont {
        guard kind != .standard else { return .preferredFont(forTextStyle: .body) }
        return UIFontMetrics(forTextStyle: .body).scaledFont(for: kind.uiFont(size: ChatFontStyle.body.base, weight: .regular))
    }

    /// The currently focused chat input field. Only its keyboard carries the
    /// `KeyboardGripAccessory` — the edge translation asks here whether the
    /// frame reported in `keyboardWillChangeFrame` includes the extension.
    /// Deliberately the first-responder status instead of `accessory.window`: the latter hangs
    /// on the device on the race timing of the window mounting.
    @MainActor static weak var activeInput: UITextView?

    /// The most recently built input field (there is exactly one per open chat) — so that
    /// "Reply" at the text marker can open the keyboard directly.
    @MainActor private static weak var current: UITextView?

    @MainActor static func focusCurrent() {
        current?.becomeFirstResponder()
    }

    private static let maxLines = 7

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeUIView(context: Context) -> PasteInterceptingTextView {
        let view = PasteInterceptingTextView()
        view.onLargePaste = onLargePaste
        view.onImagePaste = onImagePaste
        view.font = Self.inputFont(typeface.choice)
        view.adjustsFontForContentSizeCategory = true
        context.coordinator.typeface = typeface.choice
        // Font and placeholder in the palette (`Kit/CbColor.swift`) — the text stands directly on the island.
        view.textColor = CbColor.ui(.text)
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.showsHorizontalScrollIndicator = false
        view.delegate = context.coordinator
        view.inputAccessoryView = KeyboardGripAccessory.shared
        view.accessibilityIdentifier = identifier
        Self.current = view

        let placeholder = context.coordinator.placeholder
        placeholder.text = self.placeholder
        placeholder.font = Self.inputFont(typeface.choice)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = CbColor.ui(.textMuted)
        placeholder.isUserInteractionEnabled = false
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            placeholder.topAnchor.constraint(equalTo: view.topAnchor),
        ])
        return view
    }

    func updateUIView(_ uiView: PasteInterceptingTextView, context: Context) {
        context.coordinator.text = $text
        // The closure holds the state of the current render pass — otherwise the next
        // insertion would append to an outdated model.
        uiView.onLargePaste = onLargePaste
        uiView.onImagePaste = onImagePaste
        // Write only on a real difference — otherwise the insertion point jumps and
        // running autocorrect/dictation sessions break off.
        if uiView.text != text { uiView.text = text }
        if uiView.accessibilityIdentifier != identifier { uiView.accessibilityIdentifier = identifier }
        if context.coordinator.typeface != typeface.choice {
            context.coordinator.typeface = typeface.choice
            uiView.font = Self.inputFont(typeface.choice)
            context.coordinator.placeholder.font = uiView.font
            uiView.invalidateIntrinsicContentSize()
        }
        if context.coordinator.placeholder.text != placeholder {
            context.coordinator.placeholder.text = placeholder
        }
        context.coordinator.placeholder.isHidden = !text.isEmpty
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: PasteInterceptingTextView, context: Context
    ) -> CGSize? {
        // Answer the IDEAL question (`proposal.width == nil`) at the REAL width of the field, not at a fixed 200 pt:
        // the composer host (`sizingOptions = .intrinsicContentSize`) measures its height at the real width, but
        // renews it ONLY when the ideal size changes — and that broke at 200 pt at different characters than the
        // field. At a real wrap the host stayed one line too low, the content overflowed and was centered: the island
        // sagged by half a line (9.3 pt — exactly the gap) onto the keyboard until the next ideal wrap healed it. With the
        // real width the ideal size wraps at the same characters as the field. Before the first layout (width 0)
        // it stays at 200.
        let width = proposal.width ?? (uiView.bounds.width > 0 ? uiView.bounds.width : 200)
        let font = uiView.font ?? .preferredFont(forTextStyle: .body)
        let fit = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let height = min(
            max(fit.height, ceil(font.lineHeight)),
            ceil(font.lineHeight * CGFloat(Self.maxLines))
        )
        return CGSize(width: width, height: height)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        let placeholder = UILabel()
        /// The typeface in which the field was last set — set anew only on a change.
        var typeface: ChatTypeface = .standard

        init(text: Binding<String>) { self.text = text }

        func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            ChatInputTextView.activeInput = textView
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if ChatInputTextView.activeInput === textView {
                ChatInputTextView.activeInput = nil
            }
        }
    }
}

/// The narrow drag zone at the TOP EDGE of the composer: here the thumb pulls the
/// keyboard down without scrolling the history — INTERACTIVELY: island and keyboard
/// hang on the finger (UIKit's `keyboardDismissMode = .interactive`; thanks to the
/// `KeyboardGripAccessory` the keyboard region starts at the island's top edge, so
/// the attach engages almost immediately). The zone replaces the island's top
/// padding, so costs hardly any space, and lies as the TOPMOST element — so it takes
/// no buttons from a strip below it (queue, attachments).
///
/// Technically it is a tiny, empty scroll view: interactive dismissal in UIKit is driven
/// exclusively by a scroll view (it hangs on its pan gesture) — one without
/// scrollable content therefore moves nothing but the keyboard. `alwaysBounceVertical`
/// is mandatory: without it the pan gesture does not begin at all on empty content, and then
/// there would be no dismissal either.
struct KeyboardDismissGrip: UIViewRepresentable {
    /// All living zone scroll views. The stage asks when translating the
    /// keyboard edge whether a finger currently lies on one — only then is the
    /// directly measured accessory position trustworthy (see
    /// `syncKeyboardOverlap`). Deliberately a query of the momentary state
    /// (`isTracking`) instead of maintained markers: state transitions can be
    /// missed, the momentary state cannot.
    @MainActor static let liveGrips = NSHashTable<UIScrollView>.weakObjects()

    @MainActor static var anyGripTracking: Bool {
        // Only zones that are IN THE WINDOW: a scroll view taken out of the hierarchy in
        // the middle of the gesture never gets a `touchesEnded` and would
        // otherwise report "finger lies on it" forever — the frozen
        // accessory position would then permanently take precedence over the announced edge.
        liveGrips.allObjects.contains { $0.window != nil && $0.isTracking }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.backgroundColor = .clear
        // `.interactiveWithAccessory`, not `.interactive`: otherwise UIKit detaches the
        // `KeyboardGripAccessory` at gesture start and the island sags behind the keyboard
        // by its height (see the comment on the collection).
        scroll.keyboardDismissMode = .interactiveWithAccessory
        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.delegate = context.coordinator
        scroll.accessibilityIdentifier = "composer-keyboard-grip"
        Self.liveGrips.add(scroll)
        return scroll
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {}

    /// Release handling of the zone: both signals to the stage, which makes ONE
    /// decision of them (see `settleKeyboardAfterRelease`) — how far the keyboard
    /// followed the finger, and how far the FINGER traveled. The second is the
    /// safety net for the case that the interactive attach exceptionally does not
    /// engage; the zone must not send the keyboard away itself for that, since a
    /// second `endEditing` could contradict the stage's pull-back.
    final class Coordinator: NSObject, UIScrollViewDelegate {
        func scrollViewDidEndDragging(
            _ scrollView: UIScrollView, willDecelerate decelerate: Bool
        ) {
            var view: UIView? = scrollView.superview
            while view != nil, !(view is ChatStageView) { view = view?.superview }
            (view as? ChatStageView)?.settleKeyboardAfterRelease(
                fingerTravel: scrollView.panGestureRecognizer.translation(in: scrollView).y
            )
        }
    }
}

// NO keyboard measurement: a DisplayLink once read the displayed keyboard edge
// frame by frame (scout on the layout guide + UIKit probe per announcement)
// and wrote it as SwiftUI state — the composer was offset by the value, the
// list got it as inset. Two construction faults:
//  1. LATENCY. Measure → write state → evaluate body → render offset takes
//     effect at the earliest in the NEXT frame — the input field visibly trailed the keyboard,
//     in every kind of movement.
//  2. RACES. Every read time competed with UIKit's intermediate states. Three
//     different holes of the same pattern, each measured and patched individually
//     (stale probe presentation, deadline instead of a hanging animation, hold marker dropped
//     while the finger rested), and the flash came back anyway.
// Now the composer hangs by constraint on the stage's `keyboardLayoutGuide`
// (`ChatStageController`): UIKit moves it in the same transaction as the
// keyboard — nothing is measured, nothing trails, and model intermediate states
// that are never committed can no longer reach the screen.
