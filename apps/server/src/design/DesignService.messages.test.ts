// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { fileFailureDetail } from "./DesignService.ts";
import { DesignStoreProblem, resolveDesignRoot } from "./DesignStore.ts";

const errno = (code: string, syscall: string, path: string) =>
  Object.assign(new Error(code), { code, syscall, path });

describe("design failure messages", () => {
  it("names the cause and the folder of a failed save", () => {
    expect(fileFailureDetail(errno("EACCES", "mkdir", "/work/app/.specweave/design/d_1"))).toBe(
      "The design could not be saved: SpecWithCode may not write to /work/app/.specweave/design/d_1.",
    );
    expect(
      fileFailureDetail(errno("EACCES", "copyfile", "/work/app/.specweave/design/d_1/design.json")),
    ).toBe(
      "The design could not be saved: SpecWithCode may not write to /work/app/.specweave/design/d_1.",
    );
    expect(fileFailureDetail(errno("ENOSPC", "write", "/work/app/a.json"))).toBe(
      "The design could not be saved: the disk holding /work/app is full.",
    );
  });

  it("says read for a failed read and never 'read or saved'", () => {
    expect(fileFailureDetail(errno("EACCES", "scandir", "/work/app/.specweave/design"))).toBe(
      "The design could not be read: SpecWithCode may not read /work/app/.specweave/design.",
    );
    expect(fileFailureDetail(new Error("boom"))).toBe("The design could not be saved. Try again.");
  });

  it("says read when the caller was reading, even for a failed open", () => {
    const denied = errno("EACCES", "open", "/work/app/.specweave/design/d_1/design.json");
    expect(fileFailureDetail(denied, "read")).toBe(
      "The design could not be read: SpecWithCode may not read /work/app/.specweave/design/d_1.",
    );
    expect(fileFailureDetail(denied, "save")).toBe(
      "The design could not be saved: SpecWithCode may not write to /work/app/.specweave/design/d_1.",
    );
    expect(fileFailureDetail(new Error("boom"), "read")).toBe(
      "The design could not be read. Try again.",
    );
  });

  it("names the missing project folder", async () => {
    const gone = NodePath.join(NodeOS.tmpdir(), `swc-missing-${process.pid}-${Date.now()}`);
    const failure = await resolveDesignRoot(gone, ".specweave/design", { create: false }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DesignStoreProblem);
    expect((failure as DesignStoreProblem).message).toBe(`The folder ${gone} is missing.`);
  });
});
