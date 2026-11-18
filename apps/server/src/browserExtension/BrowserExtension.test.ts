// @effect-diagnostics nodeBuiltinImport:off -- drives the plain relay hub with a fake extension socket.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { BROWSER_EXTENSION_STORE_ID } from "@specweave-studio/contracts";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  BROWSER_EXTENSION_STORE_ORIGIN,
  makeBrowserExtension,
  relayOriginExtensionId,
  relayRequestAllowed,
} from "./BrowserExtension.ts";
import { BROWSER_EXTENSION_DIR, isPaired, PAIRING_FILE } from "./pairingState.ts";
import { CLOSE_REJECTED } from "./relayHub.ts";

const HAND_LOADED_ID = "abcdefghijklmnopabcdefghijklmnop";
const HAND_LOADED_ORIGIN = `chrome-extension://${HAND_LOADED_ID}`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-relay-origin-"));
  dirs.push(stateDir);
  const extension = makeBrowserExtension({ stateDir, port: 8319, machineName: "mac" });
  const code = extension.pairing(false).pairingCode;
  const json = JSON.parse(Buffer.from(code.split(":")[2]!, "base64url").toString("utf8"));
  const paired = () =>
    isPaired(
      NodeFS.readFileSync(NodePath.join(stateDir, BROWSER_EXTENSION_DIR, PAIRING_FILE), "utf8"),
    );
  return { extension, token: json.t as string, paired };
}

/** What the route does after `relayRequestAllowed`: open a socket bound to the Origin's id. */
function connect(
  extension: ReturnType<typeof makeBrowserExtension>,
  input: { origin: string; token?: string; claimedId?: string; label?: string },
) {
  const closed: Array<{ code: number; reason: string }> = [];
  const session = extension.hub.open(
    { send: () => {}, close: (code, reason) => closed.push({ code, reason }) },
    { extensionId: relayOriginExtensionId(input.origin) ?? "" },
  );
  session.receive(
    JSON.stringify({
      method: "hello",
      params: {
        protocol: 1,
        ...(input.token === undefined ? {} : { token: input.token }),
        label: input.label ?? "Work",
        extensionVersion: "1.0.0",
        extensionId: input.claimedId ?? relayOriginExtensionId(input.origin) ?? "",
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      },
    }),
  );
  return { closed, session };
}

describe("relayRequestAllowed: only the Chrome Web Store copy", () => {
  const store = { remoteAddress: "127.0.0.1", origin: BROWSER_EXTENSION_STORE_ORIGIN, headers: {} };

  it("accepts exactly the store origin from loopback", () => {
    expect(BROWSER_EXTENSION_STORE_ORIGIN).toBe(
      "chrome-extension://okoinngelinfjfkmkcnbgndapeiofgbb",
    );
    expect(relayRequestAllowed(store)).toBe(true);
    expect(relayRequestAllowed({ ...store, remoteAddress: "::1" })).toBe(true);
  });

  it("refuses another extension's origin", () => {
    expect(relayRequestAllowed({ ...store, origin: HAND_LOADED_ORIGIN })).toBe(false);
    expect(
      relayRequestAllowed({
        ...store,
        origin: "chrome-extension://pppppppppppppppppppppppppppppppp",
      }),
    ).toBe(false);
  });

  it("refuses the prefix alone and near misses of the store origin", () => {
    for (const origin of [
      "chrome-extension://",
      "chrome-extension://okoinngelinfjfkmkcnbgndapeiofgb",
      `${BROWSER_EXTENSION_STORE_ORIGIN}x`,
      `${BROWSER_EXTENSION_STORE_ORIGIN}/`,
      ` ${BROWSER_EXTENSION_STORE_ORIGIN}`,
      BROWSER_EXTENSION_STORE_ORIGIN.toUpperCase(),
      `moz-extension://${BROWSER_EXTENSION_STORE_ID}`,
      `https://${BROWSER_EXTENSION_STORE_ID}`,
    ])
      expect(relayRequestAllowed({ ...store, origin }), origin).toBe(false);
  });

  it("refuses web pages, other machines and proxies even for the store origin", () => {
    expect(relayRequestAllowed({ ...store, origin: "https://evil.example" })).toBe(false);
    expect(relayRequestAllowed({ ...store, origin: undefined })).toBe(false);
    expect(relayRequestAllowed({ ...store, remoteAddress: "192.168.1.5" })).toBe(false);
    expect(relayRequestAllowed({ ...store, remoteAddress: undefined })).toBe(false);
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip"])
      expect(relayRequestAllowed({ ...store, headers: { [header]: "1.2.3.4" } })).toBe(false);
  });

  it("the developer switch admits a hand-loaded id, and nothing else", () => {
    const hand = { ...store, origin: HAND_LOADED_ORIGIN };
    expect(relayRequestAllowed({ ...hand, allowHandLoaded: false })).toBe(false);
    expect(relayRequestAllowed({ ...hand, allowHandLoaded: true })).toBe(true);
    expect(relayRequestAllowed({ ...store, allowHandLoaded: true })).toBe(true);
    for (const origin of ["chrome-extension://", "chrome-extension://abc", "https://evil.example"])
      expect(relayRequestAllowed({ ...store, origin, allowHandLoaded: true }), origin).toBe(false);
    expect(
      relayRequestAllowed({ ...hand, allowHandLoaded: true, remoteAddress: "192.168.1.5" }),
    ).toBe(false);
    expect(
      relayRequestAllowed({
        ...hand,
        allowHandLoaded: true,
        headers: { forwarded: "for=1.2.3.4" },
      }),
    ).toBe(false);
  });
});

