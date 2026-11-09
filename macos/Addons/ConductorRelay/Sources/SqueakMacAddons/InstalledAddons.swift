import ConductorRelay
import SqueakMacCore

/// Replaces Sources/SqueakMacAddons/InstalledAddons.swift while the Conductor relay add-on is built in.
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {
        registry.register(conductorLink: RelayModel(client: client, demo: demo))
    }
}
