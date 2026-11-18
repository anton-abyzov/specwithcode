// @effect-diagnostics nodeBuiltinImport:off -- drives the plain relay hub with a fake extension socket.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  BROWSER_EXTENSION_STORE_ID,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  ServerSettingsError,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterAll, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

import {
  BrowserExtension,
  BROWSER_EXTENSION_STORE_ORIGIN,
  layer as browserExtensionLayer,
  makeBrowserExtension,
  relayOriginExtensionId,
  relayRequestAllowed,
} from "./BrowserExtension.ts";
import { BROWSER_EXTENSION_DIR, isPaired, PAIRING_FILE } from "./pairingState.ts";
import { CLOSE_NOT_ALLOWED, CLOSE_REJECTED } from "./relayHub.ts";

const HAND_LOADED_ID = "abcdefghijklmnopabcdefghijklmnop";
const HAND_LOADED_ORIGIN = `chrome-extension://${HAND_LOADED_ID}`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function tempStateDir() {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-relay-origin-"));
  dirs.push(stateDir);
  return stateDir;
}

function readToken(extension: ReturnType<typeof makeBrowserExtension>): string {
  const code = extension.pairing(false).pairingCode;
  return JSON.parse(Buffer.from(code.split(":")[2]!, "base64url").toString("utf8")).t;
}

function setup(allowHandLoaded?: () => boolean) {
  const stateDir = tempStateDir();
  const extension = makeBrowserExtension({
    stateDir,
    port: 8319,
    machineName: "mac",
    ...(allowHandLoaded === undefined ? {} : { allowHandLoaded }),
  });
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
      { code: CLOSE_NOT_ALLOWED, reason: "hand-loaded extension not allowed" },
    ]);
    expect(store.closed).toEqual([]);
    expect(extension.status().profiles.map((profile) => profile.label)).toEqual(["Store"]);
  });
});

describe("the developer switch at hello", () => {
  it("refuses a hand-loaded id while off, before the token, even after the socket opened", () => {
    let allow = true;
    const { extension, token, paired } = setup(() => allow);
    // The route admitted it while the switch was on; the switch went off before its hello.
    const closed: Array<{ code: number; reason: string }> = [];
    const session = extension.hub.open(
      { send: () => {}, close: (code, reason) => closed.push({ code, reason }) },
      { extensionId: HAND_LOADED_ID },
    );
    allow = false;
    session.receive(
      JSON.stringify({
        method: "hello",
        params: { protocol: 1, token, label: "Hand", extensionId: BROWSER_EXTENSION_STORE_ID },
      }),
    );
    expect(closed).toEqual([{ code: CLOSE_NOT_ALLOWED, reason: "extension not allowed" }]);
    expect(paired()).toBe(false);
    // The store copy is never affected by the switch.
    expect(connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token }).closed).toEqual(
      [],
    );
    allow = true;
    expect(connect(extension, { origin: HAND_LOADED_ORIGIN, token, label: "Hand" }).closed).toEqual(
      [],
    );
  });
});

/** The real layer with a settings double whose reads can fail and whose changes the test publishes. */
async function withLayer(
  initial: boolean | "unreadable",
  body: (input: {
    extension: ReturnType<typeof makeBrowserExtension>;
    publish: (allow: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const stateDir = tempStateDir();
  const settingsOf = (allow: boolean): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    allowHandLoadedBrowserExtension: allow,
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<ServerSettings>();
        const settingsDouble = {
          getSettings:
            initial === "unreadable"
              ? Effect.fail(
                  new ServerSettingsError({ settingsPath: "test", operation: "normalize" }),
                )
              : Effect.succeed(settingsOf(initial)),
          subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
        } as unknown as ServerSettingsModule.ServerSettingsService["Service"];
        const deps = Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir,
            port: 8319,
          } as unknown as ServerConfig.ServerConfig["Service"]),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getDescriptor: Effect.succeed({ label: "mac" }),
          } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
          Layer.succeed(ServerSettingsModule.ServerSettingsService, settingsDouble),
        );
        const context = yield* Layer.build(browserExtensionLayer.pipe(Layer.provide(deps)));
        const extension = Context.get(context, BrowserExtension) as ReturnType<
          typeof makeBrowserExtension
        >;
        const publish = async (allow: boolean) => {
          Queue.offerUnsafe(changes, settingsOf(allow));
          // Let the layer's change fiber take the update.
          for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
        };
        yield* Effect.promise(() => body({ extension, publish }));
      }),
    ),
  );
}

describe("the layer wires the switch from settings", () => {
  it("keeps hand-loaded copies out when settings cannot be read", async () => {
    await withLayer("unreadable", async ({ extension }) => {
      const token = readToken(extension);
      expect(connect(extension, { origin: HAND_LOADED_ORIGIN, token }).closed).toEqual([
        { code: CLOSE_NOT_ALLOWED, reason: "extension not allowed" },
      ]);
      expect(connect(extension, { origin: BROWSER_EXTENSION_STORE_ORIGIN, token }).closed).toEqual(
        [],
      );
    });
  });

  it("admits a hand-loaded copy while on and closes it when the switch goes off", async () => {
    await withLayer(true, async ({ extension, publish }) => {
      const token = readToken(extension);
      const hand = connect(extension, { origin: HAND_LOADED_ORIGIN, token, label: "Hand" });
      const store = connect(extension, {
        origin: BROWSER_EXTENSION_STORE_ORIGIN,
        token,
        label: "Store",
      });
      expect(hand.closed).toEqual([]);
      await publish(false);
      expect(hand.closed).toEqual([
        { code: CLOSE_NOT_ALLOWED, reason: "hand-loaded extension not allowed" },
      ]);
      expect(store.closed).toEqual([]);
      expect(connect(extension, { origin: HAND_LOADED_ORIGIN, token }).closed).toEqual([
        { code: CLOSE_NOT_ALLOWED, reason: "extension not allowed" },
      ]);
      await publish(true);
      expect(
        connect(extension, { origin: HAND_LOADED_ORIGIN, token, label: "Again" }).closed,
      ).toEqual([]);
    });
  });
});
