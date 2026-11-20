import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type DesktopBridge,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("keeps backend operations out of the local host facade", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();

    expect(api).not.toHaveProperty("server");
    expect(api.shell).not.toHaveProperty("openInEditor");
  });

  it("uses the browser context-menu fallback without a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("dismisses an open browser context menu without a desktop bridge", async () => {
    const { createLocalApi } = await import("./localApi");

    await createLocalApi().contextMenu.close();

    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });

  it("uses the themed confirmation host when it is available", async () => {
    requestConfirmDialogMock.mockResolvedValue(true);
    const { createLocalApi } = await import("./localApi");
    const options = { variant: "destructive" } as const;

    await expect(createLocalApi().dialogs.confirm("Delete this thread?", options)).resolves.toBe(
      true,
    );
    expect(requestConfirmDialogMock).toHaveBeenCalledWith("Delete this thread?", options);
  });

  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it("opens only web addresses in a browser without a desktop bridge", async () => {
    const open = vi.fn<Window["open"]>().mockReturnValue(null);
    Object.defineProperty(testWindow(), "open", { configurable: true, value: open });
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();

    for (const url of ["javascript:alert(document.domain)", "data:text/html,x", "not a url"]) {
      await expect(api.shell.openExternal(url)).rejects.toThrow("Unable to open link.");
    }
    expect(open).not.toHaveBeenCalled();

    await api.shell.openExternal("https://example.com/login");
    expect(open).toHaveBeenCalledWith("https://example.com/login", "_blank", "noopener,noreferrer");
  });

  it("opens a protocol-relative link against the page's scheme", async () => {
    const open = vi.fn<Window["open"]>().mockReturnValue(null);
    Object.defineProperty(testWindow(), "open", { configurable: true, value: open });
    Object.defineProperty(testWindow(), "location", {
      configurable: true,
      value: new URL("https://app.example.test/chat"),
    });
    const { createLocalApi } = await import("./localApi");

    try {
      await createLocalApi().shell.openExternal("//example.test/docs");
      expect(open).toHaveBeenCalledWith(
        "https://example.test/docs",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      Reflect.deleteProperty(testWindow(), "location");
    }
  });

  it("rejects opening System Settings when the desktop bridge is unavailable", async () => {
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().shell.openSystemSettings("full-disk-access")).rejects.toThrow(
      "Unable to open System Settings.",
    );
  });

  it("delegates host capabilities and persistence to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    const getClientSettings = vi.fn().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().desktopBridge = {
      showContextMenu,
      pickFolder,
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    requestConfirmDialogMock.mockReturnValue(undefined);
    await expect(api.dialogs.confirm("Install update?")).resolves.toBe(false);
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await api.persistence.setClientSettings(DEFAULT_CLIENT_SETTINGS);

    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(setClientSettings).toHaveBeenCalledWith(DEFAULT_CLIENT_SETTINGS);
  });

  it("persists client settings in browser storage", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
    };

    await api.persistence.setClientSettings(settings);
    await expect(api.persistence.getClientSettings()).resolves.toEqual(settings);
  });
});
