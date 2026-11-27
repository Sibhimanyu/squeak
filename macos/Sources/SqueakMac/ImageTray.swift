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
    /// The images on a pasteboard, as `ComposerPaste` decides: copied picture files, or raw picture bytes (a screenshot, a
    /// copy from a page) when there is no text beside them, so an ordinary text paste is never taken over.
    static func sources(_ pb: NSPasteboard, rawNeedsNoText: Bool) -> [ImageSource] {
        let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        let pictures = urls.filter { (try? $0.resourceValues(forKeys: [.contentTypeKey]).contentType)?.conforms(to: .image) == true }
        let facts = ComposerPaste.Facts(types: (pb.types ?? []).map(\.rawValue), imageFileCount: pictures.count,
                                        otherFileCount: urls.count - pictures.count)
        switch ComposerPaste.decide(facts, rawNeedsNoText: rawNeedsNoText) {
        case .imageFiles: return pictures.map(ImageSource.file)
        case .imageData(let type):
            // The chosen type first, then any other picture type: some apps list one they cannot hand over.
            let order = [type] + ComposerPaste.imageTypes.filter { $0 != type }
            for t in order { if let d = pb.data(forType: NSPasteboard.PasteboardType(t)), !d.isEmpty { return [.data(d)] } }
            return []
        case .text: return []
        }
    }
}

/// Images waiting to go with the next message of one composer. Nothing is written to disk here: the files are
/// made only when the person presses Send, in the chat's own folder, and a thumbnail is dropped with the app.
@MainActor @Observable
final class ImageTray {
    struct Item: Identifiable {
        var id = UUID()
        let image: PreparedImage
        let thumb: NSImage
        /// What its inline chip shows (the file's own name, or "image-N.png" for a paste).
        var name = "image.png"
    }

    private(set) var items: [Item] = []
    private(set) var preparing = 0
    var error: String?
    /// Why this composer cannot take a picture right now (no folder to save it in); nil: it can. A paste or drop says
    /// so instead of doing nothing.
    var unavailable: String?
    var canAttach: Bool { unavailable == nil }
    /// Inline mode (the new layout's card): each picture is inserted where the caret is, as a pending token
    /// (`InlineAttachments.pendingToken`), the moment it is pasted, dropped or picked; the field draws it as a chip.
    /// Nil: the classic strip of thumbnails above the field, and the pictures go after the words on send.
    var onInsert: ((String) -> Void)?
    /// Inline mode: a picture could not be read; its token is taken out of the text.
    var onDropped: ((String) -> Void)?
    private var names: [UUID: String] = [:]

    var inline: Bool { onInsert != nil }
    func item(pendingId: String) -> Item? { items.first { $0.id.uuidString == pendingId } }
    func isPreparing(pendingId: String) -> Bool { UUID(uuidString: pendingId).map { names[$0] != nil && item(pendingId: pendingId) == nil } ?? false }
    /// Drops pictures whose chip was deleted from the text.
    func retain(pendingIds: [String]) {
        let keep = Set(pendingIds)
        if items.contains(where: { !keep.contains($0.id.uuidString) }) { items.removeAll { !keep.contains($0.id.uuidString) } }
    }

    var isFull: Bool { items.count + preparing >= ImageAttachments.maxImages }
    var hasImages: Bool { !items.isEmpty }

    func add(_ sources: [ImageSource]) {
        if let unavailable { error = unavailable; return }
        for source in sources {
            guard !isFull else { error = "Up to \(ImageAttachments.maxImages) images per message."; return }
            error = nil
            preparing += 1
            let id = UUID()
            let name: String = {
                if case .file(let url) = source, !url.lastPathComponent.isEmpty { return url.lastPathComponent }
                return "image-\(items.count + preparing).png"
            }()
            names[id] = name
            onInsert?(InlineAttachments.pendingToken(name: name, id: id.uuidString))
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
                let name = names[id] ?? "image.png"
                if let prepared, let thumb = NSImage(data: prepared.data) {
                    items.append(Item(id: id, image: prepared, thumb: thumb, name: name))
                } else {
                    names[id] = nil
                    onDropped?(id.uuidString)
                    error = "Squeak can only attach images it can read (PNG, JPEG, HEIC, TIFF, GIF)."
                }
            }
        }
    }

    func remove(_ id: UUID) { items.removeAll { $0.id == id }; error = nil }
    func clear() { items = []; names = [:]; error = nil }

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
        if inline {
            // Each picture goes where its chip is: the pending tokens become the saved paths, in place.
            let ids = InlineAttachments.pendingIds(in: text)
            let named = ids.compactMap { id in item(pendingId: id) }
            guard !named.isEmpty else { return InlineAttachments.resolve(text, refs: [:]) }
            guard let folder, !folder.isEmpty else { throw ImageAttachmentError.folderMissing }
            let refs = try ImageAttachments.save(named.map(\.image), into: folder)
            return InlineAttachments.resolve(text, refs: Dictionary(uniqueKeysWithValues: zip(named.map(\.id.uuidString), refs)))
        }
        guard hasImages else { return text }
        guard let folder, !folder.isEmpty else { throw ImageAttachmentError.folderMissing }
        let refs = try ImageAttachments.save(items.map(\.image), into: folder)
        return ImageAttachments.compose(text, refs: refs)
    }

    /// Runs `outgoing` and shows a failure under the thumbnails; nil means "do not send".
    func prepareToSend(text: String, folder: String?) -> String? {
        if inline, preparing > 0 { error = "One moment: an image is still being prepared."; return nil }
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
        // Inline mode: the pictures are chips in the text; only a problem is said here.
        if !tray.inline && (!tray.items.isEmpty || tray.preparing > 0) || tray.error != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !tray.inline && (!tray.items.isEmpty || tray.preparing > 0) {
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
                    Text(e).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The + beside a composer: opens a panel to choose images.
struct AttachButton: View {
    let tray: ImageTray
    var size: CGFloat = 28
    var symbol: LucideName = .plus

    var body: some View {
        Button { tray.pick() } label: {
            Lucide(symbol, size: 16, color: tray.isFull ? Theme.subtle : Theme.muted)
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(tray.isFull)
        .accessibilityLabel("Attach images")
        .shortcutHint("Attach images", .attach)
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
