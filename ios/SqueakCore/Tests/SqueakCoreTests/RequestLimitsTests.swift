import Foundation
import Testing
@testable import SqueakCore

@Suite struct RequestLimitsTests {
    @Test func inFlightSharesOneLoad() async {
        let counter = LoadCounter()
        let flight = InFlight<Int>()
        async let a = flight.value(for: "k") { await counter.bump(); try? await Task.sleep(for: .milliseconds(150)); return 7 }
        try? await Task.sleep(for: .milliseconds(30))
        async let b = flight.value(for: "k") { await counter.bump(); return 8 }
        let (x, y) = await (a, b)
        #expect(x == 7 && y == 7)
        #expect(await counter.count == 1)
    }

    @Test func limiterNeverExceedsItsLimit() async {
        let limiter = ConcurrencyLimiter(limit: 3)
        let counter = LoadCounter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<10 {
                group.addTask {
                    await limiter.run {
                        await counter.enter()
                        try? await Task.sleep(for: .milliseconds(20))
                        await counter.leave()
                    }
                }
            }
        }
        #expect(await counter.peak == 3)
        #expect(await counter.current == 0)
    }
}

private actor LoadCounter {
    var count = 0, current = 0, peak = 0
    func bump() { count += 1 }
    func enter() { current += 1; peak = max(peak, current) }
    func leave() { current -= 1 }
}
