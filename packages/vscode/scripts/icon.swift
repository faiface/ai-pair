// Draws the extension's icon, the agent's cursor and label as they look in the editor, typing
// inside a pair of parens, and writes it as media/icon.svg and a 256×256 media/icon.png.
//
// Run from packages/vscode: swift scripts/icon.swift

import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// In a 128×128 box, y down, like the SVG.
struct Box { let x, y, w, h, r: CGFloat; let fill: String }
struct Text { let text: String; let x, baseline, size: CGFloat; let bold, centered: Bool; let fill: String }

let tile = Box(x: 0, y: 0, w: 128, h: 128, r: 28, fill: "#1F1F1F")
let label = Box(x: 38, y: 20, w: 76, h: 31, r: 7, fill: "#E8875B")
let cursor = Box(x: 38, y: 60, w: 8, h: 45, r: 2, fill: "#E8875B")
let texts = [
  Text(text: "Agent", x: 76, baseline: 42.5, size: 20, bold: true, centered: true, fill: "#1B1B1B"),
  Text(text: "(", x: 10, baseline: 98, size: 46, bold: false, centered: false, fill: "#FFD700"),
  Text(text: ")", x: 42, baseline: 98, size: 46, bold: false, centered: false, fill: "#FFD700"),
  Text(text: ";", x: 69, baseline: 98, size: 46, bold: false, centered: false, fill: "#CCCCCC"),
]
// The code goes under the label and cursor.
let boxesUnder = [tile]
let boxesOver = [label, cursor]

func color(_ hex: String) -> CGColor {
  let v = Int(hex.dropFirst(), radix: 16)!
  return CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

func line(_ t: Text) -> CTLine {
  let font = CTFontCreateWithName((t.bold ? "Menlo-Bold" : "Menlo-Regular") as CFString, t.size, nil)
  let attributes: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font, .init(kCTForegroundColorAttributeName as String): color(t.fill)]
  return CTLineCreateWithAttributedString(NSAttributedString(string: t.text, attributes: attributes))
}

func startX(_ t: Text) -> CGFloat {
  t.centered ? t.x - CGFloat(CTLineGetTypographicBounds(line(t), nil, nil, nil)) / 2 : t.x
}

// PNG
let size = 256
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: CGFloat(size) / 128, y: -CGFloat(size) / 128)
func draw(_ b: Box) {
  ctx.addPath(CGPath(roundedRect: CGRect(x: b.x, y: b.y, width: b.w, height: b.h), cornerWidth: b.r, cornerHeight: b.r, transform: nil))
  ctx.setFillColor(color(b.fill))
  ctx.fillPath()
}
boxesUnder.forEach(draw)
ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
for t in texts where !t.centered {
  ctx.textPosition = CGPoint(x: startX(t), y: t.baseline)
  CTLineDraw(line(t), ctx)
}
boxesOver.forEach(draw)
for t in texts where t.centered {
  ctx.textPosition = CGPoint(x: startX(t), y: t.baseline)
  CTLineDraw(line(t), ctx)
}
let png = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "media/icon.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(png, ctx.makeImage()!, nil)
precondition(CGImageDestinationFinalize(png), "Couldn't write media/icon.png")

// SVG, with live text, for editing
func n(_ v: CGFloat) -> String { String(format: "%g", (v * 100).rounded() / 100) }
func svg(_ b: Box) -> String {
  #"  <rect x="\#(n(b.x))" y="\#(n(b.y))" width="\#(n(b.w))" height="\#(n(b.h))" rx="\#(n(b.r))" fill="\#(b.fill)"/>"#
}
func svg(_ t: Text) -> String {
  let weight = t.bold ? #" font-weight="bold""# : ""
  return #"  <text x="\#(n(startX(t)))" y="\#(n(t.baseline))" font-family="Menlo, 'DejaVu Sans Mono', monospace" font-size="\#(n(t.size))"\#(weight) fill="\#(t.fill)">\#(t.text)</text>"#
}
let body = boxesUnder.map(svg) + texts.filter { !$0.centered }.map(svg) + boxesOver.map(svg) + texts.filter { $0.centered }.map(svg)
let document = (["<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\">"] + body + ["</svg>", ""]).joined(separator: "\n")
try! document.write(toFile: "media/icon.svg", atomically: true, encoding: .utf8)
print("Wrote media/icon.png and media/icon.svg")
