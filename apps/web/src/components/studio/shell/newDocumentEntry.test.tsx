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
import type { ArtifactNewEntry } from "./ArtifactNewMenu";
import { newDocumentName, useNewDocumentEntry } from "./newDocumentEntry";

let entry: ArtifactNewEntry | null = null;
function Probe(props: { workspaceRoot: string }) {
  entry = useNewDocumentEntry({ environmentId, workspaceRoot: props.workspaceRoot });
  return null;
}

const environmentId = EnvironmentId.make("host");
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.capabilities = { officeDocumentEditing: true };
  state.canWrite = true;
  state.saves.length = 0;
  state.existing.clear();
  entry = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("the New document entry", () => {
  it("names new documents in turn", () => {
    expect(newDocumentName(1)).toBe("untitled-document.docx");
    expect(newDocumentName(3)).toBe("untitled-document-3.docx");
  });

  it("is hidden without write access or an editing machine", async () => {
    state.canWrite = false;
    await act(async () => {
      root.render(<Probe workspaceRoot="/p" />);
    });
    expect(entry).toBeNull();
    state.canWrite = true;
    state.capabilities = {};
    await act(async () => {
      root.render(<Probe workspaceRoot="/p/" />);
    });
    expect(entry).toBeNull();
  });

  it("creates the next free name in the artifacts folder, never over a file", async () => {
    state.existing.add("/p/.specweave/artifacts/untitled-document.docx");
    await act(async () => {
      root.render(<Probe workspaceRoot="/p/" />);
    });
    const created = await entry!.create();
    expect(state.saves).toEqual([
      { path: "/p/.specweave/artifacts/untitled-document.docx", mode: "create" },
      { path: "/p/.specweave/artifacts/untitled-document-2.docx", mode: "create" },
    ]);
    expect(created).toEqual({
      path: ".specweave/artifacts/untitled-document-2.docx",
      title: "untitled-document-2.docx",
    });
    expect(entry!.label).toBe("Document");
  });
});
