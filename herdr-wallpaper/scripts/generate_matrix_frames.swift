#!/usr/bin/env swift
import AppKit
import CoreGraphics
import CoreText
import Foundation

let width = 2560
let height = 1440
let numFrames = 16

let args = CommandLine.arguments
let outDir = args.count > 1 ? args[1] : "assets/matrix-rain-hd"
let baseImagePath = args.count > 2 ? args[2] : "assets/matrix_rain.jpg"

let fileManager = FileManager.default
try fileManager.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let baseImage = NSImage(contentsOfFile: baseImagePath)

// Authentic Matrix glyph repertoire: half-width katakana + digits + hex/math symbols
let glyphChars: [String] = Array("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012345789ABCDEFZ:・.=*+-<>¦｜λΨΔΞ").map { String($0) }

struct StreamColumn {
    let x: CGFloat
    let fontSize: CGFloat
    let cellH: CGFloat
    let numRows: Int
    let dropsPerCol: Int
    let phaseRows: Double
    let tailLengthRows: Double
    let speedSubCycles: Double // integer (1.0 or 2.0) sub-periods per 16 frames
    let brightness: CGFloat
    let layer: Int // 0 = micro-grid, 1 = far, 2 = mid, 3 = near hero
    let seed: UInt64
}

func splitMix64(_ state: inout UInt64) -> UInt64 {
    state &+= 0x9e3779b97f4a7c15
    var z = state
    z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
    z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
    return z ^ (z >> 31)
}

func randDouble(_ state: inout UInt64) -> Double {
    return Double(splitMix64(&state) >> 11) / Double(1 << 53)
}

var rngState: UInt64 = 0x4D41545249585F32 // "MATRIX_2"
var columns: [StreamColumn] = []

// Layer 0: Deep Micro-Grid (8.5pt, 10px spacing, 3 drops per column -> ~256 streams)
let microStep: CGFloat = 10.0
for idx in 0..<Int(CGFloat(width) / microStep) {
    let cellH: CGFloat = 10.0 // 1440 / 10 = 144 rows (divisible by 3 -> 48 rows per drop!)
    let rows = height / Int(cellH)
    let drops = 3
    let subPeriod = Double(rows / drops)
    let phase = randDouble(&rngState) * subPeriod
    let tail = 14.0 + randDouble(&rngState) * 18.0
    let bright = CGFloat(0.18 + randDouble(&rngState) * 0.18)
    columns.append(StreamColumn(
        x: CGFloat(idx) * microStep + 1.0,
        fontSize: 8.5,
        cellH: cellH,
        numRows: rows,
        dropsPerCol: drops,
        phaseRows: phase,
        tailLengthRows: tail,
        speedSubCycles: 1.0,
        brightness: bright,
        layer: 0,
        seed: splitMix64(&rngState)
    ))
}

// Layer 1: Far Dense Rain (11pt, 14px spacing, 2 drops per column -> ~182 streams)
let farStep: CGFloat = 14.0
for idx in 0..<Int(CGFloat(width) / farStep) {
    let cellH: CGFloat = 12.0 // 1440 / 12 = 120 rows (divisible by 2 -> 60 rows per drop!)
    let rows = height / Int(cellH)
    let drops = 2
    let subPeriod = Double(rows / drops)
    let phase = randDouble(&rngState) * subPeriod
    let tail = 16.0 + randDouble(&rngState) * 24.0
    let bright = CGFloat(0.36 + randDouble(&rngState) * 0.26)
    columns.append(StreamColumn(
        x: CGFloat(idx) * farStep + 3.0,
        fontSize: 10.5,
        cellH: cellH,
        numRows: rows,
        dropsPerCol: drops,
        phaseRows: phase,
        tailLengthRows: tail,
        speedSubCycles: 1.0,
        brightness: bright,
        layer: 1,
        seed: splitMix64(&rngState)
    ))
}

