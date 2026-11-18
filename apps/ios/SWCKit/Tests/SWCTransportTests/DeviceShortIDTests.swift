import Foundation
import Testing
@testable import SWCTransport

@Suite struct DeviceShortIDTests {
  /// The vectors `packages/shared/src/deviceShortId.test.ts` and the server assert.
  @Test func givesTheSharedVectors() {
    // The thumbprint of RFC 7638's example key; its first bytes are 55, 54, 203, 177.
    #expect(DeviceShortID.make(thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs") == "TSKR")
    // First bytes 255, 0, 0, 255: both ends of the byte range, and the url-safe characters.
    #expect(DeviceShortID.make(thumbprint: "_wAA_0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1w") == "9229")
  }

  @Test func aRealKeyGetsFourCodeCharactersAndKeepsThem() throws {
    let key = SoftwareDpopKey()
    let id = try #require(DeviceShortID.make(thumbprint: key.thumbprint))
    #expect(id.count == DeviceShortID.length)
    #expect(id.allSatisfy { DeviceShortID.alphabet.contains($0) })
    #expect(DeviceShortID.make(thumbprint: " \(key.thumbprint)\n") == id)
  }

  @Test func textThatIsNoThumbprintGetsNothing() {
    for text in ["", "abc", "not a thumbprint", "abc+/=xyz"] {
      #expect(DeviceShortID.make(thumbprint: text) == nil)
    }
  }
}
