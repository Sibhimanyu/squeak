import Foundation

/// `v2.0.0`, `2.1.0-beta.1`. Pre-releases sort before their release.
public struct SemanticVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
    public var major: Int
    public var minor: Int
    public var patch: Int
    public var prerelease: [String]

    public init?(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        if let plus = s.firstIndex(of: "+") { s = String(s[..<plus]) }
        var pre: [String] = []
        if let dash = s.firstIndex(of: "-") {
            pre = s[s.index(after: dash)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            s = String(s[..<dash])
            if pre.contains(where: \.isEmpty) { return nil }
        }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var nums: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber), let n = Int(p) else { return nil }
            nums.append(n)
        }
        major = nums[0]
        minor = nums.count > 1 ? nums[1] : 0
        patch = nums.count > 2 ? nums[2] : 0
        prerelease = pre
    }

    public var description: String {
        "\(major).\(minor).\(patch)" + (prerelease.isEmpty ? "" : "-" + prerelease.joined(separator: "."))
    }

    public static func < (a: SemanticVersion, b: SemanticVersion) -> Bool {
        if (a.major, a.minor, a.patch) != (b.major, b.minor, b.patch) {
            return (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
        }
        if a.prerelease.isEmpty { return false }
        if b.prerelease.isEmpty { return true }
        for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
            switch (Int(x), Int(y)) {
            case let (i?, j?): return i < j
            case (_?, nil): return true
            case (nil, _?): return false
            default: return x < y
            }
        }
        return a.prerelease.count < b.prerelease.count
    }
}

public struct AvailableUpdate: Equatable, Sendable {
    public var version: SemanticVersion
    public var tag: String
    public var releaseURL: URL
}

public enum UpdateCheckResult: Equatable, Sendable {
    case upToDate
    case available(AvailableUpdate)
    case failed(String)
}

/// Asks GitHub whether a newer release exists. Reads one JSON document; never
/// downloads or installs anything.
public struct UpdateChecker: Sendable {
    public static let endpoint = URL(string: "https://api.github.com/repos/Sibhimanyu/squeak/releases/latest")!
    private let transport: any HTTPTransport

    public init(transport: any HTTPTransport = URLSessionTransport()) { self.transport = transport }

    private struct Release: Decodable {
        var tag_name: String?
        var html_url: String?
        var draft: Bool?
        var prerelease: Bool?
    }

    public func check(currentVersion: String) async -> UpdateCheckResult {
        guard let current = SemanticVersion(currentVersion) else { return .failed("Unknown current version") }
        let request = HTTPRequest(
            url: Self.endpoint,
            headers: ["User-Agent": "Squeak", "Accept": "application/vnd.github+json"],
            timeout: 10)
        let response: HTTPResponse
        do { response = try await transport.send(request) } catch { return .failed("Couldn't reach GitHub") }
        guard response.status == 200 else { return .failed("GitHub answered HTTP \(response.status)") }
        guard let release = try? JSONDecoder().decode(Release.self, from: response.body),
              let tag = release.tag_name, let latest = SemanticVersion(tag) else { return .failed("Unreadable release information") }
        if release.draft == true || release.prerelease == true { return .upToDate }
        guard latest > current else { return .upToDate }
        // Only ever open a page on github.com, whatever the response says.
        guard let raw = release.html_url, let url = URL(string: raw), url.scheme == "https", url.host == "github.com" else {
            return .failed("Release has no usable link")
        }
        return .available(AvailableUpdate(version: latest, tag: tag, releaseURL: url))
    }
}
