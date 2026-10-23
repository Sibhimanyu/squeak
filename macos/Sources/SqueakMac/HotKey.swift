import AppKit
import Carbon.HIToolbox
import Observation
import SqueakMacCore

/// How the Quick message shortcut is chosen in Settings: two double-taps and two Carbon key combinations.
struct HotKeyPreset: Identifiable, Hashable {
    let id: String
    let title: String
    /// Carbon key and modifiers; zero for a double-tap, which has no key.
    let keyCode: UInt32
    let modifiers: UInt32

    var isDoubleTap: Bool { QuickShortcut.doubleTapModifier(id: id) != nil }

    static let all: [HotKeyPreset] = [
        HotKeyPreset(id: QuickShortcut.doubleControl, title: "Double-tap Control", keyCode: 0, modifiers: 0),
        HotKeyPreset(id: QuickShortcut.doubleOption, title: "Double-tap Option", keyCode: 0, modifiers: 0),
        HotKeyPreset(id: QuickShortcut.controlShiftSpace, title: "⌃⇧ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | shiftKey)),
        HotKeyPreset(id: QuickShortcut.optionSpace, title: "⌥ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)),
    ]

    static func preset(id: String?) -> HotKeyPreset? { all.first { $0.id == id } }
}

private func squeakHotKeyHandler(_ next: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    Task { @MainActor in HotKeyCenter.shared.onFire?() }
    return noErr
}

private func squeakModifierTapCallback(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let info {
        // Only the modifier flags are read here, never a key code or any text. The tap sits on the main run loop.
        let flags = event.flags
        let now = ProcessInfo.processInfo.systemUptime
        let center = Unmanaged<HotKeyCenter>.fromOpaque(info).takeUnretainedValue()
        MainActor.assumeIsolated { center.handleTapEvent(type, flags: flags, at: now) }
    }
    return Unmanaged.passUnretained(event)
}

/// The Quick message shortcut. Two kinds:
///
/// - **Double-tap Control / Option**: a listen-only `CGEventTap` on `flagsChanged` (plus key and click
///   "something happened" events, whose contents are never read) at session level. macOS gates it behind
///   **Input Monitoring** (TCC `kTCCServiceListenEvent`); no Accessibility grant is involved.
///   `DoubleTapDetector` (SqueakMacCore) decides what counts as a double-tap.
/// - **⌃⇧ Space / ⌥ Space**: Carbon `RegisterEventHotKey`, which needs no permission.
///
/// A double-tap choice without Input Monitoring falls back to ⌃⇧ Space until it is granted.
@MainActor
@Observable
final class HotKeyCenter {
    static let shared = HotKeyCenter()
    @ObservationIgnored var onFire: (() -> Void)?
    /// Set for capture and demo runs, which must never grab a global key or install a tap.
    @ObservationIgnored var isDisabled = false
    /// Demo and capture only: show the not-granted state without touching the real permission.
    @ObservationIgnored var previewNotGranted = false
    /// Why the chosen shortcut is not active, in words for Settings; nil when it works or none is chosen.
    private(set) var registrationError: String?
    /// A double-tap is chosen but Input Monitoring is not granted, so the fallback is in use.
    private(set) var needsInputMonitoring = false
    /// The person pressed the grant button this run, so macOS may want a relaunch before the tap works.
    private(set) var requestedThisRun = false
    @ObservationIgnored private var chosenID: String?
    @ObservationIgnored private var ref: EventHotKeyRef?
    @ObservationIgnored private var handler: EventHandlerRef?
    @ObservationIgnored private var tap: CFMachPort?
    @ObservationIgnored private var tapSource: CFRunLoopSource?
    @ObservationIgnored private var detector: DoubleTapDetector?

    /// The preset that is actually live: the choice, or its fallback while Input Monitoring is missing.
    var activePreset: HotKeyPreset? {
        HotKeyPreset.preset(id: QuickShortcut.effectiveID(chosen: chosenID, inputMonitoringGranted: !needsInputMonitoring))
    }

    func register(_ preset: HotKeyPreset?) {
        chosenID = preset?.id
        stopTap()
        unregisterCarbon()
        registrationError = nil
        needsInputMonitoring = false
        guard !isDisabled else {
            needsInputMonitoring = previewNotGranted && preset?.isDoubleTap == true
            return
        }
        guard let preset else { return }
        if let modifier = QuickShortcut.doubleTapModifier(id: preset.id) {
            if startTap(modifier) { return }
            needsInputMonitoring = true
            if let fallback = HotKeyPreset.preset(id: QuickShortcut.controlShiftSpace) { registerCarbon(fallback) }
            return
        }
        registerCarbon(preset)
    }

    /// Run again when the app becomes active: the grant may have been given in System Settings meanwhile.
    func recheck() {
        guard !isDisabled, needsInputMonitoring else { return }
        register(HotKeyPreset.preset(id: chosenID))
    }

    /// Asks macOS for Input Monitoring and opens its pane, since the prompt only appears once.
    func requestInputMonitoring() {
        requestedThisRun = true
        _ = CGRequestListenEventAccess()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Starts a fresh copy of the app and quits this one, for a grant macOS applies only to new processes.
    func relaunch() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "sleep 1; /usr/bin/open -n \"$0\"", path]
        try? task.run()
        QuitIntent.shared.quitCompletely()
    }

    // MARK: Double-tap

    private func startTap(_ modifier: TapModifiers) -> Bool {
        guard CGPreflightListenEventAccess() else { return false }
        let types: [CGEventType] = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: squeakModifierTapCallback, userInfo: me)
        else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        tapSource = source
        detector = DoubleTapDetector(modifier: modifier)
        return true
    }

    private func stopTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        tap = nil
        tapSource = nil
        detector = nil
    }

    fileprivate func handleTapEvent(_ type: CGEventType, flags: CGEventFlags, at time: TimeInterval) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            detector?.otherInput()
        case .flagsChanged:
            var held: TapModifiers = []
            if flags.contains(.maskControl) { held.insert(.control) }
            if flags.contains(.maskAlternate) { held.insert(.option) }
            if flags.contains(.maskShift) { held.insert(.shift) }
            if flags.contains(.maskCommand) { held.insert(.command) }
            if detector?.flagsChanged(held, at: time) == true { onFire?() }
        default:
            detector?.otherInput()
        }
    }

    // MARK: Carbon

    private func unregisterCarbon() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }

    private func registerCarbon(_ preset: HotKeyPreset) {
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let installed = InstallEventHandler(GetApplicationEventTarget(), squeakHotKeyHandler, 1, &spec, nil, &handler)
            if installed != noErr {
                handler = nil
                registrationError = "macOS would not let Squeak listen for \(preset.title) (error \(installed))."
                return
            }
        }
        let id = EventHotKeyID(signature: OSType(0x5351_4B31), id: 1)
        var newRef: EventHotKeyRef?
        let status = RegisterEventHotKey(preset.keyCode, preset.modifiers, id, GetApplicationEventTarget(), 0, &newRef)
        if status == noErr {
            ref = newRef
        } else if status == OSStatus(eventHotKeyExistsErr) {
            registrationError = "\(preset.title) is already used by another app. Pick a different shortcut."
        } else {
            registrationError = "\(preset.title) could not be registered (error \(status)). Pick a different shortcut."
        }
    }
}
