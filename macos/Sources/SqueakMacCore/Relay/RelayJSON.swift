import Foundation

/// A JSON value that keeps object key order, so the plaintext of an encrypted
/// record is byte-identical to what `JSON.stringify` produces on the Node side
/// (the AEAD ciphertext depends on every byte).
public indirect enum RelayJSON: Equatable, Sendable {
    public struct Member: Equatable, Sendable {
        public let key: String
        public let value: RelayJSON
        public init(_ key: String, _ value: RelayJSON) {
            self.key = key
            self.value = value
        }
    }

    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([RelayJSON])
    case object([Member])

    public static func obj(_ members: KeyValuePairs<String, RelayJSON>) -> RelayJSON {
        .object(members.map { Member($0.key, $0.value) })
    }

    public subscript(key: String) -> RelayJSON? {
        guard case .object(let members) = self else { return nil }
        return members.first { $0.key == key }?.value
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .int(let i): return Int(i)
        case .double(let d): return d == d.rounded() ? Int(d) : nil
        default: return nil
        }
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// Compact serialization matching `JSON.stringify` for the shapes used here.
    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d):
            if d == d.rounded(), abs(d) < 1e15 { out += String(Int64(d)) } else { out += "\(d)" }
        case .string(let s): RelayJSON.writeString(s, to: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                v.write(to: &out)
            }
            out += "]"
        case .object(let members):
            out += "{"
            for (i, m) in members.enumerated() {
                if i > 0 { out += "," }
                RelayJSON.writeString(m.key, to: &out)
                out += ":"
                m.value.write(to: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{8}": out += "\\b"
            case "\u{c}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }

    public static func parse(_ text: String) -> RelayJSON? {
        parse(Data(text.utf8))
    }

    /// Order-preserving parser (JSONSerialization loses key order).
    public static func parse(_ data: Data) -> RelayJSON? {
        var p = Parser(bytes: Array(data))
        p.skipWS()
        guard let v = p.value() else { return nil }
        p.skipWS()
        return p.i == p.bytes.count ? v : nil
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func skipWS() {
            while i < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[i]) { i += 1 }
        }

        mutating func lit(_ s: String) -> Bool {
            let u = Array(s.utf8)
            guard i + u.count <= bytes.count, Array(bytes[i..<i + u.count]) == u else { return false }
            i += u.count
            return true
        }

        mutating func value() -> RelayJSON? {
            guard i < bytes.count else { return nil }
            switch bytes[i] {
            case UInt8(ascii: "{"):
                i += 1
                var members: [Member] = []
                skipWS()
                if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(members) }
                while true {
                    skipWS()
                    guard let k = string() else { return nil }
                    skipWS()
                    guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { return nil }
                    i += 1
                    skipWS()
                    guard let v = value() else { return nil }
                    members.append(Member(k, v))
                    skipWS()
                    guard i < bytes.count else { return nil }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(members) }
                    return nil
                }
            case UInt8(ascii: "["):
                i += 1
                var items: [RelayJSON] = []
                skipWS()
                if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
                while true {
                    skipWS()
                    guard let v = value() else { return nil }
                    items.append(v)
                    skipWS()
                    guard i < bytes.count else { return nil }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(items) }
                    return nil
                }
            case UInt8(ascii: "\""): return string().map { .string($0) }
            case UInt8(ascii: "t"): return lit("true") ? .bool(true) : nil
            case UInt8(ascii: "f"): return lit("false") ? .bool(false) : nil
            case UInt8(ascii: "n"): return lit("null") ? .null : nil
            default: return number()
            }
        }

        mutating func number() -> RelayJSON? {
            let start = i
            var isFloat = false
            while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) {
                if ".eE".utf8.contains(bytes[i]) { isFloat = true }
                i += 1
            }
            guard i > start, let text = String(bytes: bytes[start..<i], encoding: .utf8) else { return nil }
            if !isFloat, let n = Int64(text) { return .int(n) }
            return Double(text).map { .double($0) }
        }

        mutating func hex4() -> UInt32? {
            guard i + 4 <= bytes.count, let t = String(bytes: bytes[i..<i + 4], encoding: .utf8),
                let v = UInt32(t, radix: 16) else { return nil }
            i += 4
            return v
        }

        mutating func string() -> String? {
            guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { return nil }
            i += 1
            var out = [UInt8]()
            var scalars = String.UnicodeScalarView()
            func flush(_ out: inout [UInt8], _ scalars: inout String.UnicodeScalarView) {
                if !out.isEmpty { scalars.append(contentsOf: String(decoding: out, as: UTF8.self).unicodeScalars); out.removeAll() }
            }
            while i < bytes.count {
                let b = bytes[i]
                i += 1
                if b == UInt8(ascii: "\"") {
                    flush(&out, &scalars)
                    return String(scalars)
                }
                if b != UInt8(ascii: "\\") { out.append(b); continue }
                guard i < bytes.count else { return nil }
                let e = bytes[i]
                i += 1
                flush(&out, &scalars)
                switch e {
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "b"): scalars.append("\u{8}")
                case UInt8(ascii: "f"): scalars.append("\u{c}")
                case UInt8(ascii: "u"):
                    guard var cp = hex4() else { return nil }
                    if (0xD800..<0xDC00).contains(cp), i + 1 < bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                        i += 2
                        guard let lo = hex4(), (0xDC00..<0xE000).contains(lo) else { return nil }
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
                    }
                    scalars.append(Unicode.Scalar(cp) ?? "\u{FFFD}")
                default: scalars.append(Unicode.Scalar(e))  // " \\ /
                }
            }
            return nil
        }
    }
}

extension RelayJSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}
