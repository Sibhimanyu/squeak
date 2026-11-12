import Foundation

// File paths in a chat become links, but only when the file is really there. This is the logic apart from the views:
// reading `src/a.ts:12`, resolving it against the chat's folder, the cached existence check (never on the main
// thread), and where a click on it goes.

public struct PathRef: Equatable, Sendable {
    public var path: String
    public var line: Int?
    public init(path: String, line: Int? = nil) { self.path = path; self.line = line }
}

public enum PathLinking {
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "pdf", "bmp", "tif", "tiff"]

    /// `raw` as a path and an optional line (`:12`, `:12:3`), or nil when it cannot be a path: spaces, a URL, a
    /// bare word with no slash and no extension.
    public static func parse(_ raw: String) -> PathRef? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.count <= 400, !t.contains(where: { $0.isWhitespace || $0 == "\0" }),
              !t.contains("://"), !t.contains("\u{200B}") else { return nil }
        var core = Substring(t)
        var numbers: [Int] = []
        while numbers.count < 2, let colon = core.lastIndex(of: ":") {
            let tail = core[core.index(after: colon)...]
            guard !tail.isEmpty, tail.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(tail) else { break }
            numbers.insert(n, at: 0)
            core = core[..<colon]
        }
        let line = numbers.first
        guard !core.isEmpty, !core.contains(":") else { return nil }
        let path = String(core)
        let hasSlash = path.contains("/")
        let name = path.split(separator: "/").last.map(String.init) ?? ""
        let hasExt: Bool = {
            guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return false }
            let ext = name[name.index(after: dot)...]
            return (1...8).contains(ext.count) && ext.allSatisfy { $0.isLetter || $0.isNumber }
        }()
        guard path.hasPrefix("~") || path.hasPrefix("/") || hasSlash || hasExt else { return nil }
        guard path != "/" else { return nil }
        return PathRef(path: path, line: line)
    }

    /// Where the path points, made absolute against `cwd` (`~` against `home`) with `.`/`..` folded. No disk read.
    public static func resolve(_ ref: PathRef, cwd: String, home: String = NSHomeDirectory()) -> URL {
        let p = ref.path
        let full: String
        if p == "~" { full = home }
        else if p.hasPrefix("~/") { full = home + "/" + p.dropFirst(2) }
        else if p.hasPrefix("/") { full = p }
        else { full = cwd + "/" + p }
        return URL(fileURLWithPath: full).standardizedFileURL
    }

    /// The path under `root` ("a/b.swift"), or nil when it is outside (or is the root itself).
    public static func relative(_ url: URL, to root: String) -> String? {
        let base = URL(fileURLWithPath: root).standardizedFileURL.path
        let p = url.standardizedFileURL.path
        guard p.hasPrefix(base + "/") else { return nil }
        return String(p.dropFirst(base.count + 1))
    }

    public static func isImage(_ url: URL) -> Bool { imageExtensions.contains(url.pathExtension.lowercased()) }

    // MARK: Link URLs

    public static let scheme = "squeak-path"

    /// The link a rendered path carries: the text as written, percent-encoded.
    public static func linkURL(for raw: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "p", value: raw)]
        return c.url
    }

    public static func raw(from url: URL) -> String? {
        guard url.scheme == scheme, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        return items.first { $0.name == "p" }?.value
    }

    // MARK: Click routing

    public enum Action: String, CaseIterable, Sendable {
        case openInTab, openDefault, showInFinder, copyPath, copyRelativePath

        public var title: String {
            switch self {
            case .openInTab: "Open in tab"
            case .openDefault: "Open with default app"
            case .showInFinder: "Show in Finder"
            case .copyPath: "Copy path"
            case .copyRelativePath: "Copy relative path"
            }
        }
    }

    /// What the app does for an action on an existing path.
    public enum Effect: Equatable, Sendable {
        /// A text file or an image inside the chat's folder, in the file viewer (`line` for text).
        case workbenchTab(relative: String, line: Int?)
        /// An image outside the folder, in the viewer.
        case imageTab(URL)
        case openDefault(URL)
        case reveal(URL)
        case copy(String)
    }

    /// `primary` is a plain click: folders reveal in Finder, images and text open in a tab (outside the folder a text
    /// file goes to the default app, since the viewer is rooted in the chat's folder).
    public static func effect(for action: Action, url: URL, isDirectory: Bool, line: Int?, cwd: String, primary: Bool = false) -> Effect {
        switch action {
        case .openInTab:
            if isDirectory { return .reveal(url) }
            if let rel = relative(url, to: cwd) { return .workbenchTab(relative: rel, line: line) }
            return isImage(url) ? .imageTab(url) : .openDefault(url)
        case .openDefault: return .openDefault(url)
        case .showInFinder: return .reveal(url)
        case .copyPath: return .copy(url.path)
        case .copyRelativePath: return .copy(relative(url, to: cwd) ?? url.path)
        }
    }

    /// The paths a command line names, in order, for the row's menu.
    public static func paths(inCommand command: String, limit: Int = 6) -> [String] {
        var out: [String] = []
        for token in command.split(whereSeparator: { $0.isWhitespace || "\"'`()<>|;&=".contains($0) }) {
            let t = String(token)
            guard t.contains("/") || t.hasPrefix("~"), let ref = parse(t), !out.contains(ref.path) else { continue }
            out.append(t)
            if out.count == limit { break }
        }
        return out
    }
}

