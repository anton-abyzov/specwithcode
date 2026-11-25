// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure synchronous hash used to name a file.
import * as NodeCrypto from "node:crypto";

import { isValidSecretName } from "../auth/ServerSecretStore.ts";

/**
 * The secret-store name of a replay marker. Proof fields are relay-signed text
 * of any shape, so the name carries their SHA-256, never the text itself: a
 * `jti` such as `../x` cannot name a file outside the secrets folder.
 */
export const replayMarkerName = (prefix: string, proofValue: string): string =>
  `${prefix}${NodeCrypto.createHash("sha256").update(proofValue, "utf8").digest("hex")}`;

/**
 * The name an earlier build gave the same marker: the proof text itself. A
 * proof that build already accepted is still within its lifetime after an
 * upgrade, so its old marker is read too. A text that never made a valid name
 * was never stored under one.
 */
export const legacyReplayMarkerName = (prefix: string, proofValue: string): string | undefined =>
  isValidSecretName(`${prefix}${proofValue}`) ? `${prefix}${proofValue}` : undefined;
