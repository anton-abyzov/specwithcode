import { expect, it, vi } from "vite-plus/test";

vi.mock("./index.css", () => ({}));
vi.mock("./providerAuthDelivery", () => ({ prepareProviderAuthDelivery: () => {} }));
vi.mock("./cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./router", () => ({ getRouter: () => ({ load: async () => {} }) }));
vi.mock("./AppRoot", () => ({ AppRoot: () => null }));
vi.mock("./lib/windowControlsOverlay", () => ({
  syncDocumentElectronPlatformClasses: () => {},
  syncDocumentWindowControlsOverlayClass: () => {},
}));
vi.mock("./lib/renderErrorDiagnostics", () => ({
  raiseErrorStackTraceLimit: () => {},
  recordRenderErrorComponentStack: () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  createBrowserHistory: () => ({}),
  createHashHistory: () => ({}),
}));
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: () => {} }) },
}));

// Boots main in a fresh page that shares the tab's sessionStorage, as a reload does.
async function bootThenFailLazyChunk(sessionStorage: Map<string, string>) {
  vi.resetModules();
  const reload = vi.fn().mockName("location.reload");
  const page = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorage.set(key, value);
      },
      removeItem: (key: string) => {
        sessionStorage.delete(key);
      },
    },
    location: { reload },
    reportError: () => {},
  });
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { getElementById: () => ({}), documentElement: { dataset: {} } });
  try {
    const { startup } = await import("./main");
    await startup;
    page.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    return reload;
  } finally {
    vi.unstubAllGlobals();
  }
}

it("reloads only once when a lazy chunk fails after every boot", async () => {
  const sessionStorage = new Map<string, string>();

  expect(await bootThenFailLazyChunk(sessionStorage)).toHaveBeenCalledTimes(1);
  expect(await bootThenFailLazyChunk(sessionStorage)).not.toHaveBeenCalled();
  expect(await bootThenFailLazyChunk(sessionStorage)).not.toHaveBeenCalled();
});
