import type { ArtifactAppPower, DesktopArtifactAppPermissions } from "@specweave-studio/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { useTx } from "~/i18n";
import { isMacPlatform } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { callArtifactAppPermissions } from "./artifactAppPowerMessages";

/**
 * The installed page's Permissions menu: the powers this version may use, one
 * item that turns all of them off, and one that asks again when some are not
 * allowed. The shell owns the answers; the menu only shows and requests.
 */
export function ArtifactAppPermissions(props: {
  /** What the shell last reported for the version in this window. */
  readonly permissions: DesktopArtifactAppPermissions;
  readonly onChange: (permissions: DesktopArtifactAppPermissions) => void;
}) {
  const tx = useTx();
  const [busy, setBusy] = useState(false);
  const { permissions, onChange } = props;
  // A version that declares nothing has no permissions to show.
  if (permissions.declared.length === 0) return null;
  const macos = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  const label = (power: ArtifactAppPower) => {
    switch (power) {
      case "notifications":
        return tx("Show notifications");
      case "tray":
        return macos ? tx("Add an item to the menu bar") : tx("Add an item to the system tray");
      case "always-on-top":
        return tx("Keep its window above other windows");
      case "global-shortcuts":
        return tx("Respond to keyboard shortcuts while you use other apps");
    }
  };
  const act = async (action: "turn-off" | "ask") => {
    if (busy) return;
    setBusy(true);
    const next = await callArtifactAppPermissions({ action });
    setBusy(false);
    if (next === null) {
      toastManager.add({ type: "error", title: tx("Could not change the permissions") });
      return;
    }
    // An answer for another version than the one shown is not this menu's.
    if (next.attachmentId === permissions.attachmentId) onChange(next);
  };
  const granted = permissions.granted;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" />}>
        <ShieldCheckIcon aria-hidden className="size-4" /> {tx("Permissions")}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>
            {granted.length > 0
              ? tx("This version of the page can")
              : tx("This version of the page has no permissions")}
          </MenuGroupLabel>
          {granted.map((power) => (
            <MenuItem key={power} disabled>
              {label(power)}
            </MenuItem>
          ))}
        </MenuGroup>
        {granted.length > 0 ? (
          <MenuItem disabled={busy} onClick={() => void act("turn-off")}>
            {tx("Turn off all")}
          </MenuItem>
        ) : null}
        {granted.length < permissions.declared.length ? (
          <MenuItem disabled={busy} onClick={() => void act("ask")}>
            {tx("Ask me again…")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
