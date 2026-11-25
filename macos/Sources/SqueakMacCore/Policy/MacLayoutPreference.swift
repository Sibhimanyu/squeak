import Foundation
import Observation

// Settings > This Mac > General > "Classic layout" (DESIGN.md 8.12): the redesigned window (Duck avatar row, Pond
// panel in the Room, restyled Pond rows) is the default; the earlier layout is an option. Every view reads it through
// `MacLayoutPreference.shared.isNew`, never from UserDefaults directly.
//
// Storage keeps the original boolean key `newLayout`, written only when the person changes the setting, so "never
// chose" (key absent) is distinguishable: absent -> new, an explicit true stays new, an explicit false (they turned the
// new layout off after trying it) stays classic.

@MainActor @Observable
public final class MacLayoutPreference {
    public static let defaultsKey = "newLayout"
    public static let shared = MacLayoutPreference()

    @ObservationIgnored private let defaults: UserDefaults

    /// True for the new layout (the default). False only when the person chose the classic layout. Persisted on every change.
    public var isNew: Bool {
        didSet { if isNew != oldValue { defaults.set(isNew, forKey: Self.defaultsKey) } }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.isNew = (defaults.object(forKey: Self.defaultsKey) as? Bool) ?? true
    }
}
