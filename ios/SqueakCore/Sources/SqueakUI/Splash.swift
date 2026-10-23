import Foundation

/// When the launch splash (the duck, while the first fresh view loads from the Mac) is up.
enum Splash {
    /// Longest it stays without a fresh view; then the last known state shows, as before.
    static let cap: TimeInterval = 2.5
    /// A return from the background shows it again only after this long away.
    static let returnAfter: TimeInterval = 300

    /// `freshSince` is nil until a view from the Mac has arrived since the splash began, else whether it has.
    static func shows(paired: Bool, suppressed: Bool, freshSince: Bool?, elapsed: TimeInterval) -> Bool {
        paired && !suppressed && freshSince != true && elapsed < cap
    }

    static func returnShows(away: TimeInterval) -> Bool { away > returnAfter }
}
