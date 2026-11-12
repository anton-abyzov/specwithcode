// @vitest-environment jsdom
import { beforeEach, expect, it } from "vite-plus/test";

import {
  CONNECT_SIGN_IN_STARTED_KEY,
  CONNECT_SIGN_IN_STARTED_MAX_AGE_MS,
  markConnectSignInStarted,
  readConnectSignInStarted,
  signInDialogFollowsUp,
  takeConnectSignInStarted,
} from "./connectSignInStarted";

beforeEach(() => window.sessionStorage.clear());

it("keeps where a sign-in was started until it is taken", () => {
  markConnectSignInStarted("setup", 1_000);
  expect(readConnectSignInStarted(2_000)).toBe("setup");
  expect(takeConnectSignInStarted(2_000)).toBe("setup");
  expect(takeConnectSignInStarted(2_000)).toBeNull();
});

it("forgets a sign-in that was started long ago", () => {
  markConnectSignInStarted("app", 1_000);
  expect(readConnectSignInStarted(1_000 + CONNECT_SIGN_IN_STARTED_MAX_AGE_MS)).toBe("app");
  expect(readConnectSignInStarted(1_001 + CONNECT_SIGN_IN_STARTED_MAX_AGE_MS)).toBeNull();
});

it("reads nothing from a value it did not write", () => {
  for (const raw of ["", "1", "null", '{"origin":"other","at":1}', '{"origin":"app"}', "{"]) {
    window.sessionStorage.setItem(CONNECT_SIGN_IN_STARTED_KEY, raw);
    expect(readConnectSignInStarted(10), raw).toBeNull();
  }
  // A clock that went backwards says nothing about how old the note is.
  markConnectSignInStarted("app", 5_000);
  expect(readConnectSignInStarted(1_000)).toBeNull();
});

it("follows up a sign-in the dialog saw happen", () => {
  expect(signInDialogFollowsUp({ sawSignedOut: true, started: null })).toBe(true);
  expect(signInDialogFollowsUp({ sawSignedOut: true, started: "app" })).toBe(true);
});

it("follows up a sign-in that reloaded the window, and not a restored session", () => {
  expect(signInDialogFollowsUp({ sawSignedOut: false, started: "app" })).toBe(true);
  expect(signInDialogFollowsUp({ sawSignedOut: false, started: null })).toBe(false);
});

it("leaves a sign-in started in setup to setup", () => {
  expect(signInDialogFollowsUp({ sawSignedOut: true, started: "setup" })).toBe(false);
  expect(signInDialogFollowsUp({ sawSignedOut: false, started: "setup" })).toBe(false);
});
