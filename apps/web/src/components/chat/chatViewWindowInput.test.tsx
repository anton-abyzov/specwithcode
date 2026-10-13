// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { resolveChatShortcutCommand } from "../../keybindings";
import { registerChatViewWindowInput } from "./chatViewWindowInput";

it("detaches real resolved shortcuts from review and background worker instances, then restores only the worker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const terminalRPC = vi.fn();
  const nativeQuestionKey = vi.fn();
  const native = (event: KeyboardEvent) => {
    if (event.key === "1") nativeQuestionKey();
  };
  document.addEventListener("keydown", native);
  function Instance({ reviewOnly, suspended }: { reviewOnly: boolean; suspended: boolean }) {
    useEffect(
      () =>
        registerChatViewWindowInput(
          "keydown",
          (event) => {
            const command = resolveChatShortcutCommand(
              event,
              DEFAULT_RESOLVED_KEYBINDINGS,
              DEFAULT_RESOLVED_KEYBINDINGS,
              { platform: "MacIntel" },
            );
            if (command === "terminal.toggle") terminalRPC();
          },
          !reviewOnly && !suspended,
        ),
      [reviewOnly, suspended],
    );
    return null;
  }
  const shortcut = () =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }),
    );
  try {
    await act(async () => root.render(<Instance reviewOnly={false} suspended={false} />));
    shortcut();
    expect(terminalRPC).toHaveBeenCalledOnce();
    terminalRPC.mockClear();
    await act(async () =>
      root.render(
        <>
          <Instance reviewOnly={false} suspended />
          <Instance reviewOnly suspended={false} />
        </>,
      ),
    );
    shortcut();
    expect(terminalRPC).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(nativeQuestionKey).toHaveBeenCalledOnce();
    await act(async () => root.render(<Instance reviewOnly={false} suspended={false} />));
    shortcut();
    expect(terminalRPC).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.removeEventListener("keydown", native);
  }
});
it("suspends background paste handling without consuming a native answer's input", () => {
  const paste = vi.fn();
  const stop = registerChatViewWindowInput("paste", paste, false);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  expect(paste).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  stop();
});
