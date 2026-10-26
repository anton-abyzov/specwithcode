import Foundation
import SWCSync
import Weave

/// CSS colors the stream page paints with.
nonisolated struct DeviceStreamColors: Encodable, Hashable, Sendable {
  var background: String
  var foreground: String
  var muted: String
  var buttonBackground: String
  var buttonForeground: String
  var buttonBorder: String

  /// The viewer is always dark, like a video player, so the device's own screen stands out.
  static let viewer = DeviceStreamColors(
    background: WeaveColorToken.sunken.hex(.dark),
    foreground: WeaveColorToken.ink.hex(.dark),
    muted: WeaveColorToken.muted.hex(.dark),
    buttonBackground: WeaveColorToken.panel.hex(.dark),
    buttonForeground: WeaveColorToken.ink.hex(.dark),
    buttonBorder: WeaveColorToken.line.hex(.dark)
  )
}

/// The page the device viewer loads: the shared stream transport
/// (App/Generated/device-stream.js) started with one device's configuration.
/// Same document as apps/mobile/src/features/devices/device-stream-document.ts.
nonisolated enum DeviceStreamDocument {
  private struct Configuration: Encodable {
    let access: DeviceHubAccess
    let platform: String
    let deviceId: String
    let colors: DeviceStreamColors
  }

  /// The JSON `StudioDeviceStream.start` takes.
  static func configuration(access: DeviceHubAccess, session: DeviceSessionSummary, colors: DeviceStreamColors = .viewer) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let value = Configuration(access: access, platform: session.isAndroid ? "android" : "ios", deviceId: session.deviceId, colors: colors)
    let data = (try? encoder.encode(value)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  /// Tickets and device names are data, including any HTML delimiter
  /// characters, so neither the configuration nor the script can end the tag.
  static func html(configuration: String, script: String) -> String {
    let safeConfiguration = configuration.replacingOccurrences(of: "<", with: "\\u003c")
    let safeScript = script.replacingOccurrences(of: "</(script)", with: "<\\\\/$1", options: [.regularExpression, .caseInsensitive])
    let failure = #"window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Device viewer stopped unexpectedly."}));"#
    return #"<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){"#
      + failure + #"});window.addEventListener("unhandledrejection",function(){"# + failure + "});\n"
      + safeScript + "\ntry{StudioDeviceStream.start(" + safeConfiguration + ");}catch{" + failure + "}</script></body></html>"
  }

  /// Gives the page the `window.ReactNativeWebView` bridge the shared transport posts to.
  static let bridgeShim = "window.ReactNativeWebView={postMessage:function(m){window.webkit.messageHandlers.stream.postMessage(m)}};"
  static let handlerName = "stream"
  static let stopScript = "window.StudioDeviceStream&&window.StudioDeviceStream.stop();"

  static func commandScript(_ command: DeviceCommand) -> String {
    #"window.StudioDeviceStream&&window.StudioDeviceStream.command(""# + command.rawValue + #"");"#
  }
}

/// Hardware buttons the stream can press on the device.
nonisolated enum DeviceCommand: String, Sendable, CaseIterable {
  case home, back, appSwitcher, rotate
}

/// A message the stream page posts.
nonisolated enum DeviceStreamMessage: Equatable, Sendable {
  enum Status: String, Sendable { case connecting, streaming, error }

  /// The ticket was refused: get a fresh one and load again.
  case unauthorized
  /// The page gave up on this connection: get a fresh ticket and load again.
  case retry
  case input(connected: Bool)
  case status(Status, detail: String?)

  /// Nil for anything that isn't part of the stream bridge.
  static func parse(_ body: Any) -> DeviceStreamMessage? {
    guard let text = body as? String, let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else { return nil }
    switch type {
    case "unauthorized": return .unauthorized
    case "retry": return .retry
    case "input":
      guard let connected = object["connected"] as? Bool else { return nil }
      return .input(connected: connected)
    case "status":
      guard let raw = object["status"] as? String, let status = Status(rawValue: raw) else { return nil }
      if let detail = object["detail"], !(detail is String) { return nil }
      return .status(status, detail: object["detail"] as? String)
    default:
      return nil
    }
  }
}
