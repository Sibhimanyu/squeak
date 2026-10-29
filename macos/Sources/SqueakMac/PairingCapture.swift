import AppKit
import SqueakMacCore
import SwiftUI
import Vision

extension CaptureRunner {
    /// Offline-only review of both pairing flows, compact layout and realistic QR density.
    static func runPairingDemo(prefix: String, model: AppModel) async {
        let payload: [String: String] = [
            "host": "Squeak Demo Mac", "hostId": String(repeating: "0", count: 32),
            "publicKey": String(repeating: "A", count: 43), "token": "demo-not-a-real-pairing-secret",
            "relay": "https://demo.invalid", "expires": "2000-01-01T00:00:00Z",
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let url = "squeak://pair?d=\(encoded)"
        var results: [[String: Any]] = []
        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for target in PairTarget.allCases {
                for (layout, width, height) in [("wide", 780.0, 650.0), ("compact", 460.0, 720.0), ("short", 780.0, 560.0), ("minimum", 420.0, 560.0)] {
                    let root = PairSheet(initialTarget: target, previewPairingURL: url)
                        .environment(model).frame(width: width, height: height)
                    let host = NSHostingView(rootView: root)
                    host.frame = NSRect(x: 0, y: 0, width: width, height: height)
                    host.appearance = NSAppearance(named: appearance)
                    let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                    window.contentView = host
                    window.makeKeyAndOrderFront(nil)
                    try? await Task.sleep(for: .milliseconds(300))
                    let path = "\(prefix)-\(target.rawValue)-\(layout)-\(tone).png"
                    write(host, to: path)
                    let request = VNDetectBarcodesRequest()
                    request.symbologies = [.qr]
                    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path))
                    try? handler.perform([request])
                    results.append(["file": path, "decodedExpectedPayload": request.results?.contains { $0.payloadStringValue == target.qrText(pairingURL: url) } == true])
                    window.orderOut(nil)
                }
            }
        }
        // Exercise the actual QR renderer at both common display scales and dense payload lengths.
        for scale in [1.0, 2.0] {
            for length in [32, 320, 600] {
                let text = "squeak://pair?d=" + String(repeating: "a", count: length)
                guard let image = QRCode.image(for: text, points: 336, displayScale: scale),
                      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
                let request = VNDetectBarcodesRequest()
                request.symbologies = [.qr]
                try? VNImageRequestHandler(cgImage: cg).perform([request])
                results.append(["displayScale": scale, "payloadLength": text.count,
                                "decodedExpectedPayload": request.results?.first?.payloadStringValue == text])
            }
        }
        let report = try! JSONSerialization.data(withJSONObject: ["allDecoded": results.allSatisfy { $0["decodedExpectedPayload"] as? Bool == true }, "cases": results], options: [.prettyPrinted, .sortedKeys])
        try? report.write(to: URL(fileURLWithPath: "\(prefix)-qr-validation.json"))
        NSApp.terminate(nil)
    }
}
