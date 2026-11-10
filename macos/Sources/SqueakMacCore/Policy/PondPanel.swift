import Foundation

// DESIGN.md §8.10 and §9: the right panel's default content, the Pond panel. A Pond is the shared container (for
// now a project), a thread one agent on one task, the Flock a pond's members, a Nest the machine an agent runs on,
// Ripples the activity feed. Everything the panel decides lives here so CI can test it; the views only draw.

/// One member of a pond's Flock. Today only the Mac's own person and the open thread's agent; a later account
/// layer adds people here and nothing else changes.
public struct PondMember: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case person, agent }
    public var id: String
    public var kind: Kind
    public var name: String
    /// The agent's model, or "You" for the local person.
    public var detail: String?
    /// The agent id ("claude", "codex") for the provider mark; nil for a person.
    public var agent: String?
    /// A stable index the avatar's colour is picked by (`PondPresence.avatarColours` of them).
    public var colourIndex: Int
    public var initial: String { String(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?") }
}

public enum PondPresence {
    public static let avatarColours = 6

    /// A name always lands on the same colour.
    public static func colourIndex(for name: String) -> Int {
        var h: UInt32 = 5381
        for u in name.unicodeScalars { h = h &* 33 &+ u.value }
        return Int(h % UInt32(avatarColours))
    }

    /// Who is here: the local person, then the open thread's agent when there is one. No one else is invented.
    public static func members(person: String, agent: String?, agentName: String?, model: String?) -> [PondMember] {
        let name = person.trimmingCharacters(in: .whitespaces).isEmpty ? "You" : person
        var list = [PondMember(id: "person:local", kind: .person, name: name, detail: "You", agent: nil, colourIndex: colourIndex(for: name))]
        if let agent, !agent.isEmpty {
            let shown = agentName ?? agent
            list.append(PondMember(id: "agent:\(agent)", kind: .agent, name: shown, detail: model, agent: agent, colourIndex: colourIndex(for: shown)))
        }
        return list
    }
}

public enum PondSentence {
    /// "Changed 4 files, +120 −30"; nil when nothing changed.
    public static func changed(files: Int, added: Int, removed: Int) -> String? {
        guard files > 0 else { return nil }
        return "Changed \(files) \(files == 1 ? "file" : "files"), +\(added) \u{2212}\(removed)"
    }

    /// "12 min", "2 h 5 min", "3 d": a span in words, never shorter than a minute.
    public static func span(_ seconds: TimeInterval) -> String {
        let m = max(1, Int(seconds / 60))
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h < 24 { return m % 60 == 0 ? "\(h) h" : "\(h) h \(m % 60) min" }
        return "\(h / 24) d"
    }

    /// The This thread card's time line.
    public static func timing(state: SessionState, startedAt: Date?, lastActivityAt: Date?, now: Date) -> String? {
        func ago(_ d: Date?) -> String? { d.map { "\(span(now.timeIntervalSince($0))) ago" } }
        switch state {
        case .working:
            if let startedAt { return "Working for \(span(now.timeIntervalSince(startedAt)))" }
            return "Working now"
        case .blocked: return ago(lastActivityAt).map { "Waiting on you, since \($0)" } ?? "Waiting on you"
        case .finished: return ago(lastActivityAt).map { "Finished \($0)" }
        case .error: return ago(lastActivityAt).map { "Failed \($0)" }
        case .idle: return lastActivityAt.map { "Quiet for \(span(now.timeIntervalSince($0)))" }
        case .unknown: return nil
        }
    }

    public static func stateWord(_ state: SessionState) -> String {
        switch state {
        case .working: "Working"
        case .blocked: "Needs you"
        case .finished: "Finished"
        case .error: "Failed"
        case .idle: "Idle"
        case .unknown: "Unknown"
        }
    }
}

/// A thread as the pond sees it: what the sidebar already knows, plus when it started if its source says.
public struct PondThreadFact: Equatable, Sendable {
    public var key: SessionKey
    public var title: String
    public var state: SessionState
    public var lastActivityAt: Date?
    public var startedAt: Date?
    public init(key: SessionKey, title: String, state: SessionState, lastActivityAt: Date?, startedAt: Date? = nil) {
        self.key = key; self.title = title; self.state = state; self.lastActivityAt = lastActivityAt; self.startedAt = startedAt
    }
}

/// A pull request the open thread made, with when it was last seen to change if known.
public struct PondPullRequestFact: Equatable, Sendable {
    public var number: Int
    public var merged: Bool
    public var at: Date?
    public var threadTitle: String
    public init(number: Int, merged: Bool, at: Date?, threadTitle: String) {
        self.number = number; self.merged = merged; self.at = at; self.threadTitle = threadTitle
    }
}

public struct PondRipple: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case started, finished, failed, needsYou, prOpened, prMerged, filesChanged, remote }
    public var id: String
    public var kind: Kind
    public var sentence: String
    public var at: Date
    public var threadKey: SessionKey?
}

