// @effect-diagnostics nodeBuiltinImport:off - real files in a temporary folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  assertRoomFor,
  CHUNK_BYTES,
  chunkCount,
  FileTransferRefusal,
  IncomingFile,
  inboxFolder,
  isCredentialLocation,
  landingPath,
  looksSecret,
  pinFile,
  readPinned,
  resolveFile,
  safeFileName,
  sha256File,
} from "./files.ts";
import { FileOffers, type OfferCaller } from "./offers.ts";
import { newReceivingKey, seal, unseal } from "./seal.ts";

let root: string;
let project: string;
let state: string;
const caller = (over: Partial<OfferCaller> = {}): OfferCaller => ({
  coordinatorEnvironmentId: "env-m4",
  coordinatorLabel: "M4",
  mayCarrySecrets: true,
  roots: [project],
  ...over,
});

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-transfer-")));
  project = NodePath.join(root, "project");
  state = NodePath.join(root, "state");
  NodeFS.mkdirSync(project);
  NodeFS.mkdirSync(state);
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const baseOf = () => NodePath.join(root, "base");
const put = (name: string, content: string | Buffer) => {
  const path = NodePath.join(project, name);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  return path;
};

describe("what counts as a secret", () => {
  it("catches key files by name and by what they hold", async () => {
    expect(await looksSecret(put(".env", "A=1"))).toBe(true);
    expect(await looksSecret(put("release.keystore", "x"))).toBe(true);
    expect(
      await looksSecret(put("publisher.json", '{"type":"service_account","private_key":"x"}')),
    ).toBe(true);
    expect(await looksSecret(put("key.txt", "-----BEGIN RSA PRIVATE KEY-----\nabc"))).toBe(true);
    expect(await looksSecret(put("app-release.aab", "plain bytes"))).toBe(false);
    expect(await looksSecret(put("notes.json", '{"name":"x"}'))).toBe(false);
  });
});

describe("resolving and landing", () => {
  it("refuses folders, missing files and relative paths", async () => {
    await expect(resolveFile(project)).rejects.toThrow("not a regular file");
    // It names the call that moves a project folder, not a flow an agent cannot start.
    await expect(resolveFile(project)).rejects.toThrow("studio_project_add_to_machine");
    await expect(resolveFile(NodePath.join(project, "no"))).rejects.toThrow("does not exist");
    await expect(resolveFile("relative.txt")).rejects.toThrow("absolute path");
  });

  it("keeps a sent name inside its folder", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(() => safeFileName("..")).toThrow(FileTransferRefusal);
  });

  it("refuses a destination outside the reachable folders, through a symlink too", async () => {
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.symlinkSync(outside, NodePath.join(project, "link"));
    const base = { name: "a", roots: [project], inbox: state, id: "1" };
    await expect(
      landingPath({ ...base, destinationPath: NodePath.join(outside, "a") }),
    ).rejects.toThrow("outside what this transfer may write");
    await expect(
      landingPath({ ...base, destinationPath: NodePath.join(project, "link", "a") }),
    ).rejects.toThrow("outside what this transfer may write");
    expect(await landingPath({ ...base, destinationPath: NodePath.join(project, "b") })).toBe(
      NodePath.join(project, "b"),
    );
    expect(await landingPath(base)).toBe(NodePath.join(state, "1", "a"));
  });

  it("names the machine and both sizes when there is no room", async () => {
    await expect(assertRoomFor(state, 2 ** 52, "M1")).rejects.toThrow(
      /^M1 has .* free at .*\. This file needs/u,
    );
  });
});

