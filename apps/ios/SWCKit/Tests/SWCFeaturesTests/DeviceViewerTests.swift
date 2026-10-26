import Foundation
import Testing
import SWCSync
@testable import SWCFeatures

@Suite("Device viewer")
struct DeviceViewerTests {
  private let session = DeviceSessionSummary(environmentId: "env-m4", hostId: "local", deviceId: "439CE36F", isAndroid: false, name: "iPhone Duo")
  private let access = DeviceHubAccess(httpBase: "http://mac:8319/api/device-hub", wsBase: "ws://mac:8319/api/device-hub", query: ["wsTicket": "</script><b>", "hostId": "local"])

  @Test func configurationCarriesAccessDeviceAndColors() throws {
    let json = DeviceStreamDocument.configuration(access: access, session: session)
    let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    #expect(object["platform"] as? String == "ios")
    #expect(object["deviceId"] as? String == "439CE36F")
    let colors = try #require(object["colors"] as? [String: String])
    #expect(Set(colors.keys) == ["background", "foreground", "muted", "buttonBackground", "buttonForeground", "buttonBorder"])
    #expect(colors.values.allSatisfy { $0.hasPrefix("#") })
    let accessObject = try #require(object["access"] as? [String: Any])
    #expect(accessObject["httpBase"] as? String == "http://mac:8319/api/device-hub")
  }

  @Test func documentKeepsDataInsideItsScriptTag() {
    let hostile = DeviceSessionSummary(environmentId: "env-m4", hostId: "local", deviceId: "439CE36F", isAndroid: false, name: "</script><b>")
    let configuration = DeviceStreamDocument.configuration(access: access, session: hostile)
    let html = DeviceStreamDocument.html(configuration: configuration, script: "var a='</SCRIPT>';var b='</script >';")
    // Exactly the one closing tag the document writes itself.
    #expect(html.components(separatedBy: "</script>").count == 2)
    #expect(html.range(of: "</script", options: .caseInsensitive).map { html[$0.lowerBound...] }?.hasPrefix("</script></body></html>") == true)
    #expect(!html.contains("<b>"))
    #expect(html.contains(#"\u003c/script>\u003cb>"#))
    #expect(html.contains(#"<\/SCRIPT>"#) && html.contains(#"<\/script >"#))
    #expect(html.contains("StudioDeviceStream.start({"))
  }

  @Test func parsesBridgeMessages() {
    #expect(DeviceStreamMessage.parse(#"{"type":"unauthorized"}"#) == .unauthorized)
    #expect(DeviceStreamMessage.parse(#"{"type":"retry"}"#) == .retry)
    #expect(DeviceStreamMessage.parse(#"{"type":"input","connected":true}"#) == .input(connected: true))
    #expect(DeviceStreamMessage.parse(#"{"type":"status","status":"streaming"}"#) == .status(.streaming, detail: nil))
    #expect(DeviceStreamMessage.parse(#"{"type":"status","status":"error","detail":"No video"}"#) == .status(.error, detail: "No video"))
    #expect(DeviceStreamMessage.parse(#"{"type":"status","status":"paused"}"#) == nil)
    #expect(DeviceStreamMessage.parse(#"{"type":"status","status":"error","detail":3}"#) == nil)
    #expect(DeviceStreamMessage.parse(#"{"type":"input"}"#) == nil)
    #expect(DeviceStreamMessage.parse("not json") == nil)
    #expect(DeviceStreamMessage.parse(42) == nil)
  }

  @Test func commandsCallTheTransport() {
    #expect(DeviceStreamDocument.commandScript(.appSwitcher) == #"window.StudioDeviceStream&&window.StudioDeviceStream.command("appSwitcher");"#)
    #expect(DeviceCommand.allCases.map(\.rawValue) == ["home", "back", "appSwitcher", "rotate"])
  }
}
