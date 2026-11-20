import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Hands the settled Connect account to the connection registry (1434, D-01),
 * which forgets machines saved under an account that left, on this window only.
 * `account` is undefined until Connect has settled; nothing is sent before that.
 */
export function ConnectMachineOwnersSync({
  account,
}: {
  readonly account: string | null | undefined;
}) {
  const setAccount = useAtomCommand(environmentCatalog.setAccount, {
    label: "Forget the previous account's machines",
    reportFailure: false,
  });
  useEffect(() => {
    if (account === undefined) return;
    void setAccount(account);
  }, [account, setAccount]);
  return null;
}
