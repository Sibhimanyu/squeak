#if os(iOS)
import SqueakCore
import SwiftUI

/// Usage › Details: what the agents on the Mac have used, like Claude Code's `/stats`, over 7 days, 30 days
/// or all time. The Mac works it out from the agents' own files and answers one range per ask; nothing here
/// is computed on the phone beyond wording. Bars are ink, never a state colour (DESIGN.md §3.3).
struct UsageDetailsView: View {
    @Environment(AppModel.self) private var model
    @State private var range = "7d"
    @State private var stats: UsageStatsView?
    @State private var problem: String?
    @State private var loading = false

    private static let ranges = [("7d", "7 days"), ("30d", "30 days"), ("all", "All time")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Picker("Range", selection: $range) {
                    ForEach(Self.ranges, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                if let stats {
                    if stats.pending > 0 {
                        Text("Your Mac is still reading \(stats.pending) files for the first time, so these will grow.")
                            .font(.footnote).foregroundStyle(Theme.muted)
                    }
                    headline(stats)
                    tokens(stats.totals)
                    if !stats.daily.isEmpty { daily(stats.daily, allTime: stats.range == "all") }
                    if !stats.models.isEmpty { models(stats.models) }
                    if !stats.projects.isEmpty { projects(stats.projects, total: stats.totals.tokens) }
                } else if loading {
                    HStack(spacing: 8) { ProgressView(); Text("Asking your Mac…").foregroundStyle(Theme.muted) }
                }
                if let problem { Text(problem).foregroundStyle(Theme.muted) }
                Text("Counted from the agents' own files on your Mac, Claude and Codex both. The cost is an estimate for Claude at API rates; Codex isn't priced. Your plan's limits are on the Usage page.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .navigationTitle("Details")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: range) { await load() }
    }

    private func load() async {
        loading = true
        let asked = range
        let (answer, failure) = await model.usageStats(asked)
        guard asked == range else { return }
        if let answer { stats = answer }
        problem = failure
        loading = false
    }

    // MARK: Headline

    private func headline(_ s: UsageStatsView) -> some View {
        let tiles: [(String, String, String?)] = [
            ("Tokens", UsageStatsFormat.tokens(s.totals.tokens), nil),
            ("Estimated cost", UsageStatsFormat.cost(s.totals.costUsd) ?? "Not priced", s.totals.costUsd == nil ? nil : "Claude, at API rates"),
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

    // MARK: Models and projects

    private func models(_ models: [UsageStatsView.Model]) -> some View {
        section("Models") {
            ForEach(models) { m in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(UsageStatsFormat.model(m.model)).font(.subheadline)
                        Text(m.agent == "codex" ? "Codex" : "Claude").font(.caption).foregroundStyle(Theme.muted)
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
    /// The demo Mac's detailed usage, for screenshots: shaped like a real week, built through the same decoder
    /// as a real answer.
    static func usageStats(_ range: String) -> UsageStatsView {
        let days = range == "7d" ? 7 : 30
        let formatter = ISO8601DateFormatter.localDay
        let daily: [[String: Any]] = (0..<days).map { i in
            let date = Date().addingTimeInterval(Double(i - days + 1) * 86_400)
            return ["date": formatter.string(from: date), "tokens": [180, 420, 260, 0, 610, 380, 520][i % 7] * 1_000_000]
        }
        let total = daily.compactMap { $0["tokens"] as? Int }.reduce(0, +)
        let json: [String: Any] = [
            "range": range, "computedAt": ISO8601DateFormatter().string(from: Date()), "pending": 0,
            "totals": ["tokens": total, "input": total / 400, "output": total / 250, "cacheRead": total * 96 / 100,
                       "cacheWrite": total / 50, "messages": total / 210_000, "sessions": days * 26, "costUsd": Double(total) / 3_100_000],
            "activeDays": daily.filter { ($0["tokens"] as? Int ?? 0) > 0 }.count, "currentStreak": 3, "longestStreak": 12,
            "favoriteModel": "claude-opus-5-5", "peakHour": 11, "longestSession": ["minutes": 1044, "project": "squeak"],
            "models": [
                ["model": "claude-opus-5-5", "agent": "claude", "tokens": total * 62 / 100, "share": 0.62, "costUsd": Double(total) / 4_200_000],
                ["model": "claude-sonnet-5-5", "agent": "claude", "tokens": total * 27 / 100, "share": 0.27, "costUsd": Double(total) / 11_000_000],
                ["model": "gpt-6.1-sol", "agent": "codex", "tokens": total * 9 / 100, "share": 0.09],
            ],
            "daily": daily,
            "projects": [["name": "squeak", "tokens": total * 6 / 10], ["name": "motion-graphics-skill", "tokens": total * 3 / 10],
                         ["name": "greenroom", "tokens": total / 10]],
        ]
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(UsageStatsView.self, from: data)
    }
}
#endif
