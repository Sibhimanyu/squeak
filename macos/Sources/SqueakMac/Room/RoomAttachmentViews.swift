import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI
import UniformTypeIdentifiers

// Attachments in the pond room: the composer's tray (a + beside the mic, paste, drop), the thumbnails and chips above the
// field, and the pictures and files in a message's bubble. The limits and the format are `RoomAttachmentDraft` (Core).

/// Pictures and files waiting to go with the next room message. Nothing is written to disk: a thumbnail is dropped with
/// the app, and the host stores what is sent.
@MainActor @Observable
final class RoomAttachmentTray {
    private(set) var draft = RoomAttachmentDraft()
    private(set) var thumbs: [UUID: NSImage] = [:]

    var items: [OutgoingAttachment] { draft.items }

    /// Files and pictures from the file picker, a drop or a copied file: a picture is prepared like a chat's, anything
    /// else is read as it is (a folder is refused).
    func add(_ urls: [URL]) {
        for url in urls {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentTypeKey])
            if values?.isDirectory == true { draft.fail("Folders can't be attached. Choose files."); continue }
            guard values?.isRegularFile == true else { draft.fail("\u{201C}\(url.lastPathComponent)\u{201D} can't be read."); continue }
            if values?.contentType?.conforms(to: .image) == true { addImage(.file(url), name: url.lastPathComponent) } else { addFile(url, size: values?.fileSize ?? 0) }
        }
    }

    /// Pictures from the pasteboard (⌘V with an image) or the field's own drops.
    func addImages(_ sources: [ImageSource]) {
        for source in sources {
            switch source {
            case .data: addImage(source, name: "Pasted image")
            case .file(let url): addImage(source, name: url.lastPathComponent)
            }
        }
    }

    private func addImage(_ source: ImageSource, name: String) {
        guard draft.beginImage() else { return }
        Task { [weak self] in
            let prepared = await Task.detached(priority: .userInitiated) { () -> PreparedImage? in
                switch source {
                case .data(let d): return ImageAttachments.prepare(d)
                case .file(let url):
                    guard let v = try? url.resourceValues(forKeys: [.fileSizeKey]), (v.fileSize ?? 0) <= ImageAttachments.maxSourceBytes,
                          let d = try? Data(contentsOf: url) else { return nil }
                    return ImageAttachments.prepare(d)
                }
            }.value
            guard let self else { return }
            let thumb = prepared.flatMap { NSImage(data: $0.data) }
            draft.finishImage(prepared, name: name, size: thumb?.size)
            if let thumb, let last = draft.items.last, last.kind == .image, thumbs[last.id] == nil { thumbs[last.id] = thumb }
        }
    }

    private func addFile(_ url: URL, size: Int) {
        if draft.isFull(.file) { draft.fail("Up to \(RoomAttachmentLimits.maxFiles) files per message."); return }
        if let problem = RoomAttachmentLimits.fileProblem(name: url.lastPathComponent, size: size) { draft.fail(problem); return }
        guard let data = try? Data(contentsOf: url) else { draft.fail("\u{201C}\(url.lastPathComponent)\u{201D} can't be read."); return }
        draft.addFile(name: url.lastPathComponent, data: data)
    }

    func remove(_ id: UUID) { draft.remove(id); thumbs[id] = nil }
    func clear() { draft.clear(); thumbs = [:] }

    /// The + button: the system open panel for pictures and files.
    func pick() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "Choose pictures or files to attach"
        guard panel.runModal() == .OK else { return }
        add(panel.urls)
    }

    func fail(_ message: String) { draft.fail(message) }
}

/// Thumbnails and file chips above the composer's field, each with a remove button, and any problem in one line.
struct RoomAttachmentStrip: View {
    let tray: RoomAttachmentTray

