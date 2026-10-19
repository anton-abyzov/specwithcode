import { EnvironmentId, ProjectWriteFileError } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile, addToast } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  readScope: vi.fn(),
  getUnsavedFile: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: addToast },
  stackedThreadToast: (options: object) => options,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
let renderer: ReactTestRenderer | null;

function ChangeSource(_props: { onChange: (contents: string) => void }) {
  return null;
}

function ReadOnlyProbe(_props: { readOnly: boolean }) {
  return null;
}

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  return (
    <>
      <ChangeSource onChange={(contents) => coordinator.change(contents)} />
      <ReadOnlyProbe readOnly={coordinator.readOnly} />
    </>
  );
}

function mount(props = defaultProps) {
  act(() => {
    renderer = create(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    );
  });
}

function changeHandler(): (contents: string) => void {
  return renderer!.root.findByType(ChangeSource).props.onChange;
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  onPendingChange.mockReset();
  addToast.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it("stops saving a protected file after one refusal and shows one toast", async () => {
    writeFile.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ProjectWriteFileError({
            cwd: "/workspace",
            relativePath: "file.txt",
            failure: "operation_failed",
            operation: "write-file",
            reason: "protected",
          }),
        ),
      ),
    );
    mount();
    expect(renderer!.root.findByType(ReadOnlyProbe).props.readOnly).toBe(false);
    changeHandler()("first edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toMatchObject({
      type: "error",
      description:
        "This file is protected from edits inside SpecWithCode. Use another editor to change it.",
      id: expect.stringContaining("file.txt"),
    });
    expect(renderer!.root.findByType(ReadOnlyProbe).props.readOnly).toBe(true);

    changeHandler()("second edit");
    changeHandler()("third edit");
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);

    // Another file starts writable.
    writeFile.mockResolvedValue(AsyncResult.success(undefined));
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} relativePath="other.txt" />
        </StrictMode>,
      ),
    );
    expect(renderer!.root.findByType(ReadOnlyProbe).props.readOnly).toBe(false);
    changeHandler()("other edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0]).toMatchObject({
      input: { relativePath: "other.txt", contents: "other edit" },
    });
  });

  it("keeps saving after an ordinary failure, without the protected toast", async () => {
    writeFile.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("socket closed"))));
    mount();
    changeHandler()("first edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    changeHandler()("second edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(addToast).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(ReadOnlyProbe).props.readOnly).toBe(false);
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "README.md", contents: "- [x] task\n" },
    });
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await act(async () => renderer!.unmount());
    renderer = null;
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      mount();
      changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await act(async () => renderer!.unmount());
        renderer = null;
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...defaultProps} />
        </StrictMode>,
      ),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("recovers an existing draft once after StrictMode setup replay", async () => {
    getUnsavedFile.mockReturnValue({ contents: "reopened draft" });
    mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "reopened draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    act(() =>
      renderer!.update(
        <StrictMode>
          <FileSurface {...nextProps} />
        </StrictMode>,
      ),
    );
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    mount();
    const retiredChange = changeHandler();
    await act(async () => renderer!.unmount());
    renderer = null;
    mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
