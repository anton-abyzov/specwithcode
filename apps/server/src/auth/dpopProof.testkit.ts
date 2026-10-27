// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no KeyObject, generateKeyPairSync, or sign.
import * as NodeCrypto from "node:crypto";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
  normalizeDpopHtu,
} from "@specweave-studio/shared/dpop";

export interface TestDpopKey {
  readonly thumbprint: string;
  /** An ES256 `dpop+jwt` for `method url`, bound to `accessToken` when given. */
  readonly proof: (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
    readonly iat?: number;
    readonly jti?: string;
    /** Omit `ath` even though a token is given. */
    readonly withoutAth?: boolean;
  }) => string;
}

/** A fresh P-256 key that signs DPoP proofs the way a coordinator would. */
export function makeTestDpopKey(): TestDpopKey {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk = { kty: "EC", crv: "P-256", x: exported.x, y: exported.y } as DpopPublicJwk;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    proof: (input) => {
      const header = Buffer.from(
        JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          htm: input.method,
          htu: normalizeDpopHtu(input.url),
          jti: input.jti ?? NodeCrypto.randomUUID(),
          // @effect-diagnostics-next-line globalDate:off -- DPoP proofs carry wall-clock seconds.
          iat: input.iat ?? Math.floor(Date.now() / 1000),
          ...(input.accessToken && !input.withoutAth
            ? { ath: computeDpopAccessTokenHash(input.accessToken) }
            : {}),
        }),
      ).toString("base64url");
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
}
