import AppKit
import Foundation
import Vision

struct Candidate: Codable {
    let confidence: Float
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

func findDetailedLandscapeRegion(_ cgImage: CGImage) -> CGRect? {
    let sourceWidth = cgImage.width
    let sourceHeight = cgImage.height
    let targetWidth = min(360, sourceWidth)
    let targetHeight = max(1, Int((Double(sourceHeight) / Double(sourceWidth)) * Double(targetWidth)))
    var pixels = [UInt8](repeating: 0, count: targetWidth * targetHeight * 4)
    guard let context = CGContext(
        data: &pixels,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: targetWidth * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.interpolationQuality = .medium
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))

    var gray = [Int](repeating: 0, count: targetWidth * targetHeight)
    for index in 0..<(targetWidth * targetHeight) {
        let base = index * 4
        gray[index] = (Int(pixels[base]) * 3 + Int(pixels[base + 1]) * 6 + Int(pixels[base + 2])) / 10
    }
    var integral = [Int](repeating: 0, count: (targetWidth + 1) * (targetHeight + 1))
    var colorIntegral = [Int](repeating: 0, count: (targetWidth + 1) * (targetHeight + 1))
    for y in 1..<targetHeight {
        var rowSum = 0
        var colorRowSum = 0
        for x in 1..<targetWidth {
            let gradient = abs(gray[y * targetWidth + x] - gray[y * targetWidth + x - 1])
                + abs(gray[y * targetWidth + x] - gray[(y - 1) * targetWidth + x])
            rowSum += gradient >= 34 ? 1 : 0
            integral[(y + 1) * (targetWidth + 1) + x + 1] = integral[y * (targetWidth + 1) + x + 1] + rowSum
            let base = (y * targetWidth + x) * 4
            let high = max(pixels[base], max(pixels[base + 1], pixels[base + 2]))
            let low = min(pixels[base], min(pixels[base + 1], pixels[base + 2]))
            colorRowSum += Int(high) - Int(low) >= 18 ? 1 : 0
            colorIntegral[(y + 1) * (targetWidth + 1) + x + 1] = colorIntegral[y * (targetWidth + 1) + x + 1] + colorRowSum
        }
    }
    func sum(_ table: [Int], _ x: Int, _ y: Int, _ width: Int, _ height: Int) -> Int {
        let stride = targetWidth + 1
        let x2 = x + width
        let y2 = y + height
        return table[y2 * stride + x2] - table[y * stride + x2]
            - table[y2 * stride + x] + table[y * stride + x]
    }

    var best: (x: Int, y: Int, width: Int, height: Int, score: Double)?
    let minWidth = Int(Double(targetWidth) * 0.24)
    let maxWidth = Int(Double(targetWidth) * 0.95)
    for width in stride(from: minWidth, through: maxWidth, by: 6) {
        let height = max(1, Int(Double(width) / 1.7778))
        guard height < targetHeight else { continue }
        for y in stride(from: 0, through: targetHeight - height, by: 3) {
            for x in stride(from: 0, through: targetWidth - width, by: 3) {
                let edgeCount = sum(integral, x, y, width, height)
                let colorCount = sum(colorIntegral, x, y, width, height)
                let area = width * height
                let density = Double(edgeCount) / Double(area)
                let colorDensity = Double(colorCount) / Double(area)
                let score = density * sqrt(Double(area)) * (1 + colorDensity * 4.5)
                if best == nil || score > best!.score { best = (x, y, width, height, score) }
            }
        }
    }
    guard let region = best, region.score >= 1.25 else { return nil }
    let scaleX = CGFloat(sourceWidth) / CGFloat(targetWidth)
    let scaleY = CGFloat(sourceHeight) / CGFloat(targetHeight)
    return CGRect(
        x: CGFloat(region.x) * scaleX,
        y: CGFloat(region.y) * scaleY,
        width: CGFloat(region.width) * scaleX,
        height: CGFloat(region.height) * scaleY
    )
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("用法：cyrene-vision-card-crop <輸入圖片> <輸出圖片>")
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOf: inputURL),
      let imageData = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: imageData),
      let cgImage = bitmap.cgImage else {
    fail("無法讀取輸入圖片")
}