    var body: some View {
        if !tray.draft.isEmpty || tray.draft.error != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !tray.draft.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(tray.items) { item in
                            Group {
                                if item.kind == .image { thumb(item) } else { chip(item) }
                            }
                            .overlay(alignment: .topTrailing) { remove(item) }
                        }
                        if tray.draft.preparing > 0 { ProgressView().controlSize(.small).frame(width: 44, height: 44) }
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 5).padding(.trailing, 5)
                }
                if let e = tray.draft.error {
                    Text(e).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 4)
        }
    }

    private func thumb(_ item: OutgoingAttachment) -> some View {
        Group {
            if let image = tray.thumbs[item.id] { Image(nsImage: image).resizable().scaledToFill() } else { Theme.surfaceRaised }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Attached image")
    }

    private func chip(_ item: OutgoingAttachment) -> some View {
        HStack(spacing: 6) {
            Lucide(.fileText, size: 14, color: Theme.muted)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: item.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text(verbatim: RoomAttachmentText.size(item.data.count)).font(.system(size: 10)).foregroundStyle(Theme.subtle)
            }
        }
        .padding(.horizontal, 8).frame(maxWidth: 180, minHeight: 44, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Attached file, \(item.name), \(RoomAttachmentText.size(item.data.count))")
    }

    private func remove(_ item: OutgoingAttachment) -> some View {
        Button { tray.remove(item.id) } label: {
            Lucide(.x, size: 10, color: Theme.ink)
                .frame(width: 16, height: 16)
                .background(Circle().fill(Theme.surfaceRaised))
                .overlay(Circle().strokeBorder(Theme.lineStrong))
        }
        .buttonStyle(.plain).offset(x: 5, y: -5)
        .accessibilityLabel("Remove \(item.kind == .image ? "image" : item.name)")
    }
}

/// The paperclip beside the mic: opens the picker.
struct RoomAttachButton: View {
    let tray: RoomAttachmentTray

