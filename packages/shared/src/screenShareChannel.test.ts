import { describe, expect, it } from "vite-plus/test";

import { computeDpopJwkThumbprint, verifyDpopProof, type DpopPublicJwk } from "./dpop.ts";
import {
  acceptScreenShareProof,
  answerScreenShareChallenge,
  fromBase64Url,
  makeScreenShareKnock,
  makeScreenShareOpener,
  makeScreenShareSealer,
  newScreenShareMachineKey,
  SCREEN_SHARE_KNOCK_TYP,
  SCREEN_SHARE_PROOF_MAX_SKEW_SECONDS,
  SCREEN_SHARE_PROOF_TYP,
  screenShareKnockHolds,
  screenShareCodeMatches,
  ScreenShareHandshakeError,
  startScreenShareTarget,
  startScreenShareViewer,
  toBase64Url,
} from "./screenShareChannel.ts";

const ENV = "env-target";
const SID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const NOW = 1_795_000_000;

async function device() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! } as DpopPublicJwk;
  const sign = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data),
    );
  return { jwk, thumbprint: computeDpopJwkThumbprint(jwk), sign };
}

async function handshake(options?: {
  readonly knowsMachine?: boolean;
  readonly alterChallenge?: (challenge: Record<string, unknown>) => Record<string, unknown>;
  readonly alterHello?: (hello: Record<string, unknown>) => Record<string, unknown>;
  readonly viewerSessionId?: string;
  readonly viewerEnvironmentId?: string;
}) {
  const viewerDevice = await device();
  const machineKey = newScreenShareMachineKey();
  const knowsMachine = options?.knowsMachine ?? true;
  const viewer = startScreenShareViewer({
    mode: "view",
    deviceJwk: viewerDevice.jwk,
    knowsMachine,
  });
  const helloOnWire = JSON.parse(JSON.stringify(viewer.hello)) as Record<string, unknown>;
  const target = startScreenShareTarget({
    hello: options?.alterHello ? options.alterHello(helloOnWire) : helloOnWire,
    environmentId: ENV,
    sessionId: SID,
    attestedThumbprint: viewerDevice.thumbprint,
    machineKey,
  });
  const challengeOnWire = JSON.parse(JSON.stringify(target.challenge)) as Record<string, unknown>;
  const answer = await answerScreenShareChallenge({
    start: viewer,
    challenge: options?.alterChallenge ? options.alterChallenge(challengeOnWire) : challengeOnWire,
    environmentId: options?.viewerEnvironmentId ?? ENV,
    sessionId: options?.viewerSessionId ?? SID,
    pinnedMachineKey: knowsMachine ? machineKey.publicKey : undefined,
    nowEpochSeconds: NOW,
    sign: viewerDevice.sign,
  });
  return { viewerDevice, machineKey, viewer, target, answer };
}

const reason = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ScreenShareHandshakeError) return error.reason;
    throw error;
  }
  return "accepted";
};

