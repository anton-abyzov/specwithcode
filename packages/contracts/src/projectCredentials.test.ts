import { describe, expect, it } from "vite-plus/test";

import { CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import * as Schema from "effect/Schema";

import {
  formatProjectCredentialsManifest,
  isPrivateSshHost,
  isSafeSshHost,
  isSafeSshTarget,
  parseProjectCredentialsManifest,
  PROJECT_CREDENTIALS_RPC_METHODS,
  ProjectSshTarget,
} from "./projectCredentials.ts";

const parse = (credentials: unknown, extra: Record<string, unknown> = {}) =>
  parseProjectCredentialsManifest({ version: 1, credentials, ...extra });

const problemOf = (result: ReturnType<typeof parse>) => (result.ok ? null : result.problem);

describe("project credentials manifest", () => {
  it("keeps ids, skips and short notes", () => {
    const result = parse([
      { id: "github" },
      { id: "azure", skip: true, note: " production subscription only " },
    ]);
    expect(result).toEqual({
      ok: true,
      manifest: {
        version: 1,
        credentials: [
          { id: "github" },
          { id: "azure", skip: true, note: "production subscription only" },
        ],
      },
    });
  });

  it("round-trips through the saved form", () => {
    const result = parse([
      { id: "kubernetes", note: "ash cluster" },
      { id: "npm", skip: true },
    ]);
    if (!result.ok) throw new Error(result.problem);
    const again = parseProjectCredentialsManifest(
      JSON.parse(formatProjectCredentialsManifest(result.manifest)),
    );
    expect(again).toEqual(result);
  });

  it("refuses keys that could carry a command or a value", () => {
    for (const key of ["command", "signIn", "probe", "value", "token", "path", "label"])
      expect(problemOf(parse([{ id: "github", [key]: "x" }]))).toMatch(/Entry 1 has a key/u);
    expect(problemOf(parse([], { run: "x" }))).toMatch(/key that is not version or credentials/u);
  });

  it("refuses ids outside the app's list, duplicates and a long list", () => {
    expect(problemOf(parse([{ id: "my-vault" }]))).toMatch(/Entry 1: id is not/u);
    expect(problemOf(parse([{ id: "github" }, { id: "github" }]))).toMatch(/listed twice/u);
    expect(problemOf(parse(Array.from({ length: 101 }, () => ({ id: "github" }))))).toMatch(
      /more than 100/u,
    );
    expect(problemOf(parseProjectCredentialsManifest({ version: 2, credentials: [] }))).toMatch(
      /version must be 1/u,
    );
  });

  it("refuses control, bidirectional and format characters in a note", () => {
    const hostile = [
      "line one\nrm -rf ~",
      "safe\u202Eevil",
      "zero\u200Bwidth",
      "tab\there",
      "esc\u001B[2J",
      "sep\u2028arator",
    ];
    for (const note of hostile)
      expect(problemOf(parse([{ id: "github", note }]))).toMatch(
        /note holds control or formatting characters/u,
      );
  });

  it("refuses token-shaped notes without repeating them", () => {
    // Built from parts, so no scanner reads this file as holding a credential.
    const shaped = [
      `${"gh"}p_${"a".repeat(36)}`,
      `${"github"}_pat_${"A1".repeat(20)}`,
      `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
      `${"s"}k-${"b".repeat(40)}`,
      `${"xo"}xb-${"1234567890"}-${"abcdefghij"}`,
      `${"AK"}IA${"IOSFODNN7EXAMPLE"}`,
      `${"ey"}J${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
      "c".repeat(40),
    ];
    for (const note of shaped) {
      const problem = problemOf(parse([{ id: "github", note }]));
      expect(problem).toMatch(/note looks like a secret value/u);
      expect(problem).not.toContain(note);
    }
  });

  it("refuses a note over 120 characters", () => {
    expect(problemOf(parse([{ id: "github", note: "word ".repeat(30) }]))).toMatch(
      /longer than 120/u,
    );
  });
});

describe("project credentials RPC scopes", () => {
  it("guards every method, and the probe above read access", () => {
    const scopes = CLIENT_GUARDED_RPC_SCOPES as Record<string, string>;
    expect(scopes[PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsScan]).toBe("filesystem:read");
    expect(scopes[PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsSave]).toBe("filesystem:write");
    expect(scopes[PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsProbe]).toBe(
      "orchestration:operate",
    );
  });
});

const decodeSshTarget = Schema.decodeUnknownSync(ProjectSshTarget);

describe("SSH targets on the wire", () => {
  const target = (over: Partial<ProjectSshTarget> = {}): ProjectSshTarget => ({
    kind: "server",
    user: "root",
    host: "build.example.com",
    variable: null,
    source: "ops/deploy.sh",
    ...over,
  });
  const decodes = (value: unknown) => {
    try {
      decodeSshTarget(value);
      return true;
    } catch {
      return false;
    }
  };

  it("accepts plain hosts and refuses anything that could bend a command", () => {
    for (const host of ["build.example.com", "203.0.113.7", "a", "xn--bcher-kva.example"])
      expect(isSafeSshHost(host), host).toBe(true);
    for (const host of [
      "-oProxyCommand=x",
      "a b",
      "a;b",
      "a$(b)",
      "a`b`",
      "a'b",
      'a"b',
      "a..b",
      "a.",
      ".a",
      "a-",
      "[::1]",
      "::1",
      "a:22",
      "fe80::1%en0",
      "h\u043Est",
      "host\u202E",
      "a\nb",
      "",
      "a".repeat(64),
    ])
      expect(isSafeSshHost(host), JSON.stringify(host)).toBe(false);
  });

  it("holds the same patterns in the schema, so a sender cannot skip them", () => {
    expect(decodes(target())).toBe(true);
    expect(decodes(target({ host: "-oProxyCommand=x" }))).toBe(false);
    expect(decodes(target({ user: "a b" }))).toBe(false);
    expect(decodes(target({ variable: "A;B" }))).toBe(false);
    expect(decodes(target({ kind: "other" as never }))).toBe(false);
  });

  it("wants the fields that fit the kind, and a plain source", () => {
    expect(isSafeSshTarget(target())).toBe(true);
    expect(isSafeSshTarget(target({ variable: "WORKER_IP" }))).toBe(true);
    expect(isSafeSshTarget(target({ kind: "variable", host: null, variable: "HOST" }))).toBe(true);
    expect(isSafeSshTarget(target({ kind: "variable", host: null }))).toBe(false);
    expect(isSafeSshTarget(target({ kind: "variable", variable: "HOST" }))).toBe(false);
    expect(isSafeSshTarget(target({ host: null }))).toBe(false);
    expect(isSafeSshTarget(target({ kind: "git", variable: "H" }))).toBe(false);
    expect(isSafeSshTarget(target({ source: "ops/\u202Edeploy.sh" }))).toBe(false);
  });

  it("knows this machine and private networks", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.9",
      "172.16.0.1",
      "100.64.0.1",
      "169.254.1.1",
    ])
      expect(isPrivateSshHost(host), host).toBe(true);
    for (const host of [
      "203.0.113.7",
      "172.32.0.1",
      "100.128.0.1",
      "build.example.com",
      "10.example.com",
    ])
      expect(isPrivateSshHost(host), host).toBe(false);
  });
});
