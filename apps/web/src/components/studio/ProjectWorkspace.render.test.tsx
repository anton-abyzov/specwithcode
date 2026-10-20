// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";
// The fixtures install their module stand-ins first, so they load before anything they replace.
import { state, container, render, prompt } from "./ProjectWorkspace.test-fixtures";
import { setConversationFindState } from "../find/conversationFindStore";
import { COORDINATOR_MESSAGE_WINDOW } from "./CoordinatorConversation";

function conversation(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    text:
      index % 2 === 0
        ? `Question ${index}`
        : `Answer ${index}, see [Thread worker](studio://thread/worker)`,
    role: index % 2 === 0 ? "user" : "assistant",
    createdBy: index % 2 === 0 ? "user" : "agent",
    createdAt: new Date(Date.UTC(2026, 9, 15, 10, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 15, 10, 0, index)).toISOString(),
    streaming: false,
    attachments: [],
  }));
}
const shownMessages = () => container.querySelectorAll(".project-message").length;

describe("coordinator conversation rendering", () => {
  it("renders no message while the person types", async () => {
    state.messages = conversation(20);
    await render();
    const before = state.markdownRenders;
    expect(before).toBeGreaterThan(0);
    await prompt("S");
    await prompt("St");
    await prompt("Status of every worker");
    expect(state.markdownRenders).toBe(before);
  });

  it("renders no message when a thread's status changes or another project's thread updates", async () => {
    state.messages = conversation(20);
    await render();
    const before = state.markdownRenders;
    const chipLabel = () =>
      container.querySelector("[data-thread-chip='worker']")?.getAttribute("aria-label");
    const labelBefore = chipLabel();
    expect(labelBefore).toBeTruthy();
    state.shells = state.shells.map((thread) =>
      thread.id === "worker" || thread.id === "foreign"
        ? { ...thread, updatedAt: "2026-10-16T00:00:00Z", hasPendingUserInput: true }
        : thread,
    );
    await render();
    expect(state.markdownRenders).toBe(before);
    // The chip in each message still follows the thread it names.
    expect(chipLabel()).not.toBe(labelBefore);
  });

  it("renders the messages again when a named thread is renamed", async () => {
    state.messages = conversation(4);
    await render();
    const before = state.markdownRenders;
    state.shells = state.shells.map((thread) =>
      thread.id === "worker" ? { ...thread, title: "Renamed worker" } : thread,
    );
    await render();
    expect(state.markdownRenders).toBeGreaterThan(before);
  });

  it("mounts the latest messages and the earlier ones on request", async () => {
    state.messages = conversation(100);
    await render();
    expect(shownMessages()).toBe(COORDINATOR_MESSAGE_WINDOW);
    expect(container.querySelector(".project-message h3 + *")).not.toBeNull();
    const earlier = [...container.querySelectorAll("button")].find((button) =>
      /^Show \d+ earlier messages$/.test(button.textContent ?? ""),
    );
    expect(earlier?.textContent).toBe(`Show ${100 - COORDINATOR_MESSAGE_WINDOW} earlier messages`);
    await act(async () => earlier!.click());
    expect(shownMessages()).toBe(COORDINATOR_MESSAGE_WINDOW + 40);
    // The newest message stays the last one.
    expect(
      container.querySelectorAll(".project-message").item(shownMessages() - 1).textContent,
    ).toContain("Answer 99");
  });

  it("keeps the reader's place when older messages mount above them", async () => {
    state.messages = conversation(100);
    await render();
    const scope = container.querySelector<HTMLElement>("[data-conversation-find-scope]")!;
    // jsdom lays nothing out: each mounted message is 100px tall here.
    let top = 0;
    Object.defineProperty(scope, "scrollHeight", {
      configurable: true,
      get: () => shownMessages() * 100,
    });
    Object.defineProperty(scope, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    const earlier = [...container.querySelectorAll("button")].find((button) =>
      /^Show \d+ earlier messages$/.test(button.textContent ?? ""),
    );
    // Scrolled to the very top, where no browser anchors the scroll position.
    await act(async () => earlier!.click());
    expect(shownMessages()).toBe(COORDINATOR_MESSAGE_WINDOW + 40);
    // The message that was first in view still is, below the 40 that mounted.
    expect(top).toBe(40 * 100);
  });

  it("mounts every message while the find bar searches this conversation, and keeps them", async () => {
    state.messages = conversation(100);
    await render();
    const scope = container.querySelector<HTMLElement>("[data-conversation-find-scope]")!;
    await act(async () => setConversationFindState({ query: "Question 2", scope }));
    expect(shownMessages()).toBe(100);
    // Closing the find leaves the match it went to where it is.
    await act(async () => setConversationFindState({ query: "", scope: null }));
    expect(shownMessages()).toBe(100);
  });

  describe("scroll position while messages arrive", () => {
    // jsdom lays nothing out: each mounted message is 100px tall in a 300px viewport.
    async function scrolled() {
      await render();
      const scope = container.querySelector<HTMLElement>("[data-conversation-find-scope]")!;
      let top = 0;
      const height = () => container.querySelectorAll(".project-message").length * 100;
      Object.defineProperty(scope, "clientHeight", { configurable: true, get: () => 300 });
      Object.defineProperty(scope, "scrollHeight", { configurable: true, get: height });
      Object.defineProperty(scope, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height() - 300));
        },
      });
      // The reader scrolls: a wheel, then the scroll it causes.
      const scrollTo = async (value: number) => {
        scope.dispatchEvent(new WheelEvent("wheel", { deltaY: value - top, bubbles: true }));
        scope.scrollTop = value;
        await act(async () => scope.dispatchEvent(new Event("scroll")));
      };
      // Mounted before the geometry above existed: start at the end, as the browser would.
      await scrollTo(height());
      return { top: () => top, height, scrollTo };
    }
    const latestButton = () => container.querySelector("[data-coordinator-latest] button");
    const reply = (index: number, extra: Record<string, unknown> = {}) => ({
      ...conversation(index + 1)[index]!,
      ...extra,
    });

    it("keeps a reader who scrolled up where they are when a reply arrives", async () => {
      state.messages = conversation(10);
      const view = await scrolled();
      expect(view.top()).toBe(700);
      expect(latestButton()).toBeNull();
      await view.scrollTo(200);
      expect(latestButton()?.getAttribute("aria-label")).toBe("Jump to latest");
      state.messages = [...state.messages, reply(10, { role: "assistant", createdBy: "agent" })];
      await render();
      expect(view.top()).toBe(200);
      // Nothing scrolls an ancestor either, as scrollIntoView would on a phone.
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(latestButton()?.getAttribute("aria-label")).toBe("Jump to latest, new messages below");
      await act(async () => (latestButton() as HTMLButtonElement).click());
      expect(view.top()).toBe(view.height() - 300);
      expect(latestButton()).toBeNull();
    });

    it("follows new messages while the reader is at the end", async () => {
      state.messages = conversation(10);
      const view = await scrolled();
      state.messages = [...state.messages, reply(10, { role: "assistant", createdBy: "agent" })];
      await render();
      expect(view.top()).toBe(800);
      expect(latestButton()).toBeNull();
    });

    it("returns to the end when the person sends a message, but not for a worker's", async () => {
      state.messages = conversation(10);
      const view = await scrolled();
      await view.scrollTo(100);
      state.messages = [
        ...state.messages,
        reply(10, {
          role: "user",
          createdBy: "user",
          creationSource: "web",
          senderThreadId: "worker",
        }),
      ];
      await render();
      expect(view.top()).toBe(100);
      state.messages = [
        ...state.messages,
        reply(11, { role: "user", createdBy: "user", creationSource: "web" }),
      ];
      await render();
      expect(view.top()).toBe(view.height() - 300);
      // The browser reports the move to the end as a scroll.
      await view.scrollTo(view.top());
      expect(latestButton()).toBeNull();
    });

    it("keeps every mounted message while a reader further up gets new ones", async () => {
      state.messages = conversation(40);
      const view = await scrolled();
      const first = () => container.querySelector(".project-message")?.textContent;
      const before = first();
      expect(shownMessages()).toBe(COORDINATOR_MESSAGE_WINDOW);
      await view.scrollTo(0);
      state.messages = [...state.messages, reply(40), reply(41), reply(42)];
      await render();
      // The message at the top of the window is still there to read.
      expect(first()).toBe(before);
      expect(shownMessages()).toBe(COORDINATOR_MESSAGE_WINDOW + 3);
    });

    it("stays put while the person types in the composer", async () => {
      state.messages = conversation(10);
      const view = await scrolled();
      await view.scrollTo(300);
      await prompt("Where did worker");
      await prompt("Where did worker two land?");
      expect(view.top()).toBe(300);
    });
  });
});
