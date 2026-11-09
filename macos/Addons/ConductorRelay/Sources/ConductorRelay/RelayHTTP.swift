import Foundation

/// A parsed HTTP/1.1 request head (request line + headers), kept in wire order.
struct RelayHTTPHead {
    let method: String
    let target: String
    let version: String
    let headers: [(name: String, value: String)]

    var path: String { String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "") }

    func header(_ name: String) -> String? {
        headers.first { $0.name.lowercased() == name.lowercased() }?.value
    }

    var isWebSocketUpgrade: Bool {
        (header("upgrade") ?? "").lowercased() == "websocket"
    }

    static let terminator = Data("\r\n\r\n".utf8)

    /// Parse the head ending at `end` (exclusive of the blank line).
    static func parse(_ data: Data) -> RelayHTTPHead? {
        let text = String(decoding: data, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard first.count >= 3 else { return nil }
        var headers: [(String, String)] = []
        for l in lines where !l.isEmpty {
            guard let colon = l.firstIndex(of: ":") else { continue }
            let name = String(l[l.startIndex..<colon])
            let value = String(l[l.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            headers.append((name, value))
        }
        return RelayHTTPHead(method: String(first[0]), target: String(first[1]), version: String(first[2]), headers: headers)
    }
}
