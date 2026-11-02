// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no X25519, HKDF or AES-GCM.
/**
 * Encrypts a secret file for one transfer, so the relay that carries the
 * request and any log along the way see only ciphertext. The receiver makes a
 * key for this transfer alone; the sender seals to it with a key of its own.
 *
 * This hides the file from anything that only reads traffic. It does not prove
 * who holds the receiving key: fleet machines pin each other's identity by
 * environment id, not by a public key, so an active relay could swap keys.
 */
import * as NodeCrypto from "node:crypto";

const INFO = Buffer.from("specwithcode file transfer v1");

export interface ReceivingKey {
  /** Base64 DER of the public half, safe to send. */
  readonly publicKey: string;
  readonly privateKey: NodeCrypto.KeyObject;
}

export const newReceivingKey = (): ReceivingKey => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
};

const importPublic = (base64: string) =>
  NodeCrypto.createPublicKey({
    key: Buffer.from(base64, "base64"),
    type: "spki",
    format: "der",
  });

const contentKey = (
  privateKey: NodeCrypto.KeyObject,
  publicKey: NodeCrypto.KeyObject,
  salt: Uint8Array,
) =>
  Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      NodeCrypto.diffieHellman({ privateKey, publicKey }),
      salt,
      INFO,
      32,
    ),
  );

export const seal = (plaintext: Uint8Array, recipientPublicKey: string): string => {
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    contentKey(ephemeral.privateKey, importPublic(recipientPublicKey), iv),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    ephemeral.publicKey.export({ type: "spki", format: "der" }),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]
    .map((part) => part.toString("base64"))
    .join(".");
};

export const unseal = (sealed: string, key: ReceivingKey): Buffer => {
  const [senderKey = "", ivText = "", tag = "", data = ""] = sealed.split(".");
  const iv = Buffer.from(ivText, "base64");
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    contentKey(key.privateKey, importPublic(senderKey), iv),
    iv,
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
};
