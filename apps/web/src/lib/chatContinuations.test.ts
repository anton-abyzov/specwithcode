// @vitest-environment jsdom
import { beforeEach, expect, it } from "vite-plus/test";

import {
  chatContinuation,
  dismissContinuedFrom,
  recordChatContinuation,
  resetChatContinuationsForTests,
} from "./chatContinuations";

beforeEach(() => {
  localStorage.clear();
  resetChatContinuationsForTests();
});

const oldChat = { environmentId: "m1", threadId: "t1", label: "M1", title: "Plan the trip" };
const newChat = { environmentId: "m4", threadId: "t2", label: "M4" };

it("links the old chat and the new one both ways", () => {
  recordChatContinuation(oldChat, newChat, 1_000);
  expect(chatContinuation("m1", "t1")?.continuedIn).toEqual(newChat);
  expect(chatContinuation("m4", "t2")?.continues).toEqual(oldChat);
  expect(chatContinuation("m4", "t1")).toBeNull();
});

it("survives a reload and remembers a closed notice", () => {
  recordChatContinuation(oldChat, newChat, 1_000);
  dismissContinuedFrom("m4", "t2");
  resetChatContinuationsForTests();
  expect(chatContinuation("m4", "t2")).toMatchObject({ continues: oldChat, dismissed: true });
  expect(chatContinuation("m1", "t1")?.dismissed).toBeUndefined();
});

it("ignores stored entries it cannot read", () => {
  localStorage.setItem(
    "specwithcode:chat-continuations",
    JSON.stringify({ "m1:t1": { at: 1, continuedIn: { threadId: 3 } }, bad: "x" }),
  );
  resetChatContinuationsForTests();
  expect(chatContinuation("m1", "t1")).toEqual({ at: 1 });
});
