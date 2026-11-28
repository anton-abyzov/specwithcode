// studio-screen-control: posts the pointer, scroll and key events of a person
// controlling this Mac's screen from another of their devices (1519).
//
// The app starts it for one live control session and talks to it only over the
// stdin and stdout it inherits: one JSON object per line. It listens on nothing
// else. It runs under the app's Accessibility grant (macOS charges the grant to
// the app that started it), so it must not be started disclaimed.
//
// It exits when stdin closes, on SIGTERM, or after two minutes without a
// command. Before it exits it lets go of every key and button it pressed.
//
// Before each key or button it checks, fresh, what is on screen: no key while
// secure input is on, a system prompt is up, a browser is in front or the
// machine is locked; no click while a system prompt is up or it is locked.
// A key or button it pressed can always be let go.
//
// Commands (app to helper):
//   {"t":"config","browsers":["com.google.Chrome", ...]}
//   {"t":"input","events":[{"t":"move","x":0,"y":0}, {"t":"button","button":"left","down":true,"x":0,"y":0},
//                          {"t":"scroll","dx":0,"dy":-120,"x":0,"y":0}, {"t":"key","code":"KeyA","down":true}]}
//     (x and y are global display points)
//   {"t":"release","keys":["ShiftLeft"],"buttons":["left"]}   (keys and buttons optional)
// Replies (helper to app):
//   {"t":"ready","trusted":true}
//   {"t":"gate","blocked":null|"secure_input"|"system_prompt"|"browser"|"locked"}  (when it changes)
//   {"t":"released"}

import AppKit
import ApplicationServices
import Carbon
import Foundation

let silenceSeconds: Double = 120

// KeyboardEvent.code to macOS virtual key codes. The app checks codes against
// the same list (screenControl.logic.ts); a test compares the two.
let keyCodes: [String: CGKeyCode] = [
  "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05,
  "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "IntlBackslash": 0x0A, "KeyB": 0x0B,
  "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11,
  "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16,
  "Digit5": 0x17, "Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B,
  "Digit8": 0x1C, "Digit0": 0x1D, "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20,
  "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23, "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26,
  "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B,
  "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F, "Tab": 0x30, "Space": 0x31,
  "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35, "MetaRight": 0x36, "MetaLeft": 0x37,
  "ShiftLeft": 0x38, "CapsLock": 0x39, "AltLeft": 0x3A, "ControlLeft": 0x3B,
  "ShiftRight": 0x3C, "AltRight": 0x3D, "ControlRight": 0x3E, "F17": 0x40,
  "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumpadDivide": 0x4B,
  "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "F18": 0x4F, "F19": 0x50, "NumpadEqual": 0x51,
  "Numpad0": 0x52, "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56,
  "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59, "Numpad8": 0x5B, "Numpad9": 0x5C,
  "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64, "F9": 0x65, "F11": 0x67,
  "F13": 0x69, "F16": 0x6A, "F14": 0x6B, "F10": 0x6D, "F12": 0x6F, "F15": 0x71,
  "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "F4": 0x76, "End": 0x77, "F2": 0x78,
  "PageDown": 0x79, "F1": 0x7A, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D,
  "ArrowUp": 0x7E,
]

let modifierFlags: [String: CGEventFlags] = [
  "ShiftLeft": .maskShift, "ShiftRight": .maskShift,
  "ControlLeft": .maskControl, "ControlRight": .maskControl,
  "AltLeft": .maskAlternate, "AltRight": .maskAlternate,
  "MetaLeft": .maskCommand, "MetaRight": .maskCommand,
]

let systemPromptOwners: Set<String> = ["SecurityAgent", "coreautha"]
let systemPromptApps: Set<String> = ["com.apple.SecurityAgent", "com.apple.coreautha"]

var browsers: Set<String> = []
var heldKeys: Set<String> = []
var heldButtons: Set<String> = []
var lastGate: String? = "unset"
var lastCommand = Date()
var lastPoint = CGPoint.zero
var clickCount: Int64 = 1
var lastClickAt = Date.distantPast
var lastClickPoint = CGPoint.zero
var cachedBlock: (at: Date, value: String?)? = nil

func say(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

/// What stops typing right now, read fresh: nil when nothing does.
func currentBlock() -> String? {
  // What cannot be read blocks: the moments it is missing are lock and prompt changes.
  guard let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else { return "locked" }
  if front == "com.apple.loginwindow" { return "locked" }
  if systemPromptApps.contains(front) { return "system_prompt" }
  guard
    let windows =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]
  else { return "system_prompt" }
  for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    if systemPromptOwners.contains(owner) { return "system_prompt" }
  }
  if IsSecureEventInputEnabled() { return "secure_input" }
  if browsers.contains(front) { return "browser" }
  return nil
}

