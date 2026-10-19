import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Usage")
struct UsageTests {
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func resetsInHoursAndMinutes() {
        #expect(UsageFormat.resets(now.addingTimeInterval(2 * 3600 + 10 * 60), now: now) == "resets in 2h 10m")
        #expect(UsageFormat.resets(now.addingTimeInterval(3 * 3600), now: now) == "resets in 3h")
        #expect(UsageFormat.resets(now.addingTimeInterval(25 * 60), now: now) == "resets in 25m")
        #expect(UsageFormat.resets(now.addingTimeInterval(5 * 86400 + 3 * 3600), now: now) == "resets in 5d 3h")
    }

    @Test func aWindowThatHasResetIsNotShownAsCurrent() {
        #expect(UsageFormat.resets(now.addingTimeInterval(-60), now: now) == "has reset since")
    }

    @Test func theBarShowsWhatIsLeftAndIsFullOnceTheWindowResets() {
        #expect(UsageFormat.left(76, resetsAt: now.addingTimeInterval(-60), now: now) == "Reset")
        #expect(UsageFormat.remaining(76, resetsAt: now.addingTimeInterval(-60), now: now) == 1)
        #expect(UsageFormat.left(76, resetsAt: now.addingTimeInterval(3600), now: now) == "24% left")
        #expect(abs(UsageFormat.remaining(76, resetsAt: now.addingTimeInterval(3600), now: now) - 0.24) < 0.0001)
    }

    @Test func ageAppearsOnlyOnceAReadingIsStale() {
        #expect(UsageFormat.asOf(now.addingTimeInterval(-1800), now: now) == nil)
        #expect(UsageFormat.asOf(now.addingTimeInterval(-3 * 3600), now: now) == "as of 3 hours ago")
        #expect(UsageFormat.asOf(now.addingTimeInterval(-86400 * 3), now: now) == "as of 3 days ago")
        #expect(UsageFormat.asOf(nil, now: now) == nil)
    }

    @Test func percentBarAndDollars() {
        #expect(UsageFormat.used(41.6) == "42% used")
        #expect(UsageFormat.fraction(140) == 1 && UsageFormat.fraction(-3) == 0)
        #expect(UsageFormat.dollars(14.619) == "$14.62")
        #expect(UsageFormat.dollars(0.004) == "<$0.01")
    }

    @Test func todaysCostCountsOnlyTodaysPricedSessions() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let today = now
        let yesterday = now.addingTimeInterval(-86400)
        let r = UsageFormat.cost(
            of: [(today, 2.5), (today, nil), (yesterday, 9), (nil, 4), (today, 1.25)], now: now, calendar: cal)
        #expect(r.usd == 3.75 && r.sessions == 2)
    }

    @Test func stateCarriesBothReadingsAndTodaysCost() throws {
        let json = """
        {"generatedAt":"2026-10-19T09:00:00Z",
         "claudeLimits":{"fiveHour":{"utilization":0.42,"resetsAt":"2026-10-19T12:00:00.000Z"},
                         "sevenDay":{"utilization":0.18,"resetsAt":"2026-10-23T08:00:00.000Z"},
                         "observedAt":"2026-10-19T06:00:00.000Z"},
         "codexUsage":{"primary":{"usedPercent":9,"windowMinutes":300,"resetsAt":"2026-10-19T12:40:00.000Z"},
                       "secondary":{"usedPercent":31.4,"windowMinutes":10080,"resetsAt":"2026-10-24T03:00:00.000Z"},
                       "observedAt":"2026-10-19T08:59:30.000Z"},
         "active":[{"key":"a","lastActivityAt":"2026-10-19T08:00:00Z","costUsd":2.5},
                   {"key":"b","lastActivityAt":"2026-10-18T08:00:00Z","costUsd":7}],
         "others":[]}
        """
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
        #expect(state.claudeUsage?.fiveHour?.usedPercent == 42)
        #expect(state.claudeUsage?.longWindow?.usedPercent == 18)
        #expect(state.codexUsage?.longWindow?.usedPercent == 31.4)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = DaemonDate.parse("2026-10-19T10:00:00Z")!
        let usage = state.usage(now: now, calendar: cal)
        #expect(usage.todayCostUsd == 2.5 && usage.todayCostSessions == 1)
    }

    @Test func aStateWithoutReadingsIsNotAnError() throws {
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[],"others":[]}"#.utf8))
        #expect(state.claudeUsage == nil && state.codexUsage == nil)
        #expect(state.usage().todayCostUsd == nil)
    }

    @Test func refreshAsksTheDaemonOnceAndReadsTheReading() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/usage/claude-refresh", #"{"claudeLimits":{"fiveHour":{"utilization":0.5,"resetsAt":"2026-10-19T12:00:00.000Z"},"sevenDay":null,"observedAt":"2026-10-19T09:00:00.000Z"},"throttled":false,"refreshed":true}"#)
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
        let r = try await client.refreshClaudeUsage()
        #expect(r?.refreshed == true && r?.throttled == false)
        #expect(r?.claude?.fiveHour?.usedPercent == 50)
        #expect(await t.requests.count == 1)
        #expect(await t.requests[0].headers["x-squeak-token"] == "tok")
    }

    @Test func aDaemonWithoutTheRouteIsNilNotAnError() async throws {
        let t = FakeTransport()
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
        await t.route("POST", "/control/usage/claude-refresh", .success(HTTPResponse(status: 404)))
        #expect(try await client.refreshClaudeUsage() == nil)
    }
}
