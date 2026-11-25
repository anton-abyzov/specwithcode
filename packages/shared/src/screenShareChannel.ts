/**
 * The sealed session between a viewer and the machine whose screen it shows
 * (screen sharing, 1490). Everything on the path between the two, the
 * machine's own server included, passes these bytes without reading them.
 *
 * Handshake, three messages:
 *
 * 1. hello (viewer): mode, a fresh X25519 key, the device's proof key,
 *    whether the viewer already holds this machine's screen-sharing key, and
 *    the hash of a random value it keeps back.
 * 2. challenge (machine): a nonce, a fresh X25519 key, the machine's Ed25519
 *    screen-sharing key and its signature over the transcript.
 * 3. proof (viewer): a JWS over the same transcript, signed with the device
 *    key the machine approved, revealing the random value. Its `typ` is not
 *    DPoP's, so neither verifier takes the other's token.
 *
 * The device signature is what protects the screen: the machine only ever
 * seals to a key that an approved device signed together with the machine's
 * own key and nonce. The machine signature protects the viewer from a
 * stand-in machine. The first time a viewer meets a machine it holds no key to
 * check, so a person reads a code off the machine's screen and types it into
 * the viewer (`screenShareSessionCode`): it comes from the session's secret
 * and the revealed value, which the machine could not know when it chose its
 * own keys, so it cannot hunt for a session whose code matches another one.
 * After the handshake each direction has its own
 * AES-256-GCM key and a counter that must never skip, repeat or go back.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

import { computeDpopJwkThumbprint, type DpopPublicJwk } from "./dpop.ts";

export const SCREEN_SHARE_PROTOCOL = "specwithcode screen share v1";
/** The proof's JWS type. DPoP's is `dpop+jwt`; the two must never match. */
export const SCREEN_SHARE_PROOF_TYP = "swc-screen-share+jws";
/** How far the proof's `iat` may be from the machine's clock, in seconds. */
export const SCREEN_SHARE_PROOF_MAX_SKEW_SECONDS = 60;
/** The largest sealed record either side accepts, in bytes. */
export const SCREEN_SHARE_MAX_RECORD_BYTES = 4 * 1024 * 1024;

export const SCREEN_SHARE_MODES = ["view"] as const;
export type ScreenShareMode = (typeof SCREEN_SHARE_MODES)[number];

export interface ScreenShareHello {
  readonly v: 1;
  readonly mode: ScreenShareMode;
  /** The viewer's X25519 key for this session, base64url. */
  readonly viewerKey: string;
  readonly deviceJwk: DpopPublicJwk;
  /** False when the viewer holds no saved key for this machine: the machine must then ask a person. */
  readonly knowsMachine: boolean;
  /** SHA-256 of a random value the viewer reveals only in its proof, base64url. */
  readonly commit: string;
}

export interface ScreenShareChallenge {
  readonly nonce: string;
  /** The machine's X25519 key for this session, base64url. */
  readonly targetKey: string;
  /** The machine's Ed25519 screen-sharing key, base64url. */
  readonly machineKey: string;
  readonly signature: string;
}

export interface ScreenShareProof {
  readonly jws: string;
}

export interface ScreenShareSessionKeys {
  readonly toViewer: Uint8Array;
  readonly toTarget: Uint8Array;
}

/** What a finished handshake gives each side. */
export interface ScreenShareSession {
  readonly keys: ScreenShareSessionKeys;
  /** Six digits a person carries from the machine's screen to the viewer on first use. */
  readonly code: string;
}

export type ScreenShareHandshakeFailure =
  | "malformed"
  | "unsupported_mode"
  | "machine_signature"
  | "machine_key_changed"
  | "device_key_mismatch"
  | "device_signature"
  | "transcript_mismatch"
  | "commit_mismatch"
  | "stale_proof";