public enum PondRipples {
    public static let cap = 20

    /// Short sentences, newest first. Facts without a time are left out: a ripple with no "when" is not a ripple.
    public static func build(
        threads: [PondThreadFact], pullRequests: [PondPullRequestFact] = [], changed: (title: String, files: Int, at: Date?)? = nil,
        cap: Int = PondRipples.cap
    ) -> [PondRipple] {
        var out: [PondRipple] = []
        for t in threads {
            let title = t.title.isEmpty ? "A thread" : t.title
            if let at = t.startedAt {
                out.append(PondRipple(id: "start:\(t.key.hostSessionId)", kind: .started, sentence: "\(title) started", at: at, threadKey: t.key))
            }
            guard let at = t.lastActivityAt else { continue }
            switch t.state {
            case .finished: out.append(PondRipple(id: "end:\(t.key.hostSessionId)", kind: .finished, sentence: "\(title) finished", at: at, threadKey: t.key))
            case .error: out.append(PondRipple(id: "end:\(t.key.hostSessionId)", kind: .failed, sentence: "\(title) failed", at: at, threadKey: t.key))
            case .blocked: out.append(PondRipple(id: "end:\(t.key.hostSessionId)", kind: .needsYou, sentence: "\(title) needs you", at: at, threadKey: t.key))
            default: break
            }
        }
        for pr in pullRequests {
            guard let at = pr.at else { continue }
            let kind: PondRipple.Kind = pr.merged ? .prMerged : .prOpened
            out.append(PondRipple(id: "pr:\(pr.number)", kind: kind, sentence: "PR #\(pr.number) \(pr.merged ? "merged" : "opened") from \(pr.threadTitle)", at: at, threadKey: nil))
        }
        if let changed, changed.files > 0, let at = changed.at {
            out.append(PondRipple(id: "files", kind: .filesChanged, sentence: "\(changed.title) changed \(changed.files) \(changed.files == 1 ? "file" : "files")", at: at, threadKey: nil))
        }
        out.sort { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }
        return Array(out.prefix(max(0, cap)))
    }
}

public enum PondOrdering {
    /// Newest activity first, ties by title (DESIGN.md: every list is newest first).
    public static func newestFirst(_ threads: [PondThreadFact]) -> [PondThreadFact] {
        threads.sorted {
            let a = $0.lastActivityAt ?? .distantPast, b = $1.lastActivityAt ?? .distantPast
            return a != b ? a > b : $0.title.localizedCompare($1.title) == .orderedAscending
        }
    }

    /// The pond's other threads, newest first.
    public static func others(_ threads: [PondThreadFact], excluding open: SessionKey?) -> [PondThreadFact] {
        newestFirst(threads.filter { $0.key != open })
    }

    /// Threads waiting on the person, newest first.
    public static func needsYou(_ threads: [PondThreadFact]) -> [PondThreadFact] {
        newestFirst(threads.filter { $0.state == .blocked })
    }
}