func block(fresh: Bool) -> String? {
  if !fresh, let cached = cachedBlock, Date().timeIntervalSince(cached.at) < 0.1 {
    return cached.value
  }
  let value = currentBlock()
  cachedBlock = (Date(), value)
  if value != lastGate {
    lastGate = value
    say(["t": "gate", "blocked": value.map { $0 as Any } ?? NSNull()])
  }
  return value
}

func flags() -> CGEventFlags {
  var out = CGEventFlags()
  for key in heldKeys { if let flag = modifierFlags[key] { out.insert(flag) } }
  return out
}

func mouseType(_ button: String, down: Bool) -> (CGEventType, CGMouseButton) {
  switch button {
  case "right": return (down ? .rightMouseDown : .rightMouseUp, .right)
  case "middle": return (down ? .otherMouseDown : .otherMouseUp, .center)
  default: return (down ? .leftMouseDown : .leftMouseUp, .left)
  }
}

func postMove(_ point: CGPoint) {
  lastPoint = point
  var type = CGEventType.mouseMoved
  var button = CGMouseButton.left
  if heldButtons.contains("left") {
    type = .leftMouseDragged
  } else if heldButtons.contains("right") {
    type = .rightMouseDragged
    button = .right
  } else if heldButtons.contains("middle") {
    type = .otherMouseDragged
    button = .center
  }
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  else { return }
  event.flags = flags()
  event.post(tap: .cghidEventTap)
}

func postButton(_ name: String, down: Bool, at point: CGPoint) {
  let (type, button) = mouseType(name, down: down)
  if down {
    let near = abs(point.x - lastClickPoint.x) < 4 && abs(point.y - lastClickPoint.y) < 4
    clickCount = near && Date().timeIntervalSince(lastClickAt) < NSEvent.doubleClickInterval ? min(clickCount + 1, 3) : 1
    lastClickAt = Date()
    lastClickPoint = point
    heldButtons.insert(name)
  } else {
    heldButtons.remove(name)
  }
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  else { return }
  event.setIntegerValueField(.mouseEventClickState, value: clickCount)
  event.flags = flags()
  event.post(tap: .cghidEventTap)
  lastPoint = point
}

func postScroll(dx: Double, dy: Double) {
  guard
    let event = CGEvent(
      scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
      wheel1: Int32(max(-10_000, min(10_000, -dy))), wheel2: Int32(max(-10_000, min(10_000, -dx))), wheel3: 0)
  else { return }
  event.flags = flags()
  event.post(tap: .cghidEventTap)
}

func postKey(_ code: String, down: Bool) {
  guard let virtual = keyCodes[code] else { return }
  if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
  guard let event = CGEvent(keyboardEventSource: nil, virtualKey: virtual, keyDown: down) else { return }
  event.flags = flags()
  event.post(tap: .cghidEventTap)
}

func releaseAll() {
  for key in heldKeys where modifierFlags[key] == nil { postKey(key, down: false) }
  for key in heldKeys { postKey(key, down: false) }
  for button in heldButtons { postButton(button, down: false, at: lastPoint) }
  heldKeys.removeAll()
  heldButtons.removeAll()
}

func number(_ value: Any?) -> Double? {
  guard let value = value as? NSNumber, value.doubleValue.isFinite else { return nil }
  return value.doubleValue
}

/// Input that waited too long is not acted on: only what lets go of a key or button runs.
let staleSeconds = 1.0

func handleInput(_ events: [[String: Any]], stale: Bool) {
  for event in events {
    if stopping.value { return }
    switch event["t"] as? String {
    case "move":
      guard !stale, let x = number(event["x"]), let y = number(event["y"]) else { continue }
      // A move with a button held is a drag: it gets the same fresh check as a press.
      let now = block(fresh: !heldButtons.isEmpty)
      if now == "locked" || (!heldButtons.isEmpty && now == "system_prompt") { continue }
      postMove(CGPoint(x: x, y: y))
    case "button":
      guard let x = number(event["x"]), let y = number(event["y"]),
        let name = event["button"] as? String, ["left", "right", "middle"].contains(name),
        let down = event["down"] as? Bool
      else { continue }
      if down {
        if stale { continue }
        let now = block(fresh: true)
        if now == "system_prompt" || now == "locked" { continue }
        postButton(name, down: true, at: CGPoint(x: x, y: y))
      } else if heldButtons.contains(name) {
        postButton(name, down: false, at: CGPoint(x: x, y: y))
      }
    case "scroll":
      guard !stale, let dx = number(event["dx"]), let dy = number(event["dy"]),
        let x = number(event["x"]), let y = number(event["y"])
      else { continue }
      let now = block(fresh: true)
      if now == "system_prompt" || now == "locked" { continue }
      postMove(CGPoint(x: x, y: y))
      postScroll(dx: dx, dy: dy)
    case "key":
      guard let code = event["code"] as? String, keyCodes[code] != nil,
        let down = event["down"] as? Bool
      else { continue }
      if down {
        if stale || block(fresh: true) != nil { continue }
        postKey(code, down: true)
      } else if heldKeys.contains(code) {
        postKey(code, down: false)
      }
    default:
      continue
    }
  }
}

