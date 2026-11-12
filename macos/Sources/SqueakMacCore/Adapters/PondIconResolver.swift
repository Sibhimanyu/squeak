import Foundation

/// One rule for which icon a pond shows, used by every Mac surface: the custom pond icon (what `set_pond_icon` and
/// "Change icon…" write, one file in the host's `project-icons/`) first, then the icon found on the repository
/// (Conductor's), then nothing, which the view draws as a letter on the pond colour.
public enum PondIconResolver {
    public enum Source: Equatable, Sendable { case custom, repository, letter }

    public static func source(custom: Bool, repository: Bool) -> Source {
        custom ? .custom : repository ? .repository : .letter
    }

    /// What a cached custom image is keyed on: the pond and the icon's version (the file's mtime the host sends).
    /// With neither a version nor a URL the pond has no custom icon.
    public static func stamp(id: String, version: String?, url: String?) -> String? {
        guard let v = version ?? url else { return nil }
        return "\(id)@\(v)"
    }
}

/// A cache of one value per pond that drops the previous version when a new one arrives, so a changed icon is
/// fetched again and the old image does not linger.
public struct VersionedCache<Value> {
    private var stamps: [String: String] = [:]
    private var values: [String: Value] = [:]
    public init() {}

    public func value(id: String, stamp: String?) -> Value? {
        guard let stamp, stamps[id] == stamp else { return nil }
        return values[id]
    }

    public mutating func store(_ value: Value, id: String, stamp: String) {
        stamps[id] = stamp
        values[id] = value
    }

    public mutating func remove(id: String) { stamps[id] = nil; values[id] = nil }
    public var ids: Set<String> { Set(values.keys) }
}
