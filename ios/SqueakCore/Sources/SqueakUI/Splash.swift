import Foundation

/// When the launch splash (the duck, while the first fresh view loads from the Mac) is up.
enum Splash {
    /// Longest it stays without a fresh view; then the last known state shows, as before.
    static let cap: TimeInterval = 2.5
    /// A return from the background shows it again only after this long away.
    static let returnAfter: TimeInterval = 300

    /// `freshSince` is nil until a view from the Mac has arrived since the splash began, else whether it has.
    /// `hasSaved`: the last view is already on screen from disk, so there is nothing to wait behind.
    static func shows(paired: Bool, suppressed: Bool, freshSince: Bool?, elapsed: TimeInterval, hasSaved: Bool = false) -> Bool {
        paired && !suppressed && !hasSaved && freshSince != true && elapsed < cap
    }

    static func returnShows(away: TimeInterval) -> Bool { away > returnAfter }

    /// What a return from the background shows. The old view is on screen already, so after a long absence it stays
    /// and says it is updating (like a cold launch with a saved view); the splash is only for a phone with nothing to show.
    enum Return: Equatable { case nothing, updating, splash }

    static func returnView(away: TimeInterval, hasView: Bool) -> Return {
        guard returnShows(away: away) else { return .nothing }
        return hasView ? .updating : .splash
    }
}
