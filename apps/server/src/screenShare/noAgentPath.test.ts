// @effect-diagnostics-next-line nodeBuiltinImport:off - reads this repository's own source files.
import * as NodeFs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - joins paths under this repository.
import * as NodePath from "node:path";

import {
  CLIENT_GUARDED_RPC_SCOPES,
  SCREEN_SHARE_HOST_PATH,
  SCREEN_SHARE_ROUTE_PREFIX,
  SCREEN_SHARE_VIEW_PATH,
  WS_METHODS,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  hostHelloProof,
  screenShareSocketOf,
  screenShareSocketRefusal,
  viewerSessionEnd,
} from "./ScreenShareHttp.ts";

/**
 * Screen sharing has no path an agent can take (1490 AC-16): no RPC method, so
 * nothing a scope could unlock, no MCP tool, and no HTTP route but the two
 * guarded sockets. These fail the day someone adds one without deciding to.
 */
const SCREEN_SHARE = /screen[-_ ]?shar/i;
const serverSource = NodePath.resolve(import.meta.dirname, "..");

const filesUnder = (folder: string): ReadonlyArray<string> =>
  NodeFs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(folder, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

describe("screen sharing has no agent path", () => {
  it("no RPC method names it", () => {
    const named = [...Object.keys(WS_METHODS), ...Object.values(WS_METHODS)].filter((name) =>
      SCREEN_SHARE.test(String(name)),
    );
    expect(named).toEqual([]);
    expect(
      Object.keys(CLIENT_GUARDED_RPC_SCOPES).filter((name) => SCREEN_SHARE.test(name)),
    ).toEqual([]);
  });

  it("no MCP toolkit mentions it", () => {
    const files = filesUnder(NodePath.join(serverSource, "mcp"));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => SCREEN_SHARE.test(NodeFs.readFileSync(file, "utf8")))).toEqual(
      [],
    );
  });

  it("the server's HTTP routes reach it only through the two guarded sockets", () => {
    const paths = /SCREEN_SHARE_(?:ROUTE_PREFIX|HOST_PATH|VIEW_PATH)|\/api\/screen-share/;
    const routed = filesUnder(serverSource)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => paths.test(NodeFs.readFileSync(file, "utf8")))
      .map((file) => NodePath.relative(serverSource, file));
    expect(routed).toEqual([NodePath.join("screenShare", "ScreenShareHttp.ts")]);

    const http = NodeFs.readFileSync(
      NodePath.join(serverSource, "screenShare", "ScreenShareHttp.ts"),
      "utf8",
    );
    // One registration, one place that reads the path, and the guard before any upgrade.
    expect(http.match(/router\.add\(/g)).toHaveLength(1);
    expect(http.match(/screenShareSocketOf\(/g)).toHaveLength(1);
    expect(http.match(/\.pathname/g)).toHaveLength(1);
    expect(http.indexOf("if (which === null) return notFound;")).toBeGreaterThan(0);
    expect(http.indexOf("if (which === null) return notFound;")).toBeLessThan(
      http.indexOf("authenticateMediaRequest("),
    );
    // The one decision that lets a socket in is made, and acted on, before the one upgrade.
    expect(http.match(/screenShareSocketRefusal\(/g)).toHaveLength(1);
    const guard = http.indexOf("if (refusal !== null) {");
    expect(guard).toBeGreaterThan(http.indexOf("screenShareSocketRefusal({"));
    expect(guard).toBeLessThan(http.indexOf("request.upgrade"));
    expect(http.match(/request\.upgrade/g)).toHaveLength(1);
    expect(http).toContain("personDeviceOf(session, approvedNameFrom(trust))");
    expect(http).toContain("ownAppStanding(");
    // The proof is checked and dropped: the routes keep nothing they could spend.
    expect(http).not.toMatch(/attachHost\(peer, proof\)|reprove\(proof\)/);
  });

  it("answers only the two socket paths, and only as a WebSocket", () => {
    expect(screenShareSocketOf(SCREEN_SHARE_HOST_PATH, "websocket")).toBe("host");
    expect(screenShareSocketOf(SCREEN_SHARE_VIEW_PATH, "WebSocket")).toBe("view");
    const others = [
      SCREEN_SHARE_ROUTE_PREFIX,
      `${SCREEN_SHARE_ROUTE_PREFIX}/`,
      `${SCREEN_SHARE_ROUTE_PREFIX}/status`,
      `${SCREEN_SHARE_ROUTE_PREFIX}/frame`,
      `${SCREEN_SHARE_ROUTE_PREFIX}/grants`,
      `${SCREEN_SHARE_HOST_PATH}/`,
      `${SCREEN_SHARE_VIEW_PATH}/x`,
      `${SCREEN_SHARE_VIEW_PATH}%2f`,
      SCREEN_SHARE_VIEW_PATH.toUpperCase(),
    ];
    for (const path of others) expect(screenShareSocketOf(path, "websocket")).toBeNull();
    // A plain request gets nothing, not even on the two paths.
    for (const path of [SCREEN_SHARE_HOST_PATH, SCREEN_SHARE_VIEW_PATH]) {
      expect(screenShareSocketOf(path, undefined)).toBeNull();
      expect(screenShareSocketOf(path, "h2c")).toBeNull();
    }
  });

  it("lets in no viewer whose session has no end", () => {
    expect(viewerSessionEnd(undefined)).toBeNull();
    expect(viewerSessionEnd(DateTime.makeUnsafe(1_800_000_000_000))).toBe(1_800_000_000_000);
    const device = { device: {} };
    expect(
      screenShareSocketRefusal({ socket: "view", ownApp: false, device, expiresAtMs: null }),
    ).toBe("session_without_expiry");
    expect(
      screenShareSocketRefusal({ socket: "view", ownApp: false, device, expiresAtMs: 1 }),
    ).toBeNull();
  });

  it("refuses a socket for every reason but being the right kind of caller", () => {
    const device = { device: {} };
    const refusal = screenShareSocketRefusal;
    // A host is this machine's app or nothing; a device is no help to it.
    expect(refusal({ socket: "host", ownApp: false, device: null, expiresAtMs: 1 })).toBe(
      "not_this_machines_app",
    );
    expect(refusal({ socket: "host", ownApp: false, device, expiresAtMs: 1 })).toBe(
      "not_this_machines_app",
    );
    expect(refusal({ socket: "host", ownApp: true, device: null, expiresAtMs: null })).toBeNull();
    // A viewer is a person's approved device; being the app is no help to it.
    expect(refusal({ socket: "view", ownApp: true, device: null, expiresAtMs: 1 })).toBe(
      "not_a_persons_device",
    );
    expect(
      refusal({ socket: "view", ownApp: true, device: { refusal: "agent" }, expiresAtMs: 1 }),
    ).toBe("agent");
  });

  it("reads a host's proof only from a small hello", () => {
    expect(hostHelloProof(JSON.stringify({ t: "hello", proof: "abc" }))).toBe("abc");
    expect(hostHelloProof(JSON.stringify({ t: "status", proof: "abc" }))).toBeNull();
    expect(hostHelloProof(JSON.stringify({ t: "hello", proof: 7 }))).toBeNull();
    expect(hostHelloProof(JSON.stringify({ t: "hello", proof: "x".repeat(600) }))).toBeNull();
    expect(hostHelloProof("not json")).toBeNull();
    expect(hostHelloProof(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("only the two socket routes and the guard touch the relay", () => {
    const users = filesUnder(serverSource)
      .filter((file) => !file.includes(`${NodePath.sep}screenShare${NodePath.sep}`))
      .filter((file) =>
        /screenShare\/|ScreenShareRelay|ScreenShareHttp/.test(NodeFs.readFileSync(file, "utf8")),
      )
      .map((file) => NodePath.relative(serverSource, file));
    expect(users).toEqual(["server.ts"]);

    // Nothing outside this folder so much as names screen sharing, but the guard,
    // the capability flag and the one mount. A route cannot reach a relay it cannot name.
    const naming = filesUnder(serverSource)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.includes(`${NodePath.sep}screenShare${NodePath.sep}`))
      .filter((file) => SCREEN_SHARE.test(NodeFs.readFileSync(file, "utf8")))
      .map((file) => NodePath.relative(serverSource, file))
      .toSorted();
    expect(naming).toEqual([
      NodePath.join("auth", "personDevice.ts"),
      NodePath.join("environment", "ServerEnvironment.ts"),
      "server.ts",
    ]);
    // The relay is made once, inside the route layer, and handed to nothing else.
    const made = filesUnder(serverSource)
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap(
        (file) => NodeFs.readFileSync(file, "utf8").match(/new ScreenShareRelay[<(]/g) ?? [],
      );
    expect(made).toHaveLength(1);
    const http = NodeFs.readFileSync(
      NodePath.join(serverSource, "screenShare", "ScreenShareHttp.ts"),
      "utf8",
    );
    expect(http.match(/^export const \w+/gm)).toEqual([
      "export const hostHelloProof",
      "export const screenShareSocketOf",
      "export const viewerSessionEnd",
      "export const screenShareSocketRefusal",
      "export const routeLayer",
    ]);
    const server = NodeFs.readFileSync(NodePath.join(serverSource, "server.ts"), "utf8");
    expect(server.match(/ScreenShareHttp\.(?!ts")\w+/g)).toEqual(["ScreenShareHttp.routeLayer"]);
  });
});
