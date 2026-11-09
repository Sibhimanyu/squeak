import Foundation

/// Reads the same repository artwork Conductor displays, without writing to its database.
/// Missing icons (or an older schema) leave the caller's letter-tile fallback intact.
public enum RepositoryIcons {
    public static func read(database: ConductorDatabase = ConductorDatabase()) -> [String: Data] {
        guard let rows = try? database.query("SELECT name, icon FROM repos WHERE icon IS NOT NULL AND icon != ''") else { return [:] }
        var icons: [String: Data] = [:]
        for row in rows {
            if let name = row["name"]?.string, let uri = row["icon"]?.string, let data = decode(uri) { icons[name] = data }
        }
        return icons
    }

    static func decode(_ uri: String) -> Data? {
        guard uri.utf8.count <= 2_800_000, let comma = uri.firstIndex(of: ",") else { return nil }
        let header = String(uri[..<comma]).lowercased()
        guard ["data:image/png;base64", "data:image/jpeg;base64", "data:image/jpg;base64", "data:image/gif;base64", "data:image/webp;base64"].contains(header),
              let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])), !data.isEmpty else { return nil }
        return data
    }
}
