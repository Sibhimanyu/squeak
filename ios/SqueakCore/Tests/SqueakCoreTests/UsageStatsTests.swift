import XCTest
@testable import SqueakCore

final class UsageStatsTests: XCTestCase {
    /// Exactly what src/fleet/usage-stats.ts `aggregate` writes (made with it, then pasted).
    let daemonJSON = #"{"range":"7d","computedAt":"2026-10-24T06:30:00.000Z","pending":0,"totals":{"tokens":18365,"input":110,"output":55,"cacheRead":18000,"cacheWrite":200,"messages":4,"sessions":2,"costUsd":1.25},"activeDays":2,"currentStreak":2,"longestStreak":2,"favoriteModel":"claude-opus-5-5","peakHour":14,"longestSession":{"minutes":50,"project":"farm"},"models":[{"model":"claude-opus-5-5","agent":"claude","tokens":9250,"share":0.5036754696433433,"costUsd":1.25},{"model":"gpt-6.1-sol","agent":"codex","tokens":9115,"share":0.4963245303566567,"costUsd":null}],"daily":[{"date":"2026-10-18","tokens":0},{"date":"2026-10-19","tokens":0},{"date":"2026-10-20","tokens":0},{"date":"2026-10-21","tokens":0},{"date":"2026-10-22","tokens":0},{"date":"2026-10-23","tokens":9115},{"date":"2026-10-24","tokens":9250}],"projects":[{"name":"farm","tokens":9250}]}"#

    func testDecodesTheDaemonsAnswer() throws {
        let v = try JSONDecoder().decode(UsageStatsView.self, from: Data(daemonJSON.utf8))
        XCTAssertEqual(v.range, "7d")
        XCTAssertEqual(v.totals.sessions, 2)
        XCTAssertEqual(v.totals.costUsd, 1.25)
        XCTAssertEqual(v.favoriteModel, "claude-opus-5-5")
        XCTAssertEqual(v.peakHour, 14)
        XCTAssertEqual(v.longestSession, .init(minutes: 50, project: "farm"))
        XCTAssertEqual(v.daily.count, 7)
        XCTAssertEqual(v.models.last?.costUsd, nil)
        // Inside a command result, too.
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"status":"sent","stats":\#(daemonJSON)}"#.utf8))
        XCTAssertEqual(result.stats, v)
    }

    func testWords() {
        XCTAssertEqual(UsageStatsFormat.tokens(13_900_186_405), "13.9B")
        XCTAssertEqual(UsageStatsFormat.tokens(2_994_740), "3.0M")
        XCTAssertEqual(UsageStatsFormat.tokens(45_000), "45K")
        XCTAssertEqual(UsageStatsFormat.tokens(912), "912")
        XCTAssertEqual(UsageStatsFormat.cost(4128.8), "$4,129")
        XCTAssertEqual(UsageStatsFormat.cost(12.4), "$12.40")
        XCTAssertNil(UsageStatsFormat.cost(nil))
        XCTAssertEqual(UsageStatsFormat.duration(minutes: 1044), "17h 24m")
        XCTAssertEqual(UsageStatsFormat.duration(minutes: 45), "45m")
        XCTAssertEqual(UsageStatsFormat.hour(14), "2 PM – 3 PM")
        XCTAssertEqual(UsageStatsFormat.hour(23), "11 PM – 12 AM")
        XCTAssertEqual(UsageStatsFormat.model("claude-opus-5-5"), "Opus 5.5")
        XCTAssertEqual(UsageStatsFormat.model("claude-sonnet-5"), "Sonnet 5")
        XCTAssertEqual(UsageStatsFormat.model("gpt-6.1-sol"), "gpt-6.1-sol")
        XCTAssertEqual(UsageStatsFormat.days(1), "1 day")
        XCTAssertEqual(UsageStatsFormat.day("2026-09-24"), "24 Sep")
        XCTAssertNil(UsageStatsFormat.day(nil))
    }

    func testSourceSaysWhereAndHowFarBack() throws {
        let claude = try JSONDecoder().decode(UsageStatsView.self, from: Data(#"{"range":"all","agent":"claude","since":"2026-07-01","keepDays":30,"keptFrom":"2026-09-24","claudeCodeRecord":{"tokens":45582279877,"sessions":453,"messages":245534,"since":"2026-07-01","through":"2026-10-22"},"computedAt":"x","pending":0,"totals":{"tokens":1,"input":1,"output":0,"cacheRead":0,"cacheWrite":0,"messages":1,"sessions":1,"costUsd":null},"activeDays":1,"currentStreak":1,"longestStreak":1,"favoriteModel":null,"peakHour":null,"longestSession":null,"models":[],"daily":[],"projects":[]}"#.utf8))
        XCTAssertTrue(UsageStatsFormat.source(claude).contains("deletes each file after 30 days, so All time here starts around 24 Sep"))
        XCTAssertTrue(UsageStatsFormat.recordNote(claude.claudeCodeRecord!).hasPrefix("Claude Code's /stats counts 45.6B tokens since 1 Jul."))
        let codex = try JSONDecoder().decode(UsageStatsView.self, from: Data(#"{"range":"all","agent":"codex","since":"2026-09-30","computedAt":"x","pending":0,"totals":{"tokens":1,"input":1,"output":0,"cacheRead":0,"cacheWrite":0,"messages":1,"sessions":1,"costUsd":null},"activeDays":1,"currentStreak":1,"longestStreak":1,"favoriteModel":null,"peakHour":null,"longestSession":null,"models":[],"daily":[],"projects":[]}"#.utf8))
        XCTAssertTrue(UsageStatsFormat.source(codex).contains("ChatGPT app"))
        XCTAssertTrue(UsageStatsFormat.source(codex).contains("go back to 30 Sep"))
    }
}
