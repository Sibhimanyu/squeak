import AppKit
import ApplicationServices
import Foundation

// Squeak Hands: the one process that holds Accessibility permission, so that
// nothing broader (Conductor, which runs every agent; node, which runs every
// script) has to.

let conductorBundleId = "com.conductor.app"

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : String(s.prefix(160)) }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func dump(_ el: AXUIElement, depth: Int, into out: inout [[String: Any]]) {
    if depth > 60 || out.count > 6000 { return }
    var node: [String: Any] = ["d": depth]
    for (key, name) in [("role", kAXRoleAttribute), ("sub", kAXSubroleAttribute), ("title", kAXTitleAttribute),
                        ("desc", kAXDescriptionAttribute), ("value", kAXValueAttribute), ("id", "AXIdentifier"),
                        ("domId", "AXDOMIdentifier"), ("help", kAXHelpAttribute), ("ph", "AXPlaceholderValue")] {
        if let s = str(el, name) { node[key] = s }
    }
    if let url = attr(el, "AXURL") as? URL { node["url"] = url.absoluteString }
    if let selected = attr(el, kAXSelectedAttribute) as? Bool, selected { node["sel"] = true }
    if let classes = attr(el, "AXDOMClassList") as? [String], !classes.isEmpty {
        node["cls"] = classes.prefix(6).joined(separator: " ")
    }
    out.append(node)
    for child in children(el) { dump(child, depth: depth + 1, into: &out) }
}

/// Conductor's sidecar runs under the same bundle id, so "the first one" is
/// a coin flip. The app is the one that shows up in the Dock.
func conductorProcess() -> NSRunningApplication? {
    let all = NSRunningApplication.runningApplications(withBundleIdentifier: conductorBundleId)
    return all.first { $0.activationPolicy == .regular } ?? all.first
}

func conductorApp() -> AXUIElement? {
    guard let app = conductorProcess() else { return nil }
    return AXUIElementCreateApplication(app.processIdentifier)
}

func write(_ object: Any, to path: String) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    FileManager.default.createFile(atPath: path, contents: data)
}


// MARK: - send

struct SendRequest: Decodable {
    let workspaceId: String
    let sessionId: String
    let sessionTitle: String?
    let text: String
    /// Do everything except press Return, then clear the composer again.
    let dryRun: Bool?
    /// Only bring the chat on screen; type nothing. `text` is ignored.
    let navigateOnly: Bool?
}

/// Every way a send can end. Only "sent" and "unconfirmed" may have reached
/// the chat; everything else guarantees nothing was typed, so the caller can
/// safely deliver another way.
enum SendError: String {
    case locked, notRunning = "conductor-not-running", noWindow = "no-window"
    case workspaceNotInSidebar = "workspace-not-in-sidebar", chatNotOpen = "chat-not-open"
    case noComposer = "no-composer", draftPresent = "draft-present", pasteFailed = "paste-failed"
    case unconfirmed
}

func screenIsLocked() -> Bool {
    guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return (info["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func findAll(_ el: AXUIElement, depth: Int = 0, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
    if depth > 60 { return [] }
    var found = match(el) ? [el] : []
    for child in children(el) { found += findAll(child, depth: depth + 1, match) }
    return found
}

func role(_ el: AXUIElement) -> String? { str(el, kAXRoleAttribute) }

func url(_ el: AXUIElement) -> URL? { attr(el, "AXURL") as? URL }

func classes(_ el: AXUIElement) -> [String] { (attr(el, "AXDOMClassList") as? [String]) ?? [] }

/// Poll until `condition` holds or the timeout passes.
func waitFor(_ seconds: Double, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.1)
    } while Date() < deadline
    return condition()
}

final class ConductorWindow {
    let app: AXUIElement
    let pid: pid_t

