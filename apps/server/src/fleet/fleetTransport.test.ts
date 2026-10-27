import { EnvironmentId } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real key file for the link.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import {
  FLEET_ADDRESS_TTL_MS,
  fleetAuthorization,
  fleetRequest,
  makeFleetAddressBook,
  makeFleetLink,
  reachFleetMachine,
  type FleetLink,
} from "./fleetTransport.ts";

const TAILNET = "https://m1.fixture.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const target = {
  id: "m1",
  environmentId: EnvironmentId.make("env-m1"),
  url: TAILNET,
  connectUrl: CONNECT,
};
const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Mac M1",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});
/** A Studio-shaped token, bound to `jkt` when given. */
const token = (jkt?: string) =>
  `${Buffer.from(JSON.stringify({ sid: "s1", ...(jkt ? { jkt } : {}) })).toString("base64url")}.sig`;

/** Answers on `up` origins as `as[origin]` (default env-m1); everything else is offline. */
function network(up: Set<string>, as: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async (url) => {
    const target = new URL(String(url));
    if (!up.has(target.origin)) throw new TypeError("offline");
    if (target.pathname === "/.well-known/studio/environment")
      return Response.json(descriptor(as[target.origin] ?? "env-m1"));
    return Response.json({ ok: true });
  });
}

