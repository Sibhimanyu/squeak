import Foundation

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var timeout: TimeInterval

    public init(method: String = "GET", url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval = 5) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data = Data()) {
        self.status = status
        self.body = body
    }
}

/// Transport failures, split by whether the request could have reached the server.
public enum TransportError: Error, Equatable, Sendable {
    /// Nothing listening / no route: the request was never written.
    case connectionRefused
    /// Timed out: the request may have been written and processed.
    case timedOut
    /// Connection dropped mid-flight: the request may have been processed.
    case connectionLost
    case other(String)
}

public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.waitsForConnectivity = false
            config.urlCache = nil
            self.session = URLSession(configuration: config)
        }
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var r = URLRequest(url: request.url, timeoutInterval: request.timeout)
        r.httpMethod = request.method
        r.httpBody = request.body
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        do {
            let (data, response) = try await session.data(for: r)
            guard let http = response as? HTTPURLResponse else { throw TransportError.other("not an HTTP response") }
            return HTTPResponse(status: http.statusCode, body: data)
        } catch let e as TransportError {
            throw e
        } catch let e as URLError {
            switch e.code {
            case .cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .dnsLookupFailed:
                throw TransportError.connectionRefused
            case .timedOut:
                throw TransportError.timedOut
            case .networkConnectionLost:
                throw TransportError.connectionLost
            default:
                throw TransportError.other(e.localizedDescription)
            }
        }
    }
}
