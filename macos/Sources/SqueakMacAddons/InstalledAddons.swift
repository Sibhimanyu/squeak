import Conductor
import SqueakMacCore

/// The add-ons this build carries: Conductor, always (inert until the person adds it in Settings › Extensions).
/// With the development relay built in (see the marked block in Package.swift) this file is replaced by the relay
/// folder's own, which registers Conductor too and attaches the relay to it.
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {
        registry.register(app: ConductorAddon(client: client))
    }
}
