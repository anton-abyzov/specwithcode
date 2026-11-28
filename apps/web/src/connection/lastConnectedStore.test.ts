import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeBrowserLastConnectedStore } from "./lastConnectedStore";

function memoryStorage(): Pick<Window, "localStorage"> {
  const values = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    } as Storage,
  };
}

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");

describe("makeBrowserLastConnectedStore (1517)", () => {
  it.effect("keeps each machine's last session time apart", () =>
    Effect.gen(function* () {
      const store = makeBrowserLastConnectedStore(memoryStorage());
      yield* store.write(STUDIO, 1_700_000_000_000);
      expect(yield* store.read(STUDIO)).toBe(1_700_000_000_000);
      expect(yield* store.read(LAPTOP)).toBeNull();
    }),
  );

  it.effect("reads a corrupt or blocked store as never connected", () =>
    Effect.gen(function* () {
      const corrupt = memoryStorage();
      corrupt.localStorage.setItem("specwithcode:last-connected:env-studio", "soon");
      expect(yield* makeBrowserLastConnectedStore(corrupt).read(STUDIO)).toBeNull();

      const blocked = makeBrowserLastConnectedStore({
        localStorage: {
          getItem: () => {
            throw new Error("SecurityError");
          },
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        } as unknown as Storage,
      });
      yield* blocked.write(STUDIO, 1);
      expect(yield* blocked.read(STUDIO)).toBeNull();
      expect(yield* makeBrowserLastConnectedStore(undefined).read(STUDIO)).toBeNull();
    }),
  );
});
