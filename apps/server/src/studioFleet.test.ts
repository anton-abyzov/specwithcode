import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native permissions and symlinks independently exercise the secure fleet-file reader.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "./nodePath.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { StudioFleetConnectInput } from "@specweave-studio/contracts/studioFleet";
import { connectFleet, discoverFleet, parseFleetConfig, readFleetConfig } from "./studioFleet.ts";
const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Fixture Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});
const source = () => ({
  version: 1,
  machines: [
    {
      id: "m1",
      label: "Mac M1",
      environmentId: "environment-m1",
      url: "https://fixture.tailnet.ts.net:8443",
      managementToken: "synthetic-private-management-token",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    },
  ],
});
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const fetcher = (id = "environment-m1") =>
  vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/pairing-token")
      ? Response.json({
          credential: "one-time-synthetic",
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60000),
          ),
        })
      : Response.json(descriptor(id)),
  );
describe("private fleet boundary", () => {
  it("rejects arbitrary destinations, ambiguous IDs, credentials in URLs and extra config keys", () => {
    for (const url of [
      "http://fixture.tailnet.ts.net",
      "https://example.com",
      "https://127.0.0.1",
      "https://metadata.google.internal",
      "https://user:password@fixture.tailnet.ts.net",
      "https://fixture.tailnet.ts.net/relay",
      "https://fixture.tailnet.ts.net?target=evil",
      "https://fixture.tailnet.ts.net#secret",
    ]) {
      const raw = source();
      raw.machines[0]!.url = url;
      expect(() => parseFleetConfig(raw)).toThrow("securely");
    }
    expect(() => parseFleetConfig({ ...source(), endpoint: "evil" })).toThrow();
    expect(() =>
      parseFleetConfig({ version: 1, machines: [...source().machines, ...source().machines] }),
    ).toThrow();
    expect(
      Schema.decodeUnknownOption(StudioFleetConnectInput)({
        id: "m1",
        url: "https://evil.ts.net",
        scopes: [AuthAccessWriteScope],
      })._tag,
    ).toBe("None");
  });
  it("reads only an owner-only regular file and refuses symlink credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-fleet-test-"));
    dirs.push(dir);
    expect(await readFleetConfig(dir)).toBeNull();
    const file = join(dir, "studio-fleet.json");
    await writeFile(file, JSON.stringify(source()), { mode: 0o600 });
    expect((await readFleetConfig(dir))?.machines).toHaveLength(1);
    await chmod(file, 0o644);
    await expect(readFleetConfig(dir)).rejects.toThrow("securely");
    await rm(file);
    await writeFile(join(dir, "secret.json"), JSON.stringify(source()), { mode: 0o600 });
    await symlink(join(dir, "secret.json"), file);
    await expect(readFleetConfig(dir)).rejects.toThrow("securely");
  });
  it("discovery returns safe metadata and distinguishes private reachability from loopback binding", async () => {
    const f = fetcher();
    const snapshot = await discoverFleet(parseFleetConfig(source()), "127.0.0.1", f);
    expect(snapshot.listener).toBe("loopback");
    expect(snapshot.machines[0]?.status).toBe("reachable");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private");
    expect(f.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(f.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(
      (await discoverFleet(parseFleetConfig(source()), "0.0.0.0", fetcher("wrong-id"))).machines[0]
        ?.status,
    ).toBe("identity-mismatch");
    expect(
      (
        await discoverFleet(
          parseFleetConfig(source()),
          undefined,
          vi.fn(async () => {
            throw new Error("offline");
          }),
        )
      ).machines[0]?.status,
    ).toBe("unreachable");
  });
  it("never forwards a management credential to a mismatched identity or unknown destination", async () => {
    const f = fetcher("wrong-id");
    const config = parseFleetConfig(source());
    await expect(
      connectFleet(config, "m1", new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]), f),
    ).rejects.toThrow("different machine");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[1]?.headers).toBeUndefined();
    await expect(
      connectFleet(
        config,
        "arbitrary",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        f,
      ),
    ).rejects.toThrow("not configured");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete and malformed descriptors before declaring readiness or minting a credential", async () => {
    for (const body of [
      { environmentId: "environment-m1" },
      { ...descriptor("environment-m1"), platform: { os: "unsupported", arch: "arm64" } },
      { ...descriptor("environment-m1"), capabilities: null },
    ]) {
      const f = vi.fn<typeof fetch>(async () => Response.json(body));
      const config = parseFleetConfig(source());
      expect((await discoverFleet(config, "127.0.0.1", f)).machines[0]?.status).toBe("unreachable");
      await expect(
        connectFleet(config, "m1", new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]), f),
      ).rejects.toThrow("unavailable");
      expect(f.mock.calls).toHaveLength(2);
      expect(
        f.mock.calls.every(
          ([url, init]) =>
            String(url).endsWith("/.well-known/studio/environment") && init?.headers === undefined,
        ),
      ).toBe(true);
    }
  });
  it("issues an ordinary one-time pairing with the intersection of caller and operator grants", async () => {
    const f = fetcher();
    const result = await connectFleet(
      parseFleetConfig(source()),
      "m1",
      new Set([AuthOrchestrationReadScope, AuthAccessWriteScope]),
      f,
    );
    expect(JSON.parse(String(f.mock.calls[1]?.[1]?.body))).toEqual({
      label: "Private fleet browser",
      scopes: [AuthOrchestrationReadScope],
    });
    expect(result).toMatchObject({
      environmentId: "environment-m1",
      host: "https://fixture.tailnet.ts.net:8443",
      pairingCode: "one-time-synthetic",
      scopes: [AuthOrchestrationReadScope],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(f.mock.calls[1]?.[1]?.redirect).toBe("error");
  });
  it("requires auth administration by default; explicit operator delegation grants only standard scopes", async () => {
    const f = fetcher();
    const operator = new Set([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    await expect(connectFleet(parseFleetConfig(source()), "m1", operator, f)).rejects.toThrow(
      "cannot pair",
    );
    expect(f).not.toHaveBeenCalled();
    const raw = { ...source(), allowConnectFrom: AuthOrchestrationOperateScope };
    const result = await connectFleet(parseFleetConfig(raw), "m1", operator, f);
    expect(result.scopes).toEqual([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    await expect(
      connectFleet(parseFleetConfig(raw), "m1", new Set([AuthOrchestrationReadScope]), f),
    ).rejects.toThrow("cannot pair");
    expect(() =>
      parseFleetConfig({
        ...raw,
        machines: [
          { ...raw.machines[0], scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope] },
        ],
      }),
    ).toThrow("securely");
    expect(() =>
      parseFleetConfig({ ...raw, allowConnectFrom: AuthOrchestrationReadScope }),
    ).toThrow("securely");
  });
  it("fails closed when no read grant remains or the target rejects/redirects pairing", async () => {
    const config = parseFleetConfig(source());
    const f = fetcher();
    await expect(connectFleet(config, "m1", new Set([AuthAccessWriteScope]), f)).rejects.toThrow(
      "cannot pair",
    );
    expect(f).not.toHaveBeenCalled();
    const rejected = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? new Response("secret detail", { status: 401 })
        : Response.json(descriptor("environment-m1")),
    );
    await expect(
      connectFleet(
        config,
        "m1",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        rejected,
      ),
    ).rejects.toThrow("renew");
  });
});