describe("screen share handshake", () => {
  it("gives both sides the same keys and the same code", async () => {
    const { target, answer } = await handshake();
    const { keys, code } = acceptScreenShareProof({
      start: target,
      proof: answer.proof,
      environmentId: ENV,
      sessionId: SID,
      nowEpochSeconds: NOW + 2,
    });
    expect(toBase64Url(keys.toViewer)).toBe(toBase64Url(answer.keys.toViewer));
    expect(toBase64Url(keys.toTarget)).toBe(toBase64Url(answer.keys.toTarget));
    expect(toBase64Url(keys.toViewer)).not.toBe(toBase64Url(keys.toTarget));
    expect(code).toBe(answer.code);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("gives every session its own code, even between the same two keys", async () => {
    const mine = await device();
    const machineKey = newScreenShareMachineKey();
    const codes = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const viewer = startScreenShareViewer({
        mode: "view",
        deviceJwk: mine.jwk,
        knowsMachine: false,
      });
      const target = startScreenShareTarget({
        hello: viewer.hello,
        environmentId: ENV,
        sessionId: SID,
        attestedThumbprint: mine.thumbprint,
        machineKey,
      });
      const answer = await answerScreenShareChallenge({
        start: viewer,
        challenge: target.challenge,
        environmentId: ENV,
        sessionId: SID,
        pinnedMachineKey: undefined,
        nowEpochSeconds: NOW,
        sign: mine.sign,
      });
      codes.add(answer.code);
    }
    // Six draws from a million: a repeat here means the code is not per session.
    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it("the code depends on the value the viewer revealed only in its signed proof", async () => {
    const { target, answer, viewer } = await handshake({ knowsMachine: false });
    // The hello and the challenge are public on the wire; the reveal is not in either.
    const onWire = JSON.stringify([viewer.hello, target.challenge]);
    expect(onWire).not.toContain(toBase64Url(viewer.reveal));
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(answer.proof.jws.split(".")[1]!)),
    ) as { r: string };
    expect(payload.r).toBe(toBase64Url(viewer.reveal));
  });

  it("the machine refuses a proof whose revealed value is not the one the hello committed to", async () => {
    const viewerDevice = await device();
    const machineKey = newScreenShareMachineKey();
    const viewer = startScreenShareViewer({
      mode: "view",
      deviceJwk: viewerDevice.jwk,
      knowsMachine: false,
    });
    const target = startScreenShareTarget({
      hello: viewer.hello,
      environmentId: ENV,
      sessionId: SID,
      attestedThumbprint: viewerDevice.thumbprint,
      machineKey,
    });
    // The same device signs a proof for the same transcript with another value.
    const answer = await answerScreenShareChallenge({
      start: { ...viewer, reveal: crypto.getRandomValues(new Uint8Array(32)) },
      challenge: target.challenge,
      environmentId: ENV,
      sessionId: SID,
      pinnedMachineKey: undefined,
      nowEpochSeconds: NOW,
      sign: viewerDevice.sign,
    });
    expect(
      await reason(() =>
        acceptScreenShareProof({
          start: target,
          proof: answer.proof,
          environmentId: ENV,
          sessionId: SID,
          nowEpochSeconds: NOW,
        }),
      ),
    ).toBe("commit_mismatch");
  });

  it("a hello with no commitment, or a changed one, never yields a session", async () => {
    expect(
      await reason(() =>
        handshake({
          alterHello: (h) => {
            const { commit: _commit, ...rest } = h;
            return rest;
          },
        }),
      ),
    ).toBe("malformed");
    const swapped = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(await reason(() => handshake({ alterHello: (h) => ({ ...h, commit: swapped }) }))).toBe(
      "machine_signature",
    );
  });

  it("matches a typed code with spaces and refuses anything else", () => {
    expect(screenShareCodeMatches("482 913", "482913")).toBe(true);
    expect(screenShareCodeMatches(" 482913 ", "482913")).toBe(true);
    expect(screenShareCodeMatches("482914", "482913")).toBe(false);
    expect(screenShareCodeMatches("48291", "482913")).toBe(false);
    expect(screenShareCodeMatches("", "482913")).toBe(false);
  });

  it("refuses a hello that names another device key than the server attested", async () => {
    const other = await device();
    const mine = await device();
    const viewer = startScreenShareViewer({
      mode: "view",
      deviceJwk: other.jwk,
      knowsMachine: true,
    });
    expect(
      await reason(() =>
        startScreenShareTarget({
          hello: viewer.hello,
          environmentId: ENV,
          sessionId: SID,
          attestedThumbprint: mine.thumbprint,
          machineKey: newScreenShareMachineKey(),
        }),
      ),
    ).toBe("device_key_mismatch");
  });

  it("refuses a mode this build does not have", async () => {
    const mine = await device();
    const viewer = startScreenShareViewer({
      mode: "view",
      deviceJwk: mine.jwk,
      knowsMachine: true,
    });
    expect(
      await reason(() =>
        startScreenShareTarget({
          hello: { ...viewer.hello, mode: "control" },
          environmentId: ENV,
          sessionId: SID,
          attestedThumbprint: mine.thumbprint,
          machineKey: newScreenShareMachineKey(),
        }),
      ),
    ).toBe("unsupported_mode");
  });

  it("the viewer refuses a machine key other than the one it saved", async () => {
    const stranger = newScreenShareMachineKey();
    expect(
      await reason(() =>
        handshake({ alterChallenge: (c) => ({ ...c, machineKey: stranger.publicKey }) }),
      ),
    ).toBe("machine_key_changed");
  });

  it("the viewer refuses a challenge whose session key was swapped on the way", async () => {
    const swapped = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(
      await reason(() => handshake({ alterChallenge: (c) => ({ ...c, targetKey: swapped }) })),
    ).toBe("machine_signature");
    expect(
      await reason(() => handshake({ alterChallenge: (c) => ({ ...c, nonce: swapped }) })),
    ).toBe("machine_signature");
  });

  it("the viewer refuses a challenge made for another session or machine", async () => {
    expect(await reason(() => handshake({ viewerSessionId: "another-session" }))).toBe(
      "machine_signature",
    );
    expect(await reason(() => handshake({ viewerEnvironmentId: "env-other" }))).toBe(
      "machine_signature",
    );
  });

  it("a hello changed on the way never yields a session", async () => {
    const swapped = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    // The machine signs what it saw, so the viewer's check of that signature fails.
    expect(
      await reason(() => handshake({ alterHello: (h) => ({ ...h, viewerKey: swapped }) })),
    ).toBe("machine_signature");
    expect(
      await reason(() =>
        handshake({ knowsMachine: true, alterHello: (h) => ({ ...h, knowsMachine: false }) }),
      ),
    ).toBe("machine_signature");
  });

  it("the machine refuses a proof signed by another key", async () => {
    const { target, answer } = await handshake();
    const thief = await device();
    const [header, payload] = answer.proof.jws.split(".") as [string, string, string];
    const forged = toBase64Url(
      await thief.sign(new TextEncoder().encode(`${header}.${payload}`) as Uint8Array<ArrayBuffer>),
    );
    expect(
      await reason(() =>
        acceptScreenShareProof({
          start: target,
          proof: { jws: `${header}.${payload}.${forged}` },
          environmentId: ENV,
          sessionId: SID,
          nowEpochSeconds: NOW,
        }),
      ),
    ).toBe("device_signature");
  });

  it("the machine refuses a proof that carries another key in its header", async () => {
    const { target, answer } = await handshake();
    const thief = await device();
    const [, payload] = answer.proof.jws.split(".") as [string, string, string];
    const header = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ typ: SCREEN_SHARE_PROOF_TYP, alg: "ES256", jwk: thief.jwk }),
      ),
    );
    const signature = toBase64Url(
      await thief.sign(new TextEncoder().encode(`${header}.${payload}`) as Uint8Array<ArrayBuffer>),
    );
    expect(
      await reason(() =>
        acceptScreenShareProof({
          start: target,
          proof: { jws: `${header}.${payload}.${signature}` },
          environmentId: ENV,
          sessionId: SID,
          nowEpochSeconds: NOW,
        }),
      ),
    ).toBe("device_key_mismatch");
  });

  it("the machine refuses a proof from another handshake of the same device", async () => {
    const mine = await device();
    const machineKey = newScreenShareMachineKey();
    const open = () => {
      const viewer = startScreenShareViewer({
        mode: "view",
        deviceJwk: mine.jwk,
        knowsMachine: true,
      });
      const target = startScreenShareTarget({
        hello: viewer.hello,
        environmentId: ENV,
        sessionId: SID,
        attestedThumbprint: mine.thumbprint,
        machineKey,
      });
      return { viewer, target };
    };
    const first = open();
    const second = open();
    const answer = await answerScreenShareChallenge({
      start: first.viewer,
      challenge: first.target.challenge,
      environmentId: ENV,
      sessionId: SID,
      pinnedMachineKey: machineKey.publicKey,
      nowEpochSeconds: NOW,
      sign: mine.sign,
    });
    expect(
      await reason(() =>
        acceptScreenShareProof({
          start: second.target,
          proof: answer.proof,
          environmentId: ENV,
          sessionId: SID,
          nowEpochSeconds: NOW,
        }),
      ),
    ).toBe("transcript_mismatch");
  });

  it("the machine refuses a proof that is too old or from the future", async () => {
    const { target, answer } = await handshake();
    for (const now of [NOW + 61, NOW - 61])
      expect(
        await reason(() =>
          acceptScreenShareProof({
            start: target,
            proof: answer.proof,
            environmentId: ENV,
            sessionId: SID,
            nowEpochSeconds: now,
          }),
        ),
      ).toBe("stale_proof");
  });

  it("a viewer with no saved key says so, and a viewer cannot claim one it lacks", async () => {
    const fresh = await handshake({ knowsMachine: false });
    expect(fresh.target.hello.knowsMachine).toBe(false);
    const mine = await device();
    const viewer = startScreenShareViewer({
      mode: "view",
      deviceJwk: mine.jwk,
      knowsMachine: true,
    });
    const target = startScreenShareTarget({
      hello: viewer.hello,
      environmentId: ENV,
      sessionId: SID,
      attestedThumbprint: mine.thumbprint,
      machineKey: newScreenShareMachineKey(),
    });
    expect(
      await reason(() =>
        answerScreenShareChallenge({
          start: viewer,
          challenge: target.challenge,
          environmentId: ENV,
          sessionId: SID,
          pinnedMachineKey: undefined,
          nowEpochSeconds: NOW,
          sign: mine.sign,
        }),
      ),
    ).toBe("malformed");
  });

  it("is not a DPoP proof, and a DPoP proof is not a session proof", async () => {
    const { target, answer, viewerDevice } = await handshake();
    expect(
      verifyDpopProof({
        proof: answer.proof.jws,
        method: "POST",
        url: "https://machine.example/api/auth/websocket-ticket",
        nowEpochSeconds: NOW,
      }).ok,
    ).toBe(false);

    const header = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: viewerDevice.jwk }),
      ),
    );
    const payload = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          htm: "POST",
          htu: "https://machine.example/api/auth/websocket-ticket",
          jti: "j1",
          iat: NOW,
          // Even with every session field copied in, the type refuses it.
          aud: ENV,
          sid: SID,
          mode: "view",
          th: toBase64Url(target.transcriptHash),
        }),
      ),
    );
    const signature = toBase64Url(
      await viewerDevice.sign(
        new TextEncoder().encode(`${header}.${payload}`) as Uint8Array<ArrayBuffer>,
      ),
    );
    const dpop = `${header}.${payload}.${signature}`;
    expect(
      verifyDpopProof({
        proof: dpop,
        method: "POST",
        url: "https://machine.example/api/auth/websocket-ticket",
        nowEpochSeconds: NOW,
      }).ok,
    ).toBe(true);
    expect(
      await reason(() =>
        acceptScreenShareProof({
          start: target,
          proof: { jws: dpop },
          environmentId: ENV,
          sessionId: SID,
          nowEpochSeconds: NOW,
        }),
      ),
    ).toBe("malformed");
  });
});

