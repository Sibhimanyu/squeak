import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import SqueakCore

private final class RecordingHTTP: AccountHTTP, @unchecked Sendable {
    var last: URLRequest?
    let status: Int, body: Data
    init(status: Int, body: String = "{}") { self.status = status; self.body = Data(body.utf8) }
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) { last = request; return (status, body) }
}

final class AvatarTests: XCTestCase {
    func testSquareCropIsCentred() {
        XCTAssertTrue(AvatarImage.squareCrop(width: 400, height: 200) == (100, 0, 200))
        XCTAssertTrue(AvatarImage.squareCrop(width: 200, height: 301) == (0, 50, 200))
        XCTAssertTrue(AvatarImage.squareCrop(width: 64, height: 64) == (0, 0, 64))
    }

    func testQualityStepsDownFromStart() {
        let q = AvatarImage.qualities()
        XCTAssertEqual(q.first, 0.85)
        XCTAssertEqual(q.last, 0.35)
        XCTAssertEqual(q, q.sorted(by: >))
    }

    func testFitTakesFirstUnderTheCap() {
        var tried: [Double] = []
        let d = AvatarImage.fit { q in tried.append(q); return Data(count: q > 0.7 ? 70_000 : 1_000) }
        XCTAssertEqual(d?.count, 1_000)
        XCTAssertEqual(tried, [0.85, 0.75, 0.65])
        XCTAssertNil(AvatarImage.fit { _ in Data(count: 70_000) })
        XCTAssertNil(AvatarImage.fit { _ in nil })
    }

    func testPrepareMakes256SquareJpegUnderCap() throws {
        let ctx = CGContext(data: nil, width: 600, height: 300, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.9, green: 0.4, blue: 0.1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 600, height: 300))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil); CGImageDestinationFinalize(dest)

        let out = try XCTUnwrap(AvatarImage.prepare(data as Data))
        XCTAssertLessThanOrEqual(out.count, AvatarImage.maxBytes)
        XCTAssertEqual(Array(out.prefix(2)), [0xFF, 0xD8])
        let src = CGImageSourceCreateWithData(out as CFData, nil)!
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
        XCTAssertEqual(img.width, 256); XCTAssertEqual(img.height, 256)
        XCTAssertNil(AvatarImage.prepare(Data("not an image".utf8)))
    }

    func testPutSendsTokenAndMapsStatuses() async throws {
        let ok = RecordingHTTP(status: 200, body: #"{"at":1}"#)
        let api = AccountAPI(appURL: "https://a.test", token: "tok", http: ok)
        let r = try await api.putAvatar(Data([1, 2, 3]))
        XCTAssertNil(r)
        XCTAssertEqual(ok.last?.httpMethod, "PUT")
        XCTAssertEqual(ok.last?.value(forHTTPHeaderField: "x-squeak-account"), "tok")
        XCTAssertEqual(ok.last?.url?.absoluteString, "https://a.test/server/squeak_relay/account/avatar")
        let body = try JSONSerialization.jsonObject(with: ok.last!.httpBody!) as? [String: String]
        XCTAssertEqual(body?["type"], "image/jpeg"); XCTAssertEqual(body?["data"], "AQID")

        for (status, sentence) in [(413, AvatarPhase.tooBig), (400, AvatarPhase.badImage), (429, AvatarPhase.busy), (500, AvatarPhase.network)] {
            let a = AccountAPI(appURL: "https://a.test", token: "t", http: RecordingHTTP(status: status))
            let got = try await a.putAvatar(Data([1]))
            XCTAssertEqual(got, sentence)
        }
    }

    func testUnauthorizedThrowsSignedOutAndGetIsNilOn404() async throws {
        let a = AccountAPI(appURL: "https://a.test", token: "t", http: RecordingHTTP(status: 401))
        do { _ = try await a.putAvatar(Data([1])); XCTFail() } catch { XCTAssertEqual(error as? AccountError, .signedOut) }
        do { _ = try await a.avatar(); XCTFail() } catch { XCTAssertEqual(error as? AccountError, .signedOut) }
        let nf = AccountAPI(appURL: "https://a.test", token: "t", http: RecordingHTTP(status: 404))
        let none = try await nf.avatar()
        XCTAssertNil(none)
        let del = RecordingHTTP(status: 204)
        let d = try await AccountAPI(appURL: "https://a.test", token: "t", http: del).deleteAvatar()
        XCTAssertNil(d); XCTAssertEqual(del.last?.httpMethod, "DELETE")
    }
}
