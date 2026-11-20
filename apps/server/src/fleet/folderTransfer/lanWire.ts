// @effect-diagnostics nodeBuiltinImport:off - hashes, tokens and constant-time comparison.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

/**
 * The local-network path of a folder copy: the shared words, limits and hashes
 * of both machines (1334 S-1 to S-9). Nothing here opens a socket.
 *
 * No address, port, certificate hash or token is ever put in an error message
 * or a log line by this path (S-10). Failures carry a class from the fallback
 * table and nothing else.
 */
export const LAN_ALPN = "swc-folder-lan/1";
export const LAN_TOKEN_PREFIX = "swclan_";
export const LAN_CERTIFICATE_SUBJECT = "swc-folder-lan";

/** The file classes a copy may ever select; `secret` is never among them (S-5). */
export const LAN_SELECTION_CEILING: ReadonlyArray<string> = [
  "ignoredData",
  "rebuildable",
  "repository",
  "tracked",
  "untracked",
];

/** Source listener budgets (S-8). Tests pass shorter deadlines, never larger sizes. */
export interface LanSourceLimits {
  readonly liveGenerations: number;
  readonly liveGenerationsPerDestination: number;
  readonly generationsPerOperationPerHour: number;
  readonly addressesPerOffer: number;
  readonly handshakesPerAddress: number;
  readonly handshakesTotal: number;
  readonly failedHandshakesPerMinute: number;
  readonly failedHandshakeBlockMs: number;
  readonly authenticatedSockets: number;
  readonly chunkReadsPerOperation: number;
  readonly chunkReadsTotal: number;
  readonly handshakeMs: number;
  readonly headerBytes: number;
  readonly headerMs: number;
  readonly bodyBytes: number;
  readonly bodyMs: number;
  readonly stallBytes: number;
  readonly stallMs: number;
  readonly idleSocketMs: number;
  readonly idleGenerationMs: number;
  readonly absoluteMs: number;
}

export const LAN_SOURCE_LIMITS: LanSourceLimits = Object.freeze({
  liveGenerations: 4,
  liveGenerationsPerDestination: 2,
  generationsPerOperationPerHour: 6,
  addressesPerOffer: 4,
  handshakesPerAddress: 2,
  handshakesTotal: 16,
  failedHandshakesPerMinute: 10,
  failedHandshakeBlockMs: 60_000,
  authenticatedSockets: 4,
  chunkReadsPerOperation: 4,
  chunkReadsTotal: 8,
  handshakeMs: 5_000,
  headerBytes: 8 * 1024,
  headerMs: 2_000,
  bodyBytes: 128 * 1024,
  bodyMs: 10_000,
  stallBytes: 64 * 1024,
  stallMs: 30_000,
  idleSocketMs: 60_000,
  idleGenerationMs: 15 * 60_000,
  absoluteMs: 2 * 60 * 60_000,
});

/** Destination client budgets (S-8). */
export interface LanClientLimits {
  readonly connectMs: number;
  readonly setupMs: number;
  readonly headersMs: number;
  readonly progressBytes: number;
  readonly progressMs: number;
  readonly manifestMs: number;
  readonly chunksMs: number;
  readonly connections: number;
  readonly chunkWireBytes: number;
  readonly chunkExpandedBytes: number;
  readonly manifestWireBytes: number;
  readonly manifestExpandedBytes: number;
  readonly manifestEntries: number;
  readonly manifestLineBytes: number;
  readonly smallAnswerBytes: number;
  /** The destination ends its side a little before the source's 15 minutes. */
  readonly idleGenerationMs: number;
}

export const LAN_CLIENT_LIMITS: LanClientLimits = Object.freeze({
  connectMs: 1_500,
  setupMs: 5_000,
  headersMs: 10_000,
  progressBytes: 256 * 1024,
  progressMs: 15_000,
  manifestMs: 10 * 60_000,
  chunksMs: 5 * 60_000,
  connections: 4,
  chunkWireBytes: 65 * 1024 * 1024,
  chunkExpandedBytes: 65 * 1024 * 1024,
  manifestWireBytes: 256 * 1024 * 1024,
  manifestExpandedBytes: 2 * 1024 * 1024 * 1024,
  manifestEntries: 2_000_000,
  manifestLineBytes: 64 * 1024,
  smallAnswerBytes: 16 * 1024,
  idleGenerationMs: 14 * 60_000,
});

/** Why a generation ended; never shown with an address. */
export type LanEndCause =
  | "terminal"
  | "denied"
  | "rotated"
  | "setting_off"
  | "latched"
  | "idle"
  | "expired"
  | "network_changed"
  | "woke"
  | "shutdown"
  /** The other machine said its side ended. */
  | "retired"
  /** The source built another manifest: the one this generation published is gone. */
  | "manifest_changed";

/** A recorded denial: an authenticated answer about authorization (S-4). */
export type LanDenial = "revoked" | "refused" | "scope_changed";
export const LAN_DENIALS: ReadonlyArray<LanDenial> = ["revoked", "refused", "scope_changed"];

/** What the destination saw on the local network, by the fallback table. */
export type LanFailureKind =
  | "unreachable"
  | "wrong_pin"
  | "wrong_identity"
  | "denied"
  | "not_authorization";

