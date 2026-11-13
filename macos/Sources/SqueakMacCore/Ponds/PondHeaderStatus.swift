import Foundation

// What a pond's dashboard says about its own state, decided here so the page never changes height because of it.
// The persistent fact (this Mac cannot start threads in the pond) is one fixed line with an info mark; "refreshing" is a
// small mark in a fixed slot, drawn only for a read the person started or one that is slow; nothing is a row that comes
// and goes above the cards.

/// Which reads are in flight, and since when. A background refresh (the minute's poll, the host's change stream) is
/// quiet until it has taken longer than `quietFor`; a read the person started (Try again, an action) shows at once.
public struct PondReadTracker: Sendable, Equatable {
    public struct Read: Sendable, Equatable {
        public var since: Date
        public var byPerson: Bool
    }

    /// A background read shows its mark only after this long.
    public static let quietFor: TimeInterval = 1

    public private(set) var reads: [String: Read] = [:]

    public init() {}

    public mutating func begin(_ id: String, byPerson: Bool, now: Date = Date()) {
        if var read = reads[id] {
            read.byPerson = read.byPerson || byPerson
            reads[id] = read
        } else {
            reads[id] = Read(since: now, byPerson: byPerson)
        }
    }

    public mutating func end(_ id: String) { reads[id] = nil }

    /// A read is in flight, shown or not.
    public func isReading(_ id: String) -> Bool { reads[id] != nil }

    /// A read is in flight and the person should see a mark for it.
    public func isShown(_ id: String, now: Date = Date()) -> Bool {
        guard let read = reads[id] else { return false }
        return read.byPerson || now.timeIntervalSince(read.since) > Self.quietFor
    }

    /// When a quiet read becomes visible (so a view can look again then); nil when it already shows or nothing reads.
    public func showsAt(_ id: String) -> Date? {
        guard let read = reads[id], !read.byPerson else { return nil }
        return read.since.addingTimeInterval(Self.quietFor)
    }
}

/// The mark in the header's fixed slot.
public enum PondHeaderIndicator: Sendable, Equatable {
    case none
    /// A read the person started, or a slow one: the working mark, faded in.
    case refreshing
    /// The pond could not be reached; the sentence is the hover text.
    case problem(help: String)
    /// Nothing to show and a way to read again.
    case retry(help: String)
}

public struct PondHeaderStatus: Sendable, Equatable {
    /// One line under the pond's name; never wraps (the header's height does not depend on it).
    public var accessLine: String
    /// The sentence behind an info mark on that line (hover), when there is one.
    public var info: String?
    public var indicator: PondHeaderIndicator

    /// The short line shown in place of the long sentence when this Mac cannot start threads in the pond.
    public static let shareOnlyLine = "Threads can only be shared into this pond"

    /// `access`: the line for an ordinary pond (role, people). `offer`: what the Start button may do here.
    /// `readShown`: `PondReadTracker.isShown` for this pond.
    public static func make(access: String, local: Bool, offer: PondStartThread?, freshness: PondFreshness, readShown: Bool) -> PondHeaderStatus {
        var line = access
        var info: String?
        if !local, case .shareOnly(let why)? = offer {
            line = shareOnlyLine
            info = why
        }
        let indicator: PondHeaderIndicator
        switch freshness {
        case .live: indicator = .none
        case .reading, .refreshing: indicator = readShown ? .refreshing : .none
        case .couldntRead: indicator = .retry(help: freshness.line ?? "")
        case .offline, .stale: indicator = .problem(help: [freshness.line, freshness.writesDisabledReason].compactMap { $0 }.joined(separator: " "))
        }
        return PondHeaderStatus(accessLine: line, info: info, indicator: indicator)
    }
}
