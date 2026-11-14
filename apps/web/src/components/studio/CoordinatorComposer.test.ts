import { describe, expect, it, vi } from "vite-plus/test";

import { readAwayRequest } from "../../studio/awayRequest";
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

describe("submitCoordinatorDraft Away commands", () => {
  it("opens the Away dialog for /away and $back even where app commands are not offered", async () => {
    for (const [text, intent] of [
      ["/away", "away"],
      ["$back", "back"],
    ] as const) {
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
      expect(readAwayRequest()).toBe(intent);
    }
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
