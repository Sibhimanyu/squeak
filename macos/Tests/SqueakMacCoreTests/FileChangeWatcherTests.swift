import Foundation
import Testing
@testable import SqueakMacCore

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var value: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
}

private func waitFor(_ timeout: TimeInterval = 3, _ condition: () async -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return await condition()
}

@Suite("FileChangeWatcher and Broker.nudge")
struct FileChangeWatcherTests {
    func tempFile() throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-watch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("conductor.db-wal").path
        FileManager.default.createFile(atPath: path, contents: Data("x".utf8))
        return path
    }

    func append(_ path: String) throws {
        let h = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try h.seekToEnd()
        try h.write(contentsOf: Data("more".utf8))
        try h.close()
    }

    @Test func firesWhenTheFileIsWritten() async throws {
        let path = try tempFile()
        let hits = Counter()
        let w = FileChangeWatcher(paths: [path]) { hits.bump() }
        w.start()
        #expect(await waitFor { w.armedCount == 1 })
        let before = hits.value
        try append(path)
        #expect(await waitFor { hits.value > before })
        w.stop()
    }

    @Test func picksUpAReplacedFileAndAFileThatAppearsLater() async throws {
        let path = try tempFile()
        let hits = Counter()
        let w = FileChangeWatcher(paths: [path], rearmEvery: 0.1) { hits.bump() }
        w.start()
        #expect(await waitFor { w.armedCount == 1 })
        try FileManager.default.removeItem(atPath: path)
        #expect(await waitFor { w.armedCount == 0 })
        FileManager.default.createFile(atPath: path, contents: Data("y".utf8))
        #expect(await waitFor { w.armedCount == 1 })
        let before = hits.value
        try append(path)
        #expect(await waitFor { hits.value > before })
        w.stop()
    }

    @Test func nudgeCoalescesABurstIntoOneRefresh() async throws {
        let a = FakeAdapter(sessions: [makeSession("c1")])
        let broker = Broker(adapters: [a], clock: FakeClock(), nudgeDebounce: .milliseconds(30))
        for _ in 0..<5 { await broker.nudge() }
        #expect(await waitFor { await a.discoverCount >= 1 })
        try await Task.sleep(for: .milliseconds(150))
        #expect(await a.discoverCount == 1)
        await broker.nudge()
        #expect(await waitFor { await a.discoverCount == 2 })
        await broker.stop()
    }
}
