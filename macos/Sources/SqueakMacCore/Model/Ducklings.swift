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
    /// When the agent took this helper's report in (host-side: its next assistant row after the notification); nil
    /// from a host that does not say, or while it has not yet.
    public var reportedAt: Date?

    enum CodingKeys: String, CodingKey { case id, kind, title, model, status, startedAt, endedAt, summary, reportedAt }
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
        reportedAt = date(.reportedAt)
    }

    public init(id: String, kind: Kind = .agent, title: String, model: String? = nil, status: Status = .running,
                startedAt: Date? = nil, endedAt: Date? = nil, summary: String? = nil, reportedAt: Date? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.model = model; self.status = status
        self.startedAt = startedAt; self.endedAt = endedAt; self.summary = summary; self.reportedAt = reportedAt
    }

    /// Seconds after it ended that a finished chip is kept when the host cannot say its report was taken in.
    public static let unreportedKeepSeconds: TimeInterval = 20

    /// Whether the bar still shows this chip. A running one always; a finished one until its report reached the agent
    /// (`reportedAt`); with no `reportedAt`, until `unreportedKeepSeconds` after it ended. A failed one waits for the
    /// report alone (the host drops it after 10 minutes). The stream's own duckling row is not governed by this.
    public func isShownInBar(now: Date) -> Bool {
        if status == .running { return true }
        if let reportedAt { return reportedAt > now }
        if status == .failed { return true }
        guard let endedAt else { return true }
        return now.timeIntervalSince(endedAt) < Self.unreportedKeepSeconds
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

    /// The chips the bar shows at `now` (see `Duckling.isShownInBar`).
    public func barItems(now: Date) -> [Duckling] { items.filter { $0.isShownInBar(now: now) } }
}

/// What the thread, the sidebar and the dashboard say about ducklings; pure so the replay and unit tests pin it.
public enum DucklingWords {
    /// "1 duckling" / "3 ducklings".
    public static func count(_ n: Int) -> String { "\(n) \(n == 1 ? "duckling" : "ducklings")" }

    /// The thread's status line while the chat is idle with helpers: "Ready · 2 ducklings running"; nil without any.
    public static func readyLine(running: Int) -> String? { running > 0 ? "Ready · \(count(running)) running" : nil }

    /// The working row while the agent itself works and ducklings run: "Working… · 2 ducklings in the background".
    public static func workingLine(_ base: String, running: Int) -> String {
        running > 0 ? "\(base) · \(count(running)) in the background" : base
    }

    /// The bar above the composer: "2 in the background"; a line while only finished chips await their report; nil = no bar.
    public static func barText(_ set: DucklingSet?, now: Date = Date()) -> String? {
        guard let set else { return nil }
        if set.running > 0 { return "\(set.running) in the background" }
        let shown = set.barItems(now: now)
        if shown.isEmpty { return nil }
        return shown.contains { $0.status == .failed } ? "Background work finished, one failed" : "Background work finished"
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
    /// The panel's parts, top to bottom: steps first, the report once there is one, what it was asked last.
    public enum Part: Equatable, Sendable { case steps, report, brief }
    public var body: Body
    public var title: String
    public var model: String?
    public var status: Duckling.Status
    public var startedAt: Date?
    public var endedAt: Date?
    public var brief: String?
    public var steps: [ActivityStep]
    public var report: String?
    /// The panel keeps polling only while the duckling runs.
    public var isLive: Bool { status == .running && body != .unavailable }

    public static let unavailableText = "Update Squeak's background service to watch ducklings."
    public static let briefLineLimit = 3
    public static let briefCharLimit = 320

    /// `chip` is the duckling's row (title, status) from the session, shown before the route answers.
    public static func make(result: Result<DucklingDetail?, any Error>?, chip: Duckling?, previous: DucklingPanelModel? = nil) -> DucklingPanelModel {
        let base = DucklingPanelModel(body: .loading, title: chip?.title ?? "Duckling", model: chip?.model, status: chip?.status ?? .running,
                                      startedAt: chip?.startedAt, endedAt: chip?.endedAt, brief: nil, steps: [], report: chip?.summary)
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
                startedAt: detail.startedAt ?? base.startedAt, endedAt: detail.endedAt ?? base.endedAt,
                brief: detail.brief.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 },
                steps: detail.steps.map { ActivityStep(kind: $0.kind, text: $0.text, at: $0.at) },
                report: detail.report.flatMap { $0.isEmpty ? nil : $0 } ?? chip?.summary)
        }
    }

    /// The parts to draw, in order. Steps are always there (they say why they are empty); the report only when there is
    /// one; the brief last, folded.
    public var parts: [Part] {
        guard body == .ready else { return [.steps] }
        var p: [Part] = [.steps]
        if report != nil { p.append(.report) }
        if brief != nil { p.append(.brief) }
        return p
    }

    /// "4m" / "12s": how long it has run (or ran), from the detail's own times.
    public func elapsed(now: Date = Date()) -> String? {
        Duckling(id: "", title: "", status: status, startedAt: startedAt, endedAt: endedAt).elapsed(now: now)
    }

    /// The sentence under an empty steps list; nil when steps are listed (or the panel has its own message).
    public var stepsEmptyText: String? {
        guard body == .ready, steps.isEmpty else { return nil }
        return status == .running ? "Steps will appear here as it works" : "No steps were recorded"
    }

    /// The brief folded to a few lines (markdown source, cut at a line or word); `isCut` says there is more to open.
    public var briefPreview: (text: String, isCut: Bool)? {
        brief.map { Self.briefPreview($0) }
    }

    public static func briefPreview(_ brief: String, lines: Int = briefLineLimit, chars: Int = briefCharLimit) -> (text: String, isCut: Bool) {
        let all = brief.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: true)
        var out = all.prefix(lines).joined(separator: "\n")
        var cut = all.count > lines
        if out.count > chars {
            let head = String(out.prefix(chars))
            out = head.lastIndex(of: " ").map { String(head[..<$0]) } ?? head
            cut = true
        }
        return (out, cut)
    }

    /// A line only while it has something to say that the parts do not.
    public var message: String? {
        switch body {
        case .loading: "Reading the duckling…"
        case .unavailable: Self.unavailableText
        case .unreachable: "Squeak's background service did not answer. Trying again."
        case .ready: nil
        }
    }
}

/// The duckling the side panel shows: which chat, which task.
public struct DucklingRef: Hashable, Sendable {
    public var session: SessionKey
    public var taskId: String
    public init(session: SessionKey, taskId: String) { self.session = session; self.taskId = taskId }

    /// The open duckling after the selection changes: it belongs to one chat, so another chat closes it.
    public static func open(_ ref: DucklingRef?, whenSelected selected: SessionKey?) -> DucklingRef? {
        ref.flatMap { $0.session == selected ? $0 : nil }
    }
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
