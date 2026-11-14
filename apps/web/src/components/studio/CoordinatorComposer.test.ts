import { describe, expect, it, vi } from "vite-plus/test";

import { readAwayRequest } from "../../studio/awayRequest";
import { submitCoordinatorDraft } from "./CoordinatorComposer";

const composerWith = (prompt: string) => {
  const setPrompt = vi.fn();
  return {
    setPrompt,
    composer: {
      getSnapshot: () => ({ prompt, promptRevision: 1, attachments: [], submitting: false }),
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
