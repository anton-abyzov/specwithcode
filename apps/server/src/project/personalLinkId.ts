import { sha256 } from "../nodeCrypto.ts";

/**
 * The link id of a Connect account's one personal assistant (1448 D-11):
 * `logical:percy:` and the first 32 hex characters of SHA-256 of `percy:` and
 * the Connect user id. Every machine of the account computes the same id, so
 * none is chosen or passed around, and the user id itself is not in it.
 */
export const personalLinkIdForAccount = (cloudUserId: string): string =>
  `logical:percy:${sha256([`percy:${cloudUserId}`], "hex").slice(0, 32)}`;
