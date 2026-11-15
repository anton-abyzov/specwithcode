import { describe, expect, it } from "vite-plus/test";

import { CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import {
  formatProjectCredentialsManifest,
  parseProjectCredentialsManifest,
  PROJECT_CREDENTIALS_RPC_METHODS,
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
    const result = parse([{ id: "kubernetes", note: "ash cluster" }, { id: "npm", skip: true }]);
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
