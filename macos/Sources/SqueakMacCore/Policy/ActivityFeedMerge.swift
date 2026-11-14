import Foundation

/// The open chat's step feed while a turn runs: append-only, keyed by stable identity, merged from every input that
/// can speak (the host's transcript read, the stream's live step). Reads race (a 2 s poll, a read per stream event,
/// one on every state change) and any of them can come back empty, partial or older than what is on screen; the
/// screen must only ever grow or update in place. A row once shown stays until the turn ends, and the turn's end is
/// one transition, after which the finished design (the fold) takes the feed from the host's record.
public struct ActivityFeedMerge: Equatable, Sendable {
    public struct Result: Equatable, Sendable {
        public var steps: [ActivityStep]
        /// True on the one call where a working turn ended.
        public var turnEnded: Bool
    }

    private var turn: String?
    private var held: [Held] = []
    private var working = false
    /// The tracker and retry notes of the newest read.
    private var latest: [ActivityStep] = []

    private struct Held: Equatable, Sendable {
        var key: String
        var step: ActivityStep
    }

    public init() {}

    /// Forget everything (another chat opened).
    public mutating func reset() { self = ActivityFeedMerge() }

    /// - `turn`: the id of the turn the chat is in (a new one starts a fresh feed).
    /// - `incoming`: the host's current-turn steps; nil when the read failed (nothing from it is applied).
    /// - `live`: the stream's step the model is on; a tool the host has no row for yet is held until its row lands, a
    ///   thinking placeholder is only drawn after the rows while it is the newest thing.
    public mutating func apply(incoming: [ActivityStep]?, live: ActivityStep?, working now: Bool, turn newTurn: String?) -> Result {
        if newTurn != turn { held = []; turn = newTurn; working = false }
        let ended = working && !now
        working = now

        if !now {
            // Finished: the host's record is the truth, but an empty or failed read never blanks what was shown.
            if let incoming, !incoming.isEmpty { held = Self.keyed(incoming).map { Held(key: $0.0, step: $0.1) } }
            return Result(steps: held.map(\.step), turnEnded: ended)
        }

        if let incoming {
            latest = incoming.filter { !Self.holds($0) }
            let keyed = Self.keyed(incoming.filter(Self.holds))
            var out = keyed.map { Held(key: $0.0, step: $0.1) }
            let have = Set(out.map(\.key))
            // What was held and this read lacks goes back right after the row it followed.
            var at = -1
            for h in held {
                if have.contains(h.key) {
                    at = out.firstIndex { $0.key == h.key } ?? at
                } else {
                    out.insert(h, at: at + 1)
                    at += 1
                }
            }
            held = out
        }
        if let live, let id = live.toolId, !held.contains(where: { $0.key == "tool:\(id)" }) {
            held.append(Held(key: "tool:\(id)", step: live))
        }
        let rows = held.map(\.step) + latest
        guard let live, Self.isPlaceholder(live) else { return Result(steps: rows, turnEnded: ended) }
        return Result(steps: NativeLiveState.withLive(rows, live: live, working: true), turnEnded: ended)
    }

    static func isPlaceholder(_ s: ActivityStep) -> Bool {
        s.kind == "thinking" && s.text == NativeLiveState.thinkingText && s.at == nil
    }

    /// A tracker or a retry note is the newest state of something, not a row to keep: the read's word is final.
    static func holds(_ s: ActivityStep) -> Bool { s.kind != "progress" && s.kind != "retry" }

    /// Identity: the tool call's id; else kind and time; else kind and words. A repeat of the same gets its ordinal.
    static func keyed(_ steps: [ActivityStep]) -> [(String, ActivityStep)] {
        var seen: [String: Int] = [:]
        return steps.map { s in
            let base: String
            if let id = s.toolId { base = "tool:\(id)" }
            else if let at = s.at { base = "\(s.kind)@\(at.timeIntervalSince1970)" }
            else { base = "\(s.kind):\(s.text)" }
            let n = seen[base, default: 0]
            seen[base] = n + 1
            return (n == 0 ? base : "\(base)#\(n)", s)
        }
    }
}
