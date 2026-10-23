import Foundation

/// The four modifiers a double-tap can use or be spoilt by. Caps Lock, Fn and the numeric pad are not
/// modifiers here: they never take part in a shortcut and must not break one.
public struct TapModifiers: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let control = TapModifiers(rawValue: 1 << 0)
    public static let option = TapModifiers(rawValue: 1 << 1)
    public static let shift = TapModifiers(rawValue: 1 << 2)
    public static let command = TapModifiers(rawValue: 1 << 3)
}

/// Recognises a double-tap of one modifier from nothing but modifier flags and "some other key or
/// click happened". It never sees which key, so there is nothing here to log or leak.
///
/// A tap is the modifier pressed and released alone, held no longer than `maxPress`. Two taps fire when
/// the second press starts within `maxGap` of the first release; the shortcut fires on the second
/// release. Left and right keys are the same modifier. Any other modifier, key or click between the
/// taps, or during either one, spoils the attempt, so holding Control to use it as a modifier never fires.
public struct DoubleTapDetector: Sendable {
    public static let defaultMaxGap: TimeInterval = 0.35
    public static let defaultMaxPress: TimeInterval = 0.25

    public let modifier: TapModifiers
    public let maxGap: TimeInterval
    public let maxPress: TimeInterval

    private var flags: TapModifiers = []
    private var pressStart: TimeInterval?
    private var firstTapEnd: TimeInterval?
    /// Set when something else joined the press; stays until every modifier is up.
    private var spoilt = false

    public init(modifier: TapModifiers, maxGap: TimeInterval = defaultMaxGap, maxPress: TimeInterval = defaultMaxPress) {
        self.modifier = modifier
        self.maxGap = maxGap
        self.maxPress = maxPress
    }

    /// The modifier flags changed. Returns true when this release completes a double-tap.
    public mutating func flagsChanged(_ new: TapModifiers, at time: TimeInterval) -> Bool {
        if new == flags { return false }
        let old = flags
        flags = new

        if new.isEmpty {
            defer { pressStart = nil; spoilt = false }
            guard !spoilt, let start = pressStart, time - start <= maxPress, time >= start else {
                firstTapEnd = nil
                return false
            }
            if let first = firstTapEnd, start - first <= maxGap, start >= first {
                firstTapEnd = nil
                return true
            }
            firstTapEnd = time
            return false
        }

        if new == modifier, old.isEmpty {
            // A fresh press of the chosen modifier. A first tap that waited too long is dropped here.
            if let first = firstTapEnd, time - first > maxGap { firstTapEnd = nil }
            pressStart = time
            spoilt = false
            return false
        }
        if new != modifier { spoil() }
        return false
    }

    /// Some other key went down, or the mouse was clicked. Never says which.
    public mutating func otherInput() { spoil() }

    private mutating func spoil() {
        spoilt = true
        pressStart = nil
        firstTapEnd = nil
    }
}

/// What the Quick message shortcut can be. Stored under the `hotKey` default; "" means None.
public enum QuickShortcut {
    public static let doubleControl = "double-ctrl"
    public static let doubleOption = "double-opt"
    public static let controlShiftSpace = "ctrl-shift-space"
    public static let optionSpace = "opt-space"

    public static let defaultID = doubleControl
    public static let allIDs = [doubleControl, doubleOption, controlShiftSpace, optionSpace]

    public static func doubleTapModifier(id: String?) -> TapModifiers? {
        switch id {
        case doubleControl: .control
        case doubleOption: .option
        default: nil
        }
    }

    /// Double-taps need Input Monitoring. Without it, ⌃⇧ Space (Carbon, no permission) stands in.
    public static func effectiveID(chosen: String?, inputMonitoringGranted: Bool) -> String? {
        if doubleTapModifier(id: chosen) != nil, !inputMonitoringGranted { return controlShiftSpace }
        return chosen
    }
}

/// What is stored under the `hotKey` default: no value means the default, "" means the user chose None.
public enum HotKeyPreference {
    public static let migrationKey = "hotKeyMovedToDoubleTap"

    /// The shortcut id to use at launch. Before the one-time move, everything except ⌃⇧ Space and None
    /// (the old default ⌥ Space and the presets that were removed) becomes the new default; after it,
    /// ⌥ Space is an ordinary choice again. An id no longer in the list also falls back to the default.
    public static func resolve(stored: String?, alreadyMigrated: Bool) -> String? {
        guard let stored else { return QuickShortcut.defaultID }
        if stored.isEmpty { return nil }
        if !alreadyMigrated, stored != QuickShortcut.controlShiftSpace { return QuickShortcut.defaultID }
        return QuickShortcut.allIDs.contains(stored) ? stored : QuickShortcut.defaultID
    }

    public static func storedValue(for id: String?) -> String { id ?? "" }
}
