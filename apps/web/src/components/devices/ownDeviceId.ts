/**
 * This window's own short device ID (1406): the four characters a machine shows
 * beside this device in its approval pop-up and device list, from the same key.
 * Loaded on demand, so the cards that show it stay light on imports.
 */
import { deviceShortIdOfThumbprint } from "@specweave-studio/shared/deviceShortId";
import { useEffect, useState } from "react";

/** A read of this window's key: its ID (null without a key), or that the read failed. */
export type OwnDeviceRead =
  | { readonly ok: true; readonly id: string | null }
  | { readonly ok: false };

let loading: Promise<OwnDeviceRead> | undefined;

/** Tells "no key" from "could not read", for callers that must not mistake one for the other. */
export function readOwnDeviceShortId(): Promise<OwnDeviceRead> {
  loading ??= (async (): Promise<OwnDeviceRead> => {
    try {
      const [{ readStoredBrowserDpopKey }, Effect] = await Promise.all([
        import("../../cloud/dpop"),
        import("effect/Effect"),
      ]);
      const key = await Effect.runPromise(readStoredBrowserDpopKey());
      return {
        ok: true,
        id: key === null ? null : (deviceShortIdOfThumbprint(key.thumbprint) ?? null),
      };
    } catch {
      return { ok: false };
    }
  })().finally(() => {
    // Read again next time: a window gains a key on sign-in and may replace it.
    loading = undefined;
  });
  return loading;
}

/** Null when this window holds no proof key yet, or it cannot be read. */
export async function loadOwnDeviceShortId(): Promise<string | null> {
  const read = await readOwnDeviceShortId();
  return read.ok ? read.id : null;
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
