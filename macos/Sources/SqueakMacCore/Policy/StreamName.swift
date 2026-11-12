import Foundation

/// One name for a stream (a workspace), like Conductor: the sidebar row, the breadcrumb, the pond home, history rows
/// and notifications all call this. Chat titles belong to chat tabs and the rows inside a stream, never to the stream.
public enum StreamName {
    /// The workspace's own title when it was renamed (`workspaces.title`), else the main checkout's `<repo> · <branch>`,
    /// else the folder's name made readable ("hong-kong" is "Hong Kong").
    public static func resolve(title: String?, name: String, branch: String?, repo: String?) -> String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        if let repo, !repo.isEmpty, name.caseInsensitiveCompare(repo) == .orderedSame {
            let b = (branch ?? "").trimmingCharacters(in: .whitespaces)
            return b.isEmpty ? repo : "\(repo) · \(b)"
        }
        return pretty(name)
    }

    /// "wood-duck" and "wood_duck" show as "Wood Duck"; a name that already has spaces or capitals is left alone.
    public static func pretty(_ name: String) -> String {
        guard name.contains("-") || name.contains("_"), !name.contains(" ") else { return name }
        return name.split(whereSeparator: { $0 == "-" || $0 == "_" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
