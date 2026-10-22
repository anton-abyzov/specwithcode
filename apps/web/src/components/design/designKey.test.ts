import { DesignId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decodeDesignKey, encodeDesignKey } from "./designKey";

const designId = "d_7f3a" as DesignId;

describe("design keys", () => {
  it("encodes a project design and a Playground design", () => {
    const projectId = ProjectId.make("proj-1");
    expect(encodeDesignKey({ kind: "project", projectId }, designId)).toBe("p.proj-1.d_7f3a");
    expect(encodeDesignKey({ kind: "playground" }, designId)).toBe("pg.d_7f3a");
  });

  it("round-trips project ids that contain dots", () => {
    const owner = { kind: "project", projectId: ProjectId.make("acme.web.v2") } as const;
    expect(decodeDesignKey(encodeDesignKey(owner, designId))).toEqual({ owner, designId });
    expect(decodeDesignKey("pg.d_7f3a")).toEqual({ owner: { kind: "playground" }, designId });
  });

  it("rejects malformed keys", () => {
    for (const key of [
      "",
      "pg.",
      "p.",
      "p..d1",
      "p.proj",
      "x.proj.d1",
      "pg.bad id",
      "p.proj.d/1",
    ]) {
      expect(decodeDesignKey(key)).toBeNull();
    }
  });
});
