import Foundation

/// Where "Sign in to Squeak" was opened from, so its back button returns there (DESIGN.md §8.10, Sign in page).
public enum SignInOrigin: Equatable, Sendable {
    case settings
    case setup
    case pond(String)
    case dashboard

    /// The back button's words: the place you came from.
    public var backTitle: String {
        switch self {
        case .settings: "Settings"
        case .setup: "Setup"
        case .pond(let name): name.isEmpty ? "Dashboard" : name
        case .dashboard: "Dashboard"
        }
    }
}