let request = VNDetectRectanglesRequest()
request.maximumObservations = 40
request.minimumConfidence = 0.45
request.minimumAspectRatio = 0.28
request.maximumAspectRatio = 1.0
request.minimumSize = 0.08
request.quadratureTolerance = 18

do {
    try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
} catch {
    fail("矩形偵測失敗：\(error.localizedDescription)")
}

let imageWidth = CGFloat(cgImage.width)
let imageHeight = CGFloat(cgImage.height)
let ranked = (request.results ?? []).compactMap { observation -> (CGRect, Float, CGFloat)? in
    let box = observation.boundingBox
    let pixelAspect = (box.width * imageWidth) / max(1, box.height * imageHeight)
    let area = box.width * box.height
    // 官方 /create 圖為橫向 16:9；排除 Discord 的寬文字泡泡與整個內容窗格。
    guard pixelAspect >= 1.58, pixelAspect <= 2.05, area >= 0.045, area <= 0.55 else { return nil }
    let aspectScore = max(0, 1 - abs(pixelAspect - 1.78) / 1.2)
    let score = area * (0.78 + CGFloat(observation.confidence) * 0.12 + aspectScore * 0.10)
    return (box, observation.confidence, score)
}.sorted { $0.2 > $1.2 }

var selectedBox = ranked.first?.0
var selectedConfidence = ranked.first?.1 ?? 0

if selectedBox == nil {
    let saliencyRequest = VNGenerateAttentionBasedSaliencyImageRequest()
    do {
        try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([saliencyRequest])
        let objects = saliencyRequest.results?.first?.salientObjects ?? []
        let saliencyRanked = objects.compactMap { object -> (CGRect, Float, CGFloat)? in
            let box = object.boundingBox
            let pixelAspect = (box.width * imageWidth) / max(1, box.height * imageHeight)
            let area = box.width * box.height
            guard pixelAspect >= 1.45, pixelAspect <= 2.15, area >= 0.035, area <= 0.65 else { return nil }
            let aspectScore = max(0, 1 - abs(pixelAspect - 1.78) / 1.1)
            return (box, object.confidence, area * (0.78 + aspectScore * 0.22))
        }.sorted { $0.2 > $1.2 }
        selectedBox = saliencyRanked.first?.0
        selectedConfidence = saliencyRanked.first?.1 ?? 0
    } catch {
        // 下方會統一回報找不到矩形。
    }
}

if selectedBox == nil, let detailRegion = findDetailedLandscapeRegion(cgImage) {
    selectedBox = CGRect(
        x: detailRegion.minX / imageWidth,
        y: detailRegion.minY / imageHeight,
        width: detailRegion.width / imageWidth,
        height: detailRegion.height / imageHeight
    )
    selectedConfidence = 0.5
}

guard let box = selectedBox else { fail("找不到角色卡矩形") }
let heuristicCrop = selectedConfidence == 0.5
let paddingX = heuristicCrop ? box.width * 0.06 : min(box.width, box.height) * 0.006
let paddingY = heuristicCrop ? box.height * 0.04 : min(box.width, box.height) * 0.006
let minX = max(0, box.minX - paddingX)
let minY = max(0, box.minY - paddingY)
let normalized = CGRect(
    x: minX,
    y: minY,
    width: min(1 - minX, box.width + paddingX * 2),
    height: min(1 - minY, box.height + paddingY * 2)
)
let cropRect = CGRect(
    x: normalized.minX * imageWidth,
    y: normalized.minY * imageHeight,
    width: normalized.width * imageWidth,
    height: normalized.height * imageHeight
).integral

let usesWholeFrame = normalized.width * normalized.height >= 0.82
let outputImage = usesWholeFrame ? cgImage : cgImage.cropping(to: cropRect)
guard let outputImage,
      let png = NSBitmapImageRep(cgImage: outputImage).representation(using: .png, properties: [:]) else {
    fail("角色卡裁切失敗")
}

do {
    try png.write(to: outputURL, options: .atomic)
    let candidate = Candidate(
        confidence: selectedConfidence,
        x: cropRect.minX,
        y: imageHeight - cropRect.maxY,
        width: cropRect.width,
        height: cropRect.height
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(candidate))
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail("無法寫入裁切圖片：\(error.localizedDescription)")
}
