// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectEnvironmentImportPreview } from "@specweave-studio/contracts";
import { ProjectEnvironmentImport } from "./ProjectEnvironmentImport";

let container: HTMLDivElement;
let root: Root;
const preview = (): ProjectEnvironmentImportPreview => ({
  root: "/work/planning",
  revision: 4,
  fingerprint: "a".repeat(64),
  canApply: true,
  repositories: [
    {
      id: "web",
      path: "/work/web",
      url: "https://github.com/example/web",
      status: "add",
      reason: "Attach this existing checkout.",
    },
    {
      id: "local",
      path: "/work/local",
      url: null,
      status: "blocked",
      reason:
        "No readable origin URL. Use an approved additional folder for this local-only checkout.",
    },
  ],
  environment: {
    additionalFolders: [],
    repositories: [{ id: "web", url: "https://github.com/example/web", localPath: "/work/web" }],
  },
});
const props = {
  initialRoot: "/work/planning",
  revision: 4,
  disabled: false,
  onPreview: vi.fn(),
  onImport: vi.fn(),
  onBusyChange: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  props.onPreview.mockResolvedValue(preview());
  props.onImport.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (patch = {}) =>
  act(async () => root.render(<ProjectEnvironmentImport {...props} {...patch} />));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === name)!;
const click = (name: string) => act(async () => button(name).click());

describe("workspace import review", () => {
  it("waits for explicit preview/apply and keeps remaining rows after partial import", async () => {
    await render();
    expect(props.onPreview).not.toHaveBeenCalled();
    await click("Preview import");
    expect(container.textContent).toContain("1 to attach · 0 already attached · 1 blocked");
    expect(props.onImport).not.toHaveBeenCalled();
    props.onPreview.mockResolvedValue({
      ...preview(),
      revision: 5,
      repositories: preview().repositories.map((row) =>
        row.status === "add" ? { ...row, status: "existing" } : row,
      ),
    });
    await click("Import 1 ready repository");
    expect(props.onImport).toHaveBeenCalledWith(preview());
    expect(container.textContent).toContain("1 attached, 1 remaining");
    expect(container.textContent).toContain("local-only checkout");
    expect(container.textContent).toContain("0 to attach · 1 already attached · 1 blocked");
  });
  it("disables blocked previews, invalidates stale revisions and handles fresh host rejection", async () => {
    props.onPreview.mockResolvedValue({ ...preview(), canApply: false });
    await render();
    await click("Preview import");
    expect(button("Import 1 ready repository").disabled).toBe(true);
    await render({ revision: 5 });
    expect(container.querySelector('[aria-label="Workspace import preview"]')).toBeNull();
    props.onPreview.mockResolvedValue(preview());
    await click("Preview import");
    props.onImport.mockRejectedValue(
      new Error("The workspace or project changed. Preview the import again."),
    );
    await click("Import 1 ready repository");
    expect(container.textContent).toContain("Preview the import again.");
    expect(container.querySelector('[aria-label="Workspace import preview"]')).toBeNull();
  });
  it("keeps the confirmed partial result when a follow-up preview fails", async () => {
    await render();
    await click("Preview import");
    props.onPreview.mockRejectedValue(new Error("Host unavailable"));
    await click("Import 1 ready repository");
    expect(container.textContent).toContain("1 attached, 1 remaining");
    expect(container.textContent).toContain("local-only checkout");
    expect(container.textContent).toContain("Import saved. Preview again");
    expect(button("Keep existing attachments").disabled).toBe(true);
    expect(props.onImport).toHaveBeenCalledTimes(1);
  });
  it("blocks concurrent requests and read-only project controls", async () => {
    let complete!: (value: ProjectEnvironmentImportPreview) => void;
    props.onPreview.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    await click("Preview import");
    expect(button("Checking workspace…").disabled).toBe(true);
    await click("Checking workspace…");
    expect(props.onPreview).toHaveBeenCalledTimes(1);
    await act(async () => complete(preview()));
    await render({ disabled: true });
    expect(button("Import 1 ready repository").disabled).toBe(true);
    expect(button("Preview import").disabled).toBe(true);
  });
});
