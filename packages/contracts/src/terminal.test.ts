import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalError,
  terminalHistoryTail,
  TerminalObserveInput,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalThreadInput,
  TerminalWriteInput,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("accepts valid open input", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("accepts ultrawide terminal dimensions from xterm fit", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 423,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 10,
        rows: 0,
      }),
    ).toBe(false);
  });

  it("requires terminalId — the client must always pick an id", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
      }),
    ).toBe(false);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.specweave-studio/worktrees/feature-a",
      cols: 100,
      rows: 24,
      env: {
        STUDIO_PROJECT_ROOT: "/tmp/project",
        CUSTOM_FLAG: "1",
      },
      providerInstanceId: "codex_work",
    });
    expect(parsed.env).toMatchObject({
      STUDIO_PROJECT_ROOT: "/tmp/project",
      CUSTOM_FLAG: "1",
    });
    expect(parsed.worktreePath).toBe("/tmp/project/.specweave-studio/worktrees/feature-a");
    expect(parsed.providerInstanceId).toBe("codex_work");
  });

  it("rejects invalid env keys", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
        env: {
          "bad-key": "1",
        },
      }),
    ).toBe(false);
  });

  it("rejects invalid provider instance ids", () => {
    for (const providerInstanceId of ["", "1invalid", "invalid id"]) {
      expect(
        decodes(TerminalOpenInput, {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project",
          providerInstanceId,
        }),
      ).toBe(false);
    }
  });
});

describe("TerminalAttachInput", () => {
  it("accepts explicit inactive-session restart intent", () => {
    const parsed = decodeSync(TerminalAttachInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      restartIfNotRunning: true,
    });

    expect(parsed.restartIfNotRunning).toBe(true);
  });

  it("carries an optional history budget that older inputs omit", () => {
    for (const schema of [TerminalAttachInput, TerminalObserveInput]) {
      const base = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };
      expect(decodeSync(schema, base).maxHistoryBytes).toBeUndefined();
      expect(decodeSync(schema, { ...base, maxHistoryBytes: 524_288 }).maxHistoryBytes).toBe(
        524_288,
      );
      expect(decodes(schema, { ...base, maxHistoryBytes: -1 })).toBe(false);
      expect(decodes(schema, { ...base, maxHistoryBytes: 1.5 })).toBe(false);
    }
  });
});

describe("terminalHistoryTail", () => {
  it("keeps the newest bytes from a code point boundary", () => {
    const history = "ab\u00e9\u{1f600}cd";
    expect(terminalHistoryTail(history, 100)).toBe(history);
    expect(terminalHistoryTail(history, 0)).toBe("");
    // "ab" 2, "\u00e9" 2, the emoji 4 and "cd" 2 bytes: 10 in total.
    expect(terminalHistoryTail(history, 10)).toBe(history);
    expect(terminalHistoryTail(history, 8)).toBe("\u00e9\u{1f600}cd");
    // A cut inside a multi-byte character moves past it.
    expect(terminalHistoryTail(history, 7)).toBe("\u{1f600}cd");
    expect(terminalHistoryTail(history, 5)).toBe("cd");
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "",
      }),
    ).toBe(false);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        data: "echo hello\n",
      }),
    ).toBe(false);
  });
});

describe("TerminalThreadInput", () => {
  it("trims thread ids", () => {
    const parsed = decodeSync(TerminalThreadInput, { threadId: " thread-1 " });
    expect(parsed.threadId).toBe("thread-1");
  });
});

describe("TerminalResizeInput", () => {
  it("accepts valid size", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        cols: 80,
        rows: 24,
      }),
    ).toBe(false);
  });
});

