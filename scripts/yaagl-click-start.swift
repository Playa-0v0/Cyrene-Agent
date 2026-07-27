import AppKit
import ApplicationServices

let acceptedLabels = ["开始游戏", "開始遊戲", "Start Game"]

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return "" }
    return value as? String ?? ""
}

func containsStartLabel(_ text: String) -> Bool {
    acceptedLabels.contains { text.localizedCaseInsensitiveContains($0) }
}

func pressStartButton(_ element: AXUIElement, depth: Int = 0) -> Bool {
    guard depth < 16 else { return false }

    let role = stringAttribute(element, kAXRoleAttribute as CFString)
    if role == (kAXButtonRole as String) {
        let searchable = [
            stringAttribute(element, kAXTitleAttribute as CFString),
            stringAttribute(element, kAXDescriptionAttribute as CFString),
            stringAttribute(element, kAXValueAttribute as CFString),
        ].joined(separator: " ")
        if containsStartLabel(searchable), AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return true
        }
    }

    var childrenValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
          let children = childrenValue as? [AXUIElement] else { return false }
    return children.contains { pressStartButton($0, depth: depth + 1) }
}

guard AXIsProcessTrusted() else {
    fputs("accessibility permission missing\n", stderr)
    exit(2)
}

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == "com.3shain.yaagl.hkrpg.os" ||
    $0.localizedName?.localizedCaseInsensitiveContains("Honkai Star Rail") == true
}) else {
    fputs("YAAGL is not running\n", stderr)
    exit(3)
}

app.activate(options: [.activateIgnoringOtherApps])
let applicationElement = AXUIElementCreateApplication(app.processIdentifier)
if pressStartButton(applicationElement) {
    print("clicked")
    exit(0)
}

fputs("start button not found\n", stderr)
exit(4)
