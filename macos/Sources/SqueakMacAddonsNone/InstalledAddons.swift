import SqueakMacCore

/// Stands in for Sources/SqueakMacAddons while Addons/Conductor/ is deleted (see the marked block in Package.swift): no add-on.
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {}
}
