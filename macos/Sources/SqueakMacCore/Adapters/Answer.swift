import Foundation

// Answering an agent's question or plan (docs/answering-questions.md).
// Port of the daemon's `GET/POST /control/session/<id>/question|answer`.

public struct AskOption: Decodable, Sendable, Equatable, Hashable {
    public var label: String
    public var description: String?
    public init(label: String, description: String? = nil) { self.label = label; self.description = description }
}

public struct AskQuestion: Decodable, Sendable, Equatable {
    public var question: String
    public var header: String?
    public var multiSelect: Bool
    public var options: [AskOption]

    public init(question: String, header: String? = nil, multiSelect: Bool = false, options: [AskOption]) {
        self.question = question; self.header = header; self.multiSelect = multiSelect; self.options = options
    }
}

public enum AskKind: String, Decodable, Sendable, Equatable { case question, plan }

/// How an answer would travel. `stopAndSend` is the only route in Conductor 0.91.1.
public enum AskDelivery: String, Decodable, Sendable, Equatable {
    case direct, unknown, unavailable
    case stopAndSend = "stop-and-send"
}

public struct PendingAsk: Decodable, Sendable, Equatable {
    public var toolUseId: String
    public var kind: AskKind
    public var questions: [AskQuestion]
    /// The plan's text, for a plan.
    public var plan: String?
    public var delivery: AskDelivery

    public init(toolUseId: String, kind: AskKind = .question, questions: [AskQuestion] = [], plan: String? = nil, delivery: AskDelivery = .stopAndSend) {
        self.toolUseId = toolUseId; self.kind = kind; self.questions = questions; self.plan = plan; self.delivery = delivery
    }

    enum CodingKeys: String, CodingKey { case toolUseId, kind, questions, plan, delivery }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        toolUseId = try c.decode(String.self, forKey: .toolUseId)
        kind = try c.decode(AskKind.self, forKey: .kind)
        questions = c.lenient([AskQuestion].self, .questions) ?? []
        plan = c.lenient(String.self, .plan)
        delivery = c.lenient(String.self, .delivery).flatMap(AskDelivery.init(rawValue:)) ?? .unknown
    }

    /// Shown before sending when the question can only be answered by stopping it first.
    public var routeNote: String? {
        switch delivery {
        case .stopAndSend: "Squeak will stop the question and send your answer as a message."
        case .unavailable: "Conductor's relay isn't connected, so this can't be answered from here."
        case .direct, .unknown: nil
        }
    }

    public var canDeliver: Bool { delivery != .unavailable }
}

public struct AskAnswer: Encodable, Sendable, Equatable {
    public var question: Int
    public var picked: [String]
    public var other: String?
    public init(question: Int, picked: [String], other: String? = nil) { self.question = question; self.picked = picked; self.other = other }
}

public enum PlanAnswer: Sendable, Equatable {
    case approve
    case revise(note: String)
}

public enum AnswerOutcome: Sendable, Equatable {
    case answered(via: String, note: String?)
    /// Nothing was sent; the reason is safe to show as is.
    case refused(reason: String)
    /// The request may have been processed: look in Conductor before answering again.
    case uncertain(reason: String)

    /// The one line under the card after sending.
    public var line: String {
        switch self {
        case .answered(let via, let note):
            if let note, !note.isEmpty { return note.hasPrefix("Not confirmed") ? note : "Answered. \(note)" }
            return via == "conductor" ? "Answered in Conductor." : "Answered. Sent as a message after stopping the question."
        case .refused(let reason), .uncertain(let reason): return reason
        }
    }

    public var isAnswered: Bool { if case .answered = self { true } else { false } }
}

struct AnswerBody: Decodable {
    var status: String?
    var via: String?
    var note: String?
    var reason: String?
}

private struct AnswerRequest: Encodable {
    struct Plan: Encodable { var approve: Bool; var note: String? }
    var toolUseId: String
    var answers: [AskAnswer]?
    var plan: Plan?
}

