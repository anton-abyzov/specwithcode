// @effect-diagnostics nodeBuiltinImport:off -- The fake helper process is built from Node streams.
// @effect-diagnostics globalTimers:off -- The fake helper is driven by plain timers in these tests.
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { VoiceHelper } from "./VoiceHelper.ts";
import { allowMediaPermission } from "./voicePermission.ts";

function fakeHelper(respond: (request: { id: number; op: string }) => object | null) {
  const spawned: NodeChildProcess.ChildProcessWithoutNullStreams[] = [];
  const spawn = () => {
    const child = new NodeEvents.EventEmitter() as NodeChildProcess.ChildProcessWithoutNullStreams;
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr: new NodeStream.PassThrough(),
      exitCode: null,
      kill: () => {
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0);
        return true;
      },
    });
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const reply = respond(JSON.parse(line));
        if (reply) stdout.write(`${JSON.stringify(reply)}\n`);
      }
    });
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

describe("VoiceHelper", () => {
  it("matches replies to requests by id", async () => {
    const { spawn, spawned } = fakeHelper(({ id, op }) => ({ id, ok: true, text: `${op}-${id}` }));
    const helper = new VoiceHelper(spawn);
    const [first, second] = await Promise.all([
      helper.request({ op: "transcribe" }),
      helper.request({ op: "status" }),
    ]);
    expect(first.text).toBe("transcribe-1");
    expect(second.text).toBe("status-2");
    expect(spawned).toHaveLength(1);
    helper.stop();
  });

  it("turns helper errors into readable messages", async () => {
    const { spawn } = fakeHelper(({ id }) => ({ id, ok: false, error: "unsupported-locale" }));
    const helper = new VoiceHelper(spawn);
    await expect(helper.request({ op: "transcribe" })).rejects.toThrow(
      "Speech recognition does not support this language on this Mac.",
    );
    helper.stop();
  });

  it("fails pending requests when the helper exits and restarts it next time", async () => {
    const { spawn, spawned } = fakeHelper(() => null);
    const helper = new VoiceHelper(spawn);
    const pending = helper.request({ op: "transcribe" });
    spawned[0]?.kill();
    await expect(pending).rejects.toThrow("stopped unexpectedly");
    const again = helper.request({ op: "status" });
    expect(spawned).toHaveLength(2);
    helper.stop();
    await expect(again).rejects.toThrow("stopped");
  });

  it("fails a request that waits too long in the queue without stopping the helper", async () => {
    const seen: string[] = [];
    const { spawn, spawned } = fakeHelper(({ id, op }) => {
      seen.push(op);
      return op === "prepare" ? null : { id, ok: true, text: op };
    });
    const helper = new VoiceHelper(spawn, { timeoutMs: 20 });
    const prepare = helper.request({ op: "prepare" }, { timeoutMs: 5_000 });
    const transcribe = helper.request({ op: "transcribe" });
    await expect(transcribe).rejects.toThrow("still getting ready");
    // It was never sent, and the helper is still working on the prepare.
    expect(seen).toEqual(["prepare"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.exitCode).toBeNull();
    helper.stop();
    await expect(prepare).rejects.toThrow("stopped");
  });

  it("fails only the request that timed out and carries on with a fresh helper", async () => {
    const { spawn, spawned } = fakeHelper(({ id, op }) =>
      op === "prepare" ? null : { id, ok: true, text: op },
    );
    const helper = new VoiceHelper(spawn, { timeoutMs: 1_000 });
    const prepare = helper.request({ op: "prepare" }, { timeoutMs: 10 });
    const transcribe = helper.request({ op: "transcribe" });
    await expect(prepare).rejects.toThrow("took too long");
    await expect(transcribe).resolves.toMatchObject({ text: "transcribe" });
    expect(spawned).toHaveLength(2);
    helper.stop();
  });

  it("times out a request that never answers", async () => {
    const { spawn } = fakeHelper(() => null);
    const helper = new VoiceHelper(spawn, { timeoutMs: 10 });
    await expect(helper.request({ op: "speak" })).rejects.toThrow("took too long");
  });
});

describe("allowMediaPermission", () => {
  const base = {
    permission: "media",
    mediaTypes: ["audio"],
    requestingUrl: "studio://app/#/projects/abc",
    pageUrl: "studio://app/",
    callActive: true,
  };

  it("allows audio for the app page during a call", () => {
    expect(allowMediaPermission(base)).toBe(true);
  });

  it("refuses the microphone outside a call, with video, and for other origins", () => {
    expect(allowMediaPermission({ ...base, callActive: false })).toBe(false);
    expect(allowMediaPermission({ ...base, mediaTypes: ["audio", "video"] })).toBe(false);
    expect(allowMediaPermission({ ...base, requestingUrl: "https://evil.example/" })).toBe(false);
    expect(allowMediaPermission({ ...base, requestingUrl: undefined })).toBe(false);
  });

  it("leaves other permissions and screen capture at Electron's default", () => {
    expect(allowMediaPermission({ ...base, permission: "notifications", callActive: false })).toBe(
      true,
    );
    // getDisplayMedia (preview tab recording) asks for "media" with no device types.
    expect(allowMediaPermission({ ...base, mediaTypes: [], callActive: false })).toBe(true);
    expect(allowMediaPermission({ ...base, mediaTypes: undefined, callActive: false })).toBe(true);
  });
});
