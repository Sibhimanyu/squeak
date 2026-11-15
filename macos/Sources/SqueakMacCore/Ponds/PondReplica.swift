import Foundation

/// A member's copy of someone else's thread: the starter's timeline events as a pond relays them, reduced by the very
/// reducer the starter's own Mac uses (`TurnTimeline`). The relay path has its own `seq` (the pond's); the host's `seq` is
/// inside each event, and that is the order. So a page read twice, an event seen out of order, or a replay after a
/// reconnect all reduce to the same timeline the starter has.
public struct PondReplica: Equatable, Sendable {
    public private(set) var timeline = TurnTimeline()
    /// At least one timeline event has arrived: the thread's rows come from here and the older normalised events are ignored.
    public private(set) var hasTimeline = false
    /// The pond event that first showed each element, which is its row id (one id space with the question/approval rows).
    private var origin: [String: Int] = [:]
    private var stepsSeen: [String: Int] = [:]
    /// Events that came before the first read was complete: where the log starts is not known until it is (a pond keeps
    /// only the newest events), and the first to arrive is not necessarily the first there is.
    private var early: [Early] = []

    private struct Early: Equatable, Sendable {
        var outer: Int
        var event: TimelineEvent
    }

    public init() {}

    /// Folds pond events in. Order of arrival does not matter; a host seq that has not come yet holds the ones after it.
    public mutating func ingest(_ events: [ThreadEvent]) {
        for e in events.sorted(by: { $0.seq < $1.seq }) {
            guard case .timeline(let t) = e.kind else { continue }
            hasTimeline = true
            if timeline.hasBaseline {
                timeline.apply(t)
                note(outer: e.seq)
            } else {
                early.append(Early(outer: e.seq, event: t))
            }
        }
    }

    /// Everything the pond holds has been read: a host seq still missing was never relayed (a thread made private for a while),
    /// so the replica goes on past it.
    public mutating func settle() {
        if !timeline.hasBaseline, let first = early.min(by: { $0.event.seq < $1.event.seq }) {
            // The log starts at the lowest host seq the pond holds; everything read so far is applied in order.
            timeline.load([first.event])
            note(outer: first.outer)
            for item in early.sorted(by: { $0.event.seq < $1.event.seq }) {
                timeline.apply(item.event)
                note(outer: item.outer)
            }
            early = []
        }
        guard timeline.gapSince != nil else { return }
        timeline.acceptGap()
        note(outer: origin.values.max() ?? 0)
    }

    private mutating func note(outer: Int) {
        for t in timeline.turns where !t.waitsInQueue {
            let key = "t:\(t.id)"
            if origin[key] == nil { origin[key] = outer }
            let seen = stepsSeen[t.id] ?? 0
            if t.steps.count > seen {
                for s in t.steps[seen...] where origin["s:\(t.id):\(s.id)"] == nil { origin["s:\(t.id):\(s.id)"] = outer }
                stepsSeen[t.id] = t.steps.count
            }
        }
    }

    /// The thread's prompts, work and the agent's words as rows. `starter`: whose prompt an author-less one is.
    public func rows(starter: String) -> [ThreadRow] {
        var out: [ThreadRow] = []
        func id(_ key: String) -> Int { origin[key] ?? 0 }
        // A prompt still waiting in the queue is not a row of the pond's thread yet: it takes its place when it starts.
        for t in timeline.turns where !t.waitsInQueue {
            if !t.auto { out.append(.user(id: id("t:\(t.id)"), by: t.author?.id ?? starter, text: t.prompt, at: t.startedAt)) }
            for seg in TimelineSteps.segments(of: t) {
                switch seg {
                case .work(let first, let steps, _):
                    if !steps.isEmpty { out.append(.steps(id: id("s:\(t.id):\(first)"), steps)) }
                case .message(let mid):
                    if let s = t.steps.first(where: { $0.id == mid }) { out.append(.agent(id: id("s:\(t.id):\(mid)"), text: s.label, at: s.at)) }
                case .steer(let sid, let text, let author):
                    out.append(.user(id: id("s:\(t.id):\(sid)"), by: author?.id ?? starter, text: text, at: t.steps.first { $0.id == sid }?.at))
                }
            }
        }
        return out
    }
}

public extension ThreadTimeline {
    /// The thread's rows when a timeline replica is available: the replica's prompts, work and words, and the legacy
    /// events' questions, approvals and changed-files, all in the pond's own order.
    static func rows(_ events: [ThreadEvent], replica: PondReplica, starter: String) -> [ThreadRow] {
        guard replica.hasTimeline else { return rows(events) }
        let resolved = Set(events.compactMap { e -> String? in if case .resolved(let r) = e.kind { r } else { nil } })
        var rest: [ThreadRow] = []
        for e in events.sorted(by: { $0.seq < $1.seq }) {
            switch e.kind {
            case .question(let r, let text, let options): rest.append(.question(id: e.seq, requestId: r, text: text, options: options, resolved: resolved.contains(r)))
            case .approval(let r, let label): rest.append(.approval(id: e.seq, requestId: r, label: label, resolved: resolved.contains(r)))
            case .changed(let files, let added, let removed, _): rest.append(.changed(id: e.seq, files: files, added: added, removed: removed))
            default: break
            }
        }
        return (replica.rows(starter: starter) + rest).enumerated().sorted { a, b in
            a.element.id != b.element.id ? a.element.id < b.element.id : a.offset < b.offset
        }.map(\.element)
    }
}
