import {
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type ServerDirectEndpoint,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { SmartphoneIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import {
  createServerPairingCredential,
  readPrimaryEnvironmentTarget,
} from "~/environments/primary";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildPhonePairingUrl,
  describePhoneNetworkHint,
  resolvePhonePairingAddress,
} from "./PairPhone.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const PHONE_LINK_LABEL = "iPhone";
const PAIR_PHONE_SETTING: SettingsSearchItemId = "pair-phone";

/** The server this window talks to, which is not always the page's own origin. */
function currentServerOrigin(): string | null {
  try {
    return readPrimaryEnvironmentTarget()?.target.httpBaseUrl ?? window.location.origin;
  } catch {
    return null;
  }
}

function formatClockTime(value: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(value)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

type PairPhoneSettingsProps = {
  /** The endpoint Settings uses for pairing links on this machine. */
  readonly endpoint: AdvertisedEndpoint | null;
  /** Addresses the server reports for itself, for windows without the desktop bridge. */
  readonly serverEndpoints: ReadonlyArray<ServerDirectEndpoint> | undefined;
  readonly canCreateLinks: boolean;
  /** Scopes this window holds; the phone link never asks for more. */
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  /** Whether this window shows the Network access and Tailscale HTTPS rows (desktop app). */
  readonly hasAccessControls: boolean;
  /** Scrolls to the section with Network access and Tailscale HTTPS. */
  readonly onShowAccessSettings: () => void;
};

/**
 * A one-step way to pair the iPhone app: make a one-time link with the
 * standard client permissions and show it as a QR code right away.
 */
export const PairPhoneSettings = memo(function PairPhoneSettings({
  endpoint,
  serverEndpoints,
  canCreateLinks,
  delegatableScopes,
  onPairingLinkCreated,
  hasAccessControls,
  onShowAccessSettings,
}: PairPhoneSettingsProps) {
  const address = useMemo(
    () =>
      resolvePhonePairingAddress({
        endpoint,
        serverEndpoints,
        currentOrigin: currentServerOrigin(),
      }),
    [endpoint, serverEndpoints],
  );
  const [created, setCreated] = useState<AuthPairingCredentialResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const pairingUrl =
    created !== null && address !== null ? buildPhonePairingUrl(address, created.credential) : null;

  const phoneScopes = useMemo(
    () => AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
    [delegatableScopes],
  );
  const canPair = canCreateLinks && phoneScopes.length > 0;

  const handlePair = useCallback(async () => {
    const scopes = phoneScopes;
    if (scopes.length === 0) return;
    setIsCreating(true);
    try {
      const result = await createServerPairingCredential({ label: PHONE_LINK_LABEL, scopes });
      onPairingLinkCreated(result);
      setCreated(result);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create a pairing code",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        }),
      );
    } finally {
      setIsCreating(false);
    }
  }, [phoneScopes, onPairingLinkCreated]);

  const handleCopy = useCallback(async () => {
    if (pairingUrl === null) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      toastManager.add(stackedThreadToast({ type: "success", title: "Pairing link copied" }));
    } catch {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy the pairing link",
          description: "Scan the code instead.",
        }),
      );
    }
  }, [pairingUrl]);

  const description = !canPair
    ? "This window cannot create pairing codes. Quit and reopen SpecWithCode so it signs in with full access to this computer."
    : address === null
      ? hasAccessControls
        ? "Your phone needs an address to reach this computer. Turn on Tailscale HTTPS or Network access for this machine first."
        : "Your phone needs an address to reach this computer. Set up Tailscale Serve for it with `specwithcode pair --tailscale`, or open these settings in the SpecWithCode desktop app."
      : `Scan a code with the SpecWithCode app on your iPhone. It connects to ${address.httpBaseUrl.replace(/\/$/u, "")}.`;

  return (
    <SettingsSection
      {...searchableSetting(PAIR_PHONE_SETTING)}
      title="Phone"
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title="Pair a phone"
        description={description}
        control={
          canPair && address === null && hasAccessControls ? (
            <Button size="sm" variant="outline" onClick={onShowAccessSettings}>
              Set up access
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              disabled={!canPair || address === null || isCreating}
              onClick={() => void handlePair()}
            >
              {isCreating ? "Creating…" : "Pair a phone"}
            </Button>
          )
        }
      />
      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Scan with your iPhone</DialogTitle>
            <DialogDescription>
              In the SpecWithCode app, tap Pair a machine, then Scan QR code.
              {created !== null
                ? ` The code works once and expires at ${formatClockTime(created.expiresAt)}.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {pairingUrl !== null && address !== null ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-fit rounded-xl bg-white p-3">
                  <QRCodeSvg
                    value={pairingUrl}
                    size={208}
                    level="M"
                    marginSize={1}
                    title="Pairing code for the SpecWithCode iPhone app"
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  {describePhoneNetworkHint(address.hint)}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The code was created, but this computer has no address your phone can reach.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {pairingUrl !== null ? (
              <Button variant="ghost" onClick={() => void handleCopy()}>
                Copy link
              </Button>
            ) : null}
            <Button variant="default" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
});
