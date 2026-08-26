import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift generate-icon.swift <output.iconset>\n", stderr)
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

let variants: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

func renderIcon(pixels: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bitmapFormat: [],
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw CocoaError(.fileWriteUnknown)
    }

    bitmap.size = NSSize(width: 256, height: 256)
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw CocoaError(.fileWriteUnknown)
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.shouldAntialias = true

    NSColor(calibratedRed: 0.93, green: 0.96, blue: 1.0, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 22, y: 22, width: 212, height: 212), xRadius: 46, yRadius: 46).fill()

    NSColor(calibratedRed: 0.15, green: 0.39, blue: 0.92, alpha: 1).setFill()
    for (x, height) in [(79.0, 52.0), (118.0, 102.0), (157.0, 74.0)] {
        NSBezierPath(roundedRect: NSRect(x: x, y: 70, width: 20, height: height), xRadius: 10, yRadius: 10).fill()
    }

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return png
}

for variant in variants {
    try renderIcon(pixels: variant.pixels).write(
        to: outputDirectory.appendingPathComponent(variant.name),
        options: .atomic
    )
}
