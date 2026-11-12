import Foundation

/// A chat's background helpers ("ducklings"): the optional `ducklings` field of a session, from the host and the
/// daemon. It never makes a chat "working": a chat whose turn ended with helpers running is Ready.
public struct Duckling: Hashable, Codable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case agent, shell }
    public enum Status: String, Codable, Sendable { case running, done, failed, stopped }

    public var id: String
    public var kind: Kind
    public var title: String
    public var model: String?
    public var status: Status
    public var startedAt: Date?
    public var endedAt: Date?
    public var summary: String?

    enum CodingKeys: String, CodingKey { case id, kind, title, model, status, startedAt, endedAt, summary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.lenient(Kind.self, .kind) ?? .agent
        title = c.lenient(String.self, .title) ?? "Helper"
        model = c.lenient(String.self, .model).flatMap { $0.isEmpty ? nil : $0 }
        status = c.lenient(Status.self, .status) ?? .running
        func date(_ k: CodingKeys) -> Date? { c.lenient(String.self, k).flatMap(DaemonDate.parse) ?? c.lenient(Date.self, k) }
        startedAt = date(.startedAt)
        endedAt = date(.endedAt)
        summary = c.lenient(String.self, .summary)
    }

    public init(id: String, kind: Kind = .agent, title: String, model: String? = nil, status: Status = .running,
                startedAt: Date? = nil, endedAt: Date? = nil, summary: String? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.model = model; self.status = status
        self.startedAt = startedAt; self.endedAt = endedAt; self.summary = summary
    }

    /// "4m", "1h 5m", "12s": how long it has run (or ran).
    public func elapsed(now: Date = Date()) -> String? {
        guard let startedAt else { return nil }
        let seconds = max(0, Int((endedAt ?? now).timeIntervalSince(startedAt)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
    }

    /// What a chip reads: "Review the diff · Sonnet 5.5 · 4m".
    public func chipText(now: Date = Date()) -> String {
        [title, kind == .agent ? model : nil, elapsed(now: now)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The chip's mark: a check for a finished one, a cross for a failed one; a running one shows its own loader (nil).
    public var chipMark: String? {
        switch status {
        case .running: nil
        case .done: "✓"
        case .failed: "✕"
        case .stopped: "–"
        }
    }

    public var statusWord: String {
        switch status {
        case .running: "Running"
        case .done: "Finished"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }
}

public struct DucklingSet: Hashable, Codable, Sendable {
    public var running: Int
    /// Newest first.
    public var items: [Duckling]

    public init(running: Int, items: [Duckling] = []) { self.running = running; self.items = items }

    enum CodingKeys: String, CodingKey { case running, items }
    /// Lenient: a bad item is skipped, a missing count is the running items. (A wholly wrong field decodes to nil
    /// through `lenient`, which is how older hosts that omit it look.)
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (c.lenient([Failable<Duckling>].self, .items) ?? []).compactMap(\.value).filter { !$0.id.isEmpty }
        running = max(0, c.lenient(Int.self, .running) ?? items.filter { $0.status == .running }.count)
    }

    public var isEmpty: Bool { running == 0 && items.isEmpty }
}

/// What the thread, the sidebar and the dashboard say about ducklings; pure so the replay and unit tests pin it.
public enum DucklingWords {
    /// "1 duckling" / "3 ducklings".
    public static func count(_ n: Int) -> String { "\(n) \(n == 1 ? "duckling" : "ducklings")" }

    /// The thread's status line while the chat is idle with helpers: "Ready · 2 ducklings running"; nil without any.
    public static func readyLine(running: Int) -> String? { running > 0 ? "Ready · \(count(running)) running" : nil }

    /// The bar above the composer: "2 in the background"; "All done" when only finished ones remain; nil shows no bar.
    public static func barText(_ set: DucklingSet?) -> String? {
        guard let set, !set.isEmpty else { return nil }
        if set.running > 0 { return "\(set.running) in the background" }
        return set.items.contains { $0.status == .failed } ? "Background work finished, one failed" : "Background work finished"
    }

    /// The dashboard's top figure: "3 ducklings running · 2 threads"; nil when none run.
    public static func dashboardFigure(running: Int, threads: Int) -> String? {
        guard running > 0 else { return nil }
        return "\(count(running)) running · \(threads) \(threads == 1 ? "thread" : "threads")"
    }
}

/// Where the idle-with-helpers rule decides things; used by `ChatDock`.
public enum DucklingRules {
    /// Ducklings present (even zero) mean the host speaks the new contract: its count must never hold the thread open.
    public static func hostSpeaks(_ set: DucklingSet?) -> Bool { set != nil }
}

/// A duckling opened in the side panel: `GET /native/sessions/:id/ducklings/:taskId`.
public struct DucklingDetail: Decodable, Sendable, Equatable {
    public var id: String
    public var title: String?
    public var model: String?
    public var status: String?
    public var startedAt: Date?
    public var endedAt: Date?
    public var brief: String?
    public var steps: [DaemonActivity.Step]
    public var report: String?

    enum CodingKeys: String, CodingKey { case id, title, model, status, startedAt, endedAt, brief, steps, report }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title)
        model = c.lenient(String.self, .model)
        status = c.lenient(String.self, .status)
        startedAt = c.lenient(String.self, .startedAt).flatMap(DaemonDate.parse)
        endedAt = c.lenient(String.self, .endedAt).flatMap(DaemonDate.parse)
        brief = c.lenient(String.self, .brief)
        steps = (c.lenient([Failable<DaemonActivity.Step>].self, .steps) ?? []).compactMap(\.value)
        report = c.lenient(String.self, .report)
    }
    public init(id: String, title: String? = nil, model: String? = nil, status: String? = nil, startedAt: Date? = nil,
                endedAt: Date? = nil, brief: String? = nil, steps: [DaemonActivity.Step] = [], report: String? = nil) {
        self.id = id; self.title = title; self.model = model; self.status = status; self.startedAt = startedAt
        self.endedAt = endedAt; self.brief = brief; self.steps = steps; self.report = report
    }
}

/// What the side panel shows, decided here; the view only draws it.
public struct DucklingPanelModel: Equatable, Sendable {
    public enum Body: Equatable, Sendable { case loading, unavailable, unreachable, ready }
    public var body: Body
    public var title: String
    public var model: String?
    public var status: Duckling.Status
    public var brief: String?
    public var steps: [ActivityStep]
    public var report: String?
    /// The panel keeps polling only while the duckling runs.
    public var isLive: Bool { status == .running && body != .unavailable }

    public static let unavailableText = "Update Squeak's background service to watch ducklings."

    /// `chip` is the duckling's row (title, status) from the session, shown before the route answers.
    public static func make(result: Result<DucklingDetail?, any Error>?, chip: Duckling?, previous: DucklingPanelModel? = nil) -> DucklingPanelModel {
        let base = DucklingPanelModel(body: .loading, title: chip?.title ?? "Duckling", model: chip?.model, status: chip?.status ?? .running,
                                      brief: nil, steps: [], report: chip?.summary)
        guard let result else { return previous ?? base }
        switch result {
        case .failure:
            var kept = previous ?? base
            kept.body = kept.body == .ready ? .ready : .unreachable
            return kept
        case .success(let detail):
            guard let detail else { var m = base; m.body = .unavailable; return m }
            let status = (detail.status.flatMap(Duckling.Status.init)) ?? chip?.status ?? .running
            return DucklingPanelModel(
                body: .ready, title: detail.title ?? base.title, model: detail.model ?? base.model, status: status,
                brief: detail.brief.flatMap { $0.isEmpty ? nil : $0 },
                steps: detail.steps.map { ActivityStep(kind: $0.kind, text: $0.text, at: $0.at) },
                report: detail.report.flatMap { $0.isEmpty ? nil : $0 } ?? chip?.summary)
        }
    }

    public var message: String? {
        switch body {
        case .loading: "Reading the duckling…"
        case .unavailable: Self.unavailableText
        case .unreachable: "Squeak's background service did not answer. Trying again."
        case .ready: steps.isEmpty && report == nil ? "No steps yet." : nil
        }
    }
}

/// The duckling the side panel shows: which chat, which task.
public struct DucklingRef: Hashable, Sendable {
    public var session: SessionKey
    public var taskId: String
    public init(session: SessionKey, taskId: String) { self.session = session; self.taskId = taskId }
}

extension DashboardBoard {
    /// Helpers running across the dashboard's threads, and how many threads have any (the top figure).
    public static func ducklingTotals(_ columns: [DashboardColumn]) -> (running: Int, threads: Int) {
        var running = 0, threads = 0
        for column in columns {
            for item in column.workspaces {
                guard let chat = destination(in: item.workspace), let n = chat.ducklings?.running, n > 0 else { continue }
                running += n; threads += 1
            }
        }
        return (running, threads)
    }
}
