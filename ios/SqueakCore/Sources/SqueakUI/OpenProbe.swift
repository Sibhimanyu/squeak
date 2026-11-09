#if os(iOS) && DEBUG
import Foundation

/// `-squeak-open-probe`: times a chat opening, from the navigation push being requested (the path change) to
/// its first body, its first appearance and its reveal, plus the longest main-thread stall (the largest gap
/// between two display-link frames) in the 2.5 s after the tap. Lines go to `Documents/open-probe.txt`. Debug only.
@MainActor
enum OpenProbe {
    static let on = ProcessInfo.processInfo.arguments.contains("-squeak-open-probe")
    private static var start: Double?
    private static var seen: Set<String> = []
    private static var watcher: Watcher?
    private static var url: URL { URL.documentsDirectory.appending(path: "open-probe.txt") }

    private static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    /// The tap: the path changed to a chat.
    static func begin(_ label: String) {
        guard on else { return }
        start = now()
        seen = []
        write("---- \(label)")
        watcher?.stop()
        let watcher = Watcher()
        self.watcher = watcher
        // A background thread pings the main queue every 5 ms; the longest wait for an answer is the longest
        // stretch the main thread was busy. (A display link never fires on a headless simulator.)
        watcher.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            MainActor.assumeIsolated {
                guard self.watcher === watcher else { return }
                watcher.stop()
                write(String(format: "longest-stall %.0f ms (pings %d, over 33 ms: %d)", watcher.maxGap * 1000, watcher.frames, watcher.slow))
            }
        }
    }

    /// A named moment, written once per open.
    static func mark(_ name: String) {
        guard on, let start, !seen.contains(name) else { return }
        seen.insert(name)
        write(String(format: "%.0f ms %@", (now() - start) * 1000, name))
    }

    /// Times a block of work (a build, a mount) and writes how long it took.
    static func measure<T>(_ name: String, _ body: () -> T) -> T {
        guard on else { return body() }
        let began = now()
        let result = body()
        write(String(format: "  %@ took %.1f ms", name, (now() - began) * 1000))
        return result
    }

    private static func write(_ line: String) {
        guard on, let data = (line + "\n").data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile(); handle.write(data); try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    private final class Watcher: @unchecked Sendable {
        private let lock = NSLock()
        private var maxGapValue = 0.0
        private var ticksValue = 0
        private var slowValue = 0
        private var running = false
        var maxGap: Double { lock.withLock { maxGapValue } }
        var frames: Int { lock.withLock { ticksValue } }
        var slow: Int { lock.withLock { slowValue } }

        func run() {
            lock.withLock { running = true }
            Thread.detachNewThread { [self] in
                while lock.withLock({ running }) {
                    Thread.sleep(forTimeInterval: 0.005)
                    let sent = ProcessInfo.processInfo.systemUptime
                    let answered = DispatchSemaphore(value: 0)
                    DispatchQueue.main.async { [self] in
                        defer { answered.signal() }
                        let wait = ProcessInfo.processInfo.systemUptime - sent
                        lock.withLock {
                            maxGapValue = max(maxGapValue, wait)
                            ticksValue += 1
                            if wait > 0.033 { slowValue += 1 }
                        }
                    }
                    answered.wait()
                }
            }
        }

        func stop() { lock.withLock { running = false } }
    }
}
#endif
