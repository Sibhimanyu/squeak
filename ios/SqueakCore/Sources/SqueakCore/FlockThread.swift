import Foundation

/// One pond member's thread, as the Mac reduces it from the pond's events (src/remote/flock-thread.ts): written sealed
/// into `live` only while this phone's presence names the thread (`flock`), deleted when it leaves. Read and message
/// only: an approval is shown and stays with the starter's Mac.
public struct FlockThreadDoc: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable, Identifiable {
        public let id: Int
        /// "user", "agent", "thinking", "tool", "question" or "approval".
        public let role: String
        public let text: String
        /// Who a user row came from.
        public var by: String? = nil
        /// A tool that finished, a question or approval that was answered or withdrawn.
        public var done: Bool? = nil

        public init(id: Int, role: String, text: String, by: String? = nil, done: Bool? = nil) {
            self.id = id; self.role = role; self.text = text; self.by = by; self.done = done
        }
    }

    public struct Access: Codable, Equatable, Sendable {
        public let canMessage: Bool
        public var reason: String? = nil
        public init(canMessage: Bool, reason: String? = nil) { self.canMessage = canMessage; self.reason = reason }
    }

    public let v: Int
    public let pond: String
    public let thread: String
    public let title: String
    public let by: String
    public let state: String
    public let mode: String
    public var poweredBy: String? = nil
    public var locked: Bool? = nil
    public let access: Access
    public let entries: [Entry]
    public var seq: Int64? = nil

    public init(v: Int = 1, pond: String, thread: String, title: String, by: String, state: String, mode: String,
                poweredBy: String? = nil, locked: Bool? = nil, access: Access, entries: [Entry], seq: Int64? = nil) {
        self.v = v; self.pond = pond; self.thread = thread; self.title = title; self.by = by; self.state = state
        self.mode = mode; self.poweredBy = poweredBy; self.locked = locked; self.access = access; self.entries = entries; self.seq = seq
    }

    /// The `live` document id: the Mac's `flockThreadDoc` (the thread id hashed like a session key, under `flock:`).
    public static func doc(for threadId: String) -> String { LiveTurn.handle(for: "flock:" + threadId) + "-f" }

    /// What the footer under the composer says: nothing when this person may message, else the Mac's calm reason.
    public var readOnlyReason: String? {
        access.canMessage ? nil : (access.reason ?? "You can read this thread but not message it.")
    }
}
