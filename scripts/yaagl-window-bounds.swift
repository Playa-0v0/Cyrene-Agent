import CoreGraphics
import Foundation

let options: CGWindowListOption = [.excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, .zero) as? [[String: Any]] else {
    exit(1)
}

var bestPayload: [String: Any]? = nil
var bestScore = -1.0

for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let title = window[kCGWindowName as String] as? String ?? ""
    let isYaagl = owner.localizedCaseInsensitiveContains("yaagl")
        || owner.localizedCaseInsensitiveContains("honkai star rail")
        || title.localizedCaseInsensitiveContains("yet another anime game launcher")
    guard isYaagl,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? NSNumber,
          let y = bounds["Y"] as? NSNumber,
          let width = bounds["Width"] as? NSNumber,
          let height = bounds["Height"] as? NSNumber,
          width.doubleValue > 300,
          height.doubleValue > 200 else { continue }

    let payload: [String: Any] = [
        "x": x.doubleValue,
        "y": y.doubleValue,
        "width": width.doubleValue,
        "height": height.doubleValue,
        "owner": owner,
        "title": title,
    ]
    let titleBonus = title.localizedCaseInsensitiveContains("yet another anime game launcher") ? 1_000_000_000.0 : 0
    let score = titleBonus + width.doubleValue * height.doubleValue
    if score > bestScore {
        bestScore = score
        bestPayload = payload
    }
}

guard let payload = bestPayload else { exit(2) }
let data = try JSONSerialization.data(withJSONObject: payload)
print(String(data: data, encoding: .utf8)!)
