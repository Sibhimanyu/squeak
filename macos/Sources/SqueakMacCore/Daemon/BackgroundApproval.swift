import Foundation
import ServiceManagement

/// Whether macOS lets Squeak's launch agent run (System Settings › General › Login Items › "Allow in the Background").
/// A person who turned it off, or dismissed the "background item added" notice the wrong way, leaves launchd refusing the job.
public enum BackgroundApproval: Equatable, Sendable {
    case allowed
    /// The person has switched Squeak's background item off.
    case needsApproval
    /// macOS knows nothing of the plist yet, or this macOS cannot say: carry on and let the start itself show it.
    case unknown

    /// The mapping, apart from the system call so it can be tested.
    public static func from(rawStatus: Int) -> BackgroundApproval {
        // SMAppService.Status: notRegistered 0, enabled 1, requiresApproval 2, notFound 3.
        switch rawStatus {
        case 1: return .allowed
        case 2: return .needsApproval
        default: return .unknown
        }
    }

    /// Reads macOS's own answer for a launch agent plist (macOS 13+).
    public static func current(plist: URL) -> BackgroundApproval {
        from(rawStatus: SMAppService.statusForLegacyPlist(at: plist).rawValue)
    }

    public static func openLoginItemsSettings() { SMAppService.openSystemSettingsLoginItems() }
}
