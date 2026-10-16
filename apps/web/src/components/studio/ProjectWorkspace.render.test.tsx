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
});
