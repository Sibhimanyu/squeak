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
