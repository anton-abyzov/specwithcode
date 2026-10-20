import { describe, expect, it, vi } from "vite-plus/test";

import { onRestartToUpdateRequest, requestRestartToUpdate } from "./restartToUpdateRequests";

describe("restart to update requests", () => {
  it("reaches the mounted Restart to update button and stops after it unmounts", () => {
    expect(requestRestartToUpdate()).toBe(false);
    const restart = vi.fn(() => true);
    const unsubscribe = onRestartToUpdateRequest(restart);

    expect(requestRestartToUpdate()).toBe(true);
    expect(restart).toHaveBeenCalledOnce();

    unsubscribe();
    expect(requestRestartToUpdate()).toBe(false);
  });

  it("keeps the newest handler when an older one unsubscribes late", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    const unsubscribeOlder = onRestartToUpdateRequest(older);
    const unsubscribeNewer = onRestartToUpdateRequest(newer);
    unsubscribeOlder();

    expect(requestRestartToUpdate()).toBe(true);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    unsubscribeNewer();
  });

  it("passes what is asked and lets the caller install on its own when the button declines", () => {
    // The mounted button only updates the service when its view includes it.
    const restart = vi.fn((request: { requireService?: boolean }) => !request.requireService);
    const unsubscribe = onRestartToUpdateRequest(restart);

    expect(requestRestartToUpdate({ requireService: true })).toBe(false);
    expect(restart).toHaveBeenLastCalledWith({ requireService: true });
    expect(requestRestartToUpdate()).toBe(true);
    expect(restart).toHaveBeenLastCalledWith({});
    unsubscribe();
  });
});
