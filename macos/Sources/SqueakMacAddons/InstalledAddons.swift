import Conductor
import SqueakMacCore

/// The add-ons this build carries: Conductor, always (inert until the person adds it in Settings › Extensions).
public enum InstalledAddons {
    @MainActor
    public static func register(client: DaemonClient, demo: Bool, into registry: AddonRegistry) {
        registry.register(app: ConductorAddon(client: client))
    }
}
