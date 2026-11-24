// @vitest-environment jsdom

import { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  capabilities: { officeDocumentEditing: true } as Record<string, boolean>,
  canWrite: true,
  saves: [] as Array<{ path: string; mode: string }>,
  existing: new Set<string>(),
}));

vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map([["host", { environment: { capabilities: state.capabilities } }]]),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => state.canWrite }));
vi.mock("~/studio/design", () => ({ design: { documentSave: { label: "save" } } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: { input: { path: string; mode: string } }) => {
    state.saves.push({ path: value.input.path, mode: value.input.mode });
    if (state.existing.has(value.input.path)) {
      return { _tag: "Failure", cause: { code: "conflict", message: "exists" } };
    }
    return { _tag: "Success", value: { path: value.input.path, revision: "a".repeat(64) } };
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuTrigger: (props: { children: unknown; "aria-label": string }) => (
    <button type="button" aria-label={props["aria-label"]}>
      {props.children as never}
    </button>
  ),
  MenuPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuItem: (props: { children: unknown; onClick: () => void }) => (
    <button type="button" data-menu-item onClick={props.onClick}>
      {props.children as never}
    </button>
  ),
}));
vi.mock("./LibraryFileViewer", () => ({
  LibraryFileViewer: (props: { path: string }) => <div data-viewer={props.path} />,
}));

import { NewArtifactMenu, newDocumentName } from "./NewArtifactMenu";

const environmentId = EnvironmentId.make("host");
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.capabilities = { officeDocumentEditing: true };
  state.canWrite = true;
  state.saves.length = 0;
  state.existing.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("NewArtifactMenu", () => {
  it("names new documents in turn", () => {
    expect(newDocumentName(1)).toBe("untitled-document.docx");
    expect(newDocumentName(3)).toBe("untitled-document-3.docx");
  });

  it("is hidden without write access or an editing machine", async () => {
    state.canWrite = false;
    await act(async () => {
      root.render(<NewArtifactMenu environmentId={environmentId} workspaceRoot="/p" />);
    });
    expect(container.querySelector("[aria-label='New artifact']")).toBeNull();
    state.canWrite = true;
    state.capabilities = {};
    await act(async () => {
      root.render(<NewArtifactMenu environmentId={environmentId} workspaceRoot="/p/" />);
    });
    expect(container.querySelector("[aria-label='New artifact']")).toBeNull();
  });

  it("creates the next free name in the artifacts folder and opens it", async () => {
    state.existing.add("/p/.specweave/artifacts/untitled-document.docx");
    await act(async () => {
      root.render(<NewArtifactMenu environmentId={environmentId} workspaceRoot="/p/" />);
    });
    await act(async () => {
      (container.querySelector("[data-menu-item]") as HTMLButtonElement).click();
    });
    expect(state.saves).toEqual([
      { path: "/p/.specweave/artifacts/untitled-document.docx", mode: "create" },
      { path: "/p/.specweave/artifacts/untitled-document-2.docx", mode: "create" },
    ]);
    expect(container.querySelector("[data-viewer]")?.getAttribute("data-viewer")).toBe(
      ".specweave/artifacts/untitled-document-2.docx",
    );
  });
});
