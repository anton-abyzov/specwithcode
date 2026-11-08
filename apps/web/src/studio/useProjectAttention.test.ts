import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { memberFreshness } from "./useProjectAttention";

const snapshot = (projectIds: string[]) =>
  Option.some({ projects: projectIds.map((id) => ({ id })) } as never);

describe("memberFreshness", () => {
  it("reads a project on a live machine as live", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "a", false)).toBe("live");
  });

  it("reads a project a live machine no longer has as live, not catching up forever", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "gone", false)).toBe(
      "live",
    );
  });

  it("waits for a machine that is still synchronizing or only cached", () => {
    expect(
      memberFreshness({ snapshot: snapshot(["a"]), status: "synchronizing" }, "a", false),
    ).toBe("synchronizing");
    expect(
      memberFreshness({ snapshot: snapshot(["a"]), status: "synchronizing" }, "gone", false),
    ).toBe("empty");
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "cached" }, "gone", false)).toBe(
      "empty",
    );
    expect(memberFreshness({ snapshot: Option.none(), status: "empty" }, "a", false)).toBe("empty");
  });

  it("reads an unreachable machine as offline", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "a", true)).toBe(
      "offline",
    );
  });
});
