import Foundation

/// One line of the room as drawn. `id` never changes for a row: a sent message keeps the id it had as a pending
/// row when the host's post replaces it, so nothing re-renders as new, vanishes or moves.
public struct RoomRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var post: RoomPost
    /// Sent from here, not yet answered by the host.
    public var pending: Bool
    public var failed: Bool
}

/// What a step of the feed asks the caller to do next.
public enum RoomFeedEffect: Sendable, Equatable {
    case none
    /// A post arrived past a hole (or before the first read): read `since` this seq to fill it.
    case refetch(since: Int)
}

/// The room's rows as a reducer (the TurnTimeline discipline): idempotent by seq, append-only at the tail, older
/// pages only prepend, a gap refetches, a pending row is reconciled by the host's post and never duplicated.
public struct RoomFeed: Sendable, Equatable {
    public private(set) var rows: [RoomRow] = []
    public private(set) var latestSeq = 0
    public private(set) var loaded = false
    /// More history before the oldest row (false until a page says so by being full).
    public var hasMoreBefore = false
    public private(set) var threads: [RoomThread] = []
    private var seen: Set<Int> = []
    private var localCounter = 0

    public init() {}

    public var oldestSeq: Int? { rows.lazy.filter { !$0.pending || $0.post.seq > 0 }.map(\.post.seq).filter { $0 > 0 }.min() }

    // MARK: Reading

    /// The first read, or a read `since` a seq: posts are merged by seq, so a repeat changes nothing.
    @discardableResult
    public mutating func apply(page: RoomPage, pageSize: Int? = nil) -> RoomFeedEffect {
        let first = !loaded
        loaded = true
        threads = page.threads
        for p in page.posts.sorted(by: { $0.seq < $1.seq }) { appendReal(p) }
        latestSeq = max(latestSeq, page.latestSeq)
        if first, let pageSize { hasMoreBefore = page.posts.count >= pageSize }
        return .none
    }

    /// A post from the stream.
    public mutating func receive(_ post: RoomPost) -> RoomFeedEffect {
        guard loaded else { return .refetch(since: 0) }
        if seen.contains(post.seq) { return .none }
        // A hole: leave it out and read the range, which brings this post too.
        if latestSeq > 0, post.seq > latestSeq + 1 { return .refetch(since: latestSeq) }
        appendReal(post)
        latestSeq = max(latestSeq, post.seq)
        return .none
    }

    /// The stream's `hello`: the host is ahead of what is held.
    public func hello(latestSeq host: Int) -> RoomFeedEffect {
        loaded && host > latestSeq ? .refetch(since: latestSeq) : .none
    }

    /// An older page, newest-last. Only rows older than the oldest held are taken, in front.
    public mutating func prepend(page: RoomPage, pageSize: Int) {
        let floor = oldestSeq ?? Int.max
        let older = page.posts.filter { $0.seq < floor && !seen.contains($0.seq) }.sorted { $0.seq < $1.seq }
        for p in older { seen.insert(p.seq) }
        rows.insert(contentsOf: older.map { RoomRow(id: $0.id, post: $0, pending: false, failed: false) }, at: 0)
        hasMoreBefore = page.posts.count >= pageSize
    }

    public mutating func setThreads(_ t: [RoomThread]) { threads = t }

    private mutating func appendReal(_ post: RoomPost) {
        guard !seen.contains(post.seq) else { return }
        seen.insert(post.seq)
        // The host's copy of a message sent from here (the stream can beat the POST's answer): the pending row
        // becomes it, in place, under its own id.
        if post.author.kind == .person,
            let i = rows.firstIndex(where: { $0.pending && !$0.failed && $0.post.text == post.text }) {
            rows[i].post = post; rows[i].pending = false
            return
        }
        let row = RoomRow(id: post.id, post: post, pending: false, failed: false)
        // Real posts sit before any pending rows, which stay last.
        let tail = rows.lastIndex(where: { !$0.pending }).map { $0 + 1 } ?? 0
        rows.insert(row, at: tail)
        if post.seq > latestSeq { latestSeq = post.seq }
    }

    // MARK: Sending

    /// A pending row for text just typed; returns its id.
    public mutating func addPending(text: String, level: RoomLevel, author: RoomAuthor, at: Int64) -> String {
        localCounter += 1
        let id = "local-\(localCounter)"
        let post = RoomPost(seq: 0, id: id, author: author, kind: .message, level: level, text: text, at: at)
        rows.append(RoomRow(id: id, post: post, pending: true, failed: false))
        return id
    }

