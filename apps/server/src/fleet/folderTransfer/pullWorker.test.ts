// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { DEFAULT_SELECTION } from "./classify.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import type { ManifestEntry } from "./manifest.ts";
import { finalPass, pullFiles, stagedPath, type PullFile } from "./pullWorker.ts";
import { checkSourceUrl, SourceClient, SourceClientError } from "./sourceClient.ts";
import { SourceTransfers } from "./sourceService.ts";
import { liveMovingCopies, serveSource } from "./sourceTestServer.testkit.ts";

const operationId = "019a0000-0000-7000-8000-0000000000a1";
let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let token: string;
let entries: Array<ManifestEntry>;

const client = (overrides: Partial<ConstructorParameters<typeof SourceClient>[0]> = {}) =>
  new SourceClient({
    baseUrl: served.url,
    operationId,
    token,
    allowLoopback: true,
    sleep: async () => undefined,
    ...overrides,
  });

const pullList = (): Array<PullFile> =>
  entries
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256!,
      chunks: [...entry.chunks!],
      size: entry.size,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      localSource: null,
    }));

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-pull-")));
  fixture = makeUmbrella(base);
  // Live-file refreshes are what an uncaptured moving copy relies on.
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    verifyCaptureFilesystem: liveMovingCopies,
  });
  served = await serveSource(transfers, "env-source");
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    // Exercise the live-file path retained for coordinator moves and legacy jobs.
    mode: "copy-and-move",
    destinationEnvironmentId: "env-destination",
  });
  token = offered.token;
  const source = client();
  await source.hello("env-source");
  await source.requestManifest(DEFAULT_SELECTION);
  for (;;) {
    const manifest = await source.manifest();
    if ("entries" in manifest) {
      entries = manifest.entries;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

describe("source routes", () => {
  it("refuses a wrong bearer, another machine and non-tailnet URLs", async () => {
    await expect(client({ token: "swcft_wrong" }).hello("env-source")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(client().hello("env-other")).rejects.toMatchObject({ code: "wrong_machine" });
    expect(() => checkSourceUrl(served.url, false)).toThrow(SourceClientError);
    expect(() => checkSourceUrl("https://evil.example.com", false)).toThrow(SourceClientError);
    expect(checkSourceUrl("https://m4max.tail1234.ts.net:8443/x", false).origin).toBe(
      "https://m4max.tail1234.ts.net:8443",
    );
    expect(checkSourceUrl("https://prod-0123456789abcdef.spec-weave.com/x", false).origin).toBe(
      "https://prod-0123456789abcdef.spec-weave.com",
    );
    for (const lookalike of [
      "https://relay.spec-weave.com",
      "https://prod-0123456789abcdef.spec-weave.com.evil.com",
      "https://a.prod-0123456789abcdef.spec-weave.com",
      "https://prod-0123456789abcdef.spec-weave.com:8443",
      "http://prod-0123456789abcdef.spec-weave.com",
      "https://prod-0123456789abcdef.spec-weave.com/?token=1",
    ])
      expect(() => checkSourceUrl(lookalike, false), lookalike).toThrow(SourceClientError);
  });

  it("moves to the Connect address when the tailnet address does not answer", async () => {
    const tailnet = "https://m4max.tail1234.ts.net";
    const seen: string[] = [];
    const identity = (environmentId: string) =>
      (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${url.origin}${url.pathname.startsWith("/.well-known") ? " identity" : ""}`);
        if (url.origin === tailnet) throw new TypeError("fetch failed");
        if (url.pathname === "/.well-known/studio/environment")
          return Response.json({ environmentId });
        // @effect-diagnostics-next-line globalFetch:off -- the stub forwards to the real local test server.
        return fetch(input, init);
      }) as typeof fetch;
    const fallback = new URL(served.url).origin;
    const viaFallback = client({
      baseUrl: tailnet,
      fallbackBaseUrl: served.url,
      expectedEnvironmentId: "env-source",
      fetch: identity("env-source"),
    });
    expect((await viaFallback.hello("env-source")).environmentId).toBe("env-source");
    // The address that answered stays in use for the next call; its identity is checked once.
    await viaFallback.hello("env-source");
    expect(seen).toEqual([tailnet, `${fallback} identity`, fallback, fallback]);

    // The token never goes to a fallback that answers as another machine.
    seen.length = 0;
    await expect(
      client({
        baseUrl: tailnet,
        fallbackBaseUrl: served.url,
        expectedEnvironmentId: "env-source",
        fetch: identity("env-other"),
      }).hello("env-source"),
    ).rejects.toMatchObject({ code: "wrong_machine" });
    expect(seen).toEqual([tailnet, `${fallback} identity`]);

    // Without the source's id there is nothing to check it against: no fallback.
    seen.length = 0;
    await expect(
      client({
        baseUrl: tailnet,
        fallbackBaseUrl: served.url,
        fetch: identity("env-source"),
        sleep: async () => undefined,
      }).hello("env-source"),
    ).rejects.toMatchObject({ code: "unreachable" });
    expect(seen.every((entry) => entry === tailnet)).toBe(true);
  });

  it("treats a refusal on the first address as final and checks the fallback address", async () => {
    const tailnet = "https://m4max.tail1234.ts.net";
    const seen: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(new URL(String(input)).origin);
      return new Response("no", { status: 401 });
    }) as typeof fetch;
    await expect(
      client({
        baseUrl: tailnet,
        fallbackBaseUrl: served.url,
        expectedEnvironmentId: "env-source",
        fetch: fetcher,
      }).hello("env-source"),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(seen).toEqual([tailnet]);
    expect(() =>
      client({
        baseUrl: tailnet,
        fallbackBaseUrl: "https://prod-0123456789abcdef.spec-weave.com.evil.com",
      }),
    ).toThrow(expect.objectContaining({ code: "unsupported_url" }));
  });

  it("serves only the selection: no secrets, no rebuildable files", () => {
    expect(entries.some((entry) => entry.path === ".env")).toBe(false);
    expect(entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
    expect(entries.some((entry) => entry.path === ".git/HEAD")).toBe(true);
  });
});

describe("pull into staging", () => {
  it("resumes without re-sending verified chunks after an interruption", async () => {
    const staging = NodePath.join(base, "staging-resume");
    NodeFS.mkdirSync(staging, { recursive: true });
    const controller = new AbortController();
    await expect(
      pullFiles({
        client: client({ signal: controller.signal }),
        stagingRoot: staging,
        files: pullList(),
        directories: [],
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.filesDone >= 20) controller.abort();
        },
      }),
    ).rejects.toThrow();
    const same = (entry: ManifestEntry) => {
      try {
        // Git pointers can be normalized into a portable source snapshot.
        // Resume must match the advertised bytes, not a live source pathname.
        return (
          NodeCrypto.createHash("sha256")
            .update(NodeFS.readFileSync(stagedPath(staging, entry.path)))
            .digest("hex") === entry.sha256
        );
      } catch {
        return false;
      }
    };
    const files = entries.filter((item) => item.type === "file");
    const complete = files.filter(same);
    expect(complete.length).toBeGreaterThanOrEqual(20);
    expect(complete.length).toBeLessThan(files.length);
    const before = served.requests.length;
    const result = await pullFiles({
      client: client(),
      stagingRoot: staging,
      files: pullList(),
      directories: [],
    });
    expect(result.unstable).toEqual([]);
    const resent = new Set(
      served.requests
        .slice(before)
        .filter((request) => request.action === "chunks")
        .flatMap((request) => JSON.parse(request.body).chunks as Array<string>),
    );
    const stillNeeded = new Set(
      files.filter((entry) => !complete.includes(entry)).flatMap((entry) => entry.chunks!),
    );
    for (const entry of complete)
      for (const sha of entry.chunks!)
        if (!stillNeeded.has(sha)) expect(resent.has(sha)).toBe(false);
    for (const entry of files) expect(same(entry)).toBe(true);
    // Windows has no POSIX mode bits to check.
    if (process.platform !== "win32")
      expect(NodeFS.statSync(stagedPath(staging, "scripts/run.sh")).mode & 0o777).toBe(0o755);
  });

  it("reuses a local copy instead of the network", async () => {
    const staging = NodePath.join(base, "staging-local");
    NodeFS.mkdirSync(staging, { recursive: true });
    const files = pullList().filter((file) => file.path === "work/big.bin");
    files[0]!.localSource = NodePath.join(fixture.root, "work/big.bin");
    const before = served.requests.length;
    let progress = { bytesLocal: 0 };
    await pullFiles({
      client: client(),
      stagingRoot: staging,
      files,
      directories: [],
      onProgress: (p) => (progress = p),
    });
    expect(served.requests.slice(before).some((request) => request.action === "chunks")).toBe(
      false,
    );
    expect(progress.bytesLocal).toBe(fixture.bigFileBytes);
  });

  it("re-reads a file that changed after the manifest and passes the final check", async () => {
    const staging = NodePath.join(base, "staging-changed");
    NodeFS.mkdirSync(staging, { recursive: true });
    const files = pullList().filter(
      (file) => file.path.startsWith("notes/") || file.path === "docs/guide.md",
    );
    NodeFS.writeFileSync(NodePath.join(fixture.root, "notes/todo.md"), "edited while copying\n");
    const result = await pullFiles({
      client: client(),
      stagingRoot: staging,
      files,
      directories: [],
    });
    expect([...result.refreshed.keys()]).toEqual(["notes/todo.md"]);
    expect(NodeFS.readFileSync(stagedPath(staging, "notes/todo.md"), "utf8")).toBe(
      "edited while copying\n",
    );
    // An edit that keeps size but not mtime is caught by the final pass.
    NodeFS.writeFileSync(NodePath.join(fixture.root, "docs/guide.md"), "guide v3 (uncommitted)\n");
    const final = await finalPass({ client: client(), stagingRoot: staging, files, links: [] });
    expect(final.unstable).toEqual([]);
    expect(NodeFS.readFileSync(stagedPath(staging, "docs/guide.md"), "utf8")).toBe(
      "guide v3 (uncommitted)\n",
    );
  });

  it("rejects manifest paths that leave staging", () => {
    for (const bad of ["../escape", "/etc/passwd", "a/../../b"])
      expect(() => stagedPath(base, bad)).toThrow();
  });
});