export class ScreenShareHandshakeError extends Error {
  readonly reason: ScreenShareHandshakeFailure;
  constructor(reason: ScreenShareHandshakeFailure) {
    super(`Screen sharing handshake failed: ${reason}.`);
    this.name = "ScreenShareHandshakeError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Encoding.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const toBase64Url = (bytes: Uint8Array): string => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ScreenShareHandshakeError("malformed");
  const raw = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
};

const keyBytes = (text: unknown, length: number): Uint8Array<ArrayBuffer> => {
  if (typeof text !== "string") throw new ScreenShareHandshakeError("malformed");
  const bytes = fromBase64Url(text);
  if (bytes.length !== length) throw new ScreenShareHandshakeError("malformed");
  return bytes;
};

/** Length-prefixed parts, so no two different inputs give the same bytes. */
const framed = (...parts: ReadonlyArray<Uint8Array | string>): Uint8Array<ArrayBuffer> => {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + 4 + chunk.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const chunk of chunks) {
    view.setUint32(at, chunk.length);
    out.set(chunk, at + 4);
    at += 4 + chunk.length;
  }
  return out;
};

const isMode = (value: unknown): value is ScreenShareMode =>
  typeof value === "string" && (SCREEN_SHARE_MODES as ReadonlyArray<string>).includes(value);

const isP256Jwk = (value: unknown): value is DpopPublicJwk => {
  if (typeof value !== "object" || value === null) return false;
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string"
  );
};

const p256PublicBytes = (jwk: DpopPublicJwk): Uint8Array => {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(keyBytes(jwk.x, 32), 1);
  out.set(keyBytes(jwk.y, 32), 33);
  return out;
};

// ---------------------------------------------------------------------------
// Transcript, code and keys.

export interface ScreenShareTranscript {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly hello: ScreenShareHello;
  readonly nonce: string;
  readonly targetKey: string;
  readonly machineKey: string;
}

/** What both sides sign: every value that names or shapes the session. */
export const screenShareTranscriptHash = (transcript: ScreenShareTranscript): Uint8Array =>
  sha256(
    framed(
      SCREEN_SHARE_PROTOCOL,
      transcript.environmentId,
      transcript.sessionId,
      transcript.hello.mode,
      keyBytes(transcript.hello.viewerKey, 32),
      computeDpopJwkThumbprint(transcript.hello.deviceJwk),
      transcript.hello.knowsMachine ? "known" : "new",
      keyBytes(transcript.hello.commit, 32),
      keyBytes(transcript.nonce, 32),
      keyBytes(transcript.targetKey, 32),
      keyBytes(transcript.machineKey, 32),
    ),
  );

const sharedSecret = (secret: Uint8Array, theirKey: Uint8Array): Uint8Array => {
  const shared = x25519.getSharedSecret(secret, theirKey);
  // An all-zero secret means the other side sent a low-order point.
  if (shared.every((byte) => byte === 0)) throw new ScreenShareHandshakeError("malformed");
  return shared;
};

/**
 * The first-use code: six digits from the session's secret, the transcript and
 * the viewer's revealed value. Only the two ends can compute it, and it is
 * different for every session.
 */
export const screenShareSessionCode = (
  shared: Uint8Array,
  nonce: Uint8Array,
  transcriptHash: Uint8Array,
  reveal: Uint8Array,
): string => {
  const okm = hkdf(
    sha256,
    shared,
    nonce,
    framed(`${SCREEN_SHARE_PROTOCOL} code`, transcriptHash, reveal),
    4,
  );
  const value = new DataView(okm.buffer, okm.byteOffset, 4).getUint32(0) % 1_000_000;
  return value.toString().padStart(6, "0");
};

/** Whether what a person typed is the code, ignoring spaces. Constant time over the digits. */
export const screenShareCodeMatches = (typed: string, code: string): boolean => {
  const digits = typed.replace(/\s+/g, "");
  if (digits.length !== code.length) return false;
  let difference = 0;
  for (let at = 0; at < code.length; at += 1)
    difference |= digits.charCodeAt(at) ^ code.charCodeAt(at);
  return difference === 0;
};

