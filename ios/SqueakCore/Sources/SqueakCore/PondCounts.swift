import Foundation

/// The pond dashboard's numbers. The Mac decides them (`counts` of the phone's pond view); the phone only draws, and counts
/// its own chats with `fallback` when an older Mac sends none. Same definitions as `src/fleet/pond-counts.ts`: on duty,
/// working (on-duty ducks mid-turn), needs you (on-duty ducks waiting on the person), off duty and the total.
public struct PondCounts: Codable, Equatable, Sendable {
    public var onDuty: Int
    public var working: Int
    public var needsYou: Int
    public var offDuty: Int
    public var total: Int

    public init(onDuty: Int, working: Int, needsYou: Int, offDuty: Int, total: Int) {
        self.onDuty = onDuty; self.working = working; self.needsYou = needsYou; self.offDuty = offDuty; self.total = total
    }

    public static let zero = PondCounts(onDuty: 0, working: 0, needsYou: 0, offDuty: 0, total: 0)

    /// One duck per `duckId` (its newest chat speaks for it), else one per chat; a chat with no `duckDuty` is on duty.
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
            if s.isOffDuty { c.offDuty += 1; continue }
            c.onDuty += 1
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
    /// Its duck is off duty (the Mac sends `duckDuty: "off"`); absent = on duty.
    public var isOffDuty: Bool { duckDuty == "off" }
}
