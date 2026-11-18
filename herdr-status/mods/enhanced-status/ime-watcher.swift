// Publishes the current macOS input source to /tmp/herdr-ime.json for the
// enhanced-status IME badge (see pollIme in main.js).
//
//   ime-watcher          watch input source changes and rewrite the file
//   ime-watcher --once   print the current state to stdout and exit

import Carbon
import Foundation

let outputURL = URL(fileURLWithPath: "/tmp/herdr-ime.json")

struct ImeState: Encodable, Equatable {
  let badge: String
  let name: String
  let id: String
  let isChinese: Bool
}

private func property<T>(_ source: TISInputSource, _ key: CFString) -> T? {
  guard let raw = TISGetInputSourceProperty(source, key) else { return nil }
  return Unmanaged<AnyObject>.fromOpaque(raw).takeUnretainedValue() as? T
}

// Ordered: first matching id fragment wins.
private let chineseBadges: [(fragment: String, badge: String)] = [
  ("Zhuyin", "注"),
  ("Cangjie", "倉"),
  ("Sucheng", "速"),
  ("Pinyin", "拼"),
  ("Wubi", "五"),
  ("Stroke", "筆"),
  ("Handwriting", "寫"),
]

private func badge(id: String, name: String, isChinese: Bool, languages: [String]) -> String {
  if isChinese {
    return chineseBadges.first { id.contains($0.fragment) }?.badge ?? "中"
  }
  if languages.first?.hasPrefix("ja") == true { return "あ" }
  if languages.first?.hasPrefix("ko") == true { return "한" }
  if id.hasSuffix(".ABC") || id.hasSuffix(".US") { return "ABC" }
  return String(name.prefix(3)).uppercased()
}

func currentState() -> ImeState? {
  guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return nil }
  let id: String = property(source, kTISPropertyInputSourceID) ?? "unknown"
  let name: String = property(source, kTISPropertyLocalizedName) ?? id
  let languages: [String] = property(source, kTISPropertyInputSourceLanguages) ?? []
  let isChinese = languages.first?.hasPrefix("zh") == true
    || id.contains(".TCIM") || id.contains(".SCIM")
  return ImeState(
    badge: badge(id: id, name: name, isChinese: isChinese, languages: languages),
    name: name,
    id: id,
    isChinese: isChinese
  )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

if CommandLine.arguments.contains("--once") {
  guard let state = currentState(), let data = try? encoder.encode(state) else { exit(1) }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

var lastWritten: ImeState?

func publish() {
  guard let state = currentState(), state != lastWritten,
    let data = try? encoder.encode(state)
  else { return }
  do {
    try data.write(to: outputURL, options: .atomic)
    lastWritten = state
  } catch {
    FileHandle.standardError.write(Data("ime-watcher: \(error)\n".utf8))
  }
}

DistributedNotificationCenter.default().addObserver(
  forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
  object: nil,
  queue: .main
) { _ in publish() }

publish()
RunLoop.main.run()