func handle(_ data: Data, stale: Bool) {
  guard let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else { return }
  lastCommand = Date()
  switch command["t"] as? String {
  case "config":
    if let list = command["browsers"] as? [String] { browsers = Set(list.prefix(200)) }
    _ = block(fresh: true)
  case "input":
    if let events = command["events"] as? [[String: Any]] {
      handleInput(Array(events.prefix(64)), stale: stale)
    }
  case "release":
    // The app may name keys and buttons another helper pressed before it went away.
    for code in (command["keys"] as? [String] ?? []).prefix(64) where keyCodes[code] != nil {
      heldKeys.insert(code)
    }
    for name in (command["buttons"] as? [String] ?? []).prefix(3)
    where ["left", "right", "middle"].contains(name) {
      heldButtons.insert(name)
    }
    releaseAll()
    say(["t": "released"])
  default:
    return
  }
}

/// Set off the main queue when the pipe closes or SIGTERM arrives, so an input
/// backlog stops at once instead of running out first.
final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var on = false
  var value: Bool { lock.lock(); defer { lock.unlock() }; return on }
  func set() { lock.lock(); on = true; lock.unlock() }
}
let stopping = Flag()

func finish() -> Never {
  stopping.set()
  releaseAll()
  exit(0)
}

/// Lines waiting for the main queue, at most `queueLimit`; past it new input is dropped.
/// A release or config line is never dropped, nor an input line that lets go of a key or
/// button: what was pressed is always let go. Each line keeps when it arrived.
let queueLimit = 256
let queueLock = NSLock()
var queued: [(at: Date, data: Data, input: Bool)] = []
var draining = false

func enqueue(_ data: Data) {
  let input = data.range(of: Data("\"t\":\"input\"".utf8)) != nil
  queueLock.lock()
  let letsGo = input && data.range(of: Data("\"down\":false".utf8)) != nil
  if input && !letsGo && queued.count >= queueLimit {
    queueLock.unlock()
    return
  }
  queued.append((Date(), data, input))
  let start = !draining
  draining = true
  queueLock.unlock()
  if start { DispatchQueue.main.async { drain() } }
}

/// A few lines per turn of the main queue, so the timers and the signal source get turns between.
func drain() {
  for _ in 0..<8 {
    if stopping.value { finish() }
    queueLock.lock()
    if queued.isEmpty {
      draining = false
      queueLock.unlock()
      return
    }
    let next = queued.removeFirst()
    queueLock.unlock()
    handle(next.data, stale: Date().timeIntervalSince(next.at) > staleSeconds)
  }
  DispatchQueue.main.async { drain() }
}

signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
term.setEventHandler {
  stopping.set()
  DispatchQueue.main.async { finish() }
}
term.resume()
signal(SIGPIPE, SIG_IGN)

let silence = DispatchSource.makeTimerSource(queue: .main)
silence.schedule(deadline: .now() + 1, repeating: 1)
silence.setEventHandler {
  if Date().timeIntervalSince(lastCommand) > silenceSeconds { finish() }
  // The viewer learns why typing is off before it types.
  _ = block(fresh: true)
}
silence.resume()

/// Lines are read off the main thread in chunks, so a line over the limit is
/// dropped as it arrives instead of being held whole first.
let lineLimit = 128 * 1024
Thread.detachNewThread {
  var line = Data()
  var overflow = false
  var chunk = [UInt8](repeating: 0, count: 16 * 1024)
  while true {
    let count = read(0, &chunk, chunk.count)
    if count < 0 && errno == EINTR { continue }
    if count <= 0 { break }
    var start = 0
    for index in 0..<count where chunk[index] == 0x0A {
      if !overflow {
        line.append(contentsOf: chunk[start..<index])
        if line.count <= lineLimit && !line.isEmpty { enqueue(line) }
      }
      line = Data()
      overflow = false
      start = index + 1
    }
    if !overflow && start < count {
      line.append(contentsOf: chunk[start..<count])
      if line.count > lineLimit {
        overflow = true
        line = Data()
      }
    }
  }
  stopping.set()
  DispatchQueue.main.async { finish() }
}

say(["t": "ready", "trusted": AXIsProcessTrusted()])
RunLoop.main.run()
