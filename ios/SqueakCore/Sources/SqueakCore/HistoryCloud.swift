import Foundation

/* "History cache" Layer 2 (docs/remote-channel.md), the device side: the Mac keeps a sealed copy of its recent chats in
   Squeak's cloud (`channels/<id>/hist/`, the Mac's history-cloud.ts). It is sealed with the channel key like every other
   document, so a phone opens it with the key it already holds. An index (`idx`) names each chat's pages; a page is
   `<handle>-<first entry id>`. A device reads it when the Mac cannot answer (asleep, off) or when it has nothing of the chat
   yet (a new phone), puts what it reads into the same `ChatHistoryState` the Mac's delta fills, and the Mac catches the
   rest up when it wakes (the cursors are the same entry ids, so nothing is repeated). */

public struct HistoryCloudIndex: Codable, Equatable, Sendable {
    public struct PageRef: Codable, Equatable, Sendable {
        /// The id of the page's first entry.
        public let f: String
        /// The page's last entry time (ms); 0 when undated.
        public let t: Double
        public init(f: String, t: Double = 0) { self.f = f; self.t = t }
    }
    public struct Chat: Codable, Equatable, Sendable {
        public let key: String
        /// Oldest first.
        public let pages: [PageRef]
        /// The id of the newest entry held in the cloud.
        public let newest: String
        /// The chat's first message is in the oldest page.
        public let complete: Bool
        public let act: Double
        public init(key: String, pages: [PageRef], newest: String, complete: Bool, act: Double = 0) {
            self.key = key; self.pages = pages; self.newest = newest; self.complete = complete; self.act = act
        }
    }
    public let v: Int
    public let chats: [Chat]
    public var seq: Int64? = nil
    public var at: Double? = nil
    public init(v: Int = 1, chats: [Chat], seq: Int64? = nil, at: Double? = nil) { self.v = v; self.chats = chats; self.seq = seq; self.at = at }

    public func chat(_ key: String) -> Chat? { chats.first { $0.key == key } }
}

public struct HistoryCloudPage: Codable, Equatable, Sendable {
    public let v: Int
    public let key: String
    public let first: String
    /// Oldest first.
    public let entries: [LiveTurn.HistoryEntry]
    public var seq: Int64? = nil
    public init(v: Int = 1, key: String, first: String, entries: [LiveTurn.HistoryEntry], seq: Int64? = nil) {
        self.v = v; self.key = key; self.first = first; self.entries = entries; self.seq = seq
    }
}

public enum HistoryCloud {
    /// The kind the Mac writes under, and the index's document id.
    public static let kind = "hist"
    public static let indexDoc = "idx"

    /// The page's document id: the chat's handle (as for a live document), `-`, the first entry's id.
    public static func pageDoc(for key: String, first: String) -> String { "\(LiveTurn.handle(for: key))-\(first)" }

    /// The pages worth reading for a chat of which `held` is already on the device: all of them when nothing is held,
    /// else those from the one that holds (or follows) the newest held entry. Empty when the cloud has nothing newer.
    public static func pagesToRead(held: ChatHistoryState?, chat: HistoryCloudIndex.Chat) -> [HistoryCloudIndex.PageRef] {
        guard !chat.pages.isEmpty else { return [] }
        guard let newest = held?.newestCursor else { return chat.pages }
        guard isNewer(chat.newest, than: newest) else { return [] }
        guard let top = newest.cursorValue else { return chat.pages }
        // The page holding the held newest entry is the last whose first entry is not after it.
        let start = chat.pages.lastIndex { ($0.f.cursorValue ?? .max) <= top } ?? 0
        return Array(chat.pages[start...])
    }

    /// Whether cursor `a` is after `b`. Cursors are digit strings that only grow within a chat; two that do not parse
    /// are never "newer" (the caller then falls back on the Mac).
    public static func isNewer(_ a: String, than b: String) -> Bool {
        guard let x = a.cursorValue, let y = b.cursorValue else { return false }
        return x > y
    }
}

extension String {
    /// A cursor as a number (digits only), else nil.
    var cursorValue: UInt64? { isEmpty || !allSatisfy(\.isASCII) || !allSatisfy(\.isNumber) ? nil : UInt64(self) }
}

extension ChatHistoryState {
    /// What the cloud copy brings (`pages`, oldest first, from `HistoryCloud.pagesToRead`). It lands like the Mac's live push:
    /// over the tail, and where it does not reach back to what was held a gap is recorded for the Mac's catch-up when it
    /// answers. Nothing held and the pages start the chat: the chat is complete. A copy that is not newer than what is
    /// held is ignored (the phone read the Mac live after the cloud copy was made). True when the state changed.
    @discardableResult
    public mutating func mergeCloud(_ pages: [HistoryCloudPage], chat: HistoryCloudIndex.Chat) -> Bool {
        let incoming = pages.flatMap(\.entries).filter { $0.id != nil }
        guard !incoming.isEmpty, let last = incoming.last?.id else { return false }
        if let newest = newestCursor {
            guard HistoryCloud.isNewer(last, than: newest) else { return false }
        }
        let before = self
        let wasEmpty = entries.isEmpty
        mergeLatest(incoming)
        if wasEmpty, chat.complete, pages.first?.first == chat.pages.first?.f {
            complete = true
            nextBefore = nil
        }
        return self != before
    }
}
