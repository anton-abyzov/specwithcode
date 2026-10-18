import { describe, expect, it, vi } from "vite-plus/test";

import { onRestartToUpdateRequest, requestRestartToUpdate } from "./restartToUpdateRequests";

describe("restart to update requests", () => {
  it("reaches the mounted Restart to update button and stops after it unmounts", () => {
    expect(requestRestartToUpdate()).toBe(false);
    const restart = vi.fn();
    const unsubscribe = onRestartToUpdateRequest(restart);

    expect(requestRestartToUpdate()).toBe(true);
    expect(restart).toHaveBeenCalledOnce();

    unsubscribe();
    expect(requestRestartToUpdate()).toBe(false);
  });

  it("keeps the newest handler when an older one unsubscribes late", () => {
    const older = vi.fn();
    const newer = vi.fn();
    const unsubscribeOlder = onRestartToUpdateRequest(older);
    const unsubscribeNewer = onRestartToUpdateRequest(newer);
    unsubscribeOlder();

    expect(requestRestartToUpdate()).toBe(true);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    unsubscribeNewer();
  });
});
