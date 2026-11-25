import { describe, expect, it, vi } from "vite-plus/test";

import { readGitHubStarred, type GitHubStarredDeps } from "./gitHubStarred.ts";

function deps(overrides: Partial<GitHubStarredDeps> & { status?: number } = {}) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(null, { status: overrides.status ?? 204 });
  });
  return {
    fetch,
    value: {
      hostEnabled: true,
      savedToken: async () => null,
      ghToken: async () => "gho_test",
      fetch: fetch as unknown as typeof globalThis.fetch,
      ...overrides,
    } satisfies GitHubStarredDeps,
  };
}

describe("readGitHubStarred", () => {
  it("reads 204 as starred, with a GET to the fixed repository", async () => {
    const { fetch, value } = deps();
    await expect(readGitHubStarred(value)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/user/starred/anton-abyzov/specwithcode");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gho_test");
  });

  it("reads 404 as not starred", async () => {
    await expect(readGitHubStarred(deps({ status: 404 }).value)).resolves.toBe(false);
  });

  it("does not know on other answers or network errors", async () => {
    await expect(readGitHubStarred(deps({ status: 401 }).value)).resolves.toBeNull();
    const failing = deps({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(readGitHubStarred(failing.value)).resolves.toBeNull();
  });

  it("prefers the token saved in Settings over gh", async () => {
    const { fetch, value } = deps({ savedToken: async () => "saved_token" });
    await readGitHubStarred(value);
    const [, init] = fetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer saved_token");
  });

  it("never calls GitHub without a sign-in or with github.com turned off", async () => {
    const none = deps({ ghToken: async () => null });
    await expect(readGitHubStarred(none.value)).resolves.toBeNull();
    expect(none.fetch).not.toHaveBeenCalled();
    const off = deps({ hostEnabled: false });
    await expect(readGitHubStarred(off.value)).resolves.toBeNull();
    expect(off.fetch).not.toHaveBeenCalled();
  });
});
