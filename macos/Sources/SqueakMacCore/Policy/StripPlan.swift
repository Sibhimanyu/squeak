import Foundation

/// One tab of the strip as it is drawn: a saved thread, or the New chat placeholder.
public enum StripEntry: Hashable, Sendable {
    case thread(String)
    case placeholder
}

/// Which tab is selected and where the New chat placeholder sits, given where the centre is. The saved tabs are the
/// `TabStore`'s and are never added to here: the strip is the same on a chat and on a New thread page, where the page is
/// a selected placeholder beside the tabs. A chat on screen without a tab shows none; Squeak does not add tabs by itself.
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
            return StripPlan(entries: entries, selected: .thread(key.stringValue))
        default:
            return StripPlan(entries: entries, selected: nil)
        }
    }
}
