import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AcpMcpBridgeError,
  acpMcpCallFailureLine,
  isConnectionBlocked,
  runAcpMcpCliFastPath,
} from "./AcpMcpStdioBridge.ts";

const ENDPOINT = "http://127.0.0.1:8319/api/mcp";
/** What Node's fetch throws inside an agent sandbox that denies local connections. */
const blocked = (code = "EPERM") =>
  new AcpMcpBridgeError("fetch failed", {
    cause: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(`connect ${code} 127.0.0.1:8319 - Local (0.0.0.0:0)`), {
        code,
      }),
    }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("acp-mcp-call failures", () => {
  it("names a sandbox-blocked connection and the steps that fix it", () => {
    for (const code of ["EPERM", "EACCES"]) {
      expect(isConnectionBlocked(blocked(code))).toBe(true);
      const line = acpMcpCallFailureLine(blocked(code), ENDPOINT);
      expect(line).toContain("sandbox blocked the connection to SpecWithCode on this machine");
      expect(line).toContain("127.0.0.1:8319");
      expect(line).toContain("Restarting the session or the app does not change that");
      expect(line).toContain("outside the sandbox");
      expect(line).toContain("the thread's access mode decides it");
      // A Full access thread with prompts off can neither approve a request nor
      // switch to the mode it is already on: the line must not send it there.
      expect(line).not.toContain("approving the request");
      expect(line).not.toContain("switch the thread to Full access");
      expect(line).toContain("a thread already on Full access that still gets this");
      expect(line).toContain("not something a restart fixes");
      expect(line).not.toContain("\n");
      expect(line).not.toMatch(/\bat \S+ \(/);
    }
  });

  it("gives any other failure one line with its cause", () => {
    const refused = new AcpMcpBridgeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8319"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(isConnectionBlocked(refused)).toBe(false);
    expect(acpMcpCallFailureLine(refused, ENDPOINT)).toBe(
      "acp-mcp-call failed: fetch failed (connect ECONNREFUSED 127.0.0.1:8319).",
    );
    expect(
      acpMcpCallFailureLine(
        new AcpMcpBridgeError("SpecWithCode MCP endpoint responded with HTTP 500."),
        ENDPOINT,
      ),
    ).toBe("acp-mcp-call failed: SpecWithCode MCP endpoint responded with HTTP 500.");
    expect(acpMcpCallFailureLine("boom", ENDPOINT)).toBe("acp-mcp-call failed: boom.");
  });

  it("exits 1 with that one line instead of a stack trace", async () => {
    vi.stubEnv("STUDIO_ACP_MCP_CREDENTIAL_FILE", "");
    vi.stubEnv("STUDIO_ACP_MCP_ENDPOINT", ENDPOINT);
    vi.stubEnv("STUDIO_ACP_MCP_AUTHORIZATION", "Bearer call-failure-test");
    vi.stubGlobal("fetch", () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect EPERM 127.0.0.1:8319 - Local (0.0.0.0:0)"), {
            code: "EPERM",
          }),
        }),
      ),
    );
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    await runAcpMcpCliFastPath("acp-mcp-call", ["studio_thread_list", "{}"]);

    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/sandbox blocked the connection to SpecWithCode on this machine/);
    expect(stderr[0]?.trimEnd().split("\n")).toHaveLength(1);
  });
});
