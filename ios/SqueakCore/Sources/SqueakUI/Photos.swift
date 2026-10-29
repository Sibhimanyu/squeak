#if os(iOS)
import PhotosUI
import SqueakCore
import SqueakIcons
import SwiftUI
import UIKit

/// A photo picked to send: already shrunk to what the channel carries, with a small picture for the tray.
struct ChatPhoto: Identifiable, Equatable {
    let id: UUID
    let jpeg: Data
    let thumb: UIImage
}

enum PhotoPrep {
    /// The longest edge a photo is sent at: enough for an agent to read a screenshot or a whiteboard.
    static let longestEdge: CGFloat = 1600

    /// A picked image, shrunk and compressed to fit the channel (`PhotoAttachment.maxBytes`); nil when it is not
    /// an image or will not get that small.
    static func prepare(_ data: Data) -> ChatPhoto? {
        guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
        let scale = min(1, longestEdge / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        for quality in [0.75, 0.6, 0.45, 0.3] as [CGFloat] {
            if let jpeg = resized.jpegData(compressionQuality: quality), jpeg.count <= PhotoAttachment.maxBytes {
                return ChatPhoto(id: UUID(), jpeg: jpeg, thumb: thumbnail(of: resized))
            }
        }
        return nil
    }

    private static func thumbnail(of image: UIImage) -> UIImage {
        let side: CGFloat = 112
        let scale = side / min(image.size.width, image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
        }
    }
}

/// The paperclip beside a message field: the system photo picker (out of process, so no permission is asked).
struct AttachButton: View {
    @Binding var photos: [ChatPhoto]
    var height: CGFloat = 48
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        PhotosPicker(selection: $picked, maxSelectionCount: max(1, PhotoAttachment.maxPhotos - photos.count), matching: .images) {
            Lucide(.paperclip, size: 20, label: "Attach a photo", color: Theme.muted).frame(width: 44, height: height)
        }
        .disabled(photos.count >= PhotoAttachment.maxPhotos)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items where photos.count < PhotoAttachment.maxPhotos {
                    if let data = try? await item.loadTransferable(type: Data.self), let photo = PhotoPrep.prepare(data) {
                        photos.append(photo)
                    }
                }
                picked = []
            }
        }
    }
}

/// Pasting a copied image into the message field. A text view only offers Paste for text, so the two UITextView
/// methods are widened once: with only images on the pasteboard, Paste is offered and, instead of pasting,
/// posts the images. The field that has focus takes them (`pasteImages`); any other paste is untouched.
enum ImagePaste {
    static let notification = Notification.Name("squeak.pasteImages")
    nonisolated(unsafe) private static var installed = false

    private static var onlyImages: Bool { UIPasteboard.general.hasImages && !UIPasteboard.general.hasStrings }

