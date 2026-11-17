import Foundation

/// How a status word read off a chat's live stream lands on the row the catalog already holds.
///
/// The stream says "idle" for any chat with no turn running, and says it again on every reconnect (the Mac coming back
/// from sleep or another Space reopens the stream and the first status is "idle"). The catalog is the one that knows
/// whether a turn ever ended (`lastTurnEndedAt`): "finished" is "idle" with a turn behind it. So a stream "idle" never
/// takes a "finished" row back to "idle" (that flashed Finished, Idle, Finished on every return to the window); the
/// next catalog read stays the authority for anything else.
public enum HostStatusMerge {
    public static func next(current: SessionState, fromStream stream: SessionState) -> SessionState {
        if stream == .idle, current == .finished { return .finished }
        return stream
    }
}
