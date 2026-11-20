// @effect-diagnostics nodeBuiltinImport:off - the receiving key is a private file beside the copy's record.
/**
 * The receiving key of one folder copy, on the destination. A window that may
 * not send secrets the plain way asks the source to send them sealed: the
 * source asks this machine for a key over the fleet link, seals each secret
 * file to it, and this machine opens them when it pulls. The transfer token
 * travels through the window; this key never leaves this machine, so the token
 * alone yields only ciphertext.
 *
 * The private half sits in the copy's own folder (mode 0600, like the record
 * that already holds the transfer token) and is removed once the secrets are in.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { type ReceivingKey, unseal } from "../fileTransfer/seal.ts";
import { exists, readJson, writeJson } from "./durable.ts";

export const SECRETS_KEY_FILE = "secrets-key.json";

interface StoredKey {
  readonly version: 1;
  /** Base64 DER (SPKI), the half the source seals to. */
  readonly publicKey: string;
  /** Base64 DER (PKCS8). Never sent anywhere. */
  readonly privateKey: string;
  readonly createdAt: string;
}

const keyFile = (directory: string) => NodePath.join(directory, SECRETS_KEY_FILE);

const readStored = async (directory: string): Promise<StoredKey | null> => {
  const file = keyFile(directory);
  if (!(await exists(file))) return null;
  const stored = await readJson<StoredKey>(file).catch(() => null);
  return stored !== null &&
    stored.version === 1 &&
    typeof stored.publicKey === "string" &&
    typeof stored.privateKey === "string"
    ? stored
    : null;
};

/**
 * The public half of this copy's receiving key, made on first use. Asking again
 * returns the same key, so a source that retries seals to the key kept here.
 */
export async function receivingKeyFor(directory: string, now: string): Promise<string> {
  const stored = await readStored(directory);
  if (stored !== null) return stored.publicKey;
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
  const created: StoredKey = {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: now,
  };
  await writeJson(keyFile(directory), created);
  return created.publicKey;
}

/** The plain bytes of one sealed secret body, or null when no key here opens it. */
export async function openSealedSecret(
  directory: string,
  sealed: Uint8Array,
): Promise<Uint8Array | null> {
  const stored = await readStored(directory);
  if (stored === null) return null;
  try {
    const key: ReceivingKey = {
      publicKey: stored.publicKey,
      privateKey: NodeCrypto.createPrivateKey({
        key: Buffer.from(stored.privateKey, "base64"),
        type: "pkcs8",
        format: "der",
      }),
    };
    return new Uint8Array(unseal(Buffer.from(sealed).toString("utf8"), key));
  } catch {
    // Sealed to another key, cut short or changed on the way: nothing is written.
    return null;
  }
}

/** The secrets are in (or the copy ended): the key has no further use. */
export async function dropReceivingKey(directory: string): Promise<void> {
  await NodeFSP.rm(keyFile(directory), { force: true });
}
