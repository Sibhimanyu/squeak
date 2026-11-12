import Foundation

// Keeping the main thread quiet: derived values computed once per change, writes that fire only when the value
// differs, and poll loops that stop while nobody looks and slow down while nothing changes. All pure or
// injectable, so SqueakMacCore's tests can drive them.

/// Assigns only when the value differs, so an observer is woken by a real change and never by an equal write.
/// Use this (a key path) on an `@Observable` property: passing it `inout` (`&model.value`) goes through the
/// property's `_modify`, which tells observers before the comparison is made. Returns whether it changed.
@discardableResult
public func publishIfChanged<Root: AnyObject, T: Equatable>(_ root: Root, _ keyPath: ReferenceWritableKeyPath<Root, T>, _ fresh: T) -> Bool {
    guard root[keyPath: keyPath] != fresh else { return false }
    root[keyPath: keyPath] = fresh
    return true
}

/// One derived value, computed on the first read after `invalidate()` or after its time bucket turns, and reused
/// until then. The owner invalidates from the `didSet` of each real input. `recomputes` is how tests see it.
public final class Memo<Value> {
    private var cached: Value?
    private var bucket: Int?
    public private(set) var recomputes = 0
    public init() {}

    public func invalidate() { cached = nil }

    /// `bucket` is a coarse clock (see `TimeBucket`) for values that read "now": a new bucket recomputes.
    public func value(bucket: Int = 0, _ compute: () -> Value) -> Value {
        if let cached, self.bucket == bucket { return cached }
        let out = compute()
        cached = out
        self.bucket = bucket
        recomputes += 1
        return out
    }
}

/// A value per key, cleared together (row titles, marks and VoiceOver labels per session).
public final class KeyedMemo<Key: Hashable, Value> {
    private var cached: [Key: Value] = [:]
    private var bucket: Int?
    public private(set) var recomputes = 0
    public init() {}

    public func invalidate() { cached.removeAll(keepingCapacity: true) }
    public func invalidate(_ key: Key) { cached[key] = nil }

    public func value(_ key: Key, bucket: Int = 0, _ compute: () -> Value) -> Value {
        value(key, bucket: bucket, fresh: { _ in true }, compute)
    }

    /// `fresh` rejects a cached value built from an older version of whatever the key names (the session itself).
    public func value(_ key: Key, bucket: Int = 0, fresh: (Value) -> Bool, _ compute: () -> Value) -> Value {
        if self.bucket != bucket { cached.removeAll(keepingCapacity: true); self.bucket = bucket }
        if let hit = cached[key], fresh(hit) { return hit }
        let out = compute()
        cached[key] = out
        recomputes += 1
        return out
    }
}

public enum TimeBucket {
    /// Whole `seconds`-long steps since the epoch: the sidebar's "earlier" cut-offs move on a 30 s grain.
    public static func of(_ now: Date, seconds: TimeInterval = 30) -> Int { Int((now.timeIntervalSince1970 / seconds).rounded(.down)) }
}

/// What the person is looking at, as far as a poll cares.
public enum PollPresence: Equatable, Sendable {
    /// The window is on screen and Squeak is the active app.
    case active
    /// Visible but another app is in front: still drawn, so it refreshes, only less often.
    case inactive
    /// Hidden, minimised or covered: nothing is drawn, so nothing is read.
    case hidden
}

/// How long to wait before the next read: the base while things change, growing while they do not, stretched while
/// another app is in front, and nil (paused) while hidden.
public struct PollPacing: Equatable, Sendable {
    public var growth = 1.6
    public var inactiveFactor = 3.0
    public private(set) var idleRounds = 0
    public init(growth: Double = 1.6, inactiveFactor: Double = 3) {
        self.growth = growth
        self.inactiveFactor = inactiveFactor
    }

    public mutating func record(changed: Bool) { idleRounds = changed ? 0 : min(idleRounds + 1, 16) }
    public mutating func reset() { idleRounds = 0 }

    public func interval(base: TimeInterval, max cap: TimeInterval, presence: PollPresence) -> TimeInterval? {
        if presence == .hidden { return nil }
        let grown = Swift.min(Swift.max(cap, base), base * pow(growth, Double(idleRounds)))
        return presence == .inactive ? Swift.min(Swift.max(cap, base), grown * inactiveFactor) : grown
    }
}

/// The presence every poll loop reads. The window controller sets it; a loop waiting on a hidden window is woken
/// the moment it is shown.
@MainActor
public final class PollPresenceGate {
    public private(set) var presence: PollPresence
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    public init(_ presence: PollPresence = .active) { self.presence = presence }

    public func set(_ new: PollPresence) {
        guard new != presence else { return }
        presence = new
        let all = waiters
        waiters.removeAll()
        for (_, c) in all { c.resume() }
    }

    /// Returns at once unless hidden; else when the presence next changes.
    public func waitUntilVisible() async {
        while presence == .hidden, !Task.isCancelled { await nextChange() }
    }

    /// Returns when the presence changes (or the task is cancelled).
    public func nextChange() async { await wait(UUID()) }

    private func wait(_ id: UUID) async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                if Task.isCancelled { c.resume() } else { waiters[id] = c }
            }
        } onCancel: {
            Task { @MainActor in self.resume(id) }
        }
    }

    private func resume(_ id: UUID) { waiters.removeValue(forKey: id)?.resume() }

    /// Sleeps `seconds`, or until the presence changes, whichever is first.
    public func sleep(_ seconds: TimeInterval) async {
        let id = UUID()
        let timer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            self.resume(id)
        }
        await wait(id)
        timer.cancel()
    }
}

public enum PollLoop {
    /// Reads, waits, reads again until cancelled. `tick` says whether anything changed (the wait grows while it did
    /// not). Nothing runs while the gate is hidden; on return the first read is immediate and the pacing restarts.
    /// `sleep` is injectable for tests; nil sleeps on the gate, so a presence change cuts the wait short.
    @MainActor
    public static func run(
        gate: PollPresenceGate, base: @MainActor () -> TimeInterval, max cap: TimeInterval,
        sleep: (@MainActor (TimeInterval) async -> Void)? = nil,
        tick: @MainActor () async -> Bool
    ) async {
        var pacing = PollPacing()
        while !Task.isCancelled {
            if gate.presence == .hidden {
                await gate.waitUntilVisible()
                pacing.reset()
                continue
            }
            let before = gate.presence
            let changed = await tick()
            if Task.isCancelled { return }
            pacing.record(changed: changed)
            guard let wait = pacing.interval(base: base(), max: cap, presence: gate.presence) else { continue }
            if let sleep { await sleep(wait) } else { await gate.sleep(wait) }
            if gate.presence != before, gate.presence == .active { pacing.reset() }
        }
    }
}

/// For a read that a view's own loop asks for on a fixed beat: lets the model skip the ones that come too soon,
/// backing off while nothing changes, and refuses outright while hidden.
public struct PollThrottle: Sendable {
    public private(set) var pacing = PollPacing()
    public private(set) var lastRead: Date?
    public init() {}

    public mutating func reset() { pacing.reset(); lastRead = nil }

    public mutating func shouldRead(base: TimeInterval, max cap: TimeInterval, presence: PollPresence, now: Date = Date()) -> Bool {
        guard let wait = pacing.interval(base: base, max: cap, presence: presence) else { return false }
        if let lastRead, now.timeIntervalSince(lastRead) < wait - 0.25 { return false }
        lastRead = now
        return true
    }

    public mutating func record(changed: Bool) { pacing.record(changed: changed) }
}
