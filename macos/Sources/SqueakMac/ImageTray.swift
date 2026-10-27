import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI
import UniformTypeIdentifiers

/// Where an image came from: bytes on the pasteboard, or a file the person copied, dropped or picked.
enum ImageSource {
    case data(Data)
    case file(URL)
}

enum ImagePasteboard {
    /// The images on a pasteboard. A copied image file always counts; raw image bytes (a screenshot, a copy from
    /// a page) count only when there is no text beside them, so an ordinary text paste is never taken over.
    static func sources(_ pb: NSPasteboard, rawNeedsNoText: Bool) -> [ImageSource] {
        let files = (pb.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true, .urlReadingContentsConformToTypes: [UTType.image.identifier],
        ]) as? [URL]) ?? []
        if !files.isEmpty { return files.map(ImageSource.file) }
        if rawNeedsNoText, pb.availableType(from: [.string]) != nil { return [] }
        if let d = pb.data(forType: .png) ?? pb.data(forType: .tiff) { return [.data(d)] }
        return []
    }
}

/// Images waiting to go with the next message of one composer. Nothing is written to disk here: the files are
/// made only when the person presses Send, in the chat's own folder, and a thumbnail is dropped with the app.
@MainActor @Observable
final class ImageTray {
    struct Item: Identifiable {
        let id = UUID()
        let image: PreparedImage
        let thumb: NSImage
    }

    private(set) var items: [Item] = []
    private(set) var preparing = 0
    var error: String?

    var isFull: Bool { items.count + preparing >= ImageAttachments.maxImages }
    var hasImages: Bool { !items.isEmpty }

    func add(_ sources: [ImageSource]) {
        for source in sources {
            guard !isFull else { error = "Up to \(ImageAttachments.maxImages) images per message."; return }
            error = nil
            preparing += 1
            Task { [weak self] in
                let prepared = await Task.detached(priority: .userInitiated) { () -> PreparedImage? in
                    switch source {
                    case .data(let d): return ImageAttachments.prepare(d)
                    case .file(let url):
                        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), v.isRegularFile == true,
                              (v.fileSize ?? 0) <= ImageAttachments.maxSourceBytes, let d = try? Data(contentsOf: url)
                        else { return nil }
                        return ImageAttachments.prepare(d)
                    }
                }.value
                guard let self else { return }
                preparing -= 1
                if let prepared, let thumb = NSImage(data: prepared.data) {
                    items.append(Item(image: prepared, thumb: thumb))
                } else {
                    error = "Squeak can only attach images it can read (PNG, JPEG, HEIC, TIFF, GIF)."
                }
            }
        }
    }

    func remove(_ id: UUID) { items.removeAll { $0.id == id }; error = nil }
    func clear() { items = []; error = nil }

    /// The attach button: a system open panel for images.
    func pick() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "Choose images to attach"
        guard panel.runModal() == .OK else { return }
        add(panel.urls.map(ImageSource.file))
    }

    /// What to send for `text`: unchanged without images; otherwise the images are saved under `folder` and
    /// the text names them. Throws, with nothing sent and the images still here, when they cannot be saved.
    func outgoing(text: String, folder: String?) throws -> String {
        guard hasImages else { return text }
        guard let folder, !folder.isEmpty else { throw ImageAttachmentError.folderMissing }
        let refs = try ImageAttachments.save(items.map(\.image), into: folder)
        return ImageAttachments.compose(text, refs: refs)
    }

    /// Runs `outgoing` and shows a failure under the thumbnails; nil means "do not send".
    func prepareToSend(text: String, folder: String?) -> String? {
        do { return try outgoing(text: text, folder: folder) } catch {
            self.error = (error as? ImageAttachmentError)?.errorDescription ?? "Squeak couldn't save the image."
            return nil
        }
    }
}

/// Thumbnails above a composer's field, each with a remove button, and any problem in one line.
struct ImageStrip: View {
    let tray: ImageTray

    var body: some View {
        if !tray.items.isEmpty || tray.preparing > 0 || tray.error != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !tray.items.isEmpty || tray.preparing > 0 {
                    HStack(spacing: 8) {
                        ForEach(tray.items) { item in
                            Image(nsImage: item.thumb).resizable().scaledToFill()
                                .frame(width: 44, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
                                .overlay(alignment: .topTrailing) {
                                    Button { tray.remove(item.id) } label: {
                                        Lucide(.x, size: 10, color: Theme.ink)
                                            .frame(width: 16, height: 16)
                                            .background(Circle().fill(Theme.surfaceRaised))
                                            .overlay(Circle().strokeBorder(Theme.lineStrong))
                                    }
                                    .buttonStyle(.plain)
                                    .offset(x: 5, y: -5)
                                    .accessibilityLabel("Remove image")
                                }
                                .accessibilityElement(children: .contain)
                                .accessibilityLabel("Attached image")
                        }
                        if tray.preparing > 0 { ProgressView().controlSize(.small).frame(width: 44, height: 44) }
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 5).padding(.trailing, 5)
                }
                if let e = tray.error {
                    Text(e).font(.system(size: 12)).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The + beside a composer: opens a panel to choose images.
struct AttachButton: View {
    let tray: ImageTray
    var size: CGFloat = 28

    var body: some View {
        Button { tray.pick() } label: {
            Lucide(.plus, size: 16, color: tray.isFull ? Theme.subtle : Theme.muted)
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(tray.isFull)
        .accessibilityLabel("Attach images")
        .help("Attach images (you can also paste or drop them)")
    }
}

extension View {
    /// Image files dropped anywhere on a composer are attached (the field itself also takes drops).
    func imageDrop(_ tray: ImageTray) -> some View {
        dropDestination(for: URL.self) { urls, _ in
            tray.add(urls.map(ImageSource.file))
            return !urls.isEmpty
        }
    }
}
