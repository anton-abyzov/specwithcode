import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  authScopeResponse,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native permissions and symlinks independently exercise the fleet-file writer.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { join } from "./nodePath.ts";
import { readFleetConfig } from "./studioFleet.ts";
import {
  addFleetMachine,
  decodeFleetJoinCode,
  encodeFleetJoinCode,
  type FleetJoin,
  fleetMachineIdFor,
  removeFleetMachine,
  removeFleetMachineEverywhere,
  revokeManagementToken,
} from "./studioFleetJoin.ts";
import { fleetRemoveSummary } from "./cli/fleet.ts";

const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Fixture Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});
const invite = (overrides: Partial<FleetJoin> = {}): FleetJoin => ({
  url: "https://m1.fixture.ts.net",
  environmentId: "environment-m1",
  label: "Mac M1",
  managementToken: "synthetic-new-management-token",
  ...overrides,
});
/** As a real server answers: `scopes` is the legacy subset, `permissions` the grant. */
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  authenticated: true,
  ...authScopeResponse(scopes),
  sessionMethod: "bearer-access-token",
});
/**
 * Answers every address as the environment it is mapped to, and its session
 * endpoint with the scopes the invitation's token holds there.
 */
const fetcher = (
  byOrigin: Record<string, string>,
  tokenScopes: ReadonlyArray<AuthEnvironmentScope> | "unsupported" = [
    ...AuthStandardClientScopes,
    AuthAccessWriteScope,
  ],
) =>
  vi.fn<typeof fetch>(async (url) => {
    const target = new URL(String(url));
    const environmentId = byOrigin[target.origin];
    if (environmentId === undefined) return Promise.reject(new TypeError("unreachable"));
    if (target.pathname === "/api/auth/session")
      return tokenScopes === "unsupported"
        ? new Response("not found", { status: 404 })
        : Response.json(session(tokenScopes));
    return Response.json(descriptor(environmentId));
  });
