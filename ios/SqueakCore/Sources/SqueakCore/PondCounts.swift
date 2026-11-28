import Foundation

/// The pond dashboard's numbers. The Mac decides them (`counts` of the phone's pond view); the phone only draws, and counts
/// its own chats with `fallback` when an older Mac sends none. Same definitions as `src/fleet/pond-counts.ts`: open,
/// working (open ducks mid-turn), needs you (open ducks waiting on the person), closed and the total.
public struct PondCounts: Codable, Equatable, Sendable {
    public var open: Int
    public var working: Int
    public var needsYou: Int
    public var closed: Int
    public var total: Int

    public init(open: Int, working: Int, needsYou: Int, closed: Int, total: Int) {
        self.open = open; self.working = working; self.needsYou = needsYou; self.closed = closed; self.total = total
    }

    private enum CodingKeys: String, CodingKey { case open, working, needsYou, closed, total }
    /// What an older Mac called the open and closed numbers.
    private enum OlderKeys: String, CodingKey { case onDuty, offDuty }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let older = try decoder.container(keyedBy: OlderKeys.self)
        open = try c.decodeIfPresent(Int.self, forKey: .open) ?? older.decode(Int.self, forKey: .onDuty)
        working = try c.decode(Int.self, forKey: .working)
        needsYou = try c.decode(Int.self, forKey: .needsYou)
        closed = try c.decodeIfPresent(Int.self, forKey: .closed) ?? older.decode(Int.self, forKey: .offDuty)
        total = try c.decode(Int.self, forKey: .total)
    }

    public static let zero = PondCounts(open: 0, working: 0, needsYou: 0, closed: 0, total: 0)

    /// One duck per `duckId` (its newest chat speaks for it), else one per chat; a chat with no `duckClosed` is open.
    public static func fallback(sessions: [PhoneSnapshot.Session]) -> PondCounts {
        var ducks: [String: PhoneSnapshot.Session] = [:]
        for s in sessions {
            let key = s.duckId ?? s.key
            let at = ISO8601DateFormatter.squeakParse(s.lastActivityAt) ?? .distantPast
            if let seen = ducks[key], (ISO8601DateFormatter.squeakParse(seen.lastActivityAt) ?? .distantPast) >= at { continue }
            ducks[key] = s
        }
        var c = PondCounts.zero
        for s in ducks.values {
            c.total += 1
            if s.isClosed { c.closed += 1; continue }
            c.open += 1
            if s.needsYou { c.needsYou += 1 } else if s.state == "working" { c.working += 1 }
        }
        return c
    }

    /// The Mac's numbers when it sent them, else this phone's own.
    public static func resolve(_ sent: PondCounts?, sessions: [PhoneSnapshot.Session]) -> PondCounts {
        sent ?? fallback(sessions: sessions)
    }
}

extension PhoneSnapshot.Session {
    /// Its duck is closed (the Mac sends `duckClosed: true`); absent = open.
    public var isClosed: Bool { duckClosed == true || duckDuty == "off" }
}
