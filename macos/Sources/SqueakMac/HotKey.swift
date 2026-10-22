import AppKit
import Carbon.HIToolbox
import Observation

struct HotKeyPreset: Identifiable, Hashable {
    let id: String
    let title: String
    let keyCode: UInt32
    let modifiers: UInt32

    static let defaultID = "opt-space"

    static let all: [HotKeyPreset] = [
        HotKeyPreset(id: "opt-space", title: "⌥ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)),
        HotKeyPreset(id: "ctrl-shift-space", title: "⌃⇧ Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | shiftKey)),
        HotKeyPreset(id: "ctrl-shift-k", title: "⌃⇧ K", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey | shiftKey)),
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

/// What is stored under the `hotKey` default: no value means the default, "" means the user chose None.
enum HotKeyPreference {
    static let migrationKey = "hotKeyMovedToOptSpace"

    /// The shortcut id to use at launch. Runs at app init only: the one-time move off ⌥⌘M happens
    /// when the marker is unset; after that ⌥⌘M is an ordinary choice again.
    static func resolve(stored: String?, alreadyMigrated: Bool) -> String? {
        if !alreadyMigrated, stored == "opt-cmd-m" { return HotKeyPreset.defaultID }
        guard let stored else { return HotKeyPreset.defaultID }
        return stored.isEmpty ? nil : stored
    }

    static func storedValue(for id: String?) -> String { id ?? "" }
}

/// Carbon RegisterEventHotKey: a global shortcut that needs no Accessibility grant.
@MainActor
@Observable
final class HotKeyCenter {
    static let shared = HotKeyCenter()
    @ObservationIgnored var onFire: (() -> Void)?
    /// Set for capture and demo runs, which must never grab a global key.
    @ObservationIgnored var isDisabled = false
    /// Why the chosen shortcut is not active, in words for Settings; nil when it works or none is chosen.
    private(set) var registrationError: String?
    @ObservationIgnored private var ref: EventHotKeyRef?
    @ObservationIgnored private var handler: EventHandlerRef?

    func register(_ preset: HotKeyPreset?) {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        registrationError = nil
        guard !isDisabled, let preset else { return }
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
