import {
  newSignInViewerKey,
  sealForSignIn,
  signInKeyFingerprint,
  unsealForSignIn,
} from "@specweave-studio/shared/signInSeal";
import { describe, expect, it } from "vite-plus/test";

import { newReceivingKey, seal, unseal } from "../fleet/fileTransfer/seal.ts";
import { keyFingerprint, SIGN_IN_SEAL_INFO } from "./signInView.ts";

// The viewer's WebCrypto half must read what the server seals and the other way round (1488).
describe("sign-in sealing between the server and the viewer", () => {
  it("opens a server frame in the viewer", async () => {
    const viewer = await newSignInViewerKey();
    const sealed = seal(Buffer.from("frame ✓"), viewer.publicKey, SIGN_IN_SEAL_INFO);
    expect(new TextDecoder().decode(await unsealForSignIn(sealed, viewer))).toBe("frame ✓");
  });

  it("opens viewer text on the server", async () => {
    const view = newReceivingKey();
    const sealed = await sealForSignIn(new TextEncoder().encode("p@ss wörd"), view.publicKey);
    expect(unseal(sealed, view, SIGN_IN_SEAL_INFO).toString("utf8")).toBe("p@ss wörd");
  });

  it("refuses a frame sealed for file transfer, or changed on the way", async () => {
    const viewer = await newSignInViewerKey();
    await expect(
      unsealForSignIn(seal(Buffer.from("x"), viewer.publicKey), viewer),
    ).rejects.toThrow();
    const sealed = seal(Buffer.from("abc"), viewer.publicKey, SIGN_IN_SEAL_INFO);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("abd").toString("base64");
    await expect(unsealForSignIn(parts.join("."), viewer)).rejects.toThrow();
    await expect(unsealForSignIn("not sealed", viewer)).rejects.toThrow();
  });

  it("shows the same fingerprint as the server", async () => {
    const view = newReceivingKey();
    expect(await signInKeyFingerprint(view.publicKey)).toBe(keyFingerprint(view.publicKey));
  });
});
