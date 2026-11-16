import Foundation

/// A timeline turn as the step lists the existing views draw (`TurnBlockView`, `FoldedTurnView`, the dock). Only
/// a re-shaping of what the timeline holds: nothing here decides what exists.
public enum TimelineSteps {
    /// Every step of a turn in order: the prompt (`you`), notes and replies (`note`), thoughts, tool calls (with what
    /// opens under them once it is known), steers, errors and, for a running turn, its open wait.
    public static func activity(of turn: TimelineTurn, now: Date, details: [String: ToolDetail] = [:]) -> [ActivityStep] {
        var out: [ActivityStep] = []
        if !turn.auto, turn.turnId != nil || turn.state == .sending {
            out.append(ActivityStep(kind: "you", text: turn.prompt, at: turn.startedAt))
        }
        for s in turn.steps {
            switch s.kind {
            case .tool:
                out.append(ActivityStep(kind: "tool", text: s.label, at: s.at, toolId: s.id, detail: details[s.id]))
            case .thinking:
                // A thought the model did not show a summary of has no words: it lists no row once it is over.
                let full = s.detail["text"]?.string ?? ""
                out.append(ActivityStep(kind: "thinking", text: s.status == .running ? NativeLiveState.thinkingText : full, at: s.at))
            case .note, .other:
                out.append(ActivityStep(kind: "note", text: s.label, at: s.at))
            case .steer:
                out.append(ActivityStep(kind: "you", text: s.detail["text"]?.string ?? s.label, at: s.at))
            case .error:
                out.append(ActivityStep(kind: "error", text: s.label, at: s.at))
            case .progress:
                out.append(ActivityStep(
                    kind: "progress", text: s.label, at: s.at,
                    detail: .progress(
                        steps: (s.detail["steps"]?.array ?? []).compactMap(\.string), current: s.detail["current"]?.int,
                        percent: s.detail["percent"]?.double, status: s.detail["status"]?.string)))
            case .waiting, .retrying:
                break
            }
        }
        if turn.state == .running, turn.openWait != nil {
            out.append(ActivityStep(kind: NativeLiveState.waitingKind, text: turn.statusLine(now: now), at: turn.openWait?.at))
        }
        return out
    }

    /// Each turn's steps, by the turn id its messages carry (`turnWork`: what a finished turn folds under its reply).
    public static func work(_ turns: [TimelineTurn], details: [String: ToolDetail] = [:]) -> [String: [ActivityStep]] {
        var out: [String: [ActivityStep]] = [:]
        for t in turns {
            guard let id = t.turnId else { continue }
            let steps = activity(of: t, now: t.endedAt ?? t.startedAt ?? Date(timeIntervalSince1970: 0), details: details)
                .filter { $0.kind != "progress" && $0.kind != NativeLiveState.waitingKind }
            if !steps.isEmpty { out[id] = steps }
        }
        return out
    }
}

/// A turn's body in drawing order. Ids are stable (a step's own id), so a row that exists keeps its identity as the turn
/// grows and a view never swaps it.
public enum TimelineSegment: Equatable, Identifiable, Sendable {
    /// Thoughts and tool calls. `live`: the run the turn is in now.
    case work(id: String, steps: [ActivityStep], live: Bool)
    /// A text message of the agent (a note, or the reply of an ended turn); its text is in the chat messages by this id.
    case message(id: String)
    /// A message a person sent into the running turn.
    case steer(id: String, text: String, author: TimelineAuthor?)

    public var id: String {
        switch self {
        case .work(let id, _, _): "work-\(id)"
        case .message(let id): id
        case .steer(let id, _, _): id
        }
    }
}

public extension TimelineSteps {
    /// A running turn lists its work in the order it happened, with the agent's words and steers between; an ended
    /// turn folds all its work into one run above them (the `Worked for 1m 42s · 6 steps` line).
    /// `hiding`: steer steps not drawn yet (their card still waits at the bottom of the stream).
    static func segments(of turn: TimelineTurn, details: [String: ToolDetail] = [:], hiding: Set<String> = []) -> [TimelineSegment] {
        func work(_ s: TimelineStep) -> ActivityStep? {
            switch s.kind {
            case .tool: ActivityStep(kind: "tool", text: s.label, at: s.at, toolId: s.id, detail: details[s.id])
            case .thinking: ActivityStep(kind: "thinking", text: s.status == .running ? NativeLiveState.thinkingText : (s.detail["text"]?.string ?? ""), at: s.at)
            case .error: ActivityStep(kind: "error", text: s.label, at: s.at)
            default: nil
            }
        }
        var out: [TimelineSegment] = []
        if turn.isEnded {
            let all = turn.steps.compactMap(work)
            if let first = turn.steps.first(where: { work($0) != nil }) { out.append(.work(id: first.id, steps: all, live: false)) }
            for s in turn.steps {
                if s.isMessage { out.append(.message(id: s.id)) } else if s.kind == .steer, !hiding.contains(s.id) { out.append(.steer(id: s.id, text: s.detail["text"]?.string ?? s.label, author: s.author)) }
            }
            return out
        }
        var run: [ActivityStep] = []
        var runId: String?
        func flush(live: Bool) {
            if let runId, !run.isEmpty { out.append(.work(id: runId, steps: run, live: live)) }
            run = []; runId = nil
        }
        for s in turn.steps {
            if s.isMessage { flush(live: false); out.append(.message(id: s.id)) }
            else if s.kind == .steer { if !hiding.contains(s.id) { flush(live: false); out.append(.steer(id: s.id, text: s.detail["text"]?.string ?? s.label, author: s.author)) } }
            else if let a = work(s) { if runId == nil { runId = s.id }; run.append(a) }
        }
        flush(live: turn.state == .running)
        return out
    }
}