const dirs: string[] = [];
const home = async () => {
  const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-join-"));
  dirs.push(dir);
  return dir;
};
const relayed = {
  version: 1,
  machines: [
    {
      id: "m1",
      label: "Mac M1",
      environmentId: "environment-m1",
      url: "https://m4.fixture.ts.net:8443",
      managementToken: "synthetic-old-management-token",
      scopes: ["orchestration:read", "orchestration:operate"],
    },
  ],
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

describe("machine invitations", () => {
  it("round-trips through a copy with line breaks and spaces", () => {
    const code = encodeFleetJoinCode(invite());
    const wrapped = `  ${code.slice(0, 30)}\n${code.slice(30)}  `;
    expect(decodeFleetJoinCode(wrapped)).toEqual(invite());
  });

  it("rejects anything but a private Tailscale HTTPS address and the exact fields", () => {
    for (const bad of [
      invite({ url: "http://m1.fixture.ts.net" }),
      invite({ url: "https://192.168.1.20:8319" }),
      invite({ url: "https://m1.fixture.ts.net/relay" }),
      invite({ managementToken: "has spaces" }),
    ])
      expect(() => decodeFleetJoinCode(encodeFleetJoinCode(bad))).toThrow(
        "not a machine invitation",
      );
    const extra = `swc-machine-${Buffer.from(JSON.stringify({ v: 1, ...invite(), scopes: ["access:write"] })).toString("base64url")}`;
    expect(() => decodeFleetJoinCode(extra)).toThrow("not a machine invitation");
    expect(() => decodeFleetJoinCode("https://m1.fixture.ts.net")).toThrow(
      "not a machine invitation",
    );
  });

  it("makes short unique ids from names", () => {
    expect(fleetMachineIdFor("Hetzner VPS", new Set())).toBe("hetzner-vps");
    expect(fleetMachineIdFor("Mac M1", new Set(["mac-m1"]))).toBe("mac-m1-2");
    expect(fleetMachineIdFor("???", new Set())).toBe("machine");
  });
});

describe("adding machines to the fleet file", () => {
  it("creates an owner-only file the server reads, after the address answers as that machine", async () => {
    const baseDir = await home();
    const result = await addFleetMachine({
      baseDir,
      code: encodeFleetJoinCode(invite()),
      fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-m1" }),
    });
    expect(result).toEqual({
      id: "mac-m1",
      label: "Mac M1",
      url: "https://m1.fixture.ts.net",
      environmentId: "environment-m1",
      change: "added",
    });
    expect((await NodeFSP.stat(join(baseDir, "studio-fleet.json"))).mode & 0o777).toBe(0o600);
    const config = await readFleetConfig(baseDir);
    expect(config?.machines.map((m) => [m.id, m.url, m.managementToken])).toEqual([
      ["mac-m1", "https://m1.fixture.ts.net", "synthetic-new-management-token"],
    ]);
    // No temp file is left behind.
    expect(await NodeFSP.readdir(baseDir)).toEqual(["studio-fleet.json"]);
  });

  it("moves a relayed machine to its own address and keeps its id, label and scopes", async () => {
    const baseDir = await home();
    await NodeFSP.writeFile(join(baseDir, "studio-fleet.json"), JSON.stringify(relayed), {
      mode: 0o600,
    });
    const result = await addFleetMachine({
      baseDir,
      code: encodeFleetJoinCode(invite({ label: "Anton's M1" })),
      fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-m1" }),
    });
    expect(result).toMatchObject({
      id: "m1",
      label: "Mac M1",
      change: "updated",
      previousUrl: "https://m4.fixture.ts.net:8443",
    });
    const written = JSON.parse(await NodeFSP.readFile(join(baseDir, "studio-fleet.json"), "utf8"));
    expect(written.machines).toEqual([
      {
        ...relayed.machines[0],
        url: "https://m1.fixture.ts.net",
        managementToken: "synthetic-new-management-token",
      },
    ]);
  });

  it("writes nothing when the address does not answer as that machine", async () => {
    const baseDir = await home();
    await NodeFSP.writeFile(join(baseDir, "studio-fleet.json"), JSON.stringify(relayed), {
      mode: 0o600,
    });
    const before = await NodeFSP.readFile(join(baseDir, "studio-fleet.json"), "utf8");
    await expect(
      addFleetMachine({
        baseDir,
        code: encodeFleetJoinCode(invite()),
        fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-other" }),
      }),
    ).rejects.toThrow("different machine");
    await expect(
      addFleetMachine({ baseDir, code: encodeFleetJoinCode(invite()), fetcher: fetcher({}) }),
    ).rejects.toThrow("unavailable");
    expect(await NodeFSP.readFile(join(baseDir, "studio-fleet.json"), "utf8")).toBe(before);
  });

  it("refuses an invitation whose token cannot open sessions there, and writes nothing", async () => {
    const baseDir = await home();
    await NodeFSP.writeFile(join(baseDir, "studio-fleet.json"), JSON.stringify(relayed), {
      mode: 0o600,
    });
    const before = await NodeFSP.readFile(join(baseDir, "studio-fleet.json"), "utf8");
    // What `fleet invite` made before 1.0.52: a token that can only manage access.
    const fetch = fetcher({ "https://m1.fixture.ts.net": "environment-m1" }, [
      AuthAccessWriteScope,
    ]);
    await expect(
      addFleetMachine({ baseDir, code: encodeFleetJoinCode(invite()), fetcher: fetch }),
    ).rejects.toThrow("cannot open sessions");
    expect(await NodeFSP.readFile(join(baseDir, "studio-fleet.json"), "utf8")).toBe(before);
    const sessionCall = fetch.mock.calls.find(
      ([url]) => new URL(String(url)).pathname === "/api/auth/session",
    );
    expect(new Headers(sessionCall?.[1]?.headers).get("authorization")).toBe(
      "Bearer synthetic-new-management-token",
    );
  });

  it("refuses a new machine whose token cannot open sessions there", async () => {
    const baseDir = await home();
    await expect(
      addFleetMachine({
        baseDir,
        code: encodeFleetJoinCode(invite()),
        fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-m1" }, [AuthAccessWriteScope]),
      }),
    ).rejects.toThrow("cannot open sessions");
    await expect(NodeFSP.stat(join(baseDir, "studio-fleet.json"))).rejects.toThrow();
  });

  it("adds a machine whose server does not report its token's scopes", async () => {
    const baseDir = await home();
    const added = await addFleetMachine({
      baseDir,
      code: encodeFleetJoinCode(invite()),
      fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-m1" }, "unsupported"),
    });
    expect(added.change).toBe("added");
  });

  it("refuses an address another machine uses and a symlinked fleet file", async () => {
    const baseDir = await home();
    await NodeFSP.writeFile(join(baseDir, "studio-fleet.json"), JSON.stringify(relayed), {
      mode: 0o600,
    });
    await expect(
      addFleetMachine({
        baseDir,
        code: encodeFleetJoinCode(
          invite({ url: "https://m4.fixture.ts.net:8443", environmentId: "environment-m3" }),
        ),
        fetcher: fetcher({ "https://m4.fixture.ts.net:8443": "environment-m3" }),
      }),
    ).rejects.toThrow("already uses this address");

    const linked = await home();
    await NodeFSP.symlink(join(baseDir, "studio-fleet.json"), join(linked, "studio-fleet.json"));
    await expect(
      addFleetMachine({
        baseDir: linked,
        code: encodeFleetJoinCode(invite()),
        fetcher: fetcher({ "https://m1.fixture.ts.net": "environment-m1" }),
      }),
    ).rejects.toThrow();
  });

  it("removes a machine by id or name", async () => {
    const baseDir = await home();
    await NodeFSP.writeFile(join(baseDir, "studio-fleet.json"), JSON.stringify(relayed), {
      mode: 0o600,
    });
    expect(await removeFleetMachine({ baseDir, machine: "mac m1" })).toEqual({
      id: "m1",
      label: "Mac M1",
      environmentId: "environment-m1",
    });
    expect((await readFleetConfig(baseDir))?.machines).toEqual([]);
    await expect(removeFleetMachine({ baseDir, machine: "m1" })).rejects.toThrow(
      "No configured machine",
    );
  });

  describe("removing a machine revokes what this machine holds there", () => {
    const token = `${Buffer.from(JSON.stringify({ sid: "management-session-1" })).toString("base64url")}.signature`;
    const target = {
      url: "https://m1.fixture.ts.net",
      environmentId: "environment-m1" as never,
      managementToken: token,
    };
    /** Answers as `environmentId`; the self-revoke endpoint answers `revokeStatus`. */
    const machine = (environmentId: string, revokeStatus: number) => {
      const revokes: Array<string | null> = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api/auth/session/revoke") {
          revokes.push(new Headers(init?.headers).get("authorization"));
          return new Response("{}", { status: revokeStatus });
        }
        return Response.json(descriptor(environmentId));
      });
      return { fetch, revokes };
    };

    it("revokes the management token on the machine it was made for", async () => {
      const { fetch, revokes } = machine("environment-m1", 200);
      expect(await revokeManagementToken(fetch, target)).toEqual({
        result: "revoked",
        sessionId: "management-session-1",
      });
      expect(revokes).toEqual([`Bearer ${token}`]);
    });

    it("keeps it, saying so, when that machine is too old or unreachable", async () => {
      expect(
        (await revokeManagementToken(machine("environment-m1", 404).fetch, target)).result,
      ).toBe("kept");
      const offline = vi.fn<typeof globalThis.fetch>(async () =>
        Promise.reject(new TypeError("offline")),
      );
      expect(await revokeManagementToken(offline, target)).toEqual({
        result: "kept",
        sessionId: "management-session-1",
      });
    });

    it("never sends the token to an address that answers as another machine", async () => {
      const { fetch, revokes } = machine("environment-someone-else", 200);
      expect((await revokeManagementToken(fetch, target)).result).toBe("kept");
      expect(revokes).toEqual([]);
    });

    it("removes the machine either way and reports what is still valid there", async () => {
      const baseDir = await home();
      await NodeFSP.writeFile(
        join(baseDir, "studio-fleet.json"),
        JSON.stringify({
          ...relayed,
          machines: [{ ...relayed.machines[0], url: target.url, managementToken: token }],
        }),
        { mode: 0o600 },
      );
      const offline = vi.fn<typeof globalThis.fetch>(async () =>
        Promise.reject(new TypeError("offline")),
      );
      const removed = await removeFleetMachineEverywhere({
        baseDir,
        machine: "m1",
        fetcher: offline,
        revokeWorkerAccess: async () => "kept",
      });
      expect(removed).toEqual({
        id: "m1",
        label: "Mac M1",
        environmentId: "environment-m1",
        managementToken: "kept",
        workerAccess: "kept",
        managementSessionId: "management-session-1",
      });
      expect((await readFleetConfig(baseDir))?.machines).toEqual([]);

      // Phone links there go before the management token that reaches them,
      // and a failure to reach them never blocks the removal.
      await NodeFSP.writeFile(
        join(baseDir, "studio-fleet.json"),
        JSON.stringify({
          ...relayed,
          machines: [{ ...relayed.machines[0], url: target.url, managementToken: token }],
        }),
        { mode: 0o600 },
      );
      const order: string[] = [];
      const tracked = vi.fn<typeof globalThis.fetch>(async (input) => {
        order.push(`fetch ${new URL(String(input)).pathname}`);
        throw new TypeError("offline");
      });
      const unlinked = await removeFleetMachineEverywhere({
        baseDir,
        machine: "m1",
        fetcher: tracked,
        revokeWorkerAccess: async () => "kept",
        unlinkPhones: async (machine) => {
          order.push(`unlink ${machine.environmentId}`);
          throw new Error("offline");
        },
      });
      expect(unlinked.id).toBe("m1");
      expect(order[0]).toBe("unlink environment-m1");
      expect(order.length).toBeGreaterThan(1);
      expect((await readFleetConfig(baseDir))?.machines).toEqual([]);
      const summary = fleetRemoveSummary(removed, "specwithcode");
      expect(summary).toContain("still valid on Mac M1");
      expect(summary).toContain("specwithcode auth session revoke management-session-1");
      expect(
        fleetRemoveSummary(
          {
            ...removed,
            managementToken: "revoked",
            workerAccess: "revoked",
            managementSessionId: null,
          },
          "specwithcode",
        ),
      ).toBe(
        "Removed Mac M1.\nRevoked this machine's worker access on Mac M1.\nRevoked this machine's management token on Mac M1.",
      );
    });
  });
});
