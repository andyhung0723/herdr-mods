#!/usr/bin/env swift
import AppKit
import CoreGraphics
import CoreText
import Foundation

let width = 1408
let height = 792
let numFrames = 16

let args = CommandLine.arguments
let outDir = args.count > 1 ? args[1] : "assets/matrix-rain"
let baseImagePath = args.count > 2 ? args[2] : "assets/matrix_rain.jpg"

let fileManager = FileManager.default
try fileManager.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let baseImage = NSImage(contentsOfFile: baseImagePath)

// Matrix glyph repertoire: half-width katakana + digits + hex/symbols
let glyphChars: [String] = Array("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012345789ABCDEFZ:・.=*+-<>¦｜").map { String($0) }

struct StreamColumn {
    let x: CGFloat
    let fontSize: CGFloat
    let cellH: CGFloat
    let numRows: Int
    let phaseRows: Double
    let tailLengthRows: Double
    let speedCycles: Double // 1.0 or 2.0 cycles per 16 frames
    let brightness: CGFloat
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

var rngState: UInt64 = 0x4D41545249585F31 // "MATRIX_1"
var columns: [StreamColumn] = []

// 1. Far background streams (dense, subtle emerald)
let farStep: CGFloat = 16.0
for idx in 0..<Int(CGFloat(width) / farStep) {
    let cellH: CGFloat = 14.0
    let rows = Int(ceil(CGFloat(height) / cellH))
    let phase = randDouble(&rngState) * Double(rows)
    let tail = 8.0 + randDouble(&rngState) * 14.0
    let bright = CGFloat(0.28 + randDouble(&rngState) * 0.22)
    columns.append(StreamColumn(
        x: CGFloat(idx) * farStep + 2.0,
        fontSize: 12.0,
        cellH: cellH,
        numRows: rows,
        phaseRows: phase,
        tailLengthRows: tail,
        speedCycles: 1.0,
        brightness: bright,
        seed: splitMix64(&rngState)
    ))
}

// 2. Mid-ground classic Matrix streams (crisp phosphor green)
let midStep: CGFloat = 22.0
for idx in 0..<Int(CGFloat(width) / midStep) {
    let cellH: CGFloat = 18.0 // 792 / 18 = 44 exact rows!
    let rows = height / Int(cellH)
    let phase = randDouble(&rngState) * Double(rows)
    let tail = 10.0 + randDouble(&rngState) * 18.0
    let speed = (idx % 3 == 0) ? 2.0 : 1.0
    let bright = CGFloat(0.65 + randDouble(&rngState) * 0.35)
    columns.append(StreamColumn(
        x: CGFloat(idx) * midStep + 4.0,
        fontSize: 15.5,
        cellH: cellH,
        numRows: rows,
        phaseRows: phase,
        tailLengthRows: tail,
        speedCycles: speed,
        brightness: bright,
        seed: splitMix64(&rngState)
    ))
}

// 3. Foreground hero streams (bright glowing white-green heads)
let nearStep: CGFloat = 64.0
for idx in 0..<Int(CGFloat(width) / nearStep) {
    let cellH: CGFloat = 22.0 // 792 / 22 = 36 exact rows!
    let rows = height / Int(cellH)
    let phase = randDouble(&rngState) * Double(rows)
    let tail = 9.0 + randDouble(&rngState) * 12.0
    let jitterX = CGFloat(randDouble(&rngState) * 20.0 - 10.0)
    columns.append(StreamColumn(
        x: CGFloat(idx) * nearStep + 18.0 + jitterX,
        fontSize: 19.5,
        cellH: cellH,
        numRows: rows,
        phaseRows: phase,
        tailLengthRows: tail,
        speedCycles: 1.0,
        brightness: 1.0,
        seed: splitMix64(&rngState)
    ))
}

let colorSpace = CGColorSpaceCreateDeviceRGB()

for frame in 0..<numFrames {
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

    let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: true)
    NSGraphicsContext.current = nsCtx

