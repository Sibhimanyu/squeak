import Foundation

/// Which reads an open chat polls for. A Squeak-run chat is pushed: its steps arrive as timeline events on the host's
/// stream, its model and status as host frames, and it has no daemon "extras" (no Conductor id), so nothing is polled
/// for it; the stream's own watchdog is the slow safety net. Other chats keep their polls.
public enum ChatPolling {
    /// The 3 s daemon extras read (model, stall, background work): only chats the daemon knows by a Conductor id.
    public static func pollsExtras(isNative: Bool, hasConductorId: Bool) -> Bool { !isNative && hasConductorId }

    /// The 2 s steps read while a turn works: not when the timeline feed carries the steps.
    public static func pollsActivity(usesTimeline: Bool, active: Bool, working: Bool) -> Bool { !usesTimeline && active && working }
}
