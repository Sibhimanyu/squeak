import Foundation

// DESIGN.md §8.10, a chat's history: per-turn checkpoints, restoring files, forking and editing an earlier message.
// The host decides everything (src/native/host.ts); this is the wire shape and the words.

public struct NativeFileChange: Sendable, Equatable, Decodable, Hashable {
    /// A added, M modified, D deleted, T type changed.
    public var status: String
    public var path: String
}

public struct NativeTurn: Sendable, Equatable, Decodable, Identifiable {
    public struct Checkpoint: Sendable, Equatable, Decodable { public var ref: String; public var commit: String }
    public var turn: Int
    public var text: String
    public var startSeq: Int
    public var endSeq: Int?
    public var startCheckpoint: Checkpoint?
    public var endCheckpoint: Checkpoint?
    public var files: [NativeFileChange]
    public var working: Bool
    public var id: Int { turn }
}

extension NativeHostClient {
    private struct Turns: Decodable { var turns: [NativeTurn] }
    private struct One: Decodable { var session: NativeSession }

    /// The chat's turns with the files each changed; 404 on a host that predates checkpoints.
    public func turns(sessionId: String) async throws -> [NativeTurn] {
        try JSONDecoder.native(Turns.self, try await call("GET", "/native/sessions/\(Self.id(sessionId))/turns", timeout: 20)).turns
    }

    /// Puts the folder's files back to how a turn found them (`start`) or left them (`end`). The chat is not rewound.
    public func revertFiles(sessionId: String, turn: Int, to: String = "start") async throws {
        _ = try await call(
            "POST", "/native/sessions/\(Self.id(sessionId))/revert",
            body: .object(["turn": .number(Double(turn)), "to": .string(to), "confirm": .bool(true)]), timeout: 60, maybeSent: true)
    }

    /// A copy of the chat through `atTurn` (nil: all of it).
    public func fork(sessionId: String, atTurn: Int?) async throws -> NativeSession {
        var body: [String: NativeJSON] = [:]
        if let atTurn { body["atTurn"] = .number(Double(atTurn)) }
        return try JSONDecoder.native(One.self, try await call("POST", "/native/sessions/\(Self.id(sessionId))/fork", body: .object(body), timeout: 60, maybeSent: true)).session
    }

    /// Edits an earlier message: a fork from the turn before it, with the new text sent there.
    public func edit(sessionId: String, turn: Int, text: String, revertFiles: Bool) async throws -> NativeSession {
        let body: NativeJSON = .object(["turn": .number(Double(turn)), "text": .string(text), "revertFiles": .bool(revertFiles)])
        return try JSONDecoder.native(One.self, try await call("POST", "/native/sessions/\(Self.id(sessionId))/edit", body: body, timeout: 90, maybeSent: true)).session
    }
}

/// Pure rules for the history actions.
public enum NativeHistory {
    /// The tooltip while the chat cannot be edited, forked or restored; nil when it can.
    public static func disabledReason(working: Bool) -> String? {
        working ? "Not while the chat is working. Stop it or wait for the turn to end." : nil
    }

    /// The turn a user message opened: the host's turn whose first row is that message (`native-<seq>`).
    public static func turn(forMessageId id: String, in turns: [NativeTurn]) -> NativeTurn? {
        guard id.hasPrefix("native-"), let seq = Int(id.dropFirst("native-".count)) else { return nil }
        return turns.first { $0.startSeq == seq }
    }

    /// The newest turn that has finished, for "N files changed" under the latest fold; nil while the chat has none.
    public static func latestTurn(in turns: [NativeTurn]) -> NativeTurn? { turns.max { $0.turn < $1.turn } }

    /// "3 files changed"; nil when none.
    public static func filesChangedLine(_ files: [NativeFileChange]) -> String? {
        files.isEmpty ? nil : "\(files.count) \(files.count == 1 ? "file" : "files") changed"
    }

    /// One line of the restore sheet: "Modified  src/a.ts".
    public static func fileLine(_ f: NativeFileChange) -> String {
        let word: String
        switch f.status {
        case "A": word = "Added"
        case "D": word = "Deleted"
        case "T": word = "Type changed"
        default: word = "Modified"
        }
        return "\(word)  \(f.path)"
    }

    /// What restoring to before a turn does, in the sheet's own words. Files the turn added are removed and files it
    /// deleted come back; later turns' changes go too, but the host keeps a safety copy.
    public static func restoreSummary(turn: Int) -> String {
        "Puts your files back to how they were before message \(turn). The conversation stays as it is."
    }

    /// Restoring needs a start checkpoint to go back to.
    public static func canRestore(_ t: NativeTurn?) -> Bool { t?.startCheckpoint != nil }

    /// A fork at a turn the host has no agent history for answers its own sentence; nothing else to decide here.
    public static func trimmedEdit(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