const deriveSession = (
  shared: Uint8Array,
  nonce: Uint8Array,
  transcriptHash: Uint8Array,
  reveal: Uint8Array,
): ScreenShareSession => {
  const okm = hkdf(
    sha256,
    shared,
    nonce,
    framed(`${SCREEN_SHARE_PROTOCOL} keys`, transcriptHash),
    64,
  );
  return {
    keys: { toViewer: okm.slice(0, 32), toTarget: okm.slice(32, 64) },
    code: screenShareSessionCode(shared, nonce, transcriptHash, reveal),
  };
};

// ---------------------------------------------------------------------------
// Parsing what arrives.

export const parseScreenShareHello = (value: unknown): ScreenShareHello => {
  if (typeof value !== "object" || value === null) throw new ScreenShareHandshakeError("malformed");
  const hello = value as Record<string, unknown>;
  if (hello.v !== 1 || typeof hello.knowsMachine !== "boolean" || !isP256Jwk(hello.deviceJwk))
    throw new ScreenShareHandshakeError("malformed");
  if (!isMode(hello.mode)) throw new ScreenShareHandshakeError("unsupported_mode");
  keyBytes(hello.viewerKey, 32);
  keyBytes(hello.commit, 32);
  p256PublicBytes(hello.deviceJwk);
  return {
    v: 1,
    mode: hello.mode,
    viewerKey: hello.viewerKey as string,
    deviceJwk: {
      kty: "EC",
      crv: "P-256",
      x: hello.deviceJwk.x,
      y: hello.deviceJwk.y,
    } as DpopPublicJwk,
    knowsMachine: hello.knowsMachine,
    commit: hello.commit as string,
  };
};

export const parseScreenShareChallenge = (value: unknown): ScreenShareChallenge => {
  if (typeof value !== "object" || value === null) throw new ScreenShareHandshakeError("malformed");
  const challenge = value as Record<string, unknown>;
  keyBytes(challenge.nonce, 32);
  keyBytes(challenge.targetKey, 32);
  keyBytes(challenge.machineKey, 32);
  keyBytes(challenge.signature, 64);
  return {
    nonce: challenge.nonce as string,
    targetKey: challenge.targetKey as string,
    machineKey: challenge.machineKey as string,
    signature: challenge.signature as string,
  };
};

// ---------------------------------------------------------------------------
// The machine's screen-sharing key.

export interface ScreenShareMachineKey {
  /** Base64url of the 32-byte Ed25519 secret. Kept sealed by the app. */
  readonly secret: string;
  readonly publicKey: string;
}

export const newScreenShareMachineKey = (): ScreenShareMachineKey => {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret: toBase64Url(secret), publicKey: toBase64Url(ed25519.getPublicKey(secret)) };
};

