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
