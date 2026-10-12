// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runThreadLifecycleShortcut } from "./threadLifecycleShortcut";
const event = (options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", {
    key: "s",
    metaKey: true,
    shiftKey: true,
    cancelable: true,
    ...options,
  });
afterEach(() => {
  document.body.innerHTML = "";
});
describe("Resolve keyboard gesture", () => {
  it("runs once while held, blocks a separate press in flight, then allows one deliberate Reopen", async () => {
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const options = { threadKey: "worker:thread", context: {}, run };
    const first = runThreadLifecycleShortcut(event(), options);
    await Promise.resolve();
    expect(await runThreadLifecycleShortcut(event({ repeat: true }), options)).toBe(false);
    expect(await runThreadLifecycleShortcut(event(), options)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(await runThreadLifecycleShortcut(event({ repeat: true }), options)).toBe(false);
    const reopen = vi.fn(async () => undefined);
    expect(await runThreadLifecycleShortcut(event(), { ...options, run: reopen })).toBe(true);
    expect(reopen).toHaveBeenCalledTimes(1);
  });
  it.each(["editableFocus", "terminalFocus", "modelPickerOpen"])(
    "does not consume %s",
    async (key) => {
      const e = event();
      const run = vi.fn();
      expect(
        await runThreadLifecycleShortcut(e, { threadKey: "a", context: { [key]: true }, run }),
      ).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each([
    "<input>",
    "<textarea></textarea>",
    '<div contenteditable="true"><span>x</span></div>',
    '<div class="xterm"><span>x</span></div>',
    '<div role="dialog" aria-modal="true"></div>',
    "<dialog open></dialog>",
  ])("preserves native focus or modal shortcuts: %s", async (html) => {
    document.body.innerHTML = html;
    const e = event();
    document.body.firstElementChild!.dispatchEvent(e);
    const run = vi.fn();
    expect(await runThreadLifecycleShortcut(e, { threadKey: "a", context: {}, run })).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("ignores prevented/composing events and does not leave a rejected operation locked", async () => {
    const e = event();
    e.preventDefault();
    const run = vi.fn();
    expect(await runThreadLifecycleShortcut(e, { threadKey: "a", context: {}, run })).toBe(false);
    expect(
      await runThreadLifecycleShortcut(event({ isComposing: true }), {
        threadKey: "a",
        context: {},
        run,
      }),
    ).toBe(false);
    await expect(
      runThreadLifecycleShortcut(event(), {
        threadKey: "a",
        context: {},
        run: async () => {
          throw new Error("failed");
        },
      }),
    ).rejects.toThrow("failed");
    expect(
      await runThreadLifecycleShortcut(event(), {
        threadKey: "a",
        context: {},
        run: async () => undefined,
      }),
    ).toBe(true);
  });
});
