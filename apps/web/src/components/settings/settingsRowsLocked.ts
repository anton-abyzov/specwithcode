import { createContext, useContext } from "react";

/**
 * True inside rows this sign-in may look at but not change. Those rows take no
 * click or key, so a list that normally opens on request shows in full there:
 * nothing may be readable only behind a control that cannot be pressed.
 */
export const SettingsRowsLockedContext = createContext(false);

export const useSettingsRowsLocked = () => useContext(SettingsRowsLockedContext);
