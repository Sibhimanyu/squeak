#if os(iOS)
import SqueakCore
import UIKit

extension LogoFit {
    /// The fit of a decoded icon: its pixels as RGBA, through `LogoFit.compute`.
    static func of(_ image: UIImage) -> LogoFit {
        guard let cg = image.cgImage, cg.width > 0, cg.height > 0 else { return .unchanged }
        let w = cg.width, h = cg.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        let drawn = bytes.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w * 4, space: space, bitmapInfo: info) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return drawn ? compute(rgba: bytes, width: w, height: h) : .unchanged
    }
}
#endif
