import { describe, expect, it, vi } from "vite-plus/test";

import { SYSTEM_RESUME_CHANNEL } from "../ipc/channels.ts";
import { broadcastSystemResume } from "./systemResume.ts";

function target(destroyed = false, throws = false) {
  const send = vi.fn((_channel: string) => {
    if (throws) throw new Error("Render frame was disposed");
  });
  return { isDestroyed: () => destroyed, webContents: { send } };
}

describe("broadcastSystemResume", () => {
  it("tells every live window, and skips a destroyed or disposed one", () => {
    const live = target();
    const other = target();
    const destroyed = target(true);
    const disposed = target(false, true);
    expect(broadcastSystemResume([live, destroyed, disposed, other])).toBe(2);
    expect(live.webContents.send).toHaveBeenCalledWith(SYSTEM_RESUME_CHANNEL);
    expect(other.webContents.send).toHaveBeenCalledWith(SYSTEM_RESUME_CHANNEL);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});
