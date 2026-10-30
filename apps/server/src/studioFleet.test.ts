import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native permissions and symlinks independently exercise the secure fleet-file reader.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "./nodePath.ts";
import {
  authScopeResponse,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { StudioFleetConnectInput } from "@specweave-studio/contracts/studioFleet";
import { connectFleet, discoverFleet, parseFleetConfig, readFleetConfig } from "./studioFleet.ts";
import { loadOrCreateFleetProofKey } from "./fleet/fleetProofKey.ts";
import { makeFleetLink } from "./fleet/fleetTransport.ts";
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
describe("SpecWithCode Connect addresses", () => {
  const connect = "https://prod-0123456789abcdef.spec-weave.com";
  const withMachine = (fields: Record<string, unknown>) => {
    const raw = source();
    Object.assign(raw.machines[0]!, fields);
    return raw;
  };
  it("parses an old file exactly as before", () => {
    expect(parseFleetConfig(source())).toEqual({
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
  });
  it("accepts a Connect url alone or a Connect connectUrl beside a tailnet url", () => {
    expect(parseFleetConfig(withMachine({ url: `${connect}/` })).machines[0]).toMatchObject({
      url: connect,
    });
    const both = parseFleetConfig(withMachine({ connectUrl: connect })).machines[0]!;
    expect(both.url).toBe("https://fixture.tailnet.ts.net:8443");
    expect(both.connectUrl).toBe(connect);
  });
  it("refuses a lookalike, a connectUrl beside a Connect url, and a tailnet connectUrl", () => {
    for (const fields of [
      { url: "https://relay.spec-weave.com" },
      { url: "https://prod-0123456789abcdef.spec-weave.com.evil.com" },
      { url: "https://a.prod-0123456789abcdef.spec-weave.com" },
      { url: `${connect}:8443` },
      { connectUrl: "https://relay.spec-weave.com" },
      { connectUrl: "https://other.tailnet.ts.net" },
      { connectUrl: `${connect}/path` },
      { connectUrl: 42 },
      { url: connect, connectUrl: "https://prod-fedcba9876543210.spec-weave.com" },
    ])
      expect(() => parseFleetConfig(withMachine(fields)), JSON.stringify(fields)).toThrow(
        "securely",
      );
  });
  it("keeps every address unique across machines and skips a bad connectUrl on read", () => {
    const second = (fields: Record<string, unknown>) => ({
      id: "m2",
      label: "Mac M2",
      environmentId: "environment-m2",
      url: "https://m2.tailnet.ts.net",
      scopes: [AuthOrchestrationReadScope],
      ...fields,
    });
    const first = withMachine({ connectUrl: connect }).machines[0]!;
    for (const fields of [{ url: connect, connectUrl: undefined }, { connectUrl: connect }])
      expect(() => parseFleetConfig({ version: 1, machines: [first, second(fields)] })).toThrow(
        "securely",
      );
    const tolerant = parseFleetConfig(
      {
        version: 1,
        machines: [first, second({ connectUrl: "https://relay.spec-weave.com" })],
      },
      { tolerant: true },
    );
    expect(tolerant.machines.map((m) => m.id)).toEqual(["m1"]);
    expect(tolerant.invalidEntries).toEqual([
      { index: 1, label: "Mac M2", reason: expect.stringContaining("connectUrl") },
    ]);
  });
  it("lists Connect as primary while reporting bearer management binding separately", async () => {
    const f = fetcher();
    const snapshot = await discoverFleet(
      parseFleetConfig(withMachine({ connectUrl: connect })),
      "127.0.0.1",
      f,
    );
    expect(snapshot.machines[0]).toMatchObject({
      url: source().machines[0]!.url,
      connectUrl: connect,
      status: "reachable",
      transport: "connect",
      managementBinding: "bearer",
    });
    // Discovery proves the public identity, not permission to send a bearer there.
    expect(f.mock.calls.map(([url]) => String(url))).toEqual([
      `${connect}/.well-known/studio/environment`,
    ]);
    for (const [, init] of f.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain(source().machines[0]!.managementToken);
  });
  it("lists Tailscale as fallback when Connect is unavailable without sending credentials", async () => {
    const f = vi.fn<typeof fetch>(async (url) => {
      if (String(url).startsWith(connect)) throw new TypeError("Connect offline");
      return Response.json(descriptor("environment-m1"));
    });
    const snapshot = await discoverFleet(
      parseFleetConfig(withMachine({ connectUrl: connect })),
      "127.0.0.1",
      f,
    );
    expect(snapshot.machines[0]).toMatchObject({
      url: source().machines[0]!.url,
      connectUrl: connect,
      status: "reachable",
      transport: "tailnet",
      managementBinding: "bearer",
    });
    expect(f.mock.calls.map(([url]) => String(url))).toEqual([
      `${connect}/.well-known/studio/environment`,
      `${source().machines[0]!.url}/.well-known/studio/environment`,
    ]);
    for (const [, init] of f.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
  it("says which address answered and whether the saved token is bound", async () => {
    const bound = `${Buffer.from(JSON.stringify({ sid: "s", jkt: "thumb" })).toString("base64url")}.sig`;
    const connectOnly = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith(connect)
        ? Response.json(descriptor("environment-m1"))
        : Promise.reject(new TypeError("tailnet down")),
    );
    const snapshot = await discoverFleet(
      parseFleetConfig(withMachine({ connectUrl: connect, managementToken: bound })),
      "127.0.0.1",
      connectOnly,
    );
    expect(snapshot.machines[0]).toMatchObject({
      status: "reachable",
      transport: "connect",
      managementBinding: "proof",
      machineName: "Fixture Mac",
    });
    const offline = await discoverFleet(
      parseFleetConfig(withMachine({ connectUrl: connect })),
      "127.0.0.1",
      vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(offline.machines[0]?.status).toBe("unreachable");
    expect(offline.machines[0]?.transport).toBeUndefined();
  });
  it("never sends a bearer token to a Connect address when pairing", async () => {
    const connectOnly = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith(connect)
        ? Response.json(descriptor("environment-m1"))
        : Promise.reject(new TypeError("tailnet down")),
    );
    await expect(
      connectFleet(
        parseFleetConfig(withMachine({ connectUrl: connect })),
        "m1",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        connectOnly,
      ),
    ).rejects.toThrow("only through SpecWithCode Connect");
    for (const [, init] of connectOnly.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
  it("pairs a browser over the tailnet when Connect also answers for a bound token", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "studio-fleet-pair-"));
    dirs.push(baseDir);
    const key = await loadOrCreateFleetProofKey(baseDir);
    const bound = `${Buffer.from(JSON.stringify({ sid: "s", jkt: key.thumbprint })).toString("base64url")}.sig`;
    const f = fetcher();
    const result = await connectFleet(
      parseFleetConfig(withMachine({ connectUrl: connect, managementToken: bound })),
      "m1",
      new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
      makeFleetLink({ fetch: f, baseDir }),
    );
    const tailnet = source().machines[0]!.url;
    expect(result).toMatchObject({ host: tailnet, pairingCode: "one-time-synthetic" });
    // Nothing went to the Connect address: no identity read, no code minted there.
    expect(f.mock.calls.map(([url]) => String(url))).toEqual([
      `${tailnet}/.well-known/studio/environment`,
      `${tailnet}/api/auth/pairing-token`,
    ]);
  });
  it("says Tailscale is needed when only Connect answers for a bound token, minting nothing", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "studio-fleet-pair-"));
    dirs.push(baseDir);
    const key = await loadOrCreateFleetProofKey(baseDir);
    const bound = `${Buffer.from(JSON.stringify({ sid: "s", jkt: key.thumbprint })).toString("base64url")}.sig`;
    const connectOnly = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith(connect)
        ? Response.json(descriptor("environment-m1"))
        : Promise.reject(new TypeError("tailnet down")),
    );
    await expect(
      connectFleet(
        parseFleetConfig(withMachine({ connectUrl: connect, managementToken: bound })),
        "m1",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        makeFleetLink({ fetch: connectOnly, baseDir }),
      ),
    ).rejects.toMatchObject({ kind: "connect-browser-unsupported" });
    expect(connectOnly.mock.calls.some(([url]) => String(url).endsWith("/pairing-token"))).toBe(
      false,
    );
  });
});
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
  it("skips one invalid machine line on read but keeps duplicates and writes strict", async () => {
    const machine = (n: number, url = `https://m${n}.tailnet.ts.net`) => ({
      id: `m${n}`,
      label: `Mac M${n}`,
      environmentId: `environment-m${n}`,
      url,
      scopes: [AuthOrchestrationReadScope],
    });
    const raw = {
      version: 1,
      machines: [machine(1), machine(2, "https://example.com"), machine(3)],
    };
    const config = parseFleetConfig(raw, { tolerant: true });
    expect(config.machines.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(config.invalidEntries).toEqual([
      { index: 1, label: "Mac M2", reason: expect.stringContaining("ts.net") },
    ]);
    // Strict is the default, used by every write.
    expect(() => parseFleetConfig(raw)).toThrow("securely");
    for (const duplicate of [
      { ...machine(3), id: "m1" },
      { ...machine(3), environmentId: "environment-m1" },
      machine(3, "https://m1.tailnet.ts.net"),
    ])
      expect(() =>
        parseFleetConfig({ ...raw, machines: [...raw.machines, duplicate] }, { tolerant: true }),
      ).toThrow("securely");
    expect(() => parseFleetConfig({ ...raw, endpoint: "evil" }, { tolerant: true })).toThrow(
      "securely",
    );

    const dir = await mkdtemp(join(tmpdir(), "studio-fleet-test-"));
    dirs.push(dir);
    await writeFile(join(dir, "studio-fleet.json"), JSON.stringify(raw), { mode: 0o600 });
    const read = await readFleetConfig(dir);
    expect(read?.machines.map((m) => m.id)).toEqual(["m1", "m3"]);
    const snapshot = await discoverFleet(read, "127.0.0.1", fetcher());
    expect(snapshot.machines).toHaveLength(2);
    expect(snapshot.invalidEntries).toEqual([
      { kind: "config", index: 1, label: "Mac M2", reason: expect.stringContaining("ts.net") },
    ]);
    expect(
      (await discoverFleet(parseFleetConfig(source()), "127.0.0.1", fetcher())).invalidEntries,
    ).toBeUndefined();
  });
  it("reads only an owner-only regular file and refuses symlink credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-fleet-test-"));
    dirs.push(dir);
    expect(await readFleetConfig(dir)).toBeNull();
    const file = join(dir, "studio-fleet.json");
    await writeFile(file, JSON.stringify(source()), { mode: 0o600 });
    expect((await readFleetConfig(dir))?.machines).toHaveLength(1);
    // Windows has no POSIX mode bits; the profile folder's ACL keeps the file private.
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(readFleetConfig(dir)).rejects.toThrow("securely");
    }
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
    expect(snapshot.machines[0]?.machineName).toBe(descriptor("environment-m1").label);
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
    // A revoked token: the machine refuses the pairing and the session read.
    const rejected = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token") || String(url).endsWith("/api/auth/session")
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
  it("says to make a new invitation when the token can only manage access there", async () => {
    const config = parseFleetConfig(source());
    // What `fleet invite` made before 1.0.52: the machine accepts the token
    // but will not hand out scopes it does not hold.
    const limited = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? Response.json({ code: "insufficient_scope" }, { status: 403 })
        : String(url).endsWith("/api/auth/session")
          ? Response.json({ authenticated: true, ...authScopeResponse([AuthAccessWriteScope]) })
          : Response.json(descriptor("environment-m1")),
    );
    await expect(
      connectFleet(
        config,
        "m1",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        limited,
      ),
    ).rejects.toThrow("cannot open sessions");
  });
  it("says to approve the machine again when its update turned down the saved invitation", async () => {
    const config = parseFleetConfig(source());
    // A machine on 1.0.77 or later refuses invitations issued before approvals
    // named the coordinator, and says so on its session endpoint.
    const outdated = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? Response.json({ code: "invalid_credential" }, { status: 401 })
        : String(url).endsWith("/api/auth/session")
          ? Response.json({
              authenticated: false,
              reapprovalRequired: true,
              message: "Approve this device again in SpecWithCode.",
            })
          : Response.json(descriptor("environment-m1")),
    );
    await expect(
      connectFleet(
        config,
        "m1",
        new Set([AuthAccessWriteScope, AuthOrchestrationReadScope]),
        outdated,
      ),
    ).rejects.toThrow("Invite this machine");
  });
});
