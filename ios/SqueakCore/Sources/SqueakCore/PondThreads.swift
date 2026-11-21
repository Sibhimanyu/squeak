import CryptoKit
import Foundation

/// A pond's whole thread list (src/remote/pond-threads.ts): written by the Mac, sealed, only while this phone has that
/// pond open (its presence names the pond and `pondthreads`), deleted when it leaves. Already grouped and ordered by the
/// Mac (Main first, then streams newest first, threads newest first inside): the phone only draws.
public struct PondThreads: Codable, Equatable, Sendable {
    public struct Thread: Codable, Equatable, Sendable, Identifiable {
        public let key: String
        public let title: String
        public let state: String
        public let at: String
        /// The initial of who started it, when the Mac says (absent today).
        public var who: String? = nil
        /// Ducks own their branch (flag on): the thread's duck, the branch it works on, or `main` for the pond's own folder.
        public var duckId: String? = nil
        public var branch: String? = nil
        public var main: Bool? = nil

        public var id: String { key }
        public var date: Date? { ISO8601DateFormatter.squeakParse(at) }

        public init(key: String, title: String, state: String, at: String, who: String? = nil,
                    duckId: String? = nil, branch: String? = nil, main: Bool? = nil) {
            self.key = key; self.title = title; self.state = state; self.at = at; self.who = who
            self.duckId = duckId; self.branch = branch; self.main = main
        }

        /// A bare session for a thread the phone's view does not carry (an older one): enough to draw its row and open
        /// it for history, nothing the Mac did not say. The phone's own copy wins when the view has the thread.
        public var asSession: PhoneSnapshot.Session {
            var session = PhoneSnapshot.Session(
                key: key, conductorSessionId: nil, label: title, agent: "claude", state: state, lastActivityAt: at,
                detail: nil, git: nil, contextPercent: nil, turnId: nil, message: nil, choices: nil, title: title)
            session.duckId = duckId; session.branch = branch; session.onMain = main
            return session
        }
    }

    public struct Stream: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// The pond's own folder: Main.
        public var main: Bool? = nil
        public let threads: [Thread]

        public init(id: String, name: String, main: Bool? = nil, threads: [Thread]) {
            self.id = id; self.name = name; self.main = main; self.threads = threads
        }
    }

    /// Another member's thread in this pond (read-only here: it runs on their Mac). `poweredBy` marks one a member runs with
    /// their own agent ("Powered by <their Mac> · Flotilla"). Absent from an older Mac.
    public struct FlockThread: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let state: String
        public let at: String
        public let by: String
        public let mode: String
        public var poweredBy: String? = nil
        public var locked: Bool? = nil

        public var date: Date? { ISO8601DateFormatter.squeakParse(at) }

        public init(id: String, title: String, state: String, at: String, by: String, mode: String, poweredBy: String? = nil, locked: Bool? = nil) {
            self.id = id; self.title = title; self.state = state; self.at = at; self.by = by; self.mode = mode
            self.poweredBy = poweredBy; self.locked = locked
        }
    }

    /// Whether this person may message in the pond now; `reason` is the calm sentence when not. Absent from an older Mac.
    public struct Access: Codable, Equatable, Sendable {
        public let canMessage: Bool
        public var reason: String? = nil
        public init(canMessage: Bool, reason: String? = nil) { self.canMessage = canMessage; self.reason = reason }
    }

    public let v: Int
    public let pond: String
    /// How many threads the pond has; `streams` holds the newest 200 of them.
    public let total: Int
    public var seq: Int64? = nil
    public let streams: [Stream]
    public var flock: [FlockThread]? = nil
    public var access: Access? = nil

    public init(v: Int = 1, pond: String, total: Int, seq: Int64? = nil, streams: [Stream], flock: [FlockThread]? = nil, access: Access? = nil) {
        self.v = v; self.pond = pond; self.total = total; self.seq = seq; self.streams = streams
        self.flock = flock; self.access = access
    }

    public var threads: [Thread] { streams.flatMap(\.threads) }

    /// The `live` document id: the Mac's `pondThreadsDoc` (the pond id hashed like a session key, under `pond:`).
    public static func doc(for pondId: String) -> String { LiveTurn.handle(for: "pond:" + pondId) + "-p" }
}