// Layer 2: Classic Mid-Ground Crisp Streams (13.5pt, 18px spacing, 2 drops per column -> ~142 streams)
let midStep: CGFloat = 18.0
for idx in 0..<Int(CGFloat(width) / midStep) {
    let cellH: CGFloat = 15.0 // 1440 / 15 = 96 rows (divisible by 2 -> 48 rows per drop!)
    let rows = height / Int(cellH)
    let drops = 2
    let subPeriod = Double(rows / drops)
    let phase = randDouble(&rngState) * subPeriod
    let tail = 14.0 + randDouble(&rngState) * 22.0
    let speed = (idx % 4 == 0) ? 2.0 : 1.0
    let bright = CGFloat(0.68 + randDouble(&rngState) * 0.30)
    columns.append(StreamColumn(
        x: CGFloat(idx) * midStep + 5.0,
        fontSize: 13.0,
        cellH: cellH,
        numRows: rows,
        dropsPerCol: drops,
        phaseRows: phase,
        tailLengthRows: tail,
        speedSubCycles: speed,
        brightness: bright,
        layer: 2,
        seed: splitMix64(&rngState)
    ))
}

// Layer 3: Foreground Hero Streams (16.5pt, 46px spacing, 2 drops per column -> ~55 hero streams)
let nearStep: CGFloat = 46.0
for idx in 0..<Int(CGFloat(width) / nearStep) {
    let cellH: CGFloat = 18.0 // 1440 / 18 = 80 rows (divisible by 2 -> 40 rows per drop!)
    let rows = height / Int(cellH)
    let drops = 2
    let subPeriod = Double(rows / drops)
    let phase = randDouble(&rngState) * subPeriod
    let tail = 14.0 + randDouble(&rngState) * 16.0
    let jitterX = CGFloat(randDouble(&rngState) * 14.0 - 7.0)
    columns.append(StreamColumn(
        x: CGFloat(idx) * nearStep + 12.0 + jitterX,
        fontSize: 16.0,
        cellH: cellH,
        numRows: rows,
        dropsPerCol: drops,
        phaseRows: phase,
        tailLengthRows: tail,
        speedSubCycles: 1.0,
        brightness: 1.0,
        layer: 3,
        seed: splitMix64(&rngState)
    ))
}

// Pre-cache fonts per fontSize
var fontCache: [CGFloat: NSFont] = [:]
for col in columns {
    if fontCache[col.fontSize] == nil {
        fontCache[col.fontSize] = NSFont(name: "HiraginoSans-W6", size: col.fontSize)
            ?? NSFont.monospacedSystemFont(ofSize: col.fontSize, weight: .bold)
    }
}

let colorSpace = CGColorSpaceCreateDeviceRGB()