describe("TerminalClearInput", () => {
  it("requires terminalId", () => {
    expect(decodes(TerminalClearInput, { threadId: "thread-1" })).toBe(false);
  });

  it("accepts an explicit terminalId", () => {
    const parsed = decodeSync(TerminalClearInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalCloseInput", () => {
  it("accepts optional deleteHistory", () => {
    expect(
      decodes(TerminalCloseInput, {
        threadId: "thread-1",
        deleteHistory: true,
      }),
    ).toBe(true);
  });
});

describe("TerminalSessionSnapshot", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts running snapshots", () => {
    expect(
      decodes(TerminalSessionSnapshot, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 1234,
        history: "hello\n",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: isoTimestamp,
      }),
    ).toBe(true);
  });
});

describe("TerminalEvent", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts output events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "output",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "line\n",
      }),
    ).toBe(true);
  });

  it("accepts exited events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "exited",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts closed events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "closed",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        hasRunningSubprocess: true,
        label: "vim",
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        snapshot: {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project/.specweave-studio/worktrees/feature-a",
          worktreePath: "/tmp/project/.specweave-studio/worktrees/feature-a",
          status: "running",
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Primary",
          updatedAt: isoTimestamp,
        },
      }),
    ).toBe(true);
  });
});

describe("terminal elevation markers", () => {
  const nonce = "abcdefghij0123456789";

  it("reads only markers that carry the run's nonce", async () => {
    const { terminalElevationMarker, terminalElevationState } = await import("./terminal.ts");
    expect(terminalElevationState("plain output", nonce)).toBeNull();
    expect(terminalElevationState(terminalElevationMarker("started", nonce), null)).toBeNull();
    expect(terminalElevationState(terminalElevationMarker("started", nonce), "")).toBeNull();
    expect(
      terminalElevationState(terminalElevationMarker("cancelled", "zzzzzzzzzzzzzzzzzzzz"), nonce),
    ).toBeNull();
    expect(terminalElevationState("\u001b]7717;elevation=cancelled\u0007", nonce)).toBeNull();
    expect(terminalElevationState(`\u001b]7717;elevation=root;${nonce}\u0007`, nonce)).toBeNull();
    expect(terminalElevationState(terminalElevationMarker("waiting", nonce), nonce)).toBe(
      "waiting",
    );
  });

  it("keeps the first state after waiting, whatever is printed later", async () => {
    const { terminalElevationMarker, terminalElevationState } = await import("./terminal.ts");
    const mark = (state: Parameters<typeof terminalElevationMarker>[0]) =>
      terminalElevationMarker(state, nonce);
    expect(
      terminalElevationState(`${mark("waiting")}${mark("started")}done${mark("cancelled")}`, nonce),
    ).toBe("started");
    expect(terminalElevationState(`${mark("unavailable")}${mark("started")}`, nonce)).toBe(
      "unavailable",
    );
  });

  it("reads server-verified nonce-free elevation markers and ignores nonce-bearing or late ones", async () => {
    const {
      terminalElevationMarker,
      terminalVerifiedElevationMarker,
      verifiedTerminalElevationState,
    } = await import("./terminal.ts");
    expect(verifiedTerminalElevationState("plain output")).toBeNull();
    expect(verifiedTerminalElevationState(terminalElevationMarker("started", nonce))).toBeNull();
    expect(verifiedTerminalElevationState("\u009d7717;elevation=started\u0007")).toBeNull();
    expect(verifiedTerminalElevationState("\u001b]7717;elevation=root\u0007")).toBeNull();
    expect(verifiedTerminalElevationState(terminalVerifiedElevationMarker("waiting"))).toBe(
      "waiting",
    );
    expect(
      verifiedTerminalElevationState(
        `${terminalVerifiedElevationMarker("waiting")}${terminalVerifiedElevationMarker("started")}done${terminalVerifiedElevationMarker("cancelled")}`,
      ),
    ).toBe("started");
    expect(
      verifiedTerminalElevationState(
        `${terminalVerifiedElevationMarker("terminal-app")}${terminalVerifiedElevationMarker("started")}`,
      ),
    ).toBe("terminal-app");
  });
});
