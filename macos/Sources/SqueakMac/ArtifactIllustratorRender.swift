import AppKit
import PDFKit
import SqueakMacCore

/// Renders a stub `.ai` (saved without PDF content) with the Illustrator installed on this Mac: ExtendScript through
/// AppleScript `do javascript` opens the file, saves every artboard as a PDF into the cache and closes it unsaved.
/// Runs when the person opens the file (their own Illustrator, their own Mac; never for someone else); cached by path and mtime.
enum IllustratorRender {
    struct Failure: Error { let message: String }

    static let support = URL.homeDirectory.appending(path: "Library/Application Support/Squeak Mac")

    /// The Illustrator to use: the app the system opens the file with when it is one, else any installed Illustrator
    /// (bundle id starting `com.adobe.illustrator`).
    static func app(for file: URL) -> URL? {
        func isIllustrator(_ u: URL) -> Bool { Bundle(url: u)?.bundleIdentifier?.lowercased().hasPrefix("com.adobe.illustrator") == true }
        if let u = NSWorkspace.shared.urlForApplication(toOpen: file), isIllustrator(u) { return u }
        for id in ["com.adobe.illustrator", "com.adobe.illustratorBeta"] {
            if let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return u }
        }
        let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
        for dir in apps.sorted().reversed() where dir.hasPrefix("Adobe Illustrator") {
            let u = URL(fileURLWithPath: "/Applications/\(dir)/Adobe Illustrator.app")
            if isIllustrator(u) { return u }
        }
        return nil
    }

    static func cacheFolder(for file: URL) -> URL {
        let m = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date(timeIntervalSince1970: 0)
        return ArtifactRenderCache.folder(support: support, path: file.path, modified: m)
    }

    /// The cached render's artboards, in order (nil when there is none yet).
    static func cached(for file: URL) -> [CanvasBoard]? {
        let folder = cacheFolder(for: file)
        guard let data = try? Data(contentsOf: folder.appending(path: "names.json")), let names = ArtifactRenderCache.names(from: data), !names.isEmpty else { return nil }
        let singlePdf = folder.appending(path: "art.pdf")
        if let doc = PDFDocument(url: singlePdf) {
            let boards = CanvasBoard.boards(of: doc, names: names)
            if boards.count == names.count { return boards }
        }
        var boards: [CanvasBoard] = []
        for (i, name) in names.enumerated() {
            guard let doc = PDFDocument(url: folder.appending(path: "\(i)/art.pdf")), let b = CanvasBoard.boards(of: doc, names: [name]).first else { return nil }
            boards.append(b)
        }
        return boards.count == names.count ? boards : nil
    }

    /// Runs Illustrator (launched hidden, not activated, when it is not running) and returns the rendered artboards.
    static func render(file: URL, with app: URL) async throws -> [CanvasBoard] {
        if let hit = cached(for: file) { return hit }
        let out = cacheFolder(for: file)
        try? FileManager.default.removeItem(at: out)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let script = ArtifactRenderCache.script(file: file.path, out: out.path)

        let running = NSWorkspace.shared.runningApplications.contains { $0.bundleURL == app }
        if !running {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = false
            cfg.hides = true
            _ = try? await NSWorkspace.shared.openApplication(at: app, configuration: cfg)
        }
        let result = try await Task.detached(priority: .userInitiated) { try runScript(app: app, script: script) }.value
        guard cached(for: file) != nil, let boards = cached(for: file) else {
            try? FileManager.default.removeItem(at: out)
            if let parsed = ArtifactRenderCache.parseResult(result) {
                switch parsed {
                case .error(let msg):
                    throw Failure(message: msg)
                case .ok(let n) where n == 0:
                    throw Failure(message: "Illustrator document contains no artboards.")
                default:
                    break
                }
            }
            throw Failure(message: result.isEmpty ? "Illustrator did not produce any artboards." : result)
        }
        return boards
    }

    private static func runScript(app: URL, script: String) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        p.arguments = [
            "-e", "on run argv",
            "-e", "tell application \"\(esc(app.path))\" to do javascript (item 1 of argv)",
            "-e", "end run",
            script
        ]
        let err = Pipe(), outPipe = Pipe()
        p.standardError = err
        p.standardOutput = outPipe
        try p.run()
        let deadline = Date().addingTimeInterval(300)
        while p.isRunning {
            if Date() > deadline { p.terminate(); throw Failure(message: "Illustrator took longer than five minutes. Try again, or open the file in Illustrator.") }
            Thread.sleep(forTimeInterval: 0.25)
        }
        let stdoutText = String(decoding: outPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let stderrText = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if p.terminationStatus != 0 {
            let combined = stderrText.isEmpty ? stdoutText : stderrText
            let lower = combined.lowercased()
            if lower.contains("-1743") || lower.contains("not allowed") {
                throw Failure(message: "macOS blocked Squeak from controlling Illustrator. Allow it in System Settings, Privacy & Security, Automation.")
            }
            throw Failure(message: combined.isEmpty ? "Illustrator could not render this file." : combined)
        }
        return stdoutText.isEmpty ? stderrText : stdoutText
    }
}
