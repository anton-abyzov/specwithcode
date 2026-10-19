// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk fixtures prove the legacy-root link rule.
import * as FS from "node:fs";
import * as OS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk fixtures prove the legacy-root link rule.
import * as Path from "node:path";
import { AuthAdministrativeScopes } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildPairArgs,
  isProcessAlive,
  parsePairToken,
  parseServerRuntimeState,
  parseStudioInstallation,
  resolveServiceCliCommand,
} from "./localServiceAttach.ts";

describe("parseServerRuntimeState", () => {
  it("reads the owner of a Studio home", () => {
    expect(
      parseServerRuntimeState(
        JSON.stringify({
          version: 1,
          pid: 4242,
          port: 8319,
          origin: "http://127.0.0.1:8319",
          startedAt: "2026-10-09T10:00:00.000Z",
          serviceManaged: true,
        }),
      ),
    ).toEqual({ pid: 4242, port: 8319, origin: "http://127.0.0.1:8319", serviceManaged: true });
  });

  it("rejects malformed or unsafe records", () => {
    expect(parseServerRuntimeState("not json")).toBeNull();
    expect(parseServerRuntimeState(JSON.stringify({ pid: "1", port: 1, origin: "x" }))).toBeNull();
    expect(
      parseServerRuntimeState(JSON.stringify({ pid: 0, port: 8319, origin: "http://127.0.0.1" })),
    ).toBeNull();
    expect(
      parseServerRuntimeState(JSON.stringify({ pid: 3, port: 8319, origin: "file:///etc/passwd" })),
    ).toBeNull();
  });
});

describe("parseStudioInstallation", () => {
  const join = (...parts: string[]) => parts.join("/");
  const expected = { studioRoot: "/Users/a/.specweave-studio", directoryName: "m4", join };

  it("reads the fleet installer's receipt for its own folder", () => {
    expect(
      parseStudioInstallation(
        JSON.stringify({
          schemaVersion: 1,
          identity: "m4",
          studioHome: "/Users/a/.specweave-studio/m4",
          stateDir: "/Users/a/.specweave-studio/m4/userdata",
          service: { installed: true, label: "com.specweave.studio.m4" },
        }),
        expected,
      ),
    ).toEqual({
      identity: "m4",
      studioHome: "/Users/a/.specweave-studio/m4",
      stateDir: "/Users/a/.specweave-studio/m4/userdata",
      serviceInstalled: true,
    });
  });

  it("ignores receipts that point outside their folder", () => {
    const receipt = (studioHome: string, stateDir: string) =>
      JSON.stringify({ schemaVersion: 1, studioHome, stateDir, service: { installed: true } });
    expect(parseStudioInstallation(receipt("/etc", "/etc/userdata"), expected)).toBeNull();
    expect(
      parseStudioInstallation(receipt("/Users/a/.specweave-studio/m4", "/Users/a/.ssh"), expected),
    ).toBeNull();
    expect(parseStudioInstallation("{}", expected)).toBeNull();
    expect(parseStudioInstallation("not json", expected)).toBeNull();
  });
});

describe("parseStudioInstallation across the home move", () => {
  const roots: string[] = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => FS.rmSync(root, { recursive: true, force: true })),
  );
  const receipt = (studioHome: string) =>
    JSON.stringify({
      schemaVersion: 1,
      identity: "m4",
      studioHome,
      stateDir: Path.join(studioHome, "userdata"),
      service: { installed: true },
    });

  it("reads receipts in the branded root and in a real legacy root", () => {
    const home = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "attach-roots-")));
    roots.push(home);
    for (const root of [".specwithcode", ".specweave-studio"]) {
      FS.mkdirSync(Path.join(home, root, "m4"), { recursive: true });
      const studioRoot = Path.join(home, root);
      expect(
        parseStudioInstallation(receipt(Path.join(studioRoot, "m4")), {
          studioRoot,
          directoryName: "m4",
          join: Path.join,
        })?.studioHome,
      ).toBe(Path.join(studioRoot, "m4"));
    }
    // A real legacy root is its own place: its receipt never describes the branded folder.
    expect(
      parseStudioInstallation(receipt(Path.join(home, ".specweave-studio", "m4")), {
        studioRoot: Path.join(home, ".specwithcode"),
        directoryName: "m4",
        join: Path.join,
      }),
    ).toBeNull();
  });

  it("accepts a pre-move receipt in the branded root once the legacy root is a link", () => {
    const home = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "attach-linked-")));
    roots.push(home);
    const studioRoot = Path.join(home, ".specwithcode");
    FS.mkdirSync(Path.join(studioRoot, "m4"), { recursive: true });
    FS.symlinkSync(studioRoot, Path.join(home, ".specweave-studio"));
    expect(
      parseStudioInstallation(receipt(Path.join(home, ".specweave-studio", "m4")), {
        studioRoot,
        directoryName: "m4",
        join: Path.join,
      }),
    ).toEqual({
      identity: "m4",
      studioHome: Path.join(studioRoot, "m4"),
      stateDir: Path.join(studioRoot, "m4", "userdata"),
      serviceInstalled: true,
    });
  });
});

