import Foundation

/// The pond dashboard's numbers. The daemon decides them (`counts` of `GET /native/projects/<id>/ducks`, from
/// `src/fleet/pond-counts.ts`); the page only draws them, over exactly the rows the same answer lists. On duty, working (on-duty ducks mid-turn), needs you (on-duty ducks waiting on the person), off duty, total.
public struct PondCounts: Sendable, Equatable, Decodable {
    public var onDuty: Int
    public var working: Int
    public var needsYou: Int
    public var offDuty: Int
    public var total: Int

    public init(onDuty: Int, working: Int, needsYou: Int, offDuty: Int, total: Int) {
        self.onDuty = onDuty; self.working = working; self.needsYou = needsYou; self.offDuty = offDuty; self.total = total
    }

    /// Before the host has answered: nothing is listed, so nothing is counted.
    public static let none = PondCounts(onDuty: 0, working: 0, needsYou: 0, offDuty: 0, total: 0)

    public func count(_ scope: PondDashboardScope) -> Int {
        switch scope {
        case .onDuty: onDuty
        case .working: working
        case .needsYou: needsYou
        case .offDuty: offDuty
        case .all, .shared: total
        }
    }

    /// The small second line of a tile: Off duty says how many ducks there are in all.
    public static func secondary(_ scope: PondDashboardScope, _ counts: PondCounts) -> String? {
        scope == .offDuty ? "\(counts.total) in all" : nil
    }
}
