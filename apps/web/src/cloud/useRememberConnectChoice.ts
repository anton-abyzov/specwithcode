import { useAuth } from "@clerk/react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import {
  CONNECT_ACCOUNT_AUTH,
  CONNECT_TURNED_OFF_STORAGE_KEY,
  ConnectTurnedOffSchema,
  EMPTY_CONNECT_TURNED_OFF_STATE,
  replaceUnreadableConnectChoices,
  withConnectChoice,
} from "./connectOnboarding";

/**
 * Saves the owner's own switch of SpecWithCode Connect for the signed-in
 * account, on this device. Off holds a later sign-in back from turning it on
 * again; on forgets that. Signed out there is no account to save it for.
 *
 * The account is read here, the same way the sign-in wizard reads it, so a
 * choice made while Clerk still finishes the session is saved too. Saved
 * choices that cannot be read are replaced by this one, which the owner just
 * made; only a sign-in leaves such a value alone.
 */
export function useRememberConnectChoice(): (on: boolean) => void {
  const { isSignedIn, userId } = useAuth(CONNECT_ACCOUNT_AUTH);
  const account = isSignedIn && userId ? userId : null;
  const [, setTurnedOff] = useLocalStorage(
    CONNECT_TURNED_OFF_STORAGE_KEY,
    EMPTY_CONNECT_TURNED_OFF_STATE,
    ConnectTurnedOffSchema,
  );
  return (on) => {
    if (!account) return;
    replaceUnreadableConnectChoices(account, on);
    setTurnedOff((state) => withConnectChoice(state, account, on));
  };
}
