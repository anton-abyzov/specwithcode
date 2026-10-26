// @effect-diagnostics globalTimers:off - plain async client shared by the destination worker and tests.
import type { ManifestEntry, ManifestHeader } from "./manifest.ts";
import { readManifestBytes } from "./manifest.ts";
import { decodeFrames, FOLDER_TRANSFER_PREFIX, type ChunkFrame } from "./wire.ts";

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

/**
 * The destination reaches the source only over the source's private HTTPS name
 * on the tailnet (`*.ts.net`). Loopback is accepted only when the destination's
 * operator set STUDIO_FOLDER_TRANSFER_ALLOW_LOOPBACK for isolated tests.
 */
export function checkSourceUrl(value: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceClientError("unsupported_url");
  }
  const tailnet =
    url.protocol === "https:" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname);
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((!tailnet && !loopback) || url.username || url.password || url.search || url.hash)
    throw new SourceClientError("unsupported_url");
  return new URL(url.origin);
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export interface SourceClientOptions {
  readonly baseUrl: string;
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
  private readonly base: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly options: SourceClientOptions;

  constructor(options: SourceClientOptions) {
    this.options = options;
    this.base = checkSourceUrl(options.baseUrl, options.allowLoopback ?? false);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Retries network failures and 5xx answers; 4xx answers are final. */
  private async request(
    method: "GET" | "POST",
    action: string,
    body?: unknown,
    timeoutMs = 120_000,
  ): Promise<Response> {
    const url = new URL(
      `${FOLDER_TRANSFER_PREFIX}/${this.options.operationId}/${action}`,
      this.base,
    );
    const limit = Math.min(timeoutMs, this.options.timeoutMs ?? timeoutMs);
    const retries = this.options.retry === false ? 0 : RETRY_DELAYS_MS.length;
    for (let attempt = 0; ; attempt += 1) {
      this.options.signal?.throwIfAborted();
      let response: Response | null = null;
      try {
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
        if (this.options.signal?.aborted) throw cause;
        response = null;
      }
      if (response && response.status < 500) {
        if (response.status === 401) throw new SourceClientError("unauthorized", 401);
        if (response.status === 404 && action === "hello")
          throw new SourceClientError("outdated_source", 404);
        return response;
      }
      if (attempt >= retries) throw new SourceClientError("unreachable", response?.status ?? null);
      await this.sleep(RETRY_DELAYS_MS[attempt]!);
    }
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
    const response = await this.request("POST", "chunks", { chunks: hashes }, 300_000);
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
    const response = await this.request("GET", "secrets");
    if (response.status === 404) return [];
    return (await this.json<{ files: Array<{ path: string; size: number }> }>(response)).files;
  }

  async secretFile(path: string): Promise<Uint8Array> {
    const response = await this.request("POST", "secret", { path });
    if (!response.ok) await this.json(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async commit() {
    return this.json<{ state: string }>(await this.request("POST", "commit", {}));
  }
}