extension DaemonClient {
    /// The chat's pending question or plan; nil when none, or when the daemon predates the route.
    public func pendingAsk(conductorSessionId: String) async throws -> PendingAsk? {
        let r = try await getControl("/control/session/\(Self.encode(conductorSessionId))/question")
        if r.status == 404 || r.status == 503 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        if String(decoding: r.body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "null" { return nil }
        guard let ask = try? JSONDecoder().decode(PendingAsk.self, from: r.body) else {
            throw AdapterError.badResponse("unreadable question")
        }
        return ask
    }

    /// Never throws and never retries: an answer could otherwise be delivered twice.
    public func answer(
        conductorSessionId: String, toolUseId: String, answers: [AskAnswer]? = nil, plan: PlanAnswer? = nil
    ) async -> AnswerOutcome {
        guard let token = tokenProvider() else { return .refused(reason: "Squeak's access token was not found") }
        let planBody: AnswerRequest.Plan? = switch plan {
        case .approve: .init(approve: true, note: nil)
        case .revise(let note): .init(approve: false, note: note)
        case nil: nil
        }
        guard let body = try? JSONEncoder().encode(AnswerRequest(toolUseId: toolUseId, answers: answers, plan: planBody)) else {
            return .refused(reason: "Could not encode the answer")
        }
        let request = HTTPRequest(
            method: "POST", url: controlURL("/control/session/\(Self.encode(conductorSessionId))/answer"),
            headers: ["x-squeak-token": token, "content-type": "application/json"], body: body, timeout: 40)
        let response: HTTPResponse
        do {
            response = try await transportForControl.send(request)
        } catch let e as TransportError {
            switch e {
            case .connectionRefused: return .refused(reason: "Squeak is not running")
            case .timedOut: return .uncertain(reason: "Not confirmed — check Conductor. Squeak did not answer in time.")
            case .connectionLost: return .uncertain(reason: "Not confirmed — check Conductor. The connection to Squeak dropped.")
            case .other(let m): return .refused(reason: m)
            }
        } catch {
            return .refused(reason: "Request failed")
        }
        if response.status == 401 || response.status == 403 { return .refused(reason: "Squeak rejected the access token") }
        if response.status == 404 || response.status == 503 {
            return .refused(reason: "This version of the Squeak service can't take answers yet. Update the service.")
        }
        let parsed = try? JSONDecoder().decode(AnswerBody.self, from: response.body)
        switch parsed?.status {
        case "answered": return .answered(via: parsed?.via ?? "conductor", note: parsed?.note)
        case "refused":
            let reason = parsed?.reason ?? "Squeak refused the answer"
            return reason.hasPrefix("Not confirmed") ? .uncertain(reason: reason) : .refused(reason: reason)
        default:
            if (400..<500).contains(response.status) { return .refused(reason: "Squeak rejected the request (HTTP \(response.status))") }
            return .uncertain(reason: "Not confirmed — check Conductor. Unexpected reply from Squeak (HTTP \(response.status)).")
        }
    }
}

/// The question card's state and rules, out of the view so they are tested. Mirrors the daemon's
/// validation: single-select takes exactly one pick or "something else", multi-select any.
public struct AskForm: Sendable, Equatable {
    public static let maxOther = 2_000
    public static let maxNote = 2_000

    public let ask: PendingAsk
    public var index = 0
    public private(set) var picks: [Set<String>]
    public private(set) var other: [String]
    public private(set) var usingOther: [Bool]
    public var planNote = ""
    public var revising = false

    public init(_ ask: PendingAsk) {
        self.ask = ask
        picks = Array(repeating: [], count: ask.questions.count)
        other = Array(repeating: "", count: ask.questions.count)
        usingOther = Array(repeating: false, count: ask.questions.count)
    }

    public var count: Int { ask.questions.count }
    public var current: AskQuestion? { ask.questions.indices.contains(index) ? ask.questions[index] : nil }
    public var progress: String? { count > 1 ? "\(index + 1) of \(count)" : nil }
    public var canGoBack: Bool { index > 0 }
    public var canGoNext: Bool { index + 1 < count }

    public mutating func next() { if canGoNext { index += 1 } }
    public mutating func back() { if canGoBack { index -= 1 } }

    public mutating func toggle(_ label: String, in q: Int) {
        guard ask.questions.indices.contains(q), ask.questions[q].options.contains(where: { $0.label == label }) else { return }
        if ask.questions[q].multiSelect {
            if picks[q].contains(label) { picks[q].remove(label) } else { picks[q].insert(label) }
        } else {
            picks[q] = [label]
            usingOther[q] = false
        }
    }

    public mutating func setUsingOther(_ on: Bool, in q: Int) {
        guard ask.questions.indices.contains(q) else { return }
        usingOther[q] = on
        if on, !ask.questions[q].multiSelect { picks[q] = [] }
    }

    public mutating func setOther(_ text: String, in q: Int) {
        guard ask.questions.indices.contains(q) else { return }
        other[q] = String(text.prefix(Self.maxOther))
    }

    private func trimmedOther(_ q: Int) -> String { other[q].trimmingCharacters(in: .whitespacesAndNewlines) }

    public func isAnswered(_ q: Int) -> Bool {
        guard ask.questions.indices.contains(q) else { return false }
        let hasOther = usingOther[q] && !trimmedOther(q).isEmpty
        if ask.questions[q].multiSelect { return !picks[q].isEmpty || hasOther }
        return (picks[q].count == 1 && !usingOther[q]) || hasOther
    }

    public var isComplete: Bool {
        if ask.kind == .plan { return !revising || !planNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return count > 0 && (0..<count).allSatisfy(isAnswered)
    }

    /// `Menu bar, iPhone app · Later`: what will be sent, in question order; nil until something is answered.
    public var summary: String? {
        let parts = (0..<count).compactMap { q -> String? in
            guard isAnswered(q) else { return nil }
            return answerText(q)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func answerText(_ q: Int) -> String {
        let ordered = ask.questions[q].options.map(\.label).filter { picks[q].contains($0) }
        let extra = usingOther[q] && !trimmedOther(q).isEmpty ? [trimmedOther(q)] : []
        return (ordered + extra).joined(separator: ", ")
    }

    public func answers() -> [AskAnswer] {
        (0..<count).map { q in
            let ordered = ask.questions[q].options.map(\.label).filter { picks[q].contains($0) }
            let extra = usingOther[q] ? trimmedOther(q) : ""
            return AskAnswer(question: q, picked: ordered, other: extra.isEmpty ? nil : extra)
        }
    }

    public var plan: PlanAnswer? {
        guard ask.kind == .plan else { return nil }
        let note = String(planNote.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxNote))
        return revising ? .revise(note: note) : .approve
    }
}
