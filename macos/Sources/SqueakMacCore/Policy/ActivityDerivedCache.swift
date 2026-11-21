import Foundation

/// What the transcript and dock derive from the running turn's steps, computed once per change of the steps instead of
/// once per body pass. The key is the steps themselves: an array equals its own previous value in O(1) while its storage
/// is untouched (the host publishes a new array only on change), and exactly, element by element, when it was replaced, so
/// a step edited in place (a tool going from running to done) always recomputes and nothing is ever served stale.
public final class ActivityDerivedCache {
    public private(set) var computeCount = 0
    private var steps: [ActivityStep]?
    private var shown: [ActivityStep] = []
    private var progress: ToolDetail?
    private var blocks: [Bool: TurnBlock] = [:]
    private var startKey: StartKey?
    private var start: Date?

    private struct StartKey: Equatable { var count: Int; var first: String?; var last: String? }

    public init() {}

    private func refresh(_ new: [ActivityStep]) {
        if let steps, steps == new { return }
        computeCount += 1
        steps = new
        shown = new.filter { $0.kind != "progress" && $0.kind != "retry" }
        progress = new.last(where: { $0.kind == "progress" })?.detail
        blocks = [:]
        startKey = nil
    }

    /// The steps without progress and retry notes: the live row's and the running turn's list.
    public func listed(_ activity: [ActivityStep]) -> [ActivityStep] { refresh(activity); return shown }

    /// The newest progress update's detail (the tracker), nil when there is none.
    public func progressDetail(_ activity: [ActivityStep]) -> ToolDetail? { refresh(activity); return progress }

    public func block(_ activity: [ActivityStep], working: Bool) -> TurnBlock {
        refresh(activity)
        if let b = blocks[working] { return b }
        let b = TurnFolding.block(steps: activity, working: working)
        blocks[working] = b
        return b
    }

    /// The working row's clock start; re-read when the steps or the chat's first/last message ids change.
    public func turnStart(messages: [ChatMessage], activity: [ActivityStep]) -> Date? {
        refresh(activity)
        let key = StartKey(count: messages.count, first: messages.first?.id, last: messages.last?.id)
        if startKey == key { return start }
        startKey = key
        start = TurnFolding.turnStart(messages: messages, steps: activity)
        return start
    }
}