/** Whether both halves decode to 32 bytes and the public half is the secret's own. */
export const isScreenShareMachineKey = (key: ScreenShareMachineKey): boolean => {
  try {
    const secret = keyBytes(key.secret, 32);
    const publicKey = keyBytes(key.publicKey, 32);
    const derived = ed25519.getPublicKey(secret);
    return derived.every((byte, index) => byte === publicKey[index]);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Viewer side.

export interface ScreenShareViewerStart {
  readonly hello: ScreenShareHello;
  /** The session's X25519 secret; lives only while the session does. */
  readonly secret: Uint8Array;
  /** The value `hello.commit` is the hash of; sent only inside the signed proof. */
  readonly reveal: Uint8Array;
}

export const startScreenShareViewer = (input: {
  readonly mode: ScreenShareMode;
  readonly deviceJwk: DpopPublicJwk;
  readonly knowsMachine: boolean;
}): ScreenShareViewerStart => {
  const secret = x25519.utils.randomPrivateKey();
  const reveal = crypto.getRandomValues(new Uint8Array(32));
  return {
    secret,
    reveal,
    hello: {
      v: 1,
      mode: input.mode,
      viewerKey: toBase64Url(x25519.getPublicKey(secret)),
      deviceJwk: {
        kty: "EC",
        crv: "P-256",
        x: input.deviceJwk.x,
        y: input.deviceJwk.y,
      } as DpopPublicJwk,
      knowsMachine: input.knowsMachine,
      commit: toBase64Url(sha256(reveal)),
    },
  };
};

export interface ScreenShareViewerAnswer extends ScreenShareSession {
  readonly proof: ScreenShareProof;
  /** The machine key this session was checked against; save it only once the code was typed. */
  readonly machineKey: string;
}

/**
 * Checks the machine's challenge and signs the proof. `sign` gets the bytes to
 * sign and returns the ES256 signature as 64 bytes (r then s), which is what
 * WebCrypto's ECDSA gives for a P-256 key.
 */
export const answerScreenShareChallenge = async (input: {
  readonly start: ScreenShareViewerStart;
  readonly challenge: unknown;
  readonly environmentId: string;
  readonly sessionId: string;
  /** The key saved for this machine, if any. A different one is refused. */
  readonly pinnedMachineKey: string | undefined;
  readonly nowEpochSeconds: number;
  readonly sign: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}): Promise<ScreenShareViewerAnswer> => {
  const challenge = parseScreenShareChallenge(input.challenge);
  // A viewer that said it knows the machine must hold a key, and the reverse.
  if (input.start.hello.knowsMachine !== (input.pinnedMachineKey !== undefined))
    throw new ScreenShareHandshakeError("malformed");
  if (input.pinnedMachineKey !== undefined && input.pinnedMachineKey !== challenge.machineKey)
    throw new ScreenShareHandshakeError("machine_key_changed");
  const transcriptHash = screenShareTranscriptHash({
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    hello: input.start.hello,
    nonce: challenge.nonce,
    targetKey: challenge.targetKey,
    machineKey: challenge.machineKey,
  });
  let signed = false;
  try {
    signed = ed25519.verify(
      keyBytes(challenge.signature, 64),
      transcriptHash,
      keyBytes(challenge.machineKey, 32),
    );
  } catch {
    signed = false;
  }
  if (!signed) throw new ScreenShareHandshakeError("machine_signature");

  const header = toBase64Url(
    encoder.encode(
      JSON.stringify({
        typ: SCREEN_SHARE_PROOF_TYP,
        alg: "ES256",
        jwk: input.start.hello.deviceJwk,
      }),
    ),
  );
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: input.environmentId,
        sid: input.sessionId,
        mode: input.start.hello.mode,
        th: toBase64Url(transcriptHash),
        iat: Math.floor(input.nowEpochSeconds),
        r: toBase64Url(input.start.reveal),
      }),
    ),
  );
  const signature = await input.sign(encoder.encode(`${header}.${payload}`));
  if (signature.length !== 64) throw new ScreenShareHandshakeError("device_signature");
  return {
    proof: { jws: `${header}.${payload}.${toBase64Url(signature)}` },
    ...deriveSession(
      sharedSecret(input.start.secret, keyBytes(challenge.targetKey, 32)),
      keyBytes(challenge.nonce, 32),
      transcriptHash,
      input.start.reveal,
    ),
    machineKey: challenge.machineKey,
  };
};

// ---------------------------------------------------------------------------
// Machine side.

export interface ScreenShareTargetStart {
  readonly challenge: ScreenShareChallenge;
  readonly hello: ScreenShareHello;
  readonly deviceThumbprint: string;
  readonly transcriptHash: Uint8Array;
  readonly secret: Uint8Array;
}

/**
 * Answers a viewer's hello. `attestedThumbprint` is the device key the
 * machine's server tied to the viewer's socket; a hello naming another key
 * stops here.
 */
