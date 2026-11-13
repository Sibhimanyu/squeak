import Foundation

// docs/ponds.md, "Changes on someone else's thread": the starter's Mac answers a signed `diff` command with the changed
// files and, for one file, its patch. The answer is a document that lives ten minutes. The Mac asks when the Changes view
// opens, when a file is picked and when the thread's turn ends; nothing polls.

/// The starter's answer: what changed, and one file's patch when asked.
public struct PondChanges: Sendable, Equatable, Decodable {
    public struct File: Sendable, Equatable, Decodable, Identifiable {
        public var path: String
        /// Lines changed in the file (from the starter's stat); nil when the host did not count them.
        public var changes: Int?
        public var id: String { path }
    }
    public struct Patch: Sendable, Equatable, Decodable {
        public var path: String
        public var text: String
        public var truncated: Bool
    }
    public struct Summary: Sendable, Equatable, Decodable {
        public var files: Int
        public var added: Int
        public var removed: Int
    }

    public var files: [File]
    public var summary: Summary?
    public var patch: Patch?
    public var expiresAt: Date?

    enum CodingKeys: String, CodingKey { case files, summary, patch, expiresAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        files = c.list(File.self, .files)
        summary = c.lenient(Summary.self, .summary)
        patch = c.lenient(Patch.self, .patch)
        expiresAt = PondTime.decode(c, CodingKeys.expiresAt)
    }

    public init(files: [File], summary: Summary? = nil, patch: Patch? = nil, expiresAt: Date? = nil) {
        self.files = files; self.summary = summary; self.patch = patch; self.expiresAt = expiresAt
    }
}

/// The host's answer to asking for changes: the request's id and, for one's own thread, the result at once.
public struct PondChangesReply: Sendable, Equatable, Decodable {
    public var ready: Bool
    public var requestId: String?
    public var result: PondChanges?

    enum CodingKeys: String, CodingKey { case ready, requestId, result }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.lenient(Bool.self, .ready) ?? false
        requestId = c.lenient(String.self, .requestId)
        result = c.lenient(PondChanges.self, .result)
    }
}

/// What the Changes view draws, from a thread's events and the starter's answer. Pure.
public enum PondChangesView {
    /// The read-only list the normal Changes rows draw (status "M": the host sends no per-file status).
    public static func listing(_ changes: PondChanges) -> [DaemonChanges.File] {
        changes.files.map { DaemonChanges.File(path: $0.path, status: "M", added: $0.changes ?? 0, removed: 0) }
    }

    /// "3 files changed" over the count the starter gave, else the number of files listed.
    public static func header(_ changes: PondChanges) -> String { ChangeListing.header(count: changes.summary?.files ?? changes.files.count) }

    /// The latest `changed` event of a thread (the starter writes one at each turn end), as a stand-in list until the
    /// request answers: its paths, with no counts.
    public static func fromEvents(_ events: [ThreadEvent]) -> PondChanges? {
        for e in events.reversed() {
            if case .changed(let files, let added, let removed, let paths) = e.kind, files > 0 || !paths.isEmpty {
                return PondChanges(files: paths.map { PondChanges.File(path: $0, changes: nil) },
                                   summary: .init(files: files, added: added, removed: removed))
            }
        }
        return nil
    }

    /// The seq of the newest `changed` event: when it grows, the thread's turn ended and the open view asks again.
    public static func turnEndStamp(_ events: [ThreadEvent]) -> Int {
        for e in events.reversed() { if case .changed = e.kind { return e.seq } }
        return 0
    }

    /// Whether a request is worth making: the view is open, and the last stamp is not the one already asked for.
    public static func shouldAsk(open: Bool, stamp: Int, askedAt: Int?) -> Bool { open && stamp != askedAt }

    public static let expiredLine = "That answer lapsed. Open the file again to ask for it."
}

/// A thread a member asked the owner's Mac to start (docs/ponds.md, "Starting a thread on the owner's Mac"): the request
/// is a signed command; the Mac opens the thread when it shows up in the pond with the request's id.
public enum PondStartRequest {
    /// The command lives five minutes on the wire; past that the owner's Mac will not run it.
    public static let lifetime: TimeInterval = 5 * 60

    public static func thread(for requestId: String, in threads: [PondThread]) -> PondThread? {
        threads.first { $0.requestId == requestId && !$0.isPrivate }
    }

    /// While it waits: "Waiting for Sibhi's Mac to start your thread."
    public static func waitingLine(ownerName: String?) -> String {
        "Waiting for \(owner(ownerName))\u{2019}s Mac to start your thread."
    }

    /// When nothing came back in time.
    public static func lapsedLine(ownerName: String?) -> String {
        "\(owner(ownerName))\u{2019}s Mac did not start it. Try again when they are online."
    }

    /// The place line on a shared pond when the thread runs on the owner's Mac.
    public static func placeLine(ownerName: String?) -> String { "Runs on \(owner(ownerName))\u{2019}s Mac" }

    private static func owner(_ name: String?) -> String {
        let n = name?.trimmingCharacters(in: .whitespaces) ?? ""
        return n.isEmpty ? "the owner" : n
    }

    public static func isExpired(askedAt: Date, now: Date = Date()) -> Bool { now.timeIntervalSince(askedAt) > lifetime }
}
