import CryptoKit
import Foundation

/// The direct same-Wi-Fi path's HTTP: the Realtime Database's REST dialect
/// (`RealtimeDatabaseClient` does the verbs and the event parsing) with the
/// channel id taken out of every path and an HMAC on every request, and on
/// every response one that binds the request's nonce. See `LocalAuth`.
public enum LocalFailure: Error, Equatable {
    /// The request named nothing under this channel, so none was made.
    case badPath
    case notHTTP
    /// The answer did not carry the Mac's MAC for this request: not the Mac, or an old answer replayed.
    case badResponseMAC
    case http(Int)

    /// Whether `error` proves the request never reached a server, so a command can safely go another way.
    public static func neverReached(_ error: Error) -> Bool {
        if let failure = error as? LocalFailure { return failure == .badPath }
        guard let url = error as? URLError else { return false }
        switch url.code {
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            return true
        default:
            return false
        }
    }
}

/// Signs requests for the channel's local path.
public struct LocalSigner: Sendable {
    public let key: SymmetricKey
    public let channelId: String
    let now: @Sendable () -> Date

    public init(channelKey: String, channelId: String, now: @escaping @Sendable () -> Date = Date.init) throws {
        guard let key = LocalAuth.key(channelKey: channelKey) else { throw ChannelCrypto.Failure.badKey }
        self.key = key; self.channelId = channelId; self.now = now
    }

    /// The request as the Mac wants it: `/channels/<id>` removed from the path (a LAN observer never sees the
    /// channel id), a stamp, a nonce and the MAC added. `timeout` caps how long a local call may take, so a
    /// Mac that is not there fails over to the cloud quickly.
    public func sign(_ request: URLRequest, timeout: TimeInterval? = nil) throws -> (request: URLRequest, nonce: String) {
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw LocalFailure.badPath }
        let prefix = "/channels/\(channelId)"
        guard components.percentEncodedPath.hasPrefix(prefix + "/") else { throw LocalFailure.badPath }
        components.percentEncodedPath = String(components.percentEncodedPath.dropFirst(prefix.count))
        guard let rewritten = components.url else { throw LocalFailure.badPath }
        let target = components.percentEncodedPath + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        var signed = request
        signed.url = rewritten
        if let timeout { signed.timeoutInterval = min(signed.timeoutInterval, timeout) }
        let method = signed.httpMethod ?? "GET"
        let timestamp = String(Int64(now().timeIntervalSince1970 * 1000))
        let nonce = LocalAuth.newNonce()
        let mac = LocalAuth.requestMAC(key: key, method: method, target: target, timestamp: timestamp, nonce: nonce, body: signed.httpBody ?? Data())
        signed.setValue(timestamp, forHTTPHeaderField: LocalAuth.headerTimestamp)
        signed.setValue(nonce, forHTTPHeaderField: LocalAuth.headerNonce)
        signed.setValue(mac, forHTTPHeaderField: LocalAuth.headerMAC)
        return (signed, nonce)
    }
}

/// Requests (get, set, delete) to the Mac, signed, with the answer's MAC checked before it is believed.
public struct LocalHTTPTransport: HTTPTransport {
    let signer: LocalSigner
    let inner: HTTPTransport
    let timeout: TimeInterval

    public init(signer: LocalSigner, inner: HTTPTransport, timeout: TimeInterval = LocalHTTPTransport.requestSeconds) {
        self.signer = signer; self.inner = inner; self.timeout = timeout
    }

    /// A local call that takes longer than this has failed: the cloud is the fallback.
    public static let requestSeconds: TimeInterval = 3
    /// A probe must answer within about a second.
    public static let probeSeconds: TimeInterval = 2

    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let (signed, nonce) = try signer.sign(request, timeout: timeout)
        let (data, response) = try await inner.data(for: signed)
        guard let http = response as? HTTPURLResponse else { throw LocalFailure.notHTTP }
        // A refusal carries no MAC and is a failure whatever it says; a success must prove it is the Mac's, for this request.
        if (200..<300).contains(http.statusCode) {
            guard LocalAuth.isValidResponse(key: signer.key, nonce: nonce, status: http.statusCode, body: data,
                                            mac: http.value(forHTTPHeaderField: LocalAuth.headerResponseMAC)) else {
                throw LocalFailure.badResponseMAC
            }
        }
        return (data, response)
    }
}

/// Opens a stream and says how it was answered. A `URLSession` in the app, a fake in tests.
public protocol LocalByteStream: Sendable {
    func open(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>)
}

extension URLSession: LocalByteStream {
    public func open(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>) {
        let (bytes, response) = try await bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw LocalFailure.notHTTP }
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (http, lines)
    }
}

/// Event streams from the Mac. The stream's first answer must carry the Mac's MAC for the request (the body
/// of a stream has no end to hash, so the events themselves only say "something changed": the phone reads
/// what changed through signed requests).
public struct LocalLineStream: LineStreamTransport {
    let signer: LocalSigner
    let inner: LocalByteStream

    public init(signer: LocalSigner, inner: LocalByteStream) { self.signer = signer; self.inner = inner }

    public func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let (signed, nonce) = try signer.sign(request)
        let (http, lines) = try await inner.open(signed)
        guard (200..<300).contains(http.statusCode) else { throw LocalFailure.http(http.statusCode) }
        guard LocalAuth.isValidResponse(key: signer.key, nonce: nonce, status: http.statusCode, body: Data(),
                                        mac: http.value(forHTTPHeaderField: LocalAuth.headerResponseMAC)) else {
            throw LocalFailure.badResponseMAC
        }
        return lines
    }
}

/// What the local path uses on a phone: requests and streams on sessions of their own (never the cloud's
/// pool, and never over cellular: the Mac is only ever reached on the same network).
public struct LocalSupport: Sendable {
    public let discovery: LocalDiscovery
    public let requests: HTTPTransport
    public let streams: LocalByteStream
    public let now: @Sendable () -> Date

    public init(discovery: LocalDiscovery, requests: HTTPTransport, streams: LocalByteStream, now: @escaping @Sendable () -> Date = Date.init) {
        self.discovery = discovery; self.requests = requests; self.streams = streams; self.now = now
    }

    public static let requestSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.allowsCellularAccess = false
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = LocalHTTPTransport.requestSeconds
        configuration.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: configuration)
    }()

    public static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.allowsCellularAccess = false
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = RealtimeDatabaseClient.stallSeconds
        configuration.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: configuration)
    }()

    /// Bonjour plus the addresses in the Mac's view, on the local sessions.
    public static var standard: LocalSupport {
        LocalSupport(discovery: BonjourDiscovery(), requests: requestSession, streams: streamSession)
    }
}