    /// The host accepted it: the pending row becomes the post (in place, same row id). If the stream already
    /// delivered the post, the pending row is gone and nothing is added.
    public mutating func reconcile(pendingId: String, with post: RoomPost) {
        if let i = rows.firstIndex(where: { $0.id == pendingId }) {
            if seen.contains(post.seq) {
                // The stream's copy is another row; drop the pending one only if that is truly the same post.
                if rows.contains(where: { $0.id != pendingId && $0.post.id == post.id }) { rows.remove(at: i); return }
            }
            rows[i].post = post; rows[i].pending = false; rows[i].failed = false
            seen.insert(post.seq)
            latestSeq = max(latestSeq, post.seq)
        }
    }

    public mutating func markFailed(pendingId: String) {
        if let i = rows.firstIndex(where: { $0.id == pendingId }) { rows[i].failed = true }
    }

    public mutating func retry(pendingId: String) {
        if let i = rows.firstIndex(where: { $0.id == pendingId }) { rows[i].failed = false }
    }

    public func pendingRow(_ id: String) -> RoomRow? { rows.first { $0.id == id } }
}

/// What the person sees: room posts always, agent talk only when asked.
public struct RoomFilter: Sendable, Equatable {
    public var showAgentTalk: Bool
    public init(showAgentTalk: Bool = false) { self.showAgentTalk = showAgentTalk }
    public func shows(_ row: RoomRow) -> Bool { row.post.level == .room || showAgentTalk }
}

/// Consecutive posts by one author within three minutes, drawn as one group.
public struct RoomGroup: Sendable, Equatable, Identifiable {
    /// The first row's id: a group only grows at its end, so its identity holds.
    public var id: String { rows[0].id }
    public var rows: [RoomRow]
    public var author: RoomAuthor { rows[0].post.author }
}

public enum RoomGrouping {
    public static let window: Int64 = 3 * 60 * 1000

    public static func groups(_ rows: [RoomRow], filter: RoomFilter) -> [RoomGroup] {
        var out: [RoomGroup] = []
        for row in rows where filter.shows(row) {
            if var last = out.last, sameAuthor(last.author, row.post.author), last.rows.last!.post.level == row.post.level,
                abs(row.post.at - last.rows.last!.post.at) <= window {
                last.rows.append(row)
                out[out.count - 1] = last
            } else {
                out.append(RoomGroup(rows: [row]))
            }
        }
        return out
    }

    static func sameAuthor(_ a: RoomAuthor, _ b: RoomAuthor) -> Bool {
        a.kind == b.kind && (a.id ?? a.name) == (b.id ?? b.name)
    }
}

/// What the view draws, decided here so a test can pin it.
public enum RoomPresentation {
    public struct KindLabel: Sendable, Equatable {
        public var text: String
        /// "needs you" takes the attention colour.
        public var attention: Bool
    }

    public static func kindLabel(_ post: RoomPost) -> KindLabel? {
        switch post.kind {
        case .working: KindLabel(text: "working on", attention: false)
        case .done: KindLabel(text: "done", attention: false)
        case .needs: KindLabel(text: "needs you", attention: true)
        case .handoff: KindLabel(text: "handoff", attention: false)
        case .message: nil
        }
    }

    /// "to <thread title>", when the post names a recipient the pond knows.
    public static func recipient(_ post: RoomPost, threads: [RoomThread]) -> String? {
        guard let to = post.toSessionId, !to.isEmpty else { return nil }
        let title = threads.first { $0.sessionId == to }?.title
        return "to \(title.flatMap { $0.isEmpty ? nil : $0 } ?? "a thread")"
    }

    public static func authorName(_ a: RoomAuthor) -> String {
        if !a.name.trimmingCharacters(in: .whitespaces).isEmpty { return a.name }
        switch a.kind {
        case .person: return "You"
        case .squeak: return "Squeak"
        case .agent: return "Agent"
        }
    }

    public static func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" }).prefix(2)
        let s = parts.compactMap { $0.first.map { String($0).uppercased() } }.joined()
        return s.isEmpty ? "?" : s
    }

    /// Own messages sit on the right, like the person's bubbles in a chat.
    public static func alignsRight(_ a: RoomAuthor) -> Bool { a.kind == .person }

    /// "now", "4m", "2h", "3d".
    public static func relativeTime(at: Int64, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince1970 - Double(at) / 1000))
        if s < 45 { return "now" }
        if s < 3600 { return "\(max(1, s / 60))m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    /// A chip's second line.
    public static func chipLine(_ t: RoomThread) -> String {
        t.workingOn ?? (t.state == .waiting ? "Needs you" : "Working")
    }

    /// The strip shows only threads that are working or waiting.
    public static func workingNow(_ threads: [RoomThread]) -> [RoomThread] {
        threads.filter { $0.state == .working || $0.state == .waiting }
    }
}
