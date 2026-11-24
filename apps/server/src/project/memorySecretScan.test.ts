import { describe, expect, it } from "@effect/vitest";

import { containsMemorySecret, localOnlyMemorySet } from "./memorySecretScan.ts";

// Token-shaped fixtures are assembled at runtime so repository secret scanners
// do not mistake this test file for a leaked credential.
const fakeToken = (prefix: string, unit: string, times: number) => prefix + unit.repeat(times);

// Built at run time so secret scanners never see a key header in the source.
const keyHeader = (kind: string) => ["-----BEGIN", kind, "PRIVATE", "KEY-----"].join(" ");

describe("containsMemorySecret: JSON / YAML secret fields", () => {
  const jsonCases: ReadonlyArray<readonly [string, string]> = [
    ["camelCase refreshToken", `{"refreshToken": "Rt9xQ2mVb7LpZ4kW8nJd"}`],
    ["camelCase clientSecret", `{ "clientSecret": "Cs4fG8hK2lM6nP0qR3tV" }`],
    ["kebab api-key", `{"api-key": "ak_7Hd92KfLq0Zx3Vb8"}`],
    ["snake client_secret", `{"client_secret": "x9Fq2Lr7Tz4Wp8Hm"}`],
    ["snake refresh_token", `{"refresh_token":"1a2b3c4d5e6f7g8h9i0j"}`],
    ["snake access_token minified", `{"user":"me","access_token":"AcT0ken5Value99xyz"}`],
    ["camelCase apiKey with =", `apiKey = "k3yV4lu3W1thD1g1ts"`],
    ["single-quoted privateKey", `privateKey: 'Pk8sD7fG6hJ5kL4zX3'`],
    ["prefixed key name", `{"stripe_api_key": "rk9Ab8Cd7Ef6Gh5Ij4"}`],
    ["password with realistic value", `{"password": "Tr0ub4dor&3xyzQ"}`],
  ];

  for (const [label, content] of jsonCases) {
    it(`flags ${label}`, () => {
      expect(containsMemorySecret(content)).toBe(true);
    });
  }

  const yamlCases: ReadonlyArray<readonly [string, string]> = [
    ["camelCase refreshToken", "auth:\n  refreshToken: Rt9xQ2mVb7LpZ4kW8nJd\n"],
    ["camelCase clientSecret", "oauth:\n  clientSecret: Cs4fG8hK2lM6nP0qR3tV"],
    ["kebab api-key", "api-key: ak7Hd92KfLq0Zx3Vb8"],
    ["snake client_secret", "client_secret: x9Fq2Lr7Tz4Wp8Hm"],
    ["quoted YAML value", 'access_token: "AcT0ken5Value99xyz"'],
    ["upper-case YAML key", "API_KEY: Zq81Lm72Np63Ok54"],
    ["value followed by comment", "secret_key: s3cr3tK3yV4lu3 # rotate monthly"],
    ["secret on a later line", "# Notes\n\nSome prose first.\n\nid_token: eyJ0eXAi0iJKV1Qi"],
  ];

  for (const [label, content] of yamlCases) {
    it(`flags YAML ${label}`, () => {
      expect(containsMemorySecret(content)).toBe(true);
    });
  }

  // Memory files are Markdown: a secret written as a list item is caught too.
  const listItemCases: ReadonlyArray<readonly [string, string]> = [
    ["YAML list item refreshToken", "tokens:\n  - refreshToken: Rt9xQ2mVb7LpZ4kW8nJd\n"],
    ["Markdown dash bullet api_key", "## Deploy notes\n\n- api_key: ak7Hd92KfLq0Zx3Vb8\n"],
    ["Markdown star bullet client_secret", "* client_secret: x9Fq2Lr7Tz4Wp8Hm"],
  ];

  for (const [label, content] of listItemCases) {
    it(`flags ${label}`, () => {
      expect(containsMemorySecret(content)).toBe(true);
    });
  }

  // An unquoted `key = value` (INI / TOML style) in lower or kebab case.
  it("flags unquoted INI-style api-key = value", () => {
    expect(containsMemorySecret("[service]\napi-key = ak7Hd92KfLq0Zx3Vb8\n")).toBe(true);
  });
});

