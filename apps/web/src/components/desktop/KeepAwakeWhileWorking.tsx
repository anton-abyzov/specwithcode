import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import { useEffect, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";

/**
 * Desktop only. Tells the app to hold off idle sleep while any session on a
 * connected host is working, so a laptop left alone keeps its turns running.
 */
export function KeepAwakeWhileWorking() {
  const enabled = useClientSettings((settings) => settings.keepAwakeWhileWorking);
  const shells = useThreadShells(enabled);
  const { environments } = useEnvironments();
  const working = useMemo(() => {
    if (!enabled) return false;
    const connected = new Set(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    );
    return shells.some(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        connected.has(thread.environmentId) &&
        threadRuntimeIsActive(thread.runtime),
    );
  }, [enabled, environments, shells]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    void bridge?.setKeepAwake?.({ active: working }).catch(() => undefined);
    return () => {
      void bridge?.setKeepAwake?.({ active: false }).catch(() => undefined);
    };
  }, [working]);

  return null;
}
