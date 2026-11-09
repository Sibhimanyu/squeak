import Foundation

/// One turn's expand state: ⌃O (global) and the turn's own "Expand all / Collapse all" both land here, so the
/// button's label always says what the next press does. `version` changes on every command; rows follow `open`
/// when it does, and a row's own toggle is untouched in between.
public struct TurnExpansion: Equatable, Sendable {
    public private(set) var open: Bool
    public private(set) var version: Int
    private var seenGlobal: Int

    public init(open: Bool = false, version: Int = 0, seenGlobal: Int = 0) {
        self.open = open
        self.version = version
        self.seenGlobal = seenGlobal
    }

    /// The turn's own button: flips this turn only.
    public mutating func toggleTurn() {
        open.toggle()
        version += 1
    }

    /// ⌃O: every turn is set to `allOpen`. A repeated generation is ignored.
    public mutating func applyGlobal(generation: Int, allOpen: Bool) {
        guard generation != seenGlobal else { return }
        seenGlobal = generation
        open = allOpen
        version += 1
    }
}