for frame in 0..<numFrames {
    autoreleasepool {
        let progress = Double(frame) / Double(numFrames) // 0.0 ..< 1.0

        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            fatalError("Failed to create CGContext")
        }

        ctx.setAllowsAntialiasing(true)
        ctx.setShouldAntialias(true)
        ctx.setAllowsFontSmoothing(true)
        ctx.setShouldSmoothFonts(true)

        let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: true)
        NSGraphicsContext.current = nsCtx

        // Flip so y=0 is top, y=height is bottom
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1.0, y: -1.0)

        // 1. Deep obsidian Matrix background (#020604)
        ctx.setFillColor(red: 0.008, green: 0.024, blue: 0.014, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

        // 2. Subtle atmospheric glow from base matrix_rain.jpg (16% opacity)
        if let base = baseImage,
           let cgBase = base.cgImage(forProposedRect: nil, context: nsCtx, hints: nil) {
            ctx.saveGState()
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: 1.0, y: -1.0)
            ctx.setAlpha(0.16)
            ctx.draw(cgBase, in: CGRect(x: 0, y: 0, width: width, height: height))
            ctx.restoreGState()
        }

        // 3. Draw all 4 depth layers of falling Matrix code
        for col in columns {
            let font = fontCache[col.fontSize]!
            let subPeriod = Double(col.numRows / col.dropsPerCol)

            // Head position within [0, subPeriod)
            let headOffset = (col.phaseRows + progress * col.speedSubCycles * subPeriod)
                .truncatingRemainder(dividingBy: subPeriod)

            for r in 0..<col.numRows {
                let rowInSub = Double(r % (col.numRows / col.dropsPerCol))
                var dist = headOffset - rowInSub
                if dist < 0 {
                    dist += subPeriod
                }

                if dist > col.tailLengthRows {
                    continue
                }

                // Deterministic glyph selection per cell, with subtle live mutation near the head
                var glyphSeed = col.seed ^ UInt64(r &* 1315423911)
                if dist < 1.8 || (dist < 5.0 && ((r + frame) % 7 == 0)) {
                    glyphSeed ^= UInt64(frame &* 2654435761)
                }
                let glyphIdx = Int(splitMix64(&glyphSeed) % UInt64(glyphChars.count))
                let glyph = glyphChars[glyphIdx]

                let norm = dist / col.tailLengthRows // 0.0 at head -> 1.0 at tail end
                let fade = pow(1.0 - norm, 1.65) * Double(col.brightness)

                let textColor: NSColor
                var glowBlur: CGFloat = 0.0

                if dist < 0.95 && col.layer >= 1 {
                    // Leading phosphor white-green character (#e4ffed)
                    let headAlpha = min(1.0, Double(col.brightness) * 1.08)
                    textColor = NSColor(
                        calibratedRed: col.layer == 3 ? 0.92 : 0.80,
                        green: 1.0,
                        blue: col.layer == 3 ? 0.95 : 0.86,
                        alpha: CGFloat(headAlpha)
                    )
                    if col.layer >= 2 {
                        glowBlur = col.fontSize * 0.65
                    }
                } else if dist < 3.2 && col.layer >= 1 {
                    // Intense neon Matrix green (#00ff66)
                    textColor = NSColor(
                        calibratedRed: 0.04,
                        green: 1.0,
                        blue: 0.42,
                        alpha: CGFloat(fade)
                    )
                    if col.layer == 3 {
                        glowBlur = col.fontSize * 0.45
                    }
                } else {
                    // Rich emerald gradient trail (#00d455 -> #003b18)
                    let g = CGFloat(0.24 + 0.72 * (1.0 - norm))
                    let b = CGFloat(0.06 + 0.25 * (1.0 - norm))
                    textColor = NSColor(
                        calibratedRed: 0.0,
                        green: g,
                        blue: b,
                        alpha: CGFloat(fade)
                    )
                }

                if glowBlur > 0.0 {
                    ctx.saveGState()
                    ctx.setShadow(
                        offset: .zero,
                        blur: glowBlur,
                        color: CGColor(red: 0.0, green: 1.0, blue: 0.42, alpha: 0.85)
                    )
                }

                let attrs: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: textColor,
                ]
                let attrStr = NSAttributedString(string: glyph, attributes: attrs)
                attrStr.draw(at: NSPoint(x: col.x, y: CGFloat(r) * col.cellH))

                if glowBlur > 0.0 {
                    ctx.restoreGState()
                }
            }
        }

        // 4. Fine Retina CRT scanlines (every 2px, subtle 14% alpha)
        ctx.setFillColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.14)
        for y in stride(from: 0, to: height, by: 2) {
            ctx.fill(CGRect(x: 0, y: y, width: width, height: 1))
        }

        // 5. Soft radial vignette to keep terminal contrast crisp
        let center = CGPoint(x: CGFloat(width) * 0.5, y: CGFloat(height) * 0.5)
        let maxRadius = hypot(CGFloat(width) * 0.55, CGFloat(height) * 0.55)
        if let gradient = CGGradient(
            colorsSpace: colorSpace,
            colors: [
                CGColor(red: 0, green: 0, blue: 0, alpha: 0.0),
                CGColor(red: 0, green: 0.02, blue: 0.01, alpha: 0.42),
            ] as CFArray,
            locations: [0.45, 1.0]
        ) {
            ctx.drawRadialGradient(
                gradient,
                startCenter: center,
                startRadius: 0,
                endCenter: center,
                endRadius: maxRadius,
                options: [.drawsAfterEndLocation]
            )
        }

        guard let outCgImage = ctx.makeImage() else {
            fatalError("Failed to make CGImage for frame \(frame)")
        }
        let bitmapRep = NSBitmapImageRep(cgImage: outCgImage)
        guard let jpegData = bitmapRep.representation(
            using: .jpeg,
            properties: [.compressionFactor: 0.92]
        ) else {
            fatalError("Failed to encode JPEG for frame \(frame)")
        }

        let fileName = String(format: "frame_%02d.jpg", frame)
        let fileURL = URL(fileURLWithPath: outDir).appendingPathComponent(fileName)
        try! jpegData.write(to: fileURL)
    }
}

print("Generated \(numFrames) 2K Retina high-density Matrix rain frames in \(outDir)")
