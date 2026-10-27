/**
 * This machine's fleet proof key: the P-256 key every management token it
 * holds over SpecWithCode Connect is bound to (DPoP, RFC 9449). The key lives
 * in `<baseDir>/studio-fleet-key.json` beside the fleet file, so the CLI and
 * the server share it, and it is read with the same care as the fleet file:
 * no symlink, owner only, mode 0600.
 *
 * A token bound to this key is useless to anyone who captures it on the way
 * (Cloudflare terminates TLS on a tunnel): every request needs a fresh proof
 * for that method and URL, signed by this key.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - O_NOFOLLOW is required; Effect FileSystem does not expose numeric open flags.
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - exclusive create (link) and a no-follow read on one descriptor.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's Crypto has no KeyObject, generateKeyPair, or sign.
import * as NodeCrypto from "node:crypto";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
  normalizeDpopHtu,
} from "@specweave-studio/shared/dpop";

import { join } from "../nodePath.ts";

export const FLEET_PROOF_KEY_FILE = "studio-fleet-key.json";

export interface FleetProofKey {
  /** RFC 7638 thumbprint of the public key, as a bound token's `jkt` names it. */
  readonly thumbprint: string;
  /** An ES256 `dpop+jwt` for `method url`, bound to `accessToken` when given. */
  readonly proof: (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
  }) => Promise<string>;
}

export class FleetProofKeyError extends Error {
  constructor() {
    super("This machine's fleet key could not be read securely.");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPart = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{40,60}$/.test(value);

interface StoredKey {
  readonly v: 1;
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

function decodeStoredKey(raw: unknown): StoredKey {
  if (
    !isRecord(raw) ||
    raw.v !== 1 ||
    raw.kty !== "EC" ||
    raw.crv !== "P-256" ||
    !isPart(raw.x) ||
    !isPart(raw.y) ||
    !isPart(raw.d) ||
    Object.keys(raw).some((key) => !["v", "kty", "crv", "x", "y", "d"].includes(key))
  )
    throw new FleetProofKeyError();
  return { v: 1, kty: "EC", crv: "P-256", x: raw.x, y: raw.y, d: raw.d };
}

function keyFrom(stored: StoredKey): FleetProofKey {
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: stored.x,
    y: stored.y,
  } as DpopPublicJwk;
  let privateKey: NodeCrypto.KeyObject;
  try {
    privateKey = NodeCrypto.createPrivateKey({
      key: { kty: "EC", crv: "P-256", x: stored.x, y: stored.y, d: stored.d },
      format: "jwk",
    });
  } catch {
    throw new FleetProofKeyError();
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    proof: async (input) => {
      const htu = normalizeDpopHtu(input.url);
      if (htu === null) throw new FleetProofKeyError();
      const payload = encode({
        htm: input.method.toUpperCase(),
        htu,
        jti: NodeCrypto.randomUUID(),
        // @effect-diagnostics-next-line globalDate:off - a plain async helper shared with the CLI; the proof's iat is wall-clock time.
        iat: Math.floor(Date.now() / 1000),
        ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
      });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
}

/** The stored key, or null when there is none. Refuses a link, a foreign owner or a readable mode. */
async function readStoredKey(baseDir: string): Promise<StoredKey | null> {
  const path = join(baseDir, FLEET_PROOF_KEY_FILE);
  const windows = process.platform === "win32";
  let file: NodeFSP.FileHandle | undefined;
  try {
    if (windows && (await NodeFSP.lstat(path)).isSymbolicLink()) throw new FleetProofKeyError();
    file = await NodeFSP.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (!windows && (stat.mode & 0o077) !== 0) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new FleetProofKeyError();
    return decodeStoredKey(JSON.parse(await file.readFile("utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new FleetProofKeyError();
  } finally {
    await file?.close();
  }
}

/** This machine's fleet key, or null when it has none. Never creates one. */
export async function readFleetProofKey(baseDir: string): Promise<FleetProofKey | null> {
  const stored = await readStoredKey(baseDir);
  return stored === null ? null : keyFrom(stored);
}

/**
 * This machine's fleet key, made on first use. The file appears whole or not
 * at all (written to a private temp file, then hard-linked into place, which
 * fails if another writer got there first), so two concurrent callers end up
 * with the same key.
 */
export async function loadOrCreateFleetProofKey(baseDir: string): Promise<FleetProofKey> {
  const existing = await readStoredKey(baseDir);
  if (existing !== null) return keyFrom(existing);
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const stored = decodeStoredKey({ v: 1, kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d });
  const path = join(baseDir, FLEET_PROOF_KEY_FILE);
  const temp = join(
    baseDir,
    `.${FLEET_PROOF_KEY_FILE}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const file = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await NodeFSP.link(temp, path);
    } catch (error) {
      if (!(isRecord(error) && error.code === "EEXIST")) throw new FleetProofKeyError();
    }
  } finally {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
  }
  const winner = await readStoredKey(baseDir);
  if (winner === null) throw new FleetProofKeyError();
  return keyFrom(winner);
}

/** The DPoP key thumbprint a Studio access token is bound to (`jkt`), if any. */
export function tokenProofThumbprint(token: string): string | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(claims) &&
      typeof claims.jkt === "string" &&
      claims.jkt.length > 0 &&
      claims.jkt.length <= 128
      ? claims.jkt
      : undefined;
  } catch {
    return undefined;
  }
}
