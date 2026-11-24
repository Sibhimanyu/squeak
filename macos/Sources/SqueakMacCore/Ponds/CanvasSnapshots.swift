import CryptoKit
import Foundation

// The rules behind the canvas's artboard pictures: what makes a cached picture still right (the key), how much memory
// the pictures may hold (an LRU counted in bytes), which artboards to draw first, and which files on disk to drop.
// Pure, so the pool that draws them stays a thin shell.

/// What one cached picture was drawn from. Any change in the file, the canvas's assets, the size, background or scale
/// makes a different key, so a stale picture is never shown for a changed board.
public struct CanvasSnapshotKey: Hashable, Sendable {
    public var canvasPath: String
    public var boardID: String
    public var fileModifiedAt: Int64
    public var assetsModifiedAt: Int64
    public var width: Double
    public var height: Double
    public var background: String?
    public var scale: Int

    public init(canvasPath: String, board: CanvasArtboardInfo, assetsModifiedAt: Int64, scale: Int = 2) {
        self.canvasPath = canvasPath; boardID = board.id; fileModifiedAt = board.modifiedAt
        self.assetsModifiedAt = assetsModifiedAt; width = board.width; height = board.height
        background = board.background; self.scale = scale
    }

    private static func digest(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// Shared by every picture of one artboard: lets a new picture sweep away the older ones of the same board.
    public var boardPrefix: String { "\(Self.digest(canvasPath))-\(Self.digest(boardID))" }

    /// The disk file's name: the board prefix, then a digest of everything that changes the picture.
    public var fileName: String {
        let rest = "\(fileModifiedAt)|\(assetsModifiedAt)|\(width)|\(height)|\(background ?? "")|\(scale)"
        return "\(boardPrefix)-\(Self.digest(rest)).png"
    }

    /// Bytes the decoded picture takes in memory (RGBA at the key's scale).
    public var pixelBytes: Int {
        let w = (width * Double(scale)).rounded(.up), h = (height * Double(scale)).rounded(.up)
        return Int(max(1, w)) * Int(max(1, h)) * 4
    }
}

/// Least-recently-used accounting by cost. Holds no values, only which keys are kept and what they cost; the caller
/// drops the values of whatever `insert` returns.
public struct CostLRU<Key: Hashable>: Sendable where Key: Sendable {
    public let capacity: Int
    public private(set) var total = 0
    private var costs: [Key: Int] = [:]
    private var order: [Key] = []   // oldest first

    public init(capacity: Int) { self.capacity = capacity }

    public var count: Int { costs.count }
    public var keys: [Key] { order }
    public func contains(_ key: Key) -> Bool { costs[key] != nil }

    /// Marks a key as just used; false when it is not kept.
    @discardableResult
    public mutating func touch(_ key: Key) -> Bool {
        guard costs[key] != nil else { return false }
        order.removeAll { $0 == key }
        order.append(key)
        return true
    }

    /// Keeps `key` as the newest and returns the keys to forget, oldest first. A picture bigger than the whole budget
    /// is not kept (it comes back as its own eviction).
    public mutating func insert(_ key: Key, cost: Int) -> [Key] {
        remove(key)
        guard cost <= capacity else { return [key] }
        costs[key] = cost; order.append(key); total += cost
        var evicted: [Key] = []
        while total > capacity, let oldest = order.first, oldest != key {
            order.removeFirst()
            total -= costs.removeValue(forKey: oldest) ?? 0
            evicted.append(oldest)
        }
        return evicted
    }

    public mutating func remove(_ key: Key) {
        guard let c = costs.removeValue(forKey: key) else { return }
        total -= c
        order.removeAll { $0 == key }
    }

    public mutating func removeAll(where match: (Key) -> Bool) -> [Key] {
        let gone = order.filter(match)
        for k in gone { remove(k) }
        return gone
    }
}

public enum CanvasRenderPlan {
    /// Distance of an artboard's centre from the viewport's centre, in the pasteboard's own coordinates.
    public static func distance(_ frame: CGRect, from centre: CGPoint) -> Double {
        hypot(Double(frame.midX - centre.x), Double(frame.midY - centre.y))
    }

    /// `ids` nearest the viewport first; ties keep the list order, so the order is stable.
    public static func priority(ids: [String], frames: [String: CGRect], centre: CGPoint) -> [String] {
        var scored: [(index: Int, id: String, distance: Double)] = []
        for (i, id) in ids.enumerated() {
            var d = Double.greatestFiniteMagnitude
            if let f = frames[id] { d = distance(f, from: centre) }
            scored.append((i, id, d))
        }
        scored.sort { a, b in a.distance != b.distance ? a.distance < b.distance : a.index < b.index }
        return scored.map { $0.id }
    }

    /// The leading part of a priority order whose pictures fit `budget` bytes together (always at least one), so
    /// nothing is drawn only to be pushed out of the memory cache again.
    public static func withinBudget(order: [String], cost: [String: Int], budget: Int) -> [String] {
        var used = 0, out: [String] = []
        for id in order {
            let c = cost[id] ?? 0
            if !out.isEmpty && used + c > budget { break }
            used += c; out.append(id)
        }
        return out
    }

    /// Renders under way that should stop: they are far from the viewport (outside the nearest `keep`) while nearer
    /// artboards wait for a slot.
    public static func cancellations(inFlight: [String], waiting: [String], order: [String], keep: Int) -> [String] {
        guard !waiting.isEmpty else { return [] }
        let rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($1, $0) })
        let nearestWaiting = waiting.compactMap { rank[$0] }.min() ?? Int.max
        return inFlight.filter { id in
            guard let r = rank[id] else { return true }   // no longer on the canvas
            return r >= keep && r > nearestWaiting
        }
    }
}

public enum CanvasDiskCache {
    public struct File: Equatable, Sendable {
        public var name: String
        public var bytes: Int
        public var modified: Date
        public init(name: String, bytes: Int, modified: Date) { self.name = name; self.bytes = bytes; self.modified = modified }
    }

    /// Files to delete so the folder fits `capacity` bytes: the oldest first.
    public static func victims(_ files: [File], capacity: Int) -> [String] {
        var total = files.reduce(0) { $0 + $1.bytes }
        var out: [String] = []
        for f in files.sorted(by: { $0.modified < $1.modified }) where total > capacity {
            out.append(f.name); total -= f.bytes
        }
        return out
    }

    /// Older pictures of the same artboard than `current`.
    public static func superseded(_ files: [String], by current: CanvasSnapshotKey) -> [String] {
        files.filter { $0.hasPrefix(current.boardPrefix + "-") && $0 != current.fileName }
    }
}
