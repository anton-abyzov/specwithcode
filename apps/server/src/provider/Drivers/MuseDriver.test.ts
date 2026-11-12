import { describe, expect, it } from "@effect/vitest";

import { museGaveNoAnswer } from "./MuseDriver.ts";

describe("museGaveNoAnswer", () => {
  it("is the connection's own two limits", () => {
    expect(museGaveNoAnswer(new Error("Muse Code handshake timed out"))).toBe(true);
    expect(museGaveNoAnswer(new Error("Muse Code control request timed out"))).toBe(true);
  });

  it("is not a launcher line that says something timed out", () => {
    const handshake = new Error("Muse Code handshake timed out");
    expect(museGaveNoAnswer(new Error("error: download timed out", { cause: handshake }))).toBe(
      false,
    );
    expect(museGaveNoAnswer(new Error("connection reached EOF"))).toBe(false);
    expect(museGaveNoAnswer("Muse Code handshake timed out")).toBe(false);
    expect(museGaveNoAnswer(undefined)).toBe(false);
  });
});
