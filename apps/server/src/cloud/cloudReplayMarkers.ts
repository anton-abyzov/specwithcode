import * as NodeCrypto from "node:crypto";

/**
 * The secret-store name of a replay marker. Proof fields are relay-signed text
 * of any shape, so the name carries their SHA-256, never the text itself: a
 * `jti` such as `../x` cannot name a file outside the secrets folder.
 */
export const replayMarkerName = (prefix: string, proofValue: string): string =>
  `${prefix}${NodeCrypto.createHash("sha256").update(proofValue, "utf8").digest("hex")}`;
