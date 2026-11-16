import Foundation

/// A pond's or stream's status at a glance. The Mac decides it (`activity`, `working`, `needsYou` on a pond and on
/// each of its streams in the phone view; needs you, then working, then error, else idle) and the phone only draws
/// it; an older Mac sends none, so the phone folds the chats it has with the same precedence.
public struct StatusRollup: Equatable, Sendable {
    public enum Activity: String, Sendable { case working, needsYou = "needs_you", error, idle }
    public var activity: Activity
    public var working: Int
    public var needsYou: Int

    public init(activity: Activity, working: Int = 0, needsYou: Int = 0) {
        self.activity = activity; self.working = working; self.needsYou = needsYou
    }

    /// The Mac's own word; nil when absent or one this phone does not know (then it folds the chats).
    public init?(activity: String?, working: Int?, needsYou: Int?) {
        guard let a = activity.flatMap(Activity.init(rawValue:)) else { return nil }
        self.init(activity: a, working: working ?? 0, needsYou: needsYou ?? 0)
    }

    /// The same rule as the daemon's `rollupStatus`: a chat waiting on you, else working (a running duckling counts),
    /// else failed.
    public init(sessions: [PhoneSnapshot.Session]) {
        var working = 0, waiting = 0, failed = 0
        for s in sessions {
            if s.needsYou { waiting += 1 }
            else if s.state == "working" || (s.ducklings?.running ?? 0) > 0 { working += 1 }
            else if s.state == "error" { failed += 1 }
        }
        self.init(activity: waiting > 0 ? .needsYou : working > 0 ? .working : failed > 0 ? .error : .idle,
                  working: working, needsYou: waiting)
    }

    /// "greenroom, 1 working, 1 needs you"; just the name when nothing is going on.
    public func label(for name: String) -> String {
        var parts = [name]
        if working > 0 { parts.append("\(working) working") }
        if needsYou > 0 { parts.append("\(needsYou) needs you") }
        if parts.count == 1, activity == .error { parts.append("failed") }
        return parts.joined(separator: ", ")
    }

    /// What a pond row shows in the count's slot.
    public enum Mark: Equatable, Sendable { case needsYou(Int), working, error }

    /// Needs you (with its count) wins, then working, then error; idle shows nothing here (the row keeps its count).
    public var mark: Mark? {
        switch activity {
        case .needsYou: .needsYou(max(needsYou, 1))
        case .working: .working
        case .error: .error
        case .idle: nil
        }
    }
}