// MARK: Existence, cached

/// Whether a path is there, remembered per resolved path for a short while. `state` never touches the disk: a path
/// not seen yet (or one past its time) is checked on a background queue and `onChange` fires when the answer is a
/// new one worth drawing, so a body can ask on every pass.
public final class PathExistenceCache: @unchecked Sendable {
    public enum State: Equatable, Sendable { case unknown, missing, exists(isDirectory: Bool) }

    struct Entry { var state: State; var checkedAt: Date; var modified: TimeInterval? }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var inFlight: Set<String> = []
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date
    private let probe: @Sendable (String) -> (isDirectory: Bool, modified: TimeInterval)?
    private let queue = DispatchQueue(label: "squeak.path-exists", qos: .utility)
    /// Called (off the main thread) when a path's answer changed from what was drawn.
    public var onChange: (@Sendable () -> Void)?
    public static let capacity = 2000

    public init(
        ttl: TimeInterval = 15, now: @escaping @Sendable () -> Date = { Date() },
        probe: @escaping @Sendable (String) -> (isDirectory: Bool, modified: TimeInterval)? = PathExistenceCache.diskProbe
    ) {
        self.ttl = ttl; self.now = now; self.probe = probe
    }

    public static let diskProbe: @Sendable (String) -> (isDirectory: Bool, modified: TimeInterval)? = { path in
        var st = stat()
        guard stat(path, &st) == 0 else { return nil }
        return ((st.st_mode & S_IFMT) == S_IFDIR, TimeInterval(st.st_mtimespec.tv_sec))
    }

    public func state(for url: URL) -> State {
        let key = url.standardizedFileURL.path
        lock.lock()
        let entry = entries[key]
        let stale = entry.map { now().timeIntervalSince($0.checkedAt) >= ttl } ?? true
        let start = stale && !inFlight.contains(key)
        if start { inFlight.insert(key) }
        lock.unlock()
        if start { queue.async { [self] in check(key) } }
        return entry?.state ?? .unknown
    }

    /// Runs the check now, on this thread (the queue's, or a test's).
    func check(_ key: String) {
        let found = probe(key)
        let new: State = found.map { .exists(isDirectory: $0.isDirectory) } ?? .missing
        lock.lock()
        let old = entries[key]
        if entries.count >= Self.capacity { entries.removeAll(keepingCapacity: true) }
        entries[key] = Entry(state: new, checkedAt: now(), modified: found?.modified)
        inFlight.remove(key)
        lock.unlock()
        // Only an arrival that adds a link, or a change that removes one, needs a redraw.
        let drawn = old?.state ?? .unknown
        if drawn != new, new != .missing || old != nil { onChange?() }
    }

    /// For tests: wait for the queue.
    func drain() { queue.sync {} }
}

