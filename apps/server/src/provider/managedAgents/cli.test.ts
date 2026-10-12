import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const bin = NodeURL.fileURLToPath(new URL("../../bin.ts", import.meta.url));
const invoke = (args: readonly string[]) =>
  NodeChildProcess.spawnSync(process.execPath, [bin, "managed-agents", ...args], {
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "", PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  });

describe("shipped Managed Agents CLI", () => {
  it("does not leak malformed config excerpts in parse errors", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-beta-cli-"));
    const config = NodePath.join(directory, "config.json");
    try {
      await NodeFSP.writeFile(config, 'SECRET_SENTINEL_0892 {"enabled":true', { mode: 0o600 });
      const result = invoke(["status", "--config", config]);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("SECRET_SENTINEL_0892");
      expect(result.stderr).toContain("readable JSON file");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("reports missing API authentication through the actual binary", () => {
    const result = invoke(["status"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      configured: false,
      apiKeyPresent: false,
      authentication: "anthropic-api-key",
      reason: "disabled",
    });
  });
});
