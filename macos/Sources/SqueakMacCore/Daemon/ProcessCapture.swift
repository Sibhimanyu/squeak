import Foundation

/// A value that can be handed to a continuation once, whoever gets there first (exit, deadline, launch failure).
final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    private var early: T?
    private var done = false

    /// Hands the value over. False when something already did.
    @discardableResult func finish(_ value: T) -> Bool {
        lock.lock()
        if done { lock.unlock(); return false }
        done = true
        let c = continuation
        if c == nil { early = value }
        lock.unlock()
        c?.resume(returning: value)
        return true
    }

    func wait() async -> T {
        await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
            lock.lock()
            if done, let v = early { lock.unlock(); c.resume(returning: v); return }
            continuation = c
            lock.unlock()
        }
    }
}

struct CapturedRun: Sendable, Equatable {
    var exit: Int32?
    var signal: Int32?
    var timedOut: Bool
    var output: String
}

enum ProcessCapture {
    /// Runs a program and keeps what it prints. After `timeout` seconds it is terminated, `grace` seconds later killed,
    /// and the answer is given (timedOut) even if the system never reports the process gone: an exec that macOS or
    /// security software holds open never terminates, and nothing waiting on it may wait for ever.
    static func run(_ path: String, _ args: [String], timeout: Double, grace: Double = 2) async -> CapturedRun {
        let once = ResumeOnce<CapturedRun>()
        let buffer = LockedData()
        let timedOut = LockedBool()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { buffer.append(d) }
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            let rest = (try? pipe.fileHandleForReading.readToEnd()) ?? nil
            if let rest { buffer.append(rest) }
            let signalled = proc.terminationReason == .uncaughtSignal
            let t = timedOut.value
            once.finish(CapturedRun(exit: signalled ? nil : proc.terminationStatus,
                                    signal: signalled && !t ? proc.terminationStatus : nil,
                                    timedOut: t, output: buffer.string))
        }
        let q = DispatchQueue.global()
        // Launching can itself block on a held exec, so it never runs on the caller's thread.
        q.async {
            do { try p.run() } catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                once.finish(CapturedRun(exit: nil, signal: nil, timedOut: false, output: error.localizedDescription))
            }
        }
        q.asyncAfter(deadline: .now() + timeout) {
            guard !once.isDone else { return }
            timedOut.value = true
            if p.isRunning { p.terminate() }
        }
        q.asyncAfter(deadline: .now() + timeout + grace) {
            guard !once.isDone else { return }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
        q.asyncAfter(deadline: .now() + timeout + grace + 1) {
            pipe.fileHandleForReading.readabilityHandler = nil
            once.finish(CapturedRun(exit: nil, signal: nil, timedOut: true, output: buffer.string))
        }
        return await once.wait()
    }
}

extension ResumeOnce {
    var isDone: Bool { lock.lock(); defer { lock.unlock() }; return done }
}

private final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
    var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return flag }
        set { lock.lock(); flag = newValue; lock.unlock() }
    }
}
