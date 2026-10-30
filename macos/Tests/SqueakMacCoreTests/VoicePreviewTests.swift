import Foundation
import Testing
@testable import SqueakMacCore

private actor PreviewTransport: HTTPTransport {
    var requests: [HTTPRequest] = []
    var pending: CheckedContinuation<HTTPResponse, Never>?
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return await withCheckedContinuation { pending = $0 }
    }
    func finish(_ status: Int = 200, body: Data = Data()) {
        pending?.resume(returning: HTTPResponse(status: status, body: body))
        pending = nil
    }
    func count() -> Int { requests.count }
    func first() -> HTTPRequest? { requests.first }
}

@Suite @MainActor struct VoicePreviewTests {
    private func waitForRequest(_ transport: PreviewTransport) async {
        for _ in 0..<1000 {
            if await transport.count() > 0 { return }
            await Task.yield()
        }
    }

    @Test func stoppedRequestsCannotPlayOrShowALateError() async {
        let transport = PreviewTransport()
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: transport, tokenProvider: { "test-token" })
        let preview = VoicePreview()
        preview.play(voice: "am_michael", client: client)
        #expect(preview.loading && preview.active)
        await waitForRequest(transport)
        let request = await transport.first()
        #expect(request?.method == "POST")
        #expect(request?.url.path == "/control/voice/preview")
        #expect(request?.headers["x-squeak-token"] == "test-token")
        let body = request?.body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: String]
        #expect(body == ["voice": "am_michael"])
        preview.stop()
        await transport.finish(503)
        for _ in 0..<20 { await Task.yield() }
        #expect(!preview.active && preview.error == nil)
    }

    @Test func failuresEndLoadingAndCanBeCleared() async {
        let transport = PreviewTransport()
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: transport, tokenProvider: { "test-token" })
        let preview = VoicePreview()
        preview.play(voice: "af_heart", client: client)
        await waitForRequest(transport)
        await transport.finish(503)
        for _ in 0..<1000 {
            if preview.error != nil { break }
            await Task.yield()
        }
        #expect(!preview.active && preview.error != nil)
        preview.stop()
        #expect(preview.error == nil)
    }
}
