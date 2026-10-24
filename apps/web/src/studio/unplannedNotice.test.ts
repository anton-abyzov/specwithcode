import { describe, expect, it } from "vite-plus/test";

import { unplannedNoticeKey, withNoticeHidden } from "./unplannedNotice";

describe("unplanned notice setting", () => {
  it("keys the setting by machine and project", () => {
    expect(unplannedNoticeKey("env-1", "project-1")).toBe("env-1:project-1");
    expect(unplannedNoticeKey("env-1", null)).toBeNull();
    expect(unplannedNoticeKey(undefined, "project-1")).toBeNull();
  });

  it("hides and shows one project without touching the others", () => {
    const hidden = withNoticeHidden(["env-1:other"], "env-1:project-1", true);
    expect(hidden).toEqual(["env-1:other", "env-1:project-1"]);
    expect(withNoticeHidden(hidden, "env-1:project-1", true)).toEqual(hidden);
    expect(withNoticeHidden(hidden, "env-1:project-1", false)).toEqual(["env-1:other"]);
  });
});