// MARK: Thumbnails

/// A thumbnail's identity: the file as it is now (path, mtime, size) at a pixel size, so an edited image is a new key.
public struct ThumbnailKey: Hashable, Sendable {
    public var path: String
    public var modified: TimeInterval
    public var size: Int64
    public var maxPixel: Int
    public init(path: String, modified: TimeInterval, size: Int64, maxPixel: Int) {
        self.path = path; self.modified = modified; self.size = size; self.maxPixel = maxPixel
    }
    var string: String { "\(path)|\(modified)|\(size)|\(maxPixel)" }
}

#if canImport(ImageIO)
import CoreGraphics
import ImageIO

/// Downsampled images for step rows and image cards, decoded off the main thread and kept (NSCache evicts under pressure).
public final class ThumbnailCache: @unchecked Sendable {
    public static let shared = ThumbnailCache()
    private final class Box { let image: CGImage; init(_ i: CGImage) { image = i } }
    private let cache: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 120; return c }()
    /// The newest image seen per path, so a body can draw at once without a stat (the task revalidates it).
    private let latest: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 120; return c }()
    public private(set) var decodes = 0
    private let lock = NSLock()

    public init() {}

    public func key(for url: URL, maxPixel: Int) -> ThumbnailKey? {
        var st = stat()
        guard stat(url.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        return ThumbnailKey(path: url.path, modified: TimeInterval(st.st_mtimespec.tv_sec), size: Int64(st.st_size), maxPixel: maxPixel)
    }

    public func cached(_ key: ThumbnailKey) -> CGImage? { cache.object(forKey: key.string as NSString)?.image }

    /// The last thumbnail shown for the path at this size, whatever its age.
    public func latestImage(path: String, maxPixel: Int) -> CGImage? { latest.object(forKey: "\(path)|\(maxPixel)" as NSString)?.image }

    /// Decodes (or returns) the thumbnail; call from a background task. Nil for a missing or unreadable file.
    public func image(for url: URL, maxPixel: Int) -> CGImage? {
        guard let key = key(for: url, maxPixel: maxPixel) else { return nil }
        if let hit = cached(key) { remember(hit, key); return hit }
        guard let made = Self.decode(url, maxPixel: maxPixel) else { return nil }
        lock.lock(); decodes += 1; lock.unlock()
        cache.setObject(Box(made), forKey: key.string as NSString)
        remember(made, key)
        return made
    }

    private func remember(_ image: CGImage, _ key: ThumbnailKey) {
        latest.setObject(Box(image), forKey: "\(key.path)|\(key.maxPixel)" as NSString)
    }

    static func decode(_ url: URL, maxPixel: Int) -> CGImage? {
        if url.pathExtension.lowercased() == "pdf" { return firstPage(url, maxPixel: maxPixel) }
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, options as CFDictionary)
    }

    private static func firstPage(_ url: URL, maxPixel: Int) -> CGImage? {
        guard let doc = CGPDFDocument(url as CFURL), let page = doc.page(at: 1) else { return nil }
        let box = page.getBoxRect(.cropBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = CGFloat(maxPixel) / max(box.width, box.height)
        let w = max(1, Int(box.width * scale)), h = max(1, Int(box.height * scale))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        ctx.drawPDFPage(page)
        return ctx.makeImage()
    }
}
#endif

// MARK: Zoom

/// The image tab's zoom: fixed steps, fit-to-window, and 100%.
public enum ImageZoom {
    public static let steps: [Double] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8]

    public static func zoomedIn(_ scale: Double) -> Double { steps.first { $0 > scale + 0.001 } ?? steps.last! }
    public static func zoomedOut(_ scale: Double) -> Double { steps.last { $0 < scale - 0.001 } ?? steps.first! }

    /// The scale that fits an image in a box (never above 1: fit does not enlarge a small image).
    public static func fit(image: (w: Double, h: Double), box: (w: Double, h: Double)) -> Double {
        guard image.w > 0, image.h > 0, box.w > 0, box.h > 0 else { return 1 }
        return min(1, box.w / image.w, box.h / image.h)
    }
}
