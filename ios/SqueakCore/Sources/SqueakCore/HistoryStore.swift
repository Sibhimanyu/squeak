import Foundation

/// The chat-history cache on the phone: per chat key, the last non-empty history the Mac sent, so a chat opened
/// after a relaunch shows its whole history in the first frame instead of only the newest message.
///
/// Session text is sensitive, so the file is in Caches, written with Data Protection `.completeFileProtection`
/// (the app never needs it in the background), excluded from backup, and removed on unpair. At most
/// `maxChats` chats are kept (least recently written dropped first), and each holds only what the Mac sent.
/// Writes are coalesced: a streaming turn that changes every frame touches the disk at most once a second.
public final class HistoryStore: @unchecked Sendable {
    public static let maxChats = 30
    /// Entries kept per chat on disk (the newest); memory holds more while the app runs.
    public static let maxEntries = 200

    struct Chat: Codable, Equatable {
        var key: String
        var at: Double
        var history: [LiveTurn.HistoryEntry]
        /// Where the older pages go on from, and whether the chat's start is held. Absent in an older file.
        var nextBefore: String? = nil
        var complete: Bool? = nil
    }
    struct File: Codable { var v = 1; var chats: [Chat] }

    private let url: URL
    private let delay: TimeInterval
    private let queue = DispatchQueue(label: "squeak.history-store", qos: .utility)
    private let lock = NSLock()
    private var chats: [Chat] = []
    private var pending: DispatchWorkItem?

    /// `directory` defaults to the app's Caches folder.
    public init(directory: URL? = nil, delay: TimeInterval = 1) {
        let dir = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        url = dir.appendingPathComponent("squeak-history.json")
        self.delay = delay
        if let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1 {
            chats = Array(file.chats.sorted { $0.at > $1.at }.prefix(Self.maxChats))
        }
    }

    /// Everything stored, for seeding the in-memory cache at launch.
    public func all() -> [String: [LiveTurn.HistoryEntry]] {
        lock.lock(); defer { lock.unlock() }
        return Dictionary(chats.map { ($0.key, $0.history) }, uniquingKeysWith: { a, _ in a })
    }

    /// Everything stored with its paging state, for seeding the in-memory cache at launch.
    public func states() -> [String: ChatHistoryState] {
        lock.lock(); defer { lock.unlock() }
        return Dictionary(chats.map { ($0.key, ChatHistoryState(entries: $0.history, nextBefore: $0.nextBefore, complete: $0.complete ?? false)) },
                          uniquingKeysWith: { a, _ in a })
    }

    /// Remember a chat's history. Empty history and an unchanged one are ignored.
    public func record(_ history: [LiveTurn.HistoryEntry], for key: String, now: Date = Date()) {
        record(ChatHistoryState(entries: history), for: key, now: now)
    }

    /// Remember a chat's history and where its older pages go on. Only the newest `maxEntries` reach the disk,
    /// and the cursor moves to match, so a dropped older part can be asked for again.
    public func record(_ state: ChatHistoryState, for key: String, now: Date = Date()) {
        guard !state.entries.isEmpty else { return }
        var state = state
        state.trimTo(Self.maxEntries)
        let history = state.entries
        lock.lock()
        if let i = chats.firstIndex(where: { $0.key == key }) {
            if chats[i].history == history, chats[i].nextBefore == state.nextBefore, (chats[i].complete ?? false) == state.complete {
                lock.unlock(); return
            }
            chats.remove(at: i)
        }
        chats.insert(Chat(key: key, at: now.timeIntervalSince1970, history: history, nextBefore: state.nextBefore, complete: state.complete), at: 0)
        if chats.count > Self.maxChats { chats.removeLast(chats.count - Self.maxChats) }
        lock.unlock()
        schedule()
    }

    /// Forget everything, in memory and on disk (unpairing).
    public func clear() {
        lock.lock(); chats = []; pending?.cancel(); pending = nil; lock.unlock()
        let url = url
        queue.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Write now, waiting for it; for tests and for going to the background.
    public func flush() {
        lock.lock(); pending?.cancel(); pending = nil; lock.unlock()
        queue.sync { self.write() }
    }

    private func schedule() {
        lock.lock()
        guard pending == nil else { lock.unlock(); return }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.pending = nil; self.lock.unlock()
            self.write()
        }
        pending = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func write() {
        lock.lock(); let snapshot = chats; lock.unlock()
        guard let data = try? JSONEncoder().encode(File(chats: snapshot)) else { return }
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
