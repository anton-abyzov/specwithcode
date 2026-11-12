import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import { inProcessFinderBackend } from "./WorkspaceSearchFinder.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

// These tests mock fff in this thread; the worker backend has its own tests.
const inProcess = { backend: inProcessFinderBackend };

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        "/workspace/project",
        "paths",
        inProcess,
      );
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("preserves unexpected FileFinder creation failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native initialization failed");
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw cause;
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "paths", inProcess)),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "FileFinder.create threw unexpectedly.",
      cause,
    });
  }),
);

it.effect("keeps returned FileFinder creation diagnostics out of the cause chain", () =>
  Effect.gen(function* () {
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: false,
      error: "native index rejected the directory",
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "paths", inProcess)),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "native index rejected the directory",
    });
    expect(error.cause).toBeUndefined();
  }),
);

it.effect("waits for the full content index warmup before returning", () =>
  Effect.gen(function* () {
    const waitForIndexReady = vi.fn(async () => ({ ok: true as const, value: true }));
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady,
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content", inProcess));

    expect(waitForIndexReady).toHaveBeenCalledWith(15_000);
  }),
);

it.effect("preserves a full-index warmup timeout as a structured error", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content", inProcess)),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexScanTimedOut",
      cwd: "/workspace/project",
      timeout: "15 seconds",
    });
  }),
);

it.effect("returns partial path results when the initial scan times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mixedSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items: [
            {
              type: "directory" as const,
              item: { relativePath: "src", fileName: "src", fileCount: 1 },
            },
            { type: "file" as const, item: fileItem("src/index.ts") },
          ],
          scores: [],
          totalMatched: 2,
          totalFiles: 1,
        },
      }));
      let scanning = true;
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => scanning),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
        mixedSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        "/workspace/project",
        "paths",
        inProcess,
      );
      const list = yield* searchIndex.list();
      const search = yield* searchIndex.search("src", 10);
      scanning = true;
      mixedSearch.mockImplementationOnce(() => {
        scanning = false;
        return {
          ok: true as const,
          value: {
            items: [
              {
                type: "directory" as const,
                item: { relativePath: "src", fileName: "src", fileCount: 1 },
              },
              { type: "file" as const, item: fileItem("src/index.ts") },
            ],
            scores: [],
            totalMatched: 2,
            totalFiles: 1,
          },
        };
      });
      const searchCompletingDuringQuery = yield* searchIndex.search("src", 10);
      scanning = false;
      const completedSearch = yield* searchIndex.search("src", 10);

      expect(list).toEqual({
        entries: [
          { kind: "directory", path: "src" },
          { kind: "file", path: "src/index.ts" },
        ],
        truncated: true,
      });
      expect(search.truncated).toBe(true);
      expect(searchCompletingDuringQuery.truncated).toBe(true);
      expect(completedSearch.truncated).toBe(false);
      expect(mixedSearch).toHaveBeenCalledTimes(4);
    }),
  ),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");
    const finder = {
      destroy: vi.fn(() => {
        throw cause;
      }),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const exit = yield* Effect.scoped(
      WorkspaceSearchIndex.make("/workspace/project", "paths", inProcess),
    ).pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("preserves search and refresh failures with operation context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const searchCause = new Error("native search failed");
      const refreshCause = new Error("native scan failed");
      const contentSearchCause = new Error("native grep failed");
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => {
          throw searchCause;
        }),
        grep: vi.fn(() => {
          throw contentSearchCause;
        }),
        scanFiles: vi.fn(() => {
          throw refreshCause;
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        "/workspace/project",
        "paths",
        inProcess,
      );
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const contentSearchError = yield* Effect.flip(
        searchIndex.searchContents({
          query,
          limit: 3,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        }),
      );
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "FileFinder.mixedSearch threw unexpectedly.",
        cause: searchCause,
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(contentSearchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 3,
        reason: "FileFinder.grep threw unexpectedly.",
        cause: contentSearchCause,
      });
      expect(contentSearchError).not.toHaveProperty("query");
      expect(contentSearchError.message).not.toMatch(/Bearer|secret-token/);
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "FileFinder.scanFiles threw unexpectedly.",
        cause: refreshCause,
      });
    }),
  ),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({ ok: false, error: "native query rejected" })),
        scanFiles: vi.fn(() => ({ ok: false, error: "native refresh rejected" })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        "/workspace/project",
        "paths",
        inProcess,
      );
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        "/workspace/project",
        "content",
        inProcess,
      );
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);

