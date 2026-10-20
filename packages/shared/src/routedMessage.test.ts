import { describe, expect, it } from "vite-plus/test";
import { parseRoutedMessage, routedMessageText } from "./routedMessage.ts";

describe("routed messages", () => {
  const origin = { assistantTitle: "Aide", threadId: "project-coordinator:aide", messageId: "m:1" };

  it("round-trips the user's words unchanged", () => {
    const words = 'Audit EasyChamp\'s signup flow.\n\nKeep the "beta" label.';
    const parsed = parseRoutedMessage(routedMessageText(origin, words));
    expect(parsed).toEqual({ ...origin, words });
  });

  it("keeps the assistant's note on one bounded line", () => {
    const parsed = parseRoutedMessage(
      routedMessageText({ ...origin, note: "Only the\nEasyChamp part.  " }, "Do both"),
    );
    expect(parsed?.note).toBe("Only the EasyChamp part.");
    expect(parsed?.words).toBe("Do both");
    const long = parseRoutedMessage(routedMessageText({ ...origin, note: "x".repeat(900) }, "w"));
    expect(long?.note?.length).toBe(500);
  });

  it("cannot be broken by quotes in the assistant's name", () => {
    const parsed = parseRoutedMessage(
      routedMessageText({ ...origin, assistantTitle: 'My "Aide"' }, "w"),
    );
    expect(parsed?.assistantTitle).toBe("My 'Aide'");
  });

  it("ignores text without the header, including a user quoting it mid-message", () => {
    expect(parseRoutedMessage("Just do it")).toBeNull();
    expect(parseRoutedMessage(`Look: ${routedMessageText(origin, "nested")}`)).toBeNull();
  });
});
