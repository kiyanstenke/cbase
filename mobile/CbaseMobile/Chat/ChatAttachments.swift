import AVKit
import SwiftUI
import UIKit

/// Card for pasted text (see `PastedText`): text excerpt plus a "Pasted" badge —
/// the same look as in the web client. Sits in the composer (with a remove button, light
/// background) and in the user bubble of the timeline (`onDark` means "on the bubble":
/// light on light or dark on dark, everything is set in `CbColor.text`).
/// `width == nil` means: as wide as the column (timeline grid).
struct PastedTextCard: View {
    let preview: String
    let size: Int
    var width: CGFloat?
    var onDark = false
    var onRemove: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(preview.isEmpty ? L("Pasted text") : preview)
                .chatFont(.fixed(11))
                .lineLimit(4)
                .multilineTextAlignment(.leading)
                .foregroundStyle(onDark ? CbColor.text.opacity(0.62) : Color.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
            HStack(spacing: 5) {
                Text(L("Pasted"))
                    .chatFont(.fixed(9), weight: .semibold)
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .overlay {
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(onDark ? CbColor.text.opacity(0.3) : Color.secondary.opacity(0.45))
                    }
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .chatFont(.fixed(9))
                    .opacity(0.5)
                Spacer(minLength: 0)
                if let onRemove {
                    Button(action: onRemove) {
                        Image(systemName: "xmark.circle.fill")
                            .chatFont(.fixed(13))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Remove"))
                }
            }
        }
        .padding(9)
        .frame(width: width, alignment: .leading)
        .background(
            // Without `onDark` the card sits in the composer island — translucent on glass (`CbGlass.inside`).
            onDark ? CbColor.text.opacity(0.09) : CbGlass.inside,
            in: RoundedRectangle(cornerRadius: 12)
        )
        .accessibilityIdentifier("pasted-text-card")
    }
}

/// In the timeline the pasted text is only a file on the server — the excerpt is fetched
/// once and remembered, because the timeline cells are recycled.
@MainActor
enum PastedPreviewCache {
    static var byFile: [String: String] = [:]
}

private struct RemotePastedTextCard: View {
    let attachment: Attachment
    let load: (Attachment) async throws -> Data
    @State private var preview = ""

    var body: some View {
        PastedTextCard(preview: preview, size: attachment.size, onDark: true)
            .task {
                if let cached = PastedPreviewCache.byFile[attachment.file] { preview = cached; return }
                guard attachment.size <= PastedText.fetchMax,
                      let data = try? await load(attachment) else { return }
                let text = PastedText.preview(String(decoding: data, as: UTF8.self))
                PastedPreviewCache.byFile[attachment.file] = text
                preview = text
            }
    }
}

// ── Full-screen image viewer with pinch zoom ──────────────────────────────────
// UIScrollView instead of MagnificationGesture: pinch under the finger, double tap and panning
// then behave exactly as in Photos — SwiftUI gestures do not reach that cleanly.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear
        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(imageView)
        context.coordinator.imageView = imageView
        // Image area = viewport (aspectFit leaves margins); zooming scales the whole area,
        // the scroll view handles panning and bounds on its own.
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            imageView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
        ])
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTapped(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1.01 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

/// `fullScreenCover(item:)` needs Identifiable — UIImage is not.
struct ViewerImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

struct ViewerVideo: Identifiable {
    let id = UUID()
    let url: URL
}

/// Full-screen player for captures. The AVPlayer is only created WHEN presenting — so exactly
/// one player instance with exactly one layer exists (see ChatVideoViewerKey).
struct VideoViewerScreen: View {
    let url: URL
    let onClose: () -> Void
    @State private var player: AVPlayer?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            }
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.symbol(30))
                    .foregroundStyle(.white.opacity(0.85), .black.opacity(0.4))
            }
            .padding(14)
            .accessibilityLabel(L("Close"))
        }
        .onAppear {
            let next = AVPlayer(url: url)
            player = next
            next.play()
        }
        .onDisappear { player?.pause() }
    }
}

struct ImageViewerScreen: View {
    let image: UIImage
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ZoomableImage(image: image)
                .ignoresSafeArea()
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.symbol(30))
                    .foregroundStyle(.white.opacity(0.85), .black.opacity(0.4))
            }
            .padding(14)
            .accessibilityLabel(L("Close"))
        }
    }
}

struct AttachmentGrid: View {
    let attachments: [Attachment]
    let load: (Attachment) async throws -> Data

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 7)], spacing: 7) {
            ForEach(attachments) { attachment in
                if attachment.mime.hasPrefix("image/") {
                    RemoteAttachmentImage(attachment: attachment, load: load)
                } else if attachment.isPastedText {
                    RemotePastedTextCard(attachment: attachment, load: load)
                } else {
                    HStack(spacing: 7) {
                        Image(systemName: "doc")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name)
                                .lineLimit(2)
                            Text(byteCount(attachment.size))
                                .chatFont(.caption2)
                                .opacity(0.65)
                        }
                    }
                    .chatFont(.caption)
                    .padding(8)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                    // Only in the user bubble (`CbColor.elevated`) — a trace of its text as a surface.
                    .background(CbColor.text.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
                }
            }
        }
    }

    private func byteCount(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private struct RemoteAttachmentImage: View {
    let attachment: Attachment
    let load: (Attachment) async throws -> Data
    @State private var image: UIImage?
    @State private var localViewer: ViewerImage?
    @Environment(\.chatImageViewer) private var viewImage

    var body: some View {
        tile
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onTapGesture {
            guard let image else { return }
            if let viewImage { viewImage(image) } else { localViewer = ViewerImage(image: image) }
        }
        .accessibilityLabel(attachment.name)
        .task {
            guard image == nil,
                  let data = try? await load(attachment) else { return }
            image = UIImage(data: data)
        }
        .fullScreenCover(item: $localViewer) { item in
            ImageViewerScreen(image: item.image) { localViewer = nil }
        }
    }

    /// If the attachment knows its dimensions (`w`/`h`), the tile's height is fixed BEFORE loading — placeholder and image are
    /// equally tall, and the timeline does not grow when the image arrives (otherwise the chat is not scrolled fully down but
    /// ends about at the image). Without dimensions it keeps the old behaviour (at least 90 pt, then the image's height).
    @ViewBuilder
    private var tile: some View {
        if let ratio = attachment.aspectRatio {
            Color.clear
                .aspectRatio(CGFloat(ratio), contentMode: .fit)
                .frame(maxWidth: .infinity)
                .overlay { content }
                .clipped()
        } else {
            content
                .frame(minHeight: 90)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                CbColor.text.opacity(0.08)
                ProgressView()
                    .tint(CbColor.text)
            }
        }
    }
}