it.effect("refuses to index the home folder, a folder above it or the database folder", () =>
  Effect.gen(function* () {
    const create = vi.spyOn(FileFinder, "create");
    const options = {
      ...inProcess,
      homeDir: "/home/anton",
      stateDir: "/home/anton/.specwithcode/m4/userdata",
      platform: "linux" as const,
    };

    for (const [root, reason] of [
      ["/", "it is the filesystem root"],
      ["/home", "it holds the home folder"],
      ["/home/anton", "it is the home folder"],
      ["/home/anton/.specwithcode/m4", "it holds the service's database folder"],
      ["/home/anton/.specwithcode/m4/userdata", "it holds the service's database folder"],
    ] as const) {
      const error = yield* Effect.flip(
        Effect.scoped(WorkspaceSearchIndex.make(root, "paths", options)),
      );
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexCreateFailed",
        cwd: root,
        reason: `Refused to index '${root}': ${reason}.`,
      });
    }
    expect(create).not.toHaveBeenCalled();
  }),
);

it.effect("indexes a project folder and turns off fff's root and home scanning", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    const create = vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    yield* Effect.scoped(
      WorkspaceSearchIndex.make("/home/anton/code/app", "paths", {
        ...inProcess,
        homeDir: "/home/anton",
        stateDir: "/home/anton/.specwithcode/m4/userdata",
        platform: "linux",
      }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: "/home/anton/code/app",
        enableFsRootScanning: false,
        enableHomeDirScanning: false,
      }),
    );
    expect(finder.destroy).toHaveBeenCalledTimes(1);
  }),
);

it.effect("turns off fff's watcher and rescans once for a burst of changes", () =>
  Effect.gen(function* () {
    const scanFiles = vi.fn(() => ({ ok: true as const, value: undefined }));
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
      scanFiles,
    } as unknown as FileFinder;
    const create = vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
    let now = 0;
    const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
    const clock = {
      now: () => now,
      setTimeout: (run: () => void, delayMs: number) => {
        const timer = { at: now + delayMs, run, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle: unknown) => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= now) timer.run();
        else timers.push(timer);
      }
    };
    const watchers: Array<(relativePath: string | null) => void> = [];
    const stopWatching = vi.fn();
    const watch = vi.fn((_root: string, onChange: (relativePath: string | null) => void) => {
      watchers.push(onChange);
      return stopWatching;
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* WorkspaceSearchIndex.make("/workspace/project", "paths", {
          ...inProcess,
          watch,
          refresh: { clock },
        });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ disableWatch: true }));
        expect(watch).toHaveBeenCalledWith("/workspace/project", expect.any(Function));

        for (let index = 0; index < 200; index += 1) {
          watchers[0]?.(`src/file-${index}.ts`);
          watchers[0]?.(".git/index");
          advance(5);
        }
        expect(scanFiles).not.toHaveBeenCalled();
        advance(2_000);
        yield* Effect.promise(() => Promise.resolve());
        expect(scanFiles).toHaveBeenCalledTimes(1);
        expect(stopWatching).not.toHaveBeenCalled();
      }),
    );

    expect(stopWatching).toHaveBeenCalledTimes(1);
    expect(finder.destroy).toHaveBeenCalledTimes(1);
    // A change reported after the index is released starts nothing.
    watchers[0]?.("src/late.ts");
    advance(60_000);
    expect(scanFiles).toHaveBeenCalledTimes(1);
  }),
);

it.effect("leaves watching to fff where the service has no native recursive watch", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    const create = vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    yield* Effect.scoped(
      WorkspaceSearchIndex.make("/home/anton/code/app", "paths", {
        ...inProcess,
        homeDir: "/home/anton",
        platform: "linux",
      }),
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ disableWatch: false }));
  }),
);
