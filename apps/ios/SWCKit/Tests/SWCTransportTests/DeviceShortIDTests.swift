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
    #expect(DeviceShortID.make(thumbprint: key.thumbprint) == id)
    // Only the first six characters are read, so what follows them never matters.
    #expect(DeviceShortID.make(thumbprint: String(key.thumbprint.prefix(6))) == id)
    #expect(DeviceShortID.make(thumbprint: "\(key.thumbprint.prefix(6)) \n") == id)
  }

  @Test func textThatIsNoThumbprintGetsNothing() {
    for text in ["", "abc", "not a thumbprint", "abc+/=xyz"] {
      #expect(DeviceShortID.make(thumbprint: text) == nil)
    }
  }

  // The TypeScript suite asserts the same list: the text is read as given, never trimmed.
  @Test func textWhoseFirstSixCharactersAreNotAllBase64urlGetsNothing() {
    let key = "z3tKzoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    for text in [
      " \(key)",
      "\n\(key)",
      "\u{FEFF}\(key)",
      "\u{0085}\(key)",
      "z3tK\u{1F600}o",
      "z3tKz\u{00E9}AAAA",
      "z\u{0301}tKzoAAAA",
    ] {
      #expect(DeviceShortID.make(thumbprint: text) == nil)
    }
  }
}
