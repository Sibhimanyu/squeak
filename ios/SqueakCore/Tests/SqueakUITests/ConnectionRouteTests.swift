#if os(iOS)
import XCTest
import SqueakCore
@testable import SqueakUI

final class ConnectionRouteTests: XCTestCase {
    func testSaysHowTheMacIsBeingReached() {
        XCTAssertEqual(Connection.routeText(.local), "Connected · same Wi-Fi")
        XCTAssertEqual(Connection.routeText(.cloud), "Connected · via cloud")
    }
}
#endif