export const startScreenShareTarget = (input: {
  readonly hello: unknown;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly attestedThumbprint: string;
  readonly machineKey: ScreenShareMachineKey;
}): ScreenShareTargetStart => {
  const hello = parseScreenShareHello(input.hello);
  const deviceThumbprint = computeDpopJwkThumbprint(hello.deviceJwk);
  if (deviceThumbprint !== input.attestedThumbprint)
    throw new ScreenShareHandshakeError("device_key_mismatch");
  const secret = x25519.utils.randomPrivateKey();
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const targetKey = toBase64Url(x25519.getPublicKey(secret));
  const transcriptHash = screenShareTranscriptHash({
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    hello,
    nonce,
    targetKey,
    machineKey: input.machineKey.publicKey,
  });
  return {
    hello,
    deviceThumbprint,
    secret,
    transcriptHash,
    challenge: {
      nonce,
      targetKey,
      machineKey: input.machineKey.publicKey,
      signature: toBase64Url(ed25519.sign(transcriptHash, keyBytes(input.machineKey.secret, 32))),
    },
  };
};

const jsonPart = (text: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(fromBase64Url(text)));
  } catch {
    throw new ScreenShareHandshakeError("malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ScreenShareHandshakeError("malformed");
  return value as Record<string, unknown>;
};

/** Checks the viewer's proof against the challenge this machine sent, and gives the session. */
export const acceptScreenShareProof = (input: {
  readonly start: ScreenShareTargetStart;
  readonly proof: unknown;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly nowEpochSeconds: number;
}): ScreenShareSession => {
  const jws =
    typeof input.proof === "object" && input.proof !== null
      ? (input.proof as Record<string, unknown>).jws
      : undefined;
  if (typeof jws !== "string" || jws.length > 4096)
    throw new ScreenShareHandshakeError("malformed");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new ScreenShareHandshakeError("malformed");
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  const header = jsonPart(headerText);
  const payload = jsonPart(payloadText);
  if (header.typ !== SCREEN_SHARE_PROOF_TYP || header.alg !== "ES256" || !isP256Jwk(header.jwk))
    throw new ScreenShareHandshakeError("malformed");
  if (computeDpopJwkThumbprint(header.jwk) !== input.start.deviceThumbprint)
    throw new ScreenShareHandshakeError("device_key_mismatch");
  let signed = false;
  try {
    signed = p256.verify(
      keyBytes(signatureText, 64),
      sha256(encoder.encode(`${headerText}.${payloadText}`)),
      p256PublicBytes(input.start.hello.deviceJwk),
      { prehash: false, format: "compact" },
    );
  } catch {
    signed = false;
  }
  if (!signed) throw new ScreenShareHandshakeError("device_signature");
  if (
    payload.aud !== input.environmentId ||
    payload.sid !== input.sessionId ||
    payload.mode !== input.start.hello.mode ||
    payload.th !== toBase64Url(input.start.transcriptHash)
  )
    throw new ScreenShareHandshakeError("transcript_mismatch");
  if (
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    Math.abs(input.nowEpochSeconds - payload.iat) > SCREEN_SHARE_PROOF_MAX_SKEW_SECONDS
  )
    throw new ScreenShareHandshakeError("stale_proof");
  const reveal = keyBytes(payload.r, 32);
  if (toBase64Url(sha256(reveal)) !== input.start.hello.commit)
    throw new ScreenShareHandshakeError("commit_mismatch");
  return deriveSession(
    sharedSecret(input.start.secret, keyBytes(input.start.hello.viewerKey, 32)),
    keyBytes(input.start.challenge.nonce, 32),
    input.start.transcriptHash,
    reveal,
  );
};

// ---------------------------------------------------------------------------
// Sealed records.

const RECORD_HEADER_BYTES = 9;
const GCM_TAG_BYTES = 16;

export class ScreenShareRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenShareRecordError";
  }
}

