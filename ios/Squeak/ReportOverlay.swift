import Combine
import Heresay
import SwiftUI
import UIKit

/// Opens Heresay's report sheet above whatever is on screen. An error often shows inside a sheet (new chat,
/// pairing, settings pages), and iOS will not present the report from the root while that sheet is up, so the
/// report gets a window of its own for as long as it is open. While it is, the root lets go of `.heresay()`, so
/// exactly one view ever presents the sheet.
@MainActor
final class ReportOverlay: ObservableObject {
    static let shared = ReportOverlay()

    @Published private(set) var active = false
    private var window: UIWindow?
    private var watch: AnyCancellable?

    func present(type: ReportType? = nil, text: String? = nil) {
        guard window == nil else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else {
            Heresay.present(type: type, text: text)
            return
        }
        active = true
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: Color.clear.ignoresSafeArea().heresay())
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
        // Close the window once the sheet has opened and gone again.
        watch = Heresay.shared.$isPresented.drop(while: { !$0 }).filter { !$0 }.first()
            .sink { [weak self] _ in self?.close() }
        DispatchQueue.main.async { Heresay.present(type: type, text: text) }
        // Reports off (or the sheet refused): never leave an invisible window over the app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            if !Heresay.shared.isPresented { self?.close() }
        }
    }

    private func close() {
        watch = nil
        window?.isHidden = true
        window = nil
        active = false
    }
}
