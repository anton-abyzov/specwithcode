import { expect, it, vi, afterEach } from "vite-plus/test";
import { validConnectionConfig, redactConnectionValue } from "./config.ts";

const key = "STUDIO_CONNECTION_TEST_SECRET";
const config = { name: "Synthetic", command: "synthetic-mcp", args: [], envKeys: [key] };
afterEach(() => vi.unstubAllEnvs());

it("rejects a known credential shape pasted into the display name", () => {
  expect(validConnectionConfig({ ...config, name: "sk-" + "x".repeat(24) })).toBe(false);
  expect(validConnectionConfig({ ...config, name: "Research tools" })).toBe(true);
});

it.each([
  "https://person:password@example.invalid/mcp",
  "--url=https://person:password@example.invalid/mcp",
  "--endpoint=https://example.invalid/mcp?token=synthetic",
  "--url=https://example.invalid/mcp#synthetic",
  "--password=synthetic",
  "--api-key",
])("rejects credential-bearing argument %s instead of saving it", (argument) => {
  expect(validConnectionConfig({ ...config, args: [argument] })).toBe(false);
});

it("accepts public URLs and environment names without accepting values or executable control characters", () => {
  expect(validConnectionConfig({ ...config, args: ["--url=https://example.invalid/mcp"] })).toBe(
    true,
  );
  expect(validConnectionConfig({ ...config, envKeys: ["SECRET=synthetic"] })).toBe(false);
  expect(validConnectionConfig({ ...config, command: "synthetic\ncommand" })).toBe(false);
  expect(validConnectionConfig({ ...config, command: "--unexpected-option" })).toBe(false);
});

it.each(['quoted"credential', "back\\slash", "line\nbreak", "xy"])(
  "redacts decoded nested keys and values before JSON encoding (%j)",
  (secret) => {
    vi.stubEnv(key, secret);
    const input = {
      content: [{ type: "text", text: `prefix ${secret} suffix` }],
      structuredContent: { [secret]: { value: secret, number: 4 } },
    };
    const result = JSON.parse(JSON.stringify(redactConnectionValue(input, [key])));
    expect(result).toEqual({
      content: [{ type: "text", text: "prefix [redacted] suffix" }],
      structuredContent: { "[redacted]": { value: "[redacted]", number: 4 } },
    });
    expect(input.structuredContent[secret]?.value).toBe(secret);
  },
);

it("refuses relative commands and script paths an agent could replace in the project folder", () => {
  for (const command of ["./server", "bin/mcp", "..\\tools\\mcp.exe"])
    expect(validConnectionConfig({ ...config, command })).toBe(false);
  expect(validConnectionConfig({ ...config, command: "node", args: ["./server.js"] })).toBe(false);
  expect(validConnectionConfig({ ...config, command: "node", args: ["../mcp/index.js"] })).toBe(
    false,
  );
  expect(validConnectionConfig({ ...config, command: "/usr/local/bin/mcp-server" })).toBe(true);
  expect(validConnectionConfig({ ...config, command: "npx", args: ["-y", "@scope/server"] })).toBe(
    true,
  );
});
