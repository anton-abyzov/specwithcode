import { describe, expect, it, vi } from "vite-plus/test";

import { readAwayRequest } from "../../studio/awayRequest";
import { closeHandOffMachine, readHandOffMachineRequest } from "../handoff/HandOffMachineDialog";
import { submitCoordinatorDraft } from "./CoordinatorComposer";

const composerWith = (prompt: string) => {
  const setPrompt = vi.fn();
  // Like the real composer: one snapshot object until something changes.
  const snapshot = { prompt, promptRevision: 1, attachments: [], submitting: false };
  return {
    setPrompt,
    composer: {
      getSnapshot: () => snapshot,
      setPrompt,
      setSubmitting: vi.fn(),
    } as never,
  };
};

describe("submitCoordinatorDraft machine commands", () => {
  const submit = async (text: string) => {
    const onSend = vi.fn();
    const { composer, setPrompt } = composerWith(text);
    await submitCoordinatorDraft({
      composer,
      attached: {} as never,
      onAppCommand: null,
      onSend,
      onError: vi.fn(),
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(setPrompt).toHaveBeenCalledWith("");
  };

  it("opens Hand off for every project on /away, even where app commands are not offered", async () => {
    closeHandOffMachine();
    await submit("/away");
    // No project in the request: the dialog's scope is every project on this machine.
    expect(readHandOffMachineRequest()).toEqual({ environmentId: null });
    expect(readAwayRequest()).toBeNull();
  });

  it("asks to bring work back on $back", async () => {
    closeHandOffMachine();
    await submit("$back");
    expect(readAwayRequest()).toBe("back");
    expect(readHandOffMachineRequest()).toBeNull();
  });
});

describe("submitCoordinatorDraft and another window's send", () => {
  it("does not send a copy another window already sent", async () => {
    const onSend = vi.fn();
    const onError = vi.fn();
    const prepare = vi.fn(async () => []);
    const { composer } = composerWith("Use M5");
    await submitCoordinatorDraft({
      composer,
      attached: { dismissProblem: vi.fn(), prepare, hold: vi.fn(), clearSent: vi.fn() } as never,
      onAppCommand: null,
      onSend,
      onError,
      sentElsewhere: async () => true,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith(
      expect.stringContaining("already sent or changed in another window"),
    );
  });

  it("sends a draft that is still current", async () => {
    const onSend = vi.fn(async () => {});
    const { composer } = composerWith("Use M5");
    await submitCoordinatorDraft({
      composer: { ...(composer as object), clearSentPrompt: vi.fn() } as never,
      attached: {
        dismissProblem: vi.fn(),
        prepare: vi.fn(async () => []),
        hold: vi.fn(() => () => {}),
        clearSent: vi.fn(),
      } as never,
      onAppCommand: null,
      onSend,
      onError: vi.fn(),
      sentElsewhere: async () => false,
    });
    expect(onSend).toHaveBeenCalledWith("Use M5", undefined);
  });
});

describe("submitCoordinatorDraft when the box changes during the check", () => {
  it("does not send what was captured before the check", async () => {
    const onSend = vi.fn();
    let revision = 1;
    const composer = {
      getSnapshot: () => ({
        prompt: "Use M5",
        promptRevision: revision,
        attachments: [],
        submitting: false,
      }),
      setPrompt: vi.fn(),
      setSubmitting: vi.fn(),
    } as never;
    await submitCoordinatorDraft({
      composer,
      attached: { dismissProblem: vi.fn(), prepare: vi.fn(async () => []) } as never,
      onAppCommand: null,
      onSend,
      onError: vi.fn(),
      // A restore cleared the box (a new revision) while the host answered "kept".
      sentElsewhere: async () => {
        revision = 2;
        return false;
      },
    });
    expect(onSend).not.toHaveBeenCalled();
  });
});
