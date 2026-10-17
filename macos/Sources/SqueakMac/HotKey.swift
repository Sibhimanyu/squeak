import AppKit
import Carbon.HIToolbox

struct HotKeyPreset: Identifiable, Hashable {
    let id: String
    let title: String
    let keyCode: UInt32
    let modifiers: UInt32

    static let all: [HotKeyPreset] = [
        HotKeyPreset(id: "ctrl-opt-space", title: "⌃⌥ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)),
        HotKeyPreset(id: "ctrl-opt-cmd-space", title: "⌃⌥⌘ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey | cmdKey)),
        HotKeyPreset(id: "ctrl-opt-cmd-s", title: "⌃⌥⌘ S", keyCode: UInt32(kVK_ANSI_S), modifiers: UInt32(controlKey | optionKey | cmdKey)),
        HotKeyPreset(id: "opt-cmd-m", title: "⌥⌘ M", keyCode: UInt32(kVK_ANSI_M), modifiers: UInt32(optionKey | cmdKey)),
    ]

    static func preset(id: String?) -> HotKeyPreset? { all.first { $0.id == id } }
}

private func squeakHotKeyHandler(_ next: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    Task { @MainActor in HotKeyCenter.shared.onFire?() }
    return noErr
}

/// Carbon RegisterEventHotKey: a global shortcut that needs no Accessibility grant.
@MainActor
final class HotKeyCenter {
    static let shared = HotKeyCenter()
    var onFire: (() -> Void)?
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?

    func register(_ preset: HotKeyPreset?) {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        guard let preset else { return }
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), squeakHotKeyHandler, 1, &spec, nil, &handler)
        }
        let id = EventHotKeyID(signature: OSType(0x5351_4B31), id: 1)
        var newRef: EventHotKeyRef?
        let status = RegisterEventHotKey(preset.keyCode, preset.modifiers, id, GetApplicationEventTarget(), 0, &newRef)
        if status == noErr { ref = newRef }
    }
}
