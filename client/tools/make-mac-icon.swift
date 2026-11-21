// Builds a macOS icon from a square app artwork (iOS style, borderless): the artwork is fitted
// into the squircle shape of a TEMPLATE and masked with its alpha channel.
//
// Why a template and not a hand-drawn corner: Apple's corner is not a circular arc ("continuous
// corner"), and the margin around the shape is part of the macOS grid. Both are contained exactly
// in the alpha channel of an existing icon — client/build/icon.png itself works (produced by
// tools/icon/build-icons.mjs).
//
// Masking is PER PIXEL (artwork alpha × template alpha), deliberately not
// CGContext.clip(to:mask:) — whose meaning of luminance vs. alpha depends on the image type.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ERROR: \(message)\n".utf8))
    exit(1)
}

func loadPixels(_ path: String) -> (w: Int, h: Int, px: [UInt8]) {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("not readable: \(path)") }
    let w = image.width, h = image.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                             space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { die("no context") }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, px)
}

/// Fit the artwork into a target rectangle and return it as a pixel buffer.
func drawFitted(_ path: String, size: Int, into rect: CGRect) -> [UInt8] {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("not readable: \(path)") }
    var px = [UInt8](repeating: 0, count: size * size * 4)
    guard let ctx = CGContext(data: &px, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                             space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { die("no context") }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: rect)
    return px
}

func writePNG(_ px: [UInt8], size: Int, to path: String) {
    var buffer = px
    guard let ctx = CGContext(data: &buffer, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                             space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { die("could not write: \(path)") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { die("writing failed: \(path)") }
}

let args = CommandLine.arguments
guard args.count == 4 else { die("usage: make-mac-icon <artwork.png> <template-with-mask.png> <target.png>") }
let (mw, mh, maskPx) = loadPixels(args[2])
guard mw == mh else { die("template is not square") }

// Determine the visible area of the template — the space the artwork may occupy.
var minX = mw, minY = mh, maxX = -1, maxY = -1
for y in 0..<mh {
    for x in 0..<mw where maskPx[(y * mw + x) * 4 + 3] > 8 {
        if x < minX { minX = x }; if x > maxX { maxX = x }
        if y < minY { minY = y }; if y > maxY { maxY = y }
    }
}
guard maxX > minX else { die("template has no visible area") }
let side = min(maxX - minX + 1, maxY - minY + 1)
// CoreGraphics draws from the bottom; the y flip does not matter for a symmetric shape.
let target = CGRect(x: CGFloat(minX), y: CGFloat(mh - maxY - 1), width: CGFloat(side), height: CGFloat(side))
print("template \(mw)x\(mh): shape from (\(minX),\(minY)) to (\(maxX),\(maxY)) → edge length \(side), margin \(minX)")

var out = drawFitted(args[1], size: mw, into: target)
// Apply the template's alpha (and attenuate the premultiplied colors accordingly).
for i in stride(from: 0, to: out.count, by: 4) {
    let m = Int(maskPx[i + 3])
    if m == 255 { continue }
    for c in 0..<4 { out[i + c] = UInt8(Int(out[i + c]) * m / 255) }
}
writePNG(out, size: mw, to: args[3])
print("written: \(args[3])")
