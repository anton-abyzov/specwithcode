// @effect-diagnostics nodeBuiltinImport:off - one-time keys and certificates, made in memory.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { LAN_CERTIFICATE_SUBJECT } from "./lanWire.ts";

/**
 * A one-time ECDSA P-256 key and self-signed certificate for one generation of
 * one copy (1334 S-2, AC-04). It is made in memory, never written to disk and
 * never logged. The certificate names nothing: a fixed subject, a random
 * serial, no machine name and no account. Trust is the exact SHA-256 of its DER
 * bytes, carried on the control channel; no chain is ever validated.
 *
 * Node has no X.509 builder, so the few DER structures are encoded here.
 */
export interface LanCertificate {
  /** PKCS#8 PEM of the private key; lives only in this process. */
  readonly keyPem: string;
  readonly certificatePem: string;
  readonly certificateDer: Buffer;
  /** SHA-256 of the DER bytes: the only part that crosses the wire. */
  readonly sha256: string;
}

const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>) => {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const sequence = (...parts: ReadonlyArray<Uint8Array>) => der(0x30, ...parts);
const oid = (dotted: string) => {
  const [first, second, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const utcTime = (date: Date) => {
  const two = (value: number) => String(value).padStart(2, "0");
  return der(
    0x17,
    Buffer.from(
      `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
        `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
      "ascii",
    ),
  );
};
const extension = (id: string, critical: boolean, value: Uint8Array) =>
  sequence(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const NAME = sequence(
  der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(LAN_CERTIFICATE_SUBJECT, "utf8")))),
);

const ipBytes = (host: string): Buffer => {
  if (NodeNet.isIP(host) === 4) return Buffer.from(host.split(".").map(Number));
  const [head, tail] = host.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => "0"),
    ...right,
  ];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
  return bytes;
};

export function createLanCertificate(input: {
  /** The source's certificate serves; the recipient's proves possession of its key. */
  readonly role: "source" | "recipient";
  /** IP literals for the source's subject alternative names; none for the recipient. */
  readonly addresses?: ReadonlyArray<string>;
  readonly notBefore: Date;
  readonly notAfter: Date;
}): LanCertificate {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const serial = NodeCrypto.randomBytes(16);
  // A positive INTEGER: clear the sign bit, keep it non-zero.
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const extensions = [
    // basicConstraints, critical: an empty sequence is `CA: false`.
    extension("2.5.29.19", true, sequence()),
    // keyUsage, critical: digitalSignature only.
    extension("2.5.29.15", true, der(0x03, Buffer.from([0x07, 0x80]))),
    extension(
      "2.5.29.37",
      true,
      sequence(oid(input.role === "source" ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2")),
    ),
  ];
  if (input.role === "source" && input.addresses?.length)
    extensions.push(
      extension(
        "2.5.29.17",
        false,
        sequence(...input.addresses.map((address) => der(0x87, ipBytes(address)))),
      ),
    );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ECDSA_WITH_SHA256,
    NAME,
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    NAME,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(...extensions)),
  );
  const signature = NodeCrypto.createSign("SHA256").update(tbs).sign(privateKey);
  const certificateDer = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
  const base64 = certificateDer.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certificatePem: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    certificateDer,
    sha256: NodeCrypto.createHash("sha256").update(certificateDer).digest("hex"),
  };
}

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * The recipient's certificate as the listener's only trust anchor, or null.
 *
 * It arrives on the control channel as DER next to its hash. It is taken only when the
 * bytes hash to that value and keep the profile this module issues: the fixed subject,
 * self-signed, `CA: false`, `clientAuth` alone, no alternative name, a P-256 key and a
 * life no longer than a generation plus five minutes each side.
 */
export function recipientAnchorPem(input: {
  readonly derBase64: string;
  readonly sha256: string;
  readonly now: number;
  readonly generationMs: number;
}): string | null {
  try {
    const bytes = Buffer.from(input.derBase64, "base64");
    const presented = NodeCrypto.createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(input.sha256, "hex");
    if (expected.length !== 32 || !NodeCrypto.timingSafeEqual(presented, expected)) return null;
    const certificate = new NodeCrypto.X509Certificate(bytes);
    const from = Date.parse(certificate.validFrom);
    const to = Date.parse(certificate.validTo);
    const key = certificate.publicKey;
    const name = `CN=${LAN_CERTIFICATE_SUBJECT}`;
    if (
      certificate.subject !== name ||
      certificate.issuer !== name ||
      certificate.ca ||
      certificate.subjectAltName !== undefined ||
      certificate.keyUsage?.length !== 1 ||
      certificate.keyUsage[0] !== CLIENT_AUTH ||
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !certificate.verify(key) ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      input.now < from ||
      input.now >= to ||
      to - from > input.generationMs + 11 * 60_000
    )
      return null;
    return certificate.toString();
  } catch {
    return null;
  }
}
