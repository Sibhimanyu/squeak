import Foundation

/// Reads and rewrites the daemon's `.env` without disturbing what it does not own:
/// comments, blank lines, order and unknown keys all survive. Values are never logged.
public struct EnvFile: Sendable {
    public let url: URL

    public init(url: URL = EnvFile.defaultURL) { self.url = url }

    public static var defaultURL: URL {
        URL.homeDirectory.appending(path: "Library/Application Support/squeak/.env")
    }

    public enum EnvError: Error, Equatable { case unreadable, writeFailed }

    // MARK: Reading

    /// Every uncommented `KEY=value`; the last one wins, as in the daemon's loader.
    public func values() -> [String: String] {
        var out: [String: String] = [:]
        for line in lines() { if let (k, v) = Self.parse(line) { out[k] = v } }
        return out
    }

    public func value(_ key: String) -> String? { values()[key] }

    public func has(_ key: String) -> Bool {
        guard let v = value(key) else { return false }
        return !v.trimmingCharacters(in: .whitespaces).isEmpty
    }

    // MARK: Writing

    /// Sets and removes keys in one atomic write. A nil value removes the key.
    public func apply(_ changes: [String: String?]) throws {
        var out = lines()
        for key in changes.keys.sorted() {
            let change = changes[key]!
            let indices = out.indices.filter { Self.parse(out[$0])?.0 == key }
            if let value = change {
                let line = "\(key)=\(Self.quote(value))"
                if let first = indices.first {
                    out[first] = line
                    for i in indices.dropFirst().reversed() { out.remove(at: i) }
                } else {
                    out.append(line)
                }
            } else {
                for i in indices.reversed() { out.remove(at: i) }
            }
        }
        try write(out)
    }

    public func set(_ key: String, _ value: String) throws { try apply([key: value]) }
    public func remove(_ key: String) throws { try apply([key: nil]) }

    // MARK: Internals

    private func lines() -> [String] {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
        var parts = text.components(separatedBy: "\n")
        if parts.last == "" { parts.removeLast() }
        return parts
    }

    private func write(_ lines: [String]) throws {
        let dir = url.deletingLastPathComponent()
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let text = lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
        let tmp = dir.appending(path: ".env.\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: tmp.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
            throw EnvError.writeFailed
        }
        do {
            if fm.fileExists(atPath: url.path) {
                _ = try fm.replaceItemAt(url, withItemAt: tmp)
            } else {
                try fm.moveItem(at: tmp, to: url)
            }
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            try? fm.removeItem(at: tmp)
            throw EnvError.writeFailed
        }
    }

    static func parse(_ line: String) -> (String, String)? {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.isEmpty || s.hasPrefix("#") { return nil }
        if s.hasPrefix("export ") { s = String(s.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
        guard let eq = s.firstIndex(of: "=") else { return nil }
        let key = String(s[..<eq]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        let raw = String(s[s.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
        return (key, unquote(raw))
    }

    private static func unquote(_ raw: String) -> String {
        if raw.hasPrefix("\"") {
            // Up to the closing quote; anything after it (an inline comment) is not the value.
            var out = "", escape = false
            for c in raw.dropFirst() {
                if escape {
                    out.append(c == "n" ? "\n" : c)
                    escape = false
                } else if c == "\\" { escape = true } else if c == "\"" { return out } else { out.append(c) }
            }
            return out
        }
        if raw.hasPrefix("'") {
            let rest = raw.dropFirst()
            if let end = rest.firstIndex(of: "'") { return String(rest[..<end]) }
            return String(rest)
        }
        // Unquoted: a trailing ` # comment` is not part of the value.
        if let r = raw.range(of: " #") { return String(raw[..<r.lowerBound]).trimmingCharacters(in: .whitespaces) }
        return raw
    }

    /// Plain values stay bare (`123:abc-DEF`); anything a loader could misread is double-quoted.
    static func quote(_ value: String) -> String {
        let safe = !value.isEmpty && value.allSatisfy { c in
            c.isASCII && (c.isLetter || c.isNumber || "_-.:/@+,=%".contains(c))
        }
        if safe { return value }
        var out = "\""
        for c in value {
            switch c {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": break
            default: out.append(c)
            }
        }
        return out + "\""
    }
}
