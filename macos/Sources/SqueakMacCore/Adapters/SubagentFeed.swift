import Foundation

/// What one subagent of a working Claude chat is doing: `GET /control/session/<key>/subagent/<id>/activity`.
/// Every field is optional on the wire, so a daemon that adds or drops one still decodes.
public struct DaemonSubagentFeed: Decodable, Sendable, Equatable {
    public var taskId: String?
    public var agentId: String?
    public var label: String?
    /// "running", "done", "failed" or "stopped".
    public var status: String?
    /// False while the subagent's transcript is not readable yet (`steps` is empty).
    public var available: Bool?
    public var steps: [DaemonActivity.Step]
    /// How many steps the subagent has had; `steps` is only the newest.
    public var total: Int?
    public var startedAt: Date?
    public var endedAt: Date?

    enum CodingKeys: String, CodingKey { case taskId, agentId, label, status, available, steps, total, startedAt, endedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = c.lenient(String.self, .taskId)
        agentId = c.lenient(String.self, .agentId)
        label = c.lenient(String.self, .label)
        status = c.lenient(String.self, .status)
        available = c.lenient(Bool.self, .available)
        steps = (c.lenient([Failable<DaemonActivity.Step>].self, .steps) ?? []).compactMap(\.value)
        total = c.lenient(Int.self, .total)
        startedAt = c.lenient(String.self, .startedAt).flatMap(DaemonDate.parse)
        endedAt = c.lenient(String.self, .endedAt).flatMap(DaemonDate.parse)
    }

    public init(taskId: String? = nil, agentId: String? = nil, label: String? = nil, status: String? = nil, available: Bool? = nil,
                steps: [DaemonActivity.Step] = [], total: Int? = nil, startedAt: Date? = nil, endedAt: Date? = nil) {
        self.taskId = taskId; self.agentId = agentId; self.label = label; self.status = status; self.available = available
        self.steps = steps; self.total = total; self.startedAt = startedAt; self.endedAt = endedAt
    }
}

/// What the opened subagent row shows, decided here so a test can pin every case. The window only draws it.
public struct SubagentFeedPresentation: Equatable, Sendable {
    public enum Body: Equatable, Sendable {
        /// Nothing answered yet.
        case loading
        /// The daemon answered 404: it predates the route, or no longer has the task.
        case olderDaemon
        /// The daemon could not be reached; the last steps (if any) stay.
        case unreachable
        /// The subagent's transcript is not readable yet.
        case notReadable
        /// Readable, nothing done yet.
        case noSteps
        case steps([ActivityStep])
    }
    public var body: Body
    /// "Running", "Done", "Failed", "Stopped"; nil until the daemon says.
    public var chip: String?
    public var chipStatus: String?
    /// "Showing the newest 50 of 120 steps", only when the daemon clipped.
    public var clippedNote: String?

    public static let olderDaemonText = "Update Squeak's background service to see subagent steps."

    public var message: String? {
        switch body {
        case .loading: "Reading the subagent's steps…"
        case .olderDaemon: Self.olderDaemonText
        case .unreachable: "Squeak's background service did not answer. Trying again."
        case .notReadable: "The subagent's steps can't be read yet."
        case .noSteps: "No steps yet."
        case .steps: nil
        }
    }

    /// `previous` is what the row showed before this read; a failed read keeps its steps.
    public static func make(result: Result<DaemonSubagentFeed?, any Error>?, previous: SubagentFeedPresentation? = nil,
                            fallbackStatus: String? = nil) -> SubagentFeedPresentation {
        guard let result else { return SubagentFeedPresentation(body: .loading, chip: chip(fallbackStatus), chipStatus: fallbackStatus) }
        switch result {
        case .failure:
            var kept = previous ?? SubagentFeedPresentation(body: .unreachable, chip: chip(fallbackStatus), chipStatus: fallbackStatus)
            if case .steps = kept.body {} else { kept.body = .unreachable }
            return kept
        case .success(let feed):
            guard let feed else { return SubagentFeedPresentation(body: .olderDaemon, chip: chip(fallbackStatus), chipStatus: fallbackStatus) }
            let status = feed.status ?? fallbackStatus
            let steps = feed.steps.map { ActivityStep(kind: $0.kind, text: $0.text, at: $0.at) }
            let body: Body = feed.available == false ? .notReadable : steps.isEmpty ? .noSteps : .steps(steps)
            var note: String?
            if let total = feed.total, total > steps.count, !steps.isEmpty { note = "Showing the newest \(steps.count) of \(total) steps" }
            return SubagentFeedPresentation(body: body, chip: chip(status), chipStatus: status, clippedNote: note)
        }
    }

    public static func chip(_ status: String?) -> String? {
        switch status {
        case "running": "Running"
        case "done": "Done"
        case "failed": "Failed"
        case "stopped": "Stopped"
        default: nil
        }
    }

    /// The daemon's own rule for a task id (`^[A-Za-z0-9_-]{8,80}$`); anything else is never put in a path.
    public static func isValidTaskId(_ id: String) -> Bool {
        (8...80).contains(id.utf8.count) && id.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 95 || $0 == 45
        }
    }
}
