import AppKit
import SqueakMacCore
import WebKit

/// The sign-in page in a sheet over the window the person clicked from. It stays inside Squeak: no browser, no other Space.
/// Google refuses embedded web views, so a navigation to Google ends the sheet with `.useBrowser` and the caller runs the
/// same sign-in in the system browser session instead.
@MainActor
final class SignInSheet: NSObject, WKNavigationDelegate, WKUIDelegate {
    enum End { case callback(URL), cancelled, useBrowser, failed }

    private var window: NSWindow?
    private weak var parent: NSWindow?
    private var onEnd: ((End) -> Void)?
    private var webView: WKWebView?

    /// Shows the sheet over `parent`. `onEnd` runs once.
    func present(url: URL, over parent: NSWindow, onEnd: @escaping (End) -> Void) {
        self.parent = parent
        self.onEnd = onEnd
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        webView = web

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelTapped))
        cancel.keyEquivalent = "\u{1b}"
        let browser = NSButton(title: "Use my browser instead", target: self, action: #selector(browserTapped))
        browser.bezelStyle = .inline
        let bar = NSStackView(views: [browser, NSView(), cancel])
        bar.orientation = .horizontal
        bar.edgeInsets = NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        bar.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 640))
        content.addSubview(web); content.addSubview(bar)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: bar.topAnchor),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        let w = NSWindow(contentRect: content.frame, styleMask: [.titled], backing: .buffered, defer: false)
        w.contentView = content
        window = w
        parent.beginSheet(w, completionHandler: nil)
        web.load(URLRequest(url: url))
    }

    /// Closes the sheet without calling `onEnd` (the caller already knows).
    func dismiss() { onEnd = nil; close() }

    private func close() {
        webView?.navigationDelegate = nil; webView?.uiDelegate = nil
        webView?.stopLoading()
        if let w = window { parent?.endSheet(w); w.orderOut(nil) }
        window = nil; webView = nil
    }

    private func end(_ e: End) {
        let f = onEnd; onEnd = nil
        close()
        f?(e)
    }

    @objc private func cancelTapped() { end(.cancelled) }
    @objc private func browserTapped() { end(.useBrowser) }

    /// What a navigation means for the sheet; nil = let the page go on.
    private func verdict(for url: URL?) -> End? {
        guard let url else { return nil }
        if url.scheme == AccountSignIn.callbackScheme { return .callback(url) }
        if AccountSignIn.needsSystemBrowser(url) { return .useBrowser }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if let e = verdict(for: action.request.url) { end(e); return .cancel }
        return .allow
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // A popup (a provider's own window) loads in the sheet instead, so nothing opens outside Squeak.
        if let e = verdict(for: action.request.url) { end(e) }
        else if action.request.url != nil { webView.load(action.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failIfReal(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failIfReal(error) }
    private func failIfReal(_ error: Error) {
        let c = (error as NSError).code
        if c == NSURLErrorCancelled || (error as NSError).domain == "WebKitErrorDomain" { return }   // our own .cancel
        end(.failed)
    }
}