const importAesKey = (key: Uint8Array, usage: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [usage]);

const recordNonce = (counter: bigint): Uint8Array<ArrayBuffer> => {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, counter);
  return nonce;
};

const recordAad = (sessionId: string, type: number, counter: bigint): Uint8Array<ArrayBuffer> => {
  const head = new Uint8Array(RECORD_HEADER_BYTES);
  head[0] = type;
  new DataView(head.buffer).setBigUint64(1, counter);
  return framed(SCREEN_SHARE_PROTOCOL, sessionId, head);
};

export interface ScreenShareSealer {
  /**
   * Seals one record. Results resolve in the order of the calls, which is the
   * order to send them in. Once one fails every later one fails too: its
   * counter is spent, so the other side could never open what follows.
   */
  readonly seal: (type: number, data: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
}

export const makeScreenShareSealer = (key: Uint8Array, sessionId: string): ScreenShareSealer => {
  const aes = importAesKey(key, "encrypt");
  let counter = 0n;
  let broken = false;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    seal: (type, data) => {
      if (!Number.isInteger(type) || type < 0 || type > 255)
        return Promise.reject(new ScreenShareRecordError("Bad record type."));
      if (data.length + RECORD_HEADER_BYTES + GCM_TAG_BYTES > SCREEN_SHARE_MAX_RECORD_BYTES)
        return Promise.reject(new ScreenShareRecordError("Record too large."));
      const mine = counter;
      counter += 1n;
      const sealed = tail.then(async () => {
        if (broken) throw new ScreenShareRecordError("The session already failed.");
        const body = new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: recordNonce(mine),
              additionalData: recordAad(sessionId, type, mine),
            },
            await aes,
            new Uint8Array(data),
          ),
        );
        const out = new Uint8Array(RECORD_HEADER_BYTES + body.length);
        out[0] = type;
        new DataView(out.buffer).setBigUint64(1, mine);
        out.set(body, RECORD_HEADER_BYTES);
        return out;
      });
      tail = sealed.catch(() => {
        broken = true;
      });
      return sealed;
    },
  };
};

export interface ScreenShareOpenedRecord {
  readonly type: number;
  readonly data: Uint8Array<ArrayBuffer>;
}

export interface ScreenShareOpener {
  /**
   * Opens the next record. Anything changed, repeated, skipped or out of order
   * throws, and the opener then refuses everything after it: the session is over.
   */
  readonly open: (record: Uint8Array) => Promise<ScreenShareOpenedRecord>;
}

export const makeScreenShareOpener = (key: Uint8Array, sessionId: string): ScreenShareOpener => {
  const aes = importAesKey(key, "decrypt");
  let expected = 0n;
  let broken = false;
  let tail: Promise<unknown> = Promise.resolve();
  const fail = (message: string): never => {
    broken = true;
    throw new ScreenShareRecordError(message);
  };
  return {
    open: (record) => {
      const opened = tail.then(async () => {
        if (broken) return fail("The session already failed.");
        if (
          record.length < RECORD_HEADER_BYTES + GCM_TAG_BYTES ||
          record.length > SCREEN_SHARE_MAX_RECORD_BYTES
        )
          return fail("Bad record size.");
        const type = record[0]!;
        const counter = new DataView(
          record.buffer,
          record.byteOffset,
          record.byteLength,
        ).getBigUint64(1);
        if (counter !== expected) return fail("Record out of order.");
        let data: Uint8Array<ArrayBuffer>;
        try {
          data = new Uint8Array(
            await crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: recordNonce(counter),
                additionalData: recordAad(sessionId, type, counter),
              },
              await aes,
              new Uint8Array(record.subarray(RECORD_HEADER_BYTES)),
            ),
          );
        } catch {
          return fail("Record did not open.");
        }
        expected += 1n;
        return { type, data };
      });
      tail = opened.catch(() => undefined);
      return opened;
    },
  };
};
