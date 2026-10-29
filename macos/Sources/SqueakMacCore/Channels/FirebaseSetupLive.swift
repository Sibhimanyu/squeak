import Foundation

/// Runs real programs. Output is merged and capped; a "(Y/n)" question is answered "n".
public struct ProcessCommandRunner: CommandRunning {
    public init() {}

    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var text = ""
        private var answered = 0
        func append(_ chunk: String) -> Bool {
            lock.lock(); defer { lock.unlock() }
            text += chunk
            if text.count > 200_000 { text = String(text.suffix(100_000)) }
            let asks = text.components(separatedBy: "(Y/n)").count - 1
            if asks > answered { answered = asks; return true }
            return false
        }
        var value: String { lock.lock(); defer { lock.unlock() }; return text }
    }

    public func run(_ executable: String, _ arguments: [String], directory: URL?, declineYesNo: Bool, timeout: TimeInterval) async -> CommandResult {
        await withCheckedContinuation { (cont: CheckedContinuation<CommandResult, Never>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = arguments
            p.currentDirectoryURL = directory
            var env = ProcessInfo.processInfo.environment
            env["NO_COLOR"] = "1"
            env["FIREBASE_CLI_EXPERIMENTS"] = nil
            // An app opened from Finder gets a bare PATH, and an npm-installed `firebase` is a Node script
            // (`#!/usr/bin/env node`), so it needs the usual places Node lives.
            let home = URL.homeDirectory.path
            let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.volta/bin", "\(home)/.npm-global/bin", "\(home)/.local/bin"]
            env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
            p.environment = env
            let out = Pipe(), input = Pipe()
            p.standardOutput = out
            p.standardError = out
            p.standardInput = input
            let collector = Collector()
            let finished = NSLock()
            nonisolated(unsafe) var done = false
            @Sendable func finish(_ status: Int32) {
                finished.lock()
                if done { finished.unlock(); return }
                done = true
                finished.unlock()
                out.fileHandleForReading.readabilityHandler = nil
                if let rest = try? out.fileHandleForReading.readToEnd(), let s = String(data: rest, encoding: .utf8) { _ = collector.append(s) }
                cont.resume(returning: CommandResult(status: status, output: collector.value))
            }
            out.fileHandleForReading.readabilityHandler = { h in
                let data = h.availableData
                guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
                if collector.append(s), declineYesNo { try? input.fileHandleForWriting.write(contentsOf: Data("n\n".utf8)) }
            }
            p.terminationHandler = { finish($0.terminationStatus) }
            do { try p.run() } catch { finish(127); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if p.isRunning { p.terminate() }
            }
        }
    }
}

public struct URLSessionHTTP: HTTPSending {
    public init() {}
    public func send(_ request: SetupRequest) async throws -> SetupReply {
        guard let url = URL(string: request.url) else { throw URLError(.badURL) }
        var r = URLRequest(url: url, timeoutInterval: 30)
        r.httpMethod = request.method
        if let b = request.bearer { r.setValue("Bearer \(b)", forHTTPHeaderField: "Authorization") }
        if let body = request.body {
            r.httpBody = Data(body.utf8)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: r)
        return SetupReply(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: String(data: data, encoding: .utf8) ?? "")
    }
}

public struct URLSessionDownloader: FileDownloading {
    public init() {}
    public func download(from url: URL, to file: URL, progress: @Sendable @escaping (Double) -> Void) async throws {
        let (bytes, resp) = try await URLSession.shared.bytes(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let total = Double(resp.expectedContentLength)
        let tmp = file.appendingPathExtension("part")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tmp)
        defer { try? handle.close() }
        var buffer = Data(), got = 0.0, last = 0.0
        buffer.reserveCapacity(1 << 20)
        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count >= 1 << 20 {
                try handle.write(contentsOf: buffer)
                got += Double(buffer.count)
                buffer.removeAll(keepingCapacity: true)
                if total > 0, got / total - last >= 0.01 { last = got / total; progress(min(last, 1)) }
            }
        }
        try handle.write(contentsOf: buffer)
        try handle.close()
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        try FileManager.default.moveItem(at: tmp, to: file)
        progress(1)
    }
}
