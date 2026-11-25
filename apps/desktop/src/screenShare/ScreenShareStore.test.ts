import {
  SCREEN_SHARE_AUDIT_LIMIT,
  SCREEN_SHARE_COOLDOWN_WINDOW_MS,
  SCREEN_SHARE_GRANT_IDLE_MS,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sealScreenShareStore, unsealScreenShareStore } from "./screenShareSeal.ts";
import { ScreenShareStore, type ScreenShareStoreIo } from "./ScreenShareStore.ts";

/** A stand-in for the system's encryption: only the same `machine` opens what it sealed. */
function disk(machine = "m1") {
  const file: { bytes: Uint8Array | null } = { bytes: null };
  let now = Date.parse("2026-11-25T12:00:00Z");
  let sealing = true;
  const io: ScreenShareStoreIo = {
    read: () => file.bytes,
    write: (bytes) => {
      file.bytes = bytes;
    },
    canSeal: () => sealing,
    seal: (text) => new TextEncoder().encode(`${machine}:${text}`),
    unseal: (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (!text.startsWith(`${machine}:`)) throw new Error("not this machine's");
      return text.slice(machine.length + 1);
    },
    now: () => now,
  };
  return {
    io,
    file,
    advance: (ms: number) => {
      now += ms;
    },
    setSealing: (value: boolean) => {
      sealing = value;
    },
  };
}

const DEVICE = { thumbprint: "t1", label: "Work laptop", shortId: "7F3A" };