const dirs: string[] = [];
const home = async () => {
  const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-transport-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

/** A link with this machine's key and a clock the test moves. */
async function boundLink(fetcher: typeof fetch) {
  const baseDir = await home();
  const key = await loadOrCreateFleetProofKey(baseDir);
  let now = 1_000_000;
  const link: FleetLink = {
    ...makeFleetLink({ fetch: fetcher, baseDir, book: makeFleetAddressBook() }),
    now: () => now,
  };
  return { link, key, advance: (ms: number) => (now += ms) };
}

describe("reaching a fleet machine", () => {
  it("reaches the worker over Connect when the tailnet is down, with a proof and no bearer", async () => {
    const up = new Set([CONNECT]);
    const f = network(up);
    const { link, key, advance } = await boundLink(f);
    const bound = token(key.thumbprint);
    expect((await reachFleetMachine(link, target, { token: bound })).transport).toBe("connect");
    const { response, address } = await fleetRequest(link, target, "/api/auth/session", {
      token: bound,
    });
    expect(response.status).toBe(200);
    expect(address.origin).toBe(CONNECT);
    const sent = f.mock.calls.at(-1)!;
    expect(String(sent[0])).toBe(`${CONNECT}/api/auth/session`);
    const headers = sent[1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`DPoP ${bound}`);
    expect(headers.dpop).toMatch(/^ey/);
    expect(sent[1]!.redirect).toBe("error");

    // Remembered: the next call goes straight to Connect.
    up.add(TAILNET);
    expect((await reachFleetMachine(link, target, { token: bound })).origin).toBe(CONNECT);
    // After the TTL the tailnet is tried first again.
    advance(FLEET_ADDRESS_TTL_MS + 1);
    expect((await reachFleetMachine(link, target, { token: bound })).origin).toBe(TAILNET);
  });

  it("never contacts Connect with an unbound token: connect-unbound", async () => {
    const f = network(new Set([CONNECT]));
    const { link } = await boundLink(f);
    await expect(
      fleetRequest(link, target, "/api/auth/session", { token: token() }),
    ).rejects.toMatchObject({ kind: "connect-unbound" });
    // Connect was only asked who it is (no credential), never sent the token.
    const toConnect = f.mock.calls.filter(([url]) => String(url).startsWith(CONNECT));
    expect(toConnect.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/.well-known/studio/environment",
    ]);
    expect(
      toConnect.every(([, init]) => !JSON.stringify(init?.headers ?? {}).includes(token())),
    ).toBe(true);
    // The same unbound token over the tailnet is a plain bearer, as before.
    const tailnet = network(new Set([TAILNET]));
    const { response } = await fleetRequest(tailnet, target, "/api/auth/session", {
      token: token(),
    });
    expect(response.status).toBe(200);
    expect((tailnet.mock.calls.at(-1)![1]!.headers as Record<string, string>).authorization).toBe(
      `Bearer ${token()}`,
    );
  });

  it("calls a machine that is simply off unreachable, not one that needs a new invitation", async () => {
    const f = network(new Set());
    const { link } = await boundLink(f);
    await expect(reachFleetMachine(link, target, { token: token() })).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("never extends an address's trust with traffic: identity is proven again after the TTL", async () => {
    const up = new Set([CONNECT]);
    const f = network(up);
    const { link, key, advance } = await boundLink(f);
    const bound = token(key.thumbprint);
    const identityChecks = () =>
      f.mock.calls.filter(([url]) => String(url).endsWith("/.well-known/studio/environment"))
        .length;
    await fleetRequest(link, target, "/api/auth/session", { token: bound });
    const first = identityChecks();
    up.add(TAILNET);
    // Steady traffic within the TTL reuses the proven Connect address...
    for (let minute = 0; minute < 4; minute += 1) {
      advance(60_000);
      const { address } = await fleetRequest(link, target, "/api/auth/session", { token: bound });
      expect(address.origin).toBe(CONNECT);
    }
    expect(identityChecks()).toBe(first);
    // ...but cannot keep it past the TTL counted from its identity check.
    advance(FLEET_ADDRESS_TTL_MS - 4 * 60_000);
    const { address } = await fleetRequest(link, target, "/api/auth/session", { token: bound });
    expect(address.origin).toBe(TAILNET);
    expect(identityChecks()).toBe(first + 1);
  });

  it("refuses a token bound to a key this machine does not hold", async () => {
    const f = network(new Set([CONNECT, TAILNET]));
    const { link } = await boundLink(f);
    await expect(
      reachFleetMachine(link, target, { token: token("someone-else") }),
    ).rejects.toMatchObject({ kind: "connect-key-missing" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports an address that answers as another machine", async () => {
    const f = network(new Set([CONNECT]), { [CONNECT]: "env-other" });
    const { link, key } = await boundLink(f);
    await expect(
      reachFleetMachine(link, target, { token: token(key.thumbprint) }),
    ).rejects.toMatchObject({ kind: "identity-mismatch" });
  });

  it("does not resend a request that may have been delivered, unless idempotent", async () => {
    const up = new Set([TAILNET, CONNECT]);
    let posts = 0;
    const f = vi.fn<typeof fetch>(async (url) => {
      const where = new URL(String(url));
      if (!up.has(where.origin)) throw new TypeError("offline");
      if (where.pathname === "/.well-known/studio/environment")
        return Response.json(descriptor("env-m1"));
      if (where.origin === TAILNET) {
        posts += 1;
        throw new TypeError("connection reset");
      }
      return Response.json({ ok: true });
    });
    const { link, key } = await boundLink(f);
    const bound = token(key.thumbprint);
    await expect(
      fleetRequest(link, target, "/api/x", { method: "POST", token: bound }),
    ).rejects.toMatchObject({ kind: "unreachable" });
    expect(posts).toBe(1);
    expect(f.mock.calls.some(([url]) => String(url) === `${CONNECT}/api/x`)).toBe(false);
    const { address } = await fleetRequest(link, target, "/api/x", {
      token: bound,
      idempotent: true,
    });
    expect(address.origin).toBe(CONNECT);
  });

  it("builds headers only for the address they go to", async () => {
    const { link, key } = await boundLink(network(new Set()));
    const connect = { origin: CONNECT, transport: "connect" as const };
    await expect(
      fleetAuthorization(link, connect, "GET", `${CONNECT}/x`, token()),
    ).rejects.toMatchObject({ kind: "connect-unbound" });
    await expect(
      fleetAuthorization(link, connect, "GET", `${TAILNET}/x`, token(key.thumbprint)),
    ).rejects.toMatchObject({ kind: "unreachable" });
    const tailnet = { origin: TAILNET, transport: "tailnet" as const };
    const bound = token(key.thumbprint);
    expect(await fleetAuthorization(link, tailnet, "GET", `${TAILNET}/x`, bound)).toMatchObject({
      authorization: `DPoP ${bound}`,
    });
  });
});
