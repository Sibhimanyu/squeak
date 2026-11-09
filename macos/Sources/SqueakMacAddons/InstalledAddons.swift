import SqueakMacCore

/// The add-ons this build carries. Empty here: Package.swift swaps this module's folder for an add-on's own
/// (macos/Addons/<Name>/Sources/SqueakMacAddons) only when that folder exists and the environment asks for it
/// (see the marked block in Package.swift), and the add-on's version registers itself. Release builds use this one.
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {}
}
