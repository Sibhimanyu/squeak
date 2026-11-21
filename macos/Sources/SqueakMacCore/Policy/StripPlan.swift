import Foundation

/// One tab of the strip as it is drawn: a saved thread, or the New chat placeholder.
public enum StripEntry: Hashable, Sendable {
    case thread(String)
    case placeholder
}

/// Which thread tabs the strip shows and which is selected, given where the centre is. The strip is the same on a
/// chat and on a New thread page in its workspace: the page is a selected placeholder beside the chats, and the chat
/// that is open always has its tab (even before the list carries it), so a start never shows the old set alone.
public struct StripPlan: Equatable, Sendable {
    public var entries: [StripEntry]
    public var selected: StripEntry?

    /// `threads` are the workspace's saved thread tabs in order; `previous` is the chat the transcript follows.
    public static func plan(location: WorkbenchLocation, previous: String?, threads: [String]) -> StripPlan {
        var entries = threads.map(StripEntry.thread)
        func insert(_ e: StripEntry) {
            if let previous, let at = threads.firstIndex(of: previous) { entries.insert(e, at: at + 1) } else { entries.append(e) }
        }
        switch location {
        case .compose(.newThread, _, _):
            insert(.placeholder)
            return StripPlan(entries: entries, selected: .placeholder)
        case .chat(let key):
            let id = key.stringValue
            if !threads.contains(id) { insert(.thread(id)) }
            return StripPlan(entries: entries, selected: .thread(id))
        default:
            return StripPlan(entries: entries, selected: nil)
        }
    }
}
