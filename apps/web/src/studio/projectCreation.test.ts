import { describe, expect, it } from "vite-plus/test";
import {
  defaultProjectMachine,
  newProjectNameNotice,
  resolveNewProjectName,
  suggestProjectMachine,
} from "./projectCreation";
describe("project execution machine defaults", () => {
  it("keeps the current remote machine instead of picking the first local option", () => {
    expect(defaultProjectMachine("remote", ["local", "remote"])).toBe("remote");
  });
  it("requires an explicit choice when the current machine is offline or read-only", () => {
    expect(defaultProjectMachine("offline", ["local"])).toBeNull();
  });
  it("uses the only eligible machine when no current machine exists", () => {
    expect(defaultProjectMachine(null, ["local"])).toBe("local");
  });
  it("does not resolve ambiguous or unavailable machines by ordering", () => {
    expect(defaultProjectMachine(null, ["a", "b"])).toBeNull();
    expect(defaultProjectMachine(null, [])).toBeNull();
  });
});
describe("new project names", () => {
  it("gives an unnamed assistant its default name and keeps a typed one", () => {
    expect(resolveNewProjectName("personal", "   ")).toBe("Aide");
    expect(resolveNewProjectName("personal", " Margo ")).toBe("Margo");
  });
  it("never invents a name for a code project", () => {
    expect(resolveNewProjectName("code", "  ")).toBe("");
    expect(resolveNewProjectName("code", " api ")).toBe("api");
  });
});

describe("new project machine suggestion", () => {
  const off = { enabled: false, weights: {} };
  const suggest = (
    current: string | null,
    eligible: readonly string[],
    loadBalancing: { enabled: boolean; weights: Record<string, number> } = off,
    primary: string | null = "local",
  ) => suggestProjectMachine({ current, eligible, primary, loadBalancing });
  it("keeps the machine being worked on", () => {
    expect(suggest("remote", ["local", "remote"])).toBe("remote");
  });
  it("falls back to this computer when the current machine cannot take the project", () => {
    expect(suggest("offline", ["remote", "local"])).toBe("local");
    expect(suggest(null, ["remote", "local"])).toBe("local");
  });
  it("takes the first eligible machine when this computer is not one of them", () => {
    expect(suggest(null, ["a", "b"], off, null)).toBe("a");
    expect(suggest(null, [])).toBeNull();
  });
  it("follows load-balancing preferences only while balancing is on", () => {
    const weights = { local: 25, remote: 100 };
    expect(suggest(null, ["local", "remote"], { enabled: true, weights })).toBe("remote");
    expect(suggest(null, ["local", "remote"], { enabled: false, weights })).toBe("local");
  });
  it("never chooses a manual-only machine for the person", () => {
    const weights = { local: 0, remote: 25 };
    expect(suggest(null, ["local", "remote"], { enabled: true, weights })).toBe("remote");
    expect(
      suggest(null, ["local", "remote"], { enabled: true, weights: { local: 0, remote: 0 } }),
    ).toBeNull();
    expect(suggest(null, ["local"], { enabled: true, weights: { local: 0 } })).toBe("local");
    // Choosing it by working on it is still the person's choice.
    expect(suggest("local", ["local", "remote"], { enabled: true, weights })).toBe("local");
  });
});

describe("newProjectNameNotice", () => {
  it("stays quiet when the folder follows the name", () => {
    expect(newProjectNameNotice("")).toBeNull();
    expect(newProjectNameNotice("Pinball Stats")).toBeNull();
    expect(newProjectNameNotice("Café")).toBeNull();
  });
  it("explains names that cannot become a folder name", () => {
    expect(newProjectNameNotice("Проект")).toContain('"project"');
    expect(newProjectNameNotice("x".repeat(80))).toContain("shortened");
  });
});
