import Foundation

/// The Mac's last view, kept on the phone so a cold launch (or a tapped notification link) has a list to show in
/// its first frame instead of a splash and "Waiting for your Mac…". It is only ever shown as "what was here":
/// the first fresh view from the Mac replaces it, and nothing is acted on from it that the Mac does not check
/// again (every command names the chat's current turn).
///
/// Session text is sensitive, so like `HistoryStore` it is in Caches, written with `.completeFileProtection`,
/// excluded from backup, and removed on unpair. Writes are coalesced (at most one every `delay` seconds) and the
/// encode runs on the store's own queue, never the main actor.
public final class SnapshotStore: @unchecked Sendable {
    /// A view older than this is not worth showing first.
    public static let maxAge: TimeInterval = 7 * 24 * 3600

    struct File: Codable { var v = 1; var at: Double; var snapshot: PhoneSnapshot }

    private let url: URL
    private let delay: TimeInterval
    private let queue = DispatchQueue(label: "squeak.snapshot-store", qos: .utility)
    private let lock = NSLock()
    private var latest: PhoneSnapshot?
    private var pending: DispatchWorkItem?

    public init(directory: URL? = nil, name: String? = nil, delay: TimeInterval = 3) {
        let dir = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        url = dir.appendingPathComponent("squeak-snapshot\(name.map { "-" + $0 } ?? "").json")
        self.delay = delay
    }

    /// The kept view, or nil when none, an unreadable one, or one older than `maxAge`. Reads and decodes on the
    /// calling thread: call it off the main actor.
    public func load(now: Date = Date()) -> PhoneSnapshot? {
        guard let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1,
              now.timeIntervalSince1970 - file.at < Self.maxAge else { return nil }
        return file.snapshot
    }

    /// Remember the newest view. Cheap: it only keeps the value and schedules the write.
    public func record(_ snapshot: PhoneSnapshot) {
        lock.lock()
        if latest == snapshot { lock.unlock(); return }
        latest = snapshot
        let idle = pending == nil
        lock.unlock()
        if idle { schedule() }
    }

    /// Forget it, in memory and on disk (unpairing).
    public func clear() {
        lock.lock(); latest = nil; pending?.cancel(); pending = nil; lock.unlock()
        let url = url
        queue.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Write now, waiting for it; for tests and for going to the background.
    public func flush() {
        lock.lock(); pending?.cancel(); pending = nil; lock.unlock()
        queue.sync { self.write() }
    }

    private func schedule() {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.pending = nil; self.lock.unlock()
            self.write()
        }
        lock.lock(); pending = item; lock.unlock()
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func write() {
        lock.lock(); let snapshot = latest; lock.unlock()
        guard let snapshot, let data = try? JSONEncoder().encode(File(at: Date().timeIntervalSince1970, snapshot: snapshot)) else { return }
        var target = url
        try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        guard (try? data.write(to: target, options: options)) != nil else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }
}
