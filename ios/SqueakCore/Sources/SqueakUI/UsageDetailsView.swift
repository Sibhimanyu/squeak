#if os(iOS)
import SqueakCore
import SwiftUI

/// Usage › Details: what the agents on the Mac have used, like Claude Code's `/stats`, over 7 days, 30 days
/// or all time. The Mac works it out from the agents' own files and answers one range per ask; nothing here
/// is computed on the phone beyond wording. Bars are ink, never a state colour (DESIGN.md §3.3).
struct UsageDetailsView: View {
    @Environment(AppModel.self) private var model
    /// `-squeak-usage-codex` and `-squeak-scrollend` are for screenshots only.
    @State private var agent = ProcessInfo.processInfo.arguments.contains("-squeak-usage-codex") ? "codex" : "claude"
    @State private var range = "7d"
    @State private var stats: UsageStatsView?
    @State private var problem: String?
    @State private var loading = false

    private static let ranges = [("7d", "7 days"), ("30d", "30 days"), ("all", "All time")]
    private static let agents = [("claude", "Claude"), ("codex", "Codex (ChatGPT)")]

    var body: some View {
        ScrollViewReader { reader in
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Picker("Agent", selection: $agent) {
                    ForEach(Self.agents, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                Picker("Range", selection: $range) {
                    ForEach(Self.ranges, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                if let stats, stats.agent == nil || stats.agent == agent {
                    if stats.pending > 0 {
                        Text("Your Mac is still reading \(stats.pending) files for the first time, so these will grow.")
                            .font(.footnote).foregroundStyle(Theme.muted)
                    }
                    headline(stats)
                    tokens(stats.totals)
                    if !stats.daily.isEmpty { daily(stats.daily, allTime: stats.range == "all") }
                    if !stats.models.isEmpty { models(stats.models) }
                    if !stats.projects.isEmpty { projects(stats.projects, total: stats.totals.tokens) }
                    source(stats)
                } else if loading {
                    HStack(spacing: 8) { ProgressView(); Text("Asking your Mac…").foregroundStyle(Theme.muted) }
                }
                if let problem { Text(problem).foregroundStyle(Theme.muted) }
                Color.clear.frame(height: 1).id("end")
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: stats) {
            if ProcessInfo.processInfo.arguments.contains("-squeak-scrollend") { reader.scrollTo("end", anchor: .bottom) }
        }
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .navigationTitle("Details")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: "\(agent) \(range)") { await load() }
    }

    private func load() async {
        loading = true
        let asked = (agent, range)
        let (answer, failure) = await model.usageStats(asked.1, agent: asked.0)
        guard asked == (agent, range) else { return }
        if let answer { stats = answer }
        problem = failure
        loading = false
    }

    // MARK: Headline

    private func headline(_ s: UsageStatsView) -> some View {
        let tiles: [(String, String, String?)] = [
            ("Tokens", UsageStatsFormat.tokens(s.totals.tokens), nil),
            ("Estimated cost", UsageStatsFormat.cost(s.totals.costUsd) ?? "Not priced", s.totals.costUsd == nil ? nil : "At API rates"),
            ("Sessions", "\(s.totals.sessions)", "\(UsageStatsFormat.tokens(s.totals.messages)) messages"),
            ("Active days", "\(s.activeDays)", nil),
            ("Current streak", UsageStatsFormat.days(s.currentStreak), "Longest \(UsageStatsFormat.days(s.longestStreak))"),
            ("Favorite model", s.favoriteModel.map(UsageStatsFormat.model) ?? "None yet", nil),
            ("Busiest hour", s.peakHour.map(UsageStatsFormat.hour) ?? "Not yet", nil),
            ("Longest session", s.longestSession.map { UsageStatsFormat.duration(minutes: $0.minutes) } ?? "None yet", s.longestSession?.project),
        ]
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(tiles, id: \.0) { title, value, detail in
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.footnote).foregroundStyle(Theme.muted)
                    Text(value).font(.title3.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                    if let detail { Text(detail).font(.caption).foregroundStyle(Theme.muted).lineLimit(1) }
                }
                .frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Tokens by kind

    private func tokens(_ t: UsageStatsView.Totals) -> some View {
        section("Tokens") {
            let rows: [(String, Int)] = [("Input", t.input), ("Output", t.output), ("Cache reads", t.cacheRead), ("Cache writes", t.cacheWrite)]
            ForEach(rows, id: \.0) { name, value in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(name).font(.subheadline)
                        Spacer()
                        Text(UsageStatsFormat.tokens(value)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    UsageBar(fraction: t.tokens > 0 ? Double(value) / Double(t.tokens) : 0)
                }
                .accessibilityElement(children: .combine)
            }
            Text("Cache reads are the context an agent reads again each turn; they cost a tenth of fresh input or less.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    // MARK: By day

    private func daily(_ days: [UsageStatsView.Day], allTime: Bool) -> some View {
        let peak = max(days.map(\.tokens).max() ?? 0, 1)
        return section(allTime ? "Last 30 active days" : "By day") {
            HStack(alignment: .bottom, spacing: days.count > 10 ? 2 : 6) {
                ForEach(days) { day in
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(day.tokens > 0 ? Theme.ink : Theme.line)
                            .frame(height: max(2, 96 * CGFloat(day.tokens) / CGFloat(peak)))
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 96)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Tokens by day, peak \(UsageStatsFormat.tokens(peak))")
            HStack {
                Text(Self.shortDate(days.first?.date)).font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Text("Peak \(UsageStatsFormat.tokens(peak))").font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Text(Self.shortDate(days.last?.date)).font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }

    private static func shortDate(_ date: String?) -> String {
        guard let date, let parsed = ISO8601DateFormatter.localDay.date(from: date) else { return "" }
        return parsed.formatted(.dateTime.day().month(.abbreviated))
    }

    // MARK: Where it comes from

    private func source(_ s: UsageStatsView) -> some View {
        section("Where this comes from") {
            Text(UsageStatsFormat.source(s)).font(.footnote).foregroundStyle(Theme.muted)
            if let record = s.claudeCodeRecord {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Claude Code's own count").font(.subheadline)
                        Spacer()
                        Text(UsageStatsFormat.tokens(record.tokens)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    Text(UsageStatsFormat.recordNote(record)).font(.footnote).foregroundStyle(Theme.muted)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Models and projects

    private func models(_ models: [UsageStatsView.Model]) -> some View {
        section("Models") {
            ForEach(models) { m in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(UsageStatsFormat.model(m.model)).font(.subheadline)
                        Spacer()
                        Text("\(Int((m.share * 100).rounded()))%").font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    UsageBar(fraction: m.share)
                    Text([UsageStatsFormat.tokens(m.tokens) + " tokens", UsageStatsFormat.cost(m.costUsd)].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func projects(_ projects: [UsageStatsView.Project], total: Int) -> some View {
        section("Top projects") {
            ForEach(projects) { p in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(p.name).font(.subheadline).lineLimit(1)
                        Spacer()
                        Text(UsageStatsFormat.tokens(p.tokens)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    UsageBar(fraction: total > 0 ? Double(p.tokens) / Double(total) : 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

private extension ISO8601DateFormatter {
    /// "2026-10-24" in the phone's own time zone.
    static let localDay: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        f.timeZone = .current
        return f
    }()
}

extension DemoData {
    /// The demo Mac's detailed usage, for screenshots: shaped like a real week, one agent at a time, built
    /// through the same decoder as a real answer.
    static func usageStats(_ range: String, agent: String = "claude") -> UsageStatsView {
        let codex = agent == "codex"
        let days = range == "7d" ? 7 : 30
        let formatter = ISO8601DateFormatter.localDay
        let scale = codex ? 40_000 : 1_000_000
        let daily: [[String: Any]] = (0..<days).map { i in
            let date = Date().addingTimeInterval(Double(i - days + 1) * 86_400)
            return ["date": formatter.string(from: date), "tokens": [180, 420, 260, 0, 610, 380, 520][i % 7] * scale]
        }
        let total = daily.compactMap { $0["tokens"] as? Int }.reduce(0, +)
        let ago = { (n: Double) in formatter.string(from: Date().addingTimeInterval(-n * 86_400)) }
        let totals: [String: Any] = [
            "tokens": total, "input": total / 400, "output": total / 250, "cacheRead": total * 96 / 100,
            "cacheWrite": total / 50, "messages": total / 210_000, "sessions": days * (codex ? 4 : 26),
            "costUsd": codex ? NSNull() : Double(total) / 3_100_000,
        ]
        let codexModels: [[String: Any]] = [
            ["model": "gpt-6.1-sol", "agent": "codex", "tokens": total * 7 / 10, "share": 0.7],
            ["model": "gpt-5.6-terra", "agent": "codex", "tokens": total * 3 / 10, "share": 0.3],
        ]
        let claudeModels: [[String: Any]] = [
            ["model": "claude-opus-5-5", "agent": "claude", "tokens": total * 68 / 100, "share": 0.68, "costUsd": Double(total) / 4_200_000],
            ["model": "claude-sonnet-5-5", "agent": "claude", "tokens": total * 30 / 100, "share": 0.30, "costUsd": Double(total) / 11_000_000],
            ["model": "claude-haiku-5-5", "agent": "claude", "tokens": total * 2 / 100, "share": 0.02, "costUsd": 1.2],
        ]
        let projects: [[String: Any]] = [
            ["name": "squeak", "tokens": total * 6 / 10], ["name": "motion-graphics-skill", "tokens": total * 3 / 10],
            ["name": "greenroom", "tokens": total / 10],
        ]
        let activeDays = daily.filter { ($0["tokens"] as? Int ?? 0) > 0 }.count
        var json: [String: Any] = ["range": range, "agent": agent, "since": ago(codex ? 24 : 33)]
        json["computedAt"] = ISO8601DateFormatter().string(from: Date())
        json["pending"] = 0
        json["totals"] = totals
        json["activeDays"] = activeDays
        json["currentStreak"] = 3
        json["longestStreak"] = 12
        json["favoriteModel"] = codex ? "gpt-6.1-sol" : "claude-opus-5-5"
        json["peakHour"] = 11
        json["longestSession"] = ["minutes": codex ? 96 : 1044, "project": "squeak"] as [String: Any]
        json["models"] = codex ? codexModels : claudeModels
        json["daily"] = daily
        json["projects"] = projects
        if !codex {
            json["keepDays"] = 30
            json["keptFrom"] = ago(30)
            json["claudeCodeRecord"] = ["tokens": total * 2, "sessions": days * 24, "messages": total / 90_000,
                                        "since": ago(115), "through": ago(0)]
        }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(UsageStatsView.self, from: data)
    }
}
#endif
