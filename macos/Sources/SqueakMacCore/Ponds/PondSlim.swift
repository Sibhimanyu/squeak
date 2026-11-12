import Foundation

// The slimmed Pond tab: pure decisions (meta line, face row overflow, activity filtering) so CI can test them.

public enum PondMeta {
    /// "Claude · Opus 5.5 · finished 1 h 41 min ago". "Started by" and "Runs on" are appended only when they are not
    /// the current person / this Mac (pass nil when they are).
    public static func line(
        agentName: String, model: String?, state: SessionState, startedAt: Date?, lastActivityAt: Date?, now: Date,
        startedBy: String? = nil, runsOn: String? = nil
    ) -> String {
        var parts = [agentName, model].compactMap { $0 }.filter { !$0.isEmpty }
        if let t = timing(state: state, startedAt: startedAt, lastActivityAt: lastActivityAt, now: now) { parts.append(t) }
        if let startedBy, !startedBy.isEmpty { parts.append("started by \(startedBy)") }
        if let runsOn, !runsOn.isEmpty { parts.append("runs on \(runsOn)") }
        return parts.joined(separator: " \u{00B7} ")
    }

    public static func timing(state: SessionState, startedAt: Date?, lastActivityAt: Date?, now: Date) -> String? {
        func ago(_ d: Date?) -> String? { d.map { "\(PondSentence.span(now.timeIntervalSince($0))) ago" } }
        switch state {
        case .working: return startedAt.map { "working for \(PondSentence.span(now.timeIntervalSince($0)))" } ?? "working now"
        case .blocked: return "waiting on you"
        case .finished: return ago(lastActivityAt).map { "finished \($0)" }
        case .error: return ago(lastActivityAt).map { "failed \($0)" }
        case .idle: return lastActivityAt.map { "quiet for \(PondSentence.span(now.timeIntervalSince($0)))" }
        case .unknown: return nil
        }
    }

    /// "68 files · +9770 −1172"; nil when nothing changed.
    public static func strip(files: Int, added: Int, removed: Int) -> String? {
        guard files > 0 else { return nil }
        return "\(files) \(files == 1 ? "file" : "files") \u{00B7} +\(added) \u{2212}\(removed)"
    }
}

public enum PondFaces {
    public static let maxFaces = 5
    public static let maxRows = 3

    /// How many faces to draw and how many to fold into a "+N" chip.
    public static func overflow(total: Int, max limit: Int = PondFaces.maxFaces) -> (shown: Int, more: Int) {
        let shown = Swift.min(Swift.max(0, total), Swift.max(1, limit))
        return (shown, Swift.max(0, total) - shown)
    }

    /// The full list appears only when the pond has people other than you.
    public static func showsList(peopleOtherThanYou: Int) -> Bool { peopleOtherThanYou > 0 }

    /// Rows of the full list: at most three, the rest as "+N".
    public static func rows(total: Int) -> (shown: Int, more: Int) { overflow(total: total, max: maxRows) }

    /// "Aarav · Owner · online" (the role is left out for a plain member).
    public static func tooltip(name: String, role: String?, online: Bool?) -> String {
        [name, role, online.map { $0 ? "online" : "away" }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }
}

public enum PondActivity {
    /// Thread lifecycle lines ("X started", "X finished", "X changed 3 files") repeat what the sidebar and thread status
    /// already show. Flotilla ripples carry only text, so this reads the sentence.
    public static func isThreadStatus(_ text: String) -> Bool {
        let t = text.lowercased()
        if t.contains(" started ") || t.hasSuffix(" started") || t.hasSuffix(" finished") || t.hasSuffix(" failed") || t.hasSuffix(" needs you") { return true }
        if t.range(of: #" changed \d+ files?$"#, options: .regularExpression) != nil { return true }
        return false
    }

    /// Activity worth opening the fold for: everything but thread status, newest first.
    public static func filter(_ ripples: [PondRipple]) -> [PondRipple] {
        ripples.filter {
            switch $0.kind {
            case .started, .finished, .failed, .needsYou, .filesChanged: false
            case .remote: !isThreadStatus($0.sentence)
            case .prOpened, .prMerged: true
            }
        }
    }

    /// The disclosure's label: "Activity" or "Activity · 4".
    public static func label(count: Int) -> String { count > 0 ? "Activity \u{00B7} \(count)" : "Activity" }
}