    static func install() {
        guard !installed else { return }
        installed = true
        swap(#selector(UITextView.paste(_:)), #selector(UITextView.squeak_paste(_:)))
        swap(#selector(UITextView.canPerformAction(_:withSender:)), #selector(UITextView.squeak_canPerform(_:withSender:)))
    }

    private static func swap(_ a: Selector, _ b: Selector) {
        guard let x = class_getInstanceMethod(UITextView.self, a), let y = class_getInstanceMethod(UITextView.self, b) else { return }
        method_exchangeImplementations(x, y)
    }

    fileprivate static func offered(for action: Selector) -> Bool { action == #selector(UIResponder.paste(_:)) && onlyImages }

    fileprivate static func post() {
        let images = UIPasteboard.general.images ?? []
        NotificationCenter.default.post(name: notification, object: images.compactMap { $0.jpegData(compressionQuality: 1) })
    }
}

extension UITextView {
    @objc fileprivate func squeak_paste(_ sender: Any?) {
        if ImagePaste.offered(for: #selector(UIResponder.paste(_:))) { ImagePaste.post() } else { squeak_paste(sender) }
    }

    @objc fileprivate func squeak_canPerform(_ action: Selector, withSender sender: Any?) -> Bool {
        ImagePaste.offered(for: action) || squeak_canPerform(action, withSender: sender)
    }
}

extension View {
    /// Pasted images join `photos` while `focused` (the field that is being typed in), up to the limit.
    func pasteImages(into photos: Binding<[ChatPhoto]>, focused: Bool) -> some View {
        onAppear { ImagePaste.install() }
            .onReceive(NotificationCenter.default.publisher(for: ImagePaste.notification)) { note in
                guard focused, let all = note.object as? [Data] else { return }
                for data in all where photos.wrappedValue.count < PhotoAttachment.maxPhotos {
                    if let photo = PhotoPrep.prepare(data) { photos.wrappedValue.append(photo) }
                }
            }
    }
}

/// The photos waiting to go, as small pictures with a way to take each one off again.
struct PhotoTray: View {
    @Binding var photos: [ChatPhoto]
    /// While they upload they cannot be taken off.
    var locked = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(photos) { photo in
                    Image(uiImage: photo.thumb).resizable().scaledToFill()
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                        .opacity(locked ? 0.6 : 1)
                        .overlay(alignment: .topTrailing) {
                            if !locked {
                                Button { photos.removeAll { $0.id == photo.id } } label: {
                                    Lucide(.x, size: 12, color: Theme.ink).frame(width: 22, height: 22)
                                        .background(Theme.surfaceRaised, in: Circle()).overlay(Circle().stroke(Theme.lineStrong))
                                        .frame(width: 44, height: 44, alignment: .topTrailing).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .offset(x: 14, y: -14)
                                .accessibilityLabel("Remove photo")
                            }
                        }
                        .accessibilityLabel("Photo to send")
                }
            }
            .padding(.top, 14).padding(.trailing, 14)
        }
    }
}

/// What a message's photos look like in the chat: small labelled pills, since the picture itself stays on the Mac.
/// The photos this phone sent, kept by the path the Mac saved each at, so a sent message shows the picture and
/// opens it larger. Only what this phone sent is here: a photo that came from elsewhere stays a pill. Memory first,
/// then a file in Caches (not backed up, complete file protection), cleared on unpair.
enum SentPhotos {
    private static let memory = NSCache<NSString, UIImage>()
    private static var folder: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("SentPhotos", isDirectory: true)
    }

    private static func file(for ref: String) -> URL? {
        let name = Data(ref.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").prefix(120)
        return folder?.appendingPathComponent("\(name).jpg")
    }

    static func save(_ jpeg: Data, for ref: String) {
        if let image = UIImage(data: jpeg) { memory.setObject(image, forKey: ref as NSString) }
        guard let folder, let url = file(for: ref) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? jpeg.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func image(for ref: String) -> UIImage? {
        if let hit = memory.object(forKey: ref as NSString) { return hit }
        guard let url = file(for: ref), let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: ref as NSString)
        return image
    }

    static func clear() {
        memory.removeAllObjects()
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }
}

/// A sent message's photos: the picture itself where this phone has it (tap for a larger one), else the pill.
struct SentPhotoStrip: View {
    let refs: [String]
    @State private var opened: UIImage?

    var body: some View {
        let known = refs.compactMap { ref in SentPhotos.image(for: ref).map { (ref, $0) } }
        VStack(alignment: .trailing, spacing: 6) {
            if !known.isEmpty {
                HStack(spacing: 6) {
                    ForEach(known, id: \.0) { _, image in
                        Button { opened = image } label: {
                            Image(uiImage: image).resizable().scaledToFill()
                                .frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Photo you sent. Open it larger")
                    }
                }
            }
            if known.count < refs.count { PhotoPills(count: refs.count - known.count) }
        }
        .fullScreenCover(item: Binding(get: { opened.map(OpenedPhoto.init) }, set: { if $0 == nil { opened = nil } })) { photo in
            PhotoViewer(image: photo.image)
        }
    }
}

private struct OpenedPhoto: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// One photo, full screen: pinch to zoom, share or save from the share sheet, close at the top.
private struct PhotoViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image).resizable().scaledToFit()
                .scaleEffect(scale)
                .gesture(MagnifyGesture().onChanged { scale = max(1, base * $0.magnification) }.onEnded { _ in base = scale })
                .onTapGesture(count: 2) { withAnimation { scale = 1; base = 1 } }
            HStack(spacing: 4) {
                ShareLink(item: Image(uiImage: image), preview: SharePreview("Photo", image: Image(uiImage: image))) {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 18)).foregroundStyle(Color.white)
                        .frame(width: 44, height: 44).accessibilityLabel("Share or save")
                }
                Button { dismiss() } label: { Lucide(.x, size: 18, label: "Close", color: Color.white).frame(width: 44, height: 44) }
            }
            .padding(8)
        }
    }
}

struct PhotoPills: View {
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Lucide(.paperclip, size: 13, color: Theme.muted)
            Text(count == 1 ? "Photo" : "\(count) photos").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.surface, in: Capsule())
        .overlay(Capsule().stroke(Theme.line))
        .accessibilityElement(children: .combine)
    }
}

enum AttachTarget {
    case session(PhoneSnapshot.Session)
    case workspace(String)
}

enum UploadResult {
    case saved([String])
    case failed(String)
}

#endif
