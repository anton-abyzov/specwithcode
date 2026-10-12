import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => ({ seen: [] as unknown[], matches: false }));
vi.mock("./useMediaQuery", () => ({
  useMediaQuery: (query: unknown) => {
    queries.seen.push(query);
    return queries.matches;
  },
}));

import { PHONE_KEYBOARD_QUERY, usePhoneKeyboard } from "./usePhoneKeyboard";

afterEach(() => {
  queries.seen = [];
  queries.matches = false;
});

describe("usePhoneKeyboard", () => {
  it("asks for a touch pointer that cannot hover, at any width", () => {
    expect(usePhoneKeyboard()).toBe(false);
    expect(queries.seen).toEqual(["(pointer: coarse) and (hover: none)"]);
    expect(PHONE_KEYBOARD_QUERY).not.toMatch(/width/);
    queries.matches = true;
    expect(usePhoneKeyboard()).toBe(true);
  });
});
