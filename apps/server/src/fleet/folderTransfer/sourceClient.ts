// @effect-diagnostics globalTimers:off - plain async client shared by the destination worker and tests.
import { parseFleetOrigin } from "../fleetOrigin.ts";
import { LanFailure, type LanFailureKind } from "./lanWire.ts";
import type { ManifestEntry, ManifestHeader } from "./manifest.ts";
import { readManifestBytes } from "./manifest.ts";
import {
  decodeFrames,
  FOLDER_TRANSFER_PREFIX,
  SEALED_SECRET_CONTENT_TYPE,
  zstdAvailable,
  type ChunkFrame,
} from "./wire.ts";

export type SourceClientErrorCode =
  | "unsupported_url"
  | "unreachable"
  | "outdated_source"
  | "unauthorized"
  | "wrong_machine"
  | "refused";

export class SourceClientError extends Error {
  readonly code: SourceClientErrorCode;
  readonly status: number | null;
  constructor(code: SourceClientErrorCode, status: number | null = null, detail?: string) {
    super(detail ?? code);
    this.code = code;
    this.status = status;
  }
}

/** The source's files changed after the saved scan; the scan itself is intact. */
export class StaleScanError extends SourceClientError {}
/** The reviewed artifact cannot be used, even when the destination is empty. */
export class UnavailableSnapshotError extends SourceClientError {}

/**
 * The destination reaches the source only over the source's private HTTPS name
 * on the tailnet (`*.ts.net`) or its SpecWithCode Connect address, by the same
 * rule as the fleet file. Loopback is accepted only when the destination's
 * operator set STUDIO_FOLDER_TRANSFER_ALLOW_LOOPBACK for isolated tests.
 */
export function checkSourceUrl(value: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceClientError("unsupported_url");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new SourceClientError("unsupported_url");
  const fleet = parseFleetOrigin(url.origin) !== null;
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!fleet && !loopback) throw new SourceClientError("unsupported_url");
  return new URL(url.origin);
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export interface SourceClientOptions {
  readonly baseUrl: string;
  /**
   * A second address of the same source (its SpecWithCode Connect address),
   * checked by the same rule. A network failure or 5xx moves to the other
   * address; a 4xx is final on either.
   */
  readonly fallbackBaseUrl?: string | undefined;
  /**
   * The source machine's environment id. The fallback address is used only
   * after its `/.well-known/studio/environment` answers with this id, so the
   * transfer token never goes to another machine's address; without it the
   * fallback is ignored.
   */
  readonly expectedEnvironmentId?: string | undefined;
  readonly operationId: string;
  readonly token: string;
  readonly allowLoopback?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  /** False makes every request a single attempt: background calls never wait out the retries. */
  readonly retry?: boolean;
  /** Caps each attempt's timeout, for calls that must give up quickly. */
  readonly timeoutMs?: number;
}

export class SourceClient {
  private readonly bases: ReadonlyArray<URL>;
  /** The address in use: the last one that answered. */
  private current = 0;
  /** Addresses proven to answer as the source machine; the primary is the offer's own. */
  private readonly verified = new Set<number>([0]);
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly options: SourceClientOptions;

