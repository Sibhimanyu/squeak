import Foundation

/// What Squeak Hands says it holds (`GET /control/hands/grants`). `outdated` means the helper on this Mac
/// predates the `grants` mode (or is missing): the Mac says "Update Squeak Hands" rather than guessing.
public struct HandsGrants: Sendable, Equatable, Decodable {
    public var outdated: Bool
    public var accessibility: Bool
    /// "granted" / "denied" / "notDetermined" / "notRunning".
    public var location: String
    public var automationTerminal: String

    public init(outdated: Bool = false, accessibility: Bool = false, location: String = "notDetermined",
                automationTerminal: String = "notDetermined") {
        self.outdated = outdated; self.accessibility = accessibility
        self.location = location; self.automationTerminal = automationTerminal
    }

    private enum CodingKeys: String, CodingKey { case outdated, accessibility, location, automationTerminal }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outdated = try c.decodeIfPresent(Bool.self, forKey: .outdated) ?? false
        accessibility = try c.decodeIfPresent(Bool.self, forKey: .accessibility) ?? false
        location = try c.decodeIfPresent(String.self, forKey: .location) ?? "notDetermined"
        automationTerminal = try c.decodeIfPresent(String.self, forKey: .automationTerminal) ?? "notDetermined"
    }

    public static let outdatedBuild = HandsGrants(outdated: true)

    /// The reading for one permission Hands holds; nil for the ones it does not (or when outdated).
    public func grant(for kind: PermissionKind) -> PermissionGrant? {
        guard !outdated else { return nil }
        switch kind {
        case .accessibility: return accessibility ? .granted : .notGranted
        case .location: return Self.level(location)
        case .automation: return Self.level(automationTerminal)
        case .notifications, .inputMonitoring: return nil
        }
    }

    private static func level(_ s: String) -> PermissionGrant {
        switch s {
        case "granted": .granted
        case "denied": .denied
        default: .notGranted
        }
    }
}

extension DaemonClient {
    /// nil when the daemon is older than the route or unreachable: the explainer keeps its manual "It's on".
    public func handsGrants() async -> HandsGrants? {
        guard let r = try? await getControl("/control/hands/grants"), (200..<300).contains(r.status) else { return nil }
        return try? JSONDecoder().decode(HandsGrants.self, from: r.body)
    }
}
