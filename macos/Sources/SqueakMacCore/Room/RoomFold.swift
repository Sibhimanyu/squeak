import Foundation

/// Folds a run of one duck's state lines (took it, blocked, finished, handed over) into one row, so the Room reads as a
/// conversation and not a log. The row shows the run's latest line and carries the earlier ones for "+N earlier".
/// Pure and id-stable: the folded row keeps the id of the run's first line, so a growing run changes a row in place and
/// never replaces it. Messages, Task cards, plan cards, questions and day separators are never folded and end a run.
public enum RoomFold {
    /// The duck a foldable line belongs to; nil for anything that must stand alone.
    static func duckKey(_ line: RoomSystemLine) -> String? {
        if line.task != nil || line.jobId != nil || !line.buttons.isEmpty || line.error != nil { return nil }
        if let s = line.status {
            guard s.kind != .plan else { return nil }
            return "d:" + (s.sessionId ?? s.name)
        }
        if let h = line.handoff { return "d:" + (h.fromSessionId ?? h.from) }
        return nil
    }

    public static func fold(_ items: [RoomItem]) -> [RoomItem] {
        var out: [RoomItem] = []
        var run: [RoomSystemLine] = []
        var runKey: String?
        func flush() {
            defer { run = []; runKey = nil }
            guard var last = run.last else { return }
            if run.count > 1 { last.earlier = Array(run.dropLast()); last.id = run[0].id }
            out.append(.system(last))
        }
        for item in items {
            if case .system(let line) = item, let key = duckKey(line) {
                if key != runKey { flush(); runKey = key }
                run.append(line)
            } else {
                flush()
                out.append(item)
            }
        }
        flush()
        return out
    }

    /// The Duck a folded run belongs to, by the name the row shows.
    public static func owner(of line: RoomSystemLine) -> String? {
        if let s = line.status { return s.name }
        if let h = line.handoff { return h.from }
        return nil
    }

    /// The fold row's words: "Show 4 earlier from Ruby 2", then "Hide 4 earlier" once open.
    public static func earlierLabel(_ n: Int, from name: String? = nil, open: Bool = false) -> String {
        if open { return "Hide \(n) earlier" }
        guard let name, !name.isEmpty else { return "Show \(n) earlier" }
        return "Show \(n) earlier from \(name)"
    }
}

/// One text rule for every Room row (a Duck's message, a handoff note, a state line): up to `lines` lines, then an inline
/// "Show more". Decided from the text alone, so a row never changes height after it is first drawn.
public enum RoomRowText {
    public static let lines = 3
    /// Roughly three lines of the reading column.
    static let characters = 240

    public static func isLong(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > characters || t.split(separator: "\n", omittingEmptySubsequences: false).count > lines
    }
}
