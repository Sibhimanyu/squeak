import AppKit
import SqueakMacCore
import SqueakMarkup
import SwiftUI

// File paths in a chat as links (DESIGN: subtle, only when the file is there), and the thumbnails a step shows for an
// image it read, wrote or showed. Existence is checked off the main thread and cached (`PathExistenceCache`); a body
// only ever reads the cache. Nothing here does file I/O while drawing.

/// A counter a body reads so a finished existence check redraws the text that asked.
@Observable final class PathLinkTick: @unchecked Sendable {
    private(set) var version = 0
    func bump() { version += 1 }
}

@MainActor
final class PathLinker {
    private static let cache = PathExistenceCache()
    private static let tick: PathLinkTick = {
        let t = PathLinkTick()
        // A check that finds a file (or loses one) redraws; the callback runs on the checker's queue.
        PathLinker.cache.onChange = { DispatchQueue.main.async { t.bump() } }
        return t
    }()
    private static var registry: [String: PathLinker] = [:]

    static func shared(cwd: String, files: FilesModel) -> PathLinker {
        if let existing = registry[cwd], existing.files === files { return existing }
        let made = PathLinker(cwd: cwd, files: files)
        registry[cwd] = made
        return made
    }

    let cwd: String
    let files: FilesModel
    /// What the message renderer asks.
    private(set) var links: PathLinks = PathLinks(resolve: { _ in nil }, menu: { _ in [] })

    private init(cwd: String, files: FilesModel) {
        self.cwd = cwd
        self.files = files
        let cache = Self.cache, tick = Self.tick
        links = PathLinks(
            resolve: { raw in
                _ = tick.version  // observed: a finished check redraws this text
                guard let (_, state) = Self.lookup(raw, cwd: cwd, cache: cache), state != .missing, state != .unknown else { return nil }
                return PathLinking.linkURL(for: raw)
            },
            menu: { [weak self] raw in
                PathLinking.Action.allCases.map { action in
                    PathLinkMenuItem(title: action.title) { Task { @MainActor in self?.perform(action, raw: raw) } }
                }
            })
    }

    nonisolated static func lookup(_ raw: String, cwd: String, cache: PathExistenceCache) -> (PathRef, PathExistenceCache.State)? {
        guard let ref = PathLinking.parse(raw) else { return nil }
        let url = PathLinking.resolve(ref, cwd: cwd)
        return (ref, cache.state(for: url))
    }

    /// Whether `raw` names a file or folder that is there now (cached; never reads the disk on the caller).
    func isLinkable(_ raw: String) -> Bool { links.resolve(raw) != nil }

    func perform(_ action: PathLinking.Action, raw: String) {
        guard let ref = PathLinking.parse(raw) else { return }
        let url = PathLinking.resolve(ref, cwd: cwd)
        var isDir = false
        if case .exists(let d) = Self.cache.state(for: url) { isDir = d }
        run(PathLinking.effect(for: action, url: url, isDirectory: isDir, line: ref.line, cwd: cwd))
    }

    private func run(_ effect: PathLinking.Effect) {
        switch effect {
        case .workbenchTab(let rel, let line): files.openFile(rel, line: line)
        case .imageTab(let url): files.openExternalImage(url)
        case .openDefault(let url): NSWorkspace.shared.open(url)
        case .reveal(let url): NSWorkspace.shared.activateFileViewerSelecting([url])
        case .copy(let text):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }

    /// The right-click rows for the paths of a command (only those that exist).
    func existing(in command: String) -> [String] { PathLinking.paths(inCommand: command).filter { isLinkable($0) } }
}

private struct PathLinkerKey: EnvironmentKey { static let defaultValue: PathLinker? = nil }
extension EnvironmentValues {
    var pathLinker: PathLinker? {
        get { self[PathLinkerKey.self] }
        set { self[PathLinkerKey.self] = newValue }
    }
}

/// Puts the chat's path links in the environment: the renderer's resolver, the click handler and the linker.
struct ChatPathLinks: ViewModifier {
    let files: FilesModel?
    let cwd: String?

    func body(content: Content) -> some View {
        if let files, let cwd, !cwd.isEmpty {
            let linker = PathLinker.shared(cwd: cwd, files: files)
            content
                .environment(\.messagePathLinks, linker.links)
                .environment(\.pathLinker, linker)
                .environment(\.openURL, OpenURLAction { url in
                    guard let raw = PathLinking.raw(from: url) else { return .systemAction }
                    linker.perform(.openInTab, raw: raw)
                    return .handled
                })
        } else {
            content
        }
    }
}

// MARK: Step thumbnails

/// A small picture under a step that read, wrote or showed an image; `card` is Squeak's `show_image` (taller, with the
/// agent's caption). Decoded off the main thread at a small size and cached; a missing file shows nothing.
struct StepImageView: View {
    let path: String
    let caption: String?
    let card: Bool
    @Environment(\.pathLinker) private var linker
    @State private var image: CGImage?

    private var height: CGFloat { card ? 180 : 96 }
    private var pixels: Int { Int(height * 2 * 2) }

    init(path: String, caption: String?, card: Bool) {
        self.path = path; self.caption = caption; self.card = card
        _image = State(initialValue: ThumbnailCache.shared.latestImage(path: path, maxPixel: Int(((card ? 180 : 96) as CGFloat) * 4)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let image {
                Button { linker?.perform(.openInTab, raw: path) } label: {
                    Image(decorative: image, scale: 2)
                        .resizable().aspectRatio(contentMode: .fit)
                        .frame(maxHeight: height)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.control))
                        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                }
                .buttonStyle(.plain).pointerHand()
                .help("Open \(ChangesPresentation.fileName(path))")
                .accessibilityLabel(caption ?? ChangesPresentation.fileName(path))
                .accessibilityHint("Opens the image in a tab")
                .contextMenu {
                    if let linker {
                        ForEach(Array(linker.links.menu(path).enumerated()), id: \.offset) { _, item in Button(item.title) { item.run() } }
                    }
                }
            }
            if card, image != nil, let caption, !caption.isEmpty {
                Text(verbatim: caption).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: path) {
            let url = URL(fileURLWithPath: path), px = pixels
            let made = await Task.detached(priority: .utility) { ThumbnailCache.shared.image(for: url, maxPixel: px) }.value
            if let made { image = made } else { image = nil }
        }
    }
}
