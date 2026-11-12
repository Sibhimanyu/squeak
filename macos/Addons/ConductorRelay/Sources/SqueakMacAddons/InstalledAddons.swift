import Conductor
import ConductorRelay
import SqueakMacCore

/// Replaces Sources/SqueakMacAddons/InstalledAddons.swift while the Conductor relay add-on is built in.
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {
        let conductor = ConductorAddon(client: client)
        let relay = RelayModel(client: client, demo: demo)
        conductor.link = relay
        registry.register(app: conductor)
        registry.register(conductorLink: relay)
    }
}
