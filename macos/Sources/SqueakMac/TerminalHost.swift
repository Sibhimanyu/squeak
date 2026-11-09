import AppKit
import CoreText
import Darwin
import Observation
import SqueakMacCore
import SwiftTerm

/// DESIGN.md §8.10, the terminal panel: the shells kept alive while the app runs. `TerminalRegistry` (SqueakMacCore)
/// does the bookkeeping, one workspace (its folder) per set of tabs; this owns the live SwiftTerm views the registry's
/// tabs stand for, so a view being rebuilt by SwiftUI never touches a shell. Shells end with the app (`hangUpAll`).
@MainActor
@Observable
final class TerminalHost {
    static let shared = TerminalHost()

    private(set) var registry = TerminalRegistry()
    /// Titles a shell set for itself (OSC 0/2), by tab.
    private(set) var titles: [UUID: String] = [:]
    @ObservationIgnored private var sessions: [UUID: TerminalSession] = [:]
    /// Set by an action that should leave the keyboard in the terminal (⌘J opening, a new or chosen tab).
    @ObservationIgnored var focusPending = false

    func view(for tab: UUID) -> LocalProcessTerminalView? { sessions[tab]?.view }

    func title(of tab: TerminalTab) -> String {
        if let t = titles[tab.id], !t.isEmpty { return t }
        let name = TerminalShell.launch().name
        return tab.number > 1 ? "\(name) \(tab.number)" : name
    }

    /// The workspace's selected tab, starting its first shell on first use.
    func ensure(workspace: String, folder: String) {
        let tab = registry.ensure(workspace)
        start(tab, folder: folder)
    }

    func add(workspace: String, folder: String) {
        let tab = registry.add(workspace)
        focusPending = true
        start(tab, folder: folder)
    }

    func select(workspace: String, _ id: UUID) {
        registry.select(workspace, id)
        focusPending = true
    }

    func selectNeighbour(workspace: String, forward: Bool) {
        if let id = registry.neighbour(workspace, forward: forward) { select(workspace: workspace, id) }
    }

    private func start(_ tab: TerminalTab, folder: String) {
        guard sessions[tab.id] == nil else { return }
        let session = TerminalSession(tab: tab.id, folder: folder, host: self)
        sessions[tab.id] = session
        session.begin()
    }

    /// Close a tab and end its shell, asking first only when something other than the shell holds the terminal.
    func requestClose(workspace: String, _ id: UUID) {
        guard let session = sessions[id] else { registry.close(workspace, id); return }
        if session.decision() == .confirm {
            let alert = NSAlert()
            alert.messageText = "Stop what is running here?"
            let what = session.foregroundName().map { "“\($0)” is" } ?? "A process is"
            alert.informativeText = "\(what) still running in this terminal. Closing the tab ends it."
            alert.addButton(withTitle: "Close terminal")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        remove(workspace: workspace, id)
    }

    func remove(workspace: String, _ id: UUID) {
        sessions.removeValue(forKey: id)?.hangUp(final: false)
        titles[id] = nil
        registry.close(workspace, id)
    }

    /// The shell ended by itself (`exit`, ^D): its tab goes.
    fileprivate func shellEnded(_ id: UUID) {
        guard sessions[id] != nil else { return }
        for (workspace, w) in registry.workspaces where w.tabs.contains(where: { $0.id == id }) { remove(workspace: workspace, id) }
    }

    fileprivate func setTitle(_ title: String, for id: UUID) { titles[id] = title }

    /// SIGHUP every shell's process group, synchronously: the app is going and a shell must not outlive it.
    func hangUpAll() {
        for s in sessions.values { s.hangUp(final: true) }
        sessions.removeAll()
    }

    /// ⌘K: the screen and its scrollback go, and a shell sitting at its prompt redraws it.
    func clear(_ id: UUID) { sessions[id]?.clear() }

    func isTerminalView(_ responder: NSResponder?) -> Bool { responder is LocalProcessTerminalView }

    func tab(of view: NSResponder?) -> UUID? {
        guard let view else { return nil }
        return sessions.first { $0.value.view === view }?.key
    }
}

/// One shell: its SwiftTerm view and process. The view is configured once (font, palette, 10k lines of scrollback)
/// and re-coloured when the appearance flips.
@MainActor
private final class TerminalSession: NSObject, LocalProcessTerminalViewDelegate {
    let tab: UUID
    let folder: String
    weak var host: TerminalHost?
    let view: LocalProcessTerminalView
    private let launch = TerminalShell.launch()

