import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { resolveSelectedThreadShell } from "./selectedThreadShell";

const archived = { environmentId: "host", id: "history", deletedAt: null,
  archivedAt: "2026-10-14T00:00:00Z" } as EnvironmentThreadShell;
const ref = { environmentId: "host", threadId: "history" } as ScopedThreadRef;
describe("selected history shell", () => {
  it("supplies a selected archived shell when absent from the live index", () => {
    expect(resolveSelectedThreadShell(ref, null, archived)).toBe(archived);
  });
  it("uses the live shell after reopening", () => {
    const live = { ...archived, archivedAt: null };
    expect(resolveSelectedThreadShell(ref, live, archived)).toBe(live);
  });
  it("never leaks history into a different host, thread, draft or deleted selection", () => {
    expect(resolveSelectedThreadShell({ ...ref, environmentId: "other" } as ScopedThreadRef, null, archived)).toBeNull();
    expect(resolveSelectedThreadShell({ ...ref, threadId: "other" } as ScopedThreadRef, null, archived)).toBeNull();
    expect(resolveSelectedThreadShell(null, null, archived)).toBeNull();
    expect(resolveSelectedThreadShell(ref, null, { ...archived, deletedAt: "2026-10-14T01:00:00Z" })).toBeNull();
  });
});
