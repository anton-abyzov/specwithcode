// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { ignoreOutputStreamErrors } from "./bin.ts";

describe("ignoreOutputStreamErrors", () => {
  it("keeps a failed log write on stdout or stderr from throwing", () => {
    const stdout = new NodeEvents.EventEmitter();
    const stderr = new NodeEvents.EventEmitter();
    ignoreOutputStreamErrors([stdout, stderr]);

    const closedPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const fullDisk = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    expect(() => stdout.emit("error", closedPipe)).not.toThrow();
    expect(() => stderr.emit("error", fullDisk)).not.toThrow();
  });

  it("installs its handler once per stream", () => {
    const stdout = new NodeEvents.EventEmitter();
    ignoreOutputStreamErrors([stdout]);
    ignoreOutputStreamErrors([stdout]);
    expect(stdout.listenerCount("error")).toBe(1);
  });
});

const OUTCOME_MARKER = "OUTPUT_STREAM_ERRORS=";

/**
 * Runs the real entry and, as the process exits, fails a write on its own stdout and
 * stderr the way a closed pipe does. Emitting the error directly, instead of closing a
 * pipe, keeps the check deterministic and the same on every platform: a command that
 * exits quickly finishes before an asynchronous pipe error would reach it.
 */
const outputStreamErrorOutcome = (args: ReadonlyArray<string>) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-bin-entry-test-"));
  try {
    const probe = [
      'import { writeSync } from "node:fs";',
      'process.on("exit", () => {',
      "  const outcome = (stream) => {",
      "    try {",
      '      stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));',
      '      return "ignored";',
      "    } catch {",
      '      return "unhandled";',
      "    }",
      "  };",
      `  writeSync(2, "\\n${OUTCOME_MARKER}" + outcome(process.stdout) + "," + outcome(process.stderr) + "\\n");`,
      "});",
    ].join("\n");
    const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_HOME: home };
    delete env.STUDIO_ACP_MCP_ENDPOINT;
    delete env.STUDIO_ACP_MCP_AUTHORIZATION;
    delete env.STUDIO_ACP_MCP_CREDENTIAL_FILE;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        `data:text/javascript,${encodeURIComponent(probe)}`,
        NodePath.join(import.meta.dirname, "bin.ts"),
        ...args,
      ],
      { encoding: "utf8", env, timeout: 90_000 },
    );
    const line = result.stderr.split("\n").find((entry) => entry.startsWith(OUTCOME_MARKER));
    expect(line, result.stderr).toBeDefined();
    return line?.slice(OUTCOME_MARKER.length);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

describe("bin entry output streams", () => {
  // The server logs to these streams; a closed launcher pipe must not crash it before
  // shutdown releases the ownership lock.
  it("ignores failed writes on the real stdout and stderr for the server and CLI", () => {
    expect(outputStreamErrorOutcome(["--version"])).toBe("ignored,ignored");
  }, 120_000);

  // These commands answer on stdout for another program, so a broken pipe has to stay
  // a failure the caller can see.
  it.each([["acp-mcp-bridge"], ["acp-mcp-call"], ["managed-agents", "--help"]])(
    "leaves failed writes as failures for the machine-readable command %s",
    (...args) => {
      expect(outputStreamErrorOutcome(args)).toBe("unhandled,unhandled");
    },
    120_000,
  );
});