describe("the knock", () => {
  const NONCE = "b3f1c2d4e5a697887766554433221100";

  it("holds for the device's own key, this nonce, this machine and this moment, and for nothing else", async () => {
    const mine = await device();
    const other = await device();
    const jws = await makeScreenShareKnock({
      deviceJwk: mine.jwk,
      environmentId: ENV,
      nonce: NONCE,
      nowEpochSeconds: NOW,
      sign: mine.sign,
    });
    const asked = {
      jws,
      environmentId: ENV,
      nonce: NONCE,
      thumbprint: mine.thumbprint,
      nowEpochSeconds: NOW,
    };
    expect(screenShareKnockHolds(asked)).toBe(true);
    expect(screenShareKnockHolds({ ...asked, nonce: `${NONCE}0` })).toBe(false);
    expect(screenShareKnockHolds({ ...asked, environmentId: "env-other" })).toBe(false);
    expect(screenShareKnockHolds({ ...asked, thumbprint: other.thumbprint })).toBe(false);
    expect(
      screenShareKnockHolds({
        ...asked,
        nowEpochSeconds: NOW + SCREEN_SHARE_PROOF_MAX_SKEW_SECONDS + 1,
      }),
    ).toBe(false);
    // One changed character anywhere, and nothing that is not three parts.
    const [header, payload, signature] = jws.split(".") as [string, string, string];
    const flipped = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
    expect(screenShareKnockHolds({ ...asked, jws: `${header}.${payload}.${flipped}` })).toBe(false);
    for (const bad of ["", "a.b", `${header}.${payload}`, `${jws}.x`, "not a knock at all"])
      expect(screenShareKnockHolds({ ...asked, jws: bad })).toBe(false);
  });

  it("signed by another key under the device's name does not hold", async () => {
    const mine = await device();
    const thief = await device();
    // The thief's signature with the real device's public key in the header.
    const forged = await makeScreenShareKnock({
      deviceJwk: mine.jwk,
      environmentId: ENV,
      nonce: NONCE,
      nowEpochSeconds: NOW,
      sign: thief.sign,
    });
    // The thief's own key, signed properly, against the real device's sign-in.
    const own = await makeScreenShareKnock({
      deviceJwk: thief.jwk,
      environmentId: ENV,
      nonce: NONCE,
      nowEpochSeconds: NOW,
      sign: thief.sign,
    });
    for (const jws of [forged, own])
      expect(
        screenShareKnockHolds({
          jws,
          environmentId: ENV,
          nonce: NONCE,
          thumbprint: mine.thumbprint,
          nowEpochSeconds: NOW,
        }),
      ).toBe(false);
  });

  it("is not a session proof, and a session proof is not a knock", async () => {
    const { viewerDevice, target, answer } = await handshake();
    expect(
      screenShareKnockHolds({
        jws: answer.proof.jws,
        environmentId: ENV,
        nonce: NONCE,
        thumbprint: viewerDevice.thumbprint,
        nowEpochSeconds: NOW,
      }),
    ).toBe(false);
    const knock = await makeScreenShareKnock({
      deviceJwk: viewerDevice.jwk,
      environmentId: ENV,
      nonce: NONCE,
      nowEpochSeconds: NOW,
      sign: viewerDevice.sign,
    });
    expect(() =>
      acceptScreenShareProof({
        start: target,
        proof: { jws: knock },
        environmentId: ENV,
        sessionId: SID,
        nowEpochSeconds: NOW,
      }),
    ).toThrow();
    // Nor a DPoP proof for the server's own sign-in: its type says what it is.
    const header = JSON.parse(
      new TextDecoder().decode(fromBase64Url(knock.split(".")[0]!)),
    ) as Record<string, unknown>;
    expect(header.typ).toBe(SCREEN_SHARE_KNOCK_TYP);
    expect(SCREEN_SHARE_KNOCK_TYP).not.toBe(SCREEN_SHARE_PROOF_TYP);
    expect(header.typ).not.toBe("dpop+jwt");
  });

  it("signs nothing that is not shaped like a server's nonce", async () => {
    const mine = await device();
    for (const nonce of [
      "",
      "short",
      "has spaces in it, and is long",
      `${"a".repeat(65)}`,
      '{"aud":"x"}',
    ])
      await expect(
        makeScreenShareKnock({
          deviceJwk: mine.jwk,
          environmentId: ENV,
          nonce,
          nowEpochSeconds: NOW,
          sign: mine.sign,
        }),
      ).rejects.toThrow();
  });
});

