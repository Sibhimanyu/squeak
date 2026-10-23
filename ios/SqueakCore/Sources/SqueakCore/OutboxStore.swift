import Foundation

/// Messages this phone sent that are not settled, kept on the phone so none is lost: a message still waiting
/// on the Mac, one the Mac refused, one nobody could confirm. Relaunching the app, or the phone killing it
/// mid-send, must not make them vanish or read as delivered; the text stays so it can be sent again or edited.
///
/// Like `HistoryStore`: Caches, Data Protection `.completeFileProtection`, excluded from backup, removed on
/// unpair. Only unsettled sends are written (a delivered one is the chat's business), and anything older than
/// a day is dropped.
public final class OutboxStore: @unchecked Sendable {
    public static let maxAge: TimeInterval = 24 * 60 * 60
    public static let maxEntries = 50

    public struct Entry: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable {
            /// Written or about to be, no answer yet. After a relaunch this can only mean "unknown".
            case sending
            /// The Mac (or the channel) said it did not go through; `reason` says why.
            case refused
            /// Neither delivered nor refused: it may be in the chat.
            case unconfirmed
        }

        public var key: String
        public var id: String
        public var text: String
        public var at: Double
        public var answersTurn: String?
        public var messageId: String
        /// "queue" or "steer".
        public var mode: String
        public var queuedBehindTurn: Bool
        public var state: State
        public var reason: String?
        /// The channel command, so an answer the Mac wrote while the app was gone can still be read.
        public var commandId: String?

        public init(key: String, id: String, text: String, at: Double, answersTurn: String?, messageId: String, mode: String,
                    queuedBehindTurn: Bool, state: State, reason: String? = nil, commandId: String? = nil) {
            self.key = key; self.id = id; self.text = text; self.at = at; self.answersTurn = answersTurn
            self.messageId = messageId; self.mode = mode; self.queuedBehindTurn = queuedBehindTurn
            self.state = state; self.reason = reason; self.commandId = commandId
        }
    }
    struct File: Codable { var v = 1; var entries: [Entry] }

    private let url: URL
    private let queue = DispatchQueue(label: "squeak.outbox-store", qos: .utility)
    private let lock = NSLock()
    private var entries: [Entry] = []

    /// `directory` defaults to the app's Caches folder.
    public init(directory: URL? = nil, now: Date = Date()) {
        let dir = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        url = dir.appendingPathComponent("squeak-outbox.json")
        if let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1 {
            entries = file.entries.filter { now.timeIntervalSince1970 - $0.at < Self.maxAge }
        }
    }

    /// Everything unsettled, oldest first, for seeding the app at launch.
    public func all() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }

    /// Replace what is kept with these (the caller's whole unsettled set). Written at once: the app may be
    /// suspended a moment later, and the point is that nothing sent is lost.
    public func replace(with next: [Entry]) {
        lock.lock()
        guard next != entries else { lock.unlock(); return }
        entries = Array(next.suffix(Self.maxEntries))
        let snapshot = entries
        lock.unlock()
        queue.async { [url] in Self.write(snapshot, to: url) }
    }

    /// Forget everything, in memory and on disk (unpairing).
    public func clear() {
        lock.lock(); entries = []; lock.unlock()
        let url = url
        queue.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Wait for pending writes; for tests and for going to the background.
    public func flush() { queue.sync {} }

    private static func write(_ entries: [Entry], to url: URL) {
        guard let data = try? JSONEncoder().encode(File(entries: entries)) else { return }
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
