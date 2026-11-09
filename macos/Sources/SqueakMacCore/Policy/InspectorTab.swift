import Foundation

/// DESIGN.md §8.10, the inspector's tabs, in the order they sit. Decided apart from the views so CI can test which a
/// chat gets: Squeak's own chats have a workspace the host knows (checks, setup, run); a Conductor chat has files,
/// changes, review and what it is doing.
public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
    case files, changes, checks, review, setup, run
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .files: "All files"
        case .changes: "Changes"
        case .checks: "Checks"
        case .review: "Review"
        case .setup: "Setup"
        case .run: "Run"
        }
    }

    /// Checks (the pull request and its checks), Setup and Run belong to a workspace Squeak's host runs.
    public var needsHostWorkspace: Bool { self == .checks || self == .setup || self == .run }

    public static func available(native: Bool) -> [InspectorTab] { native ? allCases : allCases.filter { !$0.needsHostWorkspace } }
}
