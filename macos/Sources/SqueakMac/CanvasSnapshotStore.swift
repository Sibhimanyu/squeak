import AppKit
import SqueakMacCore

// Where artboard pictures are kept between draws: a memory cache capped by total pixel bytes (least recently used goes
// first) in front of a disk cache under the support folder. Keys carry the file's and the assets' modified times, so a
// changed artboard can never be answered with its old picture, and reopening a canvas shows pictures without drawing.

@MainActor
final class CanvasSnapshotStore {
    static let shared = CanvasSnapshotStore()

    nonisolated static let memoryBudget = 256 * 1024 * 1024
    nonisolated static let diskBudget = 512 * 1024 * 1024

    private let directory: URL
    private var lru: CostLRU<CanvasSnapshotKey>
    private var images: [CanvasSnapshotKey: NSImage] = [:]
    /// Told which artboards of a canvas the memory cache let go (by canvas path), so its pasteboard stops holding them.
    private var onEvict: [String: ([String]) -> Void] = [:]

    init(directory: URL = URL.homeDirectory.appending(path: "Library/Application Support/Squeak Mac/canvas-snapshots"),
         memoryBudget: Int = CanvasSnapshotStore.memoryBudget) {
        self.directory = directory
        lru = CostLRU(capacity: memoryBudget)
        let dir = directory
        Task.detached(priority: .background) { Self.prune(dir, capacity: Self.diskBudget) }
    }

    func observeEvictions(path: String, _ handler: @escaping ([String]) -> Void) { onEvict[path] = handler }
    func stopObserving(path: String) { onEvict[path] = nil }

    func memory(_ key: CanvasSnapshotKey) -> NSImage? {
        guard let image = images[key] else { return nil }
        lru.touch(key)
        return image
    }

    /// The picture from disk (and into memory), or nil when there is none.
    func disk(_ key: CanvasSnapshotKey) async -> NSImage? {
        let file = directory.appending(path: key.fileName)
        let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: file) }.value
        guard !Task.isCancelled, let data, let image = NSImage(data: data) else { return nil }
        image.size = CGSize(width: key.width, height: key.height)
        remember(image, key)
        return image
    }

    /// Keeps a freshly drawn picture in memory and writes it to disk, and sweeps older pictures of the same artboard.
    func put(_ image: NSImage, _ key: CanvasSnapshotKey) {
        image.size = CGSize(width: key.width, height: key.height)
        remember(image, key)
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        let box = ImageBox(cg), dir = directory
        Task.detached(priority: .utility) {
            let fm = FileManager.default
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            if let png = NSBitmapImageRep(cgImage: box.image).representation(using: .png, properties: [:]) {
                try? png.write(to: dir.appending(path: key.fileName), options: .atomic)
            }
            let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
            for name in CanvasDiskCache.superseded(names, by: key) { try? fm.removeItem(at: dir.appending(path: name)) }
        }
    }

    /// Forgets this canvas's pictures that are not for one of `current` any more (their file or assets changed).
    func retain(path: String, current: Set<CanvasSnapshotKey>) {
        for key in lru.removeAll(where: { $0.canvasPath == path && !current.contains($0) }) { images[key] = nil }
    }

    private func remember(_ image: NSImage, _ key: CanvasSnapshotKey) {
        images[key] = image
        let evicted = lru.insert(key, cost: key.pixelBytes)
        var byPath: [String: [String]] = [:]
        for k in evicted {
            images[k] = nil
            byPath[k.canvasPath, default: []].append(k.boardID)
        }
        for (path, ids) in byPath { onEvict[path]?(ids) }
    }

    private final class ImageBox: @unchecked Sendable {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    nonisolated private static func prune(_ dir: URL, capacity: Int) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let urls = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        let files = urls.compactMap { url -> CanvasDiskCache.File? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)), let size = v.fileSize else { return nil }
            return CanvasDiskCache.File(name: url.lastPathComponent, bytes: size, modified: v.contentModificationDate ?? .distantPast)
        }
        for name in CanvasDiskCache.victims(files, capacity: capacity) { try? fm.removeItem(at: dir.appending(path: name)) }
    }
}
