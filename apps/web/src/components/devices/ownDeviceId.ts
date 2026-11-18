/**
 * This window's own short device ID (1406): the four characters a machine shows
 * beside this device in its approval pop-up and device list, from the same key.
 * Loaded on demand, so the cards that show it stay light on imports.
 */
import { deviceShortIdOfThumbprint } from "@specweave-studio/shared/deviceShortId";
import { useEffect, useState } from "react";

let loading: Promise<string | null> | undefined;

/** Null when this window holds no proof key yet, or it cannot be read. */
export function loadOwnDeviceShortId(): Promise<string | null> {
  loading ??= (async () => {
    try {
      const [{ readStoredBrowserDpopKey }, Effect] = await Promise.all([
        import("../../cloud/dpop"),
        import("effect/Effect"),
      ]);
      const key = await Effect.runPromise(readStoredBrowserDpopKey());
      return key === null ? null : (deviceShortIdOfThumbprint(key.thumbprint) ?? null);
    } catch {
      return null;
    }
  })().then((id) => {
    // A window without a key yet asks again next time; a found ID never changes.
    if (id === null) loading = undefined;
    return id;
  });
  return loading;
}

export function useOwnDeviceShortId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadOwnDeviceShortId().then((found) => {
      if (live) setId(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return id;
}