  constructor(options: SourceClientOptions) {
    this.options = options;
    const primary = checkSourceUrl(options.baseUrl, options.allowLoopback ?? false);
    const fallback =
      options.fallbackBaseUrl === undefined
        ? undefined
        : checkSourceUrl(options.fallbackBaseUrl, options.allowLoopback ?? false);
    this.bases =
      fallback === undefined ||
      fallback.origin === primary.origin ||
      options.expectedEnvironmentId === undefined
        ? [primary]
        : [primary, fallback];
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Retries network failures and 5xx answers; 4xx answers are final. With a
   * second address, a failure first moves to the other address at once (each
   * address once per request), then retries alternate with the usual backoff.
   */
  private async request(
    method: "GET" | "POST",
    action: string,
    body?: unknown,
    timeoutMs = 120_000,
  ): Promise<Response> {
    const path = `${FOLDER_TRANSFER_PREFIX}/${this.options.operationId}/${action}`;
    const limit = Math.min(timeoutMs, this.options.timeoutMs ?? timeoutMs);
    const retries = this.options.retry === false ? 0 : RETRY_DELAYS_MS.length;
    const tried = new Set([this.current]);
    for (let attempt = 0; ;) {
      this.options.signal?.throwIfAborted();
      const url = new URL(path, this.bases[this.current]);
      let response: Response | null = null;
      try {
        if (!(await this.proven(this.current))) throw new Error("unproven address");
        response = await this.fetcher(url, {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: this.options.signal
            ? AbortSignal.any([this.options.signal, AbortSignal.timeout(limit)])
            : AbortSignal.timeout(limit),
        });
      } catch (cause) {
        if (this.options.signal?.aborted || cause instanceof SourceClientError) throw cause;
        response = null;
      }
      if (response && response.status < 500) {
        if (response.status === 401) throw new SourceClientError("unauthorized", 401);
        if (response.status === 404 && action === "hello")
          throw new SourceClientError("outdated_source", 404);
        return response;
      }
      if (this.bases.length > 1) {
        this.current = (this.current + 1) % this.bases.length;
        if (!tried.has(this.current)) {
          tried.add(this.current);
          continue;
        }
      }
      if (attempt >= retries) throw new SourceClientError("unreachable", response?.status ?? null);
      await this.sleep(RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }

  /**
   * Whether address `index` answers as the source machine, checked once before
   * the token is first sent there. A different machine is final.
   */
  private async proven(index: number): Promise<boolean> {
    if (this.verified.has(index)) return true;
    const response = await this.fetcher(
      new URL("/.well-known/studio/environment", this.bases[index]),
      {
        method: "GET",
        redirect: "error",
        signal: this.options.signal
          ? AbortSignal.any([this.options.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    ).catch(() => null);
    if (response === null || !response.ok) {
      await response?.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await response.json().catch(() => null)) as { environmentId?: unknown } | null;
    if (typeof body?.environmentId !== "string") return false;
    if (body.environmentId !== this.options.expectedEnvironmentId)
      throw new SourceClientError("wrong_machine");
    this.verified.add(index);
    return true;
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      throw new SourceClientError("refused", response.status, detail?.detail ?? detail?.error);
    }
    return (await response.json()) as T;
  }

  /** Confirms the URL answers for the expected machine and operation. */
  async hello(expectedEnvironmentId: string) {
    const hello = await this.json<{
      version: number;
      /** Chunks one batch may name; older sources omit it. */
      maxBatchChunks?: number;
      environmentId: string;
      operationId: string;
      mode: string;
      state: string;
      expiresAt: number;
      projectId?: string;
      copyRoot?: string;
      projectRelativePath?: string;
    }>(await this.request("GET", "hello"));
    if (
      hello.environmentId !== expectedEnvironmentId ||
      hello.operationId !== this.options.operationId
    )
      throw new SourceClientError("wrong_machine");
    return hello;
  }

  async validateScan(): Promise<void> {
    const response = await this.request("POST", "validate", {}, 10 * 60_000);
    if (response.status === 404)
      throw new SourceClientError(
        "outdated_source",
        404,
        "Update the source before validating this copy scan.",
      );
    if (response.status === 409) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      if (
        detail?.error === "snapshot_unavailable" ||
        detail?.error === "secret_reapproval_required"
      )
        throw new UnavailableSnapshotError(
          "refused",
          409,
          detail.detail ?? "The captured copy is unavailable. Compare again.",
        );
      throw new SourceClientError("refused", 409, detail?.detail ?? detail?.error);
    }
    const result = await this.json<{ current?: boolean; captured?: boolean }>(response);
    if (result.current !== true && result.captured !== true)
      throw new StaleScanError(
        "refused",
        409,
        "The source changed or this saved scan has no freshness evidence. Refresh the scan and review a new comparison before copying.",
      );
  }

  async requestManifest(selection: ReadonlyArray<string>) {
    return this.json<{ state: string }>(await this.request("POST", "manifest", { selection }));
  }

  /** The manifest once the source has hashed the selection; null with progress while it hashes. */
  async manifest(): Promise<
    | { readonly header: ManifestHeader; readonly entries: Array<ManifestEntry> }
    | { readonly progress: { files: number; bytes: number } | null }
  > {
    const response = await this.request("GET", "manifest", undefined, 600_000);
    if (response.status === 202) {
      const body = (await response.json()) as { progress: { files: number; bytes: number } | null };
      return { progress: body.progress };
    }
    if (!response.ok) await this.json(response);
    const [header, ...entries] = await readManifestBytes(
      new Uint8Array(await response.arrayBuffer()),
    );
    return { header: header as ManifestHeader, entries: entries as Array<ManifestEntry> };
  }

  async chunks(hashes: ReadonlyArray<string>): Promise<Array<ChunkFrame>> {
    // Ask for zstd when this machine reads it; an older source ignores the field.
    const body = zstdAvailable() ? { chunks: hashes, encodings: ["zstd"] } : { chunks: hashes };
    const response = await this.request("POST", "chunks", body, 300_000);
    if (!response.ok) await this.json(response);
    return decodeFrames(new Uint8Array(await response.arrayBuffer()));
  }

  async stat(paths: ReadonlyArray<string>) {
    return (
      await this.json<{
        entries: Array<
          | { path: string; missing: true }
          | {
              path: string;
              type: string;
              size: number;
              mtimeMs: number;
              target?: string;
              missing?: undefined;
            }
        >;
      }>(await this.request("POST", "stat", { paths }))
    ).entries;
  }

  async refresh(paths: ReadonlyArray<string>) {
    return (
      await this.json<{ entries: Array<ManifestEntry | { path: string; missing: true }> }>(
        await this.request("POST", "refresh", { paths }, 600_000),
      )
    ).entries;
  }

  async ancestry(repository: string, commits: ReadonlyArray<string>) {
    return (
      await this.json<{
        commits: Array<{ commit: string; present: boolean; ancestorOfHead: boolean }>;
      }>(await this.request("POST", "ancestry", { repository, commits }))
    ).commits;
  }

  async release(reason: string) {
    return this.json<{ state: string }>(await this.request("POST", "release", { reason }));
  }

  /** Approved secret files; an older source without the secret step has none. */
  async secrets(): Promise<Array<{ path: string; size: number }>> {
    return (await this.secretsOffer()).files;
  }

  /** The staged list, and whether the source says it serves these files only sealed. */
  async secretsOffer(): Promise<{
    readonly files: Array<{ path: string; size: number }>;
    readonly sealed: boolean;
  }> {
    const response = await this.request("GET", "secrets");
    if (response.status === 404) return { files: [], sealed: false };
    const offer = await this.json<{
      files: Array<{ path: string; size: number }>;
      sealed?: boolean;
    }>(response);
    return { files: offer.files, sealed: offer.sealed === true };
  }

  /** One approved secret file as the source served it: plain, or sealed to this machine's key. */
  async secretFile(
    path: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly sealed: boolean }> {
    const response = await this.request("POST", "secret", { path });
    if (!response.ok) await this.json(response);
    const sealed = (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith(SEALED_SECRET_CONTENT_TYPE);
    return { bytes: new Uint8Array(await response.arrayBuffer()), sealed };
  }

  async commit() {
    return this.json<{ state: string }>(await this.request("POST", "commit", {}));
  }
}

type ManifestAnswer = Awaited<ReturnType<SourceClient["manifest"]>>;

/**
 * What the copy's client needs of the local-network path (1334 S-3, S-4). It
 * never sees an address: the LAN is not a base URL and not a fallback URL, and
 * `checkSourceUrl` stays Connect-only.
 */
export interface LanPath {
  /** The live generation's connector, or null when this copy runs on Connect. */
  readonly connector: () => Promise<{
    readonly manifest: (signal?: AbortSignal) => Promise<ManifestAnswer>;
    readonly chunks: (
      hashes: ReadonlyArray<string>,
      signal?: AbortSignal,
    ) => Promise<Array<ChunkFrame>>;
    wireBytes: number;
  } | null>;
  /** Switch once. Resolves only after the latch is saved, before any Connect request. */
  readonly latch: (kind: Exclude<LanFailureKind, "denied">) => Promise<void>;
  /** A denial: the copy stops on both paths. */
  readonly stopped: () => Promise<void>;
  readonly count: (path: "lan" | "connect", bytes: number) => void;
  /**
   * After a wrong pin or identity: true when the manifest read again over Connect
   * names what was staged. False discards the staged data.
   */
  readonly recheck: (manifest: () => Promise<ManifestAnswer>) => Promise<boolean>;
}

const frameBytes = (frames: ReadonlyArray<ChunkFrame>) =>
  frames.reduce((sum, frame) => sum + frame.data.length, 0);

/**
 * The copy's client with the local network tried first for the manifest and the
 * chunks. Every other request (hello, selection, validate, stat, refresh,
 * ancestry, secrets, release, commit) is the Connect client's, untouched.
 *
 * The Connect address and the transfer token come from the copy's own record of
 * the original offer. Nothing a LAN answer says is used as an address, a
 * credential or a deadline.
 */
export class LanFirstSourceClient extends SourceClient {
  private readonly lan: LanPath;
  private readonly lanSignal: AbortSignal | undefined;

  constructor(options: SourceClientOptions, lan: LanPath) {
    super(options);
    this.lan = lan;
    this.lanSignal = options.signal;
  }

  /** Applies the fallback table to a LAN failure: stop, or latch and let Connect run. */
  private async fell(cause: unknown): Promise<void> {
    if (this.lanSignal?.aborted) throw cause;
    const failure = cause instanceof LanFailure ? cause : new LanFailure("unreachable");
    if (failure.stops) {
      await this.lan.stopped();
      throw new SourceClientError("unauthorized", 403);
    }
    await this.lan.latch(failure.kind as Exclude<LanFailureKind, "denied">);
  }

  override async manifest(): Promise<ManifestAnswer> {
    const connector = await this.lan.connector();
    if (connector !== null) {
      try {
        const before = connector.wireBytes;
        const answer = await connector.manifest(this.lanSignal);
        this.lan.count("lan", connector.wireBytes - before);
        return answer;
      } catch (cause) {
        await this.fell(cause);
      }
    }
    return super.manifest();
  }

  override async chunks(hashes: ReadonlyArray<string>): Promise<Array<ChunkFrame>> {
    const connector = await this.lan.connector();
    if (connector !== null) {
      try {
        const frames = await connector.chunks(hashes, this.lanSignal);
        this.lan.count("lan", frameBytes(frames));
        return frames;
      } catch (cause) {
        await this.fell(cause);
      }
    }
    if (!(await this.lan.recheck(() => super.manifest())))
      throw new SourceClientError(
        "refused",
        409,
        "The source could not be confirmed for part of this copy. Compare again.",
      );
    const frames = await super.chunks(hashes);
    this.lan.count("connect", frameBytes(frames));
    return frames;
  }
}
