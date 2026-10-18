// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { SERVICE_UPDATE_IN_PROGRESS_MESSAGE } from "@specweave-studio/contracts";

import { state, container, render, click, prompt } from "./ProjectWorkspace.test-fixtures";

vi.mock("../../lib/durableComposerDraftBindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  whenHostReady: async () => true,
}));

describe("a coordinator message sent during an update", () => {
  it("is sent again with the same identity once the host is back, not dropped", async () => {
    state.send.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error(SERVICE_UPDATE_IN_PROGRESS_MESSAGE),
    });
    await render();
    await prompt("Sent while the app updates");
    await click("Send");
    // The retry waits one second before sending again.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 1_100));
    });
    expect(state.send).toHaveBeenCalledTimes(2);
    const [first, second] = state.send.mock.calls;
    expect(second![0].input.commandId).toBe(first![0].input.commandId);
    expect(second![0].input.prompt).toBe("Sent while the app updates");
    expect(container.textContent).not.toContain(SERVICE_UPDATE_IN_PROGRESS_MESSAGE);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
  });
});
