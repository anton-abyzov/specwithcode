// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@specweave-studio/contracts";
import { projectReturnSearch, rememberProjectDestination } from "./projectReturnNavigation";

const worker = ThreadId.make("worker");
beforeEach(() => localStorage.clear());
describe("sidebar project return destinations", () => {
  it("remembers each project independently across rapid returns and reload reads", () => {
    rememberProjectDestination("a", { thread: worker, checkout: "m4:a" });
    rememberProjectDestination("b", { thread: ThreadId.make("other"), checkout: "m4:b" });
    expect(projectReturnSearch("a", "m4:a")).toEqual({
      thread: worker,
      checkout: "m4:a",
      restoreThread: true,
    });
    expect(projectReturnSearch("a", "m4:a")).toEqual(projectReturnSearch("a", "m4:a"));
    expect(projectReturnSearch("b", "m4:b").thread).toBe("other");
  });
  it("keeps overview intentional and first visits empty", () => {
    expect(projectReturnSearch("new")).toEqual({});
    rememberProjectDestination("a", { thread: worker });
    rememberProjectDestination("a", {});
    expect(projectReturnSearch("a")).toEqual({});
  });
  it("does not collide across machines and retains explicit thread environment", () => {
    rememberProjectDestination("m4-project", { checkout: "m4:p", thread: worker });
    rememberProjectDestination("m3-project", { checkout: "m3:p", thread: ThreadId.make("second") });
    expect(projectReturnSearch("m4-project", "m4:p").thread).toBe(worker);
    expect(projectReturnSearch("m3-project", "m3:p").thread).toBe("second");
    rememberProjectDestination("logical", { thread: worker, threadEnvironment: "m3" });
    expect(projectReturnSearch("logical").threadEnvironment).toBe("m3");
  });
  it("logical project returns preserve the explicitly viewed coordinator checkout", () => {
    rememberProjectDestination("logical", {
      checkout: "m3:p",
      thread: worker,
      threadEnvironment: "m4",
    });
    expect(projectReturnSearch("logical")).toEqual({
      checkout: "m3:p",
      thread: worker,
      threadEnvironment: "m4",
      restoreThread: true,
    });
  });
  it("returns to the exact last checkout even when the inactive sidebar defaults elsewhere", () => {
    rememberProjectDestination("repo", {
      checkout: "m3:p",
      thread: worker,
      threadEnvironment: "m3",
    });
    expect(projectReturnSearch("repo", "m4:p")).toEqual({
      checkout: "m3:p",
      thread: worker,
      threadEnvironment: "m3",
      restoreThread: true,
    });
  });
  it("does not overwrite a destination while a restored selection is loading", () => {
    rememberProjectDestination("a", { thread: worker });
    rememberProjectDestination("a", { thread: ThreadId.make("background"), restoreThread: true });
    expect(projectReturnSearch("a").thread).toBe(worker);
  });
  it("validates corrupt storage and bounds retained projects", () => {
    expect(projectReturnSearch("a", undefined, "{broken")).toEqual({});
    expect(
      projectReturnSearch(
        "a",
        undefined,
        JSON.stringify({ [JSON.stringify(["a"])]: { thread: 17 } }),
      ),
    ).toEqual({});
    for (let i = 0; i < 105; i++) rememberProjectDestination(`p${i}`, { thread: worker });
    expect(projectReturnSearch("p0")).toEqual({});
    expect(projectReturnSearch("p104").thread).toBe(worker);
  });
});
