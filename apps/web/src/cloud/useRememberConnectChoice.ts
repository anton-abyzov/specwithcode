import { useLocalStorage } from "~/hooks/useLocalStorage";

import {
  CONNECT_TURNED_OFF_STORAGE_KEY,
  ConnectTurnedOffSchema,
  EMPTY_CONNECT_TURNED_OFF_STATE,
  withConnectChoice,
} from "./connectOnboarding";

/**
 * Saves the owner's own switch of SpecWithCode Connect for the signed-in
 * account, on this device. Off holds a later sign-in back from turning it on
 * again; on forgets that. Signed out there is no account to save it for.
 */
export function useRememberConnectChoice(account: string | null): (on: boolean) => void {
  const [, setTurnedOff] = useLocalStorage(
    CONNECT_TURNED_OFF_STORAGE_KEY,
    EMPTY_CONNECT_TURNED_OFF_STATE,
    ConnectTurnedOffSchema,
  );
  return (on) => {
    if (account) setTurnedOff((state) => withConnectChoice(state, account, on));
  };
}
