import { newSignInViewerKey, unsealForSignIn } from "@specweave-studio/shared/signInSeal";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSignInSender,
  framePoint,
  SIGN_IN_TEXT_CHUNK,
  signInKeyAction,
} from "./signInViewerLogic";

const press = (
  key: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {},
) => signInKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("sign-in viewer keys (1488)", () => {
  it("sends named keys by name, characters as text, and leaves shortcuts to this window", () => {
    expect(press("Enter")).toEqual({ kind: "named", key: "enter" });
    expect(press("ArrowLeft")).toEqual({ kind: "named", key: "arrowleft" });
    expect(press("a")).toEqual({ kind: "text", text: "a" });
    expect(press("😀")).toEqual({ kind: "text", text: "😀" });
    expect(press("@", { altKey: true })).toEqual({ kind: "text", text: "@" });
    expect(press("v", { metaKey: true })).toEqual({ kind: "ignore" });
    expect(press("c", { ctrlKey: true })).toEqual({ kind: "ignore" });
    expect(press("Shift")).toEqual({ kind: "ignore" });
    expect(press("F5")).toEqual({ kind: "ignore" });
  });

  it("maps a click on the shown image to the page's pixels, and ignores one outside it", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    const frame = { width: 800, height: 600 };
    expect(framePoint({ x: 300, y: 200 }, rect, frame)).toEqual({ x: 400, y: 300 });
    expect(framePoint({ x: 99, y: 200 }, rect, frame)).toBeNull();
    expect(framePoint({ x: 300, y: 200 }, { ...rect, width: 0 }, frame)).toBeNull();
  });
});

describe("sign-in viewer sending (1488)", () => {
  const harness = async () => {
    const view = await newSignInViewerKey();
    const sent: Array<{ kind: string; value: unknown }> = [];
    const timers: Array<() => void> = [];
    const sender = createSignInSender({
      publicKey: view.publicKey,
      sendText: async (sealed) => {
        sent.push({
          kind: "text",
          value: JSON.parse(new TextDecoder().decode(await unsealForSignIn(sealed, view))),
        });
      },
      sendKey: async (frame, key) => {
        sent.push({ kind: "key", value: { frame, key } });
      },
      onError: (error) => {
        throw error;
      },
      schedule: (run) => {
        timers.push(run);
        return () => {};
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    // Sealing is WebCrypto work; on a busy machine it can outlast any fixed pause.
    const sentCount = (count: number) =>
      vi.waitFor(() => expect(sent).toHaveLength(count), { timeout: 5_000 });
    return { sender, sent, timers, settle, sentCount };
  };

  it("batches characters, seals them with a growing seq, and keeps them before the next key", async () => {
    const { sender, sent, sentCount } = await harness();
    sender.text("100:1", "hun");
    sender.text("100:1", "ter2");
    sender.key("100:1", "enter");
    await sentCount(2);
    expect(sent).toEqual([
      { kind: "text", value: { seq: 1, frame: "100:1", text: "hunter2" } },
      { kind: "key", value: { frame: "100:1", key: "enter" } },
    ]);
    sender.text("100:1", "x");
    sender.flush();
    await sentCount(3);
    expect(sent.at(-1)).toEqual({ kind: "text", value: { seq: 2, frame: "100:1", text: "x" } });
  });

  it("never sends text typed on one frame against another, and splits long pastes", async () => {
    const { sender, sent, sentCount } = await harness();
    sender.text("100:1", "a");
    sender.text("100:2", "b");
    sender.text("100:2", "c".repeat(SIGN_IN_TEXT_CHUNK + 1));
    sender.flush();
    await sentCount(3);
    expect(sent.map((entry) => (entry.value as { frame: string }).frame)).toEqual([
      "100:1",
      "100:2",
      "100:2",
    ]);
    expect(sent.map((entry) => (entry.value as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it("drops what is buffered when the view closes", async () => {
    const { sender, sent, settle } = await harness();
    sender.text("100:1", "secret");
    sender.drop();
    sender.flush();
    await settle();
    expect(sent).toEqual([]);
  });
});
