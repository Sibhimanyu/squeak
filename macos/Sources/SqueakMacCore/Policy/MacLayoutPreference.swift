import Foundation
import Observation

// Settings > This Mac > General > "New layout" (DESIGN.md "New layout"): the redesigned window (Duck avatar row, Pond
// panel in the Room, restyled Pond rows) behind one switch, off by default. Every view reads it through
// `MacLayoutPreference.shared.isNew`, never from UserDefaults directly, so the old layout is one flag away.

@MainActor @Observable
public final class MacLayoutPreference {
    public static let defaultsKey = "newLayout"
    public static let shared = MacLayoutPreference()

    @ObservationIgnored private let defaults: UserDefaults

    /// True when the person turned the new layout on. Persisted on every change.
    public var isNew: Bool {
        didSet { if isNew != oldValue { defaults.set(isNew, forKey: Self.defaultsKey) } }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.isNew = defaults.bool(forKey: Self.defaultsKey)
    }
}
