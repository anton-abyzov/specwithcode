import CryptoKit
import Foundation
import Testing
@testable import SWCTransport

/// A fixed key, so tests never touch the Keychain.
final class FixedKeyStore: DpopKeyStore {
  let key: SoftwareDpopKey
  init(_ key: SoftwareDpopKey = SoftwareDpopKey()) { self.key = key }
  func loadOrCreate() throws -> any DpopKey { key }
  func reset() throws {}
}

enum JWS {
  static func parts(_ proof: String) throws -> (header: [String: Any], payload: [String: Any], signature: Data, signingInput: String) {
    let pieces = proof.split(separator: ".").map(String.init)
    guard pieces.count == 3,
          let header = Base64URL.decode(pieces[0]).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
          let payload = Base64URL.decode(pieces[1]).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
          let signature = Base64URL.decode(pieces[2]) else { throw DpopError.invalidSignature }
    return (header, payload, signature, pieces[0] + "." + pieces[1])
  }
}

@Suite struct DpopTests {
  let key = SoftwareDpopKey()
  let url = URL(string: "https://relay.example.com/v1/environments/env-1/connect")!

  @Test func proofHasTheHeaderAndClaimsTheRelayChecks() throws {
    let now = Date(timeIntervalSince1970: 1_800_000_000.7)
    let proof = try DpopProof.make(key: key, method: "post", url: url, now: now, jti: "jti-1")
    let (header, payload, signature, _) = try JWS.parts(proof)
    #expect(header["typ"] as? String == "dpop+jwt")
    #expect(header["alg"] as? String == "ES256")
    let jwk = try #require(header["jwk"] as? [String: String])
    #expect(jwk == ["kty": "EC", "crv": "P-256", "x": Base64URL.encode(key.publicX), "y": Base64URL.encode(key.publicY)])
    #expect(payload["htm"] as? String == "POST")
    #expect(payload["htu"] as? String == "https://relay.example.com/v1/environments/env-1/connect")
    #expect(payload["jti"] as? String == "jti-1")
    #expect(payload["iat"] as? Int == 1_800_000_000)
    #expect(payload["ath"] == nil)
    #expect(signature.count == 64)
  }

  @Test func signatureVerifiesAndIsLowS() throws {
    let half = DpopProof.halfOrder
    for _ in 0..<40 {
      let proof = try DpopProof.make(key: key, method: "GET", url: url)
      let (_, _, signature, input) = try JWS.parts(proof)
      let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: signature)
      #expect(key.privateKey.publicKey.isValidSignature(ecdsa, for: Data(input.utf8)))
      #expect(DpopProof.compare(Array(signature.suffix(32)), half) <= 0)
    }
  }

  @Test func athIsTheBase64URLSHA256OfTheAccessToken() throws {
    let proof = try DpopProof.make(key: key, method: "POST", url: url, accessToken: "relay-token")
    let (_, payload, _, _) = try JWS.parts(proof)
    let expected = Base64URL.encode(Data(SHA256.hash(data: Data("relay-token".utf8))))
    #expect(payload["ath"] as? String == expected)
    #expect(!expected.contains("=") && !expected.contains("+") && !expected.contains("/"))
  }

  @Test func thumbprintIsRFC7638OverSortedMembers() {
    let jwk = DpopJWK(x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")
    let input = #"{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}"#
    #expect(jwk.thumbprint == Base64URL.encode(Data(SHA256.hash(data: Data(input.utf8)))))
    #expect(key.thumbprint == key.jwk.thumbprint)
  }

  @Test func htuDropsQueryFragmentAndDefaultPort() {
    #expect(DpopProof.htu(URL(string: "HTTPS://Relay.Example.COM:443/v1/x?y=1#frag")!) == "https://relay.example.com/v1/x")
    #expect(DpopProof.htu(URL(string: "https://m4.example.com")!) == "https://m4.example.com/")
    #expect(DpopProof.htu(URL(string: "http://localhost:8787/oauth/token")!) == "http://localhost:8787/oauth/token")
  }

  @Test func highSIsFlippedToTheLowForm() throws {
    let r = [UInt8](repeating: 7, count: 32)
    var highS = DpopProof.order
    highS[31] -= 1 // n - 1
    let flipped = try DpopProof.lowS(Data(r + highS))
    #expect(Array(flipped.prefix(32)) == r)
    #expect(Array(flipped.suffix(32)) == [UInt8](repeating: 0, count: 31) + [1])
    let low = Data(r + [UInt8](repeating: 0, count: 31) + [5])
    #expect(try DpopProof.lowS(low) == low)
    #expect(throws: DpopError.self) { try DpopProof.lowS(Data(count: 63)) }
  }

  /// Writes proofs for `Tools/verify-dpop-vectors.mjs`, which checks them
  /// with the relay's own verifier (`packages/shared/src/dpop.ts`).
  @Test func writesVectorsForTheRelayVerifier() throws {
    guard let out = ProcessInfo.processInfo.environment["SWC_DPOP_VECTORS_OUT"], !out.isEmpty else { return }
    let now = Date()
    var vectors: [[String: Any]] = []
    for (index, target) in [
      ("POST", "https://relay.example.com/v1/client/dpop-token", nil as String?),
      ("POST", "https://relay.example.com/v1/environments/env%201/connect", "relay-access-token"),
      ("GET", "https://m4-abc.tunnels.example.com/api/auth/session?x=1", "machine-token"),
      ("POST", "https://m4-abc.tunnels.example.com/oauth/token", nil),
    ].enumerated() {
      for round in 0..<8 {
        let key = SoftwareDpopKey()
        let proof = try DpopProof.make(key: key, method: target.0, url: URL(string: target.1)!, accessToken: target.2, now: now, jti: "vector-\(index)-\(round)")
        var vector: [String: Any] = ["proof": proof, "method": target.0, "url": target.1, "iat": Int(now.timeIntervalSince1970), "thumbprint": key.thumbprint]
        if let token = target.2 { vector["accessToken"] = token }
        vectors.append(vector)
      }
    }
    let data = try JSONSerialization.data(withJSONObject: vectors, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: URL(fileURLWithPath: out))
  }
}
