#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI
import VisionKit

/// The unpaired first screen: one job (scan the code on the Mac), and the failures that send you back to it.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    @State private var pasted = ""
    @State private var working = false
    @State private var showPaste = false

    private var screen: PairingScreen { .resolve(awaiting: nil, approvedMac: nil, failure: model.pairingFailure) }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                PairingDuck(mood: screen.mood).padding(.top, 36)
                VStack(spacing: 8) {
                    Text(screen.title).font(.title2.bold()).multilineTextAlignment(.center)
                    Text(screen.detail).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                }
                .id(screen)
                .transition(.opacity)
                if case .failed = screen {
                    Button(PairingScreen.tryAgain) { model.clearPairingFailure() }
                        .buttonStyle(PrimaryButtonStyle())
                } else {
                    scanSection
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .animation(.easeOut(duration: 0.2), value: screen)
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .sheet(isPresented: $scanning) {
            QRScanner { code in
                scanning = false
                Task { await pair(code) }
            }
            .ignoresSafeArea()
        }
    }

    /// The camera is asked for only when Scan is pressed (the scanner sheet starts it), with its reason beside the button.
    private var scanSection: some View {
        VStack(spacing: 14) {
            Button(DataScannerViewController.isSupported ? "Scan" : "Camera not available") {
                model.clearPairingFailure()
                scanning = true
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!DataScannerViewController.isSupported || working)
            Text(PairingScreen.cameraReason).font(.footnote).foregroundStyle(Theme.subtle).multilineTextAlignment(.center)

            Button {
                showPaste.toggle()
            } label: {
                HStack(spacing: 6) {
                    Lucide(.link, size: 14, color: Theme.muted)
                    Text(PairingScreen.pasteLabel)
                }
                .font(.subheadline).foregroundStyle(Theme.muted).frame(minHeight: 44)
            }
            if showPaste {
                VStack(spacing: 8) {
                    TextField("squeak://pair?d=\u{2026}", text: $pasted, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(10).background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
                    Button("Pair") { Task { await pair(pasted) } }
                        .disabled(pasted.isEmpty || working).frame(minHeight: 44)
                }
                .transition(.opacity)
            }

            if let url = URL(string: PairingScreen.downloadURL) {
                Link(destination: url) {
                    HStack(spacing: 6) {
                        Text(PairingScreen.noMacLabel)
                        Lucide(.externalLink, size: 13, color: Theme.muted)
                    }
                    .font(.footnote).foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: showPaste)
    }

    private func pair(_ text: String) async {
        working = true
        await model.pair(with: text)
        working = false
    }
}

/// Waiting for the Mac, or the wait that ran out.
struct AwaitingApprovalView: View {
    @Environment(AppModel.self) private var model
    let code: String
    let mac: String
    @State private var shownAt = Date()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let waited = context.date.timeIntervalSince(model.pairingAskedAt ?? shownAt)
            let screen = PairingScreen.resolve(awaiting: (mac, code), approvedMac: nil, failure: nil, waited: waited)
            ScrollView {
                VStack(spacing: 20) {
                    PairingDuck(mood: screen.mood).padding(.top, 36)
                    VStack(spacing: 8) {
                        Text(screen.title).font(.title2.bold()).multilineTextAlignment(.center)
                        Text(screen.detail).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    }
                    if case .waiting = screen {
                        MacPromptPreview(mac: mac, code: code)
                        if let problem = model.problem { Text(problem).font(.footnote) }
                        Button("Cancel") { model.unpair() }.foregroundStyle(Theme.muted).frame(minHeight: 44)
                    } else {
                        Button(PairingScreen.tryAgain) { model.unpair() }.buttonStyle(PrimaryButtonStyle())
                    }
                }
                .padding(24)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .animation(.easeOut(duration: 0.2), value: screen)
        }
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
    }
}

/// Approved: the duck celebrates for a moment, then the app opens.
struct PairingCelebrationView: View {
    @Environment(AppModel.self) private var model
    let mac: String

    var body: some View {
        let screen = PairingScreen.approved(mac: mac)
        VStack(spacing: 20) {
            Spacer()
            PairingDuck(mood: screen.mood)
            Text(screen.title).font(.title2.bold())
            Text(screen.detail).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .accessibilityElement(children: .combine)
        .task {
            try? await Task.sleep(for: .seconds(PairingScreen.celebrationTime))
            model.endPairingCelebration()
        }
    }
}

/// The one duck on the screen, its sprite and motion following the mood (DESIGN.md 6.3, 7).
/// Under Reduce Motion the sprite swaps with a fade and nothing moves.
struct PairingDuck: View {
    let mood: PairingMood
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    private var sprite: String { mood == .idle ? "squeak-duck-full" : "duck-\(mood.rawValue)" }
    private var period: Double {
        switch mood {
        case .idle: return 3.4
        case .working: return 1.1
        case .celebrating: return 0.55
        case .needsYou: return 0.6
        }
    }

    private var bob: CGFloat {
        switch mood {
        case .idle: return on ? -3 : 3
        case .working: return on ? -3 : 1
        case .celebrating: return on ? -14 : 0
        case .needsYou: return 0
        }
    }

    var body: some View {
        Image(sprite, bundle: .module)
            .resizable().scaledToFit().frame(width: 128, height: 128)
            .offset(y: reduceMotion ? 0 : bob)
            .rotationEffect(.degrees(reduceMotion || mood != .needsYou ? 0 : (on ? 5 : -5)))
            .id(mood)
            .transition(.opacity)
            .animation(.easeOut(duration: 0.2), value: mood)
            .onAppear { start() }
            .accessibilityHidden(true)
            .frame(height: 136)
    }

    private func start() {
        guard !reduceMotion else { return }
        let curve: Animation = mood == .celebrating
            ? .spring(response: period / 2, dampingFraction: 0.5)
            : .easeInOut(duration: period / 2)
        withAnimation(curve.repeatForever(autoreverses: true)) { on = true }
    }
}

/// A small, still copy of the prompt the Mac shows, built from the app's own colours and button look.
struct MacPromptPreview: View {
    let mac: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Lucide(.monitor, size: 16, color: Theme.muted)
                Text("Squeak on \(mac)").font(.footnote).foregroundStyle(Theme.muted)
            }
            Text(PairingScreen.macPromptTitle).font(.headline)
            Text(PairingScreen.macPromptLine).font(.footnote).foregroundStyle(Theme.muted)
            Text("\(code.prefix(3)) \(code.suffix(3))")
                .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit()).tracking(4)
            HStack(spacing: 8) {
                Text("Not now").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
                Text("Approve").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.primaryText)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(Theme.primaryFill, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("On your Mac you will see: \(PairingScreen.macPromptTitle) with the code \(code.map(String.init).joined(separator: " ")), and Approve or Not now.")
    }
}

/// VisionKit's live QR scanner, stopping at the first Squeak code it sees.
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case let .barcode(code) in items {
                if let value = code.payloadStringValue, value.hasPrefix("squeak://pair"), !done {
                    done = true
                    scanner.stopScanning()
                    onCode(value)
                }
            }
        }
    }
}
#endif
