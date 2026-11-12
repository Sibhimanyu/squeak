import Foundation

/// Calls `onChange` whenever one of the files is written, replaced or removed.
///
/// Uses `DispatchSource` file-system sources on descriptors opened with
/// `O_EVTONLY`: read-only, no lock, and they do not keep a volume busy. Nothing
/// here reads or writes the file. Conductor's database is in WAL mode, so a
/// commit shows up as a write to `conductor.db-wal` first.
///
/// A file that does not exist yet, or is replaced (SQLite deletes the WAL when
/// its last connection closes), is picked up again by a slow re-arm timer, so
/// a watched path never stays dead. The caller keeps its own poll as the
/// fallback either way.
public final class FileChangeWatcher: @unchecked Sendable {
    private let paths: [String]
    private let queue = DispatchQueue(label: "squeak.file-watcher")
    private let onChange: @Sendable () -> Void
    private let rearmEvery: TimeInterval
    private var sources: [String: DispatchSourceFileSystemObject] = [:]
    private var timer: DispatchSourceTimer?
    private var running = false

    public init(paths: [String], rearmEvery: TimeInterval = 2, onChange: @escaping @Sendable () -> Void) {
        self.paths = paths
        self.rearmEvery = rearmEvery
        self.onChange = onChange
    }

    deinit { stop() }

    public func start() {
        queue.async { [self] in
            guard !running else { return }
            running = true
            armMissing()
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + rearmEvery, repeating: rearmEvery)
            t.setEventHandler { [weak self] in self?.armMissing() }
            t.resume()
            timer = t
        }
    }

    public func stop() {
        queue.sync {
            running = false
            timer?.cancel()
            timer = nil
            for source in sources.values { source.cancel() }
            sources.removeAll()
        }
    }

    /// How many paths currently have a live source (for tests).
    public var armedCount: Int { queue.sync { sources.count } }

    private func armMissing() {
        guard running else { return }
        for path in paths where sources[path] == nil {
            let fd = open(path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename, .attrib], queue: queue)
            source.setEventHandler { [weak self, weak source] in
                guard let self, let source else { return }
                if !source.data.isDisjoint(with: [.delete, .rename]) {
                    // The file we hold is gone; a successor is picked up on the next re-arm.
                    source.cancel()
                    if self.sources[path] === source { self.sources[path] = nil }
                }
                self.onChange()
            }
            source.setCancelHandler { close(fd) }
            source.resume()
            sources[path] = source
            // A file that appears is itself a change.
            onChange()
        }
    }
}
