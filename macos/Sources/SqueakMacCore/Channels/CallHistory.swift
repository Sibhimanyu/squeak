import Foundation

/// Phone-call history and the gateway's own log: `GET /control/voice/calls`. The daemon owns the data;
/// this decodes tolerantly (an unknown word never fails the page) and words everything in plain sentences.
/// Times are milliseconds since 1970.
public enum CallKind: String, Sendable, Equatable { case agent, test }

public enum CallOutcome: String, Sendable, Equatable {
    case answered, unanswered, failed
    case movedOn = "moved_on"
}

public enum GatewayLogLevel: String, Sendable, Equatable { case info, warn }

public struct CallEntry: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var at: Double
    public var kind: CallKind
    public var reason: String?
    public var label: String?
    public var outcome: CallOutcome
    public var letter: String?
    public var sent: Bool?
    public var durationMs: Double
    public var failure: String?

    public init(
        id: String, at: Double, kind: CallKind = .agent, reason: String? = nil, label: String? = nil,
        outcome: CallOutcome = .unanswered, letter: String? = nil, sent: Bool? = nil, durationMs: Double = 0, failure: String? = nil
    ) {
        self.id = id; self.at = at; self.kind = kind; self.reason = reason; self.label = label; self.outcome = outcome
        self.letter = letter; self.sent = sent; self.durationMs = durationMs; self.failure = failure
    }

    private enum Keys: String, CodingKey { case id, at, kind, reason, label, outcome, letter, sent, durationMs, failure }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        id = (try? c.decode(String.self, forKey: .id)) ?? "call-\(Int(at))"
        // Unknown words read as the safest: an agent call nobody answered.
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(CallKind.init(rawValue:)) ?? .agent
        outcome = (try? c.decode(String.self, forKey: .outcome)).flatMap(CallOutcome.init(rawValue:)) ?? .unanswered
        reason = try? c.decode(String.self, forKey: .reason)
        label = try? c.decode(String.self, forKey: .label)
        letter = try? c.decode(String.self, forKey: .letter)
        sent = try? c.decode(Bool.self, forKey: .sent)
        durationMs = (try? c.decode(Double.self, forKey: .durationMs)) ?? 0
        failure = try? c.decode(String.self, forKey: .failure)
    }
}

public struct GatewayLogLine: Sendable, Equatable, Decodable, Identifiable {
    public var at: Double
    public var level: GatewayLogLevel
    public var text: String
    public var id: String { "\(at)-\(text)" }

    public init(at: Double, level: GatewayLogLevel = .info, text: String) { self.at = at; self.level = level; self.text = text }

    private enum Keys: String, CodingKey { case at, level, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        level = (try? c.decode(String.self, forKey: .level)).flatMap(GatewayLogLevel.init(rawValue:)) ?? .info
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
    }
}

public struct GatewayLog: Sendable, Equatable, Decodable {
    public var at: Double
    public var lines: [GatewayLogLine]

    public init(at: Double = 0, lines: [GatewayLogLine] = []) { self.at = at; self.lines = lines }

    private enum Keys: String, CodingKey { case at, lines }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        lines = (try? c.decode([GatewayLogLine].self, forKey: .lines)) ?? []
    }
}

public struct CallsView: Sendable, Equatable, Decodable {
    public var calls: [CallEntry]
    public var gatewayLog: GatewayLog?

    public init(calls: [CallEntry] = [], gatewayLog: GatewayLog? = nil) { self.calls = calls; self.gatewayLog = gatewayLog }

    private enum Keys: String, CodingKey { case calls, gatewayLog }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        calls = (try? c.decode([CallEntry].self, forKey: .calls)) ?? []
        gatewayLog = try? c.decode(GatewayLog.self, forKey: .gatewayLog)
    }
}

/// Plain-words formatting and the plain-text exports used by Copy.
public enum CallText {
    public static let unavailable = "Update Squeak, or set up phone calls first"

    public static func what(_ e: CallEntry) -> String {
        if e.kind == .test { return "Test call" }
        if let l = e.label, !l.isEmpty { return l }
        switch e.reason {
        case "blocked_approval": return "An approval was waiting"
        case "blocked_question", "asked_question": return "A question was waiting"
        default: return "An agent call"
        }
    }

    public static func outcomeSentence(_ e: CallEntry) -> String {
        switch e.outcome {
        case .answered:
            var s = "Answered"
            if let l = e.letter, !l.isEmpty { s += ", pressed \(l)" }
            if e.sent == true { s += " · sent" } else if e.sent == false, e.letter != nil { s += " · not sent" }
            return s
        case .unanswered: return "Not answered"
        case .failed:
            if let f = e.failure, !f.isEmpty { return "Could not be placed: \(f)" }
            return "Could not be placed"
        case .movedOn: return "Answered, but the chat had moved on"
        }
    }

    /// "42 s", "1 min 12 s", "3 min"; under a second reads "0 s".
    public static func duration(ms: Double) -> String {
        let total = max(0, Int((ms / 1000).rounded()))
        if total < 60 { return "\(total) s" }
        let m = total / 60, s = total % 60
        return s == 0 ? "\(m) min" : "\(m) min \(s) s"
    }

    /// "Today 14:02", "Yesterday 09:15", "Mon 3 Nov 14:02" (older), in the given calendar.
    public static func when(ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone; f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm"
        let time = f.string(from: d)
        if calendar.isDate(d, inSameDayAs: now) { return "Today \(time)" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(d, inSameDayAs: y) { return "Yesterday \(time)" }
        f.dateFormat = "EEE d MMM HH:mm"
        return f.string(from: d)
    }

    public static func callRow(_ e: CallEntry, now: Date = Date(), calendar: Calendar = .current) -> String {
        "\(when(ms: e.at, now: now, calendar: calendar)) · \(what(e)) · \(outcomeSentence(e)) · \(duration(ms: e.durationMs))"
    }

    public static func callsExport(_ calls: [CallEntry], now: Date = Date(), calendar: Calendar = .current) -> String {
        calls.map { callRow($0, now: now, calendar: calendar) }.joined(separator: "\n")
    }

    public static func logLine(_ l: GatewayLogLine, calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone; f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm:ss"
        let t = f.string(from: Date(timeIntervalSince1970: l.at / 1000))
        return "\(t) \(l.level == .warn ? "WARN" : "INFO") \(l.text)"
    }

    public static func logExport(_ log: GatewayLog, calendar: Calendar = .current) -> String {
        log.lines.map { logLine($0, calendar: calendar) }.joined(separator: "\n")
    }
}
