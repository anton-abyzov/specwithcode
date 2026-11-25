// @effect-diagnostics-next-line nodeBuiltinImport:off - reads this repository's own source files.
import * as NodeFs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - joins paths under this repository.
import * as NodePath from "node:path";

import { CLIENT_GUARDED_RPC_SCOPES, WS_METHODS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

/**
 * Screen sharing has no path an agent can take (1490 AC-16): no RPC method, so
 * nothing a scope could unlock, and no MCP tool. These fail the day someone
 * adds one without deciding to.
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

  it("only the two socket routes and the guard touch the relay", () => {
    const users = filesUnder(serverSource)
      .filter((file) => !file.includes(`${NodePath.sep}screenShare${NodePath.sep}`))
      .filter((file) =>
        /screenShare\/|ScreenShareRelay|ScreenShareHttp/.test(NodeFs.readFileSync(file, "utf8")),
      )
      .map((file) => NodePath.relative(serverSource, file));
    expect(users).toEqual(["server.ts"]);
  });
});