    init(tab: UUID, folder: String, host: TerminalHost) {
        self.tab = tab
        self.folder = folder
        self.host = host
        var options = TerminalOptions.default
        options.scrollback = 10_000
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 200), font: TerminalStyle.font, options: options)
        super.init()
        view.processDelegate = self
        view.linkReporting = .implicit  // links open with ⌘-click (SwiftTerm's rule)
        TerminalStyle.apply(to: view, dark: TerminalStyle.isDark(NSApp.effectiveAppearance))
    }

    func begin() {
        view.startProcess(
            executable: launch.executable, args: launch.args, environment: launch.environment, execName: nil, currentDirectory: folder)
    }

    private var shellPid: Int32 { view.process?.shellPid ?? 0 }

    /// The pty's foreground process group, nil once the shell has gone.
    private func foregroundGroup() -> Int32? {
        guard let fd = view.process?.childfd, fd >= 0 else { return nil }
        let g = tcgetpgrp(fd)
        return g > 0 ? g : nil
    }

    func decision() -> TerminalShell.CloseDecision { TerminalShell.closeDecision(shellPid: shellPid, foregroundGroup: foregroundGroup()) }

    func foregroundName() -> String? {
        guard let g = foregroundGroup() else { return nil }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(g, &buf, UInt32(buf.count)) > 0 else { return nil }
        let name = String(cString: buf)
        return name.isEmpty ? nil : name
    }

    func clear() {
        view.feed(text: "\u{1b}[2J\u{1b}[3J\u{1b}[H")
        if decision() == .closeNow { view.send(data: [0x0c][...]) }
    }

    /// SIGHUP the shell's group (the shell leads it); a closed tab is also terminated so nothing lingers.
    func hangUp(final: Bool) {
        let pid = shellPid
        if pid > 0 { killpg(pid, SIGHUP) }
        if !final { view.terminate() }
    }

    // MARK: LocalProcessTerminalViewDelegate
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) { host?.setTitle(title, for: tab) }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) { host?.shellEnded(tab) }
}

/// The terminal's look: DESIGN.md §11's palette (`Tokens.Terminal`), JetBrains Mono 12pt, the system's blinking
/// block cursor (no custom blink).
@MainActor
enum TerminalStyle {
    static func isDark(_ appearance: NSAppearance) -> Bool { appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }

    private static var registered = false

    /// JetBrains Mono from the app's `Resources/fonts` (build-app.sh), else the checkout's `brand/fonts/JetBrainsMono`;
    /// the system monospaced face when neither is found.
    static var font: NSFont {
        registerFonts()
        let size = CGFloat(Tokens.Workbench.terminalFontSize)
        return NSFont(name: "JetBrainsMono-Regular", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    private static func registerFonts() {
        guard !registered else { return }
        registered = true
        var dirs: [URL] = []
        if let r = Bundle.main.resourceURL { dirs.append(r.appendingPathComponent("fonts")) }
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0..<8 { dirs.append(dir.appendingPathComponent("brand/fonts/JetBrainsMono")); dir.deleteLastPathComponent() }
        if let exe = Bundle.main.executableURL?.deletingLastPathComponent() {
            var d = exe
            for _ in 0..<8 { dirs.append(d.appendingPathComponent("brand/fonts/JetBrainsMono")); d.deleteLastPathComponent() }
        }
        for d in dirs where FileManager.default.fileExists(atPath: d.appendingPathComponent("JetBrainsMono-Regular.ttf").path) {
            for f in ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Medium.ttf"] {
                CTFontManagerRegisterFontsForURL(d.appendingPathComponent(f) as CFURL, .process, nil)
            }
            return
        }
    }

    private static func ns(_ hex: UInt32) -> NSColor { NSColor(hex: hex) }

    private static func term(_ hex: UInt32) -> SwiftTerm.Color {
        SwiftTerm.Color(red8: UInt16((hex >> 16) & 255), green8: UInt16((hex >> 8) & 255), blue8: UInt16(hex & 255))
    }

    static func apply(to view: TerminalView, dark: Bool) {
        let p = dark ? Tokens.Terminal.dark : Tokens.Terminal.light
        view.installColors(p.ansi.map(term))
        view.nativeBackgroundColor = ns(p.background)
        view.nativeForegroundColor = ns(p.foreground)
        view.caretColor = ns(p.cursor)
        view.selectedTextBackgroundColor = ns(p.selection)
    }
}
