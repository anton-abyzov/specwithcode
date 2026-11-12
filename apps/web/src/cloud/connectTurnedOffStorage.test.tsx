import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  auth: { isSignedIn: true, userId: "user_a" as string | null },
}));
vi.mock("@clerk/react", () => ({ useAuth: () => runtime.auth }));

import {
  CONNECT_TURNED_OFF_STORAGE_KEY,
  connectTurnedOffReadable,
  replaceUnreadableConnectChoices,
} from "./connectOnboarding";
import { useRememberConnectChoice } from "./useRememberConnectChoice";

/** The real store over an in-memory localStorage, so decoding runs as in the app. */
let stored: Map<string, string>;
let readFails = false;

beforeEach(() => {
  stored = new Map();
  readFails = false;
  runtime.auth = { isSignedIn: true, userId: "user_a" };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => {
        if (readFails) throw new Error("storage is blocked");
        return stored.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        // Storage that refuses reads refuses writes too.
        if (readFails) throw new Error("storage is blocked");
        stored.set(key, value);
      },
      removeItem: (key: string) => stored.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function rememberOn(on: boolean) {
  function Harness() {
    useRememberConnectChoice()(on);
    return null;
  }
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => renderer!.unmount());
}

describe("the saved off choices on this device", () => {
  it("are readable when nothing is saved yet, and when a saved list decodes", () => {
    expect(connectTurnedOffReadable()).toBe(true);
    stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, JSON.stringify({ accounts: ["user_a"] }));
    expect(connectTurnedOffReadable()).toBe(true);
  });

  it("are unreadable when the value is not JSON, has another shape, or cannot be read", () => {
    for (const value of ["{not json", "[]", '{"accounts":"user_a"}', '{"accounts":[1]}', "null"]) {
      stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, value);
      expect(connectTurnedOffReadable(), value).toBe(false);
    }
    stored.delete(CONNECT_TURNED_OFF_STORAGE_KEY);
    readFails = true;
    expect(connectTurnedOffReadable()).toBe(false);
  });

  it("are saved and forgotten through the Settings switch", async () => {
    await rememberOn(false);
    expect(JSON.parse(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({
      accounts: ["user_a"],
    });
    await rememberOn(true);
    expect(JSON.parse(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({ accounts: [] });
  });

  it("are left exactly as they are by a read, however unreadable", () => {
    stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, "{not json");
    expect(connectTurnedOffReadable()).toBe(false);
    expect(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)).toBe("{not json");
  });

  it("are replaced by the owner's own choice when they cannot be read, so the device is not stuck", async () => {
    stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, "{not json");
    await rememberOn(false);
    expect(JSON.parse(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({
      accounts: ["user_a"],
    });
    expect(connectTurnedOffReadable()).toBe(true);
    stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, "[]");
    await rememberOn(true);
    expect(JSON.parse(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({ accounts: [] });
  });

  it("replace nothing for a signed-out switch, and nothing when storage cannot be written", async () => {
    stored.set(CONNECT_TURNED_OFF_STORAGE_KEY, "{not json");
    runtime.auth = { isSignedIn: false, userId: null };
    await rememberOn(false);
    expect(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)).toBe("{not json");
    runtime.auth = { isSignedIn: true, userId: "user_a" };
    expect(replaceUnreadableConnectChoices("user_a", false)).toBe(true);
    // Readable values are never replaced wholesale.
    expect(replaceUnreadableConnectChoices("user_b", false)).toBe(false);
    expect(JSON.parse(stored.get(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({
      accounts: ["user_a"],
    });
    readFails = true;
    expect(replaceUnreadableConnectChoices("user_a", true)).toBe(false);
  });
});
