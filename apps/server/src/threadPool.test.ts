import { describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_SERVER_THREADPOOL_SIZE,
  MIN_SERVER_THREADPOOL_SIZE,
  ensureServerThreadPoolSize,
  serverThreadPoolSize,
} from "./threadPool.ts";

describe("serverThreadPoolSize", () => {
  it("follows the core count between the floor and the cap", () => {
    expect(serverThreadPoolSize(undefined, 16)).toBe(16);
    expect(serverThreadPoolSize(undefined, 2)).toBe(MIN_SERVER_THREADPOOL_SIZE);
    expect(serverThreadPoolSize(undefined, 128)).toBe(MAX_SERVER_THREADPOOL_SIZE);
    expect(serverThreadPoolSize(undefined, Number.NaN)).toBe(MIN_SERVER_THREADPOOL_SIZE);
  });

  it("leaves an explicit UV_THREADPOOL_SIZE alone", () => {
    expect(serverThreadPoolSize("4", 16)).toBeUndefined();
    expect(serverThreadPoolSize("64", 16)).toBeUndefined();
    expect(serverThreadPoolSize("  ", 16)).toBe(16);
  });
});

describe("ensureServerThreadPoolSize", () => {
  it("does not leave the setting in the environment children inherit", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(ensureServerThreadPoolSize(env, 12)).toBe(12);
    expect(env.UV_THREADPOOL_SIZE).toBeUndefined();
  });

  it("runs from a working directory that has been deleted", () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });
    try {
      const env: NodeJS.ProcessEnv = {};
      expect(ensureServerThreadPoolSize(env, 12)).toBe(12);
      expect(env.UV_THREADPOOL_SIZE).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it("keeps a configured size and the variable that carries it", () => {
    const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: "6" };
    expect(ensureServerThreadPoolSize(env, 12)).toBeUndefined();
    expect(env.UV_THREADPOOL_SIZE).toBe("6");
  });
});
