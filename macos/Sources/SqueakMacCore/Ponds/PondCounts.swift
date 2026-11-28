import Foundation

/// The pond dashboard's numbers. The daemon decides them (`counts` of `GET /native/projects/<id>/ducks`, from
/// `src/fleet/pond-counts.ts`); the page only draws them, over exactly the rows the same answer lists. Open, working (open ducks mid-turn), needs you (open ducks waiting on the person), closed, total.
public struct PondCounts: Sendable, Equatable, Decodable {
    public var open: Int
    public var working: Int
    public var needsYou: Int
    public var closed: Int
    public var total: Int

    public init(open: Int, working: Int, needsYou: Int, closed: Int, total: Int) {
        self.open = open; self.working = working; self.needsYou = needsYou; self.closed = closed; self.total = total
    }

    private enum CodingKeys: String, CodingKey { case open, working, needsYou, closed, total }
    /// What an older daemon called the open and closed numbers.
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

    /// Before the host has answered: nothing is listed, so nothing is counted.
    public static let none = PondCounts(open: 0, working: 0, needsYou: 0, closed: 0, total: 0)

    public func count(_ scope: PondDashboardScope) -> Int {
        switch scope {
        case .open: open
        case .working: working
        case .needsYou: needsYou
        case .closed: closed
        case .all, .shared: total
        }
    }

    /// The small second line of a tile: Closed says how many ducks there are in all.
    public static func secondary(_ scope: PondDashboardScope, _ counts: PondCounts) -> String? {
        scope == .closed ? "\(counts.total) in all" : nil
    }
}
