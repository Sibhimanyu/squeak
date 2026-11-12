import Foundation
import Observation
import Testing

@testable import SqueakMacCore

@Suite("Perf: caches, change-guarded writes, poll pacing")
struct PerfTests {
    @Test func memoRecomputesOnlyAfterInvalidateOrNewBucket() {
        let memo = Memo<Int>()
        var runs = 0
        func read(_ bucket: Int = 0) -> Int { memo.value(bucket: bucket) { runs += 1; return runs } }
        #expect(read() == 1)
        #expect(read() == 1)
        #expect(read() == 1)
        #expect(memo.recomputes == 1)
        memo.invalidate()
        #expect(read() == 2)
        #expect(read(1) == 3)  // the clock moved on
        #expect(read(1) == 3)
        #expect(memo.recomputes == 3)
    }

    @Test func keyedMemoComputesOncePerKeyUntilInvalidated() {
        let memo = KeyedMemo<String, String>()
        var runs = 0
        func read(_ k: String) -> String { memo.value(k) { runs += 1; return k.uppercased() } }
        _ = read("a"); _ = read("a"); _ = read("b"); _ = read("b")
        #expect(runs == 2)
        memo.invalidate("a")
        _ = read("a"); _ = read("b")
        #expect(runs == 3)
        memo.invalidate()
        _ = read("a"); _ = read("b")
        #expect(runs == 5)
    }

    final class Counter: @unchecked Sendable { var n = 0 }

    @Observable final class Box {
        var value = 1
        var wakes = 0
    }

    @Test func changeGuardedWriteDoesNotWakeObserversOnEqualValue() {
        let box = Box()
        let counter = Counter()
        func watch() {
            withObservationTracking { _ = box.value } onChange: { counter.n += 1 }
        }
        var woke: Int { counter.n }
        watch()
        #expect(publishIfChanged(box, \.value, 1) == false)
        #expect(woke == 0)
        #expect(publishIfChanged(box, \.value, 2))
        #expect(woke == 1)
        watch()
        #expect(publishIfChanged(box, \.value, 2) == false)
        #expect(woke == 1)
    }

    @Test func pacingBacksOffWhileQuietAndResetsOnChange() {
        var p = PollPacing()
        #expect(p.interval(base: 2, max: 10, presence: .active) == 2)
        for _ in 0..<10 { p.record(changed: false) }
        #expect(p.interval(base: 2, max: 10, presence: .active) == 10)  // capped
        p.record(changed: true)
        #expect(p.interval(base: 2, max: 10, presence: .active) == 2)
        p.record(changed: false)
        #expect(p.interval(base: 2, max: 10, presence: .active)! > 2)
    }

    @Test func pacingPausesWhenHiddenAndSlowsWhenInactive() {
        let p = PollPacing()
        #expect(p.interval(base: 2, max: 20, presence: .hidden) == nil)
        #expect(p.interval(base: 2, max: 20, presence: .inactive)! > p.interval(base: 2, max: 20, presence: .active)!)
    }

    @MainActor @Test func loopDoesNotReadWhileHiddenAndReadsAtOnceOnReturn() async throws {
        let gate = PollPresenceGate(.hidden)
        var ticks = 0
        let task = Task { @MainActor in
            await PollLoop.run(gate: gate, base: { 100 }, max: 100, sleep: { _ in try? await Task.sleep(for: .seconds(100)) }) {
                ticks += 1
                return true
            }
        }
        try await Task.sleep(for: .milliseconds(80))
        #expect(ticks == 0)
        gate.set(.active)
        try await Task.sleep(for: .milliseconds(80))
        #expect(ticks == 1)
        task.cancel()
    }

    @MainActor @Test func loopBacksOffWhileNothingChanges() async throws {
        let gate = PollPresenceGate(.active)
        var waits: [TimeInterval] = []
        let task = Task { @MainActor in
            await PollLoop.run(gate: gate, base: { 2 }, max: 30, sleep: { waits.append($0); await Task.yield() }) { false }
        }
        while waits.count < 6 { try await Task.sleep(for: .milliseconds(5)) }
        task.cancel()
        let first = Array(waits.prefix(6))
        #expect(first == first.sorted())
        #expect(first.last! > first.first!)
        #expect(first.allSatisfy { $0 <= 30 })
    }
}

@Suite("Perf: throttle")
struct PollThrottleTests {
    @Test func skipsReadsThatComeTooSoonAndRefusesWhileHidden() {
        var t = PollThrottle()
        let t0 = Date()
        do { let r = t.shouldRead(base: 3, max: 12, presence: .active, now: t0); #expect(r == true) }
        do { let r = t.shouldRead(base: 3, max: 12, presence: .active, now: t0.addingTimeInterval(1)); #expect(r == false) }
        do { let r = t.shouldRead(base: 3, max: 12, presence: .active, now: t0.addingTimeInterval(3)); #expect(r == true) }
        do { let r = t.shouldRead(base: 3, max: 12, presence: .hidden, now: t0.addingTimeInterval(100)); #expect(r == false) }
    }

    @Test func backsOffWhileUnchangedAndResetsOnReturn() {
        var t = PollThrottle()
        var now = Date()
        _ = t.shouldRead(base: 3, max: 12, presence: .active, now: now)
        for _ in 0..<4 { t.record(changed: false) }
        now = now.addingTimeInterval(3)
        do { let r = t.shouldRead(base: 3, max: 12, presence: .active, now: now); #expect(r == false) }
        t.reset()
        do { let r = t.shouldRead(base: 3, max: 12, presence: .active, now: now); #expect(r == true) }
    }
}
