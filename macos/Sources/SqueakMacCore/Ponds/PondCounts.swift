import Foundation

/// The pond dashboard's numbers. The daemon decides them (`counts` of `GET /native/projects/<id>/ducks`, from
/// `src/fleet/pond-counts.ts`); the page only draws, and counts the listed rows itself with `fallback` when an older daemon
/// sends none. On duty, working (on-duty ducks mid-turn), needs you (on-duty ducks waiting on the person), off duty, total.
public struct PondCounts: Sendable, Equatable, Decodable {
    public var onDuty: Int
    public var working: Int
    public var needsYou: Int
    public var offDuty: Int
    public var total: Int

    public init(onDuty: Int, working: Int, needsYou: Int, offDuty: Int, total: Int) {
        self.onDuty = onDuty; self.working = working; self.needsYou = needsYou; self.offDuty = offDuty; self.total = total
    }

    /// The same definitions over the page's rows (a row without a duty is on duty).
    public static func fallback(rows: [PondChatRow]) -> PondCounts {
        let on = rows.filter(\.onDuty)
        return PondCounts(
            onDuty: on.count, working: on.filter { PondDashboardScope.working.includes($0) }.count,
            needsYou: on.filter { PondDashboardScope.needsYou.includes($0) }.count,
            offDuty: rows.count - on.count, total: rows.count)
    }

    /// The daemon's numbers when it sent them, else the rows'.
    public static func resolve(_ sent: PondCounts?, rows: [PondChatRow]) -> PondCounts { sent ?? fallback(rows: rows) }

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