describe("containsMemorySecret: large input", () => {
  it("scans a long run of key characters quickly", () => {
    const started = performance.now();
    expect(containsMemorySecret(`${"a_".repeat(50_000)}\n`.repeat(4))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("containsMemorySecret: prose and short values stay shared", () => {
  const safeCases: ReadonlyArray<readonly [string, string]> = [
    ["password reminder prose", "password: ask Anna tomorrow"],
    ["password manager mention", "Password: use 1Password"],
    ["password manager vault note", "password: see the 1Password vault"],
    ["quoted prose value", `{"password": "ask Anna tomorrow"}`],
    ["short quoted value", `{"api_key": "abc123"}`],
    ["short YAML value", "client_secret: x9Fq2Lr"],
    ["11-char value just under the threshold", `{"refreshToken": "abc12345678"}`],
    ["long letters-only value", `{"clientSecret": "placeholderplaceholder"}`],
    ["long digits-only value", "api_key: 123456789012345"],
    ["placeholder", `{"apiKey": "<your-api-key-here>"}`],
    ["key name inside a sentence", "Remember to rotate the refresh token every 90 days."],
    ["key name without a value", "The clientSecret field lives in the vault."],
    ["similar but unrelated key", `{"passwordHint": "f1rst-pet-name-2019"}`],
    ["plain markdown memory", "# Preferences\n\n- Prefers dark mode\n- Ships on Fridays\n"],
    ["empty content", ""],
  ];

  for (const [label, content] of safeCases) {
    it(`does not flag ${label}`, () => {
      expect(containsMemorySecret(content)).toBe(false);
    });
  }
});

describe("containsMemorySecret: env-style assignments", () => {
  it("flags upper-case env secrets", () => {
    expect(containsMemorySecret("DATABASE_PASSWORD=hunter2hunter2")).toBe(true);
    expect(containsMemorySecret('export GITHUB_TOKEN="abcdefgh12"')).toBe(true);
    expect(containsMemorySecret("  STRIPE_SECRET_KEY = 'whsec1234abcd'")).toBe(true);
    expect(containsMemorySecret("notes\nAWS_ACCESS_KEY_ID=ABCDEFGH12345678\n")).toBe(true);
    expect(containsMemorySecret("OPENAI_API_KEY=placeholder-value")).toBe(true);
  });

  it("does not flag short env values or non-secret names", () => {
    expect(containsMemorySecret("API_TOKEN=short")).toBe(false);
    expect(containsMemorySecret("NODE_ENV=production")).toBe(false);
    expect(containsMemorySecret("PORT=3000")).toBe(false);
  });
});

describe("containsMemorySecret: provider token prefixes", () => {
  const providerCases: ReadonlyArray<readonly [string, string]> = [
    ["private key block", `${keyHeader("OPENSSH")}\nb3BlbnNzaC1rZXk\n`],
    ["RSA private key block", keyHeader("RSA")],
    ["OpenAI project key", fakeToken("sk-", "proj-", 1) + "a1B2c3D4".repeat(4)],
    ["Anthropic key", fakeToken("sk-ant-", "a1B2c3D4", 4)],
    ["GitHub classic token", fakeToken("gh" + "p_", "a1B2", 9)],
    ["GitHub fine-grained token", fakeToken("github" + "_pat_", "a1B2", 8)],
    ["Slack bot token", fakeToken("xo" + "xb-", "12345-", 3)],
    ["Google API key", fakeToken("AI" + "za", "Sy1B2c3D4e", 4)],
    ["AWS access key id", fakeToken("AK" + "IA", "ABCD2345", 2)],
    ["Google OAuth access token", fakeToken("ya" + "29.", "a1B2c3D4", 4)],
    ["Google OAuth refresh token", fakeToken("1/" + "/", "0gA1b2C3d4", 3)],
    ["Bearer header", "Authorization: Bearer " + "eyJhbGciOiJIUzI1NiJ9".repeat(2)],
  ];

  for (const [label, token] of providerCases) {
    it(`flags ${label} embedded in prose`, () => {
      expect(containsMemorySecret(`Use this for deploys: ${token} (do not share)`)).toBe(true);
    });
  }

  it("does not flag short look-alikes", () => {
    expect(containsMemorySecret("sk-short")).toBe(false);
    expect(containsMemorySecret("ghp_abc")).toBe(false);
    expect(containsMemorySecret("Bearer token goes in the header")).toBe(false);
    expect(containsMemorySecret("Task-ask-the-team")).toBe(false);
  });
});

describe("localOnlyMemorySet", () => {
  it("returns an empty set for missing settings", () => {
    expect(localOnlyMemorySet(null).size).toBe(0);
    expect(localOnlyMemorySet(undefined).size).toBe(0);
    expect(localOnlyMemorySet({}).size).toBe(0);
    expect(localOnlyMemorySet({ localOnlyMemoryFiles: undefined }).size).toBe(0);
    expect(localOnlyMemorySet({ localOnlyMemoryFiles: [] }).size).toBe(0);
  });

  it("contains each listed memory file once", () => {
    const set = localOnlyMemorySet({
      localOnlyMemoryFiles: ["home-wifi.md", "bank.md", "home-wifi.md"],
    });
    expect(set.size).toBe(2);
    expect(set.has("home-wifi.md")).toBe(true);
    expect(set.has("bank.md")).toBe(true);
    expect(set.has("preferences.md")).toBe(false);
  });

  it("matches names exactly (case-sensitive, no path normalisation)", () => {
    const set = localOnlyMemorySet({ localOnlyMemoryFiles: ["Bank.md"] });
    expect(set.has("Bank.md")).toBe(true);
    expect(set.has("bank.md")).toBe(false);
    expect(set.has("./Bank.md")).toBe(false);
  });
});
