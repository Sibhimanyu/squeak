import Foundation
import XCTest

@testable import SqueakMacCore

func hexData(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

func hexString(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

struct RelayVectors {
    let root: [String: Any]
    static func load() throws -> RelayVectors {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "relay-vectors", withExtension: "json"))
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        return RelayVectors(root: obj)
    }
    func dict(_ k: String) -> [String: Any] { root[k] as! [String: Any] }
}

extension Dictionary where Key == String, Value == Any {
    func s(_ k: String) -> String { self[k] as! String }
    func h(_ k: String) -> Data { hexData(s(k)) }
}

/// Captures frames a PhoneClient sends.
final class CapturingTransport: PhoneTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [RelayJSON] = []
    private(set) var closedReason: String?
    func send(frame: RelayJSON) { lock.withLock { frames.append(frame) } }
    func close(reason: String) { lock.withLock { closedReason = reason } }
    var count: Int { lock.withLock { frames.count } }
    func frame(_ i: Int) -> RelayJSON { lock.withLock { frames[i] } }
    func waitForFrame(_ i: Int) async throws -> RelayJSON {
        for _ in 0..<500 {
            if count > i { return frame(i) }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw RelayError("timed out waiting for frame \(i)")
    }
}

func waitUntil(_ timeout: TimeInterval = 5, _ cond: @Sendable () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return cond()
}
