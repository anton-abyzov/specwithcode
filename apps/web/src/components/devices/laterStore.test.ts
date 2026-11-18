import { describe, expect, it } from "vite-plus/test";

import {
  LATER_KEEP_MS,
  LATER_MAX_PER_MACHINE,
  LATER_STORAGE_KEY,
  makeLaterStore,
  type LaterStorage,
} from "./laterStore";

const memoryStorage = (): LaterStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
};

describe("Later on the approving machine (1416)", () => {
  it("keeps a device put off across a restart of the app", () => {
    const storage = memoryStorage();
    let now = 1_000;
    makeLaterStore(
      () => storage,
      () => now,
    ).add("m4", ["device:phone-a", "request-b"]);
    // A restart: a new store over the same storage, a little later.
    now += 60 * 60_000;
    const afterRestart = makeLaterStore(
      () => storage,
      () => now,
    );
    expect([...afterRestart.keys("m4")].sort()).toEqual(["device:phone-a", "request-b"]);
    // Each machine keeps its own list.
    expect(afterRestart.keys("m5").size).toBe(0);
  });

  it("lets the pop-up show the device again 30 days after Later", () => {
    const storage = memoryStorage();
    let now = 0;
    const later = makeLaterStore(
      () => storage,
      () => now,
    );
    later.add("m4", ["device:phone-a"]);
    now = LATER_KEEP_MS - 1;
    expect(later.keys("m4").has("device:phone-a")).toBe(true);
    now = LATER_KEEP_MS;
    expect(later.keys("m4").has("device:phone-a")).toBe(false);
  });

  it("starts a device's time again when it is put off again", () => {
    const storage = memoryStorage();
    let now = 0;
    const later = makeLaterStore(
      () => storage,
      () => now,
    );
    later.add("m4", ["device:phone-a"]);
    now = LATER_KEEP_MS - 10;
    later.add("m4", ["device:phone-a"]);
    now = LATER_KEEP_MS + 10;
    expect(later.keys("m4").has("device:phone-a")).toBe(true);
    expect(JSON.parse(storage.items.get(LATER_STORAGE_KEY)!).m4).toHaveLength(1);
  });

  it("keeps at most the newest entries per machine", () => {
    const storage = memoryStorage();
    let now = 0;
    const later = makeLaterStore(
      () => storage,
      () => now,
    );
    for (let index = 0; index < LATER_MAX_PER_MACHINE + 5; index++) {
      now = index;
      later.add("m4", [`request-${index}`]);
    }
    const keys = later.keys("m4");
    expect(keys.size).toBe(LATER_MAX_PER_MACHINE);
    expect(keys.has("request-0")).toBe(false);
    expect(keys.has(`request-${LATER_MAX_PER_MACHINE + 4}`)).toBe(true);
  });

  it("drops another machine's entries once their time is up", () => {
    const storage = memoryStorage();
    let now = 0;
    const later = makeLaterStore(
      () => storage,
      () => now,
    );
    later.add("m5", ["device:old"]);
    now = LATER_KEEP_MS + 1;
    later.add("m4", ["device:new"]);
    expect(Object.keys(JSON.parse(storage.items.get(LATER_STORAGE_KEY)!))).toEqual(["m4"]);
  });

  it("works for this session when storage cannot be read or saved", () => {
    const broken: LaterStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const later = makeLaterStore(() => broken);
    later.add("m4", ["device:phone-a"]);
    expect(later.keys("m4").has("device:phone-a")).toBe(true);
    const none = makeLaterStore(() => null);
    none.add("m4", ["request-b"]);
    expect(none.keys("m4").has("request-b")).toBe(true);
  });

  it("keeps using memory once a save fails, even if storage still reads an older list", () => {
    const storage = memoryStorage();
    storage.items.set(LATER_STORAGE_KEY, JSON.stringify({ m4: [] }));
    const full: LaterStorage = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const later = makeLaterStore(() => full);
    later.add("m4", ["device:phone-a"]);
    expect(later.keys("m4").has("device:phone-a")).toBe(true);
  });

  it("ignores a damaged list instead of failing", () => {
    const storage = memoryStorage();
    storage.items.set(LATER_STORAGE_KEY, "{not json");
    expect(makeLaterStore(() => storage).keys("m4").size).toBe(0);
    storage.items.set(
      LATER_STORAGE_KEY,
      JSON.stringify({ m4: [{ key: 1 }, { key: "ok", at: 0 }] }),
    );
    expect([
      ...makeLaterStore(
        () => storage,
        () => 1,
      ).keys("m4"),
    ]).toEqual(["ok"]);
  });
});
