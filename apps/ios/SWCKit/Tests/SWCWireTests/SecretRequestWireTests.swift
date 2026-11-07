import Foundation
import Testing
import SWCWire

@Suite("SecretRequest wire")
struct SecretRequestWireTests {
  static func json(status: String? = "pending", extra: String = #","label":"OpenAI API key","reason":"To call the API","placeholder":"sk-...""#) -> String {
    """
    {"id":"ti_s","threadId":"thr_1","ordinal":3,"status":"waiting","updatedAt":"2026-11-07T06:00:05.123Z",
     "type":"secret_request"\(extra)\(status.map { ",\"secretStatus\":\"\($0)\"" } ?? "")}
    """
  }

  func request(_ json: String) throws -> TurnItem.SecretRequest {
    let item = try decodeJSON(TurnItem.self, json)
    #expect(item.type == "secret_request")
    #expect(!item.isUnknown)
    guard case let .secretRequest(request) = item.content else {
      throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a secret request"))
    }
    return request
  }

  @Test func secretRequestIsAKnownType() {
    #expect(TurnItem.knownTypes.contains("secret_request"))
  }

  @Test func secretRequestDecodes() throws {
    let request = try request(Self.json())
    #expect(request.label == "OpenAI API key")
    #expect(request.reason == "To call the API")
    #expect(request.placeholder == "sk-...")
    #expect(request.secretStatus == .pending)
    #expect(request.isPending)
    for status in ["saved", "declined", "cancelled"] {
      #expect(try self.request(Self.json(status: status)).secretStatus.rawValue == status)
    }
  }

  @Test func missingFieldsFallBackRatherThanFail() throws {
    let request = try request(Self.json(status: nil, extra: ""))
    #expect(request.label == "")
    #expect(request.reason == "")
    #expect(request.placeholder == nil)
    #expect(request.secretStatus == .cancelled)
    // A status this build does not know keeps its raw value.
    #expect(try self.request(Self.json(status: "expired")).secretStatus.rawValue == "expired")
  }

  @Test func secretRequestRoundTrips() throws {
    let item = try decodeJSON(TurnItem.self, Self.json(status: "saved"))
    let again = try WireCoding.decoder.decode(TurnItem.self, from: try WireCoding.encoder.encode(item))
    #expect(again == item)
  }
}
