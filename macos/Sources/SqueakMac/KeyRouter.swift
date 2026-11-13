import AppKit
import Observation
import SqueakMacCore
import SwiftTerm

/// Shortcuts follow focus (FocusModel.swift holds the table). This is the app's side: where the keyboard is, and the
/// one place that enacts the chords that mean two things. A terminal that is collapsed or hidden never holds the keys.
@MainActor
@Observable
final class KeyFocus {
    static let shared = KeyFocus()

    /// What the centre column shows: the chat, a file, or the review.
    enum Centre { case chat, file, review }

    private(set) var region: FocusRegion = .composer
    var centre: Centre = .chat { didSet { reclassify() } }
    /// Whether the terminal panel is on screen (inspector open, code view, lower part expanded).
    private(set) var terminalOpen: Bool = UserDefaults.standard.bool(forKey: "terminalOpen") && UserDefaults.standard.bool(forKey: "inspectorOpen")

    /// The region the table answers for.
    var effective: FocusRegion { region.effective(terminalOpen: terminalOpen) }
    var terminalFocused: Bool { effective == .terminal }

    func setTerminalOpen(_ open: Bool) {
        terminalOpen = open
        if !open { releaseTerminal() }
        reclassify()
    }

    /// A collapsed terminal gives up the keys at once; the message field takes them.
    func releaseTerminal() {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow, TerminalHost.shared.isTerminalView(window.firstResponder) else { return }
        window.makeFirstResponder(nil)
        NotificationCenter.default.post(name: .squeakFocusComposer, object: nil)
    }

    func reclassify(window: NSWindow? = nil) {
        let w = window ?? NSApp.keyWindow
        let next = KeyFocus.classify(window: w, responder: w?.firstResponder, centre: centre)
        if next != region { region = next }
    }

    static func classify(window: NSWindow?, responder: NSResponder?, centre: Centre) -> FocusRegion {
        if window is NSPanel { return .quickComposer }
        if responder is LocalProcessTerminalView { return .terminal }
        if responder is NSTableView || responder is NSOutlineView { return .sidebar }
        switch centre {
        case .file: return .fileViewer
        case .review: return .review
        case .chat: return responder is NSText ? .composer : .transcript
        }
    }
}

@MainActor
final class KeyRouter {
    static let shared = KeyRouter()
    private var monitors: [Any] = []
    private weak var model: AppModel?

    func install(model: AppModel) {
        self.model = model
        guard monitors.isEmpty else { return }
        // The terminal takes and gives up the keys without an event (a new tab, a collapse): look again whenever a window updates.
        monitors.append(NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: nil, queue: .main) { n in
            nonisolated(unsafe) let w = n.object as? NSWindow
            MainActor.assumeIsolated { if w?.isKeyWindow == true { KeyFocus.shared.reclassify(window: w) } }
        })
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let e = event
            let consumed = MainActor.assumeIsolated { self?.consumes(e) ?? false }
            return consumed ? nil : event
        } as Any)
        // A click anywhere outside the terminal takes the keys out of it.
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            nonisolated(unsafe) let e = event
            MainActor.assumeIsolated { self?.click(e) }
            return event
        } as Any)
    }

    private func click(_ event: NSEvent) {
        guard let window = event.window, TerminalHost.shared.isTerminalView(window.firstResponder),
            let hit = window.contentView?.hitTest(event.locationInWindow)
        else { return }
        var v: NSView? = hit
        while let cur = v { if cur is LocalProcessTerminalView { return }; v = cur.superview }
        window.makeFirstResponder(nil)
        KeyFocus.shared.reclassify(window: window)
    }

    private func chord(_ event: NSEvent) -> FocusChord? {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if mods == .command {
            switch key {
            case "t": return .newTab
            case "w": return .close
            case "k": return .palette
            case "l": return .focusComposer
            case "1", "2", "3", "4", "5", "6", "7", "8", "9": return .session(Int(key)!)
            default: return nil
            }
        }
        if mods == [.command, .shift], key == "t" { return .reopenTab }
        if mods == .control, key == "`" { return .leaveTerminal }
        return nil
    }

    /// Only the chords the terminal changes are enacted here (and ⌘T and ⌘W everywhere); the rest of the table's
    /// answers are what the window's own bindings already do, so they are left to them.
    private func consumes(_ event: NSEvent) -> Bool {
        guard let window = event.window, !(window is NSPanel), window === NSApp.mainWindow, window.attachedSheet == nil,
            let chord = chord(event)
        else { return false }
        let focus = KeyFocus.shared
        focus.reclassify(window: window)
        if focus.region == .terminal, !focus.terminalOpen { focus.releaseTerminal(); focus.reclassify(window: window) }
        let action = ShortcutFocus.action(chord, in: focus.region, terminalOpen: focus.terminalOpen)
        switch (chord, action) {
        case (.newTab, _), (.close, .closeTerminalTab), (.palette, .clearTerminal), (.leaveTerminal, _), (.focusComposer, _):
            return perform(action, window: window)
        default: return false
        }
    }

    @discardableResult
    func perform(_ action: FocusAction, window: NSWindow? = nil) -> Bool {
        let host = TerminalHost.shared
        let responder = (window ?? NSApp.keyWindow)?.firstResponder
        switch action {
        case .newThread: NewChatController.shared.show(); return true
        case .newTerminal:
            guard let id = host.tab(of: responder), let ws = host.workspace(of: id) else { return false }
            host.add(workspace: ws, folder: ws)
            return true
        case .closeTerminalTab:
            guard let id = host.tab(of: responder), let ws = host.workspace(of: id) else { return false }
            host.requestClose(workspace: ws, id)
            if host.registry.tabs(ws).isEmpty {
                UserDefaults.standard.set(false, forKey: "terminalOpen")
                KeyFocus.shared.setTerminalOpen(false)
            }
            return true
        case .clearTerminal:
            guard let id = host.tab(of: responder) else { return false }
            host.clear(id)
            return true
        case .focusComposer:
            KeyFocus.shared.releaseTerminal()
            NotificationCenter.default.post(name: .squeakFocusComposer, object: nil)
            return true
        default: return false
        }
    }
}
