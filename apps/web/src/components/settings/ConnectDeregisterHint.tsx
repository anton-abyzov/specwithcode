import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useTx } from "../../i18n";
import { useStudioConnectAccountPage } from "../clerk/StudioConnectAccountPages";
import { Button } from "../ui/button";

/**
 * Removing a machine from this list does not take it off the owner's
 * SpecWithCode Connect account: only Deregister on the account page does.
 * Said in the Remove confirmation, so it reads the same wherever Remove is.
 */
export function fleetRemoveConnectNote(label: string): string {
  return `If ${label} is on your SpecWithCode Connect account, it stays registered there until you deregister it: account menu > Manage account > SpecWithCode Connect > Deregister.`;
}

/** After a removal: where the machine is still registered, with the page one click away. */
export function ConnectDeregisterHint({ label }: { readonly label: string }) {
  // Builds without SpecWithCode Connect have no account page and no Clerk to open it.
  return hasCloudPublicConfig() ? (
    <ConfiguredConnectDeregisterHint label={label} />
  ) : (
    <ConnectDeregisterHintView label={label} onOpen={null} />
  );
}

function ConfiguredConnectDeregisterHint({ label }: { readonly label: string }) {
  const accountPage = useStudioConnectAccountPage();
  return (
    <>
      <ConnectDeregisterHintView label={label} onOpen={accountPage.open} />
      {accountPage.portals}
    </>
  );
}

export function ConnectDeregisterHintView({
  label,
  onOpen,
}: {
  readonly label: string;
  /** Opens Manage account on the SpecWithCode Connect page; null when signed out. */
  readonly onOpen: (() => void) | null;
}) {
  const tx = useTx();
  return (
    <p role="status" className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
      <span>
        {tx(
          "If {label} is on your SpecWithCode Connect account, it is still registered there. Deregister it under account menu > Manage account > SpecWithCode Connect.",
          { label },
        )}
      </span>
      {onOpen ? (
        <Button size="xs" variant="outline" onClick={onOpen}>
          {tx("Open SpecWithCode Connect settings")}
        </Button>
      ) : null}
    </p>
  );
}
