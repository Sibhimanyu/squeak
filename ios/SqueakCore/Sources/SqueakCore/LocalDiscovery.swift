import Foundation
import Network

/// Finds the Mac on the same network: Bonjour `_squeak._tcp` (the first use asks for Local Network access),
/// keeping only the result whose TXT tag is this channel's own (`LocalAuth.tag`), then resolving it to an
/// IPv4 address a URLSession can use. The Mac listens on IPv4 only.
public struct BonjourDiscovery: LocalDiscovery {
    public static let serviceType = "_squeak._tcp"
    let browseSeconds: Double
    let resolveSeconds: Double

    public init(browseSeconds: Double = 3.0, resolveSeconds: Double = 2.5) {
        self.browseSeconds = browseSeconds; self.resolveSeconds = resolveSeconds
    }

    public func candidates(tag: String) async -> [URL] {
        let endpoints = await browse(tag: tag)
        var urls: [URL] = []
        for endpoint in endpoints {
            if let url = await resolve(endpoint), !urls.contains(url) { urls.append(url) }
        }
        return urls
    }

    /// Results carrying this tag, stopping at the first (or when the browse time is up).
    private func browse(tag: String) async -> [NWEndpoint] {
        await withCheckedContinuation { continuation in
            let once = Once(continuation)
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { results, _ in
                let mine = results.compactMap { result -> NWEndpoint? in
                    guard case .bonjour(let record) = result.metadata, record.dictionary["t"] == tag else { return nil }
                    return result.endpoint
                }
                if !mine.isEmpty { once.finish(mine); browser.cancel() }
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .failed, .cancelled: once.finish([])
                default: break
                }
            }
            browser.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + browseSeconds) {
                once.finish([])
                browser.cancel()
            }
        }
    }

    /// Opens a connection to the service just long enough to read the IPv4 address the system chose.
    private func resolve(_ endpoint: NWEndpoint) async -> URL? {
        await withCheckedContinuation { continuation in
            let once = Once(continuation)
            let connection = NWConnection(to: endpoint, using: .tcp)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint, case .ipv4(let address) = host {
                        let text = address.rawValue.map(String.init).joined(separator: ".")
                        // The tag is public (anyone on the network can copy it), so a result is no more
                        // trusted than a stranger's: a signed request goes only where a LAN would be.
                        once.finish(LocalEndpointHints.isPrivateIPv4(text) ? URL(string: "http://\(text):\(port.rawValue)") : nil)
                    } else {
                        once.finish(nil)
                    }
                    connection.cancel()
                case .failed, .cancelled:
                    once.finish(nil)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + resolveSeconds) {
                once.finish(nil)
                connection.cancel()
            }
        }
    }
}

/// Resumes a continuation exactly once, whichever callback gets there first.
private final class Once<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    init(_ continuation: CheckedContinuation<Value, Never>) { self.continuation = continuation }
    func finish(_ value: Value) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}

/// What the Mac's own view says about where it listens (`PhoneSnapshot.local`), as addresses to try.
public enum LocalEndpointHints {
    /// URLs for the view's addresses, only when its tag is this channel's own and only private-range IPv4
    /// addresses (or loopback): a signed request is never sent anywhere a LAN would not be.
    public static func urls(_ info: PhoneSnapshot.LocalEndpointInfo?, expectedTag: String?) -> [URL] {
        guard let info, info.tag == expectedTag, (1...65535).contains(info.port) else { return [] }
        return info.hosts.prefix(4).compactMap { host in
            guard isPrivateIPv4(host) else { return nil }
            return URL(string: "http://\(host):\(info.port)")
        }
    }

    static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, let octets = Optional(parts.compactMap { UInt8($0) }), octets.count == 4 else { return false }
        return octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && (16...31).contains(octets[1]))
    }
}