/** A failure of the local-network path. Its message is its class and nothing else. */
export class LanFailure extends Error {
  readonly kind: LanFailureKind;
  readonly denial: LanDenial | "unauthorized" | null;
  constructor(kind: LanFailureKind, denial: LanDenial | "unauthorized" | null = null) {
    super(kind);
    this.kind = kind;
    this.denial = denial;
  }
  /** A denial stops the copy on both paths; everything else switches once to Connect. */
  get stops(): boolean {
    return this.kind === "denied";
  }
}

/** The S-4 row for an HTTP status that arrived inside an authenticated session. */
export function lanFailureForStatus(status: number, error?: unknown): LanFailure {
  if (status === 401) return new LanFailure("denied", "unauthorized");
  if (status === 403)
    return new LanFailure(
      "denied",
      LAN_DENIALS.includes(error as LanDenial) ? (error as LanDenial) : "unauthorized",
    );
  return new LanFailure("not_authorization");
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * AC-12: an IP literal in RFC 1918 or fc00::/7 and nothing else. No hostname, no
 * zone id, no mapped or compatible IPv4, no CGNAT, link-local or global address.
 */
export function admitLanHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 45) return false;
  if (host.includes("%") || host.includes("[") || host.includes("]")) return false;
  const v4 = IPV4.exec(host);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((part) => part > 255)) return false;
    // Canonical spelling only: no leading zeros that another parser reads as octal.
    if (`${a}.${b}.${c}.${d}` !== host) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (NodeNet.isIP(host) !== 6) return false;
  if (host.includes(".")) return false;
  const first = parseInt(host.split(":")[0] ?? "", 16);
  return Number.isInteger(first) && first >= 0xfc00 && first <= 0xfdff;
}

const framed = (tag: string, fields: ReadonlyArray<string>) => {
  const hash = NodeCrypto.createHash("sha256").update(tag, "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
};

export function lanScopeSha256(input: {
  readonly sourceProjectId: string;
  readonly copyRoot: string;
  readonly projectRelativePath: string;
  readonly mode: string;
  /** The classes approved for this copy; never the whole list by default. */
  readonly ceiling: ReadonlyArray<string>;
}): string {
  return framed("swc-folder-lan-scope-v1", [
    input.sourceProjectId,
    input.copyRoot,
    input.projectRelativePath,
    input.mode,
    [...new Set(input.ceiling)].sort().join(","),
  ]);
}

/**
 * The selection ceiling a copy is frozen to: the approved classes, sorted. Null when
 * the selection is empty or names a class that never travels the local network.
 */
export function lanCeilingOf(selection: ReadonlyArray<string>): ReadonlyArray<string> | null {
  const ceiling = [...new Set(selection)].sort();
  return ceiling.length === 0 || ceiling.some((item) => !LAN_SELECTION_CEILING.includes(item))
    ? null
    : ceiling;
}

export function lanTargetSha256(input: {
  readonly targetPath: string;
  readonly kind: "empty" | "reviewed";
}): string {
  return framed("swc-folder-lan-target-v1", [input.targetPath, input.kind]);
}

export function lanBindingSha256(input: {
  readonly sourceEnvironmentId: string;
  readonly destinationEnvironmentId: string;
  readonly operationId: string;
  readonly purpose: string;
  readonly scopeSha256: string;
  readonly targetSha256: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly sourceCertificateSha256: string;
  readonly recipientCertificateSha256: string;
}): string {
  return framed("swc-folder-lan-binding-v1", [
    input.sourceEnvironmentId,
    input.destinationEnvironmentId,
    input.operationId,
    input.purpose,
    input.scopeSha256,
    input.targetSha256,
    String(input.generation),
    String(input.expiresAt),
    input.sourceCertificateSha256,
    input.recipientCertificateSha256,
  ]);
}

export const sha256Of = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Constant-time comparison of two SHA-256 hex strings. */
export function sameSha256(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && NodeCrypto.timingSafeEqual(a, b);
}

/** A bearer for one generation on the local network only; the source keeps its hash. */
export function mintLanToken(): { readonly token: string; readonly sha256: string } {
  const token = `${LAN_TOKEN_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
  return { token, sha256: sha256Of(token) };
}

export function lanTokenMatches(presented: string | null, storedSha256: string): boolean {
  if (!presented || !presented.startsWith(LAN_TOKEN_PREFIX)) return false;
  return sameSha256(sha256Of(presented), storedSha256);
}

/** The purpose a destination record stands for; null means no local-network path. */
export function lanPurposeOfDestination(record: {
  readonly purpose?: string | undefined;
  readonly mode: string;
}): "sync-measured" | "add-whole-folder" | null {
  if (record.mode !== "copy-only") return null;
  if (record.purpose === "review") return "sync-measured";
  if (record.purpose === "add-to-machine") return "add-whole-folder";
  return null;
}

/** Whether `host` is inside the on-link prefix of `address/prefix` (same family). */
export function insidePrefix(address: string, prefix: number, host: string): boolean {
  const a = toBytes(address);
  const b = toBytes(host);
  if (!a || !b || a.length !== b.length) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.length * 8) return false;
  for (let bit = 0; bit < prefix; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    if ((a[bit >> 3]! & mask) !== (b[bit >> 3]! & mask)) return false;
  }
  return true;
}

function toBytes(host: string): Uint8Array | null {
  const family = NodeNet.isIP(host);
  if (family === 4) return Uint8Array.from(host.split(".").map(Number));
  if (family !== 6 || host.includes(".") || host.includes("%")) return null;
  const [head, tail] = host.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (tail === undefined && left.length !== 8) return null;
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}
