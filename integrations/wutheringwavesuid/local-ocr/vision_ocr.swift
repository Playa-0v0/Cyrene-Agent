import AppKit
import Foundation
import Vision

struct OCRResult: Codable {
    let error: String?
    let text: String?
}

func recognize(path: String) -> OCRResult {
    guard let image = NSImage(contentsOfFile: path) else {
        return OCRResult(error: "無法讀取圖片", text: nil)
    }

    var rect = NSRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
        return OCRResult(error: "無法轉換圖片", text: nil)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.008

    let preferredLanguages = ["zh-Hant", "zh-Hans", "en-US"]
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    request.recognitionLanguages = preferredLanguages.filter { supported.contains($0) }

    do {
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first?.string
        }
        return OCRResult(error: nil, text: lines.joined(separator: "\n"))
    } catch {
        return OCRResult(error: "本機辨識失敗：\(error.localizedDescription)", text: nil)
    }
}

let results = CommandLine.arguments.dropFirst().map { path in
    autoreleasepool { recognize(path: path) }
}

do {
    let data = try JSONEncoder().encode(results)
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("無法輸出辨識結果\n".utf8))
    exit(2)
}
