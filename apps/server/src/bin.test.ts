import * as NodeEvents from "node:events";
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
