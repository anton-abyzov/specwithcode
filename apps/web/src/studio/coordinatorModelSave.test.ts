import { describe, expect, it, vi } from "vite-plus/test";
import { createCoordinatorModelSave } from "./coordinatorModelSave";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("coordinator model persistence barrier", () => {
  it("blocks every send caller synchronously until persistence succeeds", async () => {
    const gate = createCoordinatorModelSave();
    const change = deferred();
    const persist = vi.fn(() => change.promise);
    const saving = gate.save(persist);
    const send = vi.fn(async () => "receipt");
    const sending = gate.run(send);
    expect(gate.saving).toBe(true);
    expect(send).not.toHaveBeenCalled();
    change.resolve();
    await expect(saving).resolves.toEqual({ error: null });
    await expect(sending).resolves.toBe("receipt");
    expect(persist).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a rejected choice blocking subsequent sends until a new save succeeds", async () => {
    const gate = createCoordinatorModelSave();
    const change = deferred();
    const saving = gate.save(() => change.promise);
    const send = vi.fn(async () => "receipt");
    const pending = expect(gate.run(send)).rejects.toThrow("Choose it again before sending");
    change.reject(new Error("Settings changed in another window"));
    await saving;
    await pending;
    await expect(gate.run(send)).rejects.toThrow("Settings changed in another window");
    expect(send).not.toHaveBeenCalled();
    await gate.save(async () => {});
    await gate.run(send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("handles synchronous mutation errors without clearing the send fence", async () => {
    const gate = createCoordinatorModelSave();
    await gate.save(() => {
      throw new Error("Disconnected");
    });
    await expect(gate.run(async () => {})).rejects.toThrow("Disconnected");
  });

  it("cannot dispatch a pending reply into a project after leaving it", async () => {
    const old = createCoordinatorModelSave();
    const leave = old.activate();
    const change = deferred();
    const saving = old.save(() => change.promise);
    const send = vi.fn(async () => {});
    const pending = expect(old.run(send)).rejects.toThrow("project changed");
    leave();
    // A different project is independent of the old one's pending save.
    const next = createCoordinatorModelSave();
    await next.run(async () => {});
    change.resolve();
    await expect(saving).resolves.toBeNull();
    await pending;
    expect(send).not.toHaveBeenCalled();
  });

  it("prevents a second same-frame model mutation until the first has settled", async () => {
    const gate = createCoordinatorModelSave();
    const change = deferred();
    const saving = gate.save(() => change.promise);
    const second = vi.fn(async () => {});
    await expect(gate.save(second)).resolves.toBeNull();
    expect(second).not.toHaveBeenCalled();
    change.resolve();
    await saving;
    await gate.save(second);
    expect(second).toHaveBeenCalledOnce();
  });

  it("does not consume or repeat an operation when its delivery fails", async () => {
    const gate = createCoordinatorModelSave();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue("same receipt");
    await expect(gate.run(send)).rejects.toThrow("Response lost");
    await expect(gate.run(send)).resolves.toBe("same receipt");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
