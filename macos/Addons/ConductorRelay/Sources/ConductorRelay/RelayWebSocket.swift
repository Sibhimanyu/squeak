import CryptoKit
import Foundation
import Network

/// Minimal RFC 6455 for text frames, ported from `ws.ts`. It is hand-rolled over
/// `NWConnection` rather than `NWProtocolWebSocket` because the relay shares one
/// port with plain HTTP (`/auth/exchange`, the upstream proxy) and must route on
/// the request path; `NWProtocolWebSocket` insists on owning the whole listener
/// and never exposes the path.
enum RelayWS {
    static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    static func acceptKey(_ secWebSocketKey: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((secWebSocketKey + guid).utf8))).base64EncodedString()
    }

    /// Encode one unmasked server frame, or a masked one when `mask` is given (clients).
    static func encode(opcode: UInt8, payload: Data, mask: [UInt8]? = nil) -> Data {
        var out = Data([0x80 | opcode])
        let maskBit: UInt8 = mask == nil ? 0 : 0x80
        let len = payload.count
        if len < 126 {
            out.append(maskBit | UInt8(len))
        } else if len < 65536 {
            out.append(maskBit | 126)
            out.append(contentsOf: [UInt8(len >> 8), UInt8(len & 0xff)])
        } else {
            out.append(maskBit | 127)
            for i in 0..<8 { out.append(UInt8((UInt64(len) >> UInt64(8 * (7 - i))) & 0xff)) }
        }
        if let mask {
            out.append(contentsOf: mask)
            for (i, b) in payload.enumerated() { out.append(b ^ mask[i & 3]) }
        } else {
            out.append(payload)
        }
        return out
    }

    enum Event: Equatable {
        case text(String)
        case close(code: Int, reason: String)
        case ping(Data)
    }

    /// Incremental frame parser: handles masking, fragmentation and control frames.
    struct Parser {
        private var buffer = Data()
        private var fragmentOpcode: UInt8 = 0
        private var fragments = Data()
        /// Upper bound on one message so a hostile peer cannot exhaust memory.
        static let maxMessage = 16 * 1024 * 1024

        mutating func feed(_ chunk: Data) -> [Event] {
            buffer.append(chunk)
            var events: [Event] = []
            while true {
                guard buffer.count >= 2 else { break }
                let b = Array(buffer.prefix(14))
                let fin = (b[0] & 0x80) != 0
                let opcode = b[0] & 0x0f
                let masked = (b[1] & 0x80) != 0
                var len = Int(b[1] & 0x7f)
                var offset = 2
                if len == 126 {
                    guard b.count >= 4 else { break }
                    len = Int(b[2]) << 8 | Int(b[3])
                    offset = 4
                } else if len == 127 {
                    guard b.count >= 10 else { break }
                    var l: UInt64 = 0
                    for i in 0..<8 { l = (l << 8) | UInt64(b[2 + i]) }
                    guard l <= UInt64(Parser.maxMessage) else {
                        buffer.removeAll()
                        events.append(.close(code: 1009, reason: "too big"))
                        break
                    }
                    len = Int(l)
                    offset = 10
                }
                var mask: [UInt8]?
                if masked {
                    guard buffer.count >= offset + 4 else { break }
                    mask = Array(buffer[buffer.startIndex + offset..<buffer.startIndex + offset + 4])
                    offset += 4
                }
                guard buffer.count >= offset + len else { break }
                var payload = Data(buffer[buffer.startIndex + offset..<buffer.startIndex + offset + len])
                if let mask { for i in 0..<payload.count { payload[payload.startIndex + i] ^= mask[i & 3] } }
                buffer = Data(buffer.dropFirst(offset + len))

                if opcode == 0x0 {
                    fragments.append(payload)
                    if fin {
                        deliver(fragmentOpcode, fragments, &events)
                        fragments = Data()
                        fragmentOpcode = 0
                    }
                } else if opcode == 0x1 || opcode == 0x2 {
                    if fin {
                        deliver(opcode, payload, &events)
                    } else {
                        fragmentOpcode = opcode
                        fragments = payload
                    }
                } else {
                    deliver(opcode, payload, &events)
                }
            }
            return events
        }

        private func deliver(_ opcode: UInt8, _ payload: Data, _ events: inout [Event]) {
            switch opcode {
            case 0x1: events.append(.text(String(decoding: payload, as: UTF8.self)))
            case 0x8:
                let code = payload.count >= 2 ? Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]) : 1005
                let reason = payload.count > 2 ? String(decoding: payload.dropFirst(2), as: UTF8.self) : ""
                events.append(.close(code: code, reason: reason))
            case 0x9: events.append(.ping(payload))
            default: break  // pong, binary: ignored
            }
        }
    }
}

/// A server-side WebSocket over an already-upgraded `NWConnection`.
final class RelayWebSocketConnection: @unchecked Sendable {
    private let conn: NWConnection
    private let lock = NSLock()
    private var parser = RelayWS.Parser()
    private var textHandlers: [@Sendable (String) -> Void] = []
    private var closeHandlers: [@Sendable (Int, String) -> Void] = []
    private var closed = false

    init(connection: NWConnection, initial: Data) {
        self.conn = connection
        pendingInitial = initial
    }

    private var pendingInitial: Data

    func onText(_ cb: @escaping @Sendable (String) -> Void) {
        lock.lock(); textHandlers.append(cb); lock.unlock()
    }

    func onClose(_ cb: @escaping @Sendable (Int, String) -> Void) {
        lock.lock(); closeHandlers.append(cb); lock.unlock()
    }

    /// Begin reading. Call after handlers are registered.
    func start() {
        let initial = pendingInitial
        pendingInitial = Data()
        if !initial.isEmpty { process(initial) }
        receive()
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let data, !data.isEmpty { process(data) }
            if error != nil {
                emitClose(1006, "socket error")
            } else if isComplete {
                emitClose(1006, "socket closed")
            } else if !isClosed {
                receive()
            }
        }
    }

    private var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed
    }

    private func process(_ data: Data) {
        lock.lock()
        let events = parser.feed(data)
        lock.unlock()
        for e in events {
            switch e {
            case .text(let t):
                lock.lock(); let hs = textHandlers; lock.unlock()
                for h in hs { h(t) }
            case .close(let code, let reason):
                let c = conn
                sendFrame(0x8, Data(code >= 1000 && code != 1005 ? [UInt8(code >> 8), UInt8(code & 0xff)] : [])) {
                    c.cancel()
                }
                emitClose(code, reason)
            case .ping(let p):
                sendFrame(0xa, p)
            }
        }
    }

    private func emitClose(_ code: Int, _ reason: String) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let hs = closeHandlers
        lock.unlock()
        for h in hs { h(code, reason) }
    }

    private func sendFrame(_ opcode: UInt8, _ payload: Data, completion: (@Sendable () -> Void)? = nil) {
        lock.lock()
        let skip = closed && opcode != 0x8 && opcode != 0xa
        lock.unlock()
        if skip { completion?(); return }
        conn.send(content: RelayWS.encode(opcode: opcode, payload: payload), completion: .contentProcessed { _ in completion?() })
    }

    func sendText(_ text: String) {
        sendFrame(0x1, Data(text.utf8))
    }

    func close(code: Int = 1000, reason: String = "") {
        var payload = Data([UInt8(code >> 8), UInt8(code & 0xff)])
        payload.append(Data(reason.utf8))
        let c = conn
        sendFrame(0x8, payload) { c.cancel() }
        emitClose(code, reason)
    }
}