    // Flip coordinate system so y=0 is top, y=height is bottom (falling downwards!)
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1.0, y: -1.0)

    // 1. Deep obsidian Matrix background (#030805)
    ctx.setFillColor(red: 0.012, green: 0.031, blue: 0.020, alpha: 1.0)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // 2. Subtle atmospheric depth from base matrix_rain.jpg (22% opacity)
    if let base = baseImage,
       let cgBase = base.cgImage(forProposedRect: nil, context: nsCtx, hints: nil) {
        ctx.saveGState()
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1.0, y: -1.0)
        ctx.setAlpha(0.22)
        ctx.draw(cgBase, in: CGRect(x: 0, y: 0, width: width, height: height))
        ctx.restoreGState()
    }

    // 3. Draw falling Matrix columns
    for col in columns {
        let font = NSFont(name: "HiraginoSans-W6", size: col.fontSize)
            ?? NSFont.monospacedSystemFont(ofSize: col.fontSize, weight: .bold)

        let totalRows = Double(col.numRows)
        // Head position in rows [0, totalRows)
        let headRow = (col.phaseRows + progress * col.speedCycles * totalRows)
            .truncatingRemainder(dividingBy: totalRows)

        for r in 0..<col.numRows {
            // Distance behind the falling head (wrapping seamlessly around totalRows)
            var dist = headRow - Double(r)
            if dist < 0 {
                dist += totalRows
            }

            if dist > col.tailLengthRows {
                continue
            }

            // Pick glyph deterministically per (col, row), mutating slightly near the head
            var glyphSeed = col.seed ^ UInt64(r &* 1315423911)
            if dist < 1.3 {
                glyphSeed ^= UInt64(frame &* 2654435761)
            }
            let glyphIdx = Int(splitMix64(&glyphSeed) % UInt64(glyphChars.count))
            let glyph = glyphChars[glyphIdx]

            let norm = dist / col.tailLengthRows // 0.0 at head -> 1.0 at tail end
            let fade = pow(1.0 - norm, 1.55) * Double(col.brightness)

            let textColor: NSColor
            var useGlow = false

            if dist < 0.95 {
                // Leading phosphor white-green character (#d8ffe4)
                textColor = NSColor(
                    calibratedRed: 0.85,
                    green: 1.0,
                    blue: 0.90,
                    alpha: CGFloat(min(1.0, Double(col.brightness) * 1.05))
                )
                useGlow = col.brightness > 0.6
            } else if dist < 2.8 {
                // Bright neon Matrix green (#00ff66)
                textColor = NSColor(
                    calibratedRed: 0.05,
                    green: 1.0,
                    blue: 0.42,
                    alpha: CGFloat(fade)
                )
                useGlow = col.brightness > 0.75
            } else {
                // Classic emerald trail (#00cc52 -> #004d1f)
                let g = CGFloat(0.28 + 0.68 * (1.0 - norm))
                let b = CGFloat(0.08 + 0.24 * (1.0 - norm))
                textColor = NSColor(
                    calibratedRed: 0.0,
                    green: g,
                    blue: b,
                    alpha: CGFloat(fade)
                )
            }

            ctx.saveGState()
            if useGlow {
                ctx.setShadow(
                    offset: .zero,
                    blur: col.fontSize * 0.55,
                    color: CGColor(red: 0.0, green: 1.0, blue: 0.40, alpha: 0.85)
                )
            }

            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: textColor,
            ]
            let attrStr = NSAttributedString(string: glyph, attributes: attrs)
            attrStr.draw(at: NSPoint(x: col.x, y: CGFloat(r) * col.cellH))
            ctx.restoreGState()
        }
    }

    // 4. Subtle CRT scanline & radial vignette overlay so terminal text stays ultra-readable
    ctx.setFillColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.18)
    for y in stride(from: 0, to: height, by: 3) {
        ctx.fill(CGRect(x: 0, y: y, width: width, height: 1))
    }

    guard let outCgImage = ctx.makeImage() else {
        fatalError("Failed to make CGImage for frame \(frame)")
    }
    let bitmapRep = NSBitmapImageRep(cgImage: outCgImage)
    guard let jpegData = bitmapRep.representation(
        using: .jpeg,
        properties: [.compressionFactor: 0.82]
    ) else {
        fatalError("Failed to encode JPEG for frame \(frame)")
    }

    let fileName = String(format: "frame_%02d.jpg", frame)
    let fileURL = URL(fileURLWithPath: outDir).appendingPathComponent(fileName)
    try jpegData.write(to: fileURL)
}

print("Generated \(numFrames) seamless Matrix rain frames in \(outDir)")
