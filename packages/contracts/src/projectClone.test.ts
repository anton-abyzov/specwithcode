import { describe, expect, it } from "@effect/vitest";

import { projectCloneSendBlockReason } from "./projectClone.ts";

describe("projectCloneSendBlockReason", () => {
  it("blocks sending while the repository is still arriving or never arrived", () => {
    expect(projectCloneSendBlockReason({ phase: "running" })).toBe("Cloning repository");
    expect(projectCloneSendBlockReason({ phase: "failed" })).toBe("Repository not cloned");
    expect(projectCloneSendBlockReason({ phase: "cancelled" })).toBe("Repository not cloned");
  });

  it("lets the draft send once the clone is done or when nothing is cloning", () => {
    expect(projectCloneSendBlockReason({ phase: "done" })).toBeNull();
    expect(projectCloneSendBlockReason(null)).toBeNull();
  });
});
