import { describe, expect, it, vi } from "vite-plus/test";

import { createWindowMachineClaims } from "./windowMachine";

describe("window machine claims", () => {
  it("is empty until a view claims a machine", () => {
    expect(createWindowMachineClaims().current()).toBeNull();
  });

  it("follows the coordinator's execution machine, not the window's", () => {
    const claims = createWindowMachineClaims();
    const release = claims.claim("env-linux-mini", "project");
    expect(claims.current()).toBe("env-linux-mini");
    release();
    expect(claims.current()).toBeNull();
  });

  it("lets a thread outrank the project around it, whatever the mount order", () => {
    const claims = createWindowMachineClaims();
    // React runs the child's effect first: the thread claims before its project.
    const thread = claims.claim("env-m1", "thread");
    const project = claims.claim("env-m4", "project");
    expect(claims.current()).toBe("env-m1");
    thread();
    expect(claims.current()).toBe("env-m4");
    project();
  });

  it("prefers the most recent claim of the same rank and notifies on change", () => {
    const claims = createWindowMachineClaims();
    const listener = vi.fn();
    const unsubscribe = claims.subscribe(listener);
    const first = claims.claim("env-m4");
    const second = claims.claim("env-m1");
    expect(claims.current()).toBe("env-m1");
    second();
    expect(claims.current()).toBe("env-m4");
    first();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    claims.claim("env-m3");
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
