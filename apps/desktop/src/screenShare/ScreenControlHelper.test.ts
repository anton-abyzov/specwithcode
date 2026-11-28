import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import { startScreenControlHelper } from "./ScreenControlHelper.ts";

/** A helper process that answers as the real one does, and records what it was told. */
const fakeHelper = (options: { answerRelease: boolean }) => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: string) => boolean;
  };
  const lines: Array<Record<string, unknown>> = [];
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter((text) => text !== "")) {
      const command = JSON.parse(line) as Record<string, unknown>;
      lines.push(command);
      if (command.t === "release" && options.answerRelease)
        child.stdout.write(`${JSON.stringify({ t: "released" })}\n`);
    }
  });
  child.stdin.on("finish", () => {
    if (options.answerRelease) child.emit("exit", 0, null);
  });
  child.kill = (signal: string) => {
    if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
    return true;
  };
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ t: "ready", trusted: true })}\n`));
  return { child, lines };
};

describe("screen control helper", () => {
  it("a helper that never let go and had to be killed: a fresh one lets go of what it held", async () => {
    vi.useFakeTimers();
    try {
      const helpers: Array<ReturnType<typeof fakeHelper>> = [];
      const spawn = () => {
        const helper = fakeHelper({ answerRelease: helpers.length > 0 });
        helpers.push(helper);
        return helper.child as never;
      };
      const started = await startScreenControlHelper({
        path: "/helper",
        onBlocked: () => {},
        onExit: () => {},
        spawn,
      });
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      const release = started.link.release({ keys: ["MetaLeft"], buttons: ["left"] });
      await vi.advanceTimersByTimeAsync(600);
      await release;
      started.link.stop();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(helpers).toHaveLength(2);
      expect(helpers[1]!.lines).toContainEqual({
        t: "release",
        keys: ["MetaLeft"],
        buttons: ["left"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a helper that let go and closed normally starts no other", async () => {
    let spawned = 0;
    const started = await startScreenControlHelper({
      path: "/helper",
      onBlocked: () => {},
      onExit: () => {},
      spawn: () => {
        spawned += 1;
        return fakeHelper({ answerRelease: true }).child as never;
      },
    });
    if (started.kind !== "ok") throw new Error("not started");
    await started.link.release({ keys: ["KeyA"], buttons: [] });
    started.link.stop();
    await new Promise<void>((done) => queueMicrotask(done));
    expect(spawned).toBe(1);
  });
});