    var body: some View {
        Button { tray.pick() } label: {
            Lucide(.paperclip, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Attach pictures or files")
        .shortcutHint("Attach", .attach)
        .accessibilityLabel("Attach pictures or files")
    }
}

// MARK: In a message

/// Downloads an attachment from the host once and keeps it in the temp folder, so a picture and Quick Look share one copy.
@MainActor
final class RoomAttachmentStore {
    static let shared = RoomAttachmentStore()
    private var images: [String: NSImage] = [:]
    private var inflight: [String: Task<URL?, Never>] = [:]

    private var folder: URL { FileManager.default.temporaryDirectory.appendingPathComponent("squeak-room-attachments", isDirectory: true) }

    func cachedImage(_ a: RoomAttachment) -> NSImage? { images[a.id] }

    /// The local copy of `a` (fetched if needed); nil when the host cannot be reached.
    func file(for a: RoomAttachment, host: NativeHostClient) async -> URL? {
        let dir = folder.appendingPathComponent(a.id.filter { $0.isLetter || $0.isNumber || $0 == "-" }, isDirectory: true)
        let url = dir.appendingPathComponent(RoomAttachmentFiles.cleanName(a.name))
        if FileManager.default.fileExists(atPath: url.path) { return url }
        if let t = inflight[a.id] { return await t.value }
        let task = Task<URL?, Never> {
            guard let data = try? await RoomClient(host: host).attachment(a) else { return nil }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return (try? data.write(to: url, options: .atomic)) != nil ? url : nil
        }
        inflight[a.id] = task
        let result = await task.value
        inflight[a.id] = nil
        return result
    }

    func image(for a: RoomAttachment, host: NativeHostClient) async -> NSImage? {
        if let i = images[a.id] { return i }
        guard let url = await file(for: a, host: host), let i = NSImage(contentsOf: url) else { return nil }
        images[a.id] = i
        return i
    }
}

/// A message's pictures (one keeps its shape up to 240 pt, several make a small grid) and files (chips), under its words.
struct RoomAttachmentsView: View {
    let attachments: [RoomAttachment]
    let pending: Bool
    var alignment: HorizontalAlignment = .leading
    @Environment(AppModel.self) private var model
    @State private var preview: URL?

    private var pictures: [RoomAttachment] { attachments.filter { $0.kind == .image } }
    private var files: [RoomAttachment] { attachments.filter { $0.kind == .file } }

    var body: some View {
        VStack(alignment: alignment, spacing: 6) {
            if !pictures.isEmpty { grid }
            ForEach(files) { f in chip(f) }
        }
        .opacity(pending ? 0.6 : 1)
        .sheet(item: $preview) { url in RoomAttachmentPreview(url: url) { preview = nil } }
    }

    private var grid: some View {
        let sizes = RoomAttachmentGrid.sizes(naturals: pictures.map(\.pixelSize))
        let columns = RoomAttachmentGrid.columns(count: pictures.count)
        return LazyVGrid(
            columns: Array(repeating: GridItem(.fixed(sizes[0].width), spacing: RoomAttachmentGrid.spacing), count: columns),
            alignment: .leading, spacing: RoomAttachmentGrid.spacing
        ) {
            ForEach(Array(pictures.enumerated()), id: \.element.id) { i, a in
                RoomPicture(attachment: a, size: sizes[i], pending: pending) { open(a) }
            }
        }
        .frame(width: columns == 1 ? sizes[0].width : RoomAttachmentGrid.maxWidth, alignment: .leading)
    }

    private func chip(_ a: RoomAttachment) -> some View {
        Button { open(a) } label: {
            HStack(spacing: 8) {
                Image(nsImage: NSWorkspace.shared.icon(for: UTType(filenameExtension: (a.name as NSString).pathExtension) ?? .data))
                    .resizable().frame(width: 20, height: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: a.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                    Text(verbatim: RoomAttachmentText.size(a.size)).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: 260, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().disabled(a.isLocal)
        .contextMenu { if !a.isLocal { Button("Show in Finder") { reveal(a) } } }
        .help("Open \(a.name)")
        .accessibilityLabel(RoomAttachmentText.label(a))
    }

    private func open(_ a: RoomAttachment) {
        guard !a.isLocal else { return }
        Task { if let url = await RoomAttachmentStore.shared.file(for: a, host: model.nativeHost) { preview = url } }
    }

    private func reveal(_ a: RoomAttachment) {
        Task { if let url = await RoomAttachmentStore.shared.file(for: a, host: model.nativeHost) { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
    }
}

extension URL: @retroactive Identifiable { public var id: String { absoluteString } }

/// One picture of a bubble: its frame is fixed by `RoomAttachmentGrid`, the image fills it once loaded.
private struct RoomPicture: View {
    let attachment: RoomAttachment
    let size: CGSize
    let pending: Bool
    let open: () -> Void
    @Environment(AppModel.self) private var model
    @State private var image: NSImage?

    init(attachment: RoomAttachment, size: CGSize, pending: Bool, open: @escaping () -> Void) {
        self.attachment = attachment; self.size = size; self.pending = pending; self.open = open
        _image = State(initialValue: RoomAttachmentStore.shared.cachedImage(attachment))
    }

    var body: some View {
        Button(action: open) {
            ZStack {
                Theme.surface
                if let image { Image(nsImage: image).resizable().aspectRatio(contentMode: .fill) }
                else if pending { ProgressView().controlSize(.small) }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().disabled(attachment.isLocal)
        .help("Open \(attachment.name)")
        .accessibilityLabel(RoomAttachmentText.label(attachment))
        .accessibilityHint("Opens a preview")
        .task(id: attachment.id) {
            guard image == nil, !attachment.isLocal else { return }
            image = await RoomAttachmentStore.shared.image(for: attachment, host: model.nativeHost)
        }
    }
}

/// Quick Look in a sheet: the same preview the file viewer uses for a file it cannot read as text.
private struct RoomAttachmentPreview: View {
    let url: URL
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(verbatim: url.lastPathComponent).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer()
                Button("Open") { NSWorkspace.shared.open(url) }.buttonStyle(.plain).font(.system(size: 13)).foregroundStyle(Theme.muted)
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(12)
            QuickLookPreview(url: url)
        }
        .frame(minWidth: 560, idealWidth: 720, minHeight: 420, idealHeight: 560)
        .background(Theme.bg)
    }
}
