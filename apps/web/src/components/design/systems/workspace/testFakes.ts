/** Fakes for the workspace component tests: a files API over an in-memory folder. */
import type {
  DesignSystem,
  DesignSystemFile,
  DesignSystemFileReadResult,
  DesignSystemFilesResult,
} from "@specweave-studio/contracts";
import { vi } from "vite-plus/test";

import { bytesToBase64, type SystemFilesApi } from "./systemFilesApi";

export interface FakeFile {
  readonly path: string;
  readonly origin?: "stored" | "source";
  readonly text?: string;
  readonly bytes?: number;
  readonly mimeType?: string;
  readonly unavailable?: string;
}

const encoder = new TextEncoder();

export function fakeFilesApi(
  initial: readonly FakeFile[],
  options: {
    readonly listing?: Partial<SystemFilesApi["listing"]>;
    readonly limits?: Partial<Pick<DesignSystemFilesResult, "limitBytes" | "limitFiles">>;
  } = {},
) {
  const files = new Map<string, FakeFile & { data: Uint8Array }>();
  const put = (file: FakeFile, data: Uint8Array) =>
    files.set(`${file.origin ?? "stored"}:${file.path}`, { ...file, data });
  for (const file of initial) put(file, encoder.encode(file.text ?? ""));

  const meta = (file: FakeFile & { data: Uint8Array }): DesignSystemFile => ({
    path: file.path,
    origin: file.origin ?? "stored",
    bytes: file.bytes ?? file.data.length,
    mimeType: file.mimeType ?? "application/octet-stream",
    updatedAt: "2026-10-23T15:00:00Z",
    ...(file.unavailable === undefined ? {} : { unavailable: file.unavailable }),
  });

  const listingData = (): DesignSystemFilesResult => {
    const all = [...files.values()].map(meta);
    const stored = all.filter((file) => file.origin === "stored");
    return {
      files: all,
      usedBytes: stored.reduce((sum, file) => sum + file.bytes, 0),
      limitBytes: options.limits?.limitBytes ?? 1024 * 1024 * 1024,
      limitFiles: options.limits?.limitFiles ?? 5_000,
    };
  };

  const api = {
    listing: {
      data: listingData(),
      error: null,
      isPending: false,
      refresh: vi.fn(),
      ...options.listing,
    } as SystemFilesApi["listing"],
    read: vi.fn(async ({ origin, path }) => {
      const file = files.get(`${origin}:${path}`);
      if (file === undefined) return { ok: false as const, message: `${path} is gone.` };
      const textual = /\.(md|txt|json|css|html)$/.test(path);
      const value: DesignSystemFileReadResult = {
        file: meta(file),
        encoding: textual ? "utf8" : "base64",
        data: textual ? new TextDecoder().decode(file.data) : bytesToBase64(file.data),
      };
      return { ok: true as const, value };
    }) as SystemFilesApi["read"] & ReturnType<typeof vi.fn>,
    put: vi.fn(async (path: string, base64: string) => {
      const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      put({ path, mimeType: "application/octet-stream" }, data);
      return { ok: true as const, value: meta(files.get(`stored:${path}`)!) };
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(`stored:${path}`);
      return { ok: true as const, value: null };
    }),
    move: vi.fn(async (from: string, to: string) => {
      const file = files.get(`stored:${from}`)!;
      files.delete(`stored:${from}`);
      put({ ...file, path: to }, file.data);
      return { ok: true as const, value: meta(files.get(`stored:${to}`)!) };
    }),
  };
  /** The listing as the server would now answer it. */
  const relist = () => ({ ...api, listing: { ...api.listing, data: listingData() } });
  return { api, files, relist };
}

export const SYSTEM: DesignSystem = {
  schema: 1,
  id: "acme",
  name: "Acme",
  revision: 2,
  createdAt: "2026-10-20T15:00:00Z",
  updatedAt: "2026-10-23T15:00:00Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    {
      name: "ink",
      type: "color",
      values: {
        light: {
          raw: "#111111",
          resolved: "#111111",
          provenance: { source: "user", location: "editor", extractor: "editor@1" },
        },
      },
    },
  ],
  components: [],
  sources: [],
  copiedFrom: null,
} as unknown as DesignSystem;

export function stubObjectUrls() {
  const created: Blob[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:fake/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  return {
    created,
    restore: () => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    },
  };
}