describe("writing a received file", () => {
  it("never overwrites, and keeps nothing on a wrong hash", async () => {
    const final = NodePath.join(project, "out.bin");
    const first = await IncomingFile.open({ final, size: 3, secret: false, inbox: state });
    await first.write(0, Buffer.from("abc"));
    await expect(first.finish("0".repeat(64))).rejects.toThrow("hash differs");
    expect(NodeFS.readdirSync(project)).toEqual([]);
    expect(NodeFS.readdirSync(NodePath.join(state, ".staging"))).toEqual([]);

    NodeFS.writeFileSync(final, "existing");
    await expect(
      IncomingFile.open({ final, size: 3, secret: false, inbox: state }),
    ).rejects.toThrow("already exists");
    expect(NodeFS.readFileSync(final, "utf8")).toBe("existing");
  });

  it("refuses to link over a file that appeared meanwhile", async () => {
    const final = NodePath.join(project, "race.bin");
    const incoming = await IncomingFile.open({ final, size: 1, secret: false, inbox: state });
    await incoming.write(0, Buffer.from("a"));
    NodeFS.writeFileSync(final, "theirs");
    await expect(incoming.finish(null)).rejects.toThrow("already exists");
    expect(NodeFS.readFileSync(final, "utf8")).toBe("theirs");
    expect(NodeFS.readdirSync(project)).toEqual(["race.bin"]);
  });

  it("keeps a chunk written twice correct and refuses a longer file", async () => {
    const final = NodePath.join(project, "twice.bin");
    const incoming = await IncomingFile.open({ final, size: 2, secret: false, inbox: state });
    await incoming.write(0, Buffer.from("ab"));
    await incoming.write(0, Buffer.from("ab"));
    await expect(incoming.write(0, Buffer.from("abc"))).rejects.toThrow("longer than announced");
    expect(await incoming.finish(null)).toBe(final);
    expect(NodeFS.readFileSync(final, "utf8")).toBe("ab");
  });
});

describe("sealing", () => {
  it("opens only with the receiving key and shows no plaintext", () => {
    const key = newReceivingKey();
    const sealed = seal(Buffer.from("top secret value"), key.publicKey);
    expect(sealed).not.toContain("top secret");
    expect(Buffer.from(sealed.split(".")[3]!, "base64").toString()).not.toContain("top secret");
    expect(unseal(sealed, key).toString()).toBe("top secret value");
    expect(() => unseal(sealed, newReceivingKey())).toThrow();
  });

  it("detects tampering", () => {
    const key = newReceivingKey();
    const parts = seal(Buffer.from("value"), key.publicKey).split(".");
    const bytes = Buffer.from(parts[3]!, "base64");
    bytes[0] = bytes[0]! ^ 1;
    parts[3] = bytes.toString("base64");
    expect(() => unseal(parts.join("."), key)).toThrow();
  });
});

