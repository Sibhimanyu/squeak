import Foundation

/// One step of the uninstall plan (`plan` line of `squeak uninstall --json`).
public struct UninstallPlanStep: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let detail: String
    public let needsAdmin: Bool
    public let items: [String]
}

public struct UninstallPlan: Codable, Equatable, Sendable {
    public let dryRun: Bool
    public let keepData: Bool
    public let steps: [UninstallPlanStep]
}

public enum UninstallStepStatus: String, Codable, Equatable, Sendable {
    case start, done, skipped, failed
}

public struct UninstallStepEvent: Codable, Equatable, Sendable {
    public let id: String
    public let status: UninstallStepStatus
    public let note: String?
}

public struct UninstallOffMacItem: Codable, Equatable, Sendable {
    public let title: String
    public let detail: String
    public let url: String?
}

public struct UninstallDone: Codable, Equatable, Sendable {
    public let ok: Bool
    public let restartConductor: Bool
    public let appToTrash: String?
    public let offMac: [UninstallOffMacItem]

    public init(ok: Bool, restartConductor: Bool = false, appToTrash: String? = nil, offMac: [UninstallOffMacItem] = []) {
        self.ok = ok; self.restartConductor = restartConductor; self.appToTrash = appToTrash; self.offMac = offMac
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        restartConductor = try c.decodeIfPresent(Bool.self, forKey: .restartConductor) ?? false
        appToTrash = try c.decodeIfPresent(String.self, forKey: .appToTrash)
        offMac = try c.decodeIfPresent([UninstallOffMacItem].self, forKey: .offMac) ?? []
    }
    private enum Keys: String, CodingKey { case ok, restartConductor, appToTrash, offMac }
}

public enum UninstallEvent: Equatable, Sendable {
    case plan(UninstallPlan)
    case step(UninstallStepEvent)
    case done(UninstallDone)
}

public enum UninstallLine {
    /// One stdout line to an event; anything that is not a known event of the contract is nil.
    public static func parse(_ line: String) -> UninstallEvent? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = obj["event"] as? String else { return nil }
        let dec = JSONDecoder()
        switch kind {
        case "plan": return (try? dec.decode(UninstallPlan.self, from: data)).map(UninstallEvent.plan)
        case "step": return (try? dec.decode(UninstallStepEvent.self, from: data)).map(UninstallEvent.step)
        case "done": return (try? dec.decode(UninstallDone.self, from: data)).map(UninstallEvent.done)
        default: return nil
        }
    }
}

/// What a run came to. `done` is nil when the CLI died without a `done` line.
public struct UninstallResult: Equatable, Sendable {
    public var plan: UninstallPlan?
    public var steps: [UninstallStepEvent]
    public var done: UninstallDone?
    public var exitCode: Int32
    public var failure: String?

    public var ok: Bool { done?.ok == true && failure == nil }
}

public struct UninstallCLI: Equatable, Sendable {
    public let node: URL
    public let cli: URL
}

public enum UninstallRunnerError: Error, Equatable, Sendable {
    case cliNotFound
}

/// Finds and runs `squeak uninstall --json`, turning stdout JSON lines into typed events.
public struct UninstallRunner: Sendable {
    public static let fallbackNote = "Squeak could not finish. Run it again, or use the Terminal command in docs/uninstall.md."

    public let cli: UninstallCLI?

    public init(cli: UninstallCLI?) { self.cli = cli }

    /// Bundled `Contents/Resources/daemon` first, else the installed `daemon/current`.
    public static func locate(
        bundleResources: URL?, supportDirectory: URL, fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) || FileManager.default.fileExists(atPath: $0) }
    ) -> UninstallCLI? {
        var roots: [URL] = []
        if let r = bundleResources { roots.append(r.appending(path: "daemon")) }
        roots.append(supportDirectory.appending(path: "daemon/current"))
        for root in roots {
            let node = root.appending(path: "node"), cli = root.appending(path: "dist/squeak/cli.js")
            if fileExists(node.path), fileExists(cli.path) { return UninstallCLI(node: node, cli: cli) }
        }
        return nil
    }

    public static func live() -> UninstallRunner {
        let support = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/squeak")
        return UninstallRunner(cli: locate(bundleResources: Bundle.main.resourceURL, supportDirectory: support))
    }

    public static func arguments(dryRun: Bool, keepData: Bool) -> [String] {
        var a = ["uninstall", "--json"]
        if dryRun { a.append("--dry-run") } else { a.append("--yes") }
        if keepData { a.append("--keep-data") }
        return a
    }

    /// Fold finished lines into a result (also used by tests).
    public static func result(lines: [String], exitCode: Int32) -> UninstallResult {
        var r = UninstallResult(plan: nil, steps: [], done: nil, exitCode: exitCode, failure: nil)
        for line in lines {
            switch UninstallLine.parse(line) {
            case .plan(let p): r.plan = p
            case .step(let s): r.steps.append(s)
            case .done(let d): r.done = d
            case nil: break
            }
        }
        if r.done == nil && exitCode != 0 { r.failure = fallbackNote }
        return r
    }

    /// Runs the CLI off the main thread, calling `onEvent` for each parsed line as it arrives.
    public func run(dryRun: Bool, keepData: Bool, onEvent: @escaping @Sendable (UninstallEvent) -> Void = { _ in }) async throws -> UninstallResult {
        guard let cli else { throw UninstallRunnerError.cliNotFound }
        let args = [cli.cli.path] + Self.arguments(dryRun: dryRun, keepData: keepData)
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = cli.node
                p.arguments = args
                let out = Pipe()
                p.standardOutput = out
                p.standardError = FileHandle.nullDevice
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    cont.resume(returning: UninstallResult(plan: nil, steps: [], done: nil, exitCode: -1, failure: Self.fallbackNote))
                    return
                }
                var lines: [String] = []
                var buffer = Data()
                let handle = out.fileHandleForReading
                func flush(final: Bool) {
                    while let nl = buffer.firstIndex(of: 0x0A) {
                        let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                        buffer.removeSubrange(buffer.startIndex...nl)
                        lines.append(line)
                        if let e = UninstallLine.parse(line) { onEvent(e) }
                    }
                    if final, !buffer.isEmpty {
                        let line = String(decoding: buffer, as: UTF8.self)
                        buffer.removeAll()
                        lines.append(line)
                        if let e = UninstallLine.parse(line) { onEvent(e) }
                    }
                }
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    buffer.append(chunk)
                    flush(final: false)
                }
                flush(final: true)
                p.waitUntilExit()
                cont.resume(returning: Self.result(lines: lines, exitCode: p.terminationStatus))
            }
        }
    }
}
