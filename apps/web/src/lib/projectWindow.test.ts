import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: toast.add } }));

import {
  canOpenProjectWindow,
  canOpenProjectWindowFor,
  isProjectWindow,
  openProjectWindow,
  ownProjectWindowKey,
} from "./projectWindow";

function stubWindow(input: { bridge?: Record<string, unknown>; search?: string }) {
  vi.stubGlobal("window", {
    ...(input.bridge ? { desktopBridge: input.bridge } : {}),
    location: { search: input.search ?? "" },
  });
}

beforeEach(() => {
  toast.add.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canOpenProjectWindow", () => {
  it("is false outside a browser window", () => {
    expect(canOpenProjectWindow()).toBe(false);
  });

  it("is false in the browser and on desktop builds without project windows", () => {
    stubWindow({});
    expect(canOpenProjectWindow()).toBe(false);
    stubWindow({ bridge: {} });
    expect(canOpenProjectWindow()).toBe(false);
    stubWindow({ bridge: { openProjectWindow: true } });
    expect(canOpenProjectWindow()).toBe(false);
  });

  it("is true when the desktop shell can open project windows", () => {
    stubWindow({ bridge: { openProjectWindow: async () => undefined } });
    expect(canOpenProjectWindow()).toBe(true);
  });
});

describe("openProjectWindow", () => {
  it("passes the project key and title to the desktop shell", async () => {
    const open = vi.fn(async () => undefined);
    stubWindow({ bridge: { openProjectWindow: open } });
    await openProjectWindow({ projectKey: "atlas", title: "Atlas" });
    expect(open).toHaveBeenCalledExactlyOnceWith({ projectKey: "atlas", title: "Atlas" });
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("leaves out a missing title and shortens one the shell would reject", async () => {
    const open = vi.fn(async () => undefined);
    stubWindow({ bridge: { openProjectWindow: open } });
    await openProjectWindow({ projectKey: "atlas" });
    expect(open).toHaveBeenLastCalledWith({ projectKey: "atlas" });
    await openProjectWindow({ projectKey: "atlas", title: "a".repeat(300) });
    expect(open).toHaveBeenLastCalledWith({ projectKey: "atlas", title: "a".repeat(256) });
  });

  it("reports a failed open instead of dropping it", async () => {
    stubWindow({
      bridge: {
        openProjectWindow: async () => {
          throw new Error("Window could not be created");
        },
      },
    });
    await expect(
      openProjectWindow({ projectKey: "atlas", title: "Atlas" }),
    ).resolves.toBeUndefined();
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not open project window",
      description: "Window could not be created",
    });
  });

  it("does nothing where project windows are unavailable", async () => {
    stubWindow({ bridge: {} });
    await expect(openProjectWindow({ projectKey: "atlas" })).resolves.toBeUndefined();
    expect(toast.add).not.toHaveBeenCalled();
  });
});

describe("isProjectWindow", () => {
  it("is true only for a desktop window opened for a project", () => {
    stubWindow({ bridge: { getWindowRole: () => "project" } });
    expect(isProjectWindow()).toBe(true);
    stubWindow({ bridge: { getWindowRole: () => "main" } });
    expect(isProjectWindow()).toBe(false);
  });

  it("is false on a desktop build that predates project windows", () => {
    stubWindow({ bridge: {} });
    expect(isProjectWindow()).toBe(false);
  });

  it("does not read the role from the URL, in the browser or on desktop", () => {
    stubWindow({ search: "?window=project" });
    expect(isProjectWindow()).toBe(false);
    stubWindow({ bridge: { getWindowRole: () => "main" }, search: "?window=project" });
    expect(isProjectWindow()).toBe(false);
  });

  it("is false when the shell cannot be asked", () => {
    stubWindow({
      bridge: {
        getWindowRole: () => {
          throw new Error("bridge gone");
        },
      },
    });
    expect(isProjectWindow()).toBe(false);
  });

  it("is false outside a browser window", () => {
    expect(isProjectWindow()).toBe(false);
  });
});

describe("canOpenProjectWindowFor", () => {
  const open = async () => undefined;

  it("is false wherever project windows are unavailable", () => {
    expect(canOpenProjectWindowFor("atlas")).toBe(false);
    stubWindow({ bridge: { getWindowProjectKey: () => "orbit" } });
    expect(canOpenProjectWindowFor("atlas")).toBe(false);
  });

  it("offers every project from the main window and older shells", () => {
    stubWindow({ bridge: { openProjectWindow: open } });
    expect(ownProjectWindowKey()).toBeNull();
    expect(canOpenProjectWindowFor("atlas")).toBe(true);
    stubWindow({ bridge: { openProjectWindow: open, getWindowProjectKey: () => null } });
    expect(canOpenProjectWindowFor("atlas")).toBe(true);
    expect(canOpenProjectWindowFor(null)).toBe(true);
  });

  it("offers every project but its own from a project window", () => {
    stubWindow({ bridge: { openProjectWindow: open, getWindowProjectKey: () => "atlas" } });
    expect(ownProjectWindowKey()).toBe("atlas");
    expect(canOpenProjectWindowFor("atlas")).toBe(false);
    expect(canOpenProjectWindowFor("orbit")).toBe(true);
  });

  it("treats a shell that cannot answer as the main window", () => {
    stubWindow({
      bridge: {
        openProjectWindow: open,
        getWindowProjectKey: () => {
          throw new Error("gone");
        },
      },
    });
    expect(ownProjectWindowKey()).toBeNull();
    expect(canOpenProjectWindowFor("atlas")).toBe(true);
  });
});