describe("the pairing token stays the only authentication", () => {
  it("refuses the store origin with a missing or wrong token when pairing", () => {
    const { extension, paired } = setup();
    for (const token of [undefined, "", "x".repeat(43)]) {
      const fake = connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token });
      expect(fake.closed, String(token)).toEqual([
        { code: CLOSE_REJECTED, reason: "pairing code rejected" },
      ]);
    }
    expect(extension.hub.profiles()).toEqual([]);
    expect(paired()).toBe(false);
  });

  it("refuses the store origin with a missing or wrong token when connecting", () => {
    const { extension, token, paired } = setup();
    const good = connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token });
    expect(good.closed).toEqual([]);
    expect(paired()).toBe(true);
    for (const presented of [undefined, "", `${token}x`, token.slice(1)]) {
      const fake = connect(extension, {
        origin: BROWSER_EXTENSION_STORE_ORIGIN,
        token: presented,
        label: "Other",
      });
      expect(fake.closed, String(presented)).toEqual([
        { code: CLOSE_REJECTED, reason: "pairing code rejected" },
      ]);
    }
    // The paired profile is untouched and still the only one.
    expect(good.closed).toEqual([]);
    expect(extension.hub.profiles().map((profile) => profile.label)).toEqual(["Work"]);
    // After a reset the old token no longer connects either.
    extension.pairing(true);
    const stale = connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token });
    expect(stale.closed).toEqual([{ code: CLOSE_REJECTED, reason: "pairing code rejected" }]);
  });
});

describe("from the Chrome Web Store", () => {
  it("is decided by the Origin's id, not the id the hello claims", () => {
    const { extension, token } = setup();
    connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token, label: "Store" });
    connect(extension, {
      origin: HAND_LOADED_ORIGIN,
      token,
      claimedId: BROWSER_EXTENSION_STORE_ID,
      label: "Hand",
    });
    const byLabel = Object.fromEntries(
      extension.status().profiles.map((profile) => [profile.label, profile.fromStore]),
    );
    expect(byLabel).toEqual({ Store: true, Hand: false });
  });

  it("closes hand-loaded copies when the switch goes off and keeps the store copy", () => {
    const { extension, token } = setup();
    const store = connect(extension, {
      origin: BROWSER_EXTENSION_STORE_ORIGIN,
      token,
      label: "Store",
    });
    const hand = connect(extension, { origin: HAND_LOADED_ORIGIN, token, label: "Hand" });
    extension.hub.disconnectExtensions(
      (extensionId) => extensionId === BROWSER_EXTENSION_STORE_ID,
      "hand-loaded extension not allowed",
    );
    expect(hand.closed).toEqual([
      { code: CLOSE_REJECTED, reason: "hand-loaded extension not allowed" },
    ]);
    expect(store.closed).toEqual([]);
    expect(extension.status().profiles.map((profile) => profile.label)).toEqual(["Store"]);
  });
});