describe("offers", () => {
  it("serves a multi-chunk file that arrives identical", async () => {
    const source = put("app.aab", NodeCrypto.randomBytes(CHUNK_BYTES * 2 + 17));
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerGet(caller(), { path: source });
    expect(offer.secret).toBe(false);
    const final = NodePath.join(root, "got.aab");
    const incoming = await IncomingFile.open({
      final,
      size: offer.sizeBytes,
      secret: false,
      inbox: state,
    });
    for (let index = 0; index < chunkCount(offer.sizeBytes); index += 1) {
      const chunk = await offers.read(caller(), offer.offerId!, index);
      await incoming.write(index, Buffer.from(chunk.data, "base64"));
    }
    await incoming.finish(offer.sha256);
    expect(await sha256File(final)).toBe(await sha256File(source));
    // Windows has no such mode bits; the user profile's folder permissions apply there.
    if (NodePath.sep === "/")
      expect(NodeFS.statSync(final).mode & 0o777).toBe(0o644 & ~process.umask());
  });

  it("refuses a path outside the grant's folders", async () => {
    const outside = NodePath.join(root, "private.txt");
    NodeFS.writeFileSync(outside, "x");
    await expect(
      new FileOffers(baseOf(), state).offerGet(caller(), { path: outside }),
    ).rejects.toThrow("outside what M4 may reach");
  });

  it("answers an offer only to the machine that opened it", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerGet(caller(), { path: put("a.bin", "abc") });
    await expect(
      offers.read(caller({ coordinatorEnvironmentId: "env-m3" }), offer.offerId!, 0),
    ).rejects.toThrow("no longer open");
  });

  it("lapses an idle offer", async () => {
    let now = 1_000;
    const offers = new FileOffers(baseOf(), state, () => now);
    const offer = await offers.offerGet(caller(), { path: put("a.bin", "abc") });
    now += 2 * 60 * 60 * 1000;
    await offers.offerGet(caller(), { path: put("b.bin", "abc") });
    await expect(offers.read(caller(), offer.offerId!, 0)).rejects.toThrow("no longer open");
  });

  it("gives a secret's bytes only sealed, and never to a lesser grant", async () => {
    const source = put("publisher.json", '{"private_key":"PLAINTEXT-KEY"}');
    const offers = new FileOffers(baseOf(), state);
    const asked = await offers.offerGet(caller(), { path: source });
    expect(asked).toMatchObject({ secret: true, sealed: null, offerId: null, sha256: null });
    const key = newReceivingKey();
    const sealed = await offers.offerGet(caller(), { path: source, recipientKey: key.publicKey });
    expect(sealed.sealed).not.toContain("PLAINTEXT-KEY");
    expect(unseal(sealed.sealed!, key).toString()).toContain("PLAINTEXT-KEY");
    await expect(
      offers.offerGet(caller({ mayCarrySecrets: false }), { path: source }),
    ).rejects.toThrow("full-access");
  });

  it("refuses a secret over 1 MB", async () => {
    const source = put("big.env", Buffer.alloc(1024 * 1024 + 1));
    await expect(
      new FileOffers(baseOf(), state).offerGet(caller(), { path: source }),
    ).rejects.toThrow("limited to 1 MB");
  });

  it("receives a sealed secret with mode 0600 in the inbox", async () => {
    const offers = new FileOffers(baseOf(), state);
    const content = Buffer.from('{"private_key":"PLAINTEXT-KEY"}');
    const offer = await offers.offerSend(caller(), {
      name: "publisher.json",
      sizeBytes: content.length,
      secret: true,
    });
    expect(offer.path.startsWith(inboxFolder(state))).toBe(true);
    const { path } = await offers.write(caller(), {
      offerId: offer.offerId,
      index: 0,
      sealed: seal(content, offer.recipientKey!),
    });
    // Windows has no such mode bits; the user profile's folder permissions apply there.
    if (NodePath.sep === "/") expect(NodeFS.statSync(path!).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(path!, "utf8")).toContain("PLAINTEXT-KEY");
  });

  it("does not keep a secret sent as a plain file", async () => {
    const offers = new FileOffers(baseOf(), state);
    const content = Buffer.from('{"private_key":"x"}');
    const offer = await offers.offerSend(caller(), {
      name: "plain.json",
      sizeBytes: content.length,
      secret: false,
    });
    await expect(
      offers.write(caller(), {
        offerId: offer.offerId,
        index: 0,
        data: content.toString("base64"),
      }),
    ).rejects.toThrow("not sent as one");
    expect(NodeFS.existsSync(offer.path)).toBe(false);
  });

  it("refuses plain bytes for a secret offer and leaves nothing", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerSend(caller(), { name: "a.env", sizeBytes: 3, secret: true });
    await expect(
      offers.write(caller(), { offerId: offer.offerId, index: 0, data: "YWJj" }),
    ).rejects.toThrow("must arrive sealed");
  });

  it("refuses a sealed secret under a lesser grant, and any wrong key", async () => {
    const offers = new FileOffers(baseOf(), state);
    await expect(
      offers.offerSend(caller({ mayCarrySecrets: false }), {
        name: "a.env",
        sizeBytes: 3,
        secret: true,
      }),
    ).rejects.toThrow("full-access");
    const offer = await offers.offerSend(caller(), { name: "b.env", sizeBytes: 5, secret: true });
    await expect(
      offers.write(caller(), {
        offerId: offer.offerId,
        index: 0,
        sealed: seal(Buffer.from("value"), newReceivingKey().publicKey),
      }),
    ).rejects.toThrow("nothing was kept");
    expect(NodeFS.existsSync(offer.path)).toBe(false);
  });

  it("verifies a sent file's hash, and reads chunks in order", async () => {
    const offers = new FileOffers(baseOf(), state);
    const bytes = NodeCrypto.randomBytes(CHUNK_BYTES + 5);
    const offer = await offers.offerSend(caller(), {
      name: "build.apk",
      sizeBytes: bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      secret: false,
    });
    const source = put("source.apk", bytes);
    const first = await offers.write(caller(), {
      offerId: offer.offerId,
      index: 0,
      data: (await readPinned(await pinFile(source), 0)).toString("base64"),
    });
    expect(first.path).toBeNull();
    const last = await offers.write(caller(), {
      offerId: offer.offerId,
      index: 1,
      data: (await readPinned(await pinFile(source), 1)).toString("base64"),
    });
    expect(NodeFS.readFileSync(last.path!).equals(bytes)).toBe(true);
  });

  it("stops serving when the file is swapped for a key after the check", async () => {
    const source = put("build.log", "plain");
    const key = put("elsewhere.txt", '{"private_key":"x"}');
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerGet(caller(), { path: source });
    NodeFS.rmSync(source);
    NodeFS.symlinkSync(key, source);
    await expect(offers.read(caller(), offer.offerId!, 0)).rejects.toThrow("changed during");
  });

  it("stops serving when the file changes in place", async () => {
    const source = put("build.log", "plain");
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerGet(caller(), { path: source });
    NodeFS.writeFileSync(source, "plain and longer");
    await expect(offers.read(caller(), offer.offerId!, 0)).rejects.toThrow("changed during");
  });

  it("refuses a credential past a plain start", async () => {
    const source = put(
      "long.log",
      Buffer.concat([Buffer.alloc(CHUNK_BYTES, 97), Buffer.from('"private_key":"x"')]),
    );
    const pin = await pinFile(source);
    expect(pin.secret).toBe(false);
    await expect(readPinned(pin, 1)).rejects.toThrow("holds a credential");
  });

  it("never serves a credential folder, even inside a granted project", async () => {
    const home = NodeOS.homedir();
    expect(
      await isCredentialLocation(NodePath.join(home, ".ssh", "id_ed25519"), baseOf(), state),
    ).toBe(true);
    expect(
      await isCredentialLocation(NodePath.join(home, ".claude", "settings.json"), baseOf(), state),
    ).toBe(true);
    expect(
      await isCredentialLocation(NodePath.join(baseOf(), "studio-fleet-key.json"), baseOf(), state),
    ).toBe(true);
    for (const working of ["worktrees/x/a", "scratch/x/a", "projects/x/a"])
      expect(await isCredentialLocation(NodePath.join(baseOf(), working), baseOf(), state)).toBe(
        false,
      );
    expect(
      await isCredentialLocation(NodePath.join(inboxFolder(state), "1", "a"), baseOf(), state),
    ).toBe(false);
  });

  it("does not create folders outside what it may write", async () => {
    const outside = NodePath.join(root, "outside-not-yet");
    await expect(
      landingPath({
        name: "a",
        roots: [project],
        inbox: state,
        id: "1",
        destinationPath: NodePath.join(outside, "deep", "a"),
      }),
    ).rejects.toThrow("outside what this transfer may write");
    expect(NodeFS.existsSync(outside)).toBe(false);
    await expect(
      landingPath({
        name: "a",
        roots: [project],
        inbox: state,
        id: "1",
        destinationPath: NodePath.join(project, ".git", "hooks", "a"),
      }),
    ).rejects.toThrow("outside what this transfer may write");
  });

  it("lets only a full grant choose a folder", async () => {
    await expect(
      new FileOffers(baseOf(), state).offerSend(caller({ mayCarrySecrets: false }), {
        name: "a.bin",
        sizeBytes: 1,
        secret: false,
        destinationPath: NodePath.join(project, "a.bin"),
      }),
    ).rejects.toThrow("choose a folder only");
  });

  it("repeats the outcome when the last chunk's answer was lost", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerSend(caller(), { name: "a.bin", sizeBytes: 3, secret: false });
    const write = () => offers.write(caller(), { offerId: offer.offerId, index: 0, data: "YWJj" });
    const first = await write();
    expect(first.path).toBe(offer.path);
    expect(await write()).toEqual(first);
  });

  it("shares the saved path between concurrent retries of the final chunk", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerSend(caller(), { name: "a.bin", sizeBytes: 3, secret: false });
    const write = () => offers.write(caller(), { offerId: offer.offerId, index: 0, data: "YWJj" });
    expect(await Promise.all([write(), write()])).toEqual([
      { path: offer.path },
      { path: offer.path },
    ]);
    expect(NodeFS.readFileSync(offer.path, "utf8")).toBe("abc");
  });

  it("does not publish if aborted during the final write", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerSend(caller(), { name: "a.bin", sizeBytes: 3, secret: false });
    const write = IncomingFile.prototype.write;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = vi.spyOn(IncomingFile.prototype, "write").mockImplementation(async function (
      this: IncomingFile,
      index,
      bytes,
    ) {
      await gate;
      return write.call(this, index, bytes);
    });
    try {
      const outcome = offers.write(caller(), { offerId: offer.offerId, index: 0, data: "YWJj" });
      const rejected = expect(outcome).rejects.toThrow("cancelled before publication");
      await offers.abort(caller(), offer.offerId);
      release();
      await rejected;
      expect(NodeFS.existsSync(offer.path)).toBe(false);
    } finally {
      release();
      delayed.mockRestore();
    }
  });

  it("keeps no staged file after an abort, and sweeps abandoned ones", async () => {
    const offers = new FileOffers(baseOf(), state);
    const offer = await offers.offerSend(caller(), { name: "a.bin", sizeBytes: 3, secret: false });
    const staging = NodePath.join(inboxFolder(state), ".staging");
    expect(NodeFS.readdirSync(staging)).toHaveLength(1);
    await offers.abort(caller({ coordinatorEnvironmentId: "env-m3" }), offer.offerId);
    expect(NodeFS.readdirSync(staging)).toHaveLength(1);
    await offers.abort(caller(), offer.offerId);
    expect(NodeFS.readdirSync(staging)).toEqual([]);

    const orphan = NodePath.join(staging, "orphan");
    NodeFS.writeFileSync(orphan, "x");
    const now = NodeFS.statSync(orphan).mtimeMs + 2 * 24 * 60 * 60 * 1000;
    const later = new FileOffers(baseOf(), state, () => now);
    await later.offerGet(caller(), { path: put("a.bin", "abc") });
    expect(NodeFS.readdirSync(staging)).toEqual([]);
  });

  it("lets an idle served offer give way, but never a live one", async () => {
    let now = 0;
    const offers = new FileOffers(baseOf(), state, () => now);
    const source = put("a.bin", "abc");
    for (let count = 0; count < 64; count += 1) await offers.offerGet(caller(), { path: source });
    await expect(offers.offerGet(caller(), { path: source })).rejects.toThrow("busy");
    now += 3 * 60 * 1000;
    await offers.offerGet(caller(), { path: source });
  });

  it("judges a destination in a folder that does not exist yet by what exists above it", async () => {
    const final = NodePath.join(project, "new", "sub", "a.bin");
    expect(await isCredentialLocation(final, baseOf(), state)).toBe(false);
    expect(
      await isCredentialLocation(
        NodePath.join(NodeOS.homedir(), ".ssh", "not-yet", "a"),
        baseOf(),
        state,
      ),
    ).toBe(true);
    const offer = await new FileOffers(baseOf(), state).offerSend(caller(), {
      name: "a.bin",
      sizeBytes: 1,
      secret: false,
      destinationPath: final,
    });
    expect(offer.path).toBe(final);
    expect(NodeFS.existsSync(NodePath.dirname(final))).toBe(false);
  });

  it("never moves an app home nested in a checkout, under a project or a managed worktree", async () => {
    for (const home of [".specwithcode", ".specweave-studio"]) {
      const secret = [home, "m3", "userdata", "secrets", "server-signing"];
      for (const checkout of [project, NodePath.join(baseOf(), "worktrees", "feature")])
        expect(
          await isCredentialLocation(NodePath.join(checkout, ...secret), baseOf(), state),
        ).toBe(true);
    }
    const nested = put(NodePath.join(".specwithcode", "userdata", "key"), "plain");
    await expect(
      new FileOffers(baseOf(), state).offerGet(caller(), { path: nested }),
    ).rejects.toThrow("outside what");
  });

  it("never serves a .git folder, which can hold a token", async () => {
    NodeFS.mkdirSync(NodePath.join(project, ".git"));
    const source = NodePath.join(project, ".git", "config");
    NodeFS.writeFileSync(source, "[remote]");
    await expect(
      new FileOffers(baseOf(), state).offerGet(caller(), { path: source }),
    ).rejects.toThrow("outside what");
  });

  it("names where the asked path really leads", async () => {
    const target = put("real.bin", "abc");
    const link = NodePath.join(project, "link.bin");
    NodeFS.symlinkSync(target, link);
    const answer = await new FileOffers(baseOf(), state).offerGet(caller(), { path: link });
    expect(answer.path).toBe(target);
  });
});