describe("isProcessAlive", () => {
  it("treats EPERM as alive and ESRCH as gone", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(isProcessAlive(1, () => {})).toBe(true);
    expect(isProcessAlive(1, fail("EPERM"))).toBe(true);
    expect(isProcessAlive(1, fail("ESRCH"))).toBe(false);
  });
});

describe("parsePairToken", () => {
  it("reads the text output of every released pair command", () => {
    const stdout = [
      "Pairing with Anton's Mac (http://127.0.0.1:8319).",
      "",
      "█▀▀▀▀▀█",
      "",
      "Pairing URL: http://127.0.0.1:8319/pair#token=abc",
      "Token: tok_123",
      "Expires: 2026-10-09T10:02:00.000Z",
      "",
    ].join("\n");
    expect(parsePairToken(stdout)).toBe("tok_123");
  });

  it("reads JSON output and rejects output without a token", () => {
    expect(parsePairToken('{"token":"tok_json","origin":"http://127.0.0.1:8319"}')).toBe(
      "tok_json",
    );
    expect(parsePairToken("No running SpecWithCode server found.")).toBeNull();
    expect(parsePairToken('{"token":""}')).toBeNull();
  });
});

describe("resolveServiceCliCommand", () => {
  const files = new Set([
    "/Users/a/.specweave-studio/runtime/versions/0.1.4/bin/specweave-studio",
    "/opt/node22/bin/node",
    "/Users/a/My Tools/studio/dist/bin.mjs",
    "/usr/lib/studio/bin.mjs",
  ]);
  const exists = (path: string) => files.has(path);

  it("reuses a self-contained CLI executable", () => {
    expect(
      resolveServiceCliCommand({
        argv: [
          "/Users/a/.specweave-studio/runtime/versions/0.1.4/bin/specweave-studio",
          "__server",
        ],
        exists,
      }),
    ).toEqual({
      command: "/Users/a/.specweave-studio/runtime/versions/0.1.4/bin/specweave-studio",
      args: [],
      viaRuntime: false,
    });
  });

  it("runs the server script through the same Node runtime", () => {
    expect(
      resolveServiceCliCommand({
        argv: ["/opt/node22/bin/node", "--enable-source-maps", "/usr/lib/studio/bin.mjs", "serve"],
        exists,
      }),
    ).toEqual({
      command: "/opt/node22/bin/node",
      args: ["/usr/lib/studio/bin.mjs"],
      viaRuntime: true,
    });
  });

  it("rebuilds macOS ps output whose paths contain spaces", () => {
    expect(
      resolveServiceCliCommand({
        joinedArgs: "/opt/node22/bin/node /Users/a/My Tools/studio/dist/bin.mjs serve --port 8319",
        exists,
      }),
    ).toEqual({
      command: "/opt/node22/bin/node",
      args: ["/Users/a/My Tools/studio/dist/bin.mjs"],
      viaRuntime: true,
    });
  });

  it("gives up rather than guess", () => {
    expect(resolveServiceCliCommand({ argv: ["node", "bin.mjs"], exists })).toBeNull();
    expect(
      resolveServiceCliCommand({ argv: ["/opt/node22/bin/node", "-e", "1"], exists }),
    ).toBeNull();
    expect(resolveServiceCliCommand({ exists })).toBeNull();
  });
});

describe("buildPairArgs", () => {
  it("mints a short-lived token for the given home", () => {
    expect(buildPairArgs({ baseDir: "/Users/a/.specweave-studio", label: "Desktop" })).toEqual([
      "pair",
      "--base-dir",
      "/Users/a/.specweave-studio",
      "--ttl",
      "2m",
      "--label",
      "Desktop",
      ...AuthAdministrativeScopes.flatMap((scope) => ["--scope", scope]),
    ]);
  });

  it("asks for the access scopes Settings needs to pair phones and other clients", () => {
    const args = buildPairArgs({ baseDir: "/Users/a/.specweave-studio", label: "Desktop" });
    expect(args).toContain("access:read");
    expect(args).toContain("access:write");
  });
});
