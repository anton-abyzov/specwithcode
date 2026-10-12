import { useMediaQuery } from "./useMediaQuery";

/**
 * A touch device's on-screen keyboard, where Return is a new line and the Send button sends:
 * a touch primary pointer that cannot hover, at any width, so a landscape phone or a tablet
 * counts too. Width alone is not a phone: a narrow desktop window still has a hardware
 * keyboard, and its Enter sends.
 */
export const PHONE_KEYBOARD_QUERY = "(pointer: coarse) and (hover: none)";

export function usePhoneKeyboard(): boolean {
  return useMediaQuery(PHONE_KEYBOARD_QUERY);
}