describe("screen share records", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("opens what was sealed, in order", async () => {
    const sealer = makeScreenShareSealer(key, SID);
    const opener = makeScreenShareOpener(key, SID);
    const [a, b] = await Promise.all([sealer.seal(2, bytes("one")), sealer.seal(3, bytes("two"))]);
    expect(await opener.open(a!)).toEqual({ type: 2, data: bytes("one") });
    expect(await opener.open(b!)).toEqual({ type: 3, data: bytes("two") });
  });

  it("never shows the plaintext in the record", async () => {
    const sealed = await makeScreenShareSealer(key, SID).seal(2, bytes("a frame of the screen"));
    expect(Buffer.from(sealed).includes(Buffer.from("a frame of the screen"))).toBe(false);
  });

  it("refuses a flipped bit, and everything after it", async () => {
    const sealer = makeScreenShareSealer(key, SID);
    const opener = makeScreenShareOpener(key, SID);
    const first = await sealer.seal(2, bytes("one"));
    const second = await sealer.seal(2, bytes("two"));
    const flipped = new Uint8Array(first);
    flipped[flipped.length - 1]! ^= 1;
    await expect(opener.open(flipped)).rejects.toThrow("did not open");
    await expect(opener.open(first)).rejects.toThrow("already failed");
    await expect(opener.open(second)).rejects.toThrow("already failed");
  });

  it("refuses a changed type", async () => {
    const sealed = await makeScreenShareSealer(key, SID).seal(2, bytes("one"));
    const retyped = new Uint8Array(sealed);
    retyped[0] = 16;
    await expect(makeScreenShareOpener(key, SID).open(retyped)).rejects.toThrow("did not open");
  });

  it("refuses a replayed record", async () => {
    const sealer = makeScreenShareSealer(key, SID);
    const opener = makeScreenShareOpener(key, SID);
    const first = await sealer.seal(2, bytes("one"));
    await opener.open(first);
    await expect(opener.open(first)).rejects.toThrow("out of order");
  });

  it("refuses two records swapped, and a skipped one", async () => {
    const sealer = makeScreenShareSealer(key, SID);
    const first = await sealer.seal(2, bytes("one"));
    const second = await sealer.seal(2, bytes("two"));
    await expect(makeScreenShareOpener(key, SID).open(second)).rejects.toThrow("out of order");
    void first;
  });

  it("refuses a record from another session or the other direction", async () => {
    const sealed = await makeScreenShareSealer(key, SID).seal(2, bytes("one"));
    await expect(makeScreenShareOpener(key, "another-session").open(sealed)).rejects.toThrow(
      "did not open",
    );
    const other = crypto.getRandomValues(new Uint8Array(32));
    await expect(makeScreenShareOpener(other, SID).open(sealed)).rejects.toThrow("did not open");
  });

  it("refuses a record that is too short", async () => {
    await expect(makeScreenShareOpener(key, SID).open(new Uint8Array(12))).rejects.toThrow(
      "Bad record size",
    );
  });

  it("decodes base64url strictly", () => {
    expect(() => fromBase64Url("not base64!")).toThrow();
    expect(toBase64Url(fromBase64Url("AQID"))).toBe("AQID");
  });
});
