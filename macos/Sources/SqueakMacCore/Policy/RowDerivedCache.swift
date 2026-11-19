import Foundation

/// What a transcript's body derives from its rows alone (ids, turn ids, the pictures its prompts carry), computed once per
/// rows change instead of once per body pass. The key is `ChatRowsCache.generation` (it moves exactly when the rows are
/// rebuilt), so a streaming tick that leaves the rows alone reads these in O(1).
public final class RowDerivedCache {
    public struct Derived: Sendable {
        public var rowIDs: [String]
        public var turnIDs: [String?]
        /// Each row's (turn id, is an agent message): what `TurnFolding.folds` reads.
        public var foldRows: [(String?, Bool)]
        public var attached: [String]
    }

    public private(set) var computeCount = 0
    private var generation: Int?
    private var cached = Derived(rowIDs: [], turnIDs: [], foldRows: [], attached: [])

    public init() {}

    public func derived(rows: [ChatTimeline.Row], generation: Int) -> Derived {
        if self.generation == generation { return cached }
        computeCount += 1
        self.generation = generation
        cached = Derived(
            rowIDs: rows.map(\.id),
            turnIDs: rows.map { if case .message(let m, _) = $0 { m.turnId } else { nil } },
            foldRows: rows.map { if case .message(let m, _) = $0 { (m.turnId, m.role == .assistant) } else { (nil, false) } },
            attached: PictureLayout.attachedPaths(inTexts: rows.compactMap { if case .message(let m, _) = $0, m.role == .user { m.text } else { nil } }))
        return cached
    }
}
