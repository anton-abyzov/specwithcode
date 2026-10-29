import { MOBILE_USER_RESULTS } from "../../tests/agent-messages/internalReceipts";
import { describe, expect, it } from "vite-plus/test";
import { isMetadataOnlyAssistantMessage } from "./messagePresentation";

describe("shared assistant content gate", () => {
  const empty = { role: "assistant", text: " \n\t", streaming: false, attachments: [] };
  it("does not manufacture an answer from execution metadata", () => {
    expect(isMetadataOnlyAssistantMessage(empty)).toBe(true);
    expect(
      isMetadataOnlyAssistantMessage({ ...empty, streaming: undefined, attachments: undefined }),
    ).toBe(true);
  });
  it.each([
    { ...empty, role: "user" },
    { ...empty, streaming: true },
    { ...empty, text: "Authentication failed. Sign in to continue." },
    { ...empty, attachments: [{ id: "evidence" }] },
  ])("preserves user input, live output, failures and attachments", (message) => {
    expect(isMetadataOnlyAssistantMessage(message)).toBe(false);
  });
  it("preserves cards, changed files and other supplemental content", () => {
    expect(isMetadataOnlyAssistantMessage(empty, true)).toBe(false);
  });
});

it.each(MOBILE_USER_RESULTS)("preserves actual 0957 assistant results: %s", (text) => {
  expect(isMetadataOnlyAssistantMessage({ role: "assistant", text })).toBe(false);
});