describe("ScreenShareStore", () => {
  it("is off with no grants on first run, and writes nothing until asked", () => {
    const { io, file } = disk();
    const store = new ScreenShareStore(io);
    expect(store.enabled).toBe(false);
    expect(store.grants).toEqual([]);
    expect(store.storeHealthy).toBe(true);
    expect(file.bytes).toBeNull();
  });

  it("keeps the switch, grants and key across restarts", () => {
    const { io } = disk();
    const first = new ScreenShareStore(io);
    expect(first.setEnabled(true)).toBe(true);
    first.addGrant(DEVICE);
    const second = new ScreenShareStore(io);
    expect(second.enabled).toBe(true);
    expect(second.hasGrant("t1")).toBe(true);
    expect(second.machineKey).toEqual(first.machineKey);
  });

  it("with the real seal: nothing readable on disk, and one changed bit reads as off", () => {
    const { io, file } = disk();
    const wrap = {
      available: () => true,
      wrap: (text: string) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
      unwrap: (bytes: Uint8Array) =>
        Buffer.from(Buffer.from(bytes).map((byte) => byte ^ 0x5a)).toString("utf8"),
    };
    const sealed: ScreenShareStoreIo = {
      ...io,
      seal: (text) => sealScreenShareStore(wrap, text),
      unseal: (bytes) => unsealScreenShareStore(wrap, bytes),
    };
    const store = new ScreenShareStore(sealed);
    store.setEnabled(true);
    store.addGrant(DEVICE);
    const onDisk = Buffer.from(file.bytes!).toString("utf8");
    expect(onDisk).not.toContain("Work laptop");
    expect(onDisk).not.toContain("enabled");
    expect(new ScreenShareStore(sealed).hasGrant("t1")).toBe(true);

    const envelope = JSON.parse(onDisk) as { data: string };
    const data = Buffer.from(envelope.data, "base64");
    data[5]! ^= 0x01;
    file.bytes = Buffer.from(JSON.stringify({ ...envelope, data: data.toString("base64") }));
    const tampered = new ScreenShareStore(sealed);
    expect(tampered.enabled).toBe(false);
    expect(tampered.grants).toEqual([]);
    expect(tampered.storeHealthy).toBe(false);
  });

  it("reads a file edited by hand as off, with no grants and a new key", () => {
    const { io, file } = disk();
    const first = new ScreenShareStore(io);
    first.setEnabled(true);
    first.addGrant(DEVICE);
    const key = first.machineKey.publicKey;
    file.bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, enabled: true, machineKey: first.machineKey, grants: [], audit: [] }),
    );
    const second = new ScreenShareStore(io);
    expect(second.enabled).toBe(false);
    expect(second.grants).toEqual([]);
    expect(second.storeHealthy).toBe(false);
    expect(second.machineKey.publicKey).not.toBe(key);
  });

  it("reads a file copied from another machine as off", () => {
    const other = disk("m2");
    const theirs = new ScreenShareStore(other.io);
    theirs.setEnabled(true);
    theirs.addGrant(DEVICE);
    const mine = disk("m1");
    mine.file.bytes = other.file.bytes;
    const store = new ScreenShareStore(mine.io);
    expect(store.enabled).toBe(false);
    expect(store.hasGrant("t1")).toBe(false);
    expect(store.storeHealthy).toBe(false);
  });

  it("reads a sealed file with a broken shape as off", () => {
    for (const body of [
      "not json",
      JSON.stringify({ v: 2, enabled: true }),
      JSON.stringify({
        v: 1,
        enabled: true,
        machineKey: { secret: "s", publicKey: "p" },
        grants: [{ thumbprint: "t1" }],
        audit: [],
      }),
    ]) {
      const { io, file } = disk();
      file.bytes = io.seal(body);
      const store = new ScreenShareStore(io);
      expect(store.enabled).toBe(false);
      expect(store.grants).toEqual([]);
      expect(store.storeHealthy).toBe(false);
    }
  });

  it("stays off when the file cannot be read or the system cannot encrypt", () => {
    const broken = disk();
    const store = new ScreenShareStore({
      ...broken.io,
      read: () => {
        throw new Error("EACCES");
      },
    });
    expect(store.enabled).toBe(false);
    expect(store.storeHealthy).toBe(false);

    const plain = disk();
    new ScreenShareStore(plain.io).setEnabled(true);
    plain.setSealing(false);
    const unsealed = new ScreenShareStore(plain.io);
    expect(unsealed.supported).toBe(false);
    expect(unsealed.enabled).toBe(false);
    expect(unsealed.setEnabled(true)).toBe(false);
  });

  it("does not turn on when the write fails", () => {
    const { io } = disk();
    const store = new ScreenShareStore({
      ...io,
      write: () => {
        throw new Error("ENOSPC");
      },
    });
    expect(store.setEnabled(true)).toBe(false);
    expect(store.enabled).toBe(false);
  });

  it("ends a grant 30 days after its last use, and a use renews it", () => {
    const { io, advance } = disk();
    const store = new ScreenShareStore(io);
    store.addGrant(DEVICE);
    advance(SCREEN_SHARE_GRANT_IDLE_MS - 1000);
    expect(store.hasGrant("t1")).toBe(true);
    store.touchGrant("t1");
    advance(SCREEN_SHARE_GRANT_IDLE_MS - 1000);
    expect(store.hasGrant("t1")).toBe(true);
    advance(2000);
    expect(store.hasGrant("t1")).toBe(false);
    expect(store.grants).toEqual([]);
  });

  it("removes a grant and keeps one grant per device", () => {
    const { io } = disk();
    const store = new ScreenShareStore(io);
    store.addGrant(DEVICE);
    store.addGrant({ ...DEVICE, label: "Renamed" });
    expect(store.grants.map((grant) => grant.label)).toEqual(["Renamed"]);
    store.removeGrant("t1");
    expect(store.hasGrant("t1")).toBe(false);
  });

  it("keeps the newest sessions and replaces an entry by id", () => {
    const { io } = disk();
    const store = new ScreenShareStore(io);
    for (let index = 0; index < SCREEN_SHARE_AUDIT_LIMIT + 5; index += 1)
      store.recordAudit({
        id: `s${index}`,
        at: "2026-11-25T12:00:00.000Z",
        label: "Work laptop",
        shortId: "7F3A",
        mode: "view",
        outcome: "refused",
      });
    expect(store.audit).toHaveLength(SCREEN_SHARE_AUDIT_LIMIT);
    expect(store.audit[0]?.id).toBe("s5");
    store.recordAudit({ ...store.audit.at(-1)!, outcome: "allowed_once", frames: 3 });
    expect(store.audit).toHaveLength(SCREEN_SHARE_AUDIT_LIMIT);
    expect(store.audit.at(-1)).toMatchObject({ outcome: "allowed_once", frames: 3 });
  });

  it("goes quiet for a device after three refusals in ten minutes, and keeps that across restarts", () => {
    const { io, advance } = disk();
    const store = new ScreenShareStore(io);
    store.addStrike("t1");
    advance(60_000);
    store.addStrike("t1");
    expect(store.inCooldown("t1")).toBe(false);
    advance(60_000);
    store.addStrike("t1");
    expect(store.inCooldown("t1")).toBe(true);
    expect(store.inCooldown("t2")).toBe(false);
    expect(new ScreenShareStore(io).inCooldown("t1")).toBe(true);
    advance(SCREEN_SHARE_COOLDOWN_WINDOW_MS - 1000);
    expect(store.inCooldown("t1")).toBe(true);
    advance(2000);
    expect(store.inCooldown("t1")).toBe(false);
  });

  it("does not go quiet for refusals spread wider than the window", () => {
    const { io, advance } = disk();
    const store = new ScreenShareStore(io);
    for (let round = 0; round < 5; round += 1) {
      store.addStrike("t1");
      advance(SCREEN_SHARE_COOLDOWN_WINDOW_MS / 2 + 1000);
    }
    expect(store.inCooldown("t1")).toBe(false);
  });

  it("keeps its own record of devices that typed the code, and forgets one that is removed", () => {
    const { io } = disk();
    const first = new ScreenShareStore(io);
    expect(first.knowsDevice("t1")).toBe(false);
    expect(first.rememberDevice("t1")).toBe(true);
    first.addGrant(DEVICE);
    const second = new ScreenShareStore(io);
    expect(second.knowsDevice("t1")).toBe(true);
    expect(second.knowsDevice("t2")).toBe(false);
    second.removeGrant("t1");
    expect(new ScreenShareStore(io).knowsDevice("t1")).toBe(false);
    // A file from before this record existed reads as: no device has been here.
    const old = disk();
    const store = new ScreenShareStore(old.io);
    store.setEnabled(true);
    const text = new TextDecoder().decode(old.file.bytes!).slice(3);
    const { known: _known, ...rest } = JSON.parse(text) as Record<string, unknown>;
    old.file.bytes = new TextEncoder().encode(`m1:${JSON.stringify(rest)}`);
    const reread = new ScreenShareStore(old.io);
    expect(reread.enabled).toBe(true);
    expect(reread.knowsDevice("t1")).toBe(false);
  });
});