    init?(pid: pid_t) {
        self.pid = pid
        app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    var window: AXUIElement? {
        ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first { str($0, kAXSubroleAttribute) == "AXStandardWindow" }
    }

    var webArea: AXUIElement? {
        guard let window else { return nil }
        return findAll(window) { role($0) == "AXWebArea" }.first
    }

    /// The route Conductor is showing. This, not a tab's label, is what proves
    /// which chat a paste would land in.
    var route: URLComponents? {
        guard let area = webArea, let u = url(area) else { return nil }
        return URLComponents(url: u, resolvingAgainstBaseURL: false)
    }

    var workspaceId: String? {
        guard let parts = route?.path.split(separator: "/"), let i = parts.firstIndex(of: "workspace"), i + 1 < parts.count else { return nil }
        return String(parts[i + 1])
    }

    var sessionId: String? {
        route?.queryItems?.first { $0.name == "sessionId" }?.value
    }

    func composer() -> AXUIElement? {
        guard let area = webArea else { return nil }
        return findAll(area) { role($0) == "AXTextArea" && classes($0).contains("composer-tiptap-editor") }.first
    }
}

func composerText(_ el: AXUIElement) -> String {
    ((attr(el, kAXValueAttribute) as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

func normalized(_ text: String) -> String {
    text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
}

func postKey(_ pid: pid_t, _ key: CGKeyCode, flags: CGEventFlags = []) {
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
        event?.flags = flags
        event?.postToPid(pid)
    }
}

/// Put `text` on the clipboard for one paste and put back whatever was there.
func withClipboard<T>(_ text: String, _ body: () -> T) -> T {
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    }
    board.clearContents()
    board.setString(text, forType: .string)
    let result = body()
    Thread.sleep(forTimeInterval: 0.3)
    board.clearContents()
    if !saved.isEmpty { board.writeObjects(saved) }
    return result
}

func send(_ request: SendRequest) -> (ok: Bool, error: SendError?, detail: String?) {
    if screenIsLocked() { return (false, .locked, nil) }
    guard let running = conductorProcess() else {
        return (false, .notRunning, nil)
    }
    guard let conductor = ConductorWindow(pid: running.processIdentifier) else { return (false, .noWindow, nil) }
    // WebKit builds its tree lazily for a client that has just asked.
    guard waitFor(5, { conductor.webArea != nil }) else {
        let windows = (attr(conductor.app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        return (false, .noWindow, "windows=\(windows.count) subroles=\(windows.map { str($0, kAXSubroleAttribute) ?? "-" })")
    }

    let previous = NSWorkspace.shared.frontmostApplication
    running.activate()
    // Opening a chat is the point when navigating; otherwise hand focus back.
    let restoreFocus = request.navigateOnly != true
    defer {
        if restoreFocus, let previous, previous.processIdentifier != running.processIdentifier { previous.activate() }
    }

    // 1. The workspace, by id — sidebar links carry their route.
    if conductor.workspaceId != request.workspaceId {
        guard let window = conductor.window,
              let link = findAll(window, { role($0) == "AXLink" && url($0)?.path.hasSuffix("/workspace/\(request.workspaceId)") == true }).first
        else { return (false, .workspaceNotInSidebar, nil) }
        AXUIElementPerformAction(link, kAXPressAction as CFString)
        guard waitFor(4, { conductor.workspaceId == request.workspaceId }) else { return (false, .workspaceNotInSidebar, "did not navigate") }
    }

    // 2. The chat. Tabs are labelled by title, which need not be unique, so
    //    each candidate is only trusted once the route names the session.
    if conductor.sessionId != request.sessionId {
        guard let window = conductor.window else { return (false, .noWindow, nil) }
        let tabs = findAll(window) { role($0) == "AXRadioButton" && (str($0, kAXTitleAttribute) ?? "").hasPrefix("Close chat ") }
        let preferred = tabs.filter { str($0, kAXTitleAttribute) == "Close chat \(request.sessionTitle ?? "")" }
        var reached = false
        for tab in preferred + tabs.filter({ t in !preferred.contains { CFEqual($0, t) } }) {
            AXUIElementPerformAction(tab, kAXPressAction as CFString)
            if waitFor(1.5, { conductor.sessionId == request.sessionId }) { reached = true; break }
        }
        guard reached else { return (false, .chatNotOpen, nil) }
    }

    if request.navigateOnly == true {
        return (true, nil, "opened")
    }

    // 3. The composer, which must be empty: a half-typed message is the
    //    user's, and pasting into it would send both.
    guard waitFor(2, { conductor.composer() != nil }), let composer = conductor.composer() else { return (false, .noComposer, nil) }
    if !composerText(composer).isEmpty { return (false, .draftPresent, nil) }
    AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    Thread.sleep(forTimeInterval: 0.2)

    // Re-check the route right before typing: the user may be clicking too.
    guard conductor.sessionId == request.sessionId else { return (false, .chatNotOpen, "moved before paste") }

    let expected = normalized(request.text)
    let pasted = withClipboard(request.text) { () -> Bool in
        postKey(running.processIdentifier, 9 /* v */, flags: .maskCommand)
        return waitFor(2) { normalized(composerText(composer)).hasPrefix(String(expected.prefix(40))) }
    }
    guard pasted else {
        // Nothing reached the chat; take back whatever half-landed so the
        // user is not left with a stray draft.
        if !composerText(composer).isEmpty {
            postKey(running.processIdentifier, 0 /* a */, flags: .maskCommand)
            postKey(running.processIdentifier, 51 /* delete */)
        }
        return (false, .pasteFailed, nil)
    }
    guard conductor.sessionId == request.sessionId else {
        postKey(running.processIdentifier, 0, flags: .maskCommand)
        postKey(running.processIdentifier, 51)
        return (false, .chatNotOpen, "moved after paste")
    }

    if request.dryRun == true {
        postKey(running.processIdentifier, 0, flags: .maskCommand)
        postKey(running.processIdentifier, 51)
        let cleared = waitFor(2) { composerText(composer).isEmpty }
        return (cleared, cleared ? nil : .unconfirmed, "dry-run")
    }

    postKey(running.processIdentifier, 36 /* return */)
    // Conductor empties the composer once it takes the message.
    if waitFor(3, { composerText(composer).isEmpty }) { return (true, nil, nil) }
    return (false, .unconfirmed, nil)
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "probe"
let outPath = args.count > 2 ? args[2] : "/tmp/squeak-hands.json"
// Where errors go: the probe writes to its only path, send to its second.
let errorPath = (mode == "send" || mode == "press" || mode == "choose-file") ? (args.count > 3 ? args[3] : "/tmp/squeak-hands-result.json") : outPath

let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
if !trusted {
    write(["ok": false, "error": "not-trusted"], to: errorPath)
    exit(2)
}

switch mode {
case "probe":
    guard let app = conductorApp() else {
        write(["ok": false, "error": "conductor-not-running"], to: outPath)
        exit(3)
    }
    // Web content only builds its tree for assistive clients that ask.
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    // The window list is briefly empty while WebKit rebuilds its tree for
    // the client that just asked; wait for it rather than report nothing.
    _ = waitFor(5) { !((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).isEmpty }
    Thread.sleep(forTimeInterval: 0.5)
    var nodes: [[String: Any]] = []
    for window in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
        dump(window, depth: 0, into: &nodes)
    }
    write(["ok": true, "nodes": nodes], to: outPath)
case "press":
    // press <request.json> <result.json>: press the one control whose title or
    // description is exactly `match` (optionally inside `within`), wait, and
    // dump the tree — to read what a menu or sheet offers before acting on it.
    struct PressRequest: Decodable {
        let match: String; let role: String?; let wait: Double?; let setValue: String?; let byDomId: Bool?
        /// Another app than Conductor — e.g. the iOS Simulator, for tests.
        let bundleId: String?
    }
    let resultPath = args.count > 3 ? args[3] : "/tmp/squeak-hands-result.json"
    guard let data = FileManager.default.contents(atPath: outPath),
          let request = try? JSONDecoder().decode(PressRequest.self, from: data),
          let running = request.bundleId.flatMap({ NSRunningApplication.runningApplications(withBundleIdentifier: $0).first }) ?? conductorProcess()
    else {
        write(["ok": false, "error": "bad-request"], to: resultPath)
        exit(65)
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = waitFor(5) { !((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).isEmpty }
    running.activate()
    Thread.sleep(forTimeInterval: 0.4)
    let windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    let matches = windows.flatMap { window in
        findAll(window) { element in
            (request.byDomId == true
                ? str(element, "AXDOMIdentifier") == request.match
                : (str(element, kAXTitleAttribute) == request.match || str(element, kAXDescriptionAttribute) == request.match))
                && (request.role == nil || role(element) == request.role)
        }
    }
    guard matches.count == 1, let target = matches.first else {
        write(["ok": false, "error": matches.isEmpty ? "no-match" : "ambiguous", "count": matches.count], to: resultPath)
        exit(3)
    }
    if let value = request.setValue {
        AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString)
    } else {
        AXUIElementPerformAction(target, kAXPressAction as CFString)
    }
    Thread.sleep(forTimeInterval: request.wait ?? 1.0)
    var nodes: [[String: Any]] = []
    for window in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { dump(window, depth: 0, into: &nodes) }
    write(["ok": true, "nodes": nodes], to: resultPath)
case "choose-file":
    // choose-file <request.json> <result.json>: press `match` (a button that
    // opens the standard file picker), then pick `path` in it via ⌘⇧G.
    struct ChooseRequest: Decodable { let match: String; let path: String }
    let resultPath = args.count > 3 ? args[3] : "/tmp/squeak-hands-result.json"
    guard let data = FileManager.default.contents(atPath: outPath),
          let request = try? JSONDecoder().decode(ChooseRequest.self, from: data),
          FileManager.default.fileExists(atPath: request.path),
          let running = conductorProcess()
    else {
        write(["ok": false, "error": "bad-request"], to: resultPath)
        exit(65)
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = waitFor(5) { !((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).isEmpty }
    running.activate()
    Thread.sleep(forTimeInterval: 0.4)
    let buttons = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).flatMap { window in
        findAll(window) { str($0, kAXTitleAttribute) == request.match && role($0) == "AXButton" }
    }
    guard buttons.count == 1 else {
        write(["ok": false, "error": buttons.isEmpty ? "no-match" : "ambiguous"], to: resultPath)
        exit(3)
    }
    AXUIElementPerformAction(buttons[0], kAXPressAction as CFString)
    // Wait for the open panel: a new window (or sheet) on the app.
    let before = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count
    guard waitFor(5, { ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count > before
        || findAll(app) { role($0) == "AXSheet" }.count > 0 })
    else {
        write(["ok": false, "error": "no-file-panel"], to: resultPath)
        exit(4)
    }
    Thread.sleep(forTimeInterval: 0.6)
    func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: 0.15)
    }
    key(5 /* g */, [.maskCommand, .maskShift])
    Thread.sleep(forTimeInterval: 0.6)
    withClipboard(request.path) { key(9 /* v */, .maskCommand) }
    Thread.sleep(forTimeInterval: 0.5)
    key(36 /* return: go to the file */)
    Thread.sleep(forTimeInterval: 0.9)
    key(36 /* return: open it */)
    Thread.sleep(forTimeInterval: 1.5)
    let after = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count
    write(["ok": after <= before, "windowsBefore": before, "windowsAfter": after], to: resultPath)
case "send":
    // send <request.json> <result.json>
    let requestPath = outPath
    let resultPath = args.count > 3 ? args[3] : "/tmp/squeak-hands-result.json"
    guard let data = FileManager.default.contents(atPath: requestPath),
          let request = try? JSONDecoder().decode(SendRequest.self, from: data)
    else {
        write(["ok": false, "error": "bad-request"], to: resultPath)
        exit(65)
    }
    let result = send(request)
    var payload: [String: Any] = ["ok": result.ok]
    if let error = result.error { payload["error"] = error.rawValue }
    if let detail = result.detail { payload["detail"] = detail }
    write(payload, to: resultPath)
default:
    write(["ok": false, "error": "unknown-mode"], to: outPath)
    exit(64)
}
