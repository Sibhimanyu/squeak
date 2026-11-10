import Foundation

/// The sidebar's "+" on a project row and the New chat sheet's "New workspace in <project>" make a bird-named
/// worktree through the session host, then open the sheet preset to it (DESIGN.md §8.10).
public enum NativeWorkspaceMaking {
    /// The host project a sidebar project row is: the sidebar groups by repository name, so a project matches by
    /// name (case aside). Nil for a row the host does not run chats in (a Conductor-only repository): no "+" there.
    public static func project(named name: String, in projects: [NativeProject]) -> NativeProject? {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        guard !n.isEmpty else { return nil }
        return projects.first { $0.name.trimmingCharacters(in: .whitespaces).lowercased() == n }
    }

    /// Why a workspace was not made, in a plain sentence (never a status code or a raw body).
    public static func problem(_ error: Error) -> String {
        guard let e = error as? NativeHostError else { return "Squeak couldn't make the workspace." }
        switch e {
        case .hostDown, .tokenMissing, .tokenRejected: return e.reason + "."
        case .http(_, let m):
            if let m, !m.isEmpty { return m.hasSuffix(".") ? m : m + "." }
            return "Squeak couldn't make the workspace."
        case .uncertain: return "Squeak's session host didn't answer. Check the pond's workspaces before trying again."
        case .badResponse: return "Squeak couldn't make the workspace."
        }
    }
}
