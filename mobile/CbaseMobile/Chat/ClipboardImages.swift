import UIKit
import UniformTypeIdentifiers

/// Images from the clipboard as attachments. The field
/// (`PasteInterceptingTextView`) used to offer "Paste" only for TEXT: a `UITextView` without
/// `allowsEditingTextAttributes` does not accept images on its own, and `paste(_:)` read only `UIPasteboard.general.string`.
///
/// This holds only WHAT from the clipboard becomes an attachment. Uploading goes through the same path as from the
/// photos picker (`ChatViewModel.uploadImage`: name, extension, upload, chip with progress).
enum ClipboardImages {
    /// Does the clipboard carry an image? Only the TYPES are asked (`hasImages`, `contains(pasteboardTypes:)`) —
    /// that triggers no paste-prompt banner and may therefore stand in `canPerformAction`, which UIKit asks on every build of the
    /// edit menu. `hasImages` alone knows only the classic image list; HEIC & co. are caught by the conformance question.
    static func carriesImage(_ deposit: UIPasteboard = .general) -> Bool {
        deposit.hasImages || deposit.contains(pasteboardTypes: [UTType.image.identifier])
    }

    /// An item is an image if ONE of its types is one — then the whole item counts as an image. An image copied from Safari
    /// carries its address as text; only the image is pasted (as in Messages).
    static func isImage(_ provider: NSItemProvider) -> Bool {
        provider.registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: .image) == true }
    }

    /// What the server knows as an image (`runtime/image-dimensions.js`, `runtime/http.js:ATTACH_MIME`: png, jpeg, gif, webp) — and
    /// thus the model. A HEIC was stored by the server as `application/octet-stream`.
    static let webFormate: [UTType] = [.png, .jpeg, .gif, .webP]

    /// Which type of an item is uploaded: the first (in the item's order) that the server knows as an image;
    /// else the first image type at all (HEIC, TIFF), then with `transform` — it goes out as JPEG.
    static func selectType(_ identifiers: [String]) -> (type: UTType, transform: Bool)? {
        let types = identifiers.compactMap { UTType($0) }
        if let web = types.first(where: { type in webFormate.contains { type.conforms(to: $0) } }) { return (web, false) }
        if let image = types.first(where: { $0.conforms(to: .image) }) { return (image, true) }
        return nil
    }

    /// Bytes for the upload from the photos picker: a format the server knows as an image stays raw; everything else —
    /// above all HEIC, the format of the Photos app — goes out as JPEG. Otherwise the picker would upload the first type raw, and a HEIC
    /// would sit on the server as `application/octet-stream`: the model would see no image. Converted off the main actor.
    static func webSuitable(data: Data, type: UTType?) async -> (data: Data, type: UTType?) {
        if let type, webFormate.contains(where: { type.conforms(to: $0) }) { return (data, type) }
        let jpeg = await Task.detached(priority: .userInitiated) { UIImage(data: data)?.jpegData(compressionQuality: 0.9) }.value
        guard let jpeg else { return (data, type) }
        return (jpeg, .jpeg)
    }

    /// The image of an item: bytes and type for the upload, or nil (nothing readable). Runs off the
    /// main actor — converting a large HEIC takes noticeable time.
    static func load(_ provider: NSItemProvider) async -> (data: Data, type: UTType)? {
        guard let choice = selectType(provider.registeredTypeIdentifiers) else { return nil }
        let data: Data? = await withCheckedContinuation { finished in
            _ = provider.loadDataRepresentation(forTypeIdentifier: choice.type.identifier) { data, _ in
                finished.resume(returning: data)
            }
        }
        guard let data, !data.isEmpty else { return nil }
        guard choice.transform else { return (data, choice.type) }
        // Not decodable: out raw like from the picker — better an attachment the server does not know as an image than none.
        guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) else { return (data, choice.type) }
        return (jpeg, .jpeg)
    }

    /// The text of an item WITHOUT an image (several items on the clipboard) — it goes into the field as before.
    static func loadText(_ provider: NSItemProvider) async -> String? {
        guard provider.canLoadObject(ofClass: NSString.self) else { return nil }
        return await withCheckedContinuation { finished in
            _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                finished.resume(returning: (object as? NSString).map { String($0) })
            }
        }
    }
}
